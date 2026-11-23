import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { useMe } from "./lib/session.ts";
import { Login } from "./routes/Login.tsx";
import { Onboarding } from "./routes/Onboarding.tsx";
import { DashboardLayout, type SellerMe } from "./routes/dashboard/Layout.tsx";
import { Home } from "./routes/dashboard/Home.tsx";
import { Products } from "./routes/dashboard/Products.tsx";
import { ProductEditor } from "./routes/dashboard/ProductEditor.tsx";
import { Delivery } from "./routes/dashboard/Delivery.tsx";

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
  const area = !data ? "/login" : !data.seller ? "/onboarding" : "/dashboard";
  const inArea = pathname === area || pathname.startsWith(`${area}/`);
  if (!inArea) return <Navigate to={area} replace />;

  if (area === "/dashboard") return <DashboardLayout me={data as SellerMe} />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      { path: "/login", element: <Login /> },
      { path: "/onboarding", element: <Onboarding /> },
      {
        path: "/dashboard",
        children: [
          { index: true, element: <Home /> },
          { path: "products", element: <Products /> },
          { path: "products/new", element: <ProductEditor /> },
          { path: "products/:id", element: <ProductEditor /> },
          { path: "delivery", element: <Delivery /> },
          { path: "*", element: <Navigate to="/dashboard" replace /> },
        ],
      },
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
