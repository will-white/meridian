import { describe, expect, it } from "vitest";
import { classifyAmounts, detectRecurring, detectSeries, MIN_CHARGES_DISPERSED, type ChargeLike } from "./recurringDetect.js";

/**
 * Audit batch b5 (recurring detection, subscriptions, alerts and cash flow): the engine side of
 * findings b5-recurring-cashflow-02 (a price change is the expected amount at once),
 * b5-recurring-cashflow-07 (seasonal utility bills are detected) and b5-recurring-cashflow-11
 * (the first on-cycle charge's account is carried for the new-series history guard).
 * Every number is worked by hand in the comments.
 */

const TODAY = "2026-10-13";
const A = "acct-a";
const B = "acct-b";

function charge(id: string, date: string, amountCents: bigint, accountId = A): ChargeLike {
  return { id, accountId, date, amountCents };
}

function ids(charges: ChargeLike[]): string[] {
  return charges.map((c) => c.id);
}

function only<T>(xs: T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0]!;
}

describe("b5-02: a fixed series that changes price is fixed at the new price from its first new charge", () => {
  it("one, two and three charges at 17.99 after five at 15.49 are all fixed at 17.99 ± 1.00", () => {
    // One: last3 {1549, 1549, 1799} spread 250 > 100, but the three before the newest charge
    // {1549, 1549, 1549} were fixed, so the newest charge is a new level: fixed 1799, tolerance max(100, 17) = 100.
    expect(classifyAmounts([1549n, 1549n, 1549n, 1549n, 1549n, 1799n])).toEqual({ mode: "fixed", expectedAbs: 1799n, toleranceCents: 100n, dispersed: false });
    // Two: the newest run {1799, 1799} agrees (spread 0 ≤ 100) and the three before it {1549 × 3} were fixed.
    expect(classifyAmounts([1549n, 1549n, 1549n, 1549n, 1549n, 1799n, 1799n])).toEqual({ mode: "fixed", expectedAbs: 1799n, toleranceCents: 100n, dispersed: false });
    // Three: last3 {1799 × 3} is fixed on its own (unchanged rule).
    expect(classifyAmounts([1549n, 1549n, 1549n, 1549n, 1549n, 1799n, 1799n, 1799n])).toEqual({ mode: "fixed", expectedAbs: 1799n, toleranceCents: 100n, dispersed: false });
    // A cut is a new level too (a cheaper plan): fixed 999.
    expect(classifyAmounts([1549n, 1549n, 1549n, 999n])).toMatchObject({ mode: "fixed", expectedAbs: 999n, toleranceCents: 100n });
  });

  it("a change from a series that was not fixed, or a run that does not agree, stays variable", () => {
    // Fewer than three charges before the change: nothing shows the series was fixed.
    expect(classifyAmounts([1549n, 1549n, 1799n])).toMatchObject({ mode: "variable", expectedAbs: 1549n, toleranceCents: 250n });
    // The three before the newest charge {1549, 1549, 1799} were not fixed: back to the old price after one month.
    // Last 6 {1549, 1549, 1549, 1549, 1799, 1549} → upper median 1549, band max(0, 250) = 250.
    expect(classifyAmounts([1549n, 1549n, 1549n, 1549n, 1549n, 1799n, 1549n])).toMatchObject({ mode: "variable", expectedAbs: 1549n, toleranceCents: 250n });
    // Two new charges that disagree with each other (1799, 1999): variable.
    expect(classifyAmounts([1549n, 1549n, 1549n, 1799n, 1999n]).mode).toBe("variable");
    // TC3's utility is untouched: variable 11040 ± 3425.
    expect(classifyAmounts([8420n, 7615n, 9130n, 12275n, 13850n, 11040n, 8890n])).toEqual({ mode: "variable", expectedAbs: 11040n, toleranceCents: 3425n, dispersed: false });
  });

  it("detection proposes the new price, and an off-cycle one-off after the series does not set the amount", () => {
    const dates = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"];
    const increased = [...dates.map((d) => charge(`nf-${d}`, d, -1549n)), charge("nf-10-05", "2026-10-05", -1799n)];
    expect(detectSeries(increased, TODAY)).toMatchObject({ amountMode: "fixed", expectedCents: -1799n, toleranceCents: 100n, lastChargeCents: -1799n, chargeCount: 7 });

    // Seven on-cycle charges of 15.49 and a 29.99 extra in October (same period as 10-05): the amounts
    // of the series are the on-cycle charges, which are what is linked: fixed 1549 ± 100 (before: variable 1549 ± 1450).
    const series = [...dates, "2026-10-05"].map((d) => charge(`nf-${d}`, d, -1549n));
    const withOneOff = [...series, charge("nf-oneoff", "2026-10-10", -2999n)];
    const d = only(detectRecurring(withOneOff, TODAY));
    expect(d.onCycleIds).toEqual(ids(series));
    expect(d).toMatchObject({ amountMode: "fixed", expectedCents: -1549n, toleranceCents: 100n, lastChargeCents: -1549n });
  });
});

