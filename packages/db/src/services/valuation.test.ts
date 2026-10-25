import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, CASH_PLUG_NAME, parseFixed8, type IsoDate } from "@meridian/shared";
import { account, balanceSnapshot, holdingSnapshot, investmentTxn, price, security, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { PlanError } from "./audit.js";
import { cashSecurity } from "./securities.js";
import { investmentAccountIds, listInvestmentAccounts, loadValuationInput, valuationSeries, valuationSummary, valueAccountsOn } from "./valuation.js";

const f8 = parseFixed8;

/**
 * Prices design §7 tests 9–16 (scenario S1 + B + C of §3.7–§3.9) through the DB loader and the
 * services, under the plan's names: the chain's `cash` line for the statement's cash row, the
 * plug as "Cash (from balance)", `carried_flows` for the transfer after the statement, and
 * `expectedThrough = 2026-10-20` (a Wednesday morning clock). Every number is the design's.
 */
describe.skipIf(!TEST_DATABASE_URL)("valuation services (prices S1)", () => {
  let t: TestDb;
  /** 11:00 in New York on 2026-10-21: the latest completed close is 10-20. */
  const NOW = new Date("2026-10-21T15:00:00Z");
  const TODAY: IsoDate = "2026-10-21";
  let A: string; // brokerage, positions, cash_inference auto (S1)
  let P: string; // S1 without the cash line and a 09-30 balance of 56,800.00 (the plug)
  let Q: string; // S1 without the cash line and no balance
  let B: string; // 401k, balance-only
  let C: string; // IRA, positions from 10-12
  let D: string; // 401k, dollar-only position
  let E: string; // brokerage, full history, unpriced security
  let VTI: string;
  let VFIAX: string;
  let FXAIX: string;
  let TRUST: string;
  let NOPX: string;
  let CASH: string;

  beforeAll(async () => {
    t = await createTestDb();
    const accounts = await t.db
      .insert(account)
      .values([
        { name: "A Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "P Brokerage (plug)", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "Q Brokerage (no balance)", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "B 401k", type: "401k", taxTreatment: "pre_tax", onBudget: false },
        { name: "C IRA", type: "ira", taxTreatment: "pre_tax", onBudget: false },
        { name: "D 401k (dollar-only)", type: "401k", taxTreatment: "pre_tax", onBudget: false },
        { name: "E Brokerage (unpriced)", type: "brokerage", taxTreatment: "taxable", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
    A = acct("A Brokerage");
    P = acct("P Brokerage (plug)");
    Q = acct("Q Brokerage (no balance)");
    B = acct("B 401k");
    C = acct("C IRA");
    D = acct("D 401k (dollar-only)");
    E = acct("E Brokerage (unpriced)");

    const secs = await t.db
      .insert(security)
      .values([
        { ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "VFIAX", name: "Vanguard 500 Index Admiral", type: "fund", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "FXAIX", name: "Fidelity 500 Index", type: "fund", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: null, name: "Collective Trust 2045", type: "fund", assetClass: "us_stock", priceMode: "implied", needsReview: false },
        { ticker: "NOPX", name: "No Price Corp", type: "stock", assetClass: "us_stock", priceMode: "provider", needsReview: false },
      ])
      .returning({ id: security.id, ticker: security.ticker, name: security.name });
    const sec = (name: string) => secs.find((s) => s.name === name)!.id;
    VTI = sec("Vanguard Total Stock Market ETF");
    VFIAX = sec("Vanguard 500 Index Admiral");
    FXAIX = sec("Fidelity 500 Index");
    TRUST = sec("Collective Trust 2045");
    NOPX = sec("No Price Corp");
    CASH = (await cashSecurity(t.db)).row.id;

    const provider = (securityId: string, date: IsoDate, close: string) => ({ securityId, date, close, adjClose: close, source: "provider" as const, provider: "tiingo" as const, suspect: false, fetchedAt: NOW });
    const implied = (securityId: string, date: IsoDate, close: string) => ({ securityId, date, close, source: "implied" as const });
    await t.db.insert(price).values([
      implied(VTI, "2026-09-30", "300"),
      implied(VFIAX, "2026-09-30", "500"),
      provider(VTI, "2026-10-09", "301.1"),
      provider(VTI, "2026-10-12", "303"),
      provider(VTI, "2026-10-13", "305.25"),
      provider(VFIAX, "2026-10-09", "498.75"),
      provider(VFIAX, "2026-10-12", "502"),
      provider(VFIAX, "2026-10-13", "505.1"),
      // C's 10-12 import writes its implied unit price (the design's "implied rows from the import").
      implied(FXAIX, "2026-10-12", "200"),
      provider(FXAIX, "2026-10-13", "202"),
    ]);

    const snap = (accountId: string, date: IsoDate, securityId: string, quantity: string | null, priceValue: string | null, valueCents: bigint) => ({
      accountId,
      date,
      source: "csv" as const,
      securityId,
      quantity,
      price: priceValue,
      valueCents,
      reportedCostBasisCents: null,
    });
    await t.db.insert(holdingSnapshot).values([
      snap(A, "2026-09-30", VTI, "100", "300", 3000000n),
      snap(A, "2026-09-30", VFIAX, "50.123", "500", 2506150n),
      snap(A, "2026-09-30", CASH, "1234.56", "1", 123456n),
      snap(P, "2026-09-30", VTI, "100", "300", 3000000n),
      snap(P, "2026-09-30", VFIAX, "50.123", "500", 2506150n),
      snap(Q, "2026-09-30", VTI, "100", "300", 3000000n),
      snap(Q, "2026-09-30", VFIAX, "50.123", "500", 2506150n),
      snap(C, "2026-10-12", FXAIX, "10", "200", 200000n),
      snap(D, "2026-10-01", TRUST, null, null, 1234567n),
    ]);
    await t.db.insert(balanceSnapshot).values([
      { accountId: A, date: "2026-09-30", balanceCents: 5629606n, source: "csv" },
      { accountId: P, date: "2026-09-30", balanceCents: 5680000n, source: "csv" },
      { accountId: B, date: "2026-10-01", balanceCents: 1000000n, source: "manual" },
      { accountId: B, date: "2026-10-10", balanceCents: 1020000n, source: "manual" },
      // Computed rows are the engine's own output and never anchor anything.
      { accountId: B, date: "2026-10-12", balanceCents: 9990000n, source: "computed" },
    ]);
    await t.db.insert(transaction).values([
      { accountId: A, source: "manual", date: "2026-10-05", amountCents: 100000n, rawDescription: "TRANSFER IN", isTransfer: true },
      { accountId: P, source: "manual", date: "2026-10-05", amountCents: 100000n, rawDescription: "TRANSFER IN", isTransfer: true },
    ]);
    // E: a full-history account (trades, no statement) whose only security has no price row.
    await t.db.insert(investmentTxn).values({ accountId: E, securityId: NOPX, date: "2026-10-01", type: "buy", quantity: "10", price: "50", amountCents: -50000n, source: "manual" });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const valueOn = async (accountId: string, date: IsoDate) => (await valueAccountsOn(t.db, { accountIds: [accountId], date, now: NOW }))[0]!;
  const lineOf = (v: Awaited<ReturnType<typeof valueOn>>, pick: { securityId?: string; kind?: string }) =>
    v.lines.find((l) => (pick.securityId ? l.securityId === pick.securityId : l.kind === pick.kind))!;

  it("values S1 by the chain: snapshot on 09-30, repriced positions with the statement's cash and the carried transfer after it (test 9)", async () => {
    const onStatement = await valueOn(A, "2026-09-30");
    expect(onStatement).toMatchObject({ basis: "snapshot", asOf: "2026-09-30", valueCents: 5629606n, fidelity: "positions", cashAnchor: "2026-09-30", balanceDiffCents: 0n, priceStatus: "current" });
    // Security id order; no synthetic line (the plug is exactly 0).
    expect([...onStatement.lines.map((l) => l.kind)].sort()).toEqual(["cash", "position", "position"]);
    expect(onStatement.lines.every((l) => l.priceStatus === "statement" || l.priceStatus === "cash")).toBe(true);

    const d9 = await valueOn(A, "2026-10-09");
    expect(d9).toMatchObject({ basis: "positions", asOf: "2026-09-30", valueCents: 5734341n, priceStatus: "current", cashAnchor: "2026-09-30", balanceDiffCents: null });
    expect(lineOf(d9, { securityId: VTI })).toMatchObject({ kind: "position", valueCents: 3011000n, price: f8("301.1"), priceDate: "2026-10-09", priceSource: "provider", priceStatus: "current", valueSource: "priced" });
    expect(lineOf(d9, { securityId: VFIAX })).toMatchObject({ valueCents: 2499885n, priceSource: "provider", priceStatus: "current" });
    expect(lineOf(d9, { securityId: CASH })).toMatchObject({ kind: "cash", valueCents: 123456n, priceSource: "cash", priceStatus: "cash" });
    expect(lineOf(d9, { kind: "carried_flows" })).toMatchObject({ securityId: null, valueCents: 100000n, name: "Transfers since 2026-09-30" });
    expect(d9.lines.some((l) => l.kind === "cash_plug")).toBe(false);

    expect((await valueOn(A, "2026-10-10")).valueCents).toBe(5734341n);
    const d11 = await valueOn(A, "2026-10-11");
    expect(d11).toMatchObject({ valueCents: 5734341n, priceStatus: "current" });
    expect((await valueOn(A, "2026-10-12")).valueCents).toBe(5769631n);
    expect((await valueOn(A, "2026-10-13")).valueCents).toBe(5807669n);
    expect(await valueOn(A, "2026-09-29")).toMatchObject({ basis: "none", valueCents: null, asOf: null });

    await t.db.update(account).set({ cashInference: "off" }).where(eq(account.id, A));
    const off13 = await valueOn(A, "2026-10-13");
    expect(off13).toMatchObject({ valueCents: 5707669n, cashInference: "off", cashAnchor: null });
    expect(off13.lines.some((l) => l.kind === "carried_flows")).toBe(false);
    expect((await valueOn(A, "2026-10-09")).valueCents).toBe(5634341n);
    await t.db.update(account).set({ cashInference: "auto" }).where(eq(account.id, A));
  });

  it("plugs cash from the 09-30 balance when the statement lists no cash row, never without a balance, never when off, never when zero (test 10)", async () => {
    const onStatement = await valueOn(P, "2026-09-30");
    expect(onStatement).toMatchObject({ basis: "snapshot", valueCents: 5680000n, cashAnchor: "2026-09-30", balanceDiffCents: 0n });
    expect(lineOf(onStatement, { kind: "cash_plug" })).toMatchObject({ name: CASH_PLUG_NAME, securityId: null, valueCents: 173850n, priceDate: "2026-09-30", priceStatus: "cash", valueSource: "carried" });
    const d13 = await valueOn(P, "2026-10-13");
    expect(d13.valueCents).toBe(5858063n); // 3,052,500 + 2,531,713 + 173,850 + 100,000
    expect(lineOf(d13, { kind: "cash_plug" }).valueCents).toBe(173850n);
    expect(lineOf(d13, { kind: "carried_flows" }).valueCents).toBe(100000n);

    const noBalance = await valueOn(Q, "2026-09-30");
    expect(noBalance).toMatchObject({ valueCents: 5506150n, cashAnchor: null });
    expect(noBalance.lines.some((l) => l.kind === "cash_plug")).toBe(false);

    await t.db.update(account).set({ cashInference: "off" }).where(eq(account.id, P));
    const off = await valueOn(P, "2026-09-30");
    expect(off).toMatchObject({ valueCents: 5506150n, cashAnchor: null });
    expect(off.lines.some((l) => l.kind === "cash_plug")).toBe(false);
    expect((await valueOn(P, "2026-10-13")).valueCents).toBe(5584213n);
    await t.db.update(account).set({ cashInference: "auto" }).where(eq(account.id, P));

    // A's balance equals its statement: a plug of exactly 0 emits no line.
    const a = await valueOn(A, "2026-09-30");
    expect(a.lines.some((l) => l.kind === "cash_plug")).toBe(false);
  });

  it("carries a dollar-only position and leaves an unpriced lots-basis account without a value (test 12)", async () => {
    const d = await valueOn(D, "2026-10-13");
    expect(d).toMatchObject({ basis: "positions", asOf: "2026-10-01", valueCents: 1234567n, priceStatus: "implied", fidelity: "positions" });
    expect(lineOf(d, { securityId: TRUST })).toMatchObject({ quantity: null, price: null, priceStatus: "carried", valueSource: "carried", valueCents: 1234567n });

    const e = await valueOn(E, "2026-10-13");
    expect(e).toMatchObject({ basis: "lots", asOf: "2026-10-01", fidelity: "full_history", valueCents: null, missing: [NOPX] });
    expect(lineOf(e, { securityId: NOPX })).toMatchObject({ quantity: f8("10"), valueCents: null, valueSource: "unpriced", priceStatus: "missing" });
    const series = await valuationSeries(t.db, { from: "2026-10-12", to: "2026-10-13", today: TODAY, now: NOW, accountIds: [E] });
    expect(series.portfolio.map((p) => [p.valueCents, p.partial, p.missing])).toEqual([
      [null, true, [E]],
      [null, true, [E]],
    ]);
  });

  it("values a balance-only account from its reported balances and an account from its first statement on (test 13)", async () => {
    expect(await valueOn(B, "2026-10-09")).toMatchObject({ basis: "balance", asOf: "2026-10-01", valueCents: 1000000n, priceStatus: "n/a", fidelity: "balance_only" });
    for (const d of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]) expect((await valueOn(B, d)).valueCents).toBe(1020000n);
    expect(await valueOn(B, "2026-09-30")).toMatchObject({ basis: "none", valueCents: null });
    expect((await valueOn(C, "2026-10-11")).valueCents).toBeNull();
    expect(await valueOn(C, "2026-10-12")).toMatchObject({ basis: "snapshot", valueCents: 200000n });
    expect(await valueOn(C, "2026-10-13")).toMatchObject({ basis: "positions", asOf: "2026-10-12", valueCents: 202000n, priceStatus: "current" });
  });

  it("builds the series over A, B and C with per-account values, the partial flag, the true first data dates and the step rules (test 14)", async () => {
    const series = await valuationSeries(t.db, { from: "2026-10-09", to: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C] });
    expect(series).toMatchObject({ from: "2026-10-09", to: "2026-10-13", expectedDate: "2026-10-20", dates: ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"] });
    expect(series.portfolio.map((p) => [p.valueCents, p.partial, p.missing, p.priceStatus])).toEqual([
      [6734341n, true, [C], "current"],
      [6754341n, true, [C], "current"],
      [6754341n, true, [C], "current"],
      [6989631n, false, [], "current"],
      [7029669n, false, [], "current"],
    ]);
    const byId = new Map(series.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(A)!.values).toEqual([5734341n, 5734341n, 5734341n, 5769631n, 5807669n]);
    expect(byId.get(B)!.values).toEqual([1000000n, 1020000n, 1020000n, 1020000n, 1020000n]);
    expect(byId.get(C)!.values).toEqual([null, null, null, 200000n, 202000n]);
    expect(series.accounts.map((a) => [a.name, a.fidelity, a.firstDataDate])).toEqual([
      ["A Brokerage", "positions", "2026-09-30"],
      ["B 401k", "balance_only", "2026-10-01"],
      ["C IRA", "positions", "2026-10-12"],
    ]);
    series.dates.forEach((_, i) => {
      const sum = series.accounts.reduce<bigint | null>((acc, a) => (a.values[i] === null ? acc : (acc ?? 0n) + a.values[i]!), null);
      expect(series.portfolio[i]!.valueCents).toBe(sum);
    });

    const weekly = await valuationSeries(t.db, { from: "2026-10-05", to: "2026-10-13", today: TODAY, now: NOW, accountIds: [A], step: "week" });
    expect(weekly.dates).toEqual(["2026-10-09", "2026-10-13"]);
    const monthly = await valuationSeries(t.db, { from: "2026-09-15", to: "2026-10-13", today: TODAY, now: NOW, accountIds: [A], step: "month" });
    expect(monthly.dates).toEqual(["2026-09-30", "2026-10-13"]);
    expect(monthly.accounts[0]!.values).toEqual([5629606n, 5807669n]);

    await expect(valuationSeries(t.db, { from: addDays("2026-10-13", -3661), to: "2026-10-13", today: TODAY, now: NOW, accountIds: [A] })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(valuationSeries(t.db, { from: "2026-10-13", to: "2026-10-12", today: TODAY, now: NOW, accountIds: [A] })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(valuationSeries(t.db, { from: "2026-10-13", to: "2026-10-22", today: TODAY, now: NOW, accountIds: [A] })).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  it("reports the day change as price movement on the quantities held, excluding the balance-only account (test 15)", async () => {
    const s13 = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C], period: "1w" });
    expect(s13.dayChange).toMatchObject({ cents: 40038n, asOf: "2026-10-13", prior: "2026-10-12", reason: null, partial: true, excluded: [{ accountId: B, reason: "balance_only" }] });
    const byId = new Map(s13.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(A)!.dayChange).toMatchObject({ cents: 38038n, asOf: "2026-10-13", prior: "2026-10-12", reason: null });
    const aLines = new Map(byId.get(A)!.dayChange.lines.map((l) => [l.securityId, l.cents]));
    expect(aLines.get(VTI)).toBe(22500n);
    expect(aLines.get(VFIAX)).toBe(15538n);
    expect(aLines.size).toBe(2);
    expect(byId.get(B)!.dayChange).toMatchObject({ cents: null, reason: "balance_only" });
    expect(byId.get(C)!.dayChange).toMatchObject({ cents: 2000n });
    // bp over the included accounts' prior value: 40,038 / (5,807,669 + 202,000 − 40,038) → 67 bp (truncated).
    expect(s13.dayChange.bp).toBe(67);

    // The morning after: the feed can only have the 10-13 close, so the figures are the same session's.
    const s14 = await valuationSummary(t.db, { asOf: "2026-10-14", today: "2026-10-14", now: new Date("2026-10-14T18:00:00Z"), accountIds: [A, B, C], period: "1w" });
    expect(s14).toMatchObject({ expectedDate: "2026-10-13" });
    expect(s14.dayChange).toMatchObject({ cents: 40038n, asOf: "2026-10-13", prior: "2026-10-12" });

    const s12 = await valuationSummary(t.db, { asOf: "2026-10-12", today: TODAY, now: NOW, accountIds: [A], period: "1w" });
    expect(s12.dayChange).toMatchObject({ cents: 35290n, asOf: "2026-10-12", prior: "2026-10-09" });
    const s9 = await valuationSummary(t.db, { asOf: "2026-10-09", today: TODAY, now: NOW, accountIds: [A], period: "1w" });
    expect(s9.dayChange).toMatchObject({ cents: 4735n, asOf: "2026-10-09", prior: "2026-10-08" });
    const a9 = s9.accounts[0]!.dayChange.lines;
    expect(a9.find((l) => l.securityId === VTI)).toMatchObject({ cents: 11000n, priorPrice: { date: "2026-09-30", source: "implied" } });
    expect(a9.find((l) => l.securityId === VFIAX)).toMatchObject({ cents: -6265n });

    // Balances alone on two consecutive days are not a market move.
    const only = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [B], period: "1w" });
    expect(only.dayChange).toMatchObject({ cents: null, reason: "balance_only", partial: true, excluded: [{ accountId: B, reason: "balance_only" }] });
  });

  it("computes the period change once: start, change, new accounts' opening values, net flows and growth (test 16)", async () => {
    const week = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C], period: "1w" });
    expect(week).toMatchObject({ asOf: "2026-10-13", today: TODAY, expectedDate: "2026-10-20", totalCents: 7029669n, partial: false, missing: [], priceStatus: "current" });
    expect(week.periodChange).toMatchObject({
      period: "1w",
      from: "2026-10-06",
      to: "2026-10-13",
      startCents: 6729606n,
      endCents: 7029669n,
      changeCents: 300063n,
      netFlowsCents: 200000n,
      growthCents: 100063n,
      growthReason: null,
      newAccounts: [{ id: C, name: "C IRA", openingCents: 200000n }],
      incomeCents: 0n,
      uncategorizedRows: 0,
    });
    // 300,063 × 10,000 / 6,729,606 = 445.8… → 445 bp (truncated).
    expect(week.periodChange!.changeBp).toBe(445);
    const rows = new Map(week.periodChange!.accounts.map((a) => [a.accountId, a]));
    expect(rows.get(A)).toMatchObject({ startCents: 5729606n, endCents: 5807669n, changeCents: 78063n, netFlowsCents: 0n, growthCents: 78063n, isNew: false });
    expect(rows.get(B)).toMatchObject({ startCents: 1000000n, endCents: 1020000n, changeCents: 20000n, netFlowsCents: 0n, growthCents: 20000n });
    expect(rows.get(C)).toMatchObject({ startCents: null, endCents: 202000n, isNew: true, openingCents: 200000n, openingDate: "2026-10-12", netFlowsCents: 200000n, growthCents: 2000n });

    const alone = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A], period: "custom", from: "2026-09-30" });
    expect(alone.periodChange).toMatchObject({ from: "2026-09-30", startCents: 5629606n, changeCents: 178063n, netFlowsCents: 100000n, growthCents: 78063n, growthReason: null, changeBp: 316 });

    await t.db.update(account).set({ cashInference: "off" }).where(eq(account.id, A));
    const off = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A], period: "custom", from: "2026-09-30" });
    expect(off.periodChange).toMatchObject({ changeCents: 78063n, netFlowsCents: 100000n, growthCents: null, growthReason: "flows_not_in_value" });
    await t.db.update(account).set({ cashInference: "auto" }).where(eq(account.id, A));

    const ytd = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C], period: "ytd" });
    expect(ytd.periodChange).toMatchObject({ from: "2025-12-31", startCents: null, changeCents: null, changeBp: null, netFlowsCents: 0n, growthCents: null, newAccounts: [] });

    // `all` starts at the earliest data date of the selection; a custom period needs a start on or before the end.
    const all = await valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C], period: "all" });
    expect(all.periodChange).toMatchObject({ from: "2026-09-30", startCents: 5629606n });
    await expect(valuationSummary(t.db, { asOf: "2026-10-13", today: TODAY, now: NOW, accountIds: [A], period: "custom" })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(valuationSummary(t.db, { asOf: "2026-10-12", today: TODAY, now: NOW, accountIds: [A], period: "custom", from: "2026-10-13" })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(valuationSummary(t.db, { asOf: "2026-10-22", today: TODAY, now: NOW, accountIds: [A], period: "1w" })).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  it("marks a missing close stale and carries the last one (scenario S2 in tests 14 and 15)", async () => {
    await t.db.delete(price).where(and(eq(price.securityId, VFIAX), eq(price.date, "2026-10-12")));
    const series = await valuationSeries(t.db, { from: "2026-10-12", to: "2026-10-13", today: TODAY, now: NOW, accountIds: [A, B, C] });
    expect(series.portfolio.map((p) => [p.valueCents, p.priceStatus])).toEqual([
      [6973341n, "stale"],
      [7029669n, "current"],
    ]);
    const v12 = await valueOn(A, "2026-10-12");
    expect(v12).toMatchObject({ valueCents: 5753341n, priceStatus: "stale", stalest: { securityId: VFIAX, priceDate: "2026-10-09", tradingDaysBehind: 1 } });
    const s12 = await valuationSummary(t.db, { asOf: "2026-10-12", today: TODAY, now: NOW, accountIds: [A], period: "1w" });
    expect(s12.dayChange).toMatchObject({ cents: 19000n, asOf: "2026-10-12", prior: "2026-10-09" });
    expect(s12.accounts[0]!.dayChange.lines.find((l) => l.securityId === VFIAX)).toMatchObject({ cents: 0n, priceStatus: "stale" });
    expect(s12.priceStatus).toBe("stale");
    await t.db.insert(price).values({ securityId: VFIAX, date: "2026-10-12", close: "502", adjClose: "502", source: "provider", provider: "tiingo", suspect: false, fetchedAt: NOW });
  });

  it("ignores a trade that the lots cannot reconcile with the statement: derived fidelity stays positions (test 11)", async () => {
    const [row] = await t.db
      .insert(investmentTxn)
      .values({ accountId: A, securityId: VTI, date: "2026-10-06", type: "buy", quantity: "0.5", price: "300", amountCents: -15000n, source: "manual" })
      .returning({ id: investmentTxn.id });
    const v = await valueOn(A, "2026-10-13");
    expect(v).toMatchObject({ fidelity: "positions", basis: "positions", valueCents: 5807669n });
    const input = await loadValuationInput(t.db, { accountIds: [A], from: "2026-10-13", to: "2026-10-13", now: NOW });
    expect(input.fidelities.get(A)).toMatchObject({ fidelity: "positions", positionsMatch: false });
    expect(input.fidelities.get(A)!.fidelityNote).toMatch(/trade history incomplete/);
    await t.db.delete(investmentTxn).where(eq(investmentTxn.id, row!.id));
  });

  it("lists the investment accounts by name and rejects other ids with 400 bad_request", async () => {
    const [checking] = await t.db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const [closed] = await t.db.insert(account).values({ name: "Closed IRA", type: "ira", taxTreatment: "pre_tax", closed: true }).returning({ id: account.id });
    expect(await investmentAccountIds(t.db)).toEqual([A, B, C, D, E, P, Q]);
    expect(await investmentAccountIds(t.db, [Q, A])).toEqual([A, Q]);
    expect((await listInvestmentAccounts(t.db, { accountIds: [closed!.id], includeClosed: true })).map((a) => a.name)).toEqual(["Closed IRA"]);
    await expect(investmentAccountIds(t.db, [checking!.id])).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(investmentAccountIds(t.db, [closed!.id])).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(investmentAccountIds(t.db, [randomUUID()])).rejects.toBeInstanceOf(PlanError);
    await t.db.delete(account).where(eq(account.id, checking!.id));
    await t.db.delete(account).where(eq(account.id, closed!.id));
  });
});

