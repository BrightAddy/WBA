import { useEffect, type CSSProperties } from "react";
import { Link, Outlet, useLocation, useOutletContext, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatCedis, readableInk, type PublicStore, type StoreTheme } from "@kiosk/shared";
import { api, RequestError } from "../../lib/api.ts";
import { useCart } from "../../lib/cart.ts";
import { BagIcon } from "../../components/icons.tsx";
import { RollingNumber } from "../../components/RollingNumber.tsx";
import { Wordmark } from "../../components/ui.tsx";

export type StoreCtx = { store: PublicStore; slug: string };
export const useStore = () => useOutletContext<StoreCtx>();

/** Each store re-themes through CSS variables; every component reads the semantic tokens. */
function themeStyle(t: StoreTheme): CSSProperties {
  const vars: Record<string, string> = {};
  if (t.accent && /^#[0-9a-f]{6}$/i.test(t.accent)) {
    vars["--store-accent"] = t.accent;
    vars["--store-accent-ink"] = readableInk(t.accent);
  }
  if (typeof t.radius === "number") vars["--store-radius"] = `${Math.max(0, Math.min(28, t.radius))}px`;
  return vars as CSSProperties;
}

export function StoreShell() {
  const { slug: param = "" } = useParams();
  const q = useQuery({
    queryKey: ["store", param.toLowerCase()],
    queryFn: () => api.store(param),
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (q.data) document.title = q.data.name;
    return () => {
      document.title = "Kiosk";
    };
  }, [q.data]);

  if (q.isPending) return <StoreSkeleton />;
  if (q.isError) {
    const missing = q.error instanceof RequestError && q.error.status === 404;
    return (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="max-w-[38ch]">
          <Wordmark />
          <h1 className="mt-8 font-display text-3xl font-extrabold tracking-tight">
            {missing ? "This store isn't open." : "Couldn't load this store."}
          </h1>
          <p className="mt-3 text-muted">
            {missing
              ? "Check the link with the seller, or it may not be live yet."
              : "Check your connection and reload the page."}
          </p>
        </div>
      </div>
    );
  }

  const store = q.data;
  return (
    <div style={themeStyle(store.theme)} className="min-h-dvh bg-bg pb-28">
      {store.preview && (
        <div className="bg-ink px-4 py-2.5 text-center text-sm text-[color:var(--chalk)]">
          Preview. Only you can see this store until it's approved, and ordering is switched off.
        </div>
      )}
      <Outlet context={{ store, slug: store.slug } satisfies StoreCtx} />
      <CartBar slug={store.slug} />
    </div>
  );
}

function StoreSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-8" aria-busy>
      <div className="h-16 w-3/4 max-w-xl animate-pulse rounded-md bg-sunken" />
      <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="aspect-[4/5] animate-pulse rounded-md bg-sunken" />
        ))}
      </div>
    </div>
  );
}

/** Slides up once there's something in the cart. Hidden where the cart itself is on screen. */
function CartBar({ slug }: { slug: string }) {
  const cart = useCart(slug);
  const { pathname } = useLocation();
  const hidden = /\/(cart|order)(\/|$)/.test(pathname);
  const show = cart.count > 0 && !hidden;

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] transition-transform duration-[var(--dur-slow)] ease-[var(--ease-spring)] ${
        show ? "translate-y-0" : "translate-y-[140%]"
      }`}
      aria-hidden={!show}
    >
      <Link
        to={`/${slug}/cart`}
        tabIndex={show ? 0 : -1}
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-ink py-2.5 pl-3 pr-5 text-[color:var(--chalk)] shadow-[0_10px_30px_-8px_rgb(0_0_0/0.5)] transition-transform active:scale-[0.98]"
      >
        <span className="relative grid size-10 place-items-center rounded-full bg-accent text-accent-fg">
          <BagIcon />
          <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full bg-[color:var(--chalk)] px-1 text-[11px] font-bold leading-5 text-ink">
            {cart.count}
          </span>
        </span>
        <span className="font-medium">View cart</span>
        <RollingNumber value={formatCedis(cart.subtotalPesewas)} className="ml-auto text-lg font-semibold" />
      </Link>
    </div>
  );
}
