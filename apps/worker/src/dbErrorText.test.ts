import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueJob, job } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey } from "@meridian/shared";
import type { WorkerConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { claimFailure } from "./jobs/claim.js";
import { drainQueue } from "./runner.js";

/**
 * drizzle-orm 0.44 and later throw a failed query as a `DrizzleQueryError` whose message is the
 * SQL text and its parameters. What the worker stores for the household to read (a job's last
 * error, a connection's) is the database's own message, as it was before the upgrade.
 */

describe("a failed query's text in what the worker stores", () => {
  it("claimFailure reports the database's message, not the SQL and its parameters", () => {
    const cause = Object.assign(new Error("canceling statement due to statement timeout"), { name: "PostgresError", code: "57014" });
    const error = new DrizzleQueryError('update "connection" set "access_url_enc" = $1 where "id" = $2', ["v1:ciphertext-of-the-access-url", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"], cause);
    const { message, spent } = claimFailure(error);
    expect(message).toBe("The setup token could not be claimed yet: canceling statement due to statement timeout. Press Sync now to try again.");
    expect(spent).toBe(false);
  });

  describe.skipIf(!TEST_DATABASE_URL)("with a database", () => {
    let t: TestDb;
    beforeAll(async () => {
      t = await createTestDb();
    });
    afterAll(async () => t?.cleanup());

    it("a job that fails on a query records Postgres's message as its last error", async () => {
      const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test", syncIntervalHours: 6, pollIntervalMs: 20, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 1000 };
      const quiet = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} } as unknown as Console;
      const ctx: JobContext = { db: t.db, config, client: {}, now: () => new Date(), log: quiet };
      // An account id that is not a uuid: the valuation's first query is refused by Postgres (22P02).
      const queued = await enqueueJob(t.db, "investments.valuation", { reason: "test", accountId: "not-a-uuid" });
      await drainQueue(ctx);
      const [row] = await t.db.select({ lastError: job.lastError }).from(job).where(eq(job.id, queued.id));
      expect(row!.lastError).toBe('invalid input syntax for type uuid: "not-a-uuid"');
    });
  });
});
