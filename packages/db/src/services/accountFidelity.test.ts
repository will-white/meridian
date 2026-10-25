import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountFidelity, parseFixed8 } from "@meridian/shared";
import { account, accountReconciliation, investmentTxn, security } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { accountFidelities } from "./accountFidelity.js";
import { replaceHoldingSnapshot } from "./holdings.js";
import { createInvestmentTxn, deleteInvestmentTxn } from "./investmentTxns.js";
import { createSecurity } from "./securities.js";

const TODAY = INV_SEED_TODAY;
const f8 = parseFixed8;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: TODAY });

describe("accountFidelity (pure, imports test 18)", () => {
  it("trades → full history; else snapshots → positions; else balance only", () => {
    expect(accountFidelity({ hasTrades: false, hasSnapshots: false })).toBe("balance_only");
    expect(accountFidelity({ hasTrades: false, hasSnapshots: true })).toBe("positions");
    expect(accountFidelity({ hasTrades: true, hasSnapshots: false })).toBe("full_history");
    expect(accountFidelity({ hasTrades: true, hasSnapshots: true })).toBe("full_history");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("accountFidelities (imports test 18, plan decision 7)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let pos: string;
  let reviewed: string;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    pos = (await t.db.insert(account).values({ name: "Positions Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id }))[0]!.id;
    reviewed = (await createSecurity(t.db, { ticker: "NEWX", name: "Unreviewed Fund", type: "fund", assetClass: "other" }, ctx())).id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("the seed: B's four buys explain its latest statement; R has positions only; checking has no block", async () => {
    const m = await accountFidelities(t.db, [S.accounts.brokerage, S.accounts.roth, S.accounts.checking]);
    expect(m.has(S.accounts.checking)).toBe(false);
    expect(m.get(S.accounts.brokerage)).toMatchObject({
      fidelity: "full_history",
      fidelityNote: null,
      positionsMatch: true,
      lastSnapshotDate: "2026-10-13",
      lastSnapshotSource: "simplefin",
      lastTradeDate: "2026-04-14",
      securityCount: 3,
      needsReviewCount: 0,
      lastReconciliation: null,
      warnings: [],
      positionCheckDate: "2026-10-13",
    });
    expect(m.get(S.accounts.roth)).toMatchObject({
      fidelity: "positions",
      fidelityNote: null,
      positionsMatch: null,
      lastSnapshotDate: "2026-10-09",
      lastSnapshotSource: "csv",
      lastTradeDate: null,
      securityCount: 4,
      needsReviewCount: 0,
      warnings: [],
      positionCheckDate: null,
    });
  });

  it("a brokerage with one csv snapshot (2 securities, 1 needing review) moves between levels as trades come and go", async () => {
    // The seed's securities are reviewed; the new fund was created by the owner (reviewed) and is flagged here by hand.
    await t.db.update(security).set({ needsReview: true }).where(eq(security.id, reviewed));
    await replaceHoldingSnapshot(t.db, {
      accountId: pos,
      date: "2026-10-13",
      source: "csv",
      positions: [
        { securityId: S.securities.vti, quantity: f8("12.75"), price: f8("250"), valueCents: 318750n, reportedCostBasisCents: null },
        { securityId: reviewed, quantity: f8("10"), price: f8("20"), valueCents: 20000n, reportedCostBasisCents: null },
      ],
      today: TODAY,
    });
    const before = (await accountFidelities(t.db, [pos])).get(pos)!;
    expect(before).toMatchObject({ fidelity: "positions", positionsMatch: null, lastSnapshotDate: "2026-10-13", lastSnapshotSource: "csv", lastTradeDate: null, securityCount: 2, needsReviewCount: 1, lastReconciliation: null });

    // A dividend is not a trade.
    const dividend = await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-01", type: "dividend", securityId: S.securities.vti, amountCents: 1234n }, ctx());
    expect((await accountFidelities(t.db, [pos])).get(pos)).toMatchObject({ fidelity: "positions", lastTradeDate: null, positionsMatch: null });

    // One buy that explains the VTI line: full history. The unreviewed fund has no lots, so it mismatches.
    const buy = await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-02", type: "buy", securityId: S.securities.vti, quantity: f8("12.75"), price: f8("240") }, ctx());
    const withBuy = (await accountFidelities(t.db, [pos])).get(pos)!;
    expect(withBuy).toMatchObject({ fidelity: "positions", positionsMatch: false, lastTradeDate: "2026-10-02", positionCheckDate: "2026-10-13" });
    expect(withBuy.fidelityNote).toBe("trade history incomplete: NEWX lots cover 0 of 10 shares");
    expect(withBuy.warnings.map((w) => [w.code, w.securityId, w.lotsQuantity, w.snapshotQuantity, w.date])).toEqual([["position_mismatch", reviewed, 0n, f8("10"), "2026-10-13"]]);

    // Add the fund's buy: the lots explain the whole statement.
    const buy2 = await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-03", type: "buy", securityId: reviewed, quantity: f8("10"), price: f8("19") }, ctx());
    expect((await accountFidelities(t.db, [pos])).get(pos)).toMatchObject({ fidelity: "full_history", fidelityNote: null, positionsMatch: true, lastTradeDate: "2026-10-03", warnings: [] });

    // A quantity off by more than 0.001 shares demotes with a note; a 0.0005 difference does not.
    await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-04", type: "buy", securityId: reviewed, quantity: f8("0.0005"), price: f8("19") }, ctx());
    expect((await accountFidelities(t.db, [pos])).get(pos)).toMatchObject({ fidelity: "full_history", positionsMatch: true });
    const extra = await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-05", type: "buy", securityId: S.securities.vti, quantity: f8("2"), price: f8("240") }, ctx());
    const demoted = (await accountFidelities(t.db, [pos])).get(pos)!;
    expect(demoted).toMatchObject({ fidelity: "positions", positionsMatch: false });
    expect(demoted.fidelityNote).toBe("trade history incomplete: VTI lots cover 14.75 of 12.75 shares");
    await deleteInvestmentTxn(t.db, extra.items[0]!.id, {}, ctx());

    // Deleting every trade returns the account to positions.
    await deleteInvestmentTxn(t.db, buy.items[0]!.id, {}, ctx());
    await deleteInvestmentTxn(t.db, buy2.items[0]!.id, {}, ctx());
    const reviewedBuys = (await t.db.select({ id: investmentTxn.id }).from(investmentTxn).where(and(eq(investmentTxn.accountId, pos), eq(investmentTxn.type, "buy")))).map((r) => r.id);
    for (const id of reviewedBuys) await deleteInvestmentTxn(t.db, id, {}, ctx());
    expect((await accountFidelities(t.db, [pos])).get(pos)).toMatchObject({ fidelity: "positions", lastTradeDate: null, positionsMatch: null });
    expect(dividend.items[0]!.type).toBe("dividend");
  });

  it("the latest reconciliation attempt is reported; the cash line and dollar-only rows are skipped by the check", async () => {
    await t.db.insert(accountReconciliation).values({ accountId: pos, statementDate: "2026-10-09", statementTotalCents: 100n, appValueCents: 150n, appBasis: "snapshot", cashInference: "auto", diffCents: 50n, reconciled: true, accepted: false, rows: [] });
    await t.db.insert(accountReconciliation).values({ accountId: pos, statementDate: "2026-10-13", statementTotalCents: 338750n, appValueCents: 338750n, appBasis: "snapshot", cashInference: "auto", diffCents: 0n, reconciled: true, accepted: true, rows: [], holdingSnapshotDate: "2026-10-13" });
    const rec = (await accountFidelities(t.db, [pos])).get(pos)!.lastReconciliation!;
    expect(rec).toMatchObject({ statementDate: "2026-10-13", diffCents: 0n, reconciled: true, accepted: true });

    // A statement with a cash line and a dollar-only position: neither is compared with the lots.
    await replaceHoldingSnapshot(t.db, {
      accountId: pos,
      date: "2026-10-14",
      source: "manual",
      positions: [
        { securityId: S.securities.vti, quantity: f8("3"), price: f8("250"), valueCents: 75000n, reportedCostBasisCents: null },
        { securityId: S.securities.cash, quantity: f8("500"), price: f8("1"), valueCents: 50000n, reportedCostBasisCents: null },
        { securityId: S.securities.tr2050, quantity: null, price: null, valueCents: 42000n, reportedCostBasisCents: null },
      ],
      today: TODAY,
    });
    await createInvestmentTxn(t.db, { accountId: pos, date: "2026-10-06", type: "buy", securityId: S.securities.vti, quantity: f8("3"), price: f8("240") }, ctx());
    expect((await accountFidelities(t.db, [pos])).get(pos)).toMatchObject({ fidelity: "full_history", positionsMatch: true, lastSnapshotDate: "2026-10-14", lastSnapshotSource: "manual", securityCount: 3, warnings: [] });
  });
});
