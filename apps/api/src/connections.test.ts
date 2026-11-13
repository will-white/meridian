import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connection, job } from "@meridian/db";
import { encryptSecret } from "@meridian/shared";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * What the Connections page needs from the API to recover from a bank outage: how the last
 * attempt went and whether the schedule is paused, a full resync that really is one, and a
 * way to switch a paused connection back on.
 */
describe.skipIf(!TEST_DATABASE_URL)("connections: sync state and the full resync", () => {
  let t: TestApp;
  let connectionId: string;
  const LAST_SYNC = new Date("2026-10-01T06:00:00Z");
  const LAST_ATTEMPT = new Date("2026-10-13T06:00:00Z");
  const view = async () => (await t.call({ method: "GET", url: "/api/connections" })).json().find((c: { id: string }) => c.id === connectionId);
  const syncJobs = () => t.db.db.select().from(job).where(eq(job.type, "simplefin.sync"));

  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
    const [row] = await t.db.db
      .insert(connection)
      .values({
        type: "simplefin",
        name: "Bank",
        // The Bridge refused the access URL twelve days after the last good sync.
        status: "auth_required",
        accessUrlEnc: await encryptSecret("https://alice:s3cret@bridge.example.test/simplefin", t.config.secretsKey),
        lastSyncAt: LAST_SYNC,
        lastAttemptAt: LAST_ATTEMPT,
        syncedThrough: "2026-10-01",
        syncPaused: true,
        lastError: "SimpleFIN access was refused (403). The access URL may have been revoked; reconnect with a new setup token.",
      })
      .returning({ id: connection.id });
    connectionId = row!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("shows when the connection last worked, when it was last tried and that the schedule is paused", async () => {
    expect(await view()).toMatchObject({
      status: "auth_required",
      lastSyncAt: "2026-10-01T06:00:00.000Z",
      lastAttemptAt: "2026-10-13T06:00:00.000Z",
      syncedThrough: "2026-10-01",
      syncPaused: true,
    });
  });

  it("turns a sync that is already waiting into a full resync instead of dropping the request", async () => {
    const plain = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: {} });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toMatchObject({ type: "simplefin.sync", status: "queued", payload: { connectionId, manual: true } });
    expect(plain.json().payload.fullResync).toBeUndefined();

    // The same job, now carrying the flag the worker reads.
    const full = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: { fullResync: true } });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ id: plain.json().id, status: "queued", payload: { connectionId, manual: true, fullResync: true } });
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ connectionId, manual: true, fullResync: true });
    // Asking again changes nothing.
    const again = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: { fullResync: true } });
    expect(again.json().id).toBe(plain.json().id);
    expect(await syncJobs()).toHaveLength(1);
  });

  it("refuses a full resync while an ordinary sync is running, and queues one once it has finished", async () => {
    const [running] = await syncJobs();
    await t.db.db.update(job).set({ status: "running", payload: { connectionId, scheduled: true } }).where(eq(job.id, running!.id));
    // An ordinary "sync now" is satisfied by the run in progress.
    const plain = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: {} });
    expect(plain.json()).toMatchObject({ id: running!.id, status: "running" });
    // A full resync is not: the run in progress asked for the short window.
    const full = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: { fullResync: true } });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("sync_running");
    expect(await syncJobs()).toHaveLength(1);

    await t.db.db.update(job).set({ status: "done" }).where(eq(job.id, running!.id));
    const after = await t.call({ method: "POST", url: `/api/connections/${connectionId}/sync`, payload: { fullResync: true } });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ status: "queued", payload: { connectionId, manual: true, fullResync: true } });
    expect(after.json().id).not.toBe(running!.id);
  });

  it("switching a connection back on lifts the pause, so the schedule tries it again", async () => {
    const off = await t.call({ method: "PATCH", url: `/api/connections/${connectionId}`, payload: { status: "disabled" } });
    expect(off.json()).toMatchObject({ status: "disabled", syncPaused: true });
    const renamed = await t.call({ method: "PATCH", url: `/api/connections/${connectionId}`, payload: { name: "Bank (main)" } });
    expect(renamed.json()).toMatchObject({ name: "Bank (main)", status: "disabled", syncPaused: true });
    const on = await t.call({ method: "PATCH", url: `/api/connections/${connectionId}`, payload: { status: "ok" } });
    expect(on.json()).toMatchObject({ status: "ok", syncPaused: false, lastAttemptAt: "2026-10-13T06:00:00.000Z" });
  });
});

/**
 * Audit a4-sync-parse-06: a setup token whose claim failed for a reason that passes (the
 * Bridge down for a few minutes) is still stored; Sync now must queue the claim again
 * instead of answering that there is no access URL.
 */
describe.skipIf(!TEST_DATABASE_URL)("connections: a setup token that could not be claimed yet", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("Sync now queues the claim again while the token is stored and there is no access URL", async () => {
    const [row] = await t.db.db
      .insert(connection)
      .values({
        type: "simplefin",
        name: "Bank",
        status: "error",
        claimTokenEnc: await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok"), t.config.secretsKey),
        lastError: "The setup token could not be claimed yet: Claim failed with HTTP 503. Press Sync now to try again.",
      })
      .returning({ id: connection.id });
    for (const payload of [{}, { fullResync: true }]) {
      const res = await t.call({ method: "POST", url: `/api/connections/${row!.id}/sync`, payload });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ type: "simplefin.claim", status: "queued", payload: { connectionId: row!.id } });
    }
    expect(await t.db.db.select().from(job).where(eq(job.type, "simplefin.claim"))).toHaveLength(1);
    const [after] = await t.db.db.select().from(connection).where(eq(connection.id, row!.id));
    expect(after!.status).toBe("claiming");
  });

  it("says what the household can do when there is neither a token nor an access URL", async () => {
    const [row] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Refused", status: "error" }).returning({ id: connection.id });
    const res = await t.call({ method: "POST", url: `/api/connections/${row!.id}/sync`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "no_access_url",
      error: "This connection has no access URL: its setup token was refused or used up. Remove the connection and add it again with a new setup token from the SimpleFIN Bridge.",
    });
  });
});
