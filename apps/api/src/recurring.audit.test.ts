import * as OTPAuth from "otpauth";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recurring, refreshRecurringItem, resolvePayee, transaction, type Db } from "@meridian/db";
import type { IsoDate, RecurringView, SubscriptionsResponse } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Audit batch b5 (recurring detection, subscriptions, alerts and cash flow) on the routes:
 * b5-recurring-cashflow-06 and -10 (the Subscriptions response), -09 (account_required) and
 * -12 (moving a linked charge). The server clock is 2026-10-13 18:00 UTC.
 */

const TODAY: IsoDate = "2026-10-13";
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

describe.skipIf(!TEST_DATABASE_URL)("recurring routes: audit batch b5", () => {
  let t: TestApp;
  let db: Db;
  let checking: string;
  let savings: string;
  let card: string;
  let subscriptions: string;

  async function charge(accountId: string, payeeName: string, date: IsoDate, cents: bigint): Promise<string> {
    const p = await resolvePayee(db, payeeName);
    const [row] = await db.insert(transaction).values({ accountId, source: "manual", date, amountCents: cents, payeeId: p.id, rawDescription: payeeName }).returning({ id: transaction.id });
    return row!.id;
  }

  async function activeItem(input: { payeeName: string; accountId: string; anchorDay: number; expectedCents: bigint; links: string[]; transferAccountId?: string; lastChargeDate: IsoDate }): Promise<string> {
    const p = await resolvePayee(db, input.payeeName);
    const [row] = await db
      .insert(recurring)
      .values({
        payeeId: p.id,
        name: input.payeeName,
        status: "active",
        source: "detected",
        cadence: "monthly",
        anchorDay: input.anchorDay,
        expectedCents: input.expectedCents,
        toleranceCents: 100n,
        categoryId: subscriptions,
        accountId: input.accountId,
        transferAccountId: input.transferAccountId ?? null,
        missedFromDate: input.lastChargeDate,
      })
      .returning({ id: recurring.id });
    for (const id of input.links) await db.update(transaction).set({ recurringId: row!.id }).where(eq(transaction.id, id));
    await refreshRecurringItem(db, row!.id, input.lastChargeDate, new Date(`${input.lastChargeDate}T12:00:00Z`));
    return row!.id;
  }

  beforeAll(async () => {
    t = await createTestApp({ now: serverClock });
    db = t.db.db;
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
    checking = (await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Checking", type: "checking" } })).json().id;
    savings = (await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Savings", type: "savings" } })).json().id;
    card = (await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Card", type: "credit" } })).json().id;
    const categories = (await t.call({ method: "GET", url: "/api/categories" })).json() as Array<{ id: string; name: string }>;
    subscriptions = categories.find((c) => c.name === "Subscriptions")!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("b5-12: POST /link with move takes a charge from another item of the same payee; without it, 409", async () => {
    const a = [await charge(card, "Apple", "2026-08-02", -299n), await charge(card, "Apple", "2026-09-02", -299n)];
    const b = [await charge(checking, "Apple", "2026-08-03", -299n)];
    const itemA = await activeItem({ payeeName: "Apple", accountId: card, anchorDay: 2, expectedCents: -299n, links: a, lastChargeDate: "2026-09-02" });
    const itemB = await activeItem({ payeeName: "Apple", accountId: checking, anchorDay: 3, expectedCents: -299n, links: b, lastChargeDate: "2026-08-03" });
    const link = (id: string, payload: object) => t.call({ method: "POST", url: `/api/recurring/${id}/link`, payload });

    const refused = await link(itemB, { transactionId: a[1] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "conflict" });
    const moved = await link(itemB, { transactionId: a[1], move: true });
    expect(moved.statusCode).toBe(200);
    expect(moved.json() as RecurringView).toMatchObject({ id: itemB, chargeCount: 2, lastChargeDate: "2026-09-02" });
    const after = (await t.call({ method: "GET", url: `/api/recurring/${itemA}` })).json() as RecurringView;
    expect(after).toMatchObject({ chargeCount: 1, lastChargeDate: "2026-08-02" });
    expect((await t.call({ method: "GET", url: `/api/transactions/${a[1]}` })).json().recurringId).toBe(itemB);
  });

  it("b5-09: PATCH an active item's account to null is 400 account_required", async () => {
    const links = [await charge(checking, "Water", "2026-09-15", -4000n)];
    const id = await activeItem({ payeeName: "Water", accountId: checking, anchorDay: 15, expectedCents: -4000n, links, lastChargeDate: "2026-09-15" });
    const res = await t.call({ method: "PATCH", url: `/api/recurring/${id}`, payload: { accountId: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "account_required" });
    expect(((await t.call({ method: "GET", url: `/api/recurring/${id}` })).json() as RecurringView).accountId).toBe(checking);
  });

  it("b5-06, b5-10: subscriptions leave out transfers and carry the auto-pause reason", async () => {
    await activeItem({ payeeName: "Save monthly", accountId: checking, transferAccountId: savings, anchorDay: 1, expectedCents: -50000n, links: [], lastChargeDate: "2026-10-01" });
    const gymLinks = [await charge(checking, "Gym", "2026-05-05", -4000n), await charge(checking, "Gym", "2026-06-05", -4000n)];
    const gym = await activeItem({ payeeName: "Gym", accountId: checking, anchorDay: 5, expectedCents: -4000n, links: gymLinks, lastChargeDate: "2026-06-05" });
    await refreshRecurringItem(db, gym, TODAY, serverClock()); // Jul, Aug, Sep, Oct missed: auto-paused
    await refreshRecurringItem(db, gym, "2026-10-14", serverClock()); // the next nightly run: consecutive_missed back to 0

    const subs = (await t.call({ method: "GET", url: "/api/recurring/subscriptions" })).json() as SubscriptionsResponse;
    expect(subs.items.map((s) => s.name)).not.toContain("Save monthly");
    expect(subs.pausedItems.find((s) => s.name === "Gym")).toMatchObject({ status: "paused", statusReason: "missed_3", consecutiveMissed: 0 });
    expect(subs.items.every((s) => s.statusReason === null)).toBe(true);
  });
});
