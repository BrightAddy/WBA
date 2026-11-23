import type { ReactNode } from "react";
import { Wordmark } from "../components/ui.tsx";

/** Narrow, left-aligned column. On wide screens the right side is left to `aside`. */
export function AuthShell({
  title,
  lede,
  children,
  aside,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mx-auto grid min-h-dvh max-w-6xl grid-rows-[auto_1fr] px-5 sm:px-8">
      <header className="flex h-16 items-center">
        <Wordmark />
      </header>
      <main
        className={`grid items-start gap-10 pb-16 pt-6 sm:pt-14 ${aside ? "lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:gap-20" : ""}`}
      >
        <section className="w-full max-w-[420px]">
          <h1 className="font-display text-[2.5rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-5xl">{title}</h1>
          {lede && <p className="mt-3 max-w-[38ch] text-muted">{lede}</p>}
          <div className="mt-8">{children}</div>
        </section>
        {aside}
      </main>
    </div>
  );
}
