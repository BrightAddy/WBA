import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatGhanaPhone, type AdminSellerDto, type AdminSellerFilter } from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { Button } from "../../components/ui.tsx";

const TABS: { id: AdminSellerFilter; label: string }[] = [
  { id: "pending", label: "Waiting" },
  { id: "approved", label: "Live" },
  { id: "suspended", label: "Suspended" },
];

const EMPTY: Record<AdminSellerFilter, string> = {
  pending: "Nobody is waiting for review.",
  approved: "No live stores yet.",
  suspended: "No suspended stores.",
};

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string) {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), "hour");
  return rtf.format(Math.round(mins / 1440), "day");
}

export function Review() {
  const [tab, setTab] = useState<AdminSellerFilter>("pending");
  const q = useQuery({ queryKey: ["admin-sellers", tab], queryFn: () => api.adminSellers(tab), refetchInterval: 30_000 });
  // Keep the counts visible while another tab loads.
  const counts = q.data?.counts;

  return (
    <main className="mx-auto max-w-4xl px-5 pb-24 pt-8 sm:px-8 sm:pt-12">
      <h1 className="font-display text-[2.25rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-[2.75rem]">Store review</h1>
      <p className="mt-3 max-w-[56ch] text-muted">
        Open the seller's Instagram or TikTok and check it's a real page selling real stock. Approve to put their store live.
      </p>

      <div className="mt-8 flex gap-2 overflow-x-auto" role="tablist" aria-label="Store status">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] transition-colors ${
              tab === t.id ? "border-ink bg-ink text-[color:var(--chalk)]" : "border-line-strong text-muted hover:text-fg"
            }`}
          >
            {t.label}
            {counts && (
              <span
                className={`min-w-5 rounded-full px-1.5 text-xs font-semibold leading-5 ${
                  t.id === "pending" && counts.pending > 0 && tab !== t.id ? "bg-accent text-accent-fg" : "bg-[color:var(--chalk)]/15"
                }`}
              >
                {counts[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <div className="mt-6 h-40 animate-pulse rounded-lg bg-sunken" aria-busy />
      ) : q.isError ? (
        <p className="mt-8 text-muted">
          {q.error instanceof RequestError && q.error.status === 403
            ? "This account isn't an admin. Add your number to ADMIN_PHONES and sign in again."
            : "Couldn't load stores. Check your connection and reload."}
        </p>
      ) : q.data.sellers.length === 0 ? (
        <p className="mt-10 text-muted">{EMPTY[tab]}</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {q.data.sellers.map((s) => (
            <SellerCard key={s.id} seller={s} />
          ))}
        </ul>
      )}
    </main>
  );
}

function SellerCard({ seller: s }: { seller: AdminSellerDto }) {
  const qc = useQueryClient();
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");
  const done = () => {
    setSuspending(false);
    setReason("");
    void qc.invalidateQueries({ queryKey: ["admin-sellers"] });
  };
  const approve = useMutation({ mutationFn: () => api.adminApprove(s.id), onSuccess: done });
  const suspend = useMutation({ mutationFn: () => api.adminSuspend(s.id, reason), onSuccess: done });
  const error = (approve.error ?? suspend.error) as RequestError | null;
  const link = "underline underline-offset-4 hover:text-accent";
  const noSocial = !s.instagramUrl && !s.tiktokUrl;

  return (
    <li className="rounded-lg border border-line-strong bg-raised p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-2xl font-extrabold tracking-tight">{s.storeName}</h2>
        <a className={`text-sm text-muted ${link}`} href={`/${s.slug}`} target="_blank" rel="noopener noreferrer">
          /{s.slug}
        </a>
        <span className="ml-auto text-sm text-muted">signed up {ago(s.createdAt)}</span>
      </div>

      <dl className="mt-4 grid gap-x-8 gap-y-1.5 text-[15px] sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Owner</dt>
        <dd>{s.ownerName}</dd>
        <dt className="text-muted">WhatsApp</dt>
        <dd>
          <a className={link} href={`https://wa.me/${s.phone.replace("+", "")}`} target="_blank" rel="noopener noreferrer">
            {formatGhanaPhone(s.phone)}
          </a>
        </dd>
        <dt className="text-muted">Page to check</dt>
        <dd className="flex flex-wrap gap-x-4">
          {s.instagramUrl && (
            <a className={link} href={s.instagramUrl} target="_blank" rel="noopener noreferrer">
              Instagram
            </a>
          )}
          {s.tiktokUrl && (
            <a className={link} href={s.tiktokUrl} target="_blank" rel="noopener noreferrer">
              TikTok
            </a>
          )}
          {noSocial && <span className="text-danger">Neither given</span>}
        </dd>
        <dt className="text-muted">Set up</dt>
        <dd>
          {s.liveProducts} live {s.liveProducts === 1 ? "product" : "products"}, {s.deliveryAreas}{" "}
          {s.deliveryAreas === 1 ? "delivery area" : "delivery areas"}
          {s.orders > 0 && `, ${s.orders} ${s.orders === 1 ? "order" : "orders"}`}
        </dd>
        {s.status !== "pending" && s.suspendedReason && (
          <>
            <dt className="text-muted">Reason</dt>
            <dd>{s.suspendedReason}</dd>
          </>
        )}
      </dl>

      <div className="mt-5 border-t border-line pt-4">
        {suspending ? (
          <div className="space-y-3">
            <label className="block text-sm font-medium" htmlFor={`why-${s.id}`}>
              Why? This is kept in the record.
            </label>
            <input
              id={`why-${s.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Instagram page isn't theirs"
              className="h-12 w-full rounded-md border border-line-strong bg-bg px-3.5 outline-none focus:border-fg"
              autoFocus
            />
            <div className="flex items-center gap-3">
              <Button variant="secondary" className="!h-11" busy={suspend.isPending} disabled={reason.trim().length < 3} onClick={() => suspend.mutate()}>
                Suspend store
              </Button>
              <Button variant="quiet" onClick={() => setSuspending(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {s.status !== "approved" && (
              <Button className="!h-11" busy={approve.isPending} onClick={() => approve.mutate()}>
                {s.status === "pending" ? "Approve store" : "Reinstate store"}
              </Button>
            )}
            {s.status !== "suspended" && (
              <Button variant={s.status === "pending" ? "secondary" : "quiet"} className={s.status === "pending" ? "!h-11" : ""} onClick={() => setSuspending(true)}>
                {s.status === "pending" ? "Reject" : "Suspend"}
              </Button>
            )}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error.message}</p>}
      </div>
    </li>
  );
}
