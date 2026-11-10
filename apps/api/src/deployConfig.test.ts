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

  it("the Vite dev server proxies /api to the loopback address the API binds", () => {
    expect(repo("apps/web/vite.config.ts")).toContain('proxy: { "/api": "http://127.0.0.1:3000" }');
  });
});
