import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connection } from "@meridian/db";
import { PLAN_SEED_START_MONTH, PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import { DashboardView, PlanResponse, SetPlanCellsResponse } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Audit batch b7-plan-ui on the routes: b7-plan-ui-05 (the plan carries its start month, so the
 * grid can show the months before it read-only) and b7-plan-ui-12 (the dashboard's sync rows say
 * whether scheduled syncs are paused). Seed of docs/design/phase-2/grid-and-api.md, today 2026-10-13.
 */

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

describe.skipIf(!TEST_DATABASE_URL)("plan and dashboard routes: audit batch b7", () => {
  let t: TestApp;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestApp({ now: serverClock });
    S = await seedPlanFixture(t.db.db);
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("b7-05: GET /plan and the plan a cell write returns carry the plan start month, which moves with the setting", async () => {
    expect(PLAN_SEED_START_MONTH).toBe("2026-08");
    let res = await t.call({ method: "GET", url: `/api/plan?today=${TODAY}` });
    expect(res.statusCode).toBe(200);
    expect(PlanResponse.parse(res.json()).startMonth).toBe("2026-08");

    // A later start month: the default range's first month (2026-08) is now before it.
    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { planStartMonth: "2026-09" } })).statusCode).toBe(200);
    res = await t.call({ method: "GET", url: `/api/plan?today=${TODAY}` });
    const plan = PlanResponse.parse(res.json());
    expect(plan.months[0]).toBe("2026-08");
    expect(plan.startMonth).toBe("2026-09");

    // The month the grid shows read-only is the one the API refuses.
    const refused = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: [{ month: "2026-08", categoryId: S.categories.dining, plannedCents: "100", source: "manual" }], today: TODAY },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("before_plan_start");

    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { planStartMonth: "2026-08" } })).statusCode).toBe(200);
    const written = await t.call({
      method: "PUT",
      url: "/api/plan/cells",
      payload: { edits: [{ month: "2026-08", categoryId: S.categories.dining, plannedCents: "100", source: "manual" }], range: { from: "2026-08", to: "2027-01" }, today: TODAY },
    });
    expect(written.statusCode).toBe(200);
    expect(SetPlanCellsResponse.parse(written.json()).plan?.startMonth).toBe("2026-08");
  });

  it("b7-12: a connection whose scheduled syncs are paused says so on the dashboard", async () => {
    await t.db.db.insert(connection).values([
      { type: "simplefin", name: "Bank A", status: "auth_required", lastSyncAt: new Date("2026-10-12T06:00:00Z") },
      { type: "simplefin", name: "Bank B", status: "error", syncPaused: true, lastError: "HTTP 403" },
      { type: "simplefin", name: "Bank C", status: "error" },
      { type: "simplefin", name: "Bank D", status: "ok", lastSyncAt: new Date("2026-10-13T06:00:00Z") },
    ]);
    const res = await t.call({ method: "GET", url: `/api/dashboard?today=${TODAY}` });
    expect(res.statusCode).toBe(200);
    const view = DashboardView.parse(res.json());
    expect(view.sync.attention.map((a) => [a.name, a.status, a.syncPaused])).toEqual([
      ["Bank A", "auth_required", false],
      ["Bank B", "error", true],
      ["Bank C", "error", false],
    ]);
  });
});
