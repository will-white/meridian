import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { parsePriceProviderId, placeholderSecretProblem, secretsKeyProblem, type PriceProviderId } from "@meridian/shared";

/**
 * SECRETS_KEY from the environment, or from a Docker secret file named by SECRETS_KEY_FILE;
 * it must be 32 bytes of base64 (audit a7-backup-deploy-secrets-06). `name` reads another key
 * the same way (SECRETS_KEY_OLD for the key rotation).
 */
export function readSecretsKey(env: NodeJS.ProcessEnv = process.env, name = "SECRETS_KEY"): string {
  const file = env[`${name}_FILE`];
  const fromFile = file ? readFileSync(file, "utf8").trim() : "";
  const key = fromFile || env[name]?.trim() || "";
  if (!key) throw new Error(`${name} (or ${name}_FILE) must be set; generate one with \`openssl rand -base64 32\``);
  const problem = secretsKeyProblem(key, name);
  if (problem) throw new Error(problem);
  return key;
}

/** In production, stop on the .env.example database password (audit a7-backup-deploy-secrets-17). */
export function productionDatabaseProblem(databaseUrl: string): string | null {
  let password = "";
  try {
    password = decodeURIComponent(new URL(databaseUrl).password);
  } catch {
    return null;
  }
  return placeholderSecretProblem("POSTGRES_PASSWORD", password);
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

/** Address ranges `TRUST_PROXY` may name instead of spelling them out (the proxy-addr presets Fastify understands). */
const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * `TRUST_PROXY`: the reverse proxy's address(es), comma separated: IPs, CIDR ranges, or the
 * presets `loopback`, `linklocal` and `uniquelocal` (10/8, 172.16/12, 192.168/16, fc00::/7).
 * Only a peer on this list may state the client's address and the public host through
 * `X-Forwarded-For` / `X-Forwarded-Host`; from anyone else the headers are ignored. Empty
 * (the default) trusts nobody. "Trust every peer" and hop counts are refused on purpose: a
 * client that reaches the port directly could then pick its own address and dodge the
 * sign-in rate limits.
 */
export function parseTrustProxy(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const lowered = entries.map((entry) => entry.toLowerCase());
  if (lowered.length === 1 && ["false", "off", "none", "0"].includes(lowered[0]!)) return [];
  for (const entry of lowered) {
    if (TRUST_PROXY_PRESETS.has(entry)) continue;
    const [address = "", prefix, ...rest] = entry.split("/");
    const family = isIP(address);
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
    if (family === 0 || !prefixOk || rest.length > 0) {
      throw new Error(`TRUST_PROXY must list the reverse proxy's addresses (an IP, a CIDR range, or loopback, linklocal, uniquelocal), not "${entry}"`);
    }
  }
  return lowered;
}

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Interface to listen on. Loopback unless told otherwise; the Docker image sets 0.0.0.0 so the proxy container can reach it. */
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** Directory with the built web app; served by the API in production. */
  WEB_DIST_DIR: z.string().optional(),
  /** A signed-in session ends after this many days, however often it is used. */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** A signed-in session ends after this many days without a request. */
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * Phase 3 price feed, read here for display and the `not_configured` state only; the API
   * never reads the key. Normalized by the shared `parsePriceProviderId` (as the worker does),
   * so one .env value boots both or fails both with the same message.
   */
  PRICE_PROVIDER: z.string().optional(),
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
  /** Interface the server binds (`API_HOST`). */
  host: string;
  port: number;
  /** Peers whose `X-Forwarded-*` headers are believed (`TRUST_PROXY`); empty trusts nobody. */
  trustProxy: string[];
  sessionSecret: string;
  secretsKey: string;
  webDistDir: string | undefined;
  /** Absolute lifetime of a signed-in session (`SESSION_TTL_DAYS`). */
  sessionTtlDays: number;
  /** Allowed inactivity of a signed-in session (`SESSION_IDLE_DAYS`). */
  sessionIdleDays: number;
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
  const databaseUrl = resolveDatabaseUrl(env);
  if (production) {
    const problem = placeholderSecretProblem("SESSION_SECRET", parsed.SESSION_SECRET) ?? productionDatabaseProblem(databaseUrl);
    if (problem) throw new Error(problem);
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    sessionSecret: parsed.SESSION_SECRET,
    secretsKey: readSecretsKey(env),
    webDistDir: parsed.WEB_DIST_DIR ?? (production ? path.resolve(process.cwd(), "apps/web/dist") : undefined),
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    sessionIdleDays: parsed.SESSION_IDLE_DAYS,
    secureCookies: production,
    priceProvider: parsePriceProviderId(parsed.PRICE_PROVIDER),
    priceFetchHour: parsed.PRICE_FETCH_HOUR,
    priceCatchupHour: parseCatchupHour(parsed.PRICE_CATCHUP_HOUR),
  };
}
