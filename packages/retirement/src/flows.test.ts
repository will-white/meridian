import { fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { planClock } from "./clock.js";
import { EngineInputError } from "./errors.js";
import {
  CONTRIB,
  INCOME,
  IY,
  IY_REC,
  LIMIT,
  compileContributions,
  compileIncomes,
  contributionsYearInto,
  conversionsYearInto,
  incomeYearInto,
  limitGroupOf,
} from "./flows.js";
import { prepare } from "./prepare.js";
import { account, buildSimInput, incomeStream } from "./testing/simInput.js";

/** cpi[0] = 1, cpi[t + 1] = cpi[t] × (1 + inflation[t]), by multiplication in order (engine §3.1). */
function cpiPath(inflation: readonly number[]): Float64Array {
  const cpi = new Float64Array(inflation.length + 1);
  cpi[0] = 1;
  for (let t = 0; t < inflation.length; t++) cpi[t + 1] = cpi[t]! * (1 + inflation[t]!);
  return cpi;
}

function constantCpi(rate: number, years: number): Float64Array {
  return cpiPath(new Array<number>(years).fill(rate));
}

/** Runs one plan year of the run's income streams: per-stream amounts and the IY record. */
function incomeYear(run: ReturnType<typeof prepare>, t: number, cpi: Float64Array, alive: number[] = [1, 1].slice(0, run.personCount)) {
  const amounts = new Float64Array(run.incomes.count);
  const out = new Float64Array(IY_REC);
  incomeYearInto(run.incomes, t, cpi, Uint8Array.from(alive), amounts, out);
  return { amounts, out };
}

function contributionsYear(run: ReturnType<typeof prepare>, t: number, cpi: Float64Array, alive: number[] = [1, 1].slice(0, run.personCount)) {
  const employee = new Float64Array(run.contributions.count);
  const employer = new Float64Array(run.contributions.count);
  contributionsYearInto(run.contributions, run.incomes, t, cpi, Uint8Array.from(alive), employee, employer);
  return { employee, employer };
}

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof EngineInputError) return e.code;
    throw e;
  }
  return undefined;
}

describe("T30 income streams (engine-and-returns §7 T30, with seams C15 and C16)", () => {
  // A plan from January 2027 (f = 1), one person born 1962 (fixed age 95, Y = 31).
  const people = [{ birthYear: 1962 }];

  it("T30 a salary of 100,000 with 1% real growth at 3% inflation is 108,222.41 in year 2", () => {
    // 100,000 × cpi[2] × 1.01² = 100,000 × 1.0609 × 1.0201 = 108,222.409 → 108,222.41.
    const run = prepare(buildSimInput({ people, incomes: [incomeStream("salary_p1", "salary", "10000000", "2027-01", { personId: "p1", realGrowthBp: 100 })] }));
    const cpi = constantCpi(0.03, 3);
    expect(incomeYear(run, 0, cpi).out[IY.WAGES0]).toBe(100000);
    expect(incomeYear(run, 1, cpi).out[IY.WAGES0]).toBeCloseTo(100000 * 1.03 * 1.01, 9);
    const y2 = incomeYear(run, 2, cpi);
    expect(y2.out[IY.WAGES0]).toBeCloseTo(108222.409, 6);
    expect(Math.round(y2.out[IY.WAGES0]! * 100) / 100).toBe(108222.41);
    expect(y2.out[IY.CASH]).toBe(y2.out[IY.WAGES0]);
    expect(y2.out[IY.PENSION]).toBe(0);
  });

  it("T30 a nominal pension of 24,000 without COLA stays 24,000; one in today's dollars with COLA cpi is 24,000 × cpi[t]", () => {
    const run = prepare(
      buildSimInput({
        people,
        incomes: [
          incomeStream("nominal", "pension", "2400000", "2027-01", { personId: "p1", dollars: "nominal", cola: { mode: "none" } }),
          incomeStream("real", "pension", "2400000", "2027-01", { personId: "p1", dollars: "today", cola: { mode: "cpi" } }),
        ],
      }),
    );
    const cpi = cpiPath([0.03, -0.01, 0.05, 0.02]);
    for (let t = 0; t <= 4; t++) {
      const { amounts, out } = incomeYear(run, t, cpi);
      expect(amounts[0]).toBe(24000);
      expect(amounts[1]).toBe(24000 * cpi[t]!);
      expect(out[IY.GUARANTEED]).toBe(amounts[0]! + amounts[1]!);
      expect(out[IY.PENSION]).toBe(out[IY.GUARANTEED]);
    }
  });

  it("T30 taxableBp 6000 on an annuity of 10,000 gives 6,000 ordinary and 10,000 cash", () => {
    const run = prepare(
      buildSimInput({ people, incomes: [incomeStream("annuity", "annuity", "1000000", "2027-01", { personId: "p1", dollars: "nominal", cola: { mode: "none" }, taxableBp: 6000 })] }),
    );
    const { out } = incomeYear(run, 0, constantCpi(0, 1));
    expect(out[IY.PENSION]).toBe(6000);
    expect(out[IY.EXEMPT]).toBe(4000);
    expect(out[IY.CASH]).toBe(10000);
    expect(out[IY.GUARANTEED]).toBe(10000);
  });

  it("T30 rental and other income count as other income, taxed at their taxable share", () => {
    const run = prepare(
      buildSimInput({
        people,
        incomes: [incomeStream("rent", "rental", "1200000", "2027-01"), incomeStream("gig", "other", "500000", "2027-01", { personId: "p1", taxableBp: 5000 })],
      }),
    );
    const { out } = incomeYear(run, 0, constantCpi(0, 1));
    expect([out[IY.RENTAL], out[IY.OTHER_ORD], out[IY.EXEMPT], out[IY.OTHER], out[IY.CASH]]).toEqual([12000, 2500, 2500, 17000, 17000]);
    expect(run.incomes.kind[0]).toBe(INCOME.RENTAL);
    expect(run.incomes.person[0]).toBe(-1);
  });
});

