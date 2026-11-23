import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkoutSchema, formatCedis, type CheckoutInput, type QuoteLine } from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { useCart } from "../../lib/cart.ts";
import { uuid } from "../../lib/uuid.ts";
import { Button, Field } from "../../components/ui.tsx";
import { Thumb } from "../../components/Thumb.tsx";
import { ArrowLeft, Minus, Plus, Trash } from "../../components/icons.tsx";
import { ReceiptCard, ReceiptRow, ReceiptTotal, TearLine } from "./Receipt.tsx";
import { useStore } from "./StoreShell.tsx";

const CONTACT_KEY = "kiosk.contact.v1";
type Contact = { name?: string; phone?: string };
const loadContact = (): Contact => {
  try {
    return JSON.parse(localStorage.getItem(CONTACT_KEY) ?? "{}") as Contact;
  } catch {
    return {};
  }
};

type Fulfilment = "delivery" | "pickup";

export function CartPage() {
  const { store, slug } = useStore();
  const cart = useCart(slug);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { zones, settings } = store.delivery;
  const delivers = zones.length > 0;
  const canPickup = settings.pickupEnabled;

  const saved = useMemo(loadContact, []);
  const [fulfilment, setFulfilment] = useState<Fulfilment>(delivers || !canPickup ? "delivery" : "pickup");
  const [zoneId, setZoneId] = useState<string | null>(zones.length === 1 ? zones[0]!.id : null);
  const [name, setName] = useState(saved.name ?? "");
  const [phone, setPhone] = useState(saved.phone ?? "");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const items = cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
  const sig = items.map((i) => `${i.variantId}:${i.quantity}`).join(",");
  const effectiveZone = fulfilment === "delivery" ? zoneId : null;

  // The server prices the cart. keepPreviousData lets the total roll instead of flashing.
  const quote = useQuery({
    queryKey: ["quote", slug, sig, fulfilment, effectiveZone],
    queryFn: () => api.quote(slug, { items, fulfilment, zoneId: effectiveZone }),
    enabled: items.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: 1,
  });
  const q = quote.data;
  const fresh = Boolean(q) && !quote.isPlaceholderData;

  // If stock dropped, bring the cart down to what can actually be ordered.
  useEffect(() => {
    if (!q || quote.isPlaceholderData) return;
    const reduced = q.lines.filter((l) => l.problem === "reduced");
    if (!reduced.length) return;
    for (const l of reduced) cart.setQuantity(l.variantId, l.quantity);
    setNotice("Some quantities were lowered to what's in stock.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, quote.isPlaceholderData]);

  // One token per distinct checkout; a retry of the same checkout reuses it so it can't double-order.
  const tokenRef = useRef<{ key: string; token: string } | null>(null);
  const tokenFor = (key: string) => {
    if (tokenRef.current?.key !== key) tokenRef.current = { key, token: uuid() };
    return tokenRef.current.token;
  };

  const place = useMutation({
    mutationFn: (input: CheckoutInput) => api.placeOrder(slug, input),
    onSuccess: (order) => {
      try {
        sessionStorage.setItem(`kiosk.order.${order.code}`, JSON.stringify(order));
        localStorage.setItem(CONTACT_KEY, JSON.stringify({ name: order.customerName, phone }));
      } catch {
        /* storage blocked: the confirmation page falls back to just the code */
      }
      navigate(`/${slug}/order/${order.code}`, { replace: true });
      cart.clear();
      void qc.invalidateQueries({ queryKey: ["store"] });
      void qc.invalidateQueries({ queryKey: ["product"] });
    },
    onError: (e) => {
      if (!(e instanceof RequestError)) return setFormError("Something went wrong. Try again.");
      if (e.fields && Object.keys(e.fields).length) setErrors(e.fields);
      if (e.code === "cart_changed") {
        setNotice(e.message);
        void qc.invalidateQueries({ queryKey: ["quote", slug] });
      } else if (!Object.keys(e.fields ?? {}).length) {
        setFormError(e.message);
      }
    },
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    const input: CheckoutInput = {
      items,
      fulfilment,
      zoneId: effectiveZone,
      clientToken: tokenFor(`${sig}|${fulfilment}|${effectiveZone}`),
      customerName: name,
      customerPhone: phone,
      addressText: fulfilment === "delivery" ? address : null,
      landmark,
      note,
    };
    const parsed = checkoutSchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      requestAnimationFrame(() =>
        (document.querySelector('[aria-invalid="true"], #area[data-invalid="true"]') as HTMLElement | null)?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        }),
      );
      return;
    }
    setErrors({});
    place.mutate(input);
  }

  const lineBy = new Map(q?.lines.map((l) => [l.variantId, l]));
  const problems = q?.lines.filter((l) => l.problem === "sold_out" || l.problem === "unavailable") ?? [];
  const d = q?.delivery ?? null;
  const zone = zones.find((z) => z.id === effectiveZone);
  const subtotal = q?.subtotalPesewas ?? cart.subtotalPesewas;
  const toFree =
    fulfilment === "delivery" && settings.freeDeliveryOverPesewas && subtotal < settings.freeDeliveryOverPesewas
      ? settings.freeDeliveryOverPesewas - subtotal
      : 0;
  const total = d?.ok ? formatCedis(d.totalPesewas) : null;
  const canPlace = fresh && q!.orderable && d?.ok === true && !store.preview && !place.isPending;

  const placeLabel = store.preview
    ? "Ordering is off in preview"
    : problems.length
      ? "Remove unavailable items"
      : total
        ? `Place order · ${total}`
        : "Choose your area";

  const button = (
    <Button type="submit" form="checkout" busy={place.isPending} disabled={!canPlace} className="w-full !bg-accent !text-accent-fg">
      {placeLabel}
    </Button>
  );

  return (
    <main className="mx-auto max-w-5xl px-4 pb-32 sm:px-8 lg:pb-16">
      <nav className="flex h-16 items-center">
        <Link to={`/${slug}`} className="-ml-2 flex h-11 items-center gap-2 rounded-md px-2 text-muted hover:text-fg">
          <ArrowLeft width={18} height={18} />
          Keep shopping
        </Link>
      </nav>
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.035em] sm:text-5xl">Your cart</h1>

      {cart.lines.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-lg text-muted">Nothing in your cart yet.</p>
          <Link to={`/${slug}`} className="mt-5 inline-flex h-12 items-center rounded-md bg-ink px-6 text-[color:var(--chalk)]">
            Browse {store.name}
          </Link>
        </div>
      ) : (
        <>
        {notice && (
          <p role="status" className="mt-6 rounded-md border border-line-strong bg-raised px-4 py-3 text-sm">
            {notice}
          </p>
        )}
        <form id="checkout" onSubmit={submit} noValidate className="mt-8 grid gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* Items */}
          <section className="lg:col-start-1" aria-label="Items">
            <ul className="divide-y divide-line border-y border-line">
              {cart.lines.map((l) => (
                <Line
                  key={l.variantId}
                  title={l.title}
                  label={l.label}
                  unit={lineBy.get(l.variantId)?.unitPricePesewas ?? l.unitPricePesewas}
                  quantity={l.quantity}
                  server={lineBy.get(l.variantId)}
                  onQty={(n) => cart.setQuantity(l.variantId, n)}
                  onRemove={() => cart.remove(l.variantId)}
                />
              ))}
            </ul>
            {problems.length > 0 && (
              <button
                type="button"
                onClick={() => cart.removeMany(problems.map((p) => p.variantId))}
                className="mt-3 text-sm underline underline-offset-4"
              >
                Remove {problems.length === 1 ? "the unavailable item" : "unavailable items"}
              </button>
            )}
          </section>

          {/* Delivery */}
          <section className="lg:col-start-1" aria-labelledby="area-h">
            <h2 id="area-h" className="font-display text-xl font-bold tracking-tight">
              {canPickup && delivers ? "Delivery or pickup" : canPickup ? "Pickup" : "Where should it go?"}
            </h2>

            {!delivers && !canPickup ? (
              <p className="mt-3 rounded-md border border-line-strong bg-raised px-4 py-3 text-muted">
                This store hasn't set up delivery yet, so it can't take orders right now.
              </p>
            ) : (
              <>
                {canPickup && delivers && (
                  <div className="mt-4 grid grid-cols-2 gap-1 rounded-md bg-sunken p-1" role="group" aria-label="How do you want it?">
                    {(["delivery", "pickup"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={fulfilment === f}
                        onClick={() => setFulfilment(f)}
                        className={`h-10 rounded-[calc(var(--radius)-4px)] text-[15px] font-medium transition-colors ${
                          fulfilment === f ? "bg-raised shadow-sm" : "text-muted"
                        }`}
                      >
                        {f === "delivery" ? "Delivery" : "Pickup"}
                      </button>
                    ))}
                  </div>
                )}

                {fulfilment === "delivery" ? (
                  <div id="area" data-invalid={errors.zoneId ? "true" : undefined} className="mt-4">
                    <p className="mb-2 text-sm text-muted">Pick your area. The fee is set by the seller.</p>
                    {zones.length <= 10 ? (
                      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Delivery area">
                        {zones.map((z) => {
                          const on = z.id === zoneId;
                          return (
                            <button
                              key={z.id}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              onClick={() => {
                                setZoneId(z.id);
                                setErrors((e) => ({ ...e, zoneId: "" }));
                              }}
                              className={`min-h-12 rounded-md border px-4 py-2 text-left transition-colors ${
                                on ? "border-ink bg-ink text-[color:var(--chalk)]" : "border-line-strong bg-raised hover:border-fg"
                              }`}
                            >
                              <span className="block text-[15px] font-medium">{z.name}</span>
                              <span className={`block text-sm tabular-nums ${on ? "opacity-70" : "text-muted"}`}>
                                {formatCedis(z.feePesewas)}
                                {z.etaLabel ? ` · ${z.etaLabel}` : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <select
                        value={zoneId ?? ""}
                        onChange={(e) => {
                          setZoneId(e.target.value || null);
                          setErrors((x) => ({ ...x, zoneId: "" }));
                        }}
                        aria-label="Delivery area"
                        className="h-12 w-full rounded-md border border-line-strong bg-raised px-3.5"
                      >
                        <option value="">Choose your area</option>
                        {zones.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name} · {formatCedis(z.feePesewas)}
                          </option>
                        ))}
                      </select>
                    )}
                    {errors.zoneId && <p className="mt-2 text-sm text-danger">{errors.zoneId}</p>}
                    {d && !d.ok && <p className="mt-2 text-sm text-danger">{d.reason}</p>}
                  </div>
                ) : (
                  <p className="mt-4 rounded-md border border-line-strong bg-raised px-4 py-3">
                    <span className="block text-sm text-muted">Collect from</span>
                    {settings.pickupAddress}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Receipt */}
          <aside className="lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:self-start lg:sticky lg:top-6" aria-label="Order total">
            <ReceiptCard>
              <ReceiptRow label="Items" value={formatCedis(subtotal)} />
              <ReceiptRow
                label={fulfilment === "pickup" ? "Pickup" : zone ? `Delivery · ${zone.name}` : "Delivery"}
                value={
                  d?.ok ? (d.feePesewas === 0 ? "Free" : formatCedis(d.feePesewas)) : <span className="text-sm opacity-60">to be set</span>
                }
                muted={!d?.ok}
              />
              <TearLine />
              <ReceiptTotal value={total} />
              {toFree > 0 && d?.ok && (
                <p className="mt-4 text-sm opacity-75">Add {formatCedis(toFree)} more for free delivery.</p>
              )}
            </ReceiptCard>
            <div className="mt-4 hidden lg:block">{button}</div>
            <p className="mt-3 hidden text-center text-sm text-faint lg:block">You'll hear from {store.name} on WhatsApp.</p>
          </aside>

          {/* Details */}
          <section className="lg:col-start-1" aria-labelledby="you-h">
            <h2 id="you-h" className="font-display text-xl font-bold tracking-tight">
              Your details
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" error={errors.customerName} />
              <Field
                label="WhatsApp number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
                placeholder="024 123 4567"
                error={errors.customerPhone}
              />
              {fulfilment === "delivery" && (
                <>
                  <Field
                    className="sm:col-span-2"
                    label="Delivery address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    autoComplete="street-address"
                    placeholder="House number, street, area"
                    error={errors.addressText}
                  />
                  <Field
                    className="sm:col-span-2"
                    label="Landmark (optional)"
                    value={landmark}
                    onChange={(e) => setLandmark(e.target.value)}
                    placeholder="Near the mall, blue gate"
                  />
                </>
              )}
              <Field className="sm:col-span-2" label="Note to the seller (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {formError && (
              <p role="alert" className="mt-4 text-sm text-danger">
                {formError}
              </p>
            )}
          </section>
        </form>
        </>
      )}

      {cart.lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm lg:hidden">
          <div className="mx-auto max-w-md">{button}</div>
        </div>
      )}
    </main>
  );
}

function Line({
  title,
  label,
  unit,
  quantity,
  server,
  onQty,
  onRemove,
}: {
  title: string;
  label: string;
  unit: number;
  quantity: number;
  server: QuoteLine | undefined;
  onQty: (n: number) => void;
  onRemove: () => void;
}) {
  const gone = server?.problem === "sold_out" || server?.problem === "unavailable";
  return (
    <li className="flex gap-4 py-4">
      <div className="w-20 shrink-0 sm:w-24">
        {server?.image ? (
          <Thumb image={server.image} sizes="96px" alt="" className={`aspect-[4/5] rounded-sm ${gone ? "opacity-40" : ""}`} />
        ) : (
          <div className="aspect-[4/5] rounded-sm bg-sunken" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate font-medium ${gone ? "text-faint line-through" : ""}`}>{title}</p>
            <p className="text-sm text-muted">{label}</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            className="-mr-2 -mt-1 grid size-10 shrink-0 place-items-center rounded-md text-faint hover:text-danger"
            aria-label={`Remove ${title}`}
          >
            <Trash width={18} height={18} />
          </button>
        </div>
        {gone ? (
          <p className="mt-auto text-sm text-danger">{server?.problem === "sold_out" ? "Sold out" : "No longer available"}</p>
        ) : (
          <div className="mt-auto flex items-center justify-between pt-2">
            <div className="flex h-10 items-center rounded-md border border-line-strong bg-raised">
              <button
                type="button"
                className="grid size-10 place-items-center text-muted hover:text-fg disabled:opacity-30"
                onClick={() => onQty(quantity - 1)}
                disabled={quantity <= 1}
                aria-label={`One fewer ${title}`}
              >
                <Minus width={15} height={15} />
              </button>
              <span className="w-7 text-center tabular-nums">{quantity}</span>
              <button
                type="button"
                className="grid size-10 place-items-center text-muted hover:text-fg disabled:opacity-30"
                onClick={() => onQty(quantity + 1)}
                aria-label={`One more ${title}`}
              >
                <Plus width={15} height={15} />
              </button>
            </div>
            <span className="font-medium tabular-nums">{formatCedis(unit * quantity)}</span>
          </div>
        )}
      </div>
    </li>
  );
}
