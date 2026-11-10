import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@meridian/db";
import { createTestApp, OWNER_PASSWORD, sessionCookies, signInOwner, TEST_DATABASE_URL, totpCode, viewerCookies, type TestApp } from "./test/helpers.js";

const JSON_HEADERS = { "content-type": "application/json" };
const KB = 1024;

describe.skipIf(!TEST_DATABASE_URL)("the session is checked before a request body is read", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("asks for setup, not for a valid body, while no owner exists", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/accounts", payload: { nonsense: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("setup_required");
  });

  it("answers an anonymous caller 401 whatever the body: invalid, malformed or oversized", async () => {
    await signInOwner(t);
    const invalid = await t.app.inject({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{}] } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: "Sign in required", code: "unauthorized" });

    const malformed = await t.app.inject({ method: "POST", url: "/api/transactions", headers: JSON_HEADERS, payload: '{"accountId":' });
    expect(malformed.statusCode).toBe(401);

    // 1.2 MB is over the default body limit; an anonymous caller is refused before the size matters.
    const oversized = await t.app.inject({ method: "PUT", url: "/api/plan/cells", headers: JSON_HEADERS, payload: `{"edits":[${Array(400_000).fill("{}").join(",")}]}` });
    expect(oversized.statusCode).toBe(401);

    const badParams = await t.app.inject({ method: "GET", url: "/api/transactions?limit=abc&from=not-a-date" });
    expect(badParams.statusCode).toBe(401);
    const badId = await t.app.inject({ method: "DELETE", url: "/api/recurring/not-a-uuid" });
    expect(badId.statusCode).toBe(401);
  });

  it("answers a viewer 403 for a change before validating it, and a half-signed-in session 401", async () => {
    const viewer = await viewerCookies(t);
    const change = await t.app.inject({ method: "PUT", url: "/api/plan/cells", cookies: viewer, payload: { edits: [{}] } });
    expect(change.statusCode).toBe(403);
    expect(change.json().code).toBe("viewer");
    // A read-only POST stays open to the viewer and is validated as usual.
    const projection = await t.app.inject({ method: "POST", url: "/api/cashflow/projection", cookies: viewer, payload: { horizonDays: 0 } });
    expect(projection.statusCode).toBe(400);
    expect(projection.json().code).toBe("validation");

    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: OWNER_PASSWORD } });
    const half = { meridian_session: login.cookies.find((c) => c.name === "meridian_session")!.value };
    const res = await t.app.inject({ method: "POST", url: "/api/accounts", cookies: half, payload: { nonsense: true } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("totp_required");
  });

  it("still validates the public sign-in routes and a signed-in owner's requests", async () => {
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner" } });
    expect(login.statusCode).toBe(400);
    expect(login.json().code).toBe("validation");
    const owner = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{}] } });
    expect(owner.statusCode).toBe(400);
    expect(owner.json().code).toBe("validation");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("request size limits", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("refuses a body over 1 MiB on an ordinary route and accepts a CSV of several megabytes on the import routes", async () => {
    const big = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{ note: "x".repeat(1024 * KB) }] } });
    expect(big.statusCode).toBe(413);
    const under = await t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits: [{ note: "x".repeat(1000 * KB) }] } });
    expect(under.statusCode).toBe(400); // read and validated: the note is over its 500 characters

    // 30,000 rows of 50 bytes: a 1.5 MB bank export, over the ordinary limit.
    const csvText = "Date,Description,Amount\n" + Array.from({ length: 30_000 }, (_, i) => `2026-01-15,COFFEE SHOP ${String(i).padStart(21, "0")},-4.50`).join("\n");
    expect(csvText.length).toBeGreaterThan(1_400_000);
    const preview = await t.call({ method: "POST", url: "/api/import/csv/preview", payload: { csvText } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().headers).toEqual(["Date", "Description", "Amount"]);
  });

  it("keeps the sign-in routes to a few kilobytes", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "x".repeat(20 * KB) } });
    expect(res.statusCode).toBe(413);
  });

  it("refuses a list longer than any contract allows before validating its items", async () => {
    // 5,001 empty edits is 15 KB of JSON; the cap is 5,000 items per list.
    const res = await t.call({ method: "PUT", url: "/api/plan/cells", headers: JSON_HEADERS, payload: `{"edits":[${Array(5001).fill("{}").join(",")}]}` });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "A list in the request has too many items (5001, at most 5000)", code: "too_many_items" });
    const nested = await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { whatIfs: [{ kind: "oneTime", tags: Array(5001).fill(0) }] } });
    expect(nested.statusCode).toBe(413);
    // At the cap the contract's own limit answers (600 edits for the plan grid).
    const atCap = await t.call({ method: "PUT", url: "/api/plan/cells", headers: JSON_HEADERS, payload: `{"edits":[${Array(5000).fill("{}").join(",")}]}` });
    expect(atCap.statusCode).toBe(400);
    expect(atCap.json().code).toBe("validation");
  });

  it("bounds the tag lists that had no limit", async () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `t${i}`);
    const tags = await t.call({ method: "PATCH", url: "/api/transactions/3f2504e0-4f89-41d3-9a0c-0305e82c3301", payload: { tags: fiftyOne } });
    expect(tags.statusCode).toBe(400);
    expect(tags.json()).toEqual({ error: "tags: Array must contain at most 50 element(s)", code: "validation" });
    const rule = await t.call({ method: "POST", url: "/api/rules", payload: { name: "Tags", conditions: { payee: { op: "equals", value: "x" } }, actions: { addTags: fiftyOne } } });
    expect(rule.statusCode).toBe(400);
    expect(rule.json().error).toBe("actions/addTags: Array must contain at most 50 element(s)");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("cross-site requests", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const account = (name: string) => ({ name, type: "checking", balanceCents: "100" });
  const accountNames = async () => ((await t.call({ method: "GET", url: "/api/accounts" })).json() as Array<{ name: string }>).map((a) => a.name).sort();

  it("refuses a change whose Origin is another site, even with the owner's cookie", async () => {
    const res = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.local", origin: "https://evil.example" }, payload: account("Evil") });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Cross-site request refused", code: "cross_site_request" });
    // A sibling host on the same site (another machine on the tailnet) is another origin too.
    const sibling = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.tail1234.ts.net", origin: "https://nas.tail1234.ts.net" }, payload: account("Sibling") });
    expect(sibling.statusCode).toBe(403);
    const opaque = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.local", origin: "null" }, payload: account("Opaque") });
    expect(opaque.statusCode).toBe(403);
    expect(await accountNames()).toEqual([]);
  });

  it("goes by Sec-Fetch-Site when the browser sends it", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.local", origin: "https://meridian.local", "sec-fetch-site": site }, payload: account(site) });
      expect(res.statusCode, site).toBe(403);
      expect(res.json().code, site).toBe("cross_site_request");
    }
    for (const site of ["same-origin", "none"]) {
      const res = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.local", origin: "https://meridian.local", "sec-fetch-site": site }, payload: account(site) });
      expect(res.statusCode, site).toBe(200);
    }
    expect(await accountNames()).toEqual(["none", "same-origin"]);
  });

  it("accepts the app's own origin, on any port, and clients that send no Origin at all", async () => {
    const own = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "meridian.local", origin: "https://meridian.local" }, payload: account("Own") });
    expect(own.statusCode).toBe(200);
    const dev = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "localhost:5173", origin: "http://localhost:5173" }, payload: account("Dev") });
    expect(dev.statusCode).toBe(200);
    const otherPort = await t.call({ method: "POST", url: "/api/accounts", headers: { host: "localhost:5173", origin: "http://localhost:8080" }, payload: account("Other port") });
    expect(otherPort.statusCode).toBe(403);
    const script = await t.call({ method: "POST", url: "/api/accounts", payload: account("Script") });
    expect(script.statusCode).toBe(200);
  });

  it("applies to sign-in and sign-out too, and leaves reads alone", async () => {
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { host: "meridian.local", origin: "https://evil.example" }, payload: { username: "owner", password: OWNER_PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe("cross_site_request");
    const logout = await t.call({ method: "POST", url: "/api/auth/logout", headers: { host: "meridian.local", origin: "https://evil.example" } });
    expect(logout.statusCode).toBe(403);
    const read = await t.call({ method: "GET", url: "/api/accounts", headers: { host: "meridian.local", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(read.statusCode).toBe(200);
  });

  it("accepts a change only as JSON: a form's content types are refused even without a body", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const bodyless = await t.call({ method: "POST", url: "/api/recurring/detect", headers: { "content-type": contentType } });
      expect(bodyless.statusCode, contentType).toBe(415);
      expect(bodyless.json().code, contentType).toBe("unsupported_media_type");
      const smuggled = await t.call({ method: "POST", url: "/api/accounts", headers: { "content-type": contentType }, payload: JSON.stringify(account("Smuggled")) });
      expect(smuggled.statusCode, contentType).toBe(415);
    }
    // A body with no Content-Type at all (a typeless Blob) is not read as JSON either.
    const untyped = await t.app.inject({ method: "POST", url: "/api/accounts", cookies: t.cookies, headers: { "content-length": String(JSON.stringify(account("Smuggled")).length) }, payload: Buffer.from(JSON.stringify(account("Smuggled"))) });
    expect(untyped.statusCode).toBe(415);
    const json = await t.call({ method: "POST", url: "/api/accounts", headers: { "content-type": "application/json; charset=utf-8" }, payload: JSON.stringify(account("Json")) });
    expect(json.statusCode).toBe(200);
    const bodyless = await t.call({ method: "POST", url: "/api/recurring/detect" });
    expect(bodyless.statusCode).toBe(202);
    expect(await accountNames()).not.toContain("Smuggled");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("behind the reverse proxy", () => {
  let t: TestApp;
  const PROXY = "172.18.0.5";
  beforeAll(async () => {
    t = await createTestApp({ config: { trustProxy: [PROXY] } });
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("compares Origin with the host the proxy forwarded", async () => {
    const forwarded = { host: "web:3000", "x-forwarded-host": "meridian.local", "x-forwarded-for": "192.168.1.50", "x-forwarded-proto": "https" };
    const own = await t.call({ method: "POST", url: "/api/accounts", remoteAddress: PROXY, headers: { ...forwarded, origin: "https://meridian.local" }, payload: { name: "Own", type: "checking" } });
    expect(own.statusCode).toBe(200);
    const evil = await t.call({ method: "POST", url: "/api/accounts", remoteAddress: PROXY, headers: { ...forwarded, origin: "https://web:3000" }, payload: { name: "Evil", type: "checking" } });
    expect(evil.statusCode).toBe(403);
    // A peer that is not the proxy cannot pick the host to compare with.
    const direct = await t.call({ method: "POST", url: "/api/accounts", remoteAddress: "172.18.0.9", headers: { ...forwarded, origin: "https://meridian.local" }, payload: { name: "Direct", type: "checking" } });
    expect(direct.statusCode).toBe(403);
  });

  it("limits sign-in attempts per client address as reported by the proxy, and ignores the header from anyone else", async () => {
    const attempt = (remoteAddress: string, forwardedFor: string | undefined, username: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {}, payload: { username, password: "wrong password here" } });

    // Ten attempts a minute per address: the eleventh from the same client is refused.
    for (let i = 0; i < 10; i++) expect((await attempt(PROXY, "192.168.1.50", `a${i}`)).statusCode, `attempt ${i + 1}`).toBe(401);
    expect((await attempt(PROXY, "192.168.1.50", "a10")).statusCode).toBe(429);
    // Another client behind the proxy has its own allowance.
    expect((await attempt(PROXY, "192.168.1.51", "b0")).statusCode).toBe(401);
    // A client cannot prepend an address of its choice: the proxy's own entry (the right-most) counts.
    expect((await attempt(PROXY, "203.0.113.7, 192.168.1.50", "a11")).statusCode).toBe(429);

    // A peer that is not the proxy is counted by its socket address, whatever it claims.
    for (let i = 0; i < 10; i++) expect((await attempt("172.18.0.9", `203.0.113.${i}`, `c${i}`)).statusCode, `direct attempt ${i + 1}`).toBe(401);
    expect((await attempt("172.18.0.9", "203.0.113.200", "c10")).statusCode).toBe(429);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("sign-in limits that do not depend on the address", () => {
  let t: TestApp;
  let secret: string;
  beforeAll(async () => {
    t = await createTestApp();
    secret = await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("with no trusted proxy, X-Forwarded-For does not change who is counted", async () => {
    const attempt = (forwardedFor: string, username: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.168.1.60", headers: { "x-forwarded-for": forwardedFor }, payload: { username, password: "wrong password here" } });
    for (let i = 0; i < 10; i++) expect((await attempt(`203.0.113.${i}`, `spoof${i}`)).statusCode, `attempt ${i + 1}`).toBe(401);
    expect((await attempt("203.0.113.99", "spoof10")).statusCode).toBe(429);
  });

  it("allows 20 password attempts a minute per username, from any number of addresses", async () => {
    const attempt = (remoteAddress: string, username: string, password = "wrong password here") =>
      t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress, payload: { username, password } });
    // 20 wrong passwords for "owner" from 20 addresses (one each, far below the per-address limit).
    for (let i = 0; i < 20; i++) expect((await attempt(`10.1.0.${i}`, i % 2 ? "owner" : " Owner ")).statusCode, `attempt ${i + 1}`).toBe(401);
    const blocked = await attempt("10.1.0.200", "owner", OWNER_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    // Another username is unaffected.
    expect((await attempt("10.1.0.201", "someone-else")).statusCode).toBe(401);
  });

  it("allows 5 authenticator codes per 15 minutes per user, across sessions and addresses", async () => {
    // Fresh password sessions inserted directly (the password limiter above is spent for this minute).
    const [owner] = await t.db.db.select({ id: user.id }).from(user);
    const halfSession = () => sessionCookies(t, owner!.id, { totpVerified: false });
    const right = totpCode(secret);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: `10.2.0.${i}`, cookies: await halfSession(), payload: { code: wrong } });
      expect(res.statusCode, `code ${i + 1}`).toBe(401);
      expect(res.json().code).toBe("bad_totp");
    }
    const sixth = await t.app.inject({ method: "POST", url: "/api/auth/totp/verify", remoteAddress: "10.2.0.200", cookies: await halfSession(), payload: { code: totpCode(secret) } });
    expect(sixth.statusCode).toBe(429);
  });
});
