import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createDb } from "../src/db/client.ts";
import { loadEnv } from "../src/env.ts";
import { LocalStorage } from "../src/lib/storage.ts";
import { MemoryOrderNotifier, MemoryOtpSender } from "../src/lib/whatsapp.ts";
import { approve, makeProduct, ORIGIN, resetDb, signUpSeller } from "./helpers.ts";
import { sql } from "drizzle-orm";

const URL_ = process.env.TEST_DATABASE_URL ?? "postgres://kiosk:kiosk@localhost:5432/kiosk_test";
let app: Awaited<ReturnType<typeof buildApp>>;
let pool: ReturnType<typeof createDb>["pool"];
let db: ReturnType<typeof createDb>["db"];
const sender = new MemoryOtpSender();
let kofi: string;

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), "kiosk-dist-"));
  writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><title>Kiosk</title></head><body><div id="root"></div></body></html>`);
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  const env = loadEnv({
    NODE_ENV: "test", DATABASE_URL: URL_, WEB_ORIGIN: ORIGIN, PUBLIC_URL: "https://kiosk.test",
    OTP_SECRET: "test-secret-test-secret-test-secret-xx", WEB_DIST: dist,
  });
  ({ db, pool } = createDb(URL_));
  app = await buildApp({ env, db, otpSender: sender, orderNotifier: new MemoryOrderNotifier(), storage: new LocalStorage(mkdtempSync(join(tmpdir(), "m-"))), logger: false });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(db);
  kofi = await signUpSeller(app, sender, "0241234567", "kofi-thrift");
  await approve(db, "kofi-thrift");
  await db.execute(sql`UPDATE sellers SET bio = 'Thrift <b>finds</b> "Accra"' WHERE slug = 'kofi-thrift'`);
});

const html = (url: string) => app.inject({ method: "GET", url });

describe("link previews", () => {
  it("injects escaped store tags with an absolute image URL", async () => {
    await makeProduct(app, kofi);
    const r = await html("/kofi-thrift");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("<title>kofi-thrift</title>");
    expect(r.body).toContain('og:url" content="https://kiosk.test/kofi-thrift"');
    expect(r.body).toMatch(/og:image" content="https:\/\/kiosk\.test\/media\/products\/[^"]+\/720\.webp"/);
    expect(r.body).toContain("&lt;b&gt;finds&lt;/b&gt; &quot;Accra&quot;");
    expect(r.body).not.toContain("<b>finds</b>");
  });

  it("tags a product with its price", async () => {
    const p = await makeProduct(app, kofi, { title: "Carhartt hoodie", pricePesewas: 8500 });
    const r = await html(`/kofi-thrift/p/${p.id}`);
    expect(r.body).toContain("Carhartt hoodie · kofi-thrift");
    expect(r.body).toContain("GH₵85");
  });

  it("serves the plain shell for unknown, pending and reserved paths, and 404s for api and files", async () => {
    expect((await html("/nobody")).body).not.toContain("og:title");
    await db.execute(sql`UPDATE sellers SET status = 'pending'`);
    expect((await html("/kofi-thrift")).body).not.toContain("og:title");
    const login = await html("/login");
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('<div id="root">');
    expect((await html("/api/nope")).statusCode).toBe(404);
    expect((await html("/missing.js")).statusCode).toBe(404);
    expect((await html("/favicon.svg")).statusCode).toBe(200);
  });
});
