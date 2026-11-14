import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connection, type ConnectionError } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { dismissSyncGap, lastErrorsKeepingSyncGaps } from "./syncGaps.js";

/**
 * Audit a3-sync-core, second round: a sync.gap notice names days the feed was never asked for
 * again, a hole that no later sync fills. It stays on the connection, whatever later syncs
 * report, until the household dismisses it.
 */
describe.skipIf(!TEST_DATABASE_URL)("sync.gap notices on the connection (a3-sync-core, second round)", () => {
  let t: TestDb;
  const gap = (from: string, to: string): ConnectionError => ({ code: "sync.gap", message: `Transactions dated ${from} to ${to} may be missing.`, from, to });
  const auth: ConnectionError = { code: "con.auth", message: "The bank connection needs to be re-authenticated at the SimpleFIN Bridge." };
  const insert = async (lastErrors: ConnectionError[]) =>
    (await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "ok", lastErrors }).returning({ id: connection.id }))[0]!.id;
  const errorsOf = async (id: string) => (await t.db.select({ lastErrors: connection.lastErrors }).from(connection).where(eq(connection.id, id)))[0]!.lastErrors;
  const write = async (id: string, entries: ConnectionError[]) => t.db.update(connection).set({ lastErrors: lastErrorsKeepingSyncGaps(entries) }).where(eq(connection.id, id));

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("keeps the notices the connection carries, in front of what the new response reports", async () => {
    const id = await insert([auth, gap("2026-01-10", "2026-02-20"), gap("2026-05-25", "2026-07-18")]);
    await write(id, [{ code: "act.failed", message: "The Bridge could not read this account.", accountId: "CHK" }]);
    expect(await errorsOf(id)).toEqual([gap("2026-01-10", "2026-02-20"), gap("2026-05-25", "2026-07-18"), { code: "act.failed", message: "The Bridge could not read this account.", accountId: "CHK" }]);
    // A failed sync (no entries) keeps them too.
    await write(id, []);
    expect(await errorsOf(id)).toEqual([gap("2026-01-10", "2026-02-20"), gap("2026-05-25", "2026-07-18")]);
  });

  it("replaces the notice of the same outage (same first day) with the new one instead of adding a second", async () => {
    const id = await insert([gap("2026-01-10", "2026-02-20"), gap("2026-05-25", "2026-07-17")]);
    await write(id, [auth, gap("2026-05-25", "2026-07-18")]);
    expect(await errorsOf(id)).toEqual([gap("2026-01-10", "2026-02-20"), auth, gap("2026-05-25", "2026-07-18")]);
  });

  it("drops a notice that does not name its days (written before they did), as every sync used to", async () => {
    const id = await insert([{ code: "sync.gap", message: "The last complete sync was 2026-06-01." }, { code: "sync.gap", message: "odd", from: "2026-01-01" }, gap("2026-05-25", "2026-07-18")]);
    await write(id, []);
    expect(await errorsOf(id)).toEqual([gap("2026-05-25", "2026-07-18")]);
  });

  it("dismisses one notice by its first day and leaves everything else; a connection that does not exist is false", async () => {
    const id = await insert([auth, gap("2026-01-10", "2026-02-20"), gap("2026-05-25", "2026-07-18")]);
    expect(await dismissSyncGap(t.db, id, "2026-05-25")).toBe(true);
    expect(await errorsOf(id)).toEqual([auth, gap("2026-01-10", "2026-02-20")]);
    // Again: nothing left to remove, still fine.
    expect(await dismissSyncGap(t.db, id, "2026-05-25")).toBe(true);
    expect(await errorsOf(id)).toEqual([auth, gap("2026-01-10", "2026-02-20")]);
    expect(await dismissSyncGap(t.db, id, "2026-01-10")).toBe(true);
    expect(await errorsOf(id)).toEqual([auth]);
    expect(await dismissSyncGap(t.db, "00000000-0000-4000-8000-000000000000", "2026-01-10")).toBe(false);
  });
});
