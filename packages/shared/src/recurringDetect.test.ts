import { describe, expect, it } from "vitest";
import type { Cadence } from "./enums.js";
import {
  classifyAmounts,
  clusterByAmount,
  compareScores,
  detectRecurring,
  detectSeries,
  detectTrialConversion,
  fitSchedule,
  isNewSeries,
  scoreCadence,
  upperMedian,
  type CadenceScore,
  type ChargeLike,
} from "./recurringDetect.js";
import { isMissed, monthlyEquivalentCents, occurrencesInRange, yearlyCents } from "./schedule.js";

const TODAY = "2026-10-13";
const A = "acct-a";
const B = "acct-b";

function charge(id: string, date: string, amountCents: bigint, accountId = A): ChargeLike {
  return { id, accountId, date, amountCents };
}

/** One charge per date at a single amount; ids are `${prefix}-${date}`. */
function series(prefix: string, amountCents: bigint, dates: string[], accountId = A): ChargeLike[] {
  return dates.map((date) => charge(`${prefix}-${date}`, date, amountCents, accountId));
}

function ids(charges: ChargeLike[]): string[] {
  return charges.map((c) => c.id);
}

/** fitSchedule + scoreCadence for one cadence over charges given in date order. */
function scoreFor(charges: ChargeLike[], cadence: Cadence): CadenceScore | undefined {
  const dates = charges.map((c) => c.date);
  const schedule = fitSchedule(dates, cadence);
  return schedule ? scoreCadence(dates, ids(charges), schedule) : undefined;
}

function scoreBp(charges: ChargeLike[], cadence: Cadence): number | undefined {
  return scoreFor(charges, cadence)?.scoreBp;
}

function only<T>(xs: T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0]!;
}

describe("primitives", () => {
  it("upperMedian takes sorted[floor(n/2)] for numbers and bigints", () => {
    expect(upperMedian([19, 2, 7])).toBe(7);
    expect(upperMedian([3, 3, 3, 3, 5, 5, 5, 5])).toBe(5);
    expect(upperMedian([1549n, 1549n, 1549n, 1549n, 1549n, 1799n])).toBe(1549n);
    expect(upperMedian([13850n, 11040n, 8890n])).toBe(11040n);
    expect(() => upperMedian([])).toThrow();
  });

  it("compareScores: score, then normalised residual, then the longer period", () => {
    const base = (cadence: Cadence, scoreBp: number, residualSum: number, n: number): CadenceScore => ({
      cadence,
      schedule: { cadence },
      n,
      hits: n - 1,
      skips: 0,
      extras: 0,
      misses: 0,
      onCycle: n,
      scoreBp,
      residualSum,
      onCycleIds: [],
      firstOnCycle: true,
    });
    expect(compareScores(base("biweekly", 10000, 0, 11), base("twice_monthly", 8000, 0, 11))).toBeLessThan(0);
    // 2/(3·10) > 0/(2·10): the biweekly fit is tighter.
    expect(compareScores(base("twice_monthly", 10000, 2, 11), base("biweekly", 10000, 0, 11))).toBeGreaterThan(0);
    // Exact tie → the longer period plans fewer occurrences.
    expect(compareScores(base("monthly", 10000, 0, 5), base("biweekly", 10000, 0, 5))).toBeLessThan(0);
  });

  it("clusterByAmount bands 15% (at least $1) above the cluster minimum", () => {
    const clusters = clusterByAmount([
      charge("c", "2026-01-03", -1099n),
      charge("a", "2026-01-01", -299n),
      charge("d", "2026-01-04", -499n),
      charge("b", "2026-01-02", -399n),
      charge("e", "2026-01-05", -1263n),
      charge("f", "2026-01-06", -1264n),
    ]);
    expect(clusters.map(ids)).toEqual([["a", "b"], ["d"], ["c", "e"], ["f"]]);
  });
});

