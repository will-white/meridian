import { describe, expect, it } from "vitest";
import type { ExternalFlowInput } from "../performance.js";
import { BaselineContribution } from "./baseline.js";
import { aggregateContributions, EMPLOYER_DESCRIPTION, withRecurringFallback, type BaselineContributionRecord } from "./contributions.js";
import { fixtureBaseline, IDS } from "./testFixtures.js";

// Inputs-and-data §7 test 6 (contribution aggregation, §3.2 B8) on literal flows. The window is the
// fixture's: the 12 complete months 2025-10 to 2026-09 before today 2026-10-14.
const WINDOW = { from: "2025-10", to: "2026-09" };
const PLAN = new Set([IDS.K, IDS.H, IDS.T, IDS.B, IDS.R]);
const MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

let seq = 0;
function flow(accountId: string, date: string, cents: number, o: Partial<ExternalFlowInput> = {}): ExternalFlowInput {
  seq += 1;
  return { date, amountCents: BigInt(cents), kind: "cash", source: "ledger", accountId, counterpartyAccountId: null, pairId: null, sourceId: `t${seq}`, ...o };
}

/** The fixture's K: on day 15 of each month, +100,000 employee and +50,000 employer, both unpaired (§7.0). */
function kFlows(descriptions: Map<string, string>, employer = "EMPLOYER MATCH"): ExternalFlowInput[] {
  return MONTHS.flatMap((m) => {
    const own = flow(IDS.K, `${m}-15`, 100_000);
    const match = flow(IDS.K, `${m}-15`, 50_000);
    descriptions.set(own.sourceId!, "EMPLOYEE PRE-TAX CONTRIBUTION");
    descriptions.set(match.sourceId!, employer);
    return [own, match];
  });
}

/** The fixture's H: four unpaired payroll deposits of 30,000 (2026-06-15, 07-15, 08-17, 09-15). */
function hFlows(descriptions: Map<string, string>): ExternalFlowInput[] {
  return ["2026-06-15", "2026-07-15", "2026-08-17", "2026-09-15"].map((d) => {
    const f = flow(IDS.H, d, 30_000);
    descriptions.set(f.sourceId!, "PAYROLL HSA CONTRIBUTION");
    return f;
  });
}

const one = (records: BaselineContributionRecord[], id: string) => records.find((r) => r.accountId === id)!;

