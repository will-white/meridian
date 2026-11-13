import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { account, balanceSnapshot, category, connection, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { applyAccountSet } from "./sync.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];

const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });

/**
 * A response that arrives with HTTP 200 and an `errlist` entry is not the whole truth about
 * the accounts the entry covers: the Bridge sends what it last knew, which may be nothing.
 * Applying it must not read "not in the list" as "gone".
 */
describe.skipIf(!TEST_DATABASE_URL)("applyAccountSet on a response the Bridge marked incomplete", () => {
  let t: TestDb;
  let connectionId: string;
  const NOW = new Date("2026-09-12T12:00:00Z");
  const WINDOW: IsoDate = "2026-09-04";

  const acct = (id: string, name: string, transactions: SfTxn[], extra: Record<string, unknown> = {}): SfAccount => ({
    org: { name: "Bank" },
    id,
    name,
    currency: "USD",
    balance: "100.00",
    "balance-date": unix("2026-09-12", 6),
    transactions,
    ...extra,
  });
  const set = (accounts: SfAccount[], errlist: SimplefinAccountSet["errlist"] = []): SimplefinAccountSet => ({ errors: [], errlist, accounts });
  const apply = (accountSet: SimplefinAccountSet) => applyAccountSet(t.db, { connectionId, accountSet, windowStart: WINDOW, now: NOW });
  const rows = () =>
    t.db
      .select({ ext: transaction.externalId, pending: transaction.pending, categoryId: transaction.categoryId, notes: transaction.notes, account: account.externalId })
      .from(transaction)
      .innerJoin(account, eq(account.id, transaction.accountId))
      .orderBy(asc(account.externalId), asc(transaction.externalId));

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.delete(transaction);
    await t.db.delete(account);
    await t.db.delete(connection);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    connectionId = conn!.id;
  });

  it("keeps the pending rows, and the edits on them, of an account the Bridge could not read", async () => {
    // Two pending card purchases and one pending checking hold, all seen on a healthy sync.
    const healthy = await apply(
      set([
        acct("CARD", "Sapphire Visa", [pending("P1", "2026-09-10", "-20.00", "KING SOOPERS #0123"), pending("P2", "2026-09-11", "-8.50", "SQ *BLUE BOTTLE COFFEE")]),
        acct("CHK", "Everyday Checking", [pending("H1", "2026-09-11", "-45.00", "HOTEL HOLD")]),
      ]),
    );
    expect(healthy).toMatchObject({ incomplete: false, stats: { created: 3, removedPending: 0 } });
    const [groceries] = await t.db.insert(category).values({ name: "Groceries (test)", bucket: "spending", position: 99 }).returning({ id: category.id });
    await t.db.update(transaction).set({ categoryId: groceries!.id, categoryLocked: true, notes: "weekly shop" }).where(eq(transaction.externalId, "P1"));

    // Next sync: the Bridge could not read the card (empty list, act.failed). Checking is fine and its hold has dropped off.
    const failed = await apply(set([acct("CARD", "Sapphire Visa", []), acct("CHK", "Everyday Checking", [])], [{ code: "act.failed", msg: "could not refresh", account_id: "CARD" }]));
    expect(failed.incomplete).toBe(true);
    // Only the checking hold is gone: 1, not 3.
    expect(failed.stats.removedPending).toBe(1);
    expect(await rows()).toEqual([
      { ext: "P1", pending: true, categoryId: groceries!.id, notes: "weekly shop", account: "CARD" },
      { ext: "P2", pending: true, categoryId: null, notes: null, account: "CARD" },
    ]);
  });

  it("keeps them for incomplete data too, and still posts a pending row in place when its posted item arrives", async () => {
    await apply(set([acct("CARD", "Sapphire Visa", [pending("P1", "2026-09-10", "-20.00", "KING SOOPERS #0123"), pending("P2", "2026-09-11", "-8.50", "SQ *BLUE BOTTLE COFFEE")])]));
    const [before] = await t.db.select({ id: transaction.id }).from(transaction).where(eq(transaction.externalId, "P1"));

    // Partial data: P1 posted under a new id, P2 is not in the list at all.
    const partial = await apply(set([acct("CARD", "Sapphire Visa", [posted("T1", "2026-09-11", "-20.00", "KING SOOPERS #0123 DENVER CO")])], [{ code: "act.missingdata", account_id: "CARD" }]));
    expect(partial.stats).toMatchObject({ created: 0, replacedPending: 1, removedPending: 0 });
    expect((await rows()).map((r) => [r.ext, r.pending])).toEqual([
      ["P2", true],
      ["T1", false],
    ]);
    const [after] = await t.db.select({ id: transaction.id }).from(transaction).where(eq(transaction.externalId, "T1"));
    expect(after!.id).toBe(before!.id);
  });

  it("a bank that needs re-authentication covers its own accounts, or every account when the Bridge does not say which", async () => {
    const seed = () =>
      apply(
        set([
          acct("CARD", "Sapphire Visa", [pending("P1", "2026-09-10", "-20.00", "KING SOOPERS #0123")], { conn_id: "CON-CARD" }),
          acct("CHK", "Everyday Checking", [pending("H1", "2026-09-11", "-45.00", "HOTEL HOLD")], { conn_id: "CON-BANK" }),
        ]),
      );
    const empty = (errlist: SimplefinAccountSet["errlist"]) =>
      apply(set([acct("CARD", "Sapphire Visa", [], { conn_id: "CON-CARD" }), acct("CHK", "Everyday Checking", [], { conn_id: "CON-BANK" })], errlist));

    // Named: the card's bank is broken, checking is not, so the checking hold really did drop off.
    await seed();
    const named = await empty([{ code: "con.auth", msg: "re-login", conn_id: "CON-CARD" }]);
    expect(named.stats.removedPending).toBe(1);
    expect((await rows()).map((r) => r.ext)).toEqual(["P1"]);

    // Not named: nothing in the response can be trusted to be complete.
    await t.db.delete(transaction);
    await seed();
    const unnamed = await empty([{ code: "con.auth", msg: "re-login" }]);
    expect(unnamed).toMatchObject({ incomplete: true, stats: { removedPending: 0 } });
    expect((await rows()).map((r) => r.ext)).toEqual(["P1", "H1"]);
  });

  it("reports how fresh each open account's data is, leaving out accounts the household closed", async () => {
    const stale = { "balance-date": unix("2026-08-30", 6) };
    await apply(set([acct("CARD", "Sapphire Visa", []), acct("OLD", "Old Savings", [], stale)]));
    await t.db.update(account).set({ closed: true }).where(eq(account.externalId, "OLD"));
    const first = await apply(set([acct("CARD", "Sapphire Visa", []), acct("CHK", "Everyday Checking", [], { "balance-date": unix("2026-09-01", 6) }), acct("OLD", "Old Savings", [], stale)]));
    expect(first.incomplete).toBe(false);
    expect([...first.balanceDates].sort()).toEqual(["2026-09-01", "2026-09-12"]);
  });
});

