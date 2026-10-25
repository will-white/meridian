import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFixed8, type IsoDate } from "@meridian/shared";
import { account, accountReconciliation, auditLog, balanceSnapshot, holdingSnapshot, job, price, security, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { PlanError } from "./audit.js";
import { commitReconciliation, deleteReconciliation, getReconciliation, listReconciliations, previewReconciliation } from "./reconcile.js";
import { cashSecurity } from "./securities.js";
import { valueAccountsOn } from "./valuation.js";

const f8 = parseFixed8;

/**
 * Prices design §7 tests 17–19 (scenario S1, account A, cash inference auto, statement 10-13)
 * through the reconcile service, plus the views design's reconcile panel on the INV seed.
 * The seeded SimpleFIN balance of the design's test 18 is a `computed` row here: under the
 * plan's chain a reported balance dated on the statement date would anchor cash on that day.
 */
describe.skipIf(!TEST_DATABASE_URL)("reconcile (prices tests 17–19)", () => {
  let t: TestDb;
  /** 11:00 in New York on 2026-10-21: the latest completed close is 10-20. */
  const NOW = new Date("2026-10-21T15:00:00Z");
  const TODAY: IsoDate = "2026-10-21";
  let A: string;
  let A2: string;
  let VTI: string;
  let VFIAX: string;
  let FXAIX: string;
  let NEWP: string;
  let CASH: string;
  const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY, now: NOW });

  const statementRows = (vfiaxPrice = "505.1", vtiQuantity = "100") => [
    { ticker: "VTI", quantity: f8(vtiQuantity), price: f8("305.25") },
    { ticker: "VFIAX", quantity: f8("50.123"), price: f8(vfiaxPrice) },
    { ticker: "Cash", quantity: f8("2234.56"), valueCents: 223456n },
  ];

  const countRows = async () => ({
    audit: (await t.db.select().from(auditLog)).length,
    snapshots: (await t.db.select().from(holdingSnapshot)).length,
    balances: (await t.db.select().from(balanceSnapshot)).length,
    prices: (await t.db.select().from(price)).length,
    jobs: (await t.db.select().from(job)).length,
    reconciliations: (await t.db.select().from(accountReconciliation)).length,
  });

  beforeAll(async () => {
    t = await createTestDb();
    const accounts = await t.db
      .insert(account)
      .values([
        { name: "A Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "A2 Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    A = accounts.find((a) => a.name === "A Brokerage")!.id;
    A2 = accounts.find((a) => a.name === "A2 Brokerage")!.id;
    const secs = await t.db
      .insert(security)
      .values([
        { ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "VFIAX", name: "Vanguard 500 Index Admiral", type: "fund", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "FXAIX", name: "Fidelity 500 Index", type: "fund", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "NEWP", name: "Newly Referenced Corp", type: "stock", assetClass: "us_stock", priceMode: "provider", needsReview: false },
      ])
      .returning({ id: security.id, ticker: security.ticker });
    const sec = (ticker: string) => secs.find((s) => s.ticker === ticker)!.id;
    VTI = sec("VTI");
    VFIAX = sec("VFIAX");
    FXAIX = sec("FXAIX");
    NEWP = sec("NEWP");
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
      provider(FXAIX, "2026-10-13", "202"),
    ]);
    const snap = (accountId: string, date: IsoDate, securityId: string, quantity: string, priceValue: string, valueCents: bigint, source: "csv" | "manual" = "csv") => ({
      accountId,
      date,
      source,
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
      // A2: a CSV snapshot on the statement date with an extra row, and an older manual one.
      snap(A2, "2026-10-13", VTI, "10", "305.25", 305250n),
      snap(A2, "2026-10-13", FXAIX, "5", "202", 101000n),
      snap(A2, "2026-10-10", VTI, "10", "303", 303000n, "manual"),
    ]);
    await t.db.insert(balanceSnapshot).values([
      { accountId: A, date: "2026-09-30", balanceCents: 5629606n, source: "csv" },
      { accountId: A2, date: "2026-10-10", balanceCents: 303000n, source: "manual" },
      { accountId: A2, date: "2026-10-13", balanceCents: 406250n, source: "csv" },
    ]);
    await t.db.insert(transaction).values({ accountId: A, source: "manual", date: "2026-10-05", amountCents: 100000n, rawDescription: "TRANSFER IN", isTransfer: true });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("previews the statement against the chain: match ×3, difference 0, the 09-30 balance block, no writes (test 17)", async () => {
    const before = await countRows();
    const p = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows() }, { today: TODAY, now: NOW });
    expect(p).toMatchObject({
      accountId: A,
      date: "2026-10-13",
      statementTotalCents: 5807669n,
      differenceCents: 0n,
      unexplainedCents: 0n,
      toleranceCents: 100n,
      matchesToDollar: true,
      alreadyReconciled: false,
      cashInference: "auto",
      cashInferenceHint: null,
      balance: { balanceCents: 5629606n, balanceDate: "2026-09-30", differenceCents: -178063n },
    });
    expect(p.app).toMatchObject({ basis: "positions", asOf: "2026-09-30", valueCents: 5807669n });
    expect(p.rows.map((r) => [r.ticker ?? r.name, r.status])).toEqual([
      ["VFIAX", "match"],
      ["VTI", "match"],
      ["Cash", "match"],
    ]);
    const cashRow = p.rows.find((r) => r.isCash)!;
    expect(cashRow).toMatchObject({ securityId: CASH, app: { quantity: f8("1234.56"), valueCents: 223456n, valueSource: "carried" }, statement: { quantity: f8("2234.56"), valueCents: 223456n }, valueDiffCents: 0n });
    expect(p.rows.find((r) => r.ticker === "VTI")).toMatchObject({ app: { quantity: f8("100"), price: f8("305.25"), priceDate: "2026-10-13", priceSource: "provider", valueCents: 3052500n }, quantityDiff: 0n, priceDiff: 0n });
    expect(await countRows()).toEqual(before);
  });

  it("shows what auto cash inference would have done for an account with it off (test 17, off)", async () => {
    await t.db.update(account).set({ cashInference: "off" }).where(eq(account.id, A));
    const p = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows() }, { today: TODAY, now: NOW });
    expect(p).toMatchObject({ differenceCents: -100000n, matchesToDollar: false, cashInference: "off", unexplainedCents: 0n });
    expect(p.app.valueCents).toBe(5707669n);
    expect(p.rows.find((r) => r.isCash)).toMatchObject({ status: "cash", valueDiffCents: -100000n, app: { valueCents: 123456n } });
    expect(p.cashInferenceHint).toEqual({ flowsSinceSnapshotCents: 100000n, plugCents: 0n, wouldReconcile: true });
    await t.db.update(account).set({ cashInference: "auto" }).where(eq(account.id, A));
  });

  it("flags a price difference (P, −$1.00 is not to the dollar), a quantity difference (Q) and a total-only statement (test 17)", async () => {
    const p = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows("505.12") }, { today: TODAY, now: NOW });
    expect(p).toMatchObject({ statementTotalCents: 5807769n, differenceCents: -100n, unexplainedCents: 0n, matchesToDollar: false });
    expect(p.rows.find((r) => r.ticker === "VFIAX")).toMatchObject({
      status: "price",
      app: { price: f8("505.1"), priceSource: "provider", valueCents: 2531713n },
      statement: { price: f8("505.12"), valueCents: 2531813n },
      quantityDiff: 0n,
      priceDiff: f8("-0.02"),
      valueDiffCents: -100n,
    });

    const q = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows("505.1", "101") }, { today: TODAY, now: NOW });
    expect(q).toMatchObject({ differenceCents: -30525n, unexplainedCents: 0n, matchesToDollar: false });
    expect(q.rows.find((r) => r.ticker === "VTI")).toMatchObject({ status: "quantity", quantityDiff: f8("-1"), valueDiffCents: -30525n });

    const totalOnly = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: [], statementTotalCents: 5807700n }, { today: TODAY, now: NOW });
    expect(totalOnly).toMatchObject({ differenceCents: -31n, matchesToDollar: true, unexplainedCents: 0n });
    expect(totalOnly.rows).toHaveLength(1);
    expect(totalOnly.rows[0]).toMatchObject({ securityId: null, name: "Statement total", status: "match", valueDiffCents: -31n });
  });

  it("reports rows missing on either side, unknown tickers, and rejects duplicates, valueless rows and future dates (test 17)", async () => {
    const p = await previewReconciliation(
      t.db,
      { accountId: A, date: "2026-10-13", rows: [{ ticker: "vti", quantity: f8("100"), price: f8("305.25") }, { ticker: "FXAIX", quantity: f8("10"), price: f8("202") }, { ticker: "ZZZZ", quantity: f8("1"), valueCents: 100n }, { isCash: true, quantity: f8("2234.56") }] },
      { today: TODAY, now: NOW },
    );
    const status = (ticker: string) => p.rows.find((r) => r.ticker === ticker)?.status;
    expect(status("VTI")).toBe("match");
    expect(status("VFIAX")).toBe("missing_in_statement");
    expect(status("FXAIX")).toBe("missing_in_app");
    expect(p.rows.find((r) => r.ticker === "ZZZZ")).toMatchObject({ securityId: null, status: "unknown_ticker", app: null, statement: { valueCents: 100n } });
    expect(p.rows.find((r) => r.isCash)).toMatchObject({ status: "match", statement: { valueCents: 223456n } });
    expect(p.statementTotalCents).toBe(3052500n + 202000n + 100n + 223456n);

    const dup = { accountId: A, date: "2026-10-13", rows: [...statementRows(), { ticker: "VTI", quantity: f8("1"), price: f8("1") }] };
    await expect(previewReconciliation(t.db, dup, { today: TODAY, now: NOW })).rejects.toMatchObject({ status: 400, code: "duplicate_security" });
    await expect(previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: [{ ticker: "VTI", quantity: f8("100") }] }, { today: TODAY, now: NOW })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(previewReconciliation(t.db, { accountId: A, date: "2026-10-22", rows: statementRows() }, { today: TODAY, now: NOW })).rejects.toMatchObject({ status: 400, code: "future_date" });
    await expect(previewReconciliation(t.db, { accountId: randomUUID(), date: "2026-10-13", rows: [] }, { today: TODAY, now: NOW })).rejects.toBeInstanceOf(PlanError);
  });

  it("commits with accept: a manual snapshot and balance row, prices kept, the record, the audit, the valuation job; the value then equals the statement (tests 18–19)", async () => {
    // A computed row on the statement date is replaced by the manual balance (the chain ignores it before).
    await t.db.insert(balanceSnapshot).values({ accountId: A, date: "2026-10-13", balanceCents: 5800000n, source: "computed" });
    const c = ctx();
    const r = await commitReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows(), accept: true }, c);
    expect(r).toMatchObject({ accepted: true, preCommitDifferenceCents: 0n, matchesToDollar: true, rowsWritten: 3, batchId: c.batchId });
    expect(r.app).toMatchObject({ basis: "snapshot", asOf: "2026-10-13", valueCents: 5807669n });
    expect(r.app.valueCents).toBe(r.preview.statementTotalCents);

    const rows = await t.db.select().from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, A), eq(holdingSnapshot.date, "2026-10-13")));
    expect(rows.map((x) => [x.securityId, x.source, x.quantity, x.valueCents]).sort()).toEqual(
      [
        [VTI, "manual", "100.00000000", 3052500n],
        [VFIAX, "manual", "50.12300000", 2531713n],
        [CASH, "manual", "2234.56000000", 223456n],
      ].sort(),
    );
    const [bal] = await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, A), eq(balanceSnapshot.date, "2026-10-13")));
    expect(bal).toMatchObject({ balanceCents: 5807669n, source: "manual" });
    const closes = await t.db.select({ securityId: price.securityId, source: price.source, close: price.close }).from(price).where(eq(price.date, "2026-10-13"));
    expect(closes.find((p) => p.securityId === VTI)).toMatchObject({ source: "provider", close: "305.25000000" });
    expect(closes.find((p) => p.securityId === VFIAX)).toMatchObject({ source: "provider", close: "505.10000000" });

    const [rec] = await t.db.select().from(accountReconciliation).where(eq(accountReconciliation.id, r.reconciliationId));
    expect(rec).toMatchObject({
      accountId: A,
      statementDate: "2026-10-13",
      statementTotalCents: 5807669n,
      appValueCents: 5807669n,
      appBasis: "positions",
      appAsOf: "2026-09-30",
      cashInference: "auto",
      diffCents: 0n,
      balanceCents: 5629606n,
      balanceDiffCents: -178063n,
      toleranceCents: 100n,
      reconciled: true,
      accepted: true,
      holdingSnapshotDate: "2026-10-13",
    });
    expect((rec!.rows as Array<{ status: string }>).map((x) => x.status)).toEqual(["match", "match", "match"]);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "account_reconciliation", entityId: `${A}:2026-10-13`, action: "create", before: null });
    expect(audits[0]!.after).toMatchObject({ statementTotalCents: "5807669", differenceCents: "0", accepted: true });
    const jobs = await t.db.select().from(job).where(eq(job.type, "investments.valuation"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ reason: "reconcile", accountId: A, dedupeKey: `investments.valuation:${A}` });

    const [d13, d14] = await Promise.all([valueAccountsOn(t.db, { accountIds: [A], date: "2026-10-13", now: NOW }), valueAccountsOn(t.db, { accountIds: [A], date: "2026-10-14", now: NOW })]);
    expect(d13[0]).toMatchObject({ basis: "snapshot", valueCents: 5807669n });
    expect(d14[0]).toMatchObject({ basis: "positions", asOf: "2026-10-13", valueCents: 5807669n });
    expect(d14[0]!.lines.some((l) => l.kind === "carried_flows")).toBe(false);
  });

  it("accepts variant P: the pre-commit difference of −$1.00 is kept on the record and the value becomes the statement's (tests 18–19)", async () => {
    const c = ctx();
    const r = await commitReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows("505.12"), accept: true }, c);
    expect(r).toMatchObject({ accepted: true, preCommitDifferenceCents: -100n, matchesToDollar: false });
    expect(r.preview.alreadyReconciled).toBe(true);
    expect(r.app.valueCents).toBe(5807769n);
    const [rec] = await t.db.select().from(accountReconciliation).where(eq(accountReconciliation.id, r.reconciliationId));
    expect(rec).toMatchObject({ diffCents: -100n, reconciled: false, accepted: true, appValueCents: 5807669n, appBasis: "snapshot", appAsOf: "2026-10-13" });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits[0]).toMatchObject({ entity: "account_reconciliation", action: "update" });
    expect(audits[0]!.before).toHaveLength(3);
    const [bal] = await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, A), eq(balanceSnapshot.date, "2026-10-13")));
    expect(bal!.balanceCents).toBe(5807769n);

    const again = await previewReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: statementRows("505.12") }, { today: TODAY, now: NOW });
    expect(again).toMatchObject({ alreadyReconciled: true, differenceCents: 0n, matchesToDollar: true });
  });

  it("records a rejected attempt without touching the snapshot (test 18, accept false)", async () => {
    const before = await countRows();
    const c = ctx();
    const r = await commitReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: [], statementTotalCents: 5807000n, accept: false, note: "statement pending" }, c);
    expect(r).toMatchObject({ accepted: false, preCommitDifferenceCents: 769n, matchesToDollar: false, rowsWritten: 0, impliedPricesWritten: 0 });
    expect(r.app.valueCents).toBe(5807769n);
    const after = await countRows();
    expect(after).toEqual({ ...before, audit: before.audit + 1, reconciliations: before.reconciliations + 1 });
    const [rec] = await t.db.select().from(accountReconciliation).where(eq(accountReconciliation.id, r.reconciliationId));
    expect(rec).toMatchObject({ accepted: false, holdingSnapshotDate: null, note: "statement pending", reconciled: false, diffCents: 769n });
  });

  it("replaces a CSV snapshot on the statement date, leaves a manual one of another date, and queues a fetch for a newly referenced provider security (test 18)", async () => {
    const c = ctx();
    const r = await commitReconciliation(
      t.db,
      { accountId: A2, date: "2026-10-13", rows: [{ securityId: VTI, quantity: f8("10"), price: f8("305.25") }, { ticker: "NEWP", quantity: f8("1"), price: f8("10") }], accept: true },
      { ...c, queuePriceRefresh: true },
    );
    expect(r.rowsWritten).toBe(1 + 1);
    const rows = await t.db.select().from(holdingSnapshot).where(eq(holdingSnapshot.accountId, A2));
    expect(rows.map((x) => [x.date, x.securityId, x.source]).sort()).toEqual(
      [
        ["2026-10-10", VTI, "manual"],
        ["2026-10-13", VTI, "manual"],
        ["2026-10-13", NEWP, "manual"],
      ].sort(),
    );
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect((audits[0]!.before as unknown[]).length).toBe(2);
    const fetch = await t.db.select().from(job).where(eq(job.type, "prices.fetch"));
    expect(fetch).toHaveLength(1);
    expect(fetch[0]!.payload).toMatchObject({ reason: "reconcile", securityIds: [NEWP], dedupeKey: "prices:reconcile" });
    // NEWP had no price: the statement's price became its implied close.
    const [newp] = await t.db.select().from(price).where(eq(price.securityId, NEWP));
    expect(newp).toMatchObject({ date: "2026-10-13", source: "implied", close: "10.00000000" });
    expect(r.impliedPricesWritten).toBe(1);
  });

  it("accepts a total-only statement as the date's manual balance without touching the date's snapshot", async () => {
    // A2 holds a manual 10-13 snapshot (VTI 10 @ 305.25 + NEWP 1 @ 10 = 306,250) from the previous commit.
    const snapshotBefore = await t.db.select().from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, A2), eq(holdingSnapshot.date, "2026-10-13")));
    expect(snapshotBefore).toHaveLength(2);
    const c = ctx();
    const r = await commitReconciliation(t.db, { accountId: A2, date: "2026-10-13", rows: [], statementTotalCents: 310000n, accept: true }, c);
    expect(r).toMatchObject({ accepted: true, preCommitDifferenceCents: -3750n, matchesToDollar: false, rowsWritten: 0, impliedPricesWritten: 0 });
    expect(r.preview.rows).toHaveLength(1);
    expect(r.preview.rows[0]).toMatchObject({ securityId: null, name: "Statement total", status: "value", valueDiffCents: -3750n });
    // The positions survive; the statement total is the date's manual balance; the chain anchors cash on it (306,250 + 3,750 plug).
    const snapshotAfter = await t.db.select().from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, A2), eq(holdingSnapshot.date, "2026-10-13")));
    expect(snapshotAfter.map((x) => [x.id, x.securityId, x.source, x.valueCents]).sort()).toEqual(snapshotBefore.map((x) => [x.id, x.securityId, x.source, x.valueCents]).sort());
    const [bal] = await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, A2), eq(balanceSnapshot.date, "2026-10-13")));
    expect(bal).toMatchObject({ balanceCents: 310000n, source: "manual" });
    expect((await t.db.select().from(account).where(eq(account.id, A2)))[0]).toMatchObject({ balanceCents: 310000n, balanceDate: "2026-10-13" });
    expect(r.app).toMatchObject({ basis: "snapshot", asOf: "2026-10-13", valueCents: 310000n });
    expect(r.app.lines.find((l) => l.kind === "cash_plug")).toMatchObject({ valueCents: 3750n });
    const [rec] = await t.db.select().from(accountReconciliation).where(eq(accountReconciliation.id, r.reconciliationId));
    expect(rec).toMatchObject({ accepted: true, holdingSnapshotDate: null, statementTotalCents: 310000n, diffCents: -3750n, reconciled: false, appValueCents: 306250n });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "account_reconciliation", action: "update" });
    expect(audits[0]!.after).toMatchObject({ totalOnly: true, balanceCents: "310000", accepted: true });
    expect((audits[0]!.after as { rows: unknown[] }).rows).toHaveLength(2);
    expect((await listReconciliations(t.db, { accountId: A2 }))[0]).toMatchObject({ id: r.reconciliationId, accepted: true, holdingSnapshotDate: null });
  });

  it("refuses to accept unknown tickers, lists history newest first and deletes a record with an audit row", async () => {
    await expect(commitReconciliation(t.db, { accountId: A, date: "2026-10-13", rows: [{ ticker: "ZZZZ", quantity: f8("1"), valueCents: 1n }], accept: true }, ctx())).rejects.toMatchObject({ status: 400, code: "unknown_ticker" });
    const list = await listReconciliations(t.db, { accountId: A });
    expect(list).toHaveLength(3);
    expect(list.map((x) => [x.accepted, x.differenceCents])).toEqual([
      [false, 769n],
      [true, -100n],
      [true, 0n],
    ]);
    expect(list[1]).toMatchObject({ date: "2026-10-13", statementTotalCents: 5807769n, unexplainedCents: 0n, matchesToDollar: false, reconciled: false, appBasis: "snapshot", cashInference: "auto", holdingSnapshotDate: "2026-10-13" });
    expect(list[1]!.rows).toHaveLength(3);
    const got = await getReconciliation(t.db, list[0]!.id);
    expect(got?.note).toBe("statement pending");
    const c = ctx();
    await deleteReconciliation(t.db, list[0]!.id, c);
    expect(await getReconciliation(t.db, list[0]!.id)).toBeUndefined();
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits[0]).toMatchObject({ entity: "account_reconciliation", action: "delete", after: null });
    await expect(deleteReconciliation(t.db, list[0]!.id, ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("reconcile panel on the INV seed (views test 10)", () => {
  let t: TestDb;
  let S: InvestmentSeed;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("B on 10-13: three position lines, the plug as the cash row, app 2,705,200, difference 0; R on 10-09 all statement-priced", async () => {
    const rows = [
      { ticker: "VTI", quantity: f8("40"), price: f8("312.5") },
      { ticker: "VXUS", quantity: f8("100"), price: f8("71.2") },
      { ticker: "AAPL", quantity: f8("25"), price: f8("240") },
      { isCash: true, quantity: f8("1432") },
    ];
    const p = await previewReconciliation(t.db, { accountId: S.accounts.brokerage, date: "2026-10-13", rows }, { today: INV_SEED_TODAY, now: INV_SEED_NOW });
    expect(p).toMatchObject({ statementTotalCents: 2705200n, differenceCents: 0n, matchesToDollar: true, unexplainedCents: 0n });
    expect(p.app).toMatchObject({ basis: "snapshot", valueCents: 2705200n });
    expect(p.rows.map((r) => [r.ticker ?? r.name, r.status])).toEqual([
      ["AAPL", "match"],
      ["VTI", "match"],
      ["VXUS", "match"],
      ["Cash", "match"],
    ]);
    expect(p.rows.find((r) => r.isCash)).toMatchObject({ securityId: S.securities.cash, app: { quantity: null, valueCents: 143200n, valueSource: "carried" } });
    expect(p.rows.find((r) => r.ticker === "VTI")!.app).toMatchObject({ price: f8("312.5"), priceDate: "2026-10-13", priceSource: "statement", valueCents: 1250000n });

    const off = await previewReconciliation(t.db, { accountId: S.accounts.brokerage, date: "2026-10-13", rows: [], statementTotalCents: 2706434n }, { today: INV_SEED_TODAY, now: INV_SEED_NOW });
    expect(off).toMatchObject({ differenceCents: -1234n, matchesToDollar: false });

    const r = await previewReconciliation(
      t.db,
      {
        accountId: S.accounts.roth,
        date: "2026-10-09",
        rows: [
          { ticker: "VTI", quantity: f8("20"), price: f8("309") },
          { ticker: "BND", quantity: f8("100"), price: f8("74.5") },
          { securityId: S.securities.tr2050, quantity: f8("100"), valueCents: 420000n },
          { ticker: "CASH", quantity: f8("270") },
        ],
      },
      { today: INV_SEED_TODAY, now: INV_SEED_NOW },
    );
    expect(r).toMatchObject({ statementTotalCents: 1810000n, differenceCents: 0n });
    expect(r.app).toMatchObject({ basis: "snapshot", valueCents: 1810000n });
    expect(r.rows).toHaveLength(4);
    expect(r.rows.filter((x) => !x.isCash).every((x) => x.app?.priceSource === "statement" && x.status === "match")).toBe(true);
  });
});
