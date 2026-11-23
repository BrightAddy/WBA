import type { FastifyInstance } from "fastify";
import { BRAND, otpRequestSchema, otpVerifySchema, type MeResponse } from "@kiosk/shared";
import { eq } from "drizzle-orm";
import { sellers } from "../../db/schema.ts";
import { fromZod } from "../../lib/errors.ts";
import { requireAuth } from "../../plugins/auth.ts";
import { setSessionCookie } from "../../lib/session-cookie.ts";

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/otp/request",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req) => {
      const body = otpRequestSchema.safeParse(req.body);
      if (!body.success) throw fromZod(body.error);
      const r = await app.auth.requestOtp(body.data.phone, req.ip);
      return { challengeId: r.challengeId, expiresAt: r.expiresAt.toISOString(), resendAfterMs: r.resendAfterMs };
    },
  );

  app.post(
    "/auth/otp/verify",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = otpVerifySchema.safeParse(req.body);
      if (!body.success) throw fromZod(body.error);
      const { account, token, expiresAt } = await app.auth.verifyOtp(body.data.challengeId, body.data.code, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(app, reply, token, expiresAt);
      return { account: { id: account.id, phone: account.phone, role: account.role } };
    },
  );

  app.get("/auth/me", { preHandler: requireAuth }, async (req): Promise<MeResponse> => {
    const account = req.account!;
    const [seller] = await app.db.select().from(sellers).where(eq(sellers.accountId, account.id)).limit(1);
    return {
      account: { id: account.id, phone: account.phone, role: account.role },
      seller: seller
        ? {
            id: seller.id,
            ownerName: seller.ownerName,
            storeName: seller.storeName,
            slug: seller.slug,
            status: seller.status,
            instagramUrl: seller.instagramUrl,
            tiktokUrl: seller.tiktokUrl,
            createdAt: seller.createdAt.toISOString(),
          }
        : null,
    };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[BRAND.sessionCookie];
    if (token) await app.auth.revoke(token);
    reply.clearCookie(BRAND.sessionCookie, { path: "/" });
    return reply.code(204).send();
  });
}
