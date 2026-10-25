import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFixed8 } from "@meridian/shared";
import { account, balanceSnapshot, holdingSnapshot, job, price } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { listAudit } from "./audit.js";
import { deleteSnapshot, getSnapshot, latestSnapshot, listPositions, listSnapshots, rebuildImpliedPrices, replaceHoldingSnapshot, setManualPositions } from "./holdings.js";
import { getPrice, upsertPrices } from "./prices.js";
import { createSecurity, setManualPrice } from "./securities.js";

const TODAY = INV_SEED_TODAY;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });
const f8 = parseFixed8;

describe.skipIf(!TEST_DATABASE_URL)("holding snapshots", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let M: string;
  let M2: string;
  let tgt: string;

  const balanceRow = async (accountId: string, date: string) => (await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, accountId), eq(balanceSnapshot.date, date))))[0];
  const accountRow = async (id: string) => (await t.db.select({ balanceCents: account.balanceCents, balanceDate: account.balanceDate }).from(account).where(eq(account.id, id)))[0]!;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    const manual = await t.db
      .insert(account)
      .values([
        { name: "Manual Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "Manual 401k", type: "401k", taxTreatment: "pre_tax", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    M = manual.find((a) => a.name === "Manual Brokerage")!.id;
    M2 = manual.find((a) => a.name === "Manual 401k")!.id;
    tgt = (await createSecurity(t.db, { name: "Target 2045 Collective Trust", type: "fund", assetClass: "us_stock" }, ctx())).id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("writes positions and the balance row for an account without a feed; a delete rolls both back (imports test 24)", async () => {
    const first = await replaceHoldingSnapshot(t.db, {
      accountId: M,
      date: "2026-10-10",
      source: "manual",
      positions: [{ securityId: S.securities.vti, quantity: f8("2"), price: f8("500"), valueCents: 100000n, reportedCostBasisCents: null }],
      today: TODAY,
    });
    expect(first).toMatchObject({ inserted: 1, updated: 0, unchanged: 0, deleted: 0, totalValueCents: 100000n, knownBalanceCents: null, differenceCents: null, matchesToDollar: null, balanceWritten: true, balanceCents: 100000n, simplefinFed: false });
    expect(await balanceRow(M, "2026-10-10")).toMatchObject({ balanceCents: 100000n, source: "manual" });
    expect(await accountRow(M)).toEqual({ balanceCents: 100000n, balanceDate: "2026-10-10" });

    // 12.75 × 250.00 = 3,187.50; 2 × 75.125 = 150.25; the price of the first row is derived (318750 ÷ 12.75 = 250).
    const csvSet = [
      { securityId: S.securities.vti, quantity: f8("12.75"), price: null, valueCents: 318750n, reportedCostBasisCents: 260000n },
      { securityId: S.securities.bnd, quantity: f8("2"), price: f8("75.125"), valueCents: 15025n, reportedCostBasisCents: null },
    ];
    const second = await replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-13", source: "csv", positions: csvSet, today: TODAY });
    expect(second).toMatchObject({ inserted: 2, totalValueCents: 333775n, balanceWritten: true, balanceCents: 333775n });
    expect(await balanceRow(M, "2026-10-13")).toMatchObject({ balanceCents: 333775n, source: "csv" });
    expect(await accountRow(M)).toEqual({ balanceCents: 333775n, balanceDate: "2026-10-13" });
    const snap = (await getSnapshot(t.db, M, "2026-10-13"))!;
    expect(snap).toMatchObject({ source: "csv", totalValueCents: 333775n, knownBalanceCents: null, importLogId: null });
    expect(snap.rows.map((r) => [r.ticker, r.quantity, r.price, r.valueCents, r.reportedCostBasisCents]).sort()).toEqual(
      [
        ["VTI", f8("12.75"), f8("250"), 318750n, 260000n],
        ["BND", f8("2"), f8("75.125"), 15025n, null],
      ].sort(),
    );

    // The same set again changes nothing; an earlier date never moves the account balance forward.
    const again = await replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-13", source: "csv", positions: csvSet, today: TODAY });
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, deleted: 0 });
    const earlier = await replaceHoldingSnapshot(t.db, {
      accountId: M,
      date: "2026-10-11",
      source: "csv",
      positions: [{ securityId: S.securities.vti, quantity: f8("1"), price: f8("300"), valueCents: 30000n, reportedCostBasisCents: null }],
      statementTotalCents: 31234n,
      today: TODAY,
    });
    expect(earlier).toMatchObject({ balanceWritten: true, balanceCents: 31234n });
    expect(await balanceRow(M, "2026-10-11")).toMatchObject({ balanceCents: 31234n, source: "csv" });
    expect(await accountRow(M)).toEqual({ balanceCents: 333775n, balanceDate: "2026-10-13" });
    expect((await listSnapshots(t.db, M)).map((s) => [s.date, s.source, s.positions, s.totalValueCents])).toEqual([
      ["2026-10-13", "csv", 2, 333775n],
      ["2026-10-11", "csv", 1, 30000n],
      ["2026-10-10", "manual", 1, 100000n],
    ]);
    expect((await latestSnapshot(t.db, M, "2026-10-12"))!.date).toBe("2026-10-11");
    expect((await listPositions(t.db, M, "2026-10-09"))).toBeUndefined();
    expect((await listPositions(t.db, M, TODAY))!.date).toBe("2026-10-13");

    // A replaced set drops the rows that left and updates the ones that changed.
    const replaced = await replaceHoldingSnapshot(t.db, {
      accountId: M,
      date: "2026-10-13",
      source: "csv",
      positions: [{ securityId: S.securities.bnd, quantity: f8("160"), price: f8("1"), valueCents: 16000n, reportedCostBasisCents: null }],
      today: TODAY,
    });
    expect(replaced).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, deleted: 1, totalValueCents: 16000n, balanceCents: 16000n });
    expect(await accountRow(M)).toEqual({ balanceCents: 16000n, balanceDate: "2026-10-13" });

    // Delete the 10-13 set: its balance row goes, the account falls back to the latest remaining reported balance.
    const batch = randomUUID();
    const deleted = await deleteSnapshot(t.db, M, "2026-10-13", ctx(batch));
    expect(deleted).toEqual({ deleted: 1, balanceRemoved: true, impliedPricesRemoved: 0 });
    expect(await balanceRow(M, "2026-10-13")).toBeUndefined();
    expect(await accountRow(M)).toEqual({ balanceCents: 31234n, balanceDate: "2026-10-11" });
    expect(await getSnapshot(t.db, M, "2026-10-13")).toBeUndefined();
    const audit = await listAudit(t.db, { batchId: batch, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ entity: "holding_snapshot", entityId: `${M}:2026-10-13`, action: "delete", after: null });
    expect(audit.items[0]!.before).toEqual([{ securityId: S.securities.bnd, quantity: "160", price: "1", valueCents: "16000", reportedCostBasisCents: null }]);
    const valuationJobs = await t.db.select().from(job).where(eq(job.type, "investments.valuation"));
    expect(valuationJobs.map((j) => j.payload["dedupeKey"])).toEqual([`investments.valuation:${M}`]);
    await expect(deleteSnapshot(t.db, M, "2026-10-13", ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(deleteSnapshot(t.db, S.accounts.brokerage, "2026-10-13", ctx())).rejects.toMatchObject({ status: 409, code: "snapshot_source" });
  });

  it("refuses the future, non-investment accounts, unknown securities and lower-ranked overwrites (imports test 9)", async () => {
    const vti = { securityId: S.securities.vti, quantity: f8("1"), price: f8("300"), valueCents: 30000n, reportedCostBasisCents: null };
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-15", source: "csv", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 400, code: "future_date" });
    await expect(replaceHoldingSnapshot(t.db, { accountId: S.accounts.checking, date: "2026-10-13", source: "csv", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 400, code: "not_investment_account" });
    await expect(replaceHoldingSnapshot(t.db, { accountId: randomUUID(), date: "2026-10-13", source: "csv", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 404 });
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-13", source: "csv", positions: [{ ...vti, securityId: randomUUID() }], today: TODAY })).rejects.toMatchObject({ status: 404 });
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-13", source: "csv", positions: [vti, vti], today: TODAY })).rejects.toMatchObject({ status: 400, code: "validation" });

    // csv over the 10-10 manual set → 409; manual over csv replaces and is audited; csv afterwards → 409.
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-10", source: "csv", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 409, code: "snapshot_precedence" });
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-10", source: "simplefin", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 409, code: "snapshot_precedence" });
    const batch = randomUUID();
    const manual = await setManualPositions(
      t.db,
      { accountId: M, asOfDate: "2026-10-11", positions: [{ security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("13"), price: f8("250") }] },
      ctx(batch),
    );
    // VTI has no close on 10-11 (the feed has 10-09 and 10-12), so the statement's 250 becomes that day's implied close.
    expect(manual).toMatchObject({ inserted: 0, updated: 1, deleted: 0, totalValueCents: 325000n, balanceWritten: true, balanceCents: 325000n, impliedPrices: 1, securitiesCreated: 0 });
    expect((await getPrice(t.db, S.securities.vti, "2026-10-11"))!).toMatchObject({ source: "implied", close: f8("250") });
    expect(manual.snapshot).toMatchObject({ source: "manual", totalValueCents: 325000n });
    expect(await balanceRow(M, "2026-10-11")).toMatchObject({ balanceCents: 325000n, source: "manual" });
    const audit = await listAudit(t.db, { batchId: batch, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ entity: "holding_snapshot", entityId: `${M}:2026-10-11`, action: "update" });
    expect(audit.items[0]!.before).toEqual([{ securityId: S.securities.vti, quantity: "1", price: "300", valueCents: "30000", reportedCostBasisCents: null }]);
    expect(audit.items[0]!.after).toEqual([{ securityId: S.securities.vti, quantity: "13", price: "250", valueCents: "325000", reportedCostBasisCents: null }]);
    await expect(replaceHoldingSnapshot(t.db, { accountId: M, date: "2026-10-11", source: "csv", positions: [vti], today: TODAY })).rejects.toMatchObject({ status: 409, code: "snapshot_precedence" });

    // An identical re-save writes no audit row and queues nothing new.
    const jobsBefore = (await t.db.select().from(job)).length;
    const again = randomUUID();
    const same = await setManualPositions(
      t.db,
      { accountId: M, asOfDate: "2026-10-11", positions: [{ security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("13"), price: f8("250") }] },
      ctx(again),
    );
    expect(same).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, deleted: 0 });
    expect((await listAudit(t.db, { batchId: again, limit: 5 })).items).toHaveLength(0);
    expect((await t.db.select().from(job)).length).toBe(jobsBefore);
    await expect(setManualPositions(t.db, { accountId: M, asOfDate: "2026-10-15", positions: [{ security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("1"), price: f8("1") }] }, ctx())).rejects.toMatchObject({ status: 400, code: "future_date" });
    await expect(setManualPositions(t.db, { accountId: M, asOfDate: "2026-10-12", positions: [{ security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("1") }] }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(setManualPositions(t.db, { accountId: M, asOfDate: "2026-10-12", positions: [{ security: { kind: "existing", securityId: S.securities.vti }, price: f8("1") }] }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  it("positions editor: choices, derived prices and values, aggregation, cash by name", async () => {
    const result = await setManualPositions(
      t.db,
      {
        accountId: M,
        asOfDate: "2026-10-12",
        positions: [
          { security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("1"), price: f8("300") },
          { security: { kind: "existing", securityId: S.securities.vti }, quantity: f8("2"), price: f8("300"), costBasisCents: 50000n },
          { security: { kind: "create", security: { ticker: "NEWCO", cusip: null, isin: null, name: "New Co", type: "stock", assetClass: "other" } }, quantity: f8("4"), valueCents: 1000n },
          { security: { kind: "create", security: { ticker: null, cusip: null, isin: null, name: "Cash", type: "cash", assetClass: "cash" } }, valueCents: 12345n },
          { security: { kind: "create", security: { ticker: "BND", cusip: null, isin: null, name: "Vanguard Total Bond Market ETF", type: "etf", assetClass: "bonds" } }, valueCents: 7480n },
        ],
      },
      ctx(),
    );
    expect(result).toMatchObject({ inserted: 4, securitiesCreated: 1, totalValueCents: 90000n + 1000n + 12345n + 7480n });
    const rows = result.snapshot.rows;
    expect(rows.find((r) => r.ticker === "VTI")).toMatchObject({ quantity: f8("3"), price: f8("300"), valueCents: 90000n, reportedCostBasisCents: null });
    expect(rows.find((r) => r.ticker === "NEWCO")).toMatchObject({ quantity: f8("4"), price: f8("2.5"), valueCents: 1000n });
    expect(rows.find((r) => r.type === "cash")).toMatchObject({ securityId: S.securities.cash, quantity: f8("123.45"), price: f8("1"), valueCents: 12345n });
    // A dollar-only row (no quantity) keeps its value and gets no price.
    expect(rows.find((r) => r.ticker === "BND")).toMatchObject({ securityId: S.securities.bnd, quantity: null, price: null, valueCents: 7480n });
    expect(await t.db.select().from(price).where(and(eq(price.securityId, S.securities.cash)))).toEqual([]);
    expect(await t.db.select().from(price).where(and(eq(price.securityId, S.securities.bnd), eq(price.date, "2026-10-12")))).toMatchObject([{ source: "provider" }]);
  });

  it("rebuilds implied prices deterministically: largest value wins a same-date tie; manual and cash never touched (prices test 8, imports test 20)", async () => {
    // 4,725,000 ÷ 1,250 = 37.80; 945,000 ÷ 250 = 37.80.
    await replaceHoldingSnapshot(t.db, {
      accountId: M,
      date: "2026-10-31",
      source: "csv",
      positions: [
        { securityId: tgt, quantity: f8("1250"), price: null, valueCents: 4725000n, reportedCostBasisCents: null },
        { securityId: S.securities.cash, quantity: f8("100"), price: f8("1"), valueCents: 10000n, reportedCostBasisCents: null },
      ],
      today: "2026-11-01",
    });
    await replaceHoldingSnapshot(t.db, {
      accountId: M2,
      date: "2026-10-31",
      source: "csv",
      positions: [{ securityId: tgt, quantity: f8("250"), price: f8("37.8"), valueCents: 945000n, reportedCostBasisCents: null }],
      today: "2026-11-01",
    });
    const first = await rebuildImpliedPrices(t.db, { securityIds: [tgt, S.securities.cash], dates: ["2026-10-31"] });
    expect(first).toEqual({ written: 1, removed: 0 });
    const implied = (await getPrice(t.db, tgt, "2026-10-31"))!;
    expect(implied).toMatchObject({ source: "implied", close: f8("37.8"), provider: null, suspect: false });
    expect(await getPrice(t.db, S.securities.cash, "2026-10-31")).toBeUndefined();

    // The smaller position reports 37.81: the larger value still wins; a second run writes nothing.
    await t.db.update(holdingSnapshot).set({ price: "37.81" }).where(and(eq(holdingSnapshot.accountId, M2), eq(holdingSnapshot.securityId, tgt)));
    expect(await rebuildImpliedPrices(t.db, { securityIds: [tgt], dates: ["2026-10-31"] })).toEqual({ written: 0, removed: 0 });
    expect((await getPrice(t.db, tgt, "2026-10-31"))!.close).toBe(f8("37.8"));
    await t.db.update(holdingSnapshot).set({ valueCents: 4725001n }).where(and(eq(holdingSnapshot.accountId, M2), eq(holdingSnapshot.securityId, tgt)));
    // The household-wide repair also derives VTI's 10-10 close (500) from the first test's manual set, which never ran a rebuild.
    expect(await rebuildImpliedPrices(t.db, {})).toEqual({ written: 2, removed: 0 });
    expect((await getPrice(t.db, S.securities.vti, "2026-10-10"))!).toMatchObject({ source: "implied", close: f8("500") });
    expect((await getPrice(t.db, tgt, "2026-10-31"))!.close).toBe(f8("37.81"));
    expect((await t.db.select().from(price).where(and(eq(price.securityId, tgt), eq(price.date, "2026-10-31")))).length).toBe(1);

    // A manual close outranks the rebuild; a provider close outranks an implied write (imports test 20).
    await setManualPrice(t.db, tgt, { date: "2026-10-31", close: f8("37.9") }, { ...ctx(), today: "2026-11-01" });
    expect(await rebuildImpliedPrices(t.db, { securityIds: [tgt], dates: ["2026-10-31"] })).toEqual({ written: 0, removed: 0 });
    expect((await getPrice(t.db, tgt, "2026-10-31"))!).toMatchObject({ source: "manual", close: f8("37.9") });
    expect(await upsertPrices(t.db, [{ securityId: S.securities.vti, date: "2026-10-13", close: f8("250"), source: "implied" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect((await getPrice(t.db, S.securities.vti, "2026-10-13"))!.close).toBe(f8("312.5"));

    // A deleted set takes the implied rows only it derived.
    await replaceHoldingSnapshot(t.db, {
      accountId: M2,
      date: "2026-11-01",
      source: "csv",
      positions: [{ securityId: tgt, quantity: f8("10"), price: null, valueCents: 38000n, reportedCostBasisCents: null }],
      today: "2026-11-01",
    });
    expect(await rebuildImpliedPrices(t.db, { securityIds: [tgt], dates: ["2026-11-01"] })).toEqual({ written: 1, removed: 0 });
    expect((await getPrice(t.db, tgt, "2026-11-01"))!.close).toBe(f8("38"));
    const deleted = await deleteSnapshot(t.db, M2, "2026-11-01", ctx());
    expect(deleted).toMatchObject({ deleted: 1, impliedPricesRemoved: 1 });
    expect(await getPrice(t.db, tgt, "2026-11-01")).toBeUndefined();
    expect((await getPrice(t.db, tgt, "2026-10-31"))!.source).toBe("manual");

    // A dollar-only row (quantity null) derives no price (imports test 20); its value still reaches the balance row.
    const dollarOnly = await replaceHoldingSnapshot(t.db, {
      accountId: M2,
      date: "2026-11-01",
      source: "csv",
      positions: [{ securityId: tgt, quantity: null, price: null, valueCents: 38000n, reportedCostBasisCents: null }],
      today: "2026-11-01",
    });
    expect(dollarOnly).toMatchObject({ inserted: 1, totalValueCents: 38000n, balanceWritten: true, balanceCents: 38000n });
    expect(await rebuildImpliedPrices(t.db, { securityIds: [tgt], dates: ["2026-11-01"] })).toEqual({ written: 0, removed: 0 });
    expect(await getPrice(t.db, tgt, "2026-11-01")).toBeUndefined();
    expect((await getSnapshot(t.db, M2, "2026-11-01"))!.rows).toMatchObject([{ securityId: tgt, quantity: null, price: null, valueCents: 38000n }]);
  });

  it("SimpleFIN-fed accounts: the Bridge balance is the comparison; balances are written only on request (imports test 24)", async () => {
    const B = S.accounts.brokerage;
    const set = [
      { securityId: S.securities.vti, quantity: f8("40"), price: f8("312.5"), valueCents: 1250000n, reportedCostBasisCents: null },
      { securityId: S.securities.vxus, quantity: f8("100"), price: f8("71.2"), valueCents: 712000n, reportedCostBasisCents: null },
      { securityId: S.securities.aapl, quantity: f8("25"), price: f8("240"), valueCents: 600000n, reportedCostBasisCents: null },
    ];
    const noBalance = await replaceHoldingSnapshot(t.db, { accountId: B, date: "2026-10-14", source: "csv", positions: set, today: TODAY });
    expect(noBalance).toMatchObject({ inserted: 3, totalValueCents: 2562000n, knownBalanceCents: 2705200n, differenceCents: -143200n, matchesToDollar: false, balanceWritten: false, balanceCents: null, simplefinFed: true });
    expect(await balanceRow(B, "2026-10-14")).toBeUndefined();
    expect(await accountRow(B)).toEqual({ balanceCents: 2705200n, balanceDate: "2026-10-13" });
    expect((await getSnapshot(t.db, B, "2026-10-14"))!).toMatchObject({ knownBalanceCents: 2705200n, differenceCents: -143200n, matchesToDollar: false });

    const toTheDollar = await replaceHoldingSnapshot(t.db, {
      accountId: B,
      date: "2026-10-14",
      source: "csv",
      positions: [...set, { securityId: S.securities.cash, quantity: f8("1431.41"), price: f8("1"), valueCents: 143141n, reportedCostBasisCents: null }],
      today: TODAY,
    });
    expect(toTheDollar).toMatchObject({ inserted: 1, unchanged: 3, differenceCents: -59n, matchesToDollar: true, balanceWritten: false });

    const withBalance = await replaceHoldingSnapshot(t.db, { accountId: B, date: "2026-10-14", source: "csv", positions: set, setBalance: true, today: TODAY });
    expect(withBalance).toMatchObject({ deleted: 1, balanceWritten: true, balanceCents: 2562000n });
    expect(await balanceRow(B, "2026-10-14")).toMatchObject({ balanceCents: 2562000n, source: "csv" });
    expect(await accountRow(B)).toEqual({ balanceCents: 2562000n, balanceDate: "2026-10-14" });

    // A manual balance row on that date survives a csv write (seams C41).
    await t.db.update(balanceSnapshot).set({ source: "manual", balanceCents: 2600000n }).where(and(eq(balanceSnapshot.accountId, B), eq(balanceSnapshot.date, "2026-10-14")));
    const blocked = await replaceHoldingSnapshot(t.db, { accountId: B, date: "2026-10-14", source: "csv", positions: set, setBalance: true, statementTotalCents: 2561000n, today: TODAY });
    expect(blocked).toMatchObject({ unchanged: 3, balanceWritten: false });
    expect(await balanceRow(B, "2026-10-14")).toMatchObject({ balanceCents: 2600000n, source: "manual" });
    const ordered = await t.db.select({ securityId: holdingSnapshot.securityId }).from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, B), eq(holdingSnapshot.date, "2026-10-14"))).orderBy(asc(holdingSnapshot.securityId));
    expect(ordered.map((r) => r.securityId)).toEqual([S.securities.vti, S.securities.vxus, S.securities.aapl].sort());
  });
});
