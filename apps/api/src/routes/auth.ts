import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import QRCode from "qrcode";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  acceptTotpStep,
  activatePendingTotp,
  addPasskey,
  createWebauthnChallenge,
  deletePasskey,
  findPasskeyByCredentialId,
  listPasskeys,
  recordPasskeyUse,
  takeWebauthnChallenge,
  type PasskeyRow,
  confirmTotpEnrollment,
  countFailedSignIns,
  createOwner,
  createSession,
  deleteOwnSession,
  deleteSession,
  deleteUserSessions,
  listSessions,
  listSignInEvents,
  PENDING_SESSION_MS,
  purgeExpiredSessions,
  recordFailedCode,
  recordSignInEvent,
  rotateSession,
  seedDefaultCategories,
  setPassword,
  setPendingTotpSecret,
  startTotpEnrollment,
  user,
  type DbOrTx,
  type IssuedSession,
} from "@meridian/db";
import {
  AddPasskeyBody,
  AuthStatus,
  ChangePasswordBody,
  decryptSecret,
  encryptSecret,
  errorMessageText,
  LoginBody,
  OkResponse,
  PasskeyCeremony,
  PasskeyOptionsBody,
  PasskeySignInBody,
  PasskeyView,
  PasswordConfirmBody,
  RevokeSessionsResponse,
  SessionIdParams,
  SessionView,
  SetupBody,
  SignInActivity,
  TotpCodeBody,
  TotpSetupResponse,
  UuidParams,
  type SignInEventKind,
} from "@meridian/shared";
import { hashPassword, matchTotpStep, newTotpSecret, totpFor, verifyPassword } from "../lib/auth.js";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../lib/errors.js";
import { BODY_LIMIT, SIGN_IN_LIMIT } from "../lib/limits.js";
import { clearSessionCookie, clientOf, setSessionCookie, type AuthSession, type AuthState, type AuthUser } from "../plugins/auth.js";
import { auditContext } from "./plan.js";

/** A valid Argon2id hash of a random password, verified against on unknown usernames so timing does not reveal them. */
const DUMMY_HASH_PROMISE = hashPassword("meridian-dummy-password-for-constant-time");

const DAY_MS = 86_400_000;

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

/**
 * Audit a10-conformance-ledger-09: the relying party of a passkey ceremony is the address the
 * browser is on: the request's `Origin`, which must name the request's own host (as the
 * same-origin guard requires of every change). A passkey belongs to that host name: one added
 * on the LAN name does not sign in on the Tailscale name, and the other way round.
 */
function relyingParty(request: FastifyRequest): { origin: string; rpID: string } {
  const header = request.headers.origin;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw badRequest("A passkey needs the page's origin; use the app in a browser", "origin_required");
  let from: URL;
  let own: URL;
  try {
    from = new URL(raw);
    own = new URL(`${from.protocol}//${request.host}`);
  } catch {
    throw forbidden("Cross-site request refused", "cross_site_request");
  }
  if (from.host !== own.host || (from.protocol !== "https:" && from.protocol !== "http:")) throw forbidden("Cross-site request refused", "cross_site_request");
  return { origin: from.origin, rpID: from.hostname };
}

const passkeyView = (p: PasskeyRow): PasskeyView => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null, backedUp: p.backedUp });
/** The user handle a passkey carries: the member's id, as given when it was added. */
const userHandleOf = (userId: string) => Buffer.from(userId, "utf8").toString("base64url");