describe("C15 month windows: a recurring flow counts the months of its window inside the period", () => {
  const people = [{ birthYear: 1975, birthMonth: 6, retirementMonth: "2035-06" }];

  it("C15 a salary that ends in June 2035 pays five twelfths that year and nothing after", () => {
    // Window [2027-01, 2035-06): 2035 holds January to May, 5 months: 120,000 × 5/12 × 1.01^8 × cpi[8].
    const run = prepare(
      buildSimInput({ people, incomes: [incomeStream("salary_p1", "salary", "12000000", "2027-01", { personId: "p1", endMonth: "2035-06", realGrowthBp: 100 })] }),
    );
    const cpi = constantCpi(0.02, 10);
    let g8 = 1;
    for (let i = 0; i < 8; i++) g8 *= 1.01;
    expect(incomeYear(run, 8, cpi).out[IY.WAGES0]).toBeCloseTo(((120000 * 5) / 12) * g8 * cpi[8]!, 8);
    expect(incomeYear(run, 9, cpi).out[IY.WAGES0]).toBe(0);
  });

  it("C15 a pension from September 2039 pays four twelfths in 2039 (seams §4: 4,000, nominal from its first year)", () => {
    const run = prepare(
      buildSimInput({
        startYear: 2026,
        startMonth: 10,
        people: [
          { birthYear: 1975, birthMonth: 6 },
          { birthYear: 1977, birthMonth: 9 },
        ],
        incomes: [incomeStream("pen1", "pension", "1200000", "2039-09", { personId: "p2", dollars: "nominal", cola: { mode: "none" }, survivorBp: 5000 })],
      }),
    );
    const cpi = constantCpi(0.03, 20);
    expect(run.incomes.firstYear[0]).toBe(13);
    expect(incomeYear(run, 12, cpi).out[IY.PENSION]).toBe(0);
    expect(incomeYear(run, 13, cpi).out[IY.PENSION]).toBe(4000);
    expect(incomeYear(run, 14, cpi).out[IY.PENSION]).toBe(12000);
  });

  it("C15 year 0 counts only the plan's months: a plan from October pays three twelfths of a salary", () => {
    const run = prepare(
      buildSimInput({ startYear: 2026, startMonth: 10, people, incomes: [incomeStream("s", "salary", "12000000", "2026-10", { personId: "p1", endMonth: "2035-06" })] }),
    );
    expect(incomeYear(run, 0, constantCpi(0, 1)).out[IY.WAGES0]).toBe(30000);
  });

  it("C15 a window that starts before the plan is counted from the plan start (t0 = 0)", () => {
    const run = prepare(buildSimInput({ startYear: 2026, startMonth: 10, people, incomes: [incomeStream("rent", "rental", "1200000", "2020-01")] }));
    expect(run.incomes.firstYear[0]).toBe(0);
    expect(incomeYear(run, 0, constantCpi(0, 1)).out[IY.RENTAL]).toBe(3000);
  });
});

