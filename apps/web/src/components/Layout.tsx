import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { NETWORK_ERROR_MESSAGE } from "../lib/api.js";
import { useAuthStatus, useLogout } from "../lib/auth.js";
import { NAV_LINKS, pageTitle, revealInside } from "../lib/navigation.js";
import { useAppUpdate } from "../lib/swUpdate.js";
import { useDocumentTitle } from "../lib/useDocumentTitle.js";
import { ErrorBoundary, PageError } from "./ErrorBoundary.js";

/**
 * The signed-in shell: a skip link, the labelled main navigation (a sidebar on a desktop, a compact
 * bar with a scrolling link strip on a phone), and the main region. The routed page sits in an
 * error boundary keyed on the path (b8-web-layout-08). Two notices sit above the page: the last
 * auth status refetch failed (the app keeps the last known status and retries, b8-web-layout-01),
 * and a new build is ready (b8-web-layout-09).
 */
export function Layout() {
  const status = useAuthStatus();
  const logout = useLogout();
  const update = useAppUpdate();
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const linksRef = useRef<HTMLUListElement>(null);
  useDocumentTitle(pageTitle(pathname));
  useEffect(() => {
    // The phone's strip scrolls sideways and a short desktop window scrolls the sidebar: bring the
    // active link into view there, never by scrolling the page (b8-web-layout-11).
    const active = linksRef.current?.querySelector("a.active");
    revealInside(linksRef.current, active);
    revealInside(navRef.current, active);
  }, [pathname]);
  const unreachable = status.isError && status.data !== undefined;
  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("content")?.focus();
        }}
      >
        Skip to content
      </a>
      <nav className="nav" aria-label="Main" ref={navRef}>
        <div className="brand">Meridian</div>
        <ul ref={linksRef}>
          {NAV_LINKS.map(([to, label]) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <span className="muted nav-user">{status.data?.username}</span>
          <button className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="content" id="content" tabIndex={-1}>
        {unreachable && (
          <p className="shell-notice warn" role="status">
            {status.error instanceof Error ? status.error.message : NETWORK_ERROR_MESSAGE}
          </p>
        )}
        {update.ready && (
          <p className="shell-notice" role="status">
            A new version of Meridian is ready.{" "}
            <button type="button" className="link" onClick={update.apply}>
              Reload to use it
            </button>
          </p>
        )}
        <ErrorBoundary resetKey={pathname} fallback={(error, reset) => <PageError error={error} onRetry={reset} />}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
