import { and, count, eq, gt } from "drizzle-orm";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { session, user } from "@meridian/db";
import type { ApiConfig } from "../config.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { Db } from "@meridian/db";

export const SESSION_COOKIE = "meridian_session";

export type AuthLevel = "public" | "session" | "full";

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

/** Loads the session on every request and enforces the route's `config.auth` level (default: full). */
export const authPlugin = fp(async (app) => {
  // Fastify wants a getter/setter pair for reference types; the onRequest hook assigns the real value.
  app.decorateRequest("auth", null as never);
  app.addHook("onRequest", async (request) => {
    request.auth = await resolveAuthState(app.db, readSessionId(request));
  });
  app.addHook("preHandler", async (request) => {
    if (request.is404) return; // unknown paths and the SPA fallback carry no data
    const level: AuthLevel = request.routeOptions.config.auth ?? "full";
    if (level === "public") return;
    const state = request.auth;
    if (state.kind === "setup_required") throw forbidden("Create the owner account first", "setup_required");
    if (state.kind === "anonymous") throw unauthorized();
    if (level === "session") return;
    if (state.kind === "totp_enrollment_required") throw forbidden("Finish setting up two-factor authentication", "totp_enrollment_required");
    if (state.kind === "totp_required") throw unauthorized("Enter your authenticator code", "totp_required");
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && state.user.role !== "owner") throw forbidden("Viewers cannot make changes", "viewer");
  });
});
