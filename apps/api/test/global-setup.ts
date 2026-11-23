import pg from "pg";
import { runMigrations } from "../src/db/migrate.ts";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://kiosk:kiosk@localhost:5432/kiosk_test";

/** Fresh schema per run, built from the committed migrations (not from the TS schema). */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  await runMigrations(TEST_DB_URL);
}
