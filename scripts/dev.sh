#!/usr/bin/env bash
# One command to run Kiosk locally on macOS or Linux:
#   ./scripts/dev.sh
# Starts Postgres in Docker, writes apps/api/.env on first run,
# installs dependencies, applies migrations and starts the API and web app.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf "\033[1m▸ %s\033[0m\n" "$*"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────
if [ -s "$HOME/.nvm/nvm.sh" ] && ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm install 22 >/dev/null && nvm use 22 >/dev/null
fi
command -v node >/dev/null || fail "Node.js 22+ is required: https://nodejs.org"
node -v | grep -qE '^v(2[2-9]|[3-9][0-9])' || fail "Node.js 22+ is required (found $(node -v))."
if ! command -v pnpm >/dev/null; then
  say "Enabling pnpm via corepack"
  corepack enable pnpm 2>/dev/null || npm install -g pnpm@10 >/dev/null
fi
command -v docker >/dev/null || fail "Docker Desktop is required for the database: https://www.docker.com/products/docker-desktop"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Open Docker Desktop and run this again."

# ── Database ─────────────────────────────────────────────────────
# Use 5432 unless something else already holds it (e.g. a local Postgres).
PORT=5432
if lsof -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1 && ! docker compose ps --status running db 2>/dev/null | grep -q db; then
  PORT=5433
fi
export KIOSK_DB_PORT=$PORT
say "Starting Postgres on port $PORT"
docker compose up -d db >/dev/null
for _ in $(seq 1 40); do
  docker compose exec -T db pg_isready -U kiosk >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T db pg_isready -U kiosk >/dev/null 2>&1 || fail "Postgres didn't start. Run: docker compose logs db"

# ── Config ───────────────────────────────────────────────────────
ENV_FILE=apps/api/.env
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE"
  cp .env.example "$ENV_FILE"
  secret=$(openssl rand -base64 48 | tr -d '\n/+=')
  sed -i.bak "s|^OTP_SECRET=.*|OTP_SECRET=$secret|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  # Local only: new stores go live straight away so you can see the storefront.
  sed -i.bak "s|^AUTO_APPROVE_SELLERS=.*|AUTO_APPROVE_SELLERS=true|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
fi
sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=postgres://kiosk:kiosk@localhost:$PORT/kiosk|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"

# ── Install, migrate, run ────────────────────────────────────────
say "Installing dependencies"
pnpm install --frozen-lockfile
say "Applying database migrations"
pnpm db:migrate

cat <<EOF

  Kiosk is starting.
  Open  http://localhost:5173  in your browser.
  Sign in with any Ghana number. With no WhatsApp keys set, the
  6-digit login code is printed below in the API log, and so are
  new-order messages. Your store goes live straight away; open it at
  http://localhost:5173/<your-store-link>.
  Press Ctrl+C to stop.

EOF
exec pnpm dev
