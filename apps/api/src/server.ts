import { createDb, getHouseholdSetting, runMigrations, seedDefaultCategories } from "@meridian/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);

await runMigrations(db);
await seedDefaultCategories(db);
// The household_setting singleton exists from the first request on, so a viewer's GET never has to create it.
await getHouseholdSetting(db);

const app = await buildApp({ db, config });

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
