import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AREA_SUGGESTIONS,
  MAX_ZONES,
  deliverySettingsSchema,
  formatCedis,
  parseCedis,
  quoteDelivery,
  zonesInputSchema,
  type DeliveryConfigDto,
  type ZoneInput,
} from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { useUnsavedGuard } from "../../lib/use-unsaved-guard.ts";
import { Button, Field } from "../../components/ui.tsx";
import { RollingNumber } from "../../components/RollingNumber.tsx";
import { Page } from "./Layout.tsx";

type ZoneRow = { key: string; id?: string; name: string; fee: string; eta: string };
type State = { zones: ZoneRow[]; pickupEnabled: boolean; pickupAddress: string; freeOn: boolean; freeOver: string };

const toState = (c: DeliveryConfigDto): State => ({
  zones: c.zones.map((z) => ({ key: z.id, id: z.id, name: z.name, fee: String(z.feePesewas / 100), eta: z.etaLabel ?? "" })),
  pickupEnabled: c.settings.pickupEnabled,
  pickupAddress: c.settings.pickupAddress ?? "",
  freeOn: c.settings.freeDeliveryOverPesewas !== null,
  freeOver: c.settings.freeDeliveryOverPesewas === null ? "" : String(c.settings.freeDeliveryOverPesewas / 100),
});

/** Comparable snapshot: what would be sent, ignoring row keys. */
const snapshot = (s: State) =>
  JSON.stringify({
    z: s.zones.map((z) => [z.id ?? null, z.name.trim(), z.fee.trim(), z.eta.trim()]),
    p: [s.pickupEnabled, s.pickupAddress.trim()],
    f: [s.freeOn, s.freeOn ? s.freeOver.trim() : ""],
  });

export function Delivery() {
  const q = useQuery({ queryKey: ["delivery"], queryFn: api.delivery });
  if (q.isPending) return <Page title="Delivery"><div className="h-64 animate-pulse rounded-md bg-sunken" /></Page>;
  if (q.isError) return <Page title="Delivery"><p className="text-muted">Delivery settings didn't load. Reload to try again.</p></Page>;
  return <DeliveryForm config={q.data} />;
}

