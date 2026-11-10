/**
 * Recovery command line (see lib/adminCommands.ts). Bundled to dist/admin.js beside the server:
 *
 *   docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js users
 *   docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js reset-totp <username>
 *
 * It needs only the database settings the server itself uses (DATABASE_URL, or
 * MERIDIAN_DB_HOST with POSTGRES_*), not the session or encryption keys.
 */
import { createDb } from "@meridian/db";
import { resolveDatabaseUrl } from "./config.js";
import { runAdminCommand } from "./lib/adminCommands.js";

const { db, client } = createDb(resolveDatabaseUrl(), { max: 1 });
try {
  process.exitCode = await runAdminCommand(db, process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
