import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./index.js";

/**
 * Folder with drizzle-kit output. Resolved from this file in development; the
 * bundled API and worker set MERIDIAN_MIGRATIONS_DIR because import.meta.url then
 * points at the bundle.
 */
export const migrationsFolder =
  process.env.MERIDIAN_MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export async function runMigrations(db: Db, options: { migrationsSchema?: string } = {}): Promise<void> {
  await migrate(db, {
    migrationsFolder,
    migrationsTable: "__drizzle_migrations",
    ...(options.migrationsSchema ? { migrationsSchema: options.migrationsSchema } : {}),
  });
}
