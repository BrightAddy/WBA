import { z } from "zod";
import { normalizeGhanaPhone } from "@kiosk/shared";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(3000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().url(),
    MEDIA_DIR: z.string().default(".media"),
    /** Public origin of the site, used for absolute links in link previews. Defaults to WEB_ORIGIN. */
    PUBLIC_URL: z.string().url().optional(),
    /** Built web app. When set, the API serves it and injects link-preview tags per store. */
    WEB_DIST: z.string().optional(),
    /** Skip manual approval. For local testing only; production keeps stores pending until reviewed. */
    AUTO_APPROVE_SELLERS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    OTP_SECRET: z.string().min(32, "OTP_SECRET must be at least 32 characters"),
    ADMIN_PHONES: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const r = normalizeGhanaPhone(p);
            if (!r.ok) throw new Error(`ADMIN_PHONES: invalid number "${p}"`);
            return r.e164;
          }),
      ),
    WHATSAPP_TOKEN: z.string().optional().default(""),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(""),
    WHATSAPP_OTP_TEMPLATE: z.string().default("kiosk_login_code"),
    WHATSAPP_ORDER_TEMPLATE: z.string().default("kiosk_new_order"),
    WHATSAPP_OTP_TEMPLATE_LANG: z.string().default("en"),
    WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
    /** Meta app secret; signs every webhook call (X-Hub-Signature-256). */
    WHATSAPP_APP_SECRET: z.string().optional().default(""),
    /** Any string you choose; Meta echoes it when you register the webhook URL. */
    WHATSAPP_VERIFY_TOKEN: z.string().optional().default(""),
    /** The shared bot number in international digits (233201234567), for wa.me links. */
    WHATSAPP_BOT_NUMBER: z.string().regex(/^\d{8,15}$/, "digits only, e.g. 233201234567").optional(),
    /** Blank = the assistant falls back to simple built-in replies. */
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
    /** How many messages one customer may send per 10 minutes before we stop replying. */
    BOT_CUSTOMER_BURST: z.coerce.number().int().positive().default(20),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        message: "WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are required in production (webhook must be signed).",
        path: ["WHATSAPP_APP_SECRET"],
      });
    }
    if (env.NODE_ENV === "production" && !(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)) {
      ctx.addIssue({
        code: "custom",
        message: "WhatsApp credentials are required in production (codes can't be logged).",
        path: ["WHATSAPP_TOKEN"],
      });
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${lines}`);
  }
  return r.data;
}
