import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { job, transaction } from "@meridian/db";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("Phase 1 routes", () => {
  let t: TestApp;
  let checkingId: string;
  let savingsId: string;
  let groceriesId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates manual accounts with a default tax treatment and a balance snapshot", async () => {
    const checking = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Cash", type: "checking", balanceCents: "100000" } });
    expect(checking.statusCode).toBe(200);
    expect(checking.json()).toMatchObject({ taxTreatment: "none", balanceCents: "100000", onBudget: true });
    checkingId = checking.json().id;
    const roth = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Roth IRA", type: "roth" } });
    expect(roth.json().taxTreatment).toBe("roth");
    const savings = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Savings", type: "savings" } });
    savingsId = savings.json().id;

    const patched = await t.call({ method: "PATCH", url: `/api/accounts/${roth.json().id}`, payload: { type: "401k", closed: true } });
    expect(patched.json()).toMatchObject({ type: "401k", taxTreatment: "pre_tax", closed: true });
  });

  it("creates and lists transactions, searches, and locks a hand-picked category", async () => {
    const categories = await t.call({ method: "GET", url: "/api/categories" });
    groceriesId = categories.json().find((c: { name: string }) => c.name === "Groceries").id;

    const created = await t.call({
      method: "POST",
      url: "/api/transactions",
      payload: { accountId: checkingId, date: "2026-09-10", amountCents: "-4532", payeeName: "King Soopers" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ amountCents: "-4532", payeeName: "King Soopers", categoryId: null, source: "manual" });
    await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: checkingId, date: "2026-09-11", amountCents: "-1250", payeeName: "Blue Bottle Coffee" } });

    const search = await t.call({ method: "GET", url: "/api/transactions?q=soopers" });
    expect(search.json().items.map((i: { payeeName: string }) => i.payeeName)).toEqual(["King Soopers"]);
    const all = await t.call({ method: "GET", url: "/api/transactions?limit=1" });
    expect(all.json().items).toHaveLength(1);
    expect(all.json().nextCursor).toBeTruthy();
    const page2 = await t.call({ method: "GET", url: `/api/transactions?limit=1&cursor=${encodeURIComponent(all.json().nextCursor)}` });
    expect(page2.json().items[0].id).not.toBe(all.json().items[0].id);
    expect(page2.json().nextCursor).toBeNull();

    const patched = await t.call({ method: "PATCH", url: `/api/transactions/${created.json().id}`, payload: { categoryId: groceriesId, tags: ["weekly"] } });
    expect(patched.json()).toMatchObject({ categoryId: groceriesId, categoryName: "Groceries", categoryLocked: true, tags: ["weekly"] });
    const uncategorized = await t.call({ method: "GET", url: "/api/transactions?uncategorized=true" });
    expect(uncategorized.json().items.map((i: { payeeName: string }) => i.payeeName)).toEqual(["Blue Bottle Coffee"]);
  });

  it("'always do this' creates a rule that applies to existing uncategorized rows and reports counts", async () => {
    const res = await t.call({
      method: "POST",
      url: "/api/rules",
      payload: {
        name: "Coffee",
        conditions: { payee: { op: "equals", value: "Blue Bottle Coffee" } },
        actions: { setCategoryId: groceriesId },
        applyTo: "uncategorized",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toEqual({ examined: 1, changed: 1 });
    expect(res.json().rule).toMatchObject({ position: 1, enabled: true });
    const list = await t.call({ method: "GET", url: "/api/transactions?q=blue" });
    expect(list.json().items[0]).toMatchObject({ categoryId: groceriesId, categoryLocked: false });

    const invalid = await t.call({ method: "POST", url: "/api/rules", payload: { conditions: {}, actions: { setCategoryId: groceriesId } } });
    expect(invalid.statusCode).toBe(400);

    const second = await t.call({
      method: "POST",
      url: "/api/rules",
      payload: { conditions: { description: { op: "contains", value: "x" } }, actions: { addTags: ["x"] }, applyTo: "none" },
    });
    const reordered = await t.call({ method: "POST", url: "/api/rules/reorder", payload: { ids: [second.json().rule.id] } });
    expect(reordered.json().map((r: { id: string; position: number }) => [r.id, r.position])).toEqual([
      [second.json().rule.id, 1],
      [res.json().rule.id, 2],
    ]);
    expect((await t.call({ method: "DELETE", url: `/api/rules/${second.json().rule.id}` })).statusCode).toBe(200);
    expect((await t.call({ method: "POST", url: "/api/rules/run", payload: { scope: "all" } })).json()).toMatchObject({ examined: 1 });
  });

  it("marks a transaction as not-a-transfer and pairs via CSV import", async () => {
    const csvText = ["Date,Description,Amount", "2026-09-15,TRANSFER TO SAVINGS,-500.00", "2026-09-15,TRANSFER TO SAVINGS,-500.00", "bad,row,x"].join("\n");
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, accountId: checkingId } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().mapping).toMatchObject({ date: { column: "Date", format: "YYYY-MM-DD" }, amount: { mode: "single", column: "Amount" } });
    expect(preview.json().totalRows).toBe(2);
    expect(preview.json().errors).toHaveLength(1);
    expect(preview.json().rows.every((r: { duplicate: boolean }) => !r.duplicate)).toBe(true);

    // The savings side, entered by hand two days later.
    await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: savingsId, date: "2026-09-17", amountCents: "50000", payeeName: "Transfer from checking" } });

    const commit = await t.call({
      method: "POST",
      url: "/api/import/csv/commit",
      payload: { accountId: checkingId, csvText, mapping: preview.json().mapping, saveProfile: { name: "Credit Union" } },
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ created: 2, transfersPaired: 1, errors: [{ rowIndex: 3 }] });

    const again = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, accountId: checkingId, mapping: preview.json().mapping } });
    expect(again.json().duplicateCount).toBe(2);
    const recommit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { accountId: checkingId, csvText, mapping: preview.json().mapping } });
    expect(recommit.json()).toMatchObject({ created: 0, transfersPaired: 0 });

    const profiles = await t.call({ method: "GET", url: "/api/connections" });
    expect(profiles.json().map((c: { type: string; name: string }) => [c.type, c.name])).toEqual([["csv", "Credit Union"]]);
    expect(profiles.json()[0].csvMapping).toMatchObject({ hasHeader: true });

    const transfers = await t.call({ method: "GET", url: "/api/transactions?transfers=only" });
    expect(transfers.json().items).toHaveLength(2);
    const leg = transfers.json().items[0];
    const unpaired = await t.call({ method: "PATCH", url: `/api/transactions/${leg.id}`, payload: { isTransfer: false } });
    expect(unpaired.json()).toMatchObject({ isTransfer: false, transferPairId: null });
    expect((await t.call({ method: "GET", url: "/api/transactions?transfers=only" })).json().items).toHaveLength(0);
  });

  it("adds a SimpleFIN connection by queueing a claim job for the worker, never storing the token in clear", async () => {
    const bad = await t.call({ method: "POST", url: "/api/connections/simplefin", payload: { name: "Bank", token: "not-base64-at-all!!" } });
    expect(bad.statusCode).toBe(400);
    const token = Buffer.from("https://bridge.example.test/simplefin/claim/abc").toString("base64");
    const res = await t.call({ method: "POST", url: "/api/connections/simplefin", payload: { name: "My Bank", token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "simplefin", status: "claiming", activeJob: { type: "simplefin.claim", status: "queued" } });
    const jobs = await t.db.db.select().from(job).where(eq(job.type, "simplefin.claim"));
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.payload)).not.toContain(token);
    const sync = await t.call({ method: "POST", url: `/api/connections/${res.json().id}/sync`, payload: {} });
    expect(sync.json()).toMatchObject({ type: "simplefin.claim" }); // still claiming: re-queues the claim, deduped
    const list = await t.call({ method: "GET", url: "/api/connections" });
    expect(list.json().find((c: { id: string }) => c.id === res.json().id).lastErrors).toEqual([]);
    const imports = await t.call({ method: "GET", url: `/api/connections/${res.json().id}/imports` });
    expect(imports.json()).toEqual([]);
    expect((await t.call({ method: "DELETE", url: `/api/connections/${res.json().id}` })).statusCode).toBe(200);
    expect(await t.db.db.select().from(transaction)).not.toHaveLength(0);
  });

  it("merges payees and keeps the alias", async () => {
    const payees = await t.call({ method: "GET", url: "/api/payees" });
    const names = payees.json().map((p: { name: string }) => p.name);
    expect(names).toContain("King Soopers");
    const king = payees.json().find((p: { name: string }) => p.name === "King Soopers");
    const coffee = payees.json().find((p: { name: string }) => p.name === "Blue Bottle Coffee");
    const merged = await t.call({ method: "PATCH", url: `/api/payees/${king.id}`, payload: { mergeFromId: coffee.id, defaultCategoryId: groceriesId } });
    expect(merged.json()).toMatchObject({ name: "King Soopers", aliases: ["Blue Bottle Coffee"], defaultCategoryId: groceriesId, transactionCount: 2 });
  });
});
