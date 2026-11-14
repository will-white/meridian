import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { checkSecretsKey, deleteUserSessions, listUsers, resetSecondFactor, resetSecretsKey, rotateSecretsKey, setPassword, user, type AuditContext, type Db } from "@meridian/db";
import { readSecretsKey } from "../config.js";
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
  reset-totp <username>      clear a lost authenticator and the member's passkeys: they enroll a new authenticator at the next sign-in
  reset-password <username>  set a temporary password (printed once) for a member who forgot theirs
  sign-out <username>        end every session of a member

  rotate-secrets-key         re-encrypt the stored secrets from SECRETS_KEY_OLD to SECRETS_KEY
  reset-secrets-key          SECRETS_KEY is lost: show what the current key cannot open;
                             with --confirm, clear it (authenticators are set up again,
                             connections are added again with a new setup token)

Each change signs the member out everywhere and is recorded in the audit log.`;

export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  /** Where SECRETS_KEY and SECRETS_KEY_OLD (or their _FILE forms) are read; default process.env. */
  env?: NodeJS.ProcessEnv;
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

  if (command === "rotate-secrets-key" || command === "reset-secrets-key") return secretsKeyCommand(db, command, [username, ...rest].filter((a): a is string => a !== undefined), io, audit);

  if (command !== "reset-totp" && command !== "reset-password" && command !== "sign-out") return usage(io, `unknown command "${command}"`);
  if (username === undefined || rest.length > 0) return usage(io, `${command} takes one username`);
  const [member] = await db.select({ id: user.id, username: user.username, role: user.role }).from(user).where(eq(user.username, username));
  if (!member) {
    io.err(`No member is named "${username}". Run the "users" command to see the names.`);
    return 1;
  }

  if (command === "reset-totp") {
    await resetSecondFactor(db, member.id, audit());
    io.out(`Two-factor authentication (the authenticator and any passkeys) is cleared for ${member.username} and their sessions have ended.`);
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

/** Audit a7-backup-deploy-secrets-09: change SECRETS_KEY, or recover when it is lost. */
async function secretsKeyCommand(db: Db, command: "rotate-secrets-key" | "reset-secrets-key", args: string[], io: AdminIo, audit: () => AuditContext): Promise<number> {
  const env = io.env ?? process.env;
  const confirmed = command === "reset-secrets-key" && args.length === 1 && args[0] === "--confirm";
  if (args.length > 0 && !confirmed) return usage(io, `${command} takes ${command === "reset-secrets-key" ? "only --confirm" : "no argument"}`);
  let key: string;
  let oldKey = "";
  try {
    key = readSecretsKey(env);
    if (command === "rotate-secrets-key") oldKey = readSecretsKey(env, "SECRETS_KEY_OLD");
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (command === "rotate-secrets-key") {
    try {
      const { reencrypted, already } = await rotateSecretsKey(db, oldKey, key, audit());
      io.out(`Re-encrypted ${reencrypted} stored secret(s) with the new SECRETS_KEY${already > 0 ? ` (${already} already were)` : ""}.`);
      io.out("Now remove SECRETS_KEY_OLD from .env and start web and worker again.");
      return 0;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const check = await checkSecretsKey(db, key);
  if (check.unreadable.length === 0) {
    io.out(`Every stored secret (${check.stored}) decrypts with SECRETS_KEY: there is nothing to reset.`);
    return 0;
  }
  if (!confirmed) {
    io.out(`SECRETS_KEY opens ${check.readable} of the ${check.stored} stored secret(s). These cannot be read with it:`);
    for (const line of check.unreadable) io.out(`  ${line}`);
    io.out("If the key they were encrypted with is lost for good, run again with --confirm to clear them: the members set up their authenticator again at their next sign-in, and each connection is removed and added again with a new setup token (its accounts are kept).");
    return 1;
  }
  const { members, connections } = await resetSecretsKey(db, key, audit());
  if (members.length > 0) io.out(`Authenticator cleared (sign in with the password and set up a new one now): ${members.join(", ")}`);
  if (connections.length > 0) io.out(`Connections that need a new setup token (remove each and add it again on the Connections page): ${connections.join(", ")}`);
  return 0;
}

function usage(io: AdminIo, problem: string): number {
  io.err(`${problem}\n`);
  io.err(ADMIN_USAGE);
  return 2;
}
