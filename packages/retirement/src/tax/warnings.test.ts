import { describe, expect, it } from "vitest";
import { WN, WN_REC } from "./layout.js";
import {
  PATH_WARNING_CODES,
  PATH_WARNING_SLOTS,
  addPathWarnings,
  createWarningTotals,
  mergeWarningTotals,
  noteWarning,
  resetPathWarnings,
  warningMessages,
  type WarningTotals,
} from "./warnings.js";

// tax-rmd-ss §3.11 and seams C41: path warnings are the largest amount of one year per path;
// chunks merge by maximum and sum, so the run's warnings do not depend on the thread count, the
// chunking or the order (L5).

/** A small deterministic generator for the test's amounts (the engine's own draws are rng.ts). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `n` paths' warning records: about half the paths note each slot, with amounts up to 20,000. */
function pathRecords(n: number, seed: number): Float64Array[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => {
    const wn = new Float64Array(WN_REC);
    for (const slot of PATH_WARNING_SLOTS) {
      for (let year = 0; year < 3; year++) if (r() < 0.25) noteWarning(wn, slot, Math.floor(r() * 2000000) / 100);
    }
    return wn;
  });
}

function totalsOf(records: readonly Float64Array[]): WarningTotals {
  const t = createWarningTotals();
  for (const wn of records) addPathWarnings(t, wn);
  return t;
}

describe("noteWarning and the path record", () => {
  it("keeps the largest amount of one year; 0 and negative amounts note nothing; reset clears every slot", () => {
    const wn = new Float64Array(WN_REC);
    noteWarning(wn, WN.SS_EARNINGS_TEST, 2960);
    noteWarning(wn, WN.SS_EARNINGS_TEST, 7760);
    noteWarning(wn, WN.SS_EARNINGS_TEST, 7360);
    noteWarning(wn, WN.EARLY_PENALTY, 0);
    noteWarning(wn, WN.CONTRIBUTION_CAPPED, -5);
    expect(Array.from(wn)).toEqual([7760, 0, 0, 0, 0, 0, 0, 0]);
    resetPathWarnings(wn);
    expect(Array.from(wn)).toEqual(new Array(WN_REC).fill(0));
  });

  it("the codes follow the WN slots", () => {
    expect(PATH_WARNING_SLOTS).toEqual([0, 1, 2, 3]);
    expect(PATH_WARNING_CODES).toEqual(["ss_earnings_test", "early_withdrawal_penalty", "roth_basis_unknown", "contribution_capped"]);
  });
});

describe("C41 merging is a maximum and a sum, independent of chunking and order", () => {
  it("1,000 paths in one chunk, in 7 uneven chunks merged forwards, and in 13 chunks merged backwards give the same totals", () => {
    const records = pathRecords(1000, 20261113);
    const one = totalsOf(records);

    const cuts = [0, 3, 90, 91, 400, 655, 999, 1000];
    const forwards = createWarningTotals();
    for (let i = 0; i + 1 < cuts.length; i++) mergeWarningTotals(forwards, totalsOf(records.slice(cuts[i], cuts[i + 1])));

    const backwards = createWarningTotals();
    const chunks: WarningTotals[] = [];
    for (let k = 0; k < 13; k++) chunks.push(totalsOf(records.filter((_, i) => i % 13 === k)));
    for (const c of chunks.reverse()) mergeWarningTotals(backwards, c);

    for (const t of [forwards, backwards]) {
      expect(Array.from(t.warnMax)).toEqual(Array.from(one.warnMax));
      expect(Array.from(t.warnPaths)).toEqual(Array.from(one.warnPaths));
    }
    expect(warningMessages([], forwards, 1000)).toEqual(warningMessages([], one, 1000));
    // The counts are the paths with a positive amount, the maxima the largest of them.
    for (const slot of PATH_WARNING_SLOTS) {
      expect(one.warnPaths[slot]).toBe(records.filter((wn) => wn[slot]! > 0).length);
      expect(one.warnMax[slot]).toBe(Math.max(...records.map((wn) => wn[slot]!)));
    }
  });
});

describe("warningMessages", () => {
  it("the design's example: up to $7,760 in a year on 10,000 of 10,000 paths", () => {
    const t = createWarningTotals();
    t.warnMax[WN.SS_EARNINGS_TEST] = 7760;
    t.warnPaths[WN.SS_EARNINGS_TEST] = 10000;
    expect(warningMessages([], t, 10000)).toEqual([
      {
        code: "ss_earnings_test",
        message: "The Social Security earnings test withholds up to $7,760 in a year on 10,000 of 10,000 paths; the months are credited back at full retirement age.",
      },
    ]);
  });

  it("compile warnings first as given, then the path warnings in slot order; a slot no path noted is left out", () => {
    const t = createWarningTotals();
    t.warnMax[WN.CONTRIBUTION_CAPPED] = 1234567.5;
    t.warnPaths[WN.CONTRIBUTION_CAPPED] = 1;
    t.warnMax[WN.EARLY_PENALTY] = 2000;
    t.warnPaths[WN.EARLY_PENALTY] = 2500;
    const compile = [
      { code: "limits_pending", message: "The 2027 contribution limits … are not yet published." },
      { code: "ss_statement_old", message: "older statement" },
    ];
    const out = warningMessages(compile, t, 10000);
    expect(out.map((w) => w.code)).toEqual(["limits_pending", "ss_statement_old", "early_withdrawal_penalty", "contribution_capped"]);
    expect(out[0]).toEqual(compile[0]);
    expect(out[0]).not.toBe(compile[0]);
    expect(out[2]!.message).toBe(
      "Withdrawals before 59½, and HSA withdrawals for other than medical costs before 65, carry additional tax of up to $2,000 in a year on 2,500 of 10,000 paths.",
    );
    // 1,234,567.50 is shown as whole dollars rounded half away from zero.
    expect(out[3]!.message).toBe(
      "Planned contributions exceed the legal limits by up to $1,234,568 in a year on 1 of 10,000 paths; an employee's excess is saved after tax in the surplus account and an employer's excess is dropped.",
    );
  });

  it("a single path says path; the Roth message names the missing basis", () => {
    const t = createWarningTotals();
    t.warnMax[WN.ROTH_BASIS_UNKNOWN] = 999.49;
    t.warnPaths[WN.ROTH_BASIS_UNKNOWN] = 1;
    expect(warningMessages([], t, 1)).toEqual([
      {
        code: "roth_basis_unknown",
        message:
          "Roth withdrawals of up to $999 in a year are taxed as earnings on 1 of 1 path because the Roth contribution basis was not entered; enter it on the account to be exact.",
      },
    ]);
  });

  it("no warnings at all gives an empty list; the reserved slots are never reported", () => {
    const t = createWarningTotals();
    t.warnMax[WN.RESERVED0] = 5;
    t.warnPaths[WN.RESERVED0] = 3;
    expect(warningMessages([], t, 100)).toEqual([]);
  });
});
