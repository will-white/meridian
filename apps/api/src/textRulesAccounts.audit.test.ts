import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, connection, rule } from "@meridian/db";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Audit batch a6-text-rules-accounts (accounts, payees, rules and text safety): the routes.
 * The database side is packages/db/src/services/textRulesAccounts.audit.test.ts.
 */

const CSV_MAPPING = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" },
  description: { column: "Description" },
  amount: { mode: "single", column: "Amount" },
};

describe.skipIf(!TEST_DATABASE_URL)("accounts, payees, rules and text safety (audit a6-text-rules-accounts)", () => {
  let t: TestApp;
  let clock = new Date("2026-11-13T18:00:00Z");
  let checkingId: string;

  const get = (url: string) => t.call({ method: "GET", url });
  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => t.call({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const csvCommit = (accountId: string, lines: string[]) =>
    send("POST", "/api/import/csv/commit", { accountId, csvText: ["Date,Description,Amount", ...lines].join("\n"), mapping: CSV_MAPPING });

  beforeAll(async () => {
    t = await createTestApp({ now: () => clock });
    await signInOwner(t);
    checkingId = (await send("POST", "/api/accounts", { name: "Checking", type: "checking", balanceCents: "100000" })).json().id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a6-text-rules-accounts-02: a rule must name a category that exists, and a category a rule sets is not deleted", async () => {
    const missing = await send("POST", "/api/rules", { conditions: { payee: { op: "contains", value: "ace hardware" } }, actions: { setCategoryId: "11111111-1111-4111-8111-111111111111" } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("unknown_category");

    const temp = (await send("POST", "/api/categories", { name: "Hardware Temp", bucket: "spending" })).json();
    const created = await send("POST", "/api/rules", { name: "Ace", conditions: { payee: { op: "contains", value: "ace hardware" } }, actions: { setCategoryId: temp.id }, applyTo: "none" });
    expect(created.statusCode).toBe(200);
    const ruleId = created.json().rule.id as string;
    const patch = await send("PATCH", `/api/rules/${ruleId}`, { actions: { setCategoryId: "22222222-2222-4222-8222-222222222222" } });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().code).toBe("unknown_category");

    const del = await send("DELETE", `/api/categories/${temp.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ code: "in_use" });
    expect(del.json().error).toContain("1 rule(s) (Ace)");

    expect((await send("DELETE", `/api/rules/${ruleId}`)).statusCode).toBe(200);
    expect((await send("DELETE", `/api/categories/${temp.id}`)).statusCode).toBe(200);

    // A rule left from before the guard, naming a category that is gone: a CSV with a matching row and another one commits both rows.
    await t.db.db.insert(rule).values({ name: "stale", position: 1, conditions: { payee: { op: "contains", value: "ace hardware" } }, actions: { setCategoryId: temp.id } });
    const commit = await csvCommit(checkingId, ["2026-11-02,ACE HARDWARE #123 DENVER CO,-25.10", "2026-11-02,KING SOOPERS #0123 DENVER CO,-45.32"]);
    expect(commit.statusCode).toBe(200);
    expect(commit.json().created).toBe(2);
    // The Rules page still shows what the stale rule was written with.
    expect(((await get("/api/rules")).json() as Array<{ actions: unknown }>)[0]!.actions).toEqual({ setCategoryId: temp.id });
    await t.db.db.delete(rule);
  });

  it("a6-text-rules-accounts-03: a manual account's balance is recorded by date; PATCH refuses a field it does not take", async () => {
    const house = (await send("POST", "/api/accounts", { name: "House", type: "asset", balanceCents: "45000000" })).json();
    expect(house).toMatchObject({ balanceCents: "45000000", balanceDate: "2026-11-13" });

    const ignored = await send("PATCH", `/api/accounts/${house.id}`, { balanceCents: "46000000" });
    expect(ignored.statusCode).toBe(400);
    expect(ignored.json().code).toBe("validation");

    const revalued = await send("POST", `/api/accounts/${house.id}/balances`, { balanceCents: "46000000" });
    expect(revalued.statusCode).toBe(200);
    expect(revalued.json()).toMatchObject({ balanceCents: "46000000", balanceDate: "2026-11-13" });
    // An older value goes into the history only; the account keeps its latest balance.
    const older = await send("POST", `/api/accounts/${house.id}/balances`, { date: "2025-11-01", balanceCents: "42000000" });
    expect(older.json()).toMatchObject({ balanceCents: "46000000", balanceDate: "2026-11-13" });
    const dash = (await get("/api/dashboard?today=2026-11-13")).json();
    // Hand check: today 1,000.00 checking + 460,000.00 house; a year ago (2025-11-13) the house's 420,000.00 (checking has no balance that old).
    expect(dash.netWorth).toMatchObject({ todayCents: "46100000", yearAgoCents: "42000000", changeCents: "4100000" });
    // A later date moves the account's balance.
    clock = new Date("2026-11-20T18:00:00Z");
    const later = await send("POST", `/api/accounts/${house.id}/balances`, { date: "2026-11-20", balanceCents: "47000000" });
    expect(later.json()).toMatchObject({ balanceCents: "47000000", balanceDate: "2026-11-20" });
    clock = new Date("2026-11-13T18:00:00Z");
    expect((await send("POST", `/api/accounts/${house.id}/balances`, { date: "2026-12-01", balanceCents: "1" })).json().code).toBe("future_date");

    // A feed account's balance is the bank's.
    const [conn] = await t.db.db.insert(connection).values({ name: "Bank", type: "simplefin" }).returning({ id: connection.id });
    const [feed] = await t.db.db.insert(account).values({ name: "Feed Checking", type: "checking", taxTreatment: "none", connectionId: conn!.id, externalId: "ACT-1" }).returning({ id: account.id });
    const refused = await send("POST", `/api/accounts/${feed!.id}/balances`, { balanceCents: "1" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("feed_account");
    await t.db.db.delete(account).where(eq(account.id, feed!.id));
    await send("PATCH", `/api/accounts/${house.id}`, { closed: true });
  });

  it("a6-text-rules-accounts-05: a manual loan is what is owed, so a positive balance is refused", async () => {
    const positive = await send("POST", "/api/accounts", { name: "Car loan", type: "loan", balanceCents: "1500000" });
    expect(positive.statusCode).toBe(400);
    expect(positive.json().code).toBe("debt_balance_positive");
    const loan = await send("POST", "/api/accounts", { name: "Car loan", type: "loan", balanceCents: "-1500000" });
    expect(loan.statusCode).toBe(200);
    expect((await send("POST", `/api/accounts/${loan.json().id}/balances`, { balanceCents: "1400000" })).json().code).toBe("debt_balance_positive");
    expect((await send("POST", `/api/accounts/${loan.json().id}/balances`, { balanceCents: "-1400000" })).json().balanceCents).toBe("-1400000");
    const dash = (await get("/api/dashboard?today=2026-11-13")).json();
    // Checking 1,000.00 − loan 14,000.00 (the house is closed).
    expect(dash.netWorth.todayCents).toBe("-1300000");
    await send("PATCH", `/api/accounts/${loan.json().id}`, { closed: true });
  });

  it("a6-text-rules-accounts-08: a manual house or loan starts off budget and stays out of the cash-flow projection", async () => {
    const boat = (await send("POST", "/api/accounts", { name: "Boat", type: "asset", balanceCents: "2000000" })).json();
    const loan = (await send("POST", "/api/accounts", { name: "Boat loan", type: "loan", balanceCents: "-500000" })).json();
    const card = (await send("POST", "/api/accounts", { name: "Card", type: "credit" })).json();
    expect([boat.onBudget, loan.onBudget, card.onBudget]).toEqual([false, false, true]);
    const projection = (await send("POST", "/api/cashflow/projection", { today: "2026-11-13", horizonDays: 30 })).json();
    expect(projection.accounts.map((a: { name: string }) => a.name).sort()).toEqual(["Card", "Checking"]);
    expect(projection.combined.points[0]).toBe("100000");
    for (const id of [boat.id, loan.id, card.id]) await send("PATCH", `/api/accounts/${id}`, { closed: true });
  });

  it("a6-text-rules-accounts-14: a new manual account's balance is dated by the household's day", async () => {
    // 03:00 UTC on Mar 2 is 20:00 on Mar 1 in America/Denver (the API clock, not the machine's).
    clock = new Date("2027-03-02T03:00:00Z");
    const car = (await send("POST", "/api/accounts", { name: "Car", type: "asset", balanceCents: "1800000" })).json();
    expect(car.balanceDate).toBe("2027-03-01");
    clock = new Date("2026-11-13T18:00:00Z");
    await send("PATCH", `/api/accounts/${car.id}`, { closed: true });
  });

  it("a6-text-rules-accounts-20: a blank account name is refused on create and on rename", async () => {
    const blank = await send("POST", "/api/accounts", { name: "   ", type: "asset" });
    expect(blank.statusCode).toBe(400);
    expect((await send("PATCH", `/api/accounts/${checkingId}`, { name: "  " })).statusCode).toBe(400);
    expect((await send("PATCH", `/api/accounts/${checkingId}`, { name: "  Checking  " })).json().name).toBe("Checking");
  });

  it("a6-text-rules-accounts-04: a rule pattern with nested quantifiers neither hangs the API nor the imports after it", async () => {
    await send("POST", "/api/transactions", { accountId: checkingId, date: "2026-11-03", amountCents: "-650", payeeName: "Pos Purchase Starbucks Store Denver Co 1234!" });
    const t0 = Date.now();
    const created = await send("POST", "/api/rules", { conditions: { payee: { op: "regex", value: "^(\\w+\\s?)+$" } }, actions: { addTags: ["words"] }, applyTo: "uncategorized" });
    expect(created.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await get("/api/health")).statusCode).toBe(200);
    const commit = await csvCommit(checkingId, ["2026-11-04,POS PURCHASE STARBUCKS STORE DENVER CO 1234!,-7.25"]);
    expect(commit.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(10000);
    await send("DELETE", `/api/rules/${created.json().rule.id}`);
  });

  it("a6-text-rules-accounts-04/16: a pattern that does not compile, and an amount range that cannot match, are refused", async () => {
    const bad = await send("POST", "/api/rules", { conditions: { description: { op: "regex", value: "(" } }, actions: { addTags: ["x"] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid_regex");
    expect((await send("POST", "/api/rules", { conditions: { description: { op: "regex", value: "(?=x)" } }, actions: { addTags: ["x"] } })).json().code).toBe("invalid_regex");
    expect((await send("POST", "/api/rules", { conditions: { amount: {} }, actions: { addTags: ["x"] } })).json().code).toBe("invalid_amount_range");
    expect((await send("POST", "/api/rules", { conditions: { amount: { minCents: "1000", maxCents: "500" } }, actions: { addTags: ["x"] } })).json().code).toBe("invalid_amount_range");
    const ok = await send("POST", "/api/rules", { conditions: { dayOfMonth: { min: 28, max: 3 } }, actions: { addTags: ["month-end"] }, applyTo: "none" });
    expect(ok.statusCode).toBe(200);
    const id = ok.json().rule.id as string;
    expect((await send("PATCH", `/api/rules/${id}`, { conditions: { description: { op: "regex", value: "[" } } })).json().code).toBe("invalid_regex");
    await send("DELETE", `/api/rules/${id}`);
  });

  it("a6-text-rules-accounts-18: \"always do this\" on a long payee name writes the rule, with its name cut", async () => {
    const long = "P".repeat(99);
    const res = await send("POST", "/api/rules", { name: `${long} → Groceries`, conditions: { payee: { op: "equals", value: long } }, actions: { addTags: ["long"] }, applyTo: "none" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.name).toBe(`${"P".repeat(99)}…`);
    expect(res.json().rule.name.length).toBe(100);
    await send("DELETE", `/api/rules/${res.json().rule.id}`);
  });

  it("a6-text-rules-accounts-19: rules created at the same time get positions 1..n", async () => {
    await t.db.db.delete(rule);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => send("POST", "/api/rules", { name: `r${i}`, conditions: { payee: { op: "contains", value: `p${i}` } }, actions: { addTags: [`t${i}`] }, applyTo: "none" })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const positions = ((await get("/api/rules")).json() as Array<{ position: number }>).map((r) => r.position);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a6-text-rules-accounts-13: a deleted rule is restored at its old position without running over existing rows", async () => {
    const before = (await get("/api/rules")).json() as Array<{ id: string; name: string; position: number; conditions: unknown; actions: unknown; enabled: boolean }>;
    const third = before[2]!;
    expect((await send("DELETE", `/api/rules/${third.id}`)).statusCode).toBe(200);
    const history = (await get(`/api/audit?entity=rule&entityId=${third.id}`)).json();
    const entry = history.items.find((i: { action: string }) => i.action === "delete");
    expect(entry.before).toMatchObject({ name: third.name, position: 3 });
    const restored = await send("POST", "/api/rules", { name: entry.before.name, conditions: entry.before.conditions, actions: entry.before.actions, position: entry.before.position, applyTo: "none" });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().applied).toEqual({ examined: 0, changed: 0 });
    const after = (await get("/api/rules")).json() as Array<{ name: string; position: number }>;
    expect(after.map((r) => [r.name, r.position])).toEqual(before.map((r) => [r.name, r.position]));
    await t.db.db.delete(rule);
  });

  it("a6-text-rules-accounts-10: rename keeps the old name, a clash is 409, and rules on a merged name keep working", async () => {
    const coffee = (await send("POST", "/api/categories", { name: "Coffee", bucket: "spending" })).json();
    await csvCommit(checkingId, ["2026-11-05,SBUX MOBILE ORDER,-6.45", "2026-11-05,STARBUCKS STORE #123,-4.10"]);
    const payees = (await get("/api/payees?q=s")).json().items as Array<{ id: string; name: string }>;
    const sbux = payees.find((p) => p.name === "Sbux Mobile Order")!;
    const store = payees.find((p) => p.name === "Starbucks Store")!;
    // The register's "always do this" on the variant.
    const always = await send("POST", "/api/rules", { name: "Sbux → Coffee", conditions: { payee: { op: "equals", value: "Sbux Mobile Order" } }, actions: { setCategoryId: coffee.id } });
    expect(always.json().applied.changed).toBe(1);
    const merged = await send("PATCH", `/api/payees/${store.id}`, { mergeFromId: sbux.id });
    expect(merged.json().aliases).toEqual(["Sbux Mobile Order"]);
    await csvCommit(checkingId, ["2026-11-06,SBUX MOBILE ORDER,-5.95"]);
    const rows = (await get(`/api/transactions?accountId=${checkingId}&limit=200`)).json().items as Array<{ amountCents: string; payeeName: string; categoryId: string | null }>;
    expect(rows.find((r) => r.amountCents === "-595")).toMatchObject({ payeeName: "Starbucks Store", categoryId: coffee.id });

    const renamed = await send("PATCH", `/api/payees/${store.id}`, { name: "Starbucks" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().aliases.sort()).toEqual(["Sbux Mobile Order", "Starbucks Store"]);
    await csvCommit(checkingId, ["2026-11-07,STARBUCKS STORE #456,-3.80"]);
    const after = (await get(`/api/transactions?accountId=${checkingId}&limit=200`)).json().items as Array<{ amountCents: string; payeeName: string }>;
    expect(after.find((r) => r.amountCents === "-380")!.payeeName).toBe("Starbucks");
    expect(((await get("/api/payees?q=starbucks")).json().items as Array<{ name: string }>).map((p) => p.name)).not.toContain("Starbucks Store");

    const other = (await get("/api/payees?q=king")).json().items[0] as { id: string };
    const clash = await send("PATCH", `/api/payees/${other.id}`, { name: "starbucks" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe("name_taken");
    const aliasClash = await send("PATCH", `/api/payees/${other.id}`, { name: "Sbux Mobile Order" });
    expect(aliasClash.statusCode).toBe(409);
    await t.db.db.delete(rule);
  });

  it("a6-text-rules-accounts, second round: a payee cannot be renamed to a blank name", async () => {
    const king = (await get("/api/payees?q=king")).json().items[0] as { id: string; name: string; aliases: string[] };
    expect(king.name).toBe("King Soopers");
    for (const name of ["   ", "", "\t \n"]) {
      const blank = await send("PATCH", `/api/payees/${king.id}`, { name });
      expect(blank.statusCode, JSON.stringify(name)).toBe(400);
      expect(blank.json().code).toBe("validation");
    }
    const listed = (await get("/api/payees?limit=200")).json().items as Array<{ id: string; name: string; aliases: string[] }>;
    expect(listed.map((p) => p.name)).not.toContain("");
    expect(listed.find((p) => p.id === king.id)).toMatchObject({ name: "King Soopers", aliases: king.aliases });
    // A name with spaces around it is kept trimmed, as before.
    const padded = await send("PATCH", `/api/payees/${king.id}`, { name: "  King Soopers Market  " });
    expect(padded.statusCode).toBe(200);
    expect(padded.json().name).toBe("King Soopers Market");
  });

  it("a6-text-rules-accounts, second round: security notes and investment memos keep the '<' and '>' that were typed", async () => {
    const brokerage = (await send("POST", "/api/accounts", { name: "Brokerage", type: "brokerage" })).json();
    const typedNotes = "Trim if price < 50; ER <0.1% vs 0.03%";
    const created = await send("POST", "/api/investments/securities", { ticker: "VTSAX", name: "Short Bond Fund <5 yr", type: "fund", assetClass: "us_stock", notes: typedNotes });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "Short Bond Fund <5 yr", notes: typedNotes });
    const patched = await send("PATCH", `/api/investments/securities/${created.json().id}`, { notes: "Sold > 1 yr held" });
    expect(patched.json().notes).toBe("Sold > 1 yr held");

    const dividend = await send("POST", "/api/investments/txns", { type: "dividend", accountId: brokerage.id, date: "2026-11-02", securityId: created.json().id, amountCents: "1250", memo: "TRANSFER -> SAVINGS" });
    expect(dividend.statusCode).toBe(200);
    const txn = dividend.json().items[0] as { id: string; memo: string | null };
    expect(txn.memo).toBe("TRANSFER -> SAVINGS");
    const memo = await send("PATCH", `/api/investments/txns/${txn.id}`, { memo: "price < 50, sold > 1 yr" });
    expect(memo.json().memo).toBe("price < 50, sold > 1 yr");

    // What could open a tag still goes, from typed text as from the feed.
    const hostile = await send("PATCH", `/api/investments/securities/${created.json().id}`, { notes: "see <img src=x onerror=alert(1)", name: "Fund <b>A</b>" });
    expect(hostile.json()).toMatchObject({ notes: "see img src=x onerror=alert(1)", name: "Fund A" });
  });

  it("a6-text-rules-accounts, second round: a stored rule whose pattern RE2 cannot run says so in the rule list", async () => {
    await t.db.db.delete(rule);
    // Stored as a rule saved before patterns ran on RE2 would be: the routes refuse look-ahead now.
    const [stale] = await t.db.db
      .insert(rule)
      .values({ name: "Ace, not refunds", position: 1, conditions: { description: { op: "regex", value: "^(?!.*REFUND).*ACE" } }, actions: { addTags: ["hardware"] } })
      .returning();
    const [backref] = await t.db.db
      .insert(rule)
      .values({ name: "Doubled word", position: 2, conditions: { payee: { op: "regex", value: "(\\w+) \\1" }, amount: { minCents: "100", maxCents: "-100" } }, actions: { addTags: ["x"] } })
      .returning();
    const fine = await send("POST", "/api/rules", { name: "Ace", conditions: { description: { op: "contains", value: "ace hardware" } }, actions: { addTags: ["ace"] }, applyTo: "none" });
    expect(fine.statusCode).toBe(200);
    expect(fine.json().rule.problems).toEqual([]);

    const listed = (await get("/api/rules")).json() as Array<{ id: string; enabled: boolean; problems: string[] }>;
    const byId = new Map(listed.map((r) => [r.id, r]));
    expect(byId.get(stale!.id)!.enabled).toBe(true);
    expect(byId.get(stale!.id)!.problems).toHaveLength(1);
    expect(byId.get(stale!.id)!.problems[0]).toMatch(/^The description pattern cannot run here \(.*\(\?!.*\), so this rule never matches\. Edit it: look-ahead, look-behind and back-references are not supported\.$/);
    expect(byId.get(backref!.id)!.problems).toEqual([
      expect.stringMatching(/^The payee pattern cannot run here .*, so this rule never matches\./),
      "The amount range's minimum is above its maximum, so this rule never matches. Edit it (amounts are signed: spending is negative).",
    ]);
    expect(byId.get(fine.json().rule.id)!.problems).toEqual([]);

    // What the list says is what a run does: the row the JavaScript engine would match is not tagged.
    await csvCommit(checkingId, ["2026-11-08,ACE HARDWARE #12 DENVER CO,-12.00"]);
    const rows = (await get(`/api/transactions?accountId=${checkingId}&limit=200`)).json().items as Array<{ amountCents: string; tags: string[] }>;
    expect(rows.find((r) => r.amountCents === "-1200")!.tags).toEqual(["ace"]);
    // The rule can still be switched off, and an edit that keeps the pattern is refused with the reason.
    const off = await send("PATCH", `/api/rules/${stale!.id}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().problems).toHaveLength(1);
    const keep = await send("PATCH", `/api/rules/${stale!.id}`, { actions: { addTags: ["tools"] } });
    expect(keep.statusCode).toBe(400);
    expect(keep.json().code).toBe("invalid_regex");
    const fixed = await send("PATCH", `/api/rules/${stale!.id}`, { conditions: { description: { op: "regex", value: "^.*ACE" } } });
    expect(fixed.json().problems).toEqual([]);
    await t.db.db.delete(rule);
  });

  it("a6-text-rules-accounts-15: CSV previews return sanitized headers, sample cells and date errors", async () => {
    const csvText = ["Date,Description,Amount\u202E", `not-a-date <b>${"x".repeat(400)}\u202E,COFFEE,\u202E00.005-`, "2026-11-01,<b>TEA</b>,-1.00"].join("\n");
    const res = await send("POST", "/api/import/csv/preview", { csvText, accountId: checkingId, mapping: { ...CSV_MAPPING, amount: { mode: "single", column: "Amount" } } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headers).toEqual(["Date", "Description", "Amount"]);
    expect(JSON.stringify(body.sampleRows)).not.toMatch(/[\u202E<>]/);
    expect(body.sampleRows[1][2]).toBe("00.005-");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message.length).toBeLessThanOrEqual(80);
    expect(body.errors[0].message).not.toMatch(/[\u202E<>]/);
    expect(body.rows.map((r: { description: string }) => r.description)).toEqual(["TEA"]);
    // The guessed mapping still finds the column whose header carried the override.
    const guessed = await send("POST", "/api/import/csv/preview", { csvText, accountId: checkingId });
    expect(guessed.json().headers).toEqual(["Date", "Description", "Amount"]);
  });
});