describe("TC1 monthly fixed subscription (Netflix)", () => {
  const netflix = series("nf", -1549n, ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"]);

  it("detects a monthly item on the 5th with full confidence", () => {
    const d = only(detectRecurring(netflix, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 5 });
    expect(d.scoreBp).toBe(10000);
    expect(d.confidence).toBe(100);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-1549n);
    expect(d.toleranceCents).toBe(100n);
    expect(d.onCycleIds).toEqual(ids(netflix));
    expect(d.chargeCount).toBe(6);
    expect(d.firstChargeDate).toBe("2026-04-05");
    expect(d.lastChargeDate).toBe("2026-09-05");
    expect(d.lastChargeCents).toBe(-1549n);
    expect(d.lastTransactionId).toBe("nf-2026-09-05");
    expect(d.accountId).toBe(A);
    expect(d.nextDueDate).toBe("2026-10-05");
    expect(yearlyCents(d.expectedCents, d.schedule.cadence)).toBe(-18588n);
    expect(monthlyEquivalentCents(d.expectedCents, d.schedule.cadence)).toBe(-1549n);
  });

  it("walk: 5 hits, nothing else; other cadences score 2000 / 4000 / 0", () => {
    const monthly = scoreFor(netflix, "monthly")!;
    expect(monthly).toMatchObject({ hits: 5, skips: 0, extras: 0, misses: 0, onCycle: 6, residualSum: 0, firstOnCycle: true });
    expect(scoreBp(netflix, "biweekly")).toBe(2000);
    expect(scoreBp(netflix, "bimonthly")).toBe(4000);
    expect(scoreBp(netflix, "weekly")).toBe(0);
    expect(scoreBp(netflix, "quarterly")).toBe(0);
    expect(scoreBp(netflix, "semiannual")).toBe(0);
    expect(scoreBp(netflix, "yearly")).toBe(0);
  });
});

