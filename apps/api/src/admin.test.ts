import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, session, user } from "@meridian/db";
import { ADMIN_USAGE, runAdminCommand } from "./lib/adminCommands.js";
import { createTestApp, OWNER_PASSWORD, passwordSignIn, sessionCookies, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * The recovery command line (apps/api/src/admin.ts): what the person at the server's console
 * runs when the owner is locked out. The commands work on the database alone.
 */
describe.skipIf(!TEST_DATABASE_URL)("recovery commands", () => {
  let t: TestApp;
  let ownerId: string;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
    ownerId = (await t.db.db.select({ id: user.id }).from(user))[0]!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function run(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdminCommand(t.db.db, argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  }
  const status = async (jar: Record<string, string>) => (await t.app.inject({ method: "GET", url: "/api/auth/status", cookies: jar })).json();

  it("lists the members", async () => {
    const { code, out } = await run("users");
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^owner\towner\ttwo-factor on\t1 session\(s\)\tlast sign-in \d{4}-\d{2}-\d{2}T/);
  });

  it("explains itself for no command, an unknown one, a missing or unknown username, and changes nothing", async () => {
    expect(await run()).toEqual({ code: 2, out: [ADMIN_USAGE], err: [] });
    expect((await run("help")).code).toBe(0);
    const unknown = await run("delete-everything");
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toContain('unknown command "delete-everything"');
    expect((await run("reset-totp")).code).toBe(2);
    const nobody = await run("reset-password", "nobody");
    expect(nobody.code).toBe(1);
    expect(nobody.err[0]).toContain('No member is named "nobody"');
    expect(await status(t.cookies)).toMatchObject({ authenticated: true, totpEnrolled: true });
  });

  it("sign-out ends every session of the member", async () => {
    const phone = await sessionCookies(t, ownerId);
    const { code, out } = await run("sign-out", "owner");
    expect(code).toBe(0);
    expect(out).toEqual(["2 session(s) of owner ended."]);
    expect(await status(phone)).toMatchObject({ authenticated: false });
    expect(await status(t.cookies)).toMatchObject({ authenticated: false });
  });

  it("reset-password prints a temporary password that works, ends the sessions, and the old password is refused", async () => {
    const before = await sessionCookies(t, ownerId);
    const { code, out } = await run("reset-password", "owner");
    expect(code).toBe(0);
    const temporary = /^Temporary password for owner: ([A-Za-z0-9_-]{24})$/.exec(out[0]!)?.[1];
    expect(temporary).toBeDefined();
    expect(await status(before)).toMatchObject({ authenticated: false });
    expect((await passwordSignIn(t, "owner", OWNER_PASSWORD, "10.3.0.1")).res.statusCode).toBe(401);
    const signIn = await passwordSignIn(t, "owner", temporary!, "10.3.0.2");
    expect(signIn.res.statusCode).toBe(200);
    expect(signIn.res.json()).toMatchObject({ totpRequired: true, totpEnrolled: true });
  });

  it("reset-totp clears a lost authenticator: the password then opens enrollment, nothing else", async () => {
    const before = await sessionCookies(t, ownerId);
    const { code, out } = await run("reset-totp", "owner");
    expect(code).toBe(0);
    expect(out[0]).toBe("Two-factor authentication is cleared for owner and their sessions have ended.");
    expect(await status(before)).toMatchObject({ authenticated: false });
    expect(await t.db.db.select().from(session).where(eq(session.userId, ownerId))).toEqual([]);
    const [row] = await t.db.db.select({ secret: user.totpSecretEnc, confirmedAt: user.totpConfirmedAt }).from(user).where(eq(user.id, ownerId));
    expect(row).toEqual({ secret: null, confirmedAt: null });

    const temporary = /: (\S+)$/.exec((await run("reset-password", "owner")).out[0]!)![1]!;
    const signIn = await passwordSignIn(t, "owner", temporary, "10.3.0.3");
    expect(signIn.res.json()).toMatchObject({ authenticated: true, totpEnrolled: false });
    const closed = await t.app.inject({ method: "GET", url: "/api/accounts", cookies: signIn.jar });
    expect([closed.statusCode, closed.json().code]).toEqual([403, "totp_enrollment_required"]);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/totp/setup", cookies: signIn.jar })).statusCode).toBe(200);
  });

  it("records each change in the audit log with no user (the console)", async () => {
    const rows = await t.db.db.select({ userId: auditLog.userId, action: auditLog.action }).from(auditLog).where(eq(auditLog.entity, "user")).orderBy(asc(auditLog.at));
    // Setup and enrollment by the owner, then two password resets and one two-factor reset from the console.
    expect(rows.map((r) => [r.userId === null ? "console" : "owner", r.action])).toEqual([
      ["owner", "create"],
      ["owner", "update"],
      ["console", "update"],
      ["console", "update"],
      ["console", "update"],
    ]);
  });
});
