import { readFileSync } from "node:fs";
import type { SimInput, SimInputAccount, StrategyConfigInput } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { CASH_TOL } from "../constants.js";
import { YEAR_FLAG } from "../loop.js";
import { AC, SP, W, YR, ZERO_YIELDS, ac, afterTrades, basisOf, endOf, runRealPath, sp, to, yr } from "../loopTestKit.js";
import { PATH_FLAG } from "../state.js";
import { TO } from "../tax/layout.js";
import { referenceR1Input, referenceR2Input } from "../testing/referenceScenarios.js";
import { account, buildSimInput, cashAccount } from "../testing/simInput.js";
import { fixedSocialSecurity } from "../testing/stubs.js";
import { createEngineHooks } from "./plan.js";

// Build step 19: the default withdrawal order and the gross-up on the real tax function
// (strategies-outputs-web §3.5 to §3.8 and §7.2; seams C27, C33, C34, C35, F4). Every case runs
// the production hooks (`createEngineHooks()`: the strategies' `decideSpending` and the default
// order) and the production tax record `TAX_FUNCTIONS` through the public path: a SimInput from
// the builder, prepare(), createPathState(), simulatePath() with a PathDetail.
//
// As §7 says for hook cases: the fixed model at 0%, a plan from January (f = 1), yields 0
// (`ZERO_YIELDS`: no dividends, no bond spread, no payroll tax). A case's Social Security is the
// stated annual amount through the stub `fixedSocialSecurity` (the month loop is step 10's and
// step 17's; several stated amounts, 50,000 a year among them, are not twelve whole-dollar
// payments). A person's fixed life expectancy is the case's age, so the plan is the one year.
// Amounts from the gross-up within 0.02 (the solver stops at half a cent of net cash), other
// amounts within 0.005. WD-5 and WD-15 use the values re-derived in reference/sheets/hand-cases.md.

const close = (x: number, y: number) => expect(Math.abs(x - y), `${x} against ${y}`).toBeLessThanOrEqual(0.005);
const grossClose = (x: number, y: number) => expect(Math.abs(x - y), `${x} against ${y}`).toBeLessThanOrEqual(0.02);
const fixed = (age: number) => ({ mode: "fixed", age }) as const;
const run = (input: SimInput, ss?: number[]) => runRealPath(input, { hooks: createEngineHooks(), ...(ss === undefined ? {} : { tax: { socialSecurityYear: fixedSocialSecurity(ss) } }) });
const half = W(5000, 0, 5000, 0);

/** One year: plan from January of `year`, people of the stated ages, the accounts, a target of `targetCents`. */
function oneYear(o: {
  year: number;
  ages: number[];
  accounts: SimInputAccount[];
  targetCents?: string;
  essentialCents?: string;
  strategy?: StrategyConfigInput;
  cashReserveCents?: string;
  healthcareCents?: string;
}): SimInput {
  return buildSimInput({
    startYear: o.year,
    people: o.ages.map((age) => ({ birthYear: o.year - age, longevity: fixed(age) })),
    accounts: o.accounts,
    spending: {
      baseAnnualCents: o.targetCents ?? "0",
      essentialAnnualCents: o.essentialCents ?? o.targetCents ?? "0",
      healthcare:
        o.healthcareCents === undefined
          ? []
          : [{ personId: "p1", preMedicareAnnualCents: o.healthcareCents, preMedicareFrom: `${o.year}-01`, medicareFrom: `${o.year}-01`, medicareAnnualCents: o.healthcareCents, realGrowthBp: 0, inBase: false }],
    },
    ...(o.strategy === undefined ? {} : { strategy: o.strategy }),
    ...(o.cashReserveCents === undefined ? {} : { cashReserveCents: o.cashReserveCents }),
    tax: ZERO_YIELDS,
  });
}

