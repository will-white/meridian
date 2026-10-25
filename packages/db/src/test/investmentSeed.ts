import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { IsoDate } from "@meridian/shared";
import type { Db } from "../index.js";
import { rebuildLotsForAccounts, type RebuildAccountsResult } from "../services/lots.js";
import {
  account,
  allocationTarget,
  balanceSnapshot,
  category,
  connection,
  holdingSnapshot,
  householdSetting,
  investmentTxn,
  lot,
  price,
  security,
  securityAllocation,
  transaction,
} from "../schema/index.js";

/**
 * The Phase 3 "INV" seed (docs/design/phase-3/views-and-api.md §7.0), inserted into a test
 * database the way `planSeed.ts` does for Phase 2. Today = 2026-10-14 (America/Denver), so
 * the expected price date at `INV_SEED_NOW` is 2026-10-13.
 *
 * Hand totals (2026-10-13): B securities 2 562 000 + residual 143 200 = 2 705 200;
 * R 625 000 + 748 000 + 420 000 + 27 000 = 1 820 000; household 4 525 200.
 * 10-12: B 2 673 200, R 1 816 000 (4 489 200); 10-09: 2 679 200 + 1 810 000 = 4 489 200.
 *
 * Lots are a derived cache the lots service (step 7) rebuilds from B's four buys; this seed
 * writes the transactions and leaves `rebuildLots` to the step that owns it.
 */

export const INV_SEED_TODAY: IsoDate = "2026-10-14";
/** 12:00 in Denver, 14:00 in New York: before the 18:30 ET close, so `expectedPriceDate` is 2026-10-13. */
export const INV_SEED_NOW = new Date("2026-10-14T18:00:00Z");

export interface InvestmentSeed {
  accounts: { brokerage: string; roth: string; checking: string };
  connections: { vanguard: string; fidelity: string };
  categories: { dividends: string };
  securities: { vti: string; vxus: string; bnd: string; aapl: string; tr2050: string; cash: string };
  /** B's investment_txn rows by a readable key. */
  txns: Record<string, string>;
  /** The ledger rows by a readable key (`divVtiSep` is B's 09-29 bank row of the 09-28 dividend; `xferIn`/`xferOut` the paired transfer). */
  ledger: Record<string, string>;
}

