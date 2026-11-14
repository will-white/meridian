import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, price, security, user } from "../schema/index.js";
import { driverError } from "../services/driverError.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./db.js";

/**
 * What the database layer hands the app, pinned across drizzle-orm upgrades (0.38 to 0.45 here):
 * money columns (int8) are bigint, never a float, also past 2^53; share quantities and prices
 * (numeric(20,8)) are decimal strings exactly as Postgres prints them, never a float; and a
 * refused query still tells the app the SQLSTATE and the server's message (driverError).
 */

const PAST_2_53 = 9_007_199_254_740_993n; // 2^53 + 1: a float would round it to 2^53
const NUMERIC_MAX = "999999999999.99999999"; // numeric(20,8): 12 digits, 8 decimals

describe.skipIf(!TEST_DATABASE_URL)("column types through drizzle-orm and postgres-js", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("returns int8 money columns as bigint from the query builder, the relational query and raw SQL", async () => {
    const [row] = await t.db
      .insert(account)
      .values({ name: "Big", type: "checking", taxTreatment: "taxable", balanceCents: PAST_2_53, availableCents: -PAST_2_53 })
      .returning({ id: account.id, balanceCents: account.balanceCents, availableCents: account.availableCents });
    expect(row!.balanceCents).toBe(PAST_2_53);
    expect(row!.availableCents).toBe(-PAST_2_53);

    const [selected] = await t.db.select({ balanceCents: account.balanceCents }).from(account).where(eq(account.id, row!.id));
    expect(typeof selected!.balanceCents).toBe("bigint");
    expect(selected!.balanceCents).toBe(PAST_2_53);

    const found = await t.db.query.account.findFirst({ where: eq(account.id, row!.id) });
    expect(found!.balanceCents).toBe(PAST_2_53);

    const raw = await t.db.execute<{ cents: unknown; total: unknown }>(sql`select ${account.balanceCents} as cents, sum(${account.balanceCents}) as total from ${account} where ${account.id} = ${row!.id} group by 1`);
    expect(raw[0]!.cents).toBe(PAST_2_53);
    // sum(int8) is numeric in Postgres: a string, as every numeric is.
    expect(raw[0]!.total).toBe(PAST_2_53.toString());
  });

  it("returns numeric(20,8) as the decimal string Postgres prints, scale and sign included", async () => {
    const [sec] = await t.db.insert(security).values({ ticker: "TYPES", name: "Types fund", type: "etf", priceMode: "manual" }).returning({ id: security.id });
    await t.db.insert(price).values([
      { securityId: sec!.id, date: "2026-10-01", close: NUMERIC_MAX, source: "manual" },
      { securityId: sec!.id, date: "2026-10-02", close: "1.5", source: "manual" },
      { securityId: sec!.id, date: "2026-10-03", close: "0.00000001", source: "manual" },
    ]);
    const rows = await t.db.select({ date: price.date, close: price.close }).from(price).where(eq(price.securityId, sec!.id)).orderBy(price.date);
    expect(rows).toEqual([
      { date: "2026-10-01", close: NUMERIC_MAX },
      { date: "2026-10-02", close: "1.50000000" },
      { date: "2026-10-03", close: "0.00000001" },
    ]);
    for (const r of rows) expect(typeof r.close).toBe("string");

    const raw = await t.db.execute<{ close: unknown; product: unknown }>(sql`select ${price.close} as close, ${price.close} * 3 as product from ${price} where ${price.securityId} = ${sec!.id} and ${price.date} = '2026-10-02'`);
    expect(raw[0]).toEqual({ close: "1.50000000", product: "4.50000000" });
  });

  it("wraps a refused query in DrizzleQueryError, and driverError gives back Postgres's error with its SQLSTATE", async () => {
    await t.db.insert(user).values({ username: "types-owner", passwordHash: "$argon2id$secret-hash", role: "owner" });
    const error = await t.db
      .insert(user)
      .values({ username: "types-owner", passwordHash: "$argon2id$another-secret-hash", role: "viewer" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(DrizzleQueryError);
    // The wrapper's message is the SQL and its parameters, here a password hash: never show or log it.
    expect((error as Error).message).toContain("another-secret-hash");
    const cause = driverError(error) as { name: string; code: string; message: string };
    expect(cause.name).toBe("PostgresError");
    expect(cause.code).toBe("23505");
    expect(cause.message).toMatch(/^duplicate key value violates unique constraint/);
    expect(cause.message).not.toContain("secret-hash");

    // Anything that is not a wrapped query error passes through unchanged.
    const plain = new Error("plain");
    expect(driverError(plain)).toBe(plain);
    expect(driverError("text")).toBe("text");
    expect(driverError(null)).toBe(null);
  });
});
