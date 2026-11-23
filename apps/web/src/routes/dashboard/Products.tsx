import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatCedis, type ProductListItem, type ProductStatus } from "@kiosk/shared";
import { api } from "../../lib/api.ts";
import { Thumb } from "../../components/Thumb.tsx";
import { Page } from "./Layout.tsx";

const STATUS: Record<ProductStatus, { label: string; cls: string }> = {
  active: { label: "Live", cls: "bg-lime text-ink" },
  draft: { label: "Draft", cls: "bg-sunken text-muted" },
  archived: { label: "Archived", cls: "bg-sunken text-faint" },
};

export function Products() {
  const q = useQuery({ queryKey: ["products"], queryFn: api.products });

  return (
    <Page
      title="Products"
      action={
        q.data?.length ? (
          <Link
            to="/dashboard/products/new"
            className="inline-flex h-11 items-center rounded-md bg-ink px-4 text-[15px] font-medium text-[color:var(--chalk)] hover:bg-[color:var(--ink-3)]"
          >
            Add product
          </Link>
        ) : null
      }
    >
      {q.isPending ? (
        <ListSkeleton />
      ) : q.isError ? (
        <p className="text-muted">Your products didn't load. Reload the page to try again.</p>
      ) : q.data.length === 0 ? (
        <Empty />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {q.data.map((p) => (
            <Row key={p.id} p={p} />
          ))}
        </ul>
      )}
    </Page>
  );
}

function Row({ p }: { p: ProductListItem }) {
  const s = STATUS[p.status];
  const soldOut = p.variantCount > 0 && p.totalStock === 0;
  return (
    <li>
      <Link
        to={`/dashboard/products/${p.id}`}
        className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-4 py-3 transition-colors hover:bg-raised sm:grid-cols-[64px_minmax(0,1fr)_120px_120px_88px] sm:px-2"
      >
        {p.cover ? (
          <Thumb image={p.cover} sizes="64px" className="aspect-[4/5] w-full rounded-sm" />
        ) : (
          <div className="grid aspect-[4/5] w-full place-items-center rounded-sm border border-dashed border-line-strong text-xs text-faint">
            No photo
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-medium">{p.title}</p>
          <p className="truncate text-sm text-muted">{p.category}</p>
        </div>
        <p className="hidden text-right font-display font-bold tabular-nums sm:block">{formatCedis(p.pricePesewas)}</p>
        <p className={`hidden text-right text-sm tabular-nums sm:block ${soldOut ? "text-danger" : "text-muted"}`}>
          {soldOut ? "Sold out" : `${p.totalStock} in stock`}
        </p>
        <div className="flex flex-col items-end gap-1">
          <span className="font-display text-sm font-bold tabular-nums sm:hidden">{formatCedis(p.pricePesewas)}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
        </div>
      </Link>
    </li>
  );
}

function Empty() {
  return (
    <div className="max-w-[46ch] border-y border-line py-12">
      <h2 className="font-display text-2xl font-bold tracking-[-0.02em]">Add your first product</h2>
      <p className="mt-2 text-muted">
        Snap a few photos, set a price and the sizes you have. It stays a draft until you publish it.
      </p>
      <Link
        to="/dashboard/products/new"
        className="mt-6 inline-flex h-12 items-center rounded-md bg-ink px-5 text-[15px] font-medium text-[color:var(--chalk)] hover:bg-[color:var(--ink-3)]"
      >
        Add product
      </Link>
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y divide-line border-y border-line" aria-busy>
      {[0, 1, 2].map((i) => (
        <li key={i} className="grid grid-cols-[56px_1fr] items-center gap-4 py-3 sm:grid-cols-[64px_1fr]">
          <div className="aspect-[4/5] w-full animate-pulse rounded-sm bg-sunken" />
          <div className="space-y-2">
            <div className="h-4 w-48 animate-pulse rounded bg-sunken" />
            <div className="h-3 w-28 animate-pulse rounded bg-sunken" />
          </div>
        </li>
      ))}
    </ul>
  );
}
