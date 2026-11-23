import { z } from "zod";
import { normalizeGhanaPhone } from "./phone.ts";
import type { Category, ImageDto } from "./catalogue.ts";
import type { DeliveryQuote, DeliverySettings, ZoneDto } from "./delivery.ts";

/** One line can't exceed this, and public stock counts are capped to it too. */
export const MAX_LINE_QTY = 10;
export const MAX_CART_LINES = 30;
/** "Only 2 left" shows at or below this. */
export const LOW_STOCK_AT = 3;

/* ───────────────────────── Inputs ───────────────────────── */

export const cartLineSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_LINE_QTY),
});

const cartFields = {
  items: z.array(cartLineSchema).min(1, "Your cart is empty.").max(MAX_CART_LINES, "That's too many different items."),
  fulfilment: z.enum(["delivery", "pickup"]),
  zoneId: z.string().uuid().nullish(),
};

export const quoteInputSchema = z.object(cartFields);

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const checkoutSchema = z
  .object({
    ...cartFields,
    /** Random per checkout attempt, so a double tap or a retry can't place two orders. */
    clientToken: z.string().uuid(),
    customerName: z.string().trim().min(2, "Enter your name.").max(60),
    customerPhone: z.string().transform((v, ctx) => {
      const r = normalizeGhanaPhone(v);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.reason });
        return z.NEVER;
      }
      return r.e164;
    }),
    addressText: optText(200),
    landmark: optText(120),
    note: optText(300),
  })
  // `when` makes these run even if name or phone already failed, so every problem shows at once.
  .refine((o) => o.fulfilment !== "delivery" || Boolean(o.zoneId), {
    path: ["zoneId"],
    message: "Pick your area.",
    when: () => true,
  })
  .refine((o) => o.fulfilment !== "delivery" || Boolean(o.addressText), {
    path: ["addressText"],
    message: "Tell the seller where to deliver.",
    when: () => true,
  });

export type QuoteInput = z.input<typeof quoteInputSchema>;
export type CheckoutInput = z.input<typeof checkoutSchema>;

/* ───────────────────────── Public DTOs ───────────────────────── */

export type StoreTheme = {
  preset: string;
  /** Hex, e.g. "#ff4d1f". */
  accent?: string;
  radius?: number;
  layout?: "grid" | "feed";
};

export type PublicVariant = {
  id: string;
  size: string | null;
  color: string | null;
  pricePesewas: number;
  /** Real stock up to MAX_LINE_QTY; competitors don't get exact inventory. */
  available: number;
};

export type PublicProductCard = {
  id: string;
  title: string;
  category: Category;
  pricePesewas: number;
  compareAtPesewas: number | null;
  soldOut: boolean;
  /** Lowest variant price differs from the headline price. */
  fromPrice: boolean;
  cover: ImageDto | null;
};

export type PublicProduct = Omit<PublicProductCard, "cover" | "fromPrice" | "soldOut"> & {
  description: string | null;
  images: ImageDto[];
  variants: PublicVariant[];
  soldOut: boolean;
};

export type PublicStore = {
  slug: string;
  name: string;
  bio: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  theme: StoreTheme;
  /** True when the owner is viewing a store that isn't live yet. Checkout is off. */
  preview: boolean;
  delivery: { zones: ZoneDto[]; settings: Pick<DeliverySettings, "pickupEnabled" | "pickupAddress" | "freeDeliveryOverPesewas"> };
  categories: Category[];
  products: PublicProductCard[];
};

/* ───────────────────────── Quote / order ───────────────────────── */

export type QuoteProblem = "unavailable" | "sold_out" | "reduced";

export type QuoteLine = {
  variantId: string;
  productId: string;
  title: string;
  label: string;
  unitPricePesewas: number;
  /** What the order will contain: the requested amount, clamped to stock. */
  quantity: number;
  requested: number;
  lineTotalPesewas: number;
  image: ImageDto | null;
  problem: QuoteProblem | null;
};

export type QuoteResponse = {
  lines: QuoteLine[];
  subtotalPesewas: number;
  /** Null until the customer has chosen delivery or pickup. */
  delivery: DeliveryQuote | null;
  totalPesewas: number | null;
  /** True when every line can be ordered exactly as requested. */
  orderable: boolean;
};

export type PlacedOrder = {
  code: string;
  storeName: string;
  fulfilment: "delivery" | "pickup";
  zoneName: string | null;
  items: { title: string; label: string | null; quantity: number; unitPricePesewas: number; lineTotalPesewas: number }[];
  subtotalPesewas: number;
  deliveryFeePesewas: number;
  totalPesewas: number;
  customerName: string;
  customerPhone: string;
  createdAt: string;
};

/* ───────────────────────── Seller order view ───────────────────────── */

export type SellerOrderDto = PlacedOrder & {
  id: string;
  status: string;
  addressText: string | null;
  landmark: string | null;
  note: string | null;
  channel: "storefront" | "whatsapp";
};

/** Store accent colours are free-form hex; pick readable text for them. */
export function readableInk(hex: string): "#0e0e0c" | "#ffffff" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#0e0e0c";
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? "#0e0e0c" : "#ffffff";
}
