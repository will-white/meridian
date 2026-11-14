import type { SimInputAccount, SimInputSocialSecurityPerson } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { AC, SP, W, YR, ZERO_YIELDS, ac, afterTrades, basisOf, fixedModel, fixedWithdrawalHooks, runRealPath, so, sp, ti, to, yr } from "./loopTestKit.js";
import { PATH_FLAG } from "./state.js";
import { RB, RB_REC, SO, TI, TO, WN } from "./tax/layout.js";
import { account, buildSimInput, cashAccount, incomeStream } from "./testing/simInput.js";

// Build step 17: the tax area's real functions inside `assess` and the year loop (seams §2.3 and
// §2.6; C19, C21, C23, C26, C27, C36, C39; L2). Every case runs the production record
// `TAX_FUNCTIONS` through the public path: a SimInput from the builder, prepare(),
// createPathState() and simulatePath() with a PathDetail. The withdrawal hook is the reference
// order solver (cash → taxable → pre-tax → Roth → HSA) unless a case fixes the year's withdrawals
// with `fixedWithdrawalHooks`, which only decides how much leaves which account: the tax, the
// penalty bases, the Roth and HSA splits, the RMDs and the benefits are the real functions'.
//
// Unless a case says otherwise: one person, a plan from January (f = 1), the fixed model at 0%
// (so a year after 2027 has the 2027 law: F = 1 under the statutory indexing, and the senior
// deduction ends after 2028 under `current_law`), dollars within 0.005 (toBeCloseTo(x, 2)).
//
// Expected values are the tax design's (G7, G8, E1, E3 to E6, E9, E10, I1, I2, I3, J3, G5, H11)
// or are derived by hand in the comments; every derived figure was also reproduced with exact
// rationals by scratchpad/p4-loopreal/deriv.py (python3 -I), written from tax-rmd-ss §3.3 and the
// year files, not from src/.

const close = (x: number, y: number) => expect(x).toBeCloseTo(y, 2);
const closeAll = (xs: number[], ys: number[]) => {
  expect(xs.length).toBe(ys.length);
  xs.forEach((x, i) => close(x, ys[i]!));
};
const roth = (ps: { roth: Float64Array }, person: number) => Array.from(ps.roth.subarray(person * RB_REC, person * RB_REC + RB.FIRST_YEAR + 1));
const bonds = W(0, 0, 10000, 0);
const pension = (annualCents: string, personId: "p1" | "p2" = "p1", startMonth = "2026-01") =>
  incomeStream("pension", "pension", annualCents, startMonth, { personId, dollars: "nominal", cola: { mode: "none" } });
const salary = (annualCents: string, startMonth: string, endMonth?: string) =>
  incomeStream("salary", "salary", annualCents, startMonth, { personId: "p1", ...(endMonth === undefined ? {} : { endMonth }) });
/** Social Security already in pay at full retirement age, `monthly` dollars as of 2026. */
const receivingAtFra = (personId: "p1" | "p2", monthlyCents: string, startedMonth: string): SimInputSocialSecurityPerson => ({
  personId,
  mode: "receiving",
  monthlyCents,
  asOfYear: 2026,
  startedMonth,
  monthlyAtFraCents: monthlyCents,
});

describe("G7 the RMD reinvested, through the loop", () => {
  // tax-rmd-ss §3.8: single, 80, tax year 2026, pre-tax 1,000,000 on 1 January, Social Security
  // 36,000 (3,000 a month in pay since full retirement age), spending 55,000. RMD 1,000,000 ÷ 20.2
  // = 49,504.95; provisional 49,504.95 + 18,000 = 67,504.95; taxable benefits min(30,600, 0.85 ×
  // 33,504.95 + 4,500 = 32,979.21) = 30,600; AGI 80,104.95; standard 16,100 + 2,050 = 18,150;
  // senior 6,000 − 0.06 × 5,104.95 = 5,693.70; taxable 56,261.25; tax 5,800 + 0.22 × 5,861.25 =
  // 7,089.47; surplus 36,000 + 49,504.95 − 7,089.47 − 55,000 = 23,415.48, deposited at basis in the
  // surplus account (the only taxable account, seams C24).
  const input = buildSimInput({
    startYear: 2026,
    people: [{ birthYear: 1946, longevity: { mode: "fixed", age: 80 } }],
    accounts: [account("ira", "pre_tax", "100000000", { type: "ira", allocation: bonds }), account("brk", "taxable", "0", { basisCents: "0" })],
    socialSecurity: { people: [receivingAtFra("p1", "300000", "2012-01")], spousal: true, survivor: true },
    spending: { baseAnnualCents: "5500000" },
    tax: ZERO_YIELDS,
  });
  const { ps, detail } = runRealPath(input);

  it("G7 RMD 49,504.95 at the Uniform divisor 20.2; the tax input holds it, the benefits and one aged filer", () => {
    close(ac(detail, 0, 0, AC.RMD), 49504.95);
    close(ti(detail, 0, TI.TRAD_DIST), 49504.95);
    expect(ti(detail, 0, TI.SS_GROSS)).toBe(36000);
    expect(ti(detail, 0, TI.N_AGED)).toBe(1);
    expect(ti(detail, 0, TI.YEAR_FRACTION)).toBe(1);
    expect(yr(detail, 0, YR.WITHDRAWAL_TOTAL)).toBe(0);
  });

  it("G7 tax 7,089.47: taxable benefits 30,600, AGI 80,104.95, standard 18,150, senior 5,693.70, taxable income 56,261.25", () => {
    close(to(detail, 0, TO.TAXABLE_SS), 30600);
    close(to(detail, 0, TO.AGI), 80104.95);
    close(to(detail, 0, TO.STD_DEDUCTION), 18150);
    close(to(detail, 0, TO.SENIOR_DEDUCTION), 5693.7);
    close(to(detail, 0, TO.TAXABLE_INCOME), 56261.25);
    close(yr(detail, 0, YR.TAX), 7089.47);
  });

  it("G7 surplus 23,415.48 deposited in the taxable account at basis 23,415.48", () => {
    close(sp(detail, 0, SP.SURPLUS), 23415.48);
    close(ac(detail, 0, 1, AC.SURPLUS), 23415.48);
    closeAll(afterTrades(detail, 0, 1), [23415.48, 0, 0]);
    closeAll(basisOf(detail, 0, 1), [23415.48, 0, 0]);
    closeAll(afterTrades(detail, 0, 0), [0, 950495.05, 0]);
    expect(ps.flags & PATH_FLAG.SUCCESS).toBe(PATH_FLAG.SUCCESS);
  });
});

describe("G8 and C39: RMDs pro rata, then the scheduled conversion pro rata to value − RMD", () => {
  // Single, 80 (born 1946), 2026, two IRAs of 300,000 and 700,000 in bonds; two Roth IRAs of
  // 10,000 and 20,000. G8: 49,504.95 taken pro rata, 14,851.49 and 34,653.47. C39: the conversion
  // of 50,000 comes from value − RMD (285,148.51 and 665,346.53, sum 950,495.05) pro rata, 15,000
  // and 35,000, and goes into the Roth account with the largest starting balance. Tax: TRAD_DIST
  // 49,504.95 + ROTH_CONV 50,000 = AGI 99,504.95; standard 18,150; senior 6,000 − 0.06 × 24,504.95
  // = 4,529.70; taxable 76,825.25; tax 5,800 + 0.22 × 26,425.25 = 11,613.55.
  const input = (amountCents: string) =>
    buildSimInput({
      startYear: 2026,
      people: [{ birthYear: 1946, longevity: { mode: "fixed", age: 80 } }],
      accounts: [
        account("ira1", "pre_tax", "30000000", { type: "ira", allocation: bonds }),
        account("ira2", "pre_tax", "70000000", { type: "ira", allocation: bonds }),
        account("r1", "roth", "1000000", { type: "roth", rothContributionBasisCents: "1000000" }),
        account("r2", "roth", "2000000", { type: "roth", rothContributionBasisCents: "2000000" }),
        cashAccount("cash", "0"),
      ],
      rothConversions: [{ year: 2026, personId: "p1", amountCents, dollars: "nominal" }],
      tax: ZERO_YIELDS,
    });

  it("G8 RMDs 14,851.49 and 34,653.47; C39 conversions 15,000 and 35,000 into r2; tax 11,613.55", () => {
    const { ps, detail } = runRealPath(input("5000000"));
    closeAll([ac(detail, 0, 0, AC.RMD), ac(detail, 0, 1, AC.RMD)], [14851.49, 34653.47]);
    closeAll([ac(detail, 0, 0, AC.CONV_OUT), ac(detail, 0, 1, AC.CONV_OUT)], [15000, 35000]);
    closeAll([ac(detail, 0, 2, AC.CONV_IN), ac(detail, 0, 3, AC.CONV_IN)], [0, 50000]);
    closeAll([afterTrades(detail, 0, 0)[1]!, afterTrades(detail, 0, 1)[1]!], [270148.51, 630346.53]);
    close(afterTrades(detail, 0, 3)[0]!, 70000);
    close(ti(detail, 0, TI.TRAD_DIST), 49504.95);
    close(ti(detail, 0, TI.ROTH_CONV), 50000);
    expect(ti(detail, 0, TI.PEN10_BASE)).toBe(0);
    close(to(detail, 0, TO.AGI), 99504.95);
    close(to(detail, 0, TO.SENIOR_DEDUCTION), 4529.7);
    close(yr(detail, 0, YR.TAX), 11613.55);
    // The conversion joins the person's Roth record as this year's layer (CONV4).
    closeAll(roth(ps, 0), [30000, 0, 0, 0, 0, 50000, 2021]);
  });

  it("C39 a conversion above value − RMD takes what the RMDs leave (950,495.05); the RMDs are unchanged", () => {
    const { detail } = runRealPath(input("100000000"));
    closeAll([ac(detail, 0, 0, AC.RMD), ac(detail, 0, 1, AC.RMD)], [14851.49, 34653.47]);
    close(yr(detail, 0, YR.CONVERSIONS), 950495.05);
    closeAll([ac(detail, 0, 0, AC.CONV_OUT), ac(detail, 0, 1, AC.CONV_OUT)], [285148.51, 665346.53]);
    closeAll([afterTrades(detail, 0, 0)[1]!, afterTrades(detail, 0, 1)[1]!], [0, 0]);
    close(ti(detail, 0, TI.ROTH_CONV), 950495.05);
  });
});

