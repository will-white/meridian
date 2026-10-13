import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

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
});

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  port: number;
  sessionSecret: string;
  secretsKey: string;
  webDistDir: string | undefined;
  sessionTtlDays: number;
  secureCookies: boolean;
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
  };
}
