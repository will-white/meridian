import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, user } from "@meridian/db";
import {
  createTestApp,
  DAY,
  MINUTE,
  OWNER_PASSWORD,
  passwordSignIn,
  SECOND,
  sessionJar,
  signInOwner,
  TEST_DATABASE_URL,
  testClock,
  totpCode,
  wrongTotpCode,
  type CookieJar,
  type TestApp,
  type TestClock,
} from "./test/helpers.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The session id inside a signed cookie value. */
const tokenOf = (t: TestApp, jar: CookieJar) => t.app.unsignCookie(jar["meridian_session"]!).value!;
const verify = (t: TestApp, jar: CookieJar, code: string, address = "127.0.0.1") =>
  t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: address, cookies: jar, payload: { code } });
const accounts = (t: TestApp, jar: CookieJar) => t.app.inject({ method: "GET", url: "/api/accounts", cookies: jar });

describe.skipIf(!TEST_DATABASE_URL)("an authenticator code is accepted once", () => {
  let t: TestApp;
  let clock: TestClock;
  let secret: string;
  beforeAll(async () => {
    clock = testClock();
    t = await createTestApp({ authNow: clock.now });
    secret = await signInOwner(t, clock.now); // enrollment accepted the code of step S
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("refuses the code that completed enrollment when it is sent again for a sign-in", async () => {
    const { jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD);
    const again = await verify(t, jar, totpCode(secret, clock.now()));
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe("bad_totp");
    expect((await accounts(t, jar)).json().code).toBe("totp_required");
  });

  it("accepts the next code once, and refuses it in a second sign-in 0 seconds later", async () => {
    clock.advance(30 * SECOND); // step S+1
    const code = totpCode(secret, clock.now());
    const first = await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.0.0.1");
    const ok = await verify(t, first.jar, code, "10.0.0.1");
    expect(ok.statusCode).toBe(200);
    expect((await accounts(t, sessionJar(ok)!)).statusCode).toBe(200);

    // Someone who watched the password and the code being typed signs in from another device.
    const second = await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.0.0.2");
    const replay = await verify(t, second.jar, code, "10.0.0.2");
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("bad_totp");
    expect((await accounts(t, second.jar)).statusCode).toBe(401);

    // An older code is still inside the one-step tolerance, but its step is not after the last accepted one.
    const older = await verify(t, second.jar, totpCode(secret, clock.now().getTime() - 30 * SECOND), "10.0.0.2");
    expect(older.statusCode).toBe(401);

    clock.advance(30 * SECOND); // step S+2: a fresh code works
    const fresh = await verify(t, second.jar, totpCode(secret, clock.now()), "10.0.0.2");
    expect(fresh.statusCode).toBe(200);
    expect((await accounts(t, sessionJar(fresh)!)).statusCode).toBe(200);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("wrong authenticator codes", () => {
  let t: TestApp;
  let clock: TestClock;
  let secret: string;
  beforeAll(async () => {
    clock = testClock();
    t = await createTestApp({ authNow: clock.now });
    secret = await signInOwner(t, clock.now);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("end the password session at the fifth: the password has to be entered again", async () => {
    clock.advance(30 * SECOND);
    const { jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.0.1.1");
    const wrong = wrongTotpCode(secret, clock.now());
    for (let i = 1; i <= 4; i++) {
      const res = await verify(t, jar, wrong, `10.0.1.${i}`);
      expect(res.statusCode, `wrong code ${i}`).toBe(401);
      expect(res.json().code, `wrong code ${i}`).toBe("bad_totp");
    }
    const fifth = await verify(t, jar, wrong, "10.0.1.5");
    expect(fifth.statusCode).toBe(401);
    expect(fifth.json().code).toBe("sign_in_again");
    expect(await t.db.db.select().from(session).where(eq(session.id, sha256(tokenOf(t, jar))))).toEqual([]);

    // The right code no longer helps: that session is gone.
    const late = await verify(t, jar, totpCode(secret, clock.now()), "10.0.1.6");
    expect(late.statusCode).toBe(401);
    expect(late.json().code).toBe("unauthorized");
  });

  it("are listed for the owner, newest first, with the count of failures in the last 7 days", async () => {
    await t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.0.1.9", headers: { "user-agent": "Probe/1.0" }, payload: { username: "owner", password: "not the password" } });
    // An unknown username is not recorded (what was typed there may be a password).
    await t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.0.1.9", payload: { username: "hunter2-typed-in-the-wrong-box", password: "x" } });

    const res = await t.call({ method: "GET", url: "/api/auth/activity" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { username: string; kind: string; ip: string | null; userAgent: string | null }[]; failedLast7Days: number };
    expect(body.items.map((e) => e.kind)).toEqual(["password_failed", "code_lockout", "code_failed", "code_failed", "code_failed", "code_failed", "signed_in"]);
    expect(body.items.every((e) => e.username === "owner")).toBe(true);
    expect(body.items[0]).toMatchObject({ ip: "10.0.1.9", userAgent: "Probe/1.0" });
    expect(body.items[1]).toMatchObject({ ip: "10.0.1.5" });
    // 1 wrong password + 4 wrong codes + the one that ended the session.
    expect(body.failedLast7Days).toBe(6);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("session lifetime", () => {
  let t: TestApp;
  let clock: TestClock;
  let secret: string;
  let ownerId: string;
  beforeAll(async () => {
    clock = testClock();
    t = await createTestApp({ authNow: clock.now, config: { sessionTtlDays: 30, sessionIdleDays: 7 } });
    secret = await signInOwner(t, clock.now);
    ownerId = (await t.db.db.select({ id: user.id }).from(user))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const rows = () => t.db.db.select().from(session).where(eq(session.userId, ownerId));
  /** HTTP cookie dates carry whole seconds. */
  const wholeSeconds = (ms: number) => Math.floor(ms / 1000) * 1000;

  it("stores a SHA-256 of the session id, never the id the cookie carries", async () => {
    const token = tokenOf(t, t.cookies);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = (await rows()).map((r) => r.id);
    expect(stored).toEqual([sha256(token)]);
    expect(stored).not.toContain(token);
  });

  it("gives a password-only session ten minutes, and a new id with the full lifetime once the code is accepted", async () => {
    clock.advance(30 * SECOND);
    const start = clock.now().getTime();
    const { res, jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD);
    const cookie = res.cookies.find((c) => c.name === "meridian_session")!;
    expect(cookie.expires!.getTime()).toBe(wholeSeconds(start + 10 * MINUTE));
    const [pending] = await t.db.db.select().from(session).where(eq(session.id, sha256(tokenOf(t, jar))));
    expect(pending).toMatchObject({ totpVerified: false });
    expect(pending!.expiresAt.getTime()).toBe(start + 10 * MINUTE);

    const ok = await verify(t, jar, totpCode(secret, clock.now()));
    expect(ok.statusCode).toBe(200);
    const fresh = sessionJar(ok)!;
    expect(tokenOf(t, fresh)).not.toBe(tokenOf(t, jar));
    expect(ok.cookies.find((c) => c.name === "meridian_session")!.expires!.getTime()).toBe(wholeSeconds(start + 30 * DAY));
    // The id issued after the password alone never becomes a signed-in session.
    expect((await accounts(t, jar)).statusCode).toBe(401);
    expect(await t.db.db.select().from(session).where(eq(session.id, sha256(tokenOf(t, jar))))).toEqual([]);
    expect((await accounts(t, fresh)).statusCode).toBe(200);
    const [full] = await t.db.db.select().from(session).where(eq(session.id, sha256(tokenOf(t, fresh))));
    expect(full).toMatchObject({ totpVerified: true });
    expect(full!.expiresAt.getTime()).toBe(start + 30 * DAY);
  });

  it("refuses the right code on a password-only session older than ten minutes", async () => {
    clock.advance(30 * SECOND);
    const { jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD);
    clock.advance(10 * MINUTE + SECOND);
    const late = await verify(t, jar, totpCode(secret, clock.now()));
    expect(late.statusCode).toBe(401);
    expect(late.json().code).toBe("unauthorized");
  });

  it("ends a session after 7 idle days, and after 30 days however often it is used", async () => {
    clock.advance(30 * SECOND);
    const idle = sessionJar(await verify(t, (await passwordSignIn(t, "owner", OWNER_PASSWORD)).jar, totpCode(secret, clock.now())))!;
    clock.advance(30 * SECOND);
    const busy = sessionJar(await verify(t, (await passwordSignIn(t, "owner", OWNER_PASSWORD)).jar, totpCode(secret, clock.now())))!;

    // Used every 6 days: days 6, 12, 18 and 24 are fine.
    for (const day of [6, 12, 18, 24]) {
      clock.advance(6 * DAY);
      expect((await accounts(t, busy)).statusCode, `day ${day}`).toBe(200);
    }
    // Never used since day 0: gone (7 idle days passed long ago).
    expect((await accounts(t, idle)).statusCode).toBe(401);
    // Day 30: the absolute lifetime is over although the last use was 6 days ago.
    clock.advance(6 * DAY);
    expect((await accounts(t, busy)).statusCode).toBe(401);
  });

  it("removes that user's expired sessions when they sign in", async () => {
    // Everything above has expired by now (the clock is past day 30); one password sign-in leaves one row.
    expect((await rows()).length).toBeGreaterThan(1);
    const { jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD);
    expect((await rows()).map((r) => r.id)).toEqual([sha256(tokenOf(t, jar))]);
  });

  it("deletes the session on sign-out", async () => {
    const { jar } = await passwordSignIn(t, "owner", OWNER_PASSWORD);
    const full = sessionJar(await verify(t, jar, totpCode(secret, clock.now())))!;
    const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", cookies: full });
    expect(out.statusCode).toBe(200);
    expect(await t.db.db.select().from(session).where(eq(session.id, sha256(tokenOf(t, full))))).toEqual([]);
    expect((await accounts(t, full)).statusCode).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("first-run setup", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates one owner when three setup requests arrive together", async () => {
    const results = await Promise.all(
      ["alice", "bob", "carol"].map((username) => t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username, password: OWNER_PASSWORD } })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403, 403]);
    expect(results.filter((r) => r.statusCode === 403).map((r) => r.json().code)).toEqual(["already_setup", "already_setup"]);
    const users = await t.db.db.select({ username: user.username, role: user.role }).from(user);
    expect(users).toHaveLength(1);
    expect(users[0]!.role).toBe("owner");
    // The account that exists is the one whose request was answered 200.
    const winner = results.find((r) => r.statusCode === 200)!.json() as { username: string };
    expect(users[0]!.username).toBe(winner.username);
  });
});