export async function seedInvestmentFixture(db: Db): Promise<InvestmentSeed> {
  const [dividends] = await db.insert(category).values({ name: "Dividends", bucket: "income", position: 1 }).returning({ id: category.id });

  const conns = await db
    .insert(connection)
    .values([
      { type: "simplefin", name: "Vanguard", status: "ok" },
      { type: "csv", name: "Fidelity positions", csvKind: "positions", status: "ok" },
    ])
    .returning({ id: connection.id, name: connection.name });
  const conn = (name: string) => conns.find((c) => c.name === name)!.id;
  const vanguard = conn("Vanguard");
  const fidelity = conn("Fidelity positions");

  const accounts = await db
    .insert(account)
    .values([
      {
        name: "Vanguard Brokerage",
        type: "brokerage",
        taxTreatment: "taxable",
        connectionId: vanguard,
        externalId: "ACT-VG-001",
        institution: "Vanguard",
        onBudget: false,
        investmentIncomeFeed: "link",
        balanceCents: 2705200n,
        balanceDate: "2026-10-13",
      },
      {
        name: "Fidelity Roth IRA",
        type: "roth",
        taxTreatment: "roth",
        connectionId: fidelity,
        institution: "Fidelity",
        onBudget: false,
        investmentIncomeFeed: "off",
        balanceCents: 1810000n,
        balanceDate: "2026-10-09",
      },
      { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true, balanceCents: 500000n, balanceDate: "2026-10-13" },
    ])
    .returning({ id: account.id, name: account.name });
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  const B = acct("Vanguard Brokerage");
  const R = acct("Fidelity Roth IRA");
  const C = acct("Checking");

  const secs = await db
    .insert(security)
    .values([
      { ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", expenseRatioPpm: 300, priceMode: "provider", needsReview: false },
      { ticker: "VXUS", name: "Vanguard Total International Stock ETF", type: "etf", assetClass: "intl_stock", expenseRatioPpm: 500, priceMode: "provider", needsReview: false },
      { ticker: "BND", name: "Vanguard Total Bond Market ETF", type: "etf", assetClass: "bonds", expenseRatioPpm: 300, priceMode: "provider", needsReview: false },
      { ticker: "AAPL", name: "Apple Inc", type: "stock", assetClass: "us_stock", expenseRatioPpm: null, priceMode: "provider", needsReview: false },
      { ticker: null, name: "Vanguard Target Retirement 2050 Trust", type: "fund", assetClass: "us_stock", expenseRatioPpm: 800, priceMode: "implied", needsReview: false },
      { ticker: null, name: "Cash (USD)", type: "cash", assetClass: "cash", currency: "USD", priceMode: "manual", needsReview: false },
    ])
    .returning({ id: security.id, name: security.name });
  const sec = (name: string) => secs.find((s) => s.name === name)!.id;
  const VTI = sec("Vanguard Total Stock Market ETF");
  const VXUS = sec("Vanguard Total International Stock ETF");
  const BND = sec("Vanguard Total Bond Market ETF");
  const AAPL = sec("Apple Inc");
  const TR2050 = sec("Vanguard Target Retirement 2050 Trust");
  const CASH = sec("Cash (USD)");

  await db.insert(securityAllocation).values([
    { securityId: TR2050, assetClass: "us_stock", weightBp: 5400 },
    { securityId: TR2050, assetClass: "intl_stock", weightBp: 3600 },
    { securityId: TR2050, assetClass: "bonds", weightBp: 1000 },
  ]);

  await db
    .insert(householdSetting)
    .values({
      id: 1,
      planStartMonth: "2026-01",
      timezone: "America/Denver",
      benchmarkSecurityId: VTI,
      investmentIncomeCategoryId: dividends!.id,
      rebalanceBandBp: 500,
      rebalanceMinTradeCents: 10000n,
    })
    .onConflictDoUpdate({
      target: householdSetting.id,
      set: { planStartMonth: "2026-01", timezone: "America/Denver", benchmarkSecurityId: VTI, investmentIncomeCategoryId: dividends!.id, rebalanceBandBp: 500, rebalanceMinTradeCents: 10000n },
    });

  // Household targets 50/25/20/5 (views §7 test 4 deletes them; test 5 re-sets them through the service).
  await db.insert(allocationTarget).values([
    { assetClass: "us_stock", targetBp: 5000 },
    { assetClass: "intl_stock", targetBp: 2500 },
    { assetClass: "bonds", targetBp: 2000 },
    { assetClass: "cash", targetBp: 500 },
  ]);

  const provider = (securityId: string, date: IsoDate, close: string) => ({
    securityId,
    date,
    close,
    adjClose: close,
    source: "provider" as const,
    provider: "tiingo" as const,
    suspect: false,
    fetchedAt: INV_SEED_NOW,
  });
  await db.insert(price).values([
    provider(VTI, "2025-10-13", "260"),
    provider(VXUS, "2025-10-13", "60"),
    provider(AAPL, "2025-10-13", "272"),
    provider(VTI, "2026-04-10", "290"),
    provider(VXUS, "2026-04-10", "66"),
    provider(AAPL, "2026-04-10", "236"),
    provider(VTI, "2026-04-13", "290"),
    provider(VTI, "2026-10-09", "309"),
    provider(VXUS, "2026-10-09", "70.5"),
    provider(AAPL, "2026-10-09", "238"),
    provider(BND, "2026-10-09", "74.5"),
    { securityId: TR2050, date: "2026-10-09", close: "42", source: "implied" as const },
    provider(VTI, "2026-10-12", "310"),
    provider(VXUS, "2026-10-12", "70"),
    provider(AAPL, "2026-10-12", "236"),
    provider(BND, "2026-10-12", "74.9"),
    provider(VTI, "2026-10-13", "312.5"),
    provider(VXUS, "2026-10-13", "71.2"),
    provider(AAPL, "2026-10-13", "240"),
    provider(BND, "2026-10-13", "74.8"),
  ]);

  const snap = (accountId: string, date: IsoDate, source: "simplefin" | "csv" | "manual", securityId: string, quantity: string, valueCents: bigint, priceValue: string) => ({
    accountId,
    date,
    source,
    securityId,
    quantity,
    price: priceValue,
    valueCents,
    reportedCostBasisCents: null,
  });
  await db.insert(holdingSnapshot).values([
    snap(B, "2026-10-12", "simplefin", VTI, "40", 1240000n, "310"),
    snap(B, "2026-10-12", "simplefin", VXUS, "100", 700000n, "70"),
    snap(B, "2026-10-12", "simplefin", AAPL, "25", 590000n, "236"),
    snap(B, "2026-10-13", "simplefin", VTI, "40", 1250000n, "312.5"),
    snap(B, "2026-10-13", "simplefin", VXUS, "100", 712000n, "71.2"),
    snap(B, "2026-10-13", "simplefin", AAPL, "25", 600000n, "240"),
    snap(R, "2026-10-09", "csv", VTI, "20", 618000n, "309"),
    snap(R, "2026-10-09", "csv", BND, "100", 745000n, "74.5"),
    snap(R, "2026-10-09", "csv", TR2050, "100", 420000n, "42"),
    snap(R, "2026-10-09", "csv", CASH, "270", 27000n, "1"),
  ]);

  await db.insert(balanceSnapshot).values([
    { accountId: B, date: "2025-10-13", balanceCents: 2000000n, source: "simplefin" },
    { accountId: B, date: "2026-10-09", balanceCents: 2679200n, source: "simplefin" },
    { accountId: B, date: "2026-10-12", balanceCents: 2673200n, source: "simplefin" },
    { accountId: B, date: "2026-10-13", balanceCents: 2705200n, source: "simplefin" },
    { accountId: R, date: "2025-10-13", balanceCents: 1500000n, source: "manual" },
    { accountId: R, date: "2026-10-09", balanceCents: 1810000n, source: "csv" },
    { accountId: R, date: "2026-10-12", balanceCents: 1816000n, source: "computed" },
    { accountId: R, date: "2026-10-13", balanceCents: 1820000n, source: "computed" },
    { accountId: C, date: "2026-10-13", balanceCents: 500000n, source: "manual" },
  ]);

  // Ledger rows in B (SimpleFIN, uncategorized) and the one paired transfer with Checking.
  const transferIn = randomUUID();
  const ledgerSpecs: Array<{ key: string; accountId: string; date: IsoDate; amountCents: bigint; description: string; isTransfer?: boolean; pairId?: string }> = [
    { key: "eft1", accountId: B, date: "2024-02-28", amountCents: 500000n, description: "EFT RECEIVED", isTransfer: true },
    { key: "eft2", accountId: B, date: "2024-06-07", amountCents: 580000n, description: "EFT RECEIVED", isTransfer: true },
    { key: "eft3", accountId: B, date: "2025-01-14", amountCents: 575000n, description: "EFT RECEIVED", isTransfer: true },
    { key: "divVxusMar", accountId: B, date: "2026-03-20", amountCents: 3800n, description: "DIVIDEND VXUS" },
    { key: "divVtiMar", accountId: B, date: "2026-03-25", amountCents: 4560n, description: "DIVIDEND VTI" },
    { key: "xferIn", accountId: B, date: "2026-04-13", amountCents: 500000n, description: "TRANSFER IN", isTransfer: true, pairId: transferIn },
    { key: "xferOut", accountId: C, date: "2026-04-13", amountCents: -500000n, description: "TRANSFER TO VANGUARD", isTransfer: true, pairId: transferIn },
    { key: "buyVtiApr", accountId: B, date: "2026-04-14", amountCents: -580000n, description: "BUY VTI" },
    { key: "divVtiJun", accountId: B, date: "2026-06-26", amountCents: 4720n, description: "DIVIDEND VTI" },
    { key: "divAaplAug", accountId: B, date: "2026-08-14", amountCents: 650n, description: "DIVIDEND AAPL" },
    { key: "divVxusSep", accountId: B, date: "2026-09-22", amountCents: 4150n, description: "DIVIDEND VXUS" },
    { key: "divVtiSep", accountId: B, date: "2026-09-29", amountCents: 4910n, description: "DIVIDEND VTI" },
    { key: "interestSep", accountId: B, date: "2026-09-30", amountCents: 410n, description: "INTEREST" },
  ];
  const ledgerRows = await db
    .insert(transaction)
    .values(
      ledgerSpecs.map((s, i) => ({
        accountId: s.accountId,
        externalId: `INV-SEED-${i + 1}`,
        source: s.accountId === C ? ("manual" as const) : ("simplefin" as const),
        date: s.date,
        amountCents: s.amountCents,
        rawDescription: s.description,
        categoryId: null,
        isTransfer: s.isTransfer ?? false,
        transferPairId: s.pairId ?? null,
      })),
    )
    .returning({ id: transaction.id, externalId: transaction.externalId });
  const ledger = (key: string) => ledgerRows[ledgerSpecs.findIndex((s) => s.key === key)]!.id;

  const buy = (key: string, accountId: string, securityId: string, date: IsoDate, quantity: string, priceValue: string, amountCents: bigint, seq: number) => ({
    key,
    accountId,
    securityId,
    date,
    sequence: 0,
    type: "buy" as const,
    quantity,
    price: priceValue,
    amountCents,
    feeCents: 0n,
    source: "csv" as const,
    externalId: `csvid:INV-SEED-${seq}`,
    rawDescription: "YOU BOUGHT",
    ledgerTransactionId: null as string | null,
  });
  const income = (key: string, accountId: string, securityId: string | null, type: "dividend" | "interest", date: IsoDate, amountCents: bigint, seq: number, ledgerKey: string | null) => ({
    key,
    accountId,
    securityId,
    date,
    sequence: 0,
    type,
    quantity: null,
    price: null,
    amountCents,
    feeCents: 0n,
    source: "csv" as const,
    externalId: `csvid:INV-SEED-${seq}`,
    rawDescription: type === "dividend" ? "DIVIDEND RECEIVED" : "INTEREST",
    ledgerTransactionId: ledgerKey ? ledger(ledgerKey) : null,
  });
  const txnSpecs = [
    buy("buyVti1", B, VTI, "2024-03-01", "20", "250", -500000n, 1),
    buy("buyVxus", B, VXUS, "2024-06-10", "100", "58", -580000n, 2),
    buy("buyAapl", B, AAPL, "2025-01-15", "25", "230", -575000n, 3),
    buy("buyVti2", B, VTI, "2026-04-14", "20", "290", -580000n, 4),
    income("divVxusMar", B, VXUS, "dividend", "2026-03-20", 3800n, 5, "divVxusMar"),
    income("divVtiMar", B, VTI, "dividend", "2026-03-25", 4560n, 6, "divVtiMar"),
    income("divVtiJun", B, VTI, "dividend", "2026-06-26", 4720n, 7, "divVtiJun"),
    income("divAaplAug", B, AAPL, "dividend", "2026-08-14", 650n, 8, "divAaplAug"),
    income("divVxusSep", B, VXUS, "dividend", "2026-09-22", 4150n, 9, "divVxusSep"),
    income("divVtiSep", B, VTI, "dividend", "2026-09-28", 4910n, 10, "divVtiSep"),
    income("interestSep", B, null, "interest", "2026-09-30", 410n, 11, "interestSep"),
    income("rDivBndAug", R, BND, "dividend", "2026-08-05", 2240n, 12, null),
    income("rDivBndSep", R, BND, "dividend", "2026-09-04", 2260n, 13, null),
    income("rDivBndOct", R, BND, "dividend", "2026-10-06", 2280n, 14, null),
    income("rDivVtiSep", R, VTI, "dividend", "2026-09-28", 2455n, 15, null),
  ];
  const txnRows = await db
    .insert(investmentTxn)
    .values(txnSpecs.map(({ key: _key, ...row }) => row))
    .returning({ id: investmentTxn.id });
  const txns: Record<string, string> = {};
  txnSpecs.forEach((s, i) => {
    txns[s.key] = txnRows[i]!.id;
  });

  const ledgerIds: Record<string, string> = {};
  for (const s of ledgerSpecs) ledgerIds[s.key] = ledger(s.key);

  return {
    accounts: { brokerage: B, roth: R, checking: C },
    connections: { vanguard, fidelity },
    categories: { dividends: dividends!.id },
    securities: { vti: VTI, vxus: VXUS, bnd: BND, aapl: AAPL, tr2050: TR2050, cash: CASH },
    txns,
    ledger: ledgerIds,
  };
}

/**
 * Step 7: the derived lots cache for the seed's accounts (B's four buys open four lots; R has
 * no trades). Kept apart from `seedInvestmentFixture` so step 6's seed is unchanged; a step
 * that wants the views §7.0 lots calls both. Returns the rebuild plus B's lot ids keyed by
 * the seed's txn keys (`buyVti1`, `buyVxus`, `buyAapl`, `buyVti2`).
 */
export async function seedInvestmentLots(db: Db, seed: InvestmentSeed): Promise<{ rebuilt: RebuildAccountsResult; lotIds: Record<string, string> }> {
  const rebuilt = await db.transaction((tx) => rebuildLotsForAccounts(tx, [seed.accounts.brokerage, seed.accounts.roth]));
  const rows = await db.select({ id: lot.id, openedByTxnId: lot.openedByTxnId }).from(lot).where(eq(lot.accountId, seed.accounts.brokerage));
  const lotIds: Record<string, string> = {};
  for (const [key, txnId] of Object.entries(seed.txns)) {
    const row = rows.find((r) => r.openedByTxnId === txnId);
    if (row) lotIds[key] = row.id;
  }
  return { rebuilt, lotIds };
}
