import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthPlan } from "@meridian/db";
import { batchUndo, PLAN_HISTORY_ENTITIES, type AuditEntryView, type PlanResponse } from "@meridian/shared";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

async function freshApp(): Promise<{ t: TestApp; S: PlanSeed }> {
  const t = await createTestApp({ now: serverClock });
  const S = await seedPlanFixture(t.db.db);
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  return { t, S };
}

describe.skipIf(!TEST_DATABASE_URL)("plan API review probes", () => {
  let t: TestApp;
  let S: PlanSeed;
  let C: PlanSeed["categories"];

  beforeAll(async () => {
    ({ t, S } = await freshApp());
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("A1 PUT /plan/cells with an oversized range: the write is committed before the range is rejected", async () => {
    const res = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: [{ month: "2026-12", categoryId: C.fuel, plannedCents: "12345" }], range: { from: "2024-01", to: "2026-12" } },
    });
    const rows = await t.db.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.fuel));
    const dec = rows.find((r) => r.month === "2026-12");
    // The range is validated before anything is written, so a bad range persists nothing.
    expect({ status: res.statusCode, stored: dec?.plannedCents ?? null }).toEqual({ status: 400, stored: null });
    expect(res.json().error).toMatch(/At most 24 months/);
  });

  it("b9-04 PUT /plan/cells with an inverted range (from after to) writes and audits nothing", async () => {
    const before = await t.call({ method: "GET", url: "/api/audit?entity=month_plan" });
    expect(before.statusCode).toBe(200);
    const auditBefore = (before.json().items as unknown[]).length;
    const res = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: [{ month: "2027-03", categoryId: C.fuel, plannedCents: "24248" }], range: { from: "2027-01", to: "2026-01" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/from must not be after to/);
    const rows = await t.db.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.fuel));
    expect(rows.find((r) => r.month === "2027-03")).toBeUndefined();
    const after = await t.call({ method: "GET", url: "/api/audit?entity=month_plan" });
    expect((after.json().items as unknown[]).length).toBe(auditBefore);
  });

  it("A2 a batch with an unknown category writes nothing (atomic)", async () => {
    const res = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: [{ month: "2026-11", categoryId: C.fuel, plannedCents: "777" }, { month: "2026-11", categoryId: randomUUID(), plannedCents: "1" }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
    const rows = await t.db.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.fuel));
    expect(rows.find((r) => r.month === "2026-11")).toBeUndefined();
  });

  it("A3 today bound is inclusive at ±2 days", async () => {
    for (const [today, status] of [
      ["2026-10-11", 200],
      ["2026-10-15", 200],
      ["2026-10-10", 400],
      ["2026-10-16", 400],
    ] as const) {
      const res = await t.call({ method: "GET", url: `/api/plan?today=${today}` });
      expect(res.statusCode, today).toBe(status);
      if (status === 400) expect(res.json().code).toBe("today_out_of_range");
    }
  });

  it("A4 error codes from every plugin reach the client with the service code", async () => {
    const income = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{ month: "2026-10", categoryId: C.paycheck, carriedInOverrideCents: "5" }] } });
    expect([income.statusCode, income.json().code]).toEqual([400, "income_no_rollover"]);
    const early = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{ month: "2026-07", categoryId: C.fuel, plannedCents: "5" }] } });
    expect([early.statusCode, early.json().code]).toEqual([400, "before_plan_start"]);
    const tz = await t.call({ method: "PATCH", url: "/api/settings", payload: { timezone: "Mars/Olympus" } });
    expect([tz.statusCode, tz.json().code]).toEqual([400, "validation"]);
    const dupe = await t.call({ method: "POST", url: "/api/category-groups", payload: { name: "Housing", bucket: "bills" } });
    expect([dupe.statusCode, dupe.json().code]).toEqual([409, "conflict"]);
    const mismatch = await t.call({ method: "POST", url: "/api/categories", payload: { name: "Zed", bucket: "spending", groupId: S.groups.housing } });
    expect([mismatch.statusCode, mismatch.json().code]).toEqual([400, "bucket_mismatch"]);
    const goal404 = await t.call({ method: "PATCH", url: `/api/goals/${randomUUID()}`, payload: { name: "x" } });
    expect([goal404.statusCode, goal404.json().code]).toEqual([404, "not_found"]);
    const inUse = await t.call({ method: "DELETE", url: `/api/categories/${C.rent}` });
    expect([inUse.statusCode, inUse.json().code]).toEqual([409, "in_use"]);
    const goalCat = await t.call({ method: "PATCH", url: `/api/categories/${C.emergencyFund}`, payload: { bucket: "spending" } });
    expect([goalCat.statusCode, goalCat.json().code]).toEqual([400, "goal_category"]);
  });

  it("A5 GET /plan/averages?asOf in the future counts empty future months as data", async () => {
    const res = await t.call({ method: "GET", url: `/api/plan/averages?months=3&asOf=2027-02&today=${TODAY}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().window).toEqual({ from: "2026-11", to: "2027-01", monthsWithData: 3 });
  });

  const diningCells = async (): Promise<Array<[string, string, string]>> => {
    const res = await t.call({ method: "GET", url: `/api/plan?from=2026-10&to=2026-12&today=${TODAY}` });
    const plan = res.json() as PlanResponse;
    const row = plan.rows.find((r) => r.kind === "category" && r.categoryId === C.dining);
    if (!row || row.kind !== "category") throw new Error("no Dining row");
    return row.cells.map((c, i) => [plan.months[i]!, c.plannedCents, c.source]);
  };
  const historyOf = async (url: string): Promise<AuditEntryView[]> => {
    const res = await t.call({ method: "GET", url });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items as AuditEntryView[];
  };

  it("b9-03 GET /audit?entities= lists the plan's history across entities, newest first, and refuses an unknown entity", async () => {
    const fill = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: ["2026-10", "2026-11", "2026-12"].map((month) => ({ month, categoryId: C.dining, plannedCents: "25000" })), today: TODAY },
    });
    expect(fill.statusCode, fill.body).toBe(200);
    const settings = await t.call({ method: "PATCH", url: "/api/settings", payload: { zeroBased: true } });
    expect(settings.statusCode, settings.body).toBe(200);

    const items = await historyOf(`/api/audit?entities=${PLAN_HISTORY_ENTITIES.join(",")}&limit=50`);
    expect(items[0]).toMatchObject({ entity: "household_setting", action: "update", before: { zeroBased: false }, after: { zeroBased: true } });
    const cells = items.filter((e) => e.batchId === fill.json().batchId);
    expect(cells.map((e) => [e.entityId, e.action])).toEqual([
      [`2026-12:${C.dining}`, "create"],
      [`2026-11:${C.dining}`, "create"],
      [`2026-10:${C.dining}`, "update"],
    ]);
    expect(await historyOf(`/api/audit?entities=household_setting`)).toHaveLength(1);
    expect((await historyOf(`/api/audit?entities=rule`)).length).toBe(0);
    const bad = await t.call({ method: "GET", url: "/api/audit?entities=month_plan,bogus" });
    expect(bad.statusCode).toBe(400);

    // Put the settings back for the next test, through the history's own undo.
    const undo = batchUndo(items.filter((e) => e.batchId === items[0]!.batchId));
    expect(undo).toEqual({ requests: [{ method: "PATCH", url: "/settings", body: { zeroBased: false } }], cellEdits: [], blocked: [] });
    const back = await t.call({ method: "PATCH", url: `/api${undo.requests[0]!.url}`, payload: undo.requests[0]!.body });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().zeroBased).toBe(false);
  });

  it("b9-03 undoing a fill-right puts every cell of the batch back as it was, in one new audited batch", async () => {
    // Dining: typed 200.00 in Sep and Oct by the seed; after the previous test's fill-right Oct–Dec read 250.00.
    await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{ month: "2026-11", categoryId: C.dining, plannedCents: null }, { month: "2026-12", categoryId: C.dining, plannedCents: null }, { month: "2026-10", categoryId: C.dining, plannedCents: "20000" }], today: TODAY } });
    const before = await diningCells();
    expect(before).toEqual([
      ["2026-10", "20000", "manual"],
      ["2026-11", "0", "none"],
      ["2026-12", "0", "none"],
    ]);
    const fill = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: ["2026-10", "2026-11", "2026-12"].map((month) => ({ month, categoryId: C.dining, plannedCents: "31000" })), today: TODAY },
    });
    const batchId = fill.json().batchId as string;
    expect(await diningCells()).toEqual([
      ["2026-10", "31000", "manual"],
      ["2026-11", "31000", "manual"],
      ["2026-12", "31000", "manual"],
    ]);

    const entries = await historyOf(`/api/audit?batchId=${batchId}`);
    const undo = batchUndo(entries);
    expect(undo.blocked).toEqual([]);
    expect(undo.requests).toEqual([]);
    expect(undo.cellEdits).toEqual([
      { month: "2026-10", categoryId: C.dining, plannedCents: "20000", source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null },
      { month: "2026-11", categoryId: C.dining, plannedCents: null, source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null },
      { month: "2026-12", categoryId: C.dining, plannedCents: null, source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null },
    ]);
    const res = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: undo.cellEdits, today: TODAY } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toBe(3);
    expect(await diningCells()).toEqual(before);
    const rows = await t.db.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.dining));
    expect(rows.map((r) => r.month).sort()).toEqual(["2026-09", "2026-10"]);
    // The undo is itself history: one new batch with the three reverse edits.
    const undoEntries = await historyOf(`/api/audit?batchId=${res.json().batchId}`);
    expect(undoEntries.map((e) => e.action).sort()).toEqual(["delete", "delete", "update"]);
  });
});