/** The caller of a route whose guard level is `full`: signed in, second factor proven. */
function signedIn(request: FastifyRequest): { user: AuthUser; session: AuthSession } {
  if (request.auth.kind !== "ok") throw unauthorized();
  return request.auth;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => app.authNow();

  // Limits keyed on the account rather than the address (see SIGN_IN_LIMIT). They run in the
  // handler, after the per-address limit and validation, because the key is in the body or session.
  const usernameKey = (username: string) => `username:${username.trim().toLowerCase()}`;
  const passwordLimit = app.createRateLimit({ ...SIGN_IN_LIMIT.passwordPerUsername, keyGenerator: (request) => usernameKey((request.body as z.infer<typeof LoginBody>).username) });
  /** Re-entering the password on a signed-in session counts against the same allowance as signing in. */
  const reauthLimit = app.createRateLimit({ ...SIGN_IN_LIMIT.passwordPerUsername, keyGenerator: (request) => ("user" in request.auth ? usernameKey(request.auth.user.username) : `address:${request.ip}`) });
  const codeLimit = app.createRateLimit({
    ...SIGN_IN_LIMIT.codePerUser,
    keyGenerator: (request) => ("user" in request.auth ? `user:${request.auth.user.id}` : `address:${request.ip}`),
  });
  async function enforce(limit: typeof passwordLimit, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await limit(request);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("retry-after", result.ttlInSeconds);
    throw new HttpError(429, `Too many attempts. Try again in ${result.ttlInSeconds} seconds.`, "rate_limited");
  }

  /** A password-only session: ten minutes to send a code (or to enroll), and good for nothing else. */
  async function startPendingSession(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
    const s = await createSession(app.db, { userId, totpVerified: false, ttlMs: PENDING_SESSION_MS, idleMs: PENDING_SESSION_MS, now: now(), ...clientOf(request) });
    setSessionCookie(reply, app.config, s.token, s.expiresAt);
  }

  /** What a signed-in session is created with. A new id is issued every time: after the code, after a password change. */
  const fullSession = (request: FastifyRequest, userId: string) => ({
    userId,
    totpVerified: true,
    ttlMs: app.config.sessionTtlDays * DAY_MS,
    idleMs: app.config.sessionIdleDays * DAY_MS,
    now: now(),
    ...clientOf(request),
  });

  /**
   * The signed-in session that takes the place of the one this request came in on, inside the
   * caller's transaction. If that session ended while the request was in flight, the request is
   * refused and the transaction (an accepted code step, a new password) is rolled back with it.
   */
  async function replaceSession(tx: DbOrTx, request: FastifyRequest, state: { user: AuthUser; session: AuthSession }): Promise<IssuedSession> {
    const issued = await rotateSession(tx, state.session.id, fullSession(request, state.user.id));
    if (!issued) throw unauthorized();
    return issued;
  }

  const recordEvent = (request: FastifyRequest, who: { id: string; username: string }, kind: SignInEventKind) =>
    recordSignInEvent(app.db, { userId: who.id, username: who.username, kind, ...clientOf(request) });

  async function requirePassword(request: FastifyRequest, reply: FastifyReply, userId: string, password: string): Promise<void> {
    await enforce(reauthLimit, request, reply);
    const [row] = await app.db.select({ passwordHash: user.passwordHash }).from(user).where(eq(user.id, userId));
    if (!row || !(await verifyPassword(row.passwordHash, password))) throw forbidden("That is not your current password", "wrong_password");
  }

  r.get("/auth/status", { config: { auth: "public" }, schema: { response: { 200: AuthStatus } } }, async (request) => statusFor(request.auth));

  r.post(
    "/auth/setup",
    { bodyLimit: BODY_LIMIT.signIn, config: { auth: "public", rateLimit: SIGN_IN_LIMIT.setupPerAddress }, schema: { body: SetupBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      if (request.auth.kind !== "setup_required") throw forbidden("The owner account already exists", "already_setup");
      const passwordHash = await hashPassword(request.body.password);
      // Requests that arrive together all pass the check above; createOwner decides them one at a time.
      const created = await createOwner(app.db, { username: request.body.username, passwordHash }, auditContext(request).batchId);
      await seedDefaultCategories(app.db);
      await startPendingSession(request, reply, created.id);
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: false, username: created.username, role: "owner" as const };
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
      if (!row || !ok) {
        // Only attempts on a real account are kept: what is typed as an unknown username may be a password.
        if (row) await recordEvent(request, row, "password_failed");
        throw unauthorized("Wrong username or password", "bad_credentials");
      }
      // The session this browser came in on (if any) ends here, and so do this user's expired ones.
      if ("session" in request.auth) await deleteSession(app.db, request.auth.session.id);
      await purgeExpiredSessions(app.db, now(), row.id);
      await startPendingSession(request, reply, row.id);
      const enrolled = row.totpConfirmedAt !== null;
      return { setupRequired: false, authenticated: !enrolled, totpRequired: enrolled, totpEnrolled: enrolled, username: row.username, role: row.role };
    },
  );

  r.post("/auth/logout", { config: { auth: "session" }, schema: { response: { 200: OkResponse } } }, async (request, reply) => {
    if ("session" in request.auth) await deleteSession(app.db, request.auth.session.id);
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
    await startTotpEnrollment(app.db, state.user.id, await encryptSecret(secret, app.config.secretsKey));
    return totpSetupResponse(secret, state.user.username);
  });

  async function totpSetupResponse(secret: string, username: string): Promise<TotpSetupResponse> {
    const otpauthUrl = totpFor(secret, username).toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
    return { otpauthUrl, qrDataUrl, secret };
  }

  /** Prove a code from the authenticator; TOTP is enforced from here on, and the browser gets a new, signed-in session id. */
  r.post("/auth/totp/confirm", { bodyLimit: BODY_LIMIT.signIn, config: { auth: "session" }, schema: { body: TotpCodeBody, response: { 200: AuthStatus } } }, async (request, reply) => {
    const state = request.auth;
    if (state.kind === "anonymous" || state.kind === "setup_required") throw unauthorized();
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    if (state.user.totpEnrolled) throw badRequest("Two-factor authentication is already set up", "already_enrolled");
    const [row] = await app.db.select({ totpSecretEnc: user.totpSecretEnc }).from(user).where(eq(user.id, state.user.id));
    if (!row?.totpSecretEnc) throw badRequest("Start two-factor setup first", "totp_not_started");
    const secret = await decryptSecret(row.totpSecretEnc, app.config.secretsKey);
    const step = matchTotpStep(secret, state.user.username, request.body.code, now().getTime());
    if (step === null) throw unauthorized("That code is not valid", "bad_totp");
    const issued = await app.db.transaction(async (tx): Promise<IssuedSession> => {
      // The code's step is recorded, so the code that completed enrollment cannot also complete a sign-in.
      if (!(await confirmTotpEnrollment(tx, { userId: state.user.id, step, now: now() }, auditContext(request)))) throw badRequest("Two-factor authentication is already set up", "already_enrolled");
      return replaceSession(tx, request, state);
    });
    setSessionCookie(reply, app.config, issued.token, issued.expiresAt);
    await recordEvent(request, state.user, "signed_in");
    return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username, role: state.user.role };
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
      const step = matchTotpStep(secret, state.user.username, request.body.code, now().getTime());
      // One transaction: the step is taken (once, ever) and the signed-in session with its new id is created, or neither.
      const issued =
        step === null
          ? null
          : await app.db.transaction(async (tx): Promise<IssuedSession | null> => {
              if (!(await acceptTotpStep(tx, state.user.id, step))) return null; // right code, already used
              return replaceSession(tx, request, state);
            });
      if (!issued) {
        const { ended } = await recordFailedCode(app.db, state.session.id);
        await recordEvent(request, state.user, ended ? "code_lockout" : "code_failed");
        if (ended) {
          clearSessionCookie(reply, app.config);
          throw unauthorized("Too many wrong codes. Sign in again with your password.", "sign_in_again");
        }
        throw unauthorized("That code is not valid. If you have already used it, wait for the next one.", "bad_totp");
      }
      setSessionCookie(reply, app.config, issued.token, issued.expiresAt);
      await recordEvent(request, state.user, "signed_in");
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: state.user.username, role: state.user.role };
    },
  );

  // ---- The caller's own account: every role may change its own password, authenticator and sessions ----

  /** Change your password by proving the current one. Every other session of yours ends; this one continues under a new id. */
  r.post(
    "/auth/password",
    { bodyLimit: BODY_LIMIT.signIn, config: { ownAccount: true, rateLimit: SIGN_IN_LIMIT.passwordPerAddress }, schema: { body: ChangePasswordBody, response: { 200: RevokeSessionsResponse } } },
    async (request, reply) => {
      const state = signedIn(request);
      await requirePassword(request, reply, state.user.id, request.body.currentPassword);
      if (request.body.newPassword === request.body.currentPassword) throw badRequest("The new password is the same as the current one", "same_password");
      const passwordHash = await hashPassword(request.body.newPassword);
      const { revoked, issued } = await app.db.transaction(async (tx) => {
        const revoked = await setPassword(tx, { userId: state.user.id, passwordHash, now: now(), keepSessionId: state.session.id }, auditContext(request));
        return { revoked, issued: await replaceSession(tx, request, state) };
      });
      setSessionCookie(reply, app.config, issued.token, issued.expiresAt);
      return { revoked };
    },
  );

  /** Move to a new authenticator, step 1: re-enter the password, get a new secret. The current authenticator stays in force. */
  r.post(
    "/auth/totp/replace",
    { bodyLimit: BODY_LIMIT.signIn, config: { ownAccount: true, rateLimit: SIGN_IN_LIMIT.passwordPerAddress }, schema: { body: PasswordConfirmBody, response: { 200: TotpSetupResponse } } },
    async (request, reply) => {
      const state = signedIn(request);
      await requirePassword(request, reply, state.user.id, request.body.password);
      const secret = newTotpSecret();
      await setPendingTotpSecret(app.db, state.user.id, await encryptSecret(secret, app.config.secretsKey));
      reply.header("Cache-Control", "no-store");
      return totpSetupResponse(secret, state.user.username);
    },
  );

  /** Step 2: a code from the new authenticator makes it the only one. Every other session of yours ends. */
  r.post(
    "/auth/totp/replace/confirm",
    { bodyLimit: BODY_LIMIT.signIn, config: { ownAccount: true, rateLimit: SIGN_IN_LIMIT.codePerAddress }, schema: { body: TotpCodeBody, response: { 200: RevokeSessionsResponse } } },
    async (request, reply) => {
      const state = signedIn(request);
      await enforce(codeLimit, request, reply);
      const [row] = await app.db.select({ pending: user.totpPendingSecretEnc }).from(user).where(eq(user.id, state.user.id));
      if (!row?.pending) throw badRequest("Start the replacement first", "totp_replace_not_started");
      const secret = await decryptSecret(row.pending, app.config.secretsKey);
      const step = matchTotpStep(secret, state.user.username, request.body.code, now().getTime());
      if (step === null) throw badRequest("That code is not from the new authenticator", "bad_totp");
      const revoked = await activatePendingTotp(app.db, { userId: state.user.id, step, now: now(), keepSessionId: state.session.id }, auditContext(request));
      if (revoked === null) throw badRequest("Start the replacement first", "totp_replace_not_started");
      return { revoked };
    },
  );

  /** Where you are signed in. A session is named by the hash the database stores, never by the cookie's id. */
  r.get("/auth/sessions", { schema: { response: { 200: z.array(SessionView) } } }, async (request, reply) => {
    const state = signedIn(request);
    reply.header("Cache-Control", "no-store");
    return (await listSessions(app.db, state.user.id, now())).map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === state.session.id,
      ip: s.ip,
      userAgent: s.userAgent,
    }));
  });

  /** Sign out everywhere else. */
  r.post("/auth/sessions/revoke-others", { config: { ownAccount: true }, schema: { response: { 200: RevokeSessionsResponse } } }, async (request) => {
    const state = signedIn(request);
    return { revoked: await deleteUserSessions(app.db, state.user.id, state.session.id) };
  });

  /** Sign one of your sessions out (this one included). */
  r.delete("/auth/sessions/:id", { config: { ownAccount: true }, schema: { params: SessionIdParams, response: { 200: OkResponse } } }, async (request, reply) => {
    const state = signedIn(request);
    if (!(await deleteOwnSession(app.db, state.user.id, request.params.id))) throw notFound("No such session");
    if (request.params.id === state.session.id) clearSessionCookie(reply, app.config);
    return { ok: true as const };
  });

  // ---- Passkeys (audit a10-conformance-ledger-09; spec, Security: "optional passkeys") ----
  // A passkey signs its member in on its own, the device's screen lock standing in for the code
  // (user verification is required); the password and the authenticator stay, so a passkey is
  // never the only way in. Adding one needs the password, as replacing the authenticator does.

  /** Adding a passkey, step 1: the password again, then the options for `navigator.credentials.create()`. */
  r.post(
    "/auth/passkeys/options",
    { bodyLimit: BODY_LIMIT.signIn, config: { ownAccount: true, rateLimit: SIGN_IN_LIMIT.passwordPerAddress }, schema: { body: PasskeyOptionsBody, response: { 200: PasskeyCeremony } } },
    async (request, reply) => {
      const state = signedIn(request);
      const rp = relyingParty(request);
      await requirePassword(request, reply, state.user.id, request.body.password);
      const existing = await listPasskeys(app.db, state.user.id);
      const options = await generateRegistrationOptions({
        rpName: "Meridian",
        rpID: rp.rpID,
        userName: state.user.username,
        userID: new Uint8Array(Buffer.from(state.user.id, "utf8")),
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      const challengeId = await createWebauthnChallenge(app.db, { purpose: "register", challenge: options.challenge, userId: state.user.id, sessionId: state.session.id, now: now() });
      reply.header("Cache-Control", "no-store");
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },
  );

  /** Step 2: the browser's answer, verified (this host, user verification, the challenge of this session), becomes a passkey. */
  r.post("/auth/passkeys", { bodyLimit: BODY_LIMIT.passkey, config: { ownAccount: true }, schema: { body: AddPasskeyBody, response: { 200: PasskeyView } } }, async (request) => {
    const state = signedIn(request);
    const rp = relyingParty(request);
    const taken = await takeWebauthnChallenge(app.db, { id: request.body.challengeId, purpose: "register", sessionId: state.session.id, now: now() });
    if (!taken || taken.userId !== state.user.id) throw badRequest("That passkey prompt has expired. Start again.", "passkey_challenge");
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: request.body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: taken.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw badRequest(`The passkey could not be verified: ${errorMessageText(err, 200)}`, "passkey_not_verified");
    }
    if (!verified.verified) throw badRequest("The passkey could not be verified", "passkey_not_verified");
    const { credential, credentialBackedUp } = verified.registrationInfo;
    if (await findPasskeyByCredentialId(app.db, credential.id)) throw new HttpError(409, "This passkey is added already", "passkey_exists");
    const row = await addPasskey(
      app.db,
      {
        userId: state.user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? request.body.response.response.transports ?? [],
        name: request.body.name,
        backedUp: credentialBackedUp,
        now: now(),
      },
      auditContext(request),
    );
    return passkeyView(row);
  });

  /** Your passkeys. */
  r.get("/auth/passkeys", { schema: { response: { 200: z.array(PasskeyView) } } }, async (request, reply) => {
    const state = signedIn(request);
    reply.header("Cache-Control", "no-store");
    return (await listPasskeys(app.db, state.user.id)).map(passkeyView);
  });

  /** Remove one of your passkeys; it no longer signs in. */
  r.delete("/auth/passkeys/:id", { config: { ownAccount: true }, schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const state = signedIn(request);
    if (!(await deletePasskey(app.db, state.user.id, request.params.id, auditContext(request)))) throw notFound("No such passkey");
    return { ok: true as const };
  });

  /** Signing in with a passkey, step 1: the options for `navigator.credentials.get()` (any of this host's passkeys may answer). */
  r.post(
    "/auth/passkey/options",
    { bodyLimit: BODY_LIMIT.signIn, config: { auth: "public", rateLimit: SIGN_IN_LIMIT.passkeyPerAddress }, schema: { body: z.object({}), response: { 200: PasskeyCeremony } } },
    async (request, reply) => {
      if (request.auth.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
      const rp = relyingParty(request);
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
      const challengeId = await createWebauthnChallenge(app.db, { purpose: "sign_in", challenge: options.challenge, now: now() });
      reply.header("Cache-Control", "no-store");
      return { challengeId, options: options as unknown as Record<string, unknown> };
    },
  );

  /** Step 2: the passkey's answer. Verified, it signs its member in (a new signed-in session, as after the code). */
  r.post(
    "/auth/passkey/verify",
    { bodyLimit: BODY_LIMIT.passkey, config: { auth: "public", rateLimit: SIGN_IN_LIMIT.passkeyPerAddress }, schema: { body: PasskeySignInBody, response: { 200: AuthStatus } } },
    async (request, reply) => {
      if (request.auth.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
      const rp = relyingParty(request);
      const taken = await takeWebauthnChallenge(app.db, { id: request.body.challengeId, purpose: "sign_in", now: now() });
      if (!taken) throw unauthorized("That passkey prompt has expired. Try again.", "passkey_challenge");
      const found = await findPasskeyByCredentialId(app.db, request.body.response.id);
      if (!found) throw unauthorized("This passkey is not one of Meridian's. Sign in with your password; you can add the passkey under Settings.", "passkey_unknown");
      const who = { id: found.userId, username: found.username };
      const handle = request.body.response.response.userHandle;
      let ok = handle === undefined || handle === userHandleOf(found.userId);
      let newCounter = found.counter;
      if (ok) {
        try {
          const result = await verifyAuthenticationResponse({
            response: request.body.response as unknown as AuthenticationResponseJSON,
            expectedChallenge: taken.challenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.rpID,
            credential: { id: found.credentialId, publicKey: new Uint8Array(Buffer.from(found.publicKey, "base64url")), counter: found.counter, transports: found.transports as AuthenticatorTransportFuture[] },
            requireUserVerification: true,
          });
          ok = result.verified;
          newCounter = result.authenticationInfo.newCounter;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        await recordEvent(request, who, "passkey_failed");
        throw unauthorized("The passkey could not be verified. Try again, or sign in with your password.", "passkey_not_verified");
      }
      // The session this browser came in on (if any) ends here, and so do this member's expired ones.
      if ("session" in request.auth) await deleteSession(app.db, request.auth.session.id);
      await purgeExpiredSessions(app.db, now(), found.userId);
      const issued = await createSession(app.db, fullSession(request, found.userId));
      await recordPasskeyUse(app.db, found.id, newCounter, now());
      setSessionCookie(reply, app.config, issued.token, issued.expiresAt);
      await recordEvent(request, who, "passkey_signed_in");
      const enrolled = found.totpConfirmedAt !== null;
      return { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: enrolled, username: found.username, role: found.role };
    },
  );

  /** Sign-in activity: the owner sees every member's, a viewer their own. */
  r.get("/auth/activity", { schema: { response: { 200: SignInActivity } } }, async (request, reply) => {
    const state = signedIn(request);
    const scope = state.user.role === "owner" ? {} : { userId: state.user.id };
    reply.header("Cache-Control", "no-store");
    const [items, failedLast7Days] = await Promise.all([listSignInEvents(app.db, { ...scope, limit: 100 }), countFailedSignIns(app.db, { ...scope, days: 7 })]);
    return { items: items.map((e) => ({ id: e.id, at: e.at.toISOString(), username: e.username, kind: e.kind, ip: e.ip, userAgent: e.userAgent })), failedLast7Days };
  });
}
