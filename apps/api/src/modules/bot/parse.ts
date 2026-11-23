import { createHmac } from "node:crypto";
import { safeEqual } from "../../lib/crypto.ts";

/** One thing a customer sent us. */
export type Inbound = {
  /** Meta's id, unique per message; our dedupe key. */
  waId: string;
  /** Sender in E.164 (+233…). */
  from: string;
  /** The customer's WhatsApp profile name, if Meta sent it. */
  profileName: string | null;
  /** Meta's type: "text", "image", "audio", "button", … */
  type: string;
  /** Only set for text messages. */
  text: string | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Pulls customer messages out of Meta's payload. Defensive on purpose: Meta adds
 * fields, sends status receipts through the same URL, and we must never throw
 * on a shape we don't recognise (a 500 makes Meta retry the same call for days).
 */
export function parseWebhook(body: unknown): Inbound[] {
  const out: Inbound[] = [];
  if (!isObj(body)) return out;
  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const names = new Map<string, string>();
      for (const c of arr(change.value.contacts)) {
        if (isObj(c) && typeof c.wa_id === "string" && isObj(c.profile) && typeof c.profile.name === "string") {
          names.set(c.wa_id, c.profile.name);
        }
      }
      for (const m of arr(change.value.messages)) {
        if (!isObj(m) || typeof m.id !== "string" || typeof m.from !== "string" || typeof m.type !== "string") continue;
        if (!/^\d{8,15}$/.test(m.from)) continue;
        const text = m.type === "text" && isObj(m.text) && typeof m.text.body === "string" ? m.text.body : null;
        out.push({
          waId: m.id,
          from: `+${m.from}`,
          profileName: names.get(m.from)?.slice(0, 60) ?? null,
          type: m.type,
          text,
        });
      }
    }
  }
  return out;
}

/** Meta signs the exact bytes it sends: `sha256=<hex hmac>` with the app secret. */
export function validSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice("sha256=".length), expected);
}
