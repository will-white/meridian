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

const settings = (block: string): Record<string, string> =>
  Object.fromEntries([...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(\S.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));

describe("deploy files: where the API listens and which proxy it trusts", () => {
  const compose = repo("deploy/docker-compose.yml");

  it("the web container listens on every interface, trusts only private-network peers, and publishes no port", () => {
    const web = composeService(compose, "web");
    const env = settings(web);
    expect(env["API_HOST"]).toBe("0.0.0.0");
    expect(env["TRUST_PROXY"]).toBe("uniquelocal");
    expect(parseTrustProxy(env["TRUST_PROXY"])).toEqual(["uniquelocal"]);
    // The shared settings still reach it through the merge key.
    expect(web).toContain("<<: *app-environment");
    expect(compose).toMatch(/environment: &app-environment\n\s+NODE_ENV: production\n\s+MERIDIAN_DB_HOST: db/);
    expect(web).not.toMatch(/^\s+ports:/m);
    expect(web).toMatch(/^\s+expose:\n\s+- "3000"/m);
  });

  it("only Caddy publishes ports, and the worker has no network settings of the API", () => {
    const proxy = composeService(compose, "proxy");
    expect(proxy).toMatch(/ports:\n\s+- "80:80"\n\s+- "443:443"/);
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
    const config = loadConfig({ ...example, SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "s" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.trustProxy).toEqual([]);
    expect(config.port).toBe(3000);
  });

  it(".env.example states the session lifetimes the API defaults to: 30 days, 14 idle", () => {
    const example = repo(".env.example");
    expect(example).toMatch(/^SESSION_TTL_DAYS=30$/m);
    expect(example).toMatch(/^SESSION_IDLE_DAYS=14$/m);
    const defaults = loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "s", DATABASE_URL: "postgres://x" });
    expect([defaults.sessionTtlDays, defaults.sessionIdleDays]).toEqual([30, 14]);
    const custom = loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "s", DATABASE_URL: "postgres://x", SESSION_TTL_DAYS: "7", SESSION_IDLE_DAYS: "2" });
    expect([custom.sessionTtlDays, custom.sessionIdleDays]).toEqual([7, 2]);
    expect(() => loadConfig({ SESSION_SECRET: "0123456789abcdef0123456789abcdef", SECRETS_KEY: "s", DATABASE_URL: "postgres://x", SESSION_IDLE_DAYS: "0" })).toThrow();
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
