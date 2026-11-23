import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCedis, formatGhanaPhone, type SellerOrderDto } from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { Button } from "../../components/ui.tsx";
import { Page } from "./Layout.tsx";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending_payment: { label: "Waiting for payment", tone: "bg-gold/40" },
  paid: { label: "Paid", tone: "bg-lime/60" },
  preparing: { label: "Preparing", tone: "bg-lime/60" },
  out_for_delivery: { label: "Out for delivery", tone: "bg-lime/60" },
  delivered: { label: "Delivered", tone: "bg-sunken" },
  completed: { label: "Completed", tone: "bg-sunken" },
  cancelled: { label: "Cancelled", tone: "bg-sunken text-faint" },
  refunded: { label: "Refunded", tone: "bg-sunken text-faint" },
};

const when = new Intl.DateTimeFormat("en-GH", { dateStyle: "medium", timeStyle: "short" });

export function Orders() {
  const orders = useQuery({ queryKey: ["orders"], queryFn: api.sellerOrders, refetchInterval: 30_000 });

  return (
    <Page title="Orders" width="max-w-3xl">
      {orders.isPending ? (
        <div className="h-40 animate-pulse rounded-md bg-sunken" aria-busy />
      ) : orders.isError ? (
        <p className="text-muted">Couldn't load your orders. Check your connection and reload.</p>
      ) : orders.data.length === 0 ? (
        <p className="max-w-[44ch] text-muted">
          No orders yet. When a customer checks out on your store, the order shows up here and you get a WhatsApp message.
        </p>
      ) : (
        <ul className="space-y-4">
          {orders.data.map((o) => (
            <OrderCard key={o.id} order={o} />
          ))}
        </ul>
      )}
    </Page>
  );
}

function OrderCard({ order: o }: { order: SellerOrderDto }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(o.id),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
  const status = STATUS[o.status] ?? { label: o.status, tone: "bg-sunken" };

  return (
    <li className="rounded-lg border border-line-strong bg-raised p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-display text-xl font-extrabold tracking-tight">{o.code}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        <span className="ml-auto text-sm text-muted">{when.format(new Date(o.createdAt))}</span>
      </div>

      <ul className="mt-4 space-y-1 text-[15px]">
        {o.items.map((i, n) => (
          <li key={n} className="flex justify-between gap-4">
            <span className="min-w-0 truncate">
              {i.quantity} × {i.title}
              {i.label && i.label !== "Standard" ? <span className="text-muted"> · {i.label}</span> : null}
            </span>
            <span className="tabular-nums text-muted">{formatCedis(i.lineTotalPesewas)}</span>
          </li>
        ))}
        <li className="flex justify-between gap-4 text-muted">
          <span>{o.fulfilment === "pickup" ? "Pickup" : `Delivery · ${o.zoneName ?? ""}`}</span>
          <span className="tabular-nums">{o.deliveryFeePesewas === 0 ? "Free" : formatCedis(o.deliveryFeePesewas)}</span>
        </li>
        <li className="flex justify-between gap-4 border-t border-line pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatCedis(o.totalPesewas)}</span>
        </li>
      </ul>

      <dl className="mt-4 grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
        <dt className="text-muted">Customer</dt>
        <dd>
          {o.customerName},{" "}
          <a className="underline underline-offset-4" href={`https://wa.me/${o.customerPhone.replace("+", "")}`} target="_blank" rel="noopener noreferrer">
            {formatGhanaPhone(o.customerPhone)}
          </a>
        </dd>
        {o.fulfilment === "delivery" && (
          <>
            <dt className="text-muted">Deliver to</dt>
            <dd>
              {o.addressText}
              {o.landmark ? `, near ${o.landmark}` : ""}
            </dd>
          </>
        )}
        {o.note && (
          <>
            <dt className="text-muted">Note</dt>
            <dd>{o.note}</dd>
          </>
        )}
      </dl>

      {o.status === "pending_payment" && (
        <div className="mt-5 border-t border-line pt-4">
          {confirming ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted">Cancel this order and put the items back in stock?</span>
              <Button variant="secondary" className="!h-10" busy={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel order
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              {cancel.error instanceof RequestError && <span className="w-full text-sm text-danger">{cancel.error.message}</span>}
            </div>
          ) : (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              Cancel order
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
