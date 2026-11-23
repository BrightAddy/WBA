import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  CATEGORIES,
  MAX_LINE_QTY,
  quoteDelivery,
  variantLabel,
  whatsappStoreLink,
  type Category,
  type PlacedOrder,
  type PublicProduct,
  type PublicProductCard,
  type PublicStore,
  type QuoteInput,
  type QuoteLine,
  type QuoteResponse,
  type checkoutSchema,
} from "@kiosk/shared";
import type { z } from "zod";
import type { Db } from "../../db/client.ts";
import {
  blocklist,
  customers,
  deliveryZones,
  orderEvents,
  orderItems,
  orders,
  productImages,
  products,
  productVariants,
  sellers,
} from "../../db/schema.ts";
import { sha256 } from "../../lib/crypto.ts";
import { AppError, badRequest, conflict } from "../../lib/errors.ts";
import type { Storage } from "../../lib/storage.ts";
import type { OrderNotifier } from "../../lib/whatsapp.ts";
import { imageDto } from "../catalogue/dto.ts";

type Seller = typeof sellers.$inferSelect;
type Viewer = { id: string; role: string } | null;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;
type Checkout = z.output<typeof checkoutSchema>;

const PG_UNIQUE_VIOLATION = "23505";
/** node-postgres exposes the violated index as `constraint`; drizzle may wrap it in `cause`. */
const isUnique = (err: unknown, constraint?: string) => {
  type PgErr = { code?: string; constraint?: string };
  const e = err as PgErr & { cause?: PgErr };
  const code = e.code ?? e.cause?.code;
  const name = e.constraint ?? e.cause?.constraint;
  return code === PG_UNIQUE_VIOLATION && (!constraint || name === constraint);
};

const notFound = (what = "store") => new AppError(404, "not_found", `That ${what} doesn't exist.`);

