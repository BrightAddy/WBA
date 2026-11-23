import { Link, Outlet, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatGhanaPhone, type MeResponse } from "@kiosk/shared";
import { api } from "../../lib/api.ts";
import { meKey } from "../../lib/session.ts";
import { Button, Wordmark } from "../../components/ui.tsx";

export function AdminLayout({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function signOut() {
    await api.logout().catch(() => {});
    qc.setQueryData(meKey, null);
    navigate("/login", { replace: true });
  }
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-5 px-5 sm:px-8">
          <Wordmark />
          <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-medium text-[color:var(--chalk)]">Admin</span>
          <div className="ml-auto flex items-center gap-5 text-sm">
            {me.seller && (
              <Link to="/dashboard" className="text-muted hover:text-fg">
                My store
              </Link>
            )}
            <span className="hidden text-muted md:inline">{formatGhanaPhone(me.account.phone)}</span>
            <Button variant="quiet" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <Outlet context={me} />
    </div>
  );
}
