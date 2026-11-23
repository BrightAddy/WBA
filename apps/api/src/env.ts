import { z } from "zod";
import { normalizeGhanaPhone } from "@kiosk/shared";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(3000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().url(),
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
    WHATSAPP_OTP_TEMPLATE_LANG: z.string().default("en"),
    WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
  })
  .superRefine((env, ctx) => {
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
