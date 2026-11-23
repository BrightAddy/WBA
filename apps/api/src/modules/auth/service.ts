import { and, count, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, otpChallenges, sessions } from "../../db/schema.ts";
import { generateOtp, generateSessionToken, hashOtp, safeEqual, sha256 } from "../../lib/crypto.ts";
import { AppError, badRequest, tooMany } from "../../lib/errors.ts";
import type { OtpSender } from "../../lib/whatsapp.ts";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30_000;
export const OTP_WINDOW_MS = 10 * 60_000;
export const OTP_MAX_PER_WINDOW = 3;
export const OTP_MAX_PER_DAY = 10;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_REFRESH_BELOW_MS = 7 * 24 * 60 * 60_000;

type Deps = { db: Db; otpSecret: string; adminPhones: string[]; sender: OtpSender; now?: () => Date };

export function createAuthService({ db, otpSecret, adminPhones, sender, now = () => new Date() }: Deps) {
  async function requestOtp(phone: string, ip: string | undefined) {
    const t = now();

    const [recent] = await db
      .select({
        inWindow: count(sql`CASE WHEN ${otpChallenges.createdAt} >= ${new Date(t.getTime() - OTP_WINDOW_MS)} THEN 1 END`),
        inDay: count(),
        latest: sql<Date | null>`max(${otpChallenges.createdAt})`,
      })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), gte(otpChallenges.createdAt, new Date(t.getTime() - 86_400_000))));

    const latest = recent?.latest ? new Date(recent.latest) : null;
    if (latest && t.getTime() - latest.getTime() < OTP_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (t.getTime() - latest.getTime())) / 1000);
      throw tooMany(`Wait ${wait}s before asking for another code.`);
    }
    if ((recent?.inWindow ?? 0) >= OTP_MAX_PER_WINDOW || (recent?.inDay ?? 0) >= OTP_MAX_PER_DAY) {
      throw tooMany("Too many codes requested. Try again in a few minutes.");
    }

    const code = generateOtp();
    const expiresAt = new Date(t.getTime() + OTP_TTL_MS);

    // Insert first to get the id the hash is bound to, then set the hash.
    const challenge = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(otpChallenges)
        .values({ phone, codeHash: "pending", expiresAt, ip, createdAt: t })
        .returning({ id: otpChallenges.id });
      await tx
        .update(otpChallenges)
        .set({ codeHash: hashOtp(otpSecret, row!.id, code) })
        .where(eq(otpChallenges.id, row!.id));
      return row!;
    });

    try {
      await sender.sendLoginCode(phone, code);
    } catch {
      // Don't let an undelivered code count against the user's limits.
      await db.delete(otpChallenges).where(eq(otpChallenges.id, challenge.id));
      throw new AppError(502, "otp_send_failed", "We couldn't send the code on WhatsApp. Try again.");
    }

    return { challengeId: challenge.id, expiresAt, resendAfterMs: OTP_RESEND_COOLDOWN_MS };
  }

  async function verifyOtp(challengeId: string, code: string, meta: { ip?: string; userAgent?: string }) {
    const t = now();
    const invalid = () => badRequest("invalid_code", "That code is wrong or has expired.");

    // Atomically burn one attempt; returns nothing if expired, used or exhausted.
    const [row] = await db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(
        and(
          eq(otpChallenges.id, challengeId),
          isNull(otpChallenges.consumedAt),
          gt(otpChallenges.expiresAt, t),
          lt(otpChallenges.attempts, OTP_MAX_ATTEMPTS),
        ),
      )
      .returning({ phone: otpChallenges.phone, codeHash: otpChallenges.codeHash, attempts: otpChallenges.attempts });

    if (!row) throw invalid();
    if (!safeEqual(row.codeHash, hashOtp(otpSecret, challengeId, code))) {
      const left = OTP_MAX_ATTEMPTS - row.attempts;
      throw left > 0
        ? badRequest("invalid_code", `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.`)
        : badRequest("invalid_code", "Too many wrong codes. Ask for a new one.");
    }

    return db.transaction(async (tx) => {
      // Guard against two concurrent correct submissions both getting a session.
      const [consumed] = await tx
        .update(otpChallenges)
        .set({ consumedAt: t })
        .where(and(eq(otpChallenges.id, challengeId), isNull(otpChallenges.consumedAt)))
        .returning({ id: otpChallenges.id });
      if (!consumed) throw invalid();

      const isAdmin = adminPhones.includes(row.phone);
      const [account] = await tx
        .insert(accounts)
        .values({ phone: row.phone, role: isAdmin ? "admin" : "seller", lastLoginAt: t })
        .onConflictDoUpdate({
          target: accounts.phone,
          set: { lastLoginAt: t, ...(isAdmin ? { role: "admin" as const } : {}) },
        })
        .returning();

      const token = generateSessionToken();
      const expiresAt = new Date(t.getTime() + SESSION_TTL_MS);
      await tx.insert(sessions).values({
        tokenHash: sha256(token),
        accountId: account!.id,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
        createdAt: t,
      });

      return { account: account!, token, expiresAt };
    });
  }

  /** Resolves a cookie token to an account. Extends sessions nearing expiry. */
  async function authenticate(token: string) {
    const t = now();
    const tokenHash = sha256(token);
    const [hit] = await db
      .select({ account: accounts, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, t)))
      .limit(1);
    if (!hit) return null;

    let expiresAt = hit.expiresAt;
    if (expiresAt.getTime() - t.getTime() < SESSION_REFRESH_BELOW_MS) {
      expiresAt = new Date(t.getTime() + SESSION_TTL_MS);
      await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
    }
    return { account: hit.account, expiresAt, refreshed: expiresAt !== hit.expiresAt };
  }

  async function revoke(token: string) {
    await db.update(sessions).set({ revokedAt: now() }).where(eq(sessions.tokenHash, sha256(token)));
  }

  return { requestOtp, verifyOtp, authenticate, revoke };
}

export type AuthService = ReturnType<typeof createAuthService>;
