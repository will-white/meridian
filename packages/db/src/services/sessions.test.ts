import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditEntity, SignInEventKind } from "@meridian/shared";
import { AUDIT_ENTITIES, session, SIGN_IN_EVENT_KINDS, signInEvent, user } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PlanError } from "./audit.js";
import {
  createSession,
  deleteOwnSession,
  deleteUserSessions,
  findLiveSession,
  listSessions,
  MAX_FAILED_CODES,
  PENDING_SESSION_MS,
  purgeExpiredSessions,
  recordFailedCode,
  rotateSession,
  sessionIdOf,
  touchSession,
} from "./sessions.js";
import { countFailedSignIns, FAILED_SIGN_IN_KINDS, listSignInEvents, purgeSignInEvents, recordSignInEvent } from "./signInEvents.js";
import { acceptTotpStep, createOwner, createViewer, getUser, listUsers } from "./users.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 2026-11-10 09:00 UTC: every moment below is spelled relative to it. */
const T0 = new Date("2026-11-10T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("text columns mirror the shared enums", () => {
  it("sign_in_event.kind and audit_log.entity list exactly what the contracts allow", () => {
    expect([...SIGN_IN_EVENT_KINDS]).toEqual(SignInEventKind.options);
    expect([...AUDIT_ENTITIES]).toEqual(AuditEntity.options);
    expect(AUDIT_ENTITIES).toContain("user");
  });
});

