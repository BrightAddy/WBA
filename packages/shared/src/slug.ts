/** Store slugs live at the root of the domain, so app routes must be reserved. */
export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "login", "logout", "signup", "register", "onboarding",
  "dashboard", "seller", "sellers", "store", "stores", "shop", "shops", "discover",
  "explore", "search", "cart", "checkout", "order", "orders", "pay", "payment",
  "payments", "webhook", "webhooks", "help", "support", "terms", "privacy", "about",
  "pricing", "blog", "static", "assets", "kiosk", "www", "mail", "status", "settings",
]);

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,30}[a-z0-9]$/;

/** "Kofi's Thrift Hub!!" -> "kofis-thrift-hub" */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

export type SlugCheck = { ok: true } | { ok: false; reason: string };

export function validateSlug(slug: string): SlugCheck {
  if (slug.length < SLUG_MIN) return { ok: false, reason: `Use at least ${SLUG_MIN} characters.` };
  if (slug.length > SLUG_MAX) return { ok: false, reason: `Keep it under ${SLUG_MAX + 1} characters.` };
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, reason: "Use lowercase letters, numbers and single hyphens." };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "That name is reserved. Try another." };
  return { ok: true };
}
