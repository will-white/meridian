import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, date, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { job } from "./sources.js";

/**
 * Phase 4: the retirement planner's five tables (docs/design/phase-4/inputs-and-data.md §2.1 to
 * §2.4, with seams.md C46 and F9). The household profile and its stored baseline are one
 * singleton row of JSON documents; a scenario is a minimal merge patch over the profile plus its
 * own run settings; a run stores its frozen input with its hash, the versions and seed it ran
 * under, its progress and its results (summary and fan chart as JSON, four per-path series as
 * little-endian integers, seven percentile year tables). The documents are versioned, strict and
 * hold no floats and no nulls; the services parse them with the shared schemas on every read.
 * Text columns mirror the enums of `packages/shared` (the mirror test in `retirement.test.ts`).
 */

/** `sim_run.status` (shared `SimRunStatus`). */
export const SIM_RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
/** `sim_run_series.kind` (shared `SimRunSeriesKind`): ending wealth and lifetime taxes and spending in today's cents, the depletion year. */
export const SIM_RUN_SERIES_KINDS = ["ending_real_cents", "depletion_year", "lifetime_tax_real_cents", "lifetime_spending_real_cents"] as const;
/** `sim_run_series.encoding` (shared `SeriesEncoding`): signed 64-bit or 16-bit integers, little-endian, path 0 first. */
export const SERIES_ENCODINGS = ["i64le", "i16le"] as const;
/** `sim_run.return_model`, a copy of `input.settings.returnModel.kind` for lists (shared `ReturnModelKind`; no database CHECK). */
export const RETURN_MODEL_KINDS = ["historical", "bootstrap", "parametric", "fixed"] as const;
/** `sim_run.strategy`, a copy of `input.settings.strategy.kind` for lists (shared `StrategyKind`; no database CHECK). */
export const STRATEGY_KINDS = ["constant_dollar", "fixed_percentage", "guardrails", "vpw", "floor_ceiling"] as const;

/** A stored JSON document; the services parse it with its shared schema (`schemaVersion` first). */
type StoredDoc = Record<string, unknown>;

/** drizzle-orm has no `bytea` column; postgres-js hands one over as a Buffer (a Uint8Array). */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

/**
 * The household's facts (`doc`, `RetirementProfileDoc`) and the baseline last computed from live
 * data (`baseline`, `RetirementBaseline`), in one row (`id = 1`, the `household_setting` pattern).
 * `revision` counts changes of the document (optimistic concurrency, inputs decision 30); a
 * baseline refresh leaves it alone. `baseline_hash` is the SHA-256 of the baseline's canonical
 * JSON without `computedAt` and `today` (shared `baselineHash`).
 */
