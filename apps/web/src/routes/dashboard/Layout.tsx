import { NavLink, Outlet, useNavigate, useOutletContext } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatGhanaPhone, type MeResponse } from "@kiosk/shared";
import { api } from "../../lib/api.ts";
import { meKey } from "../../lib/session.ts";
import { Button, Wordmark } from "../../components/ui.tsx";

export type SellerMe = MeResponse & { seller: NonNullable<MeResponse["seller"]> };
export const useSellerMe = () => useOutletContext<SellerMe>();

const NAV = [
  { to: "/dashboard", label: "Home", end: true },
  { to: "/dashboard/products", label: "Products", end: false },
  { to: "/dashboard/delivery", label: "Delivery", end: false },
];

export function DashboardLayout({ me }: { me: SellerMe }) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await api.logout().catch(() => {});
    qc.setQueryData(meKey, null);
    navigate("/login", { replace: true });
  }

  const link = ({ isActive }: { isActive: boolean }) =>
    `relative px-1 py-2 text-[15px] transition-colors ${isActive ? "text-fg" : "text-muted hover:text-fg"}`;

  return (
    <div className="min-h-dvh pb-20 sm:pb-0">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-8 px-5 sm:px-8">
          <Wordmark />
          <nav className="hidden gap-6 sm:flex" aria-label="Dashboard">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={link}>
                {({ isActive }) => (
                  <>
                    {n.label}
                    {isActive && <span className="absolute inset-x-1 -bottom-[13px] h-0.5 bg-fg" aria-hidden />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-5 text-sm">
            <span className="hidden text-muted md:inline">{formatGhanaPhone(me.account.phone)}</span>
            <Button variant="quiet" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <Outlet context={me} />

      {/* Thumb-reach navigation on phones */}
      <nav
        aria-label="Dashboard"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex h-14 items-center justify-center text-sm font-medium ${isActive ? "text-fg" : "text-faint"}`
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Shared page frame: title row with an optional action. */
export function Page({
  title,
  action,
  children,
  width = "max-w-5xl",
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <main className={`mx-auto ${width} px-5 pb-24 pt-8 sm:px-8 sm:pt-12`}>
      <div className="mb-8 flex items-end justify-between gap-4">
        <h1 className="font-display text-[2.25rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-[2.75rem]">{title}</h1>
        {action}
      </div>
      {children}
    </main>
  );
}
