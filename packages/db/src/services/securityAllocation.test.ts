import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocationTarget, auditLog, category, householdSetting, job } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { getAllocationTargets, setAllocationTargets } from "./allocationTargets.js";
import { getAllocation } from "./investmentViews.js";
import { securityRef, setSecurityAllocation, validateSplits } from "./securityAllocation.js";
import { getHouseholdSetting, householdSettingAuditJson, updateHouseholdSetting } from "./settings.js";

const TODAY = INV_SEED_TODAY;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });

describe("validateSplits (pure)", () => {
  it("accepts a 10 000 bp set including the primary class, sorted in enum order; rejects the rest", () => {
    expect(validateSplits("us_stock", null)).toEqual([]);
    expect(validateSplits("us_stock", [])).toEqual([]);
    expect(validateSplits("us_stock", [{ assetClass: "bonds", weightBp: 4000 }, { assetClass: "us_stock", weightBp: 6000 }])).toEqual([
      { assetClass: "us_stock", weightBp: 6000 },
      { assetClass: "bonds", weightBp: 4000 },
    ]);
    expect(() => validateSplits("us_stock", [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 3000 }])).toThrow(expect.objectContaining({ code: "split_sum" }));
    expect(() => validateSplits("intl_stock", [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 4000 }])).toThrow(expect.objectContaining({ code: "split_primary" }));
    expect(() => validateSplits("us_stock", [{ assetClass: "us_stock", weightBp: 5000 }, { assetClass: "us_stock", weightBp: 5000 }])).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => validateSplits("us_stock", [{ assetClass: "us_stock", weightBp: 10001 }])).toThrow(expect.objectContaining({ code: "validation" }));
  });
});

