import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CategoryGroupView, DashboardView, GoalView, MonthSummaryView, PlanCellView, PlanResponse, PlanRow, TransactionList, TransactionView } from "@meridian/shared";
import { AUTH_KEY } from "../../lib/auth.js";
import { drillDownQuery, localToday, resolveRange, type PlanCategoryRow } from "../../lib/plan.js";
import { GoalsPage } from "../../pages/GoalsPage.js";
import { PlanPage } from "../../pages/PlanPage.js";
import { SyncCard } from "../dashboard/SyncCard.js";
import { DrillPanel, drillQueryKey } from "./DrillPanel.js";
import { ManageCategories } from "./ManageCategories.js";
import { CategoryCell, TotalCell, type CellActions } from "./PlanCell.js";
import { SummaryStrip } from "./SummaryStrip.js";

/**
 * Audit batch b7-plan-ui (spending plan, goals and dashboard in the web app): what the Plan,
 * Goals and Dashboard components render for findings 02, 04, 05, 08, 10, 11 and 12. Layout
 * itself (that the stacked values fit, that no row covers another) is checked in the built app
 * in a browser; the checks are recorded in docs/audit/phases-1-3/b7-plan-ui.md.
 */

function render(ui: ReactElement, opts: { viewer?: boolean; data?: Array<[readonly unknown[], unknown]> } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(AUTH_KEY, { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "u", role: opts.viewer ? "viewer" : "owner" });
  for (const [key, value] of opts.data ?? []) qc.setQueryData(key, value);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The text a person reads, tags removed and spaces collapsed. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const cell = (over: Partial<PlanCellView> = {}): PlanCellView => ({
  plannedCents: "0",
  source: "none",
  hasExplicitPlan: false,
  carriedInCents: "0",
  carriedInSource: "none",
  availableCents: "0",
  actualCents: "0",
  pendingCents: "0",
  remainingCents: "0",
  overspendCents: "0",
  committedCents: "0",
  rolloverMode: "none",
  txnCount: 0,
  overspent: false,
  note: null,
  ...over,
});

const RENT = "22222222-2222-4222-8222-222222222222";
const GROCERIES = "11111111-1111-4111-8111-111111111111";
const FUND = "33333333-3333-4333-8333-333333333333";
const GROUP = "44444444-4444-4444-8444-444444444444";

const categoryRow = (over: Partial<PlanCategoryRow> = {}): PlanCategoryRow => ({
  kind: "category",
  bucket: "bills",
  groupId: null,
  categoryId: RENT,
  name: "Rent",
  position: 1,
  hidden: false,
  rolloverMode: "none",
  rolloverFromMonth: null,
  goal: null,
  cells: [cell({ plannedCents: "180000", source: "recurring", actualCents: "180000", txnCount: 1 })],
  ...over,
});

const noActions: CellActions = { apply: () => {}, move: () => false, openMenu: () => {}, drill: () => {} };

const summary = (month: string, state: MonthSummaryView["state"]): MonthSummaryView => {
  const totals = { income: "500000", bills: "189548", savings: "50000", spending: "84000" };
  return {
    month,
    state,
    planned: totals,
    actual: totals,
    committed: totals,
    plannedLeftToSpendCents: "176452",
    leftToSpendCents: "176452",
    toAssignCents: "176452",
    warning: false,
    pace: null,
    uncategorized: { count: 0, cents: "0" },
  } as MonthSummaryView;
};

describe("b7-plan-ui-02: bucket and group subtotals and the strip are readable", () => {
  it("a subtotal stacks planned over actual and remaining, and labels the remaining like a category cell", () => {
    const bills = cell({ plannedCents: "189548", actualCents: "181649", remainingCents: "7899" });
    const html = render(<TotalCell cell={bills} bucket="bills" compact={false} state="current" />);
    expect(text(html)).toBe("$1,895.48 $1,816.49 $78.99 left");
    // Planned on its own line, then the actual and the remaining together (the CSS stacks them).
    expect(html).toMatch(/<span class="plan-total-planned"[^>]*>\$1,895\.48<\/span><div class="plan-sub">/);
    const income = cell({ plannedCents: "500000", actualCents: "250000", remainingCents: "250000" });
    expect(text(render(<TotalCell cell={income} bucket="income" compact={false} state="current" />))).toBe("$5,000.00 $2,500.00 $2,500.00 to come");
    expect(text(render(<TotalCell cell={income} bucket="income" compact state="current" />))).toBe("$2,500.00");
  });

  it("every strip total names its bucket inside the month cell", () => {
    const html = render(<SummaryStrip summary={[summary("2026-10", "past"), summary("2026-11", "current")]} zeroBased={false} compact={false} startMonth="2026-09" />);
    const cells = html.split('role="cell"').slice(1).map(text);
    expect(cells).toHaveLength(2);
    for (const c of cells) expect(c).toContain("Income $5,000.00 Bills $1,895.48 Savings $500.00 Spending $840.00");
  });
});

describe("b7-plan-ui-11: compact mode shows remaining, with planned on focus, and keeps the strip's totals", () => {
  it("a compact category cell shows the remaining and keeps the planned input whole for keyboard entry, without the marker", () => {
    const html = render(<CategoryCell row={categoryRow()} cell={categoryRow().cells[0]!} month="2026-12" rowIndex={3} col={0} compact state="future" lockedReason={null} actions={noActions} />);
    expect(html).toContain('value="1800.00"');
    expect(html).toContain("plan-compact-input");
    expect(html).not.toContain("plan-src");
    expect(text(html)).toContain("$0.00");
  });

  it("the compact strip still shows the bucket totals", () => {
    const html = render(<SummaryStrip summary={[summary("2026-11", "current")]} zeroBased={false} compact startMonth="2026-09" />);
    expect(text(html.split('role="cell"')[1]!)).toContain("Income $5,000.00 Bills $1,895.48 Savings $500.00 Spending $840.00");
  });
});

describe("b7-plan-ui-05 and -10: cells that cannot be edited say so", () => {
  it("a month before the plan start shows a read-only planned value and why", () => {
    const reason = "Before the plan start month (Nov 2026): change it in Settings";
    const html = render(<CategoryCell row={categoryRow()} cell={categoryRow().cells[0]!} month="2026-10" rowIndex={3} col={0} compact={false} state="past" lockedReason={reason} actions={noActions} />);
    const input = html.match(/<input[^>]*aria-label="Rent planned for 2026-10"[^>]*>/)?.[0];
    expect(input).toContain('readOnly=""');
    expect(html).toContain(reason);
    const editable = render(<CategoryCell row={categoryRow()} cell={categoryRow().cells[0]!} month="2026-11" rowIndex={3} col={0} compact={false} state="current" lockedReason={null} actions={noActions} />);
    expect(editable).not.toContain("readOnly");
  });

  it("the strip marks the months before the plan start and links to Settings", () => {
    const html = render(<SummaryStrip summary={[summary("2026-09", "past"), summary("2026-11", "current")]} zeroBased={false} compact={false} startMonth="2026-11" />);
    const [sep, nov] = html.split('role="cell"').slice(1);
    expect(sep).toContain('href="/settings"');
    expect(text(sep!)).toContain("before the plan start");
    expect(nov).not.toContain('href="/settings"');
  });

  const plan = (): PlanResponse => {
    const today = localToday();
    const { from } = resolveRange(null, null, today);
    return {
      today,
      currentMonth: today.slice(0, 7),
      startMonth: from,
      from,
      to: from,
      months: [from],
      zeroBased: false,
      rows: [{ kind: "bucket", bucket: "bills", cells: [cell()] } as PlanRow, categoryRow()],
      summary: [summary(from, "past")],
    };
  };
  const planKey = (): readonly unknown[] => {
    const today = localToday();
    const { from, to } = resolveRange(null, null, today);
    return ["plan", from, to, today];
  };

  it("a viewer gets no category manager and no zero-based switch on the Plan page", () => {
    const owner = render(<PlanPage />, { data: [[planKey(), plan()]] });
    expect(owner).toContain("Manage categories");
    expect(owner).toMatch(/<input type="checkbox"[^>]*\/> zero-based/);
    const viewer = render(<PlanPage />, { viewer: true, data: [[planKey(), plan()]] });
    expect(viewer).not.toContain("Manage categories");
    expect(viewer).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/> zero-based/);
    expect(text(viewer)).toContain("read-only");
  });

  it("a viewer sees the goals without New goal, Edit and Delete", () => {
    const goal = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Emergency Fund",
      categoryId: FUND,
      categoryName: "Emergency Fund",
      status: "active",
      targetCents: "1000000",
      targetDate: null,
      linkedAccountId: null,
      linkedAccountName: null,
      monthlyContributionCents: "50000",
      startMonth: "2026-09",
      startingCents: "0",
      history: [],
      progress: { savedCents: "80000", remainingToTargetCents: "920000", progressBp: 800, monthsLeft: null, neededPerMonthCents: null, projectedCompletionMonth: "2028-03", onTrack: null },
      createdAt: "2026-09-01T00:00:00Z",
    } as unknown as GoalView;
    const data: Array<[readonly unknown[], unknown]> = [
      [["goals"], [goal]],
      [["categories"], []],
      [["accounts"], []],
    ];
    const owner = text(render(<GoalsPage />, { data }));
    for (const label of ["New goal", "Edit", "Delete"]) expect(owner).toContain(label);
    const viewer = text(render(<GoalsPage />, { viewer: true, data }));
    expect(viewer).toContain("Emergency Fund");
    for (const label of ["New goal", "Edit", "Delete"]) expect(viewer).not.toContain(label);
  });
});

