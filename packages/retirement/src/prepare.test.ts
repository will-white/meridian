import { type AssetClassMap, type SimInput, type SimInputAccount, SimInput as SimInputSchema } from "@meridian/shared";
import { fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { detPow } from "./detmath.js";
import { EngineInputError } from "./errors.js";
import { IY, IY_REC, incomeYearInto } from "./flows.js";
import { BILLS, BONDS, STOCKS } from "./models/index.js";
import { TREATMENT, limitIssues, prepare, validateInput } from "./prepare.js";
import { AD, PR, accountDragOffset, progOffset } from "./tax/layout.js";
import { TRADE_FLOWS_ONLY, TRADE_FULL } from "./trades.js";
import { account, buildSimInput, cashAccount, incomeStream } from "./testing/simInput.js";
import { DATA_VERSION } from "./version.js";

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof EngineInputError) return e.code;
    throw e;
  }
  return undefined;
}

const W = (us: number, intl: number, bonds: number, cash: number, realEstate = 0, other = 0) => ({
  us_stock: us,
  intl_stock: intl,
  bonds,
  cash,
  real_estate: realEstate,
  other,
});

/** The three target fractions of account a in plan year t. */
function targetOf(run: ReturnType<typeof prepare>, t: number, a: number): number[] {
  const o = (t * run.accountCount + a) * 3;
  return [run.weights[o]!, run.weights[o + 1]!, run.weights[o + 2]!];
}

function holdings(arr: Float64Array, a: number): number[] {
  return [arr[a * 3 + STOCKS]!, arr[a * 3 + BONDS]!, arr[a * 3 + BILLS]!];
}