function DeliveryForm({ config }: { config: DeliveryConfigDto }) {
  const qc = useQueryClient();
  const [s, setS] = useState<State>(() => toState(config));
  const [saved, setSaved] = useState(() => snapshot(toState(config)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string }>();
  const [city, setCity] = useState<keyof typeof AREA_SUGGESTIONS>("Accra");
  const focusKey = useRef<string | null>(null);

  const dirty = snapshot(s) !== saved;
  useUnsavedGuard(dirty && !busy);

  const patch = (p: Partial<State>) => {
    setS((x) => ({ ...x, ...p }));
    setNotice(undefined);
  };
  const patchZone = (key: string, p: Partial<ZoneRow>) => {
    setS((x) => ({ ...x, zones: x.zones.map((z) => (z.key === key ? { ...z, ...p } : z)) }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`zone:${key}`))));
    setNotice(undefined);
  };
  const addZone = (name = "") => {
    if (s.zones.length >= MAX_ZONES) return;
    const key = crypto.randomUUID();
    focusKey.current = key;
    patch({ zones: [...s.zones, { key, name, fee: "", eta: "" }] });
  };

  useEffect(() => {
    if (!focusKey.current) return;
    const row = s.zones.find((z) => z.key === focusKey.current);
    document.getElementById(`${row?.name ? "fee" : "name"}-${focusKey.current}`)?.focus();
    focusKey.current = null;
  }, [s.zones]);

  const taken = new Set(s.zones.map((z) => z.name.trim().toLowerCase()));
  const suggestions = AREA_SUGGESTIONS[city].filter((a) => !taken.has(a.toLowerCase()));

  async function save() {
    // Build and validate locally first, mapping errors back to rows.
    const errs: Record<string, string> = {};
    const zones: ZoneInput[] = s.zones.map((z) => {
      const fee = parseCedis(z.fee || "");
      if (!z.fee.trim()) errs[`zone:${z.key}:fee`] = "Set a fee, or 0 for free.";
      else if (fee === null) errs[`zone:${z.key}:fee`] = "Enter an amount like 15 or 15.50.";
      return { ...(z.id && { id: z.id }), name: z.name, feePesewas: fee ?? 0, etaLabel: z.eta || null };
    });
    const zr = zonesInputSchema.safeParse({ zones });
    if (!zr.success) {
      for (const i of zr.error.issues) {
        const row = s.zones[Number(i.path[1])];
        if (row) errs[`zone:${row.key}:${String(i.path[2] ?? "name")}`] ??= i.message;
        else errs.zones = i.message;
      }
    }
    const freeOver = s.freeOn ? parseCedis(s.freeOver) : null;
    if (s.freeOn && (freeOver === null || freeOver === 0)) errs.freeOver = "Enter an order amount, like 500.";
    const settings = { pickupEnabled: s.pickupEnabled, pickupAddress: s.pickupAddress || null, freeDeliveryOverPesewas: freeOver };
    const sr = deliverySettingsSchema.safeParse(settings);
    if (!sr.success) for (const i of sr.error.issues) errs[String(i.path[0])] ??= i.message;
    if (Object.keys(errs).length) {
      setErrors(errs);
      setNotice({ tone: "err", text: "Fix the highlighted fields." });
      return;
    }

    setBusy(true);
    try {
      await api.saveZones(zones);
      const next = await api.saveDeliverySettings(sr.data!);
      const st = toState(next);
      setS(st);
      setSaved(snapshot(st));
      qc.setQueryData(["delivery"], next);
      setNotice({ tone: "ok", text: "Delivery settings saved" });
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof RequestError ? e.message : "Something went wrong. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Delivery">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
        <div className="space-y-10">
          <section aria-labelledby="zones-h">
            <div className="mb-3 flex items-baseline justify-between gap-4 border-b border-line pb-2">
              <h2 id="zones-h" className="font-display text-lg font-bold tracking-[-0.01em]">
                Areas you deliver to
              </h2>
              <p className="hidden text-sm text-muted sm:block">Customers pick one at checkout</p>
            </div>

            {s.zones.length === 0 ? (
              <p className="py-4 text-muted">No areas yet. Tap an area below or add your own.</p>
            ) : (
              <ul className="divide-y divide-line">
                {s.zones.map((z) => (
                  <ZoneEditor
                    key={z.key}
                    z={z}
                    errors={errors}
                    onChange={(p) => patchZone(z.key, p)}
                    onRemove={() => patch({ zones: s.zones.filter((x) => x.key !== z.key) })}
                  />
                ))}
              </ul>
            )}
            {errors.zones && <p className="mt-2 text-sm text-danger">{errors.zones}</p>}

            <div className="mt-4 space-y-3 rounded-md bg-sunken p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Quick add</p>
                <div className="inline-flex rounded-md border border-line-strong p-0.5 text-sm" role="radiogroup" aria-label="City">
                  {(Object.keys(AREA_SUGGESTIONS) as (keyof typeof AREA_SUGGESTIONS)[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={city === c}
                      onClick={() => setCity(c)}
                      className={`rounded-[calc(var(--radius)-2px)] px-2.5 py-1 ${city === c ? "bg-ink text-[color:var(--chalk)]" : "text-muted hover:text-fg"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => addZone(a)}
                    className="h-8 rounded-full border border-line-strong bg-raised px-3 text-sm transition-colors hover:border-fg"
                  >
                    {a}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => addZone()}
                  className="h-8 rounded-full border border-dashed border-line-strong px-3 text-sm text-muted hover:border-fg hover:text-fg"
                >
                  Another area
                </button>
              </div>
            </div>
          </section>

          <section aria-labelledby="options-h" className="space-y-6">
            <h2 id="options-h" className="border-b border-line pb-2 font-display text-lg font-bold tracking-[-0.01em]">
              Options
            </h2>
            <Toggle
              label="Free delivery on big orders"
              note="Delivery is free when the items total reaches this amount."
              on={s.freeOn}
              onChange={(v) => patch({ freeOn: v })}
            >
              <Field
                label="Free from"
                prefix="GH₵"
                inputMode="decimal"
                placeholder="500"
                value={s.freeOver}
                onChange={(e) => {
                  patch({ freeOver: e.target.value });
                  setErrors((x) => ({ ...x, freeOver: "" }));
                }}
                error={errors.freeOver}
                className="max-w-56"
              />
            </Toggle>
            <Toggle
              label="Customers can pick up"
              note="Pickup orders pay no delivery fee."
              on={s.pickupEnabled}
              onChange={(v) => patch({ pickupEnabled: v })}
            >
              <Field
                label="Pickup point"
                placeholder="Madina Zongo Junction, opposite the Total station"
                value={s.pickupAddress}
                onChange={(e) => {
                  patch({ pickupAddress: e.target.value });
                  setErrors((x) => ({ ...x, pickupAddress: "" }));
                }}
                error={errors.pickupAddress}
                hint="Use a landmark people know. It's sent to the customer after they pay."
              />
            </Toggle>
          </section>
        </div>

        <aside className="order-first lg:order-none">
          <div className="lg:sticky lg:top-24">
            <Receipt state={s} />
          </div>
        </aside>
      </div>

      <div className="sticky bottom-14 z-10 -mx-5 mt-10 border-t border-line bg-bg/95 px-5 py-3 backdrop-blur-sm sm:bottom-0 sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-3">
          <p role="status" className={`mr-auto text-sm ${notice?.tone === "err" ? "text-danger" : "text-muted"}`}>
            {notice?.text ?? (dirty ? "Unsaved changes" : "All changes saved")}
          </p>
          <Button busy={busy} disabled={!dirty || busy} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Page>
  );
}

function ZoneEditor({
  z,
  errors,
  onChange,
  onRemove,
}: {
  z: ZoneRow;
  errors: Record<string, string>;
  onChange: (p: Partial<ZoneRow>) => void;
  onRemove: () => void;
}) {
  const err = (f: string) => errors[`zone:${z.key}:${f}`];
  const input = (bad?: string) =>
    `h-11 w-full min-w-0 rounded-md border bg-raised px-3 outline-none placeholder:text-faint focus:border-fg ${bad ? "border-danger" : "border-line-strong"}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_104px_44px] gap-x-2 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_112px_140px_44px]">
      <div className="col-start-1 row-start-1">
        <input
          id={`name-${z.key}`}
          aria-label="Area"
          value={z.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Area name"
          className={input(err("name"))}
        />
        {err("name") && <p className="mt-1 text-sm text-danger">{err("name")}</p>}
      </div>
      <div className="col-start-2 row-start-1">
        <div className={`flex h-11 items-center rounded-md border bg-raised focus-within:border-fg ${err("fee") || err("feePesewas") ? "border-danger" : "border-line-strong"}`}>
          <span className="pl-2.5 pr-1 text-sm text-muted">GH₵</span>
          <input
            id={`fee-${z.key}`}
            aria-label={`Fee for ${z.name || "this area"}`}
            inputMode="decimal"
            value={z.fee}
            onChange={(e) => onChange({ fee: e.target.value })}
            placeholder="15"
            className="h-full w-full min-w-0 bg-transparent pr-2 tabular-nums outline-none placeholder:text-faint"
          />
        </div>
        {(err("fee") || err("feePesewas")) && <p className="mt-1 text-sm text-danger">{err("fee") || err("feePesewas")}</p>}
      </div>
      <input
        aria-label={`Delivery time for ${z.name || "this area"}`}
        value={z.eta}
        onChange={(e) => onChange({ eta: e.target.value })}
        placeholder="Same day"
        maxLength={30}
        className={`${input()} col-span-2 col-start-1 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1`}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${z.name || "area"}`}
        className="col-start-3 row-start-1 grid size-11 place-items-center rounded-md text-xl text-muted hover:bg-sunken hover:text-fg sm:col-start-4"
      >
        ×
      </button>
    </li>
  );
}

function Toggle({
  label,
  note,
  on,
  onChange,
  children,
}: {
  label: string;
  note: string;
  on: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start justify-between gap-6">
        <span>
          <span className="block font-medium">{label}</span>
          <span className="block text-sm text-muted">{note}</span>
        </span>
        <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span
          aria-hidden
          className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)] ${on ? "bg-ink" : "bg-line-strong"}`}
        >
          <span
            className={`absolute top-1 size-5 rounded-full bg-[color:var(--chalk)] transition-transform duration-[var(--dur)] ease-[var(--ease-spring)] ${on ? "translate-x-6" : "translate-x-1"}`}
          />
        </span>
      </label>
      {on && <div className="mt-4">{children}</div>}
    </div>
  );
}

/**
 * The live preview: what a customer actually pays, computed with the same
 * quoteDelivery() checkout will use.
 */
function Receipt({ state }: { state: State }) {
  const [subtotalText, setSubtotalText] = useState("180");
  const [pick, setPick] = useState<string>("");
  const zones = state.zones.filter((z) => z.name.trim() && parseCedis(z.fee || "x") !== null);
  const options = [...zones.map((z) => ({ value: z.key, label: z.name.trim() })), ...(state.pickupEnabled ? [{ value: "pickup", label: "Pickup" }] : [])];
  const selected = options.find((o) => o.value === pick) ?? options[0];

  const subtotal = parseCedis(subtotalText) ?? 0;
  const freeOver = state.freeOn ? parseCedis(state.freeOver) : null;
  const zone = zones.find((z) => z.key === selected?.value);

  const quote = useMemo(
    () =>
      selected
        ? quoteDelivery({
            subtotalPesewas: subtotal,
            fulfilment: selected.value === "pickup" ? "pickup" : "delivery",
            zone: zone ? { feePesewas: parseCedis(zone.fee)! } : null,
            settings: { pickupEnabled: state.pickupEnabled, freeDeliveryOverPesewas: freeOver },
          })
        : null,
    [selected, subtotal, zone, state.pickupEnabled, freeOver],
  );

  return (
    <div className="rounded-lg bg-ink p-5 text-[color:var(--chalk)] sm:p-6">
      <p className="text-sm text-[color:var(--stone-2)]">What your customer pays</p>

      {!selected ? (
        <p className="mt-6 text-[color:var(--stone-2)]">Add an area with a fee to see a preview.</p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 text-sm">
            <label className="block">
              <span className="sr-only">Order amount</span>
              <span className="flex h-10 items-center rounded-md bg-[color:var(--ink-3)] px-2.5 focus-within:outline-2 focus-within:outline-[var(--accent)]">
                <span className="text-[color:var(--stone-2)]">GH₵</span>
                <input
                  inputMode="decimal"
                  value={subtotalText}
                  onChange={(e) => setSubtotalText(e.target.value)}
                  aria-label="Order amount for the preview"
                  className="w-full min-w-0 bg-transparent pl-1 tabular-nums outline-none"
                />
              </span>
            </label>
            <select
              value={selected.value}
              onChange={(e) => setPick(e.target.value)}
              aria-label="Area for the preview"
              className="h-10 rounded-md bg-[color:var(--ink-3)] px-2 outline-none focus:outline-2 focus:outline-[var(--accent)]"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <dl className="mt-6 space-y-2 border-t border-dashed border-[color:var(--ink-3)] pt-4 text-[15px]">
            <div className="flex justify-between">
              <dt className="text-[color:var(--stone-2)]">Items</dt>
              <dd className="tabular-nums">{formatCedis(subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="truncate text-[color:var(--stone-2)]">
                {selected.value === "pickup" ? "Pickup" : `Delivery to ${selected.label}`}
              </dt>
              <dd className="tabular-nums">
                {quote?.ok ? (
                  quote.freeApplied ? (
                    <span>
                      <s className="mr-2 text-[color:var(--stone-2)]">{formatCedis(parseCedis(zone!.fee)!)}</s>
                      <span className="text-lime">Free</span>
                    </span>
                  ) : (
                    formatCedis(quote.feePesewas)
                  )
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-end justify-between border-t border-[color:var(--ink-3)] pt-4">
            <span className="text-[color:var(--stone-2)]">Total</span>
            <span className="font-display text-[2.75rem] font-extrabold leading-none tracking-[-0.03em] text-gold">
              {quote?.ok ? <RollingNumber value={formatCedis(quote.totalPesewas)} /> : "—"}
            </span>
          </div>
          {freeOver !== null && quote?.ok && !quote.freeApplied && selected.value !== "pickup" && subtotal < freeOver && (
            <p className="mt-3 text-sm text-[color:var(--stone-2)]">
              {formatCedis(freeOver - subtotal)} more and delivery is free.
            </p>
          )}
        </>
      )}
    </div>
  );
}
