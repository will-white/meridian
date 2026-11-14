/** The shell's navigation, in sidebar order. */
export const NAV_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/dashboard", "Dashboard"],
  ["/plan", "Plan"],
  ["/transactions", "Transactions"],
  ["/accounts", "Accounts"],
  ["/investments", "Investments"],
  ["/goals", "Goals"],
  ["/recurring", "Recurring"],
  ["/subscriptions", "Subscriptions"],
  ["/cashflow", "Cash flow"],
  ["/alerts", "Alerts"],
  ["/rules", "Rules"],
  ["/payees", "Payees"],
  ["/connections", "Connections"],
  ["/import", "Import CSV"],
  ["/settings", "Settings"],
];

/** The Investments sub-pages: path, label, and whether the link is active on its exact path only. */
export const INVESTMENT_LINKS: ReadonlyArray<readonly [string, string, boolean]> = [
  ["/investments", "Portfolio", true],
  ["/investments/allocation", "Allocation", false],
  ["/investments/holdings", "Holdings", false],
  ["/investments/performance", "Performance", false],
  ["/investments/income", "Income", false],
  ["/investments/prices", "Prices", false],
  ["/investments/reconcile", "Reconcile", false],
  ["/investments/securities", "Securities", false],
];

const APP = "Meridian";

/**
 * The document title of a route, "Transactions · Meridian" (audit b8-web-layout-14): the browser
 * tab, the history list and a screen reader's page announcement tell the pages apart.
 */
export function pageTitle(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/investments" || path.startsWith("/investments/")) {
    if (path.startsWith("/investments/accounts/")) return `Account · Investments · ${APP}`;
    const sub = INVESTMENT_LINKS.find(([to]) => to === path);
    return sub ? `${sub[1]} · Investments · ${APP}` : `Investments · ${APP}`;
  }
  const link = NAV_LINKS.find(([to]) => to === path);
  return link ? `${link[1]} · ${APP}` : APP;
}

/**
 * How far to scroll a container on one axis so an item inside it is in view (0 when it is):
 * `viewStart`/`viewEnd` are the container's edges and `itemStart`/`itemEnd` the item's, in the
 * same coordinates. Used to bring the active link into the phone's link strip (audit
 * b8-web-layout-11) and into a sidebar shorter than its links, without scrolling the page.
 */
export function revealOffset(viewStart: number, viewEnd: number, itemStart: number, itemEnd: number, padding = 8): number {
  if (itemStart < viewStart) return itemStart - viewStart - padding;
  if (itemEnd > viewEnd) return itemEnd - viewEnd + padding;
  return 0;
}

/** Scroll `container` itself (never the page) so `item` is in view, on each axis it scrolls on. */
export function revealInside(container: HTMLElement | null, item: Element | null | undefined): void {
  if (!container || !item) return;
  const view = container.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (container.scrollWidth > container.clientWidth) container.scrollLeft += revealOffset(view.left, view.right, rect.left, rect.right);
  if (container.scrollHeight > container.clientHeight) container.scrollTop += revealOffset(view.top, view.bottom, rect.top, rect.bottom);
}
