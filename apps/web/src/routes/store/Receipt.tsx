import type { ReactNode } from "react";
import { RollingNumber } from "../../components/RollingNumber.tsx";

/** The dark ticket: what you pay, line by line, with the total rolling as it changes. */
export function ReceiptCard({ children }: { children: ReactNode }) {
  return (
    <div className="relative rounded-lg bg-ink px-5 pb-5 pt-6 text-[color:var(--chalk)] shadow-[0_18px_40px_-20px_rgb(0_0_0/0.55)]">
      {children}
    </div>
  );
}

export function ReceiptRow({ label, value, muted = false }: { label: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 text-[15px] ${muted ? "opacity-60" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Dashed tear line with notches that punch through to the page behind. */
export function TearLine() {
  return (
    <div className="relative my-3 h-px" aria-hidden>
      <div className="absolute inset-x-3 top-0 border-t border-dashed border-[color:var(--chalk)]/30" />
      <span className="absolute -left-[1.85rem] -top-2 size-4 rounded-full bg-bg" />
      <span className="absolute -right-[1.85rem] -top-2 size-4 rounded-full bg-bg" />
    </div>
  );
}

export function ReceiptTotal({ label = "Total", value }: { label?: string; value: string | null }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <span className="pb-1 text-[15px]">{label}</span>
      {value ? (
        <RollingNumber value={value} className="font-display text-4xl font-extrabold tracking-[-0.03em]" />
      ) : (
        <span className="pb-1 text-sm opacity-60">Choose your area</span>
      )}
    </div>
  );
}
