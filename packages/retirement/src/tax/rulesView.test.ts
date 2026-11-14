import { FederalTaxPreviewRequest, FederalTaxPreviewResponse, PLANNER_DISCLAIMER, RetirementRulesView, SocialSecurityPreviewRequest } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import * as contributionLimits from "./contributionLimits.js";
import { TaxInputError } from "./federalTax.js";
import { NOT_MODELLED } from "./notModelled.js";
import * as rules from "./rulesView.js";
import { SS_RULES, socialSecurityPreviewView } from "./socialSecurity.js";
import { TaxDataError, loadTaxData } from "./taxData.js";

// The tax area's read-only views for the API (tax-rmd-ss §4.1 rulesView.ts, §4.3, §4.4; seams
// §2.4, C42): route 22 `GET /rules` (buildRulesView; test A7 through the view), route 23
// `POST /tax-preview` (federalTaxPreview; B1, C6 and J1 (a) through the wire shapes) and route 24
// `POST /social-security-preview` (socialSecurityPreviewView, tested in socialSecurity.test.ts H17).

const data = loadTaxData();
const { buildRulesView, federalTaxPreview, listTaxRuleSets, fullRetirementAgeTable, TAX_DATA_FIRST_YEAR } = rules;

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("route 22: buildRulesView", () => {
  const view = buildRulesView("2026-11-13");

  it("A7 stale is false on 2027-12-31 and true on 2028-01-01; pendingLimits is empty (Notice 2026-66 published the 2027 plan limits)", () => {
    expect(buildRulesView("2027-12-31").stale).toBe(false);
    expect(buildRulesView("2028-01-01").stale).toBe(true);
    expect(view.pendingLimits).toEqual([]);
    expect(() => buildRulesView("2026-13-01")).toThrow(RangeError);
  });

  it("parses with the shared RetirementRulesView and carries the data version, the years and the disclaimer", () => {
    expect(RetirementRulesView.safeParse(view).success).toBe(true);
    expect(view.dataVersion).toBe(data.dataVersion);
    expect([view.firstTaxYear, view.lastPublishedYear]).toEqual([2026, 2027]);
    expect(view.years.map((y) => y.taxYear)).toEqual([2026, 2027]);
    expect(view.years[0]).toEqual(data.years.get(2026));
    expect(Object.isFrozen(view.years[0])).toBe(false);
    expect(view.disclaimer).toBe(PLANNER_DISCLAIMER);
  });

  it("the four rule sets, current_law first, each with its law changes; illustrative when any law change is", () => {
    expect(view.ruleSets.map((r) => [r.id, r.illustrative, r.lawChanges.map((c) => c.id)])).toEqual([
      ["current_law", false, ["senior_deduction_sunset"]],
      ["senior_deduction_permanent", false, []],
      ["ss_shortfall_2033", true, ["senior_deduction_sunset", "ss_trust_fund_shortfall"]],
      ["rates_plus_2pts_2031", true, ["senior_deduction_sunset", "ordinary_rates_plus_2pts_2031"]],
    ]);
    expect(view.ruleSets[0]!.lawChanges[0]).toEqual({
      id: "senior_deduction_sunset",
      label: data.rules.lawChanges["senior_deduction_sunset"]!.label,
      description: data.rules.lawChanges["senior_deduction_sunset"]!.description,
      illustrative: false,
    });
    expect(view.ruleSets.map((r) => ({ id: r.id, label: r.label }))).toEqual(listTaxRuleSets());
  });

  it("the indexing rules without their steps", () => {
    expect(view.indexing).toHaveLength(data.rules.indexing.length);
    expect(view.indexing[0]).toEqual({ path: "ordinary.thresholds", index: "cpi", round: "floor_increase" });
    expect(view.indexing.find((r) => r.path === "payroll.oasdiWageBase")).toEqual({ path: "payroll.oasdiWageBase", index: "wage", round: "nearest" });
  });

  it("the yield assumptions in basis points, rounded half away from zero; the spread is null for a class that pays no interest", () => {
    // 0.013 × 10,000 is 130.00000000000003 in float64: 130.
    expect(view.taxDrag).toEqual({
      us_stock: { dividendYieldBp: 130, qualifiedShareBp: 9500, interestSpreadBp: null, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
      intl_stock: { dividendYieldBp: 280, qualifiedShareBp: 7500, interestSpreadBp: null, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
      bonds: { dividendYieldBp: 0, qualifiedShareBp: 0, interestSpreadBp: 100, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
      cash: { dividendYieldBp: 0, qualifiedShareBp: 0, interestSpreadBp: 0, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
      real_estate: { dividendYieldBp: 350, qualifiedShareBp: 0, interestSpreadBp: null, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
      other: { dividendYieldBp: 0, qualifiedShareBp: 0, interestSpreadBp: null, taxExemptShareBp: 0, gainDistributionRateBp: 0 },
    });
  });

  it("the not-modelled list, the Social Security rules with their verification status (none primary), every source", () => {
    expect(view.notModelled).toEqual(NOT_MODELLED.map((e) => ({ ...e })));
    expect(view.socialSecurityRules.map((r) => r.id)).toEqual(SS_RULES.map((r) => r.id));
    expect(view.socialSecurityRules.every((r) => r.status !== "primary")).toBe(true);
    expect(view.socialSecurityRules.find((r) => r.id === "ssa_rounding")?.status).toBe("unverified");
    expect(view.sources).toHaveLength(data.sources.length);
    expect(view.sources.every((s) => s.url.startsWith("https://") && s.file.length > 0)).toBe(true);
    expect(view.sources.find((s) => s.file === "tax/federal-2026.json" && s.title === "Rev. Proc. 2025-32")?.sha256).toBe(
      "e9ada115fb43a4af5ea326ca91edd40ab0bf29b9be01d2c13d7b8fa96214635b",
    );
  });
});

describe("route 23: federalTaxPreview", () => {
  const req = (body: unknown) => FederalTaxPreviewRequest.parse(body);

  it("B1 single, 40, 2026, wages 100,000: 13,170.00, bracket 22%, 21,800 of room; the response parses", () => {
    const res = federalTaxPreview(req({ year: 2026, filingStatus: "single", ages: [40], wagesCents: "10000000" }));
    expect(FederalTaxPreviewResponse.safeParse(res).success).toBe(true);
    expect(res.dataStatus).toBe("published");
    expect(res.dataVersion).toBe(data.dataVersion);
    expect(res.detail.totalFederalCents).toBe("1317000");
    expect(res.detail.filingStatus).toBe("single");
    expect(res.detail.bracketRateBp).toBe(2200);
    expect(res.roomInBracketCents).toBe("2180000");
    expect(res.marginalOrdinaryRate).toBeCloseTo(0.22, 9);
    expect(res.lines.find((l) => l.form === "Total")?.cents).toBe("1317000");
  });

  it("C6 married, both 68, 2026, the full return of §3.3: 6,500.00; MAGI for the ACA 131,000; room 42,500 and 22,600; 1,000 more costs 120", () => {
    const res = federalTaxPreview(
      req({
        year: 2026,
        filingStatus: "married_joint",
        ages: [68, 68],
        socialSecurityCents: "4800000",
        pensionCents: "2000000",
        traditionalDistributionsCents: "4000000",
        taxableInterestCents: "300000",
        ordinaryDividendsCents: "800000",
        qualifiedDividendsCents: "600000",
        longTermGainCents: "1200000",
      }),
    );
    expect(res.detail.taxableSocialSecurityCents).toBe("4080000");
    expect(res.detail.agiCents).toBe("12380000");
    expect(res.detail.taxableIncomeCents).toBe("7630000");
    expect(res.detail.totalFederalCents).toBe("650000");
    expect(res.detail.magiAcaCents).toBe("13100000");
    expect(res.roomInBracketCents).toBe("4250000");
    expect(res.roomAtZeroGainsCents).toBe("2260000");
    // 1,000 more of pre-tax withdrawal costs 120.00: the effective rate on the next dollar is 12%.
    expect(res.marginalOrdinaryRate).toBeCloseTo(0.12, 9);
  });

  it("J1 (a) after the last published year at the factor typed: 2028 at 1.03 gives 12,628.00, dataStatus indexed", () => {
    const res = federalTaxPreview(req({ year: 2028, filingStatus: "single", ages: [40], indexFactorBp: 10300, wagesCents: "10000000" }));
    expect(res.dataStatus).toBe("indexed");
    expect(res.detail.totalFederalCents).toBe("1262800");
  });

  it("the top bracket has no room (null); a rule set from the request is applied", () => {
    // B10: single, 2027, wages 800,000: 244,387.00 in the top bracket.
    const b10 = federalTaxPreview(req({ year: 2027, filingStatus: "single", ages: [40], wagesCents: "80000000" }));
    expect(b10.detail.totalFederalCents).toBe("24438700");
    expect(b10.roomInBracketCents).toBeNull();
    // J1 (b)/(c): joint, both 70, 2029, pension 90,000 at 1.05575: 5,640.00 under current law, 4,200.00 with the senior deduction kept.
    const j1b = { year: 2029, filingStatus: "married_joint", ages: [70, 70], indexFactorBp: 10558, pensionCents: "9000000" };
    // 10,558 bp is 1.0558, a little above 1.05575; the rounded thresholds are the same (J1's 2029 row).
    expect(federalTaxPreview(req(j1b)).detail.totalFederalCents).toBe("564000");
    expect(federalTaxPreview(req({ ...j1b, ruleSetId: "senior_deduction_permanent" })).detail.totalFederalCents).toBe("420000");
  });

  it("errors for the route: unknown_rule_set (TaxDataError) and qualified_exceeds_ordinary (TaxInputError)", () => {
    const unknown = thrown(() => federalTaxPreview(req({ year: 2026, filingStatus: "single", ages: [40], ruleSetId: "no_such_rules" })));
    expect(unknown).toBeInstanceOf(TaxDataError);
    expect((unknown as TaxDataError).code).toBe("unknown_rule_set");
    const qual = thrown(() => federalTaxPreview(req({ year: 2026, filingStatus: "single", ages: [40], ordinaryDividendsCents: "100", qualifiedDividendsCents: "200" })));
    expect(qual).toBeInstanceOf(TaxInputError);
    expect((qual as TaxInputError).code).toBe("qualified_exceeds_ordinary");
  });
});

describe("the rest of the rules view for PlannerEnv and the routes", () => {
  it("route 24's mapping, contributionLimit, SS_RULES and ssRuleVerification are re-exported as the same functions", () => {
    expect(rules.socialSecurityPreviewView).toBe(socialSecurityPreviewView);
    expect(rules.contributionLimit).toBe(contributionLimits.contributionLimit);
    expect(rules.SS_RULES).toBe(SS_RULES);
    expect(rules.NOT_MODELLED).toBe(NOT_MODELLED);
    const res = rules.socialSecurityPreviewView(
      SocialSecurityPreviewRequest.parse({ people: [{ birthYear: 1962, birthMonth: 1, monthlyAtFraCents: "60000", asOfYear: 2026, claimAgeMonths: 804 }], startYear: 2026 }),
    );
    expect(res.people[0]!.byClaimAge.map((c) => c.monthlyCents)).toHaveLength(9);
  });

  it("TAX_DATA_FIRST_YEAR is the manifest's first tax year; the full-retirement-age table ends { 1960, null, 67, 0 }", () => {
    expect(TAX_DATA_FIRST_YEAR).toBe(2026);
    expect(fullRetirementAgeTable().at(-1)).toEqual({ fromBirthYear: 1960, toBirthYear: null, years: 67, months: 0 });
  });
});
