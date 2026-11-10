import { count } from "drizzle-orm";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { findLiveSession, SESSION_TOUCH_MS, touchSession, user } from "@meridian/db";
import { sanitizeText } from "@meridian/shared";
import type { ApiConfig } from "../config.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { Db } from "@meridian/db";
import { isSafeMethod } from "./requestGuards.js";

export const SESSION_COOKIE = "meridian_session";

/**
 * `static`: a file of the web app; no session is read at all (`request.auth` stays unset).
 * `public`: no session needed, but the handler may look at `request.auth` (sign-in routes, health).
 * `session`: a password session, two-factor not required yet (the two-factor routes).
 * `full` (the default): a session with two-factor verified.
 */
export type AuthLevel = "static" | "public" | "session" | "full";

export interface AuthUser {
  id: string;
  username: string;
  role: "owner" | "viewer";
  totpEnrolled: boolean;
}

export interface AuthSession {
  /** The stored id (SHA-256 of the cookie's session id); safe to show, useless to a browser. */
  id: string;
  totpVerified: boolean;
  expiresAt: Date;
}

export type AuthState =
  | { kind: "setup_required" }
  | { kind: "anonymous" }
  | { kind: "totp_required"; user: AuthUser; session: AuthSession }
  | { kind: "totp_enrollment_required"; user: AuthUser; session: AuthSession }
  | { kind: "ok"; user: AuthUser; session: AuthSession };

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: ApiConfig;
    now: () => Date;
    /** The sign-in clock: session lifetimes and authenticator codes. Separate from `now`, the household's "today". */
    authNow: () => Date;
  }
  interface FastifyRequest {
    auth: AuthState;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
    /** A POST that only reads (e.g. a projection with a request body): viewers may call it. */
    readOnly?: boolean;
    /** A change to the caller's own sign-in (password, authenticator, sessions): every role may make it. */
    ownAccount?: boolean;
    /** Household-member management: the owner only, reads included. */
    ownerOnly?: boolean;
  }
}

/**
 * Who is asking. `token` is the session id from the cookie; a session counts while neither
 * its absolute nor its idle end has passed at `now`. Using a signed-in session pushes its
 * idle end out by `idleMs` (written at most every few minutes).
 */
export async function resolveAuthState(db: Db, token: string | undefined, now: Date = new Date(), idleMs: number = 14 * 86_400_000): Promise<AuthState> {
  const [users] = await db.select({ n: count() }).from(user);
  if ((users?.n ?? 0) === 0) return { kind: "setup_required" };
  if (!token) return { kind: "anonymous" };
  const row = await findLiveSession(db, token, now);
  if (!row) return { kind: "anonymous" };
  const authUser: AuthUser = { id: row.userId, username: row.username, role: row.role, totpEnrolled: row.totpConfirmedAt !== null };
  const authSession: AuthSession = { id: row.id, totpVerified: row.totpVerified, expiresAt: row.expiresAt };
  // A password-only row is never promoted: `totp_verified` is true only on a row created after the code was accepted.
  if (!authSession.totpVerified) return { kind: authUser.totpEnrolled ? "totp_required" : "totp_enrollment_required", user: authUser, session: authSession };
  if (!authUser.totpEnrolled) return { kind: "totp_enrollment_required", user: authUser, session: authSession };
  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_MS) await touchSession(db, row.id, now, idleMs);
  return { kind: "ok", user: authUser, session: authSession };
}

/** Where a request came from, for the session list and the sign-in activity. The User-Agent is the client's own text: cleaned and capped. */
export function clientOf(request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const header = request.headers["user-agent"];
  const userAgent = sanitizeText(Array.isArray(header) ? header[0] : header, 200);
  return { ip: request.ip || null, userAgent: userAgent === "" ? null : userAgent };
}

export function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

/** `token` is the session id itself (the database keeps only its hash). */
export function setSessionCookie(reply: FastifyReply, config: ApiConfig, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    signed: true,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: config.secureCookies });
}

/**
 * Loads the session and enforces the route's `config.auth` level (default: full) in `onRequest`:
 * before the body is read, parsed or validated. A caller who may not use a route learns nothing
 * about its contract and cannot make the server parse anything; a viewer's change is refused
 * the same way. A route that is not marked otherwise is guarded whatever its path, so a new
 * route is closed until someone opens it.
 */
export const authPlugin = fp(async (app) => {
  // Fastify wants a getter/setter pair for reference types; the onRequest hook assigns the real value.
  app.decorateRequest("auth", null as never);
  app.addHook("onRequest", async (request) => {
    // Unknown paths (the SPA fallback included) and the web app's files carry no data and never
    // touch the database: the shell still loads while Postgres is restarting.
    const level: AuthLevel = request.is404 ? "static" : (request.routeOptions.config.auth ?? "full");
    if (level === "static") return;
    request.auth = await resolveAuthState(app.db, readSessionId(request), app.authNow(), app.config.sessionIdleDays * 86_400_000);
    if (level === "public") return;
    const state = request.auth;
    if (state.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
    if (state.kind === "anonymous") throw unauthorized();
    if (level === "session") return;
    if (state.kind === "totp_enrollment_required") throw forbidden("Finish setting up two-factor authentication", "totp_enrollment_required");
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    const config = request.routeOptions.config;
    if (config.ownerOnly === true && state.user.role !== "owner") throw forbidden("Only the owner can manage household members", "owner_only");
    const mutating = !isSafeMethod(request.method) && config.readOnly !== true && config.ownAccount !== true;
    if (mutating && state.user.role !== "owner") throw forbidden("Viewers cannot make changes", "viewer");
  });
});
