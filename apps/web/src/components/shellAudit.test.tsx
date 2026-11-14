import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountView, AuthStatus, CategoryView, ConnectionView, SessionView, TransactionList, TransactionView } from "@meridian/shared";
import { App } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import * as apiModule from "../lib/api.js";
import * as authModule from "../lib/auth.js";
import { AUTH_KEY, SIGNED_OUT_STATUS } from "../lib/auth.js";
import { shortDate } from "../lib/format.js";
import { AccountsPage } from "../pages/AccountsPage.js";
import { LoginPage } from "../pages/AuthPages.js";
import { ConnectionsPage } from "../pages/ConnectionsPage.js";
import { TransactionsPage } from "../pages/TransactionsPage.js";
import { EChart } from "./charts/EChart.js";
import { Layout } from "./Layout.js";

/**
 * Audit batch b8-web-layout (the web app's shell, layout and PWA). What can be decided without a
 * browser engine is tested here: the shell's states, the query client's handling of a session that
 * changes hands, the API client's errors, the rendered landmarks and labels, the date of a
 * timestamp, the service worker's update offer, and the stylesheet rules the layout fixes rest on.
 * The layout itself (widths, heights, scrolling, focus order) is checked in the built app in
 * headless Chromium; those checks are recorded in docs/audit/phases-1-3/b8-web-layout.md.
 */

const OWNER: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" };
const KID: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "kid", role: "viewer" };

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } } });
}

function render(ui: ReactElement, qc: QueryClient, path = "/dashboard"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The text a person reads, tags removed and spaces collapsed. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** A failed refetch of a query that had data: TanStack Query keeps the data and reports the error. */
async function failRefetch(qc: QueryClient, key: readonly unknown[], error: unknown): Promise<void> {
  await qc.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error), retry: false, staleTime: 0 }).catch(() => undefined);
}

const NETWORK = () => new ApiError(0, "Can't reach Meridian.", "network");

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: U(1),
  connectionId: null,
  connectionName: null,
  externalId: null,
  name: "Joint Checking",
  institution: null,
  type: "checking",
  taxTreatment: "none",
  currency: "USD",
  onBudget: true,
  closed: false,
  balanceCents: "123456",
  availableCents: null,
  balanceDate: "2026-11-13",
  transactionCount: 3,
  lowBalanceThresholdCents: null,
  paymentDay: null,
  paymentFromAccountId: null,
  statementDay: null,
  lotMethod: "fifo",
  cashInference: "auto",
  investmentIncomeFeed: "off",
  investment: null,
  ...over,
});

const txn = (n: number, over: Partial<TransactionView> = {}): TransactionView => ({
  id: U(100 + n),
  accountId: U(1),
  accountName: "Everyday Checking with a really long account name",
  date: "2026-11-1" + n,
  amountCents: "-1234",
  payeeId: U(200 + n),
  payeeName: `Payee ${n}`,
  rawDescription: `PAYEE ${n} 1234 DENVER CO`,
  memo: null,
  categoryId: null,
  categoryName: null,
  categoryLocked: false,
  pending: false,
  isTransfer: false,
  transferPairId: null,
  notes: null,
  tags: [],
  source: "manual",
  recurringId: null,
  splits: [],
  transferPartner: null,
  ...over,
});

const CATEGORIES: CategoryView[] = [{ id: U(300), name: "Groceries", bucket: "spending", hidden: false }];

/** The register's query key with no filters set (TransactionsPage builds it from the URL). */
const REGISTER_KEY = ["transactions", { q: "", accountId: "", categoryId: "", goalId: "", recurringId: "", transfers: "include", from: "", to: "", limit: 100 }];

/**
 * Form controls a screen reader announces without a name: no aria-label, aria-labelledby or title,
 * and not inside a <label>. (Static markup: a label's `for` is not used in this app.)
 */
