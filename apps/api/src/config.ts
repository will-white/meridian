import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PriceProviderId } from "@meridian/shared";

/** SECRETS_KEY from the environment, or from a Docker secret file named by SECRETS_KEY_FILE. */
export function readSecretsKey(env: NodeJS.ProcessEnv = process.env): string {
  const file = env["SECRETS_KEY_FILE"];
  const fromFile = file ? readFileSync(file, "utf8").trim() : "";
  const key = fromFile || env["SECRETS_KEY"]?.trim() || "";
  if (!key) throw new Error("SECRETS_KEY (or SECRETS_KEY_FILE) must be set; generate one with `openssl rand -base64 32`");
  return key;
}

/**
 * In Docker the compose file sets MERIDIAN_DB_HOST and the container gets POSTGRES_*
 * from the env file, so the URL is assembled here rather than interpolated by compose
 * (which reads a different .env). Outside Docker, DATABASE_URL is used as given.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env["MERIDIAN_DB_HOST"];
  if (host) {
    const user = env["POSTGRES_USER"] ?? "meridian";
    const password = env["POSTGRES_PASSWORD"] ?? "";
    const db = env["POSTGRES_DB"] ?? "meridian";
    const port = env["MERIDIAN_DB_PORT"] ?? "5432";
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
  }
  const url = env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL (or MERIDIAN_DB_HOST with POSTGRES_*) must be set");
  return url;
}

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** Directory with the built web app; served by the API in production. */
  WEB_DIST_DIR: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Phase 3 price feed, read here for display and the `not_configured` state only; the API never reads the key. */
  PRICE_PROVIDER: z.enum(["tiingo", "none"]).default("none"),
  PRICE_FETCH_HOUR: z.coerce.number().int().min(0).max(23).default(18),
  PRICE_CATCHUP_HOUR: z.string().default("6"),
});

/** `PRICE_CATCHUP_HOUR`: an hour 0..23, or `off` (null) when the morning catch-up is disabled. */
export function parseCatchupHour(value: string | undefined, fallback = 6): number | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "false") return null;
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  port: number;
  sessionSecret: string;
  secretsKey: string;
  webDistDir: string | undefined;
  sessionTtlDays: number;
  secureCookies: boolean;
  /**
   * Phase 3 price feed as the worker sees it (`PRICE_PROVIDER`; null = `none`), for the Prices
   * page and the dashboard's feed block. loadConfig always sets these; a hand-built config
   * without them means no provider (the routes read `config.priceProvider ?? null`).
   */
  priceProvider?: PriceProviderId | null;
  /** Household-local hour of the nightly fetch (display only). */
  priceFetchHour?: number;
  /** Household-local hour of the conditional catch-up; null = off (display only). */
  priceCatchupHour?: number | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = Env.parse(env);
  const production = parsed.NODE_ENV === "production";
  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: resolveDatabaseUrl(env),
    port: parsed.API_PORT,
    sessionSecret: parsed.SESSION_SECRET,
    secretsKey: readSecretsKey(env),
    webDistDir: parsed.WEB_DIST_DIR ?? (production ? path.resolve(process.cwd(), "apps/web/dist") : undefined),
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    secureCookies: production,
    priceProvider: parsed.PRICE_PROVIDER === "none" ? null : parsed.PRICE_PROVIDER,
    priceFetchHour: parsed.PRICE_FETCH_HOUR,
    priceCatchupHour: parseCatchupHour(parsed.PRICE_CATCHUP_HOUR),
  };
}
