import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { account, category, connection, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { applyAccountSet } from "./sync.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];

const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transaction_date: unix(date), amount, description, pending: true });
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
