import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A data source: a SimpleFIN access URL, a CSV mapping, or manual entry. */
export const connection = pgTable("connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type", { enum: ["simplefin", "csv", "manual"] }).notNull(),
  name: text("name").notNull(),
  /** AES-256-GCM ciphertext of the SimpleFIN Access URL. Never logged, never in backups unencrypted. */
  accessUrlEnc: text("access_url_enc"),
  /** For csv connections: the saved column mapping per institution. */
  csvMapping: jsonb("csv_mapping").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["ok", "auth_required", "error", "disabled"] }).notNull().default("ok"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every raw import response is kept so it can be re-processed. */
export const importLog = pgTable("import_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectionId: uuid("connection_id").notNull().references(() => connection.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  rawPayload: jsonb("raw_payload"),
  errors: jsonb("errors").$type<Array<{ code: string; msg: string; conn_id?: string; account_id?: string }>>(),
  transactionsUpserted: text("transactions_upserted"),
});
