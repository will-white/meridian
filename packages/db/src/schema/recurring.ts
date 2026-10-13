import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { account } from "./accounts.js";
import { category, payee, transaction } from "./ledger.js";

export const CADENCES = ["weekly", "biweekly", "twice_monthly", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"] as const;
export const RECURRING_STATUSES = ["suggested", "active", "paused", "cancelled", "dismissed"] as const;

/**
 * Recurring charges and income: detected by the worker (status 'suggested' until confirmed)
 * or created by hand. The schedule is the cadence plus anchors (see shared/schedule.ts);
 * `next_due_date`, the charge summary and `consecutive_missed` are derived from the linked
 * transactions (transaction.recurring_id) and refreshed by the worker.
 */
export const recurring = pgTable(
  "recurring",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payeeId: uuid("payee_id").notNull().references(() => payee.id, { onDelete: "cascade" }),
    /** Where the planned amount lands (bills or income bucket). Required to activate. */
    categoryId: uuid("category_id").references(() => category.id, { onDelete: "set null" }),
    /** Account the money leaves (bill, transfer) or enters (income). Required to activate. */
    accountId: uuid("account_id").references(() => account.id, { onDelete: "set null" }),
    /** Set when the item is a transfer: destination account. */
    transferAccountId: uuid("transfer_account_id").references(() => account.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    cadence: text("cadence", { enum: CADENCES }).notNull(),
    /** Month-based cadences and twice-monthly first day; 31 = last day of the month. */
    anchorDay: smallint("anchor_day"),
    anchorDay2: smallint("anchor_day2"),
    /** bimonthly/quarterly/semiannual/yearly: any month (1..12) on the cycle. */
    anchorMonth: smallint("anchor_month"),
    /** weekly/biweekly: date of the latest on-cycle charge. */
    anchorDate: date("anchor_date"),
    /** Signed, ledger convention (negative = outflow). The sign is the series direction. */
    expectedCents: bigint("expected_cents", { mode: "bigint" }).notNull(),
    /** Band half-width in cents. */
    toleranceCents: bigint("tolerance_cents", { mode: "bigint" }).notNull().default(sql`0`),
    amountMode: text("amount_mode", { enum: ["fixed", "variable"] }).notNull().default("fixed"),
    amountLocked: boolean("amount_locked").notNull().default(false),
    scheduleLocked: boolean("schedule_locked").notNull().default(false),
    nextDueDate: date("next_due_date"),
    firstChargeDate: date("first_charge_date"),
    lastChargeDate: date("last_charge_date"),
    lastChargeCents: bigint("last_charge_cents", { mode: "bigint" }),
    lastTransactionId: uuid("last_transaction_id"),
    chargeCount: integer("charge_count").notNull().default(0),
    consecutiveMissed: smallint("consecutive_missed").notNull().default(0),
    /** Missed evaluation starts here: last charge on confirm, today on resume or manual create. */
    missedFromDate: date("missed_from_date"),
    /** Detection score / 100 (0..100). */
    confidence: smallint("confidence"),
    source: text("source", { enum: ["detected", "manual"] }).notNull(),
    status: text("status", { enum: RECURRING_STATUSES }).notNull().default("suggested"),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last detector run that reproduced this series (stale-suggestion cleanup). */
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recurring_payee_idx").on(t.payeeId),
    index("recurring_status_next_due_idx").on(t.status, t.nextDueDate),
    index("recurring_account_status_idx").on(t.accountId, t.status),
  ],
);

/** Persisted so they can be dismissed; `dedupe_key` makes re-runs and retries idempotent. */
export const alert = pgTable(
  "alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["price_increase", "new_recurring", "missed_charge", "trial_converted"] }).notNull(),
    recurringId: uuid("recurring_id").references(() => recurring.id, { onDelete: "cascade" }),
    payeeId: uuid("payee_id").notNull().references(() => payee.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").references(() => transaction.id, { onDelete: "set null" }),
    /** missed_charge: the occurrence that did not arrive. */
    dueDate: date("due_date"),
    oldCents: bigint("old_cents", { mode: "bigint" }),
    newCents: bigint("new_cents", { mode: "bigint" }),
    /** 'price:<recurringId>:<txId>' | 'new:<recurringId>' | 'missed:<recurringId>:<dueDate>' | 'trial:<payeeId>:<txId>' */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** System-resolved: late charge arrived, suggestion confirmed or dismissed. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("alert_dedupe_key_idx").on(t.dedupeKey), index("alert_created_idx").on(t.createdAt)],
);
