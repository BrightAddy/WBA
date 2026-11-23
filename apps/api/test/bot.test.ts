import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAssistant } from "../src/modules/bot/assistant.ts";
import { approve, makeProduct, resetDb, send, setupTestApp, signUpSeller, WA_SECRET, WA_VERIFY } from "./helpers.ts";

/* A scripted stand-in for Claude: each queued step answers one model call. */
type Step = (p: { messages: { role: string; content: unknown }[] }) => object;
const queue: Step[] = [];
const text = (t: string): Step => () => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
const tool = (name: string, input: object): Step => () => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `tu_${Math.random().toString(16).slice(2)}`, name, input }],
});
const toolResult = (p: Parameters<Step>[0]) => {
  const last = p.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
  return JSON.parse(last[0]!.content) as Record<string, unknown>;
};
const brain = Object.assign(
  new ClaudeAssistant({
    model: "test",
    create: (async (p: Parameters<Step>[0]) => {
      const step = queue.shift();
      if (!step) throw new Error("model called with nothing scripted");
      // A step may hand back another step (used to chain "check, then answer").
      let r: unknown = step(p);
      while (typeof r === "function") r = (r as Step)(p);
      return r;
    }) as never,
  }),
  { canTakeOrders: true },
);

let t: Awaited<ReturnType<typeof setupTestApp>>;
let kofi: string;
let hoodie: { id: string; variants: { id: string }[] };
let accra: string;
let n = 0;

beforeAll(async () => (t = await setupTestApp({ assistant: brain, env: { BOT_CUSTOMER_BURST: "6" } })));
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});
beforeEach(async () => {
  await resetDb(t.db);
  t.sender.sent.clear();
  t.notifier.sent.length = 0;
  t.chat.sent.length = 0;
  t.chat.fail = false;
  queue.length = 0;
  kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  await approve(t.db, "kofi-thrift");
  hoodie = await makeProduct(t.app, kofi, { title: "Carhartt hoodie", pricePesewas: 8500, variants: [{ size: "M", stock: 3 }, { size: "L", stock: 0 }] });
  const z = await send(t.app, "PUT", "/api/seller/delivery/zones", kofi, { zones: [{ name: "East Legon", feePesewas: 1500, etaLabel: "Same day" }] });
  accra = z.json().zones[0].id;
});

const CUSTOMER = "233201112233";
const E164 = `+${CUSTOMER}`;

function sign(body: string) {
  return "sha256=" + createHmac("sha256", WA_SECRET).update(body).digest("hex");
}
function payload(msgs: { id?: string; from?: string; text?: string; type?: string }[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: CUSTOMER, profile: { name: "Esi" } }],
              messages: msgs.map((m) => ({
                id: m.id ?? `wamid.in.${++n}`,
                from: m.from ?? CUSTOMER,
                type: m.type ?? "text",
                ...(m.type && m.type !== "text" ? {} : { text: { body: m.text ?? "" } }),
              })),
            },
          },
        ],
      },
    ],
  };
}
async function hook(body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  const res = await t.app.inject({
    method: "POST",
    url: "/api/webhooks/whatsapp",
    payload: raw,
    headers: { "content-type": "application/json", ...(signature !== null && { "x-hub-signature-256": signature ?? sign(raw) }) },
  });
  await t.app.bot.idle();
  return res;
}
const say = (msg: string, extra: { id?: string } = {}) => hook(payload([{ text: msg, ...extra }]));
const rows = async <T>(q: ReturnType<typeof sql>) => (await t.db.execute(q)).rows as T[];
const enter = () => say("Hi! I'm shopping at @kofi-thrift");

describe("webhook security", () => {
  it("echoes the challenge only for the right verify token", async () => {
    const ok = await t.app.inject({
      method: "GET",
      url: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await t.app.inject({ method: "GET", url: "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
    const none = await t.app.inject({ method: "GET", url: "/api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1" });
    expect(none.statusCode).toBe(403);
  });

  it("rejects missing, wrong and tampered signatures without processing anything", async () => {
    const body = payload([{ text: "Hi @kofi-thrift" }]);
    expect((await hook(body, null)).statusCode).toBe(401);
    expect((await hook(body, "sha256=" + "0".repeat(64))).statusCode).toBe(401);
    expect((await hook(body, sign(JSON.stringify(payload([{ text: "different" }]))))).statusCode).toBe(401);
    expect(t.chat.sent).toHaveLength(0);
    expect(await rows(sql`SELECT 1 FROM messages`)).toHaveLength(0);
  });

  it("accepts junk and status receipts with a 200 so Meta doesn't retry", async () => {
    for (const body of [{}, { entry: "x" }, { entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "x" }] } }] }] }, []]) {
      expect((await hook(body)).statusCode).toBe(200);
    }
    const bad = await t.app.inject({ method: "POST", url: "/api/webhooks/whatsapp", payload: "{not json", headers: { "content-type": "application/json", "x-hub-signature-256": sign("{not json") } });
    expect(bad.statusCode).toBe(400);
    expect(t.chat.sent).toHaveLength(0);
  });
});

