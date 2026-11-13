# Phase 4 build plan: Retirement planner v1

Source of truth: the design spec linked from `CLAUDE.md`. Scope of this phase (spec, "Build phases", item 4): household inputs, the three return models, the withdrawal strategies, federal tax, RMDs, Social Security, the fan chart and the year-by-year table. Gate: the hand-calculated test suite passes, and a reference scenario lands within tolerance of an independent calculator.

Four area designs were produced by independent designers, scored by judges and merged; a seam critic then read all four against the spec and the code. They live in `docs/design/phase-4/`:

- `inputs-and-data.md`: the planner's tables, the household profile document, scenarios as merge patches, the baseline seeded from live data, the resolver, the frozen run input (`SimInput`), the `retirement.simulate` job, result storage and retention, the API routes, the dashboard card's data.
- `engine-and-returns.md`: the `@meridian/retirement` package, units, the random number generator, the three return models and the fixed test model, mortality, the year loop, trades and basis, aggregation, the thread pool, versions and the digest.
- `tax-rmd-ss.md`: the federal tax function and its slot layouts, the yearly law tables and their indexing, penalties and Roth basis, RMDs, Social Security, contribution limits, payroll tax, the taxable-account yield assumptions, the rule sets.
- `strategies-outputs-web.md`: the five withdrawal strategies, the default withdrawal order and the gross-up solver, the result shapes, the web pages, the hand-calculated suite and the reference scenarios R1 to R4.
- `seams.md`: the critic's rulings (§1), the reconciled contract (§2), every conflict with its resolution (§3, C1 to C52), one household through one year (§4), spec gaps (§5), contradicted decisions (§6), what Phase 5 needs left in place (§7), the data files (§8), unverified figures (§9), expected values to re-derive (§10), the build order (§11).

Precedence: the spec, then **this document**, then `seams.md`, then the area design. Where an area design and `seams.md` disagree, `seams.md` wins; where this document and `seams.md` disagree, this document wins. An implementer builds from the area design for the algorithms, contracts and test cases, with the names and shapes of `seams.md` §2 and the decisions below. A section of an area design that `seams.md` says is "not built" is not built, even where another section of the same design still refers to it.

## Lead decisions the designs were written to (L1 to L8)

- **L1. Engine package and units.** `packages/retirement` (`@meridian/retirement`) is a pure TypeScript package. Inside it money is float64 dollars; at the boundary money is integer cents, converted once in each direction and rounded half away from zero. Nothing outside the package does money arithmetic in floats.
- **L2. Household.** One or two people. One person files single; two file married filing jointly; after a first death the survivor files single from the following year.
- **L3. Time step.** Annual steps (`stepsPerYear` is the literal 1) with one rule for the first, partial year.
- **L4. Dollars.** The simulation is nominal with stochastic inflation per path; every reported figure is also given in today's dollars.
- **L5. Randomness.** A counter-based generator keyed by (seed, path, purpose, step), so path `k` is the same for any thread count, chunking or order, and one path can be re-simulated alone.
- **L6. Withdrawals.** One default withdrawal order behind an interface, plus an optional Roth conversion schedule the owner types. No search or optimizer in v1.
- **L7. Data.** Versioned data files under `packages/retirement/data/` with provenance for every file; one data version; every run stores its full input snapshot, the engine version and the data version.
- **L8. Ownership.** Four areas own their files: inputs-and-data, engine-and-returns, tax-rmd-ss, strategies-outputs-web. A function is written once, by its owner, and called by the others.

## Reconciled decisions (binding)

