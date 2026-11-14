import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { AccountView, AuditList, AuthStatus, CategoryView, ConnectionView, RuleView, TransactionView } from "@meridian/shared";
import { ApiError } from "../lib/api.js";
import { AUTH_KEY } from "../lib/auth.js";
import { AccountsPage } from "../pages/AccountsPage.js";
import { ConnectionsPage } from "../pages/ConnectionsPage.js";
import { PayeesPage } from "../pages/PayeesPage.js";
import { RulesPage } from "../pages/RulesPage.js";
import { TransactionsPage } from "../pages/TransactionsPage.js";
import { RowActions } from "./transactions/RowActions.js";
import { RulePrompt } from "./transactions/RulePrompt.js";

/**
 * Audit batch a8-ledger-ui (the ledger pages in the web app): what the pages render for a given
 * cache, as static markup (the suite has no browser engine). Clicks, confirms and the layout at
 * phone width were checked in the built app in headless Chromium; the record is
 * docs/audit/phases-1-3/a8-ledger-ui.md. The pure helpers are tested in
 * apps/web/src/lib/ledgerForms.test.ts.
 */

const OWNER: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" };
const KID: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "kid", role: "viewer" };

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } } });
}

function render(ui: ReactElement, qc: QueryClient, path = "/"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function failLoad(qc: QueryClient, key: readonly unknown[], error: unknown): Promise<void> {
  await qc.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error), retry: false, staleTime: 0 }).catch(() => undefined);
}

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
  balanceCents: "250000",
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
  inFeed: null,
  ...over,
});

const txn = (n: number, over: Partial<TransactionView> = {}): TransactionView => ({
  id: U(100 + n),
  accountId: U(1),
  accountName: "Checking",
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

const conn = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: U(400),
  type: "simplefin",
  name: "Credit union",
  status: "ok",
  lastSyncAt: "2026-11-13T12:00:00Z",
  lastAttemptAt: "2026-11-13T12:00:00Z",
  syncPaused: false,
  syncedThrough: "2026-11-13",
  lastError: null,
  lastErrors: [],
  csvMapping: null,
  csvKind: "bank",
  positionsMapping: null,
  tradesMapping: null,
  accountCount: 2,
  activeJob: null,
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

const GROCERIES = U(300);
const CATEGORIES: CategoryView[] = [
  { id: GROCERIES, name: "Groceries", bucket: "spending", hidden: false },
  { id: U(301), name: "Coffee", bucket: "spending", hidden: false },
];
const REGISTER_KEY = ["transactions", { q: "", accountId: "", categoryId: "", goalId: "", recurringId: "", transfers: "include", from: "", to: "", limit: 100 }];
const registerPage = (items: TransactionView[]) => ({ pages: [{ items, nextCursor: null }], pageParams: [undefined] });

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  id: U(500),
  name: "Blue Bottle Coffee → Coffee",
  position: 1,
  enabled: true,
  conditions: { payee: { op: "equals", value: "Blue Bottle Coffee" } },
  actions: { setCategoryId: U(301) },
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});

/** Controls the page offers to change something: selects, checkboxes and buttons, by their text or name. */
const controls = (html: string) => ({
  selects: [...html.matchAll(/<select[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]!),
  checkboxes: (html.match(/type="checkbox"/g) ?? []).length,
  buttons: [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!)),
});

