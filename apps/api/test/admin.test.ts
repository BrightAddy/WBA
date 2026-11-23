import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeProduct, post, resetDb, send, setupTestApp, signIn, signUpSeller } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: string;
let kofi: string;
let ama: string;

beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});
beforeEach(async () => {
  await resetDb(t.db);
  admin = await signIn(t.app, t.sender, "0200000000"); // listed in ADMIN_PHONES
  kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  ama = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
});

const list = (status = "pending", cookie = admin) => send(t.app, "GET", `/api/admin/sellers?status=${status}`, cookie);
const idOf = async (slug: string) =>
  ((await t.db.execute(sql`SELECT id FROM sellers WHERE slug = ${slug}`)).rows[0] as { id: string }).id;
const storeStatus = async (slug: string, cookie?: string) =>
  (await t.app.inject({ method: "GET", url: `/api/stores/${slug}`, ...(cookie && { headers: { cookie } }) })).statusCode;

describe("admin access", () => {
  it("is for admins only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/admin/sellers" })).statusCode).toBe(401);
    expect((await list("pending", kofi)).statusCode).toBe(403);
    const id = await idOf("ama-wear");
    expect((await post(t.app, `/api/admin/sellers/${id}/approve`, {}, kofi)).statusCode).toBe(403);
    expect(await storeStatus("ama-wear")).toBe(404);
  });
});

describe("review queue", () => {
  it("lists pending stores oldest first with the details needed to check them", async () => {
    await makeProduct(t.app, kofi);
    const r = (await list()).json();
    expect(r.counts).toEqual({ pending: 2, approved: 0, suspended: 0 });
    expect(r.sellers.map((s: { slug: string }) => s.slug)).toEqual(["kofi-thrift", "ama-wear"]);
    expect(r.sellers[0]).toMatchObject({
      phone: "+233241234567",
      instagramUrl: "https://instagram.com/kofithrift",
      status: "pending",
      liveProducts: 1,
      deliveryAreas: 0,
      orders: 0,
    });
  });

  it("approves a store, makes it public, and records who did it", async () => {
    const id = await idOf("kofi-thrift");
    expect(await storeStatus("kofi-thrift")).toBe(404);
    expect((await post(t.app, `/api/admin/sellers/${id}/approve`, {}, admin)).statusCode).toBe(204);
    expect(await storeStatus("kofi-thrift")).toBe(200);
    expect((await list("pending")).json().counts).toEqual({ pending: 1, approved: 1, suspended: 0 });
    expect((await list("approved")).json().sellers[0].slug).toBe("kofi-thrift");

    const audit = await t.db.execute(sql`SELECT action, entity_id, data FROM audit_log`);
    expect(audit.rows).toEqual([{ action: "seller.approve", entity_id: id, data: { from: "pending" } }]);
    expect((await post(t.app, `/api/admin/sellers/${id}/approve`, {}, admin)).statusCode).toBe(409);
  });

  it("suspends with a recorded reason, hides the store and can reinstate it", async () => {
    const id = await idOf("kofi-thrift");
    await post(t.app, `/api/admin/sellers/${id}/approve`, {}, admin);

    const noReason = await post(t.app, `/api/admin/sellers/${id}/suspend`, { reason: " " }, admin);
    expect(noReason.statusCode).toBe(400);
    expect(await storeStatus("kofi-thrift")).toBe(200);

    expect((await post(t.app, `/api/admin/sellers/${id}/suspend`, { reason: "Fake Instagram page" }, admin)).statusCode).toBe(204);
    expect(await storeStatus("kofi-thrift")).toBe(404);
    expect((await list("suspended")).json().sellers[0]).toMatchObject({ slug: "kofi-thrift", suspendedReason: "Fake Instagram page" });
    expect((await send(t.app, "GET", "/api/seller/products", kofi)).statusCode).toBe(403); // locked out of the dashboard

    expect((await post(t.app, `/api/admin/sellers/${id}/approve`, {}, admin)).statusCode).toBe(204);
    expect(await storeStatus("kofi-thrift")).toBe(200);
    expect((await list("suspended")).json().sellers).toEqual([]);
  });

  it("refuses to touch banned sellers and unknown ids", async () => {
    const id = await idOf("kofi-thrift");
    await t.db.execute(sql`UPDATE sellers SET status = 'banned' WHERE id = ${id}`);
    expect((await post(t.app, `/api/admin/sellers/${id}/approve`, {}, admin)).statusCode).toBe(409);
    expect((await post(t.app, `/api/admin/sellers/${crypto.randomUUID()}/approve`, {}, admin)).statusCode).toBe(404);
  });

  it("lets an admin preview a pending store, but not another seller", async () => {
    expect(await storeStatus("kofi-thrift", admin)).toBe(200);
    expect(await storeStatus("kofi-thrift", ama)).toBe(404);
    expect(await storeStatus("kofi-thrift", kofi)).toBe(200);
  });
});
