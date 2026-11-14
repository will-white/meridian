import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baselineHash, defaultRunSettings, ProfileResponse, RetirementProfileDoc, type RetirementProfileDocInput } from "@meridian/shared";
import { auditLog, balanceSnapshot, planProfile, scenario, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { fakePlannerEnv } from "../test/retirementFakes.js";
import { RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture, type RetirementSeed } from "../test/retirementSeed.js";
import type { AuditContext } from "./audit.js";
import { computeBaseline } from "./retirementBaseline.js";
import { getProfile, previewBaseline, putProfile, refreshBaseline, revertProfile } from "./retirementProfile.js";

/**
 * Inputs-and-data §7 database cases 21 (create, save, revert) and 22 (refresh), on the planner
 * fixture (§7.0) with the fake planner environment. Figures are the design's: the effective
 * inputs of case 34 (base 4,000,000, essential 2,400,000, included 22,582,700, plan savings rate
 * 1644 bp) and the six rows of the §3.6 worked example.
 */

const TODAY = RETIREMENT_SEED_TODAY;
const NOW = RETIREMENT_SEED_NOW;
const env = fakePlannerEnv();
const q = { today: TODAY, now: NOW, env };

let batch = 0;
const ctx = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-8000-${String(++batch).padStart(12, "0")}` });

async function auditRows(t: TestDb) {
  return t.db.select().from(auditLog).orderBy(auditLog.at, auditLog.id);
}

function withRetirementAge(doc: RetirementProfileDocInput, age: number): RetirementProfileDocInput {
  return { ...doc, people: { ...doc.people, p1: { ...doc.people.p1, retirementAge: age } } };
}

describe.skipIf(!TEST_DATABASE_URL)("the profile service (inputs cases 21 and 22)", () => {
  let t: TestDb;
  let seed: RetirementSeed;
  let doc: RetirementProfileDocInput;

  beforeAll(async () => {
    t = await createTestDb();
    seed = await seedRetirementFixture(t.db);
    doc = retirementFixtureDoc(seed);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  describe("case 21: create, save, revert", () => {
    it("before creation: exists false, revision 0, no document, the live baseline of case 20, unstored", async () => {
      const p = await getProfile(t.db, q);
      expect(ProfileResponse.parse(p)).toEqual(p);
      expect(p).toMatchObject({ exists: false, revision: 0, doc: null, updatedAt: null, baselineStored: false, effective: null, issues: [], scenarioIssues: [], defaultScenarioId: null });
      const live = await computeBaseline(t.db, { today: TODAY, now: NOW });
      expect(p.baseline).toEqual(live);
      expect(p.baselineHash).toBe(await baselineHash(live));
      // As of 2026-10-13, one day before the fixture's today.
      expect(p).toMatchObject({ baselineAgeDays: 1, baselineStale: false });
      expect(await t.db.select().from(planProfile)).toEqual([]);
    });

    it("refuses a document that is not valid and a first save with a revision", async () => {
      await expect(putProfile(t.db, { ...q, doc: { ...doc, state: "Colorado" }, expectedRevision: 0 }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
      await expect(putProfile(t.db, { ...q, doc, expectedRevision: 1 }, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
      expect(await t.db.select().from(planProfile)).toEqual([]);
    });

    it("expectedRevision 0 creates revision 1, stores case 20's baseline and the default scenario, with three audit rows in one batch", async () => {
      const audit = ctx();
      const p = await putProfile(t.db, { ...q, doc, expectedRevision: 0 }, audit);
      expect(ProfileResponse.parse(p)).toEqual(p);
      expect(p).toMatchObject({ exists: true, revision: 1, baselineStored: true, baselineAgeDays: 1, baselineStale: false });
      expect(p.doc).toEqual(RetirementProfileDoc.parse(doc));

      const live = await computeBaseline(t.db, { today: TODAY, now: NOW });
      const [row] = await t.db.select().from(planProfile);
      expect(row).toMatchObject({ id: 1, schemaVersion: 1, revision: 1, baselineAsOf: "2026-10-13", baselineHash: await baselineHash(live) });
      expect(row!.baseline).toEqual(live);
      expect(p.baselineHash).toBe(row!.baselineHash);

      const scenarios = await t.db.select().from(scenario);
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0]).toMatchObject({ name: "Base plan", isDefault: true, archived: false, position: 0, revision: 1, overrides: {} });
      expect(scenarios[0]!.settings).toEqual(defaultRunSettings());
      expect(p.defaultScenarioId).toBe(scenarios[0]!.id);

      const rows = await auditRows(t);
      expect(rows.map((r) => [r.entity, r.action, r.batchId])).toEqual([
        ["plan_profile", "create", audit.batchId],
        ["plan_baseline", "create", audit.batchId],
        ["scenario", "create", audit.batchId],
      ]);
      expect(rows[0]!.after).toEqual({ doc: RetirementProfileDoc.parse(doc) });
      expect(rows[1]!.after).toMatchObject({ totalCents: "22582700", categorizedCents: "3955000", takeHomeCents: "8400000", savingsRateBp: 2518, accountCount: 8 });
      expect(rows[2]!.after).toMatchObject({ name: "Base plan", isDefault: true, archived: false, position: 0, overrides: {} });

      // The plan resolved with no overrides (case 34's effective inputs): no error, the fixture's
      // eleven warnings (case 11's eight, `expense_ratio_unknown` for K and H, `hsa_no_medical`).
      expect(p.effective).toMatchObject({ baseSpendingCents: "4000000", essentialSpendingCents: "2400000", includedTotalCents: "22582700", planSavingsRateBp: 1644 });
      expect(p.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(p.issues.map((i) => i.code).sort()).toEqual(
        [
          "allocation_assumed",
          "allocation_assumed",
          "basis_unknown",
          "contribution_from_recurring",
          "contribution_partial_window",
          "expense_ratio_unknown",
          "expense_ratio_unknown",
          "goal_before_retirement",
          "hsa_no_medical",
          "irregular_contributions",
          "uncategorized_in_spending",
        ].sort(),
      );
      expect(p.scenarioIssues).toEqual([]);
    });

    it("the same document again keeps revision 1 and writes no audit row", async () => {
      const before = await auditRows(t);
      const p = await putProfile(t.db, { ...q, doc, expectedRevision: 1 }, ctx());
      expect(p.revision).toBe(1);
      expect(await auditRows(t)).toHaveLength(before.length);
    });

    let editRow: string;
    it("a changed retirement age is revision 2 with one update row whose before holds 60", async () => {
      const before = await auditRows(t);
      const p = await putProfile(t.db, { ...q, doc: withRetirementAge(doc, 58), expectedRevision: 1 }, ctx());
      expect(p.revision).toBe(2);
      expect(p.doc!.people.p1.retirementAge).toBe(58);
      const rows = (await auditRows(t)).slice(before.length);
      expect(rows.map((r) => [r.entity, r.action])).toEqual([["plan_profile", "update"]]);
      expect((rows[0]!.before as { doc: RetirementProfileDoc }).doc.people.p1.retirementAge).toBe(60);
      expect((rows[0]!.after as { doc: RetirementProfileDoc }).doc.people.p1.retirementAge).toBe(58);
      editRow = rows[0]!.id;
    });

    it("a stale revision afterwards is 409 revision_conflict, and so is a second creation", async () => {
      await expect(putProfile(t.db, { ...q, doc, expectedRevision: 1 }, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
      await expect(putProfile(t.db, { ...q, doc, expectedRevision: 0 }, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
      expect((await t.db.select().from(planProfile))[0]!.revision).toBe(2);
    });

    it("revertProfile with that audit row restores 60 at revision 3", async () => {
      const before = await auditRows(t);
      await expect(revertProfile(t.db, { ...q, auditId: editRow, expectedRevision: 1 }, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
      const p = await revertProfile(t.db, { ...q, auditId: editRow, expectedRevision: 2 }, ctx());
      expect(p.revision).toBe(3);
      expect(p.doc).toEqual(RetirementProfileDoc.parse(doc));
      const rows = (await auditRows(t)).slice(before.length);
      expect(rows.map((r) => [r.entity, r.action])).toEqual([["plan_profile", "update"]]);
      expect((rows[0]!.before as { doc: RetirementProfileDoc }).doc.people.p1.retirementAge).toBe(58);
    });

    it("a revert of a creation, of another entity's row or of an unknown row is refused", async () => {
      const [created] = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entity, "plan_profile"), eq(auditLog.action, "create")));
      const [scenarioRow] = await t.db.select().from(auditLog).where(eq(auditLog.entity, "scenario"));
      await expect(revertProfile(t.db, { ...q, auditId: created!.id, expectedRevision: 3 }, ctx())).rejects.toMatchObject({ status: 409, code: "revert_invalid" });
      await expect(revertProfile(t.db, { ...q, auditId: scenarioRow!.id, expectedRevision: 3 }, ctx())).rejects.toMatchObject({ status: 409, code: "revert_invalid" });
      await expect(revertProfile(t.db, { ...q, auditId: "00000000-0000-4000-8000-00000000abcd", expectedRevision: 3 }, ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
      // A history entry whose document no longer parses.
      await t.db.update(auditLog).set({ before: { doc: { schemaVersion: 9 } } }).where(eq(auditLog.id, editRow));
      await expect(revertProfile(t.db, { ...q, auditId: editRow, expectedRevision: 3 }, ctx())).rejects.toMatchObject({ status: 409, code: "revert_invalid" });
    });

    it("a stored profile reads back as it was saved", async () => {
      const p = await getProfile(t.db, q);
      expect(p).toMatchObject({ exists: true, revision: 3, baselineStored: true });
      expect(p.doc).toEqual(RetirementProfileDoc.parse(doc));
      // Eight days after the as-of date the baseline is stale (more than 7 days).
      expect(await getProfile(t.db, { ...q, today: "2026-10-21" })).toMatchObject({ baselineAgeDays: 8, baselineStale: true });
    });
  });

  describe("case 22: refresh", () => {
    // §3.6's two edits: a manual balance for K on 2026-10-13 of 15,250,000, and the −45,000 row categorized as Groceries.
    beforeAll(async () => {
      await t.db.insert(balanceSnapshot).values({ accountId: seed.accounts.K, date: "2026-10-13", balanceCents: 15250000n, source: "manual" });
      await t.db.update(transaction).set({ categoryId: seed.categories.groceries }).where(eq(transaction.rawDescription, "VENMO PAYMENT"));
    });

    it("previewBaseline returns the six rows of the worked example and writes nothing", async () => {
      const [stored] = await t.db.select().from(planProfile);
      const audits = (await auditRows(t)).length;
      const preview = await previewBaseline(t.db, q);
      expect(preview.current).toEqual(stored!.baseline);
      expect(preview.proposedHash).toBe(await baselineHash(preview.proposed));
      expect(preview.changes.map((c) => ({ kind: c.kind, before: c.beforeCents, after: c.afterCents, material: c.material }))).toEqual([
        { kind: "account_value", before: "15000000", after: "15250000", material: true },
        { kind: "bucket_total", before: "15000000", after: "15250000", material: true },
        { kind: "total", before: "22582700", after: "22832700", material: true },
        { kind: "spending_category", before: "955000", after: "1000000", material: false },
        { kind: "spending_categorized", before: "3955000", after: "4000000", material: false },
        { kind: "spending_uncategorized", before: "45000", after: "0", material: false },
      ]);
      expect(preview.changes[0]!.accountId).toBe(seed.accounts.K);
      // Effective base spending is 4,000,000 before and after; the included total moves by the 250,000.
      expect(preview.effectiveBefore).toMatchObject({ baseSpendingCents: "4000000", includedTotalCents: "22582700" });
      expect(preview.effectiveAfter).toMatchObject({ baseSpendingCents: "4000000", includedTotalCents: "22832700" });
      const [after] = await t.db.select().from(planProfile);
      expect(after).toEqual(stored);
      expect(await auditRows(t)).toHaveLength(audits);
    });

    it("a refresh against a stale preview hash is 409 baseline_changed and stores nothing", async () => {
      const [stored] = await t.db.select().from(planProfile);
      await expect(refreshBaseline(t.db, { ...q, expectedHash: "0".repeat(64) }, ctx())).rejects.toMatchObject({ status: 409, code: "baseline_changed" });
      expect((await t.db.select().from(planProfile))[0]).toEqual(stored);
    });

    it("refreshBaseline with the preview's hash stores it with one plan_baseline audit row; the revision is untouched", async () => {
      const preview = await previewBaseline(t.db, q);
      const audits = (await auditRows(t)).length;
      const audit = ctx();
      const r = await refreshBaseline(t.db, { ...q, expectedHash: preview.proposedHash }, audit);
      expect(r.changes).toEqual(preview.changes);
      expect(r.profile).toMatchObject({ revision: 3, baselineHash: preview.proposedHash });
      expect(r.profile.effective).toMatchObject({ includedTotalCents: "22832700", baseSpendingCents: "4000000" });
      const [row] = await t.db.select().from(planProfile);
      expect(row).toMatchObject({ revision: 3, baselineHash: preview.proposedHash, baselineAsOf: "2026-10-13" });
      expect(row!.baseline).toEqual(preview.proposed);
      const rows = (await auditRows(t)).slice(audits);
      expect(rows.map((x) => [x.entity, x.action, x.batchId])).toEqual([["plan_baseline", "update", audit.batchId]]);
      expect(rows[0]!.before).toMatchObject({ totalCents: "22582700", categorizedCents: "3955000", uncategorizedOutflowCents: "45000" });
      expect(rows[0]!.after).toMatchObject({ totalCents: "22832700", categorizedCents: "4000000", uncategorizedOutflowCents: "0" });
    });

    it("a refresh with nothing changed writes nothing", async () => {
      const [stored] = await t.db.select().from(planProfile);
      const audits = (await auditRows(t)).length;
      const r = await refreshBaseline(t.db, q, ctx());
      expect(r.changes).toEqual([]);
      expect((await t.db.select().from(planProfile))[0]).toEqual(stored);
      expect(await auditRows(t)).toHaveLength(audits);
    });

    it("a refresh before a profile exists is 409 profile_missing", async () => {
      const other = await createTestDb();
      try {
        await expect(refreshBaseline(other.db, q, ctx())).rejects.toMatchObject({ status: 409, code: "profile_missing" });
        const preview = await previewBaseline(other.db, q);
        expect(preview).toMatchObject({ current: null, effectiveBefore: null, effectiveAfter: null });
      } finally {
        await other.cleanup();
      }
    });
  });

  it("the audit rows of case 21 and 22 name the singleton as entity id 1", async () => {
    const ids = await t.db
      .select({ id: auditLog.entityId })
      .from(auditLog)
      .where(sql`${auditLog.entity} in ('plan_profile', 'plan_baseline')`);
    expect(new Set(ids.map((r) => r.id))).toEqual(new Set(["1"]));
  });
});
