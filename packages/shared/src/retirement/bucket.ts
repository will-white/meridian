import { defaultTaxTreatment, type AccountType, type PlanBucket, type TaxTreatment } from "../enums.js";

/**
 * The planner bucket of an account (inputs-and-data §3.1, decision 9): derived from the account's
 * tax treatment, never stored. Bank accounts are `cash` whatever their treatment (the resolver
 * warns `cash_account_treatment` when the treatment is not `none`); an investment account with
 * treatment `none` takes its type's default treatment (`treatmentDefaulted`, warning
 * `tax_treatment_defaulted`); a 529 is listed but never included; credit, loan and asset accounts
 * are not listed. Closed accounts are the caller's to leave out.
 */
export interface PlanBucketOf {
  bucket?: PlanBucket;
  ineligible?: "education";
  /** Shown in the planner's account list. */
  listed: boolean;
  treatmentDefaulted: boolean;
}

function investmentBucket(treatment: TaxTreatment): PlanBucket {
  if (treatment === "none") throw new Error("an investment account type has no default bucket");
  return treatment;
}

export function planBucketOf(type: AccountType, taxTreatment: TaxTreatment): PlanBucketOf {
  switch (type) {
    case "checking":
    case "savings":
      return { bucket: "cash", listed: true, treatmentDefaulted: false };
    case "brokerage":
    case "401k":
    case "ira":
    case "roth":
    case "hsa":
      if (taxTreatment === "none") return { bucket: investmentBucket(defaultTaxTreatment[type]), listed: true, treatmentDefaulted: true };
      return { bucket: taxTreatment, listed: true, treatmentDefaulted: false };
    case "529":
      return { ineligible: "education", listed: true, treatmentDefaulted: false };
    case "credit":
    case "loan":
    case "asset":
      return { listed: false, treatmentDefaulted: false };
  }
}
