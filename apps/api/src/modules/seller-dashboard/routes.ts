import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deliverySettingsSchema, productInputSchema, productStatusSchema, zonesInputSchema } from "@kiosk/shared";
import { AppError, badRequest, fromZod } from "../../lib/errors.ts";
import { MAX_UPLOAD_BYTES } from "../../lib/images.ts";
import { requireAuth } from "../../plugins/auth.ts";
import { requireSeller } from "../../plugins/seller.ts";

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ status: z.enum(["draft", "active", "archived"]).optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

/** Everything a signed-in seller manages. All queries are scoped to req.seller.id. */
export async function sellerDashboardRoutes(app: FastifyInstance) {
  app.decorateRequest("seller", null);
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireSeller);

  /* Images */

  app.post(
    "/images",
    { config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!req.isMultipart()) throw badRequest("invalid_upload", "Send the photo as a file upload.");
      let file;
      try {
        file = await req.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
      } catch {
        throw badRequest("invalid_upload", "That upload couldn't be read.");
      }
      if (!file) throw badRequest("invalid_upload", "No photo was attached.");
      const buf = await file.toBuffer().catch((e: { code?: string }) => {
        if (e.code === "FST_REQ_FILE_TOO_LARGE") throw new AppError(413, "file_too_large", "That photo is over 12 MB.");
        throw e;
      });
      const image = await app.catalogue.uploadImage(req.seller!.id, buf);
      return reply.code(201).send({ image });
    },
  );

  app.delete("/images/:id", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await app.catalogue.discardImage(req.seller!.id, id);
    return reply.code(204).send();
  });

  /* Products */

  app.get("/products", async (req) => {
    const { status } = parse(listQuery, req.query);
    return { products: await app.catalogue.listProducts(req.seller!.id, status) };
  });

  app.get("/products/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return { product: await app.catalogue.getProduct(req.seller!.id, id) };
  });

  app.post("/products", async (req, reply) => {
    const input = parse(productInputSchema, req.body);
    const product = await app.catalogue.saveProduct(req.seller!.id, input);
    return reply.code(201).send({ product });
  });

  app.put("/products/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(productInputSchema, req.body);
    return { product: await app.catalogue.saveProduct(req.seller!.id, input, id) };
  });

  app.post("/products/:id/status", async (req) => {
    const { id } = parse(idParam, req.params);
    const { status } = parse(productStatusSchema, req.body);
    return { product: await app.catalogue.setStatus(req.seller!.id, id, status) };
  });

  /* Delivery */

  app.get("/delivery", async (req) => app.delivery.getConfig(req.seller!.id));

  app.put("/delivery/zones", async (req) => {
    const { zones } = parse(zonesInputSchema, req.body);
    return app.delivery.replaceZones(req.seller!.id, zones);
  });

  app.put("/delivery/settings", async (req) => {
    const settings = parse(deliverySettingsSchema, req.body);
    return app.delivery.updateSettings(req.seller!.id, settings);
  });

  /* Orders */

  app.get("/orders", async (req) => ({ orders: await app.orders.list(req.seller!.id) }));

  app.post("/orders/:id/cancel", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await app.orders.cancelUnpaid(req.seller!.id, id, req.account!.id);
    return reply.code(204).send();
  });
}
