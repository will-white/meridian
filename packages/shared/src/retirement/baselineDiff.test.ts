import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BaselineChange } from "./api.js";
import type { RetirementBaseline } from "./baseline.js";
import { baselineHash, diffBaselines, hashableBaseline } from "./baselineDiff.js";
import { canonicalJson } from "./freeze.js";
import { fixtureBaseline, IDS } from "./testFixtures.js";

/** The fixture baseline after the two edits of §3.6's worked example (test 15). */
function refreshed(): RetirementBaseline {
  const b = fixtureBaseline();
  // A manual balance for K on 2026-10-13 of 15,250,000.
  const k = b.accounts.find((a) => a.accountId === IDS.K)!;
  k.valueCents = "15250000";
  k.valuationDate = "2026-10-13";
  b.totals.byBucket.pre_tax = "15250000";
  b.totals.totalCents = "22832700"; // 22,582,700 + 250,000
  // The −45,000 uncategorized row categorized as Groceries: 955,000 + 45,000; 3,955,000 + 45,000.
  b.spending.byCategory.find((c) => c.categoryId === IDS.groceries)!.cents = "1000000";
  b.spending.categorizedCents = "4000000";
  b.spending.uncategorized = { count: 1, outflowCents: "0", inflowCents: "20000" };
  return b;
}

