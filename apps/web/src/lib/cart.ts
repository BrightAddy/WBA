import { useCallback, useMemo, useSyncExternalStore } from "react";
import { MAX_CART_LINES, MAX_LINE_QTY } from "@kiosk/shared";

/**
 * The cart lives on the customer's phone, per store. Titles and prices here are
 * only for showing something instantly; the server re-prices everything
 * (see /quote) and its numbers are the ones the customer is charged.
 */
export type CartLine = {
  variantId: string;
  productId: string;
  quantity: number;
  title: string;
  label: string;
  unitPricePesewas: number;
};

const keyFor = (slug: string) => `kiosk.cart.v1.${slug.toLowerCase()}`;

// localStorage can throw (private mode, blocked storage). Fall back to memory.
const memory = new Map<string, string>();
const readRaw = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return memory.get(k) ?? null;
  }
};
const writeRaw = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    memory.set(k, v);
  }
};

const valid = (l: unknown): l is CartLine => {
  const x = l as Partial<CartLine> | null;
  return (
    !!x &&
    typeof x.variantId === "string" &&
    typeof x.productId === "string" &&
    typeof x.title === "string" &&
    typeof x.label === "string" &&
    Number.isInteger(x.unitPricePesewas) &&
    Number.isInteger(x.quantity) &&
    x.quantity! >= 1 &&
    x.quantity! <= MAX_LINE_QTY
  );
};

// useSyncExternalStore needs a stable reference while nothing changed.
const cache = new Map<string, { raw: string | null; lines: CartLine[] }>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function read(slug: string): CartLine[] {
  const raw = readRaw(keyFor(slug));
  const hit = cache.get(slug);
  if (hit && hit.raw === raw) return hit.lines;
  let lines: CartLine[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    lines = Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_CART_LINES) : [];
  } catch {
    /* corrupted entry: start empty */
  }
  cache.set(slug, { raw, lines });
  return lines;
}

function write(slug: string, lines: CartLine[]) {
  writeRaw(keyFor(slug), JSON.stringify(lines));
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => e.key?.startsWith("kiosk.cart.v1.") && emit());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useCart(slug: string) {
  const lines = useSyncExternalStore(subscribe, () => read(slug), () => []);

  const add = useCallback(
    (line: Omit<CartLine, "quantity">, quantity: number, max: number) => {
      const current = read(slug);
      const cap = Math.min(MAX_LINE_QTY, max);
      const existing = current.find((l) => l.variantId === line.variantId);
      if (existing) {
        write(
          slug,
          current.map((l) =>
            l.variantId === line.variantId ? { ...l, ...line, quantity: Math.min(cap, l.quantity + quantity) } : l,
          ),
        );
      } else if (current.length < MAX_CART_LINES) {
        write(slug, [...current, { ...line, quantity: Math.max(1, Math.min(cap, quantity)) }]);
      }
    },
    [slug],
  );
  const setQuantity = useCallback(
    (variantId: string, quantity: number) =>
      write(
        slug,
        read(slug).map((l) => (l.variantId === variantId ? { ...l, quantity: Math.max(1, Math.min(MAX_LINE_QTY, quantity)) } : l)),
      ),
    [slug],
  );
  const remove = useCallback((variantId: string) => write(slug, read(slug).filter((l) => l.variantId !== variantId)), [slug]);
  const removeMany = useCallback(
    (ids: string[]) => write(slug, read(slug).filter((l) => !ids.includes(l.variantId))),
    [slug],
  );
  const clear = useCallback(() => write(slug, []), [slug]);

  const totals = useMemo(
    () => ({
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotalPesewas: lines.reduce((n, l) => n + l.quantity * l.unitPricePesewas, 0),
    }),
    [lines],
  );

  return { lines, ...totals, add, setQuantity, remove, removeMany, clear };
}