describe("routing to a store", () => {
  it("welcomes a customer who arrives from a store link, without calling the model", async () => {
    await enter();
    expect(t.chat.last(E164)).toContain("Welcome to kofi-thrift");
    const [c] = await rows<{ active: string | null }>(sql`SELECT active_seller_id AS active FROM customers WHERE phone = ${E164}`);
    expect(c!.active).not.toBeNull();
    const m = await rows<{ direction: string; sender: string }>(sql`SELECT direction, sender FROM messages ORDER BY created_at, id`);
    expect(m.map((r) => `${r.direction}/${r.sender}`)).toEqual(["inbound/customer", "outbound/bot"]);
  });

  it("handles Meta delivering the same message twice", async () => {
    await say("Hi @kofi-thrift", { id: "wamid.same" });
    await say("Hi @kofi-thrift", { id: "wamid.same" });
    expect(t.chat.sent).toHaveLength(1);
    expect(await rows(sql`SELECT 1 FROM messages WHERE direction = 'inbound'`)).toHaveLength(1);
  });

  it("tells the customer when the store doesn't exist or isn't live", async () => {
    await say("Hi @nobody-here");
    expect(t.chat.last()).toContain("couldn't find a store");
    await t.db.execute(sql`UPDATE sellers SET status = 'suspended'`);
    await say("Hi @kofi-thrift");
    expect(t.chat.last()).toContain("couldn't find a store");
    expect(await rows(sql`SELECT 1 FROM conversations`)).toHaveLength(0);
  });

  it("explains how to start when there is no store yet", async () => {
    await say("hello?");
    expect(t.chat.last()).toContain("open the store's link");
    expect(await rows(sql`SELECT 1 FROM conversations`)).toHaveLength(0);
  });

  it("switches stores when the customer mentions another one", async () => {
    const ama = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
    await approve(t.db, "ama-wear");
    void ama;
    await enter();
    await say("Hi @ama-wear");
    expect(t.chat.last()).toContain("Welcome to ama-wear");
    expect(await rows(sql`SELECT 1 FROM conversations`)).toHaveLength(2);
  });

  it("stays quiet for blocked numbers", async () => {
    const { sha256 } = await import("../src/lib/crypto.ts");
    await t.db.execute(sql`INSERT INTO blocklist (kind, value_hash, reason) VALUES ('phone', ${sha256(E164)}, 'test')`);
    await enter();
    expect(t.chat.sent).toHaveLength(0);
  });
});

describe("conversation handling", () => {
  it("flags attachments for the seller and asks for text", async () => {
    await enter();
    await hook(payload([{ type: "image" }]));
    expect(t.chat.last()).toContain("only read text");
    const [c] = await rows<{ needs_attention: boolean; attention_reason: string }>(sql`SELECT needs_attention, attention_reason FROM conversations`);
    expect(c).toMatchObject({ needs_attention: true, attention_reason: "Customer sent a image" });
  });

  it("goes silent and flags the chat once a human has taken over", async () => {
    await enter();
    await t.db.execute(sql`UPDATE conversations SET mode = 'human'`);
    t.chat.sent.length = 0;
    await say("are you there?");
    expect(t.chat.sent).toHaveLength(0);
    const [c] = await rows<{ needs_attention: boolean }>(sql`SELECT needs_attention FROM conversations`);
    expect(c!.needs_attention).toBe(true);
    expect(queue).toHaveLength(0);
  });

  it("stops replying after the seller's monthly allowance, telling the customer once", async () => {
    await t.db.execute(sql`UPDATE sellers SET bot_message_quota = 2`);
    await enter(); // reply 1
    queue.push(text("We have a Carhartt hoodie."));
    await say("what do you have?"); // reply 2
    await say("how much?");
    expect(t.chat.last()).toContain("resting");
    const after = t.chat.sent.length;
    await say("hello??");
    expect(t.chat.sent).toHaveLength(after);
    expect(queue).toHaveLength(0);
  });

  it("stops answering a customer who floods the chat", async () => {
    await enter();
    for (let i = 0; i < 9; i++) queue.push(text("ok"));
    for (let i = 0; i < 9; i++) await say(`msg ${i}`);
    expect(queue).toHaveLength(4); // the last four never reached the model
    expect(t.chat.sent).toHaveLength(1 + 5);
  });

  it("apologises and flags the chat when the model fails", async () => {
    await enter();
    queue.push(() => {
      throw new Error("boom");
    });
    await say("do you have hoodies?");
    expect(t.chat.last()).toContain("trouble right now");
    const [c] = await rows<{ attention_reason: string }>(sql`SELECT attention_reason FROM conversations`);
    expect(c!.attention_reason).toBe("Assistant error");
  });

  it("still saves the reply if WhatsApp refuses to send it", async () => {
    await enter();
    t.chat.fail = true;
    queue.push(text("We have hoodies."));
    await say("hoodies?");
    const [m] = await rows<{ payload: { sendFailed?: boolean } | null }>(sql`SELECT payload FROM messages WHERE direction = 'outbound' ORDER BY created_at DESC, id LIMIT 1`);
    expect(m!.payload).toEqual({ sendFailed: true });
  });
});

