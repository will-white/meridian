/**
 * Recovery command line (see lib/adminCommands.ts). Bundled to dist/admin.js beside the server:
 *
 *   docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js users
 *   docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js reset-totp <username>
 *
 * It needs the database settings the server itself uses (DATABASE_URL, or MERIDIAN_DB_HOST
 * with POSTGRES_*); rotate-secrets-key and reset-secrets-key also read SECRETS_KEY (and
 * SECRETS_KEY_OLD). When the server refuses to start on a wrong key, run it with
 * `docker compose -f deploy/docker-compose.yml run --rm web node apps/api/dist/admin.js <command>`.
 */
import { createDb, errorMessageOf } from "@meridian/db";
import { resolveDatabaseUrl } from "./config.js";
import { runAdminCommand } from "./lib/adminCommands.js";

const { db, client } = createDb(resolveDatabaseUrl(), { max: 1 });
try {
  process.exitCode = await runAdminCommand(db, process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) });
} catch (error) {
  console.error(errorMessageOf(error));
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
