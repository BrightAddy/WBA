import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { formatCedis, STORE_MENTION, type PlacedOrder } from "@kiosk/shared";
import type { Env } from "../../env.ts";
import type { Db } from "../../db/client.ts";
import { blocklist, conversations, customers, messages, sellers } from "../../db/schema.ts";
import { sha256 } from "../../lib/crypto.ts";
import { AppError } from "../../lib/errors.ts";
import type { ChatClient } from "../../lib/whatsapp.ts";
import type { StoreService } from "../store/service.ts";
import type { Assistant, Turn } from "./assistant.ts";
import type { Inbound } from "./parse.ts";
import { createBotTools, DRAFT_TTL_MS } from "./tools.ts";

type Seller = typeof sellers.$inferSelect;
type Conversation = typeof conversations.$inferSelect;

const YES = /^(yes|y|yeah|yep|yup|confirm|confirmed|ok|okay|sure|place it|go ahead|yes please|yes pls)[\s.!]*$/i;
const NO = /^(no|nope|cancel|stop|never ?mind|nah)\b/i;
/** Words that mean the message was only "hi, I'm here for @store". */
const GREETING_WORDS = new Set(
  "hi hello hey hola good morning afternoon evening im i m am shopping at from here for please pls visit visiting store shop".split(" "),
);

const HISTORY_LIMIT = 16;
const MAX_TEXT = 1000;
const BURST_WINDOW_MS = 10 * 60_000;

