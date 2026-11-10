# Phase 4 design: Federal tax engine, RMDs and Social Security

Area (lead decision L8): the pure functions the simulation loop calls for one household-year, and the data they read. That is the yearly tax data files and their forward indexing, the federal income tax function, taxation of Social Security, the net investment income tax, the additional taxes on early distributions, the taxable-account income and basis model, required minimum distributions, Social Security benefits, contribution limits and employee payroll tax. The year loop, the withdrawal order, the database and the pages belong to the other three areas; what this area assumes of them is in section 9.

This is the merged design. Two independent designs (A, statute-first; B, engine-first) were scored by two judges, who both preferred A; section 12 records the scores and what was taken from each. The document is self-contained: build from it without the originals.

State of the evidence:

- Nothing in the repository was changed except this file. Codebase facts were checked at commit `786cb0d` and are cited by name, never by line. The merged design of the inputs-and-data area (`docs/design/phase-4/inputs-and-data.md`) already exists and is treated as binding where it fixes a shared rule (the first-year rule, the frozen input, the package rule, unknown basis).
- `www.irs.gov` answered direct fetches on 2026-11-10 (HTTP 200), so every IRS figure and worksheet below was read from the primary document; the SHA-256 of each file is in section 10.1 and matches what both designers and both judges recorded. `www.ssa.gov` still answers 403, and `govinfo.gov`, `law.cornell.edu`, `ecfr.gov`, `uscode.house.gov`, `secure.ssa.gov`, `bls.gov` and `everycrsreport.com` are refused by the network policy.
- This session's web search budget ran out after three searches (one confirmed the 2027 Social Security figures, one showed that no 2027 retirement-plan notice exists yet and that the published forecasts disagree, one returned nothing usable). Every Social Security rule and every statute citation therefore rests on the searches the two designers and two judges recorded, listed in section 10.2, and is marked in section 10.3 where no primary source confirms it.
- Every number in sections 3 and 7 was recomputed with float64 reference scripts that implement exactly the rules of section 3 (scratch only): `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeT/scripts/ref.py` (tax, penalties, taxable account, RMDs, indexing, the slope scan), `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeT/scripts/ref_ss.py` (Social Security) and `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeT/scripts/ref_extra.py` (cents, the rounding guard, law changes). The Joint and Last Survivor table, converted to the JSON module this design ships, is at `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeT/data/rmd-joint-life.json`.

Files this area adds:

```
packages/retirement/
  data/
    manifest.json                 data version and SHA-256 of every data file
    tax/federal-2026.json         everything published for tax year 2026 (2.2)
    tax/federal-2027.json         everything published for tax year 2027 (2.2)
    tax/rules.json                indexing rules, law changes, rule sets (2.3)
    ss/rules.json                 full retirement ages, reduction and credit constants, COLA history (2.4)
    rmd/uniform-lifetime.json     Table III and the start-age rule (2.5)
    rmd/joint-life.json           Table II, 101 x 101 (2.5)
    taxable/tax-drag.json         yield assumptions of the taxable-account model (2.6; assumptions, not law)
    README.md                     the annual refresh runbook (section 6)
  src/tax/
    layout.ts            slot constants of the typed-array records (2.8)
    taxData.ts           Zod schemas of the data files, loadTaxData(), validateTaxData(), TaxDataError
    compile.ts           compileTaxLaw(), fillPathTables(), law-change operations
    federalTax.ts        federalTaxInto(), effectiveMarginalRates(), computeFederalTax()
    penalties.ts         earlyFraction(), preTaxPenaltyBase(), hsaWithdraw()
    rothBasis.ts         Roth ordering state and functions
    taxableAccount.ts    taxableYearIncome(), sellTaxable(), depositTaxable(), reinvestTaxable(), rebalanceTaxable(), stepUpBasisAtDeath()
    rmd.ts               rmdStartAge(), rmdDivisor(), requiredMinimumDistribution()
    socialSecurity.ts    factors, compileSsPlan(), resetSsState(), monthlyPayment(), socialSecurityYear(), the preview
    contributionLimits.ts, payroll.ts
    warnings.ts          run-warning slots and messages (3.11)
    notModelled.ts       the not-modelled list as data (8.2)
    rulesView.ts         listTaxRuleSets(), fullRetirementAgeTable(), contributionLimit(), buildRulesView()
    index.ts
    *.test.ts            section 7
packages/shared/src/retirement/tax.ts     wire shapes of this area (4.3)
```

Files this area touches: `apps/api/src/routes/retirement.ts` (three read-only routes, 4.4) and the `app.planner` decoration that the inputs-and-data design builds from `@meridian/retirement` (three more functions, section 6). It adds no table, no migration and no job.

## 1. Decisions (binding)