describe("b5-07: a seasonal utility bill (the spec's variable bill) is detected", () => {
  // Gas, billed on the 12th, Oct 2025 – Oct 2026: winter peak 150.00, summer trough 30.00.
  const amounts = [6000n, 10000n, 14500n, 15000n, 14000n, 11000n, 7000n, 4500n, 3200n, 3000n, 3100n, 3500n, 6200n];
  const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
  const gas = months.map((m, i) => charge(`gas-${m}`, `${m}-12`, -amounts[i]!));

  it("the amounts are dispersed: upper median 62.00, 30.00 is below half and 150.00 above twice", () => {
    expect(classifyAmounts(amounts)).toMatchObject({ mode: "variable", dispersed: true });
    // Not as a plain series: a dispersed variable group is first handed to the fallbacks.
    expect(detectSeries(gas, TODAY)).toBeUndefined();
  });

  it("every charge is on-cycle on one cadence and the fallbacks find nothing, so it is one variable monthly bill", () => {
    const d = only(detectRecurring(gas, TODAY));
    // 12 hits of 12 gaps → 10000; last 6 {4500, 3200, 3000, 3100, 3500, 6200} → upper median 3500, band max(500, 2700) = 2700.
    expect(d).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 12 },
      scoreBp: 10000,
      amountMode: "variable",
      expectedCents: -3500n,
      toleranceCents: 2700n,
      chargeCount: 13,
      firstChargeDate: "2025-10-12",
      lastChargeDate: "2026-10-12",
      nextDueDate: "2026-11-12",
    });
    expect(d.onCycleIds).toEqual(ids(gas));
  });

  it("an extra charge in a period, a missed cadence or too few charges keep a dispersed group rejected", () => {
    // A second charge in March (an extra): the dispersion may be two series, so nothing is proposed.
    expect(detectRecurring([...gas, charge("gas-extra", "2026-03-20", -2000n)], TODAY)).toEqual([]);
    // Five dispersed charges (Oct – Feb): below MIN_CHARGES_DISPERSED (6).
    expect(MIN_CHARGES_DISPERSED).toBe(6);
    expect(classifyAmounts(amounts.slice(0, 5)).dispersed).toBe(true);
    expect(detectRecurring(gas.slice(0, 5), "2026-02-20")).toEqual([]);
    // Six (Oct – Mar) are enough: upper median of {6000, 10000, 14500, 15000, 14000, 11000} = 14000, 2 · 6000 < 14000.
    const six = gas.slice(0, 6);
    expect(classifyAmounts(amounts.slice(0, 6)).dispersed).toBe(true);
    expect(only(detectRecurring(six, "2026-03-20"))).toMatchObject({ amountMode: "variable", expectedCents: -14000n, chargeCount: 6 });
  });

  it("two amount clusters that are each a series still win over one dispersed series (Apple: iCloud on the 2nd, Music on the 17th)", () => {
    const icloud = ["2026-06-02", "2026-07-02", "2026-08-02", "2026-09-02", "2026-10-02"].map((d) => charge(`ic-${d}`, d, -299n));
    const music = ["2026-06-17", "2026-07-17", "2026-08-17", "2026-09-17"].map((d) => charge(`mu-${d}`, d, -1099n));
    // Twice-monthly on (2, 17) puts every charge on-cycle, but clustering yields two accepted series.
    const detections = detectRecurring([...icloud, ...music], TODAY);
    expect(detections.map((d) => [d.schedule.cadence, d.expectedCents, d.chargeCount])).toEqual([
      ["monthly", -299n, 5],
      ["monthly", -1099n, 4],
    ]);
  });
});

describe("b5-11: the detection carries the account of its first on-cycle charge", () => {
  it("a subscription that moved cards: firstAccountId is the old card, accountId the new one", () => {
    const onA = ["2026-07-15", "2026-08-15"].map((d) => charge(`nf-${d}`, d, -1549n, A));
    const onB = ["2026-09-15", "2026-10-15"].map((d) => charge(`nf-${d}`, d, -1549n, B));
    const d = only(detectRecurring([...onA, ...onB], "2026-10-20"));
    expect(d).toMatchObject({ firstAccountId: A, accountId: B, firstChargeDate: "2026-07-15", chargeCount: 4 });
  });
});
