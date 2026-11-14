import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { and, desc, DrizzleQueryError, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { account, connection, enqueueJob, importLog, job, type JobRow } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, testDatabaseName, type TestDb } from "@meridian/db/testing";
import { encryptSecret, generateSecretsKey, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import type { WorkerConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { claimFailure } from "./jobs/claim.js";
import { runReprocessHoldingsJob } from "./jobs/reprocessHoldings.js";
import { runReprocessTransactionsJob } from "./jobs/reprocessTransactions.js";
import { drainQueue, startRunner } from "./runner.js";
import { startScheduler } from "./scheduler.js";

/**
 * drizzle-orm 0.44 and later throw a failed query as a `DrizzleQueryError` whose message is the
 * SQL text and its parameters. What the worker stores for the household to read (a job's last
 * error, a connection's, an import log's message and its per-account entries) is the database's
 * own message, as it was before the upgrade (decision 120), and so is what it logs. Below, a test
 * trigger refuses a write as a constraint would, with a message of its own, so the text compares
 * exactly.
 */

const REFUSAL = "probe: the row was refused by a test trigger";
const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const fakeJob = (type: JobRow["type"], payload: Record<string, unknown>): JobRow => {
  const now = new Date();
  return { id: randomUUID(), type, payload, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
};

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
    let ctx: JobContext;
    const secretsKey = generateSecretsKey();
    const now = new Date("2026-10-14T18:00:00Z");
    let respond: () => SimplefinAccountSet = () => ({ errors: [], errlist: [], accounts: [] });
    beforeAll(async () => {
      t = await createTestDb();
      const config: WorkerConfig = { databaseUrl: "unused", secretsKey, workerId: "test", syncIntervalHours: 6, pollIntervalMs: 20, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 1000 };
      ctx = {
        db: t.db,
        config,
        client: { allowedHosts: ["bridge.example.test"], fetch: (async () => new Response(JSON.stringify(respond()), { status: 200 })) as typeof fetch },
        now: () => now,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      };
      await t.db.execute(sql.raw(`create function probe_refuse() returns trigger language plpgsql as $$ begin raise exception '${REFUSAL}' using errcode = 'check_violation'; end $$`));
    });
    afterAll(async () => t?.cleanup());

    /** Runs `body` while every `event` on `table` (where `when` holds, if given) is refused; a statement-level trigger fires even when no row matches. */
    async function refusing(trigger: { event: "insert" | "update" | "delete"; table: string; when?: string; level?: "row" | "statement" }, body: () => Promise<void>): Promise<void> {
      await t.db.execute(sql.raw(`create trigger probe_refuse before ${trigger.event} on "${trigger.table}" for each ${trigger.level ?? "row"} ${trigger.when ? `when (${trigger.when})` : ""} execute function probe_refuse()`));
      try {
        await body();
      } finally {
        await t.db.execute(sql.raw(`drop trigger probe_refuse on "${trigger.table}"`));
      }
    }
    /** A SimpleFIN connection with one account of `type` under the feed id `externalId`. */
    async function feedAccount(name: string, externalId: string, type: "brokerage" | "checking"): Promise<string> {
      const [conn] = await t.db.insert(connection).values({ type: "simplefin", name, status: "ok", accessUrlEnc: await encryptSecret("https://alice:s3cret@bridge.example.test/simplefin", secretsKey) }).returning({ id: connection.id });
      await t.db.insert(account).values({ connectionId: conn!.id, externalId, name, type, taxTreatment: type === "brokerage" ? "taxable" : "none", onBudget: type !== "brokerage" });
      return conn!.id;
    }
    const brokerageSet = (externalId: string): SimplefinAccountSet => ({
      errors: [],
      errlist: [],
      accounts: [
        {
          org: { name: "Example Brokerage Services" },
          id: externalId,
          name: "Example Brokerage",
          currency: "USD",
          balance: "3094.40",
          "balance-date": unix("2026-10-13", 18),
          transactions: [],
          extra: { holdings: [{ symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: "12.345", price: "250.66", market_value: "3094.40" }] },
        },
      ],
    });
    const checkingSet = (externalId: string): SimplefinAccountSet => ({
      errors: [],
      errlist: [],
      accounts: [
        {
          org: { name: "First Example Bank" },
          id: externalId,
          name: "Everyday Checking",
          currency: "USD",
          balance: "100.00",
          "balance-date": unix("2026-10-14", 6),
          transactions: [{ id: "T-1", posted: unix("2026-10-13"), amount: "-4.50", description: "BLUE BOTTLE COFFEE 4417", pending: false }],
        },
      ],
    });
    const summaryOf = async (connectionId: string) =>
      (await t.db.select().from(importLog).where(and(eq(importLog.connectionId, connectionId), eq(importLog.kind, "simplefin.reprocess"))).orderBy(desc(importLog.startedAt)).limit(1))[0]!;

    it("a job that fails on a query records Postgres's message as its last error", async () => {
      // An account id that is not a uuid: the valuation's first query is refused by Postgres (22P02).
      const queued = await enqueueJob(t.db, "investments.valuation", { reason: "test", accountId: "not-a-uuid" });
      await drainQueue(ctx);
      const [row] = await t.db.select({ lastError: job.lastError }).from(job).where(eq(job.id, queued.id));
      expect(row!.lastError).toBe('invalid input syntax for type uuid: "not-a-uuid"');
    });

    it("a sync that fails on a query leaves Postgres's message on the connection and its import log", async () => {
      const connectionId = await feedAccount("Bank", "CHK-SYNC", "checking");
      respond = () => checkingSet("CHK-SYNC");
      await refusing({ event: "insert", table: "transaction" }, async () => {
        await enqueueJob(t.db, "simplefin.sync", { connectionId });
        await drainQueue(ctx);
      });
      const [conn] = await t.db.select({ status: connection.status, lastError: connection.lastError }).from(connection).where(eq(connection.id, connectionId));
      expect(conn).toEqual({ status: "error", lastError: REFUSAL });
      const logs = await t.db.select({ status: importLog.status, message: importLog.message }).from(importLog).where(and(eq(importLog.connectionId, connectionId), eq(importLog.kind, "simplefin.sync")));
      expect(logs).toEqual([{ status: "error", message: REFUSAL }]);
    });

    it("reprocessing holdings an account cannot take reports Postgres's message for that account", async () => {
      const connectionId = await feedAccount("Example Brokerage", "BRK-ONE", "brokerage");
      await t.db.insert(importLog).values({ connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-13T18:00:00Z"), rawPayload: brokerageSet("BRK-ONE") });
      await refusing({ event: "insert", table: "holding_snapshot" }, async () => {
        await runReprocessHoldingsJob(ctx, fakeJob("simplefin.reprocess_holdings", { connectionId }));
      });
      const summary = await summaryOf(connectionId);
      expect(summary.status).toBe("ok");
      expect(summary.errors).toEqual([{ code: "holdings.parse_error", message: `Example Brokerage: ${REFUSAL}`, accountId: "BRK-ONE" }]);
    });

    it("a holdings reprocess that fails on a query records Postgres's message on its summary", async () => {
      const connectionId = await feedAccount("Example Brokerage", "BRK-TWO", "brokerage");
      await t.db.insert(importLog).values({ connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-13T18:00:00Z"), rawPayload: brokerageSet("BRK-TWO") });
      // The replayed payload's row cannot be marked as reprocessed: the run fails as a whole.
      await refusing({ event: "update", table: "import_log", when: "new.stats ? 'reprocessedAt'" }, async () => {
        await expect(runReprocessHoldingsJob(ctx, fakeJob("simplefin.reprocess_holdings", { connectionId }))).rejects.toThrow();
      });
      expect(await summaryOf(connectionId)).toMatchObject({ status: "error", message: REFUSAL });
    });

    it("a transactions reprocess that fails on a query records Postgres's message on its summary", async () => {
      const connectionId = await feedAccount("Bank", "CHK-REPLAY", "checking");
      await t.db.insert(importLog).values({ connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-14T06:00:00Z"), rawPayload: checkingSet("CHK-REPLAY") });
      await refusing({ event: "insert", table: "transaction" }, async () => {
        await expect(runReprocessTransactionsJob(ctx, fakeJob("simplefin.reprocess_transactions", { connectionId }))).rejects.toThrow();
      });
      expect(await summaryOf(connectionId)).toMatchObject({ status: "error", message: REFUSAL });
    });

    it("the worker names the database's message when its first query fails, and does not start", async () => {
      // A database the API has not migrated yet: the secrets-key check's first select fails.
      const name = testDatabaseName();
      const admin = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database "${name}"`);
      try {
        const url = new URL(TEST_DATABASE_URL!);
        url.pathname = `/${name}`;
        const run = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: url.toString(), SECRETS_KEY: secretsKey },
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
          child.on("error", reject);
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
          });
        });
        expect(run).toEqual({ code: 1, stderr: '[worker] not starting: relation "user" does not exist\n' });
      } finally {
        await admin.unsafe(`drop database "${name}" with (force)`);
        await admin.end();
      }
    });

    it("a tick of the scheduler or the runner that fails on a query logs Postgres's message", async () => {
      await feedAccount("Bank", "CHK-DUE", "checking"); // never synced, so due
      const errors: string[] = [];
      const logging: JobContext = { ...ctx, log: { info: () => {}, warn: () => {}, error: (m: string) => void errors.push(m) } };
      // Queuing the due sync and purging expired sessions are both refused.
      await refusing({ event: "insert", table: "job" }, () =>
        refusing({ event: "delete", table: "session", level: "statement" }, async () => {
          const stop = startScheduler(logging, 5);
          try {
            await vi.waitFor(() => expect(errors).toEqual(expect.arrayContaining([`[scheduler] ${REFUSAL}`, `[scheduler] sign-in purge failed: ${REFUSAL}`])), { timeout: 3000, interval: 10 });
          } finally {
            await stop();
          }
        }),
      );
      expect(new Set(errors)).toEqual(new Set([`[scheduler] ${REFUSAL}`, `[scheduler] sign-in purge failed: ${REFUSAL}`]));
      // Claiming the next job is refused.
      errors.length = 0;
      await refusing({ event: "update", table: "job", level: "statement" }, async () => {
        const stop = startRunner(logging, undefined);
        try {
          await vi.waitFor(() => expect(errors).toContain(`[runner] ${REFUSAL}`), { timeout: 3000, interval: 10 });
        } finally {
          stop();
          await new Promise((resolve) => setTimeout(resolve, 3 * ctx.config.pollIntervalMs));
        }
      });
      expect(new Set(errors)).toEqual(new Set([`[runner] ${REFUSAL}`]));
    });
  });
});
