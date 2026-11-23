import type { FastifyBaseLogger } from "fastify";
import { formatCedis, maskPhone } from "@kiosk/shared";
import type { Env } from "../env.ts";

/** Anything that can deliver a login code. Swappable for tests and dev. */
export interface OtpSender {
  sendLoginCode(phoneE164: string, code: string): Promise<void>;
}

/**
 * Sends the code with an approved WhatsApp *authentication* template, the only
 * category Meta allows for OTPs. The template needs one body variable and a
 * copy-code (OTP) button whose parameter is the same code.
 */
export class WhatsAppOtpSender implements OtpSender {
  constructor(
    private readonly env: Pick<
      Env,
      "WHATSAPP_TOKEN" | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_OTP_TEMPLATE" | "WHATSAPP_OTP_TEMPLATE_LANG" | "WHATSAPP_GRAPH_VERSION"
    >,
    private readonly log: FastifyBaseLogger,
  ) {}

  async sendLoginCode(phoneE164: string, code: string): Promise<void> {
    const url = `https://graph.facebook.com/${this.env.WHATSAPP_GRAPH_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phoneE164.replace(/^\+/, ""),
        type: "template",
        template: {
          name: this.env.WHATSAPP_OTP_TEMPLATE,
          language: { code: this.env.WHATSAPP_OTP_TEMPLATE_LANG },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.log.error({ status: res.status, detail, to: maskPhone(phoneE164) }, "whatsapp otp send failed");
      throw new Error(`WhatsApp send failed (${res.status})`);
    }
  }
}

/** Dev only: prints the code to the API log instead of sending it. */
export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly log: FastifyBaseLogger) {}
  async sendLoginCode(phoneE164: string, code: string) {
    this.log.warn(`\n\n  Login code for ${phoneE164}: ${code}\n`);
  }
}

/** Tests: remembers the last code per phone. */
export class MemoryOtpSender implements OtpSender {
  readonly sent = new Map<string, string>();
  async sendLoginCode(phoneE164: string, code: string) {
    this.sent.set(phoneE164, code);
  }
}

/* ───────────────────────── Seller order notifications ───────────────────────── */

export type OrderNotice = {
  to: string;
  storeName: string;
  code: string;
  customerName: string;
  customerPhone: string;
  totalPesewas: number;
  itemCount: number;
  fulfilment: "delivery" | "pickup";
  zoneName: string | null;
};

/** Tells a seller about a new order. Failures never fail the order. */
export interface OrderNotifier {
  orderPlaced(n: OrderNotice): Promise<void>;
}

/**
 * Sends the seller a WhatsApp *utility* template (business-initiated messages
 * outside the 24-hour window must be templates). Body variables, in order:
 * order code, customer name, item count, total, area. Not yet exercised against
 * Meta: it needs an approved template on a verified business account.
 */
export class WhatsAppOrderNotifier implements OrderNotifier {
  constructor(
    private readonly env: Pick<Env, "WHATSAPP_TOKEN" | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ORDER_TEMPLATE" | "WHATSAPP_OTP_TEMPLATE_LANG" | "WHATSAPP_GRAPH_VERSION">,
    private readonly log: FastifyBaseLogger,
  ) {}

  async orderPlaced(n: OrderNotice): Promise<void> {
    const url = `https://graph.facebook.com/${this.env.WHATSAPP_GRAPH_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const text = (t: string) => ({ type: "text", text: t });
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: n.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: this.env.WHATSAPP_ORDER_TEMPLATE,
          language: { code: this.env.WHATSAPP_OTP_TEMPLATE_LANG },
          components: [
            {
              type: "body",
              parameters: [
                text(n.code),
                text(n.customerName),
                text(String(n.itemCount)),
                text(formatCedis(n.totalPesewas)),
                text(n.fulfilment === "pickup" ? "Pickup" : (n.zoneName ?? "Delivery")),
              ],
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.log.error({ status: res.status, detail, order: n.code }, "whatsapp order notice failed");
      throw new Error(`WhatsApp send failed (${res.status})`);
    }
  }
}

/** Dev only: prints the notice to the API log. */
export class ConsoleOrderNotifier implements OrderNotifier {
  constructor(private readonly log: FastifyBaseLogger) {}
  async orderPlaced(n: OrderNotice) {
    this.log.warn(
      `\n\n  New order ${n.code} for ${n.storeName}: ${n.itemCount} item(s), ${formatCedis(n.totalPesewas)} from ${n.customerName} (${n.customerPhone})\n`,
    );
  }
}

/** Tests: collects notices. */
export class MemoryOrderNotifier implements OrderNotifier {
  readonly sent: OrderNotice[] = [];
  async orderPlaced(n: OrderNotice) {
    this.sent.push(n);
  }
}


/* ───────────────────────── Chat replies (inside the 24h window) ───────────────────────── */

/** Free-form text is only allowed within 24h of the customer's last message, which is always true for replies. */
export interface ChatClient {
  sendText(toE164: string, body: string): Promise<{ id: string | null }>;
}

export class WhatsAppChatClient implements ChatClient {
  constructor(
    private readonly env: Pick<Env, "WHATSAPP_TOKEN" | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_GRAPH_VERSION">,
    private readonly log: FastifyBaseLogger,
  ) {}

  async sendText(toE164: string, body: string) {
    const url = `https://graph.facebook.com/${this.env.WHATSAPP_GRAPH_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toE164.replace(/^\+/, ""),
        type: "text",
        text: { body, preview_url: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.log.error({ status: res.status, detail, to: maskPhone(toE164) }, "whatsapp chat send failed");
      throw new Error(`WhatsApp send failed (${res.status})`);
    }
    const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
    return { id: json?.messages?.[0]?.id ?? null };
  }
}

/** Dev without credentials: prints what the bot would say. */
export class ConsoleChatClient implements ChatClient {
  constructor(private readonly log: FastifyBaseLogger) {}
  async sendText(to: string, body: string) {
    this.log.warn(`\n  [bot → ${to}]\n${body.replace(/^/gm, "    ")}\n`);
    return { id: null };
  }
}

/** Tests: records every reply. */
export class MemoryChatClient implements ChatClient {
  readonly sent: { to: string; body: string }[] = [];
  fail = false;
  private n = 0;
  async sendText(to: string, body: string) {
    if (this.fail) throw new Error("send failed");
    this.sent.push({ to, body });
    return { id: `wamid.out.${++this.n}` };
  }
  last(to?: string) {
    const list = to ? this.sent.filter((m) => m.to === to) : this.sent;
    return list.at(-1)?.body;
  }
}
