/**
 * Ghana mobile numbers, normalised to E.164 (+233XXXXXXXXX).
 *
 * Accepts the forms people actually type: 024 123 4567, 24-123-4567,
 * 233241234567, +233 (0)24 123 4567. Network prefixes are validated so a
 * typo fails here rather than as an undeliverable WhatsApp message.
 */

// MTN, Telecel (ex-Vodafone), AT (ex-AirtelTigo) and newer allocations.
const GH_MOBILE_PREFIXES = new Set([
  "20", "23", "24", "25", "26", "27", "28", "50", "53", "54", "55", "56", "57", "59",
]);

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: string };

export function normalizeGhanaPhone(input: string): PhoneResult {
  let digits = input.replace(/\(0\)/g, "").replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);

  let national: string;
  if (digits.startsWith("233")) national = digits.slice(3);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else national = digits;

  if (national.startsWith("0")) national = national.slice(1);

  if (!/^\d{9}$/.test(national)) {
    return { ok: false, reason: "Enter a 10-digit Ghana number, like 024 123 4567." };
  }
  if (!GH_MOBILE_PREFIXES.has(national.slice(0, 2))) {
    return { ok: false, reason: "That doesn't look like a Ghana mobile number." };
  }
  return { ok: true, e164: `+233${national}` };
}

/** +233241234567 -> 024 123 4567 */
export function formatGhanaPhone(e164: string): string {
  const n = e164.replace(/^\+233/, "0");
  return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
}

/** Last 4 digits only, for logs and confirmations. */
export const maskPhone = (e164: string) => `••• ••• ${e164.slice(-4)}`;
