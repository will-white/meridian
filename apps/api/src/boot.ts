import { getHouseholdSetting, runMigrations, seedDefaultCategories, verifySecretsKey, type Db } from "@meridian/db";
import type { ApiConfig } from "./config.js";

/**
 * Everything the API does to its database before it listens: migrations, the default
 * categories, the household_setting singleton (so a viewer's GET never has to create it), and
 * the check that SECRETS_KEY opens the stored secrets (audit a7-backup-deploy-secrets-06).
 * Throws SECRETS_KEY_MISMATCH when it opens none of them; returns a warning when only some.
 */
export async function prepareDatabase(db: Db, config: Pick<ApiConfig, "secretsKey">): Promise<string | null> {
  await runMigrations(db);
  await seedDefaultCategories(db);
  await getHouseholdSetting(db);
  return verifySecretsKey(db, config.secretsKey);
}
