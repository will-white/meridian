import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyInvestmentInflow, type PlanCategoryRowResult, type PlanResult, type RuleLike, type SimplefinAccount } from "@meridian/shared";
import { account, balanceSnapshot, category, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { defaultOnBudget, upsertSimplefinAccount } from "./accounts.js";
import { createGoal, listGoals } from "./goals.js";
import { ingestTransactions } from "./ingest.js";
import { getPlan } from "./plan.js";
import { countUncategorized, updateTransaction } from "./transactions.js";
import { pairTransfersInDb } from "./transfers.js";

const TODAY = INV_SEED_TODAY;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });

describe("classifyInvestmentInflow (imports test 17)", () => {
  it("marks contribution-like inflows into investment accounts and nothing else", () => {
    expect(classifyInvestmentInflow("401k", "EMPLOYEE PRE-TAX CONTRIBUTION", 50000n)).toBe("contribution");
    expect(classifyInvestmentInflow("401k", "EMPLOYER MATCH", 25000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "ELECTRONIC FUNDS TRANSFER RECEIVED", 100000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "DIVIDEND RECEIVED VTI", 1234n)).toBeNull();
    expect(classifyInvestmentInflow("brokerage", "REINVESTMENT", 1234n)).toBeNull();
    expect(classifyInvestmentInflow("brokerage", "YOU SOLD VTI", 99860n)).toBeNull();
    expect(classifyInvestmentInflow("checking", "DEPOSIT", 100000n)).toBeNull();
    expect(classifyInvestmentInflow("ira", "DISTRIBUTION", -200000n)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Phase 1/2 touches: ingest classifier, off-budget default, balance guard, plan loaders (imports tests 17, 26)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let k401: string;
  let income: string;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    k401 = (await t.db.insert(account).values({ name: "Acme 401(k)", type: "401k", taxTreatment: "pre_tax", onBudget: false, connectionId: S.connections.vanguard, externalId: "ACT-401K" }).returning({ id: account.id }))[0]!.id;
    income = (await t.db.insert(category).values({ name: "Income", bucket: "income", position: 2 }).returning({ id: category.id }))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const rowByExt = async (accountId: string, ext: string) => (await t.db.select().from(transaction).where(and(eq(transaction.accountId, accountId), eq(transaction.externalId, ext))))[0]!;

  it("a sync into a 401k marks the contribution an unpaired transfer, counts it toward the linked goal, pairs it later, and yields to a rule (test 17)", async () => {
    await createGoal(t.db, { name: "Retirement", newCategory: { name: "401k savings" }, targetCents: 100000000n, linkedAccountId: k401, startMonth: "2026-01" }, ctx());
    const stats = await ingestTransactions(
      t.db,
      [
        { externalId: "K1", date: "2026-10-02", amountCents: 50000n, description: "EMPLOYEE PRE-TAX CONTRIBUTION", pending: false },
        { externalId: "K2", date: "2026-10-05", amountCents: 1234n, description: "DIVIDEND", pending: false },
      ],
      { accountId: k401, source: "simplefin", rules: [] },
    );
    expect(stats).toMatchObject({ created: 2 });
    expect(await rowByExt(k401, "K1")).toMatchObject({ isTransfer: true, transferPairId: null, categoryId: null });
    expect(await rowByExt(k401, "K2")).toMatchObject({ isTransfer: false });
    const goal = (await listGoals(t.db, { today: TODAY })).find((g) => g.linkedAccountId === k401)!;
    expect(goal.history.find((h) => h.month === "2026-10")?.actualCents).toBe(50000n);

    // The checking side arrives within three days and pairs; "not a transfer" clears both.
    await ingestTransactions(t.db, [{ externalId: "C1", date: "2026-10-03", amountCents: -50000n, description: "ACME 401K DEFERRAL", pending: false }], { accountId: S.accounts.checking, source: "csv", rules: [] });
    expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-01" }))).toBe(1);
    const paired = await rowByExt(k401, "K1");
    expect(paired.transferPairId).not.toBeNull();
    expect((await rowByExt(S.accounts.checking, "C1")).transferPairId).toBe(paired.transferPairId);
    await updateTransaction(t.db, paired.id, { isTransfer: false });
    expect(await rowByExt(k401, "K1")).toMatchObject({ isTransfer: false, transferPairId: null });
    expect(await rowByExt(S.accounts.checking, "C1")).toMatchObject({ isTransfer: false, transferPairId: null });

    // A rule that categorizes wins over the classifier; the explicit account type is honoured too.
    const rules: RuleLike[] = [{ id: randomUUID(), position: 1, enabled: true, conditions: { description: { op: "contains", value: "CONTRIBUTION" } }, actions: { setCategoryId: income } }];
    await ingestTransactions(t.db, [{ externalId: "K3", date: "2026-10-06", amountCents: 25000n, description: "EMPLOYER MATCH CONTRIBUTION", pending: false }], { accountId: k401, source: "simplefin", rules, accountType: "401k" });
    expect(await rowByExt(k401, "K3")).toMatchObject({ isTransfer: false, categoryId: income });
    // A rule that only sets a payee leaves the decision to the classifier.
    const payeeRule: RuleLike[] = [{ id: randomUUID(), position: 1, enabled: true, conditions: { description: { op: "contains", value: "ROLLOVER" } }, actions: { setPayee: "Old Employer" } }];
    await ingestTransactions(t.db, [{ externalId: "K4", date: "2026-10-07", amountCents: 900000n, description: "ROLLOVER IN", pending: false }], { accountId: k401, source: "simplefin", rules: payeeRule });
    expect(await rowByExt(k401, "K4")).toMatchObject({ isTransfer: true, categoryId: null });
    // Outflows and non-investment accounts are never touched.
    await ingestTransactions(t.db, [{ externalId: "K5", date: "2026-10-08", amountCents: -40000n, description: "DISTRIBUTION", pending: false }], { accountId: k401, source: "simplefin", rules: [] });
    expect(await rowByExt(k401, "K5")).toMatchObject({ isTransfer: false });
    await ingestTransactions(t.db, [{ externalId: "C2", date: "2026-10-08", amountCents: 100000n, description: "DEPOSIT", pending: false }], { accountId: S.accounts.checking, source: "csv", rules: [] });
    expect(await rowByExt(S.accounts.checking, "C2")).toMatchObject({ isTransfer: false });
  });

  it("investment-type accounts start off budget; the sync's balance row never overwrites a manual or csv one (test 26, C41, plan decision 14)", async () => {
    expect(defaultOnBudget("brokerage")).toBe(false);
    expect(defaultOnBudget("roth")).toBe(false);
    expect(defaultOnBudget("checking")).toBe(true);
    expect(defaultOnBudget("credit")).toBe(true);

    const sf: SimplefinAccount = { org: { name: "Vanguard" }, id: "ACT-ROTH-9", name: "Roth IRA Brokerage", currency: "USD", balance: "1000.00", "balance-date": Math.floor(Date.UTC(2026, 9, 13, 12) / 1000), transactions: [] };
    const first = await upsertSimplefinAccount(t.db, S.connections.vanguard, sf);
    expect(first.created).toBe(true);
    const row = (await t.db.select().from(account).where(eq(account.id, first.id)))[0]!;
    expect(row).toMatchObject({ type: "roth", onBudget: false, balanceCents: 100000n, balanceDate: "2026-10-13" });
    const checking = await upsertSimplefinAccount(t.db, S.connections.vanguard, { ...sf, id: "ACT-CHK-9", name: "Everyday Checking" });
    expect((await t.db.select().from(account).where(eq(account.id, checking.id)))[0]).toMatchObject({ type: "checking", onBudget: true });

    const balanceRow = async (date: string) => (await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, first.id), eq(balanceSnapshot.date, date))))[0]!;
    expect(await balanceRow("2026-10-13")).toMatchObject({ balanceCents: 100000n, source: "simplefin" });
    await t.db.update(balanceSnapshot).set({ balanceCents: 999999n, source: "manual" }).where(and(eq(balanceSnapshot.accountId, first.id), eq(balanceSnapshot.date, "2026-10-13")));
    await upsertSimplefinAccount(t.db, S.connections.vanguard, { ...sf, balance: "1010.00" });
    expect(await balanceRow("2026-10-13")).toMatchObject({ balanceCents: 999999n, source: "manual" });
    expect((await t.db.select().from(account).where(eq(account.id, first.id)))[0]!.balanceCents).toBe(101000n);
    // Plan decision 14: the precedence manual > csv > simplefin applies to balance rows alike, so a positions import's
    // csv statement total (setBalance into a fed account) survives the sync too; the account's own balance still follows the feed.
    await t.db.insert(balanceSnapshot).values({ accountId: first.id, date: "2026-10-12", balanceCents: 5n, source: "csv" });
    await upsertSimplefinAccount(t.db, S.connections.vanguard, { ...sf, balance: "1020.00", "balance-date": Math.floor(Date.UTC(2026, 9, 12, 12) / 1000) });
    expect(await balanceRow("2026-10-12")).toMatchObject({ balanceCents: 5n, source: "csv" });
    expect((await t.db.select().from(account).where(eq(account.id, first.id)))[0]!.balanceCents).toBe(102000n);
    // A computed row ranks below the feed and is replaced; a feed row of the same date is refreshed.
    await t.db.insert(balanceSnapshot).values({ accountId: first.id, date: "2026-10-11", balanceCents: 7n, source: "computed" });
    await upsertSimplefinAccount(t.db, S.connections.vanguard, { ...sf, balance: "1030.00", "balance-date": Math.floor(Date.UTC(2026, 9, 11, 12) / 1000) });
    expect(await balanceRow("2026-10-11")).toMatchObject({ balanceCents: 103000n, source: "simplefin" });
    await upsertSimplefinAccount(t.db, S.connections.vanguard, { ...sf, balance: "1031.00", "balance-date": Math.floor(Date.UTC(2026, 9, 11, 12) / 1000) });
    expect(await balanceRow("2026-10-11")).toMatchObject({ balanceCents: 103100n, source: "simplefin" });
  });

  it("the plan reads on-budget accounts plus feed-category rows; a goal's linked transfers count either way (test 26)", async () => {
    const baseline = (await getPlan(t.db, { from: "2026-10", to: "2026-10", today: TODAY })).summary[0]!.uncategorized;
    const off = (await t.db.insert(account).values({ name: "Off-budget Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id }))[0]!.id;
    const fees = (await t.db.insert(category).values({ name: "Fees", bucket: "spending", position: 3 }).returning({ id: category.id }))[0]!.id;
    await t.db.insert(transaction).values([
      { accountId: off, source: "manual", date: "2026-10-03", amountCents: -250000n, rawDescription: "BUY VTI" },
      { accountId: off, source: "manual", date: "2026-10-04", amountCents: -10000n, rawDescription: "ADVISORY FEE", categoryId: fees },
      { accountId: off, source: "manual", date: "2026-10-06", amountCents: 1234n, rawDescription: "DIVIDEND VTI", categoryId: S.categories.dividends },
      { accountId: off, source: "manual", date: "2026-10-07", amountCents: 100000n, rawDescription: "EFT RECEIVED", isTransfer: true },
    ]);
    await createGoal(t.db, { name: "Brokerage", newCategory: { name: "Brokerage savings" }, targetCents: 100000000n, linkedAccountId: off, startMonth: "2026-01" }, ctx());
    const uncategorizedBefore = await countUncategorized(t.db);
    const cell = (plan: PlanResult, categoryId: string) => {
      const row = plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === categoryId)!;
      return row.cells[plan.months.indexOf("2026-10")]!;
    };
    const goalActual = async () => (await listGoals(t.db, { today: TODAY })).find((g) => g.linkedAccountId === off)!.history.find((h) => h.month === "2026-10")!.actualCents;

    const offPlan = await getPlan(t.db, { from: "2026-10", to: "2026-10", today: TODAY });
    expect(offPlan.summary[0]!.uncategorized).toEqual(baseline);
    expect(cell(offPlan, fees).actualCents).toBe(0n);
    expect(cell(offPlan, S.categories.dividends).actualCents).toBe(1234n);
    expect(await countUncategorized(t.db)).toBe(uncategorizedBefore);
    expect(await goalActual()).toBe(100000n);

    await t.db.update(account).set({ onBudget: true }).where(eq(account.id, off));
    const onPlan = await getPlan(t.db, { from: "2026-10", to: "2026-10", today: TODAY });
    expect(onPlan.summary[0]!.uncategorized).toEqual({ count: baseline.count + 1, cents: baseline.cents - 250000n });
    expect(cell(onPlan, fees).actualCents).toBe(10000n);
    expect(cell(onPlan, S.categories.dividends).actualCents).toBe(1234n);
    expect(await countUncategorized(t.db)).toBe(uncategorizedBefore + 1);
    expect(await goalActual()).toBe(100000n);

    // Without a feed category nothing from an off-budget account reaches the plan.
    await t.db.update(account).set({ onBudget: false }).where(eq(account.id, off));
    await t.db.execute(sql`update household_setting set investment_income_category_id = null`);
    const noFeed = await getPlan(t.db, { from: "2026-10", to: "2026-10", today: TODAY });
    expect(cell(noFeed, S.categories.dividends).actualCents).toBe(0n);
  });
});
