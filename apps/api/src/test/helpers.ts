import type { InjectOptions, LightMyRequestResponse } from "fastify";
import * as OTPAuth from "otpauth";
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

export interface TestAppOptions {
  now?: () => Date;
  /** Config overrides, e.g. `webDistDir` (serve a built UI) or `trustProxy` (run behind a reverse proxy). */
  config?: Partial<ApiConfig>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const db = await createTestDb();
  const config: ApiConfig = {
    nodeEnv: "test",
    databaseUrl: "unused",
    host: "127.0.0.1",
    port: 0,
    trustProxy: [],
    sessionSecret: "test-session-secret-at-least-32-characters-long",
    secretsKey: generateSecretsKey(),
    webDistDir: undefined,
    sessionTtlDays: 1,
    secureCookies: false,
    ...options.config,
  };
  const app = await buildApp({ db: db.db, config, logger: false, ...(options.now ? { now: options.now } : {}) });
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

export const OWNER_PASSWORD = "correct horse battery staple";

/** Creates the owner through the API and enrolls two-factor, leaving `t` fully signed in. Returns the TOTP secret. */
export async function signInOwner(t: TestApp): Promise<string> {
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: OWNER_PASSWORD } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const secret = setup.json().secret as string;
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: totpCode(secret) } });
  return secret;
}

export function totpCode(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
}
