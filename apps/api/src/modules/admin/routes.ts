import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { suspendSchema } from "@kiosk/shared";
import { fromZod } from "../../lib/errors.ts";
import { requireAdmin } from "../../plugins/auth.ts";

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ status: z.enum(["pending", "approved", "suspended"]).default("pending") });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

/** Owner-only tools. Every change is written to the audit log. */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/sellers", async (req) => {
    const { status } = parse(listQuery, req.query);
    const [sellers, counts] = await Promise.all([app.admin.listSellers(status), app.admin.counts()]);
    return { sellers, counts };
  });

  app.post("/sellers/:id/approve", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await app.admin.decide(req.account!.id, id, "approve");
    return reply.code(204).send();
  });

  app.post("/sellers/:id/suspend", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(suspendSchema, req.body);
    await app.admin.decide(req.account!.id, id, "suspend", reason);
    return reply.code(204).send();
  });
}