describe("TC2 twice-monthly payroll on the 1st and 15th with weekend shifts", () => {
  const payroll = series("pay", 245000n, [
    "2026-05-01", "2026-05-15", "2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-07-31", "2026-08-14", "2026-09-01", "2026-09-15", "2026-10-01",
  ]);

  it("fits anchors (1, 15) and scores 10000 with residual sum 2", () => {
    expect(fitSchedule(payroll.map((c) => c.date), "twice_monthly")).toEqual({ cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 });
    const score = scoreFor(payroll, "twice_monthly")!;
    expect(score).toMatchObject({ hits: 10, skips: 0, extras: 0, misses: 0, scoreBp: 10000, residualSum: 2 });
    expect(scoreFor(payroll, "biweekly")).toMatchObject({ hits: 8, misses: 2, scoreBp: 8000 });
  });

  it("twice_monthly beats biweekly; fixed +245000 ± 2450, next due Oct 15", () => {
    const d = only(detectRecurring(payroll, TODAY));
    expect(d.schedule).toEqual({ cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(245000n);
    expect(d.toleranceCents).toBe(2450n);
    expect(d.onCycleIds).toEqual(ids(payroll));
    expect(d.chargeCount).toBe(11);
    expect(d.nextDueDate).toBe("2026-10-15");
    expect(yearlyCents(d.expectedCents, d.schedule.cadence)).toBe(5880000n);
    expect(monthlyEquivalentCents(d.expectedCents, d.schedule.cadence)).toBe(490000n);
  });
});

describe("TC3 monthly utility, variable amount, posts on weekdays only", () => {
  const utility = [
    charge("u1", "2026-04-06", -8420n),
    charge("u2", "2026-05-05", -7615n),
    charge("u3", "2026-06-05", -9130n),
    charge("u4", "2026-07-06", -12275n),
    charge("u5", "2026-08-05", -13850n),
    charge("u6", "2026-09-07", -11040n),
    charge("u7", "2026-10-05", -8890n),
  ];

  it("classifies the amounts as variable with the upper median of the last six", () => {
    expect(classifyAmounts(utility.map((c) => -c.amountCents))).toEqual({ mode: "variable", expectedAbs: 11040n, toleranceCents: 3425n, dispersed: false });
  });

  it("anchors on the 5th, 6 hits with residual sum 3, next due Nov 5", () => {
    expect(scoreFor(utility, "monthly")).toMatchObject({ hits: 6, misses: 0, scoreBp: 10000, residualSum: 3, firstOnCycle: true });
    const d = only(detectRecurring(utility, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 5 });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("variable");
    expect(d.expectedCents).toBe(-11040n);
    expect(d.toleranceCents).toBe(3425n);
    expect(d.onCycleIds).toEqual(ids(utility));
    expect(d.chargeCount).toBe(7);
    expect(d.nextDueDate).toBe("2026-11-05");
    expect(yearlyCents(d.expectedCents, d.schedule.cadence)).toBe(-132480n);
    expect(monthlyEquivalentCents(d.expectedCents, d.schedule.cadence)).toBe(-11040n);
  });
});

describe("TC4 quarterly fixed charge", () => {
  const quarterly = series("q", -4500n, ["2025-11-10", "2026-02-10", "2026-05-11", "2026-08-10"]);

  it("fits anchorMonth 11 / anchorDay 10 and only quarterly is accepted", () => {
    expect(scoreFor(quarterly, "quarterly")).toMatchObject({
      schedule: { cadence: "quarterly", anchorDay: 10, anchorMonth: 11 },
      hits: 3,
      scoreBp: 10000,
      residualSum: 1,
    });
    expect(scoreBp(quarterly, "monthly")).toBe(0);
    expect(scoreBp(quarterly, "bimonthly")).toBe(3333);
    expect(scoreBp(quarterly, "semiannual")).toBe(0);
    expect(scoreBp(quarterly, "yearly")).toBe(0);
  });

  it("detects the series, next due Nov 10, and never drifts", () => {
    const d = only(detectRecurring(quarterly, TODAY));
    expect(d.schedule).toEqual({ cadence: "quarterly", anchorDay: 10, anchorMonth: 11 });
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-4500n);
    expect(d.toleranceCents).toBe(100n);
    expect(d.onCycleIds).toEqual(ids(quarterly));
    expect(d.nextDueDate).toBe("2026-11-10");
    expect(occurrencesInRange(d.schedule, "2026-10-01", "2027-12-31")).toEqual(["2026-11-10", "2027-02-10", "2027-05-10", "2027-08-10", "2027-11-10"]);
    expect(yearlyCents(d.expectedCents, d.schedule.cadence)).toBe(-18000n);
    expect(monthlyEquivalentCents(d.expectedCents, d.schedule.cadence)).toBe(-1500n);
    expect(isNewSeries(d.firstChargeDate, "2020-01-01", TODAY)).toBe(false);
  });
});

describe("TC5 yearly charge, never flagged as new", () => {
  const yearly = series("y", -11988n, ["2024-03-14", "2025-03-14", "2026-03-16"]);

  it("fits March 14, scores 10000; semiannual scores 5000 and is rejected", () => {
    expect(scoreFor(yearly, "yearly")).toMatchObject({ schedule: { cadence: "yearly", anchorDay: 14, anchorMonth: 3 }, hits: 2, scoreBp: 10000, residualSum: 2 });
    expect(scoreFor(yearly, "semiannual")).toMatchObject({ hits: 0, skips: 2, scoreBp: 5000 });
    const d = only(detectRecurring(yearly, TODAY));
    expect(d.schedule).toEqual({ cadence: "yearly", anchorDay: 14, anchorMonth: 3 });
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-11988n);
    expect(d.toleranceCents).toBe(119n);
    expect(d.onCycleIds).toEqual(ids(yearly));
    expect(d.nextDueDate).toBe("2027-03-14");
    expect(yearlyCents(d.expectedCents, "yearly")).toBe(-11988n);
    expect(monthlyEquivalentCents(d.expectedCents, "yearly")).toBe(-999n);
    expect(isNewSeries(d.firstChargeDate, "2023-06-01", TODAY)).toBe(false);
  });
});

describe("TC6 false positive to reject: three coffees", () => {
  it("(a) three prices: variable with n = 3 is rejected before any cadence is scored", () => {
    const coffees = [charge("c1", "2026-09-02", -475n), charge("c2", "2026-09-19", -610n), charge("c3", "2026-10-07", -380n)];
    expect(classifyAmounts([475n, 610n, 380n]).mode).toBe("variable");
    expect(detectSeries(coffees, TODAY)).toBeUndefined();
    expect(detectRecurring(coffees, TODAY)).toEqual([]);
  });

  it("(b) same price: no cadence is accepted", () => {
    const coffees = series("c", -475n, ["2026-09-02", "2026-09-19", "2026-10-07"]);
    expect(scoreBp(coffees, "weekly")).toBe(0);
    expect(scoreBp(coffees, "biweekly")).toBe(0);
    expect(scoreFor(coffees, "monthly")).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 7 },
      firstOnCycle: false,
      extras: 1,
      hits: 1,
      onCycle: 1,
      scoreBp: 5000,
    });
    expect(fitSchedule(coffees.map((c) => c.date), "twice_monthly")).toBeUndefined();
    expect(scoreBp(coffees, "bimonthly")).toBe(0);
    expect(scoreBp(coffees, "quarterly")).toBe(0);
    expect(scoreBp(coffees, "semiannual")).toBe(0);
    expect(scoreBp(coffees, "yearly")).toBe(0);
    expect(detectSeries(coffees, TODAY)).toBeUndefined();
    expect(detectRecurring(coffees, TODAY)).toEqual([]);
  });
});

