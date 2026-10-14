import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, user } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { DashboardView } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * GET /api/dashboard on the grid-and-api seed (docs/design/phase-2/grid-and-api.md,
 * "GET /api/dashboard computed on request"), today = 2026-10-13 as the server clock
 * (noon in America/Denver) and as the client's `today`. The seed carries balance
 * snapshots but no account balances, so the cash-flow line starts from the pending
 * sum (Visa −2500) and only falls; the dashboard service test derives its numbers.
 */

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

/** A viewer-role user with a verified session, inserted directly; returns the cookie jar for inject(). */
async function viewerCookies(t: TestApp): Promise<Record<string, string>> {
  const [row] = await t.db.db
    .insert(user)
    .values({ username: "viewer", passwordHash: "never-verified", role: "viewer", totpConfirmedAt: new Date() })
    .returning({ id: user.id });
  const id = randomBytes(32).toString("hex");
  await t.db.db.insert(session).values({ id, userId: row!.id, expiresAt: new Date(Date.now() + 86_400_000), totpVerified: true });
  return { meridian_session: t.app.signCookie(id) };
}

describe.skipIf(!TEST_DATABASE_URL)("GET /api/dashboard", () => {
  let t: TestApp;
  let S: PlanSeed;

  beforeAll(async () => {
    ({ t, S } = await freshApp());
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const getDashboard = async (query = `?today=${TODAY}`) => {
    const res = await t.call({ method: "GET", url: `/api/dashboard${query}` });
    expect(res.statusCode).toBe(200);
    return { res, view: res.json() as DashboardView };
  };

  it("assembles the design's numbers from the fresh seed, with Cache-Control: no-store and identical JSON twice", async () => {
    const { res, view } = await getDashboard();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(view.today).toBe(TODAY);

    expect(view.plan).toEqual({
      month: "2026-10",
      leftToSpendCents: "175352",
      toAssignCents: "175452",
      zeroBased: false,
      warning: false,
      pace: { daysLeft: 19, perDayCents: "9229", overCents: "0" },
      planned: { income: "500000", bills: "189548", savings: "50000", spending: "85000" },
      actual: { income: "250000", bills: "181649", savings: "30000", spending: "80000" },
      committed: { income: "500000", bills: "189648", savings: "50000", spending: "85000" },
      uncategorized: { count: 1, cents: "-4500" },
    });

    // Window ends 2026-10-27: Rent (11-01), Netflix (11-05) and Car Insurance (12-20) are out; suggestions never show.
    expect(view.billsDue).toEqual([
      { recurringId: S.recurring.internet, name: "Internet", categoryName: "Internet", accountName: "Checking", dueDate: "2026-10-20", amountCents: "-7999", overdue: false },
    ]);

    expect(view.netWorth).toEqual({
      asOf: TODAY,
      todayCents: "575000",
      yearAgoDate: "2025-10-13",
      yearAgoCents: "350000",
      changeCents: "225000",
      newAccounts: [{ id: S.accounts.visa, name: "Visa" }],
    });

    expect(view.review).toEqual({ uncategorized: 1, suggestedRecurring: 2, alerts: 1 });
    expect(view.sync).toEqual({ lastSyncAt: null, attention: [] });
    expect(view.retirement).toBeNull();

    expect(view.cashFlow.asOf).toBe(TODAY);
    expect(view.cashFlow.horizonDays).toBe(30);
    expect(view.cashFlow.thresholdCents).toBe("0");
    expect(view.cashFlow.points).toHaveLength(31);
    expect(view.cashFlow.points[0]).toEqual({ date: TODAY, cents: "-3290" });
    expect(view.cashFlow.points[30]?.date).toBe("2026-11-12");
    expect(view.cashFlow.points.map((p) => p.date)).toEqual([...new Set(view.cashFlow.points.map((p) => p.date))]);
    // The low point is the line's minimum (earliest date on ties) and here the last day of a line that only falls.
    const min = view.cashFlow.points.reduce((m, p) => (BigInt(p.cents) < BigInt(m.cents) ? p : m));
    expect(view.cashFlow.lowPoint).toEqual(min);
    expect(view.cashFlow.lowPoint.date).toBe("2026-11-12");
    expect(view.cashFlow.firstBelow).toBe(TODAY);
    expect(view.cashFlow.warnings).toEqual([
      "account Checking has no known balance",
      "account Savings has no known balance",
      "account Visa has no known balance",
      "1 month uses 3-month averages for unplanned spending categories",
      "card Visa has no payment day",
    ]);

    const again = await getDashboard();
    expect(again.res.headers["cache-control"]).toBe("no-store");
    expect(again.res.body).toBe(res.body);
  });

  it("defaults today to the server's household date and bounds a client today to ±2 days", async () => {
    const { res, view } = await getDashboard("");
    expect(view.today).toBe(TODAY);
    expect(res.body).toBe((await getDashboard()).res.body);

    const nearby = await getDashboard("?today=2026-10-15");
    expect(nearby.view.today).toBe("2026-10-15");
    expect(nearby.view.plan.pace.daysLeft).toBe(17);
    expect(nearby.view.cashFlow.points[0]?.date).toBe("2026-10-15");

    const tooFar = await t.call({ method: "GET", url: "/api/dashboard?today=2026-10-20" });
    expect(tooFar.statusCode).toBe(400);
    expect(tooFar.json()).toMatchObject({ code: "today_out_of_range" });
    expect((await t.call({ method: "GET", url: "/api/dashboard?today=2026-10-10" })).statusCode).toBe(400);
    expect((await t.call({ method: "GET", url: "/api/dashboard?today=2026-13-01" })).statusCode).toBe(400);
    expect((await t.call({ method: "GET", url: "/api/dashboard?today=yesterday" })).statusCode).toBe(400);
  });

  it("is readable by a viewer and requires a session", async () => {
    const viewer = await t.app.inject({ method: "GET", url: `/api/dashboard?today=${TODAY}`, cookies: await viewerCookies(t) });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.headers["cache-control"]).toBe("no-store");
    expect((viewer.json() as DashboardView).plan.leftToSpendCents).toBe("175352");
    const anonymous = await t.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("recomputes on every request: review counts, the plan block and the pace follow the ledger and the alerts", async () => {
    const dismissed = await t.call({ method: "POST", url: `/api/alerts/${S.alerts.netflixPrice}/dismiss` });
    expect(dismissed.statusCode).toBe(200);
    const categorized = await t.call({ method: "PATCH", url: `/api/transactions/${S.transactions.amazon}`, payload: { categoryId: S.categories.shopping } });
    expect(categorized.statusCode).toBe(200);
    const confirmed = await t.call({ method: "PATCH", url: `/api/recurring/${S.recurring.gym}`, payload: { status: "dismissed" } });
    expect(confirmed.statusCode).toBe(200);

    const { view } = await getDashboard();
    expect(view.review).toEqual({ uncategorized: 0, suggestedRecurring: 1, alerts: 0 });
    expect(view.plan.uncategorized).toEqual({ count: 0, cents: "0" });
    // Shopping Oct actual 4500 against planned 0: committed spending 85000 + 4500, pace 170852 / 19 = 8992 rem 4.
    expect(view.plan).toMatchObject({
      leftToSpendCents: "170852",
      toAssignCents: "175452",
      committed: { income: "500000", bills: "189648", savings: "50000", spending: "89500" },
      pace: { daysLeft: 19, perDayCents: "8992", overCents: "0" },
    });
    // The other cards are unchanged by a review action.
    expect(view.billsDue.map((b) => b.name)).toEqual(["Internet"]);
    expect(view.netWorth.todayCents).toBe("575000");
  });
});
