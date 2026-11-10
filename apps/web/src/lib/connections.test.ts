import { describe, expect, it } from "vitest";
import { lastAttemptFailed, syncAdvice, syncControls, syncSummary } from "./connections.js";

const healthy = {
  status: "ok" as const,
  syncPaused: false,
  accountCount: 3,
  lastSyncAt: "2026-10-13T06:00:00.000Z",
  lastAttemptAt: "2026-10-13T06:00:00.000Z",
  syncedThrough: "2026-10-13",
  activeJob: null,
};
const relative = (iso: string | null | undefined) => (iso ? `at ${iso.slice(0, 16)}` : "never");

describe("lastAttemptFailed", () => {
  it("is true when the last try is later than the last success, or there never was a success", () => {
    expect(lastAttemptFailed(healthy)).toBe(false);
    expect(lastAttemptFailed({ lastSyncAt: "2026-10-13T06:00:00.000Z", lastAttemptAt: "2026-10-13T12:00:00.000Z" })).toBe(true);
    expect(lastAttemptFailed({ lastSyncAt: null, lastAttemptAt: "2026-10-13T12:00:00.000Z" })).toBe(true);
    // Never tried (a connection still claiming its token, a csv profile).
    expect(lastAttemptFailed({ lastSyncAt: null, lastAttemptAt: null })).toBe(false);
    expect(lastAttemptFailed({ lastSyncAt: "2026-10-13T06:00:00.000Z", lastAttemptAt: null })).toBe(false);
  });
});

describe("syncSummary", () => {
  it("shows the last success and the day the ledger is complete through", () => {
    expect(syncSummary(healthy, relative)).toBe("3 accounts · last sync at 2026-10-13T06:00 · complete through 2026-10-13");
    expect(syncSummary({ ...healthy, accountCount: 1, syncedThrough: null }, relative)).toBe("1 account · last sync at 2026-10-13T06:00");
  });
  it("adds the last try when it was not a success, so a stuck connection does not look idle", () => {
    expect(syncSummary({ ...healthy, lastAttemptAt: "2026-10-14T00:00:00.000Z", syncedThrough: "2026-10-01" }, relative)).toBe(
      "3 accounts · last sync at 2026-10-13T06:00 · last tried at 2026-10-14T00:00 · complete through 2026-10-01",
    );
    expect(syncSummary({ ...healthy, accountCount: 0, lastSyncAt: null, lastAttemptAt: "2026-10-14T00:00:00.000Z", syncedThrough: null }, relative)).toBe(
      "0 accounts · last sync never · last tried at 2026-10-14T00:00",
    );
  });
});

describe("syncAdvice", () => {
  it("has nothing to add for a connection that works, is switched off, or is still claiming its token", () => {
    expect(syncAdvice(healthy)).toBeNull();
    expect(syncAdvice({ ...healthy, status: "disabled", syncPaused: true })).toBeNull();
    expect(syncAdvice({ ...healthy, status: "claiming" })).toBeNull();
  });
  it("says the schedule is paused, and how to resume it, after the Bridge refused the access URL or asked for payment", () => {
    const paused = "Scheduled syncs are paused, because asking again cannot fix this. Once it is sorted out at the Bridge, press Sync now: the schedule resumes when that sync works.";
    expect(syncAdvice({ ...healthy, status: "auth_required", syncPaused: true })).toBe(paused);
    expect(syncAdvice({ ...healthy, status: "error", syncPaused: true })).toBe(paused);
  });
  it("says syncs keep running while a bank needs re-authentication, and that nothing in between is lost", () => {
    expect(syncAdvice({ ...healthy, status: "auth_required", syncedThrough: "2026-09-10" })).toBe(
      "Re-authenticate the bank at the SimpleFIN Bridge. Syncs keep running in the meantime, and the first complete one fetches everything since 2026-09-10.",
    );
    expect(syncAdvice({ ...healthy, status: "auth_required", syncedThrough: null })).toBe("Re-authenticate the bank at the SimpleFIN Bridge. Syncs keep running in the meantime.");
  });
  it("says when a failed connection is tried again", () => {
    expect(syncAdvice({ ...healthy, status: "error" })).toBe("The schedule tries again one sync interval after the last try. Sync now tries at once.");
    // A setup token that could not be claimed: no sync was ever tried and none is scheduled.
    expect(syncAdvice({ ...healthy, status: "error", lastAttemptAt: null, syncedThrough: null })).toBeNull();
  });
});

describe("syncControls", () => {
  it("offers all three on an idle, working connection", () => {
    expect(syncControls(healthy)).toEqual({ syncNow: true, balancesOnly: true, fullResync: true });
  });
  it("offers nothing while a job is queued or running, or the connection is switched off", () => {
    const none = { syncNow: false, balancesOnly: false, fullResync: false };
    expect(syncControls({ ...healthy, activeJob: { id: "00000000-0000-4000-8000-000000000001", type: "simplefin.sync", status: "queued" } })).toEqual(none);
    expect(syncControls({ ...healthy, status: "disabled" })).toEqual(none);
  });
  it("keeps a sync and a full resync available on a connection with a problem, which is when they are needed", () => {
    expect(syncControls({ ...healthy, status: "auth_required" })).toEqual({ syncNow: true, balancesOnly: false, fullResync: true });
    expect(syncControls({ ...healthy, status: "error" })).toEqual({ syncNow: true, balancesOnly: false, fullResync: true });
    // Still claiming: "Sync now" retries the claim; there is no access URL to resync with.
    expect(syncControls({ ...healthy, status: "claiming" })).toEqual({ syncNow: true, balancesOnly: false, fullResync: false });
  });
});
