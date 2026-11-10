import { and, count, eq, gt } from "drizzle-orm";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { session, user } from "@meridian/db";
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
  }
  interface FastifyRequest {
    auth: AuthState;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
    /** A POST that only reads (e.g. a projection with a request body): viewers may call it. */
    readOnly?: boolean;
  }
}

export async function resolveAuthState(db: Db, sessionId: string | undefined): Promise<AuthState> {
  const [users] = await db.select({ n: count() }).from(user);
  if ((users?.n ?? 0) === 0) return { kind: "setup_required" };
  if (!sessionId) return { kind: "anonymous" };
  const [row] = await db
    .select({
      sessionId: session.id,
      totpVerified: session.totpVerified,
      expiresAt: session.expiresAt,
      userId: user.id,
      username: user.username,
      role: user.role,
      totpConfirmedAt: user.totpConfirmedAt,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, sessionId), gt(session.expiresAt, new Date())));
  if (!row) return { kind: "anonymous" };
  const authUser: AuthUser = { id: row.userId, username: row.username, role: row.role, totpEnrolled: row.totpConfirmedAt !== null };
  const authSession: AuthSession = { id: row.sessionId, totpVerified: row.totpVerified, expiresAt: row.expiresAt };
  if (!authUser.totpEnrolled) return { kind: "totp_enrollment_required", user: authUser, session: authSession };
  if (!authSession.totpVerified) return { kind: "totp_required", user: authUser, session: authSession };
  return { kind: "ok", user: authUser, session: authSession };
}

export function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

export function setSessionCookie(reply: FastifyReply, config: ApiConfig, sessionId: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
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
    request.auth = await resolveAuthState(app.db, readSessionId(request));
    if (level === "public") return;
    const state = request.auth;
    if (state.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
    if (state.kind === "anonymous") throw unauthorized();
    if (level === "session") return;
    if (state.kind === "totp_enrollment_required") throw forbidden("Finish setting up two-factor authentication", "totp_enrollment_required");
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    const mutating = !isSafeMethod(request.method) && request.routeOptions.config.readOnly !== true;
    if (mutating && state.user.role !== "owner") throw forbidden("Viewers cannot make changes", "viewer");
  });
});