describe("TC9 biweekly payroll every other Friday beats twice-monthly", () => {
  const payroll = series("pay", 198765n, ["2026-07-10", "2026-07-24", "2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18", "2026-10-02"]);

  it("scores biweekly 10000, weekly 5000, twice_monthly 8333 on anchors (7, 21), monthly 1666", () => {
    expect(scoreFor(payroll, "biweekly")).toMatchObject({ hits: 6, scoreBp: 10000, residualSum: 0 });
    expect(scoreFor(payroll, "weekly")).toMatchObject({ hits: 0, skips: 6, scoreBp: 5000 });
    expect(scoreFor(payroll, "twice_monthly")).toMatchObject({
      schedule: { cadence: "twice_monthly", anchorDay: 7, anchorDay2: 21 },
      firstOnCycle: true,
      hits: 5,
      misses: 1,
      scoreBp: 8333,
    });
    expect(scoreBp(payroll, "monthly")).toBe(1666);
  });

  it("detects a biweekly item anchored on the last charge, next due Oct 16", () => {
    const d = only(detectRecurring(payroll, TODAY));
    expect(d.schedule).toEqual({ cadence: "biweekly", anchorDate: "2026-10-02" });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(198765n);
    expect(d.toleranceCents).toBe(1987n);
    expect(d.onCycleIds).toEqual(ids(payroll));
    expect(d.chargeCount).toBe(7);
    expect(d.nextDueDate).toBe("2026-10-16");
    expect(yearlyCents(d.expectedCents, "biweekly")).toBe(5167890n);
    expect(monthlyEquivalentCents(d.expectedCents, "biweekly")).toBe(430657n);
  });
});

describe("TC11 refund mixed into the series", () => {
  it("the refund is its own (payee, +) group and never touches the outflow series", () => {
    const netflix = series("nf", -1549n, ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"]);
    const refund = [charge("refund", "2026-07-20", 1549n)];
    const d = only(detectRecurring(netflix, TODAY));
    expect(d.scoreBp).toBe(10000);
    expect(d.onCycleIds).toEqual(ids(netflix));
    expect(d.chargeCount).toBe(6);
    expect(detectRecurring(refund, TODAY)).toEqual([]);
  });
});

describe("TC12 same payee on two accounts: two distinct subscriptions", () => {
  const spotifyA = series("sa", -1199n, ["2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03"], A);
  const spotifyB = series("sb", -1199n, ["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"], B);
  const group = [...spotifyA, ...spotifyB].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  it("the whole group fails every cadence", () => {
    expect(scoreFor(group, "monthly")).toMatchObject({ schedule: { cadence: "monthly", anchorDay: 5 }, hits: 3, extras: 4, scoreBp: 4285 });
    expect(fitSchedule(group.map((c) => c.date), "twice_monthly")).toBeUndefined();
    expect(scoreBp(group, "weekly")).toBe(0);
    expect(scoreBp(group, "biweekly")).toBe(714);
    expect(scoreBp(group, "bimonthly")).toBe(1428);
    expect(detectSeries(group, TODAY)).toBeUndefined();
  });

  it("the per-account split yields two monthly items", () => {
    const [a, b] = detectRecurring(group, TODAY);
    expect(detectRecurring(group, TODAY)).toHaveLength(2);
    expect(a).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 3 },
      scoreBp: 10000,
      amountMode: "fixed",
      expectedCents: -1199n,
      toleranceCents: 100n,
      accountId: A,
      chargeCount: 4,
      onCycleIds: ids(spotifyA),
      nextDueDate: "2026-10-03",
    });
    expect(b).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 5 },
      scoreBp: 10000,
      expectedCents: -1199n,
      accountId: B,
      chargeCount: 4,
      onCycleIds: ids(spotifyB),
      nextDueDate: "2026-10-05",
    });
  });
});

