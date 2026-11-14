import { describe, expect, it } from "vitest";
import type { Db } from "@meridian/db";
import { buildApp } from "./app.js";
import { parsePriceProviderId } from "@meridian/shared";
import { loadConfig, parseCatchupHour, parseTrustProxy } from "./config.js";

/**
 * The API's environment (plan decision 10): `PRICE_PROVIDER` goes through the shared
 * `parsePriceProviderId`, exactly as the worker's `readPriceProvider` does, so a value that
 * boots one container boots the other (and a bad one fails both with the same message).
 */

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes, base64
const BASE = { DATABASE_URL: "postgres://x", SECRETS_KEY: KEY, SESSION_SECRET: "0123456789abcdef0123456789abcdef" };

describe("loadConfig: PRICE_PROVIDER", () => {
  it("defaults to no provider and accepts the worker's spellings: empty, `none` in any case, surrounding spaces", () => {
    expect(loadConfig(BASE).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "" }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "none" }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: " None " }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "tiingo" }).priceProvider).toBe("tiingo");
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: " Tiingo\n" }).priceProvider).toBe("tiingo");
  });

  it("refuses an unknown provider with the shared message", () => {
    expect(() => loadConfig({ ...BASE, PRICE_PROVIDER: "stooq" })).toThrow('PRICE_PROVIDER must be "tiingo" or "none", not "stooq"');
    for (const value of ["", "none", " None ", "tiingo", " Tiingo ", "stooq"]) {
      let shared: string | null | Error;
      let api: string | null | Error;
      try {
        shared = parsePriceProviderId(value);
      } catch (err) {
        shared = err as Error;
      }
      try {
        api = loadConfig({ ...BASE, PRICE_PROVIDER: value }).priceProvider ?? null;
      } catch (err) {
        api = err as Error;
      }
      expect(api instanceof Error ? api.message : api, value).toEqual(shared instanceof Error ? shared.message : shared);
    }
  });

  it("carries the display hours beside the provider", () => {
    const config = loadConfig({ ...BASE, PRICE_PROVIDER: "tiingo", PRICE_FETCH_HOUR: "17", PRICE_CATCHUP_HOUR: "off" });
    expect(config).toMatchObject({ priceProvider: "tiingo", priceFetchHour: 17, priceCatchupHour: null });
    expect(parseCatchupHour("7")).toBe(7);
    expect(parseCatchupHour("25")).toBe(6);
  });
});

describe("loadConfig: where the API listens and whose forwarded headers it believes", () => {
  it("binds loopback unless API_HOST says otherwise (the Docker image sets 0.0.0.0)", () => {
    expect(loadConfig(BASE).host).toBe("127.0.0.1");
    expect(loadConfig({ ...BASE, API_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadConfig({ ...BASE, API_HOST: " ::1 " }).host).toBe("::1");
  });

  it("trusts no proxy by default and otherwise only the listed addresses, ranges and presets", () => {
    expect(loadConfig(BASE).trustProxy).toEqual([]);
    expect(parseTrustProxy("")).toEqual([]);
    expect(parseTrustProxy("false")).toEqual([]);
    expect(parseTrustProxy(" Off ")).toEqual([]);
    expect(loadConfig({ ...BASE, TRUST_PROXY: "uniquelocal" }).trustProxy).toEqual(["uniquelocal"]);
    expect(parseTrustProxy("172.18.0.5, 10.0.0.0/8 ,Loopback,fd00::/8,::1")).toEqual(["172.18.0.5", "10.0.0.0/8", "loopback", "fd00::/8", "::1"]);
  });

  it("hands Fastify a list it accepts: every form boots, and only a listed peer's X-Forwarded-Host is believed", async () => {
    const config = loadConfig({ ...BASE, NODE_ENV: "test", TRUST_PROXY: "172.18.0.5, 10.0.0.0/8, loopback, linklocal, uniquelocal, fd00::/8, ::1" });
    const app = await buildApp({ db: {} as Db, config, logger: false });
    app.get("/seen-host", { config: { auth: "static" } }, async (request) => ({ host: request.host, ip: request.ip }));
    try {
      const forwarded = { host: "web:3000", "x-forwarded-host": "meridian.local", "x-forwarded-for": "203.0.113.7" };
      const viaProxy = await app.inject({ method: "GET", url: "/seen-host", remoteAddress: "172.18.0.5", headers: forwarded });
      expect(viaProxy.json()).toEqual({ host: "meridian.local", ip: "203.0.113.7" });
      const direct = await app.inject({ method: "GET", url: "/seen-host", remoteAddress: "203.0.113.50", headers: forwarded });
      expect(direct.json()).toEqual({ host: "web:3000", ip: "203.0.113.50" });
    } finally {
      await app.close();
    }
  });

  it("refuses to trust every peer, a hop count, a hostname or a malformed range", () => {
    for (const value of ["true", "1", "2", "*", "proxy", "caddy.local", "10.0.0.0/33", "10.0.0.0/8/8", "fd00::/129", "10.0.0", "uniquelocal,true"]) {
      expect(() => parseTrustProxy(value), value).toThrow(/^TRUST_PROXY must list the reverse proxy's addresses/);
    }
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: "true" })).toThrow('TRUST_PROXY must list the reverse proxy\'s addresses (an IP, a CIDR range, or loopback, linklocal, uniquelocal), not "true"');
  });
});