describe("E1 an early pre-tax withdrawal, through the loop and the solver", () => {
  // Single, born January 1971 (55 all of 2026: earlyFrac 1), salary 100,000 paid January to June
  // (50,000), retired July 2026, payroll tax on: 6.2% + 1.45% of 50,000 = 3,825.00, outside the
  // federal tax (C27). IRA withdrawal 20,000: AGI 70,000; taxable 53,900; 5,800 + 22% × 3,500 =
  // 6,570; additional tax 2,000; total 8,570.00. The spending that makes w = 20,000 the solver's
  // root: net = 50,000 + 20,000 − 3,825 − 8,570 − need = 0 → need 57,605. From a 401(k) after
  // separating in 2026 at 55: base 0, tax 6,570.00, need 59,605.
  const input = (type: "ira" | "401k", needCents: string) =>
    buildSimInput({
      startYear: 2026,
      people: [{ birthYear: 1971, retirementMonth: "2026-07", longevity: { mode: "fixed", age: 55 } }],
      accounts: [account("pre", "pre_tax", "10000000", { type, allocation: bonds }), cashAccount("cash", "0")],
      incomes: [salary("10000000", "2026-01", "2026-07")],
      spending: { baseAnnualCents: needCents },
    });

  it("E1 IRA: the solver takes 20,000; base 20,000; tax 8,570.00 (AGI 70,000, taxable 53,900, additional 2,000); payroll 3,825.00", () => {
    const { ps, detail } = runRealPath(input("ira", "5760500"));
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 20000);
    close(ti(detail, 0, TI.WAGES), 50000);
    close(ti(detail, 0, TI.PEN10_BASE), 20000);
    close(to(detail, 0, TO.AGI), 70000);
    close(to(detail, 0, TO.TAXABLE_INCOME), 53900);
    close(to(detail, 0, TO.PEN10), 2000);
    close(yr(detail, 0, YR.TAX), 8570);
    close(yr(detail, 0, YR.PAYROLL), 3825);
    expect(Math.abs(yr(detail, 0, YR.NET))).toBeLessThanOrEqual(0.005);
    expect(ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(0);
    close(ps.wn[WN.EARLY_PENALTY]!, 2000);
  });

  it("E1 401(k) after separating at 55: base 0, tax 6,570.00, the solver again at 20,000", () => {
    const { detail } = runRealPath(input("401k", "5960500"));
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 20000);
    expect(ti(detail, 0, TI.PEN10_BASE)).toBe(0);
    close(yr(detail, 0, YR.TAX), 6570);
  });
});

describe("E3 separation at 55, through the loop", () => {
  // A 30,000 withdrawal at earlyFrac 1 (59½ is in 2029 or later). Born 1970, retired March 2026
  // (the year of 56): in 2027, at 57, a 401(k) has base 0, an IRA 30,000 (additional tax 3,000).
  // Retired in 2023 at 53: the 401(k) base is 30,000. Born 1971 and retiring in March 2027: a
  // withdrawal in 2026, before retiring, has base 30,000 (the design's 2025 withdrawal moved to the
  // plan's first year); the same withdrawal in 2027 has base 0.
  const base = (type: "ira" | "401k", birthYear: number, retirementMonth: string, t: number) => {
    const input = buildSimInput({
      startYear: 2026,
      people: [{ birthYear, retirementMonth, longevity: { mode: "fixed", age: 2027 - birthYear } }],
      accounts: [account("pre", "pre_tax", "10000000", { type, allocation: bonds }), cashAccount("cash", "0")],
      spending: { startMonth: "2026-01" },
    });
    const { detail } = runRealPath(input, { hooks: fixedWithdrawalHooks({ [t]: [30000, 0] }) });
    close(ac(detail, t, 0, AC.WITHDRAWAL), 30000);
    return [ti(detail, t, TI.PEN10_BASE), to(detail, t, TO.PEN10)];
  };

  it("E3 401(k) 0 and IRA 30,000 (3,000) after separating in the year of 56; 401(k) 30,000 after separating at 53", () => {
    closeAll(base("401k", 1970, "2026-03", 1), [0, 0]);
    closeAll(base("ira", 1970, "2026-03", 1), [30000, 3000]);
    closeAll(base("401k", 1970, "2023-06", 1), [30000, 3000]);
  });

  it("E3 before the separation year the 401(k) base is 30,000; from it, 0", () => {
    closeAll(base("401k", 1971, "2027-03", 0), [30000, 3000]);
    closeAll(base("401k", 1971, "2027-03", 1), [0, 0]);
  });
});

describe("E4 and E5 the Roth ordering on the person's record, through the loop", () => {
  // E4 through the loop. The design's state (basis 30,000, a 2024 conversion of 20,000 already in
  // the basis, a 2028 conversion of 15,000 still a layer) cannot exist in a plan that starts in 2026,
  // so the seasoned conversion is part of the entered basis (50,000) and the layer is this year's
  // scheduled conversion of 15,000 from the person's IRA, which step 3b applies before the
  // withdrawal is priced. The account is older than five years (FIRST_YEAR 2021 by seeding). Born
  // January 1976 (50, earlyFrac 1); wages 35,000 take the place of the design's 50,000 because the
  // conversion is ordinary income too. A Roth withdrawal of 70,000: 50,000 from basis, 15,000 from
  // the layer, 5,000 of earnings; taxable 5,000; base 20,000. AGI 35,000 + 15,000 + 5,000 = 55,000;
  // taxable 38,900; 1,240 + 12% × 26,500 = 4,420; additional 2,000; total 6,420.00 (E4's).
  // E5(c): born January 1967 (59½ in July 2026, earlyFrac 0.5): taxable 2,500, base 10,000; AGI
  // 52,500; taxable 36,400; 1,240 + 12% × 24,000 = 4,120; additional 1,000; total 5,120.00.
  const input = (birthYear: number) =>
    buildSimInput({
      startYear: 2026,
      people: [{ birthYear, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 2026 - birthYear } }],
      accounts: [
        account("ira", "pre_tax", "1500000", { type: "ira", allocation: bonds }),
        account("roth", "roth", "10000000", { type: "roth", rothContributionBasisCents: "5000000" }),
        cashAccount("cash", "0"),
      ],
      incomes: [salary("3500000", "2026-01")],
      rothConversions: [{ year: 2026, personId: "p1", amountCents: "1500000", dollars: "nominal" }],
      spending: { startMonth: "2026-01" },
    });
  const hooks = fixedWithdrawalHooks({ 0: [0, 70000, 0] });

  it("E4 taxable 5,000, base 20,000, tax 6,420.00; the record keeps FIRST_YEAR 2021 and is emptied by the withdrawal", () => {
    const { ps, detail } = runRealPath(input(1976), { hooks });
    close(ac(detail, 0, 0, AC.CONV_OUT), 15000);
    close(ac(detail, 0, 1, AC.CONV_IN), 15000);
    close(ti(detail, 0, TI.WAGES), 35000);
    close(ti(detail, 0, TI.ROTH_CONV), 15000);
    close(ti(detail, 0, TI.ROTH_TAXABLE), 5000);
    close(ti(detail, 0, TI.PEN10_BASE), 20000);
    close(to(detail, 0, TO.AGI), 55000);
    close(to(detail, 0, TO.TAXABLE_INCOME), 38900);
    close(yr(detail, 0, YR.TAX), 6420);
    // Payroll tax 7.65% of 35,000 is its own line (C27).
    close(yr(detail, 0, YR.PAYROLL), 2677.5);
    closeAll(roth(ps, 0), [0, 0, 0, 0, 0, 0, 2021]);
  });

  it("E5(c) 59½ in July: taxable 2,500, base 10,000, tax 5,120.00", () => {
    const { detail } = runRealPath(input(1967), { hooks });
    close(ti(detail, 0, TI.ROTH_TAXABLE), 2500);
    close(ti(detail, 0, TI.PEN10_BASE), 10000);
    close(yr(detail, 0, YR.TAX), 5120);
  });
});

