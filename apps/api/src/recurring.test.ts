import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alert, job, payee, raiseAlert, recurring, resolvePayee, transaction, type Db } from "@meridian/db";
import type { AlertView, Cadence, IsoDate, RecurringStatus, RecurringView, SubscriptionsResponse, TransactionView } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * /api/recurring, /api/recurring/subscriptions, /api/alerts and the recurring hooks on
 * the transaction and import routes (recurring design, "api"; docs/phase-2-plan.md §17).
 * The server clock is 2026-10-13 18:00 UTC, i.e. 2026-10-13 in America/Denver.
 */

const TODAY: IsoDate = "2026-10-13";
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

interface Seed {
  checking: string;
  card: string;
  subscriptions: string;
  utilities: string;
  rent: string;
}

async function freshApp(): Promise<{ t: TestApp; db: Db; S: Seed }> {
  const t = await createTestApp({ now: serverClock });
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  const checking = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Checking", type: "checking" } });
  const card = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Card", type: "credit" } });
  const categories = (await t.call({ method: "GET", url: "/api/categories" })).json() as Array<{ id: string; name: string }>;
  const cat = (name: string) => categories.find((c) => c.name === name)!.id;
  return {
    t,
    db: t.db.db,
    S: { checking: checking.json().id, card: card.json().id, subscriptions: cat("Subscriptions"), utilities: cat("Utilities"), rent: cat("Rent / Mortgage") },
  };
}

interface ItemInput {
  payeeName: string;
  name?: string;
  status: RecurringStatus;
  cadence: Cadence;
  anchorDay?: number;
  anchorDay2?: number;
  anchorMonth?: number;
  anchorDate?: IsoDate;
  expectedCents: bigint;
  toleranceCents?: bigint;
  nextDueDate?: IsoDate | null;
  confidence?: number;
  categoryId?: string | null;
  accountId?: string | null;
  consecutiveMissed?: number;
  source?: "detected" | "manual";
}

/** A hand-built row, the way the detector or an earlier confirm would have left it. */
async function insertItem(db: Db, input: ItemInput): Promise<string> {
  const p = await resolvePayee(db, input.payeeName);
  const [row] = await db
    .insert(recurring)
    .values({
      payeeId: p.id,
      name: input.name ?? p.name,
      status: input.status,
      source: input.source ?? "detected",
      cadence: input.cadence,
      anchorDay: input.anchorDay ?? null,
      anchorDay2: input.anchorDay2 ?? null,
      anchorMonth: input.anchorMonth ?? null,
      anchorDate: input.anchorDate ?? null,
      expectedCents: input.expectedCents,
      toleranceCents: input.toleranceCents ?? 100n,
      nextDueDate: input.nextDueDate ?? null,
      confidence: input.confidence ?? null,
      categoryId: input.categoryId ?? null,
      accountId: input.accountId ?? null,
      consecutiveMissed: input.consecutiveMissed ?? 0,
    })
    .returning({ id: recurring.id });
  return row!.id;
}

async function insertTx(db: Db, input: { accountId: string; payeeName: string; date: IsoDate; cents: bigint; recurringId?: string }): Promise<string> {
  const p = await resolvePayee(db, input.payeeName);
  const [row] = await db
    .insert(transaction)
    .values({ accountId: input.accountId, source: "manual", date: input.date, amountCents: input.cents, payeeId: p.id, rawDescription: input.payeeName, recurringId: input.recurringId ?? null })
    .returning({ id: transaction.id });
  return row!.id;
}

async function jobsOfType(db: Db, type: "recurring.detect" | "plan.close_month") {
  return db.select().from(job).where(eq(job.type, type)).orderBy(asc(job.createdAt));
}

