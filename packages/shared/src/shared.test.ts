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