describe("6. contribution aggregation (inputs-and-data §3.2 B8)", () => {
  it("6 K: 24 unpaired rows, first data date 2025-09-30 → 1,800,000 gross, 600,000 employer detected, 1,200,000 employee, 12 months", () => {
    const d = new Map<string, string>();
    const k = one(aggregateContributions(kFlows(d), d, PLAN, new Map([[IDS.K, "2025-09-30"]]), WINDOW), IDS.K);
    // 2025-09-30 is not the 1st, so the first full month is 2025-10: all 12 window months count.
    expect(k).toEqual({
      accountId: IDS.K,
      monthsWithData: 12,
      grossInCents: "1800000",
      outCents: "0",
      netCents: "1800000",
      unpairedCents: "1800000",
      employerCents: "600000",
      employeeCents: "1200000",
      employerDetected: true,
      annualNetCents: "1800000",
      annualEmployeeCents: "1200000",
      annualEmployerCents: "600000",
      annualUnpairedCents: "1800000",
      flags: [],
    });
  });

  it("6 H: four rows of 30,000 from a first data date of 2026-06-01 → 4 months, annual truncDiv(120,000 × 12, 4) = 360,000, partial_window", () => {
    const d = new Map<string, string>();
    const h = one(aggregateContributions(hFlows(d), d, PLAN, new Map([[IDS.H, "2026-06-01"]]), WINDOW), IDS.H);
    expect(h).toMatchObject({ monthsWithData: 4, grossInCents: "120000", netCents: "120000", unpairedCents: "120000", employerDetected: false, employeeCents: "120000" });
    expect(h).toMatchObject({ annualNetCents: "360000", annualEmployeeCents: "360000", annualEmployerCents: "0", annualUnpairedCents: "360000", flags: ["partial_window"] });
  });

  it("6 H from 2026-06-02 with no earlier flow → first full month 2026-07, the June flow dropped: 90,000 over 3 months → 360,000", () => {
    const d = new Map<string, string>();
    const h = one(aggregateContributions(hFlows(d), d, PLAN, new Map([[IDS.H, "2026-06-02"]]), WINDOW), IDS.H);
    // Coverage starts at min(2026-06-02, 2026-06-15) = 2026-06-02, not the 1st: months 2026-07 to 2026-09.
    expect(h).toMatchObject({ monthsWithData: 3, grossInCents: "90000", annualNetCents: "360000", flags: ["partial_window"] });
  });

  it("6 +500,000 and −200,000 → net 300,000 with has_withdrawals; out greater than in → net 0", () => {
    const flows = [flow(IDS.B, "2025-11-03", 500_000), flow(IDS.B, "2026-02-03", -200_000), flow(IDS.T, "2025-12-01", 100_000), flow(IDS.T, "2026-01-05", -250_000)];
    const dates = new Map([
      [IDS.B, "2020-01-01"],
      [IDS.T, "2020-01-01"],
    ]);
    const records = aggregateContributions(flows, new Map(), PLAN, dates, WINDOW);
    expect(one(records, IDS.B)).toMatchObject({ grossInCents: "500000", outCents: "200000", netCents: "300000", annualNetCents: "300000", flags: ["irregular", "has_withdrawals"] });
    expect(one(records, IDS.T)).toMatchObject({ grossInCents: "100000", outCents: "250000", netCents: "0", employeeCents: "0", annualNetCents: "0", flags: ["irregular", "has_withdrawals"] });
  });

  it("6 a +15,000,000 flow whose counterparty is another plan investment account is dropped (net 0); securities flows are dropped too", () => {
    const flows = [
      flow(IDS.R, "2026-03-10", 15_000_000, { counterpartyAccountId: IDS.K }),
      flow(IDS.R, "2026-04-10", 700_000, { kind: "securities", source: "investment_txn" }),
      flow(IDS.R, "2026-05-10", 25_000, { counterpartyAccountId: IDS.C }),
    ];
    const r = one(aggregateContributions(flows, new Map(), PLAN, new Map([[IDS.R, "2020-01-01"]]), WINDOW), IDS.R);
    // Only the transfer from Checking (not a plan investment account) remains; it is paired, so not unpaired.
    expect(r).toMatchObject({ grossInCents: "25000", netCents: "25000", unpairedCents: "0", annualNetCents: "25000" });
  });

  it("6 one +900,000 flow among 1,000,000 gross → irregular; 500,000 of 1,000,000 is not more than half", () => {
    const records = aggregateContributions(
      [flow(IDS.B, "2026-01-10", 900_000), flow(IDS.B, "2026-02-10", 100_000), flow(IDS.T, "2026-01-10", 500_000), flow(IDS.T, "2026-02-10", 500_000)],
      new Map(),
      PLAN,
      new Map([
        [IDS.B, "2020-01-01"],
        [IDS.T, "2020-01-01"],
      ]),
      WINDOW,
    );
    expect(one(records, IDS.B).flags).toEqual(["irregular"]);
    expect(one(records, IDS.T).flags).toEqual([]);
  });

  it("6 two months of data → the annual figures are absent, insufficient_history", () => {
    // First data date 2026-08-01 (the 1st): months 2026-08 and 2026-09 count.
    const t = one(aggregateContributions([flow(IDS.T, "2026-08-20", 40_000)], new Map(), PLAN, new Map([[IDS.T, "2026-08-01"]]), WINDOW), IDS.T);
    expect(t).toEqual({
      accountId: IDS.T,
      monthsWithData: 2,
      grossInCents: "40000",
      outCents: "0",
      netCents: "40000",
      unpairedCents: "40000",
      employerCents: "0",
      employeeCents: "40000",
      employerDetected: false,
      flags: ["insufficient_history", "irregular"],
    });
  });

  it("6 the employer pattern: EMPLOYEE PRE-TAX CONTRIBUTION does not match; ER SAFE HARBOR, PROFIT SHARING and EMPLOYER MATCH do", () => {
    expect(EMPLOYER_DESCRIPTION.test("EMPLOYEE PRE-TAX CONTRIBUTION")).toBe(false);
    for (const s of ["ER SAFE HARBOR", "PROFIT SHARING", "EMPLOYER MATCH", "Non-Elective 3%", "profit-share"]) expect(EMPLOYER_DESCRIPTION.test(s), s).toBe(true);
    // With no employer description the whole net is the employee's (§3.4 R9's `match_unknown` case).
    const d = new Map<string, string>();
    const k = one(aggregateContributions(kFlows(d, "401K DEPOSIT"), d, PLAN, new Map([[IDS.K, "2025-09-30"]]), WINDOW), IDS.K);
    expect(k).toMatchObject({ employerDetected: false, employerCents: "0", employeeCents: "1800000", annualEmployeeCents: "1800000", annualEmployerCents: "0" });
    // Employer money is at most the net: 600,000 matched against a net of 400,000 after a withdrawal of 1,400,000.
    const d2 = new Map<string, string>();
    const withdrawn = [...kFlows(d2), flow(IDS.K, "2026-09-20", -1_400_000)];
    expect(one(aggregateContributions(withdrawn, d2, PLAN, new Map([[IDS.K, "2025-09-30"]]), WINDOW), IDS.K)).toMatchObject({
      netCents: "400000",
      employerCents: "400000",
      employeeCents: "0",
    });
  });

  it("an account with no data date and no flow has no months; flows outside the window or of other accounts are ignored; records are in id order", () => {
    const flows = [flow(IDS.B, "2025-09-15", 70_000), flow(IDS.B, "2026-10-01", 80_000), flow(IDS.C, "2026-01-01", 90_000)];
    const records = aggregateContributions(flows, new Map(), PLAN, new Map([[IDS.B, "2020-01-01"]]), WINDOW);
    expect(records.map((r) => r.accountId)).toEqual([...PLAN].sort());
    expect(one(records, IDS.B)).toMatchObject({ monthsWithData: 12, grossInCents: "0" });
    expect(one(records, IDS.H)).toMatchObject({ monthsWithData: 0, flags: ["insufficient_history"] });
  });

  it("the fixture's five records (the §3.2 worked example) come out of the fixture's flows, with the recurring fallback", () => {
    const d = new Map<string, string>();
    const b = flow(IDS.B, "2026-03-02", 500_000, { counterpartyAccountId: IDS.C, pairId: "p1" });
    const flows = [...kFlows(d), ...hFlows(d), b];
    const dates = new Map<string, string | null>([
      [IDS.K, "2025-09-30"],
      [IDS.H, "2026-06-01"],
      [IDS.T, "2026-10-13"],
      [IDS.B, "2021-03-01"],
      [IDS.R, "2025-10-13"],
    ]);
    const planned = new Map<string, bigint>([[IDS.R, -300_000n]]);
    const records = aggregateContributions(flows, d, PLAN, dates, WINDOW).map((r) => withRecurringFallback(r, planned.get(r.accountId) ?? 0n));
    for (const r of records) expect(BaselineContribution.parse(r)).toEqual(r);
    expect(records).toEqual(fixtureBaseline().contributions);
  });

  it("withRecurringFallback: measured when the annual net is positive, else recurring when planned, else none", () => {
    const record = (annualNetCents?: string): BaselineContributionRecord => ({
      accountId: IDS.R,
      monthsWithData: annualNetCents === undefined ? 0 : 12,
      grossInCents: "0",
      outCents: "0",
      netCents: "0",
      unpairedCents: "0",
      employerCents: "0",
      employeeCents: "0",
      employerDetected: false,
      flags: [],
      ...(annualNetCents === undefined ? {} : { annualNetCents }),
    });
    expect(withRecurringFallback(record("100"), 300_000n)).toMatchObject({ source: "measured", plannedCents: "300000" });
    expect(withRecurringFallback(record("0"), 300_000n)).toMatchObject({ source: "recurring", plannedCents: "300000" });
    expect(withRecurringFallback(record(), 0n)).toMatchObject({ source: "none", plannedCents: "0" });
  });
});