describe("C16 how a stream grows: indexed to its first year t0, then by its COLA or by inflation plus real growth", () => {
  // Plan from January 2027; streams start in 2030 (t0 = 3). Inflation 2%, 3%, 4%, −1%, 2%, 5%:
  // cpi = 1, 1.02, 1.0506, 1.092624, 1.08169776, 1.1033317152, 1.158498300960.
  const people = [{ birthYear: 1962 }];
  const cpi = cpiPath([0.02, 0.03, 0.04, -0.01, 0.02, 0.05]);
  const start = "2030-01";
  const pension = (id: string, o: Parameters<typeof incomeStream>[4]) => incomeStream(id, "pension", "1000000", start, { personId: "p1", ...o });
  const run = prepare(
    buildSimInput({
      people,
      incomes: [
        pension("today_none", { dollars: "today", cola: { mode: "none" } }),
        pension("today_cpi", { dollars: "today", cola: { mode: "cpi" } }),
        pension("today_fixed", { dollars: "today", cola: { mode: "fixed", bp: 200 } }),
        pension("nominal_none", { dollars: "nominal", cola: { mode: "none" } }),
        pension("nominal_cpi", { dollars: "nominal", cola: { mode: "cpi" } }),
        pension("nominal_fixed", { dollars: "nominal", cola: { mode: "fixed", bp: 200 } }),
        incomeStream("rent_nominal", "rental", "1000000", start, { dollars: "nominal", realGrowthBp: 100 }),
        incomeStream("rent_today", "rental", "1000000", start, { dollars: "today", realGrowthBp: 100 }),
      ],
    }),
  );
  const at = (t: number) => incomeYear(run, t, cpi).amounts;
  const c3 = cpi[3]!;

  it("C16 nothing is paid before t0", () => {
    expect(Array.from(at(2))).toEqual(new Array(8).fill(0));
    expect(Array.from(run.incomes.firstYear)).toEqual(new Array(8).fill(3));
  });

  it("C16 in its first year a nominal stream pays its quoted amount and a today's-dollar stream the amount × cpi[t0]", () => {
    const a = at(3);
    // today: 10,000 × cpi[3] = 10,926.24; nominal: 10,000.
    for (const k of [0, 1, 2, 7]) expect(a[k]).toBeCloseTo(10000 * c3, 9);
    for (const k of [3, 4, 5, 6]) expect(a[k]).toBe(10000);
  });

  it("C16 after t0: none stays, cpi follows cpi[t]/cpi[t0], fixed compounds from t0, the others follow inflation and real growth", () => {
    for (const t of [4, 5, 6]) {
      const a = at(t);
      const n = t - 3;
      let fixed = 1;
      let real = 1;
      for (let i = 0; i < n; i++) {
        fixed *= 1.02;
        real *= 1.01;
      }
      const index = cpi[t]! / c3;
      expect(a[0]).toBeCloseTo(10000 * c3, 9); // today, none: cpi[t0] for ever
      expect(a[1]).toBeCloseTo(10000 * cpi[t]!, 9); // today, cpi: cpi[t0] × cpi[t]/cpi[t0]
      expect(a[2]).toBeCloseTo(10000 * c3 * fixed, 9); // today, fixed 2%
      expect(a[3]).toBe(10000); // nominal, none
      expect(a[4]).toBeCloseTo(10000 * index, 9); // nominal, cpi: falls with prices in 2031 (engine deviation 21)
      expect(a[5]).toBeCloseTo(10000 * fixed, 9); // nominal, fixed 2% from t0, not from the plan start
      expect(a[6]).toBeCloseTo(10000 * index * real, 9); // nominal rental: from its quoted amount
      expect(a[7]).toBeCloseTo(10000 * cpi[t]! * real, 9); // today's-dollar rental
    }
    // Year 4 by hand: cpi[4]/cpi[3] = 0.99 → nominal cpi 9,900.00; nominal fixed 10,200.00; nominal rental 9,999.00.
    expect(at(4)[4]).toBeCloseTo(9900, 9);
    expect(at(4)[5]).toBeCloseTo(10200, 9);
    expect(at(4)[6]).toBeCloseTo(9999, 9);
  });
});

