import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { job } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { claimNextJob, completeJob, enqueueJob, failJob, requeueStaleJobs } from "./jobs.js";

describe.skipIf(!TEST_DATABASE_URL)("job queue", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("enqueues, dedupes by connection, claims in order, completes", async () => {
    const a = await enqueueJob(t.db, "simplefin.sync", { connectionId: "c1" }, { dedupe: true });
    const again = await enqueueJob(t.db, "simplefin.sync", { connectionId: "c1" }, { dedupe: true });
    expect(again.id).toBe(a.id);
    const b = await enqueueJob(t.db, "simplefin.sync", { connectionId: "c2" }, { dedupe: true });
    expect(b.id).not.toBe(a.id);

    const first = await claimNextJob(t.db, "w1");
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    const second = await claimNextJob(t.db, "w1");
    expect(second?.id).toBe(b.id);
    expect(await claimNextJob(t.db, "w1")).toBeUndefined();

    await completeJob(t.db, a.id);
    const [done] = await t.db.select().from(job).where(eq(job.id, a.id));
    expect(done!.status).toBe("done");
    await completeJob(t.db, b.id);
  });

  it("retries a failed job with backoff until attempts run out", async () => {
    const j = await enqueueJob(t.db, "simplefin.claim", { connectionId: "c3" }, { maxAttempts: 2 });
    const claimed = (await claimNextJob(t.db, "w1"))!;
    expect(claimed.id).toBe(j.id);
    await failJob(t.db, claimed, "boom");
    let [row] = await t.db.select().from(job).where(eq(job.id, j.id));
    expect(row!.status).toBe("queued");
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claimNextJob(t.db, "w1")).toBeUndefined(); // not due yet

    await t.db.update(job).set({ runAt: new Date(Date.now() - 1000) }).where(eq(job.id, j.id));
    const again = (await claimNextJob(t.db, "w1"))!;
    await failJob(t.db, again, "boom again");
    [row] = await t.db.select().from(job).where(eq(job.id, j.id));
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toBe("boom again");
  });

  it("dedupes on payload.dedupeKey when present, ignoring the connection (Phase 3)", async () => {
    const nightly = await enqueueJob(t.db, "prices.fetch", { reason: "nightly", dedupeKey: "prices:nightly:2026-10-13", connectionId: "c1" }, { dedupe: true });
    expect(nightly.created).toBe(true);
    const sameKey = await enqueueJob(t.db, "prices.fetch", { reason: "nightly", dedupeKey: "prices:nightly:2026-10-13", connectionId: "c2" }, { dedupe: true });
    expect(sameKey).toMatchObject({ id: nightly.id, created: false });
    const otherKey = await enqueueJob(t.db, "prices.fetch", { reason: "continue", dedupeKey: "prices:continue:root" }, { dedupe: true });
    expect(otherKey.created).toBe(true);
    expect(otherKey.id).not.toBe(nightly.id);
    // Without a key the Phase 1 rule holds: one queued job per type (and connection).
    const detect = await enqueueJob(t.db, "recurring.detect", { reason: "ledger" }, { dedupe: true });
    const detectAgain = await enqueueJob(t.db, "recurring.detect", { reason: "sync" }, { dedupe: true });
    expect(detectAgain).toMatchObject({ id: detect.id, created: false });
    // A keyed request never matches an unkeyed job of the same type, nor the other way round.
    const unkeyed = await enqueueJob(t.db, "prices.fetch", { reason: "manual" }, { dedupe: true });
    expect(unkeyed.created).toBe(false);
    expect([nightly.id, otherKey.id]).toContain(unkeyed.id);
    for (const j of [nightly, otherKey, detect]) await completeJob(t.db, j.id);
  });

  it("requeues stale running jobs", async () => {
    const j = await enqueueJob(t.db, "rules.run", {});
    await claimNextJob(t.db, "w2");
    await t.db.update(job).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(job.id, j.id));
    expect(await requeueStaleJobs(t.db, 30)).toBe(1);
    const [row] = await t.db.select().from(job).where(eq(job.id, j.id));
    expect(row!.status).toBe("queued");
  });
});
