import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { account } from "./accounts.js";
import { user } from "./auth.js";
import { BUCKETS, category } from "./ledger.js";

export const ROLLOVER_MODES = ["none", "surplus", "all"] as const;
export const PLANNED_SOURCES = ["manual", "average", "recurring", "goal"] as const;

/** Category groups sit under bucket headers in the grid. A group belongs to exactly one bucket. */
export const categoryGroup = pgTable(
  "category_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    bucket: text("bucket", { enum: BUCKETS }).notNull(),
    position: integer("position").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("category_group_bucket_name_idx").on(t.bucket, t.name), index("category_group_bucket_position_idx").on(t.bucket, t.position)],
);

/**
 * Planned amounts per (category, month). A row exists only when something was set by hand
 * or frozen by plan.close_month; a missing row (or null planned_cents) means the auto value
 * applies (recurring occurrences for bills/income, goal contribution for savings, else 0).
 * Months are `YYYY-MM` text. Carried-in is computed on read; `carried_in_override_cents` pins it.
 */
export const monthPlan = pgTable(
  "month_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id").notNull().references(() => category.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    /** Bucket-natural magnitude (>= 0); null = auto. */
    plannedCents: bigint("planned_cents", { mode: "bigint" }),
    plannedSource: text("planned_source", { enum: PLANNED_SOURCES }),
    /** Per-month override of the carry OUT of this month; null = category.rollover_mode. */
    rolloverMode: text("rollover_mode", { enum: ROLLOVER_MODES }),
    /** The spec's "carried-in amount": a pin for this month's carried-in that feeds forward. */
    carriedInOverrideCents: bigint("carried_in_override_cents", { mode: "bigint" }),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("month_plan_category_month_idx").on(t.categoryId, t.month), index("month_plan_month_idx").on(t.month)],
);

/** One goal per savings-bucket category; the category row in the grid carries the goal. */
export const savingsGoal = pgTable(
  "savings_goal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .unique()
      .references(() => category.id, { onDelete: "cascade" }),
    linkedAccountId: uuid("linked_account_id").references(() => account.id, { onDelete: "set null" }),
    targetCents: bigint("target_cents", { mode: "bigint" }).notNull(),
    targetDate: date("target_date"),
    /** Already saved when the goal was created. */
    startingCents: bigint("starting_cents", { mode: "bigint" }).notNull().default(sql`0`),
    /** Contributions and auto-planning count from here (YYYY-MM). */
    startMonth: text("start_month").notNull(),
    /** Auto-planned value for the category with source 'goal'. */
    monthlyContributionCents: bigint("monthly_contribution_cents", { mode: "bigint" }).notNull().default(sql`0`),
    status: text("status", { enum: ["active", "completed", "archived"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("savings_goal_linked_account_idx").on(t.linkedAccountId)],
);

/** Single-row household settings shared by the plan, cash-flow and dashboard areas. */
export const householdSetting = pgTable("household_setting", {
  id: smallint("id").primaryKey().default(1),
  /** Origin of every rollover chain and of plan.close_month (YYYY-MM). */
  planStartMonth: text("plan_start_month").notNull(),
  /** Presentation toggle: the strip shows "to assign" instead of "left to spend". */
  zeroBased: boolean("zero_based").notNull().default(false),
  /** Default low-balance line for cash accounts and the combined cash-flow line. */
  lowBalanceThresholdCents: bigint("low_balance_threshold_cents", { mode: "bigint" }).notNull().default(sql`0`),
  /** Carries discretionary spending in the projection when no spending history exists. */
  primaryAccountId: uuid("primary_account_id").references(() => account.id, { onDelete: "set null" }),
  projectionDefaultDays: integer("projection_default_days").notNull().default(90),
  /** IANA zone used to compute the household's "today" on the server and in worker jobs. */
  timezone: text("timezone").notNull().default("America/Denver"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Edits to plans, categories, goals, recurring items and rules keep history (spec: Security). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    /** One per HTTP request, so a fill-right or a reorder is one reviewable batch. */
    batchId: uuid("batch_id").notNull(),
    entity: text("entity", { enum: ["month_plan", "category", "category_group", "savings_goal", "recurring", "rule", "household_setting"] }).notNull(),
    /** Row id, or `${month}:${categoryId}` for plan cells. */
    entityId: text("entity_id").notNull(),
    action: text("action", { enum: ["create", "update", "delete"] }).notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId, t.at), index("audit_log_batch_idx").on(t.batchId), index("audit_log_at_idx").on(t.at)],
);
