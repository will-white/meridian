import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout.js";
import { useAuthStatus } from "./lib/auth.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { LoginPage, SetupPage, TotpEnrollPage, TotpVerifyPage } from "./pages/AuthPages.js";
import { ConnectionsPage } from "./pages/ConnectionsPage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { RulesPage } from "./pages/RulesPage.js";
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
        <Route index element={<Navigate to="/transactions" replace />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="*" element={<Navigate to="/transactions" replace />} />
      </Route>
    </Routes>
  );
}
