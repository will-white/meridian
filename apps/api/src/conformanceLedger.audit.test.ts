import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, category, connection, importLog, transaction } from "@meridian/db";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

const mapping = { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount" } };
const withId = { ...mapping, externalId: { column: "Reference" } };
const csvText = ["Date,Description,Amount,Reference", "2026-10-03,TACO BELL 1234 CO,-12.40,REF-1", "2026-10-04,SHELL OIL 57444 FORT COLLINS CO,-41.07,REF-2"].join("\n");
const UNKNOWN = "00000000-0000-4000-8000-000000000a10";

/** Audit batch a10-conformance-ledger (Phase 1 conformance), through the API. */
describe.skipIf(!TEST_DATABASE_URL)("Phase 1 conformance through the API (audit a10-conformance-ledger)", () => {
  let t: TestApp;
  let savingsId: string;

  beforeAll(async () => {
    t = await createTestApp({ now: () => new Date("2026-11-14T18:00:00Z") });
    await signInOwner(t);
    const [a] = await t.db.db.insert(account).values({ name: "Savings", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
    savingsId = a!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const register = async (accountId: string) => (await t.call({ method: "GET", url: `/api/transactions?accountId=${accountId}` })).json().items as Array<{ id: string; date: string; amountCents: string }>;

  it("a10-conformance-ledger-02: the same file committed with its id column and then without it is marked as duplicates and adds nothing", async () => {
    const first = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText, mapping: withId, accountId: savingsId } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: 2 });
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, mapping, accountId: savingsId } });
    expect(preview.json()).toMatchObject({ totalRows: 2, duplicateCount: 2 });
    const second = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText, mapping, accountId: savingsId } });
    expect(second.json()).toMatchObject({ created: 0, duplicates: 2 });
    expect(await register(savingsId)).toHaveLength(2);
  });

  it("a10-conformance-ledger-04: removing a connection keeps its stored responses; deleting a CSV profile keeps its imports, and they can be undone", async () => {
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    await t.db.db.insert(importLog).values({ connectionId: conn!.id, kind: "simplefin.sync", status: "ok", rawPayload: { errors: [], errlist: [], accounts: [] } });
    expect((await t.call({ method: "DELETE", url: `/api/connections/${conn!.id}` })).statusCode).toBe(200);
    expect(await t.db.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync"))).toHaveLength(1);

    const [checking] = await t.db.db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const text = ["Date,Description,Amount", "2026-10-09,NETFLIX.COM,-15.49", "2026-10-10,KING SOOPERS,-45.32"].join("\n");
    const commit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: text, mapping, accountId: checking!.id, saveProfile: { name: "First Bank" } } });
    expect(commit.json()).toMatchObject({ created: 2 });
    const profiles = (await t.call({ method: "GET", url: "/api/connections" })).json() as Array<{ id: string; name: string; type: string }>;
    const profile = profiles.find((p) => p.type === "csv" && p.name === "First Bank")!;
    expect((await t.call({ method: "DELETE", url: `/api/connections/${profile.id}` })).statusCode).toBe(200);
    const undo = await t.call({ method: "POST", url: `/api/import/csv/${commit.json().importLogId}/undo` });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toEqual({ removed: 2, forgotten: 0 });
    expect(await register(checking!.id)).toHaveLength(0);
  });

  it("a10-conformance-ledger-07: POST /api/transactions refuses a zero amount, a date after today and an unknown account or category with 400/404, never 500", async () => {
    const body = { accountId: savingsId, date: "2026-11-14", amountCents: "-1234", payeeName: "Farmers market" };
    const post = (payload: Record<string, unknown>) => t.call({ method: "POST", url: "/api/transactions", payload });
    const zero = await post({ ...body, amountCents: "0" });
    expect([zero.statusCode, zero.json().code]).toEqual([400, "zero_amount"]);
    const future = await post({ ...body, date: "2027-06-01" });
    expect([future.statusCode, future.json().code]).toEqual([400, "future_date"]);
    const noAccount = await post({ ...body, accountId: UNKNOWN });
    expect([noAccount.statusCode, noAccount.json().code]).toEqual([404, "not_found"]);
    const noCategory = await post({ ...body, categoryId: UNKNOWN });
    expect([noCategory.statusCode, noCategory.json().code]).toEqual([400, "unknown_category"]);
    expect((await t.db.db.select().from(transaction).where(eq(transaction.source, "manual"))).length).toBe(0);
    // Today is accepted (the household's day on the API clock).
    const ok = await post(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ date: "2026-11-14", amountCents: "-1234" });
  });

  it("a10-conformance-ledger-07: PATCH /api/transactions/:id and PATCH /api/payees/:id answer 400 unknown_category for a category that does not exist", async () => {
    const [row] = await t.db.db.select({ id: transaction.id, payeeId: transaction.payeeId }).from(transaction).where(eq(transaction.source, "manual"));
    const patch = await t.call({ method: "PATCH", url: `/api/transactions/${row!.id}`, payload: { categoryId: UNKNOWN } });
    expect([patch.statusCode, patch.json().code]).toEqual([400, "unknown_category"]);
    const payeePatch = await t.call({ method: "PATCH", url: `/api/payees/${row!.payeeId}`, payload: { defaultCategoryId: UNKNOWN } });
    expect([payeePatch.statusCode, payeePatch.json().code]).toEqual([400, "unknown_category"]);
    // A category that exists still works.
    const [dining] = await t.db.db.insert(category).values({ name: "Dining (a10)", bucket: "spending", position: 80 }).returning({ id: category.id });
    expect((await t.call({ method: "PATCH", url: `/api/transactions/${row!.id}`, payload: { categoryId: dining!.id } })).statusCode).toBe(200);
    expect((await t.call({ method: "PATCH", url: `/api/payees/${row!.payeeId}`, payload: { defaultCategoryId: dining!.id } })).statusCode).toBe(200);
  });
});
