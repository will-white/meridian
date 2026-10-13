import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export interface ConnectionError {
  code: string;
  message: string;
  accountId?: string;
}

/** A data source: a SimpleFIN access URL, a CSV mapping profile, or manual entry. */
export const connection = pgTable("connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type", { enum: ["simplefin", "csv", "manual"] }).notNull(),
  name: text("name").notNull(),
  /** AES-256-GCM ciphertext of the SimpleFIN Access URL. Never logged, never stored in clear. */
  accessUrlEnc: text("access_url_enc"),
  /** AES-256-GCM ciphertext of a pasted setup token, waiting for the worker to claim it. Cleared after the claim. */
  claimTokenEnc: text("claim_token_enc"),
  /** For csv connections: the saved column mapping for one institution. */
  csvMapping: jsonb("csv_mapping").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["ok", "claiming", "auth_required", "error", "disabled"] }).notNull().default("ok"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  /** High-water mark of the last successful sync; the next window starts 7 days before it. */
  syncedThrough: date("synced_through"),
  lastError: text("last_error"),
  /** SimpleFIN errlist entries from the last sync, sanitized. */
  lastErrors: jsonb("last_errors").$type<ConnectionError[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every raw import response is kept so it can be re-processed. */
export const importLog = pgTable(
  "import_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connection.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["simplefin.claim", "simplefin.sync", "simplefin.balances", "csv"] }).notNull(),
    status: text("status", { enum: ["running", "ok", "error"] }).notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Raw SimpleFIN response or the CSV text, exactly as received. */
    rawPayload: jsonb("raw_payload"),
    stats: jsonb("stats").$type<Record<string, number>>(),
    errors: jsonb("errors").$type<ConnectionError[]>().notNull().default([]),
    message: text("message"),
  },
  (t) => [index("import_log_connection_idx").on(t.connectionId, t.startedAt)],
);

/** Background jobs for the worker. The API only enqueues; the worker claims with SKIP LOCKED. */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: ["simplefin.claim", "simplefin.sync", "simplefin.balances", "rules.run"] }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_status_run_at_idx").on(t.status, t.runAt)],
);
