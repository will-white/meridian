import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { deleteUserSessions, listUsers, resetSecondFactor, setPassword, user, type AuditContext, type Db } from "@meridian/db";
import { hashPassword } from "./auth.js";

/**
 * Recovery commands for whoever runs the server, for the cases the app cannot solve from
 * the inside: the owner has lost their authenticator or forgotten their password. They talk
 * to the database directly, so they need a shell on the server, never a browser:
 *
 *   docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js <command>
 *
 * Every change ends the member's sessions and is written to the audit log with no user
 * (the person at the console).
 */

export const ADMIN_USAGE = `Meridian recovery commands (run on the server):

  users                      list the household's members
  reset-totp <username>      clear a lost authenticator: the member enrolls a new one at the next sign-in
  reset-password <username>  set a temporary password (printed once) for a member who forgot theirs
  sign-out <username>        end every session of a member

Each change signs the member out everywhere and is recorded in the audit log.`;

export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
}

/** 24 characters from 144 random bits. */
export function temporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Runs one command; returns the process exit code (0 done, 1 refused, 2 usage). */
export async function runAdminCommand(db: Db, argv: readonly string[], io: AdminIo): Promise<number> {
  const [command, username, ...rest] = argv;
  const now = io.now ?? (() => new Date());
  const audit = (): AuditContext => ({ userId: null, batchId: randomUUID() });

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(ADMIN_USAGE);
    return command === undefined ? 2 : 0;
  }

  if (command === "users") {
    if (username !== undefined) return usage(io, "users takes no argument");
    const users = await listUsers(db, now());
    if (users.length === 0) {
      io.out("No account exists yet: open the app in a browser to create the owner.");
      return 0;
    }
    for (const u of users) {
      const twoFactor = u.totpEnrolled ? "two-factor on" : "two-factor not set up";
      const last = u.lastSignInAt ? `last sign-in ${u.lastSignInAt.toISOString()}` : "never signed in";
      io.out(`${u.username}\t${u.role}\t${twoFactor}\t${u.activeSessions} session(s)\t${last}`);
    }
    return 0;
  }

  if (command !== "reset-totp" && command !== "reset-password" && command !== "sign-out") return usage(io, `unknown command "${command}"`);
  if (username === undefined || rest.length > 0) return usage(io, `${command} takes one username`);
  const [member] = await db.select({ id: user.id, username: user.username, role: user.role }).from(user).where(eq(user.username, username));
  if (!member) {
    io.err(`No member is named "${username}". Run the "users" command to see the names.`);
    return 1;
  }

  if (command === "reset-totp") {
    await resetSecondFactor(db, member.id, audit());
    io.out(`Two-factor authentication is cleared for ${member.username} and their sessions have ended.`);
    io.out("Until a new authenticator is enrolled the password alone opens the enrollment screen: sign in and enroll one now.");
    return 0;
  }

  if (command === "reset-password") {
    const password = temporaryPassword();
    await setPassword(db, { userId: member.id, passwordHash: await hashPassword(password), now: now() }, audit());
    io.out(`Temporary password for ${member.username}: ${password}`);
    io.out("Their sessions have ended. Sign in with it and change it under Settings > Security; it is not shown again.");
    return 0;
  }

  const ended = await deleteUserSessions(db, member.id);
  io.out(`${ended} session(s) of ${member.username} ended.`);
  return 0;
}

function usage(io: AdminIo, problem: string): number {
  io.err(`${problem}\n`);
  io.err(ADMIN_USAGE);
  return 2;
}
