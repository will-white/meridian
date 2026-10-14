import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("auth flow", () => {
  let t: TestApp;
  let secret = "";
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const code = () => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

  it("answers the health check without auth", async () => {
    const res = await t.call({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("starts in setup mode and blocks everything else", async () => {
    const status = await t.call({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ setupRequired: true, authenticated: false, totpRequired: false, totpEnrolled: false });
    const blocked = await t.call({ method: "GET", url: "/api/accounts" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("setup_required");
    const login = await t.call({ method: "POST", url: "/api/auth/login", payload: { username: "x", password: "y" } });
    expect(login.statusCode).toBe(403);
  });

  it("rejects a short password on setup", async () => {
    const res = await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "short" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation");
  });

  it("creates the owner, signs in, and requires TOTP enrollment before the app opens", async () => {
    const res = await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, totpEnrolled: false });
    expect(t.cookies["meridian_session"]).toBeTruthy();
    const again = await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "two", password: "correct horse battery staple" } });
    expect(again.statusCode).toBe(403);
    const blocked = await t.call({ method: "GET", url: "/api/accounts" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("totp_enrollment_required");
  });

  it("enrolls TOTP: wrong code refused, right code accepted", async () => {
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\/Meridian:owner\?/);
    expect(setup.json().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    secret = setup.json().secret;
    const wrong = await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: "000000" } });
    expect(wrong.statusCode).toBe(401);
    const right = await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: code() } });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({ authenticated: true, totpEnrolled: true, totpRequired: false });
    const accounts = await t.call({ method: "GET", url: "/api/accounts" });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json()).toEqual([]);
    const categories = await t.call({ method: "GET", url: "/api/categories" });
    expect(categories.json().length).toBeGreaterThan(10);
  });

  it("logs out, then login needs password and a code", async () => {
    const out = await t.call({ method: "POST", url: "/api/auth/logout" });
    expect(out.statusCode).toBe(200);
    expect(t.cookies["meridian_session"]).toBeUndefined();
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(401);

    const bad = await t.call({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "wrong password here" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("bad_credentials");
    const unknown = await t.call({ method: "POST", url: "/api/auth/login", payload: { username: "nobody", password: "wrong password here" } });
    expect(unknown.statusCode).toBe(401);

    const login = await t.call({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "correct horse battery staple" } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: false, totpRequired: true, totpEnrolled: true });
    const half = await t.call({ method: "GET", url: "/api/accounts" });
    expect(half.statusCode).toBe(401);
    expect(half.json().code).toBe("totp_required");

    const verify = await t.call({ method: "POST", url: "/api/auth/totp/verify", payload: { code: code() } });
    expect(verify.statusCode).toBe(200);
    expect((await t.call({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);
    const status = await t.call({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" });
  });

  it("ignores a forged session cookie", async () => {
    const res = await t.call({ method: "GET", url: "/api/accounts", cookies: { meridian_session: "deadbeef.forged" } });
    expect(res.statusCode).toBe(401);
  });
});
