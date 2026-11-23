import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { RESERVED_SLUGS, formatCedis } from "@kiosk/shared";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Meta = { title: string; description: string; image: string | null; url: string };

/**
 * Serves the built web app and, for store and product URLs, injects link-preview
 * tags. Crawlers (WhatsApp, Instagram, Facebook) don't run JavaScript, so a
 * client-rendered page would show up as a blank link without this.
 */
export async function webShell(app: FastifyInstance, distDir: string) {
  const root = resolve(distDir);
  const template = readFileSync(join(root, "index.html"), "utf8");
  const base = (app.env.PUBLIC_URL ?? app.env.WEB_ORIGIN).replace(/\/$/, "");
  const absolute = (u: string) => (u.startsWith("/") ? `${base}${u}` : u);

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    index: false,
    wildcard: false,
    decorateReply: false,
    setHeaders: (res, path) => {
      // Vite fingerprints everything under /assets, so it can be cached forever.
      res.header("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  async function metaFor(pathname: string): Promise<Meta | null> {
    const [slug, kind, id] = pathname.split("/").filter(Boolean);
    if (!slug || RESERVED_SLUGS.has(slug.toLowerCase())) return null;
    try {
      const store = await app.store.getStore(slug, null);
      const url = `${base}/${store.slug}`;
      if (kind === "p" && id && UUID.test(id)) {
        const p = await app.store.getProduct(slug, id, null);
        const img = p.images[0];
        return {
          title: `${p.title} · ${store.name}`,
          description: `${formatCedis(p.pricePesewas)}${p.soldOut ? " (sold out)" : ""}. ${p.description ?? `Order from ${store.name}.`}`.slice(0, 200),
          image: img ? absolute(img.urls[720] ?? Object.values(img.urls)[0]!) : null,
          url: `${url}/p/${p.id}`,
        };
      }
      if (kind) return null;
      const cover = store.products.find((p) => p.cover)?.cover;
      return {
        title: store.name,
        description: (store.bio ?? `Shop ${store.name} and order on WhatsApp.`).slice(0, 200),
        image: cover ? absolute(cover.urls[720] ?? Object.values(cover.urls)[0]!) : null,
        url,
      };
    } catch {
      return null; // unknown or not-live store: plain app shell, no tags
    }
  }

  function render(meta: Meta | null) {
    if (!meta) return template;
    const tags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${esc(meta.title)}">`,
      `<meta property="og:description" content="${esc(meta.description)}">`,
      `<meta property="og:url" content="${esc(meta.url)}">`,
      ...(meta.image
        ? [`<meta property="og:image" content="${esc(meta.image)}">`, `<meta name="twitter:card" content="summary_large_image">`]
        : [`<meta name="twitter:card" content="summary">`]),
      `<meta name="description" content="${esc(meta.description)}">`,
    ].join("\n    ");
    return template
      .replace(/<title>.*?<\/title>/s, `<title>${esc(meta.title)}</title>`)
      .replace("</head>", `    ${tags}\n  </head>`);
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (req.method !== "GET" || path.startsWith("/api/") || path.startsWith("/media/") || /\.[a-z0-9]+$/i.test(path)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    }
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(render(await metaFor(path)));
  });
}
