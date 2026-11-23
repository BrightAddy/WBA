import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkoutSchema, quoteInputSchema } from "@kiosk/shared";
import { fromZod } from "../../lib/errors.ts";

const slugParam = z.object({ slug: z.string().min(1).max(40) });
const productParams = slugParam.extend({ id: z.string().uuid() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

/** What a customer can do without signing in. Nothing here trusts client-side prices. */
export async function storeRoutes(app: FastifyInstance) {
  app.get("/stores/:slug", async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    reply.header("Cache-Control", "no-cache");
    return { store: await app.store.getStore(slug, req.account) };
  });

  app.get("/stores/:slug/products/:id", async (req, reply) => {
    const { slug, id } = parse(productParams, req.params);
    reply.header("Cache-Control", "no-cache");
    return { product: await app.store.getProduct(slug, id, req.account) };
  });

  app.post(
    "/stores/:slug/quote",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const { slug } = parse(slugParam, req.params);
      const input = parse(quoteInputSchema, req.body);
      return app.store.quote(slug, input, req.account);
    },
  );

  app.post(
    "/stores/:slug/orders",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const { slug } = parse(slugParam, req.params);
      const input = parse(checkoutSchema, req.body);
      return reply.code(201).send({ order: await app.store.placeOrder(slug, input) });
    },
  );
}
