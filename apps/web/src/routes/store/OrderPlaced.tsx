import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { formatCedis, formatGhanaPhone, type PlacedOrder } from "@kiosk/shared";
import { ReceiptCard, ReceiptRow, ReceiptTotal, TearLine } from "./Receipt.tsx";
import { useStore } from "./StoreShell.tsx";

/**
 * Shown from what the server returned at checkout, kept in sessionStorage.
 * There's deliberately no public lookup by code: an order holds a name and an address.
 */
export function OrderPlaced() {
  const { store, slug } = useStore();
  const { code = "" } = useParams();
  const order = useMemo<PlacedOrder | null>(() => {
    try {
      const raw = sessionStorage.getItem(`kiosk.order.${code}`);
      return raw ? (JSON.parse(raw) as PlacedOrder) : null;
    } catch {
      return null;
    }
  }, [code]);

  return (
    <main className="mx-auto max-w-lg px-4 py-12 sm:px-8 sm:py-20">
      <p className="font-display text-sm font-bold tracking-tight text-muted">Order placed</p>
      <h1 className="mt-1 font-display text-[clamp(3rem,16vw,5.5rem)] font-extrabold leading-none tracking-[-0.05em]">{code}</h1>
      <p className="mt-5 max-w-[42ch] text-lg text-muted text-pretty">
        {store.name} has your order and will message you on WhatsApp to confirm. Keep this code handy.
      </p>

      {order && (
        <div className="mt-10">
          <ReceiptCard>
            <ul className="space-y-2.5 pb-1">
              {order.items.map((i, n) => (
                <li key={n} className="flex items-baseline justify-between gap-4 text-[15px]">
                  <span className="min-w-0">
                    <span className="block truncate">
                      {i.quantity > 1 && <span className="tabular-nums opacity-60">{i.quantity} × </span>}
                      {i.title}
                    </span>
                    {i.label && i.label !== "Standard" && <span className="text-sm opacity-60">{i.label}</span>}
                  </span>
                  <span className="tabular-nums">{formatCedis(i.lineTotalPesewas)}</span>
                </li>
              ))}
            </ul>
            <TearLine />
            <ReceiptRow label="Items" value={formatCedis(order.subtotalPesewas)} />
            <ReceiptRow
              label={order.fulfilment === "pickup" ? "Pickup" : `Delivery · ${order.zoneName ?? ""}`}
              value={order.deliveryFeePesewas === 0 ? "Free" : formatCedis(order.deliveryFeePesewas)}
            />
            <TearLine />
            <ReceiptTotal value={formatCedis(order.totalPesewas)} />
          </ReceiptCard>
          <p className="mt-5 text-sm text-muted">
            For {order.customerName}, {formatGhanaPhone(order.customerPhone)}.
          </p>
        </div>
      )}

      <Link to={`/${slug}`} className="mt-10 inline-flex h-12 items-center rounded-md border border-line-strong bg-raised px-6 hover:border-fg">
        Back to {store.name}
      </Link>
    </main>
  );
}
