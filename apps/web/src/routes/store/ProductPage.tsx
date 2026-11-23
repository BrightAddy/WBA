import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatCedis, LOW_STOCK_AT, MAX_LINE_QTY, variantLabel, type PublicProduct, type PublicVariant } from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { useCart } from "../../lib/cart.ts";
import { Button } from "../../components/ui.tsx";
import { Thumb } from "../../components/Thumb.tsx";
import { ArrowLeft, Check, Minus, Plus } from "../../components/icons.tsx";
import { useStore } from "./StoreShell.tsx";

export function ProductPage() {
  const { store, slug } = useStore();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["product", slug, id], queryFn: () => api.storeProduct(slug, id), retry: false });

  return (
    <main className="mx-auto max-w-6xl px-4 pb-10 sm:px-8">
      <nav className="flex h-16 items-center">
        <Link to={`/${slug}`} className="-ml-2 flex h-11 items-center gap-2 rounded-md px-2 text-muted hover:text-fg">
          <ArrowLeft width={18} height={18} />
          {store.name}
        </Link>
      </nav>
      {q.isPending ? (
        <div className="grid gap-8 lg:grid-cols-2" aria-busy>
          <div className="aspect-[4/5] animate-pulse rounded-md bg-sunken" />
          <div className="h-48 animate-pulse rounded-md bg-sunken" />
        </div>
      ) : q.isError ? (
        <p className="py-24 text-center text-muted">
          {q.error instanceof RequestError && q.error.status === 404
            ? "This item is no longer available."
            : "Couldn't load this item. Check your connection and reload."}
        </p>
      ) : (
        <Detail product={q.data} slug={slug} />
      )}
    </main>
  );
}

function Detail({ product: p, slug }: { product: PublicProduct; slug: string }) {
  const cart = useCart(slug);
  const colors = useMemo(() => [...new Set(p.variants.map((v) => v.color).filter(Boolean) as string[])], [p.variants]);
  const sizes = useMemo(() => [...new Set(p.variants.map((v) => v.size).filter(Boolean) as string[])], [p.variants]);

  // Start on the first thing that's actually in stock.
  const first = p.variants.find((v) => v.available > 0) ?? p.variants[0];
  const [color, setColor] = useState<string | null>(first?.color ?? null);
  const [size, setSize] = useState<string | null>(first?.size ?? null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  const variant: PublicVariant | undefined = p.variants.find(
    (v) => (v.color ?? null) === (color ?? null) && (v.size ?? null) === (size ?? null),
  );
  const inCart = cart.lines.find((l) => l.variantId === variant?.id)?.quantity ?? 0;
  const room = variant ? Math.max(0, Math.min(variant.available, MAX_LINE_QTY) - inCart) : 0;

  useEffect(() => setQty((n) => Math.max(1, Math.min(n, room || 1))), [room]);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(false), 1800);
    return () => clearTimeout(t);
  }, [added]);

  const hasStockFor = (c: string | null, s: string | null) =>
    p.variants.some((v) => (c === null || v.color === c) && (s === null || v.size === s) && v.available > 0);

  function add() {
    if (!variant || room < 1) return;
    cart.add(
      { variantId: variant.id, productId: p.id, title: p.title, label: variantLabel(variant), unitPricePesewas: variant.pricePesewas },
      qty,
      variant.available,
    );
    setAdded(true);
    setQty(1);
  }

  const price = variant?.pricePesewas ?? p.pricePesewas;
  const low = variant && variant.available > 0 && variant.available <= LOW_STOCK_AT;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
      <Gallery product={p} />

      <section className="lg:pt-2">
        <h1 className="font-display text-3xl font-extrabold leading-tight tracking-[-0.03em] text-balance sm:text-4xl">{p.title}</h1>
        <p className="mt-3 flex items-baseline gap-3">
          <span className="text-2xl font-semibold tabular-nums">{formatCedis(price)}</span>
          {p.compareAtPesewas && p.compareAtPesewas > price && (
            <s className="text-lg text-faint tabular-nums">{formatCedis(p.compareAtPesewas)}</s>
          )}
        </p>

        {colors.length > 0 && (
          <Options
            label="Colour"
            value={color}
            options={colors.map((c) => ({ value: c, disabled: !hasStockFor(c, null) }))}
            onPick={(c) => {
              setColor(c);
              // Keep the size if that colour has it; otherwise move to one that does.
              if (!p.variants.some((v) => v.color === c && v.size === size && v.available > 0)) {
                setSize(p.variants.find((v) => v.color === c && v.available > 0)?.size ?? size);
              }
            }}
          />
        )}
        {sizes.length > 0 && (
          <Options
            label="Size"
            value={size}
            options={sizes.map((s) => ({ value: s, disabled: !hasStockFor(color, s) }))}
            onPick={setSize}
          />
        )}

        <div className="mt-7 flex items-center gap-3">
          <div className="flex h-12 items-center rounded-md border border-line-strong bg-raised" role="group" aria-label="Quantity">
            <button
              className="grid size-12 place-items-center text-muted hover:text-fg disabled:opacity-30"
              onClick={() => setQty((n) => Math.max(1, n - 1))}
              disabled={qty <= 1}
              aria-label="One fewer"
            >
              <Minus width={16} height={16} />
            </button>
            <span className="w-8 text-center tabular-nums" aria-live="polite">
              {qty}
            </span>
            <button
              className="grid size-12 place-items-center text-muted hover:text-fg disabled:opacity-30"
              onClick={() => setQty((n) => Math.min(room, n + 1))}
              disabled={qty >= room}
              aria-label="One more"
            >
              <Plus width={16} height={16} />
            </button>
          </div>
          <Button
            className={`flex-1 !bg-accent !text-accent-fg ${added ? "!bg-ink !text-[color:var(--chalk)]" : ""}`}
            onClick={add}
            disabled={!variant || room < 1}
          >
            {added ? (
              <span className="flex items-center gap-2">
                <Check width={18} height={18} /> Added
              </span>
            ) : !variant || variant.available === 0 ? (
              "Sold out"
            ) : room < 1 ? (
              "All in your cart"
            ) : (
              "Add to cart"
            )}
          </Button>
        </div>
        <p className="mt-3 h-5 text-sm text-muted" aria-live="polite">
          {low ? `Only ${variant!.available} left` : inCart > 0 ? `${inCart} in your cart` : ""}
        </p>

        {p.description && <p className="mt-6 max-w-[60ch] whitespace-pre-line text-muted text-pretty">{p.description}</p>}
      </section>
    </div>
  );
}