describe("session ids", () => {
  it("are stored as the SHA-256 of what the cookie carries", () => {
    // sha256("abc"), the FIPS 180-2 test vector.
    expect(sessionIdOf("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("sessions", () => {
  let t: TestDb;
  let ownerId: string;
  const full = (now: Date) => ({ userId: ownerId, totpVerified: true, ttlMs: 30 * DAY, idleMs: 7 * DAY, now, ip: "192.168.1.20", userAgent: "Firefox" });

  beforeAll(async () => {
    t = await createTestDb();
    ownerId = (await createOwner(t.db, { username: "owner", passwordHash: "hash" }, randomUUID())).id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a session is found by the cookie's id until its idle or absolute end, never by the stored hash", async () => {
    const s = await createSession(t.db, full(T0));
    expect(s.id).toBe(sessionIdOf(s.token));
    expect(s.expiresAt).toEqual(at(30 * DAY));
    const [row] = await t.db.select().from(session).where(eq(session.id, s.id));
    expect(row).toMatchObject({ idleExpiresAt: at(7 * DAY), lastSeenAt: T0, totpVerified: true, failedCodes: 0, ip: "192.168.1.20", userAgent: "Firefox" });

    expect(await findLiveSession(t.db, s.token, at(7 * DAY - 1))).toMatchObject({ id: s.id, userId: ownerId, username: "owner", role: "owner" });
    expect(await findLiveSession(t.db, s.token, at(7 * DAY))).toBeUndefined(); // idle for 7 days exactly
    expect(await findLiveSession(t.db, s.id, T0)).toBeUndefined(); // the hash is not a credential
  });

  it("using a session moves its idle end, at most every five minutes and never past the absolute end", async () => {
    const s = await createSession(t.db, full(T0));
    const row = async () => (await t.db.select().from(session).where(eq(session.id, s.id)))[0]!;

    await touchSession(t.db, s.id, at(4 * MINUTE), 7 * DAY); // too soon: nothing written
    expect(await row()).toMatchObject({ lastSeenAt: T0, idleExpiresAt: at(7 * DAY) });
    await touchSession(t.db, s.id, at(5 * MINUTE), 7 * DAY);
    expect(await row()).toMatchObject({ lastSeenAt: at(5 * MINUTE), idleExpiresAt: at(7 * DAY + 5 * MINUTE) });
    // Day 25 + 7 idle days would be day 32: capped at the absolute end, day 30.
    await touchSession(t.db, s.id, at(25 * DAY), 7 * DAY);
    expect(await row()).toMatchObject({ lastSeenAt: at(25 * DAY), idleExpiresAt: at(30 * DAY), expiresAt: at(30 * DAY) });
    expect(await findLiveSession(t.db, s.token, at(30 * DAY))).toBeUndefined();
  });

  it("the fifth wrong code deletes a password-only session", async () => {
    const s = await createSession(t.db, { ...full(T0), totpVerified: false, ttlMs: PENDING_SESSION_MS, idleMs: PENDING_SESSION_MS });
    expect(MAX_FAILED_CODES).toBe(5);
    expect(s.expiresAt).toEqual(at(10 * MINUTE));
    for (let n = 1; n <= 4; n++) expect(await recordFailedCode(t.db, s.id)).toEqual({ failedCodes: n, ended: false });
    expect(await findLiveSession(t.db, s.token, at(MINUTE))).toMatchObject({ totpVerified: false });
    expect(await recordFailedCode(t.db, s.id)).toEqual({ failedCodes: 5, ended: true });
    expect(await findLiveSession(t.db, s.token, at(MINUTE))).toBeUndefined();
    // A request that lost the race finds nothing to count.
    expect(await recordFailedCode(t.db, s.id)).toEqual({ failedCodes: 0, ended: false });
  });

  it("rotation replaces the row under a new id; listing shows live signed-in sessions, most recently used first", async () => {
    await deleteUserSessions(t.db, ownerId);
    const pending = await createSession(t.db, { ...full(T0), totpVerified: false, ttlMs: PENDING_SESSION_MS, idleMs: PENDING_SESSION_MS });
    const rotated = (await rotateSession(t.db, pending.id, full(at(MINUTE))))!;
    expect(rotated.id).not.toBe(pending.id);
    expect(await findLiveSession(t.db, pending.token, at(MINUTE))).toBeUndefined();
    // The old session is gone now: rotating it again issues nothing.
    expect(await rotateSession(t.db, pending.id, full(at(MINUTE)))).toBeNull();
    expect(await t.db.select({ id: session.id }).from(session)).toEqual([{ id: rotated.id }]);
    const older = await createSession(t.db, full(at(-DAY)));
    await createSession(t.db, { ...full(at(-8 * DAY)), userAgent: "idle too long" });
    await createSession(t.db, { ...full(T0), totpVerified: false, ttlMs: PENDING_SESSION_MS, idleMs: PENDING_SESSION_MS });

    const list = await listSessions(t.db, ownerId, at(2 * MINUTE));
    expect(list.map((s) => s.id)).toEqual([rotated.id, older.id]);
    // What is shown as the end is whichever comes first: here the idle end, 7 days after the last use.
    expect(list[0]).toMatchObject({ createdAt: at(MINUTE), lastSeenAt: at(MINUTE), expiresAt: at(MINUTE + 7 * DAY), ip: "192.168.1.20", userAgent: "Firefox" });
  });

  it("purging removes sessions past either end and keeps the rest; one member's sessions can be ended alone", async () => {
    const [viewer] = await t.db.insert(user).values({ username: "sam", passwordHash: "hash", role: "viewer" }).returning({ id: user.id });
    await deleteUserSessions(t.db, ownerId);
    const live = await createSession(t.db, full(T0));
    await createSession(t.db, full(at(-31 * DAY))); // past its absolute end
    await createSession(t.db, full(at(-8 * DAY))); // idle too long
    await createSession(t.db, { ...full(at(-11 * MINUTE)), totpVerified: false, ttlMs: PENDING_SESSION_MS, idleMs: PENDING_SESSION_MS }); // an abandoned password-only one
    const sams = await createSession(t.db, { ...full(at(-8 * DAY)), userId: viewer!.id });

    expect(await purgeExpiredSessions(t.db, T0, ownerId)).toBe(3);
    expect((await t.db.select({ id: session.id }).from(session)).map((r) => r.id).sort()).toEqual([live.id, sams.id].sort());
    expect(await purgeExpiredSessions(t.db, T0)).toBe(1); // Sam's, when purging for everyone
    expect(await deleteOwnSession(t.db, viewer!.id, live.id)).toBe(false); // not Sam's to end
    expect(await deleteOwnSession(t.db, ownerId, live.id)).toBe(true);
    expect(await t.db.select().from(session)).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("members and authenticator steps", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates exactly one owner however many setups run at once", async () => {
    const results = await Promise.allSettled(["alice", "bob", "carol", "dave"].map((username) => createOwner(t.db, { username, passwordHash: "hash" }, randomUUID())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as PlanError);
    expect(refused).toHaveLength(3);
    for (const e of refused) expect(e).toMatchObject({ name: "PlanError", status: 403, code: "already_setup" });
    expect(await t.db.select({ role: user.role }).from(user)).toEqual([{ role: "owner" }]);
  });

  it("takes an authenticator step once, and only a later one after it", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user);
    // Step 59_900_000 is 2026-12-10 (59_900_000 x 30 s after the epoch); the numbers only need to be ordered.
    expect(await acceptTotpStep(t.db, owner!.id, 59_900_000)).toBe(true);
    expect(await acceptTotpStep(t.db, owner!.id, 59_900_000)).toBe(false); // the same code again
    expect(await acceptTotpStep(t.db, owner!.id, 59_899_999)).toBe(false); // the previous code, still inside the tolerance
    expect(await acceptTotpStep(t.db, owner!.id, 59_900_001)).toBe(true);
    // Two requests carrying one code: one wins.
    const race = await Promise.all([1, 2, 3].map(() => acceptTotpStep(t.db, owner!.id, 59_900_002)));
    expect(race.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a viewer whose name differs only by case", async () => {
    const [owner] = await t.db.select({ id: user.id, username: user.username }).from(user);
    const ctx = { userId: owner!.id, batchId: randomUUID() };
    await createViewer(t.db, { username: "Sam", passwordHash: "hash" }, ctx);
    await expect(createViewer(t.db, { username: "sAM", passwordHash: "hash" }, ctx)).rejects.toMatchObject({ status: 409, code: "username_taken" });
    await expect(createViewer(t.db, { username: owner!.username.toUpperCase(), passwordHash: "hash" }, ctx)).rejects.toMatchObject({ status: 409, code: "username_taken" });
    expect(await t.db.select().from(user)).toHaveLength(2);
  });

  it("creates one of two viewers whose names differ only by case when both are added at once (audit a2-auth-users N1)", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user).where(eq(user.role, "owner"));
    const ctx = { userId: owner!.id, batchId: randomUUID() };
    // Ten pairs, each sent together. Before the fix both of a pair were created in most of them.
    for (let i = 0; i < 10; i++) {
      const pair = await Promise.allSettled([`PatN${i}`, `patN${i}`].map((username) => createViewer(t.db, { username, passwordHash: "hash" }, ctx)));
      expect(pair.filter((r) => r.status === "fulfilled"), `pair ${i}`).toHaveLength(1);
      const refused = pair.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as PlanError);
      expect(refused, `pair ${i}`).toHaveLength(1);
      expect(refused[0], `pair ${i}`).toMatchObject({ name: "PlanError", status: 409, code: "username_taken" });
    }
    const names = (await t.db.select({ username: user.username }).from(user)).map((u) => u.username.toLowerCase()).filter((n) => n.startsWith("patn"));
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(10);
    await t.db.delete(user).where(sql`lower(${user.username}) like 'patn%'`);
  });

  it("answers 409 username_taken when the name's unique index refuses the insert, which drizzle-orm wraps (decision 120)", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user).where(eq(user.role, "owner"));
    const ctx = { userId: owner!.id, batchId: randomUUID() };
    // A writer that takes no member lock adds "Robin" and keeps its transaction open: the
    // case-blind check cannot see the uncommitted row, so createViewer's insert waits on the
    // unique index and fails with 23505 once the other commits. drizzle-orm 0.44 and later throw
    // that as a DrizzleQueryError whose cause is the PostgresError carrying the code.
    let inserted!: () => void;
    let commit!: () => void;
    const rowWritten = new Promise<void>((resolve) => (inserted = resolve));
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    const other = t.client.begin(async (tx) => {
      await tx`insert into "user" (username, password_hash, role) values ('Robin', 'hash', 'viewer')`;
      inserted();
      await mayCommit;
    });
    try {
      await rowWritten;
      const outcome = createViewer(t.db, { username: "Robin", passwordHash: "hash" }, ctx).then(
        () => "created",
        (error: unknown) => error,
      );
      // Commit only once createViewer's insert waits on the other's row, so its check has run.
      for (let tries = 0; ; tries++) {
        const [waiting] = await t.client<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into "user"%'`;
        if (waiting!.n > 0) break;
        if (tries > 500) throw new Error("createViewer's insert never waited on the other transaction");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      commit();
      await other;
      expect(await outcome).toMatchObject({ name: "PlanError", status: 409, code: "username_taken" });
      expect(await t.db.select({ id: user.id }).from(user).where(eq(user.username, "Robin"))).toHaveLength(1);
    } finally {
      commit();
      await other.catch(() => {});
      await t.db.delete(user).where(eq(user.username, "Robin"));
    }
  });

  it("keeps sign-in activity newest first, counts the failures of the last 7 days, and drops what is older than 90 days", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user);
    const [sam] = await t.db.select({ id: user.id }).from(user).where(eq(user.username, "Sam"));
    const event = (userId: string, username: string, kind: "signed_in" | "password_failed" | "code_failed" | "code_lockout") => recordSignInEvent(t.db, { userId, username, kind, ip: "192.168.1.20", userAgent: null });
    await event(owner!.id, "owner", "signed_in");
    await event(owner!.id, "owner", "password_failed");
    await event(sam!.id, "Sam", "code_failed");
    await event(sam!.id, "Sam", "code_lockout");
    // Two old rows: a failure 8 days ago (outside the 7-day count) and a sign-in 91 days ago (past retention).
    await t.db.insert(signInEvent).values([
      { at: sql`now() - interval '8 days'`, userId: owner!.id, username: "owner", kind: "code_failed" },
      { at: sql`now() - interval '91 days'`, userId: owner!.id, username: "owner", kind: "signed_in" },
    ]);

    expect((await listSignInEvents(t.db)).map((e) => [e.username, e.kind])).toEqual([
      ["Sam", "code_lockout"],
      ["Sam", "code_failed"],
      ["owner", "password_failed"],
      ["owner", "signed_in"],
      ["owner", "code_failed"],
      ["owner", "signed_in"],
    ]);
    expect((await listSignInEvents(t.db, { userId: sam!.id })).map((e) => e.kind)).toEqual(["code_lockout", "code_failed"]);
    expect(await countFailedSignIns(t.db)).toBe(3); // owner's wrong password, Sam's two codes
    expect(await countFailedSignIns(t.db, { userId: owner!.id })).toBe(1);
    expect(await countFailedSignIns(t.db, { days: 9 })).toBe(4);

    expect(await purgeSignInEvents(t.db)).toBe(1);
    expect(await listSignInEvents(t.db)).toHaveLength(5);
    // Removing a member keeps their history under the name it happened with.
    await t.db.delete(user).where(eq(user.id, sam!.id));
    expect((await listSignInEvents(t.db)).filter((e) => e.username === "Sam")).toHaveLength(2);
  });

  it("counts a wrong current password on a signed-in session as a failed attempt (audit a2-auth-users N2)", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user).where(eq(user.role, "owner"));
    const before = await countFailedSignIns(t.db, { userId: owner!.id });
    await recordSignInEvent(t.db, { userId: owner!.id, username: "owner", kind: "reauth_failed", ip: "192.168.1.20", userAgent: null });
    expect(await countFailedSignIns(t.db, { userId: owner!.id })).toBe(before + 1);
    expect(FAILED_SIGN_IN_KINDS).toEqual(["password_failed", "reauth_failed", "code_failed", "code_lockout", "passkey_failed"]);
  });

  it("keeps a member's last sign-in after the activity that recorded it passes the 90-day retention (audit a2-auth-users N3)", async () => {
    const [owner] = await t.db.select({ id: user.id }).from(user).where(eq(user.role, "owner"));
    const robin = (await createViewer(t.db, { username: "Robin", passwordHash: "hash" }, { userId: owner!.id, batchId: randomUUID() })).id;
    const last = async () => (await getUser(t.db, robin, new Date()))!.lastSignInAt;
    const event = (kind: SignInEventKind) => recordSignInEvent(t.db, { userId: robin, username: "Robin", kind, ip: null, userAgent: null });
    const newest = async (kind: SignInEventKind) => (await listSignInEvents(t.db, { userId: robin })).find((e) => e.kind === kind)!.at;
    expect(await last()).toBeNull();

    await event("signed_in");
    const first = await newest("signed_in");
    expect(await last()).toEqual(first);
    // A failure is not a sign-in.
    await event("password_failed");
    await event("code_failed");
    expect(await last()).toEqual(first);
    await event("passkey_signed_in");
    const latest = await newest("passkey_signed_in");
    expect(latest.getTime()).toBeGreaterThan(first.getTime());
    expect(await last()).toEqual(latest);

    // Ninety-one days on, the activity is gone; the last sign-in is still known, not "never".
    await t.db.update(signInEvent).set({ at: sql`${signInEvent.at} - interval '91 days'` }).where(eq(signInEvent.userId, robin));
    expect(await purgeSignInEvents(t.db)).toBeGreaterThanOrEqual(4);
    expect(await listSignInEvents(t.db, { userId: robin })).toEqual([]);
    expect(await last()).toEqual(latest);
    expect((await listUsers(t.db, new Date())).find((u) => u.id === robin)!.lastSignInAt).toEqual(latest);
  });
});
