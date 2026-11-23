import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { BRAND, onboardingSchema, slugify, validateSlug } from "@kiosk/shared";
import { api, RequestError } from "../lib/api.ts";
import { meKey } from "../lib/session.ts";
import { Button, Field } from "../components/ui.tsx";
import { AuthShell } from "./AuthShell.tsx";

type Availability = { state: "idle" | "checking" | "ok" | "bad"; reason?: string };

export function Onboarding() {
  const [form, setForm] = useState({ ownerName: "", storeName: "", slug: "", instagramUrl: "", tiktokUrl: "" });
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [avail, setAvail] = useState<Availability>({ state: "idle" });
  const navigate = useNavigate();
  const qc = useQueryClient();

  const slug = slugEdited ? form.slug : slugify(form.storeName);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((x) => ({ ...x, [k]: "" }));
  };

  // Debounced availability check; local validation first so we don't hit the API for junk.
  useEffect(() => {
    if (!slug) return setAvail({ state: "idle" });
    const local = validateSlug(slug);
    if (!local.ok) return setAvail({ state: "bad", reason: local.reason });
    setAvail({ state: "checking" });
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .slugAvailability(slug, ctrl.signal)
        .then((r) => setAvail(r.available ? { state: "ok" } : { state: "bad", reason: r.reason }))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input = { ...form, slug };
    const parsed = onboardingSchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      return setErrors(next);
    }
    if (avail.state === "bad") return setErrors({ slug: avail.reason ?? "Pick another link." });

    setBusy(true);
    try {
      await api.onboard(input);
      await qc.invalidateQueries({ queryKey: meKey });
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof RequestError) setErrors(Object.keys(err.fields).length ? err.fields : { _: err.message });
      else setErrors({ _: "Something went wrong. Try again." });
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Name your store"
      lede="This is the link you'll put in your bio and status. Customers tap it, shop, and their order comes to your WhatsApp."
      aside={<LinkPreview slug={slug} storeName={form.storeName} avail={avail} />}
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field label="Your name" autoComplete="name" value={form.ownerName} onChange={set("ownerName")} error={errors.ownerName} autoFocus />
        <Field label="Store name" placeholder="Kofi Thrift" value={form.storeName} onChange={set("storeName")} error={errors.storeName} />
        <Field
          label="Store link"
          prefix={`${BRAND.domain}/`}
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }));
            setErrors((x) => ({ ...x, slug: "" }));
          }}
          autoCapitalize="none"
          spellCheck={false}
          error={errors.slug || (avail.state === "bad" ? avail.reason : undefined)}
          hint={avail.state === "ok" ? "That link is yours if you want it." : avail.state === "checking" ? "Checking…" : undefined}
        />

        <fieldset className="space-y-4 border-t border-line pt-5">
          <legend className="sr-only">Social profiles</legend>
          <p className="text-sm text-muted">
            Add the page you already sell on. We check it before your store goes live, which is what lets buyers trust you.
          </p>
          <Field
            label="Instagram"
            type="url"
            inputMode="url"
            placeholder="https://instagram.com/kofithrift"
            value={form.instagramUrl}
            onChange={set("instagramUrl")}
            error={errors.instagramUrl}
          />
          <Field
            label="TikTok"
            type="url"
            inputMode="url"
            placeholder="https://tiktok.com/@kofithrift"
            value={form.tiktokUrl}
            onChange={set("tiktokUrl")}
            error={errors.tiktokUrl}
          />
        </fieldset>

        {errors._ && <p role="alert" className="text-sm text-danger">{errors._}</p>}
        <Button type="submit" busy={busy} className="w-full">
          Create store
        </Button>
      </form>
    </AuthShell>
  );
}

/** The hero: the store's real link, set huge, assembling as the seller types. */
function LinkPreview({ slug, storeName, avail }: { slug: string; storeName: string; avail: Availability }) {
  const chars = useMemo(() => slug.split(""), [slug]);
  const status =
    avail.state === "ok" ? { text: "Available", cls: "bg-lime text-ink" } :
    avail.state === "bad" && slug ? { text: "Not available", cls: "bg-danger text-[color:var(--chalk)]" } :
    null;

  return (
    <div className="order-first [container-type:inline-size] lg:order-none lg:sticky lg:top-24" aria-live="polite">
      <p className="store-link" style={{ "--chars": Math.max(10, slug.length || 10) } as CSSProperties}>
        <span className="domain">{BRAND.domain}/</span>
        <br />
        <span className="slug">
          {chars.length ? (
            chars.map((c, i) => (
              <span key={`${i}-${c}`} className="slug-char">
                {c}
              </span>
            ))
          ) : (
            <span className="text-line-strong">your-store</span>
          )}
        </span>
        <span className="caret" aria-hidden />
      </p>
      <div className="mt-6 flex min-h-7 items-center gap-3 text-sm">
        {status && <span className={`rounded-full px-2.5 py-1 font-medium ${status.cls}`}>{status.text}</span>}
        {storeName && <span className="text-muted">{storeName}</span>}
      </div>
    </div>
  );
}
