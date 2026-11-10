import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CentsString, IsoDateInput, IsoDateString, MonthString } from "@meridian/shared";
import { findInputProblem, isCrossSiteChange, isNonJsonContentType, isSafeMethod, MAX_LIST_ITEMS, requestGuardsPlugin } from "./requestGuards.js";

describe("isCrossSiteChange", () => {
  const post = (over: Partial<Parameters<typeof isCrossSiteChange>[0]>) => isCrossSiteChange({ method: "POST", secFetchSite: undefined, origin: undefined, host: "meridian.local", ...over });

  it("never applies to reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isSafeMethod(method)).toBe(true);
      expect(isCrossSiteChange({ method, secFetchSite: "cross-site", origin: "https://evil.example", host: "meridian.local" })).toBe(false);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(isSafeMethod(method)).toBe(false);
  });

  it("believes Sec-Fetch-Site first: same-origin and none pass, same-site and cross-site do not", () => {
    expect(post({ secFetchSite: "same-origin" })).toBe(false);
    expect(post({ secFetchSite: "none" })).toBe(false);
    expect(post({ secFetchSite: " Same-Origin " })).toBe(false);
    expect(post({ secFetchSite: "same-site" })).toBe(true);
    expect(post({ secFetchSite: "cross-site" })).toBe(true);
    expect(post({ secFetchSite: "" })).toBe(true);
    // The browser's verdict wins over a matching Origin and over a mismatching one (a proxy that rewrote Host).
    expect(post({ secFetchSite: "cross-site", origin: "https://meridian.local" })).toBe(true);
    expect(post({ secFetchSite: "same-origin", origin: "https://meridian.local", host: "web:3000" })).toBe(false);
  });

  it("otherwise compares Origin with the request's own host, default ports included", () => {
    expect(post({ origin: "https://meridian.local" })).toBe(false);
    expect(post({ origin: "https://MERIDIAN.local" })).toBe(false);
    expect(post({ origin: "https://meridian.local:443" })).toBe(false);
    expect(post({ origin: "https://meridian.local", host: "meridian.local:443" })).toBe(false);
    expect(post({ origin: "http://meridian.local", host: "meridian.local:80" })).toBe(false);
    expect(post({ origin: "http://localhost:5173", host: "localhost:5173" })).toBe(false);
    expect(post({ origin: "http://[::1]:3000", host: "[::1]:3000" })).toBe(false);
    expect(post({ origin: "https://evil.example" })).toBe(true);
    expect(post({ origin: "https://nas.meridian.local" })).toBe(true);
    expect(post({ origin: "https://meridian.local.evil.example" })).toBe(true);
    expect(post({ origin: "https://meridian.local:8443" })).toBe(true);
    expect(post({ origin: "http://localhost:8080", host: "localhost:5173" })).toBe(true);
    expect(post({ origin: "null" })).toBe(true);
    expect(post({ origin: "" })).toBe(true);
    expect(post({ origin: "https://meridian.local", host: "" })).toBe(true);
  });

  it("lets a client through that sends neither header (not a browser)", () => {
    expect(post({})).toBe(false);
  });
});

describe("isNonJsonContentType", () => {
  it("accepts JSON or no Content-Type, and nothing a form can send", () => {
    expect(isNonJsonContentType(undefined)).toBe(false);
    expect(isNonJsonContentType("application/json")).toBe(false);
    expect(isNonJsonContentType("Application/JSON; charset=utf-8")).toBe(false);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "text/json", ""]) {
      expect(isNonJsonContentType(type), type).toBe(true);
    }
  });
});

describe("findInputProblem", () => {
  it("passes ordinary input and lists at the limit", () => {
    expect(findInputProblem(undefined)).toBeNull();
    expect(findInputProblem(null)).toBeNull();
    expect(findInputProblem({ a: 1, b: "text", c: [true, null, { d: ["x"] }] })).toBeNull();
    expect(findInputProblem({ edits: Array(MAX_LIST_ITEMS).fill({}) })).toBeNull();
    expect(findInputProblem("x".repeat(1_000_000))).toBeNull();
  });

  it("reports the first list or map over the limit, however deep", () => {
    expect(findInputProblem({ edits: Array(5001).fill({}) })).toEqual({ kind: "too_many_items", count: 5001 });
    expect(findInputProblem({ a: [{ b: { c: Array(7000).fill(0) } }] })).toEqual({ kind: "too_many_items", count: 7000 });
    expect(findInputProblem([1, 2, 3], 2)).toEqual({ kind: "too_many_items", count: 3 });
    const map = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, i]));
    expect(findInputProblem({ actionMap: map })).toEqual({ kind: "too_many_items", count: 5001 });
  });

  it("reports a NUL character in any text or key", () => {
    expect(findInputProblem({ name: "a\u0000b" })).toEqual({ kind: "nul_character" });
    expect(findInputProblem({ rows: [["ok", "\u0000"]] })).toEqual({ kind: "nul_character" });
    expect(findInputProblem({ "k\u0000": 1 })).toEqual({ kind: "nul_character" });
    expect(findInputProblem("\u0000")).toEqual({ kind: "nul_character" });
  });

  it("walks 100,000 levels of nesting without recursion", () => {
    let deep: unknown = "end";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(findInputProblem(deep)).toBeNull();
  });
});

describe("route registration", () => {
  const handler = async () => ({ ok: true });

  it("refuses a route whose request contract uses a loose wire shape, naming the field", async () => {
    const app = Fastify({ logger: false });
    await app.register(requestGuardsPlugin);
    expect(() => app.get("/a", { schema: { querystring: z.object({ from: IsoDateString.optional() }) } }, handler)).toThrow(
      "GET /a: the request querystring uses unbounded wire shapes at from (IsoDateString); use CentsInput, IsoDateInput or MonthInput",
    );
    expect(() => app.post("/b", { schema: { body: z.object({ rows: z.array(z.object({ amountCents: CentsString })) }) } }, handler)).toThrow(/POST \/b: the request body uses unbounded wire shapes at rows\[\]\.amountCents \(CentsString\)/);
    expect(() => app.get("/c/:month", { schema: { params: z.object({ month: MonthString }) } }, handler)).toThrow(/the request params uses unbounded wire shapes at month \(MonthString\)/);
    await app.close();
  });

  it("accepts bounded request shapes, and loose shapes in responses", async () => {
    const app = Fastify({ logger: false });
    await app.register(requestGuardsPlugin);
    expect(() => app.get("/ok", { schema: { querystring: z.object({ from: IsoDateInput.optional() }), response: { 200: z.object({ date: IsoDateString, cents: CentsString }) } } }, handler)).not.toThrow();
    expect(() => app.get("/plain", handler)).not.toThrow();
    await app.close();
  });
});