/**
 * Audit batch a4-sync-parse: what one odd value in a response does. The protocol's numeric
 * strings may carry a sign, an exponent or more than two decimals; a value that still cannot
 * be read costs that transaction or that balance, never the account or the sync.
 */
describe.skipIf(!TEST_DATABASE_URL)("applyAccountSet on odd values from the feed (a4-sync-parse)", () => {
  let t: TestDb;
  let connectionId: string;
  // 01:00 UTC on Nov 1 is 19:00 on Oct 31 in the household's zone (America/Denver, the default).
  const NOW = new Date("2026-11-01T01:00:00Z");
  const WINDOW: IsoDate = "2026-10-20";
  const acct = (id: string, name: string, transactions: SfTxn[], extra: Record<string, unknown> = {}): SfAccount => ({
    org: { name: "Bank" },
    id,
    name,
    currency: "USD",
    balance: "100.00",
    "balance-date": unix("2026-10-31", 6),
    transactions,
    ...extra,
  });
  const set = (accounts: SfAccount[], errlist: SimplefinAccountSet["errlist"] = [], errors: string[] = []): SimplefinAccountSet => ({ errors, errlist, accounts });
  const apply = (accountSet: SimplefinAccountSet, options: Partial<Parameters<typeof applyAccountSet>[1]> = {}) =>
    applyAccountSet(t.db, { connectionId, accountSet, windowStart: WINDOW, now: NOW, ...options });
  const byExt = async () =>
    Object.fromEntries((await t.db.select({ ext: transaction.externalId, cents: transaction.amountCents, date: transaction.date, pending: transaction.pending }).from(transaction)).map((r) => [r.ext, r]));
  const accountRow = async (ext: string) => (await t.db.select().from(account).where(eq(account.externalId, ext)))[0]!;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.delete(transaction);
    await t.db.delete(account);
    await t.db.delete(connection);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    connectionId = conn!.id;
  });

  it("a4-sync-parse-01: reads a sign, an exponent and extra decimals, and skips only a transaction whose amount it cannot read", async () => {
    const result = await apply(
      set([
        acct("CHK", "Everyday Checking", [posted("C1", "2026-10-30", "+5.00", "REFUND"), posted("C2", "2026-10-30", "1E+2", "DEPOSIT"), posted("C3", "2026-10-30", "-0.5e1", "FEE")]),
        acct("CARD", "Sapphire Visa", [posted("K1", "2026-10-30", "-12.345", "KING SOOPERS"), posted("K2", "2026-10-30", "-1.2.3", "JUNK"), posted("K3", "2026-10-30", "-20.00", "TARGET")]),
        acct("SAV", "Savings", [posted("S1", "2026-10-30", "-100.00", "TRANSFER TO CHECKING")]),
      ]),
    );
    const rows = await byExt();
    // Hand-calculated: +5.00 → 500; 1E+2 = 100 → 10000; -0.5e1 = -5 → -500; -12.345 → -1234.5 cents → -1235.
    expect([rows["C1"]?.cents, rows["C2"]?.cents, rows["C3"]?.cents, rows["K1"]?.cents, rows["K3"]?.cents, rows["S1"]?.cents]).toEqual([500n, 10000n, -500n, -1235n, -2000n, -10000n]);
    expect(rows["K2"]).toBeUndefined();
    expect(result.stats.created).toBe(6);
    // The account after the odd one was applied, and pairing ran: savings -100.00 and checking +100.00 on the same day.
    expect(result.transfersPaired).toBe(1);
    expect(result.incomplete).toBe(false);
    expect(result.errors).toEqual([
      { code: "amount.unreadable", message: "Sapphire Visa: 1 transaction was skipped because its amount could not be read", accountId: "CARD" },
      { code: "amount.rounded", message: "Sapphire Visa: 1 amount had digits below a cent and was rounded to the cent", accountId: "CARD" },
    ]);
  });

  it("a4-sync-parse-01: rounds a balance with digits below a cent, and keeps the last known balance when one cannot be read", async () => {
    const first = await apply(set([acct("CHK", "Everyday Checking", [], { balance: "1234.567", "available-balance": "1200.004" })]));
    // 1234.567 → 123456.7 cents → 123457; 1200.004 → 120000.4 → 120000
    expect(await accountRow("CHK")).toMatchObject({ balanceCents: 123457n, availableCents: 120000n });
    expect(first.errors).toEqual([{ code: "amount.rounded", message: "Everyday Checking: 2 amounts had digits below a cent and were rounded to the cent", accountId: "CHK" }]);

    const second = await apply(set([acct("CHK", "Everyday Checking", [posted("C9", "2026-10-31", "-1.00", "COFFEE")], { balance: "n/a", "balance-date": unix("2026-11-01", 6) })]));
    expect(await accountRow("CHK")).toMatchObject({ balanceCents: 123457n, availableCents: 120000n, balanceDate: "2026-10-31" });
    expect((await byExt())["C9"]?.cents).toBe(-100n);
    expect(await t.db.select({ date: balanceSnapshot.date }).from(balanceSnapshot)).toEqual([{ date: "2026-10-31" }]);
    expect(second.errors).toEqual([{ code: "balance.unreadable", message: "Everyday Checking: the balance from the Bridge could not be read, so it was not changed", accountId: "CHK" }]);

    // A new account whose balance cannot be read is created without one.
    await apply(set([acct("NEW", "New Card", [], { balance: "" })]));
    expect(await accountRow("NEW")).toMatchObject({ balanceCents: null, availableCents: null });
  });

  it("a4-sync-parse-04, a4-sync-parse-08: dates by transacted_at, then posted, then the household's day", async () => {
    await apply(
      set([
        acct("CARD", "Sapphire Visa", [
          { id: "Q1", posted: unix("2026-10-31"), transacted_at: unix("2026-10-28"), amount: "-30.00", description: "LATE POSTING", pending: false },
          { id: "P1", posted: 0, transacted_at: unix("2026-10-29"), amount: "-12.00", description: "PENDING WITH TIME", pending: true },
          { id: "P2", posted: 0, amount: "-7.00", description: "PENDING WITHOUT TIME", pending: true },
        ]),
      ]),
    );
    const rows = await byExt();
    expect([rows["Q1"]?.date, rows["P1"]?.date, rows["P2"]?.date]).toEqual(["2026-10-28", "2026-10-29", "2026-10-31"]);
  });

  it("a4-sync-parse-09, a4-sync-parse-10: ingests nothing into an account the household closed, and its problems hold nothing back", async () => {
    await apply(set([acct("CHK", "Everyday Checking", []), acct("OLD", "Old Card", [posted("O1", "2026-10-25", "-1.00", "OLD")])]));
    await t.db.update(account).set({ closed: true }).where(eq(account.externalId, "OLD"));
    const result = await apply(
      set([acct("CHK", "Everyday Checking", [posted("C1", "2026-10-30", "-2.00", "NEW")]), acct("OLD", "Old Card", [posted("O1", "2026-10-25", "-1.00", "OLD"), posted("K9", "2026-10-30", "-9.00", "AFTER CLOSING")])], [
        { code: "act.failed", msg: "could not refresh", account_id: "OLD" },
      ]),
    );
    expect(Object.keys(await byExt()).sort()).toEqual(["C1", "O1"]);
    expect(result.incomplete).toBe(false);
    // The same problem on an open account still holds the mark.
    expect((await apply(set([acct("CHK", "Everyday Checking", [])], [{ code: "act.failed", account_id: "CHK" }]))).incomplete).toBe(true);
  });

  it("a4-sync-parse-03: an account the reader skipped holds the mark unless it is closed, and a partly read account keeps its pending rows", async () => {
    await apply(set([acct("CHK", "Everyday Checking", [pending("H1", "2026-10-30", "-45.00", "HOTEL HOLD")]), acct("OLD", "Old Card", [])]));
    await t.db.update(account).set({ closed: true }).where(eq(account.externalId, "OLD"));
    const skippedOpen = await apply(set([acct("OLD", "Old Card", [])]), { readProblems: [{ code: "account.unreadable", message: "Everyday Checking: the account could not be read and was skipped (balance-date: Required)", accountId: "CHK" }] });
    expect(skippedOpen.incomplete).toBe(true);
    expect(skippedOpen.errors).toEqual([{ code: "account.unreadable", message: "Everyday Checking: the account could not be read and was skipped (balance-date: Required)", accountId: "CHK" }]);
    const skippedClosed = await apply(set([acct("CHK", "Everyday Checking", [pending("H1", "2026-10-30", "-45.00", "HOTEL HOLD")])]), { readProblems: [{ code: "account.unreadable", message: "x", accountId: "OLD" }] });
    expect(skippedClosed.incomplete).toBe(false);
    // The hold is not in this response, but one of the account's transactions could not be read: it may be that one.
    const partial = await apply(set([acct("CHK", "Everyday Checking", [])]), { readProblems: [{ code: "transaction.unreadable", message: "Everyday Checking: 1 transaction could not be read and was skipped (posted: Required)", accountId: "CHK" }] });
    expect(partial.stats.removedPending).toBe(0);
    expect(Object.keys(await byExt())).toEqual(["H1"]);
  });

  it("a4-sync-parse-12: a plain error string that repeats an errlist entry is shown once", async () => {
    const result = await apply(
      set([acct("CHK", "Everyday Checking", [])], [{ code: "con.auth", msg: "Please re-login" }, { code: "act.failed", msg: "Could not read account Visa", account_id: "VISA" }], ["Please re-login", "Could not read account Visa", "Scheduled maintenance tonight"]),
    );
    expect(result.errors).toEqual([
      { code: "con.auth", message: "The bank connection needs to be re-authenticated at the SimpleFIN Bridge. (Please re-login)" },
      { code: "act.failed", message: "The Bridge could not read this account. It will retry on the next sync. (Could not read account Visa)", accountId: "VISA" },
      { code: "error", message: "Scheduled maintenance tonight" },
    ]);
  });
});
