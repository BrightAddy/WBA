import type { FastifyPluginAsync } from "fastify";
import { safeEqual } from "../../lib/crypto.ts";
import { parseWebhook, validSignature } from "./parse.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Meta's webhook: GET proves we own the URL, POST delivers messages. Authenticated by signature, not cookie. */
export const botRoutes: FastifyPluginAsync = async (app) => {
  await app.register(
    async (hook) => {
      // Meta signs the exact bytes, so keep them next to the parsed body.
      hook.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
        req.rawBody = body as Buffer;
        try {
          done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
        } catch (err) {
          done(Object.assign(err as Error, { statusCode: 400 }), undefined);
        }
      });

      hook.get("/whatsapp", async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const expected = app.env.WHATSAPP_VERIFY_TOKEN;
        if (q["hub.mode"] === "subscribe" && expected && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], expected) && q["hub.challenge"]) {
          return reply.type("text/plain").send(q["hub.challenge"]);
        }
        return reply.code(403).send("Forbidden");
      });

      let warned = false;
      hook.post("/whatsapp", async (req, reply) => {
        const secret = app.env.WHATSAPP_APP_SECRET;
        if (secret) {
          if (!req.rawBody || !validSignature(secret, req.rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
            return reply.code(401).send({ ok: false });
          }
        } else if (!warned) {
          // Production refuses to boot without a secret; this is local testing only.
          warned = true;
          req.log.warn("WHATSAPP_APP_SECRET not set: accepting unsigned webhook calls (dev only)");
        }

        // Answer Meta straight away; replies are sent in the background.
        for (const m of parseWebhook(req.body)) app.bot.enqueue(m);
        return reply.send({ ok: true });
      });
    },
    { prefix: "/webhooks" },
  );
};
