import { useMemo, useState } from "react";
import { Link } from "react-router";
import { formatCedis, type PublicProductCard } from "@kiosk/shared";
import { Thumb } from "../../components/Thumb.tsx";
import { Pin, Search, Truck } from "../../components/icons.tsx";
import { useStore } from "./StoreShell.tsx";

const SEARCH_FROM = 12;

const WhatsAppMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12.04 2a9.9 9.9 0 0 0-8.43 15.1L2 22l5.04-1.55A9.9 9.9 0 1 0 12.04 2Zm0 1.8a8.1 8.1 0 1 1-4.3 14.96l-.3-.19-2.99.92.96-2.92-.2-.31A8.1 8.1 0 0 1 12.04 3.8Zm-3 3.9c-.2 0-.52.07-.8.37-.27.3-1.03 1-1.03 2.45 0 1.44 1.05 2.84 1.2 3.04.15.2 2.04 3.25 5.03 4.42 2.48.97 2.98.78 3.52.73.54-.05 1.74-.7 1.98-1.4.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35-.3-.15-1.74-.86-2.01-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57Z" />
  </svg>
);

export function StoreHome() {
  const { store, slug } = useStore();
  const [category, setCategory] = useState<string>("All");
  const [term, setTerm] = useState("");

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return store.products.filter(
      (p) => (category === "All" || p.category === category) && (!t || p.title.toLowerCase().includes(t)),
    );
  }, [store.products, category, term]);

  const { zones, settings } = store.delivery;
  const facts: { icon: typeof Truck; text: string }[] = [];
  if (zones.length) {
    const names = zones.slice(0, 3).map((z) => z.name).join(", ");
    facts.push({ icon: Truck, text: `Delivers to ${names}${zones.length > 3 ? ` and ${zones.length - 3} more` : ""}` });
  }
  if (settings.pickupEnabled) facts.push({ icon: Pin, text: "Pickup available" });
  if (settings.freeDeliveryOverPesewas) {
    facts.push({ icon: Truck, text: `Free delivery over ${formatCedis(settings.freeDeliveryOverPesewas)}` });
  }

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-8">
      <header className="pb-8 pt-8 sm:pt-14">
        {/* The loud element: the store's own name, as large as the screen allows. */}
        <h1 className="font-display text-[clamp(2.5rem,12.5vw,6.75rem)] font-extrabold leading-[0.9] tracking-[-0.045em] text-balance [overflow-wrap:anywhere]">
          {store.name}
          <span className="text-accent">.</span>
        </h1>
        {store.bio && <p className="mt-5 max-w-[52ch] text-lg text-muted text-pretty">{store.bio}</p>}

        {store.whatsappUrl && !store.preview && (
          <a
            href={store.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex h-11 items-center gap-2.5 rounded-full border border-line-strong bg-raised px-5 text-sm font-medium transition-colors hover:border-fg active:scale-[0.98]"
          >
            <WhatsAppMark />
            Ask on WhatsApp
          </a>
        )}

        {(facts.length > 0 || store.instagramUrl || store.tiktokUrl) && (
          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            {facts.map((f) => (
              <li key={f.text} className="flex items-center gap-2">
                <f.icon width={17} height={17} />
                {f.text}
              </li>
            ))}
            {store.instagramUrl && (
              <li>
                <a className="underline underline-offset-4 hover:text-fg" href={store.instagramUrl} target="_blank" rel="noopener noreferrer">
                  Instagram
                </a>
              </li>
            )}
            {store.tiktokUrl && (
              <li>
                <a className="underline underline-offset-4 hover:text-fg" href={store.tiktokUrl} target="_blank" rel="noopener noreferrer">
                  TikTok
                </a>
              </li>
            )}
          </ul>
        )}
      </header>

      {store.products.length > 0 && (
        <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-y border-line bg-bg/92 px-4 py-3 backdrop-blur-sm sm:-mx-8 sm:px-8">
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Categories">
            {["All", ...store.categories].map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={category === c}
                onClick={() => setCategory(c)}
                className={`h-10 shrink-0 rounded-full border px-4 text-sm transition-colors ${
                  category === c ? "border-ink bg-ink text-[color:var(--chalk)]" : "border-line-strong text-muted hover:text-fg"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          {store.products.length > SEARCH_FROM && (
            <label className="flex h-10 w-36 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-raised px-3 focus-within:border-fg sm:w-52">
              <Search width={16} height={16} className="text-faint" />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search"
                aria-label="Search this store"
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-faint"
              />
            </label>
          )}
        </div>
      )}

      {store.products.length === 0 ? (
        <p className="py-24 text-center text-muted">Nothing here yet. Check back soon.</p>
      ) : shown.length === 0 ? (
        <p className="py-24 text-center text-muted">No items match that.</p>
      ) : (
        <ul
          className={`grid gap-x-3 gap-y-8 py-6 sm:gap-x-5 ${
            store.theme.layout === "feed" ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
          }`}
        >
          {shown.map((p, i) => (
            <Card key={p.id} p={p} slug={slug} priority={i < 4} />
          ))}
        </ul>
      )}

      <footer className="border-t border-line py-8 text-sm text-faint">
        Sold by {store.name}. Storefront by <span className="font-display font-bold text-muted">kiosk</span>.
      </footer>
    </main>
  );
}

function Card({ p, slug, priority }: { p: PublicProductCard; slug: string; priority: boolean }) {
  return (
    <li>
      <Link to={`/${slug}/p/${p.id}`} className="group block">
        <div className="relative overflow-hidden rounded-md">
          {p.cover ? (
            <Thumb
              image={p.cover}
              sizes="(min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw"
              alt={p.title}
              eager={priority}
              className={`aspect-[4/5] transition-transform duration-500 ease-[var(--ease-out)] group-hover:scale-[1.03] ${p.soldOut ? "opacity-60" : ""}`}
            />
          ) : (
            <div className="aspect-[4/5] bg-sunken" />
          )}
          {p.soldOut && (
            <span className="absolute left-2 top-2 rounded-full bg-ink px-2.5 py-1 text-xs font-medium text-[color:var(--chalk)]">
              Sold out
            </span>
          )}
        </div>
        <h2 className="mt-2.5 truncate text-[15px] font-medium">{p.title}</h2>
        <p className="mt-0.5 flex items-baseline gap-2 text-[15px]">
          <span className="tabular-nums">
            {p.fromPrice && <span className="text-muted">From </span>}
            {formatCedis(p.pricePesewas)}
          </span>
          {p.compareAtPesewas && <s className="text-sm text-faint tabular-nums">{formatCedis(p.compareAtPesewas)}</s>}
        </p>
      </Link>
    </li>
  );
}
