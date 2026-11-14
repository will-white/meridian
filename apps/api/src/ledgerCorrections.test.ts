import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { account, applyAccountSet, auditLog, connection, importLog, job, transaction } from "@meridian/db";
import { isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const sfAccount = (id: string, name: string, transactions: SfTxn[]): SfAccount => ({ org: { name: "Bank" }, id, name, currency: "USD", balance: "100.00", "balance-date": unix("2026-10-19"), transactions });
const mapping = { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount" } };

/** Audit batch a5-ingest-transfers, through the API: duplicates in the preview, and the corrections the register and Import page offer. */
describe.skipIf(!TEST_DATABASE_URL)("ledger corrections (audit a5-ingest-transfers)", () => {
  let t: TestApp;
  let connectionId: string;
  let checkingId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    connectionId = conn!.id;
    await applyAccountSet(t.db.db, {
      connectionId,
      windowStart: "2026-09-20",
      now: new Date("2026-10-19T18:00:00Z"),
      accountSet: {
        errors: [],
        errlist: [],
        accounts: [
          sfAccount("CHK", "Everyday Checking", [
            posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123 DENVER CO"),
            posted("T2", "2026-10-10", "-12.50", "SQ *BLUE BOTTLE COFFEE"),
            pending("P1", "2026-10-18", "-60.00", "TST* TAPHOUSE DENVER"),
            posted("PMT", "2026-10-02", "-500.00", "ONLINE PMT VISA CARD"),
          ]),
          sfAccount("CARD", "Sapphire Visa", [posted("C1", "2026-10-03", "500.00", "PAYMENT THANK YOU")]),
        ],
      },
    });
    checkingId = (await t.db.db.select({ id: account.id }).from(account).where(eq(account.externalId, "CHK")))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const csvText = ["Date,Description,Amount", "2026-10-06,KING SOOPERS 0123,-45.32", "2026-10-10,BLUE BOTTLE COFFEE,-12.50", "2026-10-12,NETFLIX.COM,-15.49", "2026-10-19,TAPHOUSE DENVER,-60.00"].join("\n");

  it("a5-ingest-transfers-01: the CSV preview marks the rows the sync already brought, and the commit adds only the rest", async () => {
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, mapping, accountId: checkingId } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().duplicateCount).toBe(3);
    expect(preview.json().rows.map((r: { description: string; duplicate: boolean }) => [r.description, r.duplicate])).toEqual([
      ["KING SOOPERS 0123", true],
      ["BLUE BOTTLE COFFEE", true],
      ["NETFLIX.COM", false],
      ["TAPHOUSE DENVER", true],
    ]);
    const commit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText, mapping, accountId: checkingId } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ created: 1, duplicates: 3, replacedPending: 0 });
    expect(typeof commit.json().importLogId).toBe("string");
    const list = await t.call({ method: "GET", url: `/api/transactions?accountId=${checkingId}` });
    expect(list.json().items).toHaveLength(5);

    // a5-ingest-transfers-09: the import is undone, then it can be committed again.
    const undo = await t.call({ method: "POST", url: `/api/import/csv/${commit.json().importLogId}/undo` });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toEqual({ removed: 1, forgotten: 3 });
    expect((await t.call({ method: "POST", url: `/api/import/csv/${commit.json().importLogId}/undo` })).statusCode).toBe(409);
    expect((await t.call({ method: "GET", url: `/api/transactions?accountId=${checkingId}` })).json().items).toHaveLength(4);
    expect((await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, mapping, accountId: checkingId } })).json().duplicateCount).toBe(3);
  });

  it("a5-ingest-transfers-09: DELETE /api/transactions/:id removes a row, audits it and releases its transfer partner", async () => {
    const rows = (await t.call({ method: "GET", url: "/api/transactions?transfers=only" })).json().items as Array<{ id: string; amountCents: string }>;
    expect(rows.map((r) => r.amountCents).sort()).toEqual(["-50000", "50000"]);
    const out = rows.find((r) => r.amountCents === "-50000")!;
    const del = await t.call({ method: "DELETE", url: `/api/transactions/${out.id}` });
    expect(del.statusCode).toBe(200);
    expect((await t.call({ method: "GET", url: `/api/transactions/${out.id}` })).statusCode).toBe(404);
    expect((await t.call({ method: "DELETE", url: `/api/transactions/${out.id}` })).statusCode).toBe(404);
    const card = rows.find((r) => r.amountCents === "50000")!;
    expect((await t.call({ method: "GET", url: `/api/transactions/${card.id}` })).json()).toMatchObject({ isTransfer: false, transferPairId: null });
    expect(await t.db.db.select().from(auditLog).where(eq(auditLog.entityId, out.id))).toHaveLength(1);
  });

  it("a5-ingest-transfers-12: a row is paired by hand with a candidate the API offers, and undo lasts", async () => {
    const [manual] = await t.db.db.insert(account).values({ name: "Wallet", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const created = await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: manual!.id, date: "2026-10-03", amountCents: "-50000", payeeName: "Card payment by hand" } });
    const card = (await t.db.db.select({ id: transaction.id }).from(transaction).where(eq(transaction.externalId, "C1")))[0]!;
    const candidates = await t.call({ method: "GET", url: `/api/transactions/${created.json().id}/transfer-candidates` });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().map((c: { id: string }) => c.id)).toEqual([card.id]);
    const paired = await t.call({ method: "POST", url: `/api/transactions/${created.json().id}/pair`, payload: { otherId: card.id } });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toMatchObject({ isTransfer: true });
    expect((await t.call({ method: "GET", url: `/api/transactions/${card.id}` })).json().transferPairId).toBe(paired.json().transferPairId);
    expect((await t.call({ method: "POST", url: `/api/transactions/${created.json().id}/pair`, payload: { otherId: card.id } })).statusCode).toBe(409);
    expect((await t.call({ method: "PATCH", url: `/api/transactions/${card.id}`, payload: { isTransfer: false } })).json().isTransfer).toBe(false);
  });

  it("a5-ingest-transfers-02: POST /api/accounts/:id/link-feed folds a feed account into an account without a connection", async () => {
    const [manual] = await t.db.db.insert(account).values({ name: "Credit Union", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
    await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: manual!.id, date: "2026-10-08", amountCents: "250000", payeeName: "ACH DEPOSIT ACME PAYROLL" } });
    await applyAccountSet(t.db.db, {
      connectionId,
      windowStart: "2026-10-01",
      now: new Date("2026-10-19T18:00:00Z"),
      accountSet: { errors: [], errlist: [], accounts: [sfAccount("CU", "Credit Union Savings", [posted("S1", "2026-10-08", "2500.00", "ACH DEPOSIT ACME PAYROLL")])] },
    });
    const feed = (await t.db.db.select({ id: account.id }).from(account).where(eq(account.externalId, "CU")))[0]!;
    expect((await t.call({ method: "POST", url: `/api/accounts/${feed.id}/link-feed`, payload: { feedAccountId: manual!.id } })).statusCode).toBe(409);
    const linked = await t.call({ method: "POST", url: `/api/accounts/${manual!.id}/link-feed`, payload: { feedAccountId: feed.id } });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ merged: 1, moved: 0, dropped: 0 });
    const accounts = (await t.call({ method: "GET", url: "/api/accounts" })).json() as Array<{ id: string; externalId: string | null }>;
    expect(accounts.find((a) => a.id === manual!.id)!.externalId).toBe("CU");
    expect(accounts.find((a) => a.id === feed.id)).toBeUndefined();
  });

  it("a5-ingest-transfers-02 (second round): GET /api/accounts says which accounts the Bridge no longer lists, and link-feed folds a re-issued one on the same connection", async () => {
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Credit Union" }).returning({ id: connection.id });
    let clock = Date.parse("2026-10-19T18:00:00Z");
    const stored = async (accounts: SfAccount[], windowStart: IsoDate) => {
      const accountSet: SimplefinAccountSet = { errors: [], errlist: [], accounts };
      clock += 60_000;
      const [log] = await t.db.db.insert(importLog).values({ connectionId: conn!.id, kind: "simplefin.sync", status: "ok", startedAt: new Date(clock), rawPayload: accountSet }).returning({ id: importLog.id });
      await applyAccountSet(t.db.db, { connectionId: conn!.id, importLogId: log!.id, accountSet, windowStart, now: new Date(clock) });
    };
    await stored([sfAccount("CU-OLD", "Share Savings", [posted("O1", "2026-10-05", "-10.00", "NETFLIX.COM")])], "2026-10-01");
    // The Bridge re-links the credit union: the same account under a new id.
    await stored([sfAccount("CU-NEW", "Share Savings", [posted("N1", "2026-10-05", "-10.00", "NETFLIX.COM")])], "2026-10-01");
    const accounts = (await t.call({ method: "GET", url: "/api/accounts" })).json() as Array<{ id: string; externalId: string | null; inFeed: boolean | null }>;
    const oldOne = accounts.find((a) => a.externalId === "CU-OLD")!;
    const newOne = accounts.find((a) => a.externalId === "CU-NEW")!;
    expect([oldOne.inFeed, newOne.inFeed]).toEqual([false, true]);
    // A connection with no stored response says nothing either way; an account without a connection has no feed.
    expect(accounts.find((a) => a.externalId === "CHK")!.inFeed).toBeNull();
    expect(accounts.find((a) => a.externalId === null)!.inFeed).toBeNull();

    expect((await t.call({ method: "POST", url: `/api/accounts/${newOne.id}/link-feed`, payload: { feedAccountId: oldOne.id } })).json()).toMatchObject({ code: "account_still_listed" });
    expect((await t.call({ method: "POST", url: `/api/accounts/${checkingId}/link-feed`, payload: { feedAccountId: newOne.id } })).json()).toMatchObject({ code: "account_connected" });
    const linked = await t.call({ method: "POST", url: `/api/accounts/${oldOne.id}/link-feed`, payload: { feedAccountId: newOne.id } });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ merged: 1, moved: 0 });
    const after = (await t.call({ method: "GET", url: "/api/accounts" })).json() as Array<{ id: string; externalId: string | null; inFeed: boolean | null }>;
    expect(after.find((a) => a.id === oldOne.id)).toMatchObject({ externalId: "CU-NEW", inFeed: true });
    expect(after.find((a) => a.id === newOne.id)).toBeUndefined();
    expect((await t.call({ method: "GET", url: `/api/transactions?accountId=${oldOne.id}` })).json().items.map((r: { amountCents: string }) => r.amountCents)).toEqual(["-1000"]);
  });

  it("a5-ingest-transfers (second round): GET /api/import/csv/history lists past bank imports with their account, and one is undone from the list", async () => {
    const [box] = await t.db.db.insert(account).values({ name: "Cash box", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const fileA = ["Date,Description,Amount", "2026-09-02,FARMERS MARKET,-23.00", "2026-09-03,BAKERY,-7.50"].join("\n");
    const fileB = ["Date,Description,Amount", "2026-09-10,HARDWARE STORE,-41.20"].join("\n");
    const a = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: fileA, mapping, accountId: box!.id } });
    const b = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { csvText: fileB, mapping, accountId: box!.id, saveProfile: { name: "Cash box export" } } });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    // An import recorded before imports named their account is found by its rows.
    await t.db.db.update(importLog).set({ rawPayload: { csvText: fileA, mapping } }).where(eq(importLog.id, a.json().importLogId));

    const history = await t.call({ method: "GET", url: "/api/import/csv/history" });
    expect(history.statusCode).toBe(200);
    const mine = (history.json() as Array<{ id: string }>).filter((h) => h.id === a.json().importLogId || h.id === b.json().importLogId);
    expect(mine).toMatchObject([
      { id: b.json().importLogId, accountId: box!.id, accountName: "Cash box", profileName: "Cash box export", created: 1, duplicates: 0, rowsHeld: 1, undoneAt: null, canUndo: true },
      { id: a.json().importLogId, accountId: box!.id, accountName: "Cash box", profileName: null, created: 2, duplicates: 0, rowsHeld: 2, undoneAt: null, canUndo: true },
    ]);
    // The earlier import, undone from the list after another one was made.
    expect((await t.call({ method: "POST", url: `/api/import/csv/${a.json().importLogId}/undo` })).json()).toEqual({ removed: 2, forgotten: 0 });
    const later = (await t.call({ method: "GET", url: "/api/import/csv/history" })).json() as Array<{ id: string; undoneAt: string | null; rowsHeld: number; canUndo: boolean }>;
    expect(later.find((h) => h.id === a.json().importLogId)).toMatchObject({ accountName: "Cash box", rowsHeld: 0, canUndo: false });
    expect(typeof later.find((h) => h.id === a.json().importLogId)!.undoneAt).toBe("string");
    expect(later.find((h) => h.id === b.json().importLogId)).toMatchObject({ rowsHeld: 1, canUndo: true });
    expect((await t.call({ method: "GET", url: `/api/transactions?accountId=${box!.id}` })).json().items.map((r: { amountCents: string }) => r.amountCents)).toEqual(["-4120"]);
  });

  it("a5-ingest-transfers-13: POST /api/connections/:id/reprocess-transactions queues the replay", async () => {
    const res = await t.call({ method: "POST", url: `/api/connections/${connectionId}/reprocess-transactions` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "simplefin.reprocess_transactions", status: "queued" });
    expect(await t.db.db.select().from(job).where(eq(job.type, "simplefin.reprocess_transactions"))).toHaveLength(1);
  });
});