1. **Package and placement.** Code and data live in `packages/retirement` (`@meridian/retirement`, L1); the wire shapes live in `packages/shared/src/retirement/tax.ts`; the engine package imports shared, never the reverse (inputs-and-data decision 8). No I/O and no Node-only API: data files are JSON imported statically with import attributes (`import y2026 from "../../data/tax/federal-2026.json" with { type: "json" }`), which TypeScript 5.7 under `module: NodeNext` requires and which esbuild (`scripts/bundle.mjs`), `tsx` and Vite all accept. Reason: testable alone, runnable in a browser later; the repo has no JSON import yet, so the form is stated here.
2. **Units.** Inside the engine every amount is nominal float64 dollars and annual unless a name says monthly; every rate is a fraction; ages are whole years attained by 31 December (`year − birthYear`) or months, as named. Cents (`bigint`) appear only in the allocating wrapper `computeFederalTax` and in `contributionLimit`, rounded half away from zero (L1).
3. **Filing status** is `single` or `married_joint` on the wire (the frozen input's spelling) and index `0` (single) or `1` (mfj) in data keys and tables. A couple files jointly through the calendar year of the first death; the survivor files single from the next year. No head of household, no married filing separately, no qualifying surviving spouse (L2).
4. **The yearly data file is one immutable JSON file per published tax year**, and each holds every bracket, deduction, threshold, limit, rate and Social Security program amount of that year, statutory amounts included (they are repeated in every year so a law change can alter them per year). Reason: the spec's "yearly data file"; the annual refresh adds a file and edits none.
5. **Published years are data, verbatim**: 2026 (Rev. Proc. 2025-32, section 4) and 2027 (Rev. Proc. 2026-35, section 3), with provenance and the source's SHA-256 (L7).
6. **Forward indexing** applies after the last published year L = 2027: the value for year Y uses the path's cumulative inflation through year Y − 1, `F_Y = Π_{y=L..Y−1}(1 + π_y)`. An optional chained-CPI wedge (default 0) lowers each year's factor. Reason: the IRS publishes year Y's amounts in the autumn of Y − 1; L7 says "indexed forward by path inflation", so the wedge is an option and not the default (design B had it on; both judges faulted that).
7. **Rounding when indexed keeps the statute's structure**: `value_Y = value_L + floor(value_L × (F_Y − 1) / step + 1e-9) × step`, with steps of $50 joint and $25 single for bracket thresholds and the 0% gains threshold (single stays exactly half of joint), $100 joint and $50 single for the standard deduction (joint stays exactly twice single), and round-to-nearest for the HSA limits, the wage base and the earnings-test amounts (2.3). Reason: the published tables hold these identities in every year checked (2023 to 2027).
8. **Not indexed** (fixed by statute): the Social Security taxation base amounts, the net investment income tax thresholds and rate, the $3,000 capital-loss limit, the senior deduction and its thresholds, the penalty rates, the HSA catch-up, the Additional Medicare thresholds. Reason: the Code carries no adjustment for them; the bracket creep is real and is simulated.
9. **Law changes are typed operations in data, compiled once per run, never branches in the hot path.** A rule set is a named list of law changes; a scenario picks one rule set by id (`RunSettings.taxRuleSet`, a string validated when the plan is resolved and again at compile). `current_law` is the default and contains the one scheduled expiry in scope: the senior deduction ends after tax year 2028. Reason: the spec's "law change scenario"; ids are data, so adding a rule set edits one file.
10. **The tax function follows Form 1040 in order**: Schedule D netting, Publication 915 Worksheet 1, AGI, standard deduction with the age-65 additions, the senior deduction (Schedule 1-A Part V), taxable income, the Qualified Dividends and Capital Gain Tax Worksheet, Form 8960, then the additional taxes of Form 5329 and Form 8889. Every step is `min`/`max` arithmetic with the worksheet line beside it. Reason: each output can be checked against a real return.
11. **Standard deduction only.** No itemizing, credits, AMT, QBI or blind addition. Reason: the spec names the standard deduction; design B's optional itemized input is dropped (8.2).
12. **The rate schedule, not the Tax Table.** Reason: the Tax Table's $50 bands are a filing convention worth a few dollars.
13. **Capital losses are modelled**: a net loss offsets up to $3,000 of ordinary income and the rest carries forward as one long-term amount per household. Reason: a taxable account sold below basis in a crash must neither create negative tax nor lose the loss.
14. **The hot path allocates nothing and never writes its inputs.** `federalTaxInto(tables, offset, inputs, outputs)` reads a per-path table filled once per path and writes a caller-owned `Float64Array`; the partial-year scaling is done on local scalars. Reason: tens of millions of calls per run, and the caller reuses the input array across gross-up iterations.
15. **Marginal outputs.** The hot path returns the statutory rate on the next dollar of ordinary income (0 while deductions are unused), the room left in the bracket, the unused deduction and the room in the 0% gains band; true effective marginal rates come from `effectiveMarginalRates`, a finite difference of two calls. Total tax is continuous and non-decreasing in every income input, with slope below 0.60 for pre-tax withdrawals (3.4). Reason: exactness without a second code path, and a stated contract for the gross-up solver.
16. **v2 quantities are outputs now**: AGI, MAGI for IRMAA, MAGI for the ACA, provisional income, taxable Social Security, bracket room. Reason: clean seams for Phase 5.
17. **Taxable accounts use an average-basis model with value and basis per asset class** (six classes, the frozen input's order), seeded from the account's basis split by its class weights. A sale realizes `amount × (1 − basis/value)`; rebalancing sells the classes that are over weight and realizes each class's own gain fraction. Reason: the smallest model that produces every Form 1040 input, conserves basis, and does not understate rebalancing gains (the flaw of a single pair per account).
18. **Interest is a yield, not the whole return**: bonds pay `max(0, cashReturn + spread)` of their value, cash pays `max(0, cashReturn)`, stock classes pay a fixed dividend yield of which a share is qualified. Reason: taxing every positive bond return as interest overstates ordinary income in rally years (both judges); the cash series exists in all three return models.
19. **Rebalancing gains are taxed one year later** through one `pendingLtcg` number. Reason: the spec's order puts rebalancing after taxes; a one-year lag removes the circularity.
20. **Basis steps up at the first death**: fully for the decedent's own taxable accounts, by half for joint accounts (fully in a community-property state). Reason: IRC §1014 and Publication 551; without it the survivor's later gains are overstated.
21. **Unknown cost basis is 0 unless the owner entered it** (inputs-and-data decision 11). Both source designs assumed half the value; the merged frozen input carries a basis for every taxable account, so this area assumes nothing.
22. **Additional tax on early pre-tax distributions**: 10% of the part of a withdrawal that falls before the owner is 59½, with one modelled exception: an employer-plan account (`type = 401k`) after separation from service in or after the year the owner reaches 55. Reason: the cases an early retiree meets; the other exceptions are listed in 8.2.
23. **Month-exact ages become a fraction of the period**: `earlyFraction` is the share of the year (or of the partial first year) that lies before the month the owner reaches 59½ (or 65 for an HSA). Reason: exact in expectation for withdrawals spread through the year, no whole-year cliff, and correct unchanged under monthly steps.
24. **After a death the survivor owns the decedent's pre-tax, Roth and HSA balances as their own from the next year (spousal rollover), everywhere**: the survivor's age sets RMDs and the early-distribution tests, and no beneficiary exception is modelled. Reason: both source designs mixed the rollover (for RMDs) with the beneficiary exception (for penalties), which are legally exclusive.
25. **Roth withdrawals follow the Publication 590-B ordering**: regular contributions and conversions older than five tax years, then the conversions of the last five tax years oldest first, then earnings; a real five-year clock (the first tax year a Roth of the person was funded) decides whether earnings are qualified. Reason: a Roth first funded by a scheduled conversion must not be treated as qualified at once.
26. **HSA**: withdrawals up to the year's qualified medical spending are tax-free; the excess is ordinary income and carries the 20% additional tax for the part of the year before 65. Reason: Publication 969 and Form 8889.
27. **Ages.** `year − birthYear` drives the age-65 deductions, RMDs and catch-up limits (the IRS tests are "by the end of the year"). Month-exact tests use the birth month, which the profile requires (inputs-and-data 4.2), so this area has no default birth month.
28. **RMD start age**: 72 for people born 1950 or earlier (already started), 73 for 1951 to 1959, 75 for 1960 and later. Reason: the spec's wording; SECURE 2.0 §107 as read by the 2024 proposed regulations.
29. **RMD amount** = the owner's total pre-tax balance on the previous 31 December ÷ the Uniform Lifetime divisor for the age attained in the year; the Joint and Last Survivor table replaces it while the owner is married to a spouse more than 10 years younger. Reason: Publication 590-B; the table is verified and costs one lookup.
30. **The first RMD is taken in the year the start age is reached**, never deferred to 1 April of the next year; no still-working exception, no qualified charitable distributions, no inherited accounts other than the spousal rollover. Reason: deferral forces two distributions into one year and is rarely better; the rest is v1 scope (8.2).
31. **An RMD is withdrawn first and is ordinary cash income** (L6); a scheduled Roth conversion comes on top of it; cash left after spending and tax is deposited in a taxable account at full basis. Reason: L6; the conversions column of the year table stays real and basis is conserved.
32. **Social Security benefit = PIA × age factor**, with SSA's fractions exactly: early retirement 5/9 of 1% a month for 36 months then 5/12 of 1%; delayed credits 2/3 of 1% a month to age 70; spousal excess reduced 25/36 of 1% a month for 36 months then 5/12 of 1%; survivor reduced linearly from 0% at survivor full retirement age to 28.5% at 60. Reason: SSA's program rules; exact fractions keep the factors free of rounding.
33. **SSA rounding is applied**: the PIA is truncated to the dime after each COLA, each benefit to the dime, the monthly payment to the dollar. Reason: benefits then match an SSA statement at the gate; it costs one `Math.floor` each.
34. **COLA** for year Y is the path's inflation of year Y − 1 rounded to 0.1%, never negative, measured against the last level that produced a COLA; 2026 (2.8%) and 2027 (3.6%) are published. Reason: Social Security Act §215(i); the historical record has deflation years.
35. **Delayed credits earned in the claim year are added the following January** unless the claim is at 70. Reason: SSA practice; it changes the first year's benefit.
36. **Deemed filing for everyone**: the spousal excess starts at the later of the two claim months and cannot be delayed separately; it is `max(0, 50% × partner's PIA − own PIA × max(1, own factor))`. Reason: the Bipartisan Budget Act of 2015 (everyone who turns 62 after 1 January 2016) and SSA's dual-entitlement rule.
37. **Survivor**: from the year after a death the survivor is paid the larger of their own benefit and the widow(er)'s benefit; the widow(er)'s benefit is the deceased's PIA with the deceased's delayed credits, reduced for the survivor's age, and when the deceased claimed early it is capped at the larger of the deceased's benefit and 82.5% of the deceased's PIA. Reason: SSA's survivor rules, including the widow(er)'s limit.
38. **The earnings test is modelled**: for a beneficiary under full retirement age with wages, $1 is withheld per $2 over the lower exempt amount, $1 per $3 over the higher amount in the year full retirement age is reached, and the withheld months are credited back at full retirement age by recomputing the reduction. Reason: "claim at 62 and keep working part-time" is a v1 input combination; design B only flagged it and overstated income by up to the whole benefit.
39. **The family maximum is ignored.** Reason: a worker and a spouse without children draw at most 150% of the PIA, which is the lowest value the family maximum can take.
40. **The benefit entered is indexed from its statement year**: by published COLAs up to the plan start and by path COLAs after (the frozen input's `asOfYear`). A person already receiving has the PIA backed out of the current benefit and the month it started. Reason: the frozen input carries the statement year, and one index is enough (8.3).
41. **Contribution limits** (401(k) deferral and catch-ups, §415(c), IRA, HSA) are in the yearly files and indexed with their statutory steps; `contributionLimit(year, age, kind)` serves the resolver's warning; the engine caps contributions with the path's limits. Reason: a savings rate carried forward for twenty years of raises must not exceed the law.
42. **The 2027 retirement-plan limits are not published and no forecast is stored.** The 2027 file carries the 2026 amounts for the six unpublished fields and lists them under `pending`; a run that reads a pending field carries the warning `limits_pending`. Reason: the forecasts on record disagree with each other (section 10.2); a carried amount is a known lower bound and is the same on every path.
43. **Employee payroll tax** (6.2% to the wage base, 1.45%, 0.9% over $200,000 or $250,000) is a separate helper and a separate result line, never part of the federal income tax total. Reason: the spec's tax list does not name it, but wages earned after the first retirement would otherwise net 7.65% too much.
44. **Partial first year (L3).** This area adopts the rule the frozen input already carries (inputs-and-data decision 19): year 0 runs from `plan.startMonth` through December, `f = plan.firstYearMonths / 12`. Flows arrive prorated by months; every tax amount is `f × Tax(x / f)` with the calendar year's thresholds; an RMD and every limit are `f ×` the full-year amount; Social Security pays the months that are in the plan. Reason: one rule in one place; both source designs used `(12 − month) / 12`, which the merged input replaced.
45. **Taxes are paid in the year they arise.** No withholding, estimated-payment or April timing. Reason: annual steps; totals are unaffected.
46. **Data provenance**: `manifest.json` lists every data file with its SHA-256 and one `dataVersion`; every file carries its sources (title, URL, retrieval date, checksum of the fetched source); the loader validates structure and invariants and refuses bad data (L7).
47. **The not-modelled list is data** (`notModelled.ts`), served by the rules view, shown in the UI, and each entry is pinned by a test (8.2).
48. **Run warnings** are fixed codes with an amount (the largest over paths and years) and a path count, merged by the thread harness (3.11).
49. **Errors.** The package throws `TaxDataError(code, message)` only when data is loaded or compiled; the hot-path functions are total over finite inputs. `PlanError` lives in `packages/db` and is never imported here: the services and routes map a `TaxDataError` (section 6).
50. **Tests.** Section 7 is the contract. Values shown as exact fractions or whole numbers are asserted to 1e-6; dollar values shown with cents are the exact result rounded to the cent and are asserted with `|x − expected| ≤ 0.005`; cents (`bigint`), months and table entries are asserted exactly.

## 2. Data model

Conventions for every data file: JSON, UTF-8, LF line endings, two-space indent, a trailing newline; money in whole dollars unless a field says otherwise; rates as decimal fractions; ages in months where a name ends in `Months`. Every file has `schemaVersion` and `sources[]` with entries `{ title, url, retrieved (YYYY-MM-DD), sha256 (of the fetched source, or null when it is a web page or could not be fetched), section?, note? }`. `taxData.ts` holds one Zod schema per file; `loadTaxData()` parses the statically imported modules, checks the invariants listed with each file and returns a frozen `TaxData`. In the listings below `"sources": [ … ]` stands for the file's source entries, which section 10.5 lists per file.

### 2.1 Which value lives where

| Value | File | Indexed after 2027? |
| --- | --- | --- |
| Ordinary brackets, standard deduction, age-65 addition, 0% and 15% gains thresholds | `tax/federal-YYYY.json` | yes (2.3) |
| Senior deduction, Social Security taxation bases, NIIT, loss limit, penalty rates, payroll rates and Additional Medicare thresholds | `tax/federal-YYYY.json` | no |
| Contribution limits, wage base, earnings-test amounts, the year's COLA | `tax/federal-YYYY.json` | yes (2.3) |
| Rounding steps, law changes, rule sets, the stale-data inflation | `tax/rules.json` | |
| Full retirement ages, reduction and credit fractions, survivor constants, COLAs before 2026 | `ss/rules.json` | no |
| RMD divisors and start ages | `rmd/*.json` | no |
| Dividend yields, qualified shares, bond spread, step-up shares | `taxable/tax-drag.json` | no (assumptions) |

### 2.2 `tax/federal-2026.json` and `tax/federal-2027.json`

Full contents, tax year 2026:

```json
{
  "schemaVersion": 1,
  "taxYear": 2026,
  "ordinary": {
    "rates": [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37],
    "thresholds": {
      "single": [0, 12400, 50400, 105700, 201775, 256225, 640600],
      "mfj":    [0, 24800, 100800, 211400, 403550, 512450, 768700]
    }
  },
  "standardDeduction": { "single": 16100, "mfj": 32200 },
  "additionalAged": { "single": 2050, "mfj": 1650 },
  "seniorDeduction": { "amountPerPerson": 6000, "minAge": 65, "phaseoutRate": 0.06,
                       "phaseoutStart": { "single": 75000, "mfj": 150000 } },
  "capitalGains": { "rates": [0, 0.15, 0.20],
                    "zeroRateMax":    { "single": 49450,  "mfj": 98900 },
                    "fifteenRateMax": { "single": 545500, "mfj": 613700 },
                    "netLossLimit": 3000 },
  "niit": { "rate": 0.038, "threshold": { "single": 200000, "mfj": 250000 } },
  "socialSecurityTaxation": { "base1": { "single": 25000, "mfj": 32000 },
                              "base2": { "single": 34000, "mfj": 44000 },
                              "rate1": 0.5, "rate2": 0.85, "maxShare": 0.85 },
  "additionalTaxes": { "earlyDistributionRate": 0.10, "hsaNonQualifiedRate": 0.20 },
  "contributionLimits": {
    "employeeDeferral": 24500, "catchUp50": 8000, "catchUp60to63": 11250, "annualAdditions": 72000,
    "ira": 7500, "iraCatchUp50": 1100,
    "hsaSelf": 4400, "hsaFamily": 8750, "hsaCatchUp55": 1000,
    "pending": []
  },
  "payroll": { "oasdiRate": 0.062, "oasdiWageBase": 184500, "medicareRate": 0.0145,
               "additionalMedicareRate": 0.009,
               "additionalMedicareThreshold": { "single": 200000, "mfj": 250000 } },
  "socialSecurity": { "cola": 0.028, "earningsTestUnderFra": 24480, "earningsTestFraYear": 65160 },
  "sources": [
    { "title": "Rev. Proc. 2025-32", "url": "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf", "retrieved": "2026-11-10",
      "sha256": "e9ada115fb43a4af5ea326ca91edd40ab0bf29b9be01d2c13d7b8fa96214635b",
      "section": "4.01 Tables 1 and 3; 4.03; 4.14" },
    { "title": "Notice 2025-67", "url": "https://www.irs.gov/pub/irs-drop/n-25-67.pdf", "retrieved": "2026-11-10",
      "sha256": "1eea8f141b0cddd182f9f09b3bc8ffad683d27ceb806dfc6da126811dc0a1f8d", "section": "plan and IRA limits" },
    { "title": "Rev. Proc. 2025-19", "url": "https://www.irs.gov/pub/irs-drop/rp-25-19.pdf", "retrieved": "2026-11-10",
      "sha256": "ff2ba4bac62ef6940c57578d70f8be88ff3898ac806e921ad52787c11da35bf4", "section": "HSA limits" },
    { "title": "SSA, cost-of-living adjustment information (2026 amounts)", "url": "https://www.ssa.gov/cola/",
      "retrieved": "2026-11-10", "sha256": null, "note": "host refused; figures from search results (section 10.2)" }
  ]
}
```

Full contents, tax year 2027 (the fields not shown are identical to 2026: `ordinary.rates`, `seniorDeduction`, `capitalGains.rates`, `capitalGains.netLossLimit`, `niit`, `socialSecurityTaxation`, `additionalTaxes`, the payroll rates and thresholds; the file repeats them in full):

```json
{
  "schemaVersion": 1,
  "taxYear": 2027,
  "ordinary": {
    "rates": [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37],
    "thresholds": {
      "single": [0, 12800, 52025, 109125, 208325, 264550, 661375],
      "mfj":    [0, 25600, 104050, 218250, 416650, 529100, 793650]
    }
  },
  "standardDeduction": { "single": 16600, "mfj": 33200 },
  "additionalAged": { "single": 2100, "mfj": 1700 },
  "capitalGains": { "rates": [0, 0.15, 0.20],
                    "zeroRateMax":    { "single": 51050,  "mfj": 102100 },
                    "fifteenRateMax": { "single": 563200, "mfj": 633600 },
                    "netLossLimit": 3000 },
  "contributionLimits": {
    "employeeDeferral": 24500, "catchUp50": 8000, "catchUp60to63": 11250, "annualAdditions": 72000,
    "ira": 7500, "iraCatchUp50": 1100,
    "hsaSelf": 4500, "hsaFamily": 9000, "hsaCatchUp55": 1000,
    "pending": ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50"]
  },
  "payroll": { "oasdiRate": 0.062, "oasdiWageBase": 192300, "medicareRate": 0.0145,
               "additionalMedicareRate": 0.009,
               "additionalMedicareThreshold": { "single": 200000, "mfj": 250000 } },
  "socialSecurity": { "cola": 0.036, "earningsTestUnderFra": 25560, "earningsTestFraYear": 67920 },
  "sources": [
    { "title": "Rev. Proc. 2026-35", "url": "https://www.irs.gov/pub/irs-drop/rp-26-35.pdf", "retrieved": "2026-11-10",
      "sha256": "87b383c6ce6e616fd006a61f5eed46fe67099b9c23fb1e1c42ff5359474513b8",
      "section": "3.01 Tables 1 and 3; 3.03; 3.15",
      "note": "Section 1 of the PDF as retrieved reads 'as in effect on [Release Date, 2026]' (an unfilled placeholder). Re-fetch and re-hash if the IRS replaces the file." },
    { "title": "Rev. Proc. 2026-24", "url": "https://www.irs.gov/pub/irs-drop/rp-26-24.pdf", "retrieved": "2026-11-10",
      "sha256": "bcb6b41a835b84d4315f738a7250801831021829e39d70225424e2f45afcb715", "section": "HSA limits" },
    { "title": "SSA fact sheet, 2027 Social Security changes", "url": "https://www.ssa.gov/news/en/cola/factsheets/2027.html",
      "retrieved": "2026-11-10", "sha256": null, "note": "host refused; figures from search results (section 10.2)" }
  ]
}
```

Field notes.

- `ordinary.thresholds[s][i]` is the lower bound in dollars of taxable income of bracket i ("over X"); `rates[i]` applies above it. The cumulative "plus" amounts of the IRS tables are derived, never stored; the loader asserts they equal the 24 published ones:

| Table | at threshold 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026 single | 1,240 | 5,800 | 17,966 | 41,024 | 58,448 | 192,979.25 |
| 2026 joint | 2,480 | 11,600 | 35,932 | 82,048 | 116,896 | 206,583.50 |
| 2027 single | 1,280 | 5,987 | 18,549 | 42,357 | 60,349 | 199,237.75 |
| 2027 joint | 2,560 | 11,974 | 37,098 | 84,714 | 120,698 | 213,290.50 |

- `additionalAged[s]` is per person aged 65 or over at year end (§63(f)): the unmarried amount under `single`, the married amount per qualifying spouse under `mfj`.
- `seniorDeduction` is the 2025 to 2028 deduction of P.L. 119-21 (Schedule 1-A Part V): per eligible person `max(0, 6000 − 0.06 × max(0, MAGI − phaseoutStart))`. It is a deduction from taxable income, not from AGI. Its expiry is a law change in `current_law` (2.3), not a property of the year files.
- `capitalGains.zeroRateMax` and `fifteenRateMax` are the "maximum zero rate amount" and "maximum 15 percent rate amount" in dollars of taxable income.
- `socialSecurity.cola` for year Y is the adjustment first paid in January Y.
- `contributionLimits.pending` names the fields whose value the IRS had not published at retrieval; such a field holds the previous year's published amount. For 2027 the HSA amounts are published (Rev. Proc. 2026-24) and the six retirement-plan amounts are pending. The implementer replaces them from the IRS notice (the 2026 notice appeared on 13 November 2025) and empties the list before the gate.
- Invariants asserted on every year file: thresholds start at 0 and strictly ascend; rates ascend within [0, 1]; `thresholds.single[1..5] × 2 = thresholds.mfj[1..5]` (the 37% threshold is not a half); `standardDeduction.single × 2 = standardDeduction.mfj`; `zeroRateMax.single × 2 = zeroRateMax.mfj`; `zeroRateMax < fifteenRateMax`; `base1 < base2`; `taxYear` matches the file name; the years are contiguous from 2026.

### 2.3 `tax/rules.json`

```json
{
  "schemaVersion": 1,
  "staleInflation": 0.025,
  "indexing": [
    { "path": "ordinary.thresholds",              "index": "cpi",  "round": "floor_increase", "step": { "single": 25, "mfj": 50 } },
    { "path": "standardDeduction",                "index": "cpi",  "round": "floor_increase", "step": { "single": 50, "mfj": 100 } },
    { "path": "additionalAged",                   "index": "cpi",  "round": "floor_increase", "step": { "single": 50, "mfj": 50 } },
    { "path": "capitalGains.zeroRateMax",         "index": "cpi",  "round": "floor_increase", "step": { "single": 25, "mfj": 50 } },
    { "path": "capitalGains.fifteenRateMax",      "index": "cpi",  "round": "floor_increase", "step": { "single": 50, "mfj": 50 } },
    { "path": "contributionLimits.employeeDeferral", "index": "cpi", "round": "floor_increase", "step": 500 },
    { "path": "contributionLimits.catchUp50",     "index": "cpi",  "round": "floor_increase", "step": 500 },
    { "path": "contributionLimits.catchUp60to63", "index": "cpi",  "round": "floor_increase", "step": 500 },
    { "path": "contributionLimits.annualAdditions", "index": "cpi", "round": "floor_increase", "step": 1000 },
    { "path": "contributionLimits.ira",           "index": "cpi",  "round": "floor_increase", "step": 500 },
    { "path": "contributionLimits.iraCatchUp50",  "index": "cpi",  "round": "floor_increase", "step": 100 },
    { "path": "contributionLimits.hsaSelf",       "index": "cpi",  "round": "nearest", "step": 50 },
    { "path": "contributionLimits.hsaFamily",     "index": "cpi",  "round": "nearest", "step": 50 },
    { "path": "payroll.oasdiWageBase",            "index": "wage", "round": "nearest", "step": 300 },
    { "path": "socialSecurity.earningsTestUnderFra", "index": "wage", "round": "nearest", "step": 120 },
    { "path": "socialSecurity.earningsTestFraYear",  "index": "wage", "round": "nearest", "step": 120 }
  ],
  "lawChanges": {
    "senior_deduction_sunset": {
      "label": "Senior deduction ends after 2028", "illustrative": false,
      "description": "P.L. 119-21 allows the $6,000 deduction for taxable years 2025 through 2028.",
      "ops": [ { "op": "setValue", "path": "seniorDeduction.amountPerPerson", "value": 0, "fromYear": 2029, "dollars": "nominal" } ] },
    "ss_trust_fund_shortfall": {
      "label": "Social Security pays 78% of scheduled benefits from 2033", "illustrative": true,
      "description": "The 2026 Trustees Report projects the retirement trust fund's reserves run out in late 2032, after which income covers 78% of benefits.",
      "ops": [ { "op": "scaleSocialSecurity", "fromYear": 2033, "factor": 0.78 } ] },
    "ordinary_rates_plus_2pts_2031": {
      "label": "Every ordinary rate 2 points higher from 2031", "illustrative": true,
      "description": "A what-if, not a forecast.",
      "ops": [ { "op": "shiftOrdinaryRates", "fromYear": 2031, "delta": 0.02 } ] }
  },
  "ruleSets": [
    { "id": "current_law", "label": "Current law as enacted", "lawChanges": ["senior_deduction_sunset"] },
    { "id": "senior_deduction_permanent", "label": "Senior deduction made permanent", "lawChanges": [] },
    { "id": "ss_shortfall_2033", "label": "Current law, Social Security at 78% from 2033",
      "lawChanges": ["senior_deduction_sunset", "ss_trust_fund_shortfall"] },
    { "id": "rates_plus_2pts_2031", "label": "Current law, ordinary rates 2 points higher from 2031",
      "lawChanges": ["senior_deduction_sunset", "ordinary_rates_plus_2pts_2031"] }
  ],
  "sources": [ … ]
}
```

Indexing fields: `index` is `cpi` (factor `F_Y`), `wage` (factor `W_Y`, 3.2) or absent for everything not listed (never indexed); `round` is `floor_increase` (decision 7) or `nearest` (`floor(value_L × factor / step + 0.5) × step`); `step` is in dollars, one number or one per status. `socialSecurity.cola` follows its own rule (3.9.6). `staleInflation` is the annual rate assumed for calendar years between the last published year and a plan that starts later (3.2).

Law-change operations (all applied by `compileTaxLaw`, in the order listed, to the year records they cover):

| op | Fields | Effect |
| --- | --- | --- |
| `setValue` | `path` (one of `LAW_PATHS`), `value` (a number, a per-status object, or an array where the path is an array), `fromYear`, `toYear?`, `dollars` (`base` or `nominal`, default `base`) | replaces the value in every year record of the window. `base`: the value is in last-published-year dollars and stays subject to the path's indexing; `nominal`: it is used as written in every year |
| `replaceSchedule` | `fromYear`, `toYear?`, `table` (`ordinary`, `standardDeduction`, `additionalAged`, `capitalGains` in the shape of a year file, in last-published-year dollars) | replaces brackets, deductions and gains thresholds; indexed like the base |
| `shiftOrdinaryRates` | `fromYear`, `toYear?`, `delta` (−0.10 to 0.20) | adds `delta` to every ordinary rate |
| `freezeIndexing` | `fromYear`, `toYear` | the `cpi` factor is not advanced in these years (`F_Y = F_{Y−1}`) |
| `scaleSocialSecurity` | `fromYear`, `toYear?`, `factor` (0 to 1.5) | multiplies every Social Security benefit paid in the window |

`LAW_PATHS` (a `z.enum` in `taxData.ts`, so a misspelt path is a load error): `ordinary.rates`, `ordinary.thresholds`, `standardDeduction`, `additionalAged`, `seniorDeduction.amountPerPerson`, `seniorDeduction.phaseoutStart`, `seniorDeduction.phaseoutRate`, `capitalGains.rates`, `capitalGains.zeroRateMax`, `capitalGains.fifteenRateMax`, `capitalGains.netLossLimit`, `niit.rate`, `niit.threshold`, `socialSecurityTaxation.base1`, `socialSecurityTaxation.base2`, `socialSecurityTaxation.rate1`, `socialSecurityTaxation.rate2`, `socialSecurityTaxation.maxShare`, `additionalTaxes.earlyDistributionRate`, `additionalTaxes.hsaNonQualifiedRate`, `payroll.oasdiRate`, `payroll.medicareRate`, `payroll.additionalMedicareRate`, `payroll.additionalMedicareThreshold`.

Loader invariants: every `ruleSets[].lawChanges` id exists; rule set ids are unique, match `^[a-z][a-z0-9_]{0,39}$` (the frozen input's pattern) and include `current_law`; every indexed path exists in the year files. After the operations are applied to a year, the invariants of 2.2 are checked again except the three structural identities; a violation is `TaxDataError("law_change_invalid")`.

### 2.4 `ss/rules.json`

```json
{
  "schemaVersion": 1,
  "retirementFraMonths": [[1937, 780], [1938, 782], [1939, 784], [1940, 786], [1941, 788], [1942, 790],
                          [1954, 792], [1955, 794], [1956, 796], [1957, 798], [1958, 800], [1959, 802], [9999, 804]],
  "survivorFraBirthYearShift": 2,
  "earliestRetirementMonths": 744, "latestCreditMonths": 840,
  "earlyReduction":   { "firstMonths": 36, "first": "5/900",   "later": "5/1200" },
  "spousalReduction": { "firstMonths": 36, "first": "25/3600", "later": "5/1200" },
  "delayedCreditPerMonth": "1/150",
  "spousalShare": "1/2",
  "survivor": { "earliestMonths": 720, "maxReduction": "285/1000", "widowLimitShare": "825/1000" },
  "earningsTest": { "withholdUnderFra": "1/2", "withholdFraYear": "1/3" },
  "colaStep": 0.001,
  "colaHistory": { "2017": 0.003, "2018": 0.020, "2019": 0.028, "2020": 0.016, "2021": 0.013,
                   "2022": 0.059, "2023": 0.087, "2024": 0.032, "2025": 0.025 },
  "sources": [ … ]
}
```

Each row `[y, m]` of `retirementFraMonths` reads "born in year y or earlier, and after the previous row's year: m months" (780 = 65 years, 792 = 66, 804 = 67). The survivor table is the retirement table read at `birthYear − 2`. Fractions are strings parsed to numerator and denominator, so factors are computed exactly as rationals and converted to float64 once. `colaHistory[y]` is the adjustment first paid in January of year y; 2026 and 2027 are in the year files. The history exists only to index a benefit entered from an older statement (3.9.6); its nine values are unverified (section 10.3). Invariants: FRA rows ascend in both columns; every fraction lies in (0, 1]; `colaHistory` years are contiguous and end at 2025.

### 2.5 `rmd/uniform-lifetime.json` and `rmd/joint-life.json`

```json
{
  "schemaVersion": 1,
  "table": "Uniform Lifetime (Pub. 590-B Appendix B, Table III)",
  "startAge": [[1950, 72], [1959, 73], [9999, 75]],
  "jointTableSpouseGapYears": 10,
  "firstAge": 72, "lastAge": 120,
  "divisors": [27.4, 26.5, 25.5, 24.6, 23.7, 22.9, 22.0, 21.1, 20.2, 19.4, 18.5, 17.7, 16.8, 16.0, 15.2, 14.4, 13.7,
               12.9, 12.2, 11.5, 10.8, 10.1, 9.5, 8.9, 8.4, 7.8, 7.3, 6.8, 6.4, 6.0, 5.6, 5.2, 4.9, 4.6, 4.3, 4.1,
               3.9, 3.7, 3.5, 3.4, 3.3, 3.1, 3.0, 2.9, 2.8, 2.7, 2.5, 2.3, 2.0],
  "sources": [ { "title": "Publication 590-B (2025)", "url": "https://www.irs.gov/pub/irs-pdf/p590b.pdf", "retrieved": "2026-11-10",
                 "sha256": "d18a592e55ce56d43953dc338272ece3984565792d6dca06989a6ca8121f7360", "section": "Appendix B, Table III" } ]
}
```

`divisors[i]` is the distribution period in years for age `72 + i`; the last entry is the "120 and over" row. `startAge` rows read like the FRA rows. Invariants: 49 entries, strictly decreasing, sum 532.0, `divisors[1] = 26.5`, `divisors[3] = 24.6`, `divisors[8] = 20.2`.

`rmd/joint-life.json` is Publication 590-B (2025) Appendix B Table II as a full square:

```json
{ "schemaVersion": 1, "table": "Joint Life and Last Survivor Expectancy (Pub. 590-B Appendix B, Table II)",
  "firstAge": 20, "lastAge": 120, "rows": [ [72.0, 71.5, …101 numbers…], …101 rows… ] }
```

`rows[a − 20][b − 20]` is the divisor in years for an owner aged a and a spouse aged b; ages above 120 use 120 and a spouse under 20 uses 20. The file to copy is the scratch file named at the top of this document: 60,575 bytes, 109 lines, SHA-256 `bd8af7bf76d6d97c5e822834def6975ce09e7821c39917bc32faf5f247ee5350` (one row per line, one decimal per number). It was produced from the table design A parsed out of the publication, which both judges re-checked. Validation the loader runs: 101 × 101 numbers; symmetric; each row non-increasing; the sum of all 10,201 cells is 368,500.6; spot values (75, 64) = 25.3 (the publication's own example), (73, 62) = 27.2, (73, 60) = 28.6, (73, 50) = 36.8, (80, 65) = 23.8, (85, 70) = 19.5, (90, 75) = 15.4, (100, 85) = 8.5, (20, 20) = 72.0, (120, 120) = 1.0; and `rows[a][a − 10]` equals the Uniform Lifetime divisor for every a from 72 to 120 except a = 112 (3.2 against 3.3, a difference present in the IRS tables). Fallback if the file cannot be verified: ship an empty `rows` array (the schema accepts exactly 0 or 101 rows), which makes `rmdDivisor` use the Uniform table for everyone and adds the compile warning `rmd_joint_table_unavailable`; RMDs are then slightly too large for couples more than 10 years apart.

### 2.6 `taxable/tax-drag.json` (modelling assumptions, not law)

```json
{
  "schemaVersion": 1,
  "classes": {
    "us_stock":    { "dividendYield": 0.013, "qualifiedShare": 0.95, "interest": "none",      "interestSpread": 0,     "taxExemptShare": 0, "gainDistributionRate": 0 },
    "intl_stock":  { "dividendYield": 0.028, "qualifiedShare": 0.75, "interest": "none",      "interestSpread": 0,     "taxExemptShare": 0, "gainDistributionRate": 0 },
    "bonds":       { "dividendYield": 0,     "qualifiedShare": 0,    "interest": "cash_rate", "interestSpread": 0.010, "taxExemptShare": 0, "gainDistributionRate": 0 },
    "cash":        { "dividendYield": 0,     "qualifiedShare": 0,    "interest": "cash_rate", "interestSpread": 0,     "taxExemptShare": 0, "gainDistributionRate": 0 },
    "real_estate": { "dividendYield": 0.035, "qualifiedShare": 0,    "interest": "none",      "interestSpread": 0,     "taxExemptShare": 0, "gainDistributionRate": 0 },
    "other":       { "dividendYield": 0,     "qualifiedShare": 0,    "interest": "none",      "interestSpread": 0,     "taxExemptShare": 0, "gainDistributionRate": 0 }
  },
  "fallbackCashYield": 0.03,
  "basisStepUp": { "ownAccount": 1, "jointAccount": 0.5, "jointAccountCommunityProperty": 1,
                   "communityPropertyStates": ["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"] },
  "sources": [ … ]
}
```

`dividendYield`: fraction of the class's start-of-year value paid as dividends in the year; `qualifiedShare`: fraction of those dividends that are qualified; `interest: "cash_rate"`: the class pays `max(0, cashReturn + interestSpread)` of its value as interest, where `cashReturn` is the path's nominal return on the cash class that year; `taxExemptShare`: fraction of that interest that is tax-exempt (municipal funds); `gainDistributionRate`: fraction of the class's unrealized gain distributed as long-term gain each year (fund turnover); `fallbackCashYield`: used with warning `cash_series_missing` only if the engine cannot supply a cash return; `basisStepUp`: the share of unrealized gain erased at the first death by account owner (3.6). A scenario may override the per-class numbers through `TaxSettings.taxDrag` (4.3).

### 2.7 `manifest.json`

`{ "dataVersion": "2026.11.1", "firstTaxYear": 2026, "lastPublishedYear": 2027, "files": [ { "path": "tax/federal-2026.json", "sha256": "…" }, … ] }`. `DATA_VERSION` (the engine area exports it; inputs-and-data records it on every run) is this string. Any edit to a data file changes a hash and must bump `dataVersion`; the data test recomputes the hashes with Node's `crypto` (test only, so the package itself needs no Node API).

### 2.8 Typed-array layouts (`layout.ts`)

All records are `Float64Array` slots holding dollars or fractions. The constants are plain `const` objects (`TR`, `PR`, `TI`, `TO`, `RB`, `SS`, `SO`, `YI`, `WN`), not `const enum`, so Vite's isolated modules accept them.

Per-path tax table: `Float64Array(years × 2 × TAX_REC)`, `TAX_REC = 48`, record offset `taxOffset(yearIndex, status) = (yearIndex × 2 + status) × 48`.

| Slot | Name | Meaning |
| --- | --- | --- |
| 0 | `STD` | standard deduction |
| 1 | `AGED` | additional standard deduction per person 65 or over |
| 2, 3, 4 | `SENIOR_AMT`, `SENIOR_START`, `SENIOR_RATE` | senior deduction per person, phase-out start, phase-out rate |
| 5, 6 | `LTCG0`, `LTCG15` | maximum zero-rate and 15%-rate amounts |
| 7, 8 | `LTCG_RATE1`, `LTCG_RATE2` | 0.15, 0.20 |
| 9, 10 | `NIIT_THRESHOLD`, `NIIT_RATE` | |
| 11 to 15 | `SS_BASE1`, `SS_BASE2`, `SS_RATE1`, `SS_RATE2`, `SS_MAX_SHARE` | Publication 915 amounts |
| 16 | `LOSS_LIMIT` | net capital loss limit |
| 17, 18 | `PEN_EARLY_RATE`, `PEN_HSA_RATE` | 0.10, 0.20 |
| 19 | `N_BRACKETS` | 7 |
| 20 to 27 | `THR0 + i` | bracket lower bounds; slot 27 is the `+Infinity` sentinel |
| 28 to 35 | `RATE0 + i` | bracket rates |
| 36 to 43 | `BASE0 + i` | tax at each lower bound |
| 44 to 47 | reserved | v2 (IRMAA, ACA) |

Per-path program table: `Float64Array(years × PROG_REC)`, `PROG_REC = 24`, offset `progOffset(yearIndex) = yearIndex × 24`: 0 `COLA`, 1 `SS_SCALE`, 2 `ET_UNDER`, 3 `ET_FRA`, 4 `WAGE_BASE`, 5 `DEFERRAL`, 6 `CATCHUP50`, 7 `CATCHUP6063`, 8 `ANNUAL_ADD`, 9 `IRA`, 10 `IRA_CATCHUP`, 11 `HSA_SELF`, 12 `HSA_FAMILY`, 13 `HSA_CATCHUP`, 14 `OASDI_RATE`, 15 `MEDICARE_RATE`, 16 `ADDL_MEDICARE_RATE`, 17 `ADDL_MEDICARE_THR_SINGLE`, 18 `ADDL_MEDICARE_THR_MFJ`, 19 `CPI_FACTOR` (`F_Y`), 20 `WAGE_FACTOR` (`W_Y`), 21 to 23 reserved.

Tax inputs `Float64Array(TAX_IN = 24)`, dollars for the plan year (annual, or the partial first year's amounts):

| Slot | Name | Form 1040 (2025) line | Notes |
| --- | --- | --- | --- |
| 0 | `WAGES` | 1z | after pre-tax and HSA payroll deferrals |
| 1 | `PENSION` | 5b | taxable pensions and annuities |
| 2 | `INTEREST` | 2b | taxable interest |
| 3 | `TAX_EXEMPT_INTEREST` | 2a | counts toward provisional income and MAGI only |
| 4 | `ORD_DIV` | 3b | ordinary dividends including the qualified part |
| 5 | `QUAL_DIV` | 3a | at most `ORD_DIV` |
| 6 | `ST_GAIN` | Schedule D line 7 | net short-term gain or loss, signed |
| 7 | `LT_GAIN` | Schedule D line 15 | net long-term gain or loss before the carryover, signed |
| 8 | `LOSS_CARRY_IN` | Schedule D line 14 | at least 0; last year's `LOSS_CARRY_OUT` |
| 9 | `TRAD_DIST` | 4b | taxable pre-tax distributions including RMDs |
| 10 | `ROTH_CONV` | 4b | Roth conversions |
| 11 | `ROTH_TAXABLE` | 4b | non-qualified Roth earnings distributed |
| 12 | `HSA_TAXABLE` | Schedule 1 line 8f | non-qualified HSA distributions |
| 13 | `SS_GROSS` | 6a | household benefits (SSA-1099 box 5) |
| 14 | `RENTAL` | Schedule 1 line 5 | net rental income, at least 0 (also investment income) |
| 15 | `OTHER_ORD` | Schedule 1 | any other ordinary income |
| 16 | `NII_OTHER` | Form 8960 | investment income already inside another line; 0 in v1 |
| 17 | `ADJUSTMENTS` | 10 | above-the-line deductions; 0 in the v1 loop (deferrals reduce `WAGES`) |
| 18 | `PEN10_BASE` | Form 5329 line 3 | amount subject to the 10% additional tax |
| 19 | `PEN20_BASE` | Form 8889 line 16 | amount subject to the 20% additional tax |
| 20 | `N_AGED` | | filers aged 65 or over at year end (0, 1 or 2) |
| 21 | `YEAR_FRACTION` | | f of decision 44; 0 or 1 means a full year |
| 22, 23 | reserved | | |

Tax outputs `Float64Array(TAX_OUT = 32)`: 0 `TOTAL`, 1 `INCOME_TAX` (Form 1040 line 16), 2 `ORD_TAX` (worksheet line 22), 3 `CG_TAX` (`INCOME_TAX − ORD_TAX`), 4 `NIIT`, 5 `PEN10`, 6 `PEN20`, 7 `AGI`, 8 `TAXABLE_INCOME`, 9 `ORD_TAXABLE`, 10 `TAXABLE_SS`, 11 `PROVISIONAL` (Worksheet 1 line 8), 12 `STD_DEDUCTION`, 13 `SENIOR_DEDUCTION`, 14 `PREF_AT_0`, 15 `PREF_AT_15`, 16 `PREF_AT_20`, 17 `NII`, 18 `LOSS_CARRY_OUT`, 19 `LOSS_USED`, 20 `BRACKET_RATE`, 21 `BRACKET_INDEX`, 22 `ROOM_IN_BRACKET` (`+Infinity` in the top bracket), 23 `ROOM_IN_LTCG0`, 24 `MAGI_IRMAA`, 25 `MAGI_ACA`, 26 `PREF_INCOME` (worksheet line 10), 27 `LTCG_NEXT_RATE`, 28 `UNUSED_DEDUCTION`, 29 to 31 reserved.

Other layouts:

- Roth basis per person, `RB`, `Float64Array(8)`: 0 `BASIS_FREE` (regular contributions plus conversions older than five tax years), 1 to 5 `CONV0`…`CONV4` (conversions of the last five tax years; `CONV0` was made four tax years ago, `CONV4` this year), 6 `FIRST_YEAR` (the first tax year any Roth of this person was funded; 0 = none yet), 7 reserved.
- Social Security state per path, `SS`, `Float64Array(16)`, two slots each for person 0 and person 1: 0, 1 `PIA` (dollars a month, this year's); 2, 3 `ARF_MONTHS` (months of benefit withheld by the earnings test, credited back at full retirement age); 4, 5 `SPOUSAL_FACTOR` (fixed when the spousal excess starts; −1 until then); 6, 7 `SURVIVOR_FACTOR` (fixed when the widow(er)'s benefit starts; −1 until then); 8, 9 `DECEASED_FACTOR` (the person's own factor, fixed at their death; −1 while alive); 10 to 15 reserved.
- Social Security output, `SO`, `Float64Array(10)`: 0, 1 the year's benefit per person, net of withholding and scaled; 2, 3 the spousal part; 4, 5 the survivor part (what the widow(er)'s benefit adds over own plus spousal); 6, 7 withheld by the earnings test; 8, 9 months paid.
- Taxable holding: two `Float64Array`s `value` and `basis` with six slots per holding from an offset, in the class order of the frozen input's `ClassWeights`: `us_stock`, `intl_stock`, `bonds`, `cash`, `real_estate`, `other`.
- Taxable income output, `YI`, `Float64Array(12)`: 0 `INTEREST`, 1 `TAX_EXEMPT_INTEREST`, 2 `ORD_DIV`, 3 `QUAL_DIV`, 4 `LT_GAIN_DIST`, 5 reserved, 6 to 11 the income of each class (for the reinvestment step).
- Warning amounts per path, `WN`, `Float64Array(8)` (3.11).

### 2.9 State the engine holds for this area (per path)

| State | Shape | Units | Rule |
| --- | --- | --- | --- |
| `lossCarry` | 1 number | dollars | 3.3 step 1 |
| `pendingLtcg` | 1 number | dollars | 3.6 step 6 |
| taxable holding | `value[6]`, `basis[6]` per taxable or cash account | dollars | 3.6 |
| Roth basis | `RB` record per person | dollars, year | 3.7.2 |
| Social Security state | `SS` record | dollars a month, months, fractions | 3.9 |
| prior year-end pre-tax balance per person | 1 number each | dollars | 3.8 |
| two-year history of `MAGI_IRMAA` | 2 numbers | dollars | v2 seam |
| warning amounts | `WN` record | dollars | 3.11 |

## 3. Algorithms

Rounding in this area: none inside the engine except where a rule names it (the statutory steps of 3.2, the SSA truncations of 3.9). Dollars become cents only in `computeFederalTax` and `contributionLimit`: `toCents(x) = BigInt(sign(x) × floor(|x| × 100 + 0.5 + 1e-7))`, half away from zero (1.005 gives 101, −1,234.565 gives −123,457).

### 3.1 Calendar, ages and the partial first year

- `monthIndex(year, month) = year × 12 + (month − 1)` with month 1 to 12; `birthIndex = monthIndex(birthYear, birthMonth)`. A person reaches an age of `a` months at month index `birthIndex + a` (inputs-and-data decision 20). 59½ is 714 months, 60 is 720, 62 is 744, 65 is 780, 70 is 840.
- `ageAtYearEnd(year) = year − birthYear`. `N_AGED` is the number of filers on the return (the living, and a person who died that year) with `ageAtYearEnd ≥ 65`.
- Plan year i is calendar year `plan.startYear + i`. Its period is `[periodStart, periodStart + periodMonths)`: for i = 0, `periodStart = monthIndex(plan.startMonth)` and `periodMonths = plan.firstYearMonths`; for i > 0, `periodStart = 12 × year` and `periodMonths = 12`. `f = periodMonths / 12`.
- The first-year rule, used everywhere in this area: amounts for year 0 are the amounts of its months (the engine prorates flows by months); every dollar threshold of the calendar year applies scaled by f, which is the same as `f × Tax(x / f)`; an RMD is `f ×` the full-year amount; contribution limits and earnings-test amounts are `f ×`; payroll tax is `f × payroll(wages / f)`; Social Security pays exactly the months of the period. Example: as-of date 2026-11-09 gives `startMonth` 2026-11, `firstYearMonths` 2, f = 1/6; the inputs fixture (as-of 2026-10-13) gives 3 months, f = 1/4.

### 3.2 Compile and index (`compile.ts`)

`compileTaxLaw(data, { startYear, years, ruleSetId, ssAdjustment? })`, once per run in the job's thread:

1. Resolve the rule set (`TaxDataError("unknown_rule_set")` when the id is not in `ruleSets`) into its ordered operations.
2. For each plan-year index i (calendar year Y = startYear + i): take the year file of Y when published, else a copy of the last published year's record (its values are in L dollars). Apply every operation whose window contains Y. Check the invariants (2.3).
3. Flatten each year into `base`, `step` and `mode` arrays in the layouts of 2.8, one entry per slot: mode 0 fixed, 1 floor-increase, 2 nearest. Slots of a published year, slots without an indexing rule and `dollars: "nominal"` values get mode 0; `PR.SS_SCALE` is the product of the `scaleSocialSecurity` factors in force and of `ssAdjustment.factor` from `ssAdjustment.fromYear` on (the frozen input's `socialSecurity.adjustment`, `factorBp / 10000`). A per-year `frozen` flag records `freezeIndexing`.
4. Record `dataVersion`, the rule set id and the compile warnings: `tax_data_stale` when `startYear > L` (the plan starts after the last published tax year, so at least one year is indexed with `staleInflation`), `limits_pending` when a pending limit field is read, `rmd_joint_table_unavailable`.

`fillPathTables(law, indexInflation, opts, outTax, outProg)`, once per path. `indexInflation[i]` is the path's inflation rate for the whole calendar year `startYear + i` (for year 0 the full-year rate, not prorated); `opts = { chainedCpiWedge, realWageGrowth }` from `TaxSettings` (fractions, both default 0).

1. Factors. `π(y) = indexInflation[y − startYear]` when `y ≥ startYear`, else `staleInflation`. `F_Y = 1` and `W_Y = 1` for `Y ≤ L`. For `Y > L`: `F_Y = F_{Y−1} × (1 + π(Y − 1)) × (1 − chainedCpiWedge)`, or `F_Y = F_{Y−1}` when year Y is frozen; `W_Y = W_{Y−1} × (1 + π(Y − 1) + realWageGrowth)`.
2. Every slot: mode 0 copies `base`; mode 1 writes `base + floor(base × (F − 1) / step + 1e-9) × step`; mode 2 writes `floor(base × factor / step + 0.5) × step` with `factor` = `F` or `W` by the path's `index`.
3. Recompute the tax at each bracket bound: `BASE0 = 0`, `BASE_i = BASE_{i−1} + (THR_i − THR_{i−1}) × RATE_{i−1}`; slot `THR0 + 7 = +Infinity`.
4. `PR.COLA` per 3.9.6; `PR.CPI_FACTOR = F_Y`; `PR.WAGE_FACTOR = W_Y`.

The `1e-9` guard matters: `20,000 × (1.15 − 1) / 50` is `59.999999999999964` in float64 and must floor to 60 (23,000), not 59.

Worked example (test J1): L = 2027, path inflation 3.0% in 2027, 2.5% in 2028, −1.0% in 2029. `F_2028 = 1.03`, `F_2029 = 1.03 × 1.025 = 1.05575`, `F_2030 = 1.05575 × 0.99 = 1.0451925`. Joint 12% threshold for 2028: 25,600 × 0.03 = 768, floored to a multiple of 50 = 750, so 26,350; single: 12,800 × 0.03 = 384, floored to 25 = 375, so 13,175 (exactly half). Single standard deduction: 16,600 × 0.03 = 498, floored to 50 = 450, so 17,050; joint: 33,200 × 0.03 = 996, floored to 100 = 900, so 34,100 (exactly twice). With `chainedCpiWedge = 0.0025`: `F_2028 = 1.03 × 0.9975 = 1.027425` and the joint 22% threshold is 104,050 + floor(2,853.57 / 50) × 50 = 106,900. A plan that starts in 2029 on data ending at 2027: `F_2028 = 1.025`, `F_2029 = 1.050625` from `staleInflation`, joint 12% threshold 26,200 then 26,850, with `tax_data_stale`.

### 3.3 Federal income tax for one household-year (`federalTaxInto`)

`federalTaxInto(t, o, x, r)`: `t` the path tax table, `o` the record offset, `x` the inputs, `r` the outputs; returns `r[TO.TOTAL]`. Let `f = x[YEAR_FRACTION]`; when `0 < f < 1` every dollar input is read into a local as `x[k] / f` and every dollar output is multiplied by f before it is written (rates, the bracket index and `+Infinity` are left alone). `x` is never written. Names below are the locals.

Step 1, Schedule D. `netLT = LT_GAIN − LOSS_CARRY_IN`; `net = ST_GAIN + netLT`.
- `net ≥ 0`: `capInAgi = net`; `prefGain = max(0, min(netLT, net))` (the smaller of Schedule D lines 15 and 16, zero when either is a loss); `LOSS_USED = 0`; `LOSS_CARRY_OUT = 0`.
- `net < 0`: `LOSS_USED = min(−net, LOSS_LIMIT)`; `capInAgi = −LOSS_USED`; `prefGain = 0`; `LOSS_CARRY_OUT = −net − LOSS_USED`.

Step 2, income other than Social Security (Worksheet 1 line 3): `other = WAGES + PENSION + INTEREST + ORD_DIV + TRAD_DIST + ROTH_CONV + ROTH_TAXABLE + HSA_TAXABLE + RENTAL + OTHER_ORD + capInAgi`.

Step 3, taxable Social Security (Publication 915 Worksheet 1, line numbers in brackets). `PROVISIONAL = other + TAX_EXEMPT_INTEREST + 0.5 × SS_GROSS − ADJUSTMENTS` [2 to 8]. `tier1 = min(SS_RATE1 × SS_GROSS, SS_RATE1 × max(0, PROVISIONAL − SS_BASE1), SS_RATE1 × (SS_BASE2 − SS_BASE1))` [9 to 15: the excess over the base amount, capped at $9,000 single or $12,000 joint, halved, and not more than half the benefits]. `TAXABLE_SS = min(SS_MAX_SHARE × SS_GROSS, SS_RATE2 × max(0, PROVISIONAL − SS_BASE2) + tier1)` [16 to 19]. Below the first base both terms are 0; between the bases the result is `tier1`; above the second it is the two-tier sum capped at 85% of benefits.

Step 4. `AGI = other + TAXABLE_SS − ADJUSTMENTS`.

Step 5, deductions. `STD_DEDUCTION = STD + N_AGED × AGED`. `SENIOR_DEDUCTION = N_AGED × max(0, SENIOR_AMT − SENIOR_RATE × max(0, AGI − SENIOR_START))` (Schedule 1-A lines 31 to 37; its MAGI is AGI because foreign exclusions are not modelled). `TAXABLE_INCOME = max(0, AGI − STD_DEDUCTION − SENIOR_DEDUCTION)`. `UNUSED_DEDUCTION = max(0, STD_DEDUCTION + SENIOR_DEDUCTION − AGI)`.

Step 6, Qualified Dividends and Capital Gain Tax Worksheet (line numbers in brackets). `PREF_INCOME = min(QUAL_DIV + prefGain, TAXABLE_INCOME)` [10]. `ORD_TAXABLE = TAXABLE_INCOME − PREF_INCOME` [5]. `ORD_TAX = bracket(ORD_TAXABLE)` [22]. `PREF_AT_0 = max(0, min(TAXABLE_INCOME, LTCG0) − ORD_TAXABLE)` [9]. `PREF_AT_15 = min(PREF_INCOME − PREF_AT_0, max(0, min(TAXABLE_INCOME, LTCG15) − (ORD_TAXABLE + PREF_AT_0)))` [17]. `PREF_AT_20 = PREF_INCOME − PREF_AT_0 − PREF_AT_15` [20]. `INCOME_TAX = min(ORD_TAX + LTCG_RATE1 × PREF_AT_15 + LTCG_RATE2 × PREF_AT_20, bracket(TAXABLE_INCOME))` [25, the "smaller of" line]. `CG_TAX = INCOME_TAX − ORD_TAX`.

`bracket(z)`: 0 for `z ≤ 0`; otherwise scan i from 6 down to the first with `THR_i < z` and return `BASE_i + (z − THR_i) × RATE_i`.

Step 7, Form 8960. `NII = max(0, INTEREST + ORD_DIV + RENTAL + NII_OTHER + capInAgi)` (wages, pensions, retirement-account distributions, Social Security and tax-exempt interest are not investment income). `NIIT = NIIT_RATE × min(NII, max(0, AGI − NIIT_THRESHOLD))`.

Step 8, additional taxes. `PEN10 = PEN_EARLY_RATE × PEN10_BASE`; `PEN20 = PEN_HSA_RATE × PEN20_BASE`.

Step 9. `TOTAL = INCOME_TAX + NIIT + PEN10 + PEN20`.

Step 10, marginal and headroom outputs. `BRACKET_INDEX` = the largest i with `THR_i ≤ ORD_TAXABLE`; `BRACKET_RATE = 0` when `UNUSED_DEDUCTION > 0`, else `RATE_i`; `ROOM_IN_BRACKET = THR_{i+1} − ORD_TAXABLE` (dollars of ordinary taxable income to the next bound, `+Infinity` in the top bracket; a bracket-filling caller adds `UNUSED_DEDUCTION`); `ROOM_IN_LTCG0 = max(0, LTCG0 − TAXABLE_INCOME)`; `LTCG_NEXT_RATE` = 0 when `TAXABLE_INCOME < LTCG0`, `LTCG_RATE1` when `< LTCG15`, else `LTCG_RATE2`; `MAGI_IRMAA = AGI + TAX_EXEMPT_INTEREST`; `MAGI_ACA = MAGI_IRMAA + (SS_GROSS − TAXABLE_SS)`.

Worked example (test C6): married, both 68, tax year 2026. Social Security 48,000; pension 20,000; pre-tax withdrawal 40,000; interest 3,000; ordinary dividends 8,000 of which 6,000 qualified; long-term gain 12,000.

- Step 1: `net` 12,000; `prefGain` 12,000.
- Step 2: `other` = 20,000 + 3,000 + 8,000 + 40,000 + 12,000 = 83,000.
- Step 3: `PROVISIONAL` = 83,000 + 24,000 = 107,000. `tier1 = min(24,000, 0.5 × 75,000, 0.5 × 12,000) = 6,000`. `0.85 × (107,000 − 44,000) + 6,000 = 59,550`; the cap is `0.85 × 48,000 = 40,800`; `TAXABLE_SS` 40,800.
- Step 4: AGI = 83,000 + 40,800 = 123,800.
- Step 5: standard 32,200 + 2 × 1,650 = 35,500; senior 2 × 6,000 = 12,000 (AGI below 150,000); taxable income 76,300.
- Step 6: `PREF_INCOME` 18,000; `ORD_TAXABLE` 58,300; `ORD_TAX` = 2,480 + 12% × (58,300 − 24,800) = 6,500; `PREF_AT_0 = min(76,300, 98,900) − 58,300 = 18,000` (all preferential income at 0%); `INCOME_TAX` 6,500.
- Step 7: AGI below 250,000, NIIT 0. `TOTAL` 6,500.00. `MAGI_IRMAA` 123,800; `MAGI_ACA` 123,800 + 7,200 = 131,000; `BRACKET_RATE` 0.12; `ROOM_IN_BRACKET` 100,800 − 58,300 = 42,500; `ROOM_IN_LTCG0` 98,900 − 76,300 = 22,600. An extra 1,000 of pre-tax withdrawal costs 120.00 (benefits are already at the 85% cap).

`computeFederalTax(input, data?)` is the allocating wrapper for tests, the preview route and the tax detail drawer: it takes a year, a filing status, ages and cents, builds a one-year table from the data (with an optional index factor and rule set), calls `federalTaxInto` and returns named cents plus the worksheet lines.

### 3.4 Effective marginal rates and what a solver may rely on

`effectiveMarginalRates(t, o, x, scratchIn, scratchOut, out)` copies `x` into `scratchIn`, adds $100 to `TRAD_DIST` and recomputes, then (from the original again) adds $100 to `LT_GAIN`; `out[0]` and `out[1]` are `(Δ TOTAL) / 100` for each. Example (test C9b): single, 70, 2026, Social Security 60,000 and a pre-tax withdrawal of 55,000. An extra $100 of withdrawal adds $85 of taxable benefits and removes $11.10 of senior deduction, so taxable income rises $196.10 and tax rises $43.142: an effective 43.142% in the 22% bracket (22% × 1.85 × 1.06).

Properties (asserted in tests K1 to K3):

- `TOTAL` is continuous in every input.
- `TOTAL` is non-decreasing in each of `WAGES`, `PENSION`, `INTEREST`, `TAX_EXEMPT_INTEREST`, `ORD_DIV` (with `QUAL_DIV` fixed, and with both raised together), `ST_GAIN`, `LT_GAIN`, `TRAD_DIST`, `ROTH_CONV`, `ROTH_TAXABLE`, `HSA_TAXABLE`, `SS_GROSS`, `RENTAL`, `OTHER_ORD`, `NII_OTHER`, `PEN10_BASE`, `PEN20_BASE`; it is non-increasing in `QUAL_DIV` alone, `LOSS_CARRY_IN` and `ADJUSTMENTS`.
- The slope of `INCOME_TAX + NIIT` in `TRAD_DIST` never exceeded 0.5295 in a scan of 2026 single and joint households (0, 1 or 2 people over 65; Social Security 0 to 60,000; long-term gains 0 to 60,000; withdrawals 0 to 400,000 in steps of 1,000). The maximum is (12% + 15%) × 1.85 × 1.06: a dollar of withdrawal in the 12% bracket makes 85 cents of benefits taxable, pushes gains out of the 0% band and erodes the senior deduction. With the 10% additional tax the slope stays below 0.63, and for a non-qualified HSA withdrawal below 0.73. A gross-up may therefore treat `need(w) = spending + tax(w) − cashIn − w` as continuous and strictly decreasing in the withdrawal `w`; bisection or a secant iteration converges.

### 3.5 Performance

No function of sections 3.3 to 3.10 creates an object or an array; all state is in caller-owned typed arrays or scalars. `fillPathTables` writes `years × (2 × 48 + 24)` numbers per path into buffers each thread allocates once. One `federalTaxInto` call is about 60 floating-point operations and two scans of seven entries. With 10,000 paths, 60 years and about ten gross-up iterations that is 6,000,000 calls a run. A `vitest bench` file (`federalTax.bench.ts`, reported, never gating) measures calls a second and, under `--expose-gc`, that 100,000 calls leave the heap unchanged; the target is 1,000,000 calls in under 250 ms on one core. These are estimates, not measurements. Input validation (`assertTaxInput`: finite numbers, non-negative where the table of 2.8 says so, `QUAL_DIV ≤ ORD_DIV`, `N_AGED` in 0..2) runs in tests and in the preview route only, never in the loop.

### 3.6 Taxable accounts: income, sales, basis (`taxableAccount.ts`)

A taxable holding is one account of bucket `taxable` or `cash` as `value[6]` and `basis[6]` (2.8). Seeding from the frozen input: `value_c = balance × weight_c`; for a taxable account `basis_c = basisCents × weight_c` (the account's basis split by its class weights, so every class starts with the account's gain fraction; an unknown basis arrives as 0 with the resolver's `basis_unknown` warning); for a cash account `basis_c = value_c`. `drag` is the compiled `tax-drag.json` (six numbers per class) with the scenario's overrides.

1. **Income for the year**, `taxableYearIncome(value, basis, off, drag, cashReturn, out)`, on the values at the start of the year, before the year's flows. For each class c with value V and basis B: `interest = V × max(0, cashReturn + interestSpread_c)` when the class's `interest` is `cash_rate`, else 0, split into taxable and tax-exempt by `taxExemptShare_c`; `dividends = V × dividendYield_c`, of which `qualifiedShare_c` is qualified; `distribution = max(0, V − B) × gainDistributionRate_c` (long-term). Outputs: `INTEREST`, `TAX_EXEMPT_INTEREST`, `ORD_DIV`, `QUAL_DIV`, `LT_GAIN_DIST`, and the income of each class. The engine adds the first five to the year's tax inputs once, before the withdrawal solve.
2. **Deposit**, `depositTaxable(value, basis, off, weights, amount)`: `value_c += amount × weights_c` and `basis_c += amount × weights_c` (contributions, RMD surplus, capped-contribution overflow).
3. **Sale**, `sellTaxable(value, basis, off, amount)`: with `T = Σ value_c`, nothing is sold when `T ≤ 0`; otherwise `s = min(1, amount / T)`, the realized gain is `s × (T − Σ basis_c)` (negative when basis exceeds value), and every class gives up the share s of its value and of its basis. The gain goes to `LT_GAIN`.
4. **Reinvestment**, `reinvestTaxable(value, basis, off, income, startTotal)`, after the year's flows: `held = min(1, Σ value_c / startTotal)` (0 when `startTotal = 0`) and `basis_c += income_c × held`. Income is inside each class's total return, so value is not touched; the part of the income earned on money withdrawn during the year left with the withdrawal and adds no basis.
5. **Rebalancing**, `rebalanceTaxable(value, basis, off, target)`, after taxes: with `T = Σ value_c` and `d_c = value_c − T × target_c`, a class with `d_c > 0` sells `d_c`, realizing `d_c × (1 − basis_c / value_c)` and giving up `d_c × basis_c / value_c` of basis; a class with `d_c < 0` buys `−d_c`, adding it to value and basis. Returns the total realized gain.
6. **The lag.** The rebalancing gain is stored in `pendingLtcg` and added to the next plan year's `LT_GAIN`; that year's own rebalancing gain replaces it.
7. **Step-up at the first death**, `stepUpBasisAtDeath(value, basis, off, share)`: `basis_c += share × max(0, value_c − basis_c)`. `share` is `basisStepUp.ownAccount` for an account owned by the person who died, `jointAccount` for a joint account (`jointAccountCommunityProperty` when `household.state` is in the list), and the function is not called for the survivor's own accounts. A position held at a loss keeps its basis (8.3).
8. Returns are the engine's step: `value_c ×= 1 + return_c`.

Worked example (tests F1 to F6). A taxable account holds US stock 120,000 (basis 50,000), bonds 60,000 (basis 50,000) and cash 20,000 (basis 20,000): total 200,000, basis 120,000, target weights 60 / 30 / 10. The path's cash return is 3% this year.

- Income: dividends 120,000 × 0.013 = 1,560, of which 1,482 qualified; bond interest 60,000 × (0.03 + 0.01) = 2,400; cash interest 20,000 × 0.03 = 600; `INTEREST` 3,000, `ORD_DIV` 1,560, `QUAL_DIV` 1,482.
- A sale of 50,000: `s` = 0.25; gain 0.25 × (200,000 − 120,000) = 20,000. Afterwards US stock 90,000 (basis 37,500), bonds 45,000 (37,500), cash 15,000 (15,000).
- Reinvestment: `held` = 150,000 / 200,000 = 0.75; basis becomes 37,500 + 1,170 = 38,670; 37,500 + 1,800 = 39,300; 15,000 + 450 = 15,450.
- Rebalancing now trades nothing (a pro-rata sale keeps the weights). Returns of +10%, +2% and +3% give 99,000; 45,900; 15,450 (total 160,350). Cash basis equals cash value, as it must.
- Next year's rebalancing (no flows): targets 96,210; 48,105; 16,035. US stock sells 2,790 and realizes 2,790 × (1 − 38,670 / 99,000) = 1,700.21; its basis falls by 1,089.79 to 37,580.21; bonds buy 2,205 (basis 41,505) and cash buys 585 (basis 16,035). Total basis 95,120.21. A single value-and-basis pair for the account would have realized 2,790 × (1 − 93,420 / 160,350) = 1,164.54: the understatement this model removes.
- A first death with `share` 0.5 then raises basis to 66,895.10; 44,805.00 (bonds, 41,505 + 0.5 × 6,600); 16,035.00.

### 3.7 Additional taxes on early distributions (`penalties.ts`, `rothBasis.ts`)

3.7.1 The early fraction. `earlyFraction(thresholdIndex, periodStart, periodMonths) = clamp((thresholdIndex − periodStart) / periodMonths, 0, 1)`: the share of the period that lies before the month the owner reaches the age. `thresholdIndex = birthIndex + 714` for the 10% tax and `birthIndex + 780` for the HSA. Examples: born January 1967, 59½ falls in July 2026 (index 24,318): 1 for 2025, 0.5 for 2026, 0 for 2027. Born September 1967 (March 2027): 2/12 for 2027. In a first year of November and December 2026 (`periodStart` 24,322, 2 months): born June 1967 (59½ in December 2026) gives 0.5; born March 1967 gives 0.

3.7.2 Pre-tax accounts (Form 5329 Part I). `preTaxPenaltyBase(amount, earlyFrac, employerPlan, separatedAt55) = (employerPlan && separatedAt55) ? 0 : amount × earlyFrac`. `employerPlan` is true for an account of type `401k`. `separatedAt55 = retirementYear ≥ birthYear + 55 && year ≥ retirementYear`, where `retirementYear` is the year of the owner's `retirementMonth` (Form 5329 exception 01: separation from service in or after the year the owner reaches 55; never for an IRA). RMDs and Roth conversions never enter the base.

3.7.3 Roth accounts (Publication 590-B, "Ordering Rules for Distributions"). State per person: the `RB` record of 2.8, covering all of that person's Roth accounts together.

- Seeding at the plan start: `BASIS_FREE` = the sum of `rothContributionBasisCents` over the person's Roth accounts (an absent value counts 0 and sets the person's `basisUnknown` flag); the five layers 0; `FIRST_YEAR = startYear − 5` when the person has a Roth account that is not synthetic and has a balance (the clock is assumed already met for an existing account, 8.3), else 0.
- `rothRollYear(st, off)` at the start of every plan year after the first: `BASIS_FREE += CONV0`, the layers shift down by one, `CONV4 = 0`. A conversion made in year Y therefore joins `BASIS_FREE` on 1 January of Y + 5.
- `addRothContribution(st, off, amount, year)`: `BASIS_FREE += amount`. `addRothConversion(st, off, amount, year)`: `CONV4 += amount`. Both set `FIRST_YEAR = year` when it is 0.
- `rothWithdraw(st, off, amount, earlyFrac, year, out)`: (1) `fromBasis = min(amount, BASIS_FREE)`, subtracted; (2) for the layers oldest first, `take = min(remaining, CONV_k)`, subtracted, summed into `fromConversions`; (3) `fromEarnings` = what remains. `fiveYearMet = FIRST_YEAR > 0 && year ≥ FIRST_YEAR + 5`. `taxable = fromEarnings × (fiveYearMet ? earlyFrac : 1)` (earnings are tax-free only in a qualified distribution: after 59½ and after the five-year period); `penaltyBase = (fromConversions + fromEarnings) × earlyFrac`. `out`: taxable (to `ROTH_TAXABLE`), penaltyBase (to `PEN10_BASE`), fromBasis, fromConversions, fromEarnings. When `basisUnknown` is set and `taxable + penaltyBase > 0`, the caller notes the withdrawal under `WN.ROTH_BASIS_UNKNOWN`.
- At a death the survivor's record absorbs the decedent's: the basis and each layer are added, and `FIRST_YEAR` becomes the smaller non-zero one.
- Example (test E4): age 50 all of 2030 (`earlyFrac` 1); regular contributions 30,000; conversions of 20,000 in 2024 and 15,000 in 2028; clock met. In 2030 the 2024 conversion has been in `BASIS_FREE` since 1 January 2029 (50,000) and the 2028 conversion is `CONV2`. A withdrawal of 70,000 takes 50,000 from basis, 15,000 from the 2028 conversion and 5,000 of earnings: taxable 5,000, penalty base 20,000, additional tax 2,000.

3.7.4 HSA (Publication 969, Form 8889). `hsaWithdraw(amount, qualifiedMedical, earlyFrac65, out)`: `taxable = max(0, amount − qualifiedMedical)` (to `HSA_TAXABLE`); `penaltyBase = taxable × earlyFrac65` (to `PEN20_BASE`).

### 3.8 Required minimum distributions (`rmd.ts`)

- `rmdStartAge(birthYear)`: 72 when `birthYear ≤ 1950`, 73 for 1951 to 1959, 75 for 1960 and later.
- `rmdDivisor(age, spouseAge)`: when `spouseAge ≥ 0` (a living spouse) and `age − spouseAge > 10`, Table II at `(min(age, 120), clamp(spouseAge, 20, 120))`; otherwise Table III at `clamp(age, 72, 120)`. Ages are those attained in the year.
- `requiredMinimumDistribution(priorYearEndBalance, age, startAge, spouseAge)` = 0 when `age < startAge` or the balance is not positive, else `priorYearEndBalance / rmdDivisor(age, spouseAge)`, unrounded.

Rules the loop follows:

1. The balance is the owner's total pre-tax balance on the previous 31 December (IRAs aggregate by rule; each 401(k) uses the same divisor, so the total is the same). In plan year 0 the opening balance stands in for it and the amount is `f ×` the full-year figure.
2. The RMD is withdrawn first (L6), pro rata across the owner's pre-tax accounts, and is `TRAD_DIST`. A scheduled conversion is taken from what remains. An RMD is never penalized.
3. The first RMD is taken in the year the owner reaches the start age.
4. Year of death: the RMD is taken as usual (deaths take effect at the year end). From the next year the survivor owns the balance (decision 24): the survivor's birth year sets the start age and the divisor, and there is no spouse for Table II.
5. Roth accounts and HSAs have no lifetime RMD.
6. Surplus: when the year's cash in (wages, pensions, Social Security, RMDs, other income) exceeds spending plus taxes, the surplus is deposited with `depositTaxable` in the plan's surplus account (section 9), raising value and basis by the same amount.

Examples. 500,000 at 75: 500,000 ÷ 24.6 = 20,325.20. Publication 590-B's own example: 100,000 at 75 gives 4,065.04 (the publication prints $4,065); with a spouse aged 64 the divisor is 25.3 and the RMD 3,952.57 (the publication prints $3,953). Reinvestment (test G7): single, 80, tax year 2026, pre-tax balance 1,000,000 on 1 January, Social Security 36,000, spending 55,000. RMD 1,000,000 ÷ 20.2 = 49,504.95. `PROVISIONAL` = 49,504.95 + 18,000 = 67,504.95; `tier1` = 4,500; `0.85 × 33,504.95 + 4,500 = 32,979.21`, capped at 30,600; AGI 80,104.95; standard 16,100 + 2,050 = 18,150; senior 6,000 − 0.06 × 5,104.95 = 5,693.70; taxable income 56,261.25; tax 5,800 + 0.22 × 5,861.25 = 7,089.47. Surplus 36,000 + 49,504.95 − 7,089.47 − 55,000 = 23,415.48, deposited at basis 23,415.48.

### 3.9 Social Security benefits (`socialSecurity.ts`)

3.9.1 Inputs. Per person, from the frozen input's `socialSecurity.people` entry and `household.people`: `mode` (`none`, `estimate`, `receiving`), `birthYear`, `birthMonth`, and for `estimate` the benefit at full retirement age `monthlyAtFra` (dollars a month, as of `asOfYear`) and `claimAgeMonths` (744 to 840); for `receiving` the current benefit `monthly` (as of `asOfYear`), the month it started and optionally `monthlyAtFra`. Household switches `spousal` and `survivor`. A person with mode `none` receives nothing and leaves nothing to a survivor; a spouse with no earnings record is an `estimate` with amount 0 and a claim age (inputs-and-data R7).

3.9.2 Full retirement age. `fraMonths(birthYear)` from 2.4: 66 years for 1943 to 1954, then 2 more months a year to 66 years 10 months for 1959, 67 for 1960 and later. `survivorFraMonths(birthYear) = fraMonths(birthYear − 2)`.

3.9.3 Factors, all exact rationals converted to float64 once.

- `retirementFactor(claimMonths, fra)` with `claimMonths` clamped to [744, 840]: when early, `m = fra − claimMonths` and the factor is `1 − (min(m, 36) × 5/900 + max(0, m − 36) × 5/1200)`; otherwise `1 + (claimMonths − fra) / 150`. For full retirement age 67: 62 gives 7/10, 63 gives 3/4, 64 gives 4/5, 65 gives 13/15, 66 gives 14/15, 67 gives 1, 68 gives 27/25, 69 gives 29/25, 70 gives 31/25.
- `spousalFactor(ageMonths, fra)`: with `e = max(0, fra − ageMonths)`, `1 − (min(e, 36) × 25/3600 + max(0, e − 36) × 5/1200)`; no delayed credits. For 67: 62 gives 13/20, 63 gives 7/10, 64 gives 3/4, 65 gives 5/6, 66 gives 11/12.
- `survivorFactor(ageMonths, survivorFra) = 1 − (285/1000) × max(0, survivorFra − ageMonths) / (survivorFra − 720)`: 143/200 at 60, 1 at survivor full retirement age.
- `floorDime(z) = floor(z × 10 + 1e-9) / 10`; `floorDollar(z) = floor(z + 1e-9)`.

3.9.4 Compile, once per scenario: `compileSsPlan(people, { spousal, survivor, startYear }, data)` gives per person `birthIndex`, `fra`, `survivorFra`, `fraIndex = birthIndex + fra`, and

- `estimate`: `claimAge = claimAgeMonths`, `claimIndex = birthIndex + claimAge`, `piaBase = monthlyAtFra`;
- `receiving`: `claimIndex` = the month index of `startedMonth`, `claimAge = clamp(claimIndex − birthIndex, 744, 840)`, `piaBase = monthlyAtFra` when given, else `monthly / retirementFactor(claimAge, fra)`;
- `none`: `claimIndex = +Infinity`, `piaBase = 0`;
- `claimYear = floor(claimIndex / 12)`, `totalCreditMonths = max(0, claimAge − fra)`;
- `piaAtStart`: `piaBase` carried from `asOfYear` to `startYear`: for each year y from `asOfYear + 1` through `startYear`, `pia = floorDime(pia × (1 + cola(y)))`, with `cola(y)` from `colaHistory` or the year files (`staleInflation` rounded to 0.1% for a year after the last published one). An `asOfYear` before 2016 is treated as 2016 with the compile warning `ss_statement_old`; one after `startYear` is treated as `startYear`.

3.9.5 State. `resetSsState(plan, st)` at the start of each path: `PIA_i = piaAtStart_i`, `ARF_MONTHS_i = 0`, the three factors −1.

3.9.6 COLA (`fillPathTables` writes `PR.COLA` for every plan year). For `Y ≤ L` it is the published value. For `Y > L`, with `P_L = 1`, `H = 1` and `P_Y = P_{Y−1} × (1 + π(Y − 1))`: `raw = P_Y / H − 1`; `cola_Y = max(0, floor(raw × 1000 + 0.5) / 1000)`; when `cola_Y > 0`, `H = P_Y`. After a year without an adjustment the next one is therefore measured from the last level that produced one. Example (test H9): a PIA of 2,000.00 as of 2026 becomes 2,072.00 in 2027 (published 3.6%). Path inflation 2.44% in 2027 gives a 2028 COLA of 2.4%: 2,121.728, truncated to 2,121.70. Inflation −1.0% in 2028: no COLA for 2029. Inflation +2.0% in 2029: the level is 1.0244 × 0.99 × 1.02 = 1.03443912 against the high-water 1.0244, a rise of 0.98%, COLA 1.0% for 2030: 2,142.917, truncated to 2,142.90.

3.9.7 The payment of person i for month index m (`monthlyPayment`), with partner j, in calendar year Y:

1. Own benefit, when `m ≥ claimIndex_i`. An early claimer's factor is `retirementFactor(min(fra_i, claimAge_i + (m ≥ fraIndex_i ? ARF_MONTHS_i : 0)), fra_i)`. Otherwise the credits in pay are `totalCreditMonths_i` when `claimAge_i = 840` or `Y > claimYear_i`, else `clamp(12 × claimYear_i − fraIndex_i, 0, totalCreditMonths_i)` (the credits earned before the claim year; the rest arrive in January), and the factor is `1 + credits / 150`. `own = floorDime(PIA_i × factor)`.
2. Spousal excess, when `spousal` is on, neither person's mode is `none`, j is alive (`Y ≤ deathYear_j`) and `m ≥ spousalStart = max(claimIndex_i, claimIndex_j)`. The first time, `SPOUSAL_FACTOR_i = spousalFactor(spousalStart − birthIndex_i, fra_i)`. `excess = max(0, 0.5 × PIA_j − PIA_i × max(1, factor_i))`; `sp = floorDime(excess × SPOUSAL_FACTOR_i)`.
3. Widow(er)'s benefit, when `survivor` is on, neither mode is `none`, j has died (`Y > deathYear_j`) and `m ≥ survivorStart = max(12 × (deathYear_j + 1), birthIndex_i + 720)`. The first time, `SURVIVOR_FACTOR_i = survivorFactor(survivorStart − birthIndex_i, survivorFra_i)`. With `d = DECEASED_FACTOR_j`: `w = PIA_j × max(1, d) × SURVIVOR_FACTOR_i`, and when `d < 1`, `w = min(w, max(PIA_j × d, 0.825 × PIA_j))`. `wib = floorDime(w)`.
4. Payment = `floorDollar(max(own + sp, wib))`.

`DECEASED_FACTOR_j` is fixed the first time a year after j's death is computed: if j had claimed, the factor in pay in the December of death (all credits counted, the earnings-test months credited if j was past full retirement age); if j had not claimed, 1 when `12 × (deathYear_j + 1) ≤ fraIndex_j`, else `1 + min(840 − fra_j, 12 × (deathYear_j + 1) − fraIndex_j) / 150`. The deceased's PIA keeps receiving COLAs.

3.9.8 The year, `socialSecurityYear(plan, st, year, periodStart, periodMonths, prog, progOff, deathYear0, deathYear1, wages0, wages1, out)`:

1. When `year > startYear` and the period starts in January, each PIA (of the living and the dead) becomes `floorDime(PIA × (1 + PR.COLA))`: once per calendar year, whatever the step length.
2. For each living person i (`year ≤ deathYear_i`):
   a. `sPre` = the sum of the payments for the months of the period before `fraIndex_i`; `nPre` = how many of them were positive.
   b. Earnings test, when `sPre > 0` and `wages_i > 0`, with `f = periodMonths / 12`. Before the year of `fraIndex_i`: `over = wages_i − PR.ET_UNDER × f`, divisor 2. In that year: `over = wages_i × (months of the period before fraIndex_i) / periodMonths − PR.ET_FRA × f`, divisor 3. `withheld = min(sPre, max(0, over) / divisor)`; when positive, `ARF_MONTHS_i += min(nPre, ceil(withheld / (sPre / nPre) − 1e-9))`.
   c. `sPost` = the sum of the payments for the months of the period from `fraIndex_i` on (computed after b, so the months credited back already raise the factor).
   d. `benefit_i = (sPre − withheld + sPost) × PR.SS_SCALE`.
3. `out`: the two benefits (the engine sums them into `SS_GROSS`), the spousal and survivor parts, the amounts withheld and the months paid, all scaled.

Shortcut the implementation may take: when no start index (`claimIndex`, the spousal start, the survivor start, `fraIndex`) and no January credit step lies inside the period, every month pays the same, so one evaluation times the month count equals the loop (asserted by test H16). The month loop is also what a monthly engine would call.

Worked examples. Spousal (test H7a): worker PIA 2,400, spouse PIA 600, both with full retirement age 67, both in pay when the spouse is 62: own 600 × 7/10 = 420.00; excess 1,200 − 600 = 600; spousal factor 13/20; 390.00; payment $810. January rule (test H6): born July 1960, claim at 68 (July 2028), PIA 2,000, no COLA: 12 credits, of which 6 were earned before 2028; 2028 pays 6 × $2,080 = 12,480 and 2029 pays 12 × $2,160 = 25,920. Earnings test (test H10a): PIA 2,000 claimed at 62 ($1,400 a month), wages 40,000 in 2026 at age 63: (40,000 − 24,480) ÷ 2 = 7,760 withheld of 16,800; 6 months credited; at full retirement age the factor becomes that of a claim at 62 years 6 months, 29/40, and the payment $1,450.

3.9.9 Preview (allocating, for the input form): `socialSecurityPreview(people, startYear, data)` returns per person the full retirement age, `piaAtStart`, and for each whole claim age 62 to 70 the factor, the monthly benefit `floorDime(piaAtStart × factor)` and the spousal excess the partner's record would add (the partner at the entered claim age), plus the widow(er)'s benefit at survivor full retirement age.

### 3.10 Contribution limits and payroll tax (`contributionLimits.ts`, `payroll.ts`)

On the program table (`p`, offset `o`), ages attained by year end:

- `employeeDeferralLimit(p, o, age) = DEFERRAL + (60 ≤ age ≤ 63 ? CATCHUP6063 : age ≥ 50 ? CATCHUP50 : 0)`, shared by all of one owner's accounts of type `401k`, pre-tax and Roth.
- `annualAdditionsLimit(p, o) = ANNUAL_ADD` (employee plus employer, catch-up excluded).
- `iraLimit(p, o, age) = IRA + (age ≥ 50 ? IRA_CATCHUP : 0)`, shared by the owner's accounts of type `ira` and `roth`; the caller also caps it at the household's wages of the year.
- `hsaLimit(p, o, age, family, monthsBefore65) = ((family ? HSA_FAMILY : HSA_SELF) + (age ≥ 55 ? HSA_CATCHUP : 0)) × monthsBefore65 / 12`, with `monthsBefore65 = clamp(birthIndex + 780 − 12 × year, 0, 12)` (no contributions once on Medicare). The plan does not know the coverage tier, so the engine passes `family = true` (the resolver's `hsa_family` kind).
- In plan year 0 every limit is multiplied by f.
- `contributionLimit(year, age, kind)` (allocating, for the resolver's `contribution_over_limit` warning): the same formulas on the published year file, in cents; `employer_plan` is the deferral limit, `ira` the IRA limit, `hsa_family` the family HSA limit with the age-55 catch-up and no proration; `null` for a year before 2026 or after the last published year. 2026 at age 51: `3250000n`; at 61: `3575000n`; `ira` at 50: `860000n`; `hsa_family` at 55: `975000n`.

`employeePayrollTax(p, o, wages0, wages1, status) = OASDI_RATE × (min(wages0, WAGE_BASE) + min(wages1, WAGE_BASE)) + MEDICARE_RATE × (wages0 + wages1) + ADDL_MEDICARE_RATE × max(0, wages0 + wages1 − threshold(status))`, on gross wages before deferrals; in plan year 0 the caller passes `wages / f` and multiplies the result by f. Example (test I1): single, 2026, wages 250,000: 6.2% × 184,500 = 11,439.00; 1.45% × 250,000 = 3,625.00; 0.9% × 50,000 = 450.00; total 15,514.00.

### 3.11 Run warnings (`warnings.ts`)

Compile warnings (from `compileTaxLaw` and `compileSsPlan`, the same on every path): `tax_data_stale` (the plan starts after the last published tax year), `limits_pending` (a year file's pending limit was read; the message names the year and the fields), `rmd_joint_table_unavailable`, `ss_statement_old`.

Path warnings: each path owns `Float64Array(8)` and calls `noteWarning(wn, slot, amount)` = `wn[slot] = max(wn[slot], amount)`. Slots: 0 `SS_EARNINGS_TEST` (the largest amount withheld in one year), 1 `EARLY_PENALTY` (the largest `PEN10 + PEN20` of one year), 2 `ROTH_BASIS_UNKNOWN` (the largest non-qualified Roth withdrawal of a person whose Roth basis was not entered), 3 `CONTRIBUTION_CAPPED` (the largest amount cut by a limit in one year), 4 `CASH_SERIES_MISSING` (1 when `fallbackCashYield` was used), 5 to 7 reserved. The thread harness merges paths by taking, per slot, the largest amount and the number of paths with a positive value. `warningMessages(compileWarnings, merged, paths)` returns the `{ code, message }` list for the run (codes `ss_earnings_test`, `early_withdrawal_penalty`, `roth_basis_unknown`, `contribution_capped`, `cash_series_missing` and the compile codes), for example "The Social Security earnings test withholds up to $7,760 in a year on 10,000 of 10,000 paths; the months are credited back at full retirement age."

### 3.12 The sequence this area assumes inside one path

Once per path: `fillPathTables`, `resetSsState`, seed the Roth records and the taxable holdings. Each plan year:

1. `rothRollYear` for each person (not in year 0).
2. `socialSecurityYear`; the RMD of each owner from the prior year-end balance; `taxableYearIncome` of every taxable and cash holding; last year's `pendingLtcg`; these fill the fixed part of the tax inputs with wages, pensions and the other income streams.
3. Contributions, capped by 3.10 (`addRothContribution`, `depositTaxable`).
4. The withdrawal solve (strategies area): candidate withdrawals are priced with `sellTaxable`, `preTaxPenaltyBase`, `rothWithdraw`, `hsaWithdraw` on scratch state, then `federalTaxInto`, until spending plus tax is funded; a scheduled conversion calls `addRothConversion` and adds to `ROTH_CONV`.
5. Apply the solved flows to the real state; `employeePayrollTax`; deposit any surplus; carry `LOSS_CARRY_OUT`; store `MAGI_IRMAA`.
6. `reinvestTaxable`, then `rebalanceTaxable` into `pendingLtcg`; then the engine applies returns.
7. At the end of a year in which someone died: `stepUpBasisAtDeath` on the taxable holdings, the balances and the Roth record move to the survivor, and the filing status is single from the next year.

## 4. Contracts

### 4.1 Pure function signatures (exported from `@meridian/retirement`)

```ts
// taxData.ts
export class TaxDataError extends Error { readonly code: "tax_data_invalid" | "unknown_rule_set" | "law_change_invalid" }
export function loadTaxData(): TaxData;                        // the bundled JSON, parsed, validated, frozen
export function validateTaxData(raw: RawTaxData): TaxData;     // throws TaxDataError("tax_data_invalid")

// compile.ts
export interface CompiledTaxLaw {
  readonly startYear: number; readonly years: number; readonly lastPublishedYear: number;
  readonly dataVersion: string; readonly ruleSetId: string;
  readonly taxBase: Float64Array; readonly taxStep: Float64Array; readonly taxMode: Uint8Array;      // years x 2 x TAX_REC
  readonly progBase: Float64Array; readonly progStep: Float64Array; readonly progMode: Uint8Array;   // years x PROG_REC
  readonly frozen: Uint8Array;                                                                       // 1 = freezeIndexing covers the year
  readonly staleInflation: number;
  readonly warnings: ReadonlyArray<{ code: string; message: string }>;
}
export function compileTaxLaw(data: TaxData, o: { startYear: number; years: number; ruleSetId: string;
  ssAdjustment?: { fromYear: number; factor: number } }): CompiledTaxLaw;
export function fillPathTables(law: CompiledTaxLaw, indexInflation: Float64Array,
  o: { chainedCpiWedge: number; realWageGrowth: number }, outTax: Float64Array, outProg: Float64Array): void;
export function taxOffset(yearIndex: number, status: 0 | 1): number;
export function progOffset(yearIndex: number): number;
export function compileTaxDrag(data: TaxData, overrides?: TaxSettings["taxDrag"]): Float64Array;    // 6 classes x 6 numbers

// federalTax.ts
export function federalTaxInto(t: Float64Array, o: number, x: Float64Array, r: Float64Array): number;   // returns r[TO.TOTAL]
export function effectiveMarginalRates(t: Float64Array, o: number, x: Float64Array,
  scratchIn: Float64Array, scratchOut: Float64Array, out: Float64Array): void;                         // out[0] ordinary, out[1] long-term gain
export function assertTaxInput(x: Float64Array): void;                                                  // tests and previews only
export function computeFederalTax(input: FederalTaxInput, data?: TaxData): FederalTaxResult;            // allocating; cents at the boundary
export function taxYearDetail(x: Float64Array, r: Float64Array, status: 0 | 1, payrollTax: number): TaxYearDetail;  // for the year table

// taxableAccount.ts
export function taxableYearIncome(value: Float64Array, basis: Float64Array, off: number, drag: Float64Array, cashReturn: number, out: Float64Array): void;
export function depositTaxable(value: Float64Array, basis: Float64Array, off: number, weights: Float64Array, amount: number): void;
export function sellTaxable(value: Float64Array, basis: Float64Array, off: number, amount: number): number;        // realized gain
export function reinvestTaxable(value: Float64Array, basis: Float64Array, off: number, income: Float64Array, startTotal: number): void;
export function rebalanceTaxable(value: Float64Array, basis: Float64Array, off: number, target: Float64Array): number;  // realized gain
export function stepUpBasisAtDeath(value: Float64Array, basis: Float64Array, off: number, share: number): void;

// penalties.ts, rothBasis.ts
export function earlyFraction(thresholdIndex: number, periodStart: number, periodMonths: number): number;
export function preTaxPenaltyBase(amount: number, earlyFrac: number, employerPlan: boolean, separatedAt55: boolean): number;
export function hsaWithdraw(amount: number, qualifiedMedical: number, earlyFrac65: number, out: Float64Array): void;   // [taxable, penaltyBase]
export function rothRollYear(st: Float64Array, off: number): void;
export function addRothContribution(st: Float64Array, off: number, amount: number, year: number): void;
export function addRothConversion(st: Float64Array, off: number, amount: number, year: number): void;
export function rothWithdraw(st: Float64Array, off: number, amount: number, earlyFrac: number, year: number, out: Float64Array): void;
                                                               // out: taxable, penaltyBase, fromBasis, fromConversions, fromEarnings
export function mergeRothAtDeath(st: Float64Array, survivorOff: number, deceasedOff: number): void;

// rmd.ts
export function rmdStartAge(birthYear: number): 72 | 73 | 75;
export function rmdDivisor(age: number, spouseAge: number): number;        // spouseAge -1 = no living spouse
export function requiredMinimumDistribution(priorYearEndBalance: number, age: number, startAge: number, spouseAge: number): number;

// socialSecurity.ts
export function fraMonths(birthYear: number): number;
export function survivorFraMonths(birthYear: number): number;
export function retirementFactor(claimMonths: number, fra: number): number;
export function spousalFactor(ageMonths: number, fra: number): number;
export function survivorFactor(ageMonths: number, survivorFra: number): number;
export interface SsPersonInput { mode: "none" | "estimate" | "receiving"; birthYear: number; birthMonth: number;
  monthlyAtFra?: number; monthly?: number; asOfYear?: number;             // dollars a month
  claimAgeMonths?: number;                                                // estimate
  startedIndex?: number }                                                 // receiving: monthIndex of startedMonth
export interface SsPerson { readonly mode: "none" | "estimate" | "receiving"; readonly birthIndex: number; readonly fra: number;
  readonly survivorFra: number; readonly fraIndex: number; readonly claimAge: number; readonly claimIndex: number;
  readonly claimYear: number; readonly totalCreditMonths: number; readonly piaAtStart: number }
export interface SsPlan { readonly people: readonly SsPerson[]; readonly spousal: boolean; readonly survivor: boolean;
  readonly startYear: number; readonly warnings: ReadonlyArray<{ code: string; message: string }> }
export function compileSsPlan(people: readonly SsPersonInput[],
  o: { spousal: boolean; survivor: boolean; startYear: number }, data?: TaxData): SsPlan;
export function resetSsState(plan: SsPlan, st: Float64Array): void;
export function monthlyPayment(plan: SsPlan, st: Float64Array, person: 0 | 1, monthIndex: number,
  deathYear0: number, deathYear1: number): number;                        // dollars; also fixes the factors of 3.9.7
export function socialSecurityYear(plan: SsPlan, st: Float64Array, year: number, periodStart: number, periodMonths: number,
  prog: Float64Array, progOff: number, deathYear0: number, deathYear1: number, wages0: number, wages1: number, out: Float64Array): void;
export function socialSecurityPreview(people: readonly SsPersonInput[], startYear: number, data?: TaxData): SsPreview;   // allocating

// contributionLimits.ts, payroll.ts
export function employeeDeferralLimit(p: Float64Array, o: number, age: number): number;
export function annualAdditionsLimit(p: Float64Array, o: number): number;
export function iraLimit(p: Float64Array, o: number, age: number): number;
export function hsaLimit(p: Float64Array, o: number, age: number, family: boolean, monthsBefore65: number): number;
export function employeePayrollTax(p: Float64Array, o: number, wages0: number, wages1: number, status: 0 | 1): number;

// warnings.ts
export function noteWarning(wn: Float64Array, slot: number, amount: number): void;
export function warningMessages(compile: ReadonlyArray<{ code: string; message: string }>,
  merged: { amount: Float64Array; paths: Uint32Array }, totalPaths: number): Array<{ code: string; message: string }>;

// rulesView.ts (what inputs-and-data and the API consume)
export const TAX_DATA_FIRST_YEAR = 2026;
export function listTaxRuleSets(): Array<{ id: string; label: string }>;
export function fullRetirementAgeTable(): Array<{ fromBirthYear: number; toBirthYear: number | null; years: number; months: number }>;
export function contributionLimit(year: number, age: number, kind: "employer_plan" | "ira" | "hsa_family"): bigint | null;   // cents
export function buildRulesView(today: IsoDate): RetirementRulesView;
export function federalTaxPreview(req: FederalTaxPreviewRequest): FederalTaxPreviewResponse;           // throws TaxDataError
export function socialSecurityPreviewView(req: SocialSecurityPreviewRequest): SocialSecurityPreviewResponse;
export const NOT_MODELLED: ReadonlyArray<{ id: string; label: string; effect: string }>;
```

A person who does not die in the plan is passed as `deathYear = +Infinity`. `RawTaxData` is the eight imported JSON modules as `unknown`. `FederalTaxInput` has the fields of `FederalTaxPreviewRequest` (4.3) with `bigint` cents and a numeric `indexFactor`; `FederalTaxResult` has the fields of `FederalTaxPreviewResponse` with `bigint` cents; `SsPreview` has the fields of `SocialSecurityPreviewResponse` in dollars and exact factors. `IsoDate` is shared's. `fullRetirementAgeTable()` starts at `fromBirthYear: 1900` (the lowest year the profile accepts) and ends with `{ fromBirthYear: 1960, toBirthYear: null, years: 67, months: 0 }`.

### 4.2 Data-file schemas

`taxData.ts` holds one Zod schema per file, field for field as in section 2: `FederalYearRecord` (imported from shared, 4.3, because the rules view serves it), `TaxRulesFile` (with `LawChangeOp` as a `z.discriminatedUnion("op", …)` over the five operations and `path: z.enum(LAW_PATHS)`), `SocialSecurityRulesFile`, `UniformLifetimeFile`, `JointLifeFile`, `TaxDragFile`, `Manifest`. `TaxData` is the validated bundle `{ dataVersion, firstTaxYear, lastPublishedYear, years: Map<number, FederalYearRecord>, rules, ss, uniform, joint, drag, sources }`.

### 4.3 Wire shapes (`packages/shared/src/retirement/tax.ts`)

Request bodies use the bounded inputs (`NonNegCentsInput`, `CentsInput`), because the API refuses to register a route whose request contract uses the loose shapes; responses use `CentsString` (already signed) and `NonNegCentsString`. There is no `SignedCentsString` in `wire.ts`; both source designs used one.

```ts
export const TaxFilingStatus = z.enum(["single", "married_joint"]);
const RuleSetId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/** The year file as data and as a response (2.2). */
const PerStatus = z.object({ single: z.number().nonnegative(), mfj: z.number().nonnegative() }).strict();
const Source = z.object({ title: z.string().min(1), url: z.string().url(), retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), section: z.string().optional(), note: z.string().optional() }).strict();
export const FederalYearRecord = z.object({
  schemaVersion: z.literal(1), taxYear: z.number().int().min(2026),
  ordinary: z.object({ rates: z.array(z.number().min(0).max(1)).length(7),
    thresholds: z.object({ single: z.array(z.number().nonnegative()).length(7), mfj: z.array(z.number().nonnegative()).length(7) }).strict() }).strict(),
  standardDeduction: PerStatus, additionalAged: PerStatus,
  seniorDeduction: z.object({ amountPerPerson: z.number().nonnegative(), minAge: z.number().int(), phaseoutRate: z.number().min(0).max(1), phaseoutStart: PerStatus }).strict(),
  capitalGains: z.object({ rates: z.array(z.number().min(0).max(1)).length(3), zeroRateMax: PerStatus, fifteenRateMax: PerStatus, netLossLimit: z.number().nonnegative() }).strict(),
  niit: z.object({ rate: z.number().min(0).max(1), threshold: PerStatus }).strict(),
  socialSecurityTaxation: z.object({ base1: PerStatus, base2: PerStatus, rate1: z.number(), rate2: z.number(), maxShare: z.number() }).strict(),
  additionalTaxes: z.object({ earlyDistributionRate: z.number(), hsaNonQualifiedRate: z.number() }).strict(),
  contributionLimits: z.object({ employeeDeferral: z.number(), catchUp50: z.number(), catchUp60to63: z.number(), annualAdditions: z.number(),
    ira: z.number(), iraCatchUp50: z.number(), hsaSelf: z.number(), hsaFamily: z.number(), hsaCatchUp55: z.number(),
    pending: z.array(z.enum(["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50", "hsaSelf", "hsaFamily"])) }).strict(),
  payroll: z.object({ oasdiRate: z.number(), oasdiWageBase: z.number(), medicareRate: z.number(), additionalMedicareRate: z.number(), additionalMedicareThreshold: PerStatus }).strict(),
  socialSecurity: z.object({ cola: z.number().min(0).max(0.2), earningsTestUnderFra: z.number(), earningsTestFraYear: z.number() }).strict(),
  sources: z.array(Source).min(1),
}).strict();

/** Scenario-level tax assumptions: the inner shape this area asks the run-settings envelope to carry as `tax` (section 9). No floats, no nulls. */
export const TaxDragOverride = z.object({ dividendYieldBp: bp(0, 1500).optional(), qualifiedShareBp: bp().optional(),
  interestSpreadBp: bp(0, 1000).optional(), taxExemptShareBp: bp().optional(), gainDistributionRateBp: bp(0, 2000).optional() }).strict();
export const TaxSettings = z.object({
  chainedCpiWedgeBp: bp(0, 100).default(0),            // basis points a year taken off the bracket index (decision 6)
  realWageGrowthBp: bp(0, 300).default(0),             // wage base and earnings-test amounts grow this much faster than prices
  includePayrollTax: z.boolean().default(true),        // subtract employee payroll tax from wages
  capLossCarryInCents: PlanCents.default("0"),         // a capital loss carried into the plan's first year
  taxDrag: z.record(AssetClass, TaxDragOverride).default({}),
}).strict();
export const DEFAULT_TAX_SETTINGS: TaxSettings;          // TaxSettings.parse({})

/** One year of one path, for the year-by-year table (strategies-outputs-web embeds it in its row). Cents as strings, rates in basis points. */
export const TaxYearDetail = z.object({
  filingStatus: TaxFilingStatus,
  totalFederalCents: NonNegCentsString, incomeTaxCents: NonNegCentsString, ordinaryTaxCents: NonNegCentsString,
  capitalGainsTaxCents: NonNegCentsString, niitCents: NonNegCentsString, earlyPenaltyCents: NonNegCentsString, hsaPenaltyCents: NonNegCentsString,
  payrollTaxCents: NonNegCentsString,
  agiCents: CentsString, taxableIncomeCents: NonNegCentsString, ordinaryTaxableCents: NonNegCentsString,
  taxableSocialSecurityCents: NonNegCentsString, standardDeductionCents: NonNegCentsString, seniorDeductionCents: NonNegCentsString,
  gainsAt0Cents: NonNegCentsString, gainsAt15Cents: NonNegCentsString, gainsAt20Cents: NonNegCentsString,
  capitalLossCarryoverCents: NonNegCentsString, magiIrmaaCents: CentsString, magiAcaCents: CentsString,
  bracketRateBp: z.number().int(), nextGainRateBp: z.number().int(),
}).strict();

/** Read-only preview: one household-year through the tax function (the gate's comparison tool). */
const In = NonNegCentsInput.default("0");
export const FederalTaxPreviewRequest = z.object({
  year: z.number().int().min(2026).max(2150), filingStatus: TaxFilingStatus,
  ages: z.array(z.number().int().min(0).max(125)).min(1).max(2),          // attained by year end; one per filer
  indexFactorBp: z.number().int().min(2000).max(200000).default(10000),   // F x 10000, used only after the last published year
  ruleSetId: RuleSetId.default("current_law"),
  wagesCents: In, pensionCents: In, taxableInterestCents: In, taxExemptInterestCents: In,
  ordinaryDividendsCents: In, qualifiedDividendsCents: In,
  shortTermGainCents: CentsInput.default("0"), longTermGainCents: CentsInput.default("0"), lossCarryInCents: In,
  traditionalDistributionsCents: In, rothConversionsCents: In, rothTaxableEarningsCents: In, hsaTaxableCents: In,
  socialSecurityCents: In, rentalNetCents: In, otherOrdinaryCents: In, adjustmentsCents: In,
  penalty10BaseCents: In, penalty20BaseCents: In,
}).strict().refine((r) => r.ages.length === (r.filingStatus === "single" ? 1 : 2), "one age per filer");
export const FederalTaxPreviewResponse = z.object({
  dataVersion: z.string(), dataStatus: z.enum(["published", "indexed"]), detail: TaxYearDetail,
  provisionalIncomeCents: CentsString, unusedDeductionCents: NonNegCentsString,
  roomInBracketCents: NonNegCentsString.nullable(),                       // null in the top bracket
  roomAtZeroGainsCents: NonNegCentsString, lossUsedCents: NonNegCentsString,
  marginalOrdinaryRate: z.number(), marginalGainRate: z.number(),         // effective, by finite difference
  lines: z.array(z.object({ form: z.string(), line: z.string(), label: z.string(), cents: CentsString })),
});

/** Read-only preview: benefit by claiming age for the Social Security step of the form. */
export const SocialSecurityPreviewRequest = z.object({
  people: z.array(z.object({ birthYear: PlanYear, birthMonth: z.number().int().min(1).max(12),
    monthlyAtFraCents: NonNegCentsInput, asOfYear: PlanYear,
    claimAgeMonths: z.number().int().min(744).max(840) }).strict()).min(1).max(2),
  startYear: PlanYear,
}).strict();
export const SocialSecurityPreviewResponse = z.object({
  people: z.array(z.object({ fraMonths: z.number().int(), survivorFraMonths: z.number().int(), piaAtStartCents: NonNegCentsString,
    byClaimAge: z.array(z.object({ claimAgeMonths: z.number().int(), factorBp: z.number().int(),
      monthlyCents: NonNegCentsString, spousalMonthlyCents: NonNegCentsString })),          // 62..70 in whole years
    survivorMonthlyAtFraCents: NonNegCentsString })),
});

export const RetirementRulesView = z.object({
  dataVersion: z.string(), firstTaxYear: z.number().int(), lastPublishedYear: z.number().int(),
  stale: z.boolean(),                                                     // year(today) > lastPublishedYear
  pendingLimits: z.array(z.object({ year: z.number().int(), fields: z.array(z.string()) })),
  years: z.array(FederalYearRecord),
  ruleSets: z.array(z.object({ id: z.string(), label: z.string(), illustrative: z.boolean(),
    lawChanges: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), illustrative: z.boolean() })) })),
  indexing: z.array(z.object({ path: z.string(), index: z.enum(["cpi", "wage"]), round: z.enum(["floor_increase", "nearest"]) })),
  taxDrag: z.record(AssetClass, z.object({ dividendYieldBp: z.number().int(), qualifiedShareBp: z.number().int(),
    interestSpreadBp: z.number().int().nullable(), taxExemptShareBp: z.number().int(), gainDistributionRateBp: z.number().int() })),
  notModelled: z.array(z.object({ id: z.string(), label: z.string(), effect: z.string() })),
  sources: z.array(z.object({ file: z.string(), title: z.string(), url: z.string(), retrieved: z.string(), sha256: z.string().nullable() })),
  disclaimer: z.string(),
});
```

A rule set is `illustrative` when any of its law changes is. `interestSpreadBp` is null for a class that pays no interest.

### 4.4 Routes (added to `apps/api/src/routes/retirement.ts`, prefix `/api/retirement`, numbered after the 21 routes of inputs-and-data)

| # | Method and path | Role | Body or query | Response |
| --- | --- | --- | --- | --- |
| 22 | `GET /rules` | any | `today?` (through `resolveToday`) | `RetirementRulesView` |
| 23 | `POST /tax-preview` | any (`config.readOnly`) | `FederalTaxPreviewRequest` | `FederalTaxPreviewResponse` |
| 24 | `POST /social-security-preview` | any (`config.readOnly`) | `SocialSecurityPreviewRequest` | `SocialSecurityPreviewResponse` |

All three write nothing. Errors, all `{ error, code }` through `PlanError`: `400 validation` (Zod, including one age per filer); `400 unknown_rule_set`; `400 qualified_exceeds_ordinary` (qualified dividends above ordinary dividends); `400 today_out_of_range` as in Phase 2. The route handlers catch `TaxDataError` and rethrow `new PlanError(400, err.code, err.message)`.

## 5. UI (content this area specifies; the pages belong to strategies-outputs-web)

- **Rule set picker** (scenario settings): one radio per entry of `RetirementRulesView.ruleSets` with its label, the descriptions of its law changes, and the badge "illustrative" where set. `current_law` is preselected. A scenario whose stored id no longer exists resolves with the error `unknown_rule_set` (inputs-and-data R11); the picker shows the id struck through with "no longer available" until another is chosen.
- **Social Security step** (form step 4): beside the claim-age control, the table of `SocialSecurityPreviewResponse` (monthly payment at each age 62 to 70, the spousal excess, the widow(er)'s benefit at survivor full retirement age), fetched on change with a short debounce. Empty state: "Enter the benefit at full retirement age from your Social Security statement." Hint when the person claims before full retirement age and has wages planned after the claim: "While you work before full retirement age, part of the benefit is withheld and credited back later." Error state: the standard query error block with Retry.
- **Tax detail drawer** (a row of the year-by-year table): the row's `TaxYearDetail` as a two-column list in this order: filing status; AGI; taxable Social Security; standard deduction; senior deduction; taxable income; ordinary tax; capital gains tax; net investment income tax; early-withdrawal additional tax; HSA additional tax; total federal tax; payroll tax; bracket rate; rate on the next dollar of gain; gains taxed at 0%, 15%, 20%; capital loss carried forward. Zero lines are hidden except the total. The run's warnings (3.11) are notes above the table. Empty state for a row without detail: "No tax detail was stored for this year."
- **Rules and assumptions page** (under Retirement; `GET /rules`): the data version; each published year as a table with its sources as links, retrieval dates and checksums; the pending-limits note ("2027 retirement-plan limits are not published yet; the 2026 amounts are used"); the indexing rule in one sentence; the yield assumptions; the not-modelled list (label and effect). States: loading skeleton; `stale = true` shows "Tax tables end at 2027; later years are estimated from inflation. Update Meridian for newer tables."; error block with Retry. Read-only for both roles.
- **Dashboard**: the retirement card shows a small "tax tables out of date" note when the rules view is stale (the card component reads `GET /rules` lazily; the card's own contract is unchanged).
- Every planner page carries `PLANNER_DISCLAIMER`.

## 6. Jobs and services

This area adds no job and no table.

- **Run start** (`retirement.simulate`, inputs-and-data 6.3): the engine's `runSimulation` calls `loadTaxData()`, `compileTaxLaw(…, settings.taxRuleSet, socialSecurity.adjustment)`, `compileTaxDrag` and `compileSsPlan` once on the job's thread and passes the compiled arrays to the worker threads (plain typed arrays and plain objects, structured-cloneable); each thread owns its path tables and scratch arrays. A `TaxDataError` here is a programming or data error: the engine rethrows it as its `SimInputError` with the same code, which the job maps to `failSimRun(code, message)` without a retry. Idempotency and failure handling are the job's; compiling is deterministic.
- **Run record**: `sim_run.data_version` (the manifest version) and `sim_run.tax_rule_set` are the copies inputs-and-data already stores; the run's warnings (3.11) go into `SimOutput.warnings`.
- **`app.planner`** (the decoration inputs-and-data builds from `@meridian/retirement`, faked in `createTestApp`): gains `rulesView(today)`, `taxPreview(req)` and `socialSecurityPreview(req)`; `PlannerEnv.ruleSets` is `listTaxRuleSets().map((r) => r.id)`, `minStartYear` is `TAX_DATA_FIRST_YEAR`, and `contributionLimit` is this area's function.
- **Data integrity suite** (`packages/retirement/src/tax/data.test.ts`, part of `pnpm test`): every file parses; the invariants of section 2; the manifest hashes against the files. It contains no clock test: staleness is a function of the injected `today` (`buildRulesView(today).stale`), tested with fixed dates.
- **Annual refresh runbook** (`packages/retirement/data/README.md`): each November add `tax/federal-N.json` from the new revenue procedure, the HSA revenue procedure (May), the retirement-plan notice (which also empties `pending`) and the SSA fact sheet (each year's COLA lives in its year file; `colaHistory` is never extended); set `lastPublishedYear`; update the manifest hashes; run the suite; bump `dataVersion`. Old runs keep the version they recorded, and re-simulating one of their paths is refused once the version moved (inputs-and-data `engine_changed`). There is no outbound fetch at run time, consistent with the spec's network rule.

## 7. Test cases

All hand-calculated and reproduced by the scratch reference. Amounts are dollars; "2026" and "2027" mean the published rows; `N_AGED = 0` unless ages say otherwise; the tolerance rule is decision 50. Files: `data.test.ts` (A), `federalTax.test.ts` (B, C, D), `penalties.test.ts` and `rothBasis.test.ts` (E), `taxableAccount.test.ts` (F), `rmd.test.ts` (G), `socialSecurity.test.ts` (H), `contributionLimits.test.ts` and `payroll.test.ts` (I), `compile.test.ts` (J), `properties.test.ts` (K).

### A. Data

- A1. Every data file parses with its schema; the manifest hashes equal the SHA-256 of the files; `dataVersion` is `2026.11.1`.
- A2. Year files: the 24 cumulative amounts of 2.2 are reproduced; the three structural identities hold for 2026 and 2027.
- A3. Uniform Lifetime: 49 divisors, strictly decreasing, sum 532.0; 26.5 at 73, 24.6 at 75, 20.2 at 80, 2.0 at 120.
- A4. Joint table: every check of 2.5.
- A5. `fraMonths`: 1937 is 780; 1938 is 782; 1943 and 1954 are 792; 1955 is 794; 1957 is 798; 1959 is 802; 1960 and 1975 are 804. `survivorFraMonths`: 1945 and 1956 are 792; 1957 is 794; 1960 is 800; 1961 is 802; 1962 is 804. `fullRetirementAgeTable()` has 13 rows and ends `{ 1960, null, 67, 0 }`.
- A6. `listTaxRuleSets()` returns the four ids, `current_law` first; every law-change id resolves; a rules file with path `ordinary.rate` fails to load.
- A7. `buildRulesView("2027-12-31").stale` is false and `buildRulesView("2028-01-01").stale` is true; `pendingLimits` is one entry for 2027 with the six plan fields.

### B. Ordinary tax and deductions

- B1. Single, 40, 2026, wages 100,000. Taxable income 100,000 − 16,100 = 83,900. Tax 5,800 + 22% × (83,900 − 50,400 = 33,500) = 5,800 + 7,370 = **13,170.00**. `BRACKET_RATE` 0.22; `ROOM_IN_BRACKET` 105,700 − 83,900 = 21,800.
- B2. Joint, both 45, 2026, wages 180,000. Taxable 147,800; 11,600 + 22% × 47,000 = **21,940.00**.
- B3. Single, 40, 2027, wages 100,000. Taxable 83,400; 5,987 + 22% × (83,400 − 52,025 = 31,375) = **12,889.50**.
- B4. Joint, both 45, 2027, wages 180,000. Taxable 146,800; 11,974 + 22% × 42,750 = **21,379.00**.
- B5. Joint, both 67, 2026, pension 60,000 and pre-tax withdrawals 30,000. AGI 90,000; standard 32,200 + 2 × 1,650 = 35,500; senior 12,000; taxable 42,500; 2,480 + 12% × 17,700 = **4,604.00**.
- B6. The senior deduction's phase-out, 2026. (a) Single, 70, pension 100,000: senior 6,000 − 6% × 25,000 = 4,500; standard 16,100 + 2,050 = 18,150; taxable 77,350; 5,800 + 22% × 26,950 = **11,729.00**. (b) Joint, one spouse 65 or over, pension 200,000: 6,000 − 6% × 50,000 = 3,000 for the one eligible person; standard 32,200 + 1,650 = 33,850; taxable 163,150; 11,600 + 22% × 62,350 = **25,317.00**. (c) Joint, both 70, pension 200,000: senior 2 × 3,000 = 6,000; taxable 200,000 − 35,500 − 6,000 = 158,500; 11,600 + 22% × 57,700 = **24,294.00**. (d) Single, 70, pension 175,000: senior 0 (the phase-out ends at 175,000); taxable 156,850; 17,966 + 24% × 51,150 = **30,242.00**. (e) Joint, both 70, pension 250,000: senior 0; taxable 214,500; 35,932 + 24% × 3,100 = **36,676.00**.
- B7. The survivor's change of status. 2026, joint, both 75, pension 80,000: taxable 80,000 − 35,500 − 12,000 = 32,500; 2,480 + 12% × 7,700 = **3,404.00**. 2027, single, 76, the same pension: standard 16,600 + 2,100 = 18,700; senior 6,000 − 6% × 5,000 = 5,700; taxable 55,600; 5,987 + 22% × 3,575 = **6,773.50**.
- B8. Adjustments. Single, 2026, wages 85,000, adjustments 4,400: AGI 80,600; taxable 64,500; 5,800 + 22% × 14,100 = **8,902.00**.
- B9. Unused deduction. Single, 2026, wages 10,000: taxable income 0; tax 0; `UNUSED_DEDUCTION` 6,100; `BRACKET_RATE` 0; `BRACKET_INDEX` 0; `ROOM_IN_BRACKET` 12,400.
- B10. Top bracket. Single, 2027, wages 800,000: taxable 783,400; 199,237.75 + 37% × 122,025 = **244,387.00**; `ROOM_IN_BRACKET` is `+Infinity`.

### C. Taxation of Social Security

- C1. Nothing taxable. Single, benefits 20,000, pension 10,000: `PROVISIONAL` 20,000, below 25,000: **0**.
- C2. The 50% tier (Publication 915 Example 1). Single, benefits 5,980, other income 28,990: `PROVISIONAL` 31,980; `tier1 = min(2,990, 3,490, 4,500)`: **2,990**, as the IRS worksheet shows.
- C3. The 85% tier (Publication 915 Example 3). Joint, benefits 10,000, other income 40,500: `PROVISIONAL` 45,500; `tier1 = min(5,000, 6,750, 6,000) = 5,000`; 0.85 × 1,500 = 1,275; `min(8,500, 6,275)`: **6,275**, as the IRS worksheet shows.
- C4. (a) Single, benefits 20,000, other 20,000: `PROVISIONAL` 30,000; `tier1 = min(10,000, 2,500, 4,500)`: **2,500**. (b) Joint, benefits 40,000, other 50,000: `PROVISIONAL` 70,000; `tier1` 6,000; 0.85 × 26,000 = 22,100; **28,100** (below the 34,000 cap).
- C5. (a) The 85% cap. Single, benefits 30,000, other 80,000: 0.85 × 61,000 + 4,500 = 56,350, capped at **25,500**. (b) Tax-exempt interest counts. Single, benefits 24,000, pension 12,000, tax-exempt interest 4,000: `PROVISIONAL` 12,000 + 4,000 + 12,000 = 28,000; `tier1 = min(12,000, 1,500, 4,500)`: **1,500**; AGI 13,500; `MAGI_IRMAA` 17,500; `MAGI_ACA` 17,500 + 22,500 = 40,000.
- C6. The full return of 3.3: taxable benefits 40,800; AGI 123,800; taxable income 76,300; total **6,500.00**; `MAGI_ACA` 131,000; `ROOM_IN_BRACKET` 42,500; `ROOM_IN_LTCG0` 22,600; 1,000 more of pre-tax withdrawal costs 120.00.
- C7. Survivor, single, 72, 2027. Benefits 30,000, pre-tax 40,000, qualified dividends 4,000, long-term gain 6,000. `other` 50,000; `PROVISIONAL` 65,000; 0.85 × 31,000 + 4,500 = 30,850, capped at 25,500. AGI 75,500; standard 18,700; senior 6,000 − 6% × 500 = 5,970; taxable 50,830; `ORD_TAXABLE` 40,830; `PREF_AT_0 = min(50,830, 51,050) − 40,830 = 10,000`; 1,280 + 12% × (40,830 − 12,800 = 28,030) = **4,643.60**.
- C8. Joint, 2027, one spouse 66 with benefits 24,000, the other 60 with wages 50,000, interest 2,000. `PROVISIONAL` 64,000; `tier1` 6,000; 0.85 × 20,000 = 17,000; 23,000, capped at 20,400. AGI 72,400; standard 33,200 + 1,700 = 34,900; senior 6,000; taxable 31,500; 2,560 + 12% × 5,900 = **3,268.00**.
- C9. Effective marginal rates, single, 70, 2026. (a) Benefits 30,000, pre-tax 30,000: `PROVISIONAL` 45,000; taxable benefits 0.85 × 11,000 + 4,500 = 13,850; AGI 43,850; taxable 43,850 − 18,150 − 6,000 = 19,700; tax 1,240 + 12% × 7,300 = 2,116.00; `BRACKET_RATE` 0.12; `effectiveMarginalRates` ordinary **0.222**. (b) Benefits 60,000, pre-tax 55,000: 0.85 × 51,000 + 4,500 = 47,850 (below the 51,000 cap); AGI 102,850; senior 6,000 − 6% × 27,850 = 4,329; taxable 80,371; tax 5,800 + 22% × 29,971 = 12,393.62; ordinary **0.43142**; long-term gain **0.36142** (22% × 0.961 + 15%).

### D. Capital gains, net investment income tax, losses

- D1. Gains across the 0% and 15% bands. Single, 50, 2026: wages 40,000, qualified dividends 5,000, long-term gain 30,000. AGI 75,000; taxable 58,900; `PREF_INCOME` 35,000; `ORD_TAXABLE` 23,900; `PREF_AT_0` 49,450 − 23,900 = 25,550; `PREF_AT_15` 9,450 (1,417.50); `ORD_TAX` 1,240 + 12% × 11,500 = 2,620; line 23 is 4,037.50; line 24 is 5,800 + 22% × 8,500 = 7,670. Tax **4,037.50**.
- D2. Gains across the 15% and 20% bands, with NIIT. Joint, both 50, 2026: wages 532,200, long-term gain 200,000. AGI 732,200; taxable 700,000; `ORD_TAXABLE` 500,000; `ORD_TAX` 82,048 + 32% × 96,450 = 112,912; `PREF_AT_15` 613,700 − 500,000 = 113,700 (17,055); `PREF_AT_20` 86,300 (17,260); `INCOME_TAX` 147,227. NIIT 3.8% × min(200,000, 482,200) = 7,600. Total **154,827.00**.
- D3. All gains at 0%. Joint, both 66, 2027: interest 20,000, long-term gain 80,000. AGI 100,000; standard 33,200 + 2 × 1,700 = 36,600; senior 12,000; taxable 51,400; `ORD_TAXABLE` 0; `PREF_AT_0` 51,400. Tax **0.00**.
- D4. The worksheet's last line. Joint, 2026, wages 131,100, long-term gain 1,900. Taxable 100,800; `ORD_TAXABLE` 98,900; `ORD_TAX` 2,480 + 12% × 74,100 = 11,372; the gain sits above the 0% band, so line 23 is 11,372 + 285 = 11,657; line 24 is `bracket(100,800)` = 11,600. Tax **11,600.00**; `CG_TAX` 228.00.
- D5. NIIT, single, 2026. (a) Wages 250,000, interest 10,000, qualified dividends 10,000, gain 30,000: AGI 300,000; taxable 283,900; `ORD_TAXABLE` 243,900; `ORD_TAX` 41,024 + 32% × 42,125 = 54,504; gains 15% × 40,000 = 6,000; NII 50,000, below the excess of 100,000: NIIT 1,900; total **62,404.00**. (b) Wages 180,000, gain 50,000: AGI 230,000; `ORD_TAXABLE` 163,900; 17,966 + 24% × 58,200 = 31,934; gains 7,500; NIIT 3.8% × min(50,000, 30,000) = 1,140; total **40,574.00**. (c) Wages 500,000, gain 100,000: taxable 583,900; `ORD_TAXABLE` 483,900; `ORD_TAX` 58,448 + 35% × 227,675 = 138,134.25; `PREF_AT_15` 545,500 − 483,900 = 61,600 (9,240); `PREF_AT_20` 38,400 (7,680); NIIT 3,800; total **158,854.25**. (d) With a loss: wages 260,000, interest 5,000, long-term loss 10,000: `LOSS_USED` 3,000; AGI 262,000; NII 5,000 − 3,000 = 2,000; NIIT **76.00**.
- D6. Capital losses, single, 2026. (a) Wages 60,000, long-term loss 10,000: used 3,000, carried out 7,000; AGI 57,000; taxable 40,900; 1,240 + 12% × 28,500 = **4,660.00**. (b) Wages 60,000, gain 5,000, carry-in 7,000: net −2,000; used 2,000; carried out 0; AGI 58,000; taxable 41,900; **4,780.00**. (c) Wages 60,000, gain 12,000, carry-in 7,000: net 5,000, all at 0% (taxable 48,900, `ORD_TAXABLE` 43,900, `PREF_AT_0` 5,000); 1,240 + 12% × 31,500 = **5,020.00**. (d) Wages 60,000, short-term gain 4,000, long-term loss 1,000: net 3,000, preferential 0; AGI 63,000; taxable 46,900; 1,240 + 12% × 34,500 = **5,380.00**. (e) Wages 70,000, long-term gain 10,000, short-term loss 4,000: preferential 6,000; AGI 76,000; taxable 59,900; `ORD_TAXABLE` 53,900; 5,800 + 22% × 3,500 + 15% × 6,000 = **7,470.00**.
- D7. An integrated 2027 return with an RMD. Joint, ages 74 and 72. Person A (born 1953) holds 1,200,000 pre-tax on 1 January: RMD 1,200,000 ÷ 25.5 = 47,058.82. Pension 18,000; Social Security 62,000; ordinary dividends 6,300 of which 6,000 qualified; interest 2,500; long-term gain 9,000. `other` = 18,000 + 2,500 + 6,300 + 47,058.82 + 9,000 = 82,858.82; `PROVISIONAL` 113,858.82; `tier1` 6,000; 0.85 × 69,858.82 + 6,000 = 65,380.00, capped at 52,700. AGI 135,558.82; standard 36,600; senior 12,000; taxable 86,958.82; `PREF_INCOME` 15,000; `ORD_TAXABLE` 71,958.82; `ORD_TAX` 2,560 + 12% × 46,358.82 = 8,123.06; all 15,000 at 0%; line 24 is 9,923.06; NII 17,800 but AGI is below 250,000. Total **8,123.06**; `ROOM_IN_BRACKET` 104,050 − 71,958.82 = 32,091.18; `ROOM_IN_LTCG0` 15,141.18.

### E. Additional taxes, Roth ordering, HSA

- E1. Early pre-tax withdrawal. Single, 55 all year (`earlyFrac` 1), 2026, wages 50,000, IRA withdrawal 20,000: AGI 70,000; taxable 53,900; 5,800 + 22% × 3,500 = 6,570; additional tax 10% × 20,000 = 2,000; total **8,570.00**. The same from a `401k` account after retiring in 2026 at 55: base 0, total 6,570.00.
- E2. `earlyFraction`: the five examples of 3.7.1; and for the HSA, born July 1961 (65 in July 2026): 0.5 for 2026.
- E3. Separation at 55. Born 1970, `retirementMonth` 2026-03 (the year of 56). A 30,000 withdrawal in 2027 at 57 (`earlyFrac` 1): from a `401k` account the base is 0; from an `ira` account 30,000 (additional tax 3,000). Retired in 2023 at 53: the `401k` base is 30,000. A withdrawal in 2025, before retiring in 2026: base 30,000.
- E4. Roth ordering, the example of 3.7.3: taxable 5,000, base 20,000. In a 2026 single return with wages 50,000: AGI 55,000; taxable 38,900; 1,240 + 12% × 26,500 = 4,420; additional tax 2,000; total **6,420.00**.
- E5. Variants on E4's state. (a) Age 60 (`earlyFrac` 0), `FIRST_YEAR` 2022: taxable 0, base 0. (b) Age 60, `FIRST_YEAR` 2027 (2030 is before 2032): taxable 5,000, base 0. (c) The year 59½ is reached in July (`earlyFrac` 0.5), clock met: taxable 2,500, base 10,000. (d) Year 2027, age 50, `BASIS_FREE` 30,000, `CONV0` 20,000 (made 2023), `CONV2` 15,000 (made 2025): a withdrawal of 60,000 takes 30,000 from basis and 30,000 from conversions; taxable 0; base 30,000; additional tax 3,000; afterwards `BASIS_FREE` 0 and the layers 0, 0, 5,000, 0, 0. (e) 80,000 instead: 30,000 basis, 35,000 conversions, 15,000 earnings; taxable 15,000; base 50,000.
- E6. The clock is real. A person with no Roth converts 40,000 in 2027 (`FIRST_YEAR` becomes 2027). In 2030, aged 61 (`earlyFrac` 0), the account holds 50,000 and all of it is withdrawn: 40,000 from the 2027 layer, 10,000 of earnings; taxable **10,000** (2030 is before 2032), base 0. The same withdrawal in 2032, after the roll has moved the layer into `BASIS_FREE`: taxable 0.
- E7. Seasoning. `rothRollYear` at the start of 2028 on E5(d)'s initial state gives `BASIS_FREE` 50,000 and the layers 0, 15,000, 0, 0, 0.
- E8. `mergeRothAtDeath`: survivor (10,000; layers 0, 0, 0, 0, 5,000; `FIRST_YEAR` 2020) absorbs deceased (30,000; 0, 15,000, 0, 0, 0; 2015): 40,000; 0, 15,000, 0, 0, 5,000; 2015.
- E9. HSA. Withdrawal 10,000, qualified medical 6,000. Age 60 (`earlyFrac65` 1), single, 2026, wages 50,000: taxable 4,000; AGI 54,000; taxable income 37,900; 1,240 + 12% × 25,500 = 4,300; additional tax 20% × 4,000 = 800; total **5,100.00**. Age 66 with pension 50,000: AGI 54,000; standard 18,150; senior 6,000; taxable 29,850; 1,240 + 12% × 17,450 = **3,334.00**, no additional tax. In the year of turning 65 in July (`earlyFrac65` 0.5): base 2,000.
- E10. A scheduled conversion. Joint, both 62, 2026, pension 30,000: tax 0 (below the standard deduction). With a 60,000 conversion: AGI 90,000; taxable 57,800; 2,480 + 12% × 33,000 = **6,440.00**; no additional tax; `CONV4` 60,000.

### F. Taxable account (the example of 3.6)

- F1. Income: `INTEREST` 3,000; `ORD_DIV` 1,560; `QUAL_DIV` 1,482; class incomes 1,560; 0; 2,400; 600; 0; 0.
- F2. Sale of 50,000: gain **20,000**; values 90,000; 45,000; 15,000; bases 37,500; 37,500; 15,000.
- F3. Loss. A holding of 80,000 with basis 100,000 sells 20,000: gain **−5,000**; 60,000 and 75,000 remain.
- F4. Reinvestment with `held` 0.75: bases 38,670; 39,300; 15,450.
- F5. Rebalancing. (a) Straight after the pro-rata sale: gain 0. (b) After returns of +10%, +2%, +3%: gain **1,700.21**; values 96,210; 48,105; 16,035 (total unchanged at 160,350); bases 37,580.21; 41,505; 16,035.
- F6. Step-up with share 0.5 on F5(b)'s result: bases 66,895.10; 44,805.00; 16,035.00. With share 1: basis equals value in every class.
- F7. Deposit of 23,415.48 with weights 0.6 / 0.3 / 0.1: value and basis rise by 14,049.29; 7,024.64; 2,341.55.
- F8. Interest floor. Bonds 100,000 and cash 50,000: a cash return of −2% gives interest 0; of −0.5% gives bond interest 100,000 × 0.005 = 500 and cash interest 0.
- F9. Gain distributions. `gainDistributionRate` 0.05 on the class `other` (no dividends, no interest) worth 368,000 with basis 230,000: 6,900 of long-term gain, and basis 236,900 after reinvestment with `held` 1.
- F10. A cash account of 50,000 at a 3% cash return: interest 1,500; after reinvestment and the return, value and basis are both 51,500.
- F11. A sale larger than the holding (300,000 against 200,000 with basis 120,000): `s` = 1, gain 80,000, everything zero afterwards. A sale from an empty holding returns 0; `reinvestTaxable` with `startTotal` 0 changes nothing.

### G. Required minimum distributions

- G1. The IRS's examples: 38,400 at 73 is 38,400 ÷ 26.5 = **1,449.06** (the publication prints $1,450); 34,800 at 73 is **1,313.21** (prints $1,313); 100,000 at 75 is **4,065.04**; with a spouse aged 64, 100,000 ÷ 25.3 = **3,952.57**.
- G2. Known balances: 500,000 at 75 is **20,325.20**; 100,000 at 73 is 3,773.58; 800,000 at 72 (born 1950) is 29,197.08; 250,000 at 80 is 12,376.24; age 125 uses 2.0.
- G3. Start ages: 1950 gives 72; 1951 and 1959 give 73; 1960 gives 75. Born 1953: 0 in 2025 (72), due in 2026 (73). Born 1960: 0 in 2034 (74), balance ÷ 24.6 in 2035.
- G4. Joint table: owner 75 with a spouse of 65 (10 years younger, not more) uses the Uniform divisor (4,065.04); owner 73, spouse 60: 100,000 ÷ 28.6 = 3,496.50; no living spouse: Uniform.
- G5. Plan year 0: 500,000 at 75 with f = 2/12 is 3,387.53; with f = 3/12 is 5,081.30.
- G6. Survivor. A (born 1950) dies at the end of 2030; B (born 1958) owns the combined 900,000 on 1 January 2031 and is 73 that year: 900,000 ÷ 26.5 = **33,962.26**. Had B been born in 1960 (71 in 2031) the RMD is 0 until 2035.
- G7. The reinvestment example of 3.8: tax **7,089.47**, surplus **23,415.48**.
- G8. Two accounts of one owner aged 80, 300,000 and 700,000: the RMD of 49,504.95 is taken pro rata, 14,851.49 and 34,653.47.

### H. Social Security (monthly dollars; program table with COLA 0 and scale 1 unless stated)

- H1. `retirementFactor` for full retirement age 804 at 62 to 70: 7/10, 3/4, 4/5, 13/15, 14/15, 1, 27/25, 29/25, 31/25.
- H2. Full retirement age 802 (born 1959): at 62, 58 months early, 1 − (20% + 22 × 5/12%) = 17/24; at 70, 38 months late, 94/75.
- H3. Month granularity, 804: 62 years 1 month gives 169/240; 66 years 6 months gives 29/30; 67 years 6 months gives 26/25; 71 years is clamped to 31/25.
- H4. `spousalFactor` for 804 at 62 to 67: 13/20, 7/10, 3/4, 5/6, 11/12, 1. `survivorFactor` for 804: 143/200 at 60, 223/280 at 62, 293/350 at 63, 1 at 67.
- H5. Each claiming age with SSA's rounding, PIA 2,000.00, born January 1960. 62: $1,400. 63: $1,500. 64: $1,600. 65: 1,733.33 truncated to 1,733.30, paid **$1,733**. 66: 1,866.60, paid **$1,866**. 67: $2,000. 68: $2,160. 69: $2,320. 70: $2,480. A full later year pays twelve times the monthly amount (20,796 at 65). Born 1959: at 62, 1,416.60, paid **$1,416**; at 70, 2,506.60, paid **$2,506**.
- H6. January rule. (a) Born July 1960 (full retirement age July 2027), claim at 68 (July 2028): 2028 pays 6 × $2,080 = **12,480**; 2029 pays 12 × $2,160 = **25,920**. (b) Born March 1960, claim at 70: the full 31/25 at once, 10 × $2,480 = 24,800 in 2030. (c) Born November 1960, claim at 69 (November 2029): 14 of the 24 credits were earned before 2029; 2,000 × (1 + 14/150) = 2,186.60, paid $2,186 for 2 months (4,372); 2030 pays $2,320 a month.
- H7. Spousal; worker PIA 2,400 unless stated; everyone's full retirement age is 67. (a) Spouse PIA 600, both in pay when the spouse is 62: own 420.00, excess 600 × 13/20 = 390.00, paid **$810**. (b) Spouse claims at 67: 600 + 600 = **$1,200**. (c) Spouse PIA 0 at 62: 1,200 × 13/20 = **$780**. (d) Spouse claims own at 62, worker claims when the spouse is 65: own 420.00; spousal factor 5/6; excess 500.00; paid **$920**. (e) Own PIA 1,000 claimed at 70 (1,240.00), worker PIA 2,600: excess 1,300 − 1,240 = 60; paid **$1,300**. (f) Spouse PIA 800, both at 62: own 560.00, excess 400 × 13/20 = 260.00, paid **$820** (9,840 a year). (g) Spouse PIA 800 claims own at 62, worker claims when the spouse is 66: 400 × 11/12 = 366.67, truncated to 366.60; paid **$926**. (h) A start inside the year: spouse born January 1962 with PIA 600 claimed at 62; worker born July 1960 claims at 67 (July 2027), when the spouse is 65 years 6 months (factor 7/8, excess 525.00): 2027 pays 6 × $420 + 6 × $945 = **8,190**.
- H8. Survivor; deceased PIA 2,000. (a) Deceased claimed at 62 (factor 7/10); survivor past survivor full retirement age: `min(2,000, max(1,400, 1,650))` = **$1,650**. (b) Deceased claimed at 70: **$2,480**, also for a survivor whose own benefit is 1,200. (c) Deceased died before claiming and before full retirement age; survivor aged 60 when it starts: 2,000 × 143/200 = **$1,430**. (d) Survivor aged 63 at the start: 2,000 × 293/350 = 1,674.29, truncated to 1,674.20, paid **$1,674**. (e) Case (a) with the survivor aged 63: `min(1,674.29, 1,650)` = **$1,650**. (f) Deceased born July 1960, unclaimed, dies at the end of 2028: 18 credit months from July 2027 to January 2029, factor 28/25: **$2,240**. (g) Survivor born January 1966 with own PIA 1,500 and a claim at 70; the deceased dies at the end of 2027, unclaimed and before full retirement age: the widow(er)'s benefit starts in January 2028 at age 62, factor 223/280, 1,592.86 truncated to 1,592.80, paid **$1,592** (19,104 a year) through 2035; from January 2036 the own benefit of 1,500 × 31/25 = 1,860 is larger: **$1,860** (22,320 a year). (h) Survivor born May 1968; the deceased dies at the end of 2026: nothing in 2027 (under 60); 2028 pays 8 × $1,430 = 11,440 from May. (i) The couple of H7(f); the worker dies at the end of 2030: December 2030 pays the spouse $820; from 2031 `min(2,400, max(1,680, 1,980))` = **$1,980** replaces it.
- H9. COLA. The chain of 3.9.6: 2,072.00; 2,121.70; 2,121.70; 2,142.90. Statement year: a PIA of 2,000 as of 2025 is 2,056.00 at a 2026 start and 2,130.00 at a 2027 start (2,130.016 truncated). Rounding: a rise of 0.049% gives no COLA; 0.05% gives 0.1%.
- H10. Earnings test; PIA 2,000 claimed at 62 ($1,400 a month). (a) Born January 1963, year 2026, wages 40,000: (40,000 − 24,480) ÷ 2 = **7,760** withheld of 16,800 (benefit 9,040); `ARF_MONTHS` 6; from full retirement age the factor is 29/40 and the payment **$1,450**. (b) Born July 1960, year 2027 (full retirement age in July), wages 180,000: counted 180,000 × 6/12 = 90,000; (90,000 − 67,920) ÷ 3 = **7,360** withheld of the 8,400 paid before July; `ARF_MONTHS` 6; July to December pay $1,450; the year's benefit is 8,400 − 7,360 + 8,700 = **9,740**. (c) The same with wages 90,000: counted 45,000, nothing withheld, 16,800. (d) Plan year 0 of November and December 2026 (f = 2/12) for (a)'s person with wages 10,000 in those months: (10,000 − 24,480 × 2/12) ÷ 2 = 2,960, capped at the 2,800 payable: benefit 0, `ARF_MONTHS` 2. (e) (a) with wages 60,000: 17,760 exceeds the 16,800 payable: all withheld, `ARF_MONTHS` 12.
- H11. Months. Born June 1964, claim at 62 (June 2026): 2026 pays 7 × $1,400 = 9,800 and 2027 pays 16,800. A person `receiving` 1,400 since June 2026 (PIA backed out as 1,400 ÷ 7/10 = 2,000) in a plan that starts in November 2026: year 0 pays **2,800**, the two months in the plan, not seven months times f.
- H12. Scale. Under `ss_shortfall_2033`, `SS_SCALE` is 1 in 2032 and 0.78 in 2033: a 30,000 benefit pays 23,400. With the frozen input's adjustment `{ fromYear: 2035, factorBp: 9000 }` as well, 2035 has 0.702.
- H13. Switches. With `spousal: false` H7(a) pays $420. With `survivor: false` H8(i) pays $560 from 2031. A partner of mode `none` gives and receives neither part.
- H14. `receiving` with `monthlyAtFra` given uses it unchanged. An `asOfYear` of 2010 is treated as 2016 and raises `ss_statement_old`.
- H15. The deceased's PIA keeps its COLAs. H8(a) after a 2.5% COLA: PIA 2,050.00; `min(2,050, max(1,435, 1,691.25))` = 1,691.25, truncated to 1,691.20, paid **$1,691**.
- H16. Property: for 500 seeded random couples (birth months, claim ages, PIAs, death years, wages), the shortcut of 3.9.8 equals the month loop in every year, and `socialSecurityYear` over the 12 single-month periods of a year sums to the annual call when wages are 0.
- H17. Preview. For H7(a)'s spouse `byClaimAge` at 62 is `monthlyCents "42000"`, `spousalMonthlyCents "39000"`; at 67 `"60000"` and `"60000"`; `survivorMonthlyAtFraCents "198000"`.

### I. Payroll tax and contribution limits

- I1. Payroll tax. Single, 2026, wages 250,000: 11,439.00 + 3,625.00 + 450.00 = **15,514.00**. Single, 2027, wages 60,000: 3,720.00 + 870.00 = **4,590.00**. Joint, 2026, wages 220,000 and 80,000: 6.2% × (184,500 + 80,000) + 1.45% × 300,000 + 0.9% × 50,000 = 16,399 + 4,350 + 450 = **21,199.00**. Plan year 0 with f = 2/12 and wages 20,000 (120,000 a year): 9,180 × 2/12 = 1,530.00.
- I2. 2026 deferral limit by age: 45 is 24,500; 55 is 32,500; 61 is 35,750; 64 is 32,500. Annual additions 72,000.
- I3. IRA, 2026: 7,500 at 49 and 8,600 at 50. HSA, 2026: family at 55 for a full year 9,750; self-only at 40, 4,400; self-only in the year of turning 65 in July (6 months): (4,400 + 1,000) × 6/12 = 2,700; 0 in later years. 2027: 4,500 self-only and 9,000 family.
- I4. `contributionLimit`: (2026, 51, `employer_plan`) is `3250000n`; (2026, 61, `employer_plan`) is `3575000n`; (2026, 50, `ira`) is `860000n`; (2026, 55, `hsa_family`) is `975000n`; (2026, 40, `hsa_family`) is `875000n`; 2025 and 2028 give `null`.
- I5. Pending limits. `contributionLimit(2027, 45, "employer_plan")` is `2450000n` (the carried 2026 amount) and (2027, 40, `hsa_family`) is `900000n` (published). Compiling a plan that covers 2027 raises `limits_pending` naming 2027 and the six fields; a plan compiled against a fixture with an empty `pending` does not.

### J. Indexing, law changes, the partial year

- J1. Forward indexing with path inflation +3.0% in 2027, +2.5% in 2028, −1.0% in 2029 (factors 1.03, 1.05575, 1.0451925):

| Year | Single thresholds | Joint thresholds | Standard single / joint | Aged single / joint | 0% max single / joint | 15% max single / joint |
| --- | --- | --- | --- | --- | --- | --- |
| 2028 | 13,175; 53,575; 112,375; 214,550; 272,475; 681,200 | 26,350; 107,150; 224,750; 429,100; 544,950; 817,450 | 17,050 / 34,100 | 2,150 / 1,750 | 52,575 / 105,150 | 580,050 / 652,600 |
| 2029 | 13,500; 54,925; 115,200; 219,925; 279,275; 698,225 | 27,000; 109,850; 230,400; 439,850; 558,550; 837,850 | 17,500 / 35,000 | 2,200 / 1,750 | 53,875 / 107,750 | 594,550 / 668,900 |
| 2030 | 13,375; 54,375; 114,050; 217,725; 276,500; 691,250 | 26,750; 108,750; 228,100; 435,450; 553,000; 829,500 | 17,350 / 34,700 | 2,150 / 1,750 | 53,350 / 106,700 | 588,650 / 662,200 |

  The NIIT thresholds, the Social Security bases and the loss limit are the same in every year. Taxes on those rows: (a) single, 40, 2028, wages 100,000: taxable 82,950; tax at 53,575 is 1,317.50 + 12% × 40,400 = 6,165.50; plus 22% × 29,375 = **12,628.00**. (b) Joint, both 70, 2029, pension 90,000, `current_law`: standard 35,000 + 2 × 1,750 = 38,500; senior 0 (expired); taxable 51,500; 2,700 + 12% × 24,500 = **5,640.00**. (c) The same under `senior_deduction_permanent`: taxable 39,500; 2,700 + 12% × 12,500 = **4,200.00**. (d) Single, 68, 2030, pension 40,000, qualified dividends 5,000, long-term gain 20,000: AGI 65,000; standard 17,350 + 2,150 = 19,500; senior 0; taxable 45,500; `ORD_TAXABLE` 20,500; all 25,000 at 0% (45,500 is below 53,350); 1,337.50 + 12% × 7,125 = **2,192.50**.
- J2. Limits and program amounts on the same factors, from the 2027 file:

| Item (2027 value) | 2028 | 2029 | 2030 |
| --- | --- | --- | --- |
| Deferral (24,500, pending) | 25,000 | 25,500 | 25,500 |
| Catch-up at 50 (8,000) | 8,000 | 8,000 | 8,000 |
| Catch-up at 60 to 63 (11,250) | 11,250 | 11,750 | 11,750 |
| Annual additions (72,000) | 74,000 | 76,000 | 75,000 |
| IRA (7,500) and its catch-up (1,100) | 7,500; 1,100 | 7,500; 1,100 | 7,500; 1,100 |
| HSA self-only (4,500), nearest $50 | 4,650 | 4,750 | 4,700 |
| HSA family (9,000), nearest $50 | 9,250 | 9,500 | 9,400 |
| Wage base (192,300), nearest $300 | 198,000 | 203,100 | 201,000 |
| Earnings test under FRA (25,560), nearest $120 | 26,280 | 27,000 | 26,760 |
| Earnings test, FRA year (67,920), nearest $120 | 69,960 | 71,760 | 71,040 |

- J3. Partial year. (a) Single, 40, 2026, f = 3/12, wages 25,000 (100,000 a year): tax 13,170 × 3/12 = **3,292.50**; the outputs carry AGI 25,000 and `STD_DEDUCTION` 4,025. (b) f = 2/12, wages 16,666.67: **2,195.00**. (c) f = 2/12, wages 10,000, long-term loss 8,000: `LOSS_USED` 500 (3,000 × f), `LOSS_CARRY_OUT` 7,500, AGI 9,500, tax 4,660 × 2/12 = **776.67**. (d) The input array is bit-identical after each call.
- J4. Law changes. (a) `rates_plus_2pts_2031`: the 2030 row keeps the published rates; the 2031 row has 0.12, 0.14, 0.24, 0.26, 0.34, 0.37, 0.39. With a fixture that shifts from 2026: joint, wages 180,000 gives 21,940 + 2% × 147,800 = **24,896.00**, and D1 gives 12% × 12,400 + 14% × 11,500 + 1,417.50 = **4,515.50** (the gains rates do not move). (b) A fixture with `freezeIndexing` for 2028 to 2030 and inflation of 3% every year: the 2028, 2029 and 2030 rows equal 2027's; the 2031 row has `F` = 1.03 (joint thresholds 26,350 and 107,150, joint standard deduction 34,100). (c) A fixture with `replaceSchedule` from 2027 that halves the standard deduction (8,300 / 16,600): single, 2027, wages 100,000: taxable 91,700; 5,987 + 22% × 39,675 = **14,715.50**. (d) A fixture with `setValue` on `capitalGains.netLossLimit` to 5,000 from 2030, `nominal`: the 2029 row has 3,000 and the 2030 row 5,000.
- J5. Stale data. A plan starting in 2029: `F_2028 = 1.025`, `F_2029 = 1.050625`; joint 12% threshold 26,850 in 2029; warning `tax_data_stale`.
- J6. Errors. An unknown rule set id throws `TaxDataError("unknown_rule_set")`; a fixture whose `setValue` makes the thresholds descend throws `TaxDataError("law_change_invalid")`.
- J7. The wedge. `chainedCpiWedge` 0.0025 on J1's inflation: joint 22% threshold 106,900 in 2028 and 109,300 in 2029; joint standard deduction 34,100 in 2028.
- J8. The rounding guard: base 20,000, factor 1.15, step 50 gives 23,000 (the float quotient is 59.999999999999964).

### K. Properties and pins

- K1. Over 20,000 seeded random 2026 households, adding $10 to each input named in 3.4 never lowers `TOTAL`, and adding $10 to `QUAL_DIV` alone (below `ORD_DIV`), `LOSS_CARRY_IN` or `ADJUSTMENTS` never raises it.
- K2. The largest slope of `TOTAL` in `TRAD_DIST` over the scan of 3.4 is below 0.60 (the reference finds 0.52947 at single, one person over 65, benefits 40,000, gain 10,000, withdrawal 36,000).
- K3. Continuity: at every threshold of a row (bracket bounds, both gains thresholds, the Social Security bases, the senior phase-out start and end, the NIIT threshold), the tax one cent below and one cent above differ by less than one cent.
- K4. Identities on random inputs: `PREF_AT_0 + PREF_AT_15 + PREF_AT_20 = PREF_INCOME`; `ORD_TAXABLE + PREF_INCOME = TAXABLE_INCOME`; `0 ≤ TAXABLE_SS ≤ 0.85 × SS_GROSS`; `INCOME_TAX ≤ bracket(TAXABLE_INCOME)`; `Tax_f(x) = f × Tax(x / f)` to 1e-9 relative for f in {1/12, …, 11/12}.
- K5. For random `F` in [0.7, 5]: the indexed single thresholds 1 to 5 are exactly half the joint ones, the joint standard deduction exactly twice the single, the single 0% maximum exactly half the joint.
- K6. Basis conservation over 500 seeded random sequences of deposits, sales, reinvestments and rebalances: basis removed plus basis left equals basis before plus deposits plus reinvested income; rebalancing conserves total value; `retirementFactor` is non-decreasing in the claim age.
- K7. Determinism (L5): filling the tables of one path alone gives the same bytes as filling it inside a batch, and twice gives the same bytes.
- K8. Pins of 8.2: one assertion per not-modelled entry, named after its id.
- K9. Cents boundary: `computeFederalTax` on D1 returns `403750n`; on C9(b) `1239362n`; on D7 `812306n`; `toCents(20325.2032…)` is `2032520n`; `toCents(1.005)` is `101n`; `toCents(−1234.565)` is `−123457n`.

## 8. Deviations and simplifications (flagged)

### 8.1 Deviations from the spec

| # | Deviation | Reason | Effect |
| --- | --- | --- | --- |
| 1 | The "yearly data file" is one file per published year plus a rules file, and the Social Security, RMD and yield data have their own files | the annual refresh adds a file and edits none; provenance sits beside each number | none |
| 2 | A "law change" is one of the named rule sets shipped in the data, not rules the owner writes | a free-form rule editor needs validation and a UI out of proportion to v1; adding a rule set is a data change | the owner cannot invent a law change without a code change (open question 3) |
| 3 | Brackets after 2027 are indexed from the 2027 values with the path's inflation and a one-year lag, not by the statute's chained-CPI method from its base years | the path has one inflation series | thresholds within one rounding step of the statutory method; real bracket creep of about a quarter point a year is left out unless `chainedCpiWedgeBp` is set |
| 4 | Employee payroll tax is computed and reported, although the spec's tax list does not name it | wages earned after the first retirement would otherwise net 7.65% too much | lowers net earned income; its own line, never inside "federal tax"; a setting turns it off |
| 5 | Contribution limits cap the measured savings | salary growth would breach them over decades | the excess goes to the surplus account |
| 6 | The earnings test, SSA's rounding and the January rule for delayed credits are modelled, beyond the spec's "claiming age, spousal and survivor benefits" | benefits then match an SSA statement and "claim early and keep working" is not overstated | none against the spec; more code to verify (section 10.3) |
| 7 | Tax-exempt interest is an input and a class parameter (default 0) | provisional income and MAGI are then worksheet-exact | none by default |
| 8 | Three read-only routes and a rules page are added | the gate's comparison with an independent calculator needs a single-year tax call; provenance must be visible | none |
| 9 | A scenario-level `TaxSettings` block is proposed for the run settings | the wedge, wage growth, payroll switch and yields are assumptions an owner may want to vary | none until the envelope carries it (section 9) |
| 10 | The basis step-up share for joint accounts follows the stored state of residence | half in common-law states, all in community-property states | the first federal rule that reads the state field |

### 8.2 Not modelled (the content of `notModelled.ts`; each entry is pinned by test K8 through the case named)

| Id | Not modelled | Effect on results | Pin |
| --- | --- | --- | --- |
| `tax_table_rounding` | whole-dollar rounding and the Tax Table's $50 bands | within a few dollars of a filed return | B1 returns 13,170.00 exactly |
| `itemized_deductions` | itemized deductions and the non-itemizer charitable deduction | tax overstated for itemizers | B5 uses the standard and senior deductions only |
| `amt` | alternative minimum tax | none for standard-deduction households without incentive stock options | D2's total has no AMT term |
| `credits` | every credit (child, saver's, foreign tax, elderly) | tax slightly overstated | B9 returns 0, never negative |
| `other_deductions` | blindness, dependents, tips, overtime, car-loan interest, qualified business income, student-loan interest | tax overstated where they apply | B6(a) |
| `special_gain_rates` | the 25% and 28% gain rates (real estate recapture, collectibles) | understated on such a sale | D5(c) uses 0, 15 and 20% only |
| `loss_character` | the short- or long-term character of a carryover, and the carryover worksheet's rule when taxable income is negative | timing differences of a few hundred dollars | D6(b) treats the carry-in as long-term |
| `short_term_sales` | short-term gains on simulated sales and rebalancing | tax understated for a household that trades within a year | F2's gain goes to `LT_GAIN` |
| `pretax_basis` | after-tax basis in pre-tax accounts (Form 8606) | withdrawals taxed in full | E1 taxes the full 20,000 |
| `ira_deduction_limits` | the income limits on deductible IRA and Roth IRA contributions | AGI slightly understated for high earners who contribute to an IRA | I3: `iraLimit` has no income test |
| `penalty_exceptions` | substantially equal payments, disability, medical, first home, education, birth and the other exceptions | additional tax overstated for an early retiree who would use them | E3 penalizes the IRA at 57 |
| `beneficiary_ira` | keeping a deceased spouse's account as a beneficiary, which is penalty-free before 59½ | additional tax overstated for a survivor under 59½ who withdraws | G6 treats the survivor as owner |
| `roth_401k_ordering` | the pro-rata rule for non-qualified Roth 401(k) withdrawals (all Roth money follows the IRA ordering) | small; early withdrawals only | E5(d) |
| `roth_history` | conversions made in the five years before the plan start, and the true first-contribution year of an existing Roth | an early withdrawal treats pre-plan conversions as earnings unless they are entered as basis; an existing account is assumed past its five years | E6 uses the in-plan clock |
| `hsa_shoebox` | reimbursing earlier years' medical costs from the HSA | the HSA is slightly less useful | E9 uses the same year's costs |
| `rmd_first_year_deferral` | taking the first RMD by 1 April of the next year | one year of timing | G3 withdraws at 73 |
| `rmd_still_working` | delaying 401(k) RMDs while still employed | only for work past 73 or 75 | G3 |
| `qcd` | qualified charitable distributions | tax overstated for donors | G7 taxes the full RMD |
| `inherited_accounts` | accounts inherited from anyone but the spouse, and the ten-year rule | out of scope | G6 |
| `ss_family_maximum` | the family maximum | cannot bind without child beneficiaries | H7(b) pays 150% of the worker's PIA in total |
| `ss_wage_indexing` | growth of the PIA with average wages before 60, and the lower benefit of someone who stops work early | within a few percent; enter the estimate for the planned stop-work age | H9 indexes by COLAs only |
| `ss_month_rules` | entitlement only from the first full month at 62, no benefit for the month of death, payment a month in arrears, birthdays on the 1st of a month | at most one month of benefit | H11 pays the birth month |
| `ss_earnings_test_detail` | the monthly test of the first year, the worker's earnings withholding the spouse's excess, the credit-back for spousal and survivor reductions | small; the adjustment at full retirement age returns most of it | H10(a) |
| `ss_other_benefits` | child, divorced-spouse and disability benefits; a survivor choosing to delay the widow(er)'s benefit | the widow(er)'s benefit starts as soon as it can, with its permanent reduction | H8(c) |
| `ss_receiving_spousal` | a spousal top-up already inside the benefit of someone who is receiving | the amount entered is treated as the person's own benefit; enter the full-retirement-age amount to be exact | H14 |
| `nq_annuity_nii` | NIIT on the gain part of a non-qualified annuity | NIIT understated above the thresholds | D5(a): NII counts interest, dividends, rent and gains |
| `rental_detail` | depreciation and passive-loss limits on rental income | timing only | the `RENTAL` input is asserted non-negative |
| `wash_sales_lots` | wash sales and specific-lot selection in the simulation | average basis per class only | F2 |
| `loss_step_down` | the step-down of basis at death for positions held at a loss | the survivor's later losses overstated | F6 leaves a loss position's basis alone |
| `rebalance_lag` | rebalancing gains taxed in the following year | one year of timing | F5(b) goes to `pendingLtcg` |
| `payment_timing` | withholding, estimated payments, April settlement | none on totals | J3 |
| `payroll_detail` | the payroll-tax exemption of HSA payroll contributions; self-employment tax | payroll tax slightly overstated | I1 |
| `state_irmaa_aca` | state income tax, IRMAA and ACA (Phase 5) | costs understated until Phase 5; the MAGI outputs exist | C5(b) exposes `MAGI_ACA` |

### 8.3 Assumptions inside modelled rules

- Limits are indexed from their last published, rounded value, so a step can arrive a year late; the 2027 retirement-plan limits are the 2026 amounts until the notice is entered.
- Dividend yields, qualified shares, the bond spread and the step-up shares (2.6) are planning assumptions, shown on the rules page and overridable per scenario.
- Taxable income is computed on the start-of-year value and taxed in full; in a year with large withdrawals it is slightly overstated, in a year with large deposits slightly understated.
- Bond interest follows the path's cash return plus a spread; a real bond fund's coupon can differ.
- Deaths take effect at the end of a calendar year: up to one year of joint brackets and of two benefits too many.
- The first RMD year of a plan uses the opening balance and the fraction f, because no prior year-end balance exists.
- The PIA is carried by COLAs from the statement year, also before age 62 (SSA indexes by wages until 60).
- The earnings test is annual, with wages spread evenly through the year.
- Benefits are counted in the month they are for (SSA pays a month later), and Medicare premiums are not deducted before the dollar rounding (v1 has no Medicare premiums): about 0.2% of one year's benefits.
- The HSA limit is the family limit, because the plan does not know the coverage tier.
- A person born on the first of a month reaches each age a month earlier at SSA and a day earlier at the IRS than this design assumes.
- `staleInflation` is 2.5% a year for calendar years the path does not cover.

## 9. Seams (what this area assumes of the other three)

### From inputs-and-data (merged; `docs/design/phase-4/inputs-and-data.md`)

The frozen input as merged is sufficient for this area. Fields read: `plan.startYear`, `startMonth`, `firstYearMonths`; `household.filingStatus`, `state`, and per person `birthYear`, `birthMonth`, `retirementMonth`; per account `type`, `bucket`, `owner`, `balanceCents`, `basisCents`, `rothContributionBasisCents`, `allocation`, `synthetic`; per income stream `kind`, `earned`, `taxableBp`; `socialSecurity` whole; `contributions`; `rothConversions`; `settings.taxRuleSet`.

- Tax character, as that design states it and this one applies it: `salary` and `part_time` are `WAGES`, less that person's employee contributions to `pre_tax` and `hsa` accounts in the year; `pension` and `annuity` × `taxableBp` are `PENSION`; `rental` × `taxableBp` is `RENTAL`; `other` × `taxableBp` is `OTHER_ORD`; employer contributions are never income; `ADJUSTMENTS` is 0.
- Functions this area provides for it: `listTaxRuleSets()`, `TAX_DATA_FIRST_YEAR`, `contributionLimit()`, `fullRetirementAgeTable()` (4.1), with the signatures its section 9 names.
- Already settled there and relied on here: the first-year rule (its decision 19); the required birth month; required ownership of pre-tax, Roth and HSA accounts (the `account` table has no owner column, so the owner comes from the profile document); unknown basis as 0 with a warning; `claim_in_past`; `unknown_rule_set`; `data.version` in the input hash.
- Requests, each small and each with a fallback:
  1. `RunSettings` gains `tax: TaxSettings.default({})` (4.3). Until it does, the engine uses `DEFAULT_TAX_SETTINGS` and the options are unreachable.
  2. The three routes of 4.4 are registered in its route file and `app.planner` gains `rulesView`, `taxPreview` and `socialSecurityPreview`. Without them the previews and the rules page are absent; nothing else depends on them.
  3. The Social Security step tells the owner that a statement older than 2016 is indexed from 2016 (`ss_statement_old`).
  4. Not needed in v1, useful in v2: the first-contribution year and the last five years' conversions of an existing Roth.

### From engine-and-returns

- Per path, before the year loop: `indexInflation: Float64Array(years)` (the full-calendar-year inflation rate of each plan year, year 0 included and not prorated); `cashReturn` for each year (the nominal return the engine applies to the `cash` class; `NaN` if a return model has none, which triggers `fallbackCashYield`); each person's death year (or `+Infinity`); the period of each plan year (3.1).
- It owns the buffers and state of 2.9 and the scratch arrays, calls `fillPathTables` and `resetSsState` once per path, and calls the functions in the order of 3.12. Deaths take effect at the year end; the filing status is `mfj` through the death year and `single` after; `N_AGED` and the ages are those of 3.1.
- Balances by person: the prior year-end pre-tax balance per owner for the RMD; at a death the pre-tax, Roth and HSA balances and the Roth record move to the survivor, and `stepUpBasisAtDeath` is called on each taxable holding with the share of 3.6.
- Taxable and cash accounts are kept as six-slot holdings; the engine's rebalancing of a taxable account goes through `rebalanceTaxable` with the year's target weights (`glideWeightsAt` or the account's allocation). If the engine maps the six classes to fewer return series, classes that share a series simply receive the same return.
- Contributions are capped with the functions of 3.10 per owner and account type; the part above a limit is deposited in the surplus account and noted under `WN.CONTRIBUTION_CAPPED`.
- The thread harness merges the `WN` records and puts `warningMessages(…)` into `SimOutput.warnings`; a `TaxDataError` becomes its `SimInputError` with the same code; `ENGINE_VERSION` is bumped when a rule of this document changes and `DATA_VERSION` is the manifest's `dataVersion`.

### From strategies-outputs-web

- The withdrawal order after RMDs and the gross-up are its own; this area only prices each source. The gross-up relies on the properties of 3.4 and builds the tax inputs of each candidate with `sellTaxable`, `preTaxPenaltyBase`, `rothWithdraw` and `hsaWithdraw` on scratch copies of the state.
- A scheduled Roth conversion is taken from the person's pre-tax accounts after the RMD, added to `ROTH_CONV`, and recorded with `addRothConversion`.
- HSA withdrawals are offered the year's healthcare spending of the living people as `qualifiedMedical`.
- The surplus account, which receives cash left after spending and tax and the capped-contribution overflow: the included `taxable` account with the largest starting balance (ties by id), else the largest `cash` account, else a synthetic cash holding the engine creates at 0. Deposits use that account's target weights. The frozen input needs no new field for this.
- Payroll tax: when `TaxSettings.includePayrollTax` is on, `employeePayrollTax` is subtracted from the year's cash and shown as its own column.
- The year-by-year table embeds `TaxYearDetail` in each row and shows, from the `SO` record and the RMD calls, the own, spousal and survivor parts of each person's benefit, the amount withheld by the earnings test, and the RMD per person; conversions are their own column. It builds the UI pieces of section 5.
- The gate: the tax side of a reference scenario can be checked year by year through `POST /tax-preview` against any Form 1040 calculator for 2026; the expected tolerance for the tax function alone is $50 a year (Tax Table rounding and the calculator's own rounding). Social Security factors can be checked against SSA's published reduction tables once `www.ssa.gov` is reachable.

### Offered to Phase 5

`MAGI_IRMAA` (kept for two years by the engine), `MAGI_ACA`, `ROOM_IN_BRACKET`, `UNUSED_DEDUCTION`, `ROOM_IN_LTCG0`, `effectiveMarginalRates`, the reserved table slots 44 to 47 and program slots 21 to 23 (IRMAA and ACA tables), law changes for those tables, `TAXABLE_INCOME`, `TAXABLE_SS`, `PENSION` and `TRAD_DIST` as the starting point of the Colorado module, and `monthlyPayment` with claim ages as plain numbers for the claiming-age search.

## 10. Sources

### 10.1 Primary documents fetched from `www.irs.gov` on 2026-11-10 (SHA-256 of the file as received)

| Document | URL | SHA-256 | Used for |
| --- | --- | --- | --- |
| Rev. Proc. 2025-32 | https://www.irs.gov/pub/irs-drop/rp-25-32.pdf | `e9ada115fb43a4af5ea326ca91edd40ab0bf29b9be01d2c13d7b8fa96214635b` | 2026 rate tables (section 4.01), gains thresholds (4.03), standard deduction (4.14) |
| Rev. Proc. 2026-35 | https://www.irs.gov/pub/irs-drop/rp-26-35.pdf | `87b383c6ce6e616fd006a61f5eed46fe67099b9c23fb1e1c42ff5359474513b8` | 2027 rate tables (3.01), gains thresholds (3.03), standard deduction (3.15) |
| Rev. Proc. 2025-19 | https://www.irs.gov/pub/irs-drop/rp-25-19.pdf | `ff2ba4bac62ef6940c57578d70f8be88ff3898ac806e921ad52787c11da35bf4` | 2026 HSA limits |
| Rev. Proc. 2026-24 | https://www.irs.gov/pub/irs-drop/rp-26-24.pdf | `bcb6b41a835b84d4315f738a7250801831021829e39d70225424e2f45afcb715` | 2027 HSA limits |
| Notice 2025-67 | https://www.irs.gov/pub/irs-drop/n-25-67.pdf | `1eea8f141b0cddd182f9f09b3bc8ffad683d27ceb806dfc6da126811dc0a1f8d` | 2026 deferral, catch-ups, §415(c), IRA limits |
| IRS COLA table for plan limits (page, updated 24 August 2026) | https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions | page | 2026 is the newest year: the 2027 plan limits are not published |
| Publication 590-B (2025) | https://www.irs.gov/pub/irs-pdf/p590b.pdf | `d18a592e55ce56d43953dc338272ece3984565792d6dca06989a6ca8121f7360` | Tables II and III, the RMD examples, Roth ordering and five-year rules |
| Publication 915 (2025) | https://www.irs.gov/pub/irs-pdf/p915.pdf | `44c4053dab046c737e4eadff7cf8a8d23fe55d6147bde995c6055b55af6db22b` | Worksheet 1, Examples 1 and 3 |
| Instructions for Form 1040 (2025) | https://www.irs.gov/pub/irs-pdf/i1040gi.pdf | `482e9c487c608f1bbeaceef35bc3c0933e8b35443cfff447e4279d590468364a` | Qualified Dividends and Capital Gain Tax Worksheet |
| Schedule 1-A (2025) | https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf | `64f97b38ff4218e2f188fd55a8aab7043556687487c82bbefe0b6dd1a956ecd4` | Part V lines 31 to 37: $6,000, 6%, $75,000 / $150,000 |
| IRS page on the 2025 act's deductions | https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors | page | senior deduction for 2025 through 2028, per person, joint filing required |
| Form 8960 and instructions | https://www.irs.gov/pub/irs-pdf/f8960.pdf , https://www.irs.gov/pub/irs-pdf/i8960.pdf | `9b323b7166b5845a776f781b8c82eef94ccd998354e88fc33a1051c3b3789731` , `b10fbb23ff4a053db197285497a00914c558e3ae0cdf5c956b7c0c7867376428` | NIIT rate and thresholds |
| Instructions for Form 5329 | https://www.irs.gov/pub/irs-pdf/i5329.pdf | `aec3d325edb26a0d20d3b81030feb97cf62ecc97fa90c9abd91d83dd22749146` | exception 01 (separation in or after the year of 55; not IRAs) |
| Publication 969 (2025) | https://www.irs.gov/pub/irs-pdf/p969.pdf | `d51681ecae43d517415500efe6f7dcc1bba65fed09b48d416f18d6407a5b522f` | HSA 20% additional tax and the age-65 exception |
| Instructions for Schedule D | https://www.irs.gov/pub/irs-pdf/i1040sd.pdf | `650643a686378b7573e4f4476ee4e7c9f9bab1384314dca32dc336f7b2276002` | $3,000 loss limit |
| Publication 551 | https://www.irs.gov/pub/irs-pdf/p551.pdf | `0fbd4f0d37d575f95bd3dbdff09be846a2bf62e882902e02f0318739c4f904d2` | basis at death: half of a qualified joint interest; the nine community-property states |
| Tax Topics 751 and 560 | https://www.irs.gov/taxtopics/tc751 , https://www.irs.gov/taxtopics/tc560 | pages | payroll rates 6.2% and 1.45%; Additional Medicare 0.9% over $200,000 / $250,000 |
| IRS RMD FAQs (page, reviewed 29 January 2026) | https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs | page | RMDs from the year of 73, prior 31 December balance, first-year timing |
| Rev. Proc. 2022-38, 2023-34, 2024-40 | https://www.irs.gov/pub/irs-drop/rp-22-38.pdf (and `rp-23-34.pdf`, `rp-24-40.pdf`) | `6c20f8a6c9a3bdf4251fcf50dbf2e2382abc8cbeb1e5e2d3eecdc38b2cbf6bbf` , `544ba41c7ba64f77da521e0d174a7b7394dc72b5c7c73d10adb19952d5aaae57` , `4de9db6b6662b5c305a59100a027051628823b42fd5817ea4e383ad4c302af1f` | the rounding structure: in every year 2023 to 2027 the single thresholds 1 to 5 are exact halves of the joint ones; the 2023 single 37% threshold is $578,125 and the 2023 and 2024 single 0% gains maxima are $44,625 and $47,025 (multiples of $25, not $50) |

### 10.2 Secondary sources (search results; the primary host is refused)

Recorded by the two designers and two judges, plus one search of this session:

- 2027 Social Security figures (COLA 3.6%, wage base $192,300, earnings-test amounts $25,560 and $67,920; 2026: 2.8%, $184,500, $24,480 and $65,160): https://www.ssa.gov/news/en/cola/factsheets/2027.html (as quoted by search), https://www.kiplinger.com/retirement/social-security/2027-social-security-cola-is-3-6-percent , https://www.journalofaccountancy.com/news/2026/oct/social-security-wage-base-and-cola-announced-for-2027/ , https://www.asppa-net.org/news/2026/10/social-security-cola-increase-for-27-biggest-in-5-years/ , https://www.payroll.org/news-resources/news/news-detail/2026/10/14/social-security-wage-base-increases-to-$192-300-for-2027 , https://www.countrytaxcalc.com/tax-guides/usa/social-security-cola-2027/ . This session's search confirmed the COLA, the wage base and $25,560 from the SSA fact sheet's snippet and $67,920 from a secondary table.
- Reduction and credit formulas: SSA Handbook §724 https://www.ssa.gov/OP_Home/handbook/handbook.07/handbook-0724.html , https://www.ssa.gov/oact/quickcalc/earlyretire.html , https://www.aarp.org/social-security/faq/how-much-does-early-retirement-reduce-benefits , https://www.maximizemysocialsecurity.com/ask-larry/why-are-early-spousal-benefits-reduced-higher-rate .
- Full retirement ages and delayed credits: CRS R44670 https://www.everycrsreport.com/files/20161028_R44670_e1079b2a317f7ea780821933da2f77793ee66eea.html , https://www.ssa.gov/OACT/quickcalc/early_late.html , https://www.nasdaq.com/articles/what-full-retirement-age-2026 .
- Survivor ages and reduction: https://www.ssa.gov/benefits/survivors/1957s.html , https://www-origin.ssa.gov/benefits/survivors/survivorchartred.html , https://financialducksinarow.com/14687/fra-for-retirement-benefits-vs-fra-for-survivor-benefits/ .
- Widow(er)'s limit (82.5%) and the 71.5% rate at 60: CRS IF12091 https://www.everycrsreport.com/reports/IF12091.html , https://www.maximizemysocialsecurity.com/ask-larry/where-did-825-rate-widower-benefits-come , https://ssa.gov/policy/docs/workingpapers/wp92.html .
- January rule for delayed credits: POMS RS 00615.690 https://secure.ssa.gov/poms.nsf/lnx/0300615690 , https://financialducksinarow.com/11345/delayed-retirement-credits-when-are-these-applied/ .
- Spousal excess against own delayed credits; deemed filing: https://www.maximizemysocialsecurity.com/ask-larry/how-will-my-spousal-benefit-rate-be-calculated-if-i-recieve-drcs-my-own-record , https://financialducksinarow.com/10881/new-deemed-filing-rules/ , https://financialducksinarow.com/4060/deemed-filing/ .
- Rounding and COLA application: https://www.ssa.gov/oact/cola/colaapplic.html , POMS RS 00601.020 https://secure.ssa.gov/poms.nsf/lnx/0300601020 ; no negative COLA and the comparison quarter: https://www.everycrsreport.com/reports/94-803.html .
- 2026 Trustees Report (retirement trust fund reserves run out in the fourth quarter of 2032; 78% payable): https://www.ssa.gov/OACT/TR/2026/II_E_conclu.html (as quoted), https://www.everycrsreport.com/files/2026-06-25_IF13256_e1a3332f1a9ae29c3698a1f2e5a5a1d598ec6c57.html .
- RMD ages 73 (born 1951 to 1959) and 75 (1960 and later): https://www.plansponsor.com/irs-proposes-regulations-for-changes-to-secure-2-0-rmds/ , https://irahelp.com/slottreport/whats-the-first-rmd-year-for-those-born-in-1959 , https://thelink.ascensus.com/articles/2024/10/16/more-changes-for-rmds .
- Rev. Proc. 2026-35 coverage: https://www.journalofaccountancy.com/news/2026/nov/irs-announces-inflation-adjustments-for-tax-year-2027/ , https://kpmg.com/us/en/taxnewsflash/news/2026/11/rev-proc-2026-35-inflation-adjustments-2027.html .
- 2027 plan-limit forecasts (not used as data): https://401kspecialistmag.com/2027-401k-contribution-limits-all-but-official-25500-expected/ , https://401kspecialistmag.com/2027-401k-contribution-limit-projected-at-25000/ , https://www.milliman.com/en/insight/2027-irs-limits-forecast-july , https://www.napa-net.org/news/2026/9/2027-retirement-contribution-limits-come-into-focus/ . This session's search found a deferral forecast of $25,500 superseding an earlier $25,000, and an early-year forecast that left the age-50 catch-up at $8,000 where design A's sources had $8,500.
- Chained CPI running about a quarter point below CPI-U: https://www.cbo.gov/budget-options/2013/44797 , https://www.brookings.edu/articles/the-hutchins-center-explains-the-chained-cpi . Indexing method: https://thinkadvisor.com/tax-facts/2024/03/13/8512-what-indexing-factor-does-the-irs-use-to-make-the-adjustments-for-inflation .
- IRC §63(c) (joint standard deduction is 200% of the single amount), cited by judge 2: https://www.govinfo.gov/content/pkg/USCODE-2023-title26/pdf/USCODE-2023-title26-subtitleA-chap1-subchapB-partI-sec63.pdf (not fetched here).
- Repeal of the windfall and government pension offsets (so no such adjustment exists): https://www.everycrsreport.com/reports/IF12890.html .

### 10.3 Unverified (the implementer checks each against the primary source before the gate)

1. **Every Social Security rule and figure** (`www.ssa.gov` refused): the 2026 and 2027 COLA, wage base and earnings-test amounts; the reduction and credit fractions; the full-retirement-age table (the survivor rows are derived by the two-birth-year shift and were not confirmed row by row); deemed filing; the 82.5% limit and the order "reduce for age, then cap"; the spousal excess being reduced by the spouse's own delayed credits; the January posting of delayed credits; truncation to the dime and the dollar (one POMS excerpt in a designer's search said "next higher" for one step); the earnings-test credit-back in whole months.
2. **`colaHistory` 2017 to 2025** (0.3%, 2.0%, 2.8%, 1.6%, 1.3%, 5.9%, 8.7%, 3.2%, 2.5%): from memory; this session's one search confirmed only 3.2% for 2024 before the search budget ran out. Check against https://www.ssa.gov/oact/cola/colaseries.html . Fallback: delete the years that cannot be confirmed; `compileSsPlan` then treats an older statement as the first remaining year minus one, with `ss_statement_old`.
3. **The 2027 retirement-plan limits** (deferral, both catch-ups, §415(c), IRA and its catch-up): not published on 2026-11-10; the 2027 file carries the 2026 amounts as `pending`. Replace from the IRS notice.
4. **RMD age 75 for people born in 1960 or later and 73 for 1959**: the IRS pages fetched state 73 only; 75 and the 1959 reading rest on the 2024 proposed regulations as reported by secondary sources. It matches the spec.
5. **The statutory rounding rules**, whose Code text could not be fetched: $50 steps with the joint standard deduction at 200% of single (§63(c)); bracket and 0% gains thresholds with single at half of joint and $25 granularity (§1(f)(7), §1(j)); nearest $50 for HSA limits (§223(g)); nearest $300 for the wage base and nearest $10 a month for the earnings test (Social Security Act §230, §203(f)(8)); $500, $1,000 and $100 steps for the plan and IRA limits. The published tables for 2023 to 2027 are consistent with every one of them, and they affect only years after 2027.
6. **Every number in `tax-drag.json`** (dividend yields 1.3%, 2.8%, 3.5%; qualified shares 95%, 75%, 0%; bond spread 1.0%; `fallbackCashYield` 3%): modelling assumptions, not sourced figures.
7. **The Trustees figures** behind `ss_trust_fund_shortfall` (2033, 78%): two secondary sources. **The family maximum's range** (150% to 188% of the PIA), on which decision 39 rests: from the designers' knowledge, no source fetched.
8. **The placeholder in Rev. Proc. 2026-35** ("[Release Date, 2026]" in section 1 of the PDF as retrieved): the figures agree with the press coverage, but the file must be re-fetched and re-hashed if the IRS replaces it.
9. **No run-time figure in this document is a measurement** (3.5).

### 10.4 Judges' claims checked for this merge

Against the fetched documents: the 2026 items of Rev. Proc. 2025-32 are in its Section 4 (4.01, 4.03, 4.14), as both judges said (design A cited Section 3, which modifies the 2025 items); section 1 of Rev. Proc. 2026-35 contains the unfilled placeholder; every 2026 and 2027 bracket, cumulative amount, standard deduction, age addition and gains threshold in section 2.2 matches the revenue procedures; the Uniform Lifetime divisors, the publication's RMD examples and Publication 915's Examples 1 and 3 match; Schedule 1-A confirms the 6% phase-out; the IRS limit table shows 2026 as the newest year. Against the repository at `786cb0d`: `packages/shared/src/wire.ts` has `CentsString` (signed), `NonNegCentsString`, `CentsInput` and `NonNegCentsInput` and no `SignedCentsString`, and `looseWireFields` makes the API refuse loose shapes in request contracts; `PlanError` is declared in `packages/db/src/services/audit.ts`; `tsconfig.base.json` is `NodeNext` with `resolveJsonModule`; `scripts/bundle.mjs` uses esbuild and bundles `@meridian/*` from source; the runner honours `{ permanent: true }`; the auth plugin honours `config.readOnly`; Zod is `^3.24.1`. The joint table was re-validated from design A's file (symmetry, monotone rows, the 368,500.6 sum, the spot values, the single age-112 difference) before conversion to JSON.

### 10.5 The `sources` entries of the data files not listed in full in section 2

| File | Entries (title, URL and SHA-256 as in 10.1; `sha256: null` for hosts that could not be fetched) |
| --- | --- |
| `tax/rules.json` | Rev. Proc. 2025-32 and 2026-35 (the tables the steps were read from); Rev. Proc. 2022-38, 2023-34 and 2024-40 (the rounding structure); the IRS page on the 2025 act's deductions (the 2028 sunset); the 2026 Trustees Report, https://www.ssa.gov/OACT/TR/2026/II_E_conclu.html (null) |
| `ss/rules.json` | SSA Handbook §724, https://www.ssa.gov/OP_Home/handbook/handbook.07/handbook-0724.html (null); SSA, effect of early or delayed retirement, https://www.ssa.gov/OACT/quickcalc/early_late.html (null); POMS RS 00615.690, https://secure.ssa.gov/poms.nsf/lnx/0300615690 (null); SSA COLA series, https://www.ssa.gov/oact/cola/colaseries.html (null) |
| `rmd/joint-life.json` | Publication 590-B (2025), Appendix B, Table II |
| `taxable/tax-drag.json` | Publication 551 (step-up shares and the community-property states); a note that the yields and the spread are this design's assumptions |

## 11. Open questions

1. **Network.** `www.ssa.gov` (and a host with the Code's text) must be allowed before the items of 10.3 can be closed. Should the gate wait for that, or accept the Social Security rules on the secondary sources listed?
2. **The 2027 plan limits.** Ship the first data version with the six amounts pending (this design), or hold the data version until the IRS notice, due within days?
3. **Law changes.** The merged run settings carry one rule set id. Should the envelope carry a list of law-change ids instead, so an owner can combine any two (design B's shape, which one judge preferred), and should an owner be able to author a law change in the UI at all?
4. **`TaxSettings`.** Does the run-settings envelope take the `tax` block (section 9), or do the wedge, wage growth, payroll switch and yield overrides stay data-only in v1?
5. **Challenge to the first-year rule (L3).** The frozen input's nearest-month rule is adopted here. It makes a plan run on the 16th start a month later than one run on the 15th; day-exact prorating would change only `f`, and the tax function is indifferent. One rule must stay in `SimInput`.
6. **The chained-CPI wedge** defaults to 0 (matches most independent calculators and L7). Should the default scenario use 25 basis points, which is closer to the statute and lowers real thresholds by about 7% over 30 years?
7. **Survivor timing.** The widow(er)'s benefit starts as soon as the survivor is 60. Waiting until survivor full retirement age while living on the own benefit is a claiming strategy: v1 option, or Phase 5 with the claiming-age search?
8. **Payroll tax.** Keep it as a separate line with a switch (this design), or leave it out of v1 as the spec's list does?
9. **Existing Roth accounts.** The five-year period is assumed met and pre-plan conversions are not known. Should the profile ask for the first-contribution year and recent conversions now, since early retirees with a conversion ladder are exactly the households that withdraw Roth money early?
10. **Unknown basis as 0** (inherited from inputs-and-data) taxes every dollar of such an account as gain. Is a visible warning enough, or should a run be blocked until the owner enters a basis for a large account?
11. **Default yields.** The numbers in `tax-drag.json` are this design's assumptions; Phase 3 can measure each account's trailing dividends and interest. Seed them from the measurements in v1 or v2?
12. **Who owns the annual refresh?** The runbook is a November task for the owner; a reminder (an alert when `stale` turns true) is cheap to add in Phase 6.
13. **`ss_shortfall_2033` and `rates_plus_2pts_2031`** are scenarios, not forecasts. Ship them in v1, or only `current_law` and `senior_deduction_permanent`?

## 12. Judging record

Scores (correctness / spec fidelity / codebase fit / testability):

| | Design A | Design B | Winner |
| --- | --- | --- | --- |
| Judge 1 | 8.5 / 8.5 / 7 / 8.5 = 32.5 | 7.5 / 7.5 / 8.5 / 9 = 32.5 | A, "narrowly" |
| Judge 2 | 9 / 9 / 7.5 / 9 = 34.5 | 7 / 7 / 8 / 8.5 = 30.5 | A |
| Total | 67.0 | 63.0 | A |

Judge 1's notes give 33 against 32.5; the four scores it reported sum to 32.5 each, and it named A the winner. Both judges re-ran every hand-calculated case of both designs and found none wrong; both said A is the better base on the law and B the better base on structure.

Taken from A: the statute-first tax function with worksheet lines and its outputs; indexing by path inflation with the wedge as an option; the rounding that keeps single at half of joint and the joint standard deduction at twice single; nearest-step rounding for HSA limits, the wage base and the earnings test; every per-year amount in the year record; the capital-loss carryover; the Joint and Last Survivor table (now a JSON module); the basis step-up at death; the Roth five-year clock; SSA's truncations, the January rule, the COLA high-water rule and the earnings test with its credit-back; exact fractions for the factors; the Social Security preview; the worksheet lines in the tax preview; the data invariants (halves, doubles, cumulative amounts, table sums and spot values); the bench file kept out of the gating suite; most of the test cases.

Taken from B: one immutable file per published year with its provenance; typed law-change operations (`replaceSchedule`, `shiftOrdinaryRates`, `freezeIndexing`, `scaleSocialSecurity`), rule set ids as strings validated at compile, and the `illustrative` flag; the bond and cash interest model (cash return plus a spread, with a fallback); value and basis per asset class, so rebalancing realizes the gain of the class sold; `earlyFraction` in place of a whole penalty-free year; Social Security in the first year counted by the months in the plan; the Roth layer layout and `rothRollYear`; the IRA limit capped by wages and the HSA limit prorated by months before 65; overflow of capped contributions to a taxable account; the not-modelled list as data with a pin per entry; run warnings with amounts; the solver contract (continuity, monotonicity, the slope bound); Publication 915's Examples 1 and 3, the Publication 590-B example, the "smaller of" case and the status-switch case as test anchors; lettered test groups mapped to files; `assertTaxInput` outside the loop; the note on the Rev. Proc. 2026-35 placeholder; the observation that `account` has no owner column.

Flaws the judges named, and how each is resolved where it is not obvious from the lists above: the CSV became a statically imported JSON module with its own recorded hash; the wall-clock test is gone and staleness is a function of the injected `today`; the Rev. Proc. 2025-32 citation is corrected to Section 4; "sixteen" cumulative amounts is 24; whole-return bond interest is replaced by the yield model; the survivor is a rollover owner everywhere, with the lost beneficiary exception listed in 8.2; the Social Security year is a month loop with its inputs, state and outputs defined slot by slot, no context object and no limit on the number of changes inside a year; rule set ids are data and law-change paths are an enumerated list, with no free-form patches from the API; the package throws `TaxDataError` and never imports `PlanError`; the monotonicity property enumerates its inputs and states the three that run the other way; expected values printed to the cent have a stated tolerance; the survivor case that had no number has one (H8g); the partial-year scaling works on locals and a test asserts the input is untouched; request contracts use the bounded wire shapes; JSON imports use import attributes; the HSA limit is prorated and listed; `BRACKET_RATE` is 0 while deductions are unused and `UNUSED_DEDUCTION` is an output; B's default wedge, independent $50 floors, floor rounding for HSA and earnings-test amounts, flag-only earnings test, static five-year flag, January birth month and heap assertion inside the gating suite are not carried over.

Where a judge or both source designs were overruled:

- **Law-change composition.** Judge 1 asked for a scenario to store a list of law-change ids. The merged run settings of inputs-and-data already carry one `taxRuleSet` string, so composition lives in the data (a rule set lists its law changes) and the list form is open question 3.
- **The 2027 plan limits.** Both judges said to keep A's forecasts marked "projected". The forecasts on record disagree (deferral $25,000 and $25,500; age-50 catch-up $8,000 and $8,500; no second source for the other four), and inputs-and-data requires that the file not carry a forecast as published. The 2026 amounts are carried as `pending` instead: a known lower bound, identical on every path, replaced when the notice appears.
- **The first-year rule.** Both designs used `f = (12 − month) / 12` and both judges noted they agree. The merged frozen input fixed a different rule (nearest month boundary, `firstYearMonths`); L3 wants one rule, so this area adopts it and raises the difference as open question 5.
- **Unknown basis.** Both designs assumed half the value with a flag; inputs-and-data decided 0 unless entered, and the frozen input carries the basis, so this area assumes nothing (open question 10).
- **Birth month default.** The judges preferred A's July default over B's January. The merged profile requires the birth month, so no default exists.
- **Scope.** Judge 1 called A's scope heavy for v1 (earnings test, joint table, SSA rounding, January rule, payroll tax, limits, custom patches); judge 2 counted the same items in A's favour. All are kept except the custom patch editor, because each closes a v1 input combination that would otherwise be wrong by thousands of dollars or would fail the gate's comparison; the cost is the verification list of 10.3.
- **The kink form.** Judge 1 offered B's branch-free bracket sum as an optional graft. It is not adopted: the table stores the tax at each bracket bound, which the data test compares with the amounts the IRS prints, and a scan of seven entries costs the same.
- **Per-class basis.** Judge 1 called it optional, judge 2 a flaw of A. It is adopted: the frozen input gives class weights per account, the engine needs class values to rebalance anyway, and the worked example of 3.6 shows the understatement it removes (1,164.54 against 1,700.21).
