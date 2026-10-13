import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import QRCode from "qrcode";
import { seedDefaultCategories, session, user } from "@meridian/db";
import { AuthStatus, decryptSecret, encryptSecret, LoginBody, OkResponse, SetupBody, TotpCodeBody, TotpSetupResponse } from "@meridian/shared";
import { hashPassword, newSessionId, newTotpSecret, totpFor, verifyPassword, verifyTotp } from "../lib/auth.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";
import { clearSessionCookie, setSessionCookie, type AuthState } from "../plugins/auth.js";

/** A valid Argon2id hash of a random password, verified against on unknown usernames so timing does not reveal them. */
const DUMMY_HASH_PROMISE = hashPassword("meridian-dummy-password-for-constant-time");

function statusFor(state: AuthState): AuthStatus {
  switch (state.kind) {
    case "setup_required":
      return { setupRequired: true, authenticated: false, totpRequired: false, totpEnrolled: false };
    case "anonymous":
      return { setupRequired: false, authenticated: false, totpRequired: false, totpEnrolled: false };
    case "totp_required":
      return { setupRequired: false, authenticated: false, totpRequired: true, totpEnrolled: true, username: state.user.username };
    case "totp_enrollment_required":
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: false, username: state.user.username };
    case "ok":
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username };
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ttlMs = () => app.config.sessionTtlDays * 86_400_000;

  async function startSession(userId: string, totpVerified: boolean) {
    const id = newSessionId();
    const expiresAt = new Date(Date.now() + ttlMs());
    await app.db.insert(session).values({ id, userId, expiresAt, totpVerified });
    return { id, expiresAt };
  }

  r.get("/auth/status", { config: { auth: "public" }, schema: { response: { 200: AuthStatus } } }, async (request) => statusFor(request.auth));

  r.post(
    "/auth/setup",
    { config: { auth: "public", rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { body: SetupBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      if (request.auth.kind !== "setup_required") throw forbidden("The owner account already exists", "already_setup");
      const passwordHash = await hashPassword(request.body.password);
      const username = request.body.username.trim();
      const [created] = await app.db.insert(user).values({ username, passwordHash, role: "owner" }).returning({ id: user.id });
      await seedDefaultCategories(app.db);
      const s = await startSession(created!.id, false);
      setSessionCookie(reply, app.config, s.id, s.expiresAt);
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: false, username };
    },
  );

  r.post(
    "/auth/login",
    { config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: LoginBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      if (request.auth.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
      const [row] = await app.db.select().from(user).where(eq(user.username, request.body.username.trim()));
      const ok = await verifyPassword(row?.passwordHash ?? (await DUMMY_HASH_PROMISE), request.body.password);
      if (!row || !ok) throw unauthorized("Wrong username or password", "bad_credentials");
      const s = await startSession(row.id, false);
      setSessionCookie(reply, app.config, s.id, s.expiresAt);
      const enrolled = row.totpConfirmedAt !== null;
      return { setupRequired: false, authenticated: !enrolled, totpRequired: enrolled, totpEnrolled: enrolled, username: row.username };
    },
  );

  r.post("/auth/logout", { config: { auth: "session" }, schema: { response: { 200: OkResponse } } }, async (request, reply) => {
    if (request.auth.kind !== "anonymous" && request.auth.kind !== "setup_required") {
      await app.db.delete(session).where(eq(session.id, request.auth.session.id));
    }
    clearSessionCookie(reply, app.config);
    return { ok: true as const };
  });

  /** Start (or restart) TOTP enrollment: a fresh secret, stored encrypted, not yet active. */
  r.post("/auth/totp/setup", { config: { auth: "session" }, schema: { response: { 200: TotpSetupResponse } } }, async (request) => {
    const state = request.auth;
    if (state.kind === "anonymous" || state.kind === "setup_required") throw unauthorized();
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    if (state.user.totpEnrolled) throw badRequest("Two-factor authentication is already set up", "already_enrolled");
    const secret = newTotpSecret();
    await app.db.update(user).set({ totpSecretEnc: await encryptSecret(secret, app.config.secretsKey) }).where(eq(user.id, state.user.id));
    const otpauthUrl = totpFor(secret, state.user.username).toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
    return { otpauthUrl, qrDataUrl, secret };
  });

  /** Prove a code from the authenticator; TOTP is enforced from here on. */
  r.post("/auth/totp/confirm", { config: { auth: "session" }, schema: { body: TotpCodeBody, response: { 200: AuthStatus } } }, async (request) => {
    const state = request.auth;
    if (state.kind === "anonymous" || state.kind === "setup_required") throw unauthorized();
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    if (state.user.totpEnrolled) throw badRequest("Two-factor authentication is already set up", "already_enrolled");
    const [row] = await app.db.select({ totpSecretEnc: user.totpSecretEnc }).from(user).where(eq(user.id, state.user.id));
    if (!row?.totpSecretEnc) throw badRequest("Start two-factor setup first", "totp_not_started");
    const secret = await decryptSecret(row.totpSecretEnc, app.config.secretsKey);
    if (!verifyTotp(secret, state.user.username, request.body.code)) throw unauthorized("That code is not valid", "bad_totp");
    await app.db.update(user).set({ totpConfirmedAt: new Date() }).where(eq(user.id, state.user.id));
    await app.db.update(session).set({ totpVerified: true }).where(eq(session.id, state.session.id));
    return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username };
  });

  /** Second factor after a password login. */
  r.post(
    "/auth/totp/verify",
    { config: { auth: "session", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: TotpCodeBody, response: { 200: AuthStatus } } },
    async (request) => {
      const state = request.auth;
      if (state.kind === "anonymous" || state.kind === "setup_required") throw unauthorized();
      if (state.kind === "ok") return statusFor(state);
      if (state.kind === "totp_enrollment_required") throw badRequest("Two-factor authentication is not set up yet", "totp_not_enrolled");
      const [row] = await app.db.select({ totpSecretEnc: user.totpSecretEnc }).from(user).where(eq(user.id, state.user.id));
      if (!row?.totpSecretEnc) throw badRequest("Two-factor authentication is not set up", "totp_not_enrolled");
      const secret = await decryptSecret(row.totpSecretEnc, app.config.secretsKey);
      if (!verifyTotp(secret, state.user.username, request.body.code)) throw unauthorized("That code is not valid", "bad_totp");
      await app.db.update(session).set({ totpVerified: true }).where(eq(session.id, state.session.id));
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username };
    },
  );
}
