import type { FastifyInstance } from "fastify";
import { onboardingSchema, slugSchema } from "@kiosk/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sellers } from "../../db/schema.ts";
import { conflict, fromZod } from "../../lib/errors.ts";
import { requireAuth } from "../../plugins/auth.ts";

const PG_UNIQUE_VIOLATION = "23505";

async function slugTaken(app: FastifyInstance, slug: string) {
  const [row] = await app.db
    .select({ id: sellers.id })
    .from(sellers)
    .where(sql`lower(${sellers.slug}) = ${slug.toLowerCase()}`)
    .limit(1);
  return Boolean(row);
}

export async function sellerRoutes(app: FastifyInstance) {
  app.get(
    "/sellers/slug-availability",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const q = z.object({ slug: slugSchema }).safeParse(req.query);
      if (!q.success) return { available: false, reason: q.error.issues[0]?.message ?? "Invalid name." };
      return (await slugTaken(app, q.data.slug))
        ? { available: false, reason: "That link is taken. Try another." }
        : { available: true };
    },
  );

  app.post("/sellers/onboarding", { preHandler: requireAuth }, async (req, reply) => {
    const body = onboardingSchema.safeParse(req.body);
    if (!body.success) throw fromZod(body.error);
    const account = req.account!;

    const [existing] = await app.db.select({ id: sellers.id }).from(sellers).where(eq(sellers.accountId, account.id));
    if (existing) throw conflict("already_onboarded", "Your store is already set up.");

    try {
      const [seller] = await app.db
        .insert(sellers)
        .values({
          accountId: account.id,
          ownerName: body.data.ownerName,
          storeName: body.data.storeName,
          slug: body.data.slug,
          instagramUrl: body.data.instagramUrl ?? null,
          tiktokUrl: body.data.tiktokUrl ?? null,
          notifyPhone: account.phone,
          ...(app.env.AUTO_APPROVE_SELLERS && { status: "approved" as const, approvedAt: new Date() }),
        })
        .returning();
      req.log.info({ sellerId: seller!.id, slug: seller!.slug }, "seller onboarded, awaiting review");
      return reply.code(201).send({ seller: { id: seller!.id, slug: seller!.slug, status: seller!.status } });
    } catch (err) {
      // The unique index is the source of truth; the availability check is only a hint.
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION || (err as { cause?: { code?: string } }).cause?.code === PG_UNIQUE_VIOLATION) {
        throw conflict("slug_taken", "That link was just taken. Try another.", { slug: "That link is taken." });
      }
      throw err;
    }
  });
}