const ira = (balanceCents: string, owner: "p1" | "p2" = "p1", allocation = W(10000, 0, 0, 0)) => account(`ira_${owner}`, "pre_tax", balanceCents, { type: "ira", owner, allocation });
const roth = (balanceCents: string, basisCents: string) => account("roth", "roth", balanceCents, { type: "roth", rothContributionBasisCents: basisCents });
const taxable = (balanceCents: string, basisCents: string, allocation = W(10000, 0, 0, 0)) => account("brk", "taxable", balanceCents, { type: "brokerage", basisCents, allocation });
const hsa = (balanceCents: string) => account("hsa", "hsa", balanceCents, { type: "hsa" });
const wd = (d: Parameters<typeof ac>[0], a: number) => ac(d, 0, a, AC.WITHDRAWAL);

describe("WD-1 to WD-4: the gross-up on one linear piece and across a kink", () => {
  it("WD-1 married, both 60, 2026, pre-tax only, target 100,000: pre-tax 108,681.82, tax 8,681.82", () => {
    // §3.6: x − [2,480 + 0.12 (x − 32,200 − 24,800)] = 100,000 → 0.88x = 95,640 → x = 108,681.82.
    const { detail } = run(oneYear({ year: 2026, ages: [60, 60], accounts: [ira("200000000")], targetCents: "10000000" }));
    grossClose(wd(detail, 0), 108681.82);
    grossClose(yr(detail, 0, YR.TAX), 8681.82);
    expect(to(detail, 0, TO.PEN10)).toBe(0);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });

  it("WD-2 single 70, 2026, Social Security 30,000, target 61,000: pre-tax 34,005.14; taxable benefits 17,254.37; taxable income 27,109.51; tax 3,005.14", () => {
    // §3.6: deductions 16,100 + 2,050 + 6,000 = 24,150; tax 0.222x − 4,544; 30,000 + x − tax = 61,000.
    const { detail } = run(oneYear({ year: 2026, ages: [70], accounts: [ira("200000000")], targetCents: "6100000" }), [30000]);
    grossClose(wd(detail, 0), 34005.14);
    grossClose(to(detail, 0, TO.TAXABLE_SS), 17254.37);
    grossClose(to(detail, 0, TO.TAXABLE_INCOME), 27109.51);
    grossClose(yr(detail, 0, YR.TAX), 3005.14);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });

  it("WD-3 married, both 67, 2027, Social Security 50,000, target 90,000: pre-tax 41,871.17; taxable benefits 25,440.49; taxable income 18,711.66; tax 1,871.17", () => {
    // §3.6: deductions 33,200 + 3,400 + 12,000 = 48,600; 0.815x = 34,125.
    const { detail } = run(oneYear({ year: 2027, ages: [67, 67], accounts: [ira("200000000")], targetCents: "9000000" }), [50000]);
    grossClose(wd(detail, 0), 41871.17);
    grossClose(to(detail, 0, TO.TAXABLE_SS), 25440.49);
    grossClose(to(detail, 0, TO.TAXABLE_INCOME), 18711.66);
    grossClose(yr(detail, 0, YR.TAX), 1871.17);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });

  it("WD-4 single 62, 2027, pre-tax only, targets 60,000 and 100,000: 65,627.27 with tax 5,627.27; 116,525.00 with tax 16,525.00", () => {
    // 2027 single: standard 16,600; 12% from 12,800 (1,280); 22% from 52,025 (5,987).
    // 60,000: 1,280 + 0.12 (x − 29,400) = x − 60,000 → x = 65,627.27, taxable income 49,027.27.
    // 100,000: 5,987 + 0.22 (x − 68,625) = x − 100,000 → 0.78x = 90,890.5 → x = 116,525.00.
    for (const [cents, x, tax] of [["6000000", 65627.27, 5627.27], ["10000000", 116525.0, 16525.0]] as const) {
      const { detail } = run(oneYear({ year: 2027, ages: [62], accounts: [ira("200000000")], targetCents: cents }));
      grossClose(wd(detail, 0), x);
      grossClose(yr(detail, 0, YR.TAX), tax);
      expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
    }
  });
});

