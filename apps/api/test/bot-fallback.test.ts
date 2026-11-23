import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approve, makeProduct, resetDb, send, setupTestApp, signUpSeller, WA_SECRET } from "./helpers.ts";

// No ANTHROPIC_API_KEY, so the built-in rule-based assistant answers.
let t: Awaited<ReturnType<typeof setupTestApp>>;
let n = 0;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});
beforeEach(async () => {
  await resetDb(t.db);
  t.chat.sent.length = 0;
  const kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  await approve(t.db, "kofi-thrift");
  await makeProduct(t.app, kofi, { title: "Carhartt hoodie", pricePesewas: 8500 });
  await send(t.app, "PUT", "/api/seller/delivery/zones", kofi, { zones: [{ name: "East Legon", feePesewas: 1500, etaLabel: "Same day" }] });
});

async function say(text: string) {
  const raw = JSON.stringify({
    entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.${++n}`, from: "233201112233", type: "text", text: { body: text } }] } }] }],
  });
  await t.app.inject({
    method: "POST",
    url: "/api/webhooks/whatsapp",
    payload: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", WA_SECRET).update(raw).digest("hex") },
  });
  await t.app.bot.idle();
  return t.chat.last()!;
}

describe("built-in assistant (no AI key)", () => {
  it("lists products and delivery from the catalogue, and sends orders to the store link", async () => {
    expect(await say("Hi @kofi-thrift")).toContain("in stock and check delivery to your area.");
    const products = await say("what do you have?");
    expect(products).toContain("Carhartt hoodie: GH₵85");
    expect(products).toContain("http://localhost:5173/kofi-thrift");
    const delivery = await say("how much is delivery?");
    expect(delivery).toContain("East Legon: GH₵15 (Same day)");
  });

  it("hands anything else to the seller", async () => {
    await say("Hi @kofi-thrift");
    expect(await say("my order arrived damaged")).toContain("passed your message to kofi-thrift");
    const r = await t.db.execute(sql`SELECT needs_attention FROM conversations`);
    expect((r.rows[0] as { needs_attention: boolean }).needs_attention).toBe(true);
  });
});
