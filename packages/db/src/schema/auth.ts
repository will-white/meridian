import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Single-household app: one owner, optional viewers. */
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // Argon2id
  /** Encrypted with SECRETS_KEY; null until TOTP setup starts. */
  totpSecretEnc: text("totp_secret_enc"),
  /** Set once the user has proven a code; TOTP is enforced from then on. */
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
  role: text("role", { enum: ["owner", "viewer"] }).notNull().default("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  totpVerified: boolean("totp_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
