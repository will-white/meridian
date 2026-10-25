import { NavLink, Outlet } from "react-router";
import "./investments.css";
import "./InvestmentsLayout.css";

const SUB_NAV: ReadonlyArray<readonly [string, string, boolean]> = [
  ["/investments", "Portfolio", true],
  ["/investments/allocation", "Allocation", false],
  ["/investments/holdings", "Holdings", false],
  ["/investments/performance", "Performance", false],
  ["/investments/income", "Income", false],
  ["/investments/prices", "Prices", false],
  ["/investments/reconcile", "Reconcile", false],
  ["/investments/securities", "Securities", false],
];

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
