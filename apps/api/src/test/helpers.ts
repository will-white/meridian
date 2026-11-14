import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { createSession, user } from "@meridian/db";
import { createTestDb, fakePlannerEngine, fakePlannerEnv, TEST_DATABASE_URL, type FakePlannerEngine, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey, type PlannerEnv } from "@meridian/shared";
import { buildApp, type App } from "../app.js";
import type { ApiConfig } from "../config.js";
import { defaultPlanner, type Planner } from "../planner.js";

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
  /** The sign-in clock (sessions, authenticator codes); the real time unless a test moves it. */
  authNow?: () => Date;
  /** Config overrides, e.g. `webDistDir` (serve a built UI) or `trustProxy` (run behind a reverse proxy). */
  config?: Partial<ApiConfig>;
  /** The retirement planner's engine (`app.planner`): the real engine unless given, e.g. `fakePlanner()`. */
  planner?: Planner;
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
    sessionIdleDays: 1,
    secureCookies: false,
    ...options.config,
  };
  const app = await buildApp({
    db: db.db,
    config,
    logger: false,
    ...(options.now ? { now: options.now } : {}),
    ...(options.authNow ? { authNow: options.authNow } : {}),
    ...(options.planner ? { planner: options.planner } : {}),
  });
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

export interface FakePlanner extends Planner {
  /** The fake `simulatePath`, which records the path indexes it was asked for. */
  readonly engine: FakePlannerEngine;
}

/**
 * The fake planner of the planner's API cases (docs/design/phase-4/inputs-and-data.md §7, cases 32
 * to 37): the fake engine of packages/db's lifecycle cases, so that runs drained with
 * `drainFakeRuns` are current under it (its engine and data versions; its `validateInput` refuses
 * seed 4294967295) and `simulatePath` re-simulates their paths consistently; `engine` makes it
 * disagree with the stored series when asked (`endingOffset`, `not_reproducible`). The meta's
 * tables and routes 22 to 24 are the real engine's (pure, nothing to fake), with the rule sets
 * narrowed to the fake environment's.
 */
export function fakePlanner(o: { env?: Partial<PlannerEnv>; engine?: FakePlannerEngine } = {}): FakePlanner {
  const real = defaultPlanner();
  const env = fakePlannerEnv(o.env);
  const engine = o.engine ?? fakePlannerEngine();
  return {
    ...real,
    env,
    engine,
    simulatePath: (input, pathIndex) => engine.simulatePath(input, pathIndex),
    ruleSets: real.ruleSets.filter((r) => env.ruleSets.includes(r.id)),
  };
}

export const OWNER_PASSWORD = "correct horse battery staple";

/**
 * Creates the owner through the API and enrolls two-factor, leaving `t` fully signed in. Returns the TOTP secret.
 * With a moved sign-in clock, pass it as `now` so the enrollment code is the one for that moment.
 */
export async function signInOwner(t: TestApp, now: () => Date = () => new Date()): Promise<string> {
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: OWNER_PASSWORD } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const secret = setup.json().secret as string;
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: totpCode(secret, now()) } });
  return secret;
}

export type CookieJar = Record<string, string>;

/** The session cookie a response set, as a jar for `inject({ cookies })`; undefined when it set none. */
export function sessionJar(res: LightMyRequestResponse): CookieJar | undefined {
  const c = res.cookies.find((cookie) => cookie.name === "meridian_session" && cookie.value !== "");
  return c ? { meridian_session: c.value } : undefined;
}

/** A password sign-in from its own browser (no shared jar). `address` keeps the per-address limits out of the way. */
export async function passwordSignIn(t: TestApp, username: string, password: string, address = "127.0.0.1"): Promise<{ res: LightMyRequestResponse; jar: CookieJar }> {
  const res = await t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: address, payload: { username, password } });
  return { res, jar: sessionJar(res) ?? {} };
}

/** A six-digit code the authenticator would not show at `at` or one step either side. */
export function wrongTotpCode(secret: string, at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  const valid = new Set([-30_000, 0, 30_000].map((d) => totpCode(secret, ms + d)));
  return ["000000", "111111", "222222", "333333"].find((c) => !valid.has(c))!;
}

/** The authenticator's code for `secret` at a moment (now by default). */
export function totpCode(secret: string, at: Date | number = Date.now()): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: typeof at === "number" ? at : at.getTime() });
}

/** A clock a test can move: pass `now` as `authNow`, then `advance` past a code's 30 seconds or a session's lifetime. */
export interface TestClock {
  now: () => Date;
  advance: (ms: number) => void;
}

export function testClock(start: Date = new Date()): TestClock {
  let ms = start.getTime();
  return { now: () => new Date(ms), advance: (by) => void (ms += by) };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

/** A session row written directly (no sign-in); returns the cookie jar for inject(). */
export async function sessionCookies(t: TestApp, userId: string, options: { totpVerified?: boolean; now?: Date } = {}): Promise<Record<string, string>> {
  const verified = options.totpVerified ?? true;
  const s = await createSession(t.db.db, { userId, totpVerified: verified, ttlMs: verified ? DAY : 10 * MINUTE, idleMs: verified ? DAY : 10 * MINUTE, now: options.now ?? new Date(), ip: null, userAgent: null });
  return { meridian_session: t.app.signCookie(s.token) };
}

/** A viewer-role user with a verified session, inserted directly; returns the cookie jar for inject(). */
export async function viewerCookies(t: TestApp): Promise<Record<string, string>> {
  const [row] = await t.db.db
    .insert(user)
    .values({ username: `viewer-${randomBytes(4).toString("hex")}`, passwordHash: "never-verified", role: "viewer", totpConfirmedAt: new Date() })
    .returning({ id: user.id });
  return sessionCookies(t, row!.id);
}
