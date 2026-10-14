import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alert, recurring } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { CategoryDetailView, PlanCellView, PlanResponse, PlanRow } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Categories (rollover rules, delete guard, reorder), category groups, the payee
 * merge retrofit and the rules audit retrofit, on the grid-and-api seed.
 */

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

type CategoryRowView = Extract<PlanRow, { kind: "category" }>;

async function freshApp(): Promise<{ t: TestApp; S: PlanSeed }> {
  const t = await createTestApp({ now: serverClock });
  const S = await seedPlanFixture(t.db.db);
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  return { t, S };
}

async function getPlan(t: TestApp): Promise<PlanResponse> {
  const res = await t.call({ method: "GET", url: `/api/plan?today=${TODAY}` });
  expect(res.statusCode).toBe(200);
  return res.json() as PlanResponse;
}

function catRow(plan: PlanResponse, categoryId: string): CategoryRowView {
  const r = plan.rows.find((x): x is CategoryRowView => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}

function cellOf(plan: PlanResponse, categoryId: string, month: string): PlanCellView {
  const c = catRow(plan, categoryId).cells[plan.months.indexOf(month)];
  if (!c) throw new Error(`no cell ${categoryId} ${month}`);
  return c;
}

function rowCell(plan: PlanResponse, pick: (r: PlanRow) => boolean, month: string): PlanCellView {
  const c = plan.rows.find(pick)?.cells[plan.months.indexOf(month)];
  if (!c) throw new Error(`no row cell for ${month}`);
  return c;
}

const brief = (c: PlanCellView) => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents, c.source];
const totals = (c: PlanCellView) => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents];
const rowOrder = (plan: PlanResponse, bucket: string) =>
  plan.rows.filter((r) => r.bucket === bucket).map((r) => (r.kind === "bucket" ? `bucket:${r.bucket}` : r.kind === "group" ? `group:${r.name}` : r.name));

