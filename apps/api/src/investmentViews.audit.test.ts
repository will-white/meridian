import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { account, holdingSnapshot, price, security } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import { DashboardView, type HoldingsView, type PerformanceView, type PortfolioView } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, type InvestmentApp } from "./test/investments.js";

/**
 * Audit batch b6-investment-views at the routes (docs/audit/phases-1-3/b6-investment-views.md):
 * includeClosed on the Portfolio and Performance routes (b6-06), the Performance page's
 * readable warnings (b6-10) and the Holdings contract for inferred cash without a cash
 * security (b6-03). Each case runs on a fresh INV seed.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("audit b6: investment view routes", () => {
  let A: InvestmentApp | undefined;
  afterEach(async () => {
    await A?.t.cleanup();
    A = undefined;
  });
  const get = async <T>(app: InvestmentApp, url: string): Promise<T> => {
    const res = await app.t.call({ method: "GET", url });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return res.json() as T;
  };

  it("b6-06: includeClosed=true lists a closed account on the Portfolio (no 400) and on the Performance page", async () => {
    A = await freshInvestmentApp({ lots: true });
    const { roth: R, brokerage: B } = A.S.accounts;
    await A.t.db.db.update(account).set({ closed: true }).where(eq(account.id, R));

    const open = await get<PortfolioView>(A, `/api/investments/portfolio?today=${TODAY}&period=1m`);
    expect(open.accounts.map((a) => a.accountId)).toEqual([B]);
    const portfolio = await get<PortfolioView>(A, `/api/investments/portfolio?today=${TODAY}&period=1m&includeClosed=true`);
    expect(portfolio.accounts.map((a) => [a.accountName, a.closed])).toEqual([
      ["Fidelity Roth IRA", true],
      ["Vanguard Brokerage", false],
    ]);
    expect(portfolio.totalCents).toBe("4525200");

    const perfOpen = await get<PerformanceView>(A, `/api/investments/performance?today=${TODAY}&period=1y`);
    expect(perfOpen.accounts.map((a) => a.accountName)).toEqual(["Vanguard Brokerage"]);
    const perf = await get<PerformanceView>(A, `/api/investments/performance?today=${TODAY}&period=1y&includeClosed=true`);
    expect(perf.accounts.map((a) => a.accountName)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    expect(perf.total!.endValueCents).toBe("4525200");
    // A closed account named explicitly needs includeClosed as well.
    const named = await A.t.call({ method: "GET", url: `/api/investments/performance?today=${TODAY}&period=1y&accountIds=${R}` });
    expect(named.statusCode).toBe(400);
    const namedClosed = await get<PerformanceView>(A, `/api/investments/performance?today=${TODAY}&period=1y&accountIds=${R}&includeClosed=true`);
    expect(namedClosed.accounts.map((a) => a.accountName)).toEqual(["Fidelity Roth IRA"]);
  });

  it("b6-10: the Performance page's warnings read as sentences, never as engine codes", async () => {
    A = await freshInvestmentApp({ lots: true });
    // From 2025-11-12 no account has a value on the start date: the Roth's 2025-10-13 balance is carried to it.
    const view = await get<PerformanceView>(A, `/api/investments/performance?today=${TODAY}&period=custom&from=2025-11-12&to=2026-10-13`);
    const roth = view.accounts.find((a) => a.accountId === A!.S.accounts.roth)!.block;
    expect(roth.warnings.map((w) => w.code)).toContain("valuation_carried");
    expect(roth.readable).toContain("No value is recorded on 2025-11-12; the latest earlier statement or balance was carried to it.");
    const all = [view.total, ...view.accounts.map((a) => a.block)].flatMap((b) => b?.readable ?? []);
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) expect(line, line).not.toMatch(/^[a-z_]+:/);
  });

  it("b6-03: the Holdings route answers with the inferred-cash row when the household has no cash security", async () => {
    A = await freshInvestmentApp({ lots: true });
    await A.t.db.db.delete(holdingSnapshot).where(eq(holdingSnapshot.securityId, A.S.securities.cash));
    await A.t.db.db.delete(security).where(eq(security.id, A.S.securities.cash));
    const h = await get<HoldingsView>(A, `/api/investments/holdings?today=${TODAY}`);
    expect(h.rows.reduce((acc, r) => acc + BigInt(r.valueCents), 0n)).toBe(BigInt(h.totalCents));
    expect(h.rows.find((r) => r.type === "cash")).toMatchObject({ securityId: null, name: "Cash (USD)", valueCents: "170200", quantity: "1702" });
    expect(h.warnings).toEqual([]);
  });

  it("b6-08, second round: the Dashboard's investments card says when the day change is measured from a carried close", async () => {
    A = await freshInvestmentApp({ lots: true });
    // No BND close on 10-12: the change is measured from the 10-09 close for that line.
    await A.t.db.db.delete(price).where(and(eq(price.securityId, A.S.securities.bnd), eq(price.date, "2026-10-12")));
    const portfolio = await get<PortfolioView>(A, `/api/investments/portfolio?today=${TODAY}&period=1m`);
    expect(portfolio.dayChange).toMatchObject({ prior: "2026-10-12", asOf: "2026-10-13", carriedPrior: { date: "2026-10-09", sources: ["provider"] } });
    const dash = await get<DashboardView>(A, `/api/dashboard?today=${TODAY}`);
    expect(dash.investments).toMatchObject({
      dayChangeCents: portfolio.dayChange.cents,
      dayChangeBp: portfolio.dayChange.bp,
      dayChangePrior: "2026-10-12",
      dayChangeAsOf: "2026-10-13",
      dayChangeCarriedPrior: { date: "2026-10-09", sources: ["provider"] },
    });
    expect(DashboardView.safeParse(dash).success).toBe(true);
  });
});
