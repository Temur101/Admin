import { createBrowserRouter, Navigate, Outlet, useRouteError } from "react-router-dom";
import { useAuth } from "./context/AuthContext.js";
import { AdminLayout } from "./components/layout/AdminLayout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { TenantsPage } from "./pages/TenantsPage.js";
import { BotsPage } from "./pages/BotsPage.js";
import { BotDetailsPage } from "./pages/BotDetailsPage.js";
import { ReceiptsPage } from "./pages/ReceiptsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { Loader2, AlertCircle } from "lucide-react";

function RootErrorBoundary() {
  const error = useRouteError() as Error | undefined;
  return (
    <div className="min-h-screen bg-ui-subtle flex flex-col items-center justify-center p-6 text-center">
      <div className="bg-ui-surface border border-ui-border rounded-3xl p-8 max-w-md w-full shadow-2xl space-y-4">
        <div className="inline-flex h-12 w-12 rounded-2xl bg-ui-danger-soft text-ui-danger items-center justify-center mx-auto">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-bold text-ui-text">Ошибка отображения</h2>
        <p className="text-sm text-ui-muted">
          {error?.message || "Произошла непредвиденная ошибка в интерфейсе."}
        </p>
        <button
          onClick={() => (window.location.href = "/dashboard")}
          className="w-full py-2.5 px-4 bg-ui-accent hover:bg-ui-accent-hover text-ui-on-accent font-medium rounded-xl text-sm transition-colors cursor-pointer"
        >
          Вернуться на дашборд
        </button>
      </div>
    </div>
  );
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-ui-page flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-ui-accent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-ui-page flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-ui-accent" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <PublicRoute />,
    errorElement: <RootErrorBoundary />,
    children: [
      {
        path: "/login",
        element: <LoginPage />,
      },
    ],
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RootErrorBoundary />,
    children: [
      {
        element: <AdminLayout />,
        children: [
          {
            path: "/",
            element: <Navigate to="/dashboard" replace />,
          },
          {
            path: "/dashboard",
            element: <DashboardPage />,
          },
          {
            path: "/tenants",
            element: <TenantsPage />,
          },
          {
            path: "/bots",
            element: <BotsPage />,
          },
          {
            path: "/bots/:id",
            element: <BotDetailsPage />,
          },
          {
            path: "/receipts",
            element: <ReceiptsPage />,
          },
          {
            path: "/settings",
            element: <SettingsPage />,
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/dashboard" replace />,
  },
]);
