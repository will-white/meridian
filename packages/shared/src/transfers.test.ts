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

describe("pairTransfers (audit a5-ingest-transfers)", () => {
  const BROKERAGE = "acct-brokerage";

  it("a5-ingest-transfers-10: pairs both hops of a same-day checking -> savings -> brokerage move, whatever the ids", () => {
    // The ids are chosen so that taking the first closest inflow pairs checking with the brokerage,
    // which leaves the savings outflow with only its own account's inflow.
    const legs = [
      t("o1", CHECKING, "2026-10-05", -100000n),
      t("i2", BROKERAGE, "2026-10-05", 100000n),
      t("o2", SAVINGS, "2026-10-05", -100000n),
      t("i1", SAVINGS, "2026-10-05", 100000n),
    ];
    expect(pairTransfers(legs)).toEqual([
      { outflowId: "o1", inflowId: "i1" },
      { outflowId: "o2", inflowId: "i2" },
    ]);
    // Every assignment of ids gives the complete pairing.
    const names = ["a", "b", "c", "d"];
    const perms: string[][] = [];
    const permute = (rest: string[], acc: string[]) => {
      if (rest.length === 0) perms.push(acc);
      rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    permute(names, []);
    for (const [a, b, c, d] of perms) {
      const pairs = pairTransfers([
        t(a!, CHECKING, "2026-10-05", -100000n),
        t(b!, SAVINGS, "2026-10-05", 100000n),
        t(c!, SAVINGS, "2026-10-05", -100000n),
        t(d!, BROKERAGE, "2026-10-05", 100000n),
      ]);
      expect(pairs).toHaveLength(2);
      expect(pairs).toContainEqual({ outflowId: a, inflowId: b });
      expect(pairs).toContainEqual({ outflowId: c, inflowId: d });
    }
  });

  it("a5-ingest-transfers-10: a later outflow gets a leg when the earlier one can take another within the window", () => {
    const pairs = pairTransfers([
      t("early", CHECKING, "2026-10-05", -5000n),
      t("near", SAVINGS, "2026-10-05", 5000n),
      t("far", BROKERAGE, "2026-10-08", 5000n),
      t("late", BROKERAGE, "2026-10-05", -5000n),
    ]);
    // "late" can reach only "near" (the other inflow is in its own account), so "early" takes "far".
    expect(pairs).toEqual([
      { outflowId: "early", inflowId: "far" },
      { outflowId: "late", inflowId: "near" },
    ]);
  });

  it("a5-ingest-transfers-04: never pairs two legs the household said are not a transfer", () => {
    const legs = [t("dinner", CARD, "2026-10-10", -8400n), t("deposit", CHECKING, "2026-10-12", 8400n)];
    expect(pairTransfers(legs, { isDismissed: (a, b) => a === "dinner" && b === "deposit" })).toEqual([]);
    // Another leg of the same amount still pairs.
    expect(pairTransfers([...legs, t("move", SAVINGS, "2026-10-12", -8400n)], { isDismissed: (a, b) => a === "dinner" && b === "deposit" })).toEqual([
      { outflowId: "move", inflowId: "deposit" },
    ]);
  });
});
