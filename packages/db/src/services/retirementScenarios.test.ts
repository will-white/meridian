import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRunSettings, RetirementProfileDoc, ScenarioSummary, ScenarioView, type RetirementProfileDocInput } from "@meridian/shared";
import { auditLog, scenario, simRun } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { fakePlannerEnv } from "../test/retirementFakes.js";
import { RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture } from "../test/retirementSeed.js";
import type { AuditContext } from "./audit.js";
import { getProfile, putProfile } from "./retirementProfile.js";
import { requestRun } from "./retirementRuns.js";
import { createScenario, deleteScenario, getScenario, listScenarios, revertScenario, updateScenario } from "./retirementScenarios.js";

/**
 * Inputs-and-data §7 database case 23 (scenarios as minimal merge patches over the profile, with
 * revision checks), on the planner fixture with the fake planner environment.
 */

const env = fakePlannerEnv();
const q = { today: RETIREMENT_SEED_TODAY, now: RETIREMENT_SEED_NOW, env };

let batch = 0;
const ctx = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-8000-${String(++batch).padStart(12, "0")}` });

function edit(doc: RetirementProfileDocInput, f: (d: RetirementProfileDoc) => void): RetirementProfileDoc {
  const d = structuredClone(RetirementProfileDoc.parse(doc));
  f(d);
  return d;
}

describe.skipIf(!TEST_DATABASE_URL)("the scenario service (inputs case 23)", () => {
  let t: TestDb;
  let doc: RetirementProfileDocInput;
  let base: string;
  let retire58: ScenarioView;
  let profileRevision = 1;

  beforeAll(async () => {
    t = await createTestDb();
    const seed = await seedRetirementFixture(t.db);
    doc = retirementFixtureDoc(seed);
    await expect(createScenario(t.db, { name: "Too early" }, q, ctx())).rejects.toMatchObject({ status: 409, code: "profile_missing" });
    const p = await putProfile(t.db, { ...q, doc, expectedRevision: 0 }, ctx());
    base = p.defaultScenarioId!;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a scenario created from a document with p1 retiring at 58 stores exactly that patch (changeCount 1)", async () => {
    const audit = ctx();
    retire58 = await createScenario(t.db, { name: "Retire at 58", doc: edit(doc, (d) => (d.people.p1.retirementAge = 58)), profileRevision }, q, audit);
    expect(ScenarioView.parse(retire58)).toEqual(retire58);
    expect(retire58.overrides).toEqual({ people: { p1: { retirementAge: 58 } } });
    expect(retire58).toMatchObject({ changeCount: 1, isDefault: false, archived: false, revision: 1, position: 1, profileRevision: 1, latestRun: null, activeRunId: null });
    expect(retire58.changes).toEqual([{ path: "people.p1.retirementAge", before: 60, after: 58 }]);
    expect(retire58.settings).toEqual(defaultRunSettings());
    expect(retire58.doc!.people.p1.retirementAge).toBe(58);
    expect(retire58.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(retire58.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, retire58.id));
    expect(row).toMatchObject({ entity: "scenario", action: "create", batchId: audit.batchId });
    expect(row!.after).toMatchObject({ name: "Retire at 58", overrides: { people: { p1: { retirementAge: 58 } } }, isDefault: false });
  });

  it("a scenario's effective document follows the profile: the profile's new salary shows under the override", async () => {
    const p = await putProfile(t.db, { ...q, doc: edit(doc, (d) => ((d.incomes["salary_p1"] as { annualGrossCents: string }).annualGrossCents = "13000000")), expectedRevision: 1 }, ctx());
    profileRevision = p.revision;
    expect(profileRevision).toBe(2);
    const s = await getScenario(t.db, retire58.id, q);
    expect(s.doc!.people.p1.retirementAge).toBe(58);
    expect((s.doc!.incomes["salary_p1"] as { annualGrossCents: string }).annualGrossCents).toBe("13000000");
    expect(s.overrides).toEqual({ people: { p1: { retirementAge: 58 } } });
    expect(s.profileRevision).toBe(2);
  });

  it("a document sent with a stale profile revision is 409 revision_conflict", async () => {
    const stale = edit(doc, (d) => (d.people.p1.retirementAge = 57));
    await expect(createScenario(t.db, { name: "Retire at 57", doc: stale, profileRevision: 1 }, q, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    await expect(updateScenario(t.db, retire58.id, { expectedRevision: 1, doc: stale, profileRevision: 1 }, q, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    // So is a stale scenario revision.
    await expect(updateScenario(t.db, retire58.id, { expectedRevision: 7, name: "Renamed" }, q, ctx())).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    expect((await getScenario(t.db, retire58.id, q)).revision).toBe(1);
  });

  it("deleting pen1 from the profile while a scenario edits it: the save succeeds, scenarioIssues names it, and its run is 409 plan_incomplete", async () => {
    const current = (await getProfile(t.db, q)).doc!;
    const pension = await createScenario(
      t.db,
      { name: "Bigger pension", doc: edit(current, (d) => ((d.incomes["pen1"] as { monthlyCents: string }).monthlyCents = "120000")), profileRevision },
      q,
      ctx(),
    );
    expect(pension.overrides).toEqual({ incomes: { pen1: { monthlyCents: "120000" } } });
    const p = await putProfile(t.db, { ...q, doc: edit(current, (d) => delete d.incomes["pen1"]), expectedRevision: profileRevision }, ctx());
    profileRevision = p.revision;
    expect(p.scenarioIssues).toEqual([{ scenarioId: pension.id, name: "Bigger pension", issues: [expect.objectContaining({ code: "override_invalid", severity: "error" })] }]);
    const s = await getScenario(t.db, pension.id, q);
    expect(s).toMatchObject({ doc: null, inputHash: null });
    expect(s.issues.map((i) => i.code)).toEqual(["override_invalid"]);
    await expect(requestRun(t.db, { ...q, scenarioId: pension.id, refresh: false }, ctx())).rejects.toMatchObject({ status: 409, code: "plan_incomplete" });
    expect(await t.db.select().from(simRun)).toEqual([]);
    await deleteScenario(t.db, pension.id, ctx());
  });

  it("a second scenario named 'retire AT 58' is 409 name_taken; so is a rename onto it", async () => {
    await expect(createScenario(t.db, { name: "retire AT 58" }, q, ctx())).rejects.toMatchObject({ status: 409, code: "name_taken" });
    const other = await createScenario(t.db, { name: "Spend less", notes: "  trim  " }, q, ctx());
    expect(other).toMatchObject({ notes: "trim", overrides: {}, changeCount: 0 });
    await expect(updateScenario(t.db, other.id, { expectedRevision: 1, name: " RETIRE at 58 " }, q, ctx())).rejects.toMatchObject({ status: 409, code: "name_taken" });
    // A change of case of its own name is not a clash.
    const renamed = await updateScenario(t.db, other.id, { expectedRevision: 1, name: "SPEND LESS" }, q, ctx());
    expect(renamed).toMatchObject({ name: "SPEND LESS", revision: 2 });
    await deleteScenario(t.db, other.id, ctx());
  });

  it("making another scenario the default flips both rows in one audit batch; the default cannot be deleted or archived", async () => {
    const audit = ctx();
    const s = await updateScenario(t.db, retire58.id, { expectedRevision: 1, isDefault: true }, q, audit);
    expect(s).toMatchObject({ isDefault: true, revision: 2 });
    const rows = await t.db.select().from(scenario);
    expect(rows.find((r) => r.id === base)).toMatchObject({ isDefault: false, revision: 2 });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.batchId, audit.batchId));
    expect(audits.map((a) => [a.entityId, (a.before as { isDefault: boolean }).isDefault, (a.after as { isDefault: boolean }).isDefault]).sort()).toEqual(
      [
        [base, true, false],
        [retire58.id, false, true],
      ].sort(),
    );
    expect((await getProfile(t.db, q)).defaultScenarioId).toBe(retire58.id);

    await expect(deleteScenario(t.db, retire58.id, ctx())).rejects.toMatchObject({ status: 409, code: "default_scenario" });
    await expect(updateScenario(t.db, retire58.id, { expectedRevision: 2, archived: true }, q, ctx())).rejects.toMatchObject({ status: 409, code: "default_scenario" });
    await expect(updateScenario(t.db, retire58.id, { expectedRevision: 2, isDefault: false }, q, ctx())).rejects.toMatchObject({ status: 409, code: "default_scenario" });
    // An archived scenario cannot become the default.
    const archived = await updateScenario(t.db, base, { expectedRevision: 2, archived: true }, q, ctx());
    expect(archived).toMatchObject({ archived: true, revision: 3 });
    await expect(updateScenario(t.db, base, { expectedRevision: 3, isDefault: true }, q, ctx())).rejects.toMatchObject({ status: 409, code: "default_scenario" });
    // Back again: unarchived and default in one write.
    const back = await updateScenario(t.db, base, { expectedRevision: 3, archived: false, isDefault: true }, q, ctx());
    expect(back).toMatchObject({ archived: false, isDefault: true, revision: 4 });
    retire58 = await getScenario(t.db, retire58.id, q);
    expect(retire58).toMatchObject({ isDefault: false, revision: 3 });
  });

  it("an update that changes nothing keeps the revision and writes no audit row", async () => {
    const before = (await t.db.select().from(auditLog)).length;
    const same = await updateScenario(t.db, retire58.id, { expectedRevision: 3, name: "Retire at 58", settings: defaultRunSettings(), doc: (await getScenario(t.db, retire58.id, q)).doc!, profileRevision }, q, ctx());
    expect(same.revision).toBe(3);
    expect(await t.db.select().from(auditLog)).toHaveLength(before);
  });

  it("revertScenario restores the audited overrides and settings", async () => {
    const changed = await updateScenario(
      t.db,
      retire58.id,
      { expectedRevision: 3, doc: edit((await getProfile(t.db, q)).doc!, (d) => (d.people.p1.retirementAge = 57)), profileRevision, settings: { ...defaultRunSettings(), seed: 7 } },
      q,
      ctx(),
    );
    expect(changed).toMatchObject({ overrides: { people: { p1: { retirementAge: 57 } } }, revision: 4 });
    expect(changed.settings.seed).toBe(7);
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, retire58.id)).orderBy(desc(auditLog.at)).limit(1);
    const reverted = await revertScenario(t.db, retire58.id, { auditId: row!.id, expectedRevision: 4 }, q, ctx());
    expect(reverted).toMatchObject({ overrides: { people: { p1: { retirementAge: 58 } } }, revision: 5, name: "Retire at 58" });
    expect(reverted.settings).toEqual(defaultRunSettings());
    // A history entry of another scenario, or of the profile, is refused.
    const [other] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, base)).limit(1);
    await expect(revertScenario(t.db, retire58.id, { auditId: other!.id, expectedRevision: 5 }, q, ctx())).rejects.toMatchObject({ status: 409, code: "revert_invalid" });
    const [profileRow] = await t.db.select().from(auditLog).where(eq(auditLog.entity, "plan_profile")).limit(1);
    await expect(revertScenario(t.db, retire58.id, { auditId: profileRow!.id, expectedRevision: 5 }, q, ctx())).rejects.toMatchObject({ status: 409, code: "revert_invalid" });
  });

  it("copyFromId copies the overrides and settings; the list is in position order, archived ones on request", async () => {
    const copy = await createScenario(t.db, { name: "Copy of 58", copyFromId: retire58.id }, q, ctx());
    expect(copy.overrides).toEqual({ people: { p1: { retirementAge: 58 } } });
    expect(copy.inputHash).toBe(retire58.inputHash);
    await updateScenario(t.db, copy.id, { expectedRevision: 1, archived: true }, q, ctx());
    const open = await listScenarios(t.db, q);
    for (const s of open) expect(ScenarioSummary.parse(s)).toEqual(s);
    expect(open.map((s) => s.name)).toEqual(["Base plan", "Retire at 58"]);
    expect((await listScenarios(t.db, { ...q, includeArchived: true })).map((s) => s.name)).toEqual(["Base plan", "Retire at 58", "Copy of 58"]);
    await expect(getScenario(t.db, "00000000-0000-4000-8000-0000000000ff", q)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await deleteScenario(t.db, copy.id, ctx());
  });

  it("at most 50 scenarios are open: the 51st is 409 too_many_scenarios, and so is unarchiving past it", async () => {
    const open = (await listScenarios(t.db, q)).length;
    const made: string[] = [];
    for (let i = open; i < 50; i++) made.push((await createScenario(t.db, { name: `Scenario ${i}` }, q, ctx())).id);
    await expect(createScenario(t.db, { name: "One too many" }, q, ctx())).rejects.toMatchObject({ status: 409, code: "too_many_scenarios" });
    const archived = await updateScenario(t.db, made[0]!, { expectedRevision: 1, archived: true }, q, ctx());
    await createScenario(t.db, { name: "Fiftieth" }, q, ctx());
    await expect(updateScenario(t.db, made[0]!, { expectedRevision: archived.revision, archived: false }, q, ctx())).rejects.toMatchObject({ status: 409, code: "too_many_scenarios" });
  });
});