/**
 * Views design test 2 (`GET /api/investments/portfolio`, period 1y) through the chain on the
 * INV seed: the totals on the data dates, the day change, the period change with income and
 * uncategorized rows, and the daily series. Where the views design carried balance rows, the
 * chain prices B's lots between its statements (see the 2026-10-08 point).
 */
describe.skipIf(!TEST_DATABASE_URL)("valuation services (INV seed, views test 2)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let B: string;
  let R: string;

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

  it("totals 4,525,200 on 10-13 with a day change of +36,000 (80 bp) and the 1y period change of the views design", async () => {
    const s = await valuationSummary(t.db, { asOf: "2026-10-13", today: INV_SEED_TODAY, now: INV_SEED_NOW, period: "1y" });
    expect(s).toMatchObject({ asOf: "2026-10-13", today: "2026-10-14", expectedDate: "2026-10-13", totalCents: 4525200n, partial: false, missing: [], priceStatus: "implied" });
    expect(s.dayChange).toMatchObject({ cents: 36000n, asOf: "2026-10-13", prior: "2026-10-12", bp: 80, partial: false, excluded: [], reason: null });
    expect(s.accounts.map((a) => a.name)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = s.accounts;
    expect(brokerage).toMatchObject({ accountId: B, fidelity: "full_history", basis: "snapshot", asOf: "2026-10-13", valueCents: 2705200n, cashAnchor: "2026-10-13", balanceDiffCents: 0n, priceStatus: "current", lastReconciliation: null });
    expect(brokerage!.dayChange).toMatchObject({ cents: 32000n, asOf: "2026-10-13", prior: "2026-10-12" });
    expect(brokerage!.lines.find((l) => l.kind === "cash_plug")).toMatchObject({ name: CASH_PLUG_NAME, valueCents: 143200n, priceDate: "2026-10-13" });
    expect(brokerage!.lines.filter((l) => l.kind === "position").map((l) => l.valueCents)).toEqual(expect.arrayContaining([1250000n, 712000n, 600000n]));
    expect(roth).toMatchObject({ accountId: R, fidelity: "positions", basis: "positions", asOf: "2026-10-09", valueCents: 1820000n, cashAnchor: "2026-10-09", priceStatus: "implied" });
    expect(roth!.dayChange).toMatchObject({ cents: 4000n });
    expect(roth!.lines.find((l) => l.securityId === S.securities.cash)).toMatchObject({ kind: "cash", valueCents: 27000n });
    expect(roth!.lines.find((l) => l.securityId === S.securities.tr2050)).toMatchObject({ valueCents: 420000n, priceStatus: "implied", valueSource: "carried" });
    expect(roth!.lines.some((l) => l.kind === "cash_plug")).toBe(false);

    expect(s.periodChange).toMatchObject({
      period: "1y",
      from: "2025-10-13",
      to: "2026-10-13",
      startCents: 3500000n,
      endCents: 4525200n,
      changeCents: 1025200n,
      changeBp: 2929,
      netFlowsCents: 500000n,
      growthCents: 525200n,
      growthReason: null,
      incomeCents: 32435n,
      uncategorizedRows: 1,
      newAccounts: [],
    });
    const rows = new Map(s.periodChange!.accounts.map((a) => [a.accountId, a]));
    expect(rows.get(B)).toMatchObject({ startCents: 2000000n, endCents: 2705200n, changeCents: 705200n, netFlowsCents: 500000n, growthCents: 205200n });
    expect(rows.get(R)).toMatchObject({ startCents: 1500000n, endCents: 1820000n, changeCents: 320000n, netFlowsCents: 0n, growthCents: 320000n });
  });

  it("totals 4,489,200 on 10-12 with a flat day change, and rejects a non-investment account", async () => {
    const s = await valuationSummary(t.db, { asOf: "2026-10-12", today: INV_SEED_TODAY, now: INV_SEED_NOW, period: "1m" });
    expect(s).toMatchObject({ totalCents: 4489200n });
    expect(s.dayChange).toMatchObject({ cents: 0n, bp: 0, asOf: "2026-10-12", prior: "2026-10-09" });
    const byId = new Map(s.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(B)!.dayChange.cents).toBe(-6000n);
    expect(byId.get(R)!.dayChange.cents).toBe(6000n);
    await expect(valuationSummary(t.db, { asOf: "2026-10-12", today: INV_SEED_TODAY, now: INV_SEED_NOW, period: "1m", accountIds: [S.accounts.checking] })).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("builds the 1y daily series: 366 points, 3,500,000 at the start, the chain's values on the data dates", async () => {
    const series = await valuationSeries(t.db, { from: "2025-10-13", to: "2026-10-13", today: INV_SEED_TODAY, now: INV_SEED_NOW });
    expect(series.dates).toHaveLength(366);
    const at = (date: IsoDate) => series.portfolio[series.dates.indexOf(date)]!.valueCents;
    expect(at("2025-10-13")).toBe(3500000n);
    // B is priced from its lots between statements (VTI 290, VXUS 66, AAPL 236 on 10-08, cash rolled from the 2025-10-13 anchor): 2,553,200 + R's 1,500,000.
    expect(at("2026-10-08")).toBe(4053200n);
    expect(at("2026-10-09")).toBe(4489200n);
    expect(at("2026-10-12")).toBe(4489200n);
    expect(at("2026-10-13")).toBe(4525200n);
    const byId = new Map(series.accounts.map((a) => [a.accountId, a]));
    const r = byId.get(R)!;
    const rAt = (date: IsoDate) => r.values[series.dates.indexOf(date)];
    expect(rAt("2025-10-13")).toBe(1500000n);
    expect(rAt("2026-10-08")).toBe(1500000n);
    expect(rAt("2026-10-09")).toBe(1810000n);
    expect(rAt("2026-10-12")).toBe(1816000n);
    expect(rAt("2026-10-13")).toBe(1820000n);
    const b = byId.get(B)!;
    expect(b.values[series.dates.indexOf("2026-04-12")]).toBe(2038360n);
    expect(series.accounts.map((a) => [a.name, a.fidelity, a.firstDataDate])).toEqual([
      ["Fidelity Roth IRA", "positions", "2025-10-13"],
      ["Vanguard Brokerage", "full_history", "2024-03-01"],
    ]);
    expect(series.portfolio.every((p) => !p.partial)).toBe(true);
  });
});
