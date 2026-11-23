/**
 * All money is stored and computed as integer pesewas (1 GHS = 100 pesewas).
 * Floats never touch prices: 0.1 + 0.2 is not a bug we want in a checkout.
 */
export type Pesewas = number & { readonly __brand: "pesewas" };

export const pesewas = (n: number): Pesewas => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Invalid pesewas amount: ${n}`);
  return n as Pesewas;
};

/** "85", "85.5", "GH₵ 1,200.50" -> pesewas. Returns null if unparseable. */
export function parseCedis(input: string): Pesewas | null {
  const cleaned = input.replace(/gh₵|ghs|₵|,|\s/gi, "");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return pesewas(whole * 100 + frac);
}

const fmt = new Intl.NumberFormat("en-GH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** 8550 -> "GH₵85.50", 8500 -> "GH₵85" */
export function formatCedis(p: number): string {
  const cedis = p / 100;
  const body = Number.isInteger(cedis)
    ? fmt.format(cedis)
    : new Intl.NumberFormat("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cedis);
  return `GH₵${body}`;
}
