# Retirement planner data

Everything the engine knows about law, tables and history is in this directory. Nothing is fetched at run time. `manifest.json` lists every file here (except itself) with its SHA-256; `dataVersion` names the set, and every run records it. `DATA_CHECKSUM` (exported by `src/version.ts`) is the SHA-256 of the files' hashes joined by `\n` in manifest order, with no trailing newline.

| File | What it holds | Source |
| --- | --- | --- |
| `us-annual-returns.csv` (+ `.meta.json`) | stocks, bonds, bills, inflation, 1928 to 2025 | Damodaran, `histretSP.xlsx`, sheet "Returns by year" |
| `irs-2010cm-life-table.csv` (+ `.meta.json`) | `l_x` at ages 0 to 110, unisex (the fallback mortality table) | IRS Table 2010CM |
| `ssa-period-life-table.csv` (+ `.meta.json`) | not installed yet (see below) | SSA period life table |
| `tax/federal-YYYY.json` | one published tax year: brackets, deductions, gains thresholds, limits, payroll, Social Security amounts | revenue procedures, IRS notices, SSA fact sheet |
| `tax/rules.json` | indexing steps, law changes, rule sets, `staleInflation` | the revenue procedures (rounding structure), IRS fact sheet, Trustees Report |
| `ss/rules.json` | full retirement ages, reduction and credit fractions, survivor constants, COLA history, a `verification` mark per figure | SSA (refused by the build host; secondary sources named per figure) |
| `rmd/uniform-lifetime.json` | Table III divisors and the RMD start ages | Pub. 590-B (2025), IRS RMD FAQs |
| `rmd/joint-life.json` (+ `joint-life.meta.json`) | Table II, 101 x 101 | Pub. 590-B (2025) |
| `taxable/tax-drag.json` | yield assumptions of taxable accounts; basis shares at death | assumptions; Pub. 551 |

`src/generated/data.ts` is generated from the CSV files by `node packages/retirement/scripts/build-data.mjs` and committed; `data.test.ts` fails when it is stale (`--check` does the same from the command line). The JSON tables are imported statically (`import ... with { type: "json" }`) by `src/tax/taxData.ts`.

## Rules for every edit

- Every external figure names its document, section, retrieval date and the document's SHA-256 (or `null` for a web page or a refused host) in the file's `sources` or its `.meta.json`.
- Any change to any file here changes its hash: update `manifest.json` (hash, retrieval date) and bump `dataVersion` (`YYYY.MM.N`). Old runs keep the version they recorded; re-simulating one of their paths is refused once the version moved (`engine_changed`).
- Never type a forecast into a year file. A figure the agency has not published yet is carried at the previous year's amount and listed under `pending` (runs that read it carry `limits_pending`).
- Social Security figures carry `verification` in `ss/rules.json`: `primary` (read in an SSA or IRS document), `secondary` (two independent published sources agree, both named) or `unverified`. A `colaHistory` year below `secondary` is deleted, not kept.
- Run `pnpm --filter @meridian/retirement test` (the data suite recomputes every hash and asserts every validation figure) and `pnpm typecheck`.

## Annual refresh (each November)

1. **Tax tables.** When the IRS publishes the revenue procedure for year N+1 (late October or November; `https://www.irs.gov/pub/irs-drop/`), add `tax/federal-(N+1).json` as a full copy of the previous year file and replace, from its section "Adjusted items": Tables 1 and 3 (`ordinary.thresholds`), the maximum zero and 15 percent rate amounts (`capitalGains`), the standard deduction and the additional amount for the aged. Statutory amounts (senior deduction, Social Security taxation bases, NIIT, loss limit, penalty rates, payroll rates and Additional Medicare thresholds) are repeated unchanged unless a law changed them. Record the PDF's SHA-256 in `sources`.
2. **Retirement-plan limits.** From the IRS notice on plan limits (`https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions` links it; the 2026 notice appeared on 13 November 2025): deferral, catch-up at 50, catch-up at 60 to 63, the § 415(c) limit, the IRA limit and its catch-up. Replace the carried amounts and empty `contributionLimits.pending` (also in the current year's file if it still lists fields).
3. **HSA limits.** From the HSA revenue procedure (published in May for the next year): `hsaSelf`, `hsaFamily`. The $1,000 catch-up at 55 is statutory.
4. **Social Security amounts.** From the SSA fact sheet of October (`https://www.ssa.gov/news/en/cola/factsheets/N+1.html`): the COLA first paid in January N+1 (`socialSecurity.cola`), the taxable maximum (`payroll.oasdiWageBase`) and the two earnings-test amounts. The year's COLA lives in its year file; `ss/rules.json` `colaHistory` is never extended. Where the SSA host cannot be read, give two independent published sources in the source note.
5. **Rules.** Set `lastPublishedYear` in `manifest.json` to N+1. Review `tax/rules.json` for expired or new law changes (for example the senior deduction ends after 2028).
6. **Historical returns (January).** When Damodaran replaces `histretSP.xlsx`, re-extract with the meta file's recipe (sheet "Returns by year", the next data row added; never "Nominal vs Real Data"), regenerate `src/generated/data.ts`, and replace the expected values of the return series in `data.test.ts` with values computed from the new file. If the workbook cannot be read, keep the committed CSV and say so in its meta file.
7. Update every changed hash in `manifest.json`, bump `dataVersion`, run the suite.

## Installing the SSA period life table (when `www.ssa.gov` can be read)

`ssa-period-life-table.csv`: header `age,male_qx,female_qx`, 120 rows (ages 0 to 119), six decimals as published, from `https://www.ssa.gov/oact/STATS/table4c6.html` (archive copies `table4c6_YYYY_TRYYYY.html`), with a `.meta.json` naming the table year and Trustees Report. Add both files to the manifest, run `build-data.mjs` (it then fills `LIFE_SSA_MALE_QX` and `LIFE_SSA_FEMALE_QX`), add the checks of seams §8 D4 to `data.test.ts` (120 rows; every `qx` in (0, 1]; non-decreasing from 40; `l_x` rebuilt from 100,000 within 1 of the published column; life expectancy within 0.02 years at 60, 65, 70, 80, 90), and bump `dataVersion`. No code change is needed: with the file present the engine uses it and the run says `ssa_period`.
