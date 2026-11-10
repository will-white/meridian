import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createViewer, getUser, listUsers, removeViewer, resetSecondFactor, setPassword, type UserRecord } from "@meridian/db";
import { CreateViewerBody, OkResponse, SetUserPasswordBody, UserView, UuidParams } from "@meridian/shared";
import { hashPassword } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { BODY_LIMIT } from "../lib/limits.js";
import { auditContext } from "./plan.js";

function toUserView(u: UserRecord): UserView {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    totpEnrolled: u.totpEnrolled,
    createdAt: u.createdAt.toISOString(),
    passwordChangedAt: u.passwordChangedAt.toISOString(),
    lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
    activeSessions: u.activeSessions,
  };
}

/**
 * Household members (spec: two roles, owner and viewer). The owner adds viewers, sets a new
 * password for one who forgot theirs, clears the second factor of one who lost their phone,
 * and removes them. Every route here is `ownerOnly`, reads included. A member's own
 * password, authenticator and sessions are under /auth (routes/auth.ts); the owner's own
 * recovery when locked out is the `admin` command line, not a route.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => app.authNow();
  const ownerOnly = { ownerOnly: true } as const;

  async function view(id: string): Promise<UserView> {
    const record = await getUser(app.db, id, now());
    if (!record) throw notFound("No such member");
    return toUserView(record);
  }

  /** The member a route acts on, who must not be the caller: the owner's own sign-in is changed under Security, with the current password. */
  async function otherMember(request: FastifyRequest, id: string, selfMessage: string, selfCode: string): Promise<UserRecord> {
    const record = await getUser(app.db, id, now());
    if (!record) throw notFound("No such member");
    if (request.auth.kind === "ok" && request.auth.user.id === id) throw badRequest(selfMessage, selfCode);
    return record;
  }

  r.get("/users", { config: ownerOnly, schema: { response: { 200: z.array(UserView) } } }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return (await listUsers(app.db, now())).map(toUserView);
  });

  /** Add a viewer. They sign in with this password, enroll their own authenticator before anything opens, and can then change the password themselves. */
  r.post("/users", { bodyLimit: BODY_LIMIT.signIn, config: ownerOnly, schema: { body: CreateViewerBody, response: { 200: UserView } } }, async (request) => {
    const passwordHash = await hashPassword(request.body.password);
    const created = await createViewer(app.db, { username: request.body.username, passwordHash }, auditContext(request));
    return view(created.id);
  });

  r.delete("/users/:id", { config: ownerOnly, schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await removeViewer(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  /** A new password for a viewer who forgot theirs. They are signed out everywhere. */
  r.post("/users/:id/password", { bodyLimit: BODY_LIMIT.signIn, config: ownerOnly, schema: { params: UuidParams, body: SetUserPasswordBody, response: { 200: UserView } } }, async (request) => {
    await otherMember(request, request.params.id, "Change your own password under Security, with your current password", "use_change_password");
    const passwordHash = await hashPassword(request.body.password);
    await setPassword(app.db, { userId: request.params.id, passwordHash, now: now() }, auditContext(request));
    return view(request.params.id);
  });

  /** Clear a viewer's second factor (a lost phone). They are signed out everywhere and enroll a new authenticator at their next sign-in. */
  r.post("/users/:id/totp/reset", { config: ownerOnly, schema: { params: UuidParams, response: { 200: UserView } } }, async (request) => {
    await otherMember(request, request.params.id, "Replace your own authenticator under Security; if you have lost it, use the recovery command on the server", "use_replace_authenticator");
    await resetSecondFactor(app.db, request.params.id, auditContext(request));
    return view(request.params.id);
  });
}
