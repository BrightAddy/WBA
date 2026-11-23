import { IMAGE_WIDTHS, type Category, type ImageDto, type ProductDto, type VariantDto } from "@kiosk/shared";
import type { productImages, products, productVariants } from "../../db/schema.ts";
import type { Storage } from "../../lib/storage.ts";

type ImageRow = typeof productImages.$inferSelect;
type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof productVariants.$inferSelect;

/** Widths actually stored for an image: smaller originals aren't upscaled. */
export const renditionWidths = (originalWidth: number) => [...new Set(IMAGE_WIDTHS.map((w) => Math.min(w, originalWidth)))];

export function imageDto(row: ImageRow, storage: Storage): ImageDto {
  const urls: Record<number, string> = {};
  for (const w of renditionWidths(row.width)) urls[w] = storage.url(`${row.storageKey}/${w}.webp`);
  return { id: row.id, width: row.width, height: row.height, thumbhash: row.thumbhash, urls };
}

export const variantDto = (v: VariantRow): VariantDto => ({
  id: v.id,
  size: v.size,
  color: v.color,
  stock: v.stock,
  pricePesewas: v.pricePesewas,
});

export function productDto(p: ProductRow, images: ImageRow[], variants: VariantRow[], storage: Storage): ProductDto {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category as Category,
    status: p.status,
    pricePesewas: p.pricePesewas,
    compareAtPesewas: p.compareAtPesewas,
    images: [...images].sort((a, b) => a.position - b.position).map((i) => imageDto(i, storage)),
    variants: [...variants].sort((a, b) => a.position - b.position).map(variantDto),
    totalStock: variants.reduce((n, v) => n + v.stock, 0),
    updatedAt: p.updatedAt.toISOString(),
  };
}
