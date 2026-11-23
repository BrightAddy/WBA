import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { sellers } from "../db/schema.ts";
import { AppError, forbidden, unauthorized } from "../lib/errors.ts";

type Seller = typeof sellers.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    seller: Seller | null;
  }
}

/**
 * Resolves the signed-in account's store. Pending stores may build their
 * catalogue while in review; suspended and banned stores are locked out.
 */
export async function requireSeller(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.account) throw unauthorized();
  const [seller] = await req.server.db.select().from(sellers).where(eq(sellers.accountId, req.account.id)).limit(1);
  if (!seller) throw new AppError(409, "not_onboarded", "Set up your store first.");
  if (seller.status === "suspended" || seller.status === "banned") {
    throw forbidden("Your store is suspended. Contact support.");
  }
  req.seller = seller;
}
