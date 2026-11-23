# Kiosk

Storefronts and a shared WhatsApp assistant for online sellers in Ghana. "Kiosk" is a placeholder name; rename it in `packages/shared/src/brand.ts`.

## Layout

```
apps/api        Fastify + Drizzle + Postgres. Auth, sellers; orders/bot/payments to come.
apps/web        React 19 + Vite + Tailwind v4. Seller sign-in, onboarding, dashboard.
packages/shared Types, zod schemas, phone/slug/money helpers, design tokens.
```

## Run it

One command (needs Node 22+ and Docker Desktop running):

```bash
./scripts/dev.sh
```

Or step by step:

```bash
pnpm install
docker compose up -d                 # or use a local Postgres 16
cp .env.example apps/api/.env        # set OTP_SECRET: openssl rand -base64 48
pnpm db:migrate
pnpm dev                             # api :3000, web :5173
```

Without WhatsApp credentials, login codes are printed in the API log.

## Tests

```bash
pnpm test        # needs the kiosk_test database (see TEST_DATABASE_URL)
pnpm typecheck
```

API tests run against real Postgres, built from the committed migrations.

## Decisions worth knowing

- **Money is integer pesewas** everywhere. DB check constraints enforce `total = subtotal + delivery_fee` and `line_total = unit_price * qty`.
- **Orders snapshot** product titles, prices and the delivery zone name, so later edits never rewrite history. Status changes append to `order_events`.
- **Auth is WhatsApp OTP**, with no passwords:
  - Codes are HMAC'd with a server secret and bound to their challenge id.
  - Attempts are capped atomically in SQL.
  - A code can be used once, even under concurrent submits.
  - Sends are limited per phone (30s cooldown, 3 per 10 min, 10 per day) and per IP.
- **Sessions** are opaque tokens in an httpOnly SameSite=Lax cookie. Only their SHA-256 is stored, and they slide to 30 days when used.
- **CSRF:** state-changing requests must carry the web app's Origin. Webhook paths are exempt and will verify signatures instead.
- **Store links** live at the domain root, so app routes are reserved slugs. Uniqueness is case-insensitive and enforced by a unique index, not just the availability check.
- **Sellers start `pending`** and need an Instagram or TikTok link for review. Phones in `ADMIN_PHONES` sign in as admin.
- **Generating migrations:** after editing `apps/api/src/db/schema.ts`, run `pnpm db:generate` and commit the SQL.