describe("a8-ledger-ui-05: a viewer is offered no change on the register, Accounts or Connections", () => {
  const seedRegister = (qc: QueryClient) => {
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(["accounts"], [account()]);
    qc.setQueryData(REGISTER_KEY, registerPage([txn(1, { categoryId: GROCERIES, categoryName: "Groceries" }), txn(2, { isTransfer: true, transferPairId: U(600) })]));
  };

  it("the register: the category is text, with no split, undo or add", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, KID);
    seedRegister(qc);
    const html = render(<TransactionsPage />, qc, "/transactions");
    const c = controls(html);
    expect(c.selects.filter((l) => l.startsWith("Category for"))).toEqual([]);
    expect(c.buttons).not.toContain("split");
    expect(c.buttons).not.toContain("transfer · undo");
    expect(c.buttons).not.toContain("Add transaction");
    expect(text(html)).toContain("Groceries");

    const owner = client();
    owner.setQueryData(AUTH_KEY, OWNER);
    seedRegister(owner);
    const o = controls(render(<TransactionsPage />, owner, "/transactions"));
    expect(o.selects.filter((l) => l.startsWith("Category for"))).toHaveLength(1);
    expect(o.buttons).toEqual(expect.arrayContaining(["split", "transfer · undo", "Add transaction"]));
  });

  it("Accounts: no type, tax or budget control, no Close, no cash-flow edit and no add form", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, KID);
    qc.setQueryData(["accounts"], [account(), account({ id: U(2), name: "Visa", type: "credit", balanceCents: "-45000" })]);
    const html = render(<AccountsPage />, qc, "/accounts");
    const c = controls(html);
    expect(c.selects).toEqual([]);
    expect(c.checkboxes).toBe(1); // "show closed" is a view toggle, not a change
    expect(c.buttons).not.toContain("Close");
    expect(c.buttons).not.toContain("edit");
    expect(text(html)).not.toContain("Add a manual account");

    const owner = client();
    owner.setQueryData(AUTH_KEY, OWNER);
    owner.setQueryData(["accounts"], [account()]);
    const o = controls(render(<AccountsPage />, owner, "/accounts"));
    expect(o.selects).toEqual(expect.arrayContaining(["Joint Checking type", "Joint Checking tax treatment"]));
    expect(o.buttons).toEqual(expect.arrayContaining(["Close", "edit", "Add"]));
  });

  it("Connections: no Connect form, Sync, Disable, Remove or Delete", () => {
    const seed = (qc: QueryClient) => qc.setQueryData(["connections"], [conn(), conn({ id: U(401), type: "csv", name: "Chase CSV" })]);
    const qc = client();
    qc.setQueryData(AUTH_KEY, KID);
    seed(qc);
    const c = controls(render(<ConnectionsPage />, qc, "/connections"));
    for (const b of ["Connect", "Sync now", "Balances only", "Disable", "Remove", "Delete", "Full resync"]) expect(c.buttons).not.toContain(b);
    expect(c.buttons).toContain("Log");

    const owner = client();
    owner.setQueryData(AUTH_KEY, OWNER);
    seed(owner);
    expect(controls(render(<ConnectionsPage />, owner, "/connections")).buttons).toEqual(expect.arrayContaining(["Connect", "Sync now", "Disable", "Remove", "Delete"]));
  });
});

describe("a8-ledger-ui-06: loading and a failed load are never shown as empty data", () => {
  it("Connections: a failed load says why, with no 'No SimpleFIN connections yet' and no 'No saved mappings'", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    await failLoad(qc, ["connections"], new ApiError(500, "Something went wrong on the server", "internal"));
    const t = text(render(<ConnectionsPage />, qc, "/connections"));
    expect(t).toContain("Something went wrong on the server");
    expect(t).not.toContain("No SimpleFIN connections yet");
    expect(t).not.toContain("No saved mappings");
  });

  it("Rules: a failed load is not 'No rules yet', and while the rules load the history offers no revert and calls nothing deleted", async () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(["accounts"], []);
    const created = { id: U(700), at: "2026-11-12T10:00:00Z", userId: null, username: "owner", batchId: U(701), entity: "rule" as const, entityId: U(500), action: "create" as const, before: null, after: { id: U(500), name: "Coffee", position: 1, enabled: true, conditions: {}, actions: {} } };
    const deleted = { ...created, id: U(702), entityId: U(501), action: "delete" as const, before: { id: U(501), name: "Old", position: 2, enabled: true, conditions: {}, actions: {} }, after: null };
    qc.setQueryData(["audit", "rule", null], { items: [created, deleted], nextCursor: null } satisfies AuditList);
    // Still loading: no rules query data at all.
    const loading = text(render(<RulesPage />, qc, "/rules"));
    expect(loading).not.toContain("No rules yet");
    expect(loading).not.toContain("The rule was deleted since");
    expect(loading).not.toContain("revert");
    expect(loading).toContain("Loading rules");

    await failLoad(qc, ["rules"], new ApiError(0, "Can't reach Meridian.", "network"));
    const failed = text(render(<RulesPage />, qc, "/rules"));
    expect(failed).toContain("Can't reach Meridian.");
    expect(failed).not.toContain("No rules yet");
    expect(failed).not.toContain("The rule was deleted since");

    // Loaded: the plans are made against the rules that exist.
    qc.setQueryData(["rules"], [rule()]);
    const loaded = text(render(<RulesPage />, qc, "/rules"));
    expect(loaded).toContain("revert");
  });

  it("the register, Accounts and Payees say they are loading, with no total and no empty state", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    expect(text(render(<TransactionsPage />, qc, "/transactions"))).toContain("Loading transactions");
    const accounts = text(render(<AccountsPage />, qc, "/accounts"));
    expect(accounts).toContain("Loading accounts");
    expect(accounts).not.toContain("Net worth");
    expect(accounts).not.toContain("No accounts yet");
    const payees = text(render(<PayeesPage />, qc, "/payees"));
    expect(payees).toContain("Loading payees");
    expect(payees).not.toContain("No payees yet");
  });
});