/** Same WhatsApp message id always gives the same token, so a retried confirmation can't place two orders. */
const tokenFor = (waId: string) => {
  const h = createHash("sha256").update(`wa:${waId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function createBotService(deps: {
  db: Db;
  env: Pick<Env, "BOT_CUSTOMER_BURST" | "PUBLIC_URL" | "WEB_ORIGIN">;
  store: StoreService;
  chat: ChatClient;
  assistant: Assistant & { canTakeOrders?: boolean };
  log: { error: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}) {
  const { db, env, store, chat, assistant, log } = deps;
  const siteUrl = (env.PUBLIC_URL ?? env.WEB_ORIGIN).replace(/\/$/, "");

  /* ───────── Serial per customer, parallel across customers ───────── */

  // One process only. With several API instances, move this to a queue keyed by phone.
  const chains = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();

  function enqueue(msg: Inbound) {
    const prev = chains.get(msg.from) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => handle(msg))
      .catch((err) => log.error({ err, wa: msg.waId }, "bot: message handling failed"));
    chains.set(msg.from, next);
    inflight.add(next);
    void next.finally(() => {
      inflight.delete(next);
      if (chains.get(msg.from) === next) chains.delete(msg.from);
    });
  }

  /** Resolves when everything queued so far has been handled. For tests and graceful shutdown. */
  async function idle() {
    while (inflight.size) await Promise.all([...inflight]);
  }

  /* ───────── Small helpers ───────── */

  async function say(convo: Pick<Conversation, "id"> | null, to: string, body: string) {
    const text = body.slice(0, 3000);
    let waId: string | null = null;
    let failed = false;
    try {
      waId = (await chat.sendText(to, text)).id;
    } catch (err) {
      failed = true;
      log.error({ err }, "bot: reply could not be sent");
    }
    if (convo) {
      await db.insert(messages).values({
        conversationId: convo.id,
        direction: "outbound",
        sender: "bot",
        body: text,
        waMessageId: waId,
        payload: failed ? { sendFailed: true } : null,
      });
    }
  }

  const flag = (id: string, reason: string) =>
    db.update(conversations).set({ needsAttention: true, attentionReason: reason }).where(eq(conversations.id, id));

  async function approvedSellerBySlug(slug: string): Promise<Seller | null> {
    const [s] = await db
      .select()
      .from(sellers)
      .where(and(sql`lower(${sellers.slug}) = ${slug.toLowerCase()}`, eq(sellers.status, "approved")));
    return s ?? null;
  }
  async function approvedSellerById(id: string): Promise<Seller | null> {
    const [s] = await db.select().from(sellers).where(and(eq(sellers.id, id), eq(sellers.status, "approved")));
    return s ?? null;
  }

  function receipt(o: PlacedOrder) {
    const lines = o.items.map((i) => `• ${i.quantity} × ${i.title}${i.label ? ` (${i.label})` : ""}: ${formatCedis(i.lineTotalPesewas)}`);
    const how = o.fulfilment === "pickup" ? "Pickup" : `Delivery to ${o.zoneName}: ${o.deliveryFeePesewas ? formatCedis(o.deliveryFeePesewas) : "free"}`;
    return (
      `✅ Order placed! Your code is *${o.code}*.\n${lines.join("\n")}\n${how}\n*Total: ${formatCedis(o.totalPesewas)}*\n\n` +
      `${o.storeName} will message you to arrange payment.`
    );
  }

  /* ───────── The main flow ───────── */

  async function handle(msg: Inbound) {
    const [blocked] = await db
      .select({ id: blocklist.id })
      .from(blocklist)
      .where(and(eq(blocklist.kind, "phone"), eq(blocklist.valueHash, sha256(msg.from))));
    if (blocked) return;

    const [customer] = await db
      .insert(customers)
      .values({ phone: msg.from })
      .onConflictDoUpdate({ target: customers.phone, set: { phone: sql`excluded.phone` } })
      .returning();
    if (!customer) return;

    /* Which store is this about? A "@store-link" mention switches; otherwise stay with the last one. */
    const text = msg.text?.trim().slice(0, MAX_TEXT) ?? null;
    const mention = text?.match(STORE_MENTION)?.[1] ?? null;
    let seller: Seller | null = null;
    if (mention) {
      seller = await approvedSellerBySlug(mention);
      if (!seller) {
        await say(null, msg.from, `I couldn't find a store called @${mention}. Check the link the seller sent you and try again.`);
        return;
      }
      if (customer.activeSellerId !== seller.id) {
        await db.update(customers).set({ activeSellerId: seller.id }).where(eq(customers.id, customer.id));
      }
    } else if (customer.activeSellerId) {
      seller = await approvedSellerById(customer.activeSellerId);
    }
    if (!seller) {
      await say(
        null,
        msg.from,
        "Hi! 👋 I help shoppers on Kiosk. To chat with a store, open the store's link or tap its WhatsApp button, and I'll pick up from there.",
      );
      return;
    }

    /* Conversation + this message. The unique wa id makes Meta's retries harmless. */
    await db.insert(conversations).values({ sellerId: seller.id, customerId: customer.id }).onConflictDoNothing();
    const [convo0] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.sellerId, seller.id), eq(conversations.customerId, customer.id)));
    if (!convo0) return;

    const [saved] = await db
      .insert(messages)
      .values({
        conversationId: convo0.id,
        direction: "inbound",
        sender: "customer",
        body: text,
        waMessageId: msg.waId,
        payload: msg.type === "text" ? null : { type: msg.type },
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!saved) return;

    await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, convo0.id));
    const convo: Conversation = convo0;

    /* A person is handling this chat: stay quiet, make sure they notice. */
    if (convo.mode === "human") {
      await flag(convo.id, "Customer replied");
      return;
    }
    if (convo.mode === "closed") await db.update(conversations).set({ mode: "bot" }).where(eq(conversations.id, convo.id));

    if (text === null) {
      await flag(convo.id, `Customer sent a ${msg.type.replace(/_/g, " ")}`);
      await say(convo, msg.from, "I can only read text messages. Tell me in words what you're looking for, or the seller will take a look at what you sent.");
      return;
    }

    /* Greeting that only says which store. No AI needed, no cost. */
    if (mention) {
      const rest = text.replace(STORE_MENTION, " ").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
      if (rest.every((w) => GREETING_WORDS.has(w))) {
        const can = assistant.canTakeOrders !== false;
        await say(
          convo,
          msg.from,
          `Hi! 👋 Welcome to ${seller.storeName}. I can show you what's in stock${can ? ", check delivery to your area, or take your order right here" : " and check delivery to your area"}. What are you looking for?`,
        );
        return;
      }
    }

    /* A prepared order is waiting for a yes or a no. This never goes through the model. */
    const draft = convo.draft && Date.now() - Date.parse(convo.draft.at) < DRAFT_TTL_MS ? convo.draft : null;
    if (draft && YES.test(text)) {
      try {
        const placed = await store.placeOrder(
          seller.slug,
          {
            items: draft.items,
            fulfilment: draft.fulfilment,
            zoneId: draft.zoneId,
            clientToken: tokenFor(msg.waId),
            customerName: draft.customerName,
            customerPhone: msg.from,
            addressText: draft.addressText,
            landmark: draft.landmark,
            note: draft.note,
          },
          "whatsapp",
        );
        await db.update(conversations).set({ draft: null }).where(eq(conversations.id, convo.id));
        await say(convo, msg.from, receipt(placed));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await db.update(conversations).set({ draft: null }).where(eq(conversations.id, convo.id));
        await say(convo, msg.from, `${err.message} Tell me what you'd like and I'll check again.`);
      }
      return;
    }
    if (draft && NO.test(text)) {
      await db.update(conversations).set({ draft: null }).where(eq(conversations.id, convo.id));
      await say(convo, msg.from, "No problem, I've cancelled that. Anything else I can help with?");
      return;
    }

    /* Cost guards: a chatty customer, then the seller's monthly allowance. */
    const [{ n: recent } = { n: 0 }] = await db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, convo.id),
          eq(messages.sender, "customer"),
          gte(messages.createdAt, new Date(Date.now() - BURST_WINDOW_MS)),
        ),
      );
    if (recent > env.BOT_CUSTOMER_BURST) return;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [{ n: used } = { n: 0 }] = await db
      .select({ n: count() })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.sellerId, seller.id), eq(messages.sender, "bot"), gte(messages.createdAt, monthStart)));
    if (used >= seller.botMessageQuota) {
      if (convo.attentionReason !== "Assistant allowance used") {
        await flag(convo.id, "Assistant allowance used");
        await say(convo, msg.from, `${seller.storeName}'s assistant is resting for now. The seller will reply to you personally.`);
      }
      return;
    }

    /* Ask the assistant. */
    const rows = await db
      .select({ sender: messages.sender, body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, convo.id))
      .orderBy(desc(messages.createdAt), asc(messages.id))
      .limit(HISTORY_LIMIT);
    const history: Turn[] = [];
    for (const r of rows.reverse()) {
      if (!r.body) continue;
      const role = r.sender === "customer" ? "user" : "assistant";
      const body = r.body.slice(0, 600);
      const last = history.at(-1);
      if (last?.role === role) last.text += `\n${body}`;
      else history.push({ role, text: body });
    }
    while (history[0]?.role === "assistant") history.shift();
    if (history.at(-1)?.role !== "user") return;

    const tools = createBotTools({ db, store, slug: seller.slug, conversationId: convo.id, customerPhone: msg.from });
    let out = "";
    try {
      out = await assistant.reply({
        storeName: seller.storeName,
        storeBio: seller.bio,
        storeUrl: `${siteUrl}/${seller.slug}`,
        profileName: msg.profileName,
        history,
        tools,
      });
    } catch (err) {
      log.error({ err, seller: seller.id }, "bot: assistant failed");
      tools.state.handoff = "Assistant error";
      out = `Sorry, I'm having trouble right now. ${seller.storeName} will reply to you shortly.`;
    }

    if (tools.state.draftSummary) {
      out = `${out || "Here's your order:"}\n\n${tools.state.draftSummary}\n\nReply YES to place this order, or tell me what to change.`;
    } else if (!out) {
      out = `I've asked ${seller.storeName} to take a look. They'll reply here.`;
    }
    if (tools.state.handoff) await flag(convo.id, tools.state.handoff.slice(0, 200));

    await say(convo, msg.from, out);
  }

  return { enqueue, idle, handle };
}

export type BotService = ReturnType<typeof createBotService>;
