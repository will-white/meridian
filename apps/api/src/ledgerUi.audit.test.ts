import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, auditLog, balanceSnapshot, connection, job, payee } from "@meridian/db";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Audit batch a8-ledger-ui (the ledger pages in the web app): the routes behind the findings
 * whose fix is in the API. The services are tested in
 * packages/db/src/services/ledgerUi.audit.test.ts, the pages in
 * apps/web/src/components/ledgerAudit.test.tsx.
 */
describe.skipIf(!TEST_DATABASE_URL)("ledger pages, the routes behind them (audit a8-ledger-ui)", () => {
  let t: TestApp;
  const clock = new Date("2026-11-13T18:00:00Z");
  const get = (url: string) => t.call({ method: "GET", url });
  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => t.call({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const snapshots = async (accountId: string) =>
    (await t.db.db.select({ date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents }).from(balanceSnapshot).where(eq(balanceSnapshot.accountId, accountId)).orderBy(asc(balanceSnapshot.date))).map((s) => [
      s.date,
      s.balanceCents.toString(),
    ]);

  beforeAll(async () => {
    t = await createTestApp({ now: () => clock });
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  describe("a8-ledger-ui-01: a type change between a debt and anything else keeps what the household typed", () => {
    it("a car loan entered as Checking with 15,000 owes 15,000 once it is a Loan, history included, and audited", async () => {
      const car = (await send("POST", "/api/accounts", { name: "Car loan", type: "checking", balanceCents: "1500000" })).json();
      expect((await send("POST", `/api/accounts/${car.id}/balances`, { date: "2026-10-01", balanceCents: "1550000" })).statusCode).toBe(200);
      const changed = await send("PATCH", `/api/accounts/${car.id}`, { type: "loan" });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ type: "loan", balanceCents: "-1500000" });
      expect(await snapshots(car.id)).toEqual([
        ["2026-10-01", "-1550000"],
        ["2026-11-13", "-1500000"],
      ]);
      // The balance editor's "amount owed" (15,000.00) can be saved again: no state create and record-balance refuse.
      expect((await send("POST", `/api/accounts/${car.id}/balances`, { balanceCents: "-1490000" })).statusCode).toBe(200);
      const entries = await t.db.db.select().from(auditLog).where(eq(auditLog.entityId, car.id));
      expect(entries.some((e) => (e.before as { type?: string } | null)?.type === "checking" && (e.after as { type?: string; balanceCents?: string } | null)?.balanceCents === "-1500000")).toBe(true);
    });

    it("a house entered as a Loan (400,000 owed) is worth 400,000 once it is an Asset", async () => {
      const house = (await send("POST", "/api/accounts", { name: "House", type: "loan", balanceCents: "-40000000" })).json();
      const changed = await send("PATCH", `/api/accounts/${house.id}`, { type: "asset" });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ type: "asset", balanceCents: "40000000" });
      expect(await snapshots(house.id)).toEqual([["2026-11-13", "40000000"]]);
    });

    it("a change that would leave a loan with a positive balance is refused and changes nothing; a change within one side keeps the balance", async () => {
      const overdrawn = (await send("POST", "/api/accounts", { name: "Old checking", type: "checking", balanceCents: "-5000" })).json();
      const refused = await send("PATCH", `/api/accounts/${overdrawn.id}`, { type: "loan" });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe("debt_balance_positive");
      expect((await get("/api/accounts")).json().find((a: { id: string }) => a.id === overdrawn.id)).toMatchObject({ type: "checking", balanceCents: "-5000" });

      const card = (await send("POST", "/api/accounts", { name: "Store card", type: "credit", balanceCents: "-12000" })).json();
      expect((await send("PATCH", `/api/accounts/${card.id}`, { type: "loan" })).json()).toMatchObject({ type: "loan", balanceCents: "-12000" });
      const cash = (await send("POST", "/api/accounts", { name: "Cash", type: "checking", balanceCents: "8000" })).json();
      expect((await send("PATCH", `/api/accounts/${cash.id}`, { type: "savings" })).json()).toMatchObject({ type: "savings", balanceCents: "8000" });
    });

    it("second round: the refusal names the amounts in dollars, as the page does before sending", async () => {
      const overdrawn = (await send("POST", "/api/accounts", { name: "Overdrawn checking", type: "checking", balanceCents: "-1234567" })).json();
      const refused = await send("PATCH", `/api/accounts/${overdrawn.id}`, { type: "loan" });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        code: "debt_balance_positive",
        error: "A loan owes money, so its balance cannot be positive: as a loan, this account's balance of -$12,345.67 would be $12,345.67. Update its balance first, or keep its type",
      });
    });

    it("a feed account keeps the bank's balance whatever its type (the bank's sign is the bank's)", async () => {
      const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
      const [feed] = await t.db.db
        .insert(account)
        .values({ connectionId: conn!.id, externalId: "LOAN-1", name: "Auto loan", type: "checking", taxTreatment: "none", balanceCents: -1800000n, balanceDate: "2026-11-12" })
        .returning({ id: account.id });
      expect((await send("PATCH", `/api/accounts/${feed!.id}`, { type: "loan" })).json()).toMatchObject({ type: "loan", balanceCents: "-1800000" });
    });
  });

  it("a8-ledger-ui-02: reopening a feed account queues a replay of the stored sync responses for its connection", async () => {
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Credit union" }).returning({ id: connection.id });
    const [sav] = await t.db.db.insert(account).values({ connectionId: conn!.id, externalId: "SAV-1", name: "Savings", type: "savings", taxTreatment: "none", closed: true }).returning({ id: account.id });
    const replays = async () => (await t.db.db.select().from(job).where(eq(job.type, "simplefin.reprocess_transactions"))).filter((j) => j.payload["connectionId"] === conn!.id);
    expect(await replays()).toHaveLength(0);
    const reopened = await send("PATCH", `/api/accounts/${sav!.id}`, { closed: false });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().closed).toBe(false);
    expect((await replays()).map((j) => j.status)).toEqual(["queued"]);
    // Closing queues nothing, nor does reopening a manual account.
    await send("PATCH", `/api/accounts/${sav!.id}`, { closed: true });
    const manual = (await send("POST", "/api/accounts", { name: "Coins", type: "checking" })).json();
    await send("PATCH", `/api/accounts/${manual.id}`, { closed: true });
    await send("PATCH", `/api/accounts/${manual.id}`, { closed: false });
    expect(await replays()).toHaveLength(1);
  });

  it("a8-ledger-ui-02: a replay already running for the connection does not stand in for the reopen (it may have passed the closed days)", async () => {
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "Second bank" }).returning({ id: connection.id });
    const [sav] = await t.db.db.insert(account).values({ connectionId: conn!.id, externalId: "SAV-2", name: "Vacation fund", type: "savings", taxTreatment: "none", closed: true }).returning({ id: account.id });
    // "Re-read transactions" pressed a moment earlier: its replay is reading payloads while the account is still closed.
    await t.db.db.insert(job).values({ type: "simplefin.reprocess_transactions", payload: { connectionId: conn!.id }, status: "running", runAt: clock });
    expect((await send("PATCH", `/api/accounts/${sav!.id}`, { closed: false })).statusCode).toBe(200);
    const rows = (await t.db.db.select().from(job).where(eq(job.type, "simplefin.reprocess_transactions"))).filter((j) => j.payload["connectionId"] === conn!.id);
    expect(rows.map((j) => j.status).sort()).toEqual(["queued", "running"]);
    // A second reopen while that one waits adds nothing.
    await send("PATCH", `/api/accounts/${sav!.id}`, { closed: true });
    await send("PATCH", `/api/accounts/${sav!.id}`, { closed: false });
    expect((await t.db.db.select().from(job).where(eq(job.type, "simplefin.reprocess_transactions"))).filter((j) => j.payload["connectionId"] === conn!.id)).toHaveLength(2);
  });

  it("a8-ledger-ui-03: every payee can be reached: pages with a total, and a search that matches other names too", async () => {
    await t.db.db.delete(payee);
    const names = [...Array.from({ length: 615 }, (_, i) => `Aardvark Shop ${String(i).padStart(3, "0")}`), "Walmart", "Walmart Supercenter"];
    await t.db.db.insert(payee).values(names.map((name) => ({ name, aliases: name === "Walmart" ? ["WM SUPERCENTER #123"] : [] })));
    const first = await get("/api/payees");
    expect(first.statusCode).toBe(200);
    const page = first.json() as { items: Array<{ name: string }>; total: number; nextCursor: string | null };
    expect(page.total).toBe(617);
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
    const seen: string[] = page.items.map((p) => p.name);
    for (let cursor = page.nextCursor; cursor; ) {
      const next = (await get(`/api/payees?cursor=${encodeURIComponent(cursor)}`)).json() as typeof page;
      seen.push(...next.items.map((p) => p.name));
      cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(617);
    expect(new Set(seen).size).toBe(617);
    expect(seen.slice(-2)).toEqual(["Walmart", "Walmart Supercenter"]);
    // The merge picker searches: both Walmarts are found, one also by the name it was merged from.
    expect(((await get("/api/payees?q=walmart&limit=20")).json() as typeof page).items.map((p) => p.name)).toEqual(["Walmart", "Walmart Supercenter"]);
    expect(((await get("/api/payees?q=wm%20super")).json() as typeof page).items.map((p) => p.name)).toEqual(["Walmart"]);
    expect((await get("/api/payees?cursor=bm90LWEtY3Vyc29y")).json().code).toBe("invalid_cursor");
  });

  it("a8-ledger-ui-09, second round: 'always do this' is checked by the rules engine on the transaction, other names included", async () => {
    const coffee = (await send("POST", "/api/categories", { name: "Coffee (a8-09)", bucket: "spending" })).json();
    const dining = (await send("POST", "/api/categories", { name: "Dining (a8-09)", bucket: "spending" })).json();
    const acct = (await send("POST", "/api/accounts", { name: "Coffee card", type: "checking" })).json();
    const row = (await send("POST", "/api/transactions", { accountId: acct.id, date: "2026-11-10", amountCents: "-550", payeeName: "Blue Bottle Coffee" })).json();
    const check = async (id: string, categoryId: string) => (await get(`/api/transactions/${id}/always-rule?categoryId=${categoryId}`)).json();
    expect(await check(row.id, coffee.id)).toEqual({ verdict: "offer", rule: null, reason: null });

    const exact = (await send("POST", "/api/rules", { name: "Blue Bottle Coffee → Coffee", conditions: { payee: { op: "equals", value: "Blue Bottle Coffee" } }, actions: { setCategoryId: coffee.id }, applyTo: "none" })).json().rule;
    expect(await check(row.id, coffee.id)).toEqual({ verdict: "exists", rule: { id: exact.id, position: exact.position, name: "Blue Bottle Coffee → Coffee" }, reason: null });
    // The reviewer's case: a later, broader rule gives Dining, so the rule that exists does not decide and the offer stands.
    await send("POST", "/api/rules", { name: "Coffee shops → Dining", conditions: { payee: { op: "contains", value: "coffee" } }, actions: { setCategoryId: dining.id }, applyTo: "none" });
    expect(await check(row.id, coffee.id)).toEqual({ verdict: "offer", rule: null, reason: null });
    // An earlier rule that stops the run: no rule written after it would be reached.
    const stopper = (await send("POST", "/api/rules", { name: "Blue things stop here", position: 1, conditions: { payee: { op: "contains", value: "blue" } }, actions: { setCategoryId: dining.id, stop: true }, applyTo: "none" })).json().rule;
    expect(await check(row.id, coffee.id)).toEqual({ verdict: "blocked", rule: { id: stopper.id, position: 1, name: "Blue things stop here" }, reason: "stop" });

    // A payee's other names: a later rule on a name merged into Walmart decides its rows, as the sync and a rule run see them.
    await t.db.db.insert(payee).values({ name: "Walmart (a8-09)", aliases: ["Walmart Supercenter (a8-09)"] });
    const wm = (await send("POST", "/api/transactions", { accountId: acct.id, date: "2026-11-11", amountCents: "-8000", payeeName: "Walmart (a8-09)" })).json();
    await send("POST", "/api/rules", { name: "Walmart", conditions: { payee: { op: "equals", value: "Walmart (a8-09)" } }, actions: { setCategoryId: coffee.id }, applyTo: "none" });
    await send("POST", "/api/rules", { name: "Supercenter", conditions: { payee: { op: "equals", value: "Walmart Supercenter (a8-09)" } }, actions: { setCategoryId: dining.id }, applyTo: "none" });
    expect(await check(wm.id, coffee.id)).toEqual({ verdict: "offer", rule: null, reason: null });

    const missing = await get(`/api/transactions/00000000-0000-4000-8000-000000000999/always-rule?categoryId=${coffee.id}`);
    expect(missing.statusCode).toBe(404);
  });

  it("a8-ledger-ui-12: a paired leg carries its other leg's account and date", async () => {
    const chk = (await send("POST", "/api/accounts", { name: "Everyday", type: "checking" })).json();
    const sav = (await send("POST", "/api/accounts", { name: "Rainy day", type: "savings" })).json();
    const out = (await send("POST", "/api/transactions", { accountId: chk.id, date: "2026-11-02", amountCents: "-100000", payeeName: "Transfer to savings" })).json();
    const inflow = (await send("POST", "/api/transactions", { accountId: sav.id, date: "2026-11-03", amountCents: "100000", payeeName: "Transfer from checking" })).json();
    expect((await send("POST", `/api/transactions/${out.id}/pair`, { otherId: inflow.id })).json().transferPartner).toEqual({ id: inflow.id, accountId: sav.id, accountName: "Rainy day", date: "2026-11-03" });
    const list = (await get(`/api/transactions?accountId=${sav.id}`)).json();
    expect(list.items[0].transferPartner).toEqual({ id: out.id, accountId: chk.id, accountName: "Everyday", date: "2026-11-02" });
  });
});