describe.skipIf(!TEST_DATABASE_URL)("security splits, allocation targets and household investment settings (views test 7, imports test 21)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  const q = { today: TODAY, now: INV_SEED_NOW };

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("edits TR2050's splits: 60/40 moves 252,000 to US stock and 168,000 to bonds; audited once; invalid bodies refused (test 7)", async () => {
    const c = ctx();
    const ref = await setSecurityAllocation(t.db, S.securities.tr2050, { assetClass: "us_stock", splits: [{ assetClass: "bonds", weightBp: 4000 }, { assetClass: "us_stock", weightBp: 6000 }] }, c);
    expect(ref).toEqual({
      securityId: S.securities.tr2050,
      ticker: null,
      name: "Vanguard Target Retirement 2050 Trust",
      type: "fund",
      assetClass: "us_stock",
      splits: [
        { assetClass: "us_stock", weightBp: 6000 },
        { assetClass: "bonds", weightBp: 4000 },
      ],
      needsReview: false,
    });
    const a = await getAllocation(t.db, q);
    expect(a.classes.slice(0, 4).map((x) => [x.assetClass, x.currentCents])).toEqual([
      ["us_stock", 2727000n],
      ["intl_stock", 712000n],
      ["bonds", 916000n],
      ["cash", 170200n],
    ]);
    expect(a.classes[0]!.lines.find((l) => l.securityId === S.securities.tr2050)).toMatchObject({ cents: 252000n, blended: true });
    expect(a.classes[2]!.lines.find((l) => l.securityId === S.securities.tr2050)).toMatchObject({ cents: 168000n, blended: true });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toEqual([
      expect.objectContaining({
        entity: "security",
        entityId: S.securities.tr2050,
        action: "update",
        before: {
          assetClass: "us_stock",
          splits: [
            { assetClass: "us_stock", weightBp: 5400 },
            { assetClass: "intl_stock", weightBp: 3600 },
            { assetClass: "bonds", weightBp: 1000 },
          ],
        },
        after: {
          assetClass: "us_stock",
          splits: [
            { assetClass: "us_stock", weightBp: 6000 },
            { assetClass: "bonds", weightBp: 4000 },
          ],
        },
      }),
    ]);
    const c2 = ctx();
    await setSecurityAllocation(t.db, S.securities.tr2050, { assetClass: "us_stock", splits: [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 4000 }] }, c2);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.batchId, c2.batchId))).toHaveLength(0);

    await expect(setSecurityAllocation(t.db, S.securities.tr2050, { assetClass: "us_stock", splits: [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 3000 }] }, ctx())).rejects.toMatchObject({ status: 400, code: "split_sum" });
    await expect(setSecurityAllocation(t.db, S.securities.tr2050, { assetClass: "intl_stock", splits: [{ assetClass: "us_stock", weightBp: 6000 }, { assetClass: "bonds", weightBp: 4000 }] }, ctx())).rejects.toMatchObject({ status: 400, code: "split_primary" });
    const bondsOnly = await setSecurityAllocation(t.db, S.securities.tr2050, { assetClass: "bonds", splits: null }, ctx());
    expect(bondsOnly).toMatchObject({ assetClass: "bonds", splits: [] });
    expect((await getAllocation(t.db, q)).classes[2]!.currentCents).toBe(790000n - 42000n + 420000n);
    await expect(setSecurityAllocation(t.db, S.securities.cash, { assetClass: "cash", splits: null }, ctx())).rejects.toMatchObject({ status: 400, code: "cash_security_reserved" });
    await expect(setSecurityAllocation(t.db, randomUUID(), { assetClass: "cash", splits: null }, ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await securityRef(t.db, S.securities.tr2050)).toMatchObject({ assetClass: "bonds", splits: [] });
    // Restore the seed's splits for the other cases.
    await setSecurityAllocation(
      t.db,
      S.securities.tr2050,
      {
        assetClass: "us_stock",
        splits: [
          { assetClass: "us_stock", weightBp: 5400 },
          { assetClass: "intl_stock", weightBp: 3600 },
          { assetClass: "bonds", weightBp: 1000 },
        ],
      },
      ctx(),
    );
  });

  it("replaces the allocation targets as a set, audited as allocation_target/household (imports test 21)", async () => {
    const c = ctx();
    const set = await setAllocationTargets(
      t.db,
      [
        { assetClass: "cash", targetBp: 500 },
        { assetClass: "us_stock", targetBp: 6000 },
        { assetClass: "bonds", targetBp: 1500 },
        { assetClass: "intl_stock", targetBp: 2000 },
      ],
      c,
    );
    expect(set.targets).toEqual([
      { assetClass: "us_stock", targetBp: 6000 },
      { assetClass: "intl_stock", targetBp: 2000 },
      { assetClass: "bonds", targetBp: 1500 },
      { assetClass: "cash", targetBp: 500 },
    ]);
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect((await getAllocationTargets(t.db)).targets).toEqual(set.targets);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toEqual([
      expect.objectContaining({
        entity: "allocation_target",
        entityId: "household",
        action: "update",
        before: [
          { assetClass: "us_stock", targetBp: 5000 },
          { assetClass: "intl_stock", targetBp: 2500 },
          { assetClass: "bonds", targetBp: 2000 },
          { assetClass: "cash", targetBp: 500 },
        ],
        after: set.targets,
      }),
    ]);
    const c2 = ctx();
    await setAllocationTargets(t.db, set.targets, c2);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.batchId, c2.batchId))).toHaveLength(0);
    await expect(setAllocationTargets(t.db, [{ assetClass: "us_stock", targetBp: 6000 }, { assetClass: "bonds", targetBp: 3000 }], ctx())).rejects.toMatchObject({ status: 400, code: "allocation_sum", message: "Targets sum to 9000 bp, not 10000" });
    await expect(setAllocationTargets(t.db, [{ assetClass: "us_stock", targetBp: 5000 }, { assetClass: "us_stock", targetBp: 5000 }], ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await setAllocationTargets(t.db, [], ctx());
    expect(await t.db.select().from(allocationTarget)).toHaveLength(0);
    expect(await getAllocationTargets(t.db)).toEqual({ targets: [], updatedAt: null });
    expect((await getAllocation(t.db, q)).targetsSet).toBe(false);
  });

  it("household investment settings: the benchmark must be a non-cash security, the category an income category; audited with the four fields", async () => {
    const c = ctx();
    const row = await updateHouseholdSetting(t.db, { benchmarkSecurityId: S.securities.vxus, rebalanceBandBp: 300, rebalanceMinTradeCents: 25000n }, c);
    expect(row).toMatchObject({ benchmarkSecurityId: S.securities.vxus, rebalanceBandBp: 300, rebalanceMinTradeCents: 25000n, investmentIncomeCategoryId: S.categories.dividends });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, c.batchId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toMatchObject({ benchmarkSecurityId: S.securities.vti, rebalanceBandBp: 500, rebalanceMinTradeCents: "10000", investmentIncomeCategoryId: S.categories.dividends });
    expect(audits[0]!.after).toMatchObject({ benchmarkSecurityId: S.securities.vxus, rebalanceBandBp: 300, rebalanceMinTradeCents: "25000" });
    expect(householdSettingAuditJson(await getHouseholdSetting(t.db))).toMatchObject({ benchmarkSecurityId: S.securities.vxus, rebalanceMinTradeCents: "25000" });

    await expect(updateHouseholdSetting(t.db, { benchmarkSecurityId: randomUUID() }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(updateHouseholdSetting(t.db, { benchmarkSecurityId: S.securities.cash }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    const [groceries] = await t.db.insert(category).values({ name: "Groceries", bucket: "spending", position: 9 }).returning({ id: category.id });
    await expect(updateHouseholdSetting(t.db, { investmentIncomeCategoryId: groceries!.id }, ctx())).rejects.toMatchObject({ status: 400, code: "not_income_category" });
    await expect(updateHouseholdSetting(t.db, { investmentIncomeCategoryId: randomUUID() }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(updateHouseholdSetting(t.db, { rebalanceBandBp: 6000 }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(updateHouseholdSetting(t.db, { rebalanceMinTradeCents: -1n }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });

    // Clearing the benchmark and changing the feed category (which re-runs the feed).
    const [other] = await t.db.insert(category).values({ name: "Interest income", bucket: "income", position: 10 }).returning({ id: category.id });
    const cleared = await updateHouseholdSetting(t.db, { benchmarkSecurityId: null, investmentIncomeCategoryId: other!.id }, ctx());
    expect(cleared).toMatchObject({ benchmarkSecurityId: null, investmentIncomeCategoryId: other!.id });
    const feedJobs = await t.db.select().from(job).where(eq(job.type, "investments.income_feed"));
    expect(feedJobs).toHaveLength(1);
    expect(feedJobs[0]!.payload).toMatchObject({ reason: "setting", dedupeKey: "investments.income_feed" });
    await updateHouseholdSetting(t.db, { investmentIncomeCategoryId: S.categories.dividends, benchmarkSecurityId: S.securities.vti, rebalanceBandBp: 500, rebalanceMinTradeCents: 10000n }, ctx());
    expect((await t.db.select().from(householdSetting))[0]).toMatchObject({ benchmarkSecurityId: S.securities.vti, rebalanceBandBp: 500 });
  });
});
