import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import QRCode from "qrcode";
import type { z } from "zod";
import { seedDefaultCategories, session, user } from "@meridian/db";
import { AuthStatus, decryptSecret, encryptSecret, LoginBody, OkResponse, SetupBody, TotpCodeBody, TotpSetupResponse } from "@meridian/shared";
import { hashPassword, newSessionId, newTotpSecret, totpFor, verifyPassword, verifyTotp } from "../lib/auth.js";
import { badRequest, forbidden, HttpError, unauthorized } from "../lib/errors.js";
import { BODY_LIMIT, SIGN_IN_LIMIT } from "../lib/limits.js";
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
      return { setupRequired: false, authenticated: false, totpRequired: true, totpEnrolled: true, username: state.user.username, role: state.user.role };
    case "totp_enrollment_required":
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: false, username: state.user.username, role: state.user.role };
    case "ok":
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username, role: state.user.role };
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ttlMs = () => app.config.sessionTtlDays * 86_400_000;

  // Limits keyed on the account rather than the address (see SIGN_IN_LIMIT). They run in the
  // handler, after the per-address limit and validation, because the key is in the body or session.
  const passwordLimit = app.createRateLimit({ ...SIGN_IN_LIMIT.passwordPerUsername, keyGenerator: (request) => `username:${(request.body as z.infer<typeof LoginBody>).username.trim().toLowerCase()}` });
  const codeLimit = app.createRateLimit({
    ...SIGN_IN_LIMIT.codePerUser,
    keyGenerator: (request) => (request.auth.kind === "totp_required" ? `user:${request.auth.user.id}` : `address:${request.ip}`),
  });
  async function enforce(limit: typeof passwordLimit, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await limit(request);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("retry-after", result.ttlInSeconds);
    throw new HttpError(429, `Too many attempts. Try again in ${result.ttlInSeconds} seconds.`, "rate_limited");
  }

  async function startSession(userId: string, totpVerified: boolean) {
    const id = newSessionId();
    const expiresAt = new Date(Date.now() + ttlMs());
    await app.db.insert(session).values({ id, userId, expiresAt, totpVerified });
    return { id, expiresAt };
  }

  r.get("/auth/status", { config: { auth: "public" }, schema: { response: { 200: AuthStatus } } }, async (request) => statusFor(request.auth));

  r.post(
    "/auth/setup",
    { bodyLimit: BODY_LIMIT.signIn, config: { auth: "public", rateLimit: SIGN_IN_LIMIT.setupPerAddress }, schema: { body: SetupBody, response: { 200: AuthStatus } } },
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
    { bodyLimit: BODY_LIMIT.signIn, config: { auth: "public", rateLimit: SIGN_IN_LIMIT.passwordPerAddress }, schema: { body: LoginBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      if (request.auth.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
      await enforce(passwordLimit, request, reply);
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
  r.post("/auth/totp/confirm", { bodyLimit: BODY_LIMIT.signIn, config: { auth: "session" }, schema: { body: TotpCodeBody, response: { 200: AuthStatus } } }, async (request) => {
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
    { bodyLimit: BODY_LIMIT.signIn, config: { auth: "session", rateLimit: SIGN_IN_LIMIT.codePerAddress }, schema: { body: TotpCodeBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      const state = request.auth;
      if (state.kind === "anonymous" || state.kind === "setup_required") throw unauthorized();
      if (state.kind === "ok") return statusFor(state);
      if (state.kind === "totp_enrollment_required") throw badRequest("Two-factor authentication is not set up yet", "totp_not_enrolled");
      await enforce(codeLimit, request, reply);
      const [row] = await app.db.select({ totpSecretEnc: user.totpSecretEnc }).from(user).where(eq(user.id, state.user.id));
      if (!row?.totpSecretEnc) throw badRequest("Two-factor authentication is not set up", "totp_not_enrolled");
      const secret = await decryptSecret(row.totpSecretEnc, app.config.secretsKey);
      if (!verifyTotp(secret, state.user.username, request.body.code)) throw unauthorized("That code is not valid", "bad_totp");
      await app.db.update(session).set({ totpVerified: true }).where(eq(session.id, state.session.id));
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username };
    },
  );
}