function unnamedControls(html: string): string[] {
  const out: string[] = [];
  let labelDepth = 0;
  for (const m of html.matchAll(/<(\/?)(label|input|select|textarea)\b([^>]*)>/g)) {
    const [, close, tag, attrs] = m;
    if (tag === "label") {
      labelDepth += close ? -1 : 1;
      continue;
    }
    if (close) continue;
    if (/\btype="(hidden|submit|button)"/.test(attrs!)) continue;
    if (labelDepth > 0 || /\b(aria-label|aria-labelledby|title)="[^"]+"/.test(attrs!)) continue;
    out.push(`<${tag}${attrs!.slice(0, 80)}>`);
  }
  return out;
}

// ---- stylesheet rules --------------------------------------------------------------------------

const css = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of an `@media` block, by its exact prelude, e.g. "(max-width: 800px)". */
function mediaBlock(source: string, prelude: string): string {
  const start = source.indexOf(`@media ${prelude}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
  }
  return "";
}

/** Top-level rules (every @media block cut out). */
function topLevel(source: string): string {
  let out = source;
  for (let at = out.indexOf("@media"); at >= 0; at = out.indexOf("@media")) {
    let depth = 0;
    let end = out.indexOf("{", at);
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      else if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}

/** The value of `property` for `selector` in a block of plain rules (the last declaration wins). */
function decl(block: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i > 0 && d.slice(0, i).trim() === property) value = d.slice(i + 1).trim();
    }
  }
  return value;
}

const STYLES = css("../styles.css");

function tokens(block: string): Record<string, string> {
  const root = block.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  return Object.fromEntries([...root.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** `color-mix(in srgb, top p%, bottom)` */
const mix = (top: number[], bottom: number[], p: number): number[] => top.map((v, i) => v * p + bottom[i]! * (1 - p));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---- findings ----------------------------------------------------------------------------------

describe("b8-web-layout-01: a failed background refetch of the auth status keeps the app on screen", () => {
  it("renders the signed-in shell and the open page from the last known status, with a small notice", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    await failRefetch(qc, AUTH_KEY, NETWORK());
    expect(qc.getQueryState(AUTH_KEY)?.status).toBe("error");
    const html = render(<App />, qc, "/accounts");
    expect(text(html)).not.toContain("The API is unreachable");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("<h1>Accounts</h1>");
    expect(text(html)).toContain("Can't reach Meridian");
  });

  it("shows the full-screen message, with a way to try again, only when no status was ever loaded", async () => {
    const qc = client();
    await failRefetch(qc, AUTH_KEY, NETWORK());
    const html = render(<App />, qc, "/accounts");
    expect(text(html)).toContain("The API is unreachable");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).not.toContain('href="/dashboard"');
  });

  it("retries the auth status after a network error or a 5xx, never after a 4xx", () => {
    const retry = authModule.authStatusQuery().retry as (count: number, error: unknown) => boolean;
    expect(retry(0, NETWORK())).toBe(true);
    expect(retry(1, new ApiError(502, "Bad gateway"))).toBe(true);
    expect(retry(2, NETWORK())).toBe(false);
    expect(retry(0, new ApiError(401, "Sign in required", "unauthorized"))).toBe(false);
    expect(retry(0, new ApiError(429, "Too many", "rate_limited"))).toBe(false);
  });
});

describe("b8-web-layout-02: what was loaded for one member is never shown to the next", () => {
  const ownerSessions: SessionView[] = [
    { id: "s-phone", createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-13T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z", current: false, ip: "127.0.0.1", userAgent: "FxiOS/120.0 iPhone" },
  ];

  it("an expired session (a 401 on any request) forgets the member's data once the status says signed out", async () => {
    const { createQueryClient } = await import("../lib/queryClient.js");
    const qc = createQueryClient();
    let server: AuthStatus = OWNER;
    const app = new QueryObserver<AuthStatus>(qc, { queryKey: AUTH_KEY, queryFn: async () => server, staleTime: 30_000, retry: false });
    const unsubscribe = app.subscribe(() => undefined);
    await vi.waitFor(() => expect(app.getCurrentResult().data).toEqual(OWNER));
    qc.setQueryData(["auth", "sessions"], ownerSessions);
    qc.setQueryData(["auth", "activity"], { events: [{ username: "owner" }] });
    qc.setQueryData(["accounts"], [account()]);

    server = SIGNED_OUT_STATUS; // the session's lifetime ran out on the server
    await qc.fetchQuery({ queryKey: ["dashboard"], queryFn: () => Promise.reject(new ApiError(401, "Sign in required", "unauthorized")), retry: false }).catch(() => undefined);
    await vi.waitFor(() => expect(app.getCurrentResult().data).toEqual(SIGNED_OUT_STATUS));
    expect(qc.getQueryData(["auth", "sessions"])).toBeUndefined();
    expect(qc.getQueryData(["auth", "activity"])).toBeUndefined();
    expect(qc.getQueryData(["accounts"])).toBeUndefined();
    expect(qc.getQueryCache().find({ queryKey: ["dashboard"] })).toBeUndefined();

    // The viewer signs in on the same tab (useAuthMutation writes the status it gets back).
    qc.setQueryData(AUTH_KEY, KID);
    expect(qc.getQueryData(["auth", "sessions"])).toBeUndefined();
    unsubscribe();
    qc.clear();
  });

  it("a status that names another member (signed in elsewhere in the same browser) resets what is on screen", async () => {
    const { createQueryClient } = await import("../lib/queryClient.js");
    const qc = createQueryClient();
    let server: AuthStatus = OWNER;
    const app = new QueryObserver<AuthStatus>(qc, { queryKey: AUTH_KEY, queryFn: async () => server, staleTime: 30_000, retry: false });
    const unsubscribeApp = app.subscribe(() => undefined);
    await vi.waitFor(() => expect(app.getCurrentResult().data).toEqual(OWNER));
    // The Settings page is open and shows the owner's sessions.
    const page = new QueryObserver<SessionView[]>(qc, { queryKey: ["auth", "sessions"], queryFn: async () => (server.username === "owner" ? ownerSessions : []), retry: false });
    const seen: Array<SessionView[] | undefined> = [];
    const unsubscribePage = page.subscribe((r) => seen.push(r.data));
    await vi.waitFor(() => expect(page.getCurrentResult().data).toEqual(ownerSessions));
    qc.setQueryData(["accounts"], [account()]);

    server = KID;
    await qc.refetchQueries({ queryKey: AUTH_KEY });
    // At once: the open page no longer holds the owner's rows, and nothing else of theirs is cached.
    expect(page.getCurrentResult().data).not.toEqual(ownerSessions);
    expect(qc.getQueryData(["accounts"])).toBeUndefined();
    await vi.waitFor(() => expect(page.getCurrentResult().data).toEqual([]));
    expect(seen.at(-1)).toEqual([]);
    unsubscribePage();
    unsubscribeApp();
    qc.clear();
  });

  it("a refetch of the same member's status, or one that fails, forgets nothing", async () => {
    const { createQueryClient } = await import("../lib/queryClient.js");
    const qc = createQueryClient();
    await qc.fetchQuery({ queryKey: AUTH_KEY, queryFn: async () => OWNER });
    qc.setQueryData(["accounts"], [account()]);
    await qc.fetchQuery({ queryKey: AUTH_KEY, queryFn: async () => ({ ...OWNER }), staleTime: 0 });
    await failRefetch(qc, AUTH_KEY, NETWORK());
    expect(qc.getQueryData(["accounts"])).toEqual([account()]);
    qc.clear();
  });
});

describe("b8-web-layout-03: a timestamp is shown as its local calendar date", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });

  it("an alert created at 00:10 UTC on Nov 14 is Nov 13 in Denver, the day the dashboard calls today", () => {
    process.env.TZ = "America/Denver";
    expect(shortDate("2026-11-14T00:10:16.000Z")).toBe("11/13/26");
    expect(shortDate("2026-11-14T00:10:16+00:00")).toBe("11/13/26");
    process.env.TZ = "Asia/Tokyo";
    expect(shortDate("2026-11-13T20:00:00.000Z")).toBe("11/14/26");
  });

  it("a plain calendar date is never shifted, whatever the zone", () => {
    process.env.TZ = "America/Denver";
    expect(shortDate("2026-11-14")).toBe("11/14/26");
    process.env.TZ = "Pacific/Kiritimati";
    expect(shortDate("2026-01-01")).toBe("01/01/26");
    expect(shortDate(null)).toBe("—");
  });
});

describe("b8-web-layout-04: the register scrolls inside its box on a phone", () => {
  it("the register table is inside a .scroll box", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["accounts"], [account()]);
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(REGISTER_KEY, { pages: [{ items: [txn(1), txn(2)], nextCursor: null } satisfies TransactionList], pageParams: [undefined] });
    const html = render(<TransactionsPage />, qc, "/transactions");
    expect(html).toMatch(/<div class="scroll[^"]*">\s*<table class="table register"/);
  });

  it("at phone width the account name may wrap and the category select shrinks", () => {
    const phone = mediaBlock(STYLES, "(max-width: 800px)");
    expect(decl(phone, ".register .register-account", "white-space")).toBe("normal");
    expect(decl(phone, ".register select", "max-width")).toBeDefined();
  });
});

describe("b8-web-layout-05: the desktop sidebar scrolls on its own when it is taller than the window", () => {
  it(".nav (sticky, 100vh) has overflow-y: auto", () => {
    const top = topLevel(STYLES);
    expect(decl(top, ".nav", "height")).toBe("100vh");
    expect(decl(top, ".nav", "overflow-y")).toBe("auto");
  });
});

describe("b8-web-layout-06: the dashboard chart cannot hold the page wide", () => {
  it("every dashboard grid item may shrink below its content", () => {
    expect(decl(topLevel(css("../pages/DashboardPage.css")), ".dash-grid > *", "min-width")).toBe("0");
  });

  it("the chart wrapper does not take its width from the canvas inside it", () => {
    const html = renderToStaticMarkup(<EChart option={{}} label="Chart" />);
    expect(html).toContain("min-width:0");
    expect(html).toContain("contain:inline-size");
  });
});

describe("b8-web-layout-07: the CSV file pickers are reachable by keyboard and screen reader", () => {
  it("the file input is hidden visually, not removed (no display: none), and its label shows the focus", () => {
    const top = topLevel(STYLES);
    expect(decl(top, "label.file input", "display")).toBeUndefined();
    expect(decl(top, "label.file input", "opacity")).toBe("0");
    expect(decl(top, "label.file input", "position")).toBe("absolute");
    expect(decl(top, "label.file", "position")).toBe("relative");
    expect(decl(top, "label.file:focus-within", "outline")).toMatch(/solid/);
  });
});

describe("b8-web-layout-08: a page that fails to render leaves the shell usable", () => {
  it("the boundary catches the error and shows it with Try again, and a new route clears it", async () => {
    const { ErrorBoundary, PageError } = await import("./ErrorBoundary.js");
    const error = new Error("Cannot read properties of undefined (reading 'points')");
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state.error).toBe(error);
    const props = { resetKey: "/dashboard", fallback: (e: Error, reset: () => void) => <PageError error={e} onRetry={reset} />, children: <p>page</p> };
    const boundary = new ErrorBoundary(props);
    boundary.state = { ...boundary.state, ...state };
    const html = renderToStaticMarkup(<QueryClientProvider client={client()}>{boundary.render()}</QueryClientProvider>);
    expect(text(html)).toContain("reading 'points'");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    // Same route: the error stays; another route: it is cleared.
    expect(ErrorBoundary.getDerivedStateFromProps(props, boundary.state)).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps({ ...props, resetKey: "/accounts" }, boundary.state)).toEqual({ error: null, resetKey: "/accounts" });
  });

  it("the shell wraps the routed page in the boundary, keyed on the path", () => {
    const source = readFileSync(new URL("./Layout.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<ErrorBoundary resetKey=\{pathname\}[\s\S]*<Outlet \/>[\s\S]*<\/ErrorBoundary>/);
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(/<ErrorBoundary[\s\S]*<App \/>[\s\S]*<\/ErrorBoundary>/);
  });
});

describe("b8-web-layout-09: a new build is offered to the open app", () => {
  /** A ServiceWorkerContainer with one registration whose update installs a new worker. */
  function fakeWorkers(controlled: boolean) {
    const container = new EventTarget() as EventTarget & { controller: object | null; register: (url: string) => Promise<unknown> };
    const registration = new EventTarget() as EventTarget & { installing: unknown; waiting: unknown; update: () => Promise<void> };
    const messages: unknown[] = [];
    const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: (m: unknown) => messages.push(m) });
    let updates = 0;
    registration.installing = null;
    registration.waiting = null;
    registration.update = async () => {
      updates++;
    };
    container.controller = controlled ? {} : null;
    container.register = async () => registration;
    const install = () => {
      registration.installing = worker;
      registration.dispatchEvent(new Event("updatefound"));
      worker.state = "installed";
      registration.installing = null;
      registration.waiting = worker;
      worker.dispatchEvent(new Event("statechange"));
    };
    return { container, registration, worker, messages, install, updates: () => updates };
  }

  it("offers the waiting build, activates it on request and reloads once it controls the page", async () => {
    const { watchForUpdates } = await import("../lib/swUpdate.js");
    const w = fakeWorkers(true);
    let offered = 0;
    let reloads = 0;
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const watch = watchForUpdates(w.container as unknown as ServiceWorkerContainer, { onUpdateReady: () => offered++, reload: () => reloads++, doc: doc as unknown as Document, checkEveryMs: 60_000 });
    await watch.registered;
    w.install();
    expect(offered).toBe(1);
    watch.apply();
    expect(w.messages).toEqual([{ type: "SKIP_WAITING" }]);
    expect(reloads).toBe(0);
    w.container.dispatchEvent(new Event("controllerchange"));
    expect(reloads).toBe(1);
    watch.stop();
  });

  it("checks for a new build when the app comes back into view, and on a timer", async () => {
    vi.useFakeTimers();
    try {
      const { watchForUpdates } = await import("../lib/swUpdate.js");
      const w = fakeWorkers(true);
      const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
      const watch = watchForUpdates(w.container as unknown as ServiceWorkerContainer, { onUpdateReady: () => undefined, reload: () => undefined, doc: doc as unknown as Document, checkEveryMs: 60_000 });
      await watch.registered;
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(w.updates()).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(w.updates()).toBe(2);
      watch.stop();
      vi.advanceTimersByTime(60_000);
      expect(w.updates()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the first install (nothing controls the page yet) offers nothing, and a controller change it did not ask for reloads nothing", async () => {
    const { watchForUpdates } = await import("../lib/swUpdate.js");
    const w = fakeWorkers(false);
    let offered = 0;
    let reloads = 0;
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const watch = watchForUpdates(w.container as unknown as ServiceWorkerContainer, { onUpdateReady: () => offered++, reload: () => reloads++, doc: doc as unknown as Document });
    await watch.registered;
    w.install();
    w.container.dispatchEvent(new Event("controllerchange"));
    expect(offered).toBe(0);
    expect(reloads).toBe(0);
    watch.stop();
  });

  it("the build asks to be offered, not to take over the open page on its own", () => {
    const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    expect(config).toMatch(/registerType: "prompt"/);
    expect(config).toMatch(/injectRegister: false/);
  });
});

describe("b8-web-layout-10: the Investments period picker wraps instead of widening the page", () => {
  it(".inv-seg wraps and is never wider than its row", () => {
    const inv = topLevel(css("../pages/investments/investments.css"));
    expect(decl(inv, ".inv-seg", "flex-wrap")).toBe("wrap");
    expect(decl(inv, ".inv-seg", "max-width")).toBe("100%");
  });
});

describe("b8-web-layout-11: the phone header is a compact bar", () => {
  it("the shell's rows are the header and the page (a short page does not stretch the header)", () => {
    const phone = mediaBlock(STYLES, "(max-width: 800px)");
    expect(decl(phone, ".shell", "grid-template-rows")).toBe("auto 1fr");
  });

  it("the links scroll in their own strip; the member and Sign out stay in the top row", () => {
    const phone = mediaBlock(STYLES, "(max-width: 800px)");
    expect(decl(phone, ".nav ul", "overflow-x")).toBe("auto");
    expect(decl(phone, ".nav", "overflow-x")).toBeUndefined();
    expect(decl(phone, ".nav-foot", "grid-area")).toBe("foot");
    expect(decl(phone, ".nav ul", "grid-area")).toBe("links");
  });

  it("the active link is scrolled into its strip, never by scrolling the page", async () => {
    const { revealOffset } = await import("../lib/navigation.js");
    // A strip from 16 to 374 px; Settings at 1263 to 1330 px.
    expect(revealOffset(16, 374, 1263, 1330)).toBe(1330 - 374 + 8);
    expect(revealOffset(16, 374, -40, 20)).toBe(-40 - 16 - 8);
    expect(revealOffset(16, 374, 100, 160)).toBe(0);
  });
});

describe("b8-web-layout-12: light-mode muted text meets WCAG AA", () => {
  const light = tokens(STYLES);
  const dark = tokens(mediaBlock(STYLES, "(prefers-color-scheme: dark)"));

  it("muted text is at least 4.5:1 on the page, on cards and on the tinted plan rows, in both schemes", () => {
    for (const t of [light, dark]) {
      const muted = rgb(t["--muted"]!);
      const bg = rgb(t["--bg"]!);
      const panel = rgb(t["--panel"]!);
      const accent = rgb(t["--accent"]!);
      const bad = rgb(t["--bad"]!);
      const ink = rgb(t["--ink"]!);
      const backgrounds = {
        page: bg,
        card: panel,
        bucketRow: mix(accent, panel, 0.1),
        groupRow: mix(ink, panel, 0.04),
        currentMonth: mix(accent, mix(accent, panel, 0.1), 0.07),
        overspent: mix(bad, panel, 0.12),
        overspentCurrent: mix(bad, mix(accent, panel, 0.07), 0.12),
      };
      const below = Object.entries(backgrounds)
        .map(([where, background]) => ({ where, ratio: Number(contrast(muted, background).toFixed(2)) }))
        .filter((r) => r.ratio < 4.5);
      expect(below).toEqual([]);
    }
  });

  it("the charts' fallback colour is the stylesheet's", () => {
    const chart = readFileSync(new URL("./charts/EChart.tsx", import.meta.url), "utf8");
    expect(chart).toContain(`muted: "${light["--muted"]}"`);
  });
});

describe("b8-web-layout-13: a request that never reached the API says so, and nothing pretends it loaded", () => {
  it("a rejected fetch becomes ApiError 0 'network' with a readable message (a cancelled one stays a cancellation)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const error = await api("/accounts").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("network");
    expect((error as ApiError).message).toMatch(/^Can't reach Meridian/);
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")));
    const cancelled = await api("/accounts", { signal: controller.signal }).catch((e: unknown) => e);
    expect(cancelled).toBeInstanceOf(DOMException);
  });

  it("a 502 from the proxy without a JSON body says the server is not answering", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const error = (await api("/accounts").catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/not answering/);
  });

  it("queries retry a network error and a 5xx, not a 4xx", () => {
    const shouldRetry = apiModule.shouldRetry;
    expect(shouldRetry(0, NETWORK())).toBe(true);
    expect(shouldRetry(1, new ApiError(503, "x"))).toBe(true);
    expect(shouldRetry(2, NETWORK())).toBe(false);
    expect(shouldRetry(0, new ApiError(404, "x"))).toBe(false);
  });

  it("Accounts shows no net worth and no empty state when the list could not be loaded", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    await failRefetch(qc, ["accounts"], NETWORK());
    const t = text(render(<AccountsPage />, qc, "/accounts"));
    expect(t).toContain("Can't reach Meridian");
    expect(t).not.toContain("Net worth");
    expect(t).not.toContain("No accounts yet");
  });

  it("Accounts keeps the last loaded list (and its total) when a refetch fails", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["accounts"], [account()]);
    await failRefetch(qc, ["accounts"], NETWORK());
    const t = text(render(<AccountsPage />, qc, "/accounts"));
    expect(t).toContain("Net worth $1,234.56");
    expect(t).toContain("Joint Checking");
  });

  it("the register shows no 'No transactions match' when the list could not be loaded", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    await failRefetch(qc, REGISTER_KEY, NETWORK());
    const t = text(render(<TransactionsPage />, qc, "/transactions"));
    expect(t).toContain("Can't reach Meridian");
    expect(t).not.toContain("No transactions match");
  });
});

describe("b8-web-layout-14: titles, landmarks and a skip link", () => {
  it("each route has its own document title", async () => {
    const { pageTitle } = await import("../lib/navigation.js");
    expect(pageTitle("/dashboard")).toBe("Dashboard · Meridian");
    expect(pageTitle("/transactions")).toBe("Transactions · Meridian");
    expect(pageTitle("/investments")).toBe("Portfolio · Investments · Meridian");
    expect(pageTitle("/investments/holdings")).toBe("Holdings · Investments · Meridian");
    expect(pageTitle(`/investments/accounts/${U(1)}`)).toBe("Account · Investments · Meridian");
    expect(pageTitle("/import")).toBe("Import CSV · Meridian");
    expect(pageTitle("/nope")).toBe("Meridian");
  });

  it("the shell starts with a skip link to the main region and labels its navigation", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    const html = render(<Layout />, qc, "/transactions");
    const firstFocusable = html.match(/<(a|button|input|select)\b[^>]*>[^<]*/)?.[0] ?? "";
    expect(firstFocusable).toMatch(/class="skip-link"/);
    expect(firstFocusable).toContain("Skip to content");
    expect(html).toContain('<nav class="nav" aria-label="Main"');
    expect(html).toMatch(/<main class="content" id="content" tabindex="-1">/);
  });

  it("the sign-in screens are a main landmark", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, SIGNED_OUT_STATUS);
    expect(render(<LoginPage />, qc, "/dashboard")).toMatch(/^<main class="auth-frame"/);
  });
});

describe("b8-web-layout-15: every form control has a name", () => {
  it("the register: the search field and each row's category select", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["accounts"], [account()]);
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(REGISTER_KEY, { pages: [{ items: [txn(1), txn(2, { payeeName: null })], nextCursor: null }], pageParams: [undefined] });
    const html = render(<TransactionsPage />, qc, "/transactions");
    expect(unnamedControls(html)).toEqual([]);
    expect(html).toContain('aria-label="Category for Payee 1"');
    expect(html).toContain('aria-label="Category for PAYEE 2 1234 DENVER CO"');
  });

  it("Accounts: each row's type and tax treatment, and the add form", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["accounts"], [account(), account({ id: U(2), name: "Emergency Savings", type: "savings", taxTreatment: "taxable" })]);
    const html = render(<AccountsPage />, qc, "/accounts");
    expect(unnamedControls(html)).toEqual([]);
  });

  it("Connections: the name and the setup token", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["connections"], [] as ConnectionView[]);
    const html = render(<ConnectionsPage />, qc, "/connections");
    expect(unnamedControls(html)).toEqual([]);
  });
});
