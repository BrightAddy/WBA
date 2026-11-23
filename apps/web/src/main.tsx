import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { useMe } from "./lib/session.ts";
import { Login } from "./routes/Login.tsx";
import { Onboarding } from "./routes/Onboarding.tsx";
import { Dashboard } from "./routes/Dashboard.tsx";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** Single place that decides where a visitor belongs: login, onboarding or dashboard. */
function Gate() {
  const me = useMe();
  const { pathname } = useLocation();

  if (me.isPending) return <div className="min-h-dvh" aria-busy />;
  if (me.isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <p className="max-w-[40ch] text-muted">We couldn't reach the server. Check your connection and reload.</p>
      </div>
    );
  }

  const data = me.data;
  const target = !data ? "/login" : !data.seller ? "/onboarding" : "/dashboard";
  if (pathname !== target) return <Navigate to={target} replace />;

  if (target === "/dashboard") return <Dashboard me={data!} />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      { path: "/", element: null },
      { path: "/login", element: <Login /> },
      { path: "/onboarding", element: <Onboarding /> },
      { path: "/dashboard", element: null },
      { path: "*", element: null },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