describe("15. baseline diff (inputs-and-data §3.6)", () => {
  it("15 equal baselines → []; a baseline recomputed later (computedAt and today only) → []", () => {
    expect(diffBaselines(fixtureBaseline(), fixtureBaseline())).toEqual([]);
    expect(diffBaselines(fixtureBaseline(), { ...fixtureBaseline(), computedAt: "2026-10-15T08:00:00.000Z", today: "2026-10-15" })).toEqual([]);
  });

  it("15 the §3.6 pair → exactly those six rows with their material flags", () => {
    const rows = diffBaselines(fixtureBaseline(), refreshed());
    for (const r of rows) expect(BaselineChange.parse(r)).toEqual(r);
    expect(rows).toEqual([
      // +250,000 ≥ 100,000 (and 1.66% of 15,000,000): material.
      { kind: "account_value", path: `accounts.${IDS.K}.valueCents`, label: "Acme 401(k)", accountId: IDS.K, beforeCents: "15000000", afterCents: "15250000", deltaCents: "250000", material: true },
      { kind: "bucket_total", path: "totals.byBucket.pre_tax", label: "Pre-tax", beforeCents: "15000000", afterCents: "15250000", deltaCents: "250000", material: true },
      { kind: "total", path: "totals.totalCents", label: "All plan accounts", beforeCents: "22582700", afterCents: "22832700", deltaCents: "250000", material: true },
      // 45,000 is 1.13% of the before categorized spending of 3,955,000, under 2%: not material.
      { kind: "spending_category", path: `spending.byCategory.${IDS.groceries}`, label: "Groceries", beforeCents: "955000", afterCents: "1000000", deltaCents: "45000", material: false },
      { kind: "spending_categorized", path: "spending.categorizedCents", label: "Categorized spending", beforeCents: "3955000", afterCents: "4000000", deltaCents: "45000", material: false },
      { kind: "spending_uncategorized", path: "spending.uncategorized", label: "Uncategorized outflows", beforeCents: "45000", afterCents: "0", deltaCents: "-45000", note: "count 2 → 1", material: false },
    ]);
  });

  it("the material thresholds: 1,000.00 or 1% for values, 2% for spending, 200 bp for allocation", () => {
    const before = fixtureBaseline();
    const after = fixtureBaseline();
    // H: 125,000 → 126,250 is +1,250, exactly 1% of 125,000: material. Checking: 500,000 → 504,999 is +4,999,
    // under 1,000.00 and under 1% (5,000): not material.
    after.accounts.find((a) => a.accountId === IDS.H)!.valueCents = "126250";
    after.accounts.find((a) => a.accountId === IDS.C)!.valueCents = "504999";
    // Rent +79,100 = 2% of 3,955,000 exactly: material.
    after.spending.byCategory.find((c) => c.categoryId === IDS.rent)!.cents = "2479100";
    // B's weights: intl moves 199 bp (not material); R's: bonds move 200 bp (material).
    after.accounts.find((a) => a.accountId === IDS.B)!.weights = { us_stock: 6640, intl_stock: 2831, bonds: 0, cash: 529, real_estate: 0, other: 0 };
    after.accounts.find((a) => a.accountId === IDS.R)!.weights = { us_stock: 4480, intl_stock: 831, bonds: 4541, cash: 148, real_estate: 0, other: 0 };
    const rows = diffBaselines(before, after);
    const row = (kind: string, accountId?: string) => rows.find((r) => r.kind === kind && r.accountId === accountId);
    expect(row("account_value", IDS.H)).toMatchObject({ deltaCents: "1250", material: true });
    expect(row("account_value", IDS.C)).toMatchObject({ deltaCents: "4999", material: false });
    expect(rows.find((r) => r.kind === "spending_category")).toMatchObject({ label: "Rent", deltaCents: "79100", material: true });
    expect(row("account_allocation", IDS.B)).toMatchObject({ note: "us_stock 6839 → 6640, intl_stock 2632 → 2831", material: false });
    expect(row("account_allocation", IDS.R)).toMatchObject({ note: "us_stock 4680 → 4480, bonds 4341 → 4541", material: true });
    // Accounts by name: Brokerage, Checking, HealthEquity HSA, Roth IRA.
    expect(rows.filter((r) => r.accountId !== undefined).map((r) => r.label)).toEqual(["Brokerage", "Checking", "HealthEquity HSA", "Roth IRA"]);
  });

  it("added, removed and re-bucketed accounts are always material; the as-of date, income and the savings rate never", () => {
    const before = fixtureBaseline();
    const after = fixtureBaseline();
    after.asOf = "2026-10-20";
    after.accounts = after.accounts.filter((a) => a.accountId !== IDS.S);
    after.accounts.find((a) => a.accountId === IDS.T)!.bucket = "pre_tax";
    after.accounts.push({ ...after.accounts.find((a) => a.accountId === IDS.C)!, accountId: "a0000000-0000-4000-8000-000000000099", name: "Credit union", valueCents: "50" });
    after.income = { takeHomeCents: "9000000", investmentIncomeCents: "4720" };
    after.savingsRate = { ...after.savingsRate, bp: 2400 };
    const rows = diffBaselines(before, after);
    expect(rows[0]).toEqual({ kind: "as_of", path: "asOf", label: "Balances as of", note: "2026-10-13 → 2026-10-20", material: false });
    expect(rows.find((r) => r.kind === "account_added")).toMatchObject({ label: "Credit union", afterCents: "50", material: true });
    expect(rows.find((r) => r.kind === "account_removed")).toMatchObject({ label: "Savings", beforeCents: "2000000", material: true });
    expect(rows.find((r) => r.kind === "account_bucket")).toMatchObject({ label: "Old Brokerage", note: "taxable → pre_tax", material: true });
    expect(rows.find((r) => r.kind === "income")).toMatchObject({ beforeCents: "8400000", afterCents: "9000000", material: false });
    expect(rows.find((r) => r.kind === "savings_rate")).toEqual({ kind: "savings_rate", path: "savingsRate.bp", label: "Measured savings rate", note: "2518 → 2400 bp", material: false });
  });

  it("a contribution row compares the yearly amount the plan would use live (measured net, else the recurring plan)", () => {
    const after = fixtureBaseline();
    const r = after.contributions.find((c) => c.accountId === IDS.R)!;
    r.plannedCents = "360000";
    const h = after.contributions.find((c) => c.accountId === IDS.H)!;
    h.source = "none";
    h.flags = ["insufficient_history"];
    delete h.annualNetCents;
    const rows = diffBaselines(fixtureBaseline(), after).filter((x) => x.kind === "contribution");
    expect(rows).toEqual([
      // −360,000 is at least 1,000.00: material.
      { kind: "contribution", path: `contributions.${IDS.H}`, label: "HealthEquity HSA", accountId: IDS.H, beforeCents: "360000", afterCents: "0", deltaCents: "-360000", note: "source measured → none", material: true },
      // +60,000 is under 1,000.00 but 20% of 300,000 (at least 1%): material.
      { kind: "contribution", path: `contributions.${IDS.R}`, label: "Roth IRA", accountId: IDS.R, beforeCents: "300000", afterCents: "360000", deltaCents: "60000", material: true },
    ]);
  });

  it("no stored baseline: every planner account is added and every amount is new", () => {
    const rows = diffBaselines(null, fixtureBaseline());
    for (const r of rows) expect(BaselineChange.parse(r)).toEqual(r);
    // Seven bucketed accounts (the 529 has no bucket), five bucket totals and the total.
    expect(rows.filter((r) => r.kind === "account_added")).toHaveLength(7);
    expect(rows.filter((r) => r.kind === "bucket_total")).toHaveLength(5);
    expect(rows.find((r) => r.kind === "total")).toEqual({ kind: "total", path: "totals.totalCents", label: "All plan accounts", afterCents: "22582700", material: true });
    expect(rows.some((r) => r.kind === "as_of")).toBe(false);
  });
});

describe("baselineHash (inputs-and-data §3.2 B10, §3.7)", () => {
  it("SHA-256 of the canonical JSON without computedAt and today, lower-case hex", async () => {
    const b = fixtureBaseline();
    const text = canonicalJson(hashableBaseline(b));
    expect(text).not.toContain("computedAt");
    expect(text).not.toContain('"today"');
    expect(await baselineHash(b)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("a recomputation of the same data has the same hash; a change of data or of the as-of date changes it", async () => {
    const h = await baselineHash(fixtureBaseline());
    expect(await baselineHash({ ...fixtureBaseline(), computedAt: "2026-11-01T00:00:00.000Z", today: "2026-11-01" })).toBe(h);
    expect(await baselineHash(refreshed())).not.toBe(h);
    expect(await baselineHash({ ...fixtureBaseline(), asOf: "2026-10-14" })).not.toBe(h);
  });
});
