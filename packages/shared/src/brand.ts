/** Placeholder brand. Rename here and in tokens.css once the name is final. */
export const BRAND = {
  name: "Kiosk",
  domain: "kiosk.app",
  sessionCookie: "kiosk_session",
} as const;

/** Store URL as shown to sellers and customers. */
export const storeUrl = (slug: string) => `${BRAND.domain}/${slug}`;