function Options({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string | null;
  options: { value: string; disabled: boolean }[];
  onPick: (v: string) => void;
}) {
  return (
    <fieldset className="mt-6">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o.value)}
              className={`relative h-11 min-w-12 rounded-md border px-4 text-[15px] transition-colors ${
                on ? "border-ink bg-ink text-[color:var(--chalk)]" : "border-line-strong bg-raised hover:border-fg"
              } ${o.disabled ? "text-faint line-through decoration-1" : ""} ${o.disabled && !on ? "opacity-60" : ""}`}
            >
              {o.value}
              {o.disabled && <span className="sr-only"> (sold out)</span>}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Gallery({ product }: { product: PublicProduct }) {
  const [index, setIndex] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const n = product.images.length;
  if (n === 0) return <div className="aspect-[4/5] rounded-md bg-sunken" />;

  return (
    <div className="relative">
      <div
        ref={track}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
        className="flex snap-x snap-mandatory overflow-x-auto rounded-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label={`${product.title} photos`}
      >
        {product.images.map((img, i) => (
          <Thumb
            key={img.id}
            image={img}
            sizes="(min-width:1024px) 55vw, 100vw"
            alt={i === 0 ? product.title : `${product.title}, photo ${i + 1}`}
            eager={i === 0}
            className="aspect-[4/5] w-full shrink-0 snap-center"
          />
        ))}
      </div>
      {n > 1 && (
        <div className="mt-3 flex justify-center gap-1.5" role="tablist" aria-label="Photo">
          {product.images.map((img, i) => (
            <button
              key={img.id}
              role="tab"
              aria-selected={i === index}
              aria-label={`Photo ${i + 1} of ${n}`}
              onClick={() => track.current?.scrollTo({ left: i * track.current.clientWidth, behavior: "smooth" })}
              className="grid h-6 w-6 place-items-center"
            >
              <span className={`h-1.5 rounded-full transition-all duration-300 ${i === index ? "w-5 bg-ink" : "w-1.5 bg-line-strong"}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
