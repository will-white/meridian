import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PLAN_HISTORY_ENTITIES, type AuditEntryView, type AuditList, type DashboardView, type LotDisposalView, type LotsResponse, type LotView, type RealizedGainsResponse } from "@meridian/shared";
import { AUTH_KEY } from "../lib/auth.js";
import { openingNote, balancesAsOfText } from "./cashflow/opening.js";
import { CashFlowCard } from "./dashboard/CashFlowCard.js";
import { LotsDrawer, lotsDrawerQuery } from "./investments/LotsDrawer.js";
import { PlanHistory, planHistoryQuery } from "./plan/PlanHistory.js";
import { RealizedPage, realizedQuery } from "../pages/investments/RealizedPage.js";
import { localToday } from "../lib/plan.js";
import { realizedRange } from "../lib/lots.js";
import { INVESTMENT_LINKS, pageTitle } from "../lib/navigation.js";

/**
 * Audit batch b9-conformance-plan-investments (docs/audit/phases-1-3/b9-conformance-plan-investments.md):
 * what the new and changed components render for findings 01 (the lots drawer and the Realized gains
 * page), 02 (where the cash flow starts) and 03 (the plan's history with its undo). Interaction is
 * checked in the built app in a browser; the checks are recorded in the audit record.
 */

function render(ui: ReactElement, opts: { url?: string; viewer?: boolean; data?: Array<[readonly unknown[], unknown]> } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(AUTH_KEY, { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "u", role: opts.viewer ? "viewer" : "owner" });
  for (const [key, value] of opts.data ?? []) qc.setQueryData(key, value);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.url ?? "/"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const BRK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROTH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VTI = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TXN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CAT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GOAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const lot = (over: Partial<LotView>): LotView => ({
  id: "10000000-0000-4000-8000-000000000001",
  openedByTxnId: TXN,
  ordinal: 0,
  originLotId: null,
  accountId: BRK,
  accountName: "Brokerage",
  securityId: VTI,
  ticker: "VTI",
  securityName: "Vanguard Total Stock Market ETF",
  openedBy: "buy",
  acquiredDate: "2025-10-01",
  originalQuantity: "20",
  quantity: "15",
  originalCostBasisCents: "500000",
  costBasisCents: "375000",
  basisPerShare: "250",
  basisKnown: true,
  closedDate: null,
  priceDate: "2026-11-12",
  valueCents: "450000",
  unrealizedCents: "75000",
  term: "long",
  ...over,
});

describe("b9-01: the lots and the realized gains are shown", () => {
  it("the Holdings lots drawer lists the open lots with acquired, shares, basis, basis per share, value, gain and term, and the closed ones collapsed", () => {
    const today = "2026-11-13";
    const { queryKey } = lotsDrawerQuery({ accountId: BRK, securityId: VTI, asOf: null, today });
    const data: LotsResponse = {
      asOf: today,
      lots: [
        lot({}),
        lot({ id: "10000000-0000-4000-8000-000000000002", ordinal: 1, openedBy: "reinvest", acquiredDate: "2026-06-26", originalQuantity: "0.06", quantity: "0.06", costBasisCents: "1800", originalCostBasisCents: "1800", basisPerShare: "300", valueCents: "1800", unrealizedCents: "0", term: "short" }),
        lot({ id: "10000000-0000-4000-8000-000000000003", openedBy: "transfer_in", acquiredDate: "2024-01-05", quantity: "0", originalQuantity: "5", closedDate: "2026-06-01", valueCents: null, unrealizedCents: null }),
        lot({ id: "10000000-0000-4000-8000-000000000004", accountId: ROTH, accountName: "Roth IRA" }),
      ],
      accounts: [{ accountId: BRK, fidelity: "full_history", lotMethod: "fifo", positionCheckDate: "2026-11-12", warnings: [{ code: "basis_unknown", accountId: BRK, securityId: VTI, txnId: TXN, date: "2024-01-05", quantity: "5" }] }],
    };
    const t = text(render(<LotsDrawer accountId={BRK} accountName="Brokerage" securityId={VTI} label="VTI" asOf={null} today={today} />, { data: [[queryKey, data]] }));
    expect(t).toContain("Lots of VTI in Brokerage");
    expect(t).toMatch(/Acquired Shares Cost basis Basis\/share Value Gain Term/);
    expect(t).toContain("10/01/25 · buy 15 $3,750.00 250 $4,500.00 price 11/12/26 +$750.00 Long");
    expect(t).toContain("06/26/26 · reinvested dividend 0.06 $18.00 300 $18.00 price 11/12/26 $0.00 Short");
    expect(t).toContain("2 open lots 15.06 $3,768.00 $4,518.00 +$750.00");
    expect(t).toContain("1 closed lot");
    expect(t).toContain("01/05/24 · transfer in 06/01/26 5");
    // The Roth's lot of the same security is another account's drawer.
    expect(t.match(/\$4,500\.00/g)).toHaveLength(1);
    // The engine's warning about the security, in words.
    expect(t).toContain("5 shares of VTI arrived without a cost basis");
  });

  const disposal = (over: Partial<LotDisposalView>): LotDisposalView => ({
    accountId: BRK,
    accountName: "Brokerage",
    securityId: VTI,
    ticker: "VTI",
    closeTxnId: TXN,
    lotId: "10000000-0000-4000-8000-000000000001",
    kind: "sell",
    date: "2026-06-01",
    acquiredDate: "2025-10-01",
    quantity: "5",
    proceedsCents: "140000",
    basisCents: "125000",
    gainCents: "15000",
    term: "short",
    basisKnown: true,
    ...over,
  });

  it("the Realized gains page lists every disposal of the year with its proceeds, basis, gain and term, the short and long totals and the wash-sale footer", () => {
    const today = localToday();
    const year = today.slice(0, 4);
    const range = realizedRange(new URLSearchParams(`year=${year}`), today);
    const { queryKey } = realizedQuery(range, "", today);
    const totals = (gain: string, proceeds: string, basis: string, count: number) => ({ gainCents: gain, proceedsCents: proceeds, basisCents: basis, count });
    const summary = {
      shortTerm: totals("15000", "140000", "125000", 1),
      longTerm: totals("-2000", "30000", "32000", 1),
      unknownBasis: { proceedsCents: "9000", quantity: "3", count: 1 },
      transfersOut: { quantity: "2", basisCents: "50000" },
      washSalesApplied: false as const,
    };
    const data: RealizedGainsResponse = {
      from: range.from,
      to: range.to,
      summary,
      byAccount: [
        { accountId: BRK, name: "Brokerage", summary },
        { accountId: ROTH, name: "Roth IRA", summary: { ...summary, shortTerm: totals("0", "0", "0", 0) } },
      ],
      disposals: [
        disposal({}),
        disposal({ accountId: ROTH, accountName: "Roth IRA", date: "2026-07-01", acquiredDate: "2020-01-02", proceedsCents: "30000", basisCents: "32000", gainCents: "-2000", term: "long" }),
        disposal({ date: "2026-08-01", lotId: null, kind: "unmatched_sell", acquiredDate: null, quantity: "3", proceedsCents: "9000", basisCents: null, gainCents: null, term: "unknown", basisKnown: false }),
        disposal({ date: "2026-09-01", kind: "transfer_out", quantity: "2", proceedsCents: "0", basisCents: "50000", gainCents: null, term: "none" }),
      ],
    };
    const t = text(render(<RealizedPage />, { url: `/investments/realized?year=${year}`, data: [[queryKey, data], [["accounts"], []]] }));
    expect(range).toMatchObject({ from: `${Number(year) - 1}-12-31`, to: `${year}-12-31` });
    expect(t).toContain("Realized gains");
    expect(t).toContain("Short-term gain +$150.00 proceeds $1,400.00, basis $1,250.00");
    expect(t).toContain("Long-term gain -$20.00");
    expect(t).toContain("Total realized +$130.00");
    expect(t).toContain("Basis unknown $90.00");
    expect(t).toMatch(/Date Account Security Shares Acquired Proceeds Basis Gain Term/);
    expect(t).toContain("06/01/26 Brokerage VTI 5 10/01/25 $1,400.00 $1,250.00 +$150.00 Short");
    expect(t).toContain("07/01/26 Roth IRA VTI 5 01/02/20 $300.00 $320.00 -$20.00 Long");
    expect(t).toContain("no matching purchase");
    expect(t).toContain("Transferred out: 2 sh carrying $500.00 of basis");
    expect(t).toContain("Account Short-term Long-term Basis unknown (proceeds) Brokerage +$150.00 -$20.00 $90.00 Roth IRA $0.00");
    expect(t).toContain("08/01/26 Brokerage VTI 3 — $90.00 — — no matching purchase Unknown");
    expect(t).toContain("Wash sales are not applied.");
  });

  it("the page is in the Investments sub-nav with its own title, and a custom range is the route's (from, to] window", () => {
    expect(INVESTMENT_LINKS.map(([to]) => to)).toContain("/investments/realized");
    expect(pageTitle("/investments/realized")).toBe("Realized gains · Investments · Meridian");
    expect(realizedRange(new URLSearchParams("from=2026-03-01&to=2026-06-30"), "2026-11-13")).toMatchObject({ choice: "custom", from: "2026-02-28", to: "2026-06-30", first: "2026-03-01" });
    // A future or inverted custom range falls back to this year.
    expect(realizedRange(new URLSearchParams("from=2026-06-30&to=2026-03-01"), "2026-11-13")).toMatchObject({ choice: "2026" });
    expect(realizedRange(new URLSearchParams("year=2031"), "2026-11-13")).toMatchObject({ choice: "2026" });
  });
});

describe("b9-02: the cash flow says where each account starts", () => {
  it("an account's opening note names its balance date and the rows imported since; a stale one is marked", () => {
    expect(openingNote({ balanceDate: "2026-10-31", rolledForwardCents: "-95000", rolledForwardRows: 2, dataThrough: "2026-11-06" }, "2026-11-13")).toEqual({
      text: "balance of 10/31/26 + 2 transactions through 11/06/26 (-$950.00)",
      stale: true,
    });
    expect(openingNote({ balanceDate: "2026-11-12", rolledForwardCents: "0", rolledForwardRows: 0, dataThrough: "2026-11-12" }, "2026-11-13")).toEqual({ text: "balance as of 11/12/26", stale: false });
    expect(openingNote({ balanceDate: null, rolledForwardCents: "0", rolledForwardRows: 0, dataThrough: null }, "2026-11-13")).toEqual({ text: "no known balance", stale: true });
    expect(balancesAsOfText("2026-11-13", "2026-11-13")).toBeNull();
  });

  it("the dashboard's 30-day card says how old its starting balances are", () => {
    const cashFlow: DashboardView["cashFlow"] = {
      asOf: "2026-11-13",
      horizonDays: 30,
      thresholdCents: "100000",
      points: [{ date: "2026-11-13", cents: "4500" }],
      lowPoint: { date: "2026-11-13", cents: "4500" },
      firstBelow: "2026-11-13",
      balancesAsOf: "2026-09-15",
      warnings: ["Savings: the projection starts from the balance of 09/15/26; record a newer balance or import its transactions"],
    };
    const t = text(render(<CashFlowCard cashFlow={cashFlow} />));
    expect(t).toContain("Starts from balances as of 09/15/26");
    expect(t).toContain("Savings: the projection starts from the balance of 09/15/26");
  });
});

describe("b9-03: the plan's history can be reviewed and undone", () => {
  const entry = (over: Partial<AuditEntryView>): AuditEntryView => ({
    id: "20000000-0000-4000-8000-000000000001",
    at: "2026-11-13T16:05:00.000Z",
    userId: "30000000-0000-4000-8000-000000000001",
    username: "owner",
    batchId: "40000000-0000-4000-8000-000000000001",
    entity: "month_plan",
    entityId: `2026-11:${CAT}`,
    action: "create",
    before: null,
    after: { plannedCents: "25000", source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null },
    ...over,
  });
  const list: AuditList = {
    items: [
      entry({ id: "20000000-0000-4000-8000-000000000009", batchId: "40000000-0000-4000-8000-000000000009", at: "2026-11-13T17:00:00.000Z", entity: "savings_goal", entityId: GOAL, action: "update", before: { id: GOAL, name: "Emergency fund", monthlyContributionCents: "50000" }, after: { id: GOAL, name: "Emergency fund", monthlyContributionCents: "40000" } }),
      entry({ id: "20000000-0000-4000-8000-000000000008", batchId: "40000000-0000-4000-8000-000000000008", at: "2026-11-13T16:30:00.000Z", entity: "category", entityId: CAT, action: "create", before: null, after: { id: CAT, name: "Coffee" } }),
      entry({ id: "20000000-0000-4000-8000-000000000003", entityId: `2027-01:${CAT}` }),
      entry({ id: "20000000-0000-4000-8000-000000000002", entityId: `2026-12:${CAT}` }),
      entry({ id: "20000000-0000-4000-8000-000000000001", action: "update", before: { plannedCents: "20000", source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null } }),
    ],
    nextCursor: null,
  };
  const names = { category: (id: string) => (id === CAT ? "Dining" : undefined), group: () => undefined };

  it("lists the changes of every plan entity grouped by request, with who and when, each in words; an owner can undo a change", () => {
    const { queryKey, params } = planHistoryQuery(null, null);
    expect(params).toMatchObject({ entities: PLAN_HISTORY_ENTITIES.join(",") });
    const html = render(<PlanHistory names={names} cell={null} canUndo today="2026-11-13" onClose={() => {}} onUndone={() => {}} />, { data: [[queryKey, list], [["accounts"], []]] });
    const t = text(html);
    expect(t).toContain("Plan history");
    expect(t).toContain("Goal Emergency fund: monthly contribution $500.00 → $400.00");
    expect(t).toContain("Category Coffee created");
    expect(t).toContain("not undoable here: a new item is removed on its own page");
    expect(t).toContain("3 changes");
    expect(t).toContain("Dining · Jan 2027: planned $250.00 (was automatic)");
    expect(t).toContain("Dining · Nov 2026: planned $250.00 (was $200.00)");
    expect(t).toContain("owner");
    // Two batches can be undone (the goal edit and the fill-right); the category's creation cannot.
    expect(html.match(/>Undo</g)).toHaveLength(2);
  });

  it("a viewer reviews the same history without the undo; a cell's own history is filtered to it", () => {
    const { queryKey } = planHistoryQuery(null, null);
    const t = render(<PlanHistory names={names} cell={null} canUndo={false} today="2026-11-13" onClose={() => {}} onUndone={() => {}} />, { viewer: true, data: [[queryKey, list], [["accounts"], []]] });
    expect(t).not.toMatch(/>Undo</);
    expect(text(t)).toContain("Owners can undo a change.");
    const cell = planHistoryQuery({ month: "2026-11", categoryId: CAT }, null);
    expect(cell.params).toEqual({ entity: "month_plan", entityId: `2026-11:${CAT}`, limit: 100 });
    const one = text(render(<PlanHistory names={names} cell={{ month: "2026-11", categoryId: CAT }} canUndo today="2026-11-13" onClose={() => {}} onUndone={() => {}} />, { data: [[cell.queryKey, { items: [list.items[4]!], nextCursor: null }], [["accounts"], []]] }));
    expect(one).toContain("History of Dining · Nov 2026");
    expect(one).toContain("Undo puts this cell back as it was before that change.");
  });
});
