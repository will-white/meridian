import { createHash, randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, user } from "@meridian/db";
import type { SessionView, SignInActivity, UserView } from "@meridian/shared";
import {
  createTestApp,
  OWNER_PASSWORD,
  passwordSignIn,
  SECOND,
  sessionCookies,
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
const tokenOf = (t: TestApp, jar: CookieJar) => t.app.unsignCookie(jar["meridian_session"]!).value!;
const accounts = (t: TestApp, jar: CookieJar) => t.app.inject({ method: "GET", url: "/api/accounts", cookies: jar });

const FIRST_PASSWORD = "viewer first password";
const OWN_PASSWORD = "a password sam chose";
const RESET_PASSWORD = "set by the owner again";

describe.skipIf(!TEST_DATABASE_URL)("household members", () => {
  let t: TestApp;
  let clock: TestClock;
  let ownerId: string;
  let samId: string;
  /** Sam's signed-in browser. */
  let sam: CookieJar;
  beforeAll(async () => {
    clock = testClock();
    t = await createTestApp({ authNow: clock.now });
    await signInOwner(t, clock.now);
    ownerId = (await t.db.db.select({ id: user.id }).from(user))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("the owner adds a viewer, who enrolls their own authenticator at first sign-in and can then read but not change", async () => {
    const created = await t.call({ method: "POST", url: "/api/users", payload: { username: "  Sam ", password: FIRST_PASSWORD } });
    expect(created.statusCode).toBe(200);
    const view = created.json() as UserView;
    expect(view).toMatchObject({ username: "Sam", role: "viewer", totpEnrolled: false, lastSignInAt: null, activeSessions: 0 });
    samId = view.id;

    const list = (await t.call({ method: "GET", url: "/api/users" })).json() as UserView[];
    expect(list.map((u) => [u.username, u.role, u.totpEnrolled, u.activeSessions])).toEqual([
      ["owner", "owner", true, 1],
      ["Sam", "viewer", false, 0],
    ]);
    expect(list[0]!.lastSignInAt).not.toBeNull();

    // First sign-in: the password opens nothing but two-factor setup.
    const { res, jar } = await passwordSignIn(t, "Sam", FIRST_PASSWORD, "10.1.0.1");
    expect(res.json()).toEqual({ setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: false, username: "Sam", role: "viewer" });
    const closed = await accounts(t, jar);
    expect(closed.statusCode).toBe(403);
    expect(closed.json().code).toBe("totp_enrollment_required");
    const setup = await t.app.inject({ method: "POST", url: "/api/auth/totp/setup", cookies: jar });
    expect(setup.statusCode).toBe(200);
    const confirm = await t.app.inject({ method: "POST", url: "/api/auth/totp/confirm", cookies: jar, payload: { code: totpCode(setup.json().secret, clock.now()) } });
    expect(confirm.statusCode).toBe(200);
    sam = sessionJar(confirm)!;

    expect((await accounts(t, sam)).statusCode).toBe(200);
    const change = await t.app.inject({ method: "POST", url: "/api/accounts", cookies: sam, payload: { name: "Nope", type: "checking" } });
    expect(change.statusCode).toBe(403);
    expect(change.json().code).toBe("viewer");
    expect((await t.app.inject({ method: "GET", url: "/api/auth/status", cookies: sam })).json()).toMatchObject({ authenticated: true, totpEnrolled: true, username: "Sam", role: "viewer" });
  });

  it("refuses a name already taken in another case, a short password, and any member management by a viewer", async () => {
    const duplicate = await t.call({ method: "POST", url: "/api/users", payload: { username: "sam", password: FIRST_PASSWORD } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("username_taken");
    const short = await t.call({ method: "POST", url: "/api/users", payload: { username: "pat", password: "11 chars..." } });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("validation");
    const blank = await t.call({ method: "POST", url: "/api/users", payload: { username: "   ", password: FIRST_PASSWORD } });
    expect(blank.statusCode).toBe(400);

    for (const req of [
      { method: "GET", url: "/api/users" },
      { method: "POST", url: "/api/users", payload: { username: "pat", password: FIRST_PASSWORD } },
      { method: "DELETE", url: `/api/users/${ownerId}` },
      { method: "POST", url: `/api/users/${ownerId}/password`, payload: { password: "taking over the owner" } },
      { method: "POST", url: `/api/users/${ownerId}/totp/reset` },
    ] as const) {
      const res = await t.app.inject({ ...req, cookies: sam });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
      expect(res.json().code, `${req.method} ${req.url}`).toBe("owner_only");
    }
    expect(await t.db.db.select({ username: user.username }).from(user).orderBy(asc(user.createdAt))).toEqual([{ username: "owner" }, { username: "Sam" }]);
  });

  it("shows a viewer their own sign-in activity and the owner everyone's", async () => {
    const own = (await t.app.inject({ method: "GET", url: "/api/auth/activity", cookies: sam })).json() as SignInActivity;
    expect(own.items.map((e) => [e.username, e.kind])).toEqual([["Sam", "signed_in"]]);
    const all = (await t.call({ method: "GET", url: "/api/auth/activity" })).json() as SignInActivity;
    expect(all.items.map((e) => [e.username, e.kind])).toEqual([
      ["Sam", "signed_in"],
      ["owner", "signed_in"],
    ]);
    expect(all.failedLast7Days).toBe(0);
  });

  it("lets a viewer change their own password: the current one is required, their other sessions end, this one continues under a new id", async () => {
    const other = await sessionCookies(t, samId); // Sam's phone
    const change = (payload: unknown, jar = sam) => t.app.inject({ method: "POST", url: "/api/auth/password", cookies: jar, payload: payload as object });

    const wrong = await change({ currentPassword: "not the password", newPassword: OWN_PASSWORD });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe("wrong_password");
    const same = await change({ currentPassword: FIRST_PASSWORD, newPassword: FIRST_PASSWORD });
    expect(same.statusCode).toBe(400);
    expect(same.json().code).toBe("same_password");
    expect((await accounts(t, other)).statusCode).toBe(200);

    const ok = await change({ currentPassword: FIRST_PASSWORD, newPassword: OWN_PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ revoked: 1 });
    const fresh = sessionJar(ok)!;
    expect(tokenOf(t, fresh)).not.toBe(tokenOf(t, sam));
    expect((await accounts(t, other)).statusCode).toBe(401);
    expect((await accounts(t, sam)).statusCode).toBe(401);
    expect((await accounts(t, fresh)).statusCode).toBe(200);
    sam = fresh;

    expect((await passwordSignIn(t, "Sam", FIRST_PASSWORD, "10.1.0.2")).res.statusCode).toBe(401);
    expect((await passwordSignIn(t, "Sam", OWN_PASSWORD, "10.1.0.3")).res.json()).toMatchObject({ totpRequired: true, totpEnrolled: true });
  });

  it("answers a replacement code with nothing to replace, also for a viewer", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/auth/totp/replace/confirm", cookies: sam, payload: { code: "123456" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("totp_replace_not_started");
  });

  it("lets the owner set a new password for a viewer and clear their second factor; both sign the viewer out", async () => {
    clock.advance(SECOND);
    const reset = await t.call({ method: "POST", url: `/api/users/${samId}/password`, payload: { password: RESET_PASSWORD } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ username: "Sam", totpEnrolled: true, activeSessions: 0 });
    expect((await accounts(t, sam)).statusCode).toBe(401);
    expect((await passwordSignIn(t, "Sam", OWN_PASSWORD, "10.1.0.4")).res.statusCode).toBe(401);
    const half = await passwordSignIn(t, "Sam", RESET_PASSWORD, "10.1.0.5");
    expect(half.res.json()).toMatchObject({ totpRequired: true, totpEnrolled: true });

    const cleared = await t.call({ method: "POST", url: `/api/users/${samId}/totp/reset` });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ username: "Sam", totpEnrolled: false, activeSessions: 0 });
    // The half-signed-in browser is out too; the next sign-in starts enrollment again with a new secret.
    expect((await t.app.inject({ method: "GET", url: "/api/auth/status", cookies: half.jar })).json()).toMatchObject({ authenticated: false, totpRequired: false });
    const again = await passwordSignIn(t, "Sam", RESET_PASSWORD, "10.1.0.6");
    expect(again.res.json()).toMatchObject({ authenticated: true, totpEnrolled: false });
    const [row] = await t.db.db.select({ secret: user.totpSecretEnc, confirmedAt: user.totpConfirmedAt, lastStep: user.totpLastStep }).from(user).where(eq(user.id, samId));
    expect(row).toEqual({ secret: null, confirmedAt: null, lastStep: null });
  });

  it("does not let the owner's own account be changed or removed through member management", async () => {
    const password = await t.call({ method: "POST", url: `/api/users/${ownerId}/password`, payload: { password: RESET_PASSWORD } });
    expect([password.statusCode, password.json().code]).toEqual([400, "use_change_password"]);
    const totp = await t.call({ method: "POST", url: `/api/users/${ownerId}/totp/reset` });
    expect([totp.statusCode, totp.json().code]).toEqual([400, "use_replace_authenticator"]);
    const remove = await t.call({ method: "DELETE", url: `/api/users/${ownerId}` });
    expect([remove.statusCode, remove.json().code]).toEqual([400, "cannot_remove_owner"]);
    const missing = await t.call({ method: "DELETE", url: `/api/users/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);
  });

  it("removes a viewer: their session ends, they cannot sign in, and every step is in the audit log without a secret", async () => {
    const jar = await sessionCookies(t, samId);
    const removed = await t.call({ method: "DELETE", url: `/api/users/${samId}` });
    expect(removed.statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/auth/status", cookies: jar })).json()).toMatchObject({ authenticated: false });
    const signIn = await passwordSignIn(t, "Sam", RESET_PASSWORD, "10.1.0.7");
    expect(signIn.res.statusCode).toBe(401);
    expect(signIn.res.json().code).toBe("bad_credentials");
    expect(((await t.call({ method: "GET", url: "/api/users" })).json() as UserView[]).map((u) => u.username)).toEqual(["owner"]);

    const rows = await t.db.db.select().from(auditLog).where(eq(auditLog.entity, "user")).orderBy(asc(auditLog.at));
    expect(rows.map((a) => [a.entityId === ownerId ? "owner" : "Sam", a.action])).toEqual([
      ["owner", "create"], // first-run setup
      ["owner", "update"], // enrolled two-factor
      ["Sam", "create"],
      ["Sam", "update"], // enrolled two-factor
      ["Sam", "update"], // changed their password
      ["Sam", "update"], // the owner set a password
      ["Sam", "update"], // the owner cleared two-factor
      ["Sam", "delete"],
    ]);
    expect(rows[2]!.after).toMatchObject({ username: "Sam", role: "viewer", totpConfirmedAt: null });
    expect(rows[7]!.before).toMatchObject({ username: "Sam", role: "viewer", totpConfirmedAt: null });
    expect(JSON.stringify(rows)).not.toMatch(/argon2|passwordHash|totpSecret/i);

    const viaApi = await t.call({ method: "GET", url: "/api/audit?entity=user&limit=3" });
    expect(viaApi.statusCode).toBe(200);
    expect((viaApi.json() as { items: { entity: string; action: string }[] }).items.map((i) => [i.entity, i.action])).toEqual([
      ["user", "delete"],
      ["user", "update"],
      ["user", "update"],
    ]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("the owner's own sign-in", () => {
  let t: TestApp;
  let clock: TestClock;
  let secret: string;
  let ownerId: string;
  beforeAll(async () => {
    clock = testClock();
    t = await createTestApp({ authNow: clock.now });
    secret = await signInOwner(t, clock.now);
    ownerId = (await t.db.db.select({ id: user.id }).from(user))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists the owner's sessions by a hash, signs one out, then all the others", async () => {
    clock.advance(SECOND);
    const laptop = await sessionCookies(t, ownerId, { now: clock.now() });
    clock.advance(SECOND);
    const phone = await sessionCookies(t, ownerId, { now: clock.now() });
    await sessionCookies(t, ownerId, { totpVerified: false, now: clock.now() }); // a password-only session is not a place you are signed in

    const list = (await t.call({ method: "GET", url: "/api/auth/sessions" })).json() as SessionView[];
    // Most recently used first.
    expect(list.map((s) => s.id)).toEqual([phone, laptop, t.cookies].map((jar) => sha256(tokenOf(t, jar))));
    expect(list.map((s) => s.current)).toEqual([false, false, true]);
    expect(JSON.stringify(list)).not.toContain(tokenOf(t, t.cookies));

    const one = await t.call({ method: "DELETE", url: `/api/auth/sessions/${sha256(tokenOf(t, phone))}` });
    expect(one.statusCode).toBe(200);
    expect((await accounts(t, phone)).statusCode).toBe(401);
    expect((await t.call({ method: "DELETE", url: `/api/auth/sessions/${sha256("no such session")}` })).statusCode).toBe(404);
    // The cookie's own id is not a name for a session.
    expect((await t.call({ method: "DELETE", url: `/api/auth/sessions/${tokenOf(t, laptop)}` })).statusCode).toBe(404);
    expect((await t.call({ method: "DELETE", url: "/api/auth/sessions/not-a-session-id" })).statusCode).toBe(400);

    const others = await t.call({ method: "POST", url: "/api/auth/sessions/revoke-others" });
    expect(others.json()).toEqual({ revoked: 2 }); // the laptop and the password-only one
    expect((await accounts(t, laptop)).statusCode).toBe(401);
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);
  });

  it("does not let one member sign another member's session out", async () => {
    const [viewer] = await t.db.db.insert(user).values({ username: "sam", passwordHash: "never-verified", role: "viewer", totpConfirmedAt: new Date() }).returning({ id: user.id });
    const sam = await sessionCookies(t, viewer!.id, { now: clock.now() });
    const res = await t.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sha256(tokenOf(t, t.cookies))}`, cookies: sam });
    expect(res.statusCode).toBe(404);
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);
    // Their own, they can.
    expect((await t.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sha256(tokenOf(t, sam))}`, cookies: sam })).statusCode).toBe(200);
    expect((await accounts(t, sam)).statusCode).toBe(401);
  });

  it("replaces the authenticator: the old one works until a code from the new one is proven, then only the new one does", async () => {
    const wrong = await t.call({ method: "POST", url: "/api/auth/totp/replace", payload: { password: "not the password" } });
    expect([wrong.statusCode, wrong.json().code]).toEqual([403, "wrong_password"]);
    const start = await t.call({ method: "POST", url: "/api/auth/totp/replace", payload: { password: OWNER_PASSWORD } });
    expect(start.statusCode).toBe(200);
    const next = start.json().secret as string;
    expect(next).not.toBe(secret);
    expect(start.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\/Meridian:owner\?/);

    // Nothing has changed yet: a sign-in still takes the old authenticator's code.
    clock.advance(30 * SECOND);
    const phone = await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.2.0.1");
    const viaOld = await t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: "10.2.0.1", cookies: phone.jar, payload: { code: totpCode(secret, clock.now()) } });
    expect(viaOld.statusCode).toBe(200);
    const phoneSession = sessionJar(viaOld)!;

    const bad = await t.call({ method: "POST", url: "/api/auth/totp/replace/confirm", payload: { code: wrongTotpCode(next, clock.now()) } });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "bad_totp"]);
    const done = await t.call({ method: "POST", url: "/api/auth/totp/replace/confirm", payload: { code: totpCode(next, clock.now()) } });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ revoked: 1 }); // the phone
    expect((await accounts(t, phoneSession)).statusCode).toBe(401);
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);

    clock.advance(30 * SECOND);
    const again = await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.2.0.2");
    const old = await t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: "10.2.0.2", cookies: again.jar, payload: { code: totpCode(secret, clock.now()) } });
    expect([old.statusCode, old.json().code]).toEqual([401, "bad_totp"]);
    const fresh = await t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: "10.2.0.2", cookies: again.jar, payload: { code: totpCode(next, clock.now()) } });
    expect(fresh.statusCode).toBe(200);
  });
});
