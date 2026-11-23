import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { post, resetDb, setupTestApp, signIn } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});
beforeEach(async () => {
  await resetDb(t.db);
  t.sender.sent.clear();
});

const store = {
  ownerName: "Kofi Mensah",
  storeName: "Kofi Thrift",
  slug: "kofi-thrift",
  instagramUrl: "https://www.instagram.com/kofithrift",
};

describe("seller onboarding", () => {
  it("creates a pending store and shows it in /me", async () => {
    const cookie = await signIn(t.app, t.sender);
    const r = await post(t.app, "/api/sellers/onboarding", store, cookie);
    expect(r.statusCode).toBe(201);
    expect(r.json().seller).toMatchObject({ slug: "kofi-thrift", status: "pending" });

    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().seller).toMatchObject({ storeName: "Kofi Thrift", status: "pending" });
  });

  it("requires sign-in", async () => {
    const r = await post(t.app, "/api/sellers/onboarding", store);
    expect(r.statusCode).toBe(401);
  });

  it("refuses a second store for the same account", async () => {
    const cookie = await signIn(t.app, t.sender);
    await post(t.app, "/api/sellers/onboarding", store, cookie);
    const again = await post(t.app, "/api/sellers/onboarding", { ...store, slug: "kofi-2" }, cookie);
    expect(again.statusCode).toBe(409);
  });

  it("treats slugs case-insensitively and reports availability", async () => {
    const a = await signIn(t.app, t.sender, "0241234567");
    await post(t.app, "/api/sellers/onboarding", store, a);

    const check = await t.app.inject({ method: "GET", url: "/api/sellers/slug-availability?slug=KOFI-THRIFT" });
    expect(check.json()).toMatchObject({ available: false });

    const b = await signIn(t.app, t.sender, "0551234567");
    const clash = await post(t.app, "/api/sellers/onboarding", { ...store, slug: "Kofi-Thrift" }, b);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("slug_taken");
  });

  it("rejects reserved slugs and missing social proof", async () => {
    const cookie = await signIn(t.app, t.sender);
    const reserved = await post(t.app, "/api/sellers/onboarding", { ...store, slug: "admin" }, cookie);
    expect(reserved.json().error.fields.slug).toMatch(/reserved/);

    const { instagramUrl: _, ...noSocial } = store;
    const missing = await post(t.app, "/api/sellers/onboarding", noSocial, cookie);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.fields.instagramUrl).toBeTruthy();
  });
});
