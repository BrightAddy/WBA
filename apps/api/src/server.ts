import { buildApp } from "./app.ts";
import { createDb } from "./db/client.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const app = await buildApp({ env, db });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.PORT, host: "0.0.0.0" });