describe("TC13 amount clusters under one payee (Apple)", () => {
  const icloud = series("ic", -299n, ["2026-06-02", "2026-07-02", "2026-08-02", "2026-09-02", "2026-10-02"]);
  const music = series("mu", -1099n, ["2026-06-17", "2026-07-17", "2026-08-17", "2026-09-17"]);
  const oneOff = charge("app", "2026-08-09", -499n);
  const apple = [...icloud, ...music, oneOff].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  it("the whole group is variable and dispersed, so it is rejected without scoring", () => {
    const amounts = classifyAmounts(apple.map((c) => -c.amountCents));
    expect(amounts.mode).toBe("variable");
    expect(amounts.dispersed).toBe(true);
    expect(detectSeries(apple, TODAY)).toBeUndefined();
  });

  it("clusters by amount into 299 × 5, 499 × 1 and 1099 × 4", () => {
    expect(clusterByAmount(apple).map(ids)).toEqual([ids(icloud), ["app"], ids(music)]);
  });

  it("detects iCloud and Music as two monthly items; the one-off stays unlinked", () => {
    const detections = detectRecurring(apple, TODAY);
    expect(detections).toHaveLength(2);
    const [first, second] = detections;
    expect(first).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 2 },
      scoreBp: 10000,
      amountMode: "fixed",
      expectedCents: -299n,
      toleranceCents: 100n,
      onCycleIds: ids(icloud),
      chargeCount: 5,
      nextDueDate: "2026-11-02",
    });
    expect(second).toMatchObject({
      schedule: { cadence: "monthly", anchorDay: 17 },
      scoreBp: 10000,
      amountMode: "fixed",
      expectedCents: -1099n,
      toleranceCents: 100n,
      onCycleIds: ids(music),
      chargeCount: 4,
      nextDueDate: "2026-10-17",
    });
    expect(detections.flatMap((d) => d.onCycleIds)).not.toContain("app");
    expect(yearlyCents(-299n, "monthly")).toBe(-3588n);
    expect(yearlyCents(-1099n, "monthly")).toBe(-13188n);
    expect(monthlyEquivalentCents(-299n, "monthly")).toBe(-299n);
    expect(monthlyEquivalentCents(-1099n, "monthly")).toBe(-1099n);
  });
});

describe("TC14 free trial converting", () => {
  const small = charge("hulu-small", "2026-09-20", -100n);
  const full = charge("hulu-full", "2026-10-11", -1799n);

  it("a $1 charge followed within 45 days by a $17.99 charge in the last 14 days is a conversion", () => {
    expect(detectTrialConversion([small, full], TODAY)).toEqual({ smallTransactionIds: ["hulu-small"], firstFull: full });
    expect(detectTrialConversion([full, small], TODAY)).toEqual({ smallTransactionIds: ["hulu-small"], firstFull: full });
    expect(detectRecurring([small, full], TODAY)).toEqual([]);
  });

  it("variants that do not fire", () => {
    const earlyFull = charge("hulu-early", "2026-09-01", -1799n);
    expect(detectTrialConversion([earlyFull, small, full], TODAY)).toBeUndefined();
    expect(detectTrialConversion([charge("hulu-small", "2026-08-01", -100n), full], TODAY)).toBeUndefined();
    expect(detectTrialConversion([small, full], "2026-11-01")).toBeUndefined();
    expect(detectTrialConversion([small, charge("hulu-cheap", "2026-10-11", -150n)], TODAY)).toBeUndefined();
    expect(detectTrialConversion([full], TODAY)).toBeUndefined();
    expect(detectTrialConversion([charge("hulu-mid", "2026-09-20", -300n), full], TODAY)).toBeUndefined();
  });

  it("a $0 authorization counts as the small charge; a later full charge is the first one ≥ $5", () => {
    const zero = charge("hulu-zero", "2026-09-18", 0n);
    expect(detectTrialConversion([zero, full], TODAY)).toEqual({ smallTransactionIds: ["hulu-zero"], firstFull: full });
    expect(detectTrialConversion([small, zero, full], TODAY)).toEqual({ smallTransactionIds: ["hulu-zero", "hulu-small"], firstFull: full });
  });
});

