import { createDb } from "./index.js";
import { runMigrations } from "./migrate.js";

const { db, client } = createDb();
try {
  await runMigrations(db);
  console.log("[db] migrations applied");
} finally {
  await client.end();
}
