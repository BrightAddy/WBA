import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { checkoutSchema, formatCedis, MAX_LINE_QTY, type PublicStore } from "@kiosk/shared";
import type { Db } from "../../db/client.ts";
import { conversations, type OrderDraft } from "../../db/schema.ts";
import type { StoreService } from "../store/service.ts";

/**
 * Everything the assistant can do. The model never sees a seller's private data,
 * never computes a price, and cannot place an order: it can only look at the
 * public catalogue, ask the server to price a basket (which is saved as a draft)
 * and ask for a human. Placing the order needs the customer's own "yes".
 */
export const DRAFT_TTL_MS = 30 * 60_000;

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

const prepareSchema = z.object({
  items: z
    .array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_LINE_QTY) }))
    .min(1)
    .max(10),
  fulfilment: z.enum(["delivery", "pickup"]),
  area: z.string().max(80).optional(),
  customerName: z.string().max(60),
  address: z.string().max(200).optional(),
  landmark: z.string().max(120).optional(),
  note: z.string().max(300).optional(),
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "search_products",
    description:
      "Search this store's catalogue. Use for any question about what's for sale, prices or availability. Empty query lists the newest items.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words from the product name or category, e.g. 'hoodie'." } },
    },
  },
  {
    name: "get_product",
    description: "Full details for one product: description, and every size/colour with its variantId, price and stock.",
    input_schema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  },
  {
    name: "delivery_info",
    description: "Delivery areas with fees and timing, pickup availability and the free-delivery threshold.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "prepare_order",
    description:
      "Once the customer has said exactly what they want, how they get it and who they are, ask the system to price it and hold it for their confirmation. " +
      "Never guess a variantId, area, name or address; ask the customer first. Returns problems to fix or ok.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { variantId: { type: "string" }, quantity: { type: "integer" } },
            required: ["variantId", "quantity"],
          },
        },
        fulfilment: { type: "string", enum: ["delivery", "pickup"] },
        area: { type: "string", description: "Delivery area name exactly as listed by delivery_info. Delivery only." },
        customerName: { type: "string" },
        address: { type: "string", description: "Where to deliver. Delivery only." },
        landmark: { type: "string" },
        note: { type: "string" },
      },
      required: ["items", "fulfilment", "customerName"],
    },
  },
  {
    name: "hand_off_to_seller",
    description:
      "Ask the human seller to take over. Use when the customer is upset, wants a discount or custom item, asks something the tools can't answer, or asks for a person.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

export type BotToolState = {
  /** Set when prepare_order succeeded this turn; the service appends it verbatim. */
  draftSummary: string | null;
  handoff: string | null;
};

export function orderSummary(q: {
  lines: { title: string; label: string; quantity: number; lineTotalPesewas: number }[];
  deliveryFeePesewas: number;
  totalPesewas: number;
  fulfilment: "delivery" | "pickup";
  where: string;
}) {
  const lines = q.lines.map((l) => `• ${l.quantity} × ${l.title}${l.label !== "Standard" ? ` (${l.label})` : ""}: ${formatCedis(l.lineTotalPesewas)}`);
  const how = q.fulfilment === "pickup" ? "Pickup" : `Delivery to ${q.where}: ${q.deliveryFeePesewas ? formatCedis(q.deliveryFeePesewas) : "free"}`;
  return `${lines.join("\n")}\n${how}\n*Total: ${formatCedis(q.totalPesewas)}*`;
}

export function createBotTools(deps: {
  db: Db;
  store: StoreService;
  slug: string;
  conversationId: string;
  customerPhone: string;
}) {
  const state: BotToolState = { draftSummary: null, handoff: null };
  let cached: PublicStore | null = null;
  const catalogue = async () => (cached ??= await deps.store.getStore(deps.slug, null));

  async function run(name: string, raw: unknown): Promise<unknown> {
    switch (name) {
      case "search_products": {
        const { query = "" } = z.object({ query: z.string().max(100).optional() }).parse(raw ?? {});
        const s = await catalogue();
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = s.products.filter((p) => {
          const hay = `${p.title} ${p.category}`.toLowerCase();
          return words.every((w) => hay.includes(w.replace(/s$/, "")));
        });
        return {
          total: hits.length,
          products: hits.slice(0, 8).map((p) => ({
            productId: p.id,
            title: p.title,
            category: p.category,
            price: `${p.fromPrice ? "from " : ""}${formatCedis(p.pricePesewas)}`,
            soldOut: p.soldOut,
          })),
        };
      }
      case "get_product": {
        const { productId } = z.object({ productId: z.string().uuid() }).parse(raw);
        const p = await deps.store.getProduct(deps.slug, productId, null);
        return {
          title: p.title,
          description: p.description?.slice(0, 400) ?? null,
          variants: p.variants.map((v) => ({
            variantId: v.id,
            size: v.size,
            color: v.color,
            price: formatCedis(v.pricePesewas),
            inStock: v.available,
          })),
        };
      }
      case "delivery_info": {
        const d = (await catalogue()).delivery;
        return {
          areas: d.zones.map((z) => ({ name: z.name, fee: formatCedis(z.feePesewas), eta: z.etaLabel })),
          pickup: d.settings.pickupEnabled ? { address: d.settings.pickupAddress } : null,
          freeDeliveryOver: d.settings.freeDeliveryOverPesewas === null ? null : formatCedis(d.settings.freeDeliveryOverPesewas),
        };
      }
      case "prepare_order":
        return prepare(raw);
      case "hand_off_to_seller": {
        const { reason } = z.object({ reason: z.string().max(200) }).parse(raw);
        state.handoff = reason;
        return { ok: true };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  async function prepare(raw: unknown) {
    const parsed = prepareSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const a = parsed.data;

    const s = await catalogue();
    let zoneId: string | null = null;
    if (a.fulfilment === "delivery") {
      const want = (a.area ?? "").trim().toLowerCase();
      const zones = s.delivery.zones;
      const exact = zones.filter((z) => z.name.toLowerCase() === want);
      const loose = want ? zones.filter((z) => z.name.toLowerCase().includes(want) || want.includes(z.name.toLowerCase())) : [];
      const match = exact.length === 1 ? exact : loose;
      if (match.length !== 1) {
        return {
          ok: false,
          problems: [
            match.length > 1
              ? `"${a.area}" matches several areas. Ask which one: ${match.map((z) => z.name).join(", ")}.`
              : `The store doesn't deliver to "${a.area ?? ""}". Areas: ${zones.map((z) => z.name).join(", ") || "none set up"}.`,
          ],
        };
      }
      zoneId = match[0]!.id;
    }

    const checkout = checkoutSchema.safeParse({
      items: a.items,
      fulfilment: a.fulfilment,
      zoneId,
      clientToken: randomUUID(),
      customerName: a.customerName,
      customerPhone: deps.customerPhone,
      addressText: a.address,
      landmark: a.landmark,
      note: a.note,
    });
    if (!checkout.success) return { ok: false, problems: [...new Set(checkout.error.issues.map((i) => i.message))] };
    const c = checkout.data;

    const q = await deps.store.quote(deps.slug, { items: c.items, fulfilment: c.fulfilment, zoneId: c.zoneId }, null);
    const bad = q.lines.filter((l) => l.problem);
    if (bad.length) {
      return {
        ok: false,
        problems: bad.map((l) =>
          l.problem === "reduced"
            ? `${l.title} (${l.label}): only ${l.quantity} left, ask if that's okay.`
            : `${l.title}${l.label ? ` (${l.label})` : ""} is ${l.problem === "sold_out" ? "sold out" : "no longer available"}.`,
        ),
      };
    }
    if (!q.delivery) return { ok: false, problems: ["Choose delivery or pickup."] };
    if (!q.delivery.ok) return { ok: false, problems: [q.delivery.reason] };

    const draft: OrderDraft = {
      items: c.items,
      fulfilment: c.fulfilment,
      zoneId: c.zoneId ?? null,
      customerName: c.customerName,
      addressText: c.addressText,
      landmark: c.landmark,
      note: c.note,
      at: new Date().toISOString(),
    };
    await deps.db.update(conversations).set({ draft }).where(eq(conversations.id, deps.conversationId));

    const where = s.delivery.zones.find((z) => z.id === zoneId)?.name ?? "";
    state.draftSummary = orderSummary({
      lines: q.lines,
      deliveryFeePesewas: q.delivery.feePesewas,
      totalPesewas: q.delivery.totalPesewas,
      fulfilment: c.fulfilment,
      where,
    });
    return { ok: true, note: "Saved. The system will show the customer the priced summary and ask them to confirm. Do not repeat prices." };
  }

  return { state, run, defs: TOOL_DEFS };
}

export type BotTools = ReturnType<typeof createBotTools>;
