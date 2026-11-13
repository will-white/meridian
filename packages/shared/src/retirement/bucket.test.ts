import { describe, expect, it } from "vitest";
import { AccountType, TaxTreatment } from "../enums.js";
import { planBucketOf } from "./bucket.js";

describe("1. bucket table (inputs-and-data §3.1)", () => {
  it("1 bank accounts are cash whatever their treatment", () => {
    for (const type of ["checking", "savings"] as const) {
      for (const treatment of TaxTreatment.options) {
        expect(planBucketOf(type, treatment)).toEqual({ bucket: "cash", listed: true, treatmentDefaulted: false });
      }
    }
    // The table's row: savings with hsa → cash (the resolver warns cash_account_treatment).
    expect(planBucketOf("savings", "hsa")).toEqual({ bucket: "cash", listed: true, treatmentDefaulted: false });
  });

  it("1 an investment account's treatment is its bucket", () => {
    for (const type of ["brokerage", "401k", "ira", "roth", "hsa"] as const) {
      for (const treatment of ["taxable", "pre_tax", "roth", "hsa"] as const) {
        expect(planBucketOf(type, treatment)).toEqual({ bucket: treatment, listed: true, treatmentDefaulted: false });
      }
    }
  });

  it("1 an investment account with treatment none takes its type's default (taxable, pre_tax, pre_tax, roth, hsa)", () => {
    expect(planBucketOf("401k", "none")).toEqual({ bucket: "pre_tax", listed: true, treatmentDefaulted: true });
    expect(planBucketOf("brokerage", "none")).toEqual({ bucket: "taxable", listed: true, treatmentDefaulted: true });
    expect(planBucketOf("ira", "none")).toEqual({ bucket: "pre_tax", listed: true, treatmentDefaulted: true });
    expect(planBucketOf("roth", "none")).toEqual({ bucket: "roth", listed: true, treatmentDefaulted: true });
    expect(planBucketOf("hsa", "none")).toEqual({ bucket: "hsa", listed: true, treatmentDefaulted: true });
  });

  it("1 a 529 is listed with no bucket (ineligible: education); credit, loan and asset are not listed", () => {
    for (const treatment of TaxTreatment.options) {
      expect(planBucketOf("529", treatment)).toEqual({ ineligible: "education", listed: true, treatmentDefaulted: false });
      for (const type of ["credit", "loan", "asset"] as const) {
        expect(planBucketOf(type, treatment)).toEqual({ listed: false, treatmentDefaulted: false });
      }
    }
  });

  it("1 every account type and treatment has a row", () => {
    expect(AccountType.options.length * TaxTreatment.options.length).toBe(55);
    for (const type of AccountType.options) {
      for (const treatment of TaxTreatment.options) {
        const r = planBucketOf(type, treatment);
        expect(r.bucket !== undefined || r.ineligible !== undefined || !r.listed).toBe(true);
      }
    }
  });
});
