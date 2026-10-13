import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { schema };

export interface CreateDbOptions {
  max?: number;
  /** Pin every connection to one schema. */
  searchPath?: string;
  /** Postgres NOTICE handler; silent by default. */
  onNotice?: (notice: postgres.Notice) => void;
}

export function createDb(url = process.env.DATABASE_URL, options: CreateDbOptions = {}) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: options.onNotice ?? (() => {}),
    ...(options.searchPath ? { connection: { search_path: options.searchPath } } : {}),
    // Money is bigint; make sure int8 comes back as bigint, never a float.
    types: { bigint: postgres.BigInt },
  });
  return { db: drizzle(client, { schema }), client };
}

export type DbClient = ReturnType<typeof createDb>["client"];
export type Db = ReturnType<typeof createDb>["db"];
/** A db or a transaction handle: services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export * from "./migrate.js";
export * from "./services/index.js";
