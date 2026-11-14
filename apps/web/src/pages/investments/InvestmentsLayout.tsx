import { NavLink, Outlet } from "react-router";
import { INVESTMENT_LINKS as SUB_NAV } from "../../lib/navigation.js";
import "./investments.css";
import "./InvestmentsLayout.css";

/**
 * The Investments shell (views design §5): the title, a sub-nav of
 * `NavLink`s over the Phase 3 pages and the outlet. Each page renders its own
 * toolbar (an h2 with its pickers), so the shell carries none. The securities
 * and account pages mount under the same shell without being the active tab.
 */
export function InvestmentsLayout() {
  return (
    <>
      <div className="row space wrap inv-shell-head">
        <h1>Investments</h1>
        <nav className="inv-subnav" aria-label="Investments pages">
          {SUB_NAV.map(([to, label, end]) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </>
  );
}
