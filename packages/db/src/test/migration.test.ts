import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  account,
  accountReconciliation,
  allocationTarget,
  connection,
  holdingSnapshot,
  householdSetting,
  investmentTxn,
  lot,
  lotDisposal,
  lotPick,
  price,
  security,
  securityAlias,
  securityAllocation,
  transaction,
} from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./db.js";

/**
 * Constraint test for migration 0002_phase3_investments: the tables exist, the named
 * CHECKs, partial unique indexes and expression indexes refuse what they must, and one
 * valid row per table is accepted.
 */

const PHASE3_TABLES = [
  "security",
  "security_alias",
  "security_allocation",
  "price",
  "holding_snapshot",
  "investment_txn",
  "lot",
  "lot_pick",
  "lot_disposal",
  "allocation_target",
  "account_reconciliation",
] as const;

describe.skipIf(!TEST_DATABASE_URL)("migration 0002_phase3_investments", () => {
  let t: TestDb;
  let accountId: string;
  let cashId: string;
  let vtiId: string;
  let buyId: string;
  let sellId: string;
  let lotId: string;

  beforeAll(async () => {
    t = await createTestDb();
    const [acct] = await t.db.insert(account).values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning();
    accountId = acct!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates the 11 Phase 3 tables", async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ${PHASE3_TABLES}`,
    );
    expect([...rows].map((r) => r.table_name).sort()).toEqual([...PHASE3_TABLES].sort());
  });

  it("adds the account, household_setting and connection columns with their defaults and CHECKs", async () => {
    const [acct] = await t.db.select().from(account).where(sql`${account.id} = ${accountId}`);
    expect(acct).toMatchObject({ lotMethod: "fifo", cashInference: "auto", investmentIncomeFeed: "off" });

    const [hs] = await t.db.insert(householdSetting).values({ id: 1, planStartMonth: "2026-10" }).returning();
    expect(hs).toMatchObject({ benchmarkSecurityId: null, investmentIncomeCategoryId: null, rebalanceBandBp: 500, rebalanceMinTradeCents: 10000n });
    expect(typeof hs!.rebalanceMinTradeCents).toBe("bigint");

    const [conn] = await t.db.insert(connection).values({ type: "csv", name: "Statement CSV" }).returning();
    expect(conn!.csvKind).toBe("bank");

    await expect(t.db.execute(sql`update "account" set "lot_method" = 'average' where "id" = ${accountId}`)).rejects.toThrow(/account_lot_method_check/);
    await expect(t.db.execute(sql`update "account" set "cash_inference" = 'on' where "id" = ${accountId}`)).rejects.toThrow(/account_cash_inference_check/);
    await expect(t.db.execute(sql`update "account" set "investment_income_feed" = 'sync' where "id" = ${accountId}`)).rejects.toThrow(/account_income_feed_check/);
    await expect(t.db.update(householdSetting).set({ rebalanceBandBp: 5001 })).rejects.toThrow(/household_setting_rebalance_band_check/);
    await expect(t.db.update(householdSetting).set({ rebalanceMinTradeCents: -1n })).rejects.toThrow(/household_setting_min_trade_check/);
  });

  it("accepts one valid row per table", async () => {
    const [cash] = await t.db.insert(security).values({ name: "Cash (USD)", type: "cash", assetClass: "cash", priceMode: "manual" }).returning();
    cashId = cash!.id;
    expect(cash).toMatchObject({ ticker: null, currency: "USD", needsReview: true, archived: false, alwaysPrice: false, priceFetchFailures: 0, priceFetchStatus: null });

    const [vti] = await t.db
      .insert(security)
      .values({ ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", expenseRatioPpm: 300, priceMode: "provider", needsReview: false })
      .returning();
    vtiId = vti!.id;

    await t.db.insert(securityAlias).values({ securityId: vtiId, kind: "name", value: "VANGUARD TOTAL STOCK MKT ETF" });
    await t.db.insert(securityAllocation).values({ securityId: vtiId, assetClass: "us_stock", weightBp: 10000 });

    const [p] = await t.db
      .insert(price)
      .values({ securityId: vtiId, date: "2026-10-13", close: "300.25", adjClose: "300.25", source: "provider", provider: "tiingo", fetchedAt: new Date() })
      .returning();
    expect(p).toMatchObject({ close: "300.25000000", suspect: false });
    await t.db.insert(price).values({ securityId: vtiId, date: "2026-10-10", close: "298.1", source: "manual" });

    await t.db.insert(holdingSnapshot).values({
      accountId,
      securityId: vtiId,
      date: "2026-10-13",
      quantity: "10",
      price: "300.25",
      valueCents: 300250n,
      reportedCostBasisCents: 290000n,
      source: "csv",
    });
    // A dollar-only position: quantity and price null, value known.
    await t.db.insert(holdingSnapshot).values({ accountId, securityId: cashId, date: "2026-10-13", valueCents: 12345n, source: "csv" });

    const [buy] = await t.db
      .insert(investmentTxn)
      .values({
        accountId,
        securityId: vtiId,
        date: "2026-01-05",
        type: "buy",
        quantity: "10",
        price: "290",
        amountCents: -290000n,
        source: "csv",
        externalId: "csvid:abc",
        rawDescription: "Buy VTI",
      })
      .returning();
    buyId = buy!.id;
    expect(buy).toMatchObject({ feeCents: 0n, sequence: 0, userEdited: false, ledgerTransactionId: null });

    const [sell] = await t.db
      .insert(investmentTxn)
      .values({ accountId, securityId: vtiId, date: "2026-09-01", type: "sell", quantity: "4", price: "310", amountCents: 123900n, feeCents: 100n, source: "manual" })
      .returning();
    sellId = sell!.id;

    const [l] = await t.db
      .insert(lot)
      .values({
        accountId,
        securityId: vtiId,
        openedByTxnId: buyId,
        ordinal: 0,
        openedBy: "buy",
        acquiredDate: "2026-01-05",
        originalQuantity: "10",
        quantity: "6",
        originalCostBasisCents: 290000n,
        costBasisCents: 174000n,
      })
      .returning();
    lotId = l!.id;
    expect(l).toMatchObject({ basisKnown: true, closedDate: null, originLotId: null });

    await t.db.insert(lotPick).values({ sellTxnId: sellId, lotId, quantity: "4", position: 0 });

    await t.db.insert(lotDisposal).values({
      accountId,
      securityId: vtiId,
      closeTxnId: sellId,
      lotId,
      kind: "sell",
      date: "2026-09-01",
      acquiredDate: "2026-01-05",
      quantity: "4",
      proceedsCents: 123900n,
      basisCents: 116000n,
      gainCents: 7900n,
      term: "short",
      basisKnown: true,
    });

    await t.db.insert(allocationTarget).values({ assetClass: "us_stock", targetBp: 10000 });

    const [rec] = await t.db
      .insert(accountReconciliation)
      .values({
        accountId,
        statementDate: "2026-10-13",
        statementTotalCents: 312595n,
        appValueCents: 312595n,
        appBasis: "snapshot",
        appAsOf: "2026-10-13",
        cashInference: "auto",
        diffCents: 0n,
        balanceCents: 312595n,
        balanceDiffCents: 0n,
        reconciled: true,
        rows: [{ status: "match", securityId: vtiId }],
        accepted: true,
        holdingSnapshotDate: "2026-10-13",
      })
      .returning();
    expect(rec).toMatchObject({ toleranceCents: 100n, userId: null });

    // The household can now point its benchmark at a real security.
    await t.db.update(householdSetting).set({ benchmarkSecurityId: vtiId });
  });

  it("refuses rows that violate the named constraints", async () => {
    // itx_buy: a buy is a cash outflow.
    await expect(
      t.db.insert(investmentTxn).values({ accountId, securityId: vtiId, date: "2026-02-01", type: "buy", quantity: "1", price: "300", amountCents: 30000n, source: "manual" }),
    ).rejects.toThrow(/itx_buy/);
    // itx_transfer: a cash transfer in is a positive amount.
    await expect(
      t.db.insert(investmentTxn).values({ accountId, date: "2026-02-01", type: "transfer", transferDirection: "in", amountCents: -50000n, source: "manual" }),
    ).rejects.toThrow(/itx_transfer/);
    // itx_basis_only_in: carried basis belongs to transfers in only.
    await expect(
      t.db.insert(investmentTxn).values({ accountId, securityId: vtiId, date: "2026-02-01", type: "buy", quantity: "1", amountCents: -30000n, costBasisCents: 1n, source: "manual" }),
    ).rejects.toThrow(/itx_basis_only_in/);

    await expect(t.db.insert(lotPick).values({ sellTxnId: sellId, lotId, quantity: "0" })).rejects.toThrow(/lot_pick_quantity_pos/);

    await expect(t.db.insert(price).values({ securityId: vtiId, date: "2026-10-14", close: "301", source: "provider" })).rejects.toThrow(/price_provider_shape/);
    await expect(t.db.insert(price).values({ securityId: vtiId, date: "2026-10-14", close: "-1", source: "manual" })).rejects.toThrow(/price_close_nonneg/);

    // One cash security per currency (partial unique index).
    await expect(t.db.insert(security).values({ name: "Cash again", type: "cash", assetClass: "cash", priceMode: "manual" })).rejects.toThrow(/security_cash_currency_idx/);
    await expect(t.db.insert(security).values({ name: "Cash (EUR)", type: "cash", assetClass: "cash", currency: "EUR", priceMode: "manual" })).resolves.toBeDefined();
    // security_cash_shape: cash has no ticker and is class cash.
    await expect(t.db.insert(security).values({ ticker: "CASHX", name: "Sweep", type: "cash", assetClass: "cash", currency: "GBP", priceMode: "manual" })).rejects.toThrow(
      /security_cash_shape/,
    );
    await expect(t.db.insert(security).values({ ticker: "vti", name: "lower case", type: "etf", priceMode: "provider" })).rejects.toThrow(/security_ticker_shape/);
    await expect(t.db.insert(security).values({ ticker: "VTI", name: "Duplicate ticker", type: "etf", priceMode: "provider" })).rejects.toThrow(/security_ticker_idx/);

    await expect(t.db.insert(securityAllocation).values({ securityId: vtiId, assetClass: "bonds", weightBp: 0 })).rejects.toThrow(/security_allocation_weight_check/);

    await expect(
      t.db.execute(
        sql`insert into "account_reconciliation" ("account_id", "statement_date", "statement_total_cents", "app_basis", "cash_inference", "reconciled", "accepted")
            values (${accountId}, '2026-10-13', 100, 'guess', 'auto', false, false)`,
      ),
    ).rejects.toThrow(/account_reconciliation_app_basis_check/);

    await expect(t.db.insert(holdingSnapshot).values({ accountId, securityId: vtiId, date: "2026-10-14", price: "300", valueCents: 1n, source: "manual" })).rejects.toThrow(
      /hs_price_needs_quantity/,
    );
    await expect(t.db.insert(allocationTarget).values({ assetClass: "bonds", targetBp: 10001 })).rejects.toThrow(/allocation_target_bp_range/);

    // Lot identity is (opened_by_txn_id, ordinal).
    await expect(
      t.db.insert(lot).values({
        accountId,
        securityId: vtiId,
        openedByTxnId: buyId,
        ordinal: 0,
        openedBy: "buy",
        acquiredDate: "2026-01-05",
        originalQuantity: "1",
        quantity: "1",
        originalCostBasisCents: 1n,
        costBasisCents: 1n,
      }),
    ).rejects.toThrow(/lot_opened_by_ordinal_idx/);
  });

  it("lot_disposal is unique per (close_txn_id, lot_id) with null lot ids folded by COALESCE", async () => {
    const unmatched = {
      accountId,
      securityId: vtiId,
      closeTxnId: sellId,
      lotId: null,
      kind: "unmatched_sell" as const,
      date: "2026-09-01",
      quantity: "1",
      proceedsCents: 0n,
      basisCents: 0n,
      gainCents: 0n,
      term: "unknown" as const,
      basisKnown: false,
    };
    await expect(t.db.insert(lotDisposal).values(unmatched)).resolves.toBeDefined();
    await expect(t.db.insert(lotDisposal).values(unmatched)).rejects.toThrow(/lot_disposal_close_lot_idx/);
  });

  it("the partial unique index on investment_txn.ledger_transaction_id permits many nulls and one link per ledger row", async () => {
    const dividend = { accountId, securityId: vtiId, date: "2026-03-15", type: "dividend" as const, amountCents: 1234n, source: "csv" as const };
    for (let i = 0; i < 5; i++) {
      await expect(t.db.insert(investmentTxn).values({ ...dividend, sequence: i, externalId: `csvid:div-${i}` })).resolves.toBeDefined();
    }
    const [counted] = await t.db.execute<{ nulls: string }>(sql`select count(*)::text as nulls from "investment_txn" where "ledger_transaction_id" is null`);
    expect(Number(counted!.nulls)).toBeGreaterThanOrEqual(7);

    const [ledger] = await t.db
      .insert(transaction)
      .values({ accountId, source: "manual", date: "2026-03-15", amountCents: 1234n, rawDescription: "VTI DIVIDEND" })
      .returning();
    await expect(t.db.insert(investmentTxn).values({ ...dividend, sequence: 10, ledgerTransactionId: ledger!.id })).resolves.toBeDefined();
    await expect(t.db.insert(investmentTxn).values({ ...dividend, sequence: 11, ledgerTransactionId: ledger!.id })).rejects.toThrow(/investment_txn_ledger_idx/);
  });
});