describe("a8-ledger-ui-07: every change on Connections, Rules, Accounts, the register and Payees shows its failure", () => {
  // A page's mutations are local to it, so their failures cannot be set from a cache; the guard is
  // that every mutation the page declares has its error rendered.
  const pages = ["ConnectionsPage", "RulesPage", "AccountsPage", "TransactionsPage", "PayeesPage"];
  for (const page of pages) {
    it(`${page}: each useMutation's error is rendered`, () => {
      const source = readFileSync(new URL(`../pages/${page}.tsx`, import.meta.url), "utf8");
      const names = [...source.matchAll(/const (\w+) = useMutation\(/g)].map((m) => m[1]!);
      expect(names.length).toBeGreaterThan(0);
      // Rendered by the page (`error={x.error}`) or handed to the editor that shows it (`editError={x.error}`, `error={r ? x.error : y.error}`).
      const missing = names.filter((n) => !new RegExp(`[eE]rror=\\{[^}]*\\b${n}\\.error\\b`).test(source));
      expect(missing).toEqual([]);
    });
  }
});

describe("a8-ledger-ui-07: Disable, Remove, a CSV profile's Delete and a rule's enable or disable report their failure on the page", () => {
  // The mutation each of these buttons calls must have its error shown at page level, not only
  // inside an editor that may be closed (a rule's enable/disable went through the editor's
  // mutation, whose error showed only while that rule's editor was open).
  const cases: Array<[string, string, RegExp]> = [
    ["ConnectionsPage", "Disable / Enable", /onClick=\{\(\) => (\w+)\.mutate\(\{ id: c\.id, status: c\.status === "disabled"/],
    // Both ask first, saying what stays (audit a10-conformance-ledger-04).
    ["ConnectionsPage", "Remove", /confirm\(removeConnectionPrompt\(c\.name\)\)\) (\w+)\.mutate\(c\.id\)/],
    ["ConnectionsPage", "a CSV profile's Delete", /confirm\(deleteProfilePrompt\(p\.name\)\)\) (\w+)\.mutate\(p\.id\)/],
    ["RulesPage", "a rule's enable / disable", /onClick=\{\(\) => (\w+)\.mutate\(\{ id: r\.id, enabled: !r\.enabled \}\)\}/],
  ];
  for (const [page, label, button] of cases) {
    it(`${page}: ${label}`, () => {
      const source = readFileSync(new URL(`../pages/${page}.tsx`, import.meta.url), "utf8");
      const name = button.exec(source)?.[1];
      expect(name, "the button is on the page").toBeDefined();
      expect(source).toContain(`<ErrorText error={${name}.error} />`);
    });
  }
});

describe("a8-ledger-ui-09: 'always do this' is not offered for a rule that already exists", () => {
  const target = { payeeName: "Blue Bottle Coffee", categoryId: U(301) };
  const prompt = (qc: QueryClient) => text(render(<RulePrompt target={target} categoryName="Coffee" onSaved={() => undefined} onDismiss={() => undefined} />, qc));

  it("an enabled rule with that payee condition and that category: the prompt says so instead", () => {
    const qc = client();
    qc.setQueryData(["rules"], [rule()]);
    const t = prompt(qc);
    expect(t).toContain('Rule #1 "Blue Bottle Coffee → Coffee" already categorizes Blue Bottle Coffee as Coffee');
    expect(t).not.toContain("Always do this");
  });

  it("a disabled rule, another category, or a rule with more conditions still gets the offer", () => {
    for (const other of [rule({ enabled: false }), rule({ actions: { setCategoryId: GROCERIES } }), rule({ conditions: { payee: { op: "equals", value: "Blue Bottle Coffee" }, amount: { minCents: "-1000" } } })]) {
      const qc = client();
      qc.setQueryData(["rules"], [other]);
      expect(prompt(qc)).toContain("Always do this");
    }
  });
});

describe("a8-ledger-ui-12: a transfer leg names the row it is paired with", () => {
  it("'to Savings · 11/03/26' on the outflow, 'from Checking' on the inflow, and 'no other leg' for one marked alone", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(
      REGISTER_KEY,
      registerPage([
        txn(1, { amountCents: "-100000", isTransfer: true, transferPairId: U(600), transferPartner: { id: U(102), accountId: U(2), accountName: "Savings", date: "2026-11-03" } }),
        txn(2, { accountName: "Savings", amountCents: "100000", isTransfer: true, transferPairId: U(600), transferPartner: { id: U(101), accountId: U(1), accountName: "Checking", date: "2026-11-02" } }),
        txn(3, { amountCents: "-5000", isTransfer: true }),
      ]),
    );
    const t = text(render(<TransactionsPage />, qc, "/transactions"));
    expect(t).toContain("to Savings · 11/03/26");
    expect(t).toContain("from Checking · 11/02/26");
    expect(t).toContain("no other leg in the app");
  });
});

describe("a8-ledger-ui-13: rows of buttons wrap at phone width", () => {
  it("Connections: the connect form and each connection's buttons are wrapping rows", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["connections"], [conn()]);
    const html = render(<ConnectionsPage />, qc, "/connections");
    expect(html).toMatch(/<form class="row wrap"/);
    expect(html).toMatch(/<div class="row wrap conn-actions">/);
  });
});

