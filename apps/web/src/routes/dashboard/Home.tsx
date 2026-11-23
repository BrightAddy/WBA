import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { storeUrl } from "@kiosk/shared";
import { api } from "../../lib/api.ts";
import { Button } from "../../components/ui.tsx";
import { useSellerMe } from "./Layout.tsx";

export function Home() {
  const me = useSellerMe();
  const seller = me.seller;
  const [copied, setCopied] = useState(false);
  const link = storeUrl(seller.slug);
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });
  const delivery = useQuery({ queryKey: ["delivery"], queryFn: api.delivery });

  async function copy() {
    try {
      await navigator.clipboard.writeText(`https://${link}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked: the link is still selectable on screen. */
    }
  }

  const live = products.data?.filter((p) => p.status === "active").length ?? 0;
  const zones = delivery.data?.zones.length ?? 0;
  const steps = [
    {
      title: "We check your page",
      body: "We look at your Instagram or TikTok to confirm you're a real seller. Usually within a day.",
      done: seller.status === "approved",
    },
    {
      title: "Add your stock",
      body: live ? `${live} ${live === 1 ? "product is" : "products are"} live.` : "Snap your clothes, set prices and sizes, then publish.",
      done: live > 0,
      to: "/dashboard/products/new",
      cta: "Add a product",
    },
    {
      title: "Set where you deliver",
      body: zones ? `${zones} ${zones === 1 ? "area" : "areas"} with fees set.` : "List the areas you deliver to and what each costs.",
      done: zones > 0 || Boolean(delivery.data?.settings.pickupEnabled),
      to: "/dashboard/delivery",
      cta: "Set delivery",
    },
    {
      title: "Share your link",
      body: "Put it in your bio and status. Orders come straight to your WhatsApp.",
      done: false,
    },
  ];

  return (
    <main className="mx-auto max-w-3xl px-5 pb-24 pt-8 sm:px-8 sm:pt-12">
      {seller.status === "pending" && (
        <span className="inline-flex items-center gap-2 rounded-full bg-gold px-3 py-1 text-sm font-medium text-ink">
          <span className="size-1.5 rounded-full bg-ink" aria-hidden />
          In review
        </span>
      )}
      <h1 className="mt-4 font-display text-[2.5rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-5xl">
        {seller.storeName}
      </h1>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <code className="rounded-md bg-sunken px-3 py-2 font-sans text-[15px]">{link}</code>
        <Button variant="quiet" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Link to={`/${seller.slug}`} className="text-muted underline-offset-4 hover:text-fg hover:underline">
          {seller.status === "pending" ? "Preview your store" : "View your store"}
        </Link>
      </div>
      {seller.status === "pending" && (
        <p className="mt-3 max-w-[52ch] text-sm text-muted">
          Customers can open your link once we approve the store. Add stock and delivery areas while you wait, and preview how it looks.
        </p>
      )}

      <ol className="mt-12 divide-y divide-line border-y border-line">
        {steps.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[2rem_1fr_auto] items-start gap-x-3 py-5">
            <span
              className={`grid size-6 place-items-center rounded-full font-display text-sm font-bold tabular-nums ${
                s.done ? "bg-lime text-ink" : "text-faint"
              }`}
            >
              {s.done ? <span aria-label="Done">✓</span> : i + 1}
            </span>
            <div>
              <p className="font-medium">{s.title}</p>
              <p className="mt-1 max-w-[56ch] text-sm text-muted">{s.body}</p>
            </div>
            {s.to && !s.done && (
              <Link to={s.to} className="self-center text-sm font-medium underline underline-offset-4 hover:text-accent">
                {s.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>

      {me.account.role === "admin" && (
        <p className="mt-8 text-sm text-muted">You're signed in as an admin. The admin dashboard arrives on Day 6.</p>
      )}
    </main>
  );
}