describe("WD-6 to WD-9: the penalty, reserve and HSA tiers", () => {
  it("WD-6 single 50, 2026, target 40,000; cash 10,000; Roth 60,000 of which 15,000 free; pre-tax 500,000: cash 10,000, Roth 15,000, pre-tax 16,737.50; income tax 63.75; additional tax 1,673.75", () => {
    // §3.6: y − 0.10 (y − 16,100) − 0.10 y = 15,000 → 0.8 y = 13,390 → y = 16,737.50. The Roth's
    // free part is its basis (C34: an early owner's conversions and earnings are not free).
    const { detail } = run(oneYear({ year: 2026, ages: [50], accounts: [cashAccount("cash", "1000000"), roth("6000000", "1500000"), ira("50000000")], targetCents: "4000000" }));
    close(wd(detail, 0), 10000);
    grossClose(wd(detail, 1), 15000);
    grossClose(wd(detail, 2), 16737.5);
    grossClose(to(detail, 0, TO.INCOME_TAX), 63.75);
    grossClose(to(detail, 0, TO.PEN10), 1673.75);
    expect(to(detail, 0, TO.PEN20)).toBe(0);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });

  it("WD-7 the tier example of §3.5 as a target of 85,648: cash 5,000 and the reserve 5,000, taxable 20,000, Roth 30,000, pre-tax 30,000; tax 1,352.00 + 3,000.00", () => {
    // Single, 57 (born 1970: 59½ in July 2029, so the 2027 share is 1), 2027. 90,000 through the
    // order; taxable income 30,000 − 16,600 = 13,400: 1,280 + 12% × 600 = 1,352; 10% of 30,000;
    // 90,000 − 4,352 = 85,648.
    const { detail } = run(
      oneYear({
        year: 2027,
        ages: [57],
        accounts: [cashAccount("cash", "1000000"), taxable("2000000", "2000000"), roth("8000000", "3000000"), ira("30000000")],
        targetCents: "8564800",
        cashReserveCents: "500000",
      }),
    );
    grossClose(wd(detail, 0), 10000);
    grossClose(wd(detail, 1), 20000);
    grossClose(wd(detail, 2), 30000);
    grossClose(wd(detail, 3), 30000);
    grossClose(to(detail, 0, TO.INCOME_TAX), 1352);
    grossClose(to(detail, 0, TO.PEN10), 3000);
    close(ac(detail, 0, 1, AC.GAIN), 0);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });

  it("WD-8 single 66, 2027: cash 30,000 with a reserve of 10,000, HSA 5,000, taxable 8,000 at basis, Roth 20,000; healthcare 8,000; core 40,000, then 52,000", () => {
    // Need 48,000: cash 20,000 (above the reserve), HSA 5,000 (≤ healthcare 8,000: qualified),
    // taxable 8,000 (no gain), Roth 15,000 (qualified: past 59½, first funded five years before
    // the plan), the reserve untouched. Need 60,000: the Roth's 20,000, then 7,000 of the reserve.
    const accounts = [cashAccount("cash", "3000000"), hsa("500000"), taxable("800000", "800000"), roth("2000000", "0")];
    for (const [core, w] of [
      ["4000000", [20000, 5000, 8000, 15000]],
      ["5200000", [27000, 5000, 8000, 20000]],
    ] as const) {
      const { detail } = run(oneYear({ year: 2027, ages: [66], accounts, targetCents: core, cashReserveCents: "1000000", healthcareCents: "800000" }));
      w.forEach((x, a) => grossClose(wd(detail, a), x));
      close(yr(detail, 0, YR.TAX), 0);
      expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
    }
  });

  it("WD-9 single 62, 2027, pre-tax 30,000, HSA 10,000, no healthcare, target 35,448: pre-tax 30,000; HSA 10,000 non-qualified; taxable income 23,400; tax 2,552.00 + 2,000.00", () => {
    // Taxable income 40,000 − 16,600 = 23,400: 1,280 + 12% × 10,600 = 2,552; 20% of 10,000 (under
    // 65); 40,000 − 4,552 = 35,448: everything, exactly enough.
    const { detail } = run(oneYear({ year: 2027, ages: [62], accounts: [ira("3000000"), hsa("1000000")], targetCents: "3544800" }));
    grossClose(wd(detail, 0), 30000);
    grossClose(wd(detail, 1), 10000);
    grossClose(to(detail, 0, TO.TAXABLE_INCOME), 23400);
    grossClose(to(detail, 0, TO.INCOME_TAX), 2552);
    grossClose(to(detail, 0, TO.PEN20), 2000);
    expect(sp(detail, 0, SP.SHORTFALL)).toBeLessThanOrEqual(0.02);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBeLessThanOrEqual(7);
  });
});

