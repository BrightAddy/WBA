import { describe, expect, it } from "vitest";
import { normalizeGhanaPhone, formatGhanaPhone } from "./phone.ts";
import { slugify, validateSlug } from "./slug.ts";
import { parseCedis, formatCedis } from "./money.ts";
import { onboardingSchema } from "./schemas.ts";

describe("normalizeGhanaPhone", () => {
  it.each([
    ["024 123 4567", "+233241234567"],
    ["0241234567", "+233241234567"],
    ["241234567", "+233241234567"],
    ["233241234567", "+233241234567"],
    ["+233 (0)24 123 4567", "+233241234567"],
    ["00233-55-123-4567", "+233551234567"],
  ])("%s -> %s", (input, e164) => {
    expect(normalizeGhanaPhone(input)).toEqual({ ok: true, e164 });
  });

  it.each(["12345", "0301234567", "+2332412345678", "abc"])("rejects %s", (input) => {
    expect(normalizeGhanaPhone(input).ok).toBe(false);
  });

  it("formats for display", () => {
    expect(formatGhanaPhone("+233241234567")).toBe("024 123 4567");
  });
});

describe("slugs", () => {
  it("slugifies store names", () => {
    expect(slugify("Kofi's Thrift Hub!!")).toBe("kofis-thrift-hub");
    expect(slugify("  Àma   Wear  ")).toBe("ama-wear");
  });
  it("rejects reserved, short and malformed slugs", () => {
    expect(validateSlug("admin").ok).toBe(false);
    expect(validateSlug("ab").ok).toBe(false);
    expect(validateSlug("bad--slug").ok).toBe(false);
    expect(validateSlug("-edge").ok).toBe(false);
    expect(validateSlug("kofi-thrift").ok).toBe(true);
  });
});

describe("money", () => {
  it("parses cedis to integer pesewas", () => {
    expect(parseCedis("85")).toBe(8500);
    expect(parseCedis("85.5")).toBe(8550);
    expect(parseCedis("GH₵ 1,200.05")).toBe(120005);
    expect(parseCedis("1.234")).toBeNull();
    expect(parseCedis("-5")).toBeNull();
  });
  it("formats pesewas", () => {
    expect(formatCedis(8500)).toBe("GH₵85");
    expect(formatCedis(8550)).toBe("GH₵85.50");
    expect(formatCedis(120000)).toBe("GH₵1,200");
  });
});

describe("onboardingSchema", () => {
  const base = { ownerName: "Kofi Mensah", storeName: "Kofi Thrift", slug: "kofi-thrift" };
  it("requires at least one social profile", () => {
    expect(onboardingSchema.safeParse(base).success).toBe(false);
    expect(
      onboardingSchema.safeParse({ ...base, instagramUrl: "https://instagram.com/kofithrift" }).success,
    ).toBe(true);
  });
  it("rejects a social link from the wrong site", () => {
    const r = onboardingSchema.safeParse({ ...base, tiktokUrl: "https://instagram.com/x" });
    expect(r.success).toBe(false);
  });
});

import { productInputSchema } from "./catalogue.ts";
import { quoteDelivery, zonesInputSchema } from "./delivery.ts";

describe("productInputSchema", () => {
  const base = {
    title: "Carhartt hoodie",
    category: "Hoodies and jackets",
    pricePesewas: 8500,
    variants: [{ size: "M", stock: 2 }, { size: "L", stock: 0 }],
    imageIds: [],
  };
  it("accepts a valid product", () => {
    expect(productInputSchema.safeParse(base).success).toBe(true);
  });
  it("rejects duplicate size/colour combos case-insensitively", () => {
    const r = productInputSchema.safeParse({ ...base, variants: [{ size: "M", stock: 1 }, { size: "m", stock: 2 }] });
    expect(r.success).toBe(false);
  });
  it("requires the old price to be higher", () => {
    expect(productInputSchema.safeParse({ ...base, compareAtPesewas: 8000 }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, compareAtPesewas: 12000 }).success).toBe(true);
  });
  it("rejects fractional pesewas", () => {
    expect(productInputSchema.safeParse({ ...base, pricePesewas: 85.5 }).success).toBe(false);
  });
});

describe("delivery", () => {
  const settings = { pickupEnabled: true, freeDeliveryOverPesewas: 50000 };
  it("adds the zone fee", () => {
    expect(quoteDelivery({ subtotalPesewas: 18000, fulfilment: "delivery", zone: { feePesewas: 1500 }, settings }))
      .toEqual({ ok: true, feePesewas: 1500, totalPesewas: 19500, freeApplied: false });
  });
  it("waives the fee at the free-delivery threshold", () => {
    const q = quoteDelivery({ subtotalPesewas: 50000, fulfilment: "delivery", zone: { feePesewas: 1500 }, settings });
    expect(q).toEqual({ ok: true, feePesewas: 0, totalPesewas: 50000, freeApplied: true });
  });
  it("refuses unknown areas and disabled pickup", () => {
    expect(quoteDelivery({ subtotalPesewas: 1, fulfilment: "delivery", zone: null, settings }).ok).toBe(false);
    expect(
      quoteDelivery({ subtotalPesewas: 1, fulfilment: "pickup", zone: null, settings: { ...settings, pickupEnabled: false } }).ok,
    ).toBe(false);
  });
  it("rejects duplicate zone names", () => {
    const r = zonesInputSchema.safeParse({ zones: [{ name: "Madina", feePesewas: 1500 }, { name: "madina ", feePesewas: 2000 }] });
    expect(r.success).toBe(false);
  });
});
