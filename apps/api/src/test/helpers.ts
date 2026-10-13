import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey } from "@meridian/shared";
import { buildApp, type App } from "../app.js";
import type { ApiConfig } from "../config.js";

export { TEST_DATABASE_URL };

export interface TestApp {
  app: App;
  db: TestDb;
  config: ApiConfig;
  /** Inject with the cookie jar applied and updated, like a browser would. */
  call: (opts: InjectOptions) => Promise<LightMyRequestResponse>;
  cookies: Record<string, string>;
  cleanup: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const db = await createTestDb();
  const config: ApiConfig = {
    nodeEnv: "test",
    databaseUrl: "unused",
    port: 0,
    sessionSecret: "test-session-secret-at-least-32-characters-long",
    secretsKey: generateSecretsKey(),
    webDistDir: undefined,
    sessionTtlDays: 1,
    secureCookies: false,
  };
  const app = await buildApp({ db: db.db, config, logger: false });
  await app.ready();
  const cookies: Record<string, string> = {};
  const call = async (opts: InjectOptions) => {
    const res = await app.inject({ ...opts, cookies: { ...cookies, ...(opts.cookies ?? {}) } });
    for (const c of res.cookies) {
      if (c.value === "" || (c.expires && c.expires.getTime() < Date.now())) delete cookies[c.name];
      else cookies[c.name] = c.value;
    }
    return res;
  };
  return {
    app,
    db,
    config,
    call,
    cookies,
    cleanup: async () => {
      await app.close();
      await db.cleanup();
    },
  };
}
