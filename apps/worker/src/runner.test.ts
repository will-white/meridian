import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSecretsKey } from "@meridian/shared";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { loadConfig, type WorkerConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { heartbeatWriter, startRunner } from "./runner.js";

/** Audit a7-backup-deploy-secrets-18: the runner leaves a heartbeat the container's healthcheck reads. */
describe("worker heartbeat (audit a7-backup-deploy-secrets-18)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "meridian-heartbeat-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("WORKER_HEARTBEAT_FILE names the file; without it there is none", () => {
    const key = generateSecretsKey();
    expect(loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: key, WORKER_HEARTBEAT_FILE: "/tmp/beat" }).heartbeatFile).toBe("/tmp/beat");
    expect(loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: key }).heartbeatFile).toBeUndefined();
    expect(heartbeatWriter(undefined)).toBeUndefined();
    const file = path.join(dir, "beat");
    heartbeatWriter(file)!();
    expect(readFileSync(file, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A file that cannot be written does not stop the runner.
    expect(() => heartbeatWriter(path.join(dir, "no", "such", "dir"))!()).not.toThrow();
  });

  describe.skipIf(!TEST_DATABASE_URL)("with a database", () => {
    let t: TestDb;
    beforeAll(async () => {
      t = await createTestDb();
    });
    afterAll(async () => t?.cleanup());

    it("writes the heartbeat after each pass over the queue, and not while the database cannot be reached", async () => {
      const file = path.join(dir, "worker-heartbeat");
      const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test", syncIntervalHours: 6, pollIntervalMs: 20, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 1000, heartbeatFile: file };
      const quiet = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} } as unknown as Console;
      const ctx: JobContext = { db: t.db, config, client: {}, now: () => new Date(), log: quiet };
      const stop = startRunner(ctx);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          if (statSync(file).size > 0) break;
        } catch {
          // not yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      stop();
      const first = statSync(file).mtimeMs;
      expect(Date.now() - first).toBeLessThan(5000);

      // A runner whose database is gone keeps going but stops beating.
      const broken: JobContext = { ...ctx, db: { select: () => { throw new Error("database down"); }, execute: () => { throw new Error("database down"); }, update: () => { throw new Error("database down"); }, transaction: () => { throw new Error("database down"); } } as unknown as JobContext["db"] };
      let beats = 0;
      const stopBroken = startRunner(broken, () => beats++);
      await new Promise((r) => setTimeout(r, 200));
      stopBroken();
      expect(beats).toBe(0);
    });
  });
});