describe("TC15 bill on the 31st with end-of-month clamping and a late post", () => {
  const bill = series("eom", -10000n, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-06-01", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"]);

  it("anchors on 31, counts the Jun 1 post as May's charge, next due Oct 31", () => {
    expect(fitSchedule(bill.map((c) => c.date), "monthly")).toEqual({ cadence: "monthly", anchorDay: 31 });
    expect(scoreFor(bill, "monthly")).toMatchObject({ hits: 8, misses: 0, extras: 0, scoreBp: 10000, residualSum: 1 });
    const d = only(detectRecurring(bill, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 31 });
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-10000n);
    expect(d.toleranceCents).toBe(100n);
    expect(d.onCycleIds).toEqual(ids(bill));
    expect(d.nextDueDate).toBe("2026-10-31");
    expect(occurrencesInRange(d.schedule, "2026-11-01", "2027-02-28")).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
    expect(yearlyCents(d.expectedCents, "monthly")).toBe(-120000n);
    expect(monthlyEquivalentCents(d.expectedCents, "monthly")).toBe(-10000n);
  });
});

describe("TC20 an extra (duplicate) charge does not advance the cursor", () => {
  const spotify = series("sp", -1099n, ["2026-04-12", "2026-05-12", "2026-06-12", "2026-07-12", "2026-07-20", "2026-08-12", "2026-09-12", "2026-10-12"]);
  const onCycle = spotify.filter((c) => c.date !== "2026-07-20");

  it("scores 8571 with one extra; the duplicate is not linked", () => {
    expect(fitSchedule(spotify.map((c) => c.date), "monthly")).toEqual({ cadence: "monthly", anchorDay: 12 });
    expect(scoreFor(spotify, "monthly")).toMatchObject({ hits: 6, extras: 1, misses: 0, scoreBp: 8571, onCycleIds: ids(onCycle) });
    const d = only(detectRecurring(spotify, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 12 });
    expect(d.scoreBp).toBe(8571);
    expect(d.confidence).toBe(85);
    expect(d.onCycleIds).toEqual(ids(onCycle));
    expect(d.chargeCount).toBe(7);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-1099n);
    expect(d.toleranceCents).toBe(100n);
    expect(d.lastChargeDate).toBe("2026-10-12");
    expect(d.nextDueDate).toBe("2026-11-12");
    expect(yearlyCents(d.expectedCents, "monthly")).toBe(-13188n);
    expect(monthlyEquivalentCents(d.expectedCents, "monthly")).toBe(-1099n);
  });
});

describe("TC21 bimonthly bill (added cadence) vs monthly and quarterly", () => {
  const water = [charge("w1", "2026-02-12", -6200n), charge("w2", "2026-04-13", -5900n), charge("w3", "2026-06-12", -6450n), charge("w4", "2026-08-12", -6100n)];

  it("monthly scores 5000 (all skips), quarterly 3333, bimonthly 10000", () => {
    expect(scoreFor(water, "monthly")).toMatchObject({ schedule: { cadence: "monthly", anchorDay: 12 }, hits: 0, skips: 3, scoreBp: 5000 });
    expect(scoreFor(water, "quarterly")).toMatchObject({
      schedule: { cadence: "quarterly", anchorDay: 12, anchorMonth: 2 },
      hits: 1,
      extras: 1,
      misses: 1,
      scoreBp: 3333,
    });
    expect(scoreFor(water, "bimonthly")).toMatchObject({ schedule: { cadence: "bimonthly", anchorDay: 12, anchorMonth: 2 }, hits: 3, scoreBp: 10000, residualSum: 1 });
  });

  it("detects a variable bimonthly item, expected −6200 ± 300, next due Oct 12", () => {
    const d = only(detectRecurring(water, TODAY));
    expect(d.schedule).toEqual({ cadence: "bimonthly", anchorDay: 12, anchorMonth: 2 });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("variable");
    expect(d.expectedCents).toBe(-6200n);
    expect(d.toleranceCents).toBe(300n);
    expect(d.onCycleIds).toEqual(ids(water));
    expect(d.chargeCount).toBe(4);
    expect(d.nextDueDate).toBe("2026-10-12");
    expect(isMissed(d.nextDueDate, TODAY, "bimonthly")).toBe(false);
    expect(yearlyCents(d.expectedCents, "bimonthly")).toBe(-37200n);
    expect(monthlyEquivalentCents(d.expectedCents, "bimonthly")).toBe(-3100n);
  });
});