describe("E6 and E7 the five-year clock and the roll, through the loop", () => {
  // Born January 1969 (59½ in July 2028; earlyFrac 0 from 2029), plan 2027 to 2032, a pension of
  // 30,000, an IRA of 40,000 converted in 2027 into a Roth that had no balance (FIRST_YEAR becomes
  // 2027), stocks +25% in 2027 only: the Roth holds 50,000 from the end of 2027. Withdrawing all of
  // it in 2030 (61): 40,000 from the 2027 layer and 10,000 of earnings; the clock is not met (2030 <
  // 2032), so taxable 10,000, base 0; the 2030 law is 2027's (F = 1): 30,000 + 10,000 − 16,600 =
  // 23,400; 1,280 + 12% × 10,600 = 2,552.00. In 2032 the roll has moved the layer into the basis
  // (E7: a conversion of year Y joins BASIS_FREE on 1 January Y + 5) and the clock is met: taxable
  // 0; 1,280 + 12% × 600 = 1,352.00. The conversion year: 30,000 + 40,000 − 16,600 = 53,400; 5,987 +
  // 22% × 1,375 = 6,289.50.
  const input = buildSimInput({
    people: [{ birthYear: 1969, longevity: { mode: "fixed", age: 63 } }],
    accounts: [
      account("ira", "pre_tax", "4000000", { type: "ira", allocation: bonds }),
      account("roth", "roth", "0", { type: "roth", rothContributionBasisCents: "0" }),
      cashAccount("cash", "10000000"),
    ],
    incomes: [pension("3000000", "p1", "2027-01")],
    rothConversions: [{ year: 2027, personId: "p1", amountCents: "4000000", dollars: "nominal" }],
    returnModel: fixedModel([0.25, 0, 0, 0], [0, 0, 0, 0]),
  });

  it("E6 the conversion year: ROTH_CONV 40,000, tax 6,289.50; the Roth holds 50,000 at the end of 2027", () => {
    const { detail } = runRealPath(input);
    close(ti(detail, 0, TI.ROTH_CONV), 40000);
    close(yr(detail, 0, YR.TAX), 6289.5);
    close(ac(detail, 1, 1, AC.START), 50000);
  });

  it("E6 all 50,000 withdrawn in 2030: taxable 10,000, base 0, tax 2,552.00", () => {
    const { ps, detail } = runRealPath(input, { hooks: fixedWithdrawalHooks({ 3: [0, 50000, 0] }) });
    close(ac(detail, 3, 1, AC.WITHDRAWAL), 50000);
    close(ti(detail, 3, TI.ROTH_TAXABLE), 10000);
    expect(ti(detail, 3, TI.PEN10_BASE)).toBe(0);
    close(yr(detail, 3, YR.TAX), 2552);
    closeAll(roth(ps, 0), [0, 0, 0, 0, 0, 0, 2027]);
  });

  it("E6 the same withdrawal in 2032: taxable 0, tax 1,352.00", () => {
    const { detail } = runRealPath(input, { hooks: fixedWithdrawalHooks({ 5: [0, 50000, 0] }) });
    expect(ti(detail, 5, TI.ROTH_TAXABLE)).toBe(0);
    close(yr(detail, 5, YR.TAX), 1352);
  });

  it("E7 with no withdrawal the 2027 layer rolls one slot a year and is in BASIS_FREE on 1 January 2032", () => {
    const { ps } = runRealPath(input);
    closeAll(roth(ps, 0), [40000, 0, 0, 0, 0, 0, 2027]);
  });
});

describe("E9 the HSA split with the year's qualified medical spending, through the loop", () => {
  // A withdrawal of 10,000 with qualified medical spending of 6,000 (a healthcare entry included in
  // base spending: the HSA's cap is the entered amount either way, C35): taxable 4,000.
  // (a) 60 (born January 1966, earlyFrac65 1), wages 50,000: AGI 54,000; taxable 37,900; 1,240 + 12%
  //     × 25,500 = 4,300; additional 20% × 4,000 = 800; total 5,100.00.
  // (b) 66 (born January 1960) with a pension of 50,000: standard 18,150; senior 6,000; taxable
  //     29,850; 1,240 + 12% × 17,450 = 3,334.00; no additional tax.
  // (c) 65 in July 2026 (born July 1961, earlyFrac65 0.5), the pension of (b): base 2,000; 3,334 +
  //     400 = 3,734.00 (aged at the year end).
  const hsaInput = (birthYear: number, birthMonth: number, o: { wages?: boolean; preFrom: string; medicareFrom: string }) =>
    buildSimInput({
      startYear: 2026,
      people: [{ birthYear, birthMonth, retirementMonth: o.wages === true ? "2027-01" : "2026-01", longevity: { mode: "fixed", age: 2026 - birthYear } }],
      accounts: [account("hsa", "hsa", "2000000"), cashAccount("cash", "0")],
      incomes: [o.wages === true ? salary("5000000", "2026-01") : pension("5000000")],
      spending: {
        startMonth: "2026-01",
        healthcare: [
          { personId: "p1", preMedicareAnnualCents: "600000", preMedicareFrom: o.preFrom, medicareFrom: o.medicareFrom, medicareAnnualCents: "600000", realGrowthBp: 0, inBase: true },
        ],
      },
    });
  const hooks = fixedWithdrawalHooks({ 0: [10000, 0] });

  it("E9(a) at 60 with wages: taxable 4,000, base 4,000, tax 5,100.00", () => {
    const { detail } = runRealPath(hsaInput(1966, 1, { wages: true, preFrom: "2026-01", medicareFrom: "2031-01" }), { hooks });
    close(sp(detail, 0, SP.HEALTHCARE), 6000);
    close(ti(detail, 0, TI.HSA_TAXABLE), 4000);
    close(ti(detail, 0, TI.PEN20_BASE), 4000);
    close(to(detail, 0, TO.PEN20), 800);
    close(yr(detail, 0, YR.TAX), 5100);
  });

  it("E9(b) at 66 with a pension: taxable 4,000, no base, tax 3,334.00", () => {
    const { detail } = runRealPath(hsaInput(1960, 1, { preFrom: "2025-01", medicareFrom: "2025-01" }), { hooks });
    close(ti(detail, 0, TI.HSA_TAXABLE), 4000);
    expect(ti(detail, 0, TI.PEN20_BASE)).toBe(0);
    close(to(detail, 0, TO.STD_DEDUCTION), 18150);
    close(to(detail, 0, TO.SENIOR_DEDUCTION), 6000);
    close(yr(detail, 0, YR.TAX), 3334);
  });

  it("E9(c) 65 in July: base 2,000, tax 3,734.00", () => {
    const { detail } = runRealPath(hsaInput(1961, 7, { preFrom: "2026-01", medicareFrom: "2026-07" }), { hooks });
    close(sp(detail, 0, SP.HEALTHCARE), 6000);
    close(ti(detail, 0, TI.PEN20_BASE), 2000);
    close(yr(detail, 0, YR.TAX), 3734);
  });
});

