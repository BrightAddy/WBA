import { z } from "zod";
import { normalizeGhanaPhone } from "./phone.ts";
import { validateSlug } from "./slug.ts";

export const phoneSchema = z.string().trim().transform((v, ctx) => {
  const r = normalizeGhanaPhone(v);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.reason });
    return z.NEVER;
  }
  return r.e164;
});

export const slugSchema = z.string().trim().toLowerCase().superRefine((v, ctx) => {
  const r = validateSlug(v);
  if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
});

const socialUrl = (hosts: string[]) =>
  z
    .string()
    .trim()
    .url("Paste the full link to your profile.")
    .refine((u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, "");
        return hosts.includes(h);
      } catch {
        return false;
      }
    }, `Use a link from ${hosts[0]}.`);

export const otpRequestSchema = z.object({ phone: phoneSchema });

export const otpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

export const onboardingSchema = z
  .object({
    ownerName: z.string().trim().min(2, "Enter your name.").max(80),
    storeName: z.string().trim().min(2, "Enter a store name.").max(60),
    slug: slugSchema,
    instagramUrl: socialUrl(["instagram.com"]).optional().or(z.literal("").transform(() => undefined)),
    tiktokUrl: socialUrl(["tiktok.com"]).optional().or(z.literal("").transform(() => undefined)),
  })
  .refine((v) => v.instagramUrl || v.tiktokUrl, {
    message: "Add your Instagram or TikTok so we can verify your store.",
    path: ["instagramUrl"],
  });

export type OtpRequest = z.input<typeof otpRequestSchema>;
export type OtpVerify = z.input<typeof otpVerifySchema>;
export type OnboardingInput = z.input<typeof onboardingSchema>;

export const ACCOUNT_ROLES = ["seller", "admin"] as const;
export const SELLER_STATUSES = ["pending", "approved", "suspended", "banned"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export type SellerStatus = (typeof SELLER_STATUSES)[number];

/** Shape returned by GET /auth/me, shared so the web app can't drift from the API. */
export type MeResponse = {
  account: { id: string; phone: string; role: AccountRole };
  seller: null | {
    id: string;
    ownerName: string;
    storeName: string;
    slug: string;
    status: SellerStatus;
    instagramUrl: string | null;
    tiktokUrl: string | null;
    createdAt: string;
  };
};

/** Uniform API error body. `fields` carries per-field validation messages. */
export type ApiError = {
  error: { code: string; message: string; fields?: Record<string, string> };
};
