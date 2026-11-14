import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, ingestTransactions, loadRules, transaction } from "@meridian/db";
import type { IsoDate } from "@meridian/shared";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

const mapping = { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount" } };
const twoIds = ["Date,Description,Amount,Reference,Transaction ID", "2026-10-03,TACO BELL 1234 CO,-12.40,REF-1,9001", "2026-10-04,SHELL OIL 57444 FORT COLLINS CO,-41.07,REF-2,9002"].join("\n");

/** Audit batch a10-conformance-ledger, second round, through the API. */
describe.skipIf(!TEST_DATABASE_URL)("Phase 1 conformance through the API, second round (audit a10-conformance-ledger)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ now: () => new Date("2026-11-14T18:00:00Z") });
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const newAccount = async (name: string, type: "checking" | "savings" = "checking") => {
    n++;
    return (await t.db.db.insert(account).values({ name: `${name} ${n}`, type, taxTreatment: "none" }).returning({ id: account.id }))[0]!.id;
  };
  const feed = async (accountId: string, id: string, date: IsoDate, amountCents: bigint, description: string) => {
    await ingestTransactions(t.db.db, [{ externalId: id, date, amountCents, description, pending: false }], { accountId, source: "simplefin", rules: await loadRules(t.db.db) });
    return (await t.db.db.select().from(transaction).where(eq(transaction.externalId, id)))[0]!;
  };
  const view = async (id: string) => (await t.call({ method: "GET", url: `/api/transactions/${id}` })).json() as { isTransfer: boolean; transferPairId: string | null };
  const createRule = async (payload: Record<string, unknown>) => {
    const res = await t.call({ method: "POST", url: "/api/rules", payload });
    expect(res.statusCode).toBe(200);
    return res.json() as { rule: { id: string }; applied: { examined: number; changed: number } };
  };

  it("a10-conformance-ledger-02: the same file committed with one id column and then with another is marked as duplicates and adds nothing", async () => {
    const savings = await newAccount("Savings", "savings");
    const first = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: twoIds, mapping: { ...mapping, externalId: { column: "Reference" } }, accountId: savings } });
    expect(first.json()).toMatchObject({ created: 2 });
    const other = { ...mapping, externalId: { column: "Transaction ID" } };
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText: twoIds, mapping: other, accountId: savings } });
    expect(preview.json()).toMatchObject({ totalRows: 2, duplicateCount: 2 });
    const second = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: twoIds, mapping: other, accountId: savings } });
    expect(second.json()).toMatchObject({ created: 0, duplicates: 2 });
    expect((await t.call({ method: "GET", url: `/api/transactions?accountId=${savings}` })).json().items).toHaveLength(2);
  });

  it("a10-conformance-ledger-03: a pair made by hand and a row marked a transfer by hand stay so when a 'not a transfer' rule is saved and when the rules run", async () => {
    const checking = await newAccount("Checking");
    const venmo = await newAccount("Venmo");
    const cashout = await feed(checking, "API-V1", "2026-10-20", 4000n, "VENMO CASHOUT");
    const toBank = await feed(venmo, "API-W1", "2026-10-20", -4000n, "TRANSFER TO BANK");
    const rent = await feed(checking, "API-V2", "2026-10-21", -20000n, "VENMO PAYMENT RENT SHARE");
    expect((await t.call({ method: "POST", url: `/api/transactions/${cashout.id}/pair`, payload: { otherId: toBank.id } })).statusCode).toBe(200);
    expect((await t.call({ method: "PATCH", url: `/api/transactions/${rent.id}`, payload: { isTransfer: true } })).statusCode).toBe(200);
    // Saving the rule runs it over uncategorized rows (the Rules page's default), as the paired rows are.
    const saved = await createRule({ name: "Venmo is not a transfer", conditions: { description: { op: "contains", value: "VENMO" } }, actions: { markTransfer: false }, applyTo: "uncategorized" });
    expect((await t.call({ method: "POST", url: "/api/rules/run", payload: { scope: "all" } })).statusCode).toBe(200);
    const pairId = (await view(cashout.id)).transferPairId;
    expect(pairId).not.toBeNull();
    expect(await view(toBank.id)).toMatchObject({ isTransfer: true, transferPairId: pairId });
    expect(await view(cashout.id)).toMatchObject({ isTransfer: true });
    expect(await view(rent.id)).toMatchObject({ isTransfer: true });
    expect((await t.call({ method: "DELETE", url: `/api/rules/${saved.rule.id}` })).statusCode).toBe(200);
  });

  it("a10-conformance-ledger-03: deleting a 'not a transfer' rule, or switching it off, lets the rows it ruled out pair", async () => {
    const checking = await newAccount("Checking");
    const savings = await newAccount("Savings", "savings");
    const brokerage = await newAccount("Cash management", "savings");
    const transfers = await createRule({ name: "Transfers are spending", conditions: { description: { op: "contains", value: "ONLINE TRANSFER" } }, actions: { markTransfer: false }, applyTo: "none" });
    const wires = await createRule({ name: "Wires are spending", conditions: { description: { op: "contains", value: "WIRE" } }, actions: { markTransfer: false }, applyTo: "none" });
    const out = await feed(checking, "API-S1", "2026-10-26", -25000n, "ONLINE TRANSFER TO SAVINGS");
    const into = await feed(savings, "API-S2", "2026-10-26", 25000n, "ONLINE TRANSFER FROM CHECKING");
    const wireOut = await feed(checking, "API-S3", "2026-10-27", -90000n, "WIRE TO CASH MGMT");
    const wireIn = await feed(brokerage, "API-S4", "2026-10-27", 90000n, "WIRE FROM CHECKING");
    expect(out).toMatchObject({ notTransfer: true, isTransfer: false });
    expect(wireOut).toMatchObject({ notTransfer: true, isTransfer: false });

    expect((await t.call({ method: "DELETE", url: `/api/rules/${transfers.rule.id}` })).statusCode).toBe(200);
    const pairId = (await view(out.id)).transferPairId;
    expect(pairId).not.toBeNull();
    expect(await view(into.id)).toMatchObject({ isTransfer: true, transferPairId: pairId });
    expect(await view(wireOut.id)).toMatchObject({ isTransfer: false, transferPairId: null });

    expect((await t.call({ method: "PATCH", url: `/api/rules/${wires.rule.id}`, payload: { enabled: false } })).statusCode).toBe(200);
    const wirePair = (await view(wireOut.id)).transferPairId;
    expect(wirePair).not.toBeNull();
    expect(await view(wireIn.id)).toMatchObject({ isTransfer: true, transferPairId: wirePair });
    expect((await t.call({ method: "DELETE", url: `/api/rules/${wires.rule.id}` })).statusCode).toBe(200);
  });

  it("a deleted mapping profile's import stays in the Import page's history, with its undo", async () => {
    const checking = await newAccount("Checking");
    const text = ["Date,Description,Amount", "2026-10-09,NETFLIX.COM,-15.49", "2026-10-10,KING SOOPERS,-45.32"].join("\n");
    const commit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: text, mapping, accountId: checking, saveProfile: { name: "Second Bank" } } });
    expect(commit.json()).toMatchObject({ created: 2 });
    const importLogId = commit.json().importLogId as string;
    const profile = ((await t.call({ method: "GET", url: "/api/connections" })).json() as Array<{ id: string; name: string; type: string }>).find((p) => p.type === "csv" && p.name === "Second Bank")!;
    const listed = async () => ((await t.call({ method: "GET", url: "/api/import/csv/history" })).json() as Array<{ id: string; profileName: string | null; canUndo: boolean; accountId: string | null }>).find((h) => h.id === importLogId);
    expect(await listed()).toMatchObject({ profileName: "Second Bank", canUndo: true, accountId: checking });
    expect((await t.call({ method: "DELETE", url: `/api/connections/${profile.id}` })).statusCode).toBe(200);
    expect(await listed()).toMatchObject({ profileName: null, canUndo: true, accountId: checking });
    expect((await t.call({ method: "POST", url: `/api/import/csv/${importLogId}/undo` })).json()).toEqual({ removed: 2, forgotten: 0 });
    expect(await listed()).toMatchObject({ canUndo: false });
  });
});
