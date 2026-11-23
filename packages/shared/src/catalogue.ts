import { z } from "zod";

export const CATEGORIES = [
  "Tops and tees",
  "Shirts",
  "Hoodies and jackets",
  "Jeans and trousers",
  "Shorts",
  "Dresses",
  "Skirts",
  "Two-piece sets",
  "Sneakers",
  "Shoes and slides",
  "Bags",
  "Caps and hats",
  "Accessories",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Size systems sellers pick from. Free-text sizes are still allowed. */
export const SIZE_SYSTEMS = {
  letters: { label: "Clothing", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  waist: { label: "Waist", sizes: ["28", "30", "32", "34", "36", "38", "40", "42"] },
  shoesEu: { label: "Shoes (EU)", sizes: ["36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46"] },
  oneSize: { label: "One size", sizes: [] as string[] },
} as const;
export type SizeSystem = keyof typeof SIZE_SYSTEMS;

export const MAX_IMAGES = 8;
export const MAX_VARIANTS = 60;
export const MAX_PRICE_PESEWAS = 10_000_000; // GH₵100,000
/** Served widths; the client picks via srcset. */
export const IMAGE_WIDTHS = [320, 720, 1440] as const;

const pesewasInt = (max = MAX_PRICE_PESEWAS) =>
  z.number().int("Use whole pesewas.").min(0).max(max, "That price is too high.");

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const variantInputSchema = z.object({
  id: z.string().uuid().optional(),
  size: optText(20),
  color: optText(30),
  stock: z.number().int().min(0, "Stock can't be negative.").max(9999),
  pricePesewas: pesewasInt().positive().nullish().transform((v) => v ?? null),
});

export const productInputSchema = z
  .object({
    title: z.string().trim().min(2, "Give it a name.").max(120),
    description: optText(2000),
    category: z.enum(CATEGORIES, { message: "Pick a category." }),
    pricePesewas: pesewasInt().positive("Set a price."),
    compareAtPesewas: pesewasInt().positive().nullish().transform((v) => v ?? null),
    variants: z.array(variantInputSchema).min(1, "Add at least one size or stock count.").max(MAX_VARIANTS),
    imageIds: z.array(z.string().uuid()).max(MAX_IMAGES, `Up to ${MAX_IMAGES} photos.`),
  })
  .superRefine((p, ctx) => {
    if (p.compareAtPesewas !== null && p.compareAtPesewas <= p.pricePesewas) {
      ctx.addIssue({ code: "custom", path: ["compareAtPesewas"], message: "The old price must be higher than the price." });
    }
    const seen = new Set<string>();
    p.variants.forEach((v, i) => {
      const key = `${(v.size ?? "").toLowerCase()}|${(v.color ?? "").toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["variants", i], message: "This size and colour is listed twice." });
      }
      seen.add(key);
    });
    if (new Set(p.imageIds).size !== p.imageIds.length) {
      ctx.addIssue({ code: "custom", path: ["imageIds"], message: "A photo is added twice." });
    }
  });

export type ProductInput = z.input<typeof productInputSchema>;
export type ProductStatus = "draft" | "active" | "archived";

export const productStatusSchema = z.object({ status: z.enum(["draft", "active", "archived"]) });

export type ImageDto = {
  id: string;
  width: number;
  height: number;
  thumbhash: string | null;
  /** width -> URL */
  urls: Record<number, string>;
};

export type VariantDto = {
  id: string;
  size: string | null;
  color: string | null;
  stock: number;
  pricePesewas: number | null;
};

export type ProductDto = {
  id: string;
  title: string;
  description: string | null;
  category: Category;
  status: ProductStatus;
  pricePesewas: number;
  compareAtPesewas: number | null;
  images: ImageDto[];
  variants: VariantDto[];
  totalStock: number;
  updatedAt: string;
};

export type ProductListItem = Pick<
  ProductDto,
  "id" | "title" | "category" | "status" | "pricePesewas" | "totalStock" | "updatedAt"
> & { cover: ImageDto | null; variantCount: number };

/** "M / Black", "M", "Black", or "Standard" */
export const variantLabel = (v: { size: string | null; color: string | null }) =>
  [v.size, v.color].filter(Boolean).join(" / ") || "Standard";

/** Why a product can't go live yet, or null if it can. */
export function publishBlocker(p: { imageCount: number; variantCount: number }): string | null {
  if (p.imageCount === 0) return "Add at least one photo before publishing.";
  if (p.variantCount === 0) return "Add at least one size or stock count before publishing.";
  return null;
}
