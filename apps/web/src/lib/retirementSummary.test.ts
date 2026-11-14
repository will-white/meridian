import { SimSummary } from "@meridian/shared";
import { exampleSimSummary } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { clampPercentile, fundedTest, modelText, pathCaption, percentileChoices, runHeaderText, runStaleText, summaryView, typicalShortfallPercentile } from "./retirementSummary.js";

/** The ten-path run of the shared fixture: 8 successes, Wilson [4902, 9433], depletions in 2028 and 2029. */
const TEN = exampleSimSummary();

/** R3's 50% run (strategies §7.8, D16): 64 of 69 complete cohorts, 1928 to 1996, failing 1964, 1965, 1966, 1968, 1969. */
function r3Like(): SimSummary {
  return SimSummary.parse({
    ...TEN,
    paths: 69,
    successPaths: 64,
    fullPlanPaths: 64,
    successCi95Bp: undefined,
    failure: { paths: 5, firstDepletionYear: 2051, medianDepletionYear: 2053, byYear: [...Array(24).fill(0), 1, 0, 2, 2] },
    model: { kind: "historical", requestedPaths: 100, cohortMode: "complete", cohortCount: 69, firstStartYear: 1928, lastStartYear: 1996 },
    startYear: 2027,
  });
}

describe("summaryView (strategies-outputs-web §5.5 item 2)", () => {
  it("the fixture's ten paths: 80% in the warning tone, Wilson's bounds, the test in use, tiles, the failure line and bars, the coarse note", () => {
    const view = summaryView(TEN, [{ birthYear: 1975 }]);
    expect(view.hero).toBe("80%");
    expect(view.tone).toBe("warn");
    expect(view.countText).toBe("8 of 10 simulated futures funded the plan");
    // 4902 bp → 49.0%, 9433 bp → 94.3% (one decimal of the stored bounds).
    expect(view.intervalText).toBe("between 49.0% and 94.3% with this many paths");
    expect(view.testText).toBe("Funded means your planned spending was paid every year.");
    expect(view.modelText).toBe("Block bootstrap of the historical record, mean block 10 years");
    expect(view.tiles).toEqual([
      { label: "Median ending wealth", value: "$980,000.00", note: "today's dollars" },
      { label: "10th percentile ending wealth", value: "$0.00", note: "today's dollars" },
      { label: "Median shortfall of the futures that fell short", value: "$45,000.00", note: "today's dollars" },
    ]);
    // byYear [0, 0, 1, 1] from 2026: one first failure in 2028 (Alex 53) and one in 2029 (54).
    expect(view.failure).toEqual({
      text: "In the futures that fell short, half had run out by 2028 (age 53); the earliest in 2028",
      bars: [
        { year: 2028, ages: "age 53", count: 1, widthBp: 10000 },
        { year: 2029, ages: "age 54", count: 1, widthBp: 10000 },
      ],
    });
    expect(view.coarseNote).toBe("Percentiles from 10 paths are coarse");
  });

  it("the historical model: start years instead of futures, no interval, no coarse note, the cohort mode stated (plan decision 7)", () => {
    const view = summaryView(r3Like(), [{ birthYear: 1962 }]);
    // 64 × 10000 ÷ 69 = 9275.36 → 9275 bp (OUT-2) → "92%".
    expect(view.hero).toBe("92%");
    expect(view.tone).toBe("ok");
    expect(view.countText).toBe("64 of 69 historical start years funded the plan");
    expect(view.intervalText).toBeUndefined();
    expect(view.coarseNote).toBeUndefined();
    expect(view.modelText).toBe("Historical sequences, start years 1928 to 1996, each a complete stretch of history");
    expect(view.failure!.text).toBe("In the futures that fell short, half had run out by 2053 (age 91); the earliest in 2051");
    expect(view.failure!.bars.map((b) => [b.year, b.count, b.widthBp])).toEqual([
      [2051, 1, 5000],
      [2053, 2, 10000],
      [2054, 2, 10000],
    ]);
    const wrap = SimSummary.parse({ ...r3Like(), model: { kind: "historical", requestedPaths: 10000, cohortMode: "wrap", cohortCount: 98, firstStartYear: 1928, lastStartYear: 2025 } });
    expect(modelText(wrap.model)).toBe("Historical sequences, start years 1928 to 2025; a sequence that runs past the last year of the record continues from its first year (wrap-around)");
  });

  it("no failures: the failure line, bars and shortfall tile are omitted; two people's ages are both named", () => {
    const funded = SimSummary.parse({ ...TEN, successPaths: 10, fullPlanPaths: 10, failure: { paths: 0, byYear: [0, 0, 0, 0] }, shortfallRealP50OfFailures: undefined });
    const view = summaryView(funded);
    expect(view.failure).toBeUndefined();
    expect(view.tiles.map((t) => t.label)).toEqual(["Median ending wealth", "10th percentile ending wealth"]);
    expect(summaryView(TEN, [{ birthYear: 1975 }, { birthYear: 1977 }]).failure!.text).toContain("(ages 53 / 51)");
  });

  it("strategies other than constant spending add the full-plan rate, and say what funded means", () => {
    const guardrails = SimSummary.parse({ ...TEN, strategy: "guardrails", fullPlanPaths: 6 });
    expect(summaryView(guardrails).tiles.find((t) => t.label === "Never below plan")).toEqual({ label: "Never below plan", value: "60%" });
    expect(fundedTest("guardrails")).toBe("Funded means the spending the rule called for was paid every year.");
    expect(fundedTest("floor_ceiling")).toBe(fundedTest("guardrails"));
    expect(fundedTest("vpw")).toBe("Funded means your essential spending, healthcare and goals were paid every year.");
    expect(fundedTest("fixed_percentage")).toBe(fundedTest("vpw"));
  });

  it("parametric presets in words", () => {
    expect(modelText({ kind: "parametric", requestedPaths: 10000, preset: "historical" })).toBe("Parametric, long-run history");
    expect(modelText({ kind: "parametric", requestedPaths: 10000, preset: "conservative" })).toBe("Parametric, conservative future");
    expect(modelText({ kind: "parametric", requestedPaths: 10000, preset: "custom" })).toBe("Parametric, your own returns and volatilities");
    expect(modelText({ kind: "fixed", requestedPaths: 100 })).toBe("Fixed (test model)");
  });
});

