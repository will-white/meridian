import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mulToCents, parseFixed8 } from "@meridian/shared";
import { account, balanceSnapshot, holdingSnapshot, price, security } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { createInvestmentTxn, deleteInvestmentTxn } from "./investmentTxns.js";
import { classifiedLines, dashboardInvestments, getHoldings, getPortfolio, investmentContext, knownLotsCoverage, rebalanceInputOf, suggestRebalance, type RebalanceInput } from "./investmentViews.js";
import { computeHoldings } from "./lots.js";

/**
 * Audit batch b6-investment-views: the Holdings, Portfolio and rebalance findings, each on a
 * fresh INV seed (docs/audit/phases-1-3/b6-investment-views.md). Hand figures in the comments.
 */

const f8 = parseFixed8;
const TODAY = INV_SEED_TODAY;
const NOW = INV_SEED_NOW;
const q = { today: TODAY, now: NOW };
const ctx = () => ({ userId: null, batchId: randomUUID(), today: TODAY });

describe.skipIf(!TEST_DATABASE_URL)("audit b6: investment views", () => {
  let t: TestDb | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });
  const fresh = async (lots = true): Promise<{ db: TestDb["db"]; S: InvestmentSeed }> => {
    t = await createTestDb();
    const S = await seedInvestmentFixture(t.db);
    if (lots) await seedInvestmentLots(t.db, S);
    return { db: t.db, S };
  };

  it("b6-01: shares that arrived without a basis are not gain; the row is partial and the rebalance estimate uses the known lots", async () => {
    const { db, S } = await fresh();
    const B = S.accounts.brokerage;
    // 10 VTI moved in from another broker on 2026-05-01 without a cost basis; the statements now show 50 VTI.
    const moved = await createInvestmentTxn(db, { accountId: B, date: "2026-05-01", type: "transfer", direction: "in", securityId: S.securities.vti, quantity: f8("10"), amountCents: 0n }, ctx());
    expect(moved.rebuildWarnings.map((w) => w.code)).toContain("basis_unknown");
    for (const [date, valueCents] of [
      ["2026-10-12", 1550000n],
      ["2026-10-13", 1562500n],
    ] as const) {
      await db.update(holdingSnapshot).set({ quantity: "50", valueCents }).where(and(eq(holdingSnapshot.accountId, B), eq(holdingSnapshot.securityId, S.securities.vti), eq(holdingSnapshot.date, date)));
    }
    await db.update(balanceSnapshot).set({ balanceCents: 2705200n + 312500n }).where(and(eq(balanceSnapshot.accountId, B), eq(balanceSnapshot.date, "2026-10-13")));

    // The lot engine: basis 1,080,000 on the 40 known shares, unrealized 170,000, 10 sh unknown.
    const engine = (await computeHoldings(db, { accountIds: [B], asOf: "2026-10-13" })).rows.find((r) => r.securityId === S.securities.vti)!;
    expect(engine).toMatchObject({ costBasisCents: 1080000n, unrealizedCents: 170000n, unknownBasisQuantity: f8("10") });

    // Holdings for B: value 50 × 312.50 = 1,562,500; covered value 1,562,500 − 10 × 312.50 = 1,250,000;
    // gain 1,250,000 − 1,080,000 = 170,000 (the engine's figure, not 482,500); gainBp 170,000 / 1,080,000 = 1574.
    const onlyB = await getHoldings(db, { ...q, accountId: B });
    const vti = onlyB.rows.find((r) => r.ticker === "VTI")!;
    expect(vti).toMatchObject({ quantity: f8("50"), valueCents: 1562500n, costBasisCents: 1080000n, coverage: "partial", gainCents: 170000n, gainBp: 1574 });
    expect(vti.accounts).toEqual([expect.objectContaining({ accountId: B, valueCents: 1562500n, costBasisCents: 1080000n, gainCents: 170000n, unknownBasisQuantity: f8("10"), lotCount: 3 })]);

    // The household row: B's 1,250,000 covered value against its 1,080,000 cost; R uncovered.
    const all = await getHoldings(db, q);
    expect(all.rows.find((r) => r.ticker === "VTI")).toMatchObject({ valueCents: 2187500n, costBasisCents: 1080000n, coverage: "partial", gainCents: 170000n, gainBp: 1574 });

    // The rebalance's taxable-sell estimate starts from the known lots' gain and says what it leaves out.
    const c = await investmentContext(db, q);
    const input = rebalanceInputOf(c, classifiedLines(c));
    const bVti = input.accounts.find((a) => a.id === B)!.lines.find((l) => l.securityId === S.securities.vti)!;
    expect(bVti).toMatchObject({ valueCents: 1562500n, unrealizedGainCents: 170000n, unknownBasisQuantity: f8("10") });
    const sell = suggestRebalance({ ...input, targetsBp: [{ assetClass: "us_stock", targetBp: 3000 }, { assetClass: "intl_stock", targetBp: 3000 }, { assetClass: "bonds", targetBp: 3000 }, { assetClass: "cash", targetBp: 1000 }] })!.trades.find(
      (x) => x.accountId === B && x.action === "sell",
    )!;
    // R sells its 625,000 of VTI first (tax-advantaged); B sells the rest of the us_stock excess:
    // 3,014,300 − truncDiv(4,837,700 × 3000, 10000) − 625,000 = 937,990. Estimated gain
    // truncDiv(170,000 × 937,990, 1,562,500) = 102,053 (it was 482,500 × … = 289,651 with the moved shares as gain).
    expect(sell).toMatchObject({ amountCents: 937990n, estimatedGainCents: 102053n, note: "may realize about $1,020.53 of gains (not counting 10 sh whose basis is unknown); the lots view shows which lots" });
  });

  it("b6-01: the known-basis lots of a line, and the sell note without unknown-basis shares", () => {
    const price = f8("312.5");
    const line = (shares: string) => ({ valueCents: mulToCents(f8(shares), price), quantity: f8(shares), price });
    // 40 known shares (basis 1,080,000, 1,250,000 at 312.50, unrealized 170,000), 10 without a basis.
    const engine = { quantity: f8("50"), costBasisCents: 1080000n, unrealizedCents: 170000n, unknownBasisQuantity: f8("10"), price };
    const matched = { ...engine, quantity: f8("40"), unknownBasisQuantity: 0n };
    expect(knownLotsCoverage(line("40"), matched)).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: false });
    // The statement holds the 50 shares: the known lots are 40 of them, the row is partial (first round).
    expect(knownLotsCoverage(line("50"), engine)).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: true });
    // Second round: a statement the lots disagree with never changes the known lots' gain (−142,500 and
    // −1,080,000 when the unknown shares were taken off the statement's 40, or more than all of its 5).
    expect(knownLotsCoverage(line("40"), engine)).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: true });
    expect(knownLotsCoverage(line("5"), { ...engine, quantity: f8("100"), unknownBasisQuantity: f8("60") })).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: true });
    // Lots for fewer shares than the statement: 20 × 312.50 − 500,000, and partial.
    expect(knownLotsCoverage(line("40"), { quantity: f8("20"), costBasisCents: 500000n, unrealizedCents: 125000n, unknownBasisQuantity: 0n, price })).toEqual({ coveredValueCents: 625000n, gainCents: 125000n, partial: true });
    // Within the position check's 0.001 sh the lots match the statement.
    expect(knownLotsCoverage(line("40.0005"), matched).partial).toBe(false);
    // No close for the lots (or another one): the known shares at the line's price, 40 × 312.50.
    expect(knownLotsCoverage(line("40"), { ...matched, unrealizedCents: null, price: null })).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: false });
    expect(knownLotsCoverage(line("40"), { ...matched, unrealizedCents: 160000n, price: f8("310") })).toEqual({ coveredValueCents: 1250000n, gainCents: 170000n, partial: false });
    // A value-only line cannot be compared: covered whole when every lot has a basis, else uncovered.
    expect(knownLotsCoverage({ valueCents: 1300000n, quantity: null, price: null }, matched)).toEqual({ coveredValueCents: 1300000n, gainCents: 220000n, partial: false });
    expect(knownLotsCoverage({ valueCents: 1300000n, quantity: null, price: null }, engine)).toEqual({ coveredValueCents: null, gainCents: null, partial: true });
    // No known lot at all: no basis.
    expect(knownLotsCoverage(line("10"), { quantity: f8("10"), costBasisCents: null, unrealizedCents: null, unknownBasisQuantity: f8("10"), price })).toEqual({ coveredValueCents: null, gainCents: null, partial: false });
    const input: RebalanceInput = {
      accounts: [
        {
          id: "a",
          name: "Taxable",
          taxTreatment: "taxable",
          valueCents: 100000n,
          lines: [{ securityId: "s", ticker: "X", name: "X", type: "etf", assetClass: "us_stock", splits: [], valueCents: 100000n, unrealizedGainCents: 20000n, kind: "position" }],
        },
      ],
      targetsBp: [
        { assetClass: "us_stock", targetBp: 5000 },
        { assetClass: "cash", targetBp: 5000 },
      ],
      bandBp: 500,
      minTradeCents: 100n,
      prices: new Map(),
      householdPure: new Map(),
    };
    // Without unknown-basis shares the note is the design's sentence: 20,000 × 50,000 / 100,000 = 10,000.
    const trade = suggestRebalance(input)!.trades.find((x) => x.action === "sell")!;
    expect(trade).toMatchObject({ amountCents: 50000n, estimatedGainCents: 10000n, note: "may realize about $100.00 of gains; the lots view shows which lots" });
  });

  it("b6-03: without a cash security the inferred cash is a Cash row of its own, so the rows sum to the total and the expense ratio counts it", async () => {
    const { db, S } = await fresh();
    // A household whose brokerage lists positions but never a cash line: no cash security exists.
    await db.delete(holdingSnapshot).where(eq(holdingSnapshot.securityId, S.securities.cash));
    await db.delete(security).where(eq(security.id, S.securities.cash));
    const h = await getHoldings(db, q);
    // R's 27,000 is now its plug; with B's 143,200 the inferred cash is 170,200 of 4,525,200.
    expect(h).toMatchObject({ totalCents: 4525200n, cashCents: 0n, residualCents: 170200n, warnings: [] });
    expect(h.rows.reduce((acc, r) => acc + r.valueCents, 0n)).toBe(4525200n);
    const cash = h.rows.find((r) => r.type === "cash")!;
    expect(cash).toMatchObject({ securityId: null, name: "Cash (USD)", assetClass: "cash", valueCents: 170200n, weightBp: 376, coverage: "full", costBasisCents: 170200n, gainCents: 0n, quantity: f8("1702") });
    expect(cash.accounts.map((a) => [a.accountId, a.kind, a.lineName, a.inferred, a.valueCents])).toEqual([
      [S.accounts.brokerage, "cash_plug", "Cash (from balance)", true, 143200n],
      [S.accounts.roth, "cash_plug", "Cash (from balance)", true, 27000n],
    ]);
    // 1,478,900,000 / 4,525,200 = 326 ppm over the whole portfolio (339 when the cash was missing from the rows).
    expect(h.weightedExpenseRatio).toEqual({ ppm: 326, coveredBp: 10000, annualCostCents: 1478n });
  });

  it("b6-07: negative cash (a margin debit) is left out of the expense ratio and the concentration base", async () => {
    const { db, S } = await fresh(false);
    const B = S.accounts.brokerage;
    // B holds only VTI 40 sh (1,250,000 at 300 ppm) and owes 500,000: statement balance 750,000.
    await db.delete(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, B), eq(holdingSnapshot.securityId, S.securities.vxus)));
    await db.delete(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, B), eq(holdingSnapshot.securityId, S.securities.aapl)));
    await db.update(balanceSnapshot).set({ balanceCents: 750000n }).where(and(eq(balanceSnapshot.accountId, B), eq(balanceSnapshot.date, "2026-10-13")));
    const h = await getHoldings(db, { ...q, accountId: B });
    expect(h).toMatchObject({ totalCents: 750000n, residualCents: -500000n });
    // The weights still sum to the (net) total: VTI 16666, cash −6666.
    expect(h.rows.map((r) => [r.ticker ?? r.name, r.valueCents, r.weightBp])).toEqual([
      ["VTI", 1250000n, 16666],
      ["Cash (USD)", -500000n, -6666],
    ]);
    // 1,250,000 × 300 / 1,250,000 = 300 ppm (was 500 over the net 750,000); 1,250,000 × 300 / 10⁶ = 375 a year.
    expect(h.weightedExpenseRatio).toEqual({ ppm: 300, coveredBp: 10000, annualCostCents: 375n });
    // VTI is all of what B holds (10000 bp of the gross value), not 166.7 %.
    expect(h.concentration).toEqual([
      { level: "info", securityId: S.securities.vti, ticker: "VTI", weightBp: 10000, thresholdBp: 6000, message: "VTI is 100.0% of Vanguard Brokerage: most of it is one fund; fine for a total-market fund" },
    ]);
  });

  it("b6-12: the Cash row's quantity is its whole value; each sub-row says whether it is reported or inferred, and trade cash is named", async () => {
    const { db, S } = await fresh();
    const B = S.accounts.brokerage;
    const seed = await getHoldings(db, q);
    const cash = seed.rows.find((r) => r.type === "cash")!;
    // 143,200 inferred in B + 27,000 reported in R = 170,200 = 1,702 units at 1.00 (was 270 units for $1,702).
    expect(cash).toMatchObject({ securityId: S.securities.cash, quantity: f8("1702"), price: f8("1"), valueCents: 170200n });
    expect(cash.accounts.map((a) => [a.accountId, a.kind, a.lineName, a.inferred, a.quantity])).toEqual([
      [B, "cash_plug", "Cash (from balance)", true, null],
      [S.accounts.roth, "cash", "Cash (USD)", false, f8("270")],
    ]);

    // A VTI buy after B's last statement puts B on the lots basis: its trade cash is an inferred "cash" line.
    await createInvestmentTxn(db, { accountId: B, date: "2026-10-14", type: "buy", securityId: S.securities.vti, quantity: f8("5"), price: f8("312.5") }, ctx());
    const lots = await getHoldings(db, { ...q, accountId: B, asOf: "2026-10-14" });
    // 143,200 plug − 156,250 for the 5 shares = −13,050.
    expect(lots).toMatchObject({ cashCents: 0n, residualCents: -13050n });
    const lotsCash = lots.rows.find((r) => r.type === "cash")!;
    expect(lotsCash).toMatchObject({ quantity: f8("-130.5"), valueCents: -13050n });
    expect(lotsCash.accounts.map((a) => [a.kind, a.lineName, a.inferred, a.valueCents])).toEqual([
      ["cash_plug", "Cash (from balance)", true, 143200n],
      ["cash", "Cash (from trades)", true, -156250n],
    ]);
  });

  it("b6-14: concentration in an account-filtered view names the account the weight is relative to", async () => {
    const { db, S } = await fresh();
    const onlyB = await getHoldings(db, { ...q, accountId: S.accounts.brokerage });
    // AAPL 600,000 / B's 2,705,200 = 2217 bp; of the household it is 1325 bp.
    expect(onlyB.concentration).toEqual([
      { level: "warn", securityId: S.securities.aapl, ticker: "AAPL", weightBp: 2217, thresholdBp: 1000, message: "AAPL is 22.2% of Vanguard Brokerage (individual stock; flagged above 10%)" },
    ]);
    expect((await getHoldings(db, q)).concentration.map((c) => c.message)).toEqual(["AAPL is 13.3% of your portfolio (individual stock; flagged above 10%)"]);
  });

  it("b6-06: includeClosed=true values a closed account on the Portfolio, its series included", async () => {
    const { db, S } = await fresh();
    await db.update(account).set({ closed: true }).where(eq(account.id, S.accounts.roth));
    const open = await getPortfolio(db, { ...q, period: "1m" });
    expect(open.accounts.map((a) => a.accountName)).toEqual(["Vanguard Brokerage"]);
    const all = await getPortfolio(db, { ...q, period: "1m", includeClosed: true });
    expect(all.accounts.map((a) => [a.accountName, a.closed])).toEqual([
      ["Fidelity Roth IRA", true],
      ["Vanguard Brokerage", false],
    ]);
    expect(all.totalCents).toBe(4525200n);
    expect(all.series.accounts.map((a) => a.accountId).sort()).toEqual([S.accounts.brokerage, S.accounts.roth].sort());
    expect(all.series.total.at(-1)).toBe(4525200n);
  });

  it("b6-01, second round: when the lots hold more shares than the statement (lots_mismatch), the gain is still the known lots' own", async () => {
    const { db, S } = await fresh();
    const B = S.accounts.brokerage;
    // The reviewer's probe d4: 10 VTI moved in on 2026-05-01 without a basis, but the statements still show 40 VTI.
    await createInvestmentTxn(db, { accountId: B, date: "2026-05-01", type: "transfer", direction: "in", securityId: S.securities.vti, quantity: f8("10"), amountCents: 0n }, ctx());
    const engine = (await computeHoldings(db, { accountIds: [B], asOf: "2026-10-13" })).rows.find((r) => r.securityId === S.securities.vti)!;
    expect(engine).toMatchObject({ quantity: f8("50"), costBasisCents: 1080000n, unrealizedCents: 170000n, unknownBasisQuantity: f8("10") });

    const onlyB = await getHoldings(db, { ...q, accountId: B });
    expect(onlyB.accountWarnings.map((w) => w.kind)).toContain("lots_mismatch");
    // Value: the statement's 40 × 312.50 = 1,250,000. The known lots: 40 sh, basis 1,080,000, worth
    // 40 × 312.50 = 1,250,000, gain 170,000 (the engine's figure); gainBp 170,000 / 1,080,000 = 1574.
    // The first round took the 10 unknown shares off the statement's 40: 937,500 − 1,080,000 = −142,500 (−1319 bp).
    const vti = onlyB.rows.find((r) => r.ticker === "VTI")!;
    expect(vti).toMatchObject({ quantity: f8("40"), valueCents: 1250000n, costBasisCents: 1080000n, coverage: "partial", gainCents: 170000n, gainBp: 1574 });
    expect(vti.accounts).toEqual([expect.objectContaining({ accountId: B, valueCents: 1250000n, costBasisCents: 1080000n, gainCents: 170000n, unknownBasisQuantity: f8("10") })]);

    // The rebalance starts from the same known-lots gain, so the taxable sell estimates a gain, not a loss.
    const c = await investmentContext(db, q);
    const input = rebalanceInputOf(c, classifiedLines(c));
    const bVti = input.accounts.find((a) => a.id === B)!.lines.find((l) => l.securityId === S.securities.vti)!;
    expect(bVti).toMatchObject({ valueCents: 1250000n, unrealizedGainCents: 170000n, unknownBasisQuantity: f8("10") });
    const sells = suggestRebalance({ ...input, targetsBp: [{ assetClass: "us_stock", targetBp: 3000 }, { assetClass: "intl_stock", targetBp: 3000 }, { assetClass: "bonds", targetBp: 3000 }, { assetClass: "cash", targetBp: 1000 }] })!.trades.filter(
      (x) => x.accountId === B && x.action === "sell",
    );
    // us_stock 2,701,800 − truncDiv(4,525,200 × 3000, 10000) = 1,344,240 over; R sells its 625,000 first, B the
    // other 719,240. Estimate truncDiv(170,000 × 719,240, 1,250,000) = 97,816 (it was −142,500 × … = −81,993).
    expect(sells).toEqual([
      expect.objectContaining({
        securityId: S.securities.vti,
        amountCents: 719240n,
        estimatedGainCents: 97816n,
        note: "may realize about $978.16 of gains (not counting 10 sh whose basis is unknown); the lots view shows which lots",
      }),
    ]);
  });

  it("b6-01, second round: lots that cover fewer shares than the statement cover only their own shares (views design test 3)", async () => {
    const { db, S } = await fresh();
    const B = S.accounts.brokerage;
    // Test 3's demotion: without the 04-14 buy the lots hold 20 VTI (basis 500,000) of the statement's 40.
    await deleteInvestmentTxn(db, S.txns["buyVti2"]!, {}, ctx());
    const engine = (await computeHoldings(db, { accountIds: [B], asOf: "2026-10-13" })).rows.find((r) => r.securityId === S.securities.vti)!;
    expect(engine).toMatchObject({ quantity: f8("20"), costBasisCents: 500000n, unrealizedCents: 125000n, unknownBasisQuantity: 0n });
    const onlyB = await getHoldings(db, { ...q, accountId: B });
    expect(onlyB.accountWarnings.map((w) => w.kind)).toContain("lots_mismatch");
    // The known lots: 20 × 312.50 = 625,000 against 500,000, gain 125,000 (2500 bp); the other 20 statement
    // shares have no lot, so the row is partial. Before, all 1,250,000 counted against 500,000: +750,000 (+150 %).
    const vti = onlyB.rows.find((r) => r.ticker === "VTI")!;
    expect(vti).toMatchObject({ quantity: f8("40"), valueCents: 1250000n, costBasisCents: 500000n, coverage: "partial", gainCents: 125000n, gainBp: 2500 });
    expect(vti.accounts).toEqual([expect.objectContaining({ accountId: B, costBasisCents: 500000n, basisSource: "lots", gainCents: 125000n, lotCount: 1 })]);
  });

  it("b6-08, second round: the Dashboard's day change carries the carried prior close, as the Portfolio's does", async () => {
    const { db, S } = await fresh();
    // No BND close on 10-12: R's BND day change is measured from the 10-09 close (74.50 → 74.80 on 100 sh = +3,000).
    await db.delete(price).where(and(eq(price.securityId, S.securities.bnd), eq(price.date, "2026-10-12")));
    const p = await getPortfolio(db, { ...q, period: "1m", priceFeed: false });
    expect(p.dayChange).toMatchObject({ asOf: "2026-10-13", prior: "2026-10-12", carriedPrior: { date: "2026-10-09", sources: ["provider"] } });
    const d = (await dashboardInvestments(db, { today: TODAY, now: NOW, priceProvider: null }))!;
    // The block says what the Portfolio says: the same change, the closes it runs between and the carried close.
    expect(d).toMatchObject({
      dayChangeCents: p.dayChange.cents,
      dayChangeBp: p.dayChange.bp,
      dayChangeAsOf: "2026-10-13",
      dayChangePrior: "2026-10-12",
      dayChangeCarriedPrior: { date: "2026-10-09", sources: ["provider"] },
    });
    // On the seed (every close there) nothing is carried.
    await db.insert(price).values({ securityId: S.securities.bnd, date: "2026-10-12", close: "74.9", adjClose: "74.9", source: "provider", provider: "tiingo", suspect: false, fetchedAt: NOW });
    expect(await dashboardInvestments(db, { today: TODAY, now: NOW, priceProvider: null })).toMatchObject({ dayChangeCents: 36000n, dayChangeAsOf: "2026-10-13", dayChangePrior: "2026-10-12", dayChangeCarriedPrior: null });
  });
});