describe("WD-10 to WD-14: shortfall, gross years and surplus", () => {
  it("WD-10 shortfall: single 80, 2027, Social Security 24,000, pre-tax 20,000, target 60,000", () => {
    // RMD 20,000 ÷ 20.2 = 990.10; the rest, 19,009.90, is drawn; provisional income 32,000,
    // taxable benefits 0.5 × (32,000 − 25,000) = 3,500, AGI 23,500 under the deductions (16,600 +
    // 2,100 + 6,000): tax 0; funded 24,000 + 20,000 = 44,000; shortfall 16,000; the path fails.
    const { ps, detail } = run(oneYear({ year: 2027, ages: [80], accounts: [ira("2000000")], targetCents: "6000000" }), [24000]);
    close(ac(detail, 0, 0, AC.RMD), 990.1);
    close(wd(detail, 0), 19009.9);
    close(to(detail, 0, TO.TAXABLE_SS), 3500);
    close(yr(detail, 0, YR.TAX), 0);
    close(sp(detail, 0, SP.FUNDED), 44000);
    close(sp(detail, 0, SP.SHORTFALL), 16000);
    expect(yr(detail, 0, YR.FLAGS) & YEAR_FLAG.FAILED).toBe(YEAR_FLAG.FAILED);
    expect(ps.failIdx).toBe(0);
    expect(ps.flags & PATH_FLAG.SUCCESS).toBe(0);
    // net(0) < 0 and net(everything) < 0: two calls.
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(2);
  });

  // 2027, married, both 75 (born 1952); pre-tax 1,200,000 owned by one; a taxable account of
  // 100,000 at basis; Social Security 50,000; every account 50% stocks; no essentials.
  const grossHousehold = (strategy: StrategyConfigInput) =>
    run(
      buildSimInput({
        startYear: 2027,
        people: [
          { birthYear: 1952, longevity: fixed(75) },
          { birthYear: 1952, longevity: fixed(75) },
        ],
        accounts: [ira("120000000", "p1", half), taxable("10000000", "10000000", half)],
        spending: { baseAnnualCents: "10000000", essentialAnnualCents: "0" },
        strategy,
        tax: ZERO_YIELDS,
      }),
      [25000, 25000],
    );

  it("WD-11 gross year, RMD below the rule (vpw at 50% stocks): gross 75,832.60; RMD 48,780.49; taxable 27,052.11; tax 3,267.27; funded 122,565.33; nothing saved", () => {
    // P = 1,300,000; g = 0.5 × 5.0% + 0.5 × 1.9% = 3.45%, n = 25: 5.83328% → 75,832.60. RMD
    // 1,200,000 ÷ 24.6; wd = 75,832.60 − 48,780.49 = 27,052.11 from the taxable account at basis.
    // Provisional 48,780.49 + 25,000; taxable benefits 0.85 × 29,780.49 + 6,000 = 31,313.41; AGI
    // 80,093.90; deductions 33,200 + 3,400 + 12,000; taxable 31,493.90; tax 2,560 + 12% × 5,893.90.
    const { detail } = grossHousehold({ kind: "vpw" });
    close(sp(detail, 0, SP.GROSS), 75832.6);
    close(ac(detail, 0, 0, AC.RMD), 48780.49);
    close(wd(detail, 1), 27052.11);
    close(wd(detail, 0), 0);
    close(ac(detail, 0, 1, AC.GAIN), 0);
    close(yr(detail, 0, YR.TAX), 3267.27);
    close(sp(detail, 0, SP.FUNDED), 122565.33);
    close(sp(detail, 0, SP.SURPLUS), 0);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(1);
  });

  it("WD-12 gross year, RMD above the rule (3%): no withdrawal beyond the RMD; 9,780.49 saved (taxable basis + 9,780.49); funded 85,732.73", () => {
    // gross = 3% × 1,300,000 = 39,000 < RMD: wd = 0; the tax is WD-11's; net(0) = 50,000 +
    // 48,780.49 − 3,267.27 = 95,513.22; excess = 48,780.49 − 39,000 = 9,780.49 is saved, the rest
    // (85,732.73) spent.
    const { detail } = grossHousehold({ kind: "fixed_percentage", rateBp: 300 });
    close(sp(detail, 0, SP.GROSS), 39000);
    close(yr(detail, 0, YR.WITHDRAWAL_TOTAL), 0);
    close(yr(detail, 0, YR.TAX), 3267.27);
    close(sp(detail, 0, SP.SURPLUS), 9780.49);
    close(ac(detail, 0, 1, AC.SURPLUS), 9780.49);
    close(basisOf(detail, 0, 1).reduce((x, y) => x + y, 0), 109780.49);
    close(sp(detail, 0, SP.FUNDED), 85732.73);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(1);
  });

  it("WD-13 gross year with a top-up (4%): floor 50,000 keeps the rule's 40,000 (tax 3,956.00, funded 60,044.00); floor 65,000 tops up to 45,713.64 (tax 4,713.64, funded 65,000.00)", () => {
    // Single, 67 (born 1960, no RMD), 2027, Social Security 24,000, pre-tax 1,000,000. At 40,000:
    // taxable benefits min(20,400, 0.85 × 18,000 + 4,500) = 19,800; AGI 59,800; deductions 16,600 +
    // 2,100 + 6,000; taxable 35,100; tax 1,280 + 12% × 22,300 = 3,956. Floor 65,000: up to 40,705.88
    // benefits phase in, then 12%: x = 40,705.88 + (65,000 − 60,593.17) ÷ 0.88 = 45,713.64.
    for (const [floor, x, tax, funded] of [
      ["5000000", 40000, 3956, 60044],
      ["6500000", 45713.64, 4713.64, 65000],
    ] as const) {
      const { detail } = run(oneYear({ year: 2027, ages: [67], accounts: [ira("100000000")], targetCents: "8000000", essentialCents: floor, strategy: { kind: "fixed_percentage", rateBp: 400 } }), [24000]);
      close(sp(detail, 0, SP.GROSS), 40000);
      grossClose(wd(detail, 0), x);
      grossClose(yr(detail, 0, YR.TAX), tax);
      grossClose(sp(detail, 0, SP.FUNDED), funded);
      expect(yr(detail, 0, YR.FLAGS) & YEAR_FLAG.NOT_CONVERGED).toBe(0);
      // The top-up: more than the rule released (the year table's `topped_up` event, step 20).
      expect(wd(detail, 0) > 40000 + CASH_TOL).toBe(funded === 65000);
    }
  });

  it("WD-14 surplus: married, both 75, 2027, pre-tax 2,000,000, cash 5,000, Social Security 60,000, target 100,000: no withdrawal; tax 9,532.10; 31,768.72 saved to the cash account (36,768.72 after)", () => {
    // RMD 2,000,000 ÷ 24.6 = 81,300.81; taxable benefits 51,000 (the 85% cap); AGI 132,300.81;
    // taxable income 83,700.81; tax 2,560 + 12% × 58,100.81 = 9,532.10; net(0) = 60,000 + 81,300.81
    // − 9,532.10 − 100,000 = 31,768.72.
    const { detail } = run(oneYear({ year: 2027, ages: [75, 75], accounts: [ira("200000000"), cashAccount("cash", "500000")], targetCents: "10000000" }), [30000, 30000]);
    close(ac(detail, 0, 0, AC.RMD), 81300.81);
    expect(yr(detail, 0, YR.WITHDRAWAL_TOTAL)).toBe(0);
    close(to(detail, 0, TO.TAXABLE_SS), 51000);
    close(to(detail, 0, TO.AGI), 132300.81);
    close(to(detail, 0, TO.TAXABLE_INCOME), 83700.81);
    close(yr(detail, 0, YR.TAX), 9532.1);
    close(sp(detail, 0, SP.SURPLUS), 31768.72);
    close(afterTrades(detail, 0, 1)[2]!, 36768.72);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(1);
  });
});