describe("the run header and its banner (§5.5 item 1)", () => {
  const run = { finishedAt: "2026-11-08", createdAt: "2026-11-08", paths: 10000, seed: 1, current: true, engineVersion: "1.0.1", dataVersion: "2026.11.1" };
  const meta = { engineVersion: "1.0.1", dataVersion: "2026.11.1" };

  it("'run 11/08/26 · 10,000 paths · seed 1'", () => {
    expect(runHeaderText(run)).toBe("run 11/08/26 · 10,000 paths · seed 1");
  });

  it("stale: the engine or data moved, or the inputs changed; nothing when current", () => {
    expect(runStaleText(run, meta)).toBeNull();
    expect(runStaleText({ ...run, current: false }, meta)).toBe("Your accounts or profile changed since this run");
    expect(runStaleText({ ...run, dataVersion: "2026.11.0" }, meta)).toBe("The engine or its data was updated");
    expect(runStaleText({ ...run, engineVersion: "1.0.0", current: false }, meta)).toBe("The engine or its data was updated");
  });
});

describe("the percentile picker (§5.5 item 4)", () => {
  it("chips 5 to 95 are the stored percentiles; Worst, Best and Typical shortfall", () => {
    const { chips, shortcuts } = percentileChoices(TEN, 50);
    expect(chips.map((c) => c.percentile)).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(chips.filter((c) => c.selected).map((c) => c.percentile)).toEqual([50]);
    expect(chips.every((c) => c.stored)).toBe(true);
    // 2 failures of 10 paths: round(100 × 2 ÷ 2 ÷ 10) = 10.
    expect(shortcuts).toEqual([
      { label: "Worst", percentile: 1, selected: false, stored: false },
      { label: "Best", percentile: 99, selected: false, stored: false },
      { label: "Typical shortfall", percentile: 10, selected: false, stored: true },
    ]);
    expect(percentileChoices({ paths: 10, failure: { paths: 0, byYear: [] } }, 50).shortcuts.map((s) => s.label)).toEqual(["Worst", "Best"]);
  });

  it("typical shortfall: max(1, round(100 × failures ÷ 2 ÷ paths))", () => {
    expect(typicalShortfallPercentile(598, 10000)).toBe(3); // 59,800 ÷ 20,000 = 2.99 → 3
    expect(typicalShortfallPercentile(1, 10000)).toBe(1); // 0.005 → 0 → at least 1
    expect(typicalShortfallPercentile(5, 69)).toBe(4); // 500 ÷ 138 = 3.62 → 4
    expect(typicalShortfallPercentile(25, 1000)).toBe(1); // 2,500 ÷ 2,000 = 1.25 → 1
    expect(typicalShortfallPercentile(30, 1000)).toBe(2); // 1.5 → 2 (half away from zero)
  });

  it("the URL's percentile is an integer 1 to 99, else 50", () => {
    expect(clampPercentile("37")).toBe(37);
    expect(clampPercentile("0")).toBe(50);
    expect(clampPercentile("100")).toBe(50);
    expect(clampPercentile("4.5")).toBe(50);
    expect(clampPercentile(null)).toBe(50);
    expect(clampPercentile(99)).toBe(99);
  });

  it("the caption: 'Path #4,312, ranked 1,000th of 10,000 by ending wealth…'; a historical path by its start year", () => {
    expect(pathCaption({ pathIndex: 4312, rank: 999, source: "stored", table: {} }, 10000)).toBe(
      "Path #4,312, ranked 1,000th of 10,000 by ending wealth. One simulated future, not a forecast, and not the same percentile of every column.",
    );
    expect(pathCaption({ pathIndex: 38, rank: 2, source: "resimulated", table: { historicalStartYear: 1966 } }, 69)).toBe(
      "The path that starts in 1966, ranked 3rd of 69 by ending wealth. One simulated future, not a forecast, and not the same percentile of every column. Re-simulated from the run's frozen input.",
    );
  });
});