describe("T29 glide path (engine-and-returns §3.2 and §7 T29; seams C29)", () => {
  // Plan from January 2027 to 2057 (born 1962, fixed 95). Points (2030: 80/20/0) and (2040:
  // 50/40/10) in US stock / bonds / cash, through the shared glideWeightsAt and the default map.
  const glide = [
    { year: 2030, weights: W(8000, 0, 2000, 0) },
    { year: 2040, weights: W(5000, 0, 4000, 1000) },
  ];
  const run = prepare(
    buildSimInput({
      accounts: [account("ira", "pre_tax", "10000000", { allocation: W(8000, 0, 2000, 0), glidePath: glide }), account("plain", "pre_tax", "5000000", { allocation: W(3000, 3000, 3000, 1000) }), cashAccount("cash", "0")],
    }),
  );

  it("T29 2027 → (0.8, 0.2, 0); 2034 → (0.68, 0.28, 0.04); 2045 → (0.5, 0.4, 0.1)", () => {
    // 2034: d = 4, span = 10: US (8000 × 6 + 5000 × 4) / 10 = 6800, bonds 2800, cash 400, exact.
    expect(targetOf(run, 0, 0)).toEqual([0.8, 0.2, 0]);
    expect(targetOf(run, 7, 0)).toEqual([0.68, 0.28, 0.04]);
    expect(targetOf(run, 18, 0)).toEqual([0.5, 0.4, 0.1]);
    expect(targetOf(run, 30, 0)).toEqual([0.5, 0.4, 0.1]);
  });

  it("T29 without a glide path the target is the starting mix every year", () => {
    // 30% US + 30% international → stocks 0.6; bonds 0.3; cash → bills 0.1.
    for (let t = 0; t < run.years; t++) expect(targetOf(run, t, 1)).toEqual([0.6, 0.3, 0.1]);
    expect(holdings(run.bal0, 1)).toEqual([30000, 15000, 5000]);
  });

  it("T29 the starting holdings follow the current allocation, not the glide path's first point", () => {
    expect(holdings(run.bal0, 0)).toEqual([80000, 20000, 0]);
  });

  it("C29 the six-class targets are glideWeightsAt's basis points (inputs §3.9: 5333 / 1667 / 2333 / 667 at 2031)", () => {
    const r = prepare(
      buildSimInput({
        accounts: [
          account("ira", "pre_tax", "100", {
            allocation: W(6000, 2000, 1500, 500),
            glidePath: [
              { year: 2030, weights: W(6000, 2000, 1500, 500) },
              { year: 2033, weights: W(4000, 1000, 4000, 1000) },
            ],
          }),
        ],
      }),
    );
    const A = r.accountCount;
    const six = (t: number) => Array.from(r.classWeights.subarray(t * A * 6, t * A * 6 + 6));
    expect(six(4)).toEqual([0.5333, 0.1667, 0.2333, 0.0667, 0, 0]);
    expect(targetOf(r, 4, 0)).toEqual([0.7, 0.2333, 0.0667]);
    expect(six(3)).toEqual([0.6, 0.2, 0.15, 0.05, 0, 0]);
    expect(six(6)).toEqual([0.4, 0.1, 0.4, 0.1, 0, 0]);
  });

  it("T29 a cash account is all bills whatever its allocation says; a custom asset map is applied", () => {
    const r = prepare(
      buildSimInput({
        accounts: [account("odd", "cash", "100000", { allocation: W(10000, 0, 0, 0) }), account("other", "taxable", "100000", { allocation: W(0, 0, 0, 0, 0, 10000) })],
        portfolio: {
          taxableRebalance: "flows_only",
          assetClassMap: { us_stock: [10000, 0, 0], intl_stock: [10000, 0, 0], bonds: [0, 10000, 0], cash: [0, 0, 10000], real_estate: [10000, 0, 0], other: [5000, 0, 5000] },
        },
      }),
    );
    expect(holdings(r.bal0, 0)).toEqual([0, 0, 1000]);
    expect(targetOf(r, 0, 0)).toEqual([0, 0, 1]);
    expect(Array.from(r.classWeights.subarray(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(holdings(r.bal0, 1)).toEqual([500, 0, 500]);
    expect(targetOf(r, 5, 1)).toEqual([0.5, 0, 0.5]);
    expect(Array.from(r.assetMap.subarray(15, 18))).toEqual([0.5, 0, 0.5]);
    expect(r.tradeMode).toBe(TRADE_FLOWS_ONLY);
  });

  it("T29 a glide path whose years do not ascend is glide_order", () => {
    const points = [
      { year: 2040, weights: W(5000, 0, 5000, 0) },
      { year: 2030, weights: W(8000, 0, 2000, 0) },
    ];
    expect(code(() => prepare(buildSimInput({ accounts: [account("ira", "pre_tax", "100", { glidePath: points }), cashAccount("c", "0")] })))).toBe("glide_order");
  });
});

describe("C18 (b) basis seeding: the bill slice at value, the rest over stocks and bonds by value", () => {
  it("C18 the fixture's brokerage account: 25,620.9492 / 0 / 1,431.0508 with basis 22,350.9492 / 0 / 1,431.0508", () => {
    // B: 27,052.00 at 6839 US + 2632 international (9471 → stocks) and 529 cash (bills).
    // stocks 27,052 × 0.9471 = 25,620.9492; bills 27,052 × 0.0529 = 1,431.0508.
    // basis 23,782.00: bills 1,431.0508 at value; stocks 23,782 − 1,431.0508 = 22,350.9492; bonds 0.
    const run = prepare(fixtureSimInput());
    const b = run.accountIds.indexOf("a0000000-0000-4000-8000-000000000007");
    expect(holdings(run.bal0, b)).toEqual([25620.9492, 0, 1431.0508]);
    const basis = holdings(run.basis0, b);
    expect(basis[0]).toBeCloseTo(22350.9492, 9);
    expect(basis[1]).toBe(0);
    expect(basis[2]).toBe(1431.0508);
  });

  it("C18 a mixed account: 100,000 at 60/30/10 with basis 70,000 → bills 10,000 at value, 60,000 split 40,000 / 20,000", () => {
    const run = prepare(buildSimInput({ accounts: [account("t", "taxable", "10000000", { allocation: W(6000, 0, 3000, 1000), basisCents: "7000000" })] }));
    expect(holdings(run.bal0, 0)).toEqual([60000, 30000, 10000]);
    expect(holdings(run.basis0, 0)).toEqual([40000, 20000, 10000]);
  });

  it("C18 a basis below the bill slice leaves stocks and bonds at 0 and the bills at value; an absent basis counts 0", () => {
    const below = prepare(buildSimInput({ accounts: [account("t", "taxable", "10000000", { allocation: W(6000, 0, 3000, 1000), basisCents: "500000" })] }));
    expect(holdings(below.basis0, 0)).toEqual([0, 0, 10000]);
    const unknown = prepare(buildSimInput({ accounts: [account("t", "taxable", "10000000", { allocation: W(6000, 0, 3000, 1000) })] }));
    expect(holdings(unknown.basis0, 0)).toEqual([0, 0, 10000]);
  });

  it("C18 an all-stock account takes the whole basis on stocks; an account above its value keeps the excess (an unrealized loss)", () => {
    const run = prepare(
      buildSimInput({ accounts: [account("t", "taxable", "432500", { basisCents: "200000" }), account("loss", "taxable", "100000", { allocation: W(5000, 0, 5000, 0), basisCents: "300000" })] }),
    );
    expect(holdings(run.basis0, 0)).toEqual([2000, 0, 0]);
    expect(holdings(run.basis0, 1)).toEqual([1500, 1500, 0]);
  });

  it("C18 only taxable accounts carry basis", () => {
    const run = prepare(
      buildSimInput({ accounts: [account("ira", "pre_tax", "100000", { basisCents: "100000" }), account("roth", "roth", "100000"), account("hsa", "hsa", "100000"), cashAccount("c", "100000")] }),
    );
    expect(Array.from(run.basis0)).toEqual(new Array(12).fill(0));
    expect(Array.from(run.treatment)).toEqual([TREATMENT.pre_tax, TREATMENT.roth, TREATMENT.hsa, TREATMENT.cash]);
  });
});

describe("C24 the surplus account", () => {
  it("C24 the largest taxable account by starting balance (the fixture: B, not T)", () => {
    const run = prepare(fixtureSimInput());
    expect(run.accountIds[run.surplusAccount]).toBe("a0000000-0000-4000-8000-000000000007");
  });

  it("C24 ties go to the lower id; with no taxable account the largest cash account", () => {
    const tie = prepare(buildSimInput({ accounts: [account("t_b", "taxable", "500"), account("t_a", "taxable", "500"), cashAccount("c", "900")] }));
    expect(tie.accountIds[tie.surplusAccount]).toBe("t_a");
    const cash = prepare(buildSimInput({ accounts: [account("ira", "pre_tax", "9000"), cashAccount("c_small", "100"), cashAccount("c_big", "200")] }));
    expect(cash.accountIds[cash.surplusAccount]).toBe("c_big");
  });

  it("C24 the builder adds synthetic:cash like the resolver; an input with neither kind is surplus_account_missing", () => {
    const input = buildSimInput({ accounts: [account("roth", "roth", "100000")] });
    const run = prepare(input);
    expect(run.accountIds).toEqual(["roth", "synthetic:cash"]);
    expect(run.accountIds[run.surplusAccount]).toBe("synthetic:cash");
    expect(run.synthetic[1]).toBe(1);
    expect(code(() => prepare({ ...input, accounts: [input.accounts[0]!] }))).toBe("surplus_account_missing");
  });
});

describe("C25 fund costs from expenseRatioPpm", () => {
  it("C25 the fixture: B's 270 ppm gives 0.99973 a year and 0.99973^(1/4) in the three-month first year", () => {
    // 0.99973^0.25 = exp(ln(0.99973) / 4) = exp(−0.0000675091141405822) = 0.999932493164548386 (50-digit decimals).
    const run = prepare(fixtureSimInput());
    const b = run.accountIds.indexOf("a0000000-0000-4000-8000-000000000007");
    expect(run.fee[b]).toBe(1 - 270 / 1_000_000);
    expect(run.feeFirst[b]).toBeCloseTo(0.999932493164548386, 15);
    expect(run.feeFirst[b]).toBe(detPow(0.99973, 0.25));
    for (let a = 0; a < run.accountCount; a++) {
      if (a === b) continue;
      expect(run.fee[a]).toBe(1);
      expect(run.feeFirst[a]).toBe(1);
    }
  });

  it("C25 with a whole first year the first year's cost is the yearly one", () => {
    const run = prepare(buildSimInput({ accounts: [account("t", "taxable", "100", { expenseRatioPpm: 5000 })] }));
    expect(run.fee[0]).toBe(0.995);
    expect(run.feeFirst[0]).toBe(0.995);
  });
});

describe("C12 the compiles inside prepare: tax law, tax drag, Social Security, RMD, strategies", () => {
  const run = prepare(fixtureSimInput());

  it("C12 the tax law of the rule set, over the plan's years; its compile warnings come separately", () => {
    expect([run.law.startYear, run.law.years, run.law.ruleSetId]).toEqual([2026, 47, "current_law"]);
    // The 2027 plan limits are still pending (seams §9 item 3).
    expect(run.compileWarnings.map((w) => w.code)).toEqual(["limits_pending"]);
    expect(run.fillOptions).toEqual({ chainedCpiWedge: 0, realWageGrowth: 0 });
    expect(run.includePayrollTax).toBe(true);
    expect(run.lossCarryIn).toBe(0);
  });

  it("C12 C17 the fixture's brokerage account blends to a 1.72% dividend yield, 86% qualified", () => {
    // (6839 × 1.3% + 2632 × 2.8%) / 9471 = 162.603 / 9471 = 0.0171685144124168;
    // qualified (88.907 × 0.95 + 73.696 × 0.75) / 162.603 = 139.73365 / 162.603 = 0.859354685952904.
    const b = run.accountIds.indexOf("a0000000-0000-4000-8000-000000000007");
    for (const t of [0, 20, 46]) {
      const o = accountDragOffset(t, b, run.accountCount);
      expect(run.accountDrag[o + AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(0.0171685144124168, 15);
      expect(run.accountDrag[o + AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(0.859354685952904, 14);
    }
  });

  it("C12 the Social Security plan: Alex 2,800 claimed June 2042, Sam 1,900 claimed September 2044", () => {
    const [alex, sam] = run.ssPlan.people;
    expect([alex!.piaAtStart, alex!.claimIndex, alex!.fra]).toEqual([2800, 2042 * 12 + 5, 804]);
    expect([sam!.piaAtStart, sam!.claimIndex, sam!.fra]).toEqual([1900, 2044 * 12 + 8, 804]);
  });

  it("C12 the benefit adjustment reaches the program table; the tax settings their fractions", () => {
    const base = fixtureSimInput();
    const r = prepare({
      ...base,
      socialSecurity: { ...base.socialSecurity, adjustment: { fromYear: 2040, factorBp: 8000 } },
      settings: { ...base.settings, tax: { ...base.settings.tax, chainedCpiWedgeBp: 25, realWageGrowthBp: 50, includePayrollTax: false, capLossCarryInCents: "123456" } },
    });
    expect(r.law.progBase[progOffset(13) + PR.SS_SCALE]).toBe(1);
    expect(r.law.progBase[progOffset(14) + PR.SS_SCALE]).toBe(0.8);
    expect(r.fillOptions).toEqual({ chainedCpiWedge: 0.0025, realWageGrowth: 0.005 });
    expect(r.includePayrollTax).toBe(false);
    expect(r.lossCarryIn).toBe(1234.56);
  });

  it("C12 C19 the basis-reset shares follow the state: one half for a joint account in Colorado, all of it in California", () => {
    expect([run.ownStepUp, run.jointStepUp]).toEqual([1, 0.5]);
    const ca = prepare({ ...fixtureSimInput(), household: { ...fixtureSimInput().household, state: "CA" } });
    expect(ca.jointStepUp).toBe(1);
  });

  it("C12 the strategy tables come from prepareStrategies on the same clock", () => {
    expect(run.strategies.years).toBe(47);
    expect(run.strategies.coreShare[8]).toBe(0);
    expect(run.strategies.coreShare[9]).toBe(7 / 12);
    expect(run.strategies.goalReal[5]).toBe(18000);
  });
});

describe("C13 validateInput and the engine's error codes", () => {
  const ok = () => buildSimInput({ people: [{ birthYear: 1962 }] });

  it("C13 a runnable input has no issues; validateInput never throws on an input error", () => {
    expect(validateInput(fixtureSimInput())).toEqual([]);
    expect(validateInput(ok())).toEqual([]);
    expect(validateInput({ ...ok(), data: { version: "1999.01.0" } })).toEqual([
      { code: "data_version_mismatch", message: `the input was frozen for data version 1999.01.0; this engine carries ${DATA_VERSION}` },
    ]);
  });

  it("C13 the resolver's limits are reported together: 33 accounts, 41 income streams, 121 conversions", () => {
    const base = ok();
    const input: SimInput = {
      ...base,
      accounts: Array.from({ length: 33 }, (_, i) => cashAccount(`c${String(i).padStart(2, "0")}`, "0")),
      incomes: Array.from({ length: 41 }, (_, i) => incomeStream(`r${i}`, "rental", "100", "2027-01")),
      rothConversions: Array.from({ length: 121 }, (_, i) => ({ year: 2027 + (i % 30), personId: "p1" as const, amountCents: "1", dollars: "today" as const })),
    };
    expect(validateInput(input).map((i) => i.code)).toEqual(["too_many_accounts", "too_many_incomes", "too_many_conversions"]);
    expect(limitIssues({ ...input, accounts: base.accounts }).map((i) => i.code)).toEqual(["too_many_incomes", "too_many_conversions"]);
    expect(code(() => prepare(input))).toBe("too_many_accounts");
    // 32 accounts, 40 streams and 120 conversions are within the limits.
    expect(limitIssues({ ...input, accounts: input.accounts.slice(0, 32), incomes: input.incomes.slice(0, 40), rothConversions: input.rothConversions.slice(0, 120) })).toEqual([]);
  });

  it("C13 the horizon and the path-year cap", () => {
    expect(code(() => prepare(buildSimInput({ endYear: 2147 })))).toBe("horizon_too_long");
    expect(code(() => prepare(buildSimInput({ endYear: 2056 })))).toBe("plan_invalid");
    // Born 1995, fixed 95: 2027 to 2090, 64 years; 100,000 bootstrap paths × 64 > 6,000,000.
    const long = { people: [{ birthYear: 1995 }], returnModel: { kind: "bootstrap", meanBlockYears: 10 } } as const;
    expect(code(() => prepare(buildSimInput({ ...long, paths: 100000 })))).toBe("path_years_too_many");
    expect(code(() => prepare(buildSimInput({ ...long, paths: 93750 })))).toBe(undefined); // 93,750 × 64 = 6,000,000
    expect(code(() => prepare(buildSimInput({ ...long, paths: 93751 })))).toBe("path_years_too_many");
  });

  it("C13 the household: filing status, duplicate ids, a person an account names", () => {
    const base = ok();
    expect(code(() => prepare({ ...base, household: { ...base.household, filingStatus: "married_joint" } }))).toBe("household_invalid");
    const two = buildSimInput({ people: [{ birthYear: 1960 }, { birthYear: 1962 }] });
    expect(code(() => prepare({ ...two, household: { ...two.household, people: [two.household.people[0]!, { ...two.household.people[1]!, id: "p1" }] } }))).toBe(
      "household_invalid",
    );
    expect(code(() => prepare(buildSimInput({ accounts: [account("ira", "pre_tax", "100", { owner: "p2" }), cashAccount("c", "0")] })))).toBe("person_missing");
  });

  it("C13 the accounts: owner_required, account_invalid", () => {
    expect(code(() => prepare(buildSimInput({ accounts: [account("ira", "pre_tax", "100", { owner: "joint" }), cashAccount("c", "0")] })))).toBe("owner_required");
    expect(code(() => prepare(buildSimInput({ accounts: [account("hsa", "hsa", "100", { owner: "joint" }), cashAccount("c", "0")] })))).toBe("owner_required");
    expect(code(() => prepare(buildSimInput({ accounts: [cashAccount("c", "0"), cashAccount("c", "1")] })))).toBe("account_invalid");
  });

  it("C13 the tax data: start_year_unsupported before 2026; an unknown rule set keeps its code as an EngineInputError (C7)", () => {
    expect(code(() => prepare(buildSimInput({ startYear: 2025 })))).toBe("start_year_unsupported");
    let caught: unknown;
    try {
      prepare(buildSimInput({ taxRuleSet: "no_such_rule_set" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineInputError);
    expect((caught as EngineInputError).code).toBe("unknown_rule_set");
    expect(validateInput(buildSimInput({ taxRuleSet: "no_such_rule_set" })).map((i) => i.code)).toEqual(["unknown_rule_set"]);
  });

  it("C13 the other areas' codes surface through prepare: social_security_invalid, spending_invalid, historical_horizon_too_long", () => {
    const base = ok();
    expect(
      code(() =>
        prepare({
          ...base,
          socialSecurity: {
            people: [{ personId: "p1", mode: "estimate", monthlyAtFraCents: "100", asOfYear: 2026, claimMonth: "2020-01", claimAgeMonths: 700 }],
            spousal: true,
            survivor: true,
          },
        }),
      ),
    ).toBe("social_security_invalid");
    expect(code(() => prepare(buildSimInput({ spending: { baseAnnualCents: "100", essentialAnnualCents: "200" } })))).toBe("spending_invalid");
    // Born 2010, fixed 119: 2027 to 2129, 103 years against 98 years of data.
    const tooLong = buildSimInput({ people: [{ birthYear: 2010, longevity: { mode: "fixed", age: 119 } }], returnModel: { kind: "historical", cohorts: "complete" } });
    expect(validateInput(tooLong).map((i) => i.code)).toEqual(["historical_horizon_too_long"]);
  });
});

describe("Run warnings from prepare (engine-and-returns §2.6)", () => {
  const codes = (input: SimInput) => prepare(input).warnings.map((w) => w.code);

  it("intl_modelled_as_us when international stock is held or targeted; none for a US-only plan", () => {
    expect(codes(fixtureSimInput())).toEqual(["intl_modelled_as_us"]);
    const us = buildSimInput({ accounts: [account("t", "taxable", "100")], returnModel: { kind: "bootstrap", meanBlockYears: 10 } });
    expect(codes(us)).toEqual([]);
    const glide = buildSimInput({
      accounts: [account("t", "taxable", "100", { glidePath: [{ year: 2040, weights: W(5000, 5000, 0, 0) }] })],
      returnModel: { kind: "bootstrap", meanBlockYears: 10 },
    });
    expect(codes(glide)).toEqual(["intl_modelled_as_us"]);
  });

  it("other_mapped_to_stocks above 5% of the portfolio under the default map", () => {
    const model = { kind: "bootstrap", meanBlockYears: 10 } as const;
    const withOther = (otherBp: number, map?: Parameters<typeof buildSimInput>[0]) =>
      buildSimInput({ accounts: [account("t", "taxable", "100000", { allocation: W(10000 - otherBp, 0, 0, 0, 0, otherBp) })], returnModel: model, ...map });
    const w = prepare(withOther(600)).warnings;
    expect(w.map((x) => x.code)).toEqual(["other_mapped_to_stocks"]);
    expect(w[0]!.message).toContain("6% of the portfolio");
    expect(codes(withOther(500))).toEqual([]);
    const map: AssetClassMap = { us_stock: [10000, 0, 0], intl_stock: [10000, 0, 0], bonds: [0, 10000, 0], cash: [0, 0, 10000], real_estate: [10000, 0, 0], other: [0, 0, 10000] };
    expect(codes(withOther(600, { portfolio: { taxableRebalance: "full", assetClassMap: map } }))).toEqual([]);
  });

  it("first_year_lump for a goal or a conversion dated in a partial first year", () => {
    const model = { kind: "bootstrap", meanBlockYears: 10 } as const;
    const goal = { goals: [{ id: "car", name: "car", year: 2026, amountCents: "100", dollars: "today" as const }] };
    expect(codes(buildSimInput({ startYear: 2026, startMonth: 7, spending: goal, returnModel: model }))).toEqual(["first_year_lump"]);
    expect(codes(buildSimInput({ startYear: 2026, startMonth: 1, spending: goal, returnModel: model }))).toEqual([]);
    const conv = buildSimInput({
      startYear: 2026,
      startMonth: 7,
      accounts: [account("ira", "pre_tax", "100"), account("roth", "roth", "0"), cashAccount("c", "0")],
      rothConversions: [{ year: 2026, personId: "p1", amountCents: "100", dollars: "today" }],
      returnModel: model,
    });
    expect(codes(conv)).toEqual(["first_year_lump"]);
  });

  it("the return model's and mortality's warnings pass through", () => {
    const fixed = buildSimInput();
    expect(codes(fixed)).toEqual(["path_count_adjusted"]);
    const table = buildSimInput({ people: [{ birthYear: 1962, longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge: 110 } }], returnModel: { kind: "bootstrap", meanBlockYears: 10 } });
    expect(codes(table)).toEqual(["mortality_fallback_table"]);
  });
});

describe("People and Roth seeds", () => {
  it("retirement, the drawdown start and RMD ages; a spending start before the plan is drawdown from year 0", () => {
    const run = prepare(fixtureSimInput());
    expect(Array.from(run.birthIndex)).toEqual([1975 * 12 + 5, 1977 * 12 + 8]);
    expect(Array.from(run.retirementYear)).toEqual([2035, 2039]);
    expect(Array.from(run.retiredFrom)).toEqual([9, 13]);
    expect(run.drawdownStart).toBe(9);
    expect(Array.from(run.rmdStartAge)).toEqual([75, 75]);
    const early = buildSimInput({ startYear: 2027, people: [{ birthYear: 1950, retirementMonth: "2010-01" }] });
    const r = prepare({ ...early, spending: { ...early.spending, startMonth: "2010-01" } });
    expect([r.drawdownStart, r.retiredFrom[0], r.rmdStartAge[0]]).toEqual([0, -17, 72]);
  });

  it("tax-rmd-ss §3.7.3: the entered basis is summed per person; an account without one marks the basis unknown; a synthetic account does not", () => {
    const run = prepare(
      buildSimInput({
        people: [{ birthYear: 1960 }, { birthYear: 1962 }],
        accounts: [
          account("r1", "roth", "100000", { owner: "p1", rothContributionBasisCents: "4000000" }),
          account("r2", "roth", "0", { owner: "p1", rothContributionBasisCents: "100000" }),
          account("r3", "roth", "500000", { owner: "p2" }),
          account("synthetic:roth:p2", "roth", "0", { owner: "p2", synthetic: true }),
          cashAccount("c", "0"),
        ],
      }),
    );
    expect(Array.from(run.rothBasis0)).toEqual([41000, 0]);
    expect(Array.from(run.rothFunded)).toEqual([1, 1]);
    expect(Array.from(run.rothBasisUnknown)).toEqual([0, 1]);
    const synthOnly = prepare(buildSimInput({ accounts: [account("synthetic:roth:p1", "roth", "0", { synthetic: true }), cashAccount("c", "0")] }));
    expect([synthOnly.rothBasis0[0], synthOnly.rothFunded[0], synthOnly.rothBasisUnknown[0]]).toEqual([0, 0, 0]);
  });
});

describe("Test 11: the inputs fixture's frozen input prepared to stated values (inputs-and-data §7.0, seams §10)", () => {
  // The shared fixture (packages/shared/src/retirement/testFixtures.ts): test 11's frozen input with
  // seams §10's additions (expenseRatioPpm, inBase, settings.tax / settings.portfolio).
  const input = fixtureSimInput();
  const run = prepare(input);
  const ids = run.accountIds;
  const at = (id: string) => ids.indexOf(id);
  const K = at("a0000000-0000-4000-8000-000000000001");
  const H = at("a0000000-0000-4000-8000-000000000002");
  const T = at("a0000000-0000-4000-8000-000000000003");
  const S = at("a0000000-0000-4000-8000-000000000004");
  const B = at("a0000000-0000-4000-8000-000000000007");
  const R = at("a0000000-0000-4000-8000-000000000008");
  const C = at("a0000000-0000-4000-8000-000000000009");
  const X = at("synthetic:roth:p1");

  it("11 the input is a valid frozen input and prepare does not change it", () => {
    expect(SimInputSchema.safeParse(input).success).toBe(true);
    const before = JSON.stringify(input);
    prepare(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("11 the clock: 2026-10 to 2072, 47 years, f = 1/4; fixed lives end in 2070 and 2072", () => {
    expect([run.startYear, run.years, run.firstYearFraction, run.personCount, run.accountCount]).toEqual([2026, 47, 0.25, 2, 8]);
    expect(Array.from(run.mortality.fixedIndex)).toEqual([44, 46]);
    expect(run.mortality.allFixed).toBe(true);
    expect([run.model.kind, run.paths]).toEqual(["bootstrap", 10000]);
  });

  it("11 eight accounts: treatments, owners, the 401(k) as employer plan, the synthetic Roth", () => {
    expect([K, H, T, S, B, R, C, X]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(run.treatment)).toEqual([1, 3, 0, 4, 0, 2, 4, 2]);
    expect(Array.from(run.owner0)).toEqual([0, 0, -1, -1, -1, 1, -1, 0]);
    expect(Array.from(run.employerPlan)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(run.synthetic)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("11 the starting holdings on stocks / bonds / bills sum to 225,827.00 (22,582,700 cents)", () => {
    // K 150,000 and H 1,250 at the household targets 5000 / 2500 / 2000 / 500: 75% / 20% / 5%.
    expect(holdings(run.bal0, K)).toEqual([112500, 30000, 7500]);
    expect(holdings(run.bal0, H)).toEqual([937.5, 250, 62.5]);
    expect(holdings(run.bal0, T)).toEqual([4325, 0, 0]);
    expect(holdings(run.bal0, B)).toEqual([25620.9492, 0, 1431.0508]);
    // R 18,200 at 4680 / 831 / 4341 / 148: stocks 5511 → 10,030.02; bonds 7,900.62; bills 269.36.
    expect(holdings(run.bal0, R)).toEqual([10030.02, 7900.62, 269.36]);
    expect(holdings(run.bal0, S)).toEqual([0, 0, 20000]);
    expect(holdings(run.bal0, C)).toEqual([0, 0, 5000]);
    expect(holdings(run.bal0, X)).toEqual([0, 0, 0]);
    let total = 0;
    for (const x of run.bal0) total += x;
    expect(total).toBeCloseTo(225827, 8);
    // T's basis 2,000.00 on stocks; B's as C18 above; nothing else carries basis.
    expect(holdings(run.basis0, T)).toEqual([2000, 0, 0]);
    for (const a of [K, H, S, R, C, X]) expect(holdings(run.basis0, a)).toEqual([0, 0, 0]);
  });

  it("11 no glide path: every year's target is the starting mix", () => {
    for (const t of [0, 13, 46]) {
      expect(targetOf(run, t, K)).toEqual([0.75, 0.2, 0.05]);
      expect(targetOf(run, t, R)).toEqual([0.5511, 0.4341, 0.0148]);
      expect(targetOf(run, t, S)).toEqual([0, 0, 1]);
    }
  });

  it("11 people: retired from 2035 and 2039, drawdown from 2035 (t = 9); the Roth seeds", () => {
    expect(Array.from(run.retiredFrom)).toEqual([9, 13]);
    expect(run.drawdownStart).toBe(9);
    // Alex has only the synthetic Roth (no basis, unfunded); Sam's R is funded, its basis not entered.
    expect(Array.from(run.rothBasis0)).toEqual([0, 0]);
    expect(Array.from(run.rothFunded)).toEqual([0, 1]);
    expect(Array.from(run.rothBasisUnknown)).toEqual([0, 1]);
  });

  it("11 the streams: salaries from the plan start, the pension from 2039 (t0 = 13), nominal without COLA", () => {
    expect(run.incomes.ids).toEqual(["pen1", "salary_p1", "salary_p2"]);
    expect(Array.from(run.incomes.firstYear)).toEqual([13, 0, 0]);
    expect(Array.from(run.incomes.cpiNow)).toEqual([0, 1, 1]);
    expect(Array.from(run.incomes.cpiStart)).toEqual([0, 0, 0]);
    expect(Array.from(run.incomes.salaryOf)).toEqual([1, 2]);
    const out = new Float64Array(IY_REC);
    const amounts = new Float64Array(3);
    const cpi = Float64Array.from({ length: 48 }, () => 1);
    incomeYearInto(run.incomes, 0, cpi, Uint8Array.of(1, 1), amounts, out);
    // October to December: 120,000 × 3/12 and 60,000 × 3/12.
    expect([out[IY.WAGES0], out[IY.WAGES1], out[IY.CASH]]).toEqual([30000, 15000, 45000]);
    incomeYearInto(run.incomes, 13, cpi, Uint8Array.of(1, 1), amounts, out);
    // 2039 (seams §4): Sam's salary 60,000 × 8/12 = 40,000; the pension 1,000 × 4 months = 4,000.
    expect([out[IY.WAGES0], out[IY.WAGES1], out[IY.PENSION]]).toEqual([0, 40000, 4000]);
  });

  it("11 contributions, conversions, the surplus account and the warnings", () => {
    expect(Array.from(run.contributions.account)).toEqual([K, H, B, R]);
    expect(Array.from(run.contributions.employee0)).toEqual([12000, 3600, 5000, 3000]);
    expect(Array.from(run.contributions.employer0)).toEqual([6000, 0, 0, 0]);
    expect(run.conversions.real[0 * 47 + 10]).toBe(30000);
    expect(run.conversions.target[0]).toBe(X);
    expect(run.surplusAccount).toBe(B);
    expect(run.tradeMode).toBe(TRADE_FULL);
    expect(run.warnings.map((w) => w.code)).toEqual(["intl_modelled_as_us"]);
    expect(run.compileWarnings.map((w) => w.code)).toEqual(["limits_pending"]);
  });

  it("11 a resolver-shaped input with a fixture account of each bucket passes validateInput; a joint Roth would not", () => {
    expect(validateInput(input)).toEqual([]);
    const bad: SimInputAccount = { ...input.accounts[R]!, owner: "joint" };
    expect(validateInput({ ...input, accounts: input.accounts.map((a, i) => (i === R ? bad : a)) }).map((i) => i.code)).toEqual(["owner_required"]);
  });
});
