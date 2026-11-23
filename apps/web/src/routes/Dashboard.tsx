import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatGhanaPhone, storeUrl, type MeResponse } from "@kiosk/shared";
import { api } from "../lib/api.ts";
import { meKey } from "../lib/session.ts";
import { Button, Wordmark } from "../components/ui.tsx";

const NEXT_STEPS = [
  { title: "We check your page", body: "We look at your Instagram or TikTok to confirm you're a real seller. Usually within a day." },
  { title: "You add your stock", body: "Snap your clothes, set prices and sizes, and list the areas you deliver to." },
  { title: "You share your link", body: "Put it in your bio and status. Orders come straight to your WhatsApp." },
];

export function Dashboard({ me }: { me: MeResponse }) {
  const seller = me.seller!;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const link = storeUrl(seller.slug);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`https://${link}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked: the link is still selectable on screen. */
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    qc.setQueryData(meKey, null);
    navigate("/login", { replace: true });
  }

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-5 sm:px-8">
      <header className="flex h-16 items-center justify-between">
        <Wordmark />
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-muted sm:inline">{formatGhanaPhone(me.account.phone)}</span>
          <Button variant="quiet" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="pb-20 pt-8 sm:pt-14">
        {seller.status === "pending" && (
          <span className="inline-flex items-center gap-2 rounded-full bg-gold px-3 py-1 text-sm font-medium text-ink">
            <span className="size-1.5 rounded-full bg-ink" aria-hidden />
            In review
          </span>
        )}
        <h1 className="mt-4 font-display text-[2.5rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-5xl">
          {seller.storeName}
        </h1>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <code className="rounded-md bg-sunken px-3 py-2 font-sans text-[15px]">{link}</code>
          <Button variant="quiet" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        {seller.status === "pending" && (
          <p className="mt-3 max-w-[52ch] text-sm text-muted">
            Your link works once we approve the store. You can start adding stock now.
          </p>
        )}

        <ol className="mt-12 divide-y divide-line border-y border-line">
          {NEXT_STEPS.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-x-3 py-5">
              <span className="font-display text-lg font-bold tabular-nums text-faint">{i + 1}</span>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="mt-1 max-w-[56ch] text-sm text-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        {me.account.role === "admin" && (
          <p className="mt-8 text-sm text-muted">You're signed in as an admin. The admin dashboard arrives on Day 6.</p>
        )}
      </main>
    </div>
  );
}