1. **Every ruling of `seams.md` is accepted**: the twelve of §1, the contract of §2, the resolutions C1 to C52 of §3, the Phase 5 provisions F1 to F13 of §7 ("Do now" column; F9's two extra series are built), and the re-derivations of §10. The points below are the calls §12 left to the lead, and the few places this plan adds to or changes the report.
2. **First partial year by months** (C14): `f = plan.firstYearMonths / 12` everywhere. No day fraction exists anywhere in the code.
3. **Fund costs** (C25): `SimInput.accounts[].expenseRatioPpm`, seeded from the measured, value-weighted expense ratio of the account's positions, editable per account, 0 with the warning `expense_ratio_unknown` when nothing is measured. Reference scenarios set 0.
4. **Bond interest** (C18): `max(0, previous year's bill return + spread)` on the post-trade bond balance; the bill slice of a taxable account starts with basis equal to its value.
5. **Payroll tax and contribution limits** (C26, C27): employee payroll tax is on by default (`TaxSettings.includePayrollTax`), shown as its own line; contributions are capped at the indexed limits and the excess goes to the surplus account after tax.
6. **Default return model** (C51): a new scenario runs `{ kind: "bootstrap", meanBlockYears: 10 }` with 10,000 paths and seed 1.
7. **Historical cohorts**: the default stays `auto` as the engine design defines it (complete cycles when every person has a fixed life expectancy and at least 30 complete cohorts exist, wrap-around otherwise). The result states the mode and the first and last start year, and the run-settings form offers `complete` and `wrap` explicitly. Reason: complete cycles are what the published studies and the reference scenario R3 use, and a wrap-around sequence (2025 followed by 1928) never happened; where too few complete cycles exist, wrapping and saying so is better than refusing to run.
8. **Taxable accounts are fully rebalanced each year by default** (`portfolio.taxableRebalance: "full"`), which realizes gains in the year of the trade; `flows_only` is a per-scenario setting. The Results page's assumptions list names the mode. Reason: it keeps every account at the allocation the owner typed, matches the studies the reference scenarios are compared with, and errs toward more tax.
9. **Healthcare amounts are kept when included in base spending** (C35): the frozen entries carry the amounts and `inBase`; the HSA's qualified cap is the entered amount either way.
10. **R1 and R2 are regenerated** under the statutory rounding of thresholds and SSA's rounding of benefits (C50). No switch exists that turns either off. Until regenerated, no R1 or R2 figure from 2028 on, nor HC-T15, HC-S3, WD-5 or WD-15, is an expected value.
11. **Social Security figures stay flagged.** `www.ssa.gov` refuses automated requests from the build environment, so every figure in `seams.md` §9 items 1, 2, 6, 8 and 17 is built as designed and listed for the owner in `docs/phase-4-gate.md`. The mortality table is the IRS Table 2010CM (unisex) until an SSA period life table is installed; with it `sex` has no effect, the run carries `mortality_fallback_table`, and the profile form says the table is unisex. The loader accepts `ssa-period-life-table.csv` when the file is present and listed in the manifest, so installing it later is a data change (new `dataVersion`), not a code change. Every figure in `ss/rules.json` carries a `verification` value in its source block: `primary` (read in a primary document), `secondary` (two independent published sources agree, both named) or `unverified`. A COLA history year is kept only when it is at least `secondary`; other years are deleted (the tax design's own fallback, warning `ss_statement_old` when a statement is older than the history covers).
12. **The independent calculator is TypeScript** under `packages/retirement/reference/`, imports nothing from `src/` (a source scan test enforces it) and is written from the reference sheets by an implementer who has not read `src/`. It carries its own transcription of the tax figures, its own trade arithmetic, a bisection gross-up and its own random number generator.
13. **A second, outside comparison is the owner's** and is not a gate condition of the code: `docs/phase-4-gate.md` gives the inputs of R3 and R4 so they can be typed into a public calculator, with the figures to compare.
14. **Spec gaps G1 to G14 of `seams.md` §5 are closed as proposed there**: the custom parametric form (G2) and the household glide-path editor (G3) are built; the others are kept and flagged in "Deviations" below.
15. **Stored documents hold no floats and no nulls** (inputs decision 2, C3). Price levels are nine-decimal fixed-point strings (C43). Basis-point ratios computed outside the engine truncate; ratios computed inside it from float64 are rounded half away from zero at the boundary (C44).
16. **Names**: `depletionYear` / `depletion_year` (C46); bucket keys are the members of `PlanBucket` (C45); `RETIREMENT_THREADS` (C10); migration `0007_phase4_retirement` or whatever index `pnpm db:generate` assigns after the migrations then on the branch (C49).

## Package layout for Phase 4

```
packages/retirement/                 @meridian/retirement (depends on @meridian/shared and zod)
  data/                              versioned data files, manifest.json, README.md (the refresh runbook)
  scripts/build-data.mjs             generates src/generated/data.ts from the CSV series
  reference/                         the independent calculator and fixtures (imports nothing from src/)
  src/units.ts, detmath.ts, version.ts, selftest.ts
  src/tax/                           layout, taxData, compile, federalTax, penalties, rothBasis, rmd,
                                     socialSecurity, contributionLimits, payroll, taxDrag, warnings, rulesView
  src/rng.ts, src/models/, src/mortality.ts
  src/prepare.ts, trades.ts, loop.ts, hooks.ts, assess.ts
  src/strategies/, src/withdrawals/, src/results/
  src/aggregate.ts, src/index.ts     exports "."
  src/node/                          the pool and thread entry; exports "./node"
  src/testing/                       stubs on the real slot layouts; exports "./testing"
packages/shared/src/retirement/      every wire and document schema of all four areas, and the pure helpers
packages/db/src/schema/retirement.ts, services/retirement*.ts, test/retirementSeed.ts
apps/api/src/routes/retirement.ts, views/retirement.ts
apps/worker/src/jobs/retirementSimulate.ts, simThread.ts
apps/web/src/pages/retirement/, components/retirement/, components/charts/retirementOptions.ts
```

Where an area design names a file differently inside its own directory, the design's name stands; the directories above are fixed. `apps/web` imports `@meridian/shared` only (C47).

## Build order

The 31 steps of `seams.md` §11 are the build order, with what proves each step. They run in two stages because the audit remediation of Phases 1 to 3 is still landing on the same branch.

**Stage A: the pure engine (steps 1 to 22).** Everything here is new files under `packages/retirement/` and `packages/shared/src/retirement/`, plus the workspace wiring of step 1 limited to the new package, the root ESLint block and one export line in `packages/shared/src/index.ts`. The wiring of step 1 that touches `apps/api`, `apps/worker` and the Dockerfiles moves to step 27. After step 4, three lanes run side by side: the tax functions (6 to 11), the return models and trades (12, 13, 15), and the strategies' pure parts (18). They meet at steps 14, 16 and 17; steps 19 to 22 follow in order.

**Stage B: database, worker, API, web, gate (steps 23 to 31).** Starts when the remediation's final verification is green on the branch (K11), so the migration index, the service exports and the route registrations are added once, on settled code.

Step 5 (regenerating R1 and R2) is done by a scratch reference written from the amended sheets; the amended sheets are committed as `packages/retirement/reference/sheets/r1.md` to `r4.md` so that the independent calculator of step 22 has one document to be written from. The three-way agreement of step 22 is then: the scratch figures recorded in the sheets, the independent calculator, the engine.

Each implementer reports what was built, the tests added and their result, anything in the design that could not be built as written, and every figure it could not verify. A design figure that the implementation contradicts is re-derived by hand in the test file's comments, never adjusted to match the code without a derivation.

## Data files

The table of `seams.md` §8 (D1 to D18) is binding: paths, formats, sources, SHA-256 values and validation figures. `manifest.json` starts at `dataVersion: "2026.11.0"`. Every external figure in a data file names its source document, section and retrieval date in the file's `source` block or its meta file. `data.test.ts` recomputes every hash and asserts every validation figure of the table. D4 (the SSA life table) is absent at first commit (decision 11).

Checked against primary documents during design: the 2026 and 2027 brackets, standard and age deductions and capital gains thresholds (Rev. Proc. 2025-32 and 2026-35), the 2026 plan and IRA limits (Notice 2025-67), the 2026 and 2027 HSA limits (Rev. Proc. 2025-19 and 2026-24), the Uniform Lifetime and Joint and Last Survivor tables (Pub. 590-B, 2025), the basis rules at death (Pub. 551), the historical return series (the NYU Stern workbook, sheet "Returns by year") and the IRS Table 2010CM.

## Deviations from the spec (flagged)

1. **Annual steps only** (spec: "monthly optional"). Month windows, the Social Security month loop and `f` keep a monthly engine possible later (G10).
2. **Mortality table**: unisex IRS Table 2010CM until an SSA period life table is installed (decision 11, G4).
3. **Law-change scenarios** are limited to the rule sets shipped in `tax/rules.json`; the owner cannot write one in v1 (G7).
4. **Contributions are seeded from measured flows into investment accounts**, not from the budget's savings categories; saving into bank accounts is not seeded (G8).
5. **The planner also writes `job` and `audit_log`**, and two tables beyond the spec's three (G9).
6. **The API re-simulates one path** for a percentile that is not stored; it never starts threads and never runs more than one path per request (G11). After an engine or data upgrade only the seven stored percentiles of an old run remain viewable (G12).
7. **Before the first retirement neither spending nor take-home pay is modelled**, so a shortfall before retirement cannot show; the Results page says so (G13, C52).
8. **The dashboard card shows the newest finished run of the default scenario**, not of any scenario (G6).
9. **Two unmarried people in one household are treated as married filing jointly** (L2).
10. **Historical sequences**: with complete cycles, start years whose window would run past the last year of the record are left out; the result names the first and last start year (decision 7, G5).
11. **State tax, IRMAA, ACA subsidies, the Roth conversion optimizer, the solvers and scenario comparison** are Phase 5 (spec: planner v2). v1 leaves the hooks of `seams.md` §7 in place.
12. **Taxable accounts hold three simulated assets** (stocks, bonds, bills) with average-cost basis per asset, not lots; the six asset classes are blended into them by the asset map (C17).

## Unverified figures

`seams.md` §9 is the list. Items 1, 2, 6, 8 and 17 (Social Security and the SSA life table) cannot be checked from the build environment and go to the owner in `docs/phase-4-gate.md`. Items 3 (2027 plan limits, not yet published), 4 (RMD ages 73 and 75), 5 (rounding steps), 7 (yield assumptions), 9 to 16 (presets and published study figures) are recorded in the data files' `source` blocks as assumptions or pending values. Items 18 to 20 (performance, golden digests, JSON imports under the toolchain) are measured or settled during implementation and recorded below. Item 21 is closed by step 5.

## Recorded during implementation

- **Scratch material lost (2026-11-13).** The build container was replaced, and the session scratch directory went with it: the downloaded source documents, the data files the designers prepared (`mergeE/out/*.csv`, `mergeT/data/rmd-joint-life.json`) and the strategies designer's Python scratch reference. Every data file is therefore rebuilt from its primary source by step 4 and checked against the SHA-256 values and validation figures of `seams.md` §8. Where a rebuilt file's bytes differ only in layout (D10's JSON), the validation figures decide and the manifest records the new hash. Step 5 writes a new scratch reference (outside the repository) to regenerate R1 and R2; its figures are recorded in the committed sheets.
- **Stage A lanes.** Three worktrees: the engine's mathematics and the year loop (`/home/user/meridian-p4`, local branch `phase-4`), the tax, RMD and Social Security functions (`/home/user/meridian-p4t`, `phase-4-tax`), and the reference sheets with the independent calculator (`/home/user/meridian-p4r`, `phase-4-ref`). Each merges `origin/claude/happy-meitner-vpxg1y` before and after its step and pushes only a tree on which `pnpm typecheck`, `pnpm lint` and the suites it touched pass.

- **Step 4, data files rebuilt (2026-11-13).** Every source document was downloaded again and equals its pinned SHA-256 (the two workbooks, Table 2010CM, Rev. Procs. 2025-32, 2026-35, 2025-19, 2026-24, 2022-38, 2023-34, 2024-40, Notice 2025-67, Pub. 590-B, Pub. 551; Rev. Proc. 2026-35 still carries its "[Release Date, 2026]" placeholder). `us-annual-returns.csv`, `irs-2010cm-life-table.csv` and `rmd/joint-life.json` reproduce the pinned hashes byte for byte, so D10's hash did not change after all; Table II's sources moved to `rmd/joint-life.meta.json`. The 2027 plan limits are still unpublished (six fields `pending`). In `ss/rules.json` every figure carries `verification`: the nine COLA years 2017 to 2025 and every fraction and age limit are `secondary` (two named sources, by web search), the full-retirement-age rows for 1939 to 1942 and the survivor two-year shift are `unverified`; no COLA year was deleted. Static JSON imports (seams §9 item 20) work under `tsc`, Vitest, the esbuild bundle of `scripts/bundle.mjs` (a test in `data.test.ts`) and `tsx` 4.23. `taxable/tax-drag.json` names its interest modes `prior_bill_plus_spread` and `bill_return` (C17, C18) instead of the design's `cash_rate`.

(Filled in as steps land: measured run time and storage, the golden digest, anything built differently from the design and why.)
