import type { FastifyInstance, FastifyReply } from "fastify";
import { BRAND } from "@kiosk/shared";

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(BRAND.sessionCookie, token, {
    httpOnly: true,
    secure: app.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}
