import type { FastifyBaseLogger } from "fastify";
import { maskPhone } from "@kiosk/shared";
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
