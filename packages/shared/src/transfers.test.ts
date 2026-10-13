import { describe, expect, it } from "vitest";
import { pairTransfers, type TransferCandidate } from "./transfers.js";

const CHECKING = "acct-checking";
const CARD = "acct-card";
const SAVINGS = "acct-savings";

function t(id: string, accountId: string, date: string, amountCents: bigint): TransferCandidate {
  return { id, accountId, date, amountCents };
}

describe("pairTransfers", () => {
  it("pairs a card payment: outflow from checking, inflow to the card, two days apart", () => {
    const pairs = pairTransfers([t("out", CHECKING, "2026-09-10", -125000n), t("in", CARD, "2026-09-12", 125000n)]);
    expect(pairs).toEqual([{ outflowId: "out", inflowId: "in" }]);
  });

  it("does not pair legs more than 3 days apart", () => {
    expect(pairTransfers([t("out", CHECKING, "2026-09-10", -5000n), t("in", SAVINGS, "2026-09-14", 5000n)])).toEqual([]);
    expect(pairTransfers([t("out", CHECKING, "2026-09-10", -5000n), t("in", SAVINGS, "2026-09-13", 5000n)])).toHaveLength(1);
  });

  it("never pairs two legs in the same account", () => {
    expect(pairTransfers([t("a", CHECKING, "2026-09-10", -5000n), t("b", CHECKING, "2026-09-10", 5000n)])).toEqual([]);
  });

  it("requires exactly opposite amounts", () => {
    expect(pairTransfers([t("a", CHECKING, "2026-09-10", -5000n), t("b", SAVINGS, "2026-09-10", 5001n)])).toEqual([]);
    expect(pairTransfers([t("a", CHECKING, "2026-09-10", -5000n), t("b", SAVINGS, "2026-09-10", -5000n)])).toEqual([]);
  });

  it("prefers the closest date and uses each leg once", () => {
    const pairs = pairTransfers([
      t("out1", CHECKING, "2026-09-01", -10000n),
      t("out2", CHECKING, "2026-09-05", -10000n),
      t("in1", SAVINGS, "2026-09-02", 10000n),
      t("in2", SAVINGS, "2026-09-05", 10000n),
    ]);
    expect(pairs).toEqual([
      { outflowId: "out1", inflowId: "in1" },
      { outflowId: "out2", inflowId: "in2" },
    ]);
  });

  it("is deterministic on ties (earliest inflow, then id)", () => {
    const pairs = pairTransfers([
      t("out", CHECKING, "2026-09-10", -10000n),
      t("inB", SAVINGS, "2026-09-10", 10000n),
      t("inA", CARD, "2026-09-10", 10000n),
    ]);
    expect(pairs).toEqual([{ outflowId: "out", inflowId: "inA" }]);
  });

  it("leaves a lone leg unpaired (transfer to an account that is not connected)", () => {
    expect(pairTransfers([t("out", CHECKING, "2026-09-10", -30000n)])).toEqual([]);
  });

  it("ignores zero amounts", () => {
    expect(pairTransfers([t("a", CHECKING, "2026-09-10", 0n), t("b", SAVINGS, "2026-09-10", 0n)])).toEqual([]);
  });

  it("handles a realistic month: paycheck split, card payment, savings sweep, and an unrelated equal amount", () => {
    const pairs = pairTransfers([
      t("pay", CHECKING, "2026-09-01", 450000n), // paycheck, no counterpart
      t("card-pay-out", CHECKING, "2026-09-03", -187654n),
      t("card-pay-in", CARD, "2026-09-04", 187654n),
      t("sweep-out", CHECKING, "2026-09-05", -50000n),
      t("sweep-in", SAVINGS, "2026-09-05", 50000n),
      t("grocery", CARD, "2026-09-09", -50000n), // same amount, but an outflow 4 days from the inflow
      t("refund", CARD, "2026-09-20", 50000n), // too far from sweep-out, no pair
    ]);
    expect(pairs).toEqual([
      { outflowId: "card-pay-out", inflowId: "card-pay-in" },
      { outflowId: "sweep-out", inflowId: "sweep-in" },
    ]);
  });
});