describe("assistant tools", () => {
  it("answers from the catalogue and hides nothing it shouldn't", async () => {
    await enter();
    queue.push(tool("search_products", { query: "hoodies" }), (p) => {
      const r = toolResult(p) as { total: number; products: { title: string; price: string }[] };
      expect(r.total).toBe(1);
      expect(r.products[0]).toMatchObject({ title: "Carhartt hoodie", price: "GH₵85" });
      expect(JSON.stringify(r)).not.toMatch(/stock|seller|phone/i);
      return text("We have the Carhartt hoodie at GH₵85.");
    });
    await say("any hoodies?");
    expect(t.chat.last()).toBe("We have the Carhartt hoodie at GH₵85.");
  });

  it("survives bad tool arguments from the model", async () => {
    await enter();
    queue.push(tool("get_product", { productId: "not-a-uuid" }), (p) => {
      const last = p.messages.at(-1)!.content as { is_error?: boolean }[];
      expect(last[0]!.is_error).toBe(true);
      return text("Let me check that for you.");
    });
    await say("tell me about the hoodie");
    expect(t.chat.last()).toBe("Let me check that for you.");
  });

  it("flags the chat when the model hands off", async () => {
    await enter();
    queue.push(tool("hand_off_to_seller", { reason: "Wants a discount" }), text("I'll ask the seller about that."));
    await say("can I get 50% off?");
    const [c] = await rows<{ needs_attention: boolean; attention_reason: string }>(sql`SELECT needs_attention, attention_reason FROM conversations`);
    expect(c).toMatchObject({ needs_attention: true, attention_reason: "Wants a discount" });
  });
});

