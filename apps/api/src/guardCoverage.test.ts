import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_LIST_ITEMS } from "./plugins/requestGuards.js";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * The request guards cover every route the app registers, the web app's files included.
 *
 * Zod 3 validates every element of an over-long array, and the upstream fix for that (advisory
 * GHSA-mrhx-c7xc-m3w5) exists only in Zod 4. The app stays on Zod 3 because the guard refuses any
 * list or map over `MAX_LIST_ITEMS` with 413 before a contract sees it (docs/phase-1-plan.md,
 * decisions 4 and 117). That only holds if no route escapes the guard, so this suite takes the
 * routes from Fastify itself as they are registered, not from a list kept by hand: a route added
 * later is checked without anyone remembering to add it here.
 */

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SHELL = '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>';

function writeDist(): string {
  const dist = mkdtempSync(path.join(tmpdir(), "meridian-dist-"));
  const files: Record<string, string> = {
    "index.html": SHELL,
    "assets/index-abc123.js": "console.log('meridian');",
    "assets/index-abc123.css": "body{margin:0}",
    "sw.js": "self.addEventListener('install',()=>{});",
    "manifest.webmanifest": '{"name":"Meridian"}',
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
    writeFileSync(path.join(dist, name), body);
  }
  return dist;
}

/**
 * Builds the app with `webDistDir` set (so the static scope's file routes exist too) and records
 * every route Fastify registers. Fastify publishes each instance it creates on the
 * `fastify.initialization` diagnostics channel before anything is registered on it (Hooks.md,
 * "Diagnostics Channel Hook"), and an `onRoute` hook on the root sees the routes of every scope.
 * The route options object is kept, not copied: the static scope's own `onRoute` hook sets
 * `auth: "static"` on it after this one has run.
 */
async function buildRecordingRoutes(dist: string): Promise<{ t: TestApp; routes: RouteOptions[] }> {
  const routes: RouteOptions[] = [];
  const onInit = (message: unknown) => {
    (message as { fastify: FastifyInstance }).fastify.addHook("onRoute", (route) => {
      routes.push(route);
    });
  };
  subscribe("fastify.initialization", onInit);
  try {
    const t = await createTestApp({ config: { webDistDir: dist } });
    return { t, routes };
  } finally {
    unsubscribe("fastify.initialization", onInit);
  }
}

const authLevel = (route: RouteOptions) => (route.config as { auth?: string } | undefined)?.auth ?? "full";