describe("b7-plan-ui-08: a category's bucket can be changed and the category deleted", () => {
  const rows: PlanRow[] = [
    { kind: "bucket", bucket: "savings", cells: [] } as unknown as PlanRow,
    categoryRow({ categoryId: FUND, name: "Emergency Fund", bucket: "savings", goal: { id: "g" } as PlanCategoryRow["goal"], cells: [] }),
    { kind: "bucket", bucket: "spending", cells: [] } as unknown as PlanRow,
    categoryRow({ categoryId: GROCERIES, name: "Groceries", bucket: "spending", groupId: GROUP, cells: [] }),
  ];
  const groups: CategoryGroupView[] = [{ id: GROUP, name: "Everyday", bucket: "spending", position: 1, hidden: false, categoryCount: 1 } as CategoryGroupView];

  it("each category has a bucket select and a delete action; a goal's category can only stay in savings", () => {
    const html = render(<ManageCategories rows={rows} onClose={() => {}} />, { data: [[["category-groups"], groups]] });
    const groceries = html.slice(html.indexOf('aria-label="Bucket for Groceries"'));
    expect(groceries).toMatch(/^aria-label="Bucket for Groceries"[^>]*>(<option[^>]*>[^<]*<\/option>){4}<\/select>/);
    expect(html).toContain('aria-label="Delete Groceries"');
    const fund = html.slice(html.indexOf('aria-label="Bucket for Emergency Fund"'), html.indexOf("</select>", html.indexOf('aria-label="Bucket for Emergency Fund"')));
    expect(fund.match(/<option value="(income|bills|spending)" disabled=""/g)).toHaveLength(3);
    expect(fund).toMatch(/<option value="savings"( selected="")?>/);
  });
});

