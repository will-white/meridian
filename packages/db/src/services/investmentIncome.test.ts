import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { incomeByMonth, type PlanCategoryRowResult, type PlanResult } from "@meridian/shared";
import { account, auditLog, category, investmentTxn, job, payee, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { getInvestmentIncome, periodBounds, runInvestmentIncomeFeed, setInvestmentIncomeFeed } from "./investmentIncome.js";
import { linkUnlinkedInvestmentTxns } from "./investmentTxns.js";
import { loadInvestmentTxns } from "./lots.js";
import { getPlan } from "./plan.js";
import { loadDetectionInput } from "./recurring.js";
import { updateHouseholdSetting } from "./settings.js";
import { pairTransfersInDb } from "./transfers.js";

const TODAY = INV_SEED_TODAY;
const NOW = INV_SEED_NOW;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });

describe("periodBounds (views test 21)", () => {
  it("presets end at asOf, ytd starts on Dec 31, all at the earliest data date, custom is validated", () => {
    expect(periodBounds("1y", "2026-10-13", "2025-10-13")).toEqual({ kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null });
    expect(periodBounds("ytd", "2026-10-13", "2025-10-13")).toMatchObject({ from: "2025-12-31", days: 286 });
    expect(periodBounds("1m", "2026-10-13", null)!.from).toBe("2026-09-13");
    expect(periodBounds("3m", "2026-10-13", null)!.from).toBe("2026-07-13");
    expect(periodBounds("3y", "2026-10-13", "2025-10-13")).toMatchObject({ from: "2023-10-13", partial: true, note: "Values begin 2025-10-13; the period is shorter than requested" });
    expect(periodBounds("5y", "2026-10-13", null)!.from).toBe("2021-10-13");
    expect(periodBounds("all", "2026-10-13", "2025-10-13")!.from).toBe("2025-10-13");
    expect(periodBounds("all", "2026-10-13", null)).toBeNull();
    expect(periodBounds("1m", "2026-03-31", null)!.from).toBe("2026-02-28");
    expect(() => periodBounds("custom", "2026-10-13", null, { from: "2026-10-13", to: "2026-10-12", today: "2026-10-14" })).toThrow();
    expect(() => periodBounds("custom", "2026-10-13", null, { from: "2026-10-01", to: "2026-10-15", today: "2026-10-14" })).toThrow();
    expect(periodBounds("custom", "2026-10-13", null, {})).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("investment income (views tests 13–15, 20)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let B: string;
  let R: string;
  let C: string;
  const q = { today: TODAY, now: NOW };

  const cell = (plan: PlanResult, categoryId: string, month: string) => {
    const row = plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === categoryId)!;
    return row.cells[plan.months.indexOf(month)]!;
  };
  const septemberDividends = async () => cell(await getPlan(t.db, { from: "2026-09", to: "2026-09", today: TODAY }), S.categories.dividends, "2026-09");

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    B = S.accounts.brokerage;
    R = S.accounts.roth;
    C = S.accounts.checking;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("the ytd income view and the feed in link mode (test 13)", async () => {
    const v = await getInvestmentIncome(t.db, q);
    expect(v.period).toEqual({ kind: "ytd", from: "2025-12-31", to: "2026-10-13", days: 286, partial: false, note: null });
    expect(v.months.map((m) => [m.month, m.dividendsCents, m.interestCents, m.feesCents, m.reinvestedCents, m.totalCents])).toEqual([
      ["2026-03", 8360n, 0n, 0n, 0n, 8360n],
      ["2026-06", 4720n, 0n, 0n, 0n, 4720n],
      ["2026-08", 2890n, 0n, 0n, 0n, 2890n],
      ["2026-09", 13775n, 410n, 0n, 0n, 14185n],
      ["2026-10", 2280n, 0n, 0n, 0n, 2280n],
    ]);
    expect(v.months[3]!.bySecurity.map((s) => [s.ticker, s.cents])).toEqual([
      ["VTI", 7365n],
      ["VXUS", 4150n],
      ["BND", 2260n],
      [null, 410n],
    ]);
    expect(v.totals).toEqual({ dividendsCents: 32025n, interestCents: 410n, feesCents: 0n, reinvestedCents: 0n, totalCents: 32435n });
    expect(v).toMatchObject({ trailing12mCents: 32435n, yieldBp: 71, rowsTruncated: false, warnings: [] });
    expect(v.rows).toHaveLength(11);
    expect(v.rows.every((r) => r.source === "investment_txn" && !r.reinvested)).toBe(true);
    expect(v.rows.filter((r) => r.accountId === B).every((r) => r.linkStatus === "linked" && !r.fed)).toBe(true);
    expect(v.rows.filter((r) => r.accountId === R).every((r) => r.linkStatus === "not_fed" && !r.fed)).toBe(true);
    expect(v.rows.find((r) => r.id === S.txns["divVtiSep"])).toMatchObject({ date: "2026-09-28", month: "2026-09", ticker: "VTI", kind: "dividend", cents: 4910n, ledgerTransactionId: S.ledger["divVtiSep"] });
    expect(v.feed.categoryId).toBe(S.categories.dividends);
    expect(v.feed.categoryName).toBe("Dividends");
    expect(v.feed.accounts.map((a) => [a.accountName, a.mode, a.linked, a.created, a.awaiting, a.fed, a.hasLedger, a.suggestedMode])).toEqual([
      ["Fidelity Roth IRA", "off", 0, 0, 0, 0, false, "create"],
      ["Vanguard Brokerage", "link", 7, 0, 0, 0, true, "link"],
    ]);

    // The months equal the engine's income rows for the same accounts and window.
    const txns = [...(await loadInvestmentTxns(t.db, B, { through: "2026-10-13" })), ...(await loadInvestmentTxns(t.db, R, { through: "2026-10-13" }))].filter((x) => x.date > "2025-12-31");
    const engine = new Map<string, { dividends: bigint; interest: bigint }>();
    for (const m of incomeByMonth(txns)) {
      const e = engine.get(m.month) ?? { dividends: 0n, interest: 0n };
      engine.set(m.month, { dividends: e.dividends + m.dividendCents, interest: e.interest + m.interestCents });
    }
    for (const m of v.months) expect(engine.get(m.month)).toEqual({ dividends: m.dividendsCents, interest: m.interestCents });

    const uncategorizedBefore = (await getPlan(t.db, { from: "2026-09", to: "2026-09", today: TODAY })).summary[0]!.uncategorized;
    expect(await runInvestmentIncomeFeed(t.db, { now: NOW })).toEqual({ categorized: 7, created: 0, upgraded: 0, awaiting: 0, unchanged: 0, deleted: 0, skipped: [] });
    const bankRows = await t.db.select().from(transaction).where(eq(transaction.accountId, B));
    const fed = bankRows.filter((r) => r.categoryId === S.categories.dividends);
    expect(fed).toHaveLength(7);
    expect(fed.every((r) => !r.categoryLocked)).toBe(true);
    expect(bankRows.find((r) => r.rawDescription === "BUY VTI")!.categoryId).toBeNull();
    const sep = await septemberDividends();
    expect(sep.actualCents).toBe(9470n);
    expect(sep.txnCount).toBe(3);
    expect((await getPlan(t.db, { from: "2026-09", to: "2026-09", today: TODAY })).summary[0]!.uncategorized).toEqual(uncategorizedBefore);

    expect(await runInvestmentIncomeFeed(t.db, { now: NOW })).toMatchObject({ categorized: 0, unchanged: 7 });
    const again = await getInvestmentIncome(t.db, q);
    expect(again.rows.filter((r) => r.accountId === B).every((r) => r.fed)).toBe(true);
    expect(again.feed.accounts.find((a) => a.accountId === B)).toMatchObject({ fed: 7 });

    await t.db.delete(transaction).where(eq(transaction.id, S.ledger["interestSep"]!));
    const unlinked = await getInvestmentIncome(t.db, q);
    expect(unlinked.rows.find((r) => r.id === S.txns["interestSep"])).toMatchObject({ kind: "interest", linkStatus: "awaiting", ledgerTransactionId: null, fed: false });
    expect(await runInvestmentIncomeFeed(t.db, { now: NOW })).toMatchObject({ awaiting: 1, unchanged: 6 });
  });

  it("create mode, the upgrade pass, idempotency, turning it off, validation (test 14)", async () => {
    const c = ctx();
    const set = await setInvestmentIncomeFeed(t.db, R, "create", { ...c, now: NOW });
    expect(set).toMatchObject({ investmentIncomeFeed: "create", run: { created: 4, categorized: 0, upgraded: 0, awaiting: 0, unchanged: 0 }, deleted: 0 });
    expect(set.jobId).not.toBeNull();
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toEqual([expect.objectContaining({ entity: "account", entityId: R, action: "update", before: { investmentIncomeFeed: "off" }, after: { investmentIncomeFeed: "create" } })]);
    const feedJobs = await t.db.select().from(job).where(eq(job.type, "investments.income_feed"));
    expect(feedJobs).toHaveLength(1);
    expect(feedJobs[0]!.payload).toMatchObject({ dedupeKey: "investments.income_feed" });

    const rRows = await t.db.select().from(transaction).where(eq(transaction.accountId, R));
    expect(rRows).toHaveLength(4);
    expect(rRows.map((r) => r.amountCents).sort()).toEqual([2240n, 2260n, 2280n, 2455n]);
    expect(rRows.every((r) => r.source === "investment" && r.externalId?.startsWith("inv:") && r.categoryId === S.categories.dividends && !r.isTransfer && !r.pending && !r.categoryLocked)).toBe(true);
    expect(rRows.find((r) => r.amountCents === 2280n)).toMatchObject({ date: "2026-10-06", rawDescription: "DIVIDEND BND", externalId: `inv:${S.txns["rDivBndOct"]}` });
    const v = await getInvestmentIncome(t.db, q);
    expect(v.rows.filter((r) => r.accountId === R).every((r) => r.linkStatus === "created" && r.fed)).toBe(true);
    expect(v.months.map((m) => [m.month, m.totalCents])).toEqual([
      ["2026-03", 8360n],
      ["2026-06", 4720n],
      ["2026-08", 2890n],
      ["2026-09", 14185n],
      ["2026-10", 2280n],
    ]);
    // 9,470 − the 410 interest row deleted in the previous case + R's 2,260 and 2,455 synthetic rows.
    const sep = await septemberDividends();
    expect(sep.actualCents).toBe(13775n);
    expect(sep.txnCount).toBe(4);

    expect(await runInvestmentIncomeFeed(t.db, { accountIds: [R], now: NOW })).toMatchObject({ created: 0, unchanged: 4 });
    expect(await runInvestmentIncomeFeed(t.db, { accountIds: [R], now: NOW })).toMatchObject({ created: 0, unchanged: 4 });

    // The bank's own row arrives: the synthetic row gives way to it.
    const [bank] = await t.db
      .insert(transaction)
      .values({ accountId: R, source: "csv", externalId: "R-BANK-1", date: "2026-10-07", amountCents: 2280n, rawDescription: "DIVIDEND BND" })
      .returning({ id: transaction.id });
    expect(await runInvestmentIncomeFeed(t.db, { accountIds: [R], now: NOW })).toMatchObject({ upgraded: 1, unchanged: 3 });
    const afterUpgrade = await t.db.select().from(transaction).where(eq(transaction.accountId, R));
    expect(afterUpgrade).toHaveLength(4);
    expect(afterUpgrade.filter((r) => r.source === "investment")).toHaveLength(3);
    expect(afterUpgrade.find((r) => r.id === bank!.id)).toMatchObject({ categoryId: S.categories.dividends, categoryLocked: false });
    const [octDividend] = await t.db.select().from(investmentTxn).where(eq(investmentTxn.id, S.txns["rDivBndOct"]!));
    expect(octDividend!.ledgerTransactionId).toBe(bank!.id);

    // A locked category on the synthetic row travels to the bank row.
    const [other] = await t.db.insert(category).values({ name: "Other income", bucket: "income", position: 2 }).returning({ id: category.id });
    const septSynthetic = afterUpgrade.find((r) => r.amountCents === 2260n)!;
    await t.db.update(transaction).set({ categoryId: other!.id, categoryLocked: true }).where(eq(transaction.id, septSynthetic.id));
    const [bank2] = await t.db
      .insert(transaction)
      .values({ accountId: R, source: "csv", externalId: "R-BANK-2", date: "2026-09-05", amountCents: 2260n, rawDescription: "DIVIDEND BND" })
      .returning({ id: transaction.id });
    expect(await runInvestmentIncomeFeed(t.db, { accountIds: [R], now: NOW })).toMatchObject({ upgraded: 1 });
    expect((await t.db.select().from(transaction).where(eq(transaction.id, bank2!.id)))[0]).toMatchObject({ categoryId: other!.id, categoryLocked: true });
    expect(await t.db.select().from(transaction).where(eq(transaction.id, septSynthetic.id))).toHaveLength(0);

    // Off: the remaining unlocked synthetic rows go; bank rows keep their categories and links.
    const off = await setInvestmentIncomeFeed(t.db, R, "off", { ...ctx(), now: NOW });
    expect(off).toMatchObject({ investmentIncomeFeed: "off", deleted: 2, run: null, jobId: null });
    const remaining = await t.db.select().from(transaction).where(eq(transaction.accountId, R));
    expect(remaining.map((r) => [r.source, r.amountCents]).sort()).toEqual([
      ["csv", 2260n],
      ["csv", 2280n],
    ]);
    const after = await getInvestmentIncome(t.db, q);
    const rStatuses = after.rows.filter((r) => r.accountId === R).map((r) => r.linkStatus).sort();
    expect(rStatuses).toEqual(["linked", "linked", "not_fed", "not_fed"]);

    await expect(setInvestmentIncomeFeed(t.db, C, "link", { ...ctx(), now: NOW })).rejects.toMatchObject({ status: 400, code: "not_investment_account" });
    await updateHouseholdSetting(t.db, { investmentIncomeCategoryId: null }, ctx());
    await expect(setInvestmentIncomeFeed(t.db, R, "link", { ...ctx(), now: NOW })).rejects.toMatchObject({ status: 400, code: "feed_category_required" });
    expect(await runInvestmentIncomeFeed(t.db, { accountIds: [B], now: NOW })).toMatchObject({ skipped: [{ accountId: B, name: "Vanguard Brokerage", reason: "feed_category_required" }] });
    const [groceries] = await t.db.insert(category).values({ name: "Groceries", bucket: "spending", position: 3 }).returning({ id: category.id });
    await expect(updateHouseholdSetting(t.db, { investmentIncomeCategoryId: groceries!.id }, ctx())).rejects.toMatchObject({ status: 400, code: "not_income_category" });
    await updateHouseholdSetting(t.db, { investmentIncomeCategoryId: S.categories.dividends }, ctx());
  });

  it("the income view unions categorized bank rows and never double counts (test 15)", async () => {
    await setInvestmentIncomeFeed(t.db, B, "off", { ...ctx(), now: NOW });
    const before = await getInvestmentIncome(t.db, q);
    const vxusRows = await t.db.select().from(investmentTxn).where(and(eq(investmentTxn.accountId, B), eq(investmentTxn.securityId, S.securities.vxus), eq(investmentTxn.type, "dividend")));
    expect(vxusRows).toHaveLength(2);
    await t.db.delete(investmentTxn).where(inArray(investmentTxn.id, vxusRows.map((r) => r.id)));
    await t.db.update(transaction).set({ categoryId: S.categories.dividends }).where(inArray(transaction.id, [S.ledger["divVxusMar"]!, S.ledger["divVxusSep"]!]));
    const ledgerOnly = await getInvestmentIncome(t.db, q);
    const bankRows = ledgerOnly.rows.filter((r) => r.source === "ledger");
    expect(bankRows.map((r) => [r.date, r.cents, r.kind, r.linkStatus, r.fed, r.securityId])).toEqual([
      ["2026-03-20", 3800n, "dividend", "ledger_only", true, null],
      ["2026-09-22", 4150n, "dividend", "ledger_only", true, null],
    ]);
    expect(ledgerOnly.months.map((m) => [m.month, m.totalCents])).toEqual(before.months.map((m) => [m.month, m.totalCents]));
    expect(ledgerOnly.totals).toEqual(before.totals);

    await t.db.insert(investmentTxn).values(
      vxusRows.map(({ id: _id, createdAt: _c, updatedAt: _u, ledgerTransactionId: _l, ...row }) => ({ ...row, ledgerTransactionId: null })),
    );
    expect(await linkUnlinkedInvestmentTxns(t.db, { accountIds: [B] })).toBe(2);
    const relinked = await getInvestmentIncome(t.db, q);
    expect(relinked.rows.filter((r) => r.source === "ledger")).toHaveLength(0);
    expect(relinked.rows.filter((r) => r.ticker === "VXUS").map((r) => r.linkStatus)).toEqual(["linked", "linked"]);
    expect(relinked.totals).toEqual(before.totals);

    const [interest] = await t.db
      .insert(transaction)
      .values({ accountId: B, source: "simplefin", externalId: "B-INT-2", date: "2026-10-01", amountCents: 123n, rawDescription: "INTEREST EARNED", categoryId: S.categories.dividends })
      .returning({ id: transaction.id });
    const withInterest = await getInvestmentIncome(t.db, q);
    expect(withInterest.rows.find((r) => r.id === interest!.id)).toMatchObject({ kind: "interest", source: "ledger", cents: 123n });
    expect(withInterest.totals.interestCents).toBe(before.totals.interestCents + 123n);
    await t.db.delete(transaction).where(eq(transaction.id, interest!.id));
  });

  it("feed rows stay out of transfer pairing and recurring detection; cash-transfer links still pair (test 20)", async () => {
    // R's bank row +2,280 (10-07) is linked to a dividend; a Checking −2,280 must not pair with it.
    const [out1] = await t.db.insert(transaction).values({ accountId: C, source: "manual", date: "2026-10-07", amountCents: -2280n, rawDescription: "ZELLE OUT" }).returning({ id: transaction.id });
    expect(await pairTransfersInDb(t.db, { since: "2026-10-01" })).toBe(0);
    const [out2] = await t.db.insert(transaction).values({ accountId: C, source: "manual", date: "2026-09-30", amountCents: -4910n, rawDescription: "CHECK 101" }).returning({ id: transaction.id });
    expect(await pairTransfersInDb(t.db, { since: "2026-09-20" })).toBe(0);
    const rows = await t.db.select().from(transaction).where(inArray(transaction.id, [out1!.id, out2!.id, S.ledger["divVtiSep"]!]));
    expect(rows.every((r) => r.transferPairId === null && !r.isTransfer)).toBe(true);
    expect(rows.find((r) => r.id === S.ledger["divVtiSep"])!.categoryId).toBe(S.categories.dividends);
    const [seeded] = await t.db.select().from(transaction).where(eq(transaction.id, S.ledger["xferIn"]!));
    expect(seeded!.transferPairId).not.toBeNull();

    // A payee named from the dividend rows never forms a recurring series.
    const [p] = await t.db.insert(payee).values({ name: "Vanguard Dividends" }).returning({ id: payee.id });
    await t.db.update(transaction).set({ payeeId: p!.id }).where(inArray(transaction.id, [S.ledger["divVtiMar"]!, S.ledger["divVtiJun"]!, S.ledger["divVtiSep"]!]));
    const detection = await loadDetectionInput(t.db, TODAY);
    expect([...detection.groups.keys()].some((k) => k.startsWith(p!.id))).toBe(false);
    expect(detection.outflowsByPayee.has(p!.id)).toBe(false);

    // A ledger row linked to a cash `transfer` investment row is still a pairing candidate.
    const [contribution] = await t.db.insert(transaction).values({ accountId: B, source: "simplefin", externalId: "B-EFT-9", date: "2026-10-01", amountCents: 300000n, rawDescription: "EFT RECEIVED" }).returning({ id: transaction.id });
    await t.db.insert(investmentTxn).values({ accountId: B, securityId: null, date: "2026-10-01", type: "transfer", transferDirection: "in", amountCents: 300000n, source: "manual", ledgerTransactionId: contribution!.id });
    await t.db.insert(transaction).values({ accountId: C, source: "manual", date: "2026-10-01", amountCents: -300000n, rawDescription: "TRANSFER TO VANGUARD" });
    expect(await pairTransfersInDb(t.db, { since: "2026-09-28" })).toBe(1);
    expect((await t.db.select().from(transaction).where(eq(transaction.id, contribution!.id)))[0]).toMatchObject({ isTransfer: true });
    expect((await t.db.select().from(account).where(eq(account.id, B)))[0]!.investmentIncomeFeed).toBe("off");
  });
});
