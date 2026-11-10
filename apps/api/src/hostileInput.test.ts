import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Well-formed but absurd input is the caller's mistake: 400 at the edge, never a 500 from
 * inside Postgres or from date arithmetic. Every probe is sent by the signed-in owner.
 */
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe.skipIf(!TEST_DATABASE_URL)("hostile but well-formed input", () => {
  let t: TestApp;
  let checkingId: string;
  let brokerageId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
    checkingId = (await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Checking", type: "checking", balanceCents: "100000" } })).json().id;
    brokerageId = (await t.call({ method: "POST", url: "/api/accounts", payload: { name: "Brokerage", type: "brokerage", balanceCents: "500000" } })).json().id;
    for (const [date, amountCents, payeeName] of [
      ["2026-11-01", "-1234", "100% Juice"],
      ["2026-11-02", "-999", "Plain Coffee"],
      ["2026-11-03", "-500", "under_score"],
    ] as const) {
      const res = await t.call({ method: "POST", url: "/api/transactions", payload: { accountId: checkingId, date, amountCents, payeeName } });
      expect(res.statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const get = (url: string) => t.call({ method: "GET", url });
  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => t.call({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("answers a page cursor it did not issue with 400 invalid_cursor on every paginated list", async () => {
    const cursors = [b64("x|y"), b64("2026-01-01|'; drop table x; --"), b64(`2026-02-31|${UUID}`), b64(`2026-01-01|${UUID}|extra`), "%00%00", "not base64 at all", b64(`2026-01-01|${UUID}`) + "="];
    for (const cursor of cursors) {
      for (const url of [`/api/transactions?cursor=${cursor}`, `/api/audit?cursor=${cursor}`, `/api/investments/txns?cursor=${cursor}`, `/api/recurring/${UUID}/transactions?cursor=${cursor}`]) {
        const res = await get(url);
        // The recurring item does not exist, so its list answers 404 unless the cursor is refused first.
        expect([400, 404], url).toContain(res.statusCode);
        if (!url.includes("/recurring/")) expect(res.statusCode, url).toBe(400);
        if (res.statusCode === 400) expect(res.json().code, url).toMatch(/^(invalid_cursor|validation)$/);
      }
    }
    expect((await get(`/api/transactions?cursor=${b64("x|y")}`)).json()).toEqual({ error: "That page marker is not valid; reload the list", code: "invalid_cursor" });
    expect((await get(`/api/investments/txns?cursor=${b64(`2026-01-01|99999999999|${UUID}`)}`)).json().code).toBe("invalid_cursor");
    expect((await get(`/api/audit?cursor=${b64(`2026-01-01 25:00:00+00|${UUID}`)}`)).json().code).toBe("invalid_cursor");

    // Cursors the server issued keep working: three rows, one per page.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await get(`/api/transactions?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as { items: Array<{ payeeName: string }>; nextCursor: string | null };
      seen.push(...page.items.map((i) => i.payeeName));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["under_score", "Plain Coffee", "100% Juice"]);
    const audit = (await get("/api/audit?limit=1")).json() as { items: unknown[]; nextCursor: string | null };
    if (audit.nextCursor) expect((await get(`/api/audit?limit=1&cursor=${encodeURIComponent(audit.nextCursor)}`)).statusCode).toBe(200);
  });

  it("answers a date that is not on the calendar, or outside 1900 to 2199, with 400 validation wherever a date is accepted", async () => {
    const badDates = ["2026-13-45", "2026-02-31", "2025-02-29", "0000-00-00", "0001-01-01", "1899-12-31", "2200-01-01", "9999-12-31"];
    for (const d of badDates) {
      const urls = [
        `/api/transactions?from=${d}`,
        `/api/transactions?to=${d}`,
        `/api/dashboard?today=${d}`,
        `/api/plan?today=${d}`,
        `/api/investments/accounts/${brokerageId}/snapshots/${d}`,
        `/api/investments/accounts/${brokerageId}/positions?asOf=${d}`,
        `/api/investments/realized?from=${d}&to=2026-11-10`,
        `/api/investments/realized?from=2026-01-01&to=${d}`,
        `/api/valuation/series?from=${d}&to=2026-11-10`,
        `/api/valuation/summary?period=custom&from=${d}`,
        `/api/investments/accounts/${brokerageId}/changes?from=${d}&to=2026-11-10`,
        `/api/investments/performance?period=custom&from=${d}&to=2026-11-10`,
        `/api/investments/income?period=custom&from=${d}&to=2026-11-10`,
        `/api/investments/txns?from=${d}`,
      ];
      for (const url of urls) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(400);
        expect(res.json().code, url).toBe("validation");
      }
      const bodies: Array<[("POST" | "PUT" | "PATCH"), string, unknown]> = [
        ["POST", "/api/transactions", { accountId: checkingId, date: d, amountCents: "-1", payeeName: "bad date" }],
        ["POST", "/api/investments/performance", { from: d, detail: "full" }],
        ["POST", "/api/cashflow/projection", { today: d }],
        ["POST", "/api/cashflow/projection", { whatIfs: [{ kind: "oneTime", date: d, amountCents: "-1", accountId: checkingId }] }],
        ["PUT", `/api/investments/accounts/${brokerageId}/positions`, { asOfDate: d, positions: [{ security: { kind: "existing", securityId: UUID }, valueCents: "100" }] }],
        ["POST", "/api/reconcile/preview", { accountId: brokerageId, date: d, rows: [] }],
        ["POST", "/api/recurring", { name: "Rent", categoryId: UUID, accountId: checkingId, cadence: "monthly", anchorDate: d, expectedCents: "-100" }],
      ];
      for (const [method, url, payload] of bodies) {
        const res = await send(method, url, payload);
        expect(res.statusCode, `${method} ${url} ${d}`).toBe(400);
        expect(res.json().code, `${method} ${url} ${d}`).toBe("validation");
      }
    }
    expect((await get("/api/transactions?from=2026-02-31")).json().error).toBe("from: a calendar date between 1900-01-01 and 2199-12-31");
    // The edges of the range are accepted.
    expect((await get("/api/transactions?from=1900-01-01&to=2199-12-31")).statusCode).toBe(200);
    expect((await get("/api/transactions?from=2024-02-29")).statusCode).toBe(200);
  });

  it("answers months outside 1900-01 to 2199-12 with 400 validation, and never fails on the edges", async () => {
    for (const url of [
      "/api/plan?from=9999-11&to=9999-12",
      "/api/plan?from=0001-01&to=0001-02",
      "/api/plan?from=2200-01&to=2200-02",
      "/api/plan/averages?months=12&asOf=9999-12",
      "/api/plan/averages?months=12&asOf=0001-01",
      "/api/plan/averages?months=12&asOf=1899-12",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code, url).toBe("validation");
    }
    for (const [method, url, payload] of [
      ["PATCH", "/api/settings", { planStartMonth: "9999-12" }],
      ["PATCH", "/api/settings", { planStartMonth: "1899-12" }],
      ["PUT", "/api/plan/cells", { edits: [{ categoryId: UUID, month: "9999-12", plannedCents: "1" }] }],
      ["POST", "/api/plan/close-month", { through: "0001-01" }],
    ] as const) {
      const res = await send(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().code, `${method} ${url}`).toBe("validation");
    }
    for (const url of [
      "/api/plan?from=1900-01&to=1900-03",
      "/api/plan?from=2199-10&to=2199-12",
      "/api/plan/averages?months=12&asOf=1900-01",
      "/api/plan/averages?months=12&asOf=2199-12",
      "/api/plan?from=2000-01&to=1999-12",
      "/api/plan?from=2030-01&to=2000-01",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBeLessThan(500);
    }
  });

  it("answers an amount of more than 15 digits with 400 validation, and accepts the largest one", async () => {
    for (const amountCents of ["9".repeat(30), "9223372036854775808", "-9223372036854775809", "1000000000000000", "-1000000000000000"]) {
      const txn = await send("POST", "/api/transactions", { accountId: checkingId, date: "2026-11-03", amountCents, payeeName: "huge" });
      expect(txn.statusCode, amountCents).toBe(400);
      expect(txn.json().code).toBe("validation");
    }
    for (const [method, url, payload] of [
      ["POST", "/api/accounts", { name: "Overflow", type: "checking", balanceCents: "9".repeat(40) }],
      ["PATCH", `/api/accounts/${checkingId}`, { lowBalanceThresholdCents: "9".repeat(19) }],
      ["PATCH", "/api/settings", { lowBalanceThresholdCents: "9".repeat(16) }],
      ["PATCH", "/api/settings", { rebalanceMinTradeCents: "9".repeat(16) }],
      ["PUT", "/api/plan/cells", { edits: [{ categoryId: UUID, month: "2026-11", plannedCents: "9".repeat(20) }] }],
      ["POST", "/api/cashflow/projection", { thresholdCents: "9".repeat(20) }],
      ["POST", "/api/rules", { name: "Big", conditions: { amount: { minCents: "9".repeat(20) } }, actions: { markTransfer: true } }],
      ["POST", "/api/goals", { name: "Moon", targetCents: "9".repeat(20) }],
    ] as const) {
      const res = await send(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().code, `${method} ${url}`).toBe("validation");
    }
    expect((await send("POST", "/api/transactions", { accountId: checkingId, date: "2026-11-03", amountCents: "1000000000000000", payeeName: "huge" })).json().error).toBe(
      "amountCents: cents as an integer string of at most 15 digits",
    );

    // Two accounts at the largest balance: every total still adds up and serializes.
    for (const name of ["Max A", "Max B"]) {
      const res = await send("POST", "/api/accounts", { name, type: "savings", balanceCents: "999999999999999" });
      expect(res.statusCode).toBe(200);
      expect(res.json().balanceCents).toBe("999999999999999");
    }
    for (const url of ["/api/accounts", "/api/dashboard", "/api/plan", "/api/valuation/summary"]) expect((await get(url)).statusCode, url).toBe(200);
    expect((await send("POST", "/api/cashflow/projection", {})).statusCode).toBe(200);
  });

  it("keeps the plan and goals pages working for a goal that a tiny contribution would take millennia to reach", async () => {
    // $100,000 at $1 a month is 100,000 months (8,333 years): past 2199-12 there is no projected month.
    const goal = await send("POST", "/api/goals", { name: "Someday", newCategory: { name: "Someday" }, targetCents: "10000000", monthlyContributionCents: "100" });
    expect(goal.statusCode).toBe(200);
    expect(goal.json().progress).toMatchObject({ remainingToTargetCents: "10000000", projectedCompletionMonth: null });
    // The largest target, the latest target date and the earliest start month a caller may send.
    const extreme = await send("POST", "/api/goals", {
      name: "Moonshot",
      newCategory: { name: "Moonshot" },
      targetCents: "999999999999999",
      targetDate: "2199-12-31",
      startMonth: "1900-01",
      monthlyContributionCents: "1",
    });
    expect(extreme.statusCode).toBe(200);
    expect(extreme.json().progress.projectedCompletionMonth).toBeNull();
    for (const url of ["/api/goals", "/api/plan", "/api/dashboard"]) expect((await get(url)).statusCode, url).toBe(200);
    for (const id of [goal.json().id, extreme.json().id]) expect((await send("DELETE", `/api/goals/${id}`)).statusCode).toBe(200);
  });

  it("answers numbers that do not fit their column, and text Postgres cannot store, with 400", async () => {
    const split = await send("POST", "/api/investments/txns", { type: "split", accountId: brokerageId, date: "2026-11-03", securityId: UUID, splitNum: 3_000_000_000, splitDen: 1 });
    expect(split.statusCode).toBe(400);
    expect(split.json().code).toBe("validation");

    for (const [method, url, payload] of [
      ["POST", "/api/accounts", { name: "nul\u0000byte", type: "checking" }],
      ["POST", "/api/transactions", { accountId: checkingId, date: "2026-11-03", amountCents: "-1", payeeName: "a\u0000b" }],
      ["PATCH", `/api/accounts/${checkingId}`, { name: "\u0000" }],
      ["POST", "/api/import/csv/preview", { csvText: "D\u0000a\u0000t\u0000e\u0000" }],
    ] as const) {
      const res = await send(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json()).toEqual({ error: "Text in the request contains a NUL character (a file saved as UTF-16? Save it as UTF-8)", code: "validation" });
    }
    for (const url of ["/api/transactions?q=%00", "/api/payees?q=a%00b", "/api/investments/securities?q=%00"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code, url).toBe("validation");
    }
    // Lone surrogates, right-to-left marks and very long text are stored or refused by length, never a 500.
    expect((await send("POST", "/api/accounts", { name: "bad \ud800 surrogate ‮", type: "checking" })).statusCode).toBe(200);
    expect((await send("POST", "/api/accounts", { name: "x".repeat(5000), type: "checking" })).statusCode).toBe(400);
  });

  it("answers a value the contract cannot see is too large (a product of two valid inputs) with 400, not 500", async () => {
    // 999,999,999,999 shares at $999,999,999,999 is 10^26 cents: valid operands, a value no column holds.
    const security = await send("POST", "/api/investments/securities", { ticker: "HUGE", name: "Huge Corp", type: "stock", assetClass: "us_stock" });
    expect(security.statusCode).toBe(200);
    const res = await send("PUT", `/api/investments/accounts/${brokerageId}/positions`, {
      asOfDate: "2026-11-03",
      positions: [{ security: { kind: "existing", securityId: security.json().id }, quantity: "999999999999", price: "999999999999" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "A value in the request is out of range or not valid", code: "invalid_value" });
    // Nothing was written by the refused request.
    const snapshots = await get(`/api/investments/accounts/${brokerageId}/snapshots`);
    expect(snapshots.json()).toEqual([]);
  });

  it("reads a CSV whose amounts or dates are out of range as row errors, not a server error", async () => {
    const csvText = ["Date,Description,Amount", "2026-11-04,OK ROW,-12.34", "2026-11-05,TOO MANY DIGITS,-99999999999999999999.00", "0203-11-05,TYPO YEAR,-1.00", "2026-11-06,LARGEST,-9999999999999.99"].join("\n");
    const mapping = { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount" } };
    const preview = await send("POST", "/api/import/csv/preview", { csvText, mapping, accountId: checkingId });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().rows.map((r: { description: string; amountCents: string }) => [r.description, r.amountCents])).toEqual([
      ["OK ROW", "-1234"],
      ["LARGEST", "-999999999999999"],
    ]);
    expect(preview.json().errors).toEqual([
      { rowIndex: 2, message: "Unreadable amount" },
      { rowIndex: 3, message: 'Unreadable date "0203-11-05"' },
    ]);
    const commit = await send("POST", "/api/import/csv/commit", { csvText, mapping, accountId: checkingId });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().created).toBe(2);
  });

  it("matches %, _ and \\ in a payee search literally, as the transaction search does", async () => {
    const names = async (q: string) => ((await get(`/api/payees?q=${encodeURIComponent(q)}`)).json() as Array<{ name: string }>).map((p) => p.name);
    const all = await names("");
    expect(all).toEqual(expect.arrayContaining(["100% Juice", "Plain Coffee", "under_score"]));
    expect(await names("%")).toEqual(["100% Juice"]);
    expect(await names("_")).toEqual(["under_score"]);
    expect(await names("100%")).toEqual(["100% Juice"]);
    expect(await names("0% j")).toEqual(["100% Juice"]);
    expect(await names("\\")).toEqual([]);
    expect(await names("COFFEE")).toEqual(["Plain Coffee"]);
    // The register search escapes the same way.
    const register = async (q: string) => ((await get(`/api/transactions?q=${encodeURIComponent(q)}`)).json() as { items: Array<{ payeeName: string }> }).items.map((i) => i.payeeName);
    expect(await register("%")).toEqual(["100% Juice"]);
    expect(await register("_")).toEqual(["under_score"]);
  });

  it("does not fall over on deeply nested or strangely shaped JSON", async () => {
    const deep = "[".repeat(50_000) + "]".repeat(50_000);
    const res = await t.call({ method: "POST", url: "/api/accounts", headers: { "content-type": "application/json" }, payload: deep });
    expect(res.statusCode).toBe(400);
    for (const payload of ["null", "[]", '"text"', "12", '{"__proto__":{"admin":true},"name":"p","type":"checking"}']) {
      const shaped = await t.call({ method: "POST", url: "/api/accounts", headers: { "content-type": "application/json" }, payload });
      expect(shaped.statusCode, payload).toBe(400);
    }
  });
});
