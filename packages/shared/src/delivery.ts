import { z } from "zod";

export const MAX_ZONES = 60;
export const MAX_DELIVERY_FEE_PESEWAS = 100_000; // GH₵1,000

/** One-tap suggestions in the zone editor. Sellers can type anything. */
export const AREA_SUGGESTIONS = {
  Accra: [
    "Madina", "Adenta", "East Legon", "Legon", "Haatso", "Dome", "Achimota", "Lapaz", "Kwashieman",
    "Dansoman", "Osu", "Labone", "Cantonments", "Airport Residential", "Spintex", "Teshie", "Nungua",
    "Tema", "Ashaiman", "Kasoa", "Weija", "Accra Central", "Kaneshie", "Circle",
  ],
  Kumasi: ["Adum", "Asokwa", "Bantama", "KNUST", "Ayeduase", "Santasi", "Suame", "Tafo", "Ahodwo", "Nhyiaeso"],
} as const;

export const zoneInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2, "Name the area.").max(40),
  feePesewas: z
    .number()
    .int()
    .min(0, "Fee can't be negative.")
    .max(MAX_DELIVERY_FEE_PESEWAS, "That fee is too high."),
  etaLabel: z
    .string()
    .trim()
    .max(30)
    .nullish()
    .transform((v) => (v ? v : null)),
});

export const zonesInputSchema = z
  .object({ zones: z.array(zoneInputSchema).max(MAX_ZONES, `Up to ${MAX_ZONES} areas.`) })
  .superRefine(({ zones }, ctx) => {
    const seen = new Map<string, number>();
    zones.forEach((z, i) => {
      const key = z.name.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["zones", i, "name"], message: "This area is listed twice." });
      seen.set(key, i);
    });
  });

export const deliverySettingsSchema = z
  .object({
    pickupEnabled: z.boolean(),
    pickupAddress: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => (v ? v : null)),
    freeDeliveryOverPesewas: z.number().int().positive().max(10_000_000).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.pickupEnabled && !s.pickupAddress) {
      ctx.addIssue({ code: "custom", path: ["pickupAddress"], message: "Say where customers pick up." });
    }
  });

export type ZoneInput = z.input<typeof zoneInputSchema>;
export type ZoneDto = { id: string; name: string; feePesewas: number; etaLabel: string | null };
export type DeliverySettings = z.output<typeof deliverySettingsSchema>;
export type DeliveryConfigDto = { zones: ZoneDto[]; settings: DeliverySettings };

export type DeliveryQuote =
  | { ok: true; feePesewas: number; totalPesewas: number; freeApplied: boolean }
  | { ok: false; reason: string };

/**
 * The one place a delivery fee is decided. The seller's preview and the
 * customer's checkout both call this, so they can't disagree.
 */
export function quoteDelivery(input: {
  subtotalPesewas: number;
  fulfilment: "delivery" | "pickup";
  zone: Pick<ZoneDto, "feePesewas"> | null;
  settings: Pick<DeliverySettings, "pickupEnabled" | "freeDeliveryOverPesewas">;
}): DeliveryQuote {
  const { subtotalPesewas: sub, fulfilment, zone, settings } = input;
  if (fulfilment === "pickup") {
    if (!settings.pickupEnabled) return { ok: false, reason: "This store doesn't offer pickup." };
    return { ok: true, feePesewas: 0, totalPesewas: sub, freeApplied: false };
  }
  if (!zone) return { ok: false, reason: "This store doesn't deliver to that area." };
  const free = settings.freeDeliveryOverPesewas !== null && sub >= settings.freeDeliveryOverPesewas;
  const fee = free ? 0 : zone.feePesewas;
  return { ok: true, feePesewas: fee, totalPesewas: sub + fee, freeApplied: free && zone.feePesewas > 0 };
}
