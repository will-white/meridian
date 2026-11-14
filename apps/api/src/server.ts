import { createDb, errorMessageOf } from "@meridian/db";
import { buildApp } from "./app.js";
import { prepareDatabase } from "./boot.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);

let keyWarning: string | null;
try {
  keyWarning = await prepareDatabase(db, config);
} catch (err) {
  // A wrong SECRETS_KEY (or an unreachable database) stops the server with the reason, before it serves anything.
  console.error(`[api] not starting: ${errorMessageOf(err)}`);
  await client.end({ timeout: 5 });
  process.exit(1);
}

const app = await buildApp({ db, config });
if (keyWarning) app.log.warn(keyWarning);

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