describe("b7-plan-ui-04: the Plan page's drill-down panel lists draggable transactions", () => {
  const txn = (id: string, over: Partial<TransactionView>): TransactionView =>
    ({
      id,
      accountId: "66666666-6666-4666-8666-666666666666",
      accountName: "Checking",
      date: "2026-11-02",
      amountCents: "-4500",
      payeeId: null,
      payeeName: "AMAZON",
      rawDescription: "AMAZON MKTPL",
      memo: null,
      categoryId: GROCERIES,
      categoryName: "Groceries",
      categoryLocked: false,
      pending: false,
      isTransfer: false,
      transferPairId: null,
      notes: null,
      tags: [],
      source: "simplefin",
      recurringId: null,
      splits: [],
      transferPartner: null,
      ...over,
    }) as TransactionView;
  const target = { kind: "category" as const, row: categoryRow({ categoryId: GROCERIES, name: "Groceries", bucket: "spending" }), month: "2026-11" };
  const list: TransactionList = {
    items: [
      txn("a1111111-1111-4111-8111-111111111111", {}),
      txn("a2222222-2222-4222-8222-222222222222", { isTransfer: true, categoryId: null, payeeName: "TRANSFER" }),
      txn("a3333333-3333-4333-8333-333333333333", { categoryId: null, splits: [{ id: "s", categoryId: GROCERIES, categoryName: "Groceries", amountCents: "-4500", memo: null }] }),
    ],
    nextCursor: null,
  };
  const categories = [
    { id: GROCERIES, name: "Groceries", bucket: "spending" as const },
    { id: RENT, name: "Rent", bucket: "bills" as const },
  ];

  it("asks for the cell's rows, lets the owner drag or move the movable ones and links to the register", () => {
    expect(drillQueryKey(target)).toEqual(["transactions", "drill", drillDownQuery(target)]);
    const html = render(<DrillPanel target={target} title="Groceries · Nov 2026" categories={categories} canEdit onRecategorize={() => {}} onClose={() => {}} />, {
      data: [[drillQueryKey(target), list]],
    });
    expect(html.match(/draggable="true"/g)).toHaveLength(1);
    expect(html.match(/<select[^>]*aria-label="Move AMAZON/g)).toHaveLength(1);
    expect(html).toContain('href="/transactions?categoryId=11111111-1111-4111-8111-111111111111&amp;from=2026-11-01&amp;to=2026-11-30&amp;transfers=exclude&amp;planScope=true"');
    expect(text(html)).toContain("Drag a row onto a category");
  });

  it("a viewer reads the same rows without drag or move", () => {
    const html = render(<DrillPanel target={target} title="Groceries · Nov 2026" categories={categories} canEdit={false} onRecategorize={() => {}} onClose={() => {}} />, {
      viewer: true,
      data: [[drillQueryKey(target), list]],
    });
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain("<select");
    expect(text(html)).toContain("AMAZON");
  });
});

describe("b7-plan-ui-12: the dashboard's sync card gives the Bridge's remedy", () => {
  it("con.auth reads as re-authentication at the Bridge, and a paused connection says scheduled syncs are paused", () => {
    const sync: DashboardView["sync"] = {
      lastSyncAt: null,
      attention: [
        { connectionId: "77777777-7777-4777-8777-777777777777", name: "Bank A", status: "auth_required", syncPaused: false },
        { connectionId: "88888888-8888-4888-8888-888888888888", name: "Bank B", status: "error", syncPaused: true },
        { connectionId: "99999999-9999-4999-8999-999999999999", name: "Bank C", status: "error", syncPaused: false },
      ],
    };
    const t = text(render(<SyncCard sync={sync} />));
    expect(t).toContain("Bank A needs re-authentication at the Bridge");
    expect(t).toContain("Bank B last sync failed · scheduled syncs paused");
    expect(t).toMatch(/Bank C last sync failed($| )/);
    expect(t).not.toContain("new token");
  });
});