describe("Survivor shares and household streams", () => {
  const run = prepare(
    buildSimInput({
      people: [{ birthYear: 1960 }, { birthYear: 1962 }],
      incomes: [
        incomeStream("pen2", "pension", "1200000", "2027-01", { personId: "p2", dollars: "nominal", cola: { mode: "none" }, survivorBp: 5000 }),
        incomeStream("salary_p1", "salary", "6000000", "2027-01", { personId: "p1" }),
        incomeStream("rent", "rental", "600000", "2027-01"),
      ],
    }),
  );
  const cpi = constantCpi(0, 2);

  it("a person's stream pays in full while the owner lives and the survivor share once only the spouse does", () => {
    expect(Array.from(incomeYear(run, 0, cpi, [1, 1]).amounts)).toEqual([12000, 60000, 6000]);
    expect(Array.from(incomeYear(run, 0, cpi, [1, 0]).amounts)).toEqual([6000, 60000, 6000]);
  });

  it("wages stop at the earner's death; a household stream pays while anyone lives", () => {
    const { amounts, out } = incomeYear(run, 0, cpi, [0, 1]);
    expect(Array.from(amounts)).toEqual([12000, 0, 6000]);
    expect(out[IY.WAGES0]).toBe(0);
    expect(Array.from(incomeYear(run, 0, cpi, [0, 0]).amounts)).toEqual([0, 0, 0]);
  });

  it("wages are kept per person in WAGES0 / WAGES1", () => {
    const r = prepare(
      buildSimInput({
        people: [{ birthYear: 1975 }, { birthYear: 1977 }],
        incomes: [incomeStream("a", "salary", "1000000", "2027-01", { personId: "p1" }), incomeStream("b", "part_time", "300000", "2027-01", { personId: "p2" })],
      }),
    );
    const { out } = incomeYear(r, 0, cpi);
    expect([out[IY.WAGES0], out[IY.WAGES1], out[IY.CASH]]).toEqual([10000, 3000, 13000]);
  });
});

describe("Income stream errors", () => {
  const people = [{ birthYear: 1962 }];
  const bad = (s: Parameters<typeof incomeStream>[4] & object, kind: Parameters<typeof incomeStream>[1] = "salary") => () =>
    compileIncomes(buildSimInput({ people, incomes: [incomeStream("s", kind, "100", "2027-01", s)] }), planClock(buildSimInput({ people }).plan));

  it("income_invalid for a window that ends before it starts, wages without a person or with a survivor share, a mismatched earned flag, growth of −100%", () => {
    expect(code(bad({ personId: "p1", endMonth: "2027-01" }))).toBe("income_invalid");
    expect(code(bad({}))).toBe("income_invalid");
    expect(code(bad({ personId: "p1", survivorBp: 5000 }))).toBe("income_invalid");
    expect(code(bad({ personId: "p1", earned: false }))).toBe("income_invalid");
    expect(code(bad({ earned: true }, "rental"))).toBe("income_invalid");
    expect(code(bad({ realGrowthBp: -10000 }, "rental"))).toBe("income_invalid");
  });

  it("income_invalid for a second salary of one person; person_missing for an owner who is not in the household; month_invalid", () => {
    const input = buildSimInput({
      people,
      incomes: [incomeStream("a", "salary", "100", "2027-01", { personId: "p1" }), incomeStream("b", "salary", "100", "2027-01", { personId: "p1" })],
    });
    expect(code(() => prepare(input))).toBe("income_invalid");
    expect(code(bad({ personId: "p2" }))).toBe("person_missing");
    // The schema refuses a malformed month, so the engine's own check is reached only by an input built around it.
    const ok = buildSimInput({ people, incomes: [incomeStream("s", "salary", "100", "2027-01", { personId: "p1" })] });
    const malformed = { ...ok, incomes: [{ ...ok.incomes[0]!, endMonth: "2027-13" }] };
    expect(code(() => compileIncomes(malformed, planClock(ok.plan)))).toBe("month_invalid");
  });
});

