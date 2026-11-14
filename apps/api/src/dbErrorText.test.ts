import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connection, importLog, type Db } from "@meridian/db";
import { createTestDb } from "@meridian/db/testing";
import { decryptSecret, encryptSecret, generateSecretsKey } from "@meridian/shared";
import { runAdminCommand } from "./lib/adminCommands.js";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Decision 120: drizzle-orm 0.44 and later throw a failed query as a `DrizzleQueryError` whose
 * message is the SQL text and its parameters (a file's payees and amounts, a secret's
 * ciphertext). A commit that fails on a query keeps Postgres's own message in its import log,
 * which the Connections page shows, and the recovery commands and the server's start-up print
 * it, as before the upgrade (the error handler's answers and logs are in lib/errors.test.ts). A
 * test trigger refuses the write as a constraint would, with a message of its own, so the text
 * compares exactly.
 */
const REFUSAL = "probe: the row was refused by a test trigger";
const PROBE_FUNCTION = `create function probe_refuse() returns trigger language plpgsql as $$ begin raise exception '${REFUSAL}' using errcode = 'check_violation'; end $$`;
const apiDir = fileURLToPath(new URL("../", import.meta.url));
const urlOf = (databaseName: string) => {
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

/** Runs one of the API's entry points under tsx, as its dev scripts do; stopped by its own handle after 60 s at the latest. */
function runEntry(entry: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], { cwd: apiDir, env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!TEST_DATABASE_URL)("a failed query's text in what the API stores or prints (decision 120)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
    await t.db.db.execute(sql.raw(PROBE_FUNCTION));
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  /** Runs `body` while every `event` on `table` is refused. */
  async function refusing(table: string, body: () => Promise<void>, event: "insert" | "update" = "insert", db: Db = t.db.db): Promise<void> {
    await db.execute(sql.raw(`create trigger probe_refuse before ${event} on "${table}" for each row execute function probe_refuse()`));
    try {
      await body();
    } finally {
      await db.execute(sql.raw(`drop trigger probe_refuse on "${table}"`));
    }
  }
  const latestLog = async (kind: "csv" | "csv.positions") => (await t.db.db.select().from(importLog).where(eq(importLog.kind, kind)).orderBy(desc(importLog.startedAt)).limit(1))[0]!;

  it("a bank CSV commit that fails on a query keeps the database's message, not the SQL and its parameters", async () => {
    const created = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Everyday Checking", type: "checking" } });
    const accountId = created.json().id as string;
    const csvText = ["Date,Description,Amount", "2026-09-15,BLUE BOTTLE COFFEE 4417,-4.50"].join("\n");
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText, accountId } });
    expect(preview.statusCode, preview.body).toBe(200);
    await refusing("transaction", async () => {
      const commit = await t.call({ method: "POST", url: "/api/import/csv/commit", payload: { accountId, csvText, mapping: preview.json().mapping } });
      expect(commit.statusCode).toBe(500);
      expect(commit.json()).toEqual({ error: "Internal error", code: "internal" });
    });
    const log = await latestLog("csv");
    expect(log).toMatchObject({ status: "error", message: REFUSAL });
    expect(log.finishedAt).not.toBeNull();
    // The commit wrote nothing: the import can simply be run again.
    const rows = await t.call({ method: "GET", url: `/api/transactions?accountId=${accountId}` });
    expect(rows.json().items).toEqual([]);
  });

  it("a positions commit that fails on a query keeps the database's message (failLog, also the trades commit's)", async () => {
    const created = await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Schwab", type: "brokerage" } });
    const accountId = created.json().id as string;
    const csvText = ["Symbol,Description,Quantity,Last Price,Current Value", 'VTI,VANGUARD TOTAL STOCK MKT ETF,10.5,250.00,"$2,625.00"'].join("\n");
    const preview = await t.call({ method: "POST", url: "/api/import/positions/preview", payload: { csvText, accountId, asOfDate: "2026-10-13" } });
    expect(preview.statusCode, preview.body).toBe(200);
    await refusing("holding_snapshot", async () => {
      const commit = await t.call({ method: "POST", url: "/api/import/positions/commit", payload: { csvText, accountId, mapping: preview.json().mapping, asOfDate: "2026-10-13" } });
      expect(commit.statusCode).toBe(500);
    });
    const log = await latestLog("csv.positions");
    expect(log).toMatchObject({ status: "error", message: REFUSAL });
    const [others] = await t.db.db.select({ n: sql<number>`count(*)::int` }).from(importLog).where(and(eq(importLog.kind, "csv.positions"), eq(importLog.status, "ok")));
    expect(others!.n).toBe(0);
  });

  it("rotate-secrets-key prints the database's message when a secret cannot be rewritten, never the new ciphertext", async () => {
    const oldKey = t.config.secretsKey;
    const [conn] = await t.db.db
      .insert(connection)
      .values({ type: "simplefin", name: "Bridge", accessUrlEnc: await encryptSecret("https://u:p@bridge.example.test/simplefin", oldKey) })
      .returning({ id: connection.id });
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    await refusing(
      "connection",
      async () => {
        code = await runAdminCommand(t.db.db, ["rotate-secrets-key"], { out: (line) => out.push(line), err: (line) => err.push(line), env: { SECRETS_KEY: generateSecretsKey(), SECRETS_KEY_OLD: oldKey } });
      },
      "update",
    );
    expect({ code, out, err }).toEqual({ code: 1, out: [], err: [REFUSAL] });
    // Nothing changed: the rotation is one transaction.
    const [after] = await t.db.db.select({ accessUrlEnc: connection.accessUrlEnc }).from(connection).where(eq(connection.id, conn!.id));
    expect(await decryptSecret(after!.accessUrlEnc!, oldKey)).toBe("https://u:p@bridge.example.test/simplefin");
  });

  it("admin.js prints the database's message when a command fails on a query, never its parameters (the new password's hash)", async () => {
    await refusing(
      "user",
      async () => {
        const run = await runEntry("src/admin.ts", ["reset-password", "owner"], { DATABASE_URL: urlOf(t.db.databaseName) });
        expect(run).toEqual({ code: 1, stdout: "", stderr: `${REFUSAL}\n` });
      },
      "update",
    );
  });

  it("the server names the database's message when preparing the database fails on a query, and does not start", async () => {
    // A migrated database the server has not prepared yet: seeding the default categories is refused.
    const fresh = await createTestDb();
    try {
      await fresh.db.execute(sql.raw(PROBE_FUNCTION));
      await refusing(
        "category",
        async () => {
          const env = { DATABASE_URL: urlOf(fresh.databaseName), SESSION_SECRET: "test-session-secret-at-least-32-characters-long", SECRETS_KEY: generateSecretsKey(), API_HOST: "127.0.0.1", API_PORT: "3631" };
          const run = await runEntry("src/server.ts", [], env);
          expect(run.code).toBe(1);
          expect(run.stderr).toBe(`[api] not starting: ${REFUSAL}\n`);
        },
        "insert",
        fresh.db,
      );
    } finally {
      await fresh.cleanup();
    }
  });
});