export const planProfile = pgTable(
  "plan_profile",
  {
    id: smallint("id").primaryKey().default(1),
    /** `doc.schemaVersion` (count). */
    schemaVersion: integer("schema_version").notNull(),
    doc: jsonb("doc").$type<StoredDoc>().notNull(),
    /** +1 on every change of `doc` (count). */
    revision: integer("revision").notNull().default(1),
    baseline: jsonb("baseline").$type<StoredDoc>().notNull(),
    /** `baseline.asOf`, the valuation date. */
    baselineAsOf: date("baseline_as_of").notNull(),
    /** 64 lower-case hex digits. */
    baselineHash: text("baseline_hash").notNull(),
    baselineAt: timestamp("baseline_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("plan_profile_singleton", sql`"id" = 1`),
    check("plan_profile_revision_check", sql`"revision" >= 1`),
    check("plan_profile_doc_object", sql`jsonb_typeof("doc") = 'object'`),
    check("plan_profile_baseline_object", sql`jsonb_typeof("baseline") = 'object'`),
    check("plan_profile_baseline_hash_shape", sql`"baseline_hash" ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A what-if over the profile: `overrides` is the minimal RFC 7396 merge patch from the profile's
 * document to the scenario's (never `schemaVersion`), `settings` its `RunSettings`. Exactly one
 * scenario is the default (the dashboard card's); it cannot be archived. Names are unique
 * ignoring case. At most 50 scenarios that are not archived (a service check).
 */
export const scenario = pgTable(
  "scenario",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    notes: text("notes"),
    isDefault: boolean("is_default").notNull().default(false),
    /** List order. */
    position: integer("position").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    overrides: jsonb("overrides").$type<StoredDoc>().notNull().default({}),
    settings: jsonb("settings").$type<StoredDoc>().notNull(),
    /** Count. */
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scenario_name_idx").on(sql`lower("name")`),
    uniqueIndex("scenario_default_idx").on(t.isDefault).where(sql`"is_default"`),
    check("scenario_name_length", sql`char_length("name") BETWEEN 1 AND 80`),
    check("scenario_overrides_object", sql`jsonb_typeof("overrides") = 'object'`),
    check("scenario_settings_object", sql`jsonb_typeof("settings") = 'object'`),
    check("scenario_default_not_archived", sql`NOT ("is_default" AND "archived")`),
    check("scenario_revision_check", sql`"revision" >= 1`),
  ],
);

/**
 * One simulation run of a scenario: the frozen `SimInput` (`input`, self-contained) and its hash,
 * copies of the fields the lists show, the versions and seed, progress, and once `done` the
 * summary, the fan chart and the exact success count. `paths` is the requested count until the
 * engine reports its own (the historical model runs every start year; inputs decision 25), so
 * there is no `paths_done <= paths` CHECK. At most one queued or running run per scenario
 * (`sim_run_active_idx`). List queries never read `input` or `fan`.
 */
export const simRun = pgTable(
  "sim_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scenarioId: uuid("scenario_id")
      .notNull()
      .references(() => scenario.id, { onDelete: "cascade" }),
    /** The scenario's name when the input was frozen. */
    scenarioName: text("scenario_name").notNull(),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
    status: text("status", { enum: SIM_RUN_STATUSES }).notNull().default("queued"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /** The frozen snapshot (`SimInput`). */
    input: jsonb("input").$type<StoredDoc>().notNull(),
    /** `input.schemaVersion` (count). */
    inputSchemaVersion: integer("input_schema_version").notNull(),
    /** SHA-256 of the input's canonical JSON without `meta` and names (shared `inputHash`): 64 lower-case hex digits. */
    inputHash: text("input_hash").notNull(),
    /** `input.settings.seed`, 0 to 4294967295. */
    seed: bigint("seed", { mode: "number" }).notNull(),
    /** The requested count; the engine's own from its first progress report on. */
    paths: integer("paths").notNull(),
    returnModel: text("return_model", { enum: RETURN_MODEL_KINDS }).notNull(),
    strategy: text("strategy", { enum: STRATEGY_KINDS }).notNull(),
    /** `input.settings.taxRuleSet`. */
    taxRuleSet: text("tax_rule_set").notNull(),
    /** `input.data.version`. */
    dataVersion: text("data_version").notNull(),
    /** Stamped by the worker when it starts the run. */
    engineVersion: text("engine_version"),
    /** `input.meta.asOf`. */
    baselineAsOf: date("baseline_as_of").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    scenarioRevision: integer("scenario_revision").notNull(),
    /** Worker threads used (count; 0 = inline). */
    threads: smallint("threads"),
    /** Count. */
    pathsDone: integer("paths_done").notNull().default(0),
    /** The last progress write (the heartbeat `requestCancel` reads). */
    progressAt: timestamp("progress_at", { withTimezone: true }),
    /** Exact count; the success rate is `success_paths / paths`. */
    successPaths: integer("success_paths"),
    /** `SimSummary`, cents as strings. */
    summary: jsonb("summary").$type<StoredDoc>(),
    /** `FanSeries`. */
    fan: jsonb("fan").$type<StoredDoc>(),
    /** The engine's warnings, `[{ code, message }]`. */
    warnings: jsonb("warnings").$type<Array<{ code: string; message: string }>>().notNull().default([]),
    errorCode: text("error_code"),
    /** Sanitized, at most 500 characters. */
    errorMessage: text("error_message"),
    /** Milliseconds. */
    durationMs: integer("duration_ms"),
    pinned: boolean("pinned").notNull().default(false),
    note: text("note"),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("sim_run_scenario_created_idx").on(t.scenarioId, t.createdAt.desc()),
    uniqueIndex("sim_run_active_idx").on(t.scenarioId).where(sql`"status" IN ('queued', 'running')`),
    index("sim_run_done_idx").on(t.scenarioId, t.finishedAt.desc()).where(sql`"status" = 'done'`),
    index("sim_run_hash_idx").on(t.scenarioId, t.inputHash),
    check("sim_run_status_check", sql`"status" IN ('queued', 'running', 'done', 'failed', 'cancelled')`),
    check("sim_run_seed_check", sql`"seed" >= 0 AND "seed" <= 4294967295`),
    check("sim_run_paths_check", sql`"paths" >= 1 AND "paths_done" >= 0`),
    check("sim_run_input_object", sql`jsonb_typeof("input") = 'object'`),
    check("sim_run_input_hash_shape", sql`"input_hash" ~ '^[0-9a-f]{64}$'`),
    check("sim_run_error_message_length", sql`"error_message" IS NULL OR char_length("error_message") <= 500`),
    check(
      "sim_run_done_shape",
      sql`"status" <> 'done' OR ("summary" IS NOT NULL AND "fan" IS NOT NULL AND "success_paths" IS NOT NULL AND "engine_version" IS NOT NULL AND "finished_at" IS NOT NULL AND "success_paths" >= 0 AND "success_paths" <= "paths" AND "paths_done" = "paths")`,
    ),
    check("sim_run_failed_shape", sql`"status" <> 'failed' OR "error_code" IS NOT NULL`),
  ],
);

/**
 * One value per path of a finished run, in path order: ending wealth, lifetime taxes and lifetime
 * spending in today's cents (`i64le`, 8 bytes each), and the calendar year the plan ran out
 * (`depletion_year`, `i16le`, 2 bytes each, −1 = never; seams C46). `count` = `sim_run.paths`.
 */
export const simRunSeries = pgTable(
  "sim_run_series",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => simRun.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SIM_RUN_SERIES_KINDS }).notNull(),
    encoding: text("encoding", { enum: SERIES_ENCODINGS }).notNull(),
    /** Values (count). */
    count: integer("count").notNull(),
    data: bytea("data").notNull(),
  },
  (t) => [
    primaryKey({ name: "sim_run_series_pk", columns: [t.runId, t.kind] }),
    check("sim_run_series_kind_check", sql`"kind" IN ('ending_real_cents', 'depletion_year', 'lifetime_tax_real_cents', 'lifetime_spending_real_cents')`),
    check(
      "sim_run_series_shape",
      sql`("kind" IN ('ending_real_cents', 'lifetime_tax_real_cents', 'lifetime_spending_real_cents') AND "encoding" = 'i64le' AND octet_length("data") = 8 * "count") OR ("kind" = 'depletion_year' AND "encoding" = 'i16le' AND octet_length("data") = 2 * "count")`,
    ),
  ],
);

/**
 * The stored year tables of a finished run: one real path per stored percentile (5, 10, 25, 50,
 * 75, 90, 95), the path the shared `rankPaths` puts at that rank (nearest rank on ending wealth in
 * today's dollars, then earlier depletion year, then path index). Any other percentile 1 to 99 is
 * re-simulated on request while the versions match.
 */
export const simRunPath = pgTable(
  "sim_run_path",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => simRun.id, { onDelete: "cascade" }),
    percentile: smallint("percentile").notNull(),
    /** The engine's path k (re-simulatable alone, L5). */
    pathIndex: integer("path_index").notNull(),
    /** Position in the rank order (0 = worst). */
    rank: integer("rank").notNull(),
    /** Ending wealth in today's cents. */
    endingRealCents: bigint("ending_real_cents", { mode: "bigint" }).notNull(),
    /** The first calendar year the plan ran out; null = never (seams C46). */
    depletionYear: integer("depletion_year"),
    /** `YearTable`, cents as strings. */
    yearTable: jsonb("year_table").$type<StoredDoc>().notNull(),
  },
  (t) => [
    primaryKey({ name: "sim_run_path_pk", columns: [t.runId, t.percentile] }),
    check("sim_run_path_percentile_check", sql`"percentile" BETWEEN 1 AND 99`),
    check("sim_run_path_index_check", sql`"path_index" >= 0 AND "rank" >= 0`),
    check("sim_run_path_year_table_object", sql`jsonb_typeof("year_table") = 'object'`),
  ],
);
