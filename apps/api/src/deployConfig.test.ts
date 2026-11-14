import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, parseTrustProxy } from "./config.js";

/**
 * The deploy files and the API's network settings have to agree: inside Docker the API
 * listens on every interface and believes the proxy's forwarded headers; everywhere else it
 * binds loopback and believes nobody. Read as text (no Docker, no YAML parser needed).
 */
const repo = (relative: string) => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

/** The lines of one compose service (two-space key under `services:`), up to the next one. */
function composeService(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** `- NAME=value` entries of a service's environment list (a bare `- NAME` passes NAME from .env). */
const settings = (block: string): Record<string, string> =>
  Object.fromEntries([...block.matchAll(/^\s+- ([A-Z][A-Z0-9_]*)=(\S.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));

describe("deploy files: where the API listens and which proxy it trusts", () => {
  // docker-compose.yml includes services.yml, reading ../.env for its values.
  const compose = repo("deploy/services.yml");

  it("the web container listens on every interface, trusts only private-network peers, and publishes no port", () => {
    const web = composeService(compose, "web");
    const env = settings(web);
    expect(env["API_HOST"]).toBe("0.0.0.0");
    // .env may name the proxy; unset or empty, the web container trusts private-network peers (Caddy).
    expect(env["TRUST_PROXY"]).toBe("${TRUST_PROXY:-uniquelocal}");
    expect(parseTrustProxy(/^\$\{TRUST_PROXY:-(.+)\}$/.exec(env["TRUST_PROXY"] ?? "")?.[1])).toEqual(["uniquelocal"]);
    expect(env["NODE_ENV"]).toBe("production");
    expect(env["MERIDIAN_DB_HOST"]).toBe("db");
    expect(repo("deploy/docker-compose.yml")).toMatch(/include:\n\s+- path: \.\/services\.yml\n\s+env_file: \.\.\/\.env/);
    expect(web).not.toMatch(/^\s+ports:/m);
    expect(web).toMatch(/^\s+expose:\n\s+- "3000"/m);
  });

  it("only Caddy publishes ports, and the worker has no network settings of the API", () => {
    const proxy = composeService(compose, "proxy");
    expect(proxy).toMatch(/ports:\n\s+- "80:80"\n\s+- "443:443"/);
    // Audit a7-backup-deploy-secrets-10: no other service publishes one (db's loopback port is in docker-compose.dev.yml).
    for (const name of ["db", "web", "worker", "backup"]) expect(composeService(compose, name), name).not.toMatch(/^\s+ports:/m);
    const worker = settings(composeService(compose, "worker"));
    expect(worker["API_HOST"]).toBeUndefined();
    expect(worker["TRUST_PROXY"]).toBeUndefined();
    expect(repo("deploy/Caddyfile")).toMatch(/reverse_proxy web:3000/);
  });

  it("the image sets API_HOST=0.0.0.0; .env.example leaves the API on loopback with no trusted proxy", () => {
    expect(repo("apps/api/Dockerfile")).toMatch(/^ENV API_HOST=0\.0\.0\.0$/m);
    const example = Object.fromEntries(
      repo(".env.example")
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(example["API_HOST"]).toBeUndefined();
    expect(example["TRUST_PROXY"]).toBeUndefined();
    const config = loadConfig({ ...example, SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.trustProxy).toEqual([]);
    expect(config.port).toBe(3000);
  });

  it("a1-serve-and-guard (second round): the README and .env.example send a household to the file that sets TRUST_PROXY", () => {
    const readme = repo("README.md");
    const named = [...readme.matchAll(/`TRUST_PROXY` in `([^`]+)`/g)].map((m) => m[1]!);
    expect(named.length, "the README says where TRUST_PROXY is set").toBeGreaterThan(0);
    for (const file of named) {
      if (file === ".env") {
        // .env feeds compose (docker-compose.yml includes services.yml with it), and the web entry reads the value.
        expect(repo(".env.example")).toMatch(/^# TRUST_PROXY=$/m);
        expect(composeService(compose, "web")).toMatch(/^\s+- TRUST_PROXY=\$\{TRUST_PROXY:-uniquelocal\}$/m);
      } else {
        expect(repo(file), `${file} has a TRUST_PROXY entry`).toMatch(/^\s+- TRUST_PROXY=/m);
      }
    }
    // The example names where the default comes from and that .env overrides it.
    const example = repo(".env.example");
    expect(example).toMatch(/deploy\/services\.yml/);
    expect(example).not.toMatch(/The compose file sets `uniquelocal` for the web container\./);
  });

  it("a7-backup-deploy-secrets (second round): no document describes the shared env_file the compose layout no longer has", async () => {
    // Since audit a7-backup-deploy-secrets-07, services.yml passes each setting by name; the
    // `x-app-env` anchor and its `env_file: ../.env`, which gave every container all of .env, are gone.
    expect(repo("deploy/services.yml")).not.toMatch(/x-app-env|^\s+env_file:/m);
    const { readdirSync } = await import("node:fs");
    const dir = (relative: string) =>
      readdirSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `${relative}/${name}`);
    // Phase 4's documents belong to another team; the audit records quote the old layout on purpose.
    const documents = ["README.md", "docs/phase-1-plan.md", "docs/phase-2-plan.md", "docs/phase-3-plan.md", ...dir("docs/design/phase-2"), ...dir("docs/design/phase-3")];
    const stale: string[] = [];
    for (const file of documents) {
      repo(file)
        .split("\n")
        .forEach((line, i) => {
          if (/x-app-env|shared `?env_file/.test(line) && !/services\.yml/.test(line)) stale.push(`${file}:${i + 1}`);
        });
    }
    expect(stale).toEqual([]);
  });

  it(".env.example states the session lifetimes the API defaults to: 30 days, 14 idle", () => {
    const example = repo(".env.example");
    expect(example).toMatch(/^SESSION_TTL_DAYS=30$/m);
    expect(example).toMatch(/^SESSION_IDLE_DAYS=14$/m);
    const defaults = loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", DATABASE_URL: "postgres://x" });
    expect([defaults.sessionTtlDays, defaults.sessionIdleDays]).toEqual([30, 14]);
    const custom = loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", DATABASE_URL: "postgres://x", SESSION_TTL_DAYS: "7", SESSION_IDLE_DAYS: "2" });
    expect([custom.sessionTtlDays, custom.sessionIdleDays]).toEqual([7, 2]);
    expect(() => loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", DATABASE_URL: "postgres://x", SESSION_IDLE_DAYS: "0" })).toThrow();
  });

  it("the image ships the recovery command the README tells a locked-out owner to run", () => {
    // Built beside the server, copied with it, and documented with the path it has in the container.
    expect(JSON.parse(repo("apps/api/package.json")).scripts.build).toContain("bundle.mjs src/admin.ts dist/admin.js");
    expect(repo("apps/api/Dockerfile")).toMatch(/^COPY --from=build \/app\/apps\/api\/dist \.\/apps\/api\/dist$/m);
    const readme = repo("README.md");
    for (const command of ["users", "reset-totp <username>", "reset-password <username>", "sign-out <username>"]) {
      expect(readme, command).toContain(`docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js ${command}`);
    }
  });

  it("the Vite dev server proxies /api to the loopback address the API binds", () => {
    expect(repo("apps/web/vite.config.ts")).toContain('proxy: { "/api": "http://127.0.0.1:3000" }');
  });
});

describe("repository layout (audit a6-text-rules-accounts-21)", () => {
  it("has no stray root sources or superseded kickoff instructions (CLAUDE.md: apps/, packages/, deploy/, docs/)", async () => {
    const { existsSync } = await import("node:fs");
    const at = (relative: string) => existsSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)));
    expect(at("CLAUDE.md")).toBe(true);
    expect(at("src")).toBe(false);
    expect(at("KICKOFF.md")).toBe(false);
  });
});