describe("ordering in chat", () => {
  const prepare = (over: object = {}) =>
    tool("prepare_order", {
      items: [{ variantId: hoodie.variants[0]!.id, quantity: 2 }],
      fulfilment: "delivery",
      area: "east legon",
      customerName: "Esi Mensah",
      address: "House 12, Palm Street",
      ...over,
    });

  async function toConfirmation() {
    await enter();
    queue.push(prepare(), text("Here's your order"));
    await say("I want 2 hoodies in M, deliver to East Legon, I'm Esi, House 12 Palm Street");
  }

  it("prices the basket on the server, then places it only after the customer says yes", async () => {
    await toConfirmation();
    const ask = t.chat.last()!;
    expect(ask).toContain("2 × Carhartt hoodie (M): GH₵170");
    expect(ask).toContain("Delivery to East Legon: GH₵15");
    expect(ask).toContain("*Total: GH₵185*");
    expect(ask).toContain("Reply YES");
    expect(await rows(sql`SELECT 1 FROM orders`)).toHaveLength(0);

    await say("yes");
    const [o] = await rows<{ code: string; channel: string; status: string; total_pesewas: number; address_text: string; customer_phone: string }>(
      sql`SELECT code, channel, status, total_pesewas, address_text, customer_phone FROM orders`,
    );
    expect(o).toMatchObject({ channel: "whatsapp", status: "pending_payment", total_pesewas: 18500, address_text: "House 12, Palm Street", customer_phone: E164 });
    expect(t.chat.last()).toContain(`*${o!.code}*`);
    expect(t.chat.last()).toContain("*Total: GH₵185*");
    expect((await rows<{ stock: number }>(sql`SELECT stock FROM product_variants WHERE id = ${hoodie.variants[0]!.id}`))[0]!.stock).toBe(1);
    expect(t.notifier.sent).toHaveLength(1);
    expect((await rows<{ draft: unknown }>(sql`SELECT draft FROM conversations`))[0]!.draft).toBeNull();
    expect(queue).toHaveLength(0);
  });

  it("does not place a second order when the same confirmation is delivered again", async () => {
    await toConfirmation();
    await say("yes", { id: "wamid.confirm" });
    await say("yes", { id: "wamid.confirm" });
    expect(await rows(sql`SELECT 1 FROM orders`)).toHaveLength(1);
  });

  it("cancels the draft on no", async () => {
    await toConfirmation();
    await say("no");
    expect(t.chat.last()).toContain("cancelled");
    await say("yes");
    expect(await rows(sql`SELECT 1 FROM orders`)).toHaveLength(0);
  });

  it("ignores an old draft instead of surprising the customer with an order", async () => {
    await toConfirmation();
    await t.db.execute(sql`UPDATE conversations SET draft = jsonb_set(draft, '{at}', to_jsonb((now() - interval '2 hours')::text))`);
    queue.push(text("What would you like to order?"));
    await say("yes");
    expect(await rows(sql`SELECT 1 FROM orders`)).toHaveLength(0);
    expect(t.chat.last()).toBe("What would you like to order?");
  });

  it("tells the customer when stock vanished between the summary and the yes", async () => {
    await toConfirmation();
    await t.db.execute(sql`UPDATE product_variants SET stock = 0`);
    await say("yes");
    expect(t.chat.last()).toMatch(/changed|sold out/i);
    expect(await rows(sql`SELECT 1 FROM orders`)).toHaveLength(0);
    expect((await rows<{ draft: unknown }>(sql`SELECT draft FROM conversations`))[0]!.draft).toBeNull();
  });

  it("rejects what the model gets wrong and saves nothing", async () => {
    await enter();
    const stranger = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
    await approve(t.db, "ama-wear");
    const theirs = await makeProduct(t.app, stranger, { title: "Other shop item", variants: [{ stock: 5 }] });

    const problems = (p: Parameters<Step>[0]) => (toolResult(p) as { ok: boolean; problems: string[] });
    queue.push(
      prepare({ items: [{ variantId: theirs.variants[0]!.id, quantity: 1 }] }), // someone else's product
      (p) => { expect(problems(p).ok).toBe(false); return prepare({ area: "Kumasi" }); }, // not a delivery area
      (p) => { expect(problems(p).problems[0]).toContain("doesn't deliver to"); return prepare({ items: [{ variantId: hoodie.variants[1]!.id, quantity: 1 }] }); }, // sold out
      (p) => { expect(problems(p).problems[0]).toMatch(/sold out/); return prepare({ items: [{ variantId: hoodie.variants[0]!.id, quantity: 5 }] }); }, // only 3 in stock
      (p) => { expect(problems(p).problems[0]).toMatch(/only 3 left/); return text("Sorry, let me sort that out."); },
    );
    await say("order please");
    expect(queue).toHaveLength(0); // every scripted check ran, none threw
    expect(t.chat.last()).toBe("Sorry, let me sort that out.");
    expect((await rows<{ draft: unknown }>(sql`SELECT draft FROM conversations`))[0]!.draft).toBeNull();
  });

  it("never lets the model's own text change the price shown", async () => {
    await enter();
    queue.push(prepare(), text("Great, that's only GH₵1 in total!"));
    await say("order");
    const ask = t.chat.last()!;
    expect(ask).toContain("*Total: GH₵185*");
  });

  it("applies free delivery from the seller's threshold", async () => {
    await send(t.app, "PUT", "/api/seller/delivery/settings", kofi, { pickupEnabled: false, freeDeliveryOverPesewas: 15000 });
    await enter();
    queue.push(prepare(), text("Here's your order"));
    await say("2 hoodies M, East Legon, Esi, House 12");
    expect(t.chat.last()).toContain("Delivery to East Legon: free");
    expect(t.chat.last()).toContain("*Total: GH₵170*");
  });
});

describe("storefront entry point", () => {
  it("exposes a wa.me link that mentions the store", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/stores/kofi-thrift" });
    const url = new URL(r.json().store.whatsappUrl);
    expect(url.origin + url.pathname).toBe("https://wa.me/233201234567");
    expect(url.searchParams.get("text")).toContain("@kofi-thrift");
  });
});
