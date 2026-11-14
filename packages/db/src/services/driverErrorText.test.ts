import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDateToUtcMs, type SimplefinAccountSet } from "@meridian/shared";
import { account, connection, holdingSnapshot } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { applyAccountSet } from "./sync.js";

/**
 * Decision 120: drizzle-orm 0.44 and later throw a failed query as a `DrizzleQueryError` whose
 * message is the SQL text and its parameters. A sync whose holdings cannot be written reports
 * the database's own message for the account on the Connections page, as before the upgrade.
 * A test trigger refuses the snapshot as a constraint would, with a message of its own.
 */
const REFUSAL = "probe: the row was refused by a test trigger";
const BRK = "ACT-BRK-001";

describe.skipIf(!TEST_DATABASE_URL)("a failed query's text in what a sync reports (decision 120)", () => {
  let t: TestDb;
  let connectionId: string;
  let accountId: string;
  beforeAll(async () => {
    t = await createTestDb();
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Brokerage", status: "ok" }).returning({ id: connection.id });
    connectionId = conn!.id;
    const [acct] = await t.db.insert(account).values({ connectionId, externalId: BRK, name: "Example Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    accountId = acct!.id;
    await t.db.execute(sql.raw(`create function probe_refuse() returns trigger language plpgsql as $$ begin raise exception '${REFUSAL}' using errcode = 'check_violation'; end $$`));
    await t.db.execute(sql.raw(`create trigger probe_refuse before insert on "holding_snapshot" for each row execute function probe_refuse()`));
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("holdings that cannot be written are reported with the database's message, not the SQL and its parameters", async () => {
    const accountSet: SimplefinAccountSet = {
      errors: [],
      errlist: [],
      accounts: [
        {
          org: { domain: "brokerage.example.test", name: "Example Brokerage Services" },
          id: BRK,
          name: "Example Brokerage",
          currency: "USD",
          balance: "3094.40",
          "balance-date": Math.floor(isoDateToUtcMs("2026-10-13") / 1000) + 18 * 3600,
          transactions: [],
          extra: { holdings: [{ symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: "12.345", price: "250.66", market_value: "3094.40" }] },
        },
      ],
    };
    const result = await applyAccountSet(t.db, { connectionId, accountSet, windowStart: "2026-10-06", now: new Date("2026-10-14T12:00:00Z") });
    expect(result.errors).toContainEqual({ code: "holdings.parse_error", message: `Example Brokerage: ${REFUSAL}`, accountId: BRK });
    // The rest of the sync went on: the balance is recorded, no snapshot is.
    expect(await t.db.select().from(holdingSnapshot).where(eq(holdingSnapshot.accountId, accountId))).toEqual([]);
    const [acct] = await t.db.select({ balanceCents: account.balanceCents }).from(account).where(eq(account.id, accountId));
    expect(acct!.balanceCents).toBe(309440n);
  });
});
