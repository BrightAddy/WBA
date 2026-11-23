import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { otpChallenges, sessions } from "../src/db/schema.ts";
import { cookieFrom, ORIGIN, post, resetDb, setupTestApp, signIn } from "./helpers.ts";

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

describe("OTP sign-in", () => {
  it("signs a new seller in and returns /me", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "024 123 4567" });
    expect(r.statusCode).toBe(200);
    const { challengeId } = r.json();
    const code = t.sender.sent.get("+233241234567");
    expect(code).toMatch(/^\d{6}$/);

    const v = await post(t.app, "/api/auth/otp/verify", { challengeId, code });
    expect(v.statusCode).toBe(200);
    const cookie = v.cookies.find((c) => c.name === "kiosk_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");

    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieFrom(v)! } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ account: { phone: "+233241234567", role: "seller" }, seller: null });
  });

  it("never stores the raw code or session token", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    const code = t.sender.sent.get("+233241234567")!;
    const [row] = await t.db.select().from(otpChallenges).where(eq(otpChallenges.id, r.json().challengeId));
    expect(row!.codeHash).not.toContain(code);

    const v = await post(t.app, "/api/auth/otp/verify", { challengeId: r.json().challengeId, code });
    const token = v.cookies.find((c) => c.name === "kiosk_session")!.value;
    const rows = await t.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  it("grants admin to configured phones", async () => {
    const cookie = await signIn(t.app, t.sender, "0200000000");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().account.role).toBe("admin");
  });

  it("rejects a wrong code and locks after 5 attempts", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    const { challengeId } = r.json();
    const real = t.sender.sent.get("+233241234567")!;
    const wrong = real === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const v = await post(t.app, "/api/auth/otp/verify", { challengeId, code: wrong });
      expect(v.statusCode).toBe(400);
    }
    const late = await post(t.app, "/api/auth/otp/verify", { challengeId, code: real });
    expect(late.statusCode).toBe(400);
    expect(late.json().error.code).toBe("invalid_code");
  });

  it("rejects an expired code", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    const { challengeId } = r.json();
    await t.db.update(otpChallenges).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(otpChallenges.id, challengeId));
    const v = await post(t.app, "/api/auth/otp/verify", { challengeId, code: t.sender.sent.get("+233241234567") });
    expect(v.statusCode).toBe(400);
  });

  it("allows a code to be used only once, even concurrently", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    const body = { challengeId: r.json().challengeId, code: t.sender.sent.get("+233241234567") };
    const results = await Promise.all([1, 2, 3].map(() => post(t.app, "/api/auth/otp/verify", body)));
    expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
    expect(await t.db.select().from(sessions)).toHaveLength(1);
  });

  it("enforces the resend cooldown", async () => {
    await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    const again = await post(t.app, "/api/auth/otp/request", { phone: "0241234567" });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.message).toMatch(/Wait \d+s/);
  });

  it("validates Ghana numbers", async () => {
    const r = await post(t.app, "/api/auth/otp/request", { phone: "0301234567" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.fields.phone).toBeTruthy();
  });

  it("blocks state-changing requests from other origins", async () => {
    const r = await t.app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: { phone: "0241234567" },
      headers: { origin: "https://evil.example" },
    });
    expect(r.statusCode).toBe(403);
    expect(ORIGIN).not.toBe("https://evil.example");
  });

  it("logs out by revoking the session", async () => {
    const cookie = await signIn(t.app, t.sender);
    const out = await post(t.app, "/api/auth/logout", {}, cookie);
    expect(out.statusCode).toBe(204);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});