/** Short reference the customer can read out: no 0/O/1/I/L lookalikes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export function createStoreService({ db, storage, notifier, log, botNumber = null }: {
  /** Shared bot number in international digits; enables the "Chat on WhatsApp" link. */
  botNumber?: string | null;
  db: Db;
  storage: Storage;
  notifier: OrderNotifier;
  log: { error: (o: object, m: string) => void };
}) {
  /* ───────── Visibility ───────── */

  async function findSeller(slug: string, conn: Conn = db): Promise<Seller | null> {
    const [s] = await conn
      .select()
      .from(sellers)
      .where(sql`lower(${sellers.slug}) = ${slug.toLowerCase()}`)
      .limit(1);
    return s ?? null;
  }

  /**
   * Approved stores are public. A pending store is visible only to its owner
   * (as a preview, with checkout off). Suspended or banned stores don't exist.
   */
  async function visibleSeller(slug: string, viewer: Viewer): Promise<{ seller: Seller; preview: boolean }> {
    const seller = await findSeller(slug);
    if (!seller) throw notFound();
    if (seller.status === "approved") return { seller, preview: false };
    // Review: the owner and any admin can look at a store before it goes live.
    if (seller.status === "pending" && viewer && (viewer.id === seller.accountId || viewer.role === "admin")) {
      return { seller, preview: true };
    }
    throw notFound();
  }

  /* ───────── Browsing ───────── */

  async function getStore(slug: string, viewer: Viewer): Promise<PublicStore> {
    const { seller, preview } = await visibleSeller(slug, viewer);

    const [zones, rows] = await Promise.all([
      db
        .select()
        .from(deliveryZones)
        .where(and(eq(deliveryZones.sellerId, seller.id), eq(deliveryZones.active, true)))
        .orderBy(asc(deliveryZones.position)),
      db
        .select()
        .from(products)
        .where(and(eq(products.sellerId, seller.id), eq(products.status, "active")))
        .orderBy(desc(products.createdAt)),
    ]);

    let cards: PublicProductCard[] = [];
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const [covers, variants] = await Promise.all([
        db
          .selectDistinctOn([productImages.productId])
          .from(productImages)
          .where(inArray(productImages.productId, ids))
          .orderBy(productImages.productId, asc(productImages.position)),
        db.select().from(productVariants).where(inArray(productVariants.productId, ids)),
      ]);
      const coverBy = new Map(covers.map((c) => [c.productId, c]));
      const variantsBy = new Map<string, (typeof variants)[number][]>();
      for (const v of variants) variantsBy.set(v.productId, [...(variantsBy.get(v.productId) ?? []), v]);

      cards = rows.map((p) => {
        const vs = variantsBy.get(p.id) ?? [];
        const prices = vs.map((v) => v.pricePesewas ?? p.pricePesewas);
        const min = prices.length ? Math.min(...prices) : p.pricePesewas;
        const fromPrice = prices.length > 0 && Math.max(...prices) !== min;
        const cover = coverBy.get(p.id);
        return {
          id: p.id,
          title: p.title,
          category: p.category as Category,
          pricePesewas: min,
          compareAtPesewas: fromPrice ? null : p.compareAtPesewas,
          soldOut: vs.every((v) => v.stock === 0),
          fromPrice,
          cover: cover ? imageDto(cover, storage) : null,
        };
      });
      // Sold-out items sink to the bottom; the rest stay newest first.
      cards = [...cards.filter((c) => !c.soldOut), ...cards.filter((c) => c.soldOut)];
    }

    const present = new Set(cards.map((c) => c.category));
    return {
      slug: seller.slug,
      name: seller.storeName,
      bio: seller.bio,
      instagramUrl: seller.instagramUrl,
      tiktokUrl: seller.tiktokUrl,
      theme: seller.theme,
      preview,
      whatsappUrl: botNumber ? whatsappStoreLink(botNumber, seller.slug) : null,
      delivery: {
        zones: zones.map((z) => ({ id: z.id, name: z.name, feePesewas: z.feePesewas, etaLabel: z.etaLabel })),
        settings: {
          pickupEnabled: seller.pickupEnabled,
          pickupAddress: seller.pickupEnabled ? seller.pickupAddress : null,
          freeDeliveryOverPesewas: seller.freeDeliveryOverPesewas,
        },
      },
      categories: CATEGORIES.filter((c) => present.has(c)),
      products: cards,
    };
  }

  async function getProduct(slug: string, productId: string, viewer: Viewer): Promise<PublicProduct> {
    const { seller } = await visibleSeller(slug, viewer);
    const [p] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.sellerId, seller.id), eq(products.status, "active")));
    if (!p) throw notFound("product");
    const [images, variants] = await Promise.all([
      db.select().from(productImages).where(eq(productImages.productId, p.id)).orderBy(asc(productImages.position)),
      db.select().from(productVariants).where(eq(productVariants.productId, p.id)).orderBy(asc(productVariants.position)),
    ]);
    const pv = variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      pricePesewas: v.pricePesewas ?? p.pricePesewas,
      available: Math.min(v.stock, MAX_LINE_QTY),
    }));
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      category: p.category as Category,
      pricePesewas: p.pricePesewas,
      compareAtPesewas: p.compareAtPesewas,
      images: images.map((i) => imageDto(i, storage)),
      variants: pv,
      soldOut: pv.every((v) => v.available === 0),
    };
  }

  /* ───────── Pricing: the single source of truth for quote and order ───────── */

  async function price(seller: Seller, input: QuoteInput, conn: Conn = db): Promise<QuoteResponse> {
    // The same variant twice is one line.
    const wanted = new Map<string, number>();
    for (const l of input.items) wanted.set(l.variantId, Math.min(MAX_LINE_QTY, (wanted.get(l.variantId) ?? 0) + l.quantity));
    const ids = [...wanted.keys()];

    const rows = await conn
      .select({ v: productVariants, p: products })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(inArray(productVariants.id, ids), eq(products.sellerId, seller.id)));
    const byId = new Map(rows.map((r) => [r.v.id, r]));

    const productIds = [...new Set(rows.map((r) => r.p.id))];
    const covers = productIds.length
      ? await conn
          .selectDistinctOn([productImages.productId])
          .from(productImages)
          .where(inArray(productImages.productId, productIds))
          .orderBy(productImages.productId, asc(productImages.position))
      : [];
    const coverBy = new Map(covers.map((c) => [c.productId, c]));

    const lines: QuoteLine[] = ids.map((variantId) => {
      const requested = wanted.get(variantId)!;
      const hit = byId.get(variantId);
      if (!hit || hit.p.status !== "active") {
        return {
          variantId,
          productId: hit?.p.id ?? "",
          title: hit?.p.title ?? "No longer available",
          label: hit ? variantLabel(hit.v) : "",
          unitPricePesewas: 0,
          quantity: 0,
          requested,
          lineTotalPesewas: 0,
          image: null,
          problem: "unavailable",
        };
      }
      const unit = hit.v.pricePesewas ?? hit.p.pricePesewas;
      const quantity = Math.min(requested, hit.v.stock);
      const cover = coverBy.get(hit.p.id);
      return {
        variantId,
        productId: hit.p.id,
        title: hit.p.title,
        label: variantLabel(hit.v),
        unitPricePesewas: unit,
        quantity,
        requested,
        lineTotalPesewas: unit * quantity,
        image: cover ? imageDto(cover, storage) : null,
        problem: hit.v.stock === 0 ? "sold_out" : quantity < requested ? "reduced" : null,
      };
    });

    const subtotal = lines.reduce((n, l) => n + l.lineTotalPesewas, 0);

    let delivery: QuoteResponse["delivery"] = null;
    if (input.fulfilment === "pickup" || input.zoneId) {
      const [zone] =
        input.fulfilment === "delivery" && input.zoneId
          ? await conn
              .select()
              .from(deliveryZones)
              .where(and(eq(deliveryZones.id, input.zoneId), eq(deliveryZones.sellerId, seller.id), eq(deliveryZones.active, true)))
          : [];
      delivery = quoteDelivery({
        subtotalPesewas: subtotal,
        fulfilment: input.fulfilment,
        zone: zone ?? null,
        settings: { pickupEnabled: seller.pickupEnabled, freeDeliveryOverPesewas: seller.freeDeliveryOverPesewas },
      });
    }

    return {
      lines,
      subtotalPesewas: subtotal,
      delivery,
      totalPesewas: delivery?.ok ? delivery.totalPesewas : null,
      orderable: lines.length > 0 && lines.every((l) => l.problem === null),
    };
  }

  async function quote(slug: string, input: QuoteInput, viewer: Viewer): Promise<QuoteResponse> {
    const { seller } = await visibleSeller(slug, viewer);
    return price(seller, input);
  }

  /* ───────── Placing an order ───────── */

  async function viewByCode(sellerId: string, code: string, storeName: string): Promise<PlacedOrder> {
    const [o] = await db.select().from(orders).where(and(eq(orders.sellerId, sellerId), eq(orders.code, code)));
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o!.id));
    return placedView(o!, items, storeName);
  }

  async function placeOrder(slug: string, input: Checkout, channel: "storefront" | "whatsapp" = "storefront"): Promise<PlacedOrder> {
    const seller = await findSeller(slug);
    if (!seller || seller.status !== "approved") throw notFound();

    const [blocked] = await db
      .select({ id: blocklist.id })
      .from(blocklist)
      .where(and(eq(blocklist.kind, "phone"), eq(blocklist.valueHash, sha256(input.customerPhone))));
    if (blocked) throw new AppError(403, "blocked", "We can't take this order. Contact the store directly.");

    // A retry or double tap with the same token returns the order already placed.
    const [dupe] = await db
      .select({ code: orders.code })
      .from(orders)
      .where(and(eq(orders.sellerId, seller.id), eq(orders.clientToken, input.clientToken)));
    if (dupe) return viewByCode(seller.id, dupe.code, seller.storeName);

    let code!: string;
    try {
      code = await db.transaction(async (tx) => {
        const q = await price(seller, input, tx);
        if (!q.orderable) {
          throw conflict("cart_changed", "Something in your cart just changed. Review it and try again.");
        }
        if (!q.delivery) throw badRequest("delivery_missing", "Choose delivery or pickup.");
        if (!q.delivery.ok) throw badRequest("delivery_unavailable", q.delivery.reason);

        const zone =
          input.fulfilment === "delivery"
            ? (await tx.select().from(deliveryZones).where(eq(deliveryZones.id, input.zoneId!)))[0]!
            : null;

        // Take the stock first; the guard makes overselling impossible under concurrency.
        for (const l of q.lines) {
          const taken = await tx
            .update(productVariants)
            .set({ stock: sql`${productVariants.stock} - ${l.quantity}` })
            .where(and(eq(productVariants.id, l.variantId), sql`${productVariants.stock} >= ${l.quantity}`))
            .returning({ id: productVariants.id });
          if (!taken.length) throw conflict("cart_changed", "Something in your cart just sold out. Review it and try again.");
        }

        const [customer] = await tx
          .insert(customers)
          .values({ phone: input.customerPhone, name: input.customerName })
          .onConflictDoUpdate({ target: customers.phone, set: { name: sql`coalesce(${customers.name}, excluded.name)` } })
          .returning({ id: customers.id });

        let orderCode = newCode();
        for (let i = 0; i < 5; i++) {
          const [clash] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.code, orderCode));
          if (!clash) break;
          orderCode = newCode();
        }

        const [order] = await tx
          .insert(orders)
          .values({
            code: orderCode,
            sellerId: seller.id,
            customerId: customer!.id,
            channel,
            status: "pending_payment",
            fulfilment: input.fulfilment,
            subtotalPesewas: q.subtotalPesewas,
            deliveryFeePesewas: q.delivery.feePesewas,
            totalPesewas: q.delivery.totalPesewas,
            deliveryZoneId: zone?.id ?? null,
            deliveryZoneName: zone?.name ?? null,
            addressText: input.fulfilment === "delivery" ? input.addressText : null,
            landmark: input.landmark,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            note: input.note,
            clientToken: input.clientToken,
          })
          .returning({ id: orders.id, code: orders.code });

        await tx.insert(orderItems).values(
          q.lines.map((l) => ({
            orderId: order!.id,
            productId: l.productId,
            variantId: l.variantId,
            titleSnapshot: l.title,
            variantLabel: l.label,
            unitPricePesewas: l.unitPricePesewas,
            quantity: l.quantity,
            lineTotalPesewas: l.lineTotalPesewas,
          })),
        );
        await tx.insert(orderEvents).values({
          orderId: order!.id,
          fromStatus: null,
          toStatus: "pending_payment",
          actor: "customer",
          note: channel === "whatsapp" ? "Placed on WhatsApp" : "Placed on the storefront",
        });
        return order!.code;
      });
    } catch (err) {
      if (isUnique(err, "orders_seller_client_token_uq")) return viewByCode(seller.id, await codeForToken(seller.id, input.clientToken), seller.storeName);
      throw err;
    }

    const placed = await viewByCode(seller.id, code, seller.storeName);
    // Telling the seller must never fail the customer's order.
    notifier
      .orderPlaced({
        to: seller.notifyPhone,
        storeName: seller.storeName,
        code: placed.code,
        customerName: placed.customerName,
        customerPhone: placed.customerPhone,
        totalPesewas: placed.totalPesewas,
        itemCount: placed.items.reduce((n, i) => n + i.quantity, 0),
        fulfilment: placed.fulfilment,
        zoneName: placed.zoneName,
      })
      .catch((err) => log.error({ err, order: placed.code }, "order notification failed"));
    return placed;
  }

  async function codeForToken(sellerId: string, token: string) {
    const [o] = await db
      .select({ code: orders.code })
      .from(orders)
      .where(and(eq(orders.sellerId, sellerId), eq(orders.clientToken, token)));
    return o!.code;
  }

  return { visibleSeller, getStore, getProduct, quote, placeOrder };
}

export type StoreService = ReturnType<typeof createStoreService>;

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;

export function placedView(o: OrderRow, items: ItemRow[], storeName: string): PlacedOrder {
  return {
    code: o.code,
    storeName,
    fulfilment: o.fulfilment,
    zoneName: o.deliveryZoneName,
    items: items.map((i) => ({
      title: i.titleSnapshot,
      label: i.variantLabel,
      quantity: i.quantity,
      unitPricePesewas: i.unitPricePesewas,
      lineTotalPesewas: i.lineTotalPesewas,
    })),
    subtotalPesewas: o.subtotalPesewas,
    deliveryFeePesewas: o.deliveryFeePesewas,
    totalPesewas: o.totalPesewas,
    customerName: o.customerName ?? "",
    customerPhone: o.customerPhone,
    createdAt: o.createdAt.toISOString(),
  };
}
