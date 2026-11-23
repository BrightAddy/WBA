import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createDb, type Db } from "../src/db/client.ts";
import { loadEnv } from "../src/env.ts";
import { MemoryChatClient, MemoryOrderNotifier, MemoryOtpSender } from "../src/lib/whatsapp.ts";
import type { Assistant } from "../src/modules/bot/assistant.ts";
import { LocalStorage } from "../src/lib/storage.ts";

export const ORIGIN = "http://localhost:5173";
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://kiosk:kiosk@localhost:5432/kiosk_test";

export const WA_SECRET = "test-app-secret";
export const WA_VERIFY = "test-verify-token";

export async function setupTestApp(opts: { assistant?: Assistant; env?: Record<string, string> } = {}) {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB_URL,
    WEB_ORIGIN: ORIGIN,
    OTP_SECRET: "test-secret-test-secret-test-secret-xx",
    ADMIN_PHONES: "+233200000000",
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_BOT_NUMBER: "233201234567",
    ...opts.env,
  });
  const { db, pool } = createDb(TEST_DB_URL);
  const sender = new MemoryOtpSender();
  const storage = new LocalStorage(mkdtempSync(join(tmpdir(), "kiosk-media-")));
  const notifier = new MemoryOrderNotifier();
  const chat = new MemoryChatClient();
  const app = await buildApp({
    env,
    db,
    otpSender: sender,
    orderNotifier: notifier,
    chatClient: chat,
    ...(opts.assistant && { assistant: opts.assistant }),
    storage,
    logger: false,
  });
  return { app, db, pool, sender, storage, notifier, chat };
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

/** Signed-in seller with a store; returns their cookie. */
export async function signUpSeller(app: FastifyInstance, sender: MemoryOtpSender, phone: string, slug: string) {
  const cookie = await signIn(app, sender, phone);
  const r = await post(app, "/api/sellers/onboarding", {
    ownerName: "Test Seller",
    storeName: slug,
    slug,
    instagramUrl: `https://instagram.com/${slug.replace(/-/g, "")}`,
  }, cookie);
  if (r.statusCode !== 201) throw new Error(`onboarding failed: ${r.body}`);
  return cookie;
}

/** A real JPEG with EXIF (including an orientation flag) to exercise the pipeline. */
export function makeJpeg(width = 1200, height = 900, orientation?: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "seller home", Artist: "phone" } })
    .withMetadata(orientation ? { orientation } : {})
    .toBuffer();
}

export function multipart(file: Buffer, filename = "photo.jpg", contentType = "image/jpeg") {
  const boundary = "----kiosktest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(app: FastifyInstance, cookie: string, file: Buffer, filename?: string, type?: string) {
  const m = multipart(file, filename, type);
  return app.inject({
    method: "POST",
    url: "/api/seller/images",
    payload: m.payload,
    headers: { origin: ORIGIN, cookie, "content-type": m.contentType },
  });
}

export function send(app: FastifyInstance, method: "PUT" | "DELETE" | "GET", url: string, cookie: string, body?: unknown) {
  return app.inject({
    method,
    url,
    ...(body !== undefined && { payload: body as object }),
    headers: { origin: ORIGIN, cookie },
  });
}

/** Stores start pending until reviewed; tests that need a live store approve it directly. */
export async function approve(db: Db, slug: string) {
  await db.execute(sql`UPDATE sellers SET status = 'approved', approved_at = now() WHERE slug = ${slug}`);
}

/** Creates and publishes a product through the real endpoints. */
export async function makeProduct(
  app: FastifyInstance,
  cookie: string,
  opts: {
    title?: string;
    pricePesewas?: number;
    variants?: { size?: string; color?: string; stock: number; pricePesewas?: number }[];
    publish?: boolean;
  } = {},
) {
  const img = (await upload(app, cookie, await makeJpeg(800, 1000))).json().image;
  const created = await post(
    app,
    "/api/seller/products",
    {
      title: opts.title ?? "Carhartt hoodie",
      category: "Hoodies and jackets",
      pricePesewas: opts.pricePesewas ?? 8500,
      variants: opts.variants ?? [{ size: "M", stock: 3 }],
      imageIds: [img.id],
    },
    cookie,
  );
  if (created.statusCode !== 201) throw new Error(`product failed: ${created.body}`);
  const product = created.json().product;
  if (opts.publish !== false) {
    const r = await post(app, `/api/seller/products/${product.id}/status`, { status: "active" }, cookie);
    if (r.statusCode !== 200) throw new Error(`publish failed: ${r.body}`);
  }
  return product as { id: string; variants: { id: string; size: string | null }[] };
}
