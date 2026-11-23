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
import { Orders } from "./routes/dashboard/Orders.tsx";
import { AdminLayout } from "./routes/admin/Layout.tsx";
import { Review } from "./routes/admin/Review.tsx";
import { StoreShell } from "./routes/store/StoreShell.tsx";
import { StoreHome } from "./routes/store/StoreHome.tsx";
import { ProductPage } from "./routes/store/ProductPage.tsx";
import { CartPage } from "./routes/store/CartPage.tsx";
import { OrderPlaced } from "./routes/store/OrderPlaced.tsx";

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
  // Admins can always open /admin; one without a store of their own lands there.
  const isAdmin = data?.account.role === "admin";
  const area = !data
    ? "/login"
    : isAdmin && (pathname.startsWith("/admin") || !data.seller)
      ? "/admin"
      : !data.seller
        ? "/onboarding"
        : "/dashboard";
  const inArea = pathname === area || pathname.startsWith(`${area}/`);
  if (!inArea) return <Navigate to={area} replace />;

  if (area === "/admin") return <AdminLayout me={data!} />;
  if (area === "/dashboard") return <DashboardLayout me={data as SellerMe} />;
  return <Outlet />;
}

const router = createBrowserRouter([
  // Public storefronts live at the root: kiosk.app/<slug>. Static app routes below
  // outrank "/:slug", and RESERVED_SLUGS keeps stores from taking those names.
  {
    path: "/:slug",
    element: <StoreShell />,
    children: [
      { index: true, element: <StoreHome /> },
      { path: "p/:id", element: <ProductPage /> },
      { path: "cart", element: <CartPage /> },
      { path: "order/:code", element: <OrderPlaced /> },
    ],
  },
  {
    element: <Gate />,
    children: [
      { path: "/login", element: <Login /> },
      { path: "/onboarding", element: <Onboarding /> },
      { path: "/admin", children: [{ index: true, element: <Review /> }, { path: "*", element: <Navigate to="/admin" replace /> }] },
      {
        path: "/dashboard",
        children: [
          { index: true, element: <Home /> },
          { path: "products", element: <Products /> },
          { path: "products/new", element: <ProductEditor /> },
          { path: "products/:id", element: <ProductEditor /> },
          { path: "orders", element: <Orders /> },
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
