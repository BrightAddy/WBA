import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BRAND } from "@kiosk/shared";
import type { accounts } from "../db/schema.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { setSessionCookie } from "../lib/session-cookie.ts";

type Account = typeof accounts.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    account: Account | null;
  }
}

/** Resolves the session cookie on every request; routes opt in to requiring it. */
export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("account", null);

  app.addHook("onRequest", async (req, reply) => {
    const token = req.cookies[BRAND.sessionCookie];
    if (!token) return;
    const hit = await app.auth.authenticate(token);
    if (!hit) {
      reply.clearCookie(BRAND.sessionCookie, { path: "/" });
      return;
    }
    req.account = hit.account;
    if (hit.refreshed) setSessionCookie(app, reply, token, hit.expiresAt);
  });
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.account) throw unauthorized();
}

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.account) throw unauthorized();
  if (req.account.role !== "admin") throw forbidden();
}
