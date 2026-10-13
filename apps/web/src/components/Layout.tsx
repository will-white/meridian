import { NavLink, Outlet } from "react-router";
import { useAuthStatus, useLogout } from "../lib/auth.js";

const links = [
  ["/transactions", "Transactions"],
  ["/accounts", "Accounts"],
  ["/connections", "Connections"],
  ["/rules", "Rules"],
  ["/import", "Import CSV"],
] as const;

export function Layout() {
  const status = useAuthStatus();
  const logout = useLogout();
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Meridian</div>
        <ul>
          {links.map(([to, label]) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <span className="muted">{status.data?.username}</span>
          <button className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
