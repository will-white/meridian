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
import { PayeesPage } from "./pages/PayeesPage.js";
import { RulesPage } from "./pages/RulesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SubscriptionsPage } from "./pages/SubscriptionsPage.js";
import { TransactionsPage } from "./pages/TransactionsPage.js";
import { AccountInvestmentsPage } from "./pages/investments/AccountInvestmentsPage.js";
import { AllocationPage } from "./pages/investments/AllocationPage.js";
import { HoldingsPage } from "./pages/investments/HoldingsPage.js";
import { IncomePage } from "./pages/investments/IncomePage.js";
import { InvestmentsLayout } from "./pages/investments/InvestmentsLayout.js";
import { PerformancePage } from "./pages/investments/PerformancePage.js";
import { PortfolioPage } from "./pages/investments/PortfolioPage.js";
import { PricesPage } from "./pages/investments/PricesPage.js";
import { RealizedPage } from "./pages/investments/RealizedPage.js";
import { ReconcilePage } from "./pages/investments/ReconcilePage.js";
import { SecuritiesPage } from "./pages/investments/SecuritiesPage.js";

/**
 * The auth status decides the screen. Once a status was loaded it is what renders, also while a
 * refetch fails (TanStack Query keeps the data and reports the error): one dropped request or a
 * proxy restart must not replace the open page and what is typed in it (audit b8-web-layout-01;
 * only a 401, which refreshes the status, brings the sign-in screen back). The full-screen message
 * is for a first load that got no status at all.
 */
export function App() {
  const status = useAuthStatus();
  if (!status.data) {
    if (!status.isError) return <main className="auth-frame muted">Loading…</main>;
    return (
      <main className="auth-frame">
        <div className="auth-card" role="alert">
          <div className="brand big">Meridian</div>
          <p className="error">The API is unreachable. Is the server running?</p>
          <button type="button" onClick={() => void status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? "Trying…" : "Try again"}
          </button>
        </div>
      </main>
    );
  }
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
        <Route path="/payees" element={<PayeesPage />} />
        <Route path="/import" element={<ImportPage />} />
        {/* Phase 3: the Investments shell with its sub-pages (views design §5); securities and the per-account page mount under it. */}
        <Route path="/investments" element={<InvestmentsLayout />}>
          <Route index element={<PortfolioPage />} />
          <Route path="allocation" element={<AllocationPage />} />
          <Route path="holdings" element={<HoldingsPage />} />
          <Route path="performance" element={<PerformancePage />} />
          <Route path="realized" element={<RealizedPage />} />
          <Route path="income" element={<IncomePage />} />
          <Route path="prices" element={<PricesPage />} />
          <Route path="reconcile" element={<ReconcilePage />} />
          <Route path="securities" element={<SecuritiesPage />} />
          <Route path="accounts/:id" element={<AccountInvestmentsPage />} />
        </Route>
        <Route path="/prices" element={<Navigate to="/investments/prices" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