describe("TC22 twice-monthly on the 15th and last day across February", () => {
  const payroll = series("pay", 180000n, [
    "2026-01-15", "2026-01-30", "2026-02-13", "2026-02-27", "2026-03-16", "2026-03-31", "2026-04-15", "2026-04-30", "2026-05-15", "2026-05-29",
    "2026-06-15", "2026-06-30", "2026-07-15", "2026-07-31", "2026-08-14", "2026-08-31", "2026-09-15", "2026-09-30",
  ]);

  it("fits anchors (15, 31), 17 hits with residual sum 8; biweekly scores 8235", () => {
    expect(fitSchedule(payroll.map((c) => c.date), "twice_monthly")).toEqual({ cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 });
    expect(scoreFor(payroll, "twice_monthly")).toMatchObject({ hits: 17, misses: 0, extras: 0, scoreBp: 10000, residualSum: 8 });
    expect(scoreBp(payroll, "biweekly")).toBe(8235);
  });

  it("detects the payroll, next due Oct 15, two October occurrences", () => {
    const d = only(detectRecurring(payroll, TODAY));
    expect(d.schedule).toEqual({ cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(180000n);
    expect(d.toleranceCents).toBe(1800n);
    expect(d.onCycleIds).toEqual(ids(payroll));
    expect(d.chargeCount).toBe(18);
    expect(d.nextDueDate).toBe("2026-10-15");
    expect(occurrencesInRange(d.schedule, "2026-10-01", "2026-10-31")).toEqual(["2026-10-15", "2026-10-31"]);
  });
});

describe("TC23 quarterly variable bill posted two days early", () => {
  const bill = [
    charge("q1", "2025-10-14", -8520n),
    charge("q2", "2026-01-14", -7980n),
    charge("q3", "2026-04-14", -9140n),
    charge("q4", "2026-07-14", -8650n),
    charge("q5", "2026-10-12", -8390n),
  ];

  it("only quarterly is accepted: 10000 vs bimonthly 2500, semiannual 2500, monthly 0", () => {
    expect(scoreFor(bill, "quarterly")).toMatchObject({ schedule: { cadence: "quarterly", anchorDay: 14, anchorMonth: 10 }, hits: 4, scoreBp: 10000, residualSum: 2 });
    expect(scoreBp(bill, "bimonthly")).toBe(2500);
    expect(scoreBp(bill, "semiannual")).toBe(2500);
    expect(scoreBp(bill, "monthly")).toBe(0);
  });

  it("variable: expected −8520 ± 620, next due Jan 14 2027", () => {
    expect(classifyAmounts(bill.map((c) => -c.amountCents))).toEqual({ mode: "variable", expectedAbs: 8520n, toleranceCents: 620n, dispersed: false });
    const d = only(detectRecurring(bill, TODAY));
    expect(d.schedule).toEqual({ cadence: "quarterly", anchorDay: 14, anchorMonth: 10 });
    expect(d.amountMode).toBe("variable");
    expect(d.expectedCents).toBe(-8520n);
    expect(d.toleranceCents).toBe(620n);
    expect(d.onCycleIds).toEqual(ids(bill));
    expect(d.lastChargeDate).toBe("2026-10-12");
    expect(d.nextDueDate).toBe("2027-01-14");
    expect(yearlyCents(d.expectedCents, "quarterly")).toBe(-34080n);
    expect(monthlyEquivalentCents(d.expectedCents, "quarterly")).toBe(-2840n);
  });
});

describe("TC24 semiannual insurance premium", () => {
  const premium = series("ins", -61250n, ["2025-04-03", "2025-10-03", "2026-04-03", "2026-10-05"]);

  it("fits April 3, scores 10000; quarterly 5000 and yearly 0 are rejected", () => {
    expect(scoreFor(premium, "semiannual")).toMatchObject({ schedule: { cadence: "semiannual", anchorDay: 3, anchorMonth: 4 }, hits: 3, scoreBp: 10000, residualSum: 2 });
    expect(scoreFor(premium, "quarterly")).toMatchObject({ hits: 0, skips: 3, scoreBp: 5000 });
    expect(scoreBp(premium, "yearly")).toBe(0);
    const d = only(detectRecurring(premium, TODAY));
    expect(d.schedule).toEqual({ cadence: "semiannual", anchorDay: 3, anchorMonth: 4 });
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-61250n);
    expect(d.toleranceCents).toBe(612n);
    expect(d.onCycleIds).toEqual(ids(premium));
    expect(d.nextDueDate).toBe("2027-04-03");
    expect(yearlyCents(d.expectedCents, "semiannual")).toBe(-122500n);
    expect(monthlyEquivalentCents(d.expectedCents, "semiannual")).toBe(-10208n);
    expect(isNewSeries(d.firstChargeDate, "2024-01-01", TODAY)).toBe(false);
  });
});

describe("TC25 weekly charge due today", () => {
  const weekly = series("wk", -12000n, ["2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"]);

  it("weekly 10000; biweekly 0; twice_monthly 5000 on anchors (8, 25)", () => {
    expect(scoreFor(weekly, "weekly")).toMatchObject({ hits: 6, scoreBp: 10000, residualSum: 0 });
    expect(scoreBp(weekly, "biweekly")).toBe(0);
    expect(scoreFor(weekly, "twice_monthly")).toMatchObject({ schedule: { cadence: "twice_monthly", anchorDay: 8, anchorDay2: 25 }, hits: 3, extras: 3, scoreBp: 5000 });
  });

  it("next due is today and not yet missed", () => {
    const d = only(detectRecurring(weekly, TODAY));
    expect(d.schedule).toEqual({ cadence: "weekly", anchorDate: "2026-10-06" });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-12000n);
    expect(d.toleranceCents).toBe(120n);
    expect(d.onCycleIds).toEqual(ids(weekly));
    expect(d.nextDueDate).toBe("2026-10-13");
    expect(isMissed(d.nextDueDate, TODAY, "weekly")).toBe(false);
    expect(isMissed(d.nextDueDate, "2026-10-15", "weekly")).toBe(false);
    expect(isMissed(d.nextDueDate, "2026-10-16", "weekly")).toBe(true);
    expect(yearlyCents(d.expectedCents, "weekly")).toBe(-624000n);
    expect(monthlyEquivalentCents(d.expectedCents, "weekly")).toBe(-52000n);
  });
});

