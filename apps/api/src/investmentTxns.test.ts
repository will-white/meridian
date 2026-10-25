import { and, count, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, balanceSnapshot } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type { AccountView, CreateInvestmentTxnResponse, HoldingSnapshotView, InvestmentTxnList, InvestmentTxnView, LotsResponse, SnapshotSummaryView } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Investment transactions and holding snapshots on the INV seed (imports design §3.10, §4,
 * tests 15, 22, 23, 24; plan decisions 5, 14, 17, 19): keyset listing, the manual defaults
 * (5 × 48.123 + $4.95 → −24 557), transfer legs, user edits and ledger links, the snapshot
 * reads with the Bridge comparison, the positions editor with `statementTotalCents`, the
 * snapshot delete, and the viewer matrix.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("investment transaction and snapshot routes", () => {
  let A: InvestmentApp;
  let B: string;
  let R: string;
  let C: string;

  beforeAll(async () => {
    A = await freshInvestmentApp({ lots: true });
    ({ brokerage: B, roth: R, checking: C } = A.S.accounts);
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const auditCount = async (): Promise<number> => (await A.t.db.db.select({ n: count() }).from(auditLog))[0]!.n;
  const list = async (query: string) => {
    const res = await A.t.call({ method: "GET", url: `/api/investments/txns?${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as InvestmentTxnList;
  };

  it("lists newest first with keyset paging and filters", async () => {
    const all = await list(`accountId=${B}`);
    expect(all.items).toHaveLength(11);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]).toMatchObject({ date: "2026-09-30", type: "interest", amountCents: "410", securityId: null });
    expect(all.items[10]).toMatchObject({ date: "2024-03-01", type: "buy", ticker: "VTI" });

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: InvestmentTxnList = await list(`accountId=${B}&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const item of page.items) seen.add(item.id);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen.size).toBe(11);

    expect((await list(`accountId=${B}&type=buy`)).items).toHaveLength(4);
    // VTI: B's two buys and three dividends, R's one dividend.
    expect((await list(`securityId=${A.S.securities.vti}`)).items).toHaveLength(6);
    expect((await list(`accountId=${B}&from=2026-09-01&to=2026-09-30`)).items.map((i) => i.date)).toEqual(["2026-09-30", "2026-09-28", "2026-09-22"]);
  });

  it("gets one row as its view", async () => {
    const res = await A.t.call({ method: "GET", url: `/api/investments/txns/${A.S.txns["buyVti1"]}` });
    expect(res.statusCode).toBe(200);
    expect(res.json() as InvestmentTxnView).toMatchObject({
      accountId: B,
      accountName: "Vanguard Brokerage",
      securityId: A.S.securities.vti,
      ticker: "VTI",
      securityName: "Vanguard Total Stock Market ETF",
      date: "2024-03-01",
      sequence: 0,
      type: "buy",
      quantity: "20",
      price: "250",
      amountCents: "-500000",
      feeCents: "0",
      transferDirection: null,
      lotPicks: [],
      ledgerTransactionId: null,
      externalId: "csvid:INV-SEED-1",
      source: "csv",
      userEdited: false,
    });
    expect((await A.t.call({ method: "GET", url: "/api/investments/txns/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("creates manual rows with the design's defaults, audits them and rebuilds lots; refuses bad shapes", async () => {
    const audits = await auditCount();
    const buy = await A.t.call({
      method: "POST",
      url: "/api/investments/txns",
      payload: { accountId: B, date: "2026-10-13", type: "buy", securityId: A.S.securities.aapl, quantity: "5", price: "48.123", feeCents: "495", today: TODAY },
    });
    expect(buy.statusCode).toBe(200);
    const created = buy.json() as CreateInvestmentTxnResponse;
    // 5 × 48.123 = 240.615 → 24 062 (half away), plus the $4.95 fee.
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({ amountCents: "-24557", feeCents: "495", sequence: 0, source: "manual", externalId: null, quantity: "5", price: "48.123" });
    expect(await auditCount()).toBe(audits + 1);

    const lots = (await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${B}&securityId=${A.S.securities.aapl}&asOf=2026-10-13&today=${TODAY}` })).json() as LotsResponse;
    const lot = lots.lots.find((l) => l.openedByTxnId === created.items[0]!.id)!;
    // Basis per share 24 557 / 5 = 49.114; valued at the 10-13 close of 240: 5 × 240 = 1 200.00.
    expect(lot).toMatchObject({ quantity: "5", originalCostBasisCents: "24557", costBasisCents: "24557", basisPerShare: "49.114", basisKnown: true, priceDate: "2026-10-13", valueCents: "120000", unrealizedCents: "95443", term: "short" });

    const second = (await A.t.call({ method: "POST", url: "/api/investments/txns", payload: { accountId: B, date: "2026-10-13", type: "buy", securityId: A.S.securities.aapl, quantity: "1", price: "240", today: TODAY } })).json() as CreateInvestmentTxnResponse;
    expect(second.items[0]).toMatchObject({ sequence: 1, amountCents: "-24000" });

    const bad = async (payload: Record<string, unknown>) => {
      const res = await A.t.call({ method: "POST", url: "/api/investments/txns", payload });
      expect(res.statusCode).toBe(400);
      return res.json().code as string;
    };
    expect(await bad({ accountId: B, date: "2026-10-13", type: "sell", securityId: A.S.securities.aapl, quantity: "4", price: "249.65", amountCents: "-1", today: TODAY })).toBe("txn_invalid");
    expect(await bad({ accountId: B, date: "2026-10-13", type: "buy", securityId: A.S.securities.aapl, quantity: "0", price: "1", today: TODAY })).toBe("validation");
    expect(await bad({ accountId: B, date: "2026-10-15", type: "buy", securityId: A.S.securities.aapl, quantity: "1", price: "1", today: TODAY })).toBe("future_date");
    expect(await bad({ accountId: C, date: "2026-10-13", type: "buy", securityId: A.S.securities.aapl, quantity: "1", price: "1", today: TODAY })).toBe("not_investment_account");
    expect(await bad({ accountId: B, date: "2026-10-13", type: "dividend", today: TODAY })).toBe("validation");

    for (const item of [...created.items, ...second.items]) {
      expect((await A.t.call({ method: "DELETE", url: `/api/investments/txns/${item.id}` })).json()).toEqual({ ok: true });
      expect((await A.t.call({ method: "GET", url: `/api/investments/txns/${item.id}` })).statusCode).toBe(404);
    }
  });

  it("writes both legs of an own-account transfer and guards the pair", async () => {
    const res = await A.t.call({
      method: "POST",
      url: "/api/investments/txns",
      payload: { accountId: B, date: "2026-10-13", type: "transfer", direction: "out", securityId: A.S.securities.vti, quantity: "10", counterpartyAccountId: R, today: TODAY },
    });
    expect(res.statusCode).toBe(200);
    const [out, inLeg] = (res.json() as CreateInvestmentTxnResponse).items;
    expect(out).toMatchObject({ accountId: B, transferDirection: "out", amountCents: "0", quantity: "10", counterpartyAccountId: R });
    expect(inLeg).toMatchObject({ accountId: R, transferDirection: "in", amountCents: "0", quantity: "10", counterpartyAccountId: B });
    expect(out!.transferGroupId).toBe(inLeg!.transferGroupId);
    expect(out!.transferGroupId).not.toBeNull();

    const edit = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${inLeg!.id}`, payload: { quantity: "5", today: TODAY } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe("transfer_leg_linked");
    const del = await A.t.call({ method: "DELETE", url: `/api/investments/txns/${out!.id}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe("transfer_leg_linked");
    expect((await A.t.call({ method: "DELETE", url: `/api/investments/txns/${out!.id}?deleteGroup=true` })).json()).toEqual({ ok: true });
    expect((await A.t.call({ method: "GET", url: `/api/investments/txns/${inLeg!.id}` })).statusCode).toBe(404);
  });

  it("patches user-owned and source-owned columns and links to the ledger", async () => {
    const memo = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${A.S.txns["buyVti1"]}`, payload: { memo: "first lot", today: TODAY } });
    expect(memo.statusCode).toBe(200);
    expect(memo.json()).toMatchObject({ memo: "first lot", userEdited: false });
    const price = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${A.S.txns["buyVti1"]}`, payload: { price: "250.5", today: TODAY } });
    expect(price.json()).toMatchObject({ price: "250.5", userEdited: true });
    await A.t.call({ method: "PATCH", url: `/api/investments/txns/${A.S.txns["buyVti1"]}`, payload: { price: "250", today: TODAY } });

    const divSep = A.S.txns["divVtiSep"]!;
    const unlinked = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${divSep}`, payload: { ledgerTransactionId: null, today: TODAY } });
    expect(unlinked.json().ledgerTransactionId).toBeNull();
    const relinked = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${divSep}`, payload: { ledgerTransactionId: A.S.ledger["divVtiSep"], today: TODAY } });
    expect(relinked.json().ledgerTransactionId).toBe(A.S.ledger["divVtiSep"]);
    const taken = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${A.S.txns["divVtiMar"]}`, payload: { ledgerTransactionId: A.S.ledger["divVtiSep"], today: TODAY } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("ledger_linked");
    const other = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${A.S.txns["divVtiMar"]}`, payload: { ledgerTransactionId: A.S.ledger["xferOut"], today: TODAY } });
    expect(other.statusCode).toBe(400);
  });

  it("reads snapshots with the Bridge comparison", async () => {
    const summaries = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/snapshots` })).json() as SnapshotSummaryView[];
    // 10-13: 1 250 000 + 712 000 + 600 000; 10-12: 1 240 000 + 700 000 + 590 000.
    expect(summaries).toEqual([
      { date: "2026-10-13", source: "simplefin", positions: 3, totalValueCents: "2562000" },
      { date: "2026-10-12", source: "simplefin", positions: 3, totalValueCents: "2530000" },
    ]);
    const snapshot = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/snapshots/2026-10-13` })).json() as HoldingSnapshotView;
    // B is SimpleFIN-fed: the Bridge balance that day is 2 705 200, so the positions miss 1 432.00 of cash.
    expect(snapshot).toMatchObject({ accountId: B, date: "2026-10-13", source: "simplefin", totalValueCents: "2562000", knownBalanceCents: "2705200", differenceCents: "-143200", matchesToDollar: false });
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.rows.find((r) => r.ticker === "VTI")).toMatchObject({ quantity: "40", price: "312.5", valueCents: "1250000", reportedCostBasisCents: null });
    expect((await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/snapshots/2026-10-11` })).statusCode).toBe(404);

    const latest = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/positions?asOf=2026-10-12&today=${TODAY}` })).json() as HoldingSnapshotView;
    expect(latest).toMatchObject({ date: "2026-10-12", totalValueCents: "2530000" });
    // R's latest set is the 10-09 statement; no Bridge balance to compare with.
    const roth = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${R}/positions?today=${TODAY}` })).json() as HoldingSnapshotView;
    expect(roth).toMatchObject({ date: "2026-10-09", source: "csv", totalValueCents: "1810000", knownBalanceCents: null, differenceCents: null, matchesToDollar: null });
    expect(roth.rows).toHaveLength(4);
    expect((await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/positions?asOf=2026-10-15&today=${TODAY}` })).statusCode).toBe(400);
    const checking = await A.t.call({ method: "GET", url: `/api/investments/accounts/${C}/snapshots` });
    expect(checking.statusCode).toBe(400);
    expect(checking.json().code).toBe("not_investment_account");
    expect((await A.t.call({ method: "GET", url: "/api/investments/accounts/00000000-0000-4000-8000-000000000000/snapshots" })).statusCode).toBe(404);
  });

  it("saves manual positions with the statement total, audits once, and deletes the set with its balance row", async () => {
    const audits = await auditCount();
    const body = {
      asOfDate: "2026-10-13",
      statementTotalCents: "1820000",
      positions: [
        { security: { kind: "existing", securityId: A.S.securities.vti }, quantity: "20", price: "312.5" },
        { security: { kind: "existing", securityId: A.S.securities.bnd }, quantity: "100", valueCents: "748000" },
        { security: { kind: "create", security: { ticker: null, cusip: null, isin: null, name: "Cash", type: "cash", assetClass: "cash" } }, valueCents: "27000" },
      ],
      today: TODAY,
    };
    const res = await A.t.call({ method: "PUT", url: `/api/investments/accounts/${R}/positions`, payload: body });
    expect(res.statusCode).toBe(200);
    const view = res.json() as HoldingSnapshotView;
    // 20 × 312.5 = 6 250.00; BND's price is implied from 7 480.00 / 100; cash resolves to the seed's cash security.
    expect(view).toMatchObject({ accountId: R, date: "2026-10-13", source: "manual", totalValueCents: "1400000", knownBalanceCents: null });
    expect(view.rows).toHaveLength(3);
    expect(view.rows.find((r) => r.ticker === "VTI")).toMatchObject({ quantity: "20", price: "312.5", valueCents: "625000" });
    expect(view.rows.find((r) => r.ticker === "BND")).toMatchObject({ quantity: "100", price: "74.8", valueCents: "748000" });
    expect(view.rows.find((r) => r.securityId === A.S.securities.cash)).toMatchObject({ quantity: "270", price: "1", valueCents: "27000" });
    expect(await auditCount()).toBe(audits + 1);
    // The balance row is the statement's total (not Σ positions) and replaces the computed row of that day.
    const [balance] = await A.t.db.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-13")));
    expect(balance).toMatchObject({ balanceCents: 1820000n, source: "manual" });
    const accounts = (await A.t.call({ method: "GET", url: "/api/accounts" })).json() as AccountView[];
    expect(accounts.find((a) => a.id === R)).toMatchObject({ balanceCents: "1820000", balanceDate: "2026-10-13" });

    await A.t.call({ method: "PUT", url: `/api/investments/accounts/${R}/positions`, payload: body });
    expect(await auditCount()).toBe(audits + 1);
    const summaries = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${R}/snapshots` })).json() as SnapshotSummaryView[];
    expect(summaries.map((s) => [s.date, s.source, s.positions])).toEqual([
      ["2026-10-13", "manual", 3],
      ["2026-10-09", "csv", 4],
    ]);

    const simplefin = await A.t.call({ method: "DELETE", url: `/api/investments/accounts/${B}/snapshots/2026-10-13` });
    expect(simplefin.statusCode).toBe(409);
    expect(simplefin.json().code).toBe("snapshot_source");
    expect((await A.t.call({ method: "DELETE", url: `/api/investments/accounts/${R}/snapshots/2026-01-01` })).statusCode).toBe(404);
    expect((await A.t.call({ method: "DELETE", url: `/api/investments/accounts/${R}/snapshots/2026-10-13` })).json()).toEqual({ ok: true });
    expect(await auditCount()).toBe(audits + 2);
    const gone = await A.t.db.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-13")));
    expect(gone).toEqual([]);
    const after = (await A.t.call({ method: "GET", url: "/api/accounts" })).json() as AccountView[];
    expect(after.find((a) => a.id === R)).toMatchObject({ balanceCents: "1810000", balanceDate: "2026-10-09" });
  });

  it("lets a viewer read and refuses every mutation", async () => {
    const cookies = await viewerCookies(A.t);
    for (const url of [`/api/investments/txns?accountId=${B}`, `/api/investments/txns/${A.S.txns["buyVti1"]}`, `/api/investments/accounts/${B}/snapshots`, `/api/investments/accounts/${B}/snapshots/2026-10-13`, `/api/investments/accounts/${B}/positions?today=${TODAY}`]) {
      expect((await A.t.app.inject({ method: "GET", url, cookies })).statusCode, url).toBe(200);
    }
    const writes: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: Record<string, unknown> }> = [
      { method: "POST", url: "/api/investments/txns", payload: { accountId: B, date: "2026-10-13", type: "dividend", amountCents: "100", today: TODAY } },
      { method: "PATCH", url: `/api/investments/txns/${A.S.txns["buyVti1"]}`, payload: { memo: "x" } },
      { method: "DELETE", url: `/api/investments/txns/${A.S.txns["buyVti1"]}` },
      { method: "PUT", url: `/api/investments/accounts/${R}/positions`, payload: { asOfDate: "2026-10-13", positions: [{ security: { kind: "existing", securityId: A.S.securities.vti }, quantity: "1", price: "1" }] } },
      { method: "DELETE", url: `/api/investments/accounts/${R}/snapshots/2026-10-09` },
    ];
    for (const w of writes) {
      const opts: InjectOptions = { method: w.method, url: w.url, cookies };
      if (w.payload !== undefined) opts.payload = w.payload;
      const res = await A.t.app.inject(opts);
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(403);
      expect(res.json().code).toBe("viewer");
    }
  });
});