describe.skipIf(!TEST_DATABASE_URL)("categories, groups, payees and rules audit", () => {
  let t: TestApp;
  let S: PlanSeed;
  let C: PlanSeed["categories"];
  let transportId: string;

  beforeAll(async () => {
    ({ t, S } = await freshApp());
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const categories = async () => (await t.call({ method: "GET", url: "/api/categories" })).json() as CategoryDetailView[];
  const groups = async () => (await t.call({ method: "GET", url: "/api/category-groups" })).json() as Array<Record<string, unknown>>;
  const auditOf = async (query: string) => (await t.call({ method: "GET", url: `/api/audit?${query}` })).json().items as Array<Record<string, unknown>>;

  it("GET /api/categories returns the detail shape in display order", async () => {
    const list = await categories();
    expect(list.map((c) => c.name)).toEqual(["Paycheck", "Rent", "Car Insurance", "Netflix", "Internet", "Music", "Emergency Fund", "Groceries", "Dining", "Fuel", "Old Hobby", "Shopping"]);
    expect(list.find((c) => c.id === C.groceries)).toEqual({ id: C.groceries, name: "Groceries", bucket: "spending", hidden: false, groupId: S.groups.everyday, position: 1, rolloverMode: "all", rolloverFromMonth: "2026-09", goalId: null });
    expect(list.find((c) => c.id === C.emergencyFund)).toMatchObject({ groupId: null, position: 1, goalId: S.goals.emergencyFund });
    expect(list.find((c) => c.id === C.oldHobby)).toMatchObject({ hidden: true, position: 4 });
    expect(await groups()).toMatchObject([
      { name: "Paychecks", bucket: "income", position: 1, categoryCount: 1, hidden: false },
      { name: "Housing", bucket: "bills", position: 1, categoryCount: 2 },
      { name: "Subscriptions", bucket: "bills", position: 2, categoryCount: 3 },
      { name: "Everyday", bucket: "spending", position: 1, categoryCount: 4 },
    ]);
  });

  it("creates a category in a group (bucket must match), 409 on a duplicate name, deletes an unused one", async () => {
    const coffee = await t.call({ method: "POST", url: "/api/categories", payload: { name: "Coffee", bucket: "spending", groupId: S.groups.everyday } });
    expect(coffee.statusCode).toBe(200);
    expect(coffee.json()).toMatchObject({ name: "Coffee", bucket: "spending", groupId: S.groups.everyday, position: 5, goalId: null });
    expect((await auditOf(`entity=category&entityId=${coffee.json().id}`))[0]).toMatchObject({ action: "create", before: null, after: { name: "Coffee", position: 5 } });

    const mismatch = await t.call({ method: "POST", url: "/api/categories", payload: { name: "Taxes", bucket: "spending", groupId: S.groups.housing } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("bucket_mismatch");
    expect((await t.call({ method: "POST", url: "/api/categories", payload: { name: "Groceries", bucket: "spending" } })).statusCode).toBe(409);
    expect((await t.call({ method: "POST", url: "/api/categories", payload: { name: "Taxes", bucket: "spending", groupId: randomUUID() } })).statusCode).toBe(404);

    const deleted = await t.call({ method: "DELETE", url: `/api/categories/${coffee.json().id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect((await categories()).some((c) => c.name === "Coffee")).toBe(false);
    expect((await auditOf(`entity=category&entityId=${coffee.json().id}`)).map((e) => e.action)).toEqual(["delete", "create"]);
    expect((await t.call({ method: "DELETE", url: `/api/categories/${coffee.json().id}` })).statusCode).toBe(404);
  });

  it("rollover mode changes re-derive carries without moving LTS; income rejects rollover", async () => {
    const all = await t.call({ method: "PATCH", url: `/api/categories/${C.dining}`, payload: { rolloverMode: "all", rolloverFromMonth: "2026-09" } });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ id: C.dining, rolloverMode: "all", rolloverFromMonth: "2026-09" });
    const plan = await getPlan(t);
    const d = (m: string) => cellOf(plan, C.dining, m);
    expect(brief(d("2026-09"))).toEqual(["20000", "0", "26000", "-6000", "manual"]);
    expect(brief(d("2026-10"))).toEqual(["20000", "-6000", "20000", "-6000", "manual"]);
    expect(brief(d("2026-11"))).toEqual(["0", "-6000", "0", "-6000", "none"]);
    expect(brief(d("2026-12"))).toEqual(["0", "-6000", "0", "-6000", "none"]);
    expect(brief(d("2027-01"))).toEqual(["0", "-6000", "0", "-6000", "none"]);
    expect(d("2026-10").committedCents).toBe("20000");
    expect(d("2026-11").committedCents).toBe("0");
    expect(plan.summary.slice(1, 4).map((s) => s.leftToSpendCents)).toEqual(["176452", "175352", "210452"]);

    const income = await t.call({ method: "PATCH", url: `/api/categories/${C.paycheck}`, payload: { rolloverMode: "surplus" } });
    expect(income.statusCode).toBe(400);
    expect(income.json()).toMatchObject({ code: "income_no_rollover", error: "Income categories cannot roll over" });
    const early = await t.call({ method: "PATCH", url: `/api/categories/${C.dining}`, payload: { rolloverMode: "all", rolloverFromMonth: "2026-07" } });
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe("before_plan_start");

    const none = await t.call({ method: "PATCH", url: `/api/categories/${C.dining}`, payload: { rolloverMode: "none" } });
    expect(none.json()).toMatchObject({ rolloverMode: "none", rolloverFromMonth: null });
    const after = await getPlan(t);
    expect(cellOf(after, C.dining, "2026-10")).toMatchObject({ carriedInCents: "0", rolloverMode: "none" });
    expect(cellOf(after, C.dining, "2026-11")).toMatchObject({ carriedInCents: "0", remainingCents: "0" });
    expect(catRow(after, C.dining)).toMatchObject({ rolloverMode: "none", rolloverFromMonth: null });
    const history = await auditOf(`entity=category&entityId=${C.dining}`);
    expect(history[0]).toMatchObject({ action: "update", username: "owner", before: { rolloverMode: "all", rolloverFromMonth: "2026-09" }, after: { rolloverMode: "none", rolloverFromMonth: null } });
    expect(history[1]).toMatchObject({ action: "update", before: { rolloverMode: "surplus" }, after: { rolloverMode: "all" } });

    // Enabling a carrying mode without a start month starts the chain in the current month.
    const surplus = await t.call({ method: "PATCH", url: `/api/categories/${C.dining}`, payload: { rolloverMode: "surplus" } });
    expect(surplus.json()).toMatchObject({ rolloverMode: "surplus", rolloverFromMonth: "2026-10" });
    expect((await t.call({ method: "PATCH", url: `/api/categories/${C.dining}`, payload: {} })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: `/api/categories/${randomUUID()}`, payload: { name: "x" } })).statusCode).toBe(404);
  });

  it("moving a goal's category out of savings or into a group of another bucket is refused", async () => {
    const goal = await t.call({ method: "PATCH", url: `/api/categories/${C.emergencyFund}`, payload: { bucket: "spending" } });
    expect(goal.statusCode).toBe(400);
    expect(goal.json().code).toBe("goal_category");
    const group = await t.call({ method: "PATCH", url: `/api/categories/${C.fuel}`, payload: { groupId: S.groups.housing } });
    expect(group.statusCode).toBe(400);
    expect(group.json().code).toBe("bucket_mismatch");
    // A bucket move drops the old bucket's group and forces rollover off for income.
    const moved = await t.call({ method: "PATCH", url: `/api/categories/${C.music}`, payload: { bucket: "income", rolloverMode: "none" } });
    expect(moved.json()).toMatchObject({ bucket: "income", groupId: null, position: 1, rolloverMode: "none" });
    const back = await t.call({ method: "PATCH", url: `/api/categories/${C.music}`, payload: { bucket: "bills", groupId: S.groups.subscriptions } });
    expect(back.json()).toMatchObject({ bucket: "bills", groupId: S.groups.subscriptions, position: 3 });
  });

  it("group create, reorder across groups, bucket mismatch and delete rules", async () => {
    const created = await t.call({ method: "POST", url: "/api/category-groups", payload: { name: "Transport", bucket: "spending" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "Transport", bucket: "spending", position: 2, hidden: false, categoryCount: 0 });
    transportId = created.json().id;
    expect((await auditOf(`entity=category_group&entityId=${transportId}`))[0]).toMatchObject({ action: "create", after: { name: "Transport", bucket: "spending", position: 2 } });
    expect((await t.call({ method: "POST", url: "/api/category-groups", payload: { name: "Transport", bucket: "spending" } })).statusCode).toBe(409);

    const moved = await t.call({ method: "POST", url: "/api/categories/reorder", payload: { groupId: transportId, ids: [C.fuel] } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().find((c: CategoryDetailView) => c.id === C.fuel)).toMatchObject({ groupId: transportId, position: 1 });
    expect((await groups()).find((g) => g.id === transportId)).toMatchObject({ categoryCount: 1 });
    expect((await groups()).find((g) => g.id === S.groups.everyday)).toMatchObject({ categoryCount: 3 });

    const plan = await getPlan(t);
    expect(rowOrder(plan, "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Old Hobby", "group:Transport", "Fuel", "Shopping"]);
    const transportOct = rowCell(plan, (r) => r.kind === "group" && r.groupId === transportId, "2026-10");
    expect(totals(transportOct)).toEqual(["15000", "0", "5500", "9500"]);
    expect(transportOct.pendingCents).toBe("2500");

    const mismatch = await t.call({ method: "POST", url: "/api/categories/reorder", payload: { groupId: S.groups.housing, ids: [C.fuel] } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: "bucket_mismatch", error: "Category bucket does not match group" });
    expect((await t.call({ method: "POST", url: "/api/categories/reorder", payload: { groupId: randomUUID(), ids: [C.fuel] } })).statusCode).toBe(404);

    // Within Everyday: Dining first; Groceries and Old Hobby keep their relative order after it.
    const within = await t.call({ method: "POST", url: "/api/categories/reorder", payload: { groupId: S.groups.everyday, ids: [C.dining, randomUUID()] } });
    expect(within.json().filter((c: CategoryDetailView) => c.groupId === S.groups.everyday).map((c: CategoryDetailView) => [c.name, c.position])).toEqual([
      ["Dining", 1],
      ["Groceries", 2],
      ["Old Hobby", 3],
    ]);
    expect((await t.call({ method: "POST", url: "/api/categories/reorder", payload: { groupId: S.groups.everyday, ids: [C.groceries, C.dining] } })).statusCode).toBe(200);

    const inUse = await t.call({ method: "DELETE", url: `/api/categories/${C.groceries}` });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("in_use");
    expect((await t.call({ method: "DELETE", url: `/api/categories/${C.emergencyFund}` })).statusCode).toBe(409);
    expect((await t.call({ method: "DELETE", url: `/api/categories/${C.carInsurance}` })).statusCode).toBe(409); // a recurring item references it
    const gone = await t.call({ method: "DELETE", url: `/api/categories/${C.shopping}` });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ ok: true });
    const after = await getPlan(t);
    expect(after.rows.some((r) => r.kind === "category" && r.categoryId === C.shopping)).toBe(false);
    expect((await auditOf(`entity=category&entityId=${C.shopping}`))[0]).toMatchObject({ action: "delete", after: null, before: { name: "Shopping" } });
  });

  it("group rename, reorder and delete (categories become ungrouped)", async () => {
    expect((await t.call({ method: "PATCH", url: `/api/category-groups/${transportId}`, payload: { name: "Everyday" } })).statusCode).toBe(409);
    const renamed = await t.call({ method: "PATCH", url: `/api/category-groups/${transportId}`, payload: { name: "Cars", hidden: true } });
    expect(renamed.json()).toMatchObject({ name: "Cars", hidden: true, categoryCount: 1 });
    expect(catRow(await getPlan(t), C.fuel).hidden).toBe(true); // hidden through its group
    expect((await t.call({ method: "PATCH", url: `/api/category-groups/${transportId}`, payload: { hidden: false } })).json()).toMatchObject({ hidden: false });
    expect((await t.call({ method: "PATCH", url: `/api/category-groups/${randomUUID()}`, payload: { name: "x" } })).statusCode).toBe(404);

    const reordered = await t.call({ method: "POST", url: "/api/category-groups/reorder", payload: { bucket: "spending", ids: [transportId] } });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().filter((g: { bucket: string }) => g.bucket === "spending").map((g: { name: string; position: number }) => [g.name, g.position])).toEqual([
      ["Cars", 1],
      ["Everyday", 2],
    ]);
    expect(rowOrder(await getPlan(t), "spending")).toEqual(["bucket:spending", "group:Cars", "Fuel", "group:Everyday", "Groceries", "Dining", "Old Hobby"]);
    const mismatch = await t.call({ method: "POST", url: "/api/category-groups/reorder", payload: { bucket: "spending", ids: [S.groups.housing] } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("bucket_mismatch");

    const deleted = await t.call({ method: "DELETE", url: `/api/category-groups/${transportId}` });
    expect(deleted.json()).toEqual({ ok: true });
    expect((await categories()).find((c) => c.id === C.fuel)).toMatchObject({ groupId: null, position: 1, hidden: false });
    expect(rowOrder(await getPlan(t), "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Old Hobby", "Fuel"]);
    expect((await auditOf(`entity=category_group&entityId=${transportId}`)).map((e) => e.action)).toEqual(["delete", "update", "update", "update", "create"]);
    expect((await t.call({ method: "DELETE", url: `/api/category-groups/${transportId}` })).statusCode).toBe(404);
  });

  it("merging a payee re-points its recurring items and alerts before deleting it", async () => {
    const res = await t.call({ method: "PATCH", url: `/api/payees/${S.payees.internet}`, payload: { mergeFromId: S.payees.netflix } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: S.payees.internet, name: "Comcast" });
    expect(res.json().aliases).toContain("Netflix");
    const [item] = await t.db.db.select({ payeeId: recurring.payeeId }).from(recurring).where(eq(recurring.id, S.recurring.netflix));
    expect(item?.payeeId).toBe(S.payees.internet);
    const [priceAlert] = await t.db.db.select({ payeeId: alert.payeeId }).from(alert).where(eq(alert.id, S.alerts.netflixPrice));
    expect(priceAlert?.payeeId).toBe(S.payees.internet);
    expect((await t.call({ method: "GET", url: "/api/payees?q=Netflix" })).json()).toEqual([]);
    expect((await t.call({ method: "PATCH", url: `/api/payees/${S.payees.internet}`, payload: { mergeFromId: randomUUID() } })).statusCode).toBe(404);
  });

  it("rule create, update, reorder and delete write audit entries; an unchanged patch writes none", async () => {
    const make = (name: string) =>
      t.call({ method: "POST", url: "/api/rules", payload: { name, conditions: { description: { op: "contains", value: name } }, actions: { addTags: [name] }, applyTo: "none" } });
    const a = (await make("alpha")).json().rule;
    const b = (await make("beta")).json().rule;
    let items = await auditOf("entity=rule");
    expect(items.map((e) => [e.action, e.entityId])).toEqual([
      ["create", b.id],
      ["create", a.id],
    ]);
    expect(items[0]).toMatchObject({ before: null, after: { id: b.id, name: "beta", position: 2, enabled: true, actions: { addTags: ["beta"] } }, username: "owner" });

    expect((await t.call({ method: "PATCH", url: `/api/rules/${a.id}`, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await auditOf(`entity=rule&entityId=${a.id}`))[0]).toMatchObject({ action: "update", before: { enabled: true }, after: { enabled: false } });
    expect((await t.call({ method: "PATCH", url: `/api/rules/${a.id}`, payload: { enabled: false } })).statusCode).toBe(200);
    expect(await auditOf(`entity=rule&entityId=${a.id}`)).toHaveLength(2);

    const reordered = await t.call({ method: "POST", url: "/api/rules/reorder", payload: { ids: [b.id] } });
    expect(reordered.json().map((r: { id: string; position: number }) => [r.id, r.position])).toEqual([
      [b.id, 1],
      [a.id, 2],
    ]);
    items = await auditOf("entity=rule");
    const moves = items.filter((e) => e.action === "update" && (e.after as { position: number }).position !== (e.before as { position: number }).position);
    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((e) => e.batchId)).size).toBe(1);
    expect((await t.call({ method: "POST", url: "/api/rules/reorder", payload: { ids: [b.id] } })).statusCode).toBe(200);
    expect((await auditOf("entity=rule")).length).toBe(items.length);

    expect((await t.call({ method: "DELETE", url: `/api/rules/${b.id}` })).json()).toEqual({ ok: true });
    expect((await auditOf(`entity=rule&entityId=${b.id}`))[0]).toMatchObject({ action: "delete", after: null, before: { name: "beta", position: 1 } });
    expect((await t.call({ method: "DELETE", url: `/api/rules/${b.id}` })).statusCode).toBe(404);
    expect((await t.call({ method: "PATCH", url: `/api/rules/${b.id}`, payload: { name: "x" } })).statusCode).toBe(404);
  });
});
