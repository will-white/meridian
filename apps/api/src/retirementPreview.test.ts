import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_VERSION, ENGINE_VERSION } from "@meridian/retirement";
import { RETIREMENT_SEED_NOW } from "@meridian/db/testing";
import { FederalTaxPreviewResponse, RETIREMENT_API_PREFIX, RetirementMeta, RetirementRulesView, SocialSecurityPreviewResponse } from "@meridian/shared";
import { createTestApp, signInOwner, TEST_DATABASE_URL, viewerCookies, type CookieJar, type TestApp } from "./test/helpers.js";

/**
 * Routes 1 and 22 to 24 on the real planner (`app.planner` from the engine package; tax-rmd-ss
 * §4.4, seams C42 and C47): the meta, the rules view, the federal tax preview against tax-rmd-ss
 * B1 and C6 (worked by hand in that design, §7 B and §3.3), the Social Security preview, and the
 * errors of §4.4. Viewers may call all four; none writes.
 */

const R = RETIREMENT_API_PREFIX;

function parsed<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } } }, res: LightMyRequestResponse): T {
  const result = schema.safeParse(res.json());
  expect(result.success, `${res.statusCode} ${res.body.slice(0, 400)} ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true);
  return result.data as T;
}

function expectError(res: LightMyRequestResponse, status: number, code: string): void {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toMatchObject({ code, error: expect.any(String) });
}

describe.skipIf(!TEST_DATABASE_URL)("the planner's read-only routes on the real engine (1, 22 to 24)", () => {
  let t: TestApp;
  let viewer: CookieJar;

  beforeAll(async () => {
    // The default planner: the engine itself (createTestApp passes none).
    t = await createTestApp({ now: () => RETIREMENT_SEED_NOW });
    await signInOwner(t);
    viewer = await viewerCookies(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const taxPreview = async (payload: Record<string, unknown>, cookies?: CookieJar) => t.call({ method: "POST", url: `${R}/tax-preview`, payload, ...(cookies ? { cookies } : {}) });

  describe("route 23, POST /tax-preview", () => {
    it("B1: single, 40, 2026, wages 100,000: taxable 83,900, tax 13,170.00, the 22% bracket with 21,800 of room", async () => {
      // 100,000 − 16,100 = 83,900; 5,800 + 22% × (83,900 − 50,400) = 5,800 + 7,370 = 13,170.00;
      // room 105,700 − 83,900 = 21,800 (tax-rmd-ss §7 B1).
      const res = await taxPreview({ year: 2026, filingStatus: "single", ages: [40], wagesCents: "10000000" }, viewer);
      expect(res.statusCode, res.body).toBe(200);
      const r = parsed<FederalTaxPreviewResponse>(FederalTaxPreviewResponse, res);
      expect(r.dataVersion).toBe(DATA_VERSION);
      expect(r.dataStatus).toBe("published");
      expect(r.detail).toMatchObject({
        filingStatus: "single",
        agiCents: "10000000",
        standardDeductionCents: "1610000",
        taxableIncomeCents: "8390000",
        ordinaryTaxableCents: "8390000",
        ordinaryTaxCents: "1317000",
        incomeTaxCents: "1317000",
        totalFederalCents: "1317000",
        bracketRateBp: 2200,
      });
      expect(r.roomInBracketCents).toBe("2180000");
      expect(r.unusedDeductionCents).toBe("0");
    });

    it("C6: the full return of §3.3 (joint, both 68): taxable benefits 40,800, AGI 123,800, taxable 76,300, tax 6,500.00", async () => {
      // §3.3: other income 20,000 + 3,000 + 8,000 + 40,000 + 12,000 = 83,000; provisional 107,000;
      // tier1 min(24,000, 37,500, 6,000) = 6,000; 0.85 × 63,000 + 6,000 = 59,550 capped at 40,800;
      // AGI 123,800; deductions 35,500 + 12,000; taxable 76,300; preferential 18,000 all at 0%;
      // ordinary 58,300: 2,480 + 12% × 33,500 = 6,500.00; MAGI (ACA) 123,800 + 7,200 = 131,000;
      // room 100,800 − 58,300 = 42,500; room at 0% gains 98,900 − 76,300 = 22,600.
      const c6 = {
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
      };
      const res = await taxPreview(c6);
      expect(res.statusCode, res.body).toBe(200);
      const r = parsed<FederalTaxPreviewResponse>(FederalTaxPreviewResponse, res);
      expect(r.detail).toMatchObject({
        filingStatus: "married_joint",
        taxableSocialSecurityCents: "4080000",
        agiCents: "12380000",
        standardDeductionCents: "3550000",
        seniorDeductionCents: "1200000",
        taxableIncomeCents: "7630000",
        ordinaryTaxableCents: "5830000",
        ordinaryTaxCents: "650000",
        gainsAt0Cents: "1800000",
        gainsAt15Cents: "0",
        capitalGainsTaxCents: "0",
        niitCents: "0",
        totalFederalCents: "650000",
        magiIrmaaCents: "12380000",
        magiAcaCents: "13100000",
        bracketRateBp: 1200,
      });
      expect(r.provisionalIncomeCents).toBe("10700000");
      expect(r.roomInBracketCents).toBe("4250000");
      expect(r.roomAtZeroGainsCents).toBe("2260000");
      // An extra 1,000 of pre-tax withdrawal costs 120.00: benefits are already at the 85% cap.
      const more = parsed<FederalTaxPreviewResponse>(FederalTaxPreviewResponse, await taxPreview({ ...c6, traditionalDistributionsCents: "4100000" }));
      expect(BigInt(more.detail.totalFederalCents) - BigInt(r.detail.totalFederalCents)).toBe(12000n);
    });

    it("400 validation (one age per filer, a loose cents field), unknown_rule_set and qualified_exceeds_ordinary", async () => {
      expectError(await taxPreview({ year: 2026, filingStatus: "married_joint", ages: [40], wagesCents: "10000000" }), 400, "validation");
      expectError(await taxPreview({ year: 2026, filingStatus: "single", ages: [40], wagesCents: 10000000 }), 400, "validation");
      expectError(await taxPreview({ year: 2026, filingStatus: "single", ages: [40], wagesCents: "-1" }), 400, "validation");
      expectError(await taxPreview({ year: 2026, filingStatus: "single", ages: [40], ruleSetId: "no_such_rules" }), 400, "unknown_rule_set");
      expectError(await taxPreview({ year: 2026, filingStatus: "single", ages: [40], ordinaryDividendsCents: "100000", qualifiedDividendsCents: "200000" }), 400, "qualified_exceeds_ordinary");
    });

    it("after the last published year the indexed amounts follow indexFactorBp", async () => {
      const res = await taxPreview({ year: 2030, filingStatus: "single", ages: [40], wagesCents: "10000000", indexFactorBp: 11000 });
      expect(res.statusCode, res.body).toBe(200);
      expect(parsed<FederalTaxPreviewResponse>(FederalTaxPreviewResponse, res).dataStatus).toBe("indexed");
    });
  });

  describe("route 24, POST /social-security-preview", () => {
    it("born March 1960, 2,000.00 at full retirement age (67): 1,400.00 at 62 and 2,480.00 at 70", async () => {
      // FRA 804 months. At 62: 36 months × 5/9% + 24 months × 5/12% = 20% + 10% = 30% off → 70%,
      // floorDime(2,000 × 0.70) = 1,400.00. At 70: 36 months × 2/3% = 24% → 124%, 2,480.00. The
      // statement is of the start year, so no COLA applies (tax-rmd-ss §3.9).
      const res = await t.call({
        method: "POST",
        url: `${R}/social-security-preview`,
        cookies: viewer,
        payload: { people: [{ birthYear: 1960, birthMonth: 3, monthlyAtFraCents: "200000", asOfYear: 2026, claimAgeMonths: 804 }], startYear: 2026 },
      });
      expect(res.statusCode, res.body).toBe(200);
      const r = parsed<SocialSecurityPreviewResponse>(SocialSecurityPreviewResponse, res);
      const person = r.people[0]!;
      expect(person).toMatchObject({ fraMonths: 804, piaAtStartCents: "200000" });
      expect(person.byClaimAge.map((a) => a.claimAgeMonths)).toEqual([744, 756, 768, 780, 792, 804, 816, 828, 840]);
      expect(person.byClaimAge[0]).toMatchObject({ factorBp: 7000, monthlyCents: "140000", spousalMonthlyCents: "0" });
      expect(person.byClaimAge[5]).toMatchObject({ factorBp: 10000, monthlyCents: "200000" });
      expect(person.byClaimAge[8]).toMatchObject({ factorBp: 12400, monthlyCents: "248000" });
    });

    it("400 validation: a claim age outside 62 to 70, or three people", async () => {
      const person = { birthYear: 1960, birthMonth: 3, monthlyAtFraCents: "200000", asOfYear: 2026, claimAgeMonths: 852 };
      expectError(await t.call({ method: "POST", url: `${R}/social-security-preview`, payload: { people: [person], startYear: 2026 } }), 400, "validation");
      const ok = { ...person, claimAgeMonths: 804 };
      expectError(await t.call({ method: "POST", url: `${R}/social-security-preview`, payload: { people: [ok, ok, ok], startYear: 2026 } }), 400, "validation");
    });
  });

  describe("route 22, GET /rules, and route 1, GET /meta", () => {
    it("the rules view on the household's date: data 2026.11.1, tables through 2027, not stale in 2026", async () => {
      const r = parsed<RetirementRulesView>(RetirementRulesView, await t.call({ method: "GET", url: `${R}/rules`, cookies: viewer }));
      expect(r).toMatchObject({ dataVersion: DATA_VERSION, firstTaxYear: 2026, lastPublishedYear: 2027, stale: false });
      expect(r.years.map((y) => y.taxYear)).toEqual([2026, 2027]);
      expect(r.ruleSets[0]!.id).toBe("current_law");
      expectError(await t.call({ method: "GET", url: `${R}/rules?today=2026-10-20` }), 400, "today_out_of_range");
    });

    it("the meta is the engine's: its versions, minStartYear 2026 (C47) and the custom model's start from the data", async () => {
      const meta = parsed<RetirementMeta>(RetirementMeta, await t.call({ method: "GET", url: `${R}/meta`, cookies: viewer }));
      expect(meta).toMatchObject({ engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, minStartYear: 2026 });
      expect(meta.ruleSets.map((r) => r.id)).toEqual(["current_law", "senior_deduction_permanent", "ss_shortfall_2033", "rates_plus_2pts_2031"]);
      expect(meta.returnModels.historyStartParams.stocks).toEqual({ meanBp: 1185, volBp: 1940 });
      expect(meta.returnModels.presets.map((p) => p.id)).toEqual(["historical", "conservative"]);
    });
  });
});
