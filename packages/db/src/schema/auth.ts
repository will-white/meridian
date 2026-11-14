import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Single-household app: one owner, optional viewers. */
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // Argon2id
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Encrypted with SECRETS_KEY; null until TOTP setup starts. */
  totpSecretEnc: text("totp_secret_enc"),
  /** Set once the user has proven a code; TOTP is enforced from then on. */
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
  /**
   * The 30-second step of the last code accepted (RFC 6238 section 5.2): a code is taken only
   * when its step is later, so one observed code never signs in twice.
   */
  totpLastStep: integer("totp_last_step"),
  /** A replacement authenticator being set up; the current one stays in force until a code from this one is proven. */
  totpPendingSecretEnc: text("totp_pending_secret_enc"),
  role: text("role", { enum: ["owner", "viewer"] }).notNull().default("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * The last completed sign-in (password and code, or a passkey): the time of its sign-in
   * event, kept here because the activity is deleted after 90 days. Null when they never signed in.
   */
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
});

export const session = pgTable(
  "session",
  {
    /** SHA-256 (hex) of the id in the cookie: a database dump or a backup holds nothing a browser could present. */
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** Absolute end: ten minutes for a password-only session, SESSION_TTL_DAYS once the second factor is proven. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** End by inactivity: pushed out (to at most `expiresAt`) each time the session is used. */
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    totpVerified: boolean("totp_verified").notNull().default(false),
    /** Wrong authenticator codes sent on this password-only session; it is deleted at the fifth. */
    failedCodes: integer("failed_codes").notNull().default(0),
    /** Where the sign-in came from, so the owner can tell their sessions apart. */
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId), index("session_expires_idx").on(t.expiresAt)],
);

/**
 * Audit a10-conformance-ledger-09 (spec, Security: "optional passkeys"): a member's passkeys.
 * A passkey signs its member in on its own, with the device's screen lock (user verification
 * required): it stands for the password and the authenticator code together. Added under
 * Settings by a signed-in member who re-enters the password; removed there, by the member's
 * removal, or with the second factor when it is cleared (a lost phone).
 */
export const passkey = pgTable(
  "passkey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** The credential id the authenticator names it by (base64url). */
    credentialId: text("credential_id").notNull().unique(),
    /** The credential's public key, COSE-encoded (base64url). A public key: not a secret. */
    publicKey: text("public_key").notNull(),
    /** The authenticator's signature counter; an assertion with a counter that does not move forward is refused. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    /** The member's name for it ("Phone", "Laptop"). */
    name: text("name").notNull(),
    /** The credential is synced across the member's devices (a multi-device passkey). */
    backedUp: boolean("backed_up").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("passkey_user_idx").on(t.userId)],
);

/**
 * A WebAuthn challenge waiting for its answer: one use, five minutes. Adding a passkey ties it
 * to the session that asked; a passkey sign-in has no member until the answer names its
 * credential.
 */
export const webauthnChallenge = pgTable(
  "webauthn_challenge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose", { enum: ["register", "sign_in"] }).notNull(),
    challenge: text("challenge").notNull(),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webauthn_challenge_expires_idx").on(t.expiresAt)],
);

export const SIGN_IN_EVENT_KINDS = ["signed_in", "password_failed", "reauth_failed", "code_failed", "code_lockout", "passkey_signed_in", "passkey_failed"] as const;

/**
 * Sign-in activity the owner can review: completed sign-ins and failed attempts on a real
 * account (a wrong password, a wrong current password on a signed-in session, a wrong or reused
 * authenticator code, the code that ended a password session, a passkey answer that did not verify). Attempts on unknown usernames are not kept: what is typed there may be
 * a password. Rows older than 90 days are removed by the worker.
 */
export const signInEvent = pgTable(
  "sign_in_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    /** The account's name when it happened (kept after the member is removed). */
    username: text("username").notNull(),
    kind: text("kind", { enum: SIGN_IN_EVENT_KINDS }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sign_in_event_at_idx").on(t.at), index("sign_in_event_user_idx").on(t.userId, t.at)],
);
