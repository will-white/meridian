import type { InjectOptions } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, passkey, user, webauthnChallenge } from "@meridian/db";
import { createTestApp, OWNER_PASSWORD, passwordSignIn, signInOwner, totpCode, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";
import { SoftPasskey } from "./test/passkey.js";

/** The page's origin (the inject host is localhost:80). */
const ORIGIN = "http://localhost";
const withOrigin = (opts: InjectOptions, origin = ORIGIN): InjectOptions => ({ ...opts, headers: { ...(opts.headers ?? {}), origin } });

/**
 * Audit a10-conformance-ledger-09 (spec, Security and backups: "local login with Argon2id-hashed
 * password plus TOTP; optional passkeys"): a member adds passkeys under Settings and signs in
 * with one; the answer is checked against this host, the challenge, user verification, the
 * stored key and its counter; password and code stay.
 */
describe.skipIf(!TEST_DATABASE_URL)("passkeys (audit a10-conformance-ledger-09)", () => {
  let t: TestApp;
  const key = new SoftPasskey();

  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const addPasskey = async (authenticator: SoftPasskey, name: string, call = t.call, origin = ORIGIN, password = OWNER_PASSWORD) => {
    const options = await call(withOrigin({ method: "POST", url: "/api/auth/passkeys/options", payload: { password } }, origin));
    expect(options.statusCode).toBe(200);
    const { challengeId, options: creation } = options.json() as { challengeId: string; options: { challenge: string; rp: { id: string }; user: { id: string } } };
    return call(withOrigin({ method: "POST", url: "/api/auth/passkeys", payload: { challengeId, name, response: authenticator.register(creation, { origin }) } }, origin));
  };
  const signInWith = async (authenticator: SoftPasskey, opts: Parameters<SoftPasskey["answer"]>[1] = { origin: ORIGIN }) => {
    const res = await t.app.inject(withOrigin({ method: "POST", url: "/api/auth/passkey/options", payload: {} }));
    expect(res.statusCode).toBe(200);
    const { challengeId, options } = res.json() as { challengeId: string; options: { challenge: string; rpId: string } };
    const answer = authenticator.answer(options, opts);
    return { challengeId, answer, res: await t.app.inject(withOrigin({ method: "POST", url: "/api/auth/passkey/verify", payload: { challengeId, response: answer } })) };
  };

  it("adds a passkey only with the password, verified against this host and its challenge", async () => {
    const wrong = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys/options", payload: { password: "not the password" } }));
    expect([wrong.statusCode, wrong.json().code]).toEqual([403, "wrong_password"]);
    // Options name this host and ask for a discoverable credential with user verification.
    const options = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys/options", payload: { password: OWNER_PASSWORD } }));
    expect(options.json().options).toMatchObject({ rp: { id: "localhost", name: "Meridian" }, user: { name: "owner" }, authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none" });
    // An answer made on another site is refused, and its challenge is spent.
    const { challengeId, options: creation } = options.json();
    const phished = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys", payload: { challengeId, name: "Phone", response: key.register(creation, { origin: "https://evil.example" }) } }));
    expect([phished.statusCode, phished.json().code]).toEqual([400, "passkey_not_verified"]);
    const again = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys", payload: { challengeId, name: "Phone", response: key.register(creation, { origin: ORIGIN }) } }));
    expect([again.statusCode, again.json().code]).toEqual([400, "passkey_challenge"]);
    // An authenticator that did not verify the user is refused.
    const unverified = new SoftPasskey();
    const noUv = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys/options", payload: { password: OWNER_PASSWORD } }));
    const refused = await t.call(withOrigin({ method: "POST", url: "/api/auth/passkeys", payload: { challengeId: noUv.json().challengeId, name: "Key", response: unverified.register(noUv.json().options, { origin: ORIGIN, userVerified: false }) } }));
    expect([refused.statusCode, refused.json().code]).toEqual([400, "passkey_not_verified"]);

    const added = await addPasskey(key, "Phone");
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ name: "Phone", lastUsedAt: null });
    expect((await t.call({ method: "GET", url: "/api/auth/passkeys" })).json()).toEqual([expect.objectContaining({ name: "Phone" })]);
    // The same authenticator cannot be added twice.
    expect((await addPasskey(key, "Phone again")).statusCode).toBe(409);
    // A request without the page's origin, or from another host, is refused before anything is asked.
    expect((await t.call({ method: "POST", url: "/api/auth/passkeys/options", payload: { password: OWNER_PASSWORD } })).json().code).toBe("origin_required");
    expect((await t.call({ method: "POST", url: "/api/auth/passkeys/options", payload: { password: OWNER_PASSWORD }, headers: { origin: "http://evil.example", "sec-fetch-site": "same-origin" } })).json().code).toBe("cross_site_request");
    // Audited by name, never with a key.
    const audit = await t.db.db.select().from(auditLog).where(eq(auditLog.entity, "user"));
    expect(audit.some((a) => JSON.stringify(a.after) === JSON.stringify({ passkeys: ["Phone"] }))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(key.id);
  });

  it("signs in with the passkey alone: a signed-in session, recorded as such", async () => {
    const { res } = await signInWith(key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" });
    const cookie = res.cookies.find((c) => c.name === "meridian_session")!;
    const accounts = await t.app.inject({ method: "GET", url: "/api/accounts", cookies: { meridian_session: cookie.value } });
    expect(accounts.statusCode).toBe(200);
    const activity = await t.call({ method: "GET", url: "/api/auth/activity" });
    expect(activity.json().items[0]).toMatchObject({ kind: "passkey_signed_in", username: "owner" });
    expect((await t.call({ method: "GET", url: "/api/auth/passkeys" })).json()[0].lastUsedAt).not.toBeNull();
  });

  it("refuses a replayed answer, a forged signature, a counter that goes back, no user verification, another site and an unknown passkey", async () => {
    const first = await signInWith(key);
    expect(first.res.statusCode).toBe(200);
    // The same answer again: its challenge is spent.
    const replay = await t.app.inject(withOrigin({ method: "POST", url: "/api/auth/passkey/verify", payload: { challengeId: first.challengeId, response: first.answer } }));
    expect([replay.statusCode, replay.json().code]).toEqual([401, "passkey_challenge"]);
    const forged = await signInWith(key, { origin: ORIGIN, tamper: true });
    expect([forged.res.statusCode, forged.res.json().code]).toEqual([401, "passkey_not_verified"]);
    const cloned = await signInWith(key, { origin: ORIGIN, counter: 1 });
    expect([cloned.res.statusCode, cloned.res.json().code]).toEqual([401, "passkey_not_verified"]);
    const noUv = await signInWith(key, { origin: ORIGIN, userVerified: false, counter: 50 });
    expect([noUv.res.statusCode, noUv.res.json().code]).toEqual([401, "passkey_not_verified"]);
    const otherSite = await signInWith(key, { origin: "https://evil.example" });
    expect([otherSite.res.statusCode, otherSite.res.json().code]).toEqual([401, "passkey_not_verified"]);
    const otherMember = await signInWith(key, { origin: ORIGIN, userHandle: Buffer.from("someone else").toString("base64url") });
    expect([otherMember.res.statusCode, otherMember.res.json().code]).toEqual([401, "passkey_not_verified"]);
    const stranger = await signInWith(new SoftPasskey());
    expect([stranger.res.statusCode, stranger.res.json().code]).toEqual([401, "passkey_unknown"]);
    // Each failed answer from a member's passkey is on record; the unknown one names no one.
    const activity = (await t.call({ method: "GET", url: "/api/auth/activity" })).json() as { items: Array<{ kind: string }>; failedLast7Days: number };
    expect(activity.items.filter((e) => e.kind === "passkey_failed")).toHaveLength(5);
    expect(activity.failedLast7Days).toBeGreaterThanOrEqual(5);
    // Every prompt is gone once answered.
    expect(await t.db.db.select().from(webauthnChallenge)).toHaveLength(0);
  });

  it("a removed passkey no longer signs in; clearing a member's second factor removes their passkeys", async () => {
    const [stored] = await t.db.db.select().from(passkey);
    expect((await t.call({ method: "DELETE", url: `/api/auth/passkeys/${stored!.id}` })).statusCode).toBe(200);
    expect((await signInWith(key)).res.json().code).toBe("passkey_unknown");

    // A viewer adds their own passkey; the owner clears the viewer's second factor (a lost phone) and the passkey goes with it.
    await t.call({ method: "POST", url: "/api/users", payload: { username: "sam", password: "a first password for sam" } });
    const signIn = await passwordSignIn(t, "sam", "a first password for sam");
    const viewer = (opts: InjectOptions) => t.app.inject({ ...opts, cookies: { ...jar } });
    let jar = signIn.jar;
    const setup = await viewer({ method: "POST", url: "/api/auth/totp/setup" });
    const confirmed = await viewer({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: totpCode(setup.json().secret) } });
    jar = { meridian_session: confirmed.cookies.find((c) => c.name === "meridian_session")!.value };
    const samKey = new SoftPasskey();
    expect((await addPasskey(samKey, "Sam's phone", viewer, ORIGIN, "a first password for sam")).statusCode).toBe(200);
    expect((await signInWith(samKey)).res.json()).toMatchObject({ authenticated: true, username: "sam", role: "viewer" });
    const [sam] = await t.db.db.select({ id: user.id }).from(user).where(eq(user.username, "sam"));
    expect((await t.call({ method: "POST", url: `/api/users/${sam!.id}/totp/reset` })).statusCode).toBe(200);
    expect(await t.db.db.select().from(passkey).where(eq(passkey.userId, sam!.id))).toHaveLength(0);
    expect((await signInWith(samKey)).res.json().code).toBe("passkey_unknown");
  });

  it("a passkey sign-in before the owner exists is refused, like every sign-in", async () => {
    const fresh = await createTestApp();
    try {
      const res = await fresh.app.inject(withOrigin({ method: "POST", url: "/api/auth/passkey/options", payload: {} }));
      expect([res.statusCode, res.json().code]).toEqual([403, "setup_required"]);
    } finally {
      await fresh.cleanup();
    }
  });
});
