import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, balanceSnapshot, holdingSnapshot, job, lot, price } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type { ValuationSeriesResponse, ValuationSummaryResponse } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Valuation routes on the INV seed (prices design §4.1; the valuation service test's numbers:
 * 4 525 200 on 10-13, day change +36 000 (80 bp), the 1y period change 1 025 200 = 500 000 flows
 * + 525 200 growth, the 366-point series). `asOf` is the date parameter, `accountIds` is
 * comma-separated; a non-investment account is 400 `bad_request`. Reads only, viewer-callable.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("valuation routes", () => {
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
    for (const [name, table] of Object.entries({ job, auditLog, lot, price, balanceSnapshot, holdingSnapshot })) out[name] = (await A.t.db.db.select({ n: count() }).from(table))[0]!.n;
    return out;
  };
  const summary = async (query: string) => {
    const res = await A.t.call({ method: "GET", url: `/api/valuation/summary${query}` });
    return { res, view: res.json() as ValuationSummaryResponse };
  };

  it("values the household on 10-13 by the chain with day and 1y period change, zero writes, identical for a viewer", async () => {
    const before = await tableCounts();
    const { res, view } = await summary(`?today=${TODAY}&asOf=2026-10-13&period=1y`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(view).toMatchObject({ asOf: "2026-10-13", today: TODAY, expectedDate: "2026-10-13", totalCents: "4525200", partial: false, missing: [], priceStatus: "implied" });
    expect(view.dayChange).toEqual({ cents: "36000", asOf: "2026-10-13", prior: "2026-10-12", reason: null, bp: 80, partial: false, excluded: [] });
    expect(view.periodChange).toEqual({
      period: "1y",
      from: "2025-10-13",
      to: "2026-10-13",
      startCents: "3500000",
      endCents: "4525200",
      changeCents: "1025200",
      changeBp: 2929,
      netFlowsCents: "500000",
      growthCents: "525200",
      growthReason: null,
      incomeCents: "32435",
      uncategorizedRows: 1,
      newAccounts: [],
    });
    expect(view.accounts.map((a) => a.name)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = view.accounts;
    expect(brokerage).toMatchObject({
      accountId: B,
      type: "brokerage",
      taxTreatment: "taxable",
      fidelity: "full_history",
      cashInference: "auto",
      date: "2026-10-13",
      basis: "snapshot",
      asOf: "2026-10-13",
      valueCents: "2705200",
      priceStatus: "current",
      stalest: null,
      missing: [],
      balanceDiffCents: "0",
      cashAnchor: "2026-10-13",
      dayChange: { cents: "32000", asOf: "2026-10-13", prior: "2026-10-12", reason: null },
      lastReconciliation: null,
      warnings: [],
    });
    expect(brokerage!.lines.find((l) => l.kind === "cash_plug")).toMatchObject({ securityId: null, name: "Cash (from balance)", valueCents: "143200", priceDate: "2026-10-13", valueSource: "carried" });
    // Lines come in security id order; compare them by ticker.
    expect(
      brokerage!.lines
        .filter((l) => l.kind === "position")
        .map((l) => [l.ticker, l.quantity, l.price, l.valueCents, l.priceSource, l.priceStatus])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["AAPL", "25", "240", "600000", "statement", "statement"],
      ["VTI", "40", "312.5", "1250000", "statement", "statement"],
      ["VXUS", "100", "71.2", "712000", "statement", "statement"],
    ]);
    expect(roth).toMatchObject({ accountId: R, fidelity: "positions", basis: "positions", asOf: "2026-10-09", valueCents: "1820000", cashAnchor: "2026-10-09", priceStatus: "implied", dayChange: { cents: "4000" } });
    expect(roth!.lines.find((l) => l.securityId === A.S.securities.cash)).toMatchObject({ kind: "cash", quantity: "270", price: "1", valueCents: "27000", priceSource: "cash", priceStatus: "cash" });
    expect(roth!.lines.find((l) => l.securityId === A.S.securities.tr2050)).toMatchObject({ valueCents: "420000", priceStatus: "implied", valueSource: "carried" });

    const viewer = await A.t.app.inject({ method: "GET", url: `/api/valuation/summary?today=${TODAY}&asOf=2026-10-13&period=1y`, cookies: await viewerCookies(A.t) });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.body).toBe(res.body);
    expect((await summary(`?today=${TODAY}&asOf=2026-10-13&period=1y`)).res.body).toBe(res.body);
    expect(await tableCounts()).toEqual(before);
  });

  it("defaults asOf to today, selects accounts by a comma-separated list, and validates asOf and the accounts", async () => {
    const { view: today } = await summary(`?today=${TODAY}`);
    expect(today).toMatchObject({ asOf: TODAY, expectedDate: "2026-10-13", totalCents: "4525200" });
    expect(today.periodChange).toMatchObject({ period: "1m", to: TODAY });

    const { view: only } = await summary(`?today=${TODAY}&asOf=2026-10-13&accountIds=${B}`);
    expect(only.accounts.map((a) => a.accountId)).toEqual([B]);
    expect(only.totalCents).toBe("2705200");
    const { view: both } = await summary(`?today=${TODAY}&asOf=2026-10-13&accountIds=${B},${R}`);
    expect(both.accounts).toHaveLength(2);

    const { view: d12 } = await summary(`?today=${TODAY}&asOf=2026-10-12`);
    expect(d12.totalCents).toBe("4489200");
    expect(d12.dayChange).toMatchObject({ cents: "0", bp: 0, asOf: "2026-10-12", prior: "2026-10-09" });

    const checking = await A.t.call({ method: "GET", url: `/api/valuation/summary?today=${TODAY}&accountIds=${A.S.accounts.checking}` });
    expect(checking.statusCode).toBe(400);
    expect(checking.json()).toMatchObject({ code: "bad_request" });
    const future = await A.t.call({ method: "GET", url: `/api/valuation/summary?today=${TODAY}&asOf=2026-10-15` });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ code: "validation" });
    expect((await A.t.call({ method: "GET", url: `/api/valuation/summary?today=${TODAY}&accountIds=nope` })).statusCode).toBe(400);
    expect((await A.t.call({ method: "GET", url: `/api/valuation/summary?today=${TODAY}&period=custom` })).statusCode).toBe(400);
    const custom = (await summary(`?today=${TODAY}&asOf=2026-10-13&period=custom&from=2026-10-09`)).view;
    expect(custom.periodChange).toMatchObject({ period: "custom", from: "2026-10-09", to: "2026-10-13", startCents: "4489200", changeCents: "36000" });
  });

  it("builds the value series: 366 daily points from 3 500 000 to 4 525 200, per-account values and first data dates; weekly and monthly steps; range validation", async () => {
    const res = await A.t.call({ method: "GET", url: `/api/valuation/series?today=${TODAY}&from=2025-10-13&to=2026-10-13` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as ValuationSeriesResponse;
    expect(view).toMatchObject({ from: "2025-10-13", to: "2026-10-13", expectedDate: "2026-10-13" });
    expect(view.dates).toHaveLength(366);
    expect(view.portfolio).toHaveLength(366);
    const at = (date: string) => view.portfolio[view.dates.indexOf(date)];
    expect(at("2025-10-13")).toEqual({ date: "2025-10-13", valueCents: "3500000", partial: false, missing: [], priceStatus: "current" });
    expect(at("2026-10-08")!.valueCents).toBe("4053200");
    expect(at("2026-10-09")!.valueCents).toBe("4489200");
    expect(at("2026-10-12")!.valueCents).toBe("4489200");
    expect(at("2026-10-13")!.valueCents).toBe("4525200");
    expect(view.accounts.map((a) => [a.name, a.type, a.fidelity, a.firstDataDate, a.values.length])).toEqual([
      ["Fidelity Roth IRA", "roth", "positions", "2025-10-13", 366],
      ["Vanguard Brokerage", "brokerage", "full_history", "2024-03-01", 366],
    ]);
    const roth = view.accounts.find((a) => a.accountId === R)!;
    expect(roth.values[view.dates.indexOf("2026-10-08")]).toBe("1500000");
    expect(roth.values[view.dates.indexOf("2026-10-09")]).toBe("1810000");
    expect(roth.values[view.dates.indexOf("2026-10-13")]).toBe("1820000");
    expect(view.accounts.find((a) => a.accountId === B)!.values[view.dates.indexOf("2026-04-12")]).toBe("2038360");

    const weekly = (await A.t.call({ method: "GET", url: `/api/valuation/series?today=${TODAY}&from=2026-10-05&to=2026-10-13&step=week` })).json() as ValuationSeriesResponse;
    expect(weekly.dates).toEqual(["2026-10-09", "2026-10-13"]);
    const monthly = (await A.t.call({ method: "GET", url: `/api/valuation/series?today=${TODAY}&from=2026-09-15&to=2026-10-13&step=month&accountIds=${R}` })).json() as ValuationSeriesResponse;
    expect(monthly.dates).toEqual(["2026-09-30", "2026-10-13"]);
    expect(monthly.accounts.map((a) => a.accountId)).toEqual([R]);

    for (const url of [
      `/api/valuation/series?today=${TODAY}&from=2026-10-13&to=2026-10-12`,
      `/api/valuation/series?today=${TODAY}&from=2026-10-01&to=2026-10-15`,
      `/api/valuation/series?today=${TODAY}&from=2016-10-01&to=2026-10-13`,
      `/api/valuation/series?today=${TODAY}&from=2026-10-01`,
      `/api/valuation/series?today=${TODAY}&from=2026-10-01&to=2026-10-13&accountIds=${A.S.accounts.checking}`,
    ]) {
      const bad = await A.t.call({ method: "GET", url });
      expect(bad.statusCode, url).toBe(400);
    }
  });
});
