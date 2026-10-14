import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthPlan } from "@meridian/db";
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
});
