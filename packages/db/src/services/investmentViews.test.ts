import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { impliedPrice, mulToCents, parseFixed8, quantityForCents, type IsoDate } from "@meridian/shared";
import { account, allocationTarget, auditLog, balanceSnapshot, holdingSnapshot, investmentTxn, job, price, security } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { setAllocationTargets } from "./allocationTargets.js";
import { getDashboard } from "./dashboard.js";
import { deleteInvestmentTxn } from "./investmentTxns.js";
import { rebuildLotsForAccounts } from "./lots.js";
import {
  bp,
  classifiedLines,
  getAccountChanges,
  getAllocation,
  getHoldings,
  getPortfolio,
  investmentContext,
  ppmWeighted,
  rebalanceInputOf,
  splitValue,
  suggestRebalance,
  type RebalanceInput,
} from "./investmentViews.js";
import { commitReconciliation } from "./reconcile.js";
import { updateHouseholdSetting } from "./settings.js";

const f8 = parseFixed8;
const TODAY = INV_SEED_TODAY;
const NOW = INV_SEED_NOW;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });

describe("investment view helpers (views test 1)", () => {
  it("Fixed8 conversions used by the views", () => {
    expect(mulToCents(f8("40"), f8("312.5"))).toBe(1250000n);
    expect(mulToCents(f8("0.00000001"), f8("312.5"))).toBe(0n);
    expect(mulToCents(f8("3"), f8("0.005"))).toBe(2n);
    expect(mulToCents(f8("-3"), f8("0.005"))).toBe(-2n);
    expect(mulToCents(f8("100"), f8("42"))).toBe(420000n);
    expect(quantityForCents(439200n, f8("312.5"))).toBe(f8("14.0544"));
    expect(quantityForCents(115040n, f8("74.8"))).toBe(f8("15.37967914"));
    expect(quantityForCents(0n, f8("312.5"))).toBe(0n);
    expect(() => quantityForCents(1n, 0n)).toThrow();
    expect(impliedPrice(420000n, f8("100"))).toBe(f8("42"));
    expect(impliedPrice(1000000n, f8("3"))).toBe(f8("3333.33333333"));
  });

  it("bp truncates toward zero and is null without a positive total", () => {
    expect(bp(2701800n, 4525200n)).toBe(5970);
    expect(bp(170000n, 1080000n)).toBe(1574);
    expect(bp(1n, 0n)).toBeNull();
    expect(bp(-1234n, 100000n)).toBe(-123);
  });

  it("ppmWeighted counts unknown stock/cash ratios as 0 and excludes unknown fund ratios", () => {
    const rows = [
      { valueCents: 1875000n, ppm: 300, type: "etf" as const },
      { valueCents: 712000n, ppm: 500, type: "etf" as const },
      { valueCents: 748000n, ppm: 300, type: "etf" as const },
      { valueCents: 600000n, ppm: null, type: "stock" as const },
      { valueCents: 420000n, ppm: 800, type: "fund" as const },
      { valueCents: 170200n, ppm: null, type: "cash" as const },
    ];
    expect(ppmWeighted(rows)).toEqual({ ppm: 326, coveredCents: 4525200n, totalCents: 4525200n, annualCostCents: 1478n });
    expect(ppmWeighted(rows.map((r) => (r.type === "fund" ? { ...r, ppm: null } : r)))).toEqual({ ppm: 278, coveredCents: 4105200n, totalCents: 4525200n, annualCostCents: 1142n });
    expect(ppmWeighted([{ valueCents: 100n, ppm: null, type: "stock" }, { valueCents: 50n, ppm: null, type: "cash" }]).ppm).toBe(0);
    expect(ppmWeighted([{ valueCents: 100n, ppm: null, type: "etf" }])).toMatchObject({ ppm: null, coveredCents: 0n });
  });

  it("splitValue truncates per split and puts the remainder on the primary class", () => {
    const splits = (us: number, intl: number, bonds: number) => [
      { assetClass: "us_stock" as const, weightBp: us },
      { assetClass: "intl_stock" as const, weightBp: intl },
      { assetClass: "bonds" as const, weightBp: bonds },
    ];
    expect([...splitValue(420000n, splits(5400, 3600, 1000), "us_stock")]).toEqual([
      ["us_stock", 226800n],
      ["intl_stock", 151200n],
      ["bonds", 42000n],
    ]);
    expect([...splitValue(1000001n, splits(3334, 3333, 3333), "us_stock")]).toEqual([
      ["us_stock", 333401n],
      ["intl_stock", 333300n],
      ["bonds", 333300n],
    ]);
    expect([...splitValue(500n, [], "bonds")]).toEqual([["bonds", 500n]]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("investment views on the INV seed (views tests 2–10, 16, 17, 19)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let B: string;
  let R: string;
  const q = { today: TODAY, now: NOW };

  const tableCounts = async () => ({
    audit: (await t.db.select().from(auditLog)).length,
    snapshots: (await t.db.select().from(holdingSnapshot)).length,
    balances: (await t.db.select().from(balanceSnapshot)).length,
    prices: (await t.db.select().from(price)).length,
    jobs: (await t.db.select().from(job)).length,
  });

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    B = S.accounts.brokerage;
    R = S.accounts.roth;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("portfolio (test 2 through the chain): totals, day change, 1y period change, the per-account blocks and the series", async () => {
    const p = await getPortfolio(t.db, { ...q, period: "1y" });
    expect(p).toMatchObject({ today: TODAY, asOf: "2026-10-13", totalCents: 4525200n, fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 } });
    expect(p.period).toEqual({ kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null });
    expect(p.dayChange).toMatchObject({ cents: 36000n, bp: 80, asOf: "2026-10-13", prior: "2026-10-12", partial: false });
    expect(p.periodChange).toMatchObject({ from: "2025-10-13", to: "2026-10-13", startCents: 3500000n, endCents: 4525200n, changeCents: 1025200n, changeBp: 2929, netFlowsCents: 500000n, growthCents: 525200n, incomeCents: 32435n, uncategorizedRows: 1 });
    expect(p.accounts.map((a) => a.accountName)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = p.accounts;
    expect(roth).toMatchObject({
      fidelity: "positions",
      fidelityNote: null,
      basis: "positions",
      valueCents: 1820000n,
      valuationDate: "2026-10-13",
      valuationSource: "computed",
      valuationStale: false,
      positionsDate: "2026-10-09",
      positionsStale: false,
      dayChangeCents: 4000n,
      dayChangeBp: 22,
      holdingsCount: 4,
      cashCents: 27000n,
      residualCents: 0n,
      closed: false,
      investmentIncomeFeed: "off",
      warnings: [],
    });
    expect(roth!.period).toMatchObject({ startCents: 1500000n, endCents: 1820000n, changeCents: 320000n, changeBp: 2133, netFlowsCents: 0n, growthCents: 320000n, incomeCents: 9235n, uncategorizedRows: 0 });
    expect(brokerage).toMatchObject({
      fidelity: "full_history",
      fidelityNote: null,
      basis: "snapshot",
      valueCents: 2705200n,
      valuationDate: "2026-10-13",
      valuationSource: "simplefin",
      positionsDate: "2026-10-13",
      dayChangeCents: 32000n,
      dayChangeBp: 119,
      holdingsCount: 3,
      cashCents: 0n,
      residualCents: 143200n,
      investmentIncomeFeed: "link",
    });
    expect(brokerage!.period).toMatchObject({ startCents: 2000000n, changeCents: 705200n, changeBp: 3526, netFlowsCents: 500000n, growthCents: 205200n, incomeCents: 23200n, uncategorizedRows: 1 });
    expect(p.series.step).toBe(1);
    expect(p.series.dates).toHaveLength(366);
    const at = (date: IsoDate) => p.series.total[p.series.dates.indexOf(date)];
    expect(at("2025-10-13")).toBe(3500000n);
    // The chain prices B from its lots between statements (step 8's recorded deviation from the balance-carried 3,500,000).
    expect(at("2026-10-08")).toBe(4053200n);
    expect(at("2026-10-09")).toBe(4489200n);
    expect(at("2026-10-12")).toBe(4489200n);
    expect(p.series.total[p.series.total.length - 1]).toBe(4525200n);
    const rPoints = p.series.accounts.find((a) => a.accountId === R)!.points;
    expect(rPoints[p.series.dates.indexOf("2026-10-08")]).toBe(1500000n);
    expect(rPoints[p.series.dates.indexOf("2026-10-09")]).toBe(1810000n);
    expect(rPoints[p.series.dates.indexOf("2026-10-12")]).toBe(1816000n);
    expect(rPoints[p.series.dates.indexOf("2026-10-13")]).toBe(1820000n);
    expect(p.warnings).toContain("1 uncategorized row in Vanguard Brokerage is neither a transfer nor income; mark it if it is a contribution or withdrawal");

    await expect(getPortfolio(t.db, { ...q, period: "custom", from: "2026-10-13", to: "2026-10-12" })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getPortfolio(t.db, { ...q, asOf: "2026-10-15" })).rejects.toMatchObject({ status: 400, code: "validation" });
    const d12 = await getPortfolio(t.db, { ...q, asOf: "2026-10-12", period: "1m" });
    expect(d12).toMatchObject({ totalCents: 4489200n });
    expect(d12.dayChange).toMatchObject({ prior: "2026-10-09", cents: 0n, bp: 0 });
  });

  it("allocation without targets (test 4): classes in enum order, lines, by tax treatment and by account", async () => {
    await t.db.delete(allocationTarget);
    const a = await getAllocation(t.db, q);
    expect(a).toMatchObject({ asOf: "2026-10-13", totalCents: 4525200n, classifiedCents: 4525200n, unclassifiedCents: 0n, targetsSet: false, rebalance: null, unclassifiedAccounts: [], warnings: [] });
    expect(a.classes.map((c) => [c.assetClass, c.currentCents, c.currentBp, c.targetBp, c.driftBp, c.outOfBand])).toEqual([
      ["us_stock", 2701800n, 5970, null, null, false],
      ["intl_stock", 863200n, 1907, null, null, false],
      ["bonds", 790000n, 1745, null, null, false],
      ["cash", 170200n, 376, null, null, false],
      ["real_estate", 0n, 0, null, null, false],
      ["other", 0n, 0, null, null, false],
    ]);
    const us = a.classes[0]!;
    expect(us.lines.map((l) => [l.ticker ?? l.name, l.accountId, l.cents, l.kind, l.blended])).toEqual([
      ["VTI", B, 1250000n, "position", false],
      ["VTI", R, 625000n, "position", false],
      ["AAPL", B, 600000n, "position", false],
      ["Vanguard Target Retirement 2050 Trust", R, 226800n, "position", true],
    ]);
    expect(a.classes[1]!.lines.map((l) => [l.ticker ?? l.name, l.cents, l.blended])).toEqual([
      ["VXUS", 712000n, false],
      ["Vanguard Target Retirement 2050 Trust", 151200n, true],
    ]);
    expect(a.classes[2]!.lines.map((l) => [l.ticker, l.cents])).toEqual([
      ["BND", 748000n],
      [null, 42000n],
    ]);
    expect(a.classes[3]!.lines.map((l) => [l.name, l.accountId, l.cents, l.kind, l.securityId])).toEqual([
      ["Cash (from balance)", B, 143200n, "cash_plug", null],
      ["Cash (USD)", R, 27000n, "cash", S.securities.cash],
    ]);
    expect(a.byTaxTreatment.map((x) => [x.taxTreatment, x.cents, x.bp])).toEqual([
      ["taxable", 2705200n, 5978],
      ["roth", 1820000n, 4021],
    ]);
    const byAccount = new Map(a.byAccount.map((x) => [x.accountId, x]));
    expect(byAccount.get(B)!.classes).toEqual([
      { assetClass: "us_stock", cents: 1850000n, bp: 6838 },
      { assetClass: "intl_stock", cents: 712000n, bp: 2631 },
      { assetClass: "cash", cents: 143200n, bp: 529 },
    ]);
    expect(byAccount.get(R)!.classes).toEqual([
      { assetClass: "us_stock", cents: 851800n, bp: 4680 },
      { assetClass: "intl_stock", cents: 151200n, bp: 830 },
      { assetClass: "bonds", cents: 790000n, bp: 4340 },
      { assetClass: "cash", cents: 27000n, bp: 148 },
    ]);
  });

  it("targets 50/25/20/5 and the rebalance suggestion (test 5, the worked example of §3.7)", async () => {
    const c = ctx();
    const targets = [
      { assetClass: "us_stock" as const, targetBp: 5000 },
      { assetClass: "intl_stock" as const, targetBp: 2500 },
      { assetClass: "bonds" as const, targetBp: 2000 },
      { assetClass: "cash" as const, targetBp: 500 },
    ];
    await setAllocationTargets(t.db, targets, c);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId))).toHaveLength(1);
    await setAllocationTargets(t.db, targets, ctx());
    expect(await t.db.select().from(auditLog).where(eq(auditLog.entity, "allocation_target"))).toHaveLength(1);
    await expect(setAllocationTargets(t.db, [...targets.slice(0, 3), { assetClass: "cash", targetBp: 400 }], ctx())).rejects.toMatchObject({ status: 400, code: "allocation_sum" });

    const a = await getAllocation(t.db, q);
    expect(a.targetsSet).toBe(true);
    expect(a.classes.slice(0, 4).map((x) => [x.targetCents, x.driftBp, x.driftCents, x.outOfBand])).toEqual([
      [2262600n, 970, 439200n, true],
      [1131300n, -593, -268100n, true],
      [905040n, -255, -115040n, false],
      [226260n, -124, -56060n, false],
    ]);
    const r = a.rebalance!;
    expect(r).toMatchObject({ triggered: true, bandBp: 500, minTradeCents: 10000n, belowMinimumCents: 0n, residual: [] });
    expect(r.notes).toContain("Vanguard Target Retirement 2050 Trust is a blended fund and is held constant");
    expect(r.trades).toEqual([
      { accountId: R, accountName: "Fidelity Roth IRA", taxTreatment: "roth", action: "sell", assetClass: "us_stock", securityId: S.securities.vti, ticker: "VTI", inAccount: true, amountCents: 439200n, approxQuantity: f8("14.0544"), price: f8("312.5"), estimatedGainCents: null, note: null },
      {
        accountId: R,
        accountName: "Fidelity Roth IRA",
        taxTreatment: "roth",
        action: "buy",
        assetClass: "intl_stock",
        securityId: S.securities.vxus,
        ticker: "VXUS",
        inAccount: false,
        amountCents: 268100n,
        approxQuantity: f8("37.65449438"),
        price: f8("71.2"),
        estimatedGainCents: null,
        note: "VXUS or the plan's equivalent international stock fund (held in Vanguard Brokerage)",
      },
      { accountId: R, accountName: "Fidelity Roth IRA", taxTreatment: "roth", action: "buy", assetClass: "bonds", securityId: S.securities.bnd, ticker: "BND", inAccount: true, amountCents: 115040n, approxQuantity: f8("15.37967914"), price: f8("74.8"), estimatedGainCents: null, note: null },
      { accountId: R, accountName: "Fidelity Roth IRA", taxTreatment: "roth", action: "hold_cash", assetClass: "cash", securityId: null, ticker: null, inAccount: true, amountCents: 56060n, approxQuantity: null, price: null, estimatedGainCents: null, note: null },
    ]);
  });

  it("rebalance variants (test 6): not triggered, spill into taxable, cash over target, the minimum-trade pass, determinism, rank, blended-only", async () => {
    const set = async (us: number, intl: number, bonds: number, cash: number) =>
      setAllocationTargets(
        t.db,
        [
          { assetClass: "us_stock", targetBp: us },
          { assetClass: "intl_stock", targetBp: intl },
          { assetClass: "bonds", targetBp: bonds },
          { assetClass: "cash", targetBp: cash },
        ],
        ctx(),
      );
    const summary = (r: NonNullable<Awaited<ReturnType<typeof getAllocation>>["rebalance"]>) =>
      r.trades.map((x) => [x.accountId === R ? "R" : "B", x.action, x.ticker, x.amountCents, x.approxQuantity, x.inAccount, x.estimatedGainCents]);

    // (a)
    await set(5500, 2000, 2000, 500);
    const a = await getAllocation(t.db, q);
    expect(a.classes.slice(0, 4).map((x) => x.driftBp)).toEqual([470, -93, -255, -124]);
    expect(a.rebalance).toMatchObject({ triggered: false, trades: [] });

    // (b)
    await set(3000, 3000, 3000, 1000);
    const b = await getAllocation(t.db, q);
    expect(b.classes.slice(0, 4).map((x) => x.driftCents)).toEqual([1344240n, -494360n, -567560n, -282320n]);
    expect(summary(b.rebalance!)).toEqual([
      ["R", "sell", "VTI", 625000n, f8("20"), true, null],
      ["R", "buy", "BND", 567560n, f8("75.87700535"), true, null],
      ["R", "buy", "VXUS", 57440n, f8("8.06741573"), false, null],
      ["B", "sell", "VTI", 719240n, f8("23.01568"), true, 97816n],
      ["B", "buy", "VXUS", 436920n, f8("61.36516854"), true, null],
      ["B", "hold_cash", null, 282320n, null, true, null],
    ]);
    expect(b.rebalance!.residual).toEqual([]);
    expect(b.rebalance!.trades[3]!.note).toContain("may realize about $978.16 of gains");

    // (c)
    await updateHouseholdSetting(t.db, { rebalanceBandBp: 200 }, ctx());
    await set(6000, 2000, 2000, 0);
    const c = await getAllocation(t.db, q);
    expect(c.classes.slice(0, 4).map((x) => [x.driftBp, x.outOfBand])).toEqual([
      [-30, false],
      [-93, false],
      [-255, true],
      [376, true],
    ]);
    expect(summary(c.rebalance!)).toEqual([
      ["R", "use_cash", null, 27000n, null, true, null],
      ["R", "buy", "BND", 27000n, f8("3.60962567"), true, null],
      ["B", "use_cash", null, 143200n, null, true, null],
      ["B", "buy", "BND", 88040n, f8("11.77005348"), false, null],
      ["B", "buy", "VXUS", 41840n, f8("5.87640449"), true, null],
      ["B", "buy", "VTI", 13320n, f8("0.42624"), true, null],
    ]);
    expect(c.rebalance!.trades[3]!.note).toBe("BND or the plan's equivalent bond fund (held in Fidelity Roth IRA)");
    expect(c.rebalance!.residual).toEqual([]);

    // (d)
    await updateHouseholdSetting(t.db, { rebalanceMinTradeCents: 50000n }, ctx());
    const d = (await getAllocation(t.db, q)).rebalance!;
    expect(summary(d)).toEqual([
      ["B", "use_cash", null, 88040n, null, true, null],
      ["B", "buy", "BND", 88040n, f8("11.77005348"), false, null],
    ]);
    expect(d.belowMinimumCents).toBe(82160n);
    expect(d.residual).toEqual([
      { assetClass: "us_stock", amountCents: 13320n },
      { assetClass: "intl_stock", amountCents: 41840n },
      { assetClass: "bonds", amountCents: 27000n },
      { assetClass: "cash", amountCents: -82160n },
    ]);
    expect(d.notes).toContain("3 trades under $500.00 were left out");
    await updateHouseholdSetting(t.db, { rebalanceMinTradeCents: 10000n, rebalanceBandBp: 500 }, ctx());

    // (e) determinism on (b)'s input, reversed.
    await set(3000, 3000, 3000, 1000);
    const context = await investmentContext(t.db, q);
    const input = rebalanceInputOf(context, classifiedLines(context));
    const reversed: RebalanceInput = { ...input, accounts: [...input.accounts].reverse().map((acc) => ({ ...acc, lines: [...acc.lines].reverse() })) };
    expect(suggestRebalance(reversed)).toEqual(suggestRebalance(input));
    expect(suggestRebalance(input)!.trades).toEqual(b.rebalance!.trades);

    // (f) rank: a 529 (none) goes after the roth accounts and before taxable, whatever its value; two roths by value desc then name.
    const vtiLine = input.accounts.find((acc) => acc.id === R)!.lines.find((l) => l.ticker === "VTI")!;
    const k529 = { id: "k529", name: "College", taxTreatment: "none" as const, valueCents: 10000000n, lines: [{ ...vtiLine, valueCents: 10000000n }] };
    const smallRoth = { id: "small", name: "Small Roth", taxTreatment: "roth" as const, valueCents: 100000n, lines: [{ ...vtiLine, valueCents: 100000n }] };
    const ranked = suggestRebalance({ ...input, minTradeCents: 0n, accounts: [k529, ...input.accounts, smallRoth] })!;
    const order = [...new Set(ranked.trades.map((x) => x.accountId))];
    // The roth accounts first (value desc), then the 529, and the taxable account only after them (here it has nothing left to do).
    expect(order.slice(0, 3)).toEqual([R, "small", "k529"]);
    if (order.includes(B)) expect(order.indexOf(B)).toBe(3);

    // (g) blended-only over-weight: us_stock held only through a blended fund.
    const tr = input.accounts.find((acc) => acc.id === R)!.lines.find((l) => l.ticker === null && l.kind === "position")!;
    const blendedOnly = suggestRebalance({
      ...input,
      accounts: [{ id: "x", name: "X", taxTreatment: "roth", valueCents: 500000n, lines: [{ ...tr, valueCents: 420000n }, { ...vtiLine, assetClass: "bonds", ticker: "BND", securityId: S.securities.bnd, valueCents: 80000n }] }],
      targetsBp: [
        { assetClass: "us_stock", targetBp: 1000 },
        { assetClass: "bonds", targetBp: 9000 },
      ],
      householdPure: new Map(),
    })!;
    expect(blendedOnly.triggered).toBe(true);
    expect(blendedOnly.trades).toEqual([]);
    expect(blendedOnly.residual.find((x) => x.assetClass === "us_stock")!.amountCents).toBeLessThan(0n);
    expect(blendedOnly.notes).toContain("us_stock is held only through blended funds, which are held constant");
    await t.db.delete(allocationTarget);
  });

  it("holdings rows, coverage, the weighted expense ratio and concentration (test 8)", async () => {
    const h = await getHoldings(t.db, q);
    expect(h).toMatchObject({ asOf: "2026-10-13", totalCents: 4525200n, holdingsCents: 4382000n, cashCents: 27000n, residualCents: 143200n, excludedAccounts: [], accountWarnings: [], warnings: [] });
    expect(h.rows.map((r) => [r.ticker ?? r.name, r.valueCents, r.weightBp, r.coverage, r.costBasisCents, r.gainCents, r.gainBp, r.expenseRatioPpm])).toEqual([
      ["VTI", 1875000n, 4143, "partial", 1080000n, 170000n, 1574, 300],
      ["BND", 748000n, 1652, "none", null, null, null, 300],
      ["VXUS", 712000n, 1573, "full", 580000n, 132000n, 2275, 500],
      ["AAPL", 600000n, 1325, "full", 575000n, 25000n, 434, null],
      ["Vanguard Target Retirement 2050 Trust", 420000n, 928, "none", null, null, null, 800],
      ["Cash (USD)", 170200n, 376, "full", 170200n, 0n, 0, null],
    ]);
    const vti = h.rows[0]!;
    expect(vti).toMatchObject({ quantity: f8("60"), price: f8("312.5"), priceDate: "2026-10-13", priceSource: "provider", priceStatus: "current", priceStale: false, splits: [], needsReview: false, type: "etf", assetClass: "us_stock" });
    expect(vti.accounts).toEqual([
      expect.objectContaining({ accountId: B, kind: "position", quantity: f8("40"), valueCents: 1250000n, costBasisCents: 1080000n, basisSource: "lots", gainCents: 170000n, lotCount: 2, unknownBasisQuantity: 0n, priceSource: "statement", snapshotDate: "2026-10-13", snapshotSource: "simplefin", dollarOnly: false }),
      expect.objectContaining({ accountId: R, kind: "position", quantity: f8("20"), valueCents: 625000n, costBasisCents: null, basisSource: null, lotCount: null, priceSource: "provider", snapshotDate: "2026-10-09", snapshotSource: "csv" }),
    ]);
    expect(h.rows[4]).toMatchObject({ quantity: f8("100"), price: f8("42"), priceSource: "statement", priceStatus: "implied", splits: [{ assetClass: "us_stock", weightBp: 5400 }, { assetClass: "intl_stock", weightBp: 3600 }, { assetClass: "bonds", weightBp: 1000 }] });
    expect(h.rows[5]!.accounts.map((a) => [a.accountId, a.kind, a.quantity, a.valueCents])).toEqual([
      [B, "cash_plug", null, 143200n],
      [R, "cash", f8("270"), 27000n],
    ]);
    expect(h.rows[5]!.quantity).toBe(f8("270"));
    expect(h.weightedExpenseRatio).toEqual({ ppm: 326, coveredBp: 10000, annualCostCents: 1478n });
    expect(h.concentration).toEqual([{ level: "warn", securityId: S.securities.aapl, ticker: "AAPL", weightBp: 1325, thresholdBp: 1000, message: "AAPL is 13.3% of your portfolio (individual stock; flagged above 10%)" }]);

    const onlyB = await getHoldings(t.db, { ...q, accountId: B });
    expect(onlyB.totalCents).toBe(2705200n);
    expect(onlyB.rows.map((r) => [r.ticker ?? r.name, r.weightBp, r.coverage])).toEqual([
      ["VTI", 4620, "full"],
      ["VXUS", 2631, "full"],
      ["AAPL", 2217, "full"],
      ["Cash (USD)", 529, "full"],
    ]);
    expect(onlyB.rows[3]!.quantity).toBeNull();

    await t.db.update(security).set({ expenseRatioPpm: null }).where(eq(security.id, S.securities.tr2050));
    expect((await getHoldings(t.db, q)).weightedExpenseRatio).toEqual({ ppm: 278, coveredBp: 9071, annualCostCents: 1142n });
    await t.db.update(security).set({ expenseRatioPpm: 800 }).where(eq(security.id, S.securities.tr2050));
  });

  it("holding valuation rule, dollar-only positions, residuals and staleness (test 9)", async () => {
    // (a)
    const d12 = await getHoldings(t.db, { ...q, asOf: "2026-10-12" });
    expect(d12.totalCents).toBe(4489200n);
    const value = (h: typeof d12, ticker: string | null, acct: string) => h.rows.find((r) => (ticker ? r.ticker === ticker : r.ticker === null && r.type === "fund"))!.accounts.find((a) => a.accountId === acct)!.valueCents;
    expect(value(d12, "VTI", B)).toBe(1240000n);
    expect(value(d12, "VTI", R)).toBe(620000n);
    expect(value(d12, "BND", R)).toBe(749000n);
    expect(value(d12, null, R)).toBe(420000n);

    // (b) a dollar-only pool in R's statement (its balance raised to keep the residual at zero).
    const [pool] = await t.db
      .insert(security)
      .values({ ticker: null, name: "Fidelity Freedom 2050 Pool", type: "fund", assetClass: "us_stock", priceMode: "implied", needsReview: false })
      .returning({ id: security.id });
    await t.db.insert(holdingSnapshot).values({ accountId: R, date: "2026-10-09", source: "csv", securityId: pool!.id, quantity: null, price: null, valueCents: 100000n });
    await t.db.update(balanceSnapshot).set({ balanceCents: 1910000n }).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-09")));
    const withPool = await getHoldings(t.db, q);
    const poolRow = withPool.rows.find((r) => r.securityId === pool!.id)!;
    expect(poolRow).toMatchObject({ quantity: null, price: null, priceSource: "statement", valueCents: 100000n });
    expect(poolRow.accounts[0]).toMatchObject({ dollarOnly: true, quantity: null });
    expect(withPool.accountWarnings.some((w) => w.kind === "dollar_only" && w.accountId === R)).toBe(true);
    expect(withPool.residualCents).toBe(143200n);
    const allocPool = await getAllocation(t.db, q);
    expect(allocPool.classes[0]!.currentCents).toBe(2801800n);
    await t.db.delete(holdingSnapshot).where(eq(holdingSnapshot.securityId, pool!.id));
    await t.db.delete(security).where(eq(security.id, pool!.id));

    // (c) a reported balance below the positions: a negative residual is a warning, not a line (the chain's analogue of deleting the computed rows).
    await t.db.update(balanceSnapshot).set({ balanceCents: 1800000n }).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-09")));
    const negative = await getAllocation(t.db, q);
    expect(negative.accountWarnings).toContainEqual({ accountId: R, accountName: "Fidelity Roth IRA", kind: "negative_residual", message: "Holdings exceed the account value by $100.00: the positions are newer than the balance, or the balance is stale" });
    expect(negative).toMatchObject({ totalCents: 4525200n, classifiedCents: 4525200n });
    expect(negative.classes[3]!.currentCents).toBe(170200n);
    expect((await getPortfolio(t.db, { ...q, period: "1m" })).accounts.find((a) => a.accountId === R)!.valueCents).toBe(1820000n);
    await t.db.update(balanceSnapshot).set({ balanceCents: 1810000n }).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-09")));

    // (d) an old statement without newer closes: the price is stale (trading days behind the expected close); positions go stale after 35 days.
    await t.db.update(holdingSnapshot).set({ date: "2026-09-30" }).where(and(eq(holdingSnapshot.accountId, R), eq(holdingSnapshot.date, "2026-10-09")));
    const bndPrices = await t.db.select().from(price).where(eq(price.securityId, S.securities.bnd));
    await t.db.delete(price).where(eq(price.securityId, S.securities.bnd));
    const stale = await getHoldings(t.db, q);
    expect(stale.rows.find((r) => r.ticker === "BND")).toMatchObject({ priceDate: "2026-09-30", priceSource: "statement", priceStatus: "stale", priceStale: true, valueCents: 745000n });
    expect(stale.accountWarnings.some((w) => w.kind === "positions_stale")).toBe(false);
    expect(stale.accountWarnings.some((w) => w.kind === "price_stale" && w.accountId === R)).toBe(true);
    await t.db.update(holdingSnapshot).set({ date: "2026-09-01" }).where(and(eq(holdingSnapshot.accountId, R), eq(holdingSnapshot.date, "2026-09-30")));
    const older = await getPortfolio(t.db, { ...q, period: "1m" });
    expect(older.accounts.find((a) => a.accountId === R)).toMatchObject({ positionsDate: "2026-09-01", positionsStale: true });
    expect(older.accounts.find((a) => a.accountId === R)!.warnings.some((w) => w.kind === "positions_stale")).toBe(true);
    await t.db.update(holdingSnapshot).set({ date: "2026-10-09" }).where(and(eq(holdingSnapshot.accountId, R), eq(holdingSnapshot.date, "2026-09-01")));
    await t.db.insert(price).values(bndPrices.map(({ id: _id, ...row }) => row));

    // (e)
    await expect(getHoldings(t.db, { ...q, asOf: "2026-10-15" })).rejects.toMatchObject({ status: 400, code: "validation" });
    expect((await getHoldings(t.db, q)).totalCents).toBe(4525200n);
  });

  it("why did it change (test 10 on the chain): price and quantity effects sum to the delta exactly", async () => {
    const day = await getAccountChanges(t.db, B, { from: "2026-10-12", to: "2026-10-13", ...q });
    expect(day.summary).toEqual({ from: "2026-10-12", to: "2026-10-13", startCents: 2673200n, endCents: 2705200n, changeCents: 32000n, changeBp: 119, netFlowsCents: 0n, growthCents: 32000n, growthReason: null, incomeCents: 0n, uncategorizedRows: 0 });
    expect(day.holdings.map((h) => [h.ticker, h.priceEffectCents, h.quantityEffectCents, h.deltaCents])).toEqual([
      ["AAPL", 10000n, 0n, 10000n],
      ["VTI", 10000n, 0n, 10000n],
      ["VXUS", 12000n, 0n, 12000n],
    ]);
    expect(day).toMatchObject({ residualEffectCents: 0n, flows: [], income: [], warnings: [], accountName: "Vanguard Brokerage", fidelity: "full_history" });

    const year = await getAccountChanges(t.db, B, { from: "2025-10-13", to: "2026-10-13", ...q });
    expect(year.summary).toMatchObject({ startCents: 2000000n, endCents: 2705200n, changeCents: 705200n, changeBp: 3526, netFlowsCents: 500000n, growthCents: 205200n, incomeCents: 23200n, uncategorizedRows: 1 });
    expect(year.flows).toEqual([expect.objectContaining({ date: "2026-04-13", amountCents: 500000n, kind: "cash", source: "ledger", counterpartyAccountId: S.accounts.checking, counterpartyAccountName: "Checking", internal: false })]);
    expect(year.income).toHaveLength(7);
    // B is valued from its lots on 2025-10-13 (VTI 20 @ 260, VXUS 100 @ 60, AAPL 25 @ 272 plus the 200,000 plug on the 2,000,000 balance).
    const vti = year.holdings.find((h) => h.ticker === "VTI")!;
    expect(vti).toMatchObject({ quantityFrom: f8("20"), priceFrom: f8("260"), valueFromCents: 520000n, quantityTo: f8("40"), priceTo: f8("312.5"), valueToCents: 1250000n, priceEffectCents: 105000n, quantityEffectCents: 625000n });
    const holdingsDelta = year.holdings.reduce((acc, h) => acc + h.deltaCents, 0n);
    expect(holdingsDelta + year.residualEffectCents).toBe(705200n);
    expect(year.residualEffectCents).toBe(-56800n);

    await expect(getAccountChanges(t.db, B, { from: "2026-10-13", to: "2026-10-12", ...q })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getAccountChanges(t.db, B, { from: "2020-10-13", to: "2026-10-13", ...q })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getAccountChanges(t.db, B, { from: "2026-10-12", to: "2026-10-15", ...q })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getAccountChanges(t.db, randomUUID(), { from: "2026-10-12", to: "2026-10-13", ...q })).rejects.toMatchObject({ status: 404 });
  });

  it("determinism and no writes (test 19)", async () => {
    const before = await tableCounts();
    const first = [await getPortfolio(t.db, { ...q, period: "1y" }), await getAllocation(t.db, q), await getHoldings(t.db, q)];
    const second = [await getPortfolio(t.db, { ...q, period: "1y" }), await getAllocation(t.db, q), await getHoldings(t.db, q)];
    expect(second).toEqual(first);
    expect(await tableCounts()).toEqual(before);
  });

  it("dashboard net worth breakdown and the investments block (test 17)", async () => {
    const d = await getDashboard(t.db, { today: TODAY, now: NOW });
    expect(d.netWorth).toMatchObject({ todayCents: 5025200n, breakdown: { investmentsCents: 4525200n, investmentsAsOf: "2026-10-13", cashCents: 500000n, debtCents: 0n, otherCents: 0n } });
    expect(d.investments).toEqual({
      asOf: "2026-10-13",
      totalCents: 4525200n,
      dayChangeCents: 36000n,
      dayChangeBp: 80,
      staleAccounts: [],
      fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 },
      awaitingReconcile: 2,
      securitiesNeedingReview: 0,
      priceFeed: { configured: false, expectedDate: "2026-10-13", stale: 0, notFound: 0, error: 0 },
    });

    await commitReconciliation(t.db, { accountId: B, date: "2026-10-13", rows: [], statementTotalCents: 2705200n, accept: false }, { ...ctx(), now: NOW });
    expect((await getDashboard(t.db, { today: TODAY, now: NOW })).investments!.awaitingReconcile).toBe(1);

    await t.db.insert(balanceSnapshot).values({ accountId: B, date: "2026-10-14", balanceCents: 2710000n, source: "computed" });
    const later = await getDashboard(t.db, { today: TODAY, now: NOW });
    expect(later.netWorth).toMatchObject({ todayCents: 5030000n, breakdown: { investmentsCents: 4530000n, investmentsAsOf: "2026-10-14" } });
    // The investments block is the chain on the expected price date: unchanged by a computed row.
    expect(later.investments).toMatchObject({ asOf: "2026-10-13", totalCents: 4525200n });
    await t.db.delete(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, B), eq(balanceSnapshot.date, "2026-10-14")));
  });

  it("an unclassified balance-only account and its staleness (test 16)", async () => {
    const [k] = await t.db.insert(account).values({ name: "Old 401k", type: "401k", taxTreatment: "pre_tax", onBudget: false }).returning({ id: account.id });
    const K = k!.id;
    await t.db.insert(balanceSnapshot).values({ accountId: K, date: "2026-10-13", balanceCents: 5000000n, source: "manual" });
    const a = await getAllocation(t.db, q);
    expect(a).toMatchObject({ totalCents: 9525200n, classifiedCents: 4525200n, unclassifiedCents: 5000000n });
    expect(a.classes[0]!.currentBp).toBe(5970);
    expect(a.unclassifiedAccounts).toEqual([expect.objectContaining({ accountId: K, accountName: "Old 401k", fidelity: "balance_only", cents: 5000000n, bpOfTotal: 5249 })]);
    expect(a.warnings).toContain("Old 401k ($50,000.00, balance only) is not in these percentages");
    const h = await getHoldings(t.db, q);
    expect(h.excludedAccounts).toEqual([expect.objectContaining({ accountId: K, cents: 5000000n })]);
    expect(h.rows[0]!.weightBp).toBe(4143);
    const p = await getPortfolio(t.db, { ...q, period: "1y" });
    expect(p).toMatchObject({ totalCents: 9525200n, fidelityCounts: { balance_only: 1, positions: 1, full_history: 1 } });
    const kp = p.accounts.find((x) => x.accountId === K)!;
    expect(kp).toMatchObject({ basis: "balance", valuationDate: "2026-10-13", valuationSource: "manual", valuationStale: false, holdingsCount: 0, cashCents: null, residualCents: null, dayChangeCents: null });
    // Unvalued at the start: the opening value is the account's net flow, so its growth within the window is 0.
    expect(kp.period).toMatchObject({ startCents: null, changeCents: 5000000n, changeBp: null, netFlowsCents: 5000000n, growthCents: 0n });
    expect(p.dayChange).toMatchObject({ partial: true, excluded: [{ accountId: K, reason: "balance_only" }] });

    await t.db.update(balanceSnapshot).set({ date: "2026-10-01" }).where(eq(balanceSnapshot.accountId, K));
    const moved = await getPortfolio(t.db, { ...q, period: "1y" });
    expect(moved.asOf).toBe("2026-10-13");
    const kMoved = moved.accounts.find((x) => x.accountId === K)!;
    expect(kMoved).toMatchObject({ valuationStale: true, valuationDate: "2026-10-01", valueCents: 5000000n });
    expect(kMoved.warnings).toContainEqual({ accountId: K, accountName: "Old 401k", kind: "valuation_stale", message: "Old 401k has no value newer than 10/01/26" });
    expect((await getDashboard(t.db, { today: TODAY, now: NOW })).investments!.staleAccounts).toEqual([{ id: K, name: "Old 401k", valuationDate: "2026-10-01" }]);
    await t.db.delete(account).where(eq(account.id, K));
  });

  it("fidelity demotion shows the covered basis with a lots_mismatch warning (test 3)", async () => {
    await deleteInvestmentTxn(t.db, S.txns["buyVti2"]!, {}, ctx());
    const h = await getHoldings(t.db, q);
    const bRow = h.rows.find((r) => r.ticker === "VTI")!.accounts.find((a) => a.accountId === B)!;
    expect(bRow).toMatchObject({ fidelity: "positions", fidelityNote: "trade history incomplete: VTI lots cover 20 of 40 shares", costBasisCents: 500000n, basisSource: "lots", lotCount: 1, quantity: f8("40"), valueCents: 1250000n });
    expect(h.accountWarnings).toContainEqual({ accountId: B, accountName: "Vanguard Brokerage", kind: "lots_mismatch", message: "trade history incomplete: VTI lots cover 20 of 40 shares" });
    const p = await getPortfolio(t.db, { ...q, period: "1m" });
    expect(p.fidelityCounts).toEqual({ balance_only: 0, positions: 2, full_history: 0 });
    const remaining = await t.db.select().from(security).where(inArray(security.id, [S.securities.vti]));
    expect(remaining).toHaveLength(1);
  });

  it("an account with trades and no statement is full history with a note, valued from its lots (test 3)", async () => {
    // One buy, no holding snapshot; the 10-13 balance equals the position at the 10-13 close, so the plug is 0 and no cash line appears.
    const [solo] = await t.db.insert(account).values({ name: "Solo Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    const K2 = solo!.id;
    await t.db.insert(investmentTxn).values({ accountId: K2, securityId: S.securities.vti, date: "2026-10-01", type: "buy", quantity: "10", price: "300", amountCents: -300000n, source: "manual", rawDescription: "BUY VTI" });
    await t.db.insert(balanceSnapshot).values({ accountId: K2, date: "2026-10-13", balanceCents: 312500n, source: "manual" });
    await t.db.transaction((tx) => rebuildLotsForAccounts(tx, [K2]));

    const h = await getHoldings(t.db, { ...q, accountId: K2 });
    expect(h).toMatchObject({ totalCents: 312500n, holdingsCents: 312500n, cashCents: 0n, residualCents: 0n, excludedAccounts: [], accountWarnings: [] });
    expect(h.rows.map((r) => r.ticker)).toEqual(["VTI"]);
    expect(h.rows[0]!.accounts).toEqual([
      expect.objectContaining({
        accountId: K2,
        fidelity: "full_history",
        fidelityNote: "no positions statement to check against",
        kind: "position",
        quantity: f8("10"),
        valueCents: 312500n,
        costBasisCents: 300000n,
        basisSource: "lots",
        gainCents: 12500n,
        lotCount: 1,
        snapshotDate: null,
        snapshotSource: null,
        priceSource: "provider",
      }),
    ]);
    expect(h.rows[0]).toMatchObject({ coverage: "full", gainBp: 416, priceDate: "2026-10-13", priceStatus: "current" });

    const p = await getPortfolio(t.db, { ...q, period: "1m" });
    const kp = p.accounts.find((x) => x.accountId === K2)!;
    expect(kp).toMatchObject({
      fidelity: "full_history",
      fidelityNote: "no positions statement to check against",
      basis: "lots",
      valueCents: 312500n,
      valuationDate: "2026-10-13",
      valuationSource: "computed",
      positionsDate: null,
      positionsStale: false,
      holdingsCount: 1,
      cashCents: 0n,
      residualCents: 0n,
      warnings: [],
    });
    // VTI 310.00 → 312.50 on ten shares (the bp is against the unanchored 10-12 value, an engine detail not asserted here);
    // B was demoted by the previous case, so this is the only full-history account.
    expect(kp.dayChangeCents).toBe(2500n);
    expect(p.fidelityCounts).toEqual({ balance_only: 0, positions: 2, full_history: 1 });
    await t.db.delete(account).where(eq(account.id, K2));
  });
});