describe("TC26 new-subscription alert and the first-sync history guard", () => {
  const netflix = series("nf", -1549n, ["2026-08-05", "2026-09-05", "2026-10-05"]);

  it("three charges on the 5th are a monthly series", () => {
    expect(scoreFor(netflix, "monthly")).toMatchObject({ hits: 2, onCycle: 3, scoreBp: 10000 });
    const d = only(detectRecurring(netflix, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 5 });
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-1549n);
    expect(d.firstChargeDate).toBe("2026-08-05");
    expect(d.nextDueDate).toBe("2026-11-05");
  });

  it("(a) history starting 35 days before the first charge: not new; (b) 65 days before: new", () => {
    expect(isNewSeries("2026-08-05", "2026-07-01", TODAY)).toBe(false);
    expect(isNewSeries("2026-08-05", "2026-06-01", TODAY)).toBe(true);
    // Window boundary: 120 days before today is still new, 121 is not; guard boundary: 45 days is new, 44 is not.
    expect(isNewSeries("2026-06-15", "2026-01-01", TODAY)).toBe(true);
    expect(isNewSeries("2026-06-14", "2026-01-01", TODAY)).toBe(false);
    expect(isNewSeries("2026-08-05", "2026-06-21", TODAY)).toBe(true);
    expect(isNewSeries("2026-08-05", "2026-06-22", TODAY)).toBe(false);
  });
});

describe("TC27 subscription moves to a new card", () => {
  const onA = series("nf", -1549n, ["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05"], A);
  const onB = series("nf", -1549n, ["2026-07-05", "2026-08-05", "2026-09-05", "2026-10-05"], B);
  const netflix = [...onA, ...onB];

  it("one item over both accounts, account_id follows the last charge", () => {
    expect(scoreFor(netflix, "monthly")).toMatchObject({ hits: 9, scoreBp: 10000 });
    const d = only(detectRecurring(netflix, TODAY));
    expect(d.schedule).toEqual({ cadence: "monthly", anchorDay: 5 });
    expect(d.scoreBp).toBe(10000);
    expect(d.amountMode).toBe("fixed");
    expect(d.expectedCents).toBe(-1549n);
    expect(d.toleranceCents).toBe(100n);
    expect(d.onCycleIds).toEqual(ids(netflix));
    expect(d.chargeCount).toBe(10);
    expect(d.accountId).toBe(B);
    expect(d.firstChargeDate).toBe("2026-01-05");
    expect(d.lastChargeDate).toBe("2026-10-05");
    expect(d.nextDueDate).toBe("2026-11-05");
  });
});
