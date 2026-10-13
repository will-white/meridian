import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout.js";
import { useAuthStatus } from "./lib/auth.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { LoginPage, SetupPage, TotpEnrollPage, TotpVerifyPage } from "./pages/AuthPages.js";
import { CashFlowPage } from "./pages/CashFlowPage.js";
import { ConnectionsPage } from "./pages/ConnectionsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { GoalsPage } from "./pages/GoalsPage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { PlanPage } from "./pages/PlanPage.js";
import { RecurringPage } from "./pages/RecurringPage.js";
import { RulesPage } from "./pages/RulesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SubscriptionsPage } from "./pages/SubscriptionsPage.js";
import { TransactionsPage } from "./pages/TransactionsPage.js";

export function App() {
  const status = useAuthStatus();
  if (status.isLoading) return <div className="auth-frame muted">Loading…</div>;
  if (status.isError || !status.data) return <div className="auth-frame error">The API is unreachable. Is the server running?</div>;
  const s = status.data;
  if (s.setupRequired) return <SetupPage />;
  if (s.totpRequired) return <TotpVerifyPage status={s} />;
  if (!s.authenticated) return <LoginPage />;
  if (!s.totpEnrolled) return <TotpEnrollPage status={s} />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/recurring" element={<RecurringPage />} />
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/cashflow" element={<CashFlowPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