describe("loadConfig: the encryption key and placeholder secrets (audit a7-backup-deploy-secrets-06, -17)", () => {
  it("refuses a SECRETS_KEY that is not 32 bytes of base64, naming the problem, and accepts one that is", () => {
    expect(() => loadConfig({ ...BASE, SECRETS_KEY: "not-base64-at-all!!" })).toThrow(/SECRETS_KEY must be 32 random bytes in base64 \(openssl rand -base64 32\); this value is not base64/);
    // openssl rand -hex 32: 64 hex characters, which base64-decode to 48 bytes.
    expect(() => loadConfig({ ...BASE, SECRETS_KEY: "ab".repeat(32) })).toThrow(/decodes to 48 bytes.*hex/);
    expect(() => loadConfig({ ...BASE, SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZg==" })).toThrow(/decodes to 16 bytes/);
    expect(loadConfig(BASE).secretsKey).toBe(KEY);
    expect(loadConfig({ ...BASE, SECRETS_KEY: ` ${KEY}\n` }).secretsKey).toBe(KEY);
  });

  it("in production refuses the .env.example placeholders for SESSION_SECRET and the database password", () => {
    const prod = { ...BASE, NODE_ENV: "production" };
    expect(() => loadConfig({ ...prod, SESSION_SECRET: "change-me-to-64-random-hex-chars" })).toThrow(/SESSION_SECRET is the \.env\.example placeholder/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: undefined, MERIDIAN_DB_HOST: "db", POSTGRES_USER: "meridian", POSTGRES_PASSWORD: "change-me", POSTGRES_DB: "meridian" })).toThrow(/POSTGRES_PASSWORD is the \.env\.example placeholder/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: "postgres://meridian:change-me@localhost:5432/meridian" })).toThrow(/POSTGRES_PASSWORD is the \.env\.example placeholder/);
    expect(loadConfig({ ...prod, DATABASE_URL: "postgres://meridian:s3cret-and-long@db:5432/meridian" }).databaseUrl).toContain("s3cret");
    // Development keeps working with the example's database password.
    expect(loadConfig({ ...BASE, DATABASE_URL: "postgres://meridian:change-me@localhost:5432/meridian" }).nodeEnv).toBe("development");
  });

  it(".env.example leaves SESSION_SECRET empty, so the API does not start until it is set", async () => {
    const { readFileSync } = await import("node:fs");
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^SESSION_SECRET=$/m);
    expect(() => loadConfig({ ...BASE, SESSION_SECRET: "" })).toThrow(/SESSION_SECRET must be at least 32 characters/);
  });
});
