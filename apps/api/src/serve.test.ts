import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@meridian/db";
import { buildApp } from "./app.js";
import { createTestApp, OWNER_PASSWORD, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * The production shape: the API serves the built web app from WEB_DIST_DIR. The shell (HTML,
 * scripts, styles, service worker, manifest, icon) carries no household data and must load for
 * a browser with no session, or the setup and sign-in screens can never render. Only /api is guarded.
 *
 * The files are those `pnpm --filter @meridian/web build` writes (hashed names aside). There is no
 * registerSW.js: the page registers the service worker itself (vite.config.ts, injectRegister false).
 */
const FILES: Record<string, string> = {
  "index.html": '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>',
  "assets/index-abc123.js": "console.log('meridian');",
  "assets/index-abc123.css": "body{margin:0}",
  "sw.js": "self.addEventListener('install',()=>{});",
  "workbox-1a2b3c4d.js": "/* workbox */",
  "manifest.webmanifest": '{"name":"Meridian"}',
  "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
};
const ASSETS = Object.keys(FILES)
  .filter((f) => f !== "index.html")
  .map((f) => `/${f}`);

function writeDist(): string {
  const dist = mkdtempSync(path.join(tmpdir(), "meridian-dist-"));
  writeFileSync(path.join(dist, ".hidden"), "not part of the app");
  for (const [name, body] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
    writeFileSync(path.join(dist, name), body);
  }
  return dist;
}

describe("serving the built web app while the database is down", () => {
  it("still serves the shell: its files and the SPA fallback never query the database", async () => {
    const dist = writeDist();
    const down = new Proxy({}, { get: () => () => { throw new Error("the database is down"); } }) as unknown as Db; // prettier-ignore
    const app = await buildApp({
      db: down,
      logger: false,
      config: { nodeEnv: "test", databaseUrl: "unused", host: "127.0.0.1", port: 0, trustProxy: [], sessionSecret: "s".repeat(32), secretsKey: "unused", webDistDir: dist, sessionTtlDays: 1, sessionIdleDays: 1, secureCookies: false },
    });
    try {
      for (const url of [...ASSETS, "/", "/plan"]) {
        const res = await app.inject({ method: "GET", url, cookies: { meridian_session: "anything" } });
        expect(res.statusCode, url).toBe(200);
      }
      expect((await app.inject({ method: "HEAD", url: "/plan", cookies: { meridian_session: "anything" } })).statusCode).toBe(200);
      for (const url of ["/api/nope", "/api", "/assets/index-OLDHASH.js", "/registerSW.js"]) {
        expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
      }
      // The API itself does need the database.
      expect((await app.inject({ method: "GET", url: "/api/accounts" })).statusCode).toBe(500);
    } finally {
      await app.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("serving the built web app", () => {
  let t: TestApp;
  let dist: string;

  beforeAll(async () => {
    dist = writeDist();
    t = await createTestApp({ config: { webDistDir: dist } });
  });
  afterAll(async () => {
    await t?.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  async function expectShellLoads(cookies: Record<string, string>) {
    for (const url of ASSETS) {
      const res = await t.app.inject({ method: "GET", url, cookies });
      expect(res.statusCode, `GET ${url}`).toBe(200);
      expect(res.body, `GET ${url}`).toBe(FILES[url.slice(1)]);
      const head = await t.app.inject({ method: "HEAD", url, cookies });
      expect(head.statusCode, `HEAD ${url}`).toBe(200);
    }
    for (const url of ["/", "/index.html", "/plan", "/investments/holdings?account=1"]) {
      const res = await t.app.inject({ method: "GET", url, cookies });
      expect(res.statusCode, `GET ${url}`).toBe(200);
      expect(res.headers["content-type"], `GET ${url}`).toMatch(/^text\/html/);
      expect(res.body, `GET ${url}`).toBe(FILES["index.html"]);
    }
  }

  it("serves every file of the shell before the owner exists, while the API still asks for setup", async () => {
    await expectShellLoads({});
    const script = await t.app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(script.headers["content-type"]).toMatch(/javascript/);
    const styles = await t.app.inject({ method: "GET", url: "/assets/index-abc123.css" });
    expect(styles.headers["content-type"]).toMatch(/^text\/css/);
    const api = await t.app.inject({ method: "GET", url: "/api/accounts" });
    expect(api.statusCode).toBe(403);
    expect(api.json().code).toBe("setup_required");
  });

  it("serves the shell to a signed-out browser and to one that has not finished two-factor, while the API refuses both", async () => {
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: OWNER_PASSWORD } });
    const enrolling = { ...t.cookies };
    expect(enrolling["meridian_session"]).toBeTruthy();

    await expectShellLoads({});
    const anonymous = await t.app.inject({ method: "GET", url: "/api/accounts" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe("unauthorized");

    await expectShellLoads(enrolling);
    const half = await t.app.inject({ method: "GET", url: "/api/accounts", cookies: enrolling });
    expect(half.statusCode).toBe(403);
    expect(half.json().code).toBe("totp_enrollment_required");
  });

  it("answers unknown API paths and non-GET requests with a JSON 404, never the shell", async () => {
    const unknown = await t.app.inject({ method: "GET", url: "/api/nope" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "Not found", code: "not_found" });
    const post = await t.app.inject({ method: "POST", url: "/assets/index-abc123.js" });
    expect(post.statusCode).toBe(404);
    expect(post.json().code).toBe("not_found");
  });

  async function expectJson404(method: "GET" | "HEAD", url: string) {
    const res = await t.app.inject({ method, url });
    expect(res.statusCode, `${method} ${url}`).toBe(404);
    expect(res.headers["content-type"], `${method} ${url}`).toMatch(/^application\/json/);
    // (inject hands back what Fastify wrote even for HEAD; Node's server sends no body for HEAD.)
    expect(res.json(), `${method} ${url}`).toEqual({ error: "Not found", code: "not_found" });
  }

  it("answers a build file that does not exist with a JSON 404, never the shell (a stale chunk, a file this build has not got)", async () => {
    // After an update an open tab may still ask for the previous build's hashed files. HTML
    // under a script's URL fails under nosniff with a MIME-type error that hides the cause; a
    // 404 says what happened.
    for (const url of [
      "/assets/index-OLDHASH.js",
      "/assets/index-OLDHASH.css",
      "/assets/index-OLDHASH.js?v=1",
      "/assets/chunk",
      "/assets/",
      "/registerSW.js",
      "/workbox-00000000.js",
      "/favicon.ico",
      "/manifest.json",
      "/plan/report.pdf",
    ]) {
      await expectJson404("GET", url);
      await expectJson404("HEAD", url);
    }
  });

  it("treats /api itself, with or without a query, as an API path, and gives the shell to no method but GET and HEAD", async () => {
    for (const url of ["/api", "/api?x=1", "/api/", "/api/?x=1", "/api/nope?x=1", "/%61pi/nope"]) {
      await expectJson404("GET", url);
      await expectJson404("HEAD", url);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const res = await t.app.inject({ method, url: "/plan", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, payload: "{}" });
      expect(res.statusCode, `${method} /plan`).toBeGreaterThanOrEqual(400);
      expect(res.body, `${method} /plan`).not.toBe(FILES["index.html"]);
    }
  });

  it("answers HEAD of an app route as it answers GET: 200 with the shell's headers and no body", async () => {
    for (const url of ["/", "/plan", "/investments/holdings?account=1", "/investments/accounts/12", "/plan?month=2026.11"]) {
      const get = await t.app.inject({ method: "GET", url });
      expect(get.statusCode, `GET ${url}`).toBe(200);
      expect(get.body, `GET ${url}`).toBe(FILES["index.html"]);
      const head = await t.app.inject({ method: "HEAD", url });
      expect(head.statusCode, `HEAD ${url}`).toBe(200);
      expect(head.headers["content-type"], `HEAD ${url}`).toMatch(/^text\/html/);
      expect(head.headers["content-type"], `HEAD ${url}`).toBe(get.headers["content-type"]);
      expect(head.body, `HEAD ${url}`).toBe("");
    }
  });

  it("does not serve dotfiles or anything outside the build directory", async () => {
    // A stray dotfile in the build directory (written after boot or before) is never a route.
    writeFileSync(path.join(dist, ".env"), "SECRET=1");
    for (const url of ["/.env", "/.hidden", "/../package.json", "/assets/../../package.json", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fpackage.json"]) {
      const res = await t.app.inject({ method: "GET", url });
      // Unknown paths fall back to the shell (or a 4xx); they never return another file's bytes.
      if (res.statusCode === 200) expect(res.body, url).toBe(FILES["index.html"]);
      else expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });
});
