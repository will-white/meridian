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

export const payee = pgTable("payee", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** Raw descriptions that map to this payee, e.g. ["SQ *BLUE BOTTLE", "BLUE BOTTLE COFFEE #12"]. */
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  defaultCategoryId: uuid("default_category_id"),
});

export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => account.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    date: date("date").notNull(),
    /** Positive = money in, negative = money out. Cents as bigint. */
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    payeeId: uuid("payee_id").references(() => payee.id, { onDelete: "set null" }),
    rawDescription: text("raw_description").notNull(),
    categoryId: uuid("category_id"), // FK added in Phase 2 when category table lands
    bucketOverride: text("bucket_override", { enum: ["income", "bills", "savings", "spending"] }),
    pending: boolean("pending").notNull().default(false),
    /** Two legs of a transfer share one pair id and are excluded from the budget. */
    transferPairId: uuid("transfer_pair_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transaction_account_external_idx").on(t.accountId, t.externalId),
    index("transaction_date_idx").on(t.date),
    index("transaction_payee_idx").on(t.payeeId),
    index("transaction_transfer_pair_idx").on(t.transferPairId),
  ],
);

export const split = pgTable("split", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull().references(() => transaction.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id"),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
});

/** Ordered rules: conditions (payee/description/amount/account/day) -> actions (set payee, category, tags, transfer). */
export const rule = pgTable("rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  position: integer("position").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull(),
  actions: jsonb("actions").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
