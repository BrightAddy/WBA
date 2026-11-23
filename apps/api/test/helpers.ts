import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createDb, type Db } from "../src/db/client.ts";
import { loadEnv } from "../src/env.ts";
import { MemoryOtpSender } from "../src/lib/whatsapp.ts";

export const ORIGIN = "http://localhost:5173";
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://kiosk:kiosk@localhost:5432/kiosk_test";

export async function setupTestApp() {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB_URL,
    WEB_ORIGIN: ORIGIN,
    OTP_SECRET: "test-secret-test-secret-test-secret-xx",
    ADMIN_PHONES: "+233200000000",
  });
  const { db, pool } = createDb(TEST_DB_URL);
  const sender = new MemoryOtpSender();
  const app = await buildApp({ env, db, otpSender: sender, logger: false });
  return { app, db, pool, sender };
}

export async function resetDb(db: Db) {
  await db.execute(sql`
    TRUNCATE audit_log, blocklist, complaints, messages, conversations, order_events, order_items,
      orders, customers, product_variants, product_images, products, delivery_zones, sellers,
      sessions, otp_challenges, accounts RESTART IDENTITY CASCADE`);
}

/** POST JSON with the web app's Origin, optionally carrying a session cookie. */
export function post(app: FastifyInstance, url: string, body: unknown, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    payload: body as object,
    headers: { origin: ORIGIN, ...(cookie && { cookie }) },
  });
}

export function cookieFrom(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((c) => c.name === "kiosk_session");
  return c ? `kiosk_session=${c.value}` : undefined;
}

/** Full sign-in through the real endpoints; returns the session cookie. */
export async function signIn(app: FastifyInstance, sender: MemoryOtpSender, phone = "0241234567") {
  const req = await post(app, "/api/auth/otp/request", { phone });
  const { challengeId } = req.json();
  const e164 = "+233" + phone.replace(/^0/, "");
  const res = await post(app, "/api/auth/otp/verify", { challengeId, code: sender.sent.get(e164) });
  return cookieFrom(res)!;
}
