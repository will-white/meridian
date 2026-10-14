import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/** Review probes of the cash-flow, settings and account routes (grid-and-api seed, today 2026-10-13). */

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

async function signInOwner(t: TestApp): Promise<void> {
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
}

describe.skipIf(!TEST_DATABASE_URL)("cash-flow route review probes", () => {
  let t: TestApp;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestApp({ now: serverClock });
    S = await seedPlanFixture(t.db.db);
    await t.db.db.update(account).set({ balanceCents: 320000n, balanceDate: TODAY }).where(eq(account.id, S.accounts.checking));
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("C1. unknown accountIds entry → 400 with code 'bad_request' (cashflow design: `{ error, code: 'bad_request' }`)", async () => {
    const res = await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: TODAY, accountIds: [randomUUID()] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("bad_request");
  });

  it("C3. a what-if naming a non-occurrence date is reported, not an HTTP error", async () => {
    const res = await t.call({
      method: "POST",
      url: "/api/cashflow/projection",
      payload: { today: TODAY, horizonDays: 30, whatIfs: [{ kind: "skipOccurrence", recurringId: S.recurring.rent, occurrenceDate: "2026-11-02" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatIfs).toEqual([{ index: 0, applied: false, reason: `no occurrence of ${S.recurring.rent} on 2026-11-02` }]);
  });
});