describe.skipIf(!TEST_DATABASE_URL)("recurring API", () => {
  let t: TestApp;
  let db: Db;
  let S: Seed;
  const ids: Record<string, string> = {};

  const list = async (query = ""): Promise<{ items: RecurringView[]; totals: { yearlyCents: string; monthlyEquivalentCents: string } }> => {
    const res = await t.call({ method: "GET", url: `/api/recurring${query}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const names = (items: RecurringView[]) => items.map((i) => i.name);
  const patch = (id: string, payload: Record<string, unknown>) => t.call({ method: "PATCH", url: `/api/recurring/${id}`, payload });
  const get = async (id: string): Promise<RecurringView> => {
    const res = await t.call({ method: "GET", url: `/api/recurring/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ({ t, db, S } = await freshApp());
    ids.netflix = await insertItem(db, { payeeName: "Netflix", status: "suggested", cadence: "monthly", anchorDay: 5, expectedCents: -1549n, nextDueDate: "2026-10-05", confidence: 100, accountId: S.checking });
    ids.spotify = await insertItem(db, { payeeName: "Spotify", status: "suggested", cadence: "monthly", anchorDay: 12, expectedCents: -1099n, nextDueDate: "2026-11-12", confidence: 85, accountId: S.checking });
    ids.apple = await insertItem(db, { payeeName: "Apple", status: "suggested", cadence: "monthly", anchorDay: 2, expectedCents: -299n, nextDueDate: "2026-11-02", confidence: 100, accountId: S.checking });
    ids.rent = await insertItem(db, { payeeName: "Oakwood Apts", name: "Rent", status: "active", cadence: "monthly", anchorDay: 1, expectedCents: -180000n, toleranceCents: 1800n, nextDueDate: "2026-11-01", categoryId: S.rent, accountId: S.checking, consecutiveMissed: 1 });
    ids.payroll = await insertItem(db, { payeeName: "Acme Payroll", name: "Payroll", status: "active", cadence: "biweekly", anchorDate: "2026-10-02", expectedCents: 198765n, toleranceCents: 1987n, nextDueDate: "2026-10-16", categoryId: null, accountId: S.checking });
    ids.gym = await insertItem(db, { payeeName: "24 Hour Fitness", name: "Gym", status: "paused", cadence: "monthly", anchorDay: 5, expectedCents: -4999n, nextDueDate: "2026-11-05", categoryId: S.subscriptions, accountId: S.card });
    ids.insurance = await insertItem(db, { payeeName: "Allstate", name: "Insurance", status: "cancelled", cadence: "semiannual", anchorDay: 3, anchorMonth: 4, expectedCents: -61250n, nextDueDate: null, categoryId: S.utilities, accountId: S.checking });
    ids.old = await insertItem(db, { payeeName: "Old Thing", status: "dismissed", cadence: "monthly", anchorDay: 20, expectedCents: -500n, nextDueDate: "2026-10-20", categoryId: S.subscriptions, accountId: S.checking });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists everything but dismissed by default: suggestions first by confidence then |yearly|, the rest by due date (nulls last)", async () => {
    const { items, totals } = await list();
    expect(names(items)).toEqual(["Netflix", "Apple", "Spotify", "Payroll", "Rent", "Gym", "Insurance"]);
    const netflix = items[0]!;
    expect(netflix).toMatchObject({
      payeeName: "Netflix",
      status: "suggested",
      source: "detected",
      confidence: 100,
      expectedCents: "-1549",
      toleranceCents: "100",
      yearlyCents: "-18588",
      monthlyEquivalentCents: "-1549",
      accountName: "Checking",
      categoryId: null,
      categoryName: null,
      overdue: false,
      chargeCount: 0,
    });
    const payroll = items.find((i) => i.name === "Payroll")!;
    // 198765 × 26 = 5167890; / 12 truncates (plan §18).
    expect(payroll).toMatchObject({ cadence: "biweekly", anchorDate: "2026-10-02", yearlyCents: "5167890", monthlyEquivalentCents: "430657", overdue: false });
    expect(items.find((i) => i.name === "Rent")).toMatchObject({ overdue: true, consecutiveMissed: 1, categoryName: "Rent / Mortgage" });
    expect(items.find((i) => i.name === "Insurance")).toMatchObject({ nextDueDate: null, yearlyCents: "-122500", monthlyEquivalentCents: "-10208" });
    // Σ yearly = 5167890 − 2160000 − 122500 − 59988 − 18588 − 13188 − 3588 = 2790038; / 12 → 232503.
    expect(totals).toEqual({ yearlyCents: "2790038", monthlyEquivalentCents: "232503" });
  });

  it("filters by status and direction and sorts by cost, name and due", async () => {
    expect(names((await list("?status=dismissed")).items)).toEqual(["Old Thing"]);
    expect((await list("?status=all")).items).toHaveLength(8);
    expect(names((await list("?status=suggested")).items)).toEqual(["Netflix", "Apple", "Spotify"]);
    expect(names((await list("?direction=inflow")).items)).toEqual(["Payroll"]);
    expect(names((await list("?direction=outflow&status=active")).items)).toEqual(["Rent"]);
    expect(names((await list("?sort=cost")).items)).toEqual(["Payroll", "Rent", "Insurance", "Gym", "Netflix", "Spotify", "Apple"]);
    expect(names((await list("?sort=name")).items)).toEqual(["Apple", "Gym", "Insurance", "Netflix", "Payroll", "Rent", "Spotify"]);
    expect(names((await list("?status=active&sort=due")).items)).toEqual(["Payroll", "Rent"]);
    expect(names((await list("?sort=confidence&status=suggested")).items)).toEqual(["Netflix", "Apple", "Spotify"]);
    expect((await t.call({ method: "GET", url: "/api/recurring?status=bogus" })).statusCode).toBe(400);
  });

  it("GET /recurring/:id returns one item and 404 for an unknown id", async () => {
    expect(await get(ids.gym!)).toMatchObject({ id: ids.gym, name: "Gym", status: "paused", accountName: "Card" });
    expect((await t.call({ method: "GET", url: `/api/recurring/${randomUUID()}` })).statusCode).toBe(404);
  });

  it("creates a manual item: source manual, both locks, default tolerance, and the current period's charge linked", async () => {
    const charge = await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: S.checking, date: "2026-10-10", amountCents: "-8900", payeeName: "Xcel Energy" } });
    expect(charge.statusCode).toBe(200);
    const res = await t.call({
      method: "POST",
      url: "/api/recurring",
      payload: { name: "Electric", payeeName: "Xcel Energy", categoryId: S.utilities, accountId: S.checking, cadence: "monthly", anchorDay: 10, expectedCents: "-8900" },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json() as RecurringView;
    ids.electric = item.id;
    expect(item).toMatchObject({
      name: "Electric",
      payeeName: "Xcel Energy",
      categoryName: "Utilities",
      accountName: "Checking",
      source: "manual",
      status: "active",
      amountLocked: true,
      scheduleLocked: true,
      amountMode: "fixed",
      expectedCents: "-8900",
      toleranceCents: "100", // max(100, 8900 / 100 = 89)
      cadence: "monthly",
      anchorDay: 10,
      anchorMonth: null,
      chargeCount: 1,
      firstChargeDate: "2026-10-10",
      lastChargeDate: "2026-10-10",
      lastChargeCents: "-8900",
      nextDueDate: "2026-11-10",
      consecutiveMissed: 0,
      overdue: false,
      confidence: null,
      yearlyCents: "-106800",
      monthlyEquivalentCents: "-8900",
    });
    expect((await t.call({ method: "GET", url: `/api/transactions/${charge.json().id}` })).json().recurringId).toBe(item.id);

    // A yearly item with no charge yet: tolerance = max(100, 1%), next due = the next occurrence after today.
    const domain = await t.call({
      method: "POST",
      url: "/api/recurring",
      payload: { name: "Domain", payeeName: "Namecheap", categoryId: S.subscriptions, accountId: S.card, cadence: "yearly", anchorDay: 14, anchorMonth: 3, expectedCents: "-1200", notes: "example.com" },
    });
    expect(domain.statusCode).toBe(201);
    ids.domain = domain.json().id;
    expect(domain.json()).toMatchObject({ toleranceCents: "100", nextDueDate: "2027-03-14", chargeCount: 0, lastChargeDate: null, notes: "example.com", anchorMonth: 3 });

    // A large amount: 1% wins over the $1 floor.
    const big = await t.call({
      method: "POST",
      url: "/api/recurring",
      payload: { name: "Mortgage", payeeName: "Big Bank", categoryId: S.rent, accountId: S.checking, cadence: "monthly", anchorDay: 1, expectedCents: "-250000", amountMode: "variable", toleranceCents: "5000" },
    });
    expect(big.statusCode).toBe(201);
    expect(big.json()).toMatchObject({ toleranceCents: "5000", amountMode: "variable", nextDueDate: "2026-11-01" });
    ids.mortgage = big.json().id;
  });

  it("rejects a manual item whose schedule misses the anchors its cadence needs (400 validation)", async () => {
    const base = { name: "Bad", payeeName: "Someone", categoryId: S.utilities, accountId: S.checking, expectedCents: "-1000" };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ cadence: "weekly" }, /anchorDate/],
      [{ cadence: "biweekly", anchorDay: 5 }, /anchorDate/],
      [{ cadence: "twice_monthly", anchorDay: 1 }, /anchorDay2/],
      [{ cadence: "twice_monthly", anchorDay: 15, anchorDay2: 1 }, /after anchorDay/],
      [{ cadence: "monthly" }, /anchorDay/],
      [{ cadence: "quarterly", anchorDay: 10 }, /anchorMonth/],
      [{ cadence: "yearly", anchorMonth: 3 }, /anchorDay/],
      [{ cadence: "monthly", anchorDay: 5, expectedCents: "0" }, /zero/],
      [{ cadence: "monthly", anchorDay: 5, payeeId: randomUUID() }, /payeeId or payeeName/],
      [{ cadence: "monthly", anchorDay: 5, categoryId: randomUUID() }, /Category not found/],
      [{ cadence: "monthly", anchorDay: 5, accountId: randomUUID() }, /Account not found/],
    ];
    for (const [overrides, message] of cases) {
      const res = await t.call({ method: "POST", url: "/api/recurring", payload: { ...base, ...overrides } });
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(res.json().code).toBe("validation");
      expect(res.json().error).toMatch(message);
    }
    // Contract-level validation: anchorDay out of range, bad cents.
    expect((await t.call({ method: "POST", url: "/api/recurring", payload: { ...base, cadence: "monthly", anchorDay: 32 } })).statusCode).toBe(400);
    expect((await t.call({ method: "POST", url: "/api/recurring", payload: { ...base, cadence: "monthly", anchorDay: 5, expectedCents: "12.50" } })).statusCode).toBe(400);
    const nothingWithoutPayee = await t.call({ method: "POST", url: "/api/recurring", payload: { name: "X", categoryId: S.utilities, accountId: S.checking, cadence: "monthly", anchorDay: 5, expectedCents: "-1" } });
    expect(nothingWithoutPayee.statusCode).toBe(400);
    expect((await list("?status=all")).items.filter((i) => i.name === "Bad")).toHaveLength(0);
  });

  it("edits lock what they touch and re-validate the merged schedule", async () => {
    const edited = await patch(ids.spotify!, { expectedCents: "-1199", name: "Spotify Duo" });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: "Spotify Duo", expectedCents: "-1199", amountLocked: true, scheduleLocked: false, yearlyCents: "-14388" });

    const moved = await patch(ids.spotify!, { cadence: "quarterly", anchorMonth: 1 });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ cadence: "quarterly", anchorDay: 12, anchorMonth: 1, scheduleLocked: true, yearlyCents: "-4796" });

    const bad = await patch(ids.spotify!, { cadence: "weekly" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "validation", error: expect.stringMatching(/anchorDate/) });
    expect((await get(ids.spotify!)).cadence).toBe("quarterly");

    expect((await patch(randomUUID(), { name: "x" })).statusCode).toBe(404);
  });

  it("confirming needs a category; it fills the payee's default category and resolves the new_recurring alert", async () => {
    expect(await raiseAlert(db, { kind: "new_recurring", dedupeKey: `new:${ids.netflix}`, recurringId: ids.netflix!, payeeId: (await resolvePayee(db, "Netflix")).id })).toBe(true);
    const refused = await patch(ids.netflix!, { status: "active" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("category_required");
    expect((await get(ids.netflix!)).status).toBe("suggested");

    const confirmed = await patch(ids.netflix!, { status: "active", categoryId: S.subscriptions });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "active", categoryId: S.subscriptions, categoryName: "Subscriptions", statusReason: null });
    expect(confirmed.json().statusChangedAt).toBe(serverClock().toISOString());
    const [p] = await db.select({ defaultCategoryId: payee.defaultCategoryId }).from(payee).where(eq(payee.name, "Netflix"));
    expect(p!.defaultCategoryId).toBe(S.subscriptions);

    const open = (await t.call({ method: "GET", url: "/api/alerts" })).json().items as AlertView[];
    expect(open.filter((a) => a.recurringId === ids.netflix)).toHaveLength(0);
    const all = (await t.call({ method: "GET", url: "/api/alerts?includeResolved=true" })).json().items as AlertView[];
    expect(all.find((a) => a.recurringId === ids.netflix)).toMatchObject({ kind: "new_recurring", recurringName: "Netflix", payeeName: "Netflix", resolvedAt: serverClock().toISOString(), dismissedAt: null });
  });

  it("applies the status matrix: allowed transitions succeed, the others are 400 invalid_transition", async () => {
    const expectTransition = async (id: string, status: string, ok: boolean) => {
      const res = await patch(id, { status });
      if (ok) {
        expect(res.statusCode, `${status} should be allowed`).toBe(200);
        expect(res.json().status).toBe(status);
      } else {
        expect(res.statusCode, `${status} should be refused`).toBe(400);
        expect(res.json().code).toBe("invalid_transition");
      }
    };
    // suggested → only active | dismissed
    await expectTransition(ids.apple!, "paused", false);
    await expectTransition(ids.apple!, "cancelled", false);
    // active → paused | cancelled, never dismissed
    await expectTransition(ids.rent!, "dismissed", false);
    await expectTransition(ids.rent!, "paused", true);
    expect(await get(ids.rent!)).toMatchObject({ status: "paused", overdue: false, consecutiveMissed: 0 });
    // paused → active | cancelled
    await expectTransition(ids.rent!, "dismissed", false);
    await expectTransition(ids.rent!, "cancelled", true);
    expect((await get(ids.rent!)).nextDueDate).toBeNull();
    // cancelled → active only
    await expectTransition(ids.rent!, "paused", false);
    await expectTransition(ids.rent!, "dismissed", false);
    await expectTransition(ids.rent!, "active", true);
    expect((await get(ids.rent!)).nextDueDate).toBe("2026-11-01");
    // dismissed → active only (needs a category; Old Thing has one)
    await expectTransition(ids.old!, "paused", false);
    await expectTransition(ids.old!, "cancelled", false);
    await expectTransition(ids.old!, "active", true);
    await expectTransition(ids.old!, "cancelled", true);
    // the same status is a no-op
    await expectTransition(ids.old!, "cancelled", true);
    // resuming the paused gym starts the missed clock today
    await expectTransition(ids.gym!, "active", true);
    expect(await get(ids.gym!)).toMatchObject({ status: "active", statusReason: null, nextDueDate: "2026-11-05" });
    await expectTransition(ids.gym!, "paused", true);
  });

  it("dismissing keeps the row and its links and hides it from the default list", async () => {
    const charges = [];
    for (const date of ["2026-08-02", "2026-09-02", "2026-10-02"] as IsoDate[]) charges.push(await insertTx(db, { accountId: S.checking, payeeName: "Apple", date, cents: -299n, recurringId: ids.apple! }));
    const dismissed = await patch(ids.apple!, { status: "dismissed" });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: "dismissed", chargeCount: 3, lastChargeDate: "2026-10-02", nextDueDate: "2026-11-02" });
    expect(names((await list()).items)).not.toContain("Apple");
    expect(names((await list("?status=dismissed")).items)).toEqual(["Apple"]); // Old Thing was re-activated and cancelled above
    const [row] = await db.select().from(recurring).where(eq(recurring.id, ids.apple!));
    expect(row!.status).toBe("dismissed");
    const links = await db.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.payeeId, row!.payeeId));
    expect(links.map((l) => l.recurringId)).toEqual([ids.apple, ids.apple, ids.apple]);
  });

  it("links and unlinks charges by hand, with 409 for a taken period or a charge linked elsewhere", async () => {
    const sep = await insertTx(db, { accountId: S.checking, payeeName: "Oakwood Apts", date: "2026-09-01", cents: -180000n });
    const oct = await insertTx(db, { accountId: S.checking, payeeName: "Oakwood Apts", date: "2026-10-01", cents: -180000n });
    const octAgain = await insertTx(db, { accountId: S.checking, payeeName: "Oakwood Apts", date: "2026-10-03", cents: -180000n });
    const other = await insertTx(db, { accountId: S.checking, payeeName: "Someone Else", date: "2026-10-01", cents: -180000n });
    const link = (id: string, transactionId: string) => t.call({ method: "POST", url: `/api/recurring/${id}/link`, payload: { transactionId } });

    let res = await link(ids.rent!, sep);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chargeCount: 1, firstChargeDate: "2026-09-01", lastChargeDate: "2026-09-01", lastChargeCents: "-180000" });
    res = await link(ids.rent!, oct);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chargeCount: 2, lastChargeDate: "2026-10-01", nextDueDate: "2026-11-01", overdue: false });
    expect((await link(ids.rent!, oct)).statusCode).toBe(200); // already linked here: no-op

    res = await link(ids.rent!, octAgain);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", error: expect.stringMatching(/period/) });
    res = await link(ids.electric!, oct);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/another recurring item/);
    res = await link(ids.rent!, other);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "validation", error: expect.stringMatching(/payee/) });
    expect((await link(ids.rent!, randomUUID())).statusCode).toBe(404);
    expect((await link(randomUUID(), oct)).statusCode).toBe(404);

    res = await t.call({ method: "DELETE", url: `/api/recurring/${ids.rent}/link/${oct}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chargeCount: 1, lastChargeDate: "2026-09-01" });
    expect((await t.call({ method: "GET", url: `/api/transactions/${oct}` })).json().recurringId).toBeNull();
    expect((await t.call({ method: "DELETE", url: `/api/recurring/${ids.rent}/link/${oct}` })).statusCode).toBe(404);
    ids.rentSep = sep;
    ids.rentOct = oct;
  });

  it("lists an item's charges and honours the recurringId and goalId transaction filters", async () => {
    const res = await t.call({ method: "GET", url: `/api/recurring/${ids.rent}/transactions` });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as TransactionView[];
    expect(items.map((i) => [i.id, i.recurringId])).toEqual([[ids.rentSep, ids.rent]]);
    expect(res.json().nextCursor).toBeNull();
    expect((await t.call({ method: "GET", url: `/api/recurring/${randomUUID()}/transactions` })).statusCode).toBe(404);

    const filtered = await t.call({ method: "GET", url: `/api/transactions?recurringId=${ids.rent}` });
    expect((filtered.json().items as TransactionView[]).map((i) => i.id)).toEqual([ids.rentSep]);
    const goal = await t.call({ method: "GET", url: `/api/transactions?goalId=${randomUUID()}` });
    expect(goal.statusCode).toBe(200);
    expect(goal.json().items).toEqual([]);
    expect((await t.call({ method: "GET", url: "/api/transactions?recurringId=nope" })).statusCode).toBe(400);
  });

  it("a payee change or a transfer flag on a linked charge drops the link and refreshes the item", async () => {
    let res = await t.call({ method: "PATCH", url: `/api/transactions/${ids.rentSep}`, payload: { notes: "september" } });
    expect(res.json()).toMatchObject({ recurringId: ids.rent, notes: "september" });

    res = await t.call({ method: "PATCH", url: `/api/transactions/${ids.rentSep}`, payload: { payeeName: "Oakwood Apts" } });
    expect(res.json().recurringId).toBe(ids.rent); // same payee: nothing changed

    res = await t.call({ method: "PATCH", url: `/api/transactions/${ids.rentSep}`, payload: { payeeName: "Landlord LLC" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payeeName: "Landlord LLC", recurringId: null });
    expect(await get(ids.rent!)).toMatchObject({ chargeCount: 0, lastChargeDate: null, lastChargeCents: null });

    expect((await t.call({ method: "POST", url: `/api/recurring/${ids.rent}/link`, payload: { transactionId: ids.rentOct } })).json().chargeCount).toBe(1);
    res = await t.call({ method: "PATCH", url: `/api/transactions/${ids.rentOct}`, payload: { isTransfer: true } });
    expect(res.json()).toMatchObject({ isTransfer: true, recurringId: null });
    expect((await get(ids.rent!)).chargeCount).toBe(0);
  });

  it("alerts: open ones newest first, filters, idempotent dismiss, dismiss-all", async () => {
    const netflixPayee = (await resolvePayee(db, "Netflix")).id;
    const rentPayee = (await resolvePayee(db, "Oakwood Apts")).id;
    const huluPayee = (await resolvePayee(db, "Hulu")).id;
    const at = (iso: string) => new Date(iso);
    const inserted = await db
      .insert(alert)
      .values([
        { kind: "price_increase", dedupeKey: `price:${ids.netflix}:x`, recurringId: ids.netflix, payeeId: netflixPayee, oldCents: -1549n, newCents: -1799n, createdAt: at("2026-10-11T00:00:00Z") },
        { kind: "missed_charge", dedupeKey: `missed:${ids.rent}:2026-10-01`, recurringId: ids.rent, payeeId: rentPayee, dueDate: "2026-10-01", createdAt: at("2026-10-12T00:00:00Z") },
        { kind: "trial_converted", dedupeKey: `trial:${huluPayee}:y`, payeeId: huluPayee, newCents: -1799n, createdAt: at("2026-10-13T00:00:00Z") },
        { kind: "missed_charge", dedupeKey: `missed:${ids.rent}:2026-09-01`, recurringId: ids.rent, payeeId: rentPayee, dueDate: "2026-09-01", createdAt: at("2026-10-10T00:00:00Z"), dismissedAt: at("2026-10-10T01:00:00Z") },
      ])
      .returning({ id: alert.id, kind: alert.kind });
    const byKind = (kind: string, n = 0) => inserted.filter((a) => a.kind === kind)[n]!.id;

    const open = (await t.call({ method: "GET", url: "/api/alerts" })).json().items as AlertView[];
    expect(open.map((a) => a.kind)).toEqual(["trial_converted", "missed_charge", "price_increase"]);
    expect(open[0]).toMatchObject({ recurringId: null, recurringName: null, payeeName: "Hulu", newCents: "-1799", oldCents: null, dueDate: null, dismissedAt: null, resolvedAt: null });
    expect(open[1]).toMatchObject({ recurringName: "Rent", dueDate: "2026-10-01" });
    expect(open[2]).toMatchObject({ recurringName: "Netflix", oldCents: "-1549", newCents: "-1799", createdAt: "2026-10-11T00:00:00.000Z" });
    expect((await t.call({ method: "GET", url: "/api/alerts?kind=missed_charge" })).json().items).toHaveLength(1);
    expect((await t.call({ method: "GET", url: "/api/alerts?includeDismissed=true&kind=missed_charge" })).json().items).toHaveLength(2);
    expect((await t.call({ method: "GET", url: "/api/alerts?includeDismissed=true&includeResolved=true" })).json().items).toHaveLength(5);
    // The design's documented call sends the flags explicitly; "false" must not read as true.
    const explicit = await t.call({ method: "GET", url: "/api/alerts?includeDismissed=false&includeResolved=false" });
    expect(explicit.statusCode).toBe(200);
    expect((explicit.json().items as AlertView[]).map((a) => [a.kind, a.dismissedAt, a.resolvedAt])).toEqual(open.map((a) => [a.kind, null, null]));
    expect((await t.call({ method: "GET", url: "/api/alerts?includeDismissed=0&includeResolved=1" })).json().items).toHaveLength(4);
    expect((await t.call({ method: "GET", url: "/api/alerts?includeDismissed=yes" })).statusCode).toBe(400);
    expect((await t.call({ method: "GET", url: "/api/alerts?limit=1" })).json().items).toHaveLength(1);
    expect((await t.call({ method: "GET", url: "/api/alerts?kind=nope" })).statusCode).toBe(400);

    const first = await t.call({ method: "POST", url: `/api/alerts/${byKind("price_increase")}/dismiss` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: byKind("price_increase"), dismissedAt: serverClock().toISOString() });
    const again = await t.call({ method: "POST", url: `/api/alerts/${byKind("price_increase")}/dismiss` });
    expect(again.json().dismissedAt).toBe(first.json().dismissedAt);
    expect((await t.call({ method: "POST", url: `/api/alerts/${randomUUID()}/dismiss` })).statusCode).toBe(404);
    expect(((await t.call({ method: "GET", url: "/api/alerts" })).json().items as AlertView[]).map((a) => a.kind)).toEqual(["trial_converted", "missed_charge"]);

    expect((await t.call({ method: "POST", url: "/api/alerts/dismiss-all", payload: { kind: "missed_charge" } })).json()).toEqual({ dismissed: 1 });
    expect((await t.call({ method: "POST", url: "/api/alerts/dismiss-all", payload: {} })).json()).toEqual({ dismissed: 1 });
    expect((await t.call({ method: "POST", url: "/api/alerts/dismiss-all", payload: {} })).json()).toEqual({ dismissed: 0 });
    expect((await t.call({ method: "GET", url: "/api/alerts" })).json().items).toEqual([]);
  });

  it("POST /recurring/detect queues one manual detect job and dedupes while it is queued", async () => {
    await db.delete(job);
    const first = await t.call({ method: "POST", url: "/api/recurring/detect" });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ created: true });
    const second = await t.call({ method: "POST", url: "/api/recurring/detect" });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ jobId: first.json().jobId, created: false });
    const rows = await jobsOfType(db, "recurring.detect");
    expect(rows.map((j) => [j.id, j.status, j.payload])).toEqual([[first.json().jobId, "queued", { reason: "manual" }]]);
  });

  it("manual transactions and CSV commits queue a ledger detect job, deduped", async () => {
    await db.delete(job);
    const a = await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: S.checking, date: "2026-10-12", amountCents: "-2500", payeeName: "Corner Store" } });
    expect(a.statusCode).toBe(200);
    await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: S.checking, date: "2026-10-13", amountCents: "-2600", payeeName: "Corner Store" } });
    let rows = await jobsOfType(db, "recurring.detect");
    expect(rows.map((j) => [j.status, j.payload])).toEqual([["queued", { reason: "ledger" }]]);

    await db.delete(job);
    const csvText = ["Date,Description,Amount", "2026-10-01,HULU,-17.99", "2026-10-05,NETFLIX.COM,-15.49"].join("\n");
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, accountId: S.card } });
    expect(preview.statusCode).toBe(200);
    const commit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { accountId: S.card, csvText, mapping: preview.json().mapping } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().created).toBe(2);
    rows = await jobsOfType(db, "recurring.detect");
    expect(rows.map((j) => [j.status, j.payload])).toEqual([["queued", { reason: "ledger" }]]);
  });

  it("DELETE /recurring/:id removes the item and nulls its links", async () => {
    const charge = await insertTx(db, { accountId: S.checking, payeeName: "Spotify", date: "2026-10-12", cents: -1199n, recurringId: ids.spotify! });
    const res = await t.call({ method: "DELETE", url: `/api/recurring/${ids.spotify}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await t.call({ method: "GET", url: `/api/recurring/${ids.spotify}` })).statusCode).toBe(404);
    expect((await t.call({ method: "DELETE", url: `/api/recurring/${ids.spotify}` })).statusCode).toBe(404);
    expect((await t.call({ method: "GET", url: `/api/transactions/${charge}` })).json().recurringId).toBeNull();
    expect(names((await list("?status=all")).items)).not.toContain("Spotify Duo");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /api/recurring/subscriptions", () => {
  let t: TestApp;
  let db: Db;
  let S: Seed;

  beforeAll(async () => {
    ({ t, db, S } = await freshApp());
    const common = { categoryId: S.subscriptions, accountId: S.checking };
    await insertItem(db, { ...common, payeeName: "Netflix", status: "active", cadence: "monthly", anchorDay: 5, expectedCents: -1549n, nextDueDate: "2026-11-05", source: "detected" });
    await insertItem(db, { ...common, payeeName: "Water Co", name: "Water", status: "active", cadence: "quarterly", anchorDay: 10, anchorMonth: 11, expectedCents: -4500n, nextDueDate: "2026-11-10" });
    await insertItem(db, { ...common, payeeName: "Adobe", status: "active", cadence: "yearly", anchorDay: 14, anchorMonth: 3, expectedCents: -11988n, nextDueDate: "2027-03-14" });
    await insertItem(db, { ...common, payeeName: "Gym", status: "paused", cadence: "monthly", anchorDay: 5, expectedCents: -4999n, nextDueDate: "2026-11-05", consecutiveMissed: 3 });
    await insertItem(db, { ...common, payeeName: "Allstate", status: "cancelled", cadence: "semiannual", anchorDay: 3, anchorMonth: 4, expectedCents: -61250n });
    await insertItem(db, { ...common, payeeName: "Acme Payroll", status: "active", cadence: "biweekly", anchorDate: "2026-10-02", expectedCents: 198765n, nextDueDate: "2026-10-16" });
    await insertItem(db, { ...common, payeeName: "Maybe", status: "suggested", cadence: "monthly", anchorDay: 1, expectedCents: -999n, nextDueDate: "2026-11-01" });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const subs = async (): Promise<SubscriptionsResponse> => {
    const res = await t.call({ method: "GET", url: "/api/recurring/subscriptions" });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("TC16: active outflows most expensive first, paused apart, totals from the exact yearly sum", async () => {
    const s = await subs();
    expect(s.items.map((i) => [i.name, i.cadence, i.expectedCents, i.yearlyCents, i.monthlyEquivalentCents])).toEqual([
      ["Netflix", "monthly", "-1549", "-18588", "-1549"],
      ["Water", "quarterly", "-4500", "-18000", "-1500"],
      ["Adobe", "yearly", "-11988", "-11988", "-999"],
    ]);
    expect(s.items[0]).toMatchObject({ payeeName: "Netflix", categoryName: "Subscriptions", nextDueDate: "2026-11-05", lastChargeDate: null, lastChargeCents: null, amountMode: "fixed", consecutiveMissed: 0, status: "active" });
    expect(s.pausedItems.map((i) => [i.name, i.consecutiveMissed, i.status])).toEqual([["Gym", 3, "paused"]]);
    // −18588 − 18000 − 11988 = −48576; / 12 = −4048 exactly.
    expect(s.totalYearlyCents).toBe("-48576");
    expect(s.totalMonthlyCents).toBe("-4048");
  });

  it("the monthly total is the yearly total / 12, not the sum of the rows' truncated monthly values", async () => {
    const common = { categoryId: S.subscriptions, accountId: S.checking };
    await insertItem(db, { ...common, payeeName: "Trash Co", name: "Trash", status: "active", cadence: "quarterly", anchorDay: 1, anchorMonth: 1, expectedCents: -8650n, nextDueDate: "2027-01-01" });
    await insertItem(db, { ...common, payeeName: "Cloud Co", name: "Cloud", status: "active", cadence: "yearly", anchorDay: 1, anchorMonth: 6, expectedCents: -1799n, nextDueDate: "2027-06-01" });
    const s = await subs();
    expect(s.items.map((i) => [i.name, i.yearlyCents, i.monthlyEquivalentCents])).toEqual([
      ["Trash", "-34600", "-2883"],
      ["Netflix", "-18588", "-1549"],
      ["Water", "-18000", "-1500"],
      ["Adobe", "-11988", "-999"],
      ["Cloud", "-1799", "-149"],
    ]);
    // Σ yearly = −84975 → / 12 = −7081 (truncated); the rows' monthly values sum to −7080.
    expect(s.totalYearlyCents).toBe("-84975");
    expect(s.totalMonthlyCents).toBe("-7081");
    expect(s.items.reduce((sum, i) => sum + BigInt(i.monthlyEquivalentCents), 0n)).toBe(-7080n);
  });
});
