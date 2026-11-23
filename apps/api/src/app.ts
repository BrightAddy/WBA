import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { ApiError } from "@kiosk/shared";
import type { Env } from "./env.ts";
import type { Db } from "./db/client.ts";
import { AppError } from "./lib/errors.ts";
import {
  ConsoleOrderNotifier,
  ConsoleOtpSender,
  WhatsAppOrderNotifier,
  WhatsAppOtpSender,
  type OrderNotifier,
  type OtpSender,
} from "./lib/whatsapp.ts";
import { createAuthService, type AuthService } from "./modules/auth/service.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { sellerRoutes } from "./modules/sellers/routes.ts";
import { authPlugin } from "./plugins/auth.ts";
import { LocalStorage, type Storage } from "./lib/storage.ts";
import { MAX_UPLOAD_BYTES } from "./lib/images.ts";
import { createCatalogueService, type CatalogueService } from "./modules/catalogue/service.ts";
import { createDeliveryService, type DeliveryService } from "./modules/delivery/service.ts";
import { sellerDashboardRoutes } from "./modules/seller-dashboard/routes.ts";
import { createStoreService, type StoreService } from "./modules/store/service.ts";
import { storeRoutes } from "./modules/store/routes.ts";
import { createOrdersService, type OrdersService } from "./modules/orders/service.ts";
import { webShell } from "./modules/web-shell/routes.ts";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    db: Db;
    auth: AuthService;
    storage: Storage;
    catalogue: CatalogueService;
    delivery: DeliveryService;
    store: StoreService;
    orders: OrdersService;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Paths called by third parties (Meta, Paystack) that authenticate by signature instead. */
const ORIGIN_EXEMPT = [/^\/api\/webhooks\//];

export type BuildOptions = {
  env: Env;
  db: Db;
  otpSender?: OtpSender;
  orderNotifier?: OrderNotifier;
  storage?: Storage;
  logger?: boolean;
};

export async function buildApp({ env, db, otpSender, orderNotifier, storage, logger = true }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? env.NODE_ENV === "development"
        ? { level: "info", transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
        : { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] }
      : false,
    trustProxy: env.NODE_ENV === "production",
    bodyLimit: 256 * 1024,
  });

  const sender =
    otpSender ??
    (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? new WhatsAppOtpSender(env, app.log) : new ConsoleOtpSender(app.log));

  const notifier =
    orderNotifier ??
    (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? new WhatsAppOrderNotifier(env, app.log) : new ConsoleOrderNotifier(app.log));

  app.decorate("env", env);
  app.decorate("db", db);
  const store = storage ?? new LocalStorage(env.MEDIA_DIR);
  app.decorate("auth", createAuthService({ db, otpSecret: env.OTP_SECRET, adminPhones: env.ADMIN_PHONES, sender }));
  app.decorate("storage", store);
  app.decorate("catalogue", createCatalogueService({ db, storage: store }));
  app.decorate("delivery", createDeliveryService({ db }));
  app.decorate("store", createStoreService({ db, storage: store, notifier, log: app.log }));
  app.decorate("orders", createOrdersService({ db }));

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
  // Dev/self-hosted media. In production a CDN in front of R2 serves these instead.
  if (store instanceof LocalStorage) {
    await app.register(fastifyStatic, {
      root: store.rootDir,
      prefix: "/media/",
      decorateReply: false,
      immutable: true,
      maxAge: "365d",
    });
  }
  // Per-IP limits. Per-phone OTP limits live in the auth service and are always on.
  await app.register(rateLimit, {
    global: false,
    ...(env.NODE_ENV === "test" && { allowList: () => true }),
  });

  // CSRF: SameSite=Lax covers most of it; also refuse state-changing requests
  // whose Origin isn't the web app.
  app.addHook("onRequest", async (req) => {
    if (SAFE_METHODS.has(req.method) || ORIGIN_EXEMPT.some((r) => r.test(req.url))) return;
    if (req.headers.origin !== env.WEB_ORIGIN) {
      throw new AppError(403, "bad_origin", "Request blocked.");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: ApiError = { error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) } };
      return reply.code(err.status).send(body);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests. Slow down a little." } });
    }
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: "That request couldn't be read." } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong on our side." } });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(
    async (api) => {
      // Called directly, not registered, so its hook applies to sibling routes.
      await authPlugin(api);
      await api.register(authRoutes);
      await api.register(sellerRoutes);
      await api.register(storeRoutes);
      await api.register(sellerDashboardRoutes, { prefix: "/seller" });
    },
    { prefix: "/api" },
  );

  // Last, so its not-found handler only sees what no API route claimed.
  if (env.WEB_DIST) await webShell(app, env.WEB_DIST);

  return app;
}
