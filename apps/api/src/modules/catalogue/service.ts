import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql, sum } from "drizzle-orm";
import {
  publishBlocker,
  type ProductDto,
  type ProductListItem,
  type ProductStatus,
  type productInputSchema,
} from "@kiosk/shared";
import type { z } from "zod";
import type { Db } from "../../db/client.ts";
import { productImages, products, productVariants } from "../../db/schema.ts";
import { badRequest, AppError } from "../../lib/errors.ts";
import { processProductImage } from "../../lib/images.ts";
import type { Storage } from "../../lib/storage.ts";
import { imageDto, productDto } from "./dto.ts";

type ProductInput = z.output<typeof productInputSchema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Unattached uploads a seller may hold at once; bounds abandoned-upload garbage. */
export const MAX_PENDING_UPLOADS = 40;

const notFound = () => new AppError(404, "not_found", "That product doesn't exist.");

export function createCatalogueService({ db, storage }: { db: Db; storage: Storage }) {
  async function uploadImage(sellerId: string, file: Buffer) {
    const [pending] = await db
      .select({ n: count() })
      .from(productImages)
      .where(and(eq(productImages.sellerId, sellerId), isNull(productImages.productId)));
    if ((pending?.n ?? 0) >= MAX_PENDING_UPLOADS) {
      throw new AppError(429, "too_many_uploads", "Save your product before uploading more photos.");
    }

    const img = await processProductImage(file);
    const id = randomUUID();
    const storageKey = `products/${sellerId}/${id}`;
    await Promise.all(img.renditions.map((r) => storage.put(`${storageKey}/${r.width}.webp`, r.body, "image/webp")));

    const [row] = await db
      .insert(productImages)
      .values({ id, sellerId, storageKey, width: img.width, height: img.height, thumbhash: img.thumbhash })
      .returning();
    return imageDto(row!, storage);
  }

  /** Only unattached images can be discarded directly; attached ones go via product save. */
  async function discardImage(sellerId: string, imageId: string) {
    const [row] = await db
      .delete(productImages)
      .where(and(eq(productImages.id, imageId), eq(productImages.sellerId, sellerId), isNull(productImages.productId)))
      .returning({ storageKey: productImages.storageKey });
    if (row) await storage.deletePrefix(row.storageKey);
    return Boolean(row);
  }

  async function getProduct(sellerId: string, productId: string, tx: Tx | Db = db): Promise<ProductDto> {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.sellerId, sellerId)));
    if (!p) throw notFound();
    const [images, variants] = await Promise.all([
      tx.select().from(productImages).where(eq(productImages.productId, p.id)),
      tx.select().from(productVariants).where(eq(productVariants.productId, p.id)),
    ]);
    return productDto(p, images, variants, storage);
  }

  async function listProducts(sellerId: string, status?: ProductStatus): Promise<ProductListItem[]> {
    const rows = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.sellerId, sellerId),
          status ? eq(products.status, status) : sql`${products.status} <> 'archived'`,
        ),
      )
      .orderBy(desc(products.updatedAt));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);

    const [covers, stock] = await Promise.all([
      db
        .selectDistinctOn([productImages.productId])
        .from(productImages)
        .where(inArray(productImages.productId, ids))
        .orderBy(productImages.productId, asc(productImages.position)),
      db
        .select({ productId: productVariants.productId, total: sum(productVariants.stock), n: count() })
        .from(productVariants)
        .where(inArray(productVariants.productId, ids))
        .groupBy(productVariants.productId),
    ]);
    const coverBy = new Map(covers.map((c) => [c.productId, c]));
    const stockBy = new Map(stock.map((s) => [s.productId, s]));

    return rows.map((p) => {
      const cover = coverBy.get(p.id);
      const s = stockBy.get(p.id);
      return {
        id: p.id,
        title: p.title,
        category: p.category as ProductListItem["category"],
        status: p.status,
        pricePesewas: p.pricePesewas,
        totalStock: Number(s?.total ?? 0),
        variantCount: s?.n ?? 0,
        updatedAt: p.updatedAt.toISOString(),
        cover: cover ? imageDto(cover, storage) : null,
      };
    });
  }

  /**
   * Create or update a product, its photo order and its variants in one
   * transaction. Returns storage prefixes to delete once the commit succeeds.
   */
  async function saveProduct(sellerId: string, input: ProductInput, productId?: string) {
    const orphanedKeys: string[] = [];

    const id = await db.transaction(async (tx) => {
      let current: typeof products.$inferSelect | undefined;
      if (productId) {
        [current] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, productId), eq(products.sellerId, sellerId)))
          .for("update");
        if (!current) throw notFound();
      }

      // Photos must belong to this seller and be either unattached or already on this product.
      if (input.imageIds.length) {
        const owned = await tx
          .select({ id: productImages.id, productId: productImages.productId })
          .from(productImages)
          .where(and(inArray(productImages.id, input.imageIds), eq(productImages.sellerId, sellerId)))
          .for("update");
        const ok = new Set(owned.filter((i) => i.productId === null || i.productId === productId).map((i) => i.id));
        if (input.imageIds.some((i) => !ok.has(i))) {
          throw badRequest("invalid_images", "One of the photos couldn't be found. Upload it again.");
        }
      }

      const status = current?.status ?? "draft";
      if (status === "active") {
        const blocker = publishBlocker({ imageCount: input.imageIds.length, variantCount: input.variants.length });
        if (blocker) throw badRequest("publish_blocked", blocker);
      }

      const values = {
        title: input.title,
        description: input.description,
        category: input.category,
        pricePesewas: input.pricePesewas,
        compareAtPesewas: input.compareAtPesewas,
      };
      const pid = current
        ? (await tx.update(products).set(values).where(eq(products.id, current.id)).returning({ id: products.id }))[0]!.id
        : (await tx.insert(products).values({ ...values, sellerId }).returning({ id: products.id }))[0]!.id;

      await syncImages(tx, pid, input.imageIds, orphanedKeys);
      await syncVariants(tx, pid, input.variants);
      return pid;
    });

    await Promise.all(orphanedKeys.map((k) => storage.deletePrefix(k)));
    return getProduct(sellerId, id);
  }

  async function syncImages(tx: Tx, productId: string, imageIds: string[], orphanedKeys: string[]) {
    const dropped = await tx
      .delete(productImages)
      .where(
        and(
          eq(productImages.productId, productId),
          imageIds.length ? notInArray(productImages.id, imageIds) : undefined,
        ),
      )
      .returning({ storageKey: productImages.storageKey });
    orphanedKeys.push(...dropped.map((d) => d.storageKey));

    for (const [position, imageId] of imageIds.entries()) {
      await tx.update(productImages).set({ productId, position }).where(eq(productImages.id, imageId));
    }
  }

  async function syncVariants(tx: Tx, productId: string, variants: ProductInput["variants"]) {
    const existing = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
    const existingIds = new Set(existing.map((v) => v.id));
    const keepIds = variants.flatMap((v) => (v.id ? [v.id] : []));
    if (keepIds.some((id) => !existingIds.has(id))) {
      throw badRequest("invalid_variants", "A size was changed elsewhere. Reload and try again.");
    }

    const remove = [...existingIds].filter((id) => !keepIds.includes(id));
    if (remove.length) await tx.delete(productVariants).where(inArray(productVariants.id, remove));

    // Park kept rows on unique placeholder sizes first, so swaps like M<->L
    // don't trip the (product, size, colour) unique index mid-update.
    if (keepIds.length) {
      await tx
        .update(productVariants)
        .set({ size: sql`'__' || ${productVariants.id}::text`, color: null })
        .where(inArray(productVariants.id, keepIds));
    }

    for (const [position, v] of variants.entries()) {
      const row = { size: v.size, color: v.color, stock: v.stock, pricePesewas: v.pricePesewas, position };
      if (v.id) await tx.update(productVariants).set(row).where(eq(productVariants.id, v.id));
      else await tx.insert(productVariants).values({ ...row, productId });
    }
  }

  async function setStatus(sellerId: string, productId: string, status: ProductStatus) {
    const product = await getProduct(sellerId, productId);
    if (status === "active") {
      const blocker = publishBlocker({ imageCount: product.images.length, variantCount: product.variants.length });
      if (blocker) throw badRequest("publish_blocked", blocker);
    }
    await db.update(products).set({ status }).where(and(eq(products.id, productId), eq(products.sellerId, sellerId)));
    return getProduct(sellerId, productId);
  }

  return { uploadImage, discardImage, getProduct, listProducts, saveProduct, setStatus };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;
