import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountReconciliation, auditLog, balanceSnapshot, holdingSnapshot, job, price } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type { ReconcileCommitResponse, ReconcilePreviewResponse, ReconciliationListResponse } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Reconciliation routes on the INV seed (prices design §3.10, §4.1, tests 17–19; plan decision 14;
 * seams C15): the preview is a `readOnly` POST a viewer may call that writes nothing; the commit
 * records the attempt and, when accepted, writes the statement as a manual snapshot and balance
 * row, queues the valuation job and audits one batch; history lists newest first; delete removes
 * the record. B on 10-13 reconciles exactly (2 705 200 = three positions + the 143 200 plug).
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("reconcile routes", () => {
  let A: InvestmentApp;
  let B: string;
  let R: string;

  const bRows = [
    { ticker: "VTI", quantity: "40", price: "312.5" },
    { ticker: "VXUS", quantity: "100", price: "71.2" },
    { ticker: "AAPL", quantity: "25", price: "240" },
    { isCash: true, quantity: "1432" },
  ];

  beforeAll(async () => {
    A = await freshInvestmentApp({ lots: true });
    ({ brokerage: B, roth: R } = A.S.accounts);
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const tableCounts = async () => {
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries({ job, auditLog, price, balanceSnapshot, holdingSnapshot, accountReconciliation })) {
      out[name] = (await A.t.db.db.select({ n: count() }).from(table))[0]!.n;
    }
    return out;
  };
  const preview = async (payload: Record<string, unknown>, cookies?: Record<string, string>) =>
    cookies ? A.t.app.inject({ method: "POST", url: "/api/reconcile/preview", payload, cookies }) : A.t.call({ method: "POST", url: "/api/reconcile/preview", payload });
  const commit = async (payload: Record<string, unknown>) => A.t.call({ method: "POST", url: "/api/reconcile/commit", payload });

  it("previews B's 10-13 statement: match ×4, difference 0, the balance block, the app's day change; a viewer gets the same and nothing is written (test 17)", async () => {
    const before = await tableCounts();
    const res = await preview({ accountId: B, date: "2026-10-13", rows: bRows, today: TODAY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as ReconcilePreviewResponse;
    expect(view).toMatchObject({
      accountId: B,
      date: "2026-10-13",
      statementTotalCents: "2705200",
      differenceCents: "0",
      unexplainedCents: "0",
      toleranceCents: "100",
      matchesToDollar: true,
      balance: { balanceCents: "2705200", balanceDate: "2026-10-13", differenceCents: "0" },
      cashInferenceHint: null,
      alreadyReconciled: false,
    });
    expect(view.app).toMatchObject({ accountId: B, basis: "snapshot", asOf: "2026-10-13", valueCents: "2705200", dayChange: { cents: "32000", asOf: "2026-10-13", prior: "2026-10-12", reason: null }, lastReconciliation: null });
    expect(view.rows.map((r) => [r.ticker ?? r.name, r.status, r.valueDiffCents])).toEqual([
      ["AAPL", "match", "0"],
      ["VTI", "match", "0"],
      ["VXUS", "match", "0"],
      ["Cash", "match", "0"],
    ]);
    expect(view.rows.find((r) => r.ticker === "VTI")).toMatchObject({
      securityId: A.S.securities.vti,
      app: { quantity: "40", price: "312.5", priceDate: "2026-10-13", priceSource: "statement", valueCents: "1250000", valueSource: "statement" },
      statement: { quantity: "40", price: "312.5", valueCents: "1250000" },
      quantityDiff: "0",
      priceDiff: "0",
    });
    expect(view.rows.find((r) => r.isCash)).toMatchObject({ securityId: A.S.securities.cash, app: { quantity: null, valueCents: "143200", valueSource: "carried" }, statement: { quantity: "1432", valueCents: "143200" } });

    const viewer = await preview({ accountId: B, date: "2026-10-13", rows: bRows, today: TODAY }, await viewerCookies(A.t));
    expect(viewer.statusCode).toBe(200);
    expect(viewer.body).toBe(res.body);
    expect(await tableCounts()).toEqual(before);
  });

  it("flags differences and validates: a total-only statement off by $12.34, an unknown ticker, duplicates, valueless rows, future dates, non-investment accounts", async () => {
    const total = (await preview({ accountId: B, date: "2026-10-13", rows: [], statementTotalCents: "2706434", today: TODAY })).json() as ReconcilePreviewResponse;
    expect(total).toMatchObject({ differenceCents: "-1234", matchesToDollar: false, unexplainedCents: "0" });
    expect(total.rows).toEqual([expect.objectContaining({ name: "Statement total", status: "value", valueDiffCents: "-1234", statement: { quantity: "0", price: null, valueCents: "2706434" } })]);

    const priced = (await preview({ accountId: B, date: "2026-10-13", rows: [{ ...bRows[0], price: "312.52" }, ...bRows.slice(1)], today: TODAY })).json() as ReconcilePreviewResponse;
    expect(priced).toMatchObject({ statementTotalCents: "2705280", differenceCents: "-80", matchesToDollar: true });
    expect(priced.rows.find((r) => r.ticker === "VTI")).toMatchObject({ status: "price", priceDiff: "-0.02", valueDiffCents: "-80" });

    const unknown = (await preview({ accountId: B, date: "2026-10-13", rows: [...bRows, { ticker: "ZZZZ", quantity: "1", price: "1" }], today: TODAY })).json() as ReconcilePreviewResponse;
    expect(unknown.rows.find((r) => r.ticker === "ZZZZ")).toMatchObject({ securityId: null, status: "unknown_ticker", app: null });

    const codeOf = async (payload: Record<string, unknown>) => {
      const res = await preview(payload);
      expect(res.statusCode, res.body).toBe(400);
      return (res.json() as { code: string }).code;
    };
    expect(await codeOf({ accountId: B, date: "2026-10-13", rows: [bRows[0], bRows[0]], today: TODAY })).toBe("duplicate_security");
    expect(await codeOf({ accountId: B, date: "2026-10-13", rows: [{ ticker: "VTI", quantity: "40" }], today: TODAY })).toBe("validation");
    expect(await codeOf({ accountId: B, date: "2026-10-15", rows: bRows, today: TODAY })).toBe("future_date");
    expect(await codeOf({ accountId: A.S.accounts.checking, date: "2026-10-13", rows: [], statementTotalCents: "500000", today: TODAY })).toBe("not_investment_account");
    expect(await codeOf({ accountId: B, date: "2026-10-13", rows: [{ quantity: "1", price: "1" }], today: TODAY })).toBe("validation");
    expect((await preview({ accountId: randomUUID(), date: "2026-10-13", rows: [], today: TODAY })).statusCode).toBe(404);
  });

  it("commits R's 10-09 statement with accept: a manual snapshot and balance row, one audit batch, the valuation job, history and alreadyReconciled (tests 18–19)", async () => {
    const before = await tableCounts();
    const rows = [
      { ticker: "VTI", quantity: "20", price: "309" },
      { ticker: "BND", quantity: "100", price: "74.5" },
      { securityId: A.S.securities.tr2050, quantity: "100", valueCents: "420000" },
      { ticker: "CASH", quantity: "270" },
    ];
    const res = await commit({ accountId: R, date: "2026-10-09", rows, today: TODAY });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as ReconcileCommitResponse;
    expect(view).toMatchObject({ accepted: true, preCommitDifferenceCents: "0", matchesToDollar: true, rowsWritten: 4, impliedPricesWritten: 0 });
    expect(view.app).toMatchObject({ accountId: R, date: "2026-10-09", basis: "snapshot", asOf: "2026-10-09", valueCents: "1810000" });
    expect(view.app.lastReconciliation).toMatchObject({ id: view.reconciliationId, statementDate: "2026-10-09", diffCents: "0", reconciled: true, accepted: true });

    const snapshot = await A.t.db.db.select().from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, R), eq(holdingSnapshot.date, "2026-10-09")));
    expect(snapshot).toHaveLength(4);
    expect(snapshot.every((s) => s.source === "manual")).toBe(true);
    const [balance] = await A.t.db.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-09")));
    expect(balance).toMatchObject({ balanceCents: 1810000n, source: "manual" });
    const audits = await A.t.db.db.select().from(auditLog).where(eq(auditLog.batchId, view.batchId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "account_reconciliation", entityId: `${R}:2026-10-09`, action: "create" });
    const valuation = await A.t.db.db.select().from(job).where(eq(job.type, "investments.valuation"));
    expect(valuation).toEqual([expect.objectContaining({ status: "queued", payload: { reason: "reconcile", accountId: R, dedupeKey: `investments.valuation:${R}` } })]);
    // VTI's and BND's 10-09 closes stay provider rows; the statement wrote no price (counts: the record, the audit row and the job).
    const after = await tableCounts();
    expect(after).toEqual({ ...before, accountReconciliation: before["accountReconciliation"]! + 1, auditLog: before["auditLog"]! + 1, job: before["job"]! + 1 });

    const again = (await preview({ accountId: R, date: "2026-10-09", rows, today: TODAY })).json() as ReconcilePreviewResponse;
    expect(again).toMatchObject({ alreadyReconciled: true, differenceCents: "0" });
    expect(again.app.lastReconciliation).toMatchObject({ id: view.reconciliationId, accepted: true });

    const history = await A.t.call({ method: "GET", url: `/api/reconcile/history?accountId=${R}` });
    expect(history.statusCode).toBe(200);
    expect(history.headers["cache-control"]).toBe("no-store");
    expect((history.json() as ReconciliationListResponse).items).toEqual([
      expect.objectContaining({
        id: view.reconciliationId,
        accountId: R,
        date: "2026-10-09",
        statementTotalCents: "1810000",
        differenceCents: "0",
        unexplainedCents: "0",
        toleranceCents: "100",
        matchesToDollar: true,
        balance: { balanceCents: "1810000", balanceDate: null, differenceCents: "0" },
        appValueCents: "1810000",
        appBasis: "snapshot",
        appAsOf: "2026-10-09",
        cashInference: "auto",
        reconciled: true,
        accepted: true,
        holdingSnapshotDate: "2026-10-09",
        note: null,
      }),
    ]);
  });

  it("records a rejected attempt without touching the snapshot, refuses unknown tickers on accept, lists newest first and deletes with an audit row", async () => {
    const before = await tableCounts();
    const res = await commit({ accountId: B, date: "2026-10-13", rows: [], statementTotalCents: "2705200", accept: false, note: "checked against the October statement", today: TODAY });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as ReconcileCommitResponse;
    expect(view).toMatchObject({ accepted: false, preCommitDifferenceCents: "0", matchesToDollar: true, rowsWritten: 0, impliedPricesWritten: 0 });
    expect(view.app).toMatchObject({ basis: "snapshot", valueCents: "2705200" });
    expect(view.app.lastReconciliation).toMatchObject({ id: view.reconciliationId, accepted: false, reconciled: true });
    const after = await tableCounts();
    expect(after).toEqual({ ...before, accountReconciliation: before["accountReconciliation"]! + 1, auditLog: before["auditLog"]! + 1 });

    const unknown = await commit({ accountId: B, date: "2026-10-13", rows: [{ ticker: "ZZZZ", quantity: "1", price: "1" }], today: TODAY });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "unknown_ticker" });

    const second = (await commit({ accountId: B, date: "2026-10-12", rows: [], statementTotalCents: "2673200", accept: false, today: TODAY })).json() as ReconcileCommitResponse;
    const items = ((await A.t.call({ method: "GET", url: `/api/reconcile/history?accountId=${B}&limit=1` })).json() as ReconciliationListResponse).items;
    expect(items.map((i) => i.id)).toEqual([second.reconciliationId]);
    const all = ((await A.t.call({ method: "GET", url: `/api/reconcile/history?accountId=${B}` })).json() as ReconciliationListResponse).items;
    expect(all.map((i) => [i.id, i.date, i.note])).toEqual([
      [second.reconciliationId, "2026-10-12", null],
      [view.reconciliationId, "2026-10-13", "checked against the October statement"],
    ]);

    const del = await A.t.call({ method: "DELETE", url: `/api/reconcile/${second.reconciliationId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect((await A.t.db.db.select().from(auditLog).where(and(eq(auditLog.entity, "account_reconciliation"), eq(auditLog.action, "delete")))).length).toBe(1);
    expect((await A.t.call({ method: "DELETE", url: `/api/reconcile/${second.reconciliationId}` })).statusCode).toBe(404);
    expect(((await A.t.call({ method: "GET", url: `/api/reconcile/history?accountId=${B}` })).json() as ReconciliationListResponse).items.map((i) => i.id)).toEqual([view.reconciliationId]);
  });

  it("viewer: the preview is allowed, commit and delete are 403 viewer", async () => {
    const cookies = await viewerCookies(A.t);
    expect((await A.t.app.inject({ method: "GET", url: `/api/reconcile/history?accountId=${B}`, cookies })).statusCode).toBe(200);
    const commitRes = await A.t.app.inject({ method: "POST", url: "/api/reconcile/commit", payload: { accountId: B, date: "2026-10-13", rows: bRows, today: TODAY }, cookies });
    expect(commitRes.statusCode).toBe(403);
    expect(commitRes.json()).toMatchObject({ code: "viewer" });
    const delRes = await A.t.app.inject({ method: "DELETE", url: `/api/reconcile/${randomUUID()}`, cookies });
    expect(delRes.statusCode).toBe(403);
    expect(delRes.json()).toMatchObject({ code: "viewer" });
  });
});
