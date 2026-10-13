import { bigint, boolean, date, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { connection } from "./sources.js";

export const ACCOUNT_TYPES = ["checking", "savings", "credit", "loan", "brokerage", "401k", "ira", "roth", "hsa", "529", "asset"] as const;
export const TAX_TREATMENTS = ["taxable", "pre_tax", "roth", "hsa", "none"] as const;

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connection.id, { onDelete: "set null" }),
    externalId: text("external_id"),
    name: text("name").notNull(),
    /** Bank or brokerage name from SimpleFIN `org.name`. */
    institution: text("institution"),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    /** Set from day one; the retirement planner depends on it. */
    taxTreatment: text("tax_treatment", { enum: TAX_TREATMENTS }).notNull(),
    currency: text("currency").notNull().default("USD"),
    onBudget: boolean("on_budget").notNull().default(true),
    closed: boolean("closed").notNull().default(false),
    /** Latest known balance; history lives in balance_snapshot. Cents as bigint. */
    balanceCents: bigint("balance_cents", { mode: "bigint" }),
    availableCents: bigint("available_cents", { mode: "bigint" }),
    balanceDate: date("balance_date"),
    /** Phase 2 cash flow: per-account low-balance line (null = household default for cash accounts). */
    lowBalanceThresholdCents: bigint("low_balance_threshold_cents", { mode: "bigint" }),
    /** Credit accounts: day of month the card is paid (1..31, clamped); non-null turns payment projection on. */
    paymentDay: smallint("payment_day"),
    paymentFromAccountId: uuid("payment_from_account_id"),
    /** Statement close day; null = pay the balance as of the day before the payment date. */
    statementDay: smallint("statement_day"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("account_connection_external_idx").on(t.connectionId, t.externalId)],
);

/** Daily balances drive net worth history. Cents as bigint. */
export const balanceSnapshot = pgTable(
  "balance_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => account.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull(),
    availableCents: bigint("available_cents", { mode: "bigint" }),
    source: text("source", { enum: ["simplefin", "csv", "manual", "computed"] }).notNull(),
  },
  (t) => [uniqueIndex("balance_snapshot_account_date_idx").on(t.accountId, t.date), index("balance_snapshot_date_idx").on(t.date)],
);
