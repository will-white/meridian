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

  it("requeues stale running jobs", async () => {
    const j = await enqueueJob(t.db, "rules.run", {});
    await claimNextJob(t.db, "w2");
    await t.db.update(job).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(job.id, j.id));
    expect(await requeueStaleJobs(t.db, 30)).toBe(1);
    const [row] = await t.db.select().from(job).where(eq(job.id, j.id));
    expect(row!.status).toBe("queued");
  });
});