describe("WD-17 and WD-18", () => {
  it("WD-17 a goal before retirement: married, 2026, both under 65, wages 150,000, a goal of 20,000, a taxable account of 100,000 at basis 50,000: taxable 21,621.62; added tax 1,621.62; wages pay the baseline 15,340.00", () => {
    // Baseline: 150,000 − 32,200 = 117,800 taxable, above the 98,900 gains threshold: 11,600 + 22% ×
    // 17,000 = 15,340. Half of each dollar withdrawn is gain taxed at 15%: x − 0.075x = 20,000.
    const input = buildSimInput({
      startYear: 2026,
      people: [
        { birthYear: 1970, retirementMonth: "2027-01", longevity: fixed(57) },
        { birthYear: 1970, retirementMonth: "2027-01", longevity: fixed(57) },
      ],
      accounts: [taxable("10000000", "5000000")],
      incomes: [
        {
          id: "salary",
          kind: "salary",
          personId: "p1",
          name: "salary",
          annualCents: "15000000",
          dollars: "nominal",
          startMonth: "2026-01",
          endMonth: "2027-01",
          realGrowthBp: 0,
          cola: { mode: "none" },
          survivorBp: 0,
          taxableBp: 10000,
          earned: true,
        },
      ],
      spending: { startMonth: "2027-01", goals: [{ id: "goal", name: "goal", year: 2026, amountCents: "2000000", dollars: "nominal" }] },
      tax: ZERO_YIELDS,
    });
    const { detail } = run(input);
    expect(yr(detail, 0, YR.PHASE)).toBe(0);
    grossClose(wd(detail, 0), 21621.62);
    grossClose(ac(detail, 0, 0, AC.GAIN), 10810.81);
    close(yr(detail, 0, YR.TAX_BASELINE), 15340);
    grossClose(yr(detail, 0, YR.TAX) - yr(detail, 0, YR.TAX_BASELINE), 1621.62);
    close(sp(detail, 0, SP.FUNDED), 20000);
  });

  it("WD-18 pro rata through the loop: WD-4's 65,627.27 from two IRAs of 600,000 and 200,000 is 49,220.45 and 16,406.82", () => {
    // Both in tier 4 (62, past 59½): 65,627.27 × 3/4 and × 1/4.
    const { detail } = run(oneYear({ year: 2027, ages: [62], accounts: [ira("60000000"), account("ira2", "pre_tax", "20000000", { type: "ira" })], targetCents: "6000000" }));
    grossClose(wd(detail, 0), 49220.45);
    grossClose(wd(detail, 1), 16406.82);
    expect(wd(detail, 0) / wd(detail, 1)).toBeCloseTo(3, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// R1 and R2 (reference/sheets/r1.md, r2.md): WD-5, WD-15, WD-16 and the cash identity of WD-21,
// and every withdrawal, tax and spending cell of the sheets' tables.

function expectedRows(name: string): Array<Record<string, string>> {
  const lines = readFileSync(new URL(`../../reference/fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
  const head = lines[0]!.split(",");
  return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((v, i) => [head[i]!, v])));
}

describe("R1 through the default order (r1.md)", () => {
  const { ps, detail } = run(referenceR1Input());
  // Accounts in the sheet's order: cash, taxable, pre_tax_a, pre_tax_b, roth_a.
  const t = (year: number) => year - 2027;

  it("WD-16 conversion, R1 2027: pre-tax of A 900,000 → 820,000 before returns; Roth + 80,000; tax 4,696.00 with no gains tax", () => {
    // r1.md §3: taxable income 43,400, tax 2,560 + 12% × 17,800; cash 40,000, then 82,696 from
    // the taxable account (gain 31,011, stacked from 43,400 to 74,411: under the 0% maximum).
    close(ac(detail, 0, 2, AC.CONV_OUT), 80000);
    close(afterTrades(detail, 0, 2)[0]!, 820000);
    close(afterTrades(detail, 0, 4)[0]!, 230000);
    close(yr(detail, 0, YR.TAX), 4696);
    close(to(detail, 0, TO.CG_TAX), 0);
    grossClose(wd(detail, 0), 40000);
    grossClose(wd(detail, 1), 82696);
    grossClose(ac(detail, 0, 1, AC.GAIN), 31011);
  });

  it("WD-5 R1 2028, re-derived (hand-cases.md): taxable 133,585.74; gain 54,070.42; ordinary tax 8,563.41; gains tax 3,772.33", () => {
    // Gain fraction 17/42; total tax 2,473.30 + 0.1824 g; x × (1 − 0.1824 × 17/42) = 123,723.30.
    const y = t(2028);
    grossClose(ac(detail, y, 1, AC.WITHDRAWAL), 133585.74);
    grossClose(ac(detail, y, 1, AC.GAIN), 54070.42);
    grossClose(to(detail, y, TO.ORD_TAX), 8563.41);
    grossClose(to(detail, y, TO.CG_TAX), 3772.33);
    grossClose(yr(detail, y, YR.TAX), 12335.74);
    grossClose(to(detail, y, TO.SENIOR_DEDUCTION), 8871.55);
  });

  it("WD-15 R1 2031, re-derived (hand-cases.md): the taxable account runs out; taxable 43,442.14; pre-tax 21,170.38 and 8,879.72 pro rata to 869,376.38 and 364,651.88; tax 5,560.56", () => {
    // 0.778 y = 67,931.6758 − 43,442.1430 − 1,110.5598 → y = 30,050.0938, split by the
    // start-of-year balances (no RMD before 75, so available = start).
    const y = t(2031);
    grossClose(ac(detail, y, 1, AC.WITHDRAWAL), 43442.14);
    close(ac(detail, y, 1, AC.WITHDRAWAL), ac(detail, y, 1, AC.AVAILABLE));
    grossClose(ac(detail, y, 2, AC.WITHDRAWAL), 21170.38);
    grossClose(ac(detail, y, 3, AC.WITHDRAWAL), 8879.72);
    // The start balances are exactly 869,376.375 and 364,651.875 (r1.md §2.12: printed .38 and .88).
    close(ac(detail, y, 2, AC.START), 869376.375);
    close(ac(detail, y, 3, AC.START), 364651.875);
    expect(ac(detail, y, 2, AC.WITHDRAWAL) / ac(detail, y, 3, AC.WITHDRAWAL)).toBeCloseTo(ac(detail, y, 2, AC.START) / ac(detail, y, 3, AC.START), 9);
    grossClose(yr(detail, y, YR.TAX), 5560.56);
    grossClose(to(detail, y, TO.TAXABLE_SS), 49296.25);
  });

  it("R1 every row: withdrawals by account (RMDs included), RMDs, tax, funded, surplus and end balances equal r1.expected.csv within 0.02; at most 5 assess calls a year", () => {
    const rows = expectedRows("r1.expected.csv");
    expect(rows.length).toBe(detail.rows);
    const ids = ["cash", "taxable", "pre_tax_a", "pre_tax_b", "roth_a"];
    rows.forEach((row, y) => {
      ids.forEach((id, a) => {
        grossClose(ac(detail, y, a, AC.WITHDRAWAL) + ac(detail, y, a, AC.RMD), Number(row[`wd_${id}`]));
        grossClose(endOf(detail, y, a).reduce((p, q) => p + q, 0), Number(row[`end_${id}`]));
      });
      grossClose(yr(detail, y, YR.RMD_TOTAL), Number(row.rmd_total));
      grossClose(yr(detail, y, YR.TAX), Number(row.total_federal_tax));
      grossClose(sp(detail, y, SP.FUNDED), Number(row.funded));
      grossClose(sp(detail, y, SP.SURPLUS), Number(row.surplus_saved));
      grossClose(sp(detail, y, SP.SHORTFALL), Number(row.shortfall));
      expect(yr(detail, y, YR.ASSESS_CALLS)).toBeLessThanOrEqual(5);
    });
    expect(ps.flags & PATH_FLAG.SUCCESS).toBe(PATH_FLAG.SUCCESS);
    expect(ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(0);
  });
});

describe("R2 through the default order (r2.md)", () => {
  const { ps, detail } = run(referenceR2Input());

  it("R2 every row: withdrawals by account (RMDs included), RMDs, tax, funded, surplus and end balances equal r2.expected.csv within 0.02; at most 6 assess calls a year", () => {
    const rows = expectedRows("r2.expected.csv");
    expect(rows.length).toBe(detail.rows);
    const ids = ["cash", "taxable", "pre_tax_1", "pre_tax_2", "roth_1", "roth_2", "hsa_2"];
    rows.forEach((row, y) => {
      ids.forEach((id, a) => {
        grossClose(ac(detail, y, a, AC.WITHDRAWAL) + ac(detail, y, a, AC.RMD), Number(row[`wd_${id}`]));
        grossClose(endOf(detail, y, a).reduce((p, q) => p + q, 0), Number(row[`end_${id}`]));
      });
      grossClose(yr(detail, y, YR.RMD_TOTAL), Number(row.rmd_total));
      grossClose(yr(detail, y, YR.TAX), Number(row.total_federal_tax));
      grossClose(sp(detail, y, SP.FUNDED), Number(row.funded));
      grossClose(sp(detail, y, SP.SURPLUS), Number(row.surplus_saved));
      grossClose(sp(detail, y, SP.SHORTFALL), Number(row.shortfall));
      expect(yr(detail, y, YR.ASSESS_CALLS)).toBeLessThanOrEqual(6);
    });
    expect(ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(0);
  });

  it("R2 the cash reserve: the cash account keeps 20,000 × cpi until the free sources are used (2027: cash above the reserve only)", () => {
    // r2.md 2027: cash 40,000 − 20,000 reserve = 20,000 from tier 1; the HSA 12,000 for
    // healthcare; then the taxable account.
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 20000);
    close(ac(detail, 0, 6, AC.WITHDRAWAL), 12000);
  });
});

describe("WD-21 the cash identity on R1 and R2", () => {
  it("WD-21 every row of R1 and R2: income + withdrawals (RMDs included) = tax + employee contributions + payroll tax + funded + surplus, within 0.005", () => {
    for (const input of [referenceR1Input(), referenceR2Input()]) {
      const { detail } = run(input);
      for (let y = 0; y < detail.rows; y++) {
        expect(yr(detail, y, YR.PHASE)).toBe(1);
        const sources = yr(detail, y, YR.CASH_INCOME) + yr(detail, y, YR.RMD_TOTAL) + yr(detail, y, YR.WITHDRAWAL_TOTAL);
        const uses = yr(detail, y, YR.TAX) + yr(detail, y, YR.OTHER_CHARGES) + yr(detail, y, YR.EMPLOYEE) + yr(detail, y, YR.PAYROLL) + sp(detail, y, SP.FUNDED) + sp(detail, y, SP.SURPLUS);
        expect(Math.abs(sources - uses), `year ${2027 + y}`).toBeLessThanOrEqual(0.005);
      }
    }
  });
});