describe("a8-ledger-ui-14: the register's search is bounded like the API's", () => {
  it("the search field takes at most 200 characters", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    expect(render(<TransactionsPage />, qc, "/transactions")).toMatch(/aria-label="Search transactions"[^>]*maxLength="200"|maxLength="200"[^>]*aria-label="Search transactions"/);
  });

  it("a deep link with a longer search is cut to 200 characters (maxLength does not trim a value set by code)", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    const html = render(<TransactionsPage />, qc, `/transactions?q=${"x".repeat(300)}`);
    const value = /<input[^>]*aria-label="Search transactions"[^>]*value="(x*)"/.exec(html)?.[1] ?? /<input[^>]*value="(x*)"[^>]*aria-label="Search transactions"/.exec(html)?.[1];
    expect(value).toHaveLength(200);
    // The register's request carries that search, so it is not refused.
    expect(qc.getQueryCache().findAll({ queryKey: ["transactions"] }).map((q) => (q.queryKey[1] as { q: string }).q.length)).toContain(200);
  });
});

describe("a8-ledger-ui-15: account types and tax treatments read as people write them", () => {
  it("IRA, 401(k), Roth IRA, HSA and Pre-tax, never Ira, Hsa or Pre Tax", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["accounts"], [account({ type: "ira", taxTreatment: "pre_tax", name: "Rollover IRA" })]);
    const t = text(render(<AccountsPage />, qc, "/accounts"));
    for (const label of ["IRA", "401(k)", "Roth IRA", "HSA", "529 plan", "Pre-tax", "Credit card"]) expect(t).toContain(label);
    for (const bad of [" Ira ", " Hsa ", "Pre Tax", "401k "]) expect(t).not.toContain(bad);
  });
});

describe("a8-ledger-ui-11: the Connections page shows no Bridge account id", () => {
  it("an act.* entry reads as its message, which names the account", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["connections"], [conn({ lastErrors: [{ code: "act.missingdata", message: "Joint Checking: The Bridge returned incomplete data for this account. It will retry on the next sync.", accountId: "ACT-9f8e7d6c-5b4a" }] })]);
    const t = text(render(<ConnectionsPage />, qc, "/connections"));
    expect(t).toContain("act.missingdata Joint Checking: The Bridge returned incomplete data");
    expect(t).not.toContain("ACT-9f8e7d6c-5b4a");
  });
});

describe("a8-ledger-ui-03: the Payees page reaches every payee and says when its list is cut", () => {
  it("shows the count of the whole list, offers the next page, and merges through a search instead of a select of the first page", () => {
    const qc = client();
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["categories"], CATEGORIES);
    const items = Array.from({ length: 100 }, (_, i) => ({ id: U(800 + i), name: `Aardvark Shop ${String(i).padStart(3, "0")}`, aliases: [], defaultCategoryId: null, transactionCount: 1 }));
    qc.setQueryData(["payees", "list", ""], { pages: [{ items, total: 617, nextCursor: "MTAw" }], pageParams: [undefined] });
    const html = render(<PayeesPage />, qc, "/payees");
    const t = text(html);
    expect(t).toContain("Showing 100 of 617 payees, by name.");
    expect(t).toContain("Load more");
    expect(html).not.toMatch(/aria-label="Merge [^"]* into another payee"/);
    expect(controls(html).buttons.filter((b) => b === "merge into…")).toHaveLength(100);
  });
});

describe("a8-ledger-ui-04: the register edits a row's payee, notes and tags, and adds a transaction", () => {
  it("'more' opens the payee, notes and tags editor for the owner, and only the candidates for a viewer", () => {
    const t = txn(1, { payeeName: "Blue Bottle", notes: "with Sam", tags: ["trip"] });
    const props = { transaction: t, pending: false, error: null, onPair: () => undefined, onMarkTransfer: () => undefined, onDelete: () => undefined, onEdit: () => undefined, editPending: false, editError: null, onClose: () => undefined };
    const owner = render(<RowActions {...props} viewer={false} />, client());
    expect(text(owner)).toContain("Payee, notes and tags");
    expect(owner).toMatch(/value="Blue Bottle"/);
    expect(owner).toMatch(/value="trip"/);
    expect(owner).toMatch(/<textarea[^>]*>with Sam<\/textarea>/);
    const viewer = render(<RowActions {...props} viewer={true} />, client());
    expect(text(viewer)).not.toContain("Payee, notes and tags");
    expect(viewer).not.toMatch(/<textarea/);
  });
});