describe("E10 a scheduled conversion of a married couple, through the loop", () => {
  // Married filing jointly, both born January 1964 (62), 2026, a pension of 30,000: tax 0 (below the
  // joint standard deduction of 32,200). With a 60,000 conversion of person 0's IRA into person 0's
  // Roth: AGI 90,000; taxable 57,800; 2,480 + 12% × 33,000 = 6,440.00; no additional tax (a
  // conversion never enters a penalty base); CONV4 60,000 and FIRST_YEAR 2026 in person 0's record.
  const input = (conversions: boolean) =>
    buildSimInput({
      startYear: 2026,
      people: [
        { birthYear: 1964, longevity: { mode: "fixed", age: 62 } },
        { birthYear: 1964, longevity: { mode: "fixed", age: 62 } },
      ],
      accounts: [
        account("ira", "pre_tax", "10000000", { type: "ira", allocation: bonds }),
        account("roth", "roth", "0", { type: "roth", rothContributionBasisCents: "0" }),
        cashAccount("cash", "0"),
      ],
      incomes: [pension("3000000")],
      rothConversions: conversions ? [{ year: 2026, personId: "p1", amountCents: "6000000", dollars: "nominal" }] : [],
    });

  it("E10 without the conversion the tax is 0", () => {
    const { detail } = runRealPath(input(false));
    expect(yr(detail, 0, YR.FILING_STATUS)).toBe(1);
    expect(yr(detail, 0, YR.TAX)).toBe(0);
  });

  it("E10 with it: ROTH_CONV 60,000, no base, tax 6,440.00, CONV4 60,000", () => {
    const { ps, detail } = runRealPath(input(true));
    close(ti(detail, 0, TI.ROTH_CONV), 60000);
    expect(ti(detail, 0, TI.PEN10_BASE)).toBe(0);
    close(to(detail, 0, TO.AGI), 90000);
    close(to(detail, 0, TO.TAXABLE_INCOME), 57800);
    close(yr(detail, 0, YR.TAX), 6440);
    closeAll(roth(ps, 0), [0, 0, 0, 0, 0, 60000, 2026]);
    closeAll(roth(ps, 1), [0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("C23 the partial first year is scaled once, inside the functions", () => {
  // Year 0 hands every function the period's amounts and f in TI.YEAR_FRACTION; nothing in the loop
  // divides by f before a call or multiplies a result by f after it.
  // J3(a): single, 49 (born 1977: under 50, so no catch-up; the profile's fixed age is at least 50,
  // hence not J3's 40, which changes nothing below 65), from October 2026 (f = 3/12), salary 100,000
  // a year: wages 25,000; tax 13,170
  // × 3/12 = 3,292.50; AGI 25,000; standard 16,100 × 3/12 = 4,025. Payroll f × payroll(100,000) =
  // 7,650 × 3/12 = 1,912.50. Scaled twice the year would show 25,783.56 (the inputs annualized
  // before the call as well: 3/12 × Tax(400,000)) or 823.13 (the result multiplied by f again).
  // 2027 is a full year: 100,000 − 16,600 = 83,400; 5,987 + 22% × 31,375 = 12,889.50; payroll 7,650.
  const salaryInput = (startMonth: number, annualCents: string, o: { contribution?: boolean } = {}) =>
    buildSimInput({
      startYear: 2026,
      startMonth,
      people: [{ birthYear: 1977, retirementMonth: "2028-01", longevity: { mode: "fixed", age: 50 } }],
      accounts: [account("401k", "pre_tax", "0", { type: "401k" }), cashAccount("cash", "0")],
      incomes: [salary(annualCents, `2026-${String(startMonth).padStart(2, "0")}`)],
      contributions: o.contribution === true ? [{ accountId: "401k", employeeAnnualCents: "3000000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: annualCents, endMonth: "2028-01" }] : [],
      spending: { startMonth: "2028-01" },
    });

  it("C23 J3(a) through the loop: wages 25,000 and f 0.25 in the input, tax 3,292.50, AGI 25,000, standard 4,025, payroll 1,912.50", () => {
    const { detail } = runRealPath(salaryInput(10, "10000000"));
    expect(yr(detail, 0, YR.YEAR_FRACTION)).toBe(0.25);
    expect(ti(detail, 0, TI.YEAR_FRACTION)).toBe(0.25);
    close(ti(detail, 0, TI.WAGES), 25000);
    close(yr(detail, 0, YR.TAX), 3292.5);
    close(to(detail, 0, TO.AGI), 25000);
    close(to(detail, 0, TO.STD_DEDUCTION), 4025);
    close(yr(detail, 0, YR.PAYROLL), 1912.5);
    // Accumulation: wages pay the tax; the record equals the baseline.
    close(yr(detail, 0, YR.TAX_BASELINE), 3292.5);
    expect(yr(detail, 0, YR.NET)).toBe(0);
    // 2027, a full year.
    expect(ti(detail, 1, TI.YEAR_FRACTION)).toBe(1);
    close(ti(detail, 1, TI.WAGES), 100000);
    close(yr(detail, 1, YR.TAX), 12889.5);
    close(yr(detail, 1, YR.PAYROLL), 7650);
  });

  it("C23 J3(b) from November (f = 2/12): wages 16,666.67, tax 2,195.00; I1's year 0: wages 20,000 of 120,000 a year pay 9,180 × 2/12 = 1,530.00", () => {
    const b = runRealPath(salaryInput(11, "10000000"));
    close(ti(b.detail, 0, TI.WAGES), 16666.67);
    close(yr(b.detail, 0, YR.TAX), 2195);
    const i1 = runRealPath(salaryInput(11, "12000000"));
    close(ti(i1.detail, 0, TI.WAGES), 20000);
    close(yr(i1.detail, 0, YR.PAYROLL), 1530);
  });

  it("C23 the deferral limit of year 0 is 24,500 × 3/12 = 6,125: 7,500 deferred is cut, 1,375 saved after tax; wages for tax 18,875; tax 3/12 × Tax(75,500) = 1,945.00", () => {
    // The contribution scales with the salary paid in the period: 30,000 × 25,000 ÷ 100,000 = 7,500.
    // 3/12 × (5,800 + 22% × (75,500 − 16,100 − 50,400)) = 3/12 × 7,780 = 1,945.00.
    const { ps, detail } = runRealPath(salaryInput(10, "10000000", { contribution: true }));
    closeAll([ac(detail, 0, 0, AC.DEPOSIT), ac(detail, 0, 1, AC.DEPOSIT)], [6125, 1375]);
    close(yr(detail, 0, YR.CONTRIBUTION_EXCESS), 1375);
    close(ti(detail, 0, TI.WAGES), 18875);
    close(yr(detail, 0, YR.TAX), 1945);
    close(ps.wn[WN.CONTRIBUTION_CAPPED]!, 1375);
  });

  it("C23 G5 the RMD of year 0 is f × the full-year amount once: 500,000 at 75 is 3,387.53 (f = 2/12) and 5,081.30 (f = 3/12)", () => {
    const rmd = (startMonth: number) => {
      const { detail } = runRealPath(
        buildSimInput({
          startYear: 2026,
          startMonth,
          people: [{ birthYear: 1951, longevity: { mode: "fixed", age: 75 } }],
          accounts: [account("ira", "pre_tax", "50000000", { type: "ira", allocation: bonds }), cashAccount("cash", "0")],
        }),
      );
      expect(ti(detail, 0, TI.TRAD_DIST)).toBe(ac(detail, 0, 0, AC.RMD));
      return ac(detail, 0, 0, AC.RMD);
    };
    close(rmd(11), 3387.53);
    close(rmd(10), 5081.3);
  });

  it("C23 E2 the penalty share of year 0 counts the period's months: November and December 2026, 59½ in December (born June 1967), a 10,000 IRA withdrawal has base 5,000 and additional tax 500", () => {
    // earlyFraction(59½ = December 2026, periodStart November 2026, 2 months) = 1/2 (tax-rmd-ss §3.7.1);
    // the base is the period's 5,000 and the 10% of it is not scaled by f again.
    const { detail } = runRealPath(
      buildSimInput({
        startYear: 2026,
        startMonth: 11,
        people: [{ birthYear: 1967, birthMonth: 6, longevity: { mode: "fixed", age: 59 } }],
        accounts: [account("ira", "pre_tax", "10000000", { type: "ira", allocation: bonds }), cashAccount("cash", "0")],
      }),
      { hooks: fixedWithdrawalHooks({ 0: [10000, 0] }) },
    );
    close(ti(detail, 0, TI.TRAD_DIST), 10000);
    close(ti(detail, 0, TI.PEN10_BASE), 5000);
    close(to(detail, 0, TO.PEN10), 500);
  });

  it("C23 H11 Social Security of year 0 is the months in the plan: 1,400 a month since June 2026, a plan from November pays 2,800, not seven months × f", () => {
    const { detail } = runRealPath(
      buildSimInput({
        startYear: 2026,
        startMonth: 11,
        people: [{ birthYear: 1964, birthMonth: 6, longevity: { mode: "fixed", age: 62 } }],
        socialSecurity: { people: [{ personId: "p1", mode: "receiving", monthlyCents: "140000", asOfYear: 2026, startedMonth: "2026-06" }], spousal: true, survivor: true },
      }),
    );
    expect(so(detail, 0, SO.BENEFIT)).toBe(2800);
    expect(so(detail, 0, SO.MONTHS_PAID)).toBe(2);
    expect(ti(detail, 0, TI.SS_GROSS)).toBe(2800);
    close(yr(detail, 0, YR.CASH_INCOME), 2800);
  });
});

describe("C21 a claim in the middle of a year, through the loop", () => {
  // H11: born June 1964, full retirement age 67, PIA 2,000 as of 2026, claim at 62 in June 2026
  // (factor 7/10): 2026 pays June to December, 7 × 1,400 = 9,800 (not 12 × 1,400). With a pension
  // of 30,000: provisional 30,000 + 4,900 = 34,900; tier 1 min(4,900, 4,950, 4,500) = 4,500; taxable
  // benefits min(8,330, 0.85 × 900 + 4,500) = 5,265; AGI 35,265; taxable 19,165; 1,240 + 12% × 6,765
  // = 2,051.80 (twelve months would give 2,408.80). 2027: the published COLA of 3.6% gives a PIA of
  // 2,072.00, own 1,450.40, paid 1,450 a month: 17,400; provisional 38,700; taxable benefits
  // min(14,790, 0.85 × 4,700 + 4,500) = 8,495; AGI 38,495; taxable 21,895; 1,280 + 12% × 9,095 =
  // 2,371.40.
  const input = buildSimInput({
    startYear: 2026,
    people: [{ birthYear: 1964, birthMonth: 6, longevity: { mode: "fixed", age: 63 } }],
    incomes: [pension("3000000")],
    socialSecurity: {
      people: [{ personId: "p1", mode: "estimate", monthlyAtFraCents: "200000", asOfYear: 2026, claimMonth: "2026-06", claimAgeMonths: 744 }],
      spousal: true,
      survivor: true,
    },
  });
  const { detail } = runRealPath(input);

  it("C21 2026: seven months, 9,800 in the tax input as it is; taxable benefits 5,265; tax 2,051.80", () => {
    expect(so(detail, 0, SO.MONTHS_PAID)).toBe(7);
    expect(so(detail, 0, SO.BENEFIT)).toBe(9800);
    expect(ti(detail, 0, TI.SS_GROSS)).toBe(9800);
    close(yr(detail, 0, YR.CASH_INCOME), 39800);
    close(to(detail, 0, TO.TAXABLE_SS), 5265);
    close(to(detail, 0, TO.AGI), 35265);
    close(yr(detail, 0, YR.TAX), 2051.8);
  });

  it("C21 2027: twelve months at 1,450 after the published COLA, 17,400; tax 2,371.40", () => {
    expect(so(detail, 1, SO.MONTHS_PAID)).toBe(12);
    expect(so(detail, 1, SO.BENEFIT)).toBe(17400);
    close(to(detail, 1, TO.TAXABLE_SS), 8495);
    close(yr(detail, 1, YR.TAX), 2371.4);
  });
});

describe("C26 the contribution caps on the real 2026 limits", () => {
  // Born January 1965 (61 in 2026), salary 200,000, accumulation. tax-rmd-ss §3.10 with the 2026
  // year file (I2, I3): deferral 24,500 + 11,250 (60 to 63) = 35,750, so of the 401(k)'s employee
  // 40,000 4,250 is excess; annual additions 72,000 less the employee amount without catch-up
  // (24,500) leaves 47,500 for the employer's 40,000; IRA 7,500 + 1,100 (50 and over) = 8,600, so of
  // the Roth IRA's 10,000 1,400 is excess (the household's wages are far above it); HSA family
  // 8,750 + 1,000 (55 and over) × 12 months before 65 = 9,750, so of 12,000 2,250 is excess. The
  // employee excess, 7,900, is saved after tax in the cash account (C26); wages for tax 200,000 −
  // 35,750 − 9,750 = 154,500 (the Roth IRA and the excess do not reduce them); taxable 138,400;
  // 17,966 + 24% × 32,700 = 25,814.00. Payroll on gross wages: 6.2% × 184,500 + 1.45% × 200,000 =
  // 14,339.00. With an employer amount of 50,000, 2,500 above the room is dropped. SECURE 2.0's Roth
  // catch-up rule would make the 11,250 Roth for this 200,000 earner; it is not modelled
  // (notModelled `roth_catch_up`, pinned in tax/notModelled.test.ts on this case).
  const input = (employerCents: string) =>
    buildSimInput({
      startYear: 2026,
      people: [{ birthYear: 1965, retirementMonth: "2030-01", longevity: { mode: "fixed", age: 61 } }],
      accounts: [
        account("401k", "pre_tax", "0", { type: "401k" }),
        account("rira", "roth", "0", { type: "roth", rothContributionBasisCents: "0" }),
        account("hsa", "hsa", "0"),
        cashAccount("cash", "0"),
      ],
      incomes: [salary("20000000", "2026-01", "2030-01")],
      contributions: [
        { accountId: "401k", employeeAnnualCents: "4000000", employerAnnualCents: employerCents, scaleWith: "p1", salaryBasisCents: "20000000", endMonth: "2030-01" },
        { accountId: "rira", employeeAnnualCents: "1000000", employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2030-01" },
        { accountId: "hsa", employeeAnnualCents: "1200000", employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2030-01" },
      ],
      spending: { startMonth: "2030-01" },
    });

  it("C26 deposits 75,750 / 8,600 / 9,750 and the 7,900 excess in cash; wages for tax 154,500; tax 25,814.00; payroll 14,339.00", () => {
    const { ps, detail } = runRealPath(input("4000000"));
    closeAll([0, 1, 2, 3].map((a) => ac(detail, 0, a, AC.DEPOSIT)), [75750, 8600, 9750, 7900]);
    close(yr(detail, 0, YR.EMPLOYEE), 62000);
    close(yr(detail, 0, YR.EMPLOYER), 40000);
    close(yr(detail, 0, YR.CONTRIBUTION_EXCESS), 7900);
    close(ti(detail, 0, TI.WAGES), 154500);
    close(yr(detail, 0, YR.TAX), 25814);
    close(yr(detail, 0, YR.PAYROLL), 14339);
    close(ps.wn[WN.CONTRIBUTION_CAPPED]!, 7900);
    closeAll(roth(ps, 0), [8600, 0, 0, 0, 0, 0, 2026]);
  });

  it("C26 an employer amount of 50,000 is cut to the 47,500 of room; the 2,500 is dropped, not saved", () => {
    const { ps, detail } = runRealPath(input("5000000"));
    close(ac(detail, 0, 0, AC.DEPOSIT), 35750 + 47500);
    close(yr(detail, 0, YR.EMPLOYER), 47500);
    close(ac(detail, 0, 3, AC.DEPOSIT), 7900);
    close(ps.wn[WN.CONTRIBUTION_CAPPED]!, 10400);
  });
});

describe("tax-02: a married couple shares one family HSA limit; each spouse adds their own catch-up from 55", () => {
  // Pub. 969 (2025), "Rules for married people": "If either spouse has family HDHP coverage, both
  // spouses are treated as having family HDHP coverage ... the contribution limit is split equally
  // between the spouses unless you agree on a different division"; "If both spouses are 55 or older
  // ... each spouse's contribution limit is increased by the additional contribution" (§ 223(b)(5),
  // (b)(3)). The planner assumes family coverage (it does not know the tier) and divides the family
  // limit in proportion to the amounts the household entered, its own division. Two spouses with
  // HSA contributions are both eligible individuals; a spouse who contributes nothing leaves the
  // whole family limit to the other.
  const couple = (birthYear: number, cents: [string, string]) =>
    buildSimInput({
      startYear: 2026,
      people: [
        { birthYear, retirementMonth: "2030-01", longevity: { mode: "fixed", age: 2031 - birthYear } },
        { birthYear, retirementMonth: "2030-01", longevity: { mode: "fixed", age: 2031 - birthYear } },
      ],
      accounts: [account("hsa1", "hsa", "0", { owner: "p1" }), account("hsa2", "hsa", "0", { owner: "p2" }), cashAccount("cash", "0")],
      incomes: [
        incomeStream("s1", "salary", "10000000", "2026-01", { personId: "p1", endMonth: "2030-01" }),
        incomeStream("s2", "salary", "10000000", "2026-01", { personId: "p2", endMonth: "2030-01" }),
      ],
      contributions: [
        { accountId: "hsa1", employeeAnnualCents: cents[0], employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2030-01" },
        { accountId: "hsa2", employeeAnnualCents: cents[1], employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2030-01" },
      ],
      spending: { startMonth: "2030-01" },
    });

  it("tax-02 both 45, 8,750 each in 2026: the deposits sum to the family 8,750, the other 8,750 is saved after tax; wages for tax 191,250; tax 24,415.00", () => {
    // Each 8,750 × 8,750 / 17,500 = 4,375. Wages 200,000 − 8,750 = 191,250; taxable 191,250 − 32,200
    // = 159,050; 11,600 + 22% × (159,050 − 100,800) = 11,600 + 12,815 = 24,415.00. (Before the fix
    // each spouse deferred 8,750: wages 182,500, tax 22,490.00.)
    const { ps, detail } = runRealPath(couple(1981, ["875000", "875000"]));
    closeAll([0, 1, 2].map((a) => ac(detail, 0, a, AC.DEPOSIT)), [4375, 4375, 8750]);
    close(yr(detail, 0, YR.CONTRIBUTION_EXCESS), 8750);
    close(ti(detail, 0, TI.WAGES), 191250);
    close(yr(detail, 0, YR.TAX), 24415);
    close(ps.wn[WN.CONTRIBUTION_CAPPED]!, 8750);
  });

  it("tax-02 both 56, 8,750 each in 2026: 8,750 shared plus 1,000 each, 10,750 in all; wages for tax 189,250; tax 23,975.00", () => {
    // Each spouse's limit 8,750 + 1,000 = 9,750 holds the 8,750; the parts above the catch-ups,
    // 7,750 + 7,750 = 15,500, share the family 8,750: 4,375 each, plus 1,000 each = 5,375 each.
    // Excess 17,500 − 10,750 = 6,750. Wages 200,000 − 10,750 = 189,250; taxable 157,050;
    // 11,600 + 22% × 56,250 = 23,975.00.
    const { detail } = runRealPath(couple(1970, ["875000", "875000"]));
    closeAll([0, 1, 2].map((a) => ac(detail, 0, a, AC.DEPOSIT)), [5375, 5375, 6750]);
    close(ti(detail, 0, TI.WAGES), 189250);
    close(yr(detail, 0, YR.TAX), 23975);
  });

  it("tax-02 a division the household entered is kept: 6,000 and 1,000 at 45 fit the family 8,750 in full", () => {
    const { detail } = runRealPath(couple(1981, ["600000", "100000"]));
    closeAll([0, 1, 2].map((a) => ac(detail, 0, a, AC.DEPOSIT)), [6000, 1000, 0]);
    close(ti(detail, 0, TI.WAGES), 193000);
  });

  it("tax-02 one spouse contributing alone may use the whole family limit, as before", () => {
    const { detail } = runRealPath(couple(1981, ["900000", "0"]));
    // The family 8,750; 250 excess saved after tax.
    closeAll([0, 1, 2].map((a) => ac(detail, 0, a, AC.DEPOSIT)), [8750, 0, 250]);
    close(ti(detail, 0, TI.WAGES), 191250);
  });
});

describe("C19, L2 a first death: basis reset, rollover, Roth merge, survivor filing single", () => {
  // A (person 0, born January 1946) dies at the end of 2026; B (person 1, born January 1954) at the
  // end of 2027. Both in pay at full retirement age: A 3,000 a month, B 1,600 (no spousal excess:
  // 1,500 < 1,600). Accounts: A's IRA 858,500 and B's IRA 100,000 (bonds); a joint taxable account
  // of 400,000 (basis 100,000), A's own taxable 50,000 (basis 80,000, a loss) and B's own 60,000
  // (basis 20,000), all stocks; A's Roth 100,000 (basis 30,000) and B's 20,000 (basis 10,000); cash
  // 100,000. A converts 16,000 in 2026. Spending 150,000 (the survivor keeps all of it). Yields 0.
  //
  // 2026, married filing jointly, both aged: A's RMD 858,500 ÷ 20.2 (Uniform: B is 72, 8 years
  // younger) = 42,500; B is 72, before the start age 73. The conversion leaves A's IRA at
  // 858,500 − 42,500 − 16,000 = 800,000. Tax: other 58,500; benefits 55,200; provisional 86,100;
  // tier 1 6,000; taxable benefits min(46,920, 0.85 × 42,100 + 6,000 = 41,785) = 41,785; AGI
  // 100,285; standard 32,200 + 2 × 1,650 = 35,500; senior 2 × 6,000; taxable 52,785; 2,480 + 12% ×
  // 27,985 = 5,838.20. Cash withdrawn 150,000 + 5,838.20 − 55,200 − 42,500 = 58,138.20.
  // End of 2026 (C19, after returns of 0): A's own taxable account to value (share 1) — the loss
  // steps down from 80,000 to 50,000; B's own stays 20,000; the joint account 100,000 + s ×
  // 300,000: CA (community property) s = 1 → 400,000, CO s = 0.5 → 250,000. A's accounts pass to B;
  // B's Roth record absorbs A's (E8): basis 10,000 + 30,000, A's 16,000 layer, FIRST_YEAR 2021.
  //
  // 2027, B single (L2), 73: RMD of 900,000 at 26.5 (Uniform, no spouse) = 33,962.26 (G6), pro rata
  // 30,188.68 and 3,773.58; the widow's benefit: A's PIA 3,000 × 1.036 = 3,108.00 (B's own
  // 1,657.60), 12 × 3,108 = 37,296. The 2027 hook sells 100,000 of the joint account. CA: no gain;
  // provisional 33,962.26 + 18,648 = 52,610.26; taxable benefits min(31,701.60, 0.85 × 18,610.26 +
  // 4,500) = 20,318.72; AGI 54,280.99; standard 16,600 + 2,100 = 18,700; senior 6,000; taxable
  // 29,580.99; 1,280 + 12% × 16,780.99 = 3,293.72. CO: gain 100,000 × (1 − 250,000 ÷ 400,000) =
  // 37,500; taxable benefits 31,701.60 (the cap); AGI 103,163.86; senior 6,000 − 0.06 × 28,163.86 =
  // 4,310.17; taxable 80,153.70 of which 37,500 preferential: ordinary 42,653.70 → 1,280 + 12% ×
  // 29,853.70 = 4,862.44; 8,396.30 at 0% (to 51,050), 29,103.70 at 15% = 4,365.55; total 9,228.00.
  const accounts: SimInputAccount[] = [
    account("iraA", "pre_tax", "85850000", { owner: "p1", type: "ira", allocation: bonds }),
    account("iraB", "pre_tax", "10000000", { owner: "p2", type: "ira", allocation: bonds }),
    account("joint", "taxable", "40000000", { basisCents: "10000000" }),
    account("ownA", "taxable", "5000000", { owner: "p1", basisCents: "8000000" }),
    account("ownB", "taxable", "6000000", { owner: "p2", basisCents: "2000000" }),
    account("rothA", "roth", "10000000", { owner: "p1", type: "roth", rothContributionBasisCents: "3000000" }),
    account("rothB", "roth", "2000000", { owner: "p2", type: "roth", rothContributionBasisCents: "1000000" }),
    cashAccount("cash", "10000000"),
  ];
  const input = (state: string, birthYearB = 1954) =>
    buildSimInput({
      startYear: 2026,
      people: [
        { birthYear: 1946, longevity: { mode: "fixed", age: 80 } },
        { birthYear: birthYearB, longevity: { mode: "fixed", age: 2027 - birthYearB } },
      ],
      accounts,
      socialSecurity: {
        people: [receivingAtFra("p1", "300000", "2012-01"), receivingAtFra("p2", "160000", birthYearB === 1954 ? "2020-01" : "2022-05")],
        spousal: true,
        survivor: true,
      },
      rothConversions: [{ year: 2026, personId: "p1", amountCents: "1600000", dollars: "nominal" }],
      spending: { baseAnnualCents: "15000000" },
      tax: ZERO_YIELDS,
      state,
    });
  const sell = fixedWithdrawalHooks({ 1: [0, 0, 100000, 0, 0, 0, 0, 0] });
  const co = runRealPath(input("CO"), { hooks: sell });
  const ca = runRealPath(input("CA"), { hooks: sell });

  it("C19 2026 joint and aged: RMD 42,500, conversion 16,000, benefits 36,000 and 19,200, tax 5,838.20, cash withdrawn 58,138.20", () => {
    const d = co.detail;
    expect(Array.from(co.ps.deathIdx)).toEqual([0, 1]);
    expect(yr(d, 0, YR.FILING_STATUS)).toBe(1);
    expect(ti(d, 0, TI.N_AGED)).toBe(2);
    closeAll([ac(d, 0, 0, AC.RMD), ac(d, 0, 1, AC.RMD)], [42500, 0]);
    close(ac(d, 0, 0, AC.CONV_OUT), 16000);
    close(ac(d, 0, 5, AC.CONV_IN), 16000);
    closeAll([so(d, 0, SO.BENEFIT), so(d, 0, SO.BENEFIT + 1)], [36000, 19200]);
    close(to(d, 0, TO.TAXABLE_SS), 41785);
    close(to(d, 0, TO.STD_DEDUCTION), 35500);
    close(yr(d, 0, YR.TAX), 5838.2);
    close(ac(d, 0, 7, AC.WITHDRAWAL), 58138.2);
    expect(yr(d, 0, YR.WITHDRAWAL_TOTAL)).toBeCloseTo(58138.2, 2);
    // The same year in CA: the state matters only from the death on.
    close(yr(ca.detail, 0, YR.TAX), 5838.2);
  });

  it("C19 end of 2026: the joint basis moves to 250,000 in CO and to 400,000 in CA; A's loss steps down to 50,000; B's own stays 20,000", () => {
    expect(basisOf(co.detail, 0, 2)[0]).toBeCloseTo(250000, 6);
    expect(basisOf(ca.detail, 0, 2)[0]).toBeCloseTo(400000, 6);
    for (const d of [co.detail, ca.detail]) {
      expect(basisOf(d, 0, 3)[0]).toBeCloseTo(50000, 6);
      expect(basisOf(d, 0, 4)[0]).toBeCloseTo(20000, 6);
    }
  });

  it("C19 the rollover: from 2027 A's IRA, taxable account and Roth are B's; the joint account stays joint", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((a) => ac(co.detail, 1, a, AC.OWNER))).toEqual([1, 1, -1, 1, 1, 1, 1, -1]);
    close(ac(co.detail, 1, 0, AC.START), 800000);
  });

  it("E8 mergeRothAtDeath: B's record holds basis 40,000 and A's 16,000 layer (rolled once in 2027), FIRST_YEAR 2021; A's is empty", () => {
    for (const r of [co, ca]) {
      // [BASIS_FREE, CONV0 … CONV4, FIRST_YEAR]: the 2026 layer was CONV4 at the merge and is CONV3 after the 2027 roll.
      closeAll(roth(r.ps, 1), [40000, 0, 0, 0, 16000, 0, 2021]);
      closeAll(roth(r.ps, 0), [0, 0, 0, 0, 0, 0, 0]);
    }
  });

  it("L2 2027: B files single, one aged filer, standard 18,700; G6 RMD 33,962.26 (30,188.68 and 3,773.58); the widow's benefit 37,296", () => {
    const d = co.detail;
    expect(yr(d, 1, YR.FILING_STATUS)).toBe(0);
    expect(ti(d, 1, TI.N_AGED)).toBe(1);
    close(to(d, 1, TO.STD_DEDUCTION), 18700);
    closeAll([ac(d, 1, 0, AC.RMD), ac(d, 1, 1, AC.RMD)], [30188.68, 3773.58]);
    close(yr(d, 1, YR.RMD_TOTAL), 33962.26);
    expect(so(d, 1, SO.BENEFIT)).toBe(0);
    expect(so(d, 1, SO.BENEFIT + 1)).toBe(37296);
  });

  it("C19 2027 sale of 100,000 from the joint account: CA gain 0 and tax 3,293.72; CO gain 37,500 and tax 9,228.00", () => {
    close(ac(ca.detail, 1, 2, AC.WITHDRAWAL), 100000);
    close(ti(ca.detail, 1, TI.LT_GAIN), 0);
    close(to(ca.detail, 1, TO.TAXABLE_SS), 20318.72);
    close(to(ca.detail, 1, TO.AGI), 54280.99);
    close(yr(ca.detail, 1, YR.TAX), 3293.72);
    close(ti(co.detail, 1, TI.LT_GAIN), 37500);
    close(to(co.detail, 1, TO.TAXABLE_SS), 31701.6);
    close(to(co.detail, 1, TO.AGI), 103163.86);
    close(to(co.detail, 1, TO.SENIOR_DEDUCTION), 4310.17);
    close(to(co.detail, 1, TO.CG_TAX), 4365.55);
    close(yr(co.detail, 1, YR.TAX), 9228);
  });

  it("G6 the survivor's birth year sets the start age: born 1956, B is 71 in 2027 and takes no RMD from the inherited IRA", () => {
    const { detail } = runRealPath(input("CO", 1956));
    expect(ac(detail, 1, 0, AC.OWNER)).toBe(1);
    expect(yr(detail, 1, YR.RMD_TOTAL)).toBe(0);
  });
});

describe("the tax area's path warnings, fed by the loop", () => {
  it("H10(a) the earnings test through the loop: wages 40,000 at 63 withhold 7,760 of 16,800; SS_GROSS 9,040; WN.SS_EARNINGS_TEST 7,760", () => {
    // Born January 1963 (full retirement age 66 and 8 months), PIA 2,000 claimed at 62 in January
    // 2025 (1,400 a month), salary 40,000 in 2026 with the 2026 exempt amount: (40,000 − 24,480) ÷ 2
    // = 7,760 withheld (tax-rmd-ss H10(a)); the loop passes the gross wages to the earnings test.
    const { ps, detail } = runRealPath(
      buildSimInput({
        startYear: 2026,
        people: [{ birthYear: 1963, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 63 } }],
        incomes: [salary("4000000", "2026-01")],
        socialSecurity: {
          people: [{ personId: "p1", mode: "estimate", monthlyAtFraCents: "200000", asOfYear: 2026, claimMonth: "2025-01", claimAgeMonths: 744 }],
          spousal: true,
          survivor: true,
        },
      }),
    );
    close(so(detail, 0, SO.WITHHELD), 7760);
    close(so(detail, 0, SO.BENEFIT), 9040);
    close(ti(detail, 0, TI.SS_GROSS), 9040);
    close(ps.wn[WN.SS_EARNINGS_TEST]!, 7760);
  });

  // A Roth of 100,000 whose contribution basis was not entered (the seeding counts it 0, and the
  // account is older than five years): a withdrawal of 20,000 is all earnings. Born January 1967,
  // 59½ in July 2026 (earlyFrac 0.5): taxable 10,000, base 10,000, so the withdrawal is noted whole,
  // 20,000 (tax-rmd-ss §3.7.3: "the caller notes the withdrawal"). Born January 1966 (59½ in July
  // 2025): a qualified distribution, nothing noted.
  const unknownBasis = (birthYear: number) =>
    runRealPath(
      buildSimInput({
        startYear: 2026,
        people: [{ birthYear, longevity: { mode: "fixed", age: 2026 - birthYear } }],
        accounts: [account("roth", "roth", "10000000", { type: "roth" }), cashAccount("cash", "0")],
      }),
      { hooks: fixedWithdrawalHooks({ 0: [20000, 0] }) },
    );

  it("WN roth_basis_unknown: an early withdrawal on an unknown basis is noted whole (20,000); a qualified one is not", () => {
    const early = unknownBasis(1967);
    close(ti(early.detail, 0, TI.ROTH_TAXABLE), 10000);
    close(ti(early.detail, 0, TI.PEN10_BASE), 10000);
    close(early.ps.wn[WN.ROTH_BASIS_UNKNOWN]!, 20000);
    const qualified = unknownBasis(1966);
    expect(ti(qualified.detail, 0, TI.ROTH_TAXABLE)).toBe(0);
    expect(qualified.ps.wn[WN.ROTH_BASIS_UNKNOWN]).toBe(0);
  });

  it("WN roth_basis_unknown: a survivor takes on the decedent's unknown basis with the decedent's record", () => {
    // A (born 1946) has the Roth of 100,000 with no basis entered and dies at the end of 2026; B (born
    // January 1970, 57 in 2027: earlyFrac 1) entered a basis of 0 for her own empty Roth. In 2027 B
    // withdraws 20,000 from the inherited account: the merged record has no basis and A's FIRST_YEAR
    // 2021, so 20,000 of earnings, all taxable and all in the base; noted as 20,000 because the
    // basis behind it was never entered.
    const { ps, detail } = runRealPath(
      buildSimInput({
        startYear: 2026,
        people: [
          { birthYear: 1946, longevity: { mode: "fixed", age: 80 } },
          { birthYear: 1970, longevity: { mode: "fixed", age: 57 } },
        ],
        accounts: [
          account("rothA", "roth", "10000000", { owner: "p1", type: "roth" }),
          account("rothB", "roth", "0", { owner: "p2", type: "roth", rothContributionBasisCents: "0" }),
          cashAccount("cash", "0"),
        ],
      }),
      { hooks: fixedWithdrawalHooks({ 1: [20000, 0, 0] }) },
    );
    expect(ac(detail, 1, 0, AC.OWNER)).toBe(1);
    close(ti(detail, 1, TI.ROTH_TAXABLE), 20000);
    close(ti(detail, 1, TI.PEN10_BASE), 20000);
    close(ps.wn[WN.ROTH_BASIS_UNKNOWN]!, 20000);
  });
});

describe("engine-01: the first drawdown year's months before spending.startMonth are accumulation months", () => {
  // Plan decision 7 (binding) and engine-and-returns decision 9: before the first retirement
  // neither spending nor take-home pay is modelled; the wages pay their own tax, payroll and living
  // costs (seams C52). With the month windows of C15, the months of the first drawdown year before
  // spending.startMonth (the earliest retirement month) are such months: their stream income and
  // Social Security, the employee contributions and payroll tax that fall in them, and the federal
  // tax on that income alone (a baseline, as in an accumulation year) stay out of the year's net.
  // Only the months from startMonth enter the drawdown cash identity:
  //   net = cash income + RMD + w − employee − payroll − need − (tax − pre-start tax) − pre-start take-home,
  // with pre-start take-home = pre-start income − pre-start employee contributions − pre-start payroll.
  // The review's probe: retiring in December 2030, the year saved 81,957.50 of a year's wages with
  // one month of spending charged.
  //
  // Fixed returns of 0% and no inflation, so 2030's law is 2027's (F = 1) without the senior
  // deduction (current_law ends it after 2028). Single 2027: standard deduction 16,600 + 2,100 at
  // 65; brackets 10% to 12,800, 12% to 52,025 (5,987 there), 22% to 109,125.
  const single = (retire: string) =>
    buildSimInput({
      startYear: 2027,
      people: [{ birthYear: 1965, retirementMonth: retire, longevity: { mode: "fixed", age: 90 } }],
      accounts: [cashAccount("cash", "50000000")],
      incomes: [incomeStream("sal", "salary", "12000000", "2027-01", { personId: "p1", endMonth: retire })],
      spending: { baseAnnualCents: "6000000", essentialAnnualCents: "6000000", startMonth: retire },
    });
  const t30 = 3;

  it("engine-01 a single earner retiring in December 2030: the 110,000 of January to November pays its own 14,627.50 of tax and 8,415 of payroll; December's 5,000 of spending is withdrawn and nothing is saved", () => {
    // 2030: wages 110,000 (11 months, all before 2030-12); the person is 65: taxable 110,000 −
    // 18,700 = 91,300; 5,987 + 22% × (91,300 − 52,025) = 5,987 + 8,640.50 = 14,627.50. Payroll
    // 7.65% × 110,000 = 8,415. Pre-start take-home 110,000 − 0 − 8,415 = 101,585; the pre-start tax
    // is the whole tax. net = 110,000 + w − 8,415 − 5,000 − 0 − 101,585 = w − 5,000.
    const { detail } = runRealPath(single("2030-12"));
    expect(yr(detail, t30, YR.PHASE)).toBe(1);
    close(yr(detail, t30, YR.CASH_INCOME), 110000);
    close(yr(detail, t30, YR.TAX), 14627.5);
    close(yr(detail, t30, YR.TAX_BASELINE), 14627.5);
    close(yr(detail, t30, YR.PAYROLL), 8415);
    close(yr(detail, t30, YR.PRE_START_CASH), 101585);
    close(sp(detail, t30, SP.NEED), 5000);
    close(yr(detail, t30, YR.WITHDRAWAL_TOTAL), 5000);
    close(sp(detail, t30, SP.SURPLUS), 0);
    // 2029, an accumulation year: 120,000 of wages, tax 5,987 + 22% × (103,400 − 52,025) = 17,289.50, nothing saved.
    expect(yr(detail, 2, YR.PHASE)).toBe(0);
    close(yr(detail, 2, YR.TAX), 17289.5);
    close(sp(detail, 2, SP.SURPLUS), 0);
  });

  it("engine-01 retiring in July 2030 withdraws the six months' 30,000 and saves nothing; retiring in January, the year is a whole drawdown year (60,000)", () => {
    // July: wages 60,000 (January to June) before startMonth; taxable 41,300; 1,280 + 12% × 28,500 = 4,700.
    const july = runRealPath(single("2030-07")).detail;
    close(yr(july, t30, YR.TAX), 4700);
    close(yr(july, t30, YR.TAX_BASELINE), 4700);
    close(yr(july, t30, YR.PRE_START_CASH), 60000 - 4590);
    close(yr(july, t30, YR.WITHDRAWAL_TOTAL), 30000);
    close(sp(july, t30, SP.SURPLUS), 0);
    const january = runRealPath(single("2030-01")).detail;
    close(yr(january, t30, YR.PRE_START_CASH), 0);
    close(yr(january, t30, YR.TAX_BASELINE), 0);
    close(yr(january, t30, YR.WITHDRAWAL_TOTAL), 60000);
    close(sp(january, t30, SP.SURPLUS), 0);
  });

  // A couple: A (born 1965) earns 120,000 until July 2030; B (born 1967) earns 60,000 until 2033.
  // Spending 60,000 from 2030-07. Joint 2027 law: standard deduction 33,200 + 1,700 (A is 65 in
  // 2030); 10% to 25,600 (2,560), 12% to 104,050.
  const couple = (retire: string) =>
    buildSimInput({
      startYear: 2027,
      people: [
        { birthYear: 1965, retirementMonth: retire, longevity: { mode: "fixed", age: 90 } },
        { birthYear: 1967, retirementMonth: "2033-01", longevity: { mode: "fixed", age: 90 } },
      ],
      accounts: [cashAccount("cash", "50000000")],
      incomes: [
        incomeStream("a", "salary", "12000000", "2027-01", { personId: "p1", endMonth: retire }),
        incomeStream("b", "salary", "6000000", "2027-01", { personId: "p2", endMonth: "2033-01" }),
      ],
      spending: { baseAnnualCents: "6000000", essentialAnnualCents: "6000000", startMonth: retire },
    });

  it("engine-01 a working spouse: from July 2030 B's wages count against the year's spending, January to June stay out", () => {
    // 2030: wages A 60,000 and B 60,000 (pre-start A 60,000 + B 30,000 = 90,000). Tax on 120,000:
    // taxable 85,100, 2,560 + 12% × 59,500 = 9,700; on the pre-start 90,000: taxable 55,100,
    // 2,560 + 12% × 29,500 = 6,100. Payroll 7.65% × 120,000 = 9,180, pre-start 6,885. Pre-start
    // take-home 90,000 − 6,885 = 83,115. Need 30,000. net = 120,000 + w − 9,180 − 30,000 −
    // (9,700 − 6,100) − 83,115 = w − 5,895: 5,895.00 is withdrawn (before the fix 71,120 was saved).
    const { detail } = runRealPath(couple("2030-07"));
    close(yr(detail, t30, YR.TAX), 9700);
    close(yr(detail, t30, YR.TAX_BASELINE), 6100);
    close(yr(detail, t30, YR.PAYROLL), 9180);
    close(yr(detail, t30, YR.PRE_START_CASH), 83115);
    close(yr(detail, t30, YR.WITHDRAWAL_TOTAL), 5895);
    close(sp(detail, t30, SP.SURPLUS), 0);
    // 2031, a whole drawdown year (unchanged by the rule): B's 60,000 − payroll 4,590 − tax 2,510
    // (taxable 25,100) − 60,000 = −7,100: 7,100 is withdrawn.
    close(yr(detail, 4, YR.TAX), 2510);
    close(yr(detail, 4, YR.PRE_START_CASH), 0);
    close(yr(detail, 4, YR.WITHDRAWAL_TOTAL), 7100);
  });

  it("engine-01 the year's withdrawal moves by about a month's take-home with the retirement month (continuity), never by most of a year's", () => {
    // August: pre-start wages A 70,000 + B 35,000 = 105,000, taxable 70,100, tax 2,560 + 12% ×
    // 44,500 = 7,900; the year's 130,000, taxable 95,100, tax 2,560 + 12% × 69,500 = 10,900;
    // payroll 9,945, pre-start 8,032.50; need 25,000.
    // net = 130,000 + w − 9,945 − 25,000 − (10,900 − 7,900) − (105,000 − 8,032.50) = w − 4,912.50.
    const august = runRealPath(couple("2030-08")).detail;
    close(yr(august, t30, YR.TAX_BASELINE), 7900);
    close(yr(august, t30, YR.WITHDRAWAL_TOTAL), 4912.5);
    // July against August: in August B's take-home, 5,000 − 382.50 payroll − 600 tax (12%) =
    // 4,017.50, meets 5,000 of spending, so retiring a month earlier withdraws 982.50 more: about a
    // month's take-home less a month's spending, not a year's.
    const july = runRealPath(couple("2030-07")).detail;
    close(yr(july, t30, YR.WITHDRAWAL_TOTAL) - yr(august, t30, YR.WITHDRAWAL_TOTAL), 982.5);
    for (const retire of ["2030-02", "2030-04", "2030-06", "2030-09", "2030-11", "2030-12"]) {
      const d = runRealPath(couple(retire)).detail;
      expect(sp(d, t30, SP.SURPLUS), retire).toBeLessThan(1000);
    }
  });

  it("engine-01 a benefit in pay before startMonth stays out with the months it is paid in, and the cash identity holds with the pre-start term", () => {
    // Born January 1960 (FRA 67 in January 2027), receiving 2,000 a month at full retirement age
    // since 2027-01, working at 50,000 until July 2030. The year's benefit is twelve equal months
    // (no claim, no FRA and no 60th birthday inside 2030; no earnings test from FRA), so half of it
    // falls before 2030-07.
    const input = buildSimInput({
      startYear: 2027,
      people: [{ birthYear: 1960, retirementMonth: "2030-07", longevity: { mode: "fixed", age: 90 } }],
      accounts: [cashAccount("cash", "50000000")],
      incomes: [incomeStream("sal", "salary", "5000000", "2027-01", { personId: "p1", endMonth: "2030-07" })],
      socialSecurity: { people: [receivingAtFra("p1", "200000", "2027-01")], spousal: true, survivor: true },
      spending: { baseAnnualCents: "6000000", essentialAnnualCents: "6000000", startMonth: "2030-07" },
    });
    const { detail } = runRealPath(input);
    const benefit = so(detail, t30, SO.BENEFIT);
    expect(benefit).toBeGreaterThan(24000);
    // Wages 25,000 before July; payroll 7.65% × 25,000 = 1,912.50 (all of the year's).
    close(yr(detail, t30, YR.PAYROLL), 1912.5);
    close(yr(detail, t30, YR.PRE_START_CASH), 25000 + benefit / 2 - 1912.5);
    const sources = yr(detail, t30, YR.CASH_INCOME) + yr(detail, t30, YR.RMD_TOTAL) + yr(detail, t30, YR.WITHDRAWAL_TOTAL);
    const uses =
      sp(detail, t30, SP.FUNDED) +
      yr(detail, t30, YR.TAX) -
      yr(detail, t30, YR.TAX_BASELINE) +
      yr(detail, t30, YR.EMPLOYEE) +
      yr(detail, t30, YR.PAYROLL) +
      sp(detail, t30, SP.SURPLUS) +
      yr(detail, t30, YR.PRE_START_CASH);
    expect(Math.abs(sources - uses)).toBeLessThanOrEqual(0.01);
  });
});
