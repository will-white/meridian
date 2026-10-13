import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./accounts.js";
import { importLog } from "./sources.js";

export const BUCKETS = ["income", "bills", "savings", "spending"] as const;

/**
 * Minimal category table, pulled forward from Phase 2 so Phase 1 can categorize
 * and rules can set a category. `category_group` and `month_plan` arrive in Phase 2.
 */
export const category = pgTable("category", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  bucket: text("bucket", { enum: BUCKETS }).notNull().default("spending"),
  hidden: boolean("hidden").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payee = pgTable("payee", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** Raw descriptions or former payee names that map to this payee. */
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  defaultCategoryId: uuid("default_category_id").references(() => category.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => account.id, { onDelete: "cascade" }),
    /** SimpleFIN transaction id, a CSV content hash, or null for manual entries. */
    externalId: text("external_id"),
    source: text("source", { enum: ["simplefin", "csv", "manual"] }).notNull(),
    importLogId: uuid("import_log_id").references(() => importLog.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** Positive = money in, negative = money out. Cents as bigint. */
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    payeeId: uuid("payee_id").references(() => payee.id, { onDelete: "set null" }),
    /** True once the user picked the payee by hand; sync and rules then leave it alone. */
    payeeLocked: boolean("payee_locked").notNull().default(false),
    rawDescription: text("raw_description").notNull(),
    memo: text("memo"),
    categoryId: uuid("category_id").references(() => category.id, { onDelete: "set null" }),
    /** True once the user categorized by hand; re-running rules never overrides it. */
    categoryLocked: boolean("category_locked").notNull().default(false),
    bucketOverride: text("bucket_override", { enum: BUCKETS }),
    pending: boolean("pending").notNull().default(false),
    /** Excluded from the budget. Set by pairing or by a rule, even when the other leg is not connected. */
    isTransfer: boolean("is_transfer").notNull().default(false),
    /** Two legs of a transfer share one pair id. */
    transferPairId: uuid("transfer_pair_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transaction_account_external_idx").on(t.accountId, t.externalId),
    index("transaction_account_date_idx").on(t.accountId, t.date),
    index("transaction_date_idx").on(t.date),
    index("transaction_payee_idx").on(t.payeeId),
    index("transaction_category_idx").on(t.categoryId),
    index("transaction_transfer_pair_idx").on(t.transferPairId),
  ],
);

export const split = pgTable("split", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull().references(() => transaction.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => category.id, { onDelete: "set null" }),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  memo: text("memo"),
});

/** Ordered rules: conditions (payee/description/amount/account/day) -> actions (set payee, category, tags, transfer). */
export const rule = pgTable("rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default(""),
  position: integer("position").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull(),
  actions: jsonb("actions").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tag = pgTable("tag", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
});

export const transactionTag = pgTable(
  "transaction_tag",
  {
    transactionId: uuid("transaction_id").notNull().references(() => transaction.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tag.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);