describe.skipIf(!TEST_DATABASE_URL)("the request guards cover every registered route", () => {
  let t: TestApp;
  let routes: RouteOptions[];
  let dist: string;
  beforeAll(async () => {
    dist = writeDist();
    ({ t, routes } = await buildRecordingRoutes(dist));
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  it("records the API's routes and the web app's files from Fastify itself", () => {
    const seen = new Set(routes.flatMap((r) => [r.method].flat().map((m) => `${m} ${r.url}`)));
    for (const known of ["GET /api/health", "POST /api/auth/login", "POST /api/auth/setup", "GET /api/accounts", "PUT /api/plan/cells", "POST /api/import/csv/preview", "GET /assets/index-abc123.js", "GET /sw.js"]) {
      expect(seen.has(known), known).toBe(true);
    }
    // Every auth level is among them: public sign-in routes, two-factor routes, the default and the files.
    expect(new Set(routes.map(authLevel))).toEqual(new Set(["public", "session", "full", "static"]));
    expect(routes.length).toBeGreaterThan(150);
  });

  it("refuses a list over the limit with 413 on every route, whatever its method or auth level, before its contract runs", async () => {
    // The oversized list is in the query string, which every route has: the same preValidation hook
    // checks the body, the query and the path parameters (requestGuards.ts), and a body would meet
    // the sign-in routes' 8 KiB limit first. 5,001 repetitions of one key parse to one array.
    const query = `?${Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "x=0").join("&")}`;
    const missed: string[] = [];
    let checked = 0;
    for (const route of routes) {
      for (const method of [route.method].flat()) {
        const url = route.url.replace(/:[A-Za-z]+/g, UUID).replace(/\*/g, "x");
        const res = await t.call({ method: method as "GET", url: `${url}${query}` });
        checked++;
        const code = method === "HEAD" ? "(no body)" : (res.json() as { code?: string }).code;
        if (res.statusCode !== 413 || (method !== "HEAD" && code !== "too_many_items")) missed.push(`${method} ${route.url} [${authLevel(route)}]: ${res.statusCode} ${code}`);
      }
    }
    expect(missed).toEqual([]);
    expect(checked).toBeGreaterThan(150);
  });
});

/** A GET sent as written: `inject` and `fetch` resolve `.` and `..` segments before they leave, a browser's address bar too, a hand-written request does not. */
function rawGet(port: number, rawPath: string, cookie?: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers: cookie ? { cookie } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!TEST_DATABASE_URL)("a guarded route under other spellings of its path (@fastify/static advisories)", () => {
  let t: TestApp;
  let dist: string;
  let port: number;
  let ownerCookie: string;
  beforeAll(async () => {
    dist = writeDist();
    t = await createTestApp({ config: { webDistDir: dist } });
    await signInOwner(t);
    ownerCookie = Object.entries(t.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    port = (t.app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await t?.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  // Percent-encoded letters the router decodes: these are /api/accounts itself, so its guard answers.
  const SAME_ROUTE = ["/api/%61ccounts", "/%61pi/accounts", "/api/accoun%74s", "/%61%70%69/%61ccounts"];
  // Encoded separators, dot segments, doubled slashes, a backslash, case and trailing junk: none is
  // the route. The SPA fallback answers them (decoded: the JSON 404 under /api and /assets, the
  // shell for anything else, which holds no household data).
  const OTHER_SPELLINGS = [
    "/api%2Faccounts",
    "/api%2faccounts",
    "/api/accounts%2F",
    "/api%5Caccounts",
    "/api\\accounts",
    "//api/accounts",
    "/api//accounts",
    "/./api/accounts",
    "/api/./accounts",
    "/api/%2e/accounts",
    "/%2e/api/accounts",
    "/api/../api/accounts",
    "/api/%2e%2e/api/accounts",
    "/assets/../api/accounts",
    "/assets/..%2Fapi%2Faccounts",
    "/assets%2F..%2Fapi%2Faccounts",
    "/sw.js/../api/accounts",
    "/API/accounts",
    "/api/accounts/",
    "/api/accounts;.js",
    "/api/accounts%3F",
    "/api/accounts%00",
  ];

  it("reaches the route only where the router decodes the path to it, and then the guard refuses a caller with no session", async () => {
    for (const spelling of SAME_ROUTE) {
      const anonymous = await rawGet(port, spelling);
      expect(anonymous.status, spelling).toBe(401);
      expect(JSON.parse(anonymous.body).code, spelling).toBe("unauthorized");
      // The same request with the owner's session is the route: this is the guarded route, not a lookalike.
      const owner = await rawGet(port, spelling, ownerCookie);
      expect(owner.status, spelling).toBe(200);
      expect(Array.isArray(JSON.parse(owner.body)), spelling).toBe(true);
    }
  });

  it("never answers another spelling with the route's data, with or without a session", async () => {
    for (const spelling of OTHER_SPELLINGS) {
      for (const cookie of [undefined, ownerCookie]) {
        const res = await rawGet(port, spelling, cookie);
        const who = `${spelling} ${cookie ? "(owner)" : "(no session)"}`;
        if (res.status === 200) {
          // Only the public shell, never JSON.
          expect(res.type, who).toMatch(/^text\/html/);
          expect(res.body, who).toBe(SHELL);
        } else {
          expect([400, 401, 403, 404], who).toContain(res.status);
          if (res.type.startsWith("application/json")) expect(JSON.parse(res.body), who).not.toBeInstanceOf(Array);
        }
      }
    }
  });
});