describe("C26 contributions: the year-0 amount scales with the salary paid in the period", () => {
  // The inputs fixture (inputs-and-data §7.0, test 11): K 12,000 / 6,000 and H 3,600 scale with
  // Alex's salary (120,000, +1% real); B 5,000 with the household's (180,000); R 3,000 with Sam's
  // (60,000). Plan from October 2026, f = 1/4. Indices in input order: K, H, B, R.
  const run = prepare(fixtureSimInput());
  const cpi = constantCpi(0.03, 47);

  it("C26 the kinds and limit groups follow the account (tax-rmd-ss §3.10)", () => {
    expect(Array.from(run.contributions.kind)).toEqual([CONTRIB.PRE_TAX, CONTRIB.PRE_TAX, CONTRIB.AFTER_TAX, CONTRIB.ROTH]);
    expect(Array.from(run.contributions.limit)).toEqual([LIMIT.EMPLOYER_PLAN, LIMIT.HSA, LIMIT.NONE, LIMIT.IRA]);
    expect(Array.from(run.contributions.owner)).toEqual([0, 0, -1, 1]);
    // A Roth 401(k) shares the deferral limit; a traditional IRA the IRA limit; cash and other types none.
    expect([limitGroupOf("roth", "401k"), limitGroupOf("pre_tax", "ira"), limitGroupOf("cash", "savings"), limitGroupOf("pre_tax", "brokerage"), limitGroupOf("pre_tax", undefined)]).toEqual([
      LIMIT.EMPLOYER_PLAN,
      LIMIT.IRA,
      LIMIT.NONE,
      LIMIT.NONE,
      LIMIT.NONE,
    ]);
  });

  it("C26 year 0 (three months): K 3,000 and 1,500, H 900, B 1,250, R 750", () => {
    // K: 12,000 × (120,000 × 3/12) / 120,000 = 3,000; employer 6,000 × 3/12 = 1,500. H: 3,600 × 3/12.
    // B: 5,000 × (30,000 + 15,000) / 180,000 = 1,250. R: 3,000 × 15,000 / 60,000 = 750.
    const { employee, employer } = contributionsYear(run, 0, cpi);
    expect(Array.from(employee)).toEqual([3000, 900, 1250, 750]);
    expect(Array.from(employer)).toEqual([1500, 0, 0, 0]);
  });

  it("C26 2035, the year Alex retires in June: five months of a raised salary", () => {
    // Alex's salary paid in 2035 (t = 9): 120,000 × 5/12 × 1.01^9 × cpi[9] = 54,684.2636 × cpi[9]
    // (1.01^9 = 1.0936852726843609). K: 12,000 × that / 120,000 = 5,468.4264 × cpi[9]; employer half.
    // B: 5,000 × (54,684.2636 + 60,000) / 180,000 = 3,185.6740 × cpi[9]. R: 3,000 × 60,000 / 60,000 × cpi[9].
    const { employee, employer } = contributionsYear(run, 9, cpi);
    const c9 = cpi[9]!;
    expect(employee[0]! / c9).toBeCloseTo(5468.426363421804, 8);
    expect(employer[0]! / c9).toBeCloseTo(2734.213181710902, 8);
    expect(employee[1]! / c9).toBeCloseTo((3600 * 5468.426363421804) / 12000, 8);
    expect(employee[2]! / c9).toBeCloseTo(3185.6739898393901, 8);
    expect(employee[3]! / c9).toBeCloseTo(3000, 9);
  });

  it("C26 2039 (seams §4): B 5,000 × 40,000 / 180,000 = 1,111.11 and R 3,000 × 40,000 / 60,000 = 2,000, in 2039 dollars", () => {
    const { employee } = contributionsYear(run, 13, cpi);
    const c13 = cpi[13]!;
    expect(employee[0]).toBe(0);
    expect(employee[1]).toBe(0);
    expect(employee[2]! / c13).toBeCloseTo(1111.111111111111, 8);
    expect(employee[3]! / c13).toBeCloseTo(2000, 9);
    expect(Array.from(contributionsYear(run, 14, cpi).employee)).toEqual([0, 0, 0, 0]);
  });

  it("C26 a contribution stops with its scaling person's death", () => {
    const { employee } = contributionsYear(run, 1, cpi, [0, 1]);
    // Alex dead: K and H stop; B follows Sam's salary alone: 5,000 × 60,000 / 180,000 × cpi[1].
    expect(employee[0]).toBe(0);
    expect(employee[1]).toBe(0);
    expect(employee[2]! / cpi[1]!).toBeCloseTo(5000 / 3, 9);
  });

  it("C26 scaleWith inflation pays annual × cpi[t] × months before endMonth / 12, while the owner lives", () => {
    const input = buildSimInput({
      startYear: 2026,
      startMonth: 10,
      people: [{ birthYear: 1975 }],
      accounts: [account("ira", "pre_tax", "0", { type: "ira" }), account("cash", "cash", "0")],
      contributions: [{ accountId: "ira", employeeAnnualCents: "240000", employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2030-07" }],
    });
    const r = prepare(input);
    const c = constantCpi(0.02, 6);
    const amount = (t: number, alive = [1]) => contributionsYear(r, t, c, alive).employee[0];
    expect(amount(0)).toBe(600); // October to December: 2,400 × 3/12
    expect(amount(1)).toBeCloseTo(2400 * c[1]!, 9);
    expect(amount(4)).toBeCloseTo(2400 * c[4]! * 0.5, 9); // 2030: January to June
    expect(amount(5)).toBe(0);
    expect(amount(1, [0])).toBe(0);
    expect(r.contributions.limit[0]).toBe(LIMIT.IRA);
  });

  it("C26 salary months at or after endMonth do not count", () => {
    const input = buildSimInput({
      people: [{ birthYear: 1975 }],
      accounts: [account("k", "pre_tax", "0", { type: "401k" }), account("cash", "cash", "0")],
      incomes: [incomeStream("salary_p1", "salary", "12000000", "2027-01", { personId: "p1", endMonth: "2035-01" })],
      contributions: [{ accountId: "k", employeeAnnualCents: "1200000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: "12000000", endMonth: "2027-04" }],
    });
    const r = prepare(input);
    const c = constantCpi(0, 3);
    expect(contributionsYear(r, 0, c, [1]).employee[0]).toBe(3000); // January to March only
    expect(contributionsYear(r, 1, c, [1]).employee[0]).toBe(0);
  });

  it("C26 errors: unknown_account, person_missing, contribution_invalid", () => {
    const base = fixtureSimInput();
    const withEntry = (e: (typeof base.contributions)[number]) => ({ ...base, contributions: [e] });
    const k = base.contributions[0]!;
    expect(code(() => prepare(withEntry({ ...k, accountId: "nope" })))).toBe("unknown_account");
    const single = buildSimInput({
      people: [{ birthYear: 1975 }],
      accounts: [account("k", "pre_tax", "0", { type: "401k" }), account("cash", "cash", "0")],
      incomes: [incomeStream("salary_p1", "salary", "12000000", "2027-01", { personId: "p1" })],
    });
    const entry = { accountId: "k", employeeAnnualCents: "100", employerAnnualCents: "0", endMonth: "2030-01" } as const;
    expect(code(() => prepare({ ...single, contributions: [{ ...entry, scaleWith: "p2", salaryBasisCents: "100" }] }))).toBe("person_missing");
    expect(code(() => prepare({ ...single, contributions: [{ ...entry, scaleWith: "p1" }] }))).toBe("contribution_invalid");
    expect(code(() => prepare({ ...single, contributions: [{ ...entry, scaleWith: "p1", salaryBasisCents: "0" }] }))).toBe("contribution_invalid");
    expect(code(() => prepare({ ...single, incomes: [], contributions: [{ ...entry, scaleWith: "p1", salaryBasisCents: "100" }] }))).toBe("contribution_invalid");
  });

  it("C26 compileContributions maps account ids to indices", () => {
    const input = fixtureSimInput();
    const clock = planClock(input.plan);
    const index = new Map(input.accounts.map((a, i) => [a.id, i]));
    const owners = Int8Array.from(input.accounts.map((a) => (a.owner === "p1" ? 0 : a.owner === "p2" ? 1 : -1)));
    const ct = compileContributions(input, clock, compileIncomes(input, clock), index, owners);
    expect(Array.from(ct.account)).toEqual([0, 1, 4, 5]);
  });
});

describe("C39 scheduled conversions as data for the loop", () => {
  it("C39 the fixture converts 30,000 today's dollars for Alex in 2036 into synthetic:roth:p1", () => {
    const run = prepare(fixtureSimInput());
    const cpi = constantCpi(0.025, 47);
    const out = new Float64Array(2);
    conversionsYearInto(run.conversions, 10, cpi, out);
    expect(out[0]).toBeCloseTo(30000 * cpi[10]!, 9);
    expect(out[1]).toBe(0);
    conversionsYearInto(run.conversions, 9, cpi, out);
    expect(Array.from(out)).toEqual([0, 0]);
    expect(run.accountIds[run.conversions.target[0]!]).toBe("synthetic:roth:p1");
    expect(run.conversions.target[1]).toBe(-1);
  });

  it("C39 a conversion is never scaled by the period, and a nominal one is not indexed", () => {
    const run = prepare(
      buildSimInput({
        startYear: 2026,
        startMonth: 10,
        people: [{ birthYear: 1962 }],
        accounts: [account("ira", "pre_tax", "10000000", { type: "ira" }), account("roth", "roth", "0"), account("cash", "cash", "0")],
        rothConversions: [
          { year: 2026, personId: "p1", amountCents: "5000000", dollars: "today" },
          { year: 2027, personId: "p1", amountCents: "5000000", dollars: "nominal" },
        ],
      }),
    );
    const cpi = constantCpi(0.1, 3);
    const out = new Float64Array(1);
    conversionsYearInto(run.conversions, 0, cpi, out);
    expect(out[0]).toBe(50000);
    conversionsYearInto(run.conversions, 1, cpi, out);
    expect(out[0]).toBe(50000);
  });

  it("C39 the target is the person's Roth account with the largest starting balance, ties by id", () => {
    const people = [{ birthYear: 1962 }];
    const conv = [{ year: 2030, personId: "p1" as const, amountCents: "100", dollars: "today" as const }];
    const accounts = (b: string, c: string) => [account("ira", "pre_tax", "100"), account("roth_b", "roth", b), account("roth_a", "roth", c), account("cash", "cash", "0")];
    const target = (b: string, c: string) => {
      const run = prepare(buildSimInput({ people, accounts: accounts(b, c), rothConversions: conv }));
      return run.accountIds[run.conversions.target[0]!];
    };
    expect(target("500", "400")).toBe("roth_b");
    expect(target("400", "500")).toBe("roth_a");
    expect(target("500", "500")).toBe("roth_a");
  });

  it("C39 errors: conversion_invalid (outside the plan, twice in a year), conversion_no_roth, person_missing", () => {
    const people = [{ birthYear: 1962 }];
    const accounts = [account("ira", "pre_tax", "100"), account("roth", "roth", "0"), account("cash", "cash", "0")];
    const entry = { personId: "p1", amountCents: "100", dollars: "today" } as const;
    expect(code(() => prepare(buildSimInput({ people, accounts, rothConversions: [{ ...entry, year: 2026 }] })))).toBe("conversion_invalid");
    expect(code(() => prepare(buildSimInput({ people, accounts, rothConversions: [{ ...entry, year: 2030 }, { ...entry, year: 2030 }] })))).toBe("conversion_invalid");
    expect(code(() => prepare(buildSimInput({ people, accounts: [accounts[0]!, accounts[2]!], rothConversions: [{ ...entry, year: 2030 }] })))).toBe("conversion_no_roth");
    expect(code(() => prepare(buildSimInput({ people, accounts, rothConversions: [{ ...entry, personId: "p2", year: 2030 }] })))).toBe("person_missing");
  });
});

describe("The year functions allocate nothing (engine-and-returns §3.15, §4.3)", () => {
  it("10,000 path-years of incomeYearInto, contributionsYearInto and conversionsYearInto leave the heap unchanged within noise", () => {
    const run = prepare(fixtureSimInput());
    const cpi = constantCpi(0.025, 47);
    const amounts = new Float64Array(run.incomes.count);
    const out = new Float64Array(IY_REC);
    const employee = new Float64Array(run.contributions.count);
    const employer = new Float64Array(run.contributions.count);
    const conv = new Float64Array(run.personCount);
    const aliveBoth = Uint8Array.of(1, 1);
    const aliveOne = Uint8Array.of(0, 1);
    const year = (calls: number) => {
      for (let n = 0; n < calls; n++) {
        const t = n % 47;
        const alive = (n & 1) === 0 ? aliveBoth : aliveOne;
        incomeYearInto(run.incomes, t, cpi, alive, amounts, out);
        contributionsYearInto(run.contributions, run.incomes, t, cpi, alive, employee, employer);
        conversionsYearInto(run.conversions, t, cpi, conv);
      }
    };
    year(200_000); // warm-up: let the optimizing compiler settle
    const before = process.memoryUsage().heapUsed;
    year(10_000);
    const after = process.memoryUsage().heapUsed;
    // One boxed double per call would be 160 KB.
    expect(after - before).toBeLessThan(64 * 1024);
  });
});
