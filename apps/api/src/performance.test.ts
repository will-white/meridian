import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, balanceSnapshot, holdingSnapshot, investmentTxn, job, lot, lotDisposal, price } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type { AccountView, HoldingsView, LotsResponse, PerformanceResponse, RealizedGainsResponse, RebuildLotsResponse, SecurityView } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * The lots area's routes on the INV seed (lots design §4.3; the performance service test's
 * 1y figures: B true TWR 0.0861681306 over 2 000 000 → 2 038 360 → +500 000 → 2 705 200,
 * XIRR 0.0913942; R Modified Dietz 0.2133333; household XIRR 0.1403348; VTI shadow values
 * 2 942 639 / 1 802 885 / 4 745 524). The performance POST is `readOnly`: a viewer may call it
 * and it writes nothing.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("performance, lots and realized routes", () => {
  let A: InvestmentApp;
  let B: string;
  let R: string;

  beforeAll(async () => {
    A = await freshInvestmentApp({ lots: true });
    ({ brokerage: B, roth: R } = A.S.accounts);
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const tableCounts = async () => {
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries({ job, auditLog, lot, lotDisposal, price, balanceSnapshot, holdingSnapshot, investmentTxn })) {
      out[name] = (await A.t.db.db.select({ n: count() }).from(table))[0]!.n;
    }
    return out;
  };
  const performance = async (payload: Record<string, unknown>, cookies?: Record<string, string>) => {
    const res = cookies ? await A.t.app.inject({ method: "POST", url: "/api/investments/performance", payload, cookies }) : await A.t.call({ method: "POST", url: "/api/investments/performance", payload });
    return res;
  };

  it("presents the engine's 1y figures with zero writes, also for a viewer", async () => {
    const before = await tableCounts();
    const res = await performance({ from: "2025-10-13", to: "2026-10-13", today: TODAY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as PerformanceResponse;
    expect(view).toMatchObject({ from: "2025-10-13", to: "2026-10-13", asOf: "2026-10-13", today: TODAY, days: 365, detail: "summary" });
    expect(view.accounts.map((a) => a.name)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = view.accounts;
    expect(brokerage).toMatchObject({
      accountId: B,
      type: "brokerage",
      taxTreatment: "taxable",
      method: "true_twr",
      fidelity: "full_history",
      startValueCents: "2000000",
      endValueCents: "2705200",
      openingValue: null,
      contributionsCents: "500000",
      withdrawalsCents: "0",
      netFlowsCents: "500000",
      growthCents: "205200",
      subPeriods: [],
      flows: [],
      lots: [],
      disposals: [],
    });
    expect(brokerage!.twr.rate).toBeCloseTo(0.0861681306, 6);
    expect(brokerage!.xirr.annualized).toBeCloseTo(0.0913942, 6);
    expect(brokerage!.xirr.investorFlows).toEqual([]);
    expect(brokerage!.benchmark).toMatchObject({ securityId: A.S.securities.vti, ticker: "VTI", name: "Vanguard Total Stock Market ETF", adjusted: true, shadowValueCents: "2942639", startPrice: "260", endPrice: "312.5", legs: [] });
    expect(brokerage!.holdings.find((h) => h.ticker === "VTI")).toMatchObject({ accountId: B, securityName: "Vanguard Total Stock Market ETF", assetClass: "us_stock", quantity: "40", valueCents: "1250000", costBasisCents: "1080000", lotCount: 2 });
    expect(brokerage!.holdings.find((h) => h.securityId === null)).toMatchObject({ securityName: "Cash", assetClass: "cash", valueCents: "143200" });
    expect(roth).toMatchObject({ accountId: R, method: "modified_dietz", fidelity: "positions", startValueCents: "1500000", endValueCents: "1820000" });
    expect(roth!.twr.rate).toBeCloseTo(0.2133333, 6);
    expect(roth!.benchmark).toMatchObject({ shadowValueCents: "1802885" });
    expect(view.total).toMatchObject({ accountIds: expect.arrayContaining([B, R]), partialGains: true, gains: expect.objectContaining({ unrealizedCents: "327000", realizedCents: "0" }) });
    expect(view.total.xirr.annualized).toBeCloseTo(0.1403348, 6);
    expect(view.benchmark).toMatchObject({ securityId: A.S.securities.vti, shadowValueCents: "4745524" });
    expect(await tableCounts()).toEqual(before);

    const viewer = await performance({ from: "2025-10-13", to: "2026-10-13", today: TODAY }, await viewerCookies(A.t));
    expect(viewer.statusCode).toBe(200);
    expect((viewer.json() as PerformanceResponse).total.endValueCents).toBe(view.total.endValueCents);
  });

  it("fills sub-periods, flows, lots and disposals at full detail", async () => {
    const res = await performance({ from: "2025-10-13", to: "2026-10-13", today: TODAY, detail: "full" });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as PerformanceResponse;
    const brokerage = view.accounts.find((a) => a.accountId === B)!;
    // B: V(2025-10-13) 2 000 000; V(04-12) 1 830 000 + 200 000 + 8 360 = 2 038 360; +500 000 on 04-13; V(10-13) 2 705 200.
    expect(brokerage.subPeriods.map((s) => [s.from, s.to, s.beginValueCents, s.flowCents, s.endValueCents])).toEqual([
      ["2025-10-13", "2026-04-12", "2000000", "0", "2038360"],
      ["2026-04-12", "2026-10-13", "2038360", "500000", "2705200"],
    ]);
    expect(brokerage.flows).toContainEqual(expect.objectContaining({ date: "2026-04-13", amountCents: "500000", kind: "cash", source: "ledger", accountId: B, counterpartyAccountId: A.S.accounts.checking, counterpartyAccountName: "Checking", internal: false }));
    expect(brokerage.xirr.investorFlows.length).toBeGreaterThan(0);
    expect(brokerage.lots).toHaveLength(4);
    // The 2024-03-01 VTI lot: 20 @ 250 (5 000.00), valued at the 10-13 close of 312.5 → 6 250.00, long term.
    const first = brokerage.lots.find((l) => l.openedByTxnId === A.S.txns["buyVti1"])!;
    expect(first).toMatchObject({ id: A.lotIds["buyVti1"], accountName: "Vanguard Brokerage", ticker: "VTI", securityName: "Vanguard Total Stock Market ETF", openedBy: "buy", acquiredDate: "2024-03-01", quantity: "20", costBasisCents: "500000", basisPerShare: "250", basisKnown: true, priceDate: "2026-10-13", valueCents: "625000", unrealizedCents: "125000", term: "long" });
    expect(brokerage.disposals).toEqual([]);
    expect(brokerage.benchmark!.legs.length).toBeGreaterThan(0);
    expect(view.total.subPeriods.length).toBeGreaterThan(0);
  });

  it("validates the window, the accounts and the benchmark", async () => {
    const code = async (payload: Record<string, unknown>) => {
      const res = await performance(payload);
      expect(res.statusCode).toBe(400);
      return res.json().code as string;
    };
    expect(await code({ from: "2026-10-13", to: "2026-10-13", today: TODAY })).toBe("validation");
    expect(await code({ from: "2026-10-01", to: "2026-10-15", today: TODAY })).toBe("validation");
    expect(await code({ from: "2026-10-01", to: "2026-10-13", asOf: "2026-10-15", today: TODAY })).toBe("validation");
    expect(await code({ from: "2026-10-01", to: "2026-10-13", today: TODAY, accountIds: [A.S.accounts.checking] })).toBe("bad_request");
    expect(await code({ from: "2026-10-01", to: "2026-10-13", today: TODAY, benchmarkSecurityId: A.S.securities.cash })).toBe("validation");
    expect(await code({ from: "2026-10-01", to: "2026-10-13", today: "2026-10-20" })).toBe("today_out_of_range");
    const none = (await performance({ from: "2025-10-13", to: "2026-10-13", today: TODAY, benchmarkSecurityId: null, accountIds: [R] })).json() as PerformanceResponse;
    expect(none.benchmark).toBeNull();
    expect(none.accounts.map((a) => a.accountId)).toEqual([R]);
  });

  it("lists lots valued as of a date with the position check", async () => {
    const res = await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${B}&today=${TODAY}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as LotsResponse;
    expect(view.asOf).toBe(TODAY);
    expect(view.lots).toHaveLength(4);
    expect(view.accounts).toEqual([{ accountId: B, fidelity: "full_history", lotMethod: "fifo", positionCheckDate: "2026-10-13", warnings: [] }]);
    // The 2026-04-14 VTI lot: 20 @ 290, valued at 312.5 → 625 000 − 580 000; six months old is short term.
    expect(view.lots.find((l) => l.openedByTxnId === A.S.txns["buyVti2"])).toMatchObject({ quantity: "20", costBasisCents: "580000", basisPerShare: "290", valueCents: "625000", unrealizedCents: "45000", term: "short", priceDate: "2026-10-13" });
    const vti = (await A.t.call({ method: "GET", url: `/api/investments/lots?securityId=${A.S.securities.vti}&today=${TODAY}` })).json() as LotsResponse;
    expect(vti.lots.map((l) => l.ticker)).toEqual(["VTI", "VTI"]);
    const roth = (await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${R}&today=${TODAY}` })).json() as LotsResponse;
    expect(roth.lots).toEqual([]);
    expect(roth.accounts).toEqual([{ accountId: R, fidelity: "positions", lotMethod: "fifo", positionCheckDate: null, warnings: [] }]);
    expect((await A.t.call({ method: "GET", url: `/api/investments/lots?asOf=2026-10-15&today=${TODAY}` })).statusCode).toBe(400);
  });

  it("reads realized gains from the disposal cache", async () => {
    const res = await A.t.call({ method: "GET", url: "/api/investments/realized?from=2026-01-01&to=2026-10-14" });
    expect(res.statusCode).toBe(200);
    const view = res.json() as RealizedGainsResponse;
    expect(view).toMatchObject({ from: "2026-01-01", to: "2026-10-14", disposals: [], summary: { shortTerm: { count: 0, gainCents: "0" }, longTerm: { count: 0 }, washSalesApplied: false } });
    const backwards = await A.t.call({ method: "GET", url: "/api/investments/realized?from=2026-10-14&to=2026-01-01" });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().code).toBe("validation");
  });

  it("rebuilds every account's lots idempotently and keeps lot picks and rebuilds from viewers", async () => {
    const res = await A.t.call({ method: "POST", url: "/api/investments/lots/rebuild", payload: {} });
    expect(res.statusCode).toBe(200);
    const view = res.json() as RebuildLotsResponse;
    expect(view).toMatchObject({ lots: 4, disposals: 0, warnings: [] });
    expect(view.accounts).toBeGreaterThanOrEqual(1);
    const one = (await A.t.call({ method: "POST", url: "/api/investments/lots/rebuild", payload: { accountId: B } })).json() as RebuildLotsResponse;
    expect(one).toEqual({ accounts: 1, lots: 4, disposals: 0, warnings: [] });
    const notSale = await A.t.call({ method: "PUT", url: `/api/investments/txns/${A.S.txns["buyVti1"]}/lot-picks`, payload: { picks: [] } });
    expect(notSale.statusCode).toBe(400);
    expect(notSale.json().code).toBe("not_a_sale");

    const cookies = await viewerCookies(A.t);
    for (const url of [`/api/investments/lots?today=${TODAY}`, "/api/investments/realized?from=2026-01-01&to=2026-10-14"]) {
      expect((await A.t.app.inject({ method: "GET", url, cookies })).statusCode, url).toBe(200);
    }
    const rebuild = await A.t.app.inject({ method: "POST", url: "/api/investments/lots/rebuild", payload: {}, cookies });
    expect(rebuild.statusCode).toBe(403);
    expect(rebuild.json().code).toBe("viewer");
    const picks = await A.t.app.inject({ method: "PUT", url: `/api/investments/txns/${A.S.txns["buyVti1"]}/lot-picks`, payload: { picks: [] }, cookies });
    expect(picks.statusCode).toBe(403);
  });
});

/**
 * A custom period that ends before a later sale (the Performance page sends `asOf = to`). One
 * brokerage: +1,000.00 on 01-02, 10 ACME bought @ 100.00 on 01-05, 4 sold @ 150.00 on 09-01;
 * closes 120 on 06-30, 150 on 09-01, 160 on 10-13. By hand on 06-30: 10 shares worth 1,200.00 on
 * a basis of 1,000.00, +200.00 unrealized, nothing realized, no cash. On 10-13: 6 shares worth
 * 960.00 on a basis of 600.00, cash 600.00, 200.00 realized.
 */
describe.skipIf(!TEST_DATABASE_URL)("performance and lots as of a date before a later sale", () => {
  let A: InvestmentApp;
  let accountId = "";
  let acme = "";

  beforeAll(async () => {
    A = await freshInvestmentApp();
    const send = async <T>(method: "POST" | "PUT", url: string, payload: object): Promise<T> => {
      const res = await A.t.call({ method, url, payload });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
      return res.json() as T;
    };
    accountId = (await send<AccountView>("POST", "/api/accounts", { name: "As-of Brokerage", type: "brokerage" })).id;
    acme = (await send<SecurityView>("POST", "/api/investments/securities", { ticker: "ACME", name: "Acme Corp", type: "stock", assetClass: "us_stock" })).id;
    const txn = (body: object) => send("POST", "/api/investments/txns", { accountId, today: TODAY, ...body });
    await txn({ type: "transfer", direction: "in", date: "2026-01-02", amountCents: "100000" });
    await txn({ type: "buy", date: "2026-01-05", securityId: acme, quantity: "10", price: "100" });
    await txn({ type: "sell", date: "2026-09-01", securityId: acme, quantity: "4", price: "150" });
    for (const [date, close] of [["2026-06-30", "120"], ["2026-09-01", "150"], ["2026-10-13", "160"]] as const) await send("PUT", `/api/prices/${acme}/${date}`, { close, today: TODAY });
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const performance = async (to: string) => {
    const res = await A.t.call({ method: "POST", url: "/api/investments/performance", payload: { accountIds: [accountId], from: "2026-01-01", to, asOf: to, today: TODAY, detail: "full", benchmarkSecurityId: null } });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as PerformanceResponse).accounts[0]!;
  };
  const lots = async (asOf: string) => {
    const res = await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${accountId}&asOf=${asOf}&today=${TODAY}` });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as LotsResponse).lots.map((l) => [l.quantity, l.costBasisCents, l.valueCents, l.unrealizedCents, l.term]);
  };

  const holdingRows = async (asOf: string) => {
    const res = await A.t.call({ method: "GET", url: `/api/investments/holdings?accountId=${accountId}&asOf=${asOf}&today=${TODAY}` });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as HoldingsView).rows.map((r) => [r.ticker ?? r.name, r.quantity, r.valueCents, r.costBasisCents, r.gainCents]);
  };

  it("to 06-30: the end value, the holdings, the lots and the gains all describe the ten shares held that day", async () => {
    const a = await performance("2026-06-30");
    expect(a.endValueCents).toBe("120000");
    expect(a.holdings.map((h) => [h.ticker ?? h.securityName, h.quantity, h.valueCents, h.costBasisCents, h.unrealizedCents])).toEqual([
      ["ACME", "10", "120000", "100000", "20000"],
      ["Cash", "0", "0", null, null],
    ]);
    expect(a.gains).toMatchObject({ realizedCents: "0", realizedShortCents: "0", unrealizedCents: "20000", totalGainCents: "20000", proceedsCents: "0", openValueCents: "120000", openBasisCents: "100000" });
    expect(a.realized).toMatchObject({ shortTerm: { count: 0, gainCents: "0" } });
    expect(a.lots.map((l) => [l.quantity, l.costBasisCents, l.valueCents, l.unrealizedCents, l.term, l.priceDate, l.closedDate])).toEqual([["10", "100000", "120000", "20000", "short", "2026-06-30", null]]);
    expect(a.disposals).toEqual([]);
    expect(await lots("2026-06-30")).toEqual([["10", "100000", "120000", "20000", "short"]]);
    // The Holdings page on the same date agrees; its cash row nets the 1,000.00 put in against the 1,000.00 spent, at no gain.
    expect(await holdingRows("2026-06-30")).toEqual([
      ["ACME", "10", "120000", "100000", "20000"],
      ["Cash (USD)", null, "0", "0", "0"],
    ]);
  });

  it("to 10-13: six shares, the cash from the sale and the realized gain", async () => {
    const a = await performance("2026-10-13");
    expect(a.endValueCents).toBe("156000");
    expect(a.holdings.map((h) => [h.ticker ?? h.securityName, h.quantity, h.valueCents, h.costBasisCents, h.unrealizedCents])).toEqual([
      ["ACME", "6", "96000", "60000", "36000"],
      ["Cash", "600", "60000", null, null],
    ]);
    expect(a.gains).toMatchObject({ realizedCents: "20000", realizedShortCents: "20000", unrealizedCents: "36000", totalGainCents: "56000", proceedsCents: "60000" });
    expect(a.realized).toMatchObject({ shortTerm: { count: 1, proceedsCents: "60000", basisCents: "40000", gainCents: "20000" } });
    expect(a.lots.map((l) => [l.quantity, l.costBasisCents, l.valueCents, l.unrealizedCents])).toEqual([["6", "60000", "96000", "36000"]]);
    expect(a.disposals.map((d) => [d.date, d.quantity, d.gainCents])).toEqual([["2026-09-01", "4", "20000"]]);
    expect(await lots("2026-10-13")).toEqual([["6", "60000", "96000", "36000", "short"]]);
    // Cash: 1,000.00 in − 1,000.00 spent + 600.00 from the sale; cash has no gain.
    expect(await holdingRows("2026-10-13")).toEqual([
      ["ACME", "6", "96000", "60000", "36000"],
      ["Cash (USD)", null, "60000", "60000", "0"],
    ]);
  });
});
