import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, connection, enqueueJob, importLog, job, transaction } from "@meridian/db";
import { createTestDb, FIXTURE_END, FIXTURE_START, renderAccountSet, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { addDays, encryptSecret, generateSecretsKey, isoDateToUtcMs } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import { scheduleDueSyncs } from "../scheduler.js";
import type { JobContext } from "./context.js";
import { syncWindowStart } from "./sync.js";

const ACCESS = "https://alice:s3cret@bridge.example.test/simplefin";

describe("syncWindowStart", () => {
  const config = { initialWindowDays: 93, overlapDays: 7 };
  it("looks back 93 days on the first sync and overlaps 7 days afterwards", () => {
    expect(syncWindowStart(null, "2026-10-13", config)).toBe("2026-07-12");
    expect(syncWindowStart("2026-10-10", "2026-10-13", config)).toBe("2026-10-03");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("claim and sync jobs end to end", () => {
  let t: TestDb;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  let now = new Date(`${addDays(FIXTURE_START, 60)}T12:00:00Z`);
  const requests: URL[] = [];
  let nextResponse: (init: RequestInit) => Response = () => new Response("", { status: 500 });

  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey,
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
  };

  beforeAll(async () => {
    t = await createTestDb();
    ctx = {
      db: t.db,
      config,
      client: {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new URL(String(input)));
          return nextResponse(init ?? {});
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("claims a setup token, stores the access URL encrypted, and runs the first sync it queued", async () => {
    const claimTokenEnc = await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok"), secretsKey);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "claiming", claimTokenEnc }).returning();
    connectionId = conn!.id;
    await enqueueJob(t.db, "simplefin.claim", { connectionId });
    const firstWindow = addDays(FIXTURE_START, 60 - 93);
    nextResponse = (init) =>
      init.method === "POST"
        ? new Response(ACCESS, { status: 200 })
        : new Response(JSON.stringify(renderAccountSet({ start: firstWindow, asOf: addDays(FIXTURE_START, 60) })), { status: 200 });

    // The claim job queues the first sync, which queues the recurring run (plan §17); draining runs all three.
    expect(await drainQueue(ctx)).toBe(3);

    const [after] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(after!.status).toBe("ok");
    expect(after!.claimTokenEnc).toBeNull();
    expect(after!.accessUrlEnc).not.toContain("s3cret");
    expect(after!.accessUrlEnc?.startsWith("v1.")).toBe(true);
    const jobs = await t.db.select().from(job);
    expect(jobs.map((j) => [j.type, j.status]).sort()).toEqual([
      ["recurring.detect", "done"],
      ["simplefin.claim", "done"],
      ["simplefin.sync", "done"],
    ]);
    expect(jobs.find((j) => j.type === "recurring.detect")!.payload).toEqual({ reason: "sync" });

    // First sync: 93 days back, pending included, raw payload logged, connection updated.
    expect(requests).toHaveLength(2);
    const req = requests[1]!;
    expect(req.searchParams.get("version")).toBe("2");
    expect(req.searchParams.get("pending")).toBe("1");
    expect(req.searchParams.get("start-date")).toBe(String(isoDateToUtcMs(firstWindow) / 1000));
    expect(after!.syncedThrough).toBe(addDays(FIXTURE_START, 60));
    expect(after!.lastSyncAt).toEqual(now);
    const logs = await t.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("ok");
    expect((logs[0]!.rawPayload as { accounts: unknown[] }).accounts).toHaveLength(3);
    expect(logs[0]!.stats?.["created"]).toBeGreaterThan(50);
    expect(await t.db.select().from(account)).toHaveLength(3);
  });

  it("the scheduler queues a sync only once the interval has passed, and dedupes", async () => {
    expect(await scheduleDueSyncs(ctx)).toBe(0);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect(await scheduleDueSyncs(ctx)).toBe(1);
    expect(await scheduleDueSyncs(ctx)).toBe(0);
  });

  it("second sync overlaps by 7 days, posts pending items, and adds nothing twice", async () => {
    requests.length = 0;
    now = new Date(`${FIXTURE_END}T12:00:00Z`);
    const expectedStart = addDays(addDays(FIXTURE_START, 60), -7);
    nextResponse = () => new Response(JSON.stringify(renderAccountSet({ start: expectedStart, asOf: FIXTURE_END })), { status: 200 });
    const before = (await t.db.select().from(transaction)).length;
    // The sync plus the recurring run it queues.
    expect(await drainQueue(ctx)).toBe(2);
    expect(requests[0]!.searchParams.get("start-date")).toBe(String(isoDateToUtcMs(expectedStart) / 1000));
    const logs = await t.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync"));
    const last = logs[logs.length - 1]!;
    expect(last.stats?.["replacedPending"]).toBeGreaterThan(0);
    expect(last.stats?.["removedPending"]).toBe(1);
    expect((await t.db.select().from(transaction)).length).toBe(before + (last.stats?.["created"] ?? 0) - 1);
  });

  it("surfaces errlist per connection and flags con.auth as auth_required", async () => {
    const set = renderAccountSet({ start: addDays(FIXTURE_END, -7), asOf: FIXTURE_END });
    set.errlist = [{ code: "con.auth", msg: "Please <b>re-login</b>", conn_id: "x" }];
    nextResponse = () => new Response(JSON.stringify(set), { status: 200 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("auth_required");
    expect(conn!.lastErrors).toEqual([{ code: "con.auth", message: "The bank connection needs to be re-authenticated at the SimpleFIN Bridge. (Please re-login)" }]);
  });

  it("a 403 on sync marks the connection auth_required and does not retry", async () => {
    nextResponse = () => new Response("", { status: 403 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("auth_required");
    expect(conn!.lastError).toMatch(/403/);
    const failed = await t.db.select().from(job).where(eq(job.status, "failed"));
    expect(failed).toHaveLength(1);
  });

  it("a 5xx is retried with backoff and the connection shows the error", async () => {
    nextResponse = () => new Response("", { status: 503 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("error");
    const queued = await t.db.select().from(job).where(eq(job.status, "queued"));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attempts).toBe(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a refused claim token (403) is dropped and the user is told it may be compromised", async () => {
    const claimTokenEnc = await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok2"), secretsKey);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Other", status: "claiming", claimTokenEnc }).returning();
    await enqueueJob(t.db, "simplefin.claim", { connectionId: conn!.id });
    nextResponse = () => new Response("", { status: 403 });
    await drainQueue(ctx);
    const [after] = await t.db.select().from(connection).where(eq(connection.id, conn!.id));
    expect(after!.status).toBe("error");
    expect(after!.claimTokenEnc).toBeNull();
    expect(after!.lastError).toMatch(/compromised/);
  });
});
