# Phase 4 seams: conflicts between the four area designs, spec gaps and the build order

This is the seam critic's report on the four Phase 4 area designs in this directory (`inputs-and-data.md`, `engine-and-returns.md`, `tax-rmd-ss.md`, `strategies-outputs-web.md`), read in full against the spec, `CLAUDE.md`, `docs/phase-2-plan.md`, `docs/phase-3-plan.md` and the lead decisions L1 to L8. Each area design is sound on its own. They do not yet fit together: the engine and the inputs area define two different boundary inputs, three different rules exist for the first partial year, the engine and the tax area each define the taxable-account model, and the gate's two deterministic reference tables were computed under tax and Social Security rules that the tax area then decided differently. Every conflict below has one proposed resolution with its reason. Where two definitions compete, the one that is more correct for a household owner relying on the numbers wins.

State of the evidence:

- Nothing in the repository was changed except this file.
- Repository facts were checked at commit `8958fc6`. `packages/db/drizzle` now holds migrations `0000` to `0006` (`0005_linked_cash_transfers` and `0006_sync_attempts` arrived after the inputs design was written), so the Phase 4 migration is `0007_phase4_retirement` unless the generator assigns a later index.
- The pinned data files exist in the session scratchpad and their SHA-256 values were recomputed during this review and match the designs: `us-annual-returns.csv` (`ded29a46…5e8c`), `irs-2010cm-life-table.csv` (`3ba08d9b…a978`), `rmd-joint-life.json` (`bd8af7bf…5350`), and the source documents `rp-25-32.pdf`, `rp-26-35.pdf`, `n-25-67.pdf`, `rp-25-19.pdf`, `rp-26-24.pdf`, `p590b.pdf`, `p551.pdf`, `histretSP.xls`, `histretSP.xlsx`, `table-2010cm-final.xlsx`.
- One direct request per host was made during this review: `www.irs.gov` and `pages.stern.nyu.edu` answered 200; `www.ssa.gov` still answers 403. Every Social Security figure therefore stays unverified (section 9).
- No figure in this report is a measurement. Numbers used as illustrations are derived by hand from the designs' own rules and are marked where they appear.

## 1. The rulings that change the most code

1. **One boundary input.** `SimInput` (shared, stored, hashed) is the only input the engine accepts. `EngineInput` is not built as a wire or stored type (C1).
2. **The first partial year is counted in months**, `f = plan.firstYearMonths / 12`, everywhere (C14). The engine's day fraction is dropped.
3. **Recurring flows follow month windows**, not calendar years: a salary that ends in June pays five twelfths that year (C15).
4. **The taxable-account mechanics are the engine's** (three simulated assets, one trade list per account, gains taxed in the year of the sale); **the yield assumptions are the tax area's data file** (C17). The tax area's six-slot holdings, its sale, reinvestment and rebalancing functions and the one-year lag on rebalancing gains are not built.
5. **The tax function is the tax area's `federalTaxInto` with its slot layouts**, called by the engine's `assess`. The engine's object-style tax hooks are not built, and the partial-year scaling happens in one place, inside the tax function (C23, C30, C31).
6. **Thresholds after 2027 are indexed with the tax area's statutory rounding, and Social Security uses the tax area's month loop with SSA rounding.** The gate's reference tables R1 and R2 and three hand cases were computed without either and must be regenerated before they are used (C22, C21, C50).
7. **Social Security cost-of-living adjustments have one owner, the tax area.** The engine's separate cost-of-living index is not built (C20).
8. **Payroll tax on wages and contribution limits are applied**, as the tax area designed them (C26, C27).
9. **Fund costs are a per-account input seeded from the holdings' measured expense ratios** (C25). This overrules the inputs design.
10. **Basis at the first death moves toward value in both directions, with the joint share read from the state of residence** (C19).
11. **The engine's public API is the facade the inputs design assumed** (`runSimulation`, `simulatePath`, `runThreadMain`), built from the engine's internals and the strategies area's mappers (C7).
12. **The web imports `@meridian/shared` only.** The engine package is used by the worker and the API (C47).

## 2. The reconciled contract

The four designs stay the implementer's contract for algorithms and test cases. This section fixes the names and shapes at the seams. Section 3 gives the reason for each line.

### 2.1 Packages and boundary

- `packages/shared/src/retirement/` holds every wire and document schema of all four areas (the inputs design's package rule). `@meridian/retirement` depends on `@meridian/shared` and `zod`; it exports code and data only. `apps/web` does not depend on `@meridian/retirement`.
- `SimInput` (inputs design 4.5) with these changes: `accounts[]` gains `expenseRatioPpm` (integer, 0 when unknown); `spending.healthcare[]` gains `inBase` (boolean) and keeps the entered amounts; the resolver adds `synthetic:cash` when no taxable or cash account is included.
- `RunSettings` (inputs design 4.4) becomes:

```ts
export const RunSettings = z.object({
  schemaVersion: z.literal(1),
  paths, seed,                          // seed: integer 0..4294967295, default 1
  stepsPerYear: z.literal(1),
  returnModel: ReturnModelConfig,       // returnModel.ts (engine area): integers only, includes the test-only kind "fixed"
  portfolio: PortfolioSettings,         // returnModel.ts: { taxableRebalance: "full" | "flows_only", assetClassMap?: Record<AssetClass, [bp, bp, bp]> }
  strategy: StrategyConfig, withdrawalOrder: WithdrawalOrderConfig,   // strategy.ts
  taxRuleSet: RuleSetId, tax: TaxSettings,                            // tax.ts
}).strict();
export function upgradeRunSettings(raw: unknown): RunSettings;        // version dispatch, identity for 1
```

### 2.2 Plan clock

- Plan year `t` is calendar year `plan.startYear + t`. Its period is `[periodStart, periodStart + periodMonths)`: the months from `plan.startMonth` through December for `t = 0`, the whole year otherwise. `f = periodMonths / 12`.
- A recurring flow with a month window pays `annual × index × (months of the window inside the period) / 12`. A recurring amount with no window (a fee, a yield, a threshold, an RMD, a limit) is scaled by `f`. A dated lump (a goal, a scheduled conversion) is never scaled.
- `retired[i]` in year `y` is `year(retirementMonth_i) ≤ y`. `drawdownStart = year(spending.startMonth) − startYear`.
- Ages are whole years attained in the calendar year (`year − birthYear`) for the age-65 deduction, RMDs, catch-up limits and VPW; month-exact (`birthMonth`) for 59½, the HSA's 65, Social Security claims and Medicare windows.
- All flows of a year happen at its start, returns after (engine decision 6). Deaths, the rollover and the basis reset take effect at the year's end. `cpi[t]` is the price level at the start of year `t`, `cpi[0] = 1`.

### 2.3 One year, in order, with the owner of each step

| Step | What happens | Owner of the rule |
| --- | --- | --- |
| Once per path | market factors and full-year inflation rates; death draws; `fillPathTables(law, indexInflation, …)`; `resetSsState`; Roth records, balances, basis and the loss carry-in | engine calls; tax area's functions |
| 0 | ages, alive, retired, filing status, phase; `rothRollYear` from year 1 | engine; tax area's Roth state |
| 1 | income streams by month window and the inputs design's indexing; `socialSecurityYear` returns the period's benefits (not scaled again) | engine; inputs semantics; tax area |
| 2 | contributions by the inputs design's salary-scaling rule, capped by the tax area's limits; payroll tax on gross wages | engine; inputs; tax area |
| 3 | `decideSpending` fills the `SpendDecision` (with `gross`, `planned`, `rule`) | strategies |
| 3b | RMD per account; scheduled conversions resolved in the loop; `available`; penalty shares and `rothFree` for the view | engine; tax area's functions |
| 4, 5 | `planWithdrawals(view, decision, assess, w)`; `assess` previews trades, yields, Roth and HSA splits, penalty bases, fills the tax input slots and calls `federalTaxInto` | strategies own the order and the solver; engine owns `assess`; tax area owns the function |
| 6 | trades applied (flow and rebalance in one list); surplus deposited | engine |
| 7 | returns, fund costs, bill interest carried to next year, `cpi[t+1]` | engine |
| 8 | year recorded; at a death: rollover, `mergeRothAtDeath`, basis reset | engine; tax area's shares |

### 2.4 Engine facade

```ts
// "@meridian/retirement"
export const ENGINE_VERSION: string, DATA_VERSION: string, DATA_CHECKSUM: string;
export function validateInput(input: SimInput): Array<{ code: string; message: string }>;   // prepare() without throwing
export function simulatePath(input: SimInput, pathIndex: number): PathResult;                // { pathIndex, endingRealCents: bigint, depletionYear: number, table: YearTable }
// plus the tax area's listTaxRuleSets, TAX_DATA_FIRST_YEAR, contributionLimit, fullRetirementAgeTable, buildRulesView, federalTaxPreview, socialSecurityPreviewView
// "@meridian/retirement/node"
export function runSimulation(input: SimInput, opts: { threads: number; threadEntry?: URL; signal?: AbortSignal; maxRunMs?: number;
  onProgress?: (p: { donePaths: number; totalPaths: number; elapsedMs: number }) => void }): Promise<SimOutput>;
export interface SimOutput { paths: number; successPaths: number; endingRealCents: BigInt64Array; depletionYear: Int16Array;   // -1 = never
  summary: SimSummary; fan: FanSeries; warnings: Array<{ code: string; message: string }>; timing: { elapsedMs: number; threads: number } }
export function runThreadMain(): void;
export function createSimPool(opts?: { threads?: number; threadEntry?: URL }): SimPool;      // kept public for Phase 5 grids
// errors: EngineInputError(code), EngineInvariantError, EngineRuntimeError, SimulationCancelledError(code: "cancelled" | "timeout"), SimulationWorkerError
```

### 2.5 Hooks and view

- `EngineHooks` keeps `decideSpending(view, strategyState, out)` and gains the decision argument in `planWithdrawals(view, decision, assess, w)`. The hooks `publishedCola`, `resolveTaxYear`, `federalTax`, `splitRothWithdrawal`, `rmd` and `socialSecurity` are replaced by one injectable record of the tax area's functions (`fillPathTables`, `federalTaxInto`, `rothWithdraw`, `preTaxPenaltyBase`, `hsaWithdraw`, `requiredMinimumDistribution`, `socialSecurityYear`, `employeePayrollTax`, the limit functions), so the loop tests can still run on stubs written to the same slot layouts.
- `YearView` gains, read-only: `rmd[A]`, `stockShare`, `rothFree[P]`, `yearsToDeath[P]`, `drawdownStart`, `strategies`, `preTaxPenaltyShare[A]` (0 to 1), `hsaPenaltyShare[P]`. It loses `colaIndex`. `input` is the `SimInput`. Income fields are full-year rates (the period's amount divided by `f`).
- `Assessment.taxResult` is the tax area's output record (`Float64Array(TAX_OUT)`).

### 2.6 Who fills each tax input slot (inside `assess`)

`WAGES` = gross wages less the year's employee contributions to pre-tax and HSA accounts (after the caps). `PENSION` = pensions and annuities × `taxableBp`. `INTEREST` = last year's bill and cash interest (carried) plus this year's taxable bond interest. `TAX_EXEMPT_INTEREST` = bond interest × the tax-exempt share. `ORD_DIV`, `QUAL_DIV` = this year's dividends and their qualified part. `ST_GAIN` = 0. `LT_GAIN` = gains realized by the previewed trades. `LOSS_CARRY_IN` = the carried loss. `TRAD_DIST` = RMDs plus pre-tax withdrawals. `ROTH_CONV` = scheduled conversions. `ROTH_TAXABLE` and the Roth part of `PEN10_BASE` come from `rothWithdraw` on a scratch copy of the Roth record; the pre-tax part of `PEN10_BASE` from `preTaxPenaltyBase`; `HSA_TAXABLE` and `PEN20_BASE` from `hsaWithdraw`. `SS_GROSS` = the period's benefits. `RENTAL`, `OTHER_ORD` from the streams. `ADJUSTMENTS` = 0. `N_AGED` from the ages. `YEAR_FRACTION` = `f`. Every amount is the period's amount; nothing is divided by `f` before the call.

## 3. Conflicts and resolutions

### A. Boundary, packages, harness

**C1. Two boundary inputs** (inputs, engine, tax, strategies).
The inputs design freezes `SimInput` (shared; month-resolved; annual cents; one balance, one basis and six class weights per account; stored in `sim_run.input` and hashed). The engine design defines `EngineInput` (in the engine package; an `asOf` date; calendar-year windows; holdings and basis by class; rates as JSON floats; "stored whole in `sim_run`"). The tax design reads `SimInput`. The strategies design writes its fixtures and mappers against `EngineInput` and leaves "who adapts" open (its E8).
Resolution: `SimInput` is the only boundary, stored and hashed type. `prepare(input: SimInput)` builds the engine's internal tables. `EngineInput` and its Zod schema are not built. Mapping of the engine design's fields: `asOf` → `plan.*`; `seed` → `settings.seed`; `pathCount` → `settings.paths`; `persons[].retirementYear` → `year(retirementMonth)` with month windows (C15); `persons[].mortality` → `household.people[].longevity` (C28); `rothContributionBasisCents` → the sum over the person's Roth accounts; `rothRecentConversions` → dropped (not modelled in v1, tax design 8.2 `roth_history`); `holdingsCents` → `balanceCents × allocation`; `basisCents` by class → C18; `target` → `glidePath` or `allocation` (C29); `expenseRatioPpm` → new account field (C25); `assetClassMap`, `taxableRebalance` → `settings.portfolio`; the two yields, `jointBasisStepUp`, `surplusAccountId` → removed (C17, C19, C24); `returnShift` → an engine-internal option for Phase 5, absent from v1 settings; the four opaque blocks → `socialSecurity`, `spending`, `settings.strategy` and `settings.withdrawalOrder`, `settings.taxRuleSet` and `settings.tax`. The reference fixtures `r1` to `r4` and the engine's loop tests are written as `SimInput` through a builder in `@meridian/retirement/testing`.
Reason: L7 asks for the full input snapshot on every run, and the hash must cover what was simulated. One type with no adapter means the gate tests the same path production runs.

**C2. Dependency direction and where schemas live** (engine against inputs, tax, strategies).
The engine design depends only on `zod`, declares the six asset classes itself and keeps its Zod schemas in `packages/retirement/src/input.ts`. The other three put every wire schema in `packages/shared/src/retirement/` and make the engine depend on shared.
Resolution: the inputs design's package rule. `returnModel.ts` in shared (engine area) holds `ReturnModelConfig`, `PortfolioSettings` and their defaults; the engine imports `AssetClass` from shared.
Reason: no workspace cycle, the API and the web already import contracts from shared, and Phase 3 decision 3 makes `enums.ts` the single source of every enum.

**C3. Floats in stored settings** (engine against inputs).
The engine's return-model input carries JSON floats (rates, volatilities, correlations, a non-integer block length, the fixed series). The inputs design's stored documents hold no float, and `canonicalJson` throws on a non-integer.
Resolution: `ReturnModelConfig` is integer-only. Means, volatilities, persistence and correlations in basis points (correlations −10000 to 10000); the fixed series in parts per million (six decimals, the data file's precision); `meanBlockYears` an integer 1 to 30.
Reason: one canonical hash; a float that prints differently on two machines would change `input_hash`.

**C4. Settings without a home** (tax, engine against inputs).
The tax design asks for `RunSettings.tax`. The engine's `assetClassMap`, `taxableRebalance`, yields, `jointBasisStepUp`, `surplusAccountId`, `returnShift` and `expenseRatioPpm` have no field in `SimInput` or `RunSettings`.
Resolution: section 2.1. `RunSettings` gains `tax` and `portfolio`; the rest is removed or moved as C1 lists. `upgradeRunSettings` is added now.
Reason: every assumption that changes a number must be in the snapshot, in a data file (`DATA_VERSION`) or in code (`ENGINE_VERSION`); a default that lives only in engine code is covered by the engine version.

**C5. Seed** (engine against inputs).
A 64-bit decimal string, "fixed per scenario", against an integer 0 to 4294967295 with a database CHECK and one shared default of 1.
Resolution: the inputs design's integer and its shared default. The generator's key is `(seed, 0)`; `seedKey` keeps accepting a decimal string for its known-answer tests.
Reason: a safe integer in canonical JSON, and one seed across scenarios makes the difference between two scenarios a property of the plan, not of the draw.

**C6. Path count** (engine, inputs, strategies).
`settings.paths` is 100 to 100,000; the engine accepts 1 to 100,000 and replaces the count for the historical model. The fixed model's count is not stated, and R1 and R2 are "one path".
Resolution: the engine reports the effective count and `sim_run.paths` takes it (inputs decision 25). Historical: the cohort count, or a multiple of it under mortality draws. Fixed model with every life expectancy fixed: 1.
Reason: repeating identical paths adds nothing, and the reference runs must be reachable through the public input.

**C7. Engine API names and shapes** (inputs against engine, strategies).
The inputs design's worker and API call `runSimulation(input, { threads, threadEntry, signal, onProgress(done, total) })` returning `SimOutput`, `simulatePath(input, k)`, `runThreadMain()`, `SimInputError`, `SimAborted`. The engine provides `runSimulation(input, opts)` returning `{ result: EngineResult, details, raw, timing }`, `simulatePathDetail(run, k)`, five error classes, no `runThreadMain`, and its own `maxRunMs` of 600,000 ms beside the job's 900,000 ms timer. The strategies design's mappers sit between the two.
Resolution: the facade of section 2.4. Inside it: `prepare` → pool → `aggregate` → `toSimSummary`, `toFanSeries`; `simulatePath` = `toYearTable(simulatePathDetail(prepare(input), k))`. One timer: the job passes `maxRunMs` from `RETIREMENT_RUN_MAX_MS`. The engine's error classes are the exported ones and the job maps them: `EngineInputError` → `failSimRun(code)`; `SimulationCancelledError("cancelled")` → `cancelSimRun`; `("timeout")` → `failSimRun("timeout")`; `EngineInvariantError`, `EngineRuntimeError` → `failSimRun("engine_error")` and a permanent rethrow; `SimulationWorkerError` (a thread died) → rethrown as it is, so the queue's second attempt runs and then fails the run with `worker_error`. A `TaxDataError` raised inside `prepare` is rethrown as `EngineInputError` with the same code.
Reason: the job and the API are written to the inputs design's names; one timer cannot disagree with itself.

**C8. Who produces the stored percentile tables** (engine against inputs).
The harness re-simulates `detailPercentiles` and returns `details`; the job re-simulates the seven stored percentiles itself and checks each against the series (`not_reproducible`).
Resolution: the job. The harness returns no details.
Reason: storage is the inputs area's (L8), and the job's check is the reproducibility guard the spec's accuracy rule asks for.

**C9. Rank rule** (engine against inputs, strategies).
The engine ranks on float64 with four keys (ending wealth, failure year, larger shortfall, index); the other two rank on cents with three.
Resolution: the shared `rankPaths` on cents (ending wealth, then earlier failure year, then path index) is the only implementation; the engine's `percentilePathIndex` comes from it.
Reason: two orders can pick two different paths for the same percentile, and the table would then not belong to the stored series.

**C10. Thread setting and thread entry** (engine against inputs).
`SIM_THREADS` (0 to 16) against `RETIREMENT_THREADS` (`auto`, `inline`, 1 to 64); the engine bundles `packages/retirement/src/node/thread.ts` directly and falls back to a `tsx` bootstrap, the inputs design bundles `apps/worker/src/simThread.ts` (which calls `runThreadMain()`) and falls back to inline.
Resolution: `RETIREMENT_THREADS`, as the inputs design defines it; the harness clamps to the number of chunks. The worker owns `simThread.ts` and passes `threadEntry` when `dist/simThread.js` exists, else `threads = 0`. `thread.boot.mjs` serves only the engine package's own harness tests.
Reason: one prefix for the three worker variables; a bundled `main.js` cannot find a bootstrap file beside itself, so the entry must be passed explicitly in production.

**C11. Data manifest and loading** (engine against tax).
Two manifest shapes, two versions (`2026.11.0`, `2026.11.1`), generated TypeScript for the CSV series against static JSON imports for the tax tables.
Resolution: one `manifest.json`: `{ dataVersion, firstTaxYear, lastPublishedYear, files: [{ path, sha256, sourceUrl?, retrieved?, description? }] }`, first committed as `2026.11.0`. CSV series go through the generated `data.ts`; JSON tables are imported statically. One `data.test.ts` recomputes every hash. `DATA_CHECKSUM` and the result digest are stored inside `SimSummary` (`dataChecksum`, `digest`); no column is added.
Reason: `DATA_VERSION` must name one thing.

**C12. Where the tax law is compiled** (tax against engine).
The tax design compiles on the job's thread and passes typed arrays to the threads; the engine has every thread run `prepare(input)`.
Resolution: the engine's. `compileTaxLaw`, `compileTaxDrag` and `compileSsPlan` run inside `prepare`.
Reason: one preparation path for threads, inline mode and the API's single-path re-simulation.

**C13. Engine input errors** (engine against inputs).
The engine expects its error codes mapped to `PlanError(400, …)`; in the inputs design they can only surface as a failed run, after the job was queued.
Resolution: `PlannerEnv.validateInput` (the engine's `validateInput`) is called by `requestRun` and by `GET /scenarios/:id/input`; each error becomes an issue of severity `error`, so the run is refused with `409 plan_incomplete` before anything is queued. The job keeps its failure path. The resolver also enforces the engine's limits (`too_many_accounts` above 32 including synthetic accounts, 40 income streams, 120 conversions, the horizon and path-year caps).
Reason: "this plan is longer than the historical record allows" belongs on the form, not in a failed run; 409 is the status the inputs design uses for an unrunnable plan.

### B. Clock, flows and state

**C14. The first partial year (L3)** (engine against inputs, tax; strategies follows the loop).
The engine prorates by days from `asOf` (`f0 = 52/365` for 2026-11-10). The inputs design starts at the nearest month boundary and counts months; the tax design adopted that. For the inputs fixture (as-of 2026-10-13) the two fractions are 80/365 = 0.219 and 3/12 = 0.25: a 120,000 salary pays 26,301 or 30,000 in year 0.
Resolution: months, from `SimInput.plan`. The engine's other year-0 rules keep their form with this `f`: log return `f·m + √f·(x − m)`, death probability `1 − (1 − q)^f`, fund cost `fee^f`.
Reason: L3 allows one rule. Social Security, the penalty ages, contribution limits and Medicare windows are month arithmetic, the ledger's flows are monthly, and a monthly engine later is the same rule with `f = 1/12`.

**C15. Calendar-year windows against month windows** (engine against inputs, strategies).
The engine's streams have inclusive start and end years and a `retirementYear`; the frozen input has `[startMonth, endMonth)` everywhere and the strategies design already turns month windows into year shares (`yearShare`). For the fixture, Alex retires in June 2035: the frozen input pays five months of salary that year, the engine as written pays none or twelve.
Resolution: section 2.2. Every recurring flow counts the months of its window inside the period; the uniform `× f` applies only where no window exists.
Reason: half a year of salary or spending is tens of thousands of dollars in the year the plan turns from saving to drawing.

**C16. How an income stream grows** (engine against inputs).
The engine multiplies by `cpi[t] × (1 + rate)^t` or `(1 + rate)^t` counted from the plan start. The frozen input says: a nominal stream starts at its quoted amount in its first year; a today's-dollar stream is indexed to its first year; after that a pension or annuity follows its `cola` (`none`, `cpi`, `fixed`), the others follow inflation plus `realGrowthBp`. The engine's form cannot express a today's-dollar pension without a cost-of-living clause, and applies a fixed adjustment for the years before the pension starts.
Resolution: the inputs design's semantics. With `t0` the stream's first plan year: amount = annual × (`cpi[t0]` when `dollars` is `today`, else 1) × growth since `t0` (`cpi[t]/cpi[t0]` for `cpi`; 1 for `none`; `(1 + bp/10000)^(t − t0)` for `fixed`; `cpi[t]/cpi[t0] × (1 + realGrowthBp/10000)^(t − t0)` for salary, part-time, rental and other).
Reason: it is what the owner typed; a pension quoted at 65 must be that amount at 65.

**C17. The taxable-account model** (engine against tax; strategies sided with the engine).
The engine: three simulated assets per account with average-cost basis; withdrawal and rebalance in one trade list; gains taxed in the year of the trade through `assess`; dividends (1.3%, all qualified) and coupons (4.2%) on post-trade balances, taxed the same year; bill interest taxed a year later. The tax area: six classes per holding; income on start-of-year values, with bond interest equal to the same year's cash return plus 1% (which the loop cannot know at the start of the year); a pro-rata sale; rebalancing after taxes with the gain taxed a year later; class yields 1.3%, 2.8%, 3.5% with qualified shares 95%, 75%, 0%. R1, R2 and the engine's worked year W1 were computed under the engine's rules.
Resolution:
1. State and trades are the engine's: per account and simulated asset, `planTrades`, same-year gains. `taxableYearIncome`, `sellTaxable`, `depositTaxable`, `reinvestTaxable`, `rebalanceTaxable`, the six-slot holdings, the `YI` record and `pendingLtcg` are not built; the tax design's cases F1 to F11 are replaced by the engine's T23, T25, T27, T34 and the blending cases below.
2. The assumptions are the tax area's: `taxable/tax-drag.json` with `TaxSettings.taxDrag` is the only source of yields. `prepare` blends the six classes into the three simulated assets per account and plan year with that year's six-class target weights: a dividend yield and a qualified share for stocks, an interest spread and a tax-exempt share for bonds. The engine's two yield inputs are removed. Illustration: the fixture's brokerage account (68.39% US stock, 26.32% international, 5.29% cash) gets a stock dividend yield of 1.72% of which 86% is qualified.
3. Dividends = yield × post-trade stock balance × `f`, split into qualified and ordinary, taxed in the same year, added to basis.
4. Bond interest: C18.
5. Bills in taxable accounts and cash accounts: the whole actual bill return of the year, taxed with the next year, added to basis (the engine's rule).
6. `gainDistributionRate` stays a compiled parameter (default 0) applied to the post-trade unrealized gain. `fallbackCashYield` and `cash_series_missing` are dropped: every return model has a bill series.
Reason: tax is due in the year of the sale; one trade list avoids selling and rebuying the same asset; the engine owns balances and rebalancing (L8); the yields are tax assumptions and keep one owner. Honouring the qualified share matters for a household that holds international or real-estate funds in a taxable account.

**C18. Bond interest and the basis of the cash slice** (engine against tax; inputs).
(a) A fixed 4.2% coupon ignores the rate regime of a historical path; the same year's cash return plus a spread needs the year's return before the year has happened. (b) The frozen input carries one basis per taxable account; the engine wants it by class; the tax design splits it by class weights, which gives the cash slice the account's gain fraction although it also says cash basis always equals cash value.
Resolution: (a) bond interest = `max(0, billRef_t + spread)` × post-trade bond balance × `f`, where `billRef_t` is the path's full-year bill return of the previous plan year, and for year 0 the return model's starting bill rate (`bills.initial` for the parametric model, row 0 of a fixed series, otherwise the data file's last bill return). (b) The bill slice starts with basis equal to its value; `max(0, basisCents − bill value)` is split across stocks and bonds by their values.
Reason: (a) keeps the tax area's link between coupons and the level of rates without look-ahead, and it is how the bond series itself is built (the coupon promised at the prior year-end yield). It leaves W1 (bills 3%, coupon 4%), R2 (bills 2%, coupon 3%) unchanged at the default spread of 1%, and T25 with a spread of 0.2%. (b) Cash has no gain; the baseline already counts cash lines at value.

**C19. Basis at the first death** (engine against tax).
The engine moves basis toward value by an ownership share, up or down, with a per-run setting for joint accounts. The tax design steps up only, lists the missing step-down as not modelled, and reads the joint share from the state of residence.
Resolution: `basis ← basis + s × (value − basis)` per account and simulated asset, after the year's returns; `s` = 1 for the decedent's own account, 0 for the survivor's, and for a joint account `basisStepUp.jointAccount` (0.5) or `jointAccountCommunityProperty` (1) when `household.state` is in the data file's list. The engine's `jointBasisStepUp` input and the entry `loss_step_down` are dropped.
Reason: the law sets basis to fair market value in both directions, and the profile already stores the state that decides half or all.

**C20. Two cost-of-living indexes** (engine against tax).
The engine builds `cola[t]` (running maximum of the price index, a published adjustment through a `publishedCola` hook) and expects the benefit "already times `colaIndex`". The tax area computes each year's COLA itself (path inflation rounded to 0.1%, high-water rule, published 2026 and 2027 values) and applies it to the PIA with SSA's truncation.
Resolution: the tax area's. The engine's `cola`, `colaIndex`, `publishedCola`, `carry[5]` and test T16 are not built. A pension with `cola: cpi` follows `cpi` and can fall (engine deviation 21 stands).
Reason: one owner for one quantity; the tax area's version is the statutory one.

**C21. Social Security for a year** (engine against tax; strategies' sheets).
The engine takes a full-year benefit and multiplies by `f`. The tax area pays the months of the period that are in pay (its H11: two months, not seven months × `f`), needs wages and death years for the earnings test and survivor rules, and rounds as SSA does. The reference sheets assume `12 × benefit × cpi`.
Resolution: `socialSecurityYear` returns the period's benefit per person and the loop does not scale it. Illustration: in the fixture Alex claims in June 2042 and is paid seven months that year, not twelve.
Reason: a mid-year claim is the normal case; five extra months of benefit is about 14,500 in 2027 dollars for this household.

**C22. Indexing of tax thresholds after 2027** (engine, tax, strategies).
Three rules: the engine's `cpi[t] / cpi[2027]` unrounded; the tax area's lagged product of path inflation with the statute's rounding steps and an optional wedge; the strategies design's "multiplied by the price level, unrounded", on which R1, R2 and HC-T15 rest. At 2.5% inflation the 2028 joint standard deduction with two age additions is 37,400 under the tax area's rule and 37,515 in HC-T15; the first joint bracket ends at 26,200 against 26,240.
Resolution: the tax area's `fillPathTables`. The engine supplies `indexInflation[t]`, the full-year inflation rate of each plan year (for year 0 the model's full-year rate, not the part-year factor). The hook `resolveTaxYear` is not built. The strategies design's request T5 is withdrawn.
Reason: published tables are always rounded this way, so the indexed years then look like the published ones; using the part-year factor for year 0 would leave every later bracket short by the missing months' inflation.

**C23. Annualizing twice** (engine against tax).
The engine divides the tax inputs by `f` and multiplies the results by `f`; the tax function does the same internally from its `YEAR_FRACTION` slot. Built as written, year 0 would be scaled twice.
Resolution: inside `federalTaxInto` only. `assess` passes the period's amounts and sets `YEAR_FRACTION`. The MAGI kept for Phase 5 is the function's output divided by `f`.
Reason: one place, already covered by the tax area's property test `Tax_f(x) = f × Tax(x / f)`.

**C24. The surplus account** (engine, tax, strategies).
The engine: an explicit id, else the first taxable account, else the first cash account, else the surplus "is counted as spent". The tax area: the largest taxable account by starting balance, else the largest cash account, else a synthetic cash holding.
Resolution: the tax area's rule, applied by the engine on the frozen account list (ties by id). The resolver adds `synthetic:cash` (bucket cash, balance 0) when the plan has neither, so the account is in the snapshot and in the year table. Deposits go in at the account's target weights with basis.
Reason: money must not leave the plan because of which accounts happen to exist.

**C25. Fund costs** (engine against inputs).
The engine applies a per-account drag from `expenseRatioPpm`; the inputs design sends no such field and argues the spec names no such input.
Resolution: `SimInput.accounts[].expenseRatioPpm`. The baseline measures it for classified accounts (the value-weighted ratio of the positions that have one, with the covered share), the resolver uses it with provenance `live`, an owner may type it per account, and an account with no measurement gets 0 with warning `expense_ratio_unknown`. Reference scenarios set 0.
Reason: index returns are before costs. A measured cost of 0.5% a year leaves about 14% less after 30 years (0.995^30 = 0.86); ignoring a figure Phase 3 already measures makes every success rate too high. If the lead declines, the field stays and defaults to 0.

**C26. Contributions: the rule and the limits** (inputs, engine, tax).
The engine's contribution is a real annual amount or a share of one named income; the frozen input scales a year-0 amount with the salary paid to `p1`, `p2` or the household. The tax area caps contributions at the indexed limits and sends the excess to the surplus account; the engine and the inputs design do not cap.
Resolution: amount in year `t` = year-0 amount × salary paid in the period to `scaleWith` ÷ `salaryBasisCents` (`inflation`: × `cpi[t]` × months to `endMonth` / 12). The kind follows the account: pre-tax and HSA reduce the owner's wages, Roth adds to the owner's contribution basis, taxable and cash are after-tax. Caps per the tax design 3.10 (× `f` in year 0). An employee amount above a cap is deposited after tax in the surplus account and does not reduce wages; an employer amount above the annual-additions limit is dropped. Warning `contribution_capped`.
Reason: a savings rate carried through twenty years of raises must not exceed the law, and the household-scaled contribution cannot be expressed as a share of one income.

**C27. Payroll tax** (tax against engine, strategies).
The tax area subtracts employee payroll tax by default and shows it as its own line; the other two leave it out and ask.
Resolution: on by default (`TaxSettings.includePayrollTax`). In drawdown years it is a cash use beside the federal tax: `net = cash income + RMDs + withdrawals − employee contributions − payroll tax − need − tax`. In accumulation years it is reported and paid from wages, like the baseline income tax. It does not depend on the withdrawal, so it is computed once a year outside the solver. The cash identity in the strategies design's WD-21 and OUT-8 gains the term.
Reason: a working spouse's wages otherwise net 7.65% too much in exactly the years the plan starts drawing.

**C28. Mortality parameters** (inputs against engine).
The profile has `sex`, `adjustYears` (−10 to 10) and `maxAge` (90 to 119); the engine has `sex` including `unisex` and `qScale`, and runs the horizon to the end of the table.
Resolution: the engine honours the profile: the table is read at `age − adjustYears`, death is certain in the year `maxAge` is attained, and the horizon ends there (which is how the resolver computes `plan.endYear`). `qScale` stays an internal constant of 1. Until the SSA table is installed the IRS unisex table is used, `sex` has no effect and the run says so (`mortality_fallback_table`).
Reason: the profile is what the owner typed; the horizon decides which historical cohorts are complete.

**C29. Glide path interpolation** (engine against inputs).
The engine interpolates in floats; the shared `glideWeightsAt` interpolates in basis points with largest remainder, and the form previews with it.
Resolution: the engine calls `glideWeightsAt` on the six classes and then applies the asset map. An account without a glide path is rebalanced to its frozen `allocation` every year.
Reason: the form and the engine must show the same mix.

### C. The tax, RMD and Social Security seam

**C30. The tax function's signature** (engine, strategies against tax).
Assumed: `federalTax(input, params, out)` on named records with per-person arrays and `resolveTaxYear(view, out)`. Provided: `federalTaxInto(t, o, x, r)` on slot layouts with a per-path table, penalty bases computed by the caller, and the total also returned as a number.
Resolution: the tax area's signature and layouts; the function returns nothing (the engine's zero-allocation rule: a returned double is boxed). The engine's test stubs (`flatTax`, `bracketTax`) are rewritten to the same slots. The scalars the strategies design asks for (its T2) exist as `ORD_TAX`, `CG_TAX`, `STD_DEDUCTION + SENIOR_DEDUCTION`, `TAXABLE_INCOME`.
Reason: the tax area owns the function (L8), and its layout already carries the Phase 5 outputs.

**C31. Who assembles the tax input** (engine, strategies against tax; L8).
L8 gives "the gross-up logic that calls the tax function" to the strategies area; the tax design accordingly expects the strategies area to price candidates on scratch state. The engine and the strategies design both put the assembly in the engine's `assess`.
Resolution: the engine's `assess` (section 2.6), calling the tax area's pure functions; the strategies area owns the order and the solver.
Reason: one owner for the cash identity, and `f` stays out of the strategies area. This settles the engine's open question 1 and the strategies design's open question 13.

**C32. Roth state** (engine against tax; inputs).
Two eight-slot layouts in opposite order; the engine's has no five-year clock and a separate "older conversions" slot; the functions are `splitRothWithdrawal(q, state, offset, out)` against `rothWithdraw(st, off, amount, earlyFrac, year, out)`; the engine seeds per person with recent conversions, the frozen input carries a basis per Roth account and no recent conversions.
Resolution: the tax area's `RB` record and functions (`rothRollYear`, `addRothContribution`, `addRothConversion`, `rothWithdraw`, `mergeRothAtDeath`); `PathState.roth` uses that layout; seeding as the tax design 3.7.3.
Reason: the five-year clock is law, and a Roth first funded by a scheduled conversion must not be treated as qualified at once.

**C33. Who is "early"** (strategies against tax).
The order assumes `isEarly(kind, ageAttained)` with "under 60"; the tax area uses the share of the period before the month of 59½ (0 to 1) and exempts a 401(k) after separation at 55 or later, which is a property of the account.
Resolution: the engine exposes `preTaxPenaltyShare[a]` (from `earlyFraction` and `preTaxPenaltyBase`) and `hsaPenaltyShare[p]`. Tier 4 holds the pre-tax accounts whose share is 0, tier 7 those above 0; the same for Roth and the HSA. A year with a partial share counts as early for the order and is charged the partial penalty.
Reason: with "under 60" a person born in September is put in the penalty-free tier in the year two of twelve months are still penalized, and a penalty-free 401(k) is put in the penalized tier.

**C34. Free Roth money** (strategies against tax).
The order assumes "an owner who is not early takes everything free" (its T4) and computes `rothFree` as contributions plus old conversions. Under the tax area's clock, earnings are taxable until five years after the first funding even past 59½.
Resolution: the tax area exports `rothFreeAmount(st, off, balance, earlyFrac, year)`: `BASIS_FREE`, plus the conversion layers when `earlyFrac = 0`, plus earnings when `earlyFrac = 0` and the clock is met. The engine fills `rothFree[i]` from it.
Reason: tier 5 must contain only money that leaves with no tax and no penalty.

**C35. HSA when healthcare is "included in base"** (inputs against strategies, tax).
The resolver zeroes both healthcare amounts when they are included in base spending, and the fixture is set that way. The HSA's penalty-free tier is capped by the year's healthcare, so every HSA dollar becomes ordinary income (plus 20% before 65) and is drawn last.
Resolution: the frozen healthcare entries keep the entered amounts and gain `inBase`. `decideSpending` adds healthcare to spending only when `inBase` is false; `SpendDecision.healthcare` (the HSA's qualified cap) is the entered amount either way. The resolver warns `hsa_no_medical` when an HSA is included and both amounts are 0.
Reason: an HSA is spent on medical costs the household has whether or not it itemized them in the profile.

**C36. RMD divisor** (engine, strategies against tax).
The engine's hook and the strategies design's T7 use the Uniform Lifetime table only; the tax area adds the Joint and Last Survivor table for a spouse more than ten years younger and works on the owner's total.
Resolution: the tax area's functions. Per account the RMD is `balance ÷ rmdDivisor(owner's age, living spouse's age)`, which sums to the owner's total; × `f` in year 0 on the opening balance; capped at the balance.
Reason: the table is verified and costs one lookup; R1 and R2 are unaffected (age gaps of 0 and 3).

**C37. The tax block of a year row and the Social Security parts** (strategies against tax).
`YearRow.tax` (nine fields) duplicates the tax area's `TaxYearDetail` (twenty-three, with the Phase 5 MAGI figures and a payroll line). The tax design also asks for the own, spousal and survivor parts and the earnings-test withholding per person; the row has one number per person.
Resolution: `YearRow.tax` is `TaxYearDetail`; `addUp` works on its components (`incomeTax = ordinary + capital gains`; total = income tax + NIIT + the two additional taxes; payroll separate). `YearRow.income` gains `socialSecurityParts[]` per person: `spousal`, `survivor`, `withheld`.
Reason: one shape per quantity; an owner whose benefit shows 0 because of the earnings test needs to see why.

**C38. Two rounding functions for dollars to cents** (engine against tax; L1).
`floor(|x| × 100 + 0.5)` against `floor(|x| × 100 + 0.5 + 1e-7)`: they differ for values such as 1.005.
Resolution: one `dollarsToCents` in `units.ts`, with the `1e-7` guard, in bigint and string forms.
Reason: L1 says "converted once, rounded half away from zero"; the guarded form satisfies both designs' test values (the engine's T39 and the tax design's K9).

**C39. Scheduled conversions** (inputs, engine, strategies).
Per person in the frozen input ("pro rata from the person's pre-tax accounts"); one named source and one named target account in the engine; "resolved before the engine sees it" in the strategies design. Pro rata depends on the year's balances, so it cannot be resolved beforehand.
Resolution: in the conversion year, after the RMDs: the amount (× `cpi[t]` when `dollars` is `today`, never scaled by `f`) is taken pro rata to `value − rmd` from every pre-tax account the person owns that year and deposited at target weights in that person's Roth account with the largest starting balance (ties by id; the synthetic one when there is no other). A conversion for a person who has died is skipped and counted under warning `conversion_after_death`.
Reason: the loop is the only place that knows the balances; the rule must be stated once.

**C40. Hook and view extensions** (strategies' requests E1 to E3, E5 to the engine).
Resolution: accepted as section 2.5 lists, with `stockShare` defined on the simulated stock asset (after the asset map), weighted by all accounts' start balances. The loop gains the gross-year branch and the below-plan flag; chunk flags gain bit 3; the result gains `fullPlanCount`.
Reason: without them the two percentage strategies and the full-plan rate cannot be built.

**C41. Run warnings** (tax against engine).
The tax area's per-path warning amounts are "merged by the thread harness", but the chunk summary has no field for them.
Resolution: `ChunkSummary` gains `warnMax: Float64Array(8)` and `warnPaths: Uint32Array(8)`; merging is a maximum and a sum, so it does not depend on chunk order. `SimOutput.warnings` is the engine's warnings followed by `warningMessages(…)`. Resolver warnings stay in `input.meta.warnings`.
Reason: L5; warnings must be the same for any thread count.

### D. Results, API, web

**C42. Routes and pages for the tax area** (tax against inputs, strategies).
Routes 22 to 24 (`GET /rules`, `POST /tax-preview`, `POST /social-security-preview`) and three `app.planner` functions are not in the inputs design's route table or viewer matrix. The rules page, the Social Security preview table, the rule-set descriptions and the tax drawer built from `TaxYearDetail` are not in the strategies design's page list.
Resolution: the three routes are registered (read-only; the viewer matrix covers them). The web step adds `/retirement/rules`, the preview table in profile step 4, the rule-set picker fed by `GET /rules`, and builds the year drawer from `TaxYearDetail`. The stale-tables note goes on the Results and Rules pages; the dashboard card stays one request.
Reason: the tax preview is the gate's year-by-year comparison tool, and provenance must be visible somewhere.

**C43. Deflating a year row with floats outside the engine** (strategies against `CLAUDE.md`, Phase 3 decision 1).
`deflateYearRow` runs in shared and in the browser and divides cents by a float price level.
Resolution: price levels are stored as fixed-point decimal strings with nine decimals; `deflateYearRow` computes `roundDivHalfAway(cents × 10^9, level × 10^9)` in bigint. The row's `totalReal` stays the engine's figure and `addUp` absorbs the cent.
Reason: "no floats for money outside the simulation engine" is a fixed decision.

**C44. Rounding of basis-point ratios** (strategies against Phase 2 and 3, inputs).
The strategies design rounds ratios half away from zero; Phase 3 decision 2 truncates every basis-point division outside six named sites, and the inputs design truncates.
Resolution: a ratio computed inside the engine package from float64 is an engine output and is rounded half away from zero at the boundary (L1). A ratio computed outside it from cents (`successBp`, `progressBp`, the savings rates, `fundedBp`) truncates.
Reason: both rules stand, each on its side of the boundary.

**C45. Bucket keys** (strategies against the enum).
`ByBucket` spells `preTax`; `PlanBucket` spells `pre_tax`.
Resolution: keys are the enum's members.

**C46. Names for the year the money ran out** (engine `failIdx`, inputs `depletion_year` and `depleted_year`, strategies `failure.firstYear` and `failureYear`).
Resolution: one definition, the calendar year of the first drawdown year whose floor was not funded; −1 in the series and null in a column for "never". Wire and columns say `depletionYear` / `depletion_year` (the `sim_run_path` column is renamed from `depleted_year`); the engine keeps `failIdx` internally.

**C47. Does the web import the engine?** (engine against strategies, inputs).
The engine design says the web imports `@meridian/retirement`. The strategy hints need `vpwPercentage`, and `resolvePlan` in the browser needs `minStartYear`, which `GET /meta` does not return.
Resolution: the web imports shared only. `vpwPercentage` lives in `shared/retirement/strategy.ts` (integer powers by multiplication) and the engine imports it. `RetirementMeta` gains `minStartYear`. The browser's `resolvePlan` runs without `contributionLimit`; that warning comes from the server's issue list.
Reason: a small bundle, and no data files or JSON imports in the Vite build.

**C48. Size of the stored tables** (inputs against strategies).
160 KB for the seven tables in one estimate, about 0.6 MB in the other, more with `TaxYearDetail` embedded.
Resolution: keep the 2 MB guard per table; the implementer measures the fixture run once and records the figure in the inputs design's 2.7.

**C49. Migration index** (inputs against the repository).
Resolution: `0007_phase4_retirement` at commit `8958fc6`, or whatever `pnpm db:generate` assigns.

**C50. Reference scenarios computed under superseded seams** (strategies against tax, inputs).
R1 and R2 assume unrounded thresholds (C22), `12 × benefit × cpi` for Social Security (C21; R1's 2029 benefits are 60,504 under SSA rounding, not 60,516.00), an age-based penalty test (C33) and fixtures in the engine's old input shape (C1). R2 does not say when person 1's benefit started, which the survivor rule needs.
Resolution: the two sheets are amended (rounding steps; SSA truncation; R2: both benefits started at full retirement age), then the tables are regenerated by the scratch reference and by the independent calculator, and all three derivations must agree as the design's procedure requires. Until then no R1 or R2 figure from 2028 on is an expected value. R3 and R4 are unaffected (no tax, no income).
Reason: the gate must compare against numbers produced under the rules the engine implements.

**C51. No default return model** (inputs against engine).
The inputs design builds `defaultRunSettings()` from `DEFAULT_RETURN_MODEL`; no design names it.
Resolution: `{ kind: "bootstrap", meanBlockYears: 10 }`, as an owner call (section 12).
Reason: it uses the spec's default of 10,000 paths and keeps crash-and-recovery sequences without asking the owner for return assumptions.

**C52. Accumulation rows and the cash identity** (strategies against engine).
The year drawer promises two lists that each add up to the row. Before the first retirement the engine models neither spending nor take-home pay, so income less tax less contributions does not equal funded spending.
Resolution: the identity is asserted for drawdown rows only; an accumulation row shows income, contributions, tax and withdrawals for goals, with the note "spending is not modelled before retirement".

## 4. One household through one year

Household: the inputs design's fixture (its 7.0 and test 11). Alex, born June 1975, retires June 2035; Sam, born September 1977, retires September 2039; plan start October 2026 (`firstYearMonths` 3); salaries 120,000 and 60,000; a 401(k) and an HSA owned by Alex, a Roth IRA owned by Sam, two joint taxable accounts, checking and savings; base spending 40,000 with healthcare included in base; Sam's nominal pension of 1,000 a month from September 2039; benefits of 2,800 and 1,900 a month as of 2026, both claimed at 67. Year walked: **2039** (plan-year index 13), which has wages, contributions, a pension start, spending, withdrawals, tax, rebalancing and returns. The household has no RMD and no benefit in 2039, so those two steps use the same household's 2050 (Alex is 75, both benefits in pay). Amounts are today's dollars before the year's price level.

| Step | As the designs are written | Where they do not fit | Ruling |
| --- | --- | --- | --- |
| Phase | Engine: Sam is `retired` from `retirementYear` 2039, so 2039 is a retirement-phase year. Strategies: transition while "someone living still works". Inputs: Sam is paid through August. | The flag is by year, the pay by month; the designs do not say which phase a retirement year is | C15: `retired` when `year(retirementMonth) ≤ year`; 2039 is a retirement-phase year with eight months of wages as income |
| Income: wages | Inputs: 60,000 × 8/12 = 40,000. Engine: an inclusive `endYear`, so 0 or 60,000 | 20,000 to 40,000 either way | C15 |
| Income: pension | Inputs: four months, 4,000, nominal from its first year. Engine: 12,000, with any fixed adjustment counted from 2026 | 8,000, and wrong growth for other pension types | C15, C16 |
| Contributions | Inputs: joint brokerage 5,000 × 40,000/180,000 = 1,111; Sam's Roth 3,000 × 40,000/60,000 = 2,000. Engine: a real amount or a share of one income. Tax: capped at limits, excess to the surplus account | Household scaling cannot be expressed; capping is in one design only | C26 |
| Payroll tax | Tax: 7.65% of 40,000 = 3,060 leaves the year's cash. Engine, strategies: not in the cash identity | 3,060 | C27 |
| Spending need | Strategies: 40,000 × phase 1.0 (constant spending, a target year); healthcare 0 because it is in base | Fits. The HSA consequence is below | |
| Withdrawal order | Strategies: cash, HSA for healthcare, taxable, pre-tax of non-early owners, free Roth. Tax: 59½ by month; Alex's HSA is penalized before June 2040 | The HSA tier's cap is 0, so Alex's HSA (1,250 today plus 3,600 a year of contributions to 2035) is ordinary income plus 20% and is drawn last | C33, C35 |
| Gross-up and tax | Engine: `assess` builds a record of named fields and annualizes. Tax: slots, own scaling, penalty bases from the caller. Strategies: thresholds × price level, unrounded | Three threshold rules for 2039; two signatures; in year 0 the scaling would run twice | C22, C23, C30, C31 |
| Taxable income from the accounts | Engine: gains from the trade list this year, dividends 1.3% all qualified, coupons 4.2%. Tax: pro-rata sale, class yields with qualified shares, rebalancing gain next year, bond interest from this year's cash return | Two models of the same accounts | C17, C18 |
| Rebalancing | Engine: each account to its target in the same trades as the flows. Tax: `rebalanceTaxable` after taxes on six classes | Duplicate | C17, C29 |
| Returns | Engine: six classes mapped to three series, less fund costs. Inputs: sends no expense ratio | The drag has no input | C25 |
| RMD (2050) | Engine: per account from the prior year-end balance, Uniform table. Tax: owner total, Joint table when the spouse is more than ten years younger | Fits for this couple (two years apart); the hook has no spouse age | C36 |
| Social Security (2050; claims in 2042 and 2044) | Engine: full-year benefit × its own cost-of-living index × `f`. Tax: PIA 2,800 → 2,900.80 in 2027 (published 3.6%), then path COLAs with SSA truncation; the months in pay; no spousal excess (1,968.40 own against 1,450.40). Strategies' sheets: 12 × benefit × cpi | Two COLA owners; twelve months paid in a claim year where seven (2042) and four (2044) are due | C20, C21 |
| Year 0 (October to December 2026) | Engine: `f0` = 80/365. Inputs, tax: 3/12 | Salary 26,301 against 30,000; every prorated amount differs by 14% | C14 |

Two things the walk shows that are not conflicts but that the owner should know. In accumulation years only explicit contributions are saved, while from the first retirement year the loop saves every dollar of a working spouse's wages left after tax, contributions and spending; the plan's saving behaviour therefore changes at Alex's retirement. And with healthcare included in base and no amount entered, the HSA is treated as a late, penalized source until C35 is applied.

## 5. Gaps against the spec's Phase 4 scope and gate

| # | Spec line | What is uncovered | Proposed |
| --- | --- | --- | --- |
| G1 | "Gate: hand-calculated test suite passes; a reference scenario lands within tolerance of an independent calculator." | The deterministic reference tables (R1, R2) and HC-T15, HC-S3, WD-5, WD-15 were computed under rules section 3 replaces; the engine's year-0 cases use the day fraction | Regenerate before use (C50, section 10) |
| G2 | "Parametric: correlated lognormal returns with user-set expected returns and volatilities" | The engine supports `custom`; the run-settings page offers only the two presets | Add a custom form (means and volatilities; correlations and persistence from history) |
| G3 | "Asset allocation per account from investment tracking, with an optional glide path." | The profile document and the engine carry a glide path; neither UI section has an editor for it | A household glide-path editor (reference person, age points) in the Accounts step |
| G4 | "life expectancy (fixed age or a mortality-table distribution)" | The sex-specific table needs `www.ssa.gov`, still refused; the fallback is unisex and from 2010, and `sex` then has no effect | Allow the host or have the owner supply the file; until then the form says the table is unisex |
| G5 | "Historical sequences: every rolling start year in the US record" | In `auto` mode with fixed life expectancy only complete windows run: for the fixture's 47-year plan, 52 start years (1928 to 1979); 1980 to 2025, including 2000, are left out | Owner call between `complete` and `wrap` as the default (section 12); the result already states the mode and the first and last start year |
| G6 | "retirement success rate from the latest saved run" | The card shows the newest finished run of the default scenario, not the newest run of any scenario | Keep, flagged; a card that changes meaning with the last scenario opened is worse |
| G7 | "a 'law change' scenario can swap in different rules" | Only the four rule sets shipped in the data; the owner cannot write one | Keep for v1, flagged by the tax design |
| G8 | "Contributions: current savings rate from the budget, by account, until retirement." | Seeded from measured flows into investment accounts, not from the budget's savings categories; saving into bank accounts is not seeded | Keep, flagged by the inputs design |
| G9 | "the planner reads both but writes only to its own scenario tables" | It also writes `job` and `audit_log`, and two tables beyond the spec's three | Keep, flagged |
| G10 | "Annual steps (monthly optional)" | `stepsPerYear` is the literal 1 | Per L3; the month windows, the Social Security month loop and `f` keep the door open |
| G11 | Worker: "Same codebase, separate container: sync scheduler, price fetcher, recurring detection, simulations", "Long jobs never block the UI" | The API process re-simulates one path for a non-stored percentile (milliseconds, but it is simulation in the web container) | Keep; the API never starts threads and never runs more than one path per request |
| G12 | "Year-by-year table for any percentile path" | After an engine or data upgrade only the seven stored percentiles of an old run remain | Keep, flagged; the page explains it |
| G13 | "Each year: income → contributions → spending need → withdrawals by strategy → taxes → rebalancing → returns." | Before the first retirement neither spending nor take-home pay is modelled, so a pre-retirement shortfall cannot show | Keep for v1 (engine decision 9), stated on the Results page |
| G14 | "Return models, selectable per run" | No design names the default model of a new scenario | C51 |

## 6. Lead decisions and Phase 1 to 3 decisions contradicted

| # | Decision | Where it is contradicted | Fix |
| --- | --- | --- | --- |
| K1 | L3: one rule for the first partial year | Days in the engine, months in inputs and tax, "whichever the loop uses" in strategies | C14 |
| K2 | L1: converted once, rounded half away from zero | Two rounding functions; a second scaling of year 0; float deflation of cents in shared and in the browser | C38, C23, C43 |
| K3 | L7: provenance for every data file; one data version | Two manifests and two versions; the nine COLA values of 2017 to 2025 are from memory with no source; the SSA life table is absent | C11; verify or delete the COLA history (the tax design's own fallback); G4 |
| K4 | L8: ownership | The tax design defines sales, reinvestment and rebalancing of taxable accounts (engine's state) and expects the strategies area to price candidates; the harness produces stored tables (inputs' storage); the reference sheets define indexing and Social Security rules (tax's); the tax design adds routes, pages and a settings block in other areas' files | C17, C31, C8, C22, C21; the cross-area requests are accepted in C4 and C42 |
| K5 | L7: "full input snapshot" | The engine's defaults (asset map, rebalancing mode, yields) were outside the stored input | C4; the rule "snapshot, data version or engine version" |
| K6 | `CLAUDE.md`: no floats for money outside the simulation engine | `deflateYearRow` | C43 |
| K7 | Phase 3 decision 2: basis-point divisions truncate | Ratios rounded half away from zero in the result mappers | C44 |
| K8 | Phase 3 decision 3: `enums.ts` is the single source | The engine redeclares `AssetClass` | C2 |
| K9 | Phases 1 to 3: `PlanError` with 400, 404 or 409; an unrunnable plan is 409 | Engine input errors "mapped to 400" | C13 |
| K10 | Migrations in sequence | `0005` is taken (and `0006`) | C49 |
| K11 | `CLAUDE.md`: "Don't start a phase until the previous gate passes" | Not a design fault: the verification of Phases 1 to 3 and the audit remediation are still in progress | Phase 4 code starts when they are green |

No design contradicts L2, L4, L5 or L6. Two notes: L2 makes two unmarried people file jointly (the inputs design flags it), and under L5 the warnings merge and the digest are order-independent only with C41.

## 7. Phase 5: what v1 must leave in place

No v1 choice blocks Phase 5 outright. These would make it expensive, and each has a cheap fix now.

| # | Phase 5 item | v1 choice at risk | Do now |
| --- | --- | --- | --- |
| F1 | Colorado tax | The federal input is summed to the household before the call; Colorado's pension and Social Security subtractions are per taxpayer and by age | `assess` keeps per-person scratch arrays (wages, taxable pensions, pre-tax distributions, benefits) and sums them into the slots; a state hook can read them later |
| F2 | IRMAA, ACA, state tax in the cash identity | `net` subtracts only federal tax and payroll tax | `Assessment` gets an `otherCharges` number (0 in v1) that `net` subtracts; the year row gets its field with schema version 2 |
| F3 | IRMAA's two-year look-back | The MAGI history starts empty; the profile has no "MAGI of the last two years" | Keep `MAGI_IRMAA ÷ f` for two years (C23); the field is a profile version 2 addition |
| F4 | IRMAA and ACA cliffs | The solver assumes `net` is increasing | Keep the contract "return the smallest amount found with `net ≥ 0`"; do not add assertions that `net` is monotone outside tests |
| F5 | Roth conversion search | Conversions fixed before the withdrawal solve | With C39 they are resolved in the loop into `convOut` / `convIn`; a Phase 5 hook between steps 3b and 4 writes the same arrays |
| F6 | Claiming-age grid, safe-spending and earliest-retirement solvers | One pool per run; one active run per scenario; a 15-minute cap | Keep `createSimPool` public; Phase 5 adds its own job type and table |
| F7 | Earliest-retirement solver | It must re-resolve the plan per candidate age, and `sim_run.input` holds only the frozen input | Keep `resolvePlan` pure and in shared (it is); the Phase 5 job freezes the document and baseline it resolves from |
| F8 | Paired scenario comparison | Market draws must not depend on the scenario; the default run refreshes the shared baseline | T42 (common random numbers) is a gate test; the comparison uses runs with equal baseline hashes or `refresh: false` |
| F9 | Lifetime taxes compared; after-tax ending wealth | Only ending wealth and the depletion year are stored per path | Optional now: two more series kinds (`lifetime_tax_real_cents`, `lifetime_spending_real_cents`), which the engine already computes per path |
| F10 | New settings (order choice, sensitivity shift, conversion policy) | `RunSettings`, `SimInput`, `SimSummary`, `YearTable` are strict version-1 documents in jsonb; only the profile has an upgrade function | `upgradeRunSettings` now; run views parse stored results by `schemaVersion` so old runs stay readable |
| F11 | Order comparison (bracket filling) | Needs bracket room at the order | `Assessment.taxResult` is the tax area's output record, which has `ROOM_IN_BRACKET`, `UNUSED_DEDUCTION`, `ROOM_IN_LTCG0` (C30) |
| F12 | Sensitivity to ±1% returns | `returnShift` has no setting | Keep the engine option; add the setting in Phase 5 |
| F13 | Run time of grids | The 5 µs per path-year budget was measured with stub tax functions; `fillPathTables` (about 120 slots per path-year) and the Social Security month loop are extra | Measure the real engine at the harness step and record it; it sizes every Phase 5 grid |

## 8. Data files

All under `packages/retirement/data/` unless a path says otherwise. Scratch copies named below are in `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/`.

| # | File | Format | Source | Validation |
| --- | --- | --- | --- | --- |
| D1 | `manifest.json` | JSON `{ dataVersion: "2026.11.0", firstTaxYear: 2026, lastPublishedYear: 2027, files: [{ path, sha256, sourceUrl?, retrieved?, description? }] }` | built by the skeleton step | every file under `data/` is listed; each SHA-256 is recomputed by `data.test.ts` (Node `crypto`, test only); `DATA_VERSION` equals `dataVersion`; `DATA_CHECKSUM` = SHA-256 of the files' hashes joined by newlines in manifest order; any data edit bumps `dataVersion` |
| D2 | `us-annual-returns.csv` and `us-annual-returns.meta.json` | header `year,stocks,bonds,bills,inflation`; 98 rows 1928 to 2025; six decimals; LF; SHA-256 `ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c` | `https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls` (SHA-256 `28b8110916a15a4dcc11c87c6422510704608ddedcdfa67a1298abdc22e49c69`) or `histretSP.xlsx` (`d7245bc8b09cd56cab5505188fe4aaddf6e0385b969310f33a4918019c321196`); sheet "Returns by year", rows 21 to 118, columns A, B (stocks), E (bonds), D (bills), U (inflation). Scratch copy: `mergeE/out/us-annual-returns.csv` | 98 rows; 1928 = 0.438112, 0.008355, 0.030800, −0.011561; 1931 = −0.438375, −0.025589, 0.023100, −0.093168; 1966 = −0.099710, 0.029079, 0.048557, 0.034591; 1974 = −0.259018, 0.019886, 0.078458, 0.123377; 2008 = −0.365523, 0.201013, 0.014000, 0.000914; 2022 = −0.180375, −0.178282, 0.020900, 0.064544; 2025 = 0.177237, 0.077955, 0.042100, 0.027351; column sums 11.617562 / 4.725913 / 3.346646 / 3.046171; arithmetic means 0.118547 / 0.048224 / 0.034149 / 0.031083; geometric means 0.100177 / 0.045346 / 0.033716 / 0.030357. Never the sheet "Nominal vs Real Data" (its 1966 inflation is 3.36%). Fallback: keep the committed CSV if the workbook has changed and say so in the meta file |
| D3 | `irs-2010cm-life-table.csv` and its meta file | header `age,lx`; 111 rows, ages 0 to 110; five decimals; SHA-256 `3ba08d9b67a2ff1c465b177563c8c6364eb99427c1ceda1cd05fd4b529b5a978` | `https://www.irs.gov/pub/irs-tege/table-2010cm-final.xlsx` (SHA-256 `51de7bde99fd2693994ac3ac3e894311048ed6009572679e9303d1a4d931e931`). Scratch copy: `mergeE/out/irs-2010cm-life-table.csv` | `lx[0]` = 100000; strictly decreasing; `lx[65]` = 84221.59, `lx[85]` = 41399.79, `lx[95]` = 8975.661, `lx[100]` = 1882.108, `lx[109]` = 15.47804, `lx[110]` = 0; `q[65]` = 0.012814, `q[85]` = 0.084651, `q[108]` = 0.487009, `q[109]` = 1; `q` non-decreasing from age 11; survival 65 to 95 = 0.1066; life expectancy at 65 = 19.11. Labelled fallback: unisex |
| D4 | `ssa-period-life-table.csv` and its meta file | header `age,male_qx,female_qx`; 120 rows, ages 0 to 119; six decimals. **Not retrieved** | `https://www.ssa.gov/oact/STATS/table4c6.html` (archive pattern `table4c6_2022_TR2025.html`); host refused | after fetching: 120 rows; every `qx` in (0, 1]; non-decreasing from age 40; `l_x` rebuilt from 100,000 within 1 of the published column; life expectancy within 0.02 years at 60, 65, 70, 80, 90; age-65 row to confirm (unverified: male 0.016455 / 79,084 / 18.12; female 0.010188 / 87,399 / 20.66). Absent: table mortality uses D3 and the result says `irs_2010cm_fallback` |
| D5 | `tax/federal-2026.json` | JSON as the tax design 2.2 | Rev. Proc. 2025-32 `https://www.irs.gov/pub/irs-drop/rp-25-32.pdf` (`e9ada115fb43a4af5ea326ca91edd40ab0bf29b9be01d2c13d7b8fa96214635b`; sections 4.01, 4.03, 4.14); Notice 2025-67 `https://www.irs.gov/pub/irs-drop/n-25-67.pdf` (`1eea8f141b0cddd182f9f09b3bc8ffad683d27ceb806dfc6da126811dc0a1f8d`); Rev. Proc. 2025-19 `https://www.irs.gov/pub/irs-drop/rp-25-19.pdf` (`ff2ba4bac62ef6940c57578d70f8be88ff3898ac806e921ad52787c11da35bf4`); SSA `https://www.ssa.gov/cola/` (not fetched) | cumulative tax at thresholds: single 1,240; 5,800; 17,966; 41,024; 58,448; 192,979.25; joint 2,480; 11,600; 35,932; 82,048; 116,896; 206,583.50; single thresholds 1 to 5 are half of joint; standard deduction 16,100 / 32,200; 0% gains maximum 49,450 / 98,900; 15% maximum 545,500 / 613,700; thresholds ascending; `pending` empty |
| D6 | `tax/federal-2027.json` | same | Rev. Proc. 2026-35 `https://www.irs.gov/pub/irs-drop/rp-26-35.pdf` (`87b383c6ce6e616fd006a61f5eed46fe67099b9c23fb1e1c42ff5359474513b8`; sections 3.01, 3.03, 3.15; unfilled release-date placeholder); Rev. Proc. 2026-24 `https://www.irs.gov/pub/irs-drop/rp-26-24.pdf` (`bcb6b41a835b84d4315f738a7250801831021829e39d70225424e2f45afcb715`); SSA fact sheet `https://www.ssa.gov/news/en/cola/factsheets/2027.html` (not fetched) | cumulative amounts single 1,280; 5,987; 18,549; 42,357; 60,349; 199,237.75; joint 2,560; 11,974; 37,098; 84,714; 120,698; 213,290.50; standard deduction 16,600 / 33,200; 0% maximum 51,050 / 102,100; 15% maximum 563,200 / 633,600; the six retirement-plan fields listed under `pending` and equal to 2026 until the IRS notice (`https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions`) |
| D7 | `tax/rules.json` | indexing steps, law changes, rule sets, `staleInflation` 0.025 | the two revenue procedures; Rev. Proc. 2022-38, 2023-34, 2024-40 (rounding structure); the IRS page on the senior deduction; the 2026 Trustees Report (not fetched) | every rule set's law-change id exists; ids unique and matching `^[a-z][a-z0-9_]{0,39}$`; `current_law` present; every `setValue` path in `LAW_PATHS`; every indexed path exists in the year files; inflation +3.0%, +2.5%, −1.0% reproduces the tax design's table J1 (2028 joint thresholds 26,350; 107,150; 224,750; 429,100; 544,950; 817,450) |
| D8 | `ss/rules.json` | full-retirement-age rows, reduction and credit fractions as exact strings, survivor constants, COLA history 2017 to 2025 | all on the refused host: Handbook §724, `https://www.ssa.gov/OACT/quickcalc/early_late.html`, POMS RS 00615.690, `https://www.ssa.gov/oact/cola/colaseries.html` | `fraMonths` 1937 = 780, 1938 = 782, 1943 and 1954 = 792, 1955 = 794, 1957 = 798, 1959 = 802, 1960 = 804; survivor table = retirement table at `birthYear − 2`; factors for 67: 7/10, 3/4, 4/5, 13/15, 14/15, 1, 27/25, 29/25, 31/25; COLA history contiguous, ending 2025. Fallback: delete the history years that cannot be confirmed (`ss_statement_old`) |
| D9 | `rmd/uniform-lifetime.json` | 49 divisors, ages 72 to 120; start-age rows | Pub. 590-B (2025) Appendix B Table III, `https://www.irs.gov/pub/irs-pdf/p590b.pdf` (`d18a592e55ce56d43953dc338272ece3984565792d6dca06989a6ca8121f7360`) | strictly decreasing; sum 532.0; 27.4 at 72, 26.5 at 73, 24.6 at 75, 20.2 at 80, 16.0 at 85, 12.9 at 89, 6.4 at 100, 2.0 at 120; start ages 72 (born 1950 or earlier), 73 (1951 to 1959), 75 (1960 and later) |
| D10 | `rmd/joint-life.json` | 101 × 101, ages 20 to 120; 60,575 bytes; SHA-256 `bd8af7bf76d6d97c5e822834def6975ce09e7821c39917bc32faf5f247ee5350` | Pub. 590-B (2025) Appendix B Table II. Scratch copy: `mergeT/data/rmd-joint-life.json` (hash confirmed) | symmetric; rows non-increasing; sum of all cells 368,500.6; (75, 64) = 25.3, (73, 62) = 27.2, (73, 60) = 28.6, (73, 50) = 36.8, (80, 65) = 23.8, (85, 70) = 19.5, (90, 75) = 15.4, (100, 85) = 8.5, (20, 20) = 72.0, (120, 120) = 1.0; `rows[a][a − 10]` equals the Uniform divisor for 72 to 120 except 112. Fallback: empty rows and `rmd_joint_table_unavailable` |
| D11 | `taxable/tax-drag.json` | six classes × (dividend yield, qualified share, interest mode and spread, tax-exempt share, gain distribution rate); basis reset shares and the community-property states | Pub. 551 `https://www.irs.gov/pub/irs-pdf/p551.pdf` (`0fbd4f0d37d575f95bd3dbdff09be846a2bf62e882902e02f0318739c4f904d2`) for the shares and states; the yields are assumptions | six classes; shares in [0, 1]; yields in [0, 0.15]. Under C17 and C18 the spread applies to the previous year's bill return, the cash class's own interest is not read, and `fallbackCashYield` is removed |
| D12 | `README.md` | the annual refresh runbook | tax design 6 | not data |
| D13 | `src/generated/data.ts` | generated from D2 to D4 by `scripts/build-data.mjs`, committed | | `data.test.ts` fails when it is stale |
| D14 | `reference/fixtures/r1.input.json` … `r4.input.json` | `SimInput` (C1), not the engine's old input shape | the reference sheets of the strategies design 7.6 to 7.9, amended per C50 | parse with `SimInput`; R1 and R2 use the fixed model, R3 the historical model with complete cohorts, R4 custom parametric parameters |
| D15 | `reference/fixtures/r1.expected.csv`, `r2.expected.csv` | CSV, one row per plan year | written by the independent calculator **after regeneration** | equal the regenerated tables within 0.01 per cell. The printed end values (1,873,550.06 and 24,757.85) are superseded |
| D16 | `reference/fixtures/r3.expected.json` | JSON | independent calculator on D2 | 50% stocks 64 of 69, failing start years 1964, 1965, 1966, 1968, 1969; 75% stocks 65 of 69, failing 1965, 1966, 1968, 1969; Trinity convention 37 and 38 of 39 |
| D17 | `reference/fixtures/r4.expected.json` | JSON | independent run of 4,000,000 paths | success 69.97% ± 1.5 points; median ending wealth about 337,500 ± 8% |
| D18 | `reference/fixtures/published.json` | JSON | Trinity study 1998 Table 3, `https://www.aaii.com/journal/199802/feature.pdf` (not reachable; secondary sources) | 95% at 50% stocks, 98% at 75% stocks, tolerance 5 points |

## 9. Unverified figures (consolidated)

Checked against a primary document in this session or by a designer and no longer unverified: the 2026 and 2027 brackets, deductions and gains thresholds; the 2026 plan and IRA limits (Notice 2025-67); the 2026 and 2027 HSA limits; the Uniform and Joint tables; the senior deduction's 6% phase-out (Schedule 1-A, 2025 form); the historical series and the fallback life table.

Still unverified; the implementer checks each before the gate:

1. Every Social Security figure and rule (`www.ssa.gov` answers 403): the 2026 and 2027 COLAs (2.8%, 3.6%), wage bases (184,500; 192,300), earnings-test amounts (24,480 and 65,160; 25,560 and 67,920); the reduction and credit fractions; the full-retirement-age table and the survivor table derived by a two-year shift; deemed filing; the 82.5% widow(er)'s limit and the order "reduce for age, then cap"; the 71.5% rate at 60; the spousal excess net of own delayed credits; the January rule for delayed credits; truncation to the dime and the dollar; the earnings-test credit-back in whole months.
2. The COLA history 2017 to 2025 in `ss/rules.json` (0.3%, 2.0%, 2.8%, 1.6%, 1.3%, 5.9%, 8.7%, 3.2%, 2.5%): from memory; only 2024 was confirmed.
3. The 2027 retirement-plan limits: not published on 2026-11-10; the file carries the 2026 amounts as pending. No forecast is stored.
4. RMD age 75 for people born in 1960 or later and 73 for 1959: the 2024 proposed regulations through secondary sources.
5. The statutory rounding steps (Code text not fetched); the published tables of 2023 to 2027 are consistent with them.
6. The SSA period life table's age-65 check values and which vintage the page holds.
7. Every number in `tax-drag.json`: dividend yields 1.3%, 2.8%, 3.5%; qualified shares 95%, 75%, 0%; the 1.0% bond spread. Assumptions. The year-0 reference rate of C18 is the 2025 bill return (4.21%).
8. The Trustees figures behind `ss_trust_fund_shortfall` (reserves exhausted late 2032, 78% payable); the family-maximum range behind ignoring it.
9. The "[Release Date, 2026]" placeholder in Rev. Proc. 2026-35 as retrieved: re-fetch and re-hash if the IRS replaces the file.
10. Chained CPI about 0.25 points below CPI-U (the optional wedge).
11. The conservative preset's means (5.5%, 4.5%, 3.2%, 2.5%): assumptions. The mean block of 10 years: a design choice.
12. The 2025 S&P 500 return: 17.72% in the workbook (used), 17.78% on the page.
13. The Bengen 2001 band: 15% below and 20% above (the default) against 10% and 25%; the paper was not fetched.
14. The Guyton and Klinger details: which withdrawal enters the freeze test, the prosperity rule in the final 15 years, negative inflation.
15. VPW's 5.0% and 1.9% and the 10% cap (reproduced from nine table values only); the younger spouse's age is a design choice.
16. The Trinity study's 95% and 98% (secondary sources) and its withdrawal timing; its values for other mixes are not asserted.
17. That the SSA statement's estimate is in today's dollars and assumes work continues to the claim age; Medicare at 65 and claiming ages 62 to 70 against the primary pages.
18. Every performance and size figure: 5 µs per path-year and 2 s on three threads (stub tax functions, one machine); 2.7 solver calls a year (scratch reference); storage of 0.3 MB a run and 0.6 MB for seven tables; whether `os.availableParallelism()` reflects a container quota.
19. The golden digests and bit patterns of the engine's T41 (to be re-pinned once from the implementation; the success counts are the portable assertions).
20. That static JSON imports with import attributes work under this repository's `tsc`, esbuild bundle, `tsx` and Vitest: stated by the tax design, not run.
21. **New from this review:** every R1 and R2 figure from 2028 on, HC-T15 (37,515.00), HC-S3 (37,822.50), WD-5 and WD-15, and the engine's year-0 values at 52/365, are computed under superseded rules (section 10).

## 10. Expected values that must be re-derived

| Suite | Cases | Why |
| --- | --- | --- |
| Engine | T14 (replaced by the inputs design's start-rule cases); the 52/365 parts of T9, T15, T21, T22, T31 (now 2/12 for a November start; the half-year parts of T32 and T33 keep their values); T16 (removed with the engine's cost-of-living index); the second example of T36 (third rank key removed); T25 (state the qualified share and a spread of 0.2%); T12's mortality rows (horizon now ends at `maxAge`); T41 (re-pin after implementation) | C14, C20, C9, C17, C18, C28 |
| Tax | F1 to F11 (replaced by the engine's trade cases and three blending cases: the fixture brokerage account's 1.72% and 86%; a bond account's interest from the previous year's bill return; a floor at 0 when that return plus the spread is negative); the sequence of 3.12 (replaced by section 2.3) | C17, C18 |
| Strategies | R1 and R2 from 2028 on; HC-T15 (37,400.00 under the statutory steps); HC-S3; WD-5; WD-15; the cash-identity cases gain the payroll term; request T3's age test is replaced by the penalty shares; fixtures rewritten as `SimInput` | C22, C21, C27, C33, C1 |
| Inputs | The fixture's frozen input (test 11) gains `expenseRatioPpm`, `inBase` and `settings.tax` / `settings.portfolio`; new resolver cases for `synthetic:cash`, `hsa_no_medical`, `expense_ratio_unknown`, `too_many_accounts` and the engine's `validateInput` issues | C4, C24, C25, C35, C13 |

## 11. Build order

Precondition: the Phase 1 to 3 verification is green (K11), and `docs/phase-4-plan.md` records the rulings of this report the lead accepts (precedence as in Phase 3: spec, plan, this file, area design). Once step 4 is in, three lanes can run in parallel: the tax functions (steps 6 to 11), the engine's mathematics (steps 12, 13 and 15) and the resolver, schema and services (steps 23 to 26, on a fake engine). The lanes meet at steps 14, 16 and 17. Each step lists what proves it alone.

**Package scaffold and data files**

1. Scaffold `packages/retirement` (exports `.`, `./node`, `./testing`; depends on shared and zod), wire it into the worker and API manifests, both Dockerfiles' runtime stages and the root ESLint restricted-`Math` block; add `units.ts`, `detmath.ts`, `version.ts`, `selftest.ts`. Tests: T5, T39 with K9's cent cases, T46. Reason: every later step imports these, and the determinism lint must exist before the code it polices.
2. Shared contracts in `packages/shared/src/retirement/`: primitives, profile, baseline, settings (section 2.1), `SimInput`, `returnModel.ts`, `strategy.ts`, `results.ts`, `tax.ts`, `api.ts`, the enum additions, `upgradeRunSettings`. Tests: schemas parse their defaults; the request-guard check. Reason: all four lanes compile against one set of names (the Phase 2 and 3 skeleton pattern).
3. Shared pure helpers with no engine dependency: merge patch, canonical JSON and hash, `planBucketOf`, `planStart`, `ageMonth`, `classWeights`, `glideWeightsAt`, `rankPaths` and codecs, `addUp`, bigint `deflateYearRow`, `fundedShareBp`, `vpwPercentage`. Tests: inputs 1 to 5, 14, 16, 17; OUT-1 to OUT-3, OUT-6, OUT-7; the VPW table. Reason: the engine, the services and the web all call them.
4. Data files D1 to D13 with the manifest, `build-data.mjs`, the generated module and `data.test.ts`. Tests: T13, A1 to A7. Reason: every numeric test downstream reads them; pin and validate before anything depends on a value.
5. Reference sheets amended and R1, R2 regenerated on paper (C50) with the scratch reference. Reason: the independent calculator (step 22) and the gate need settled expected values; doing it early exposes a rule nobody can compute by hand.

**Pure tax, RMD and Social Security functions**

6. `layout.ts`, `taxData.ts`, `compile.ts` (`compileTaxLaw`, `fillPathTables`). Tests: J1, J2, J4 to J8, K5, K7. Reason: the per-path table is the input of every tax call.
7. `federalTax.ts` (`federalTaxInto`, `computeFederalTax`, `effectiveMarginalRates`). Tests: B, C, D, J3, K1 to K4, K9, HC-T1 to HC-T14 and HC-T16, HC-T15 re-derived. Reason: the spec's first hand-calculated case, and everything in `assess` depends on it.
8. `penalties.ts`, `rothBasis.ts` with `rothFreeAmount`. Tests: E1 to E10. Reason: the order's tiers (step 20) need the penalty shares and free amounts.
9. `rmd.ts`. Tests: G1 to G6, G8, HC-R1 to HC-R3. Reason: the spec's second hand-calculated case.
10. `socialSecurity.ts`. Tests: H1 to H17, HC-S1, HC-S2. Reason: largest unverified surface; isolating it makes the SSA check a one-file review once the host is allowed.
11. `contributionLimits.ts`, `payroll.ts`, `compileTaxDrag` with the blending of C17, `warnings.ts`, `notModelled.ts`, `rulesView.ts`. Tests: I1 to I5, K8, the three blending cases. Reason: completes what `prepare` and the API consume from the tax area.

**Return models and randomness**

12. `rng.ts`, `invNorm`, `cholesky`, the lognormal conversions. Tests: T1 to T8. Reason: known-answer vectors pin the generator before any model uses it.
13. Return models, the estimator, the year-0 rule with the month fraction, `mortality.ts` with `adjustYears` and `maxAge`. Tests: T9 to T12, T15, T17, T18 (re-derived where section 10 says). Reason: models are testable without a loop.

**Year loop**

14. `prepare(input: SimInput)`: asset mapping, glide tables through shared, month-share tables for streams and contributions, basis seeding (C18), the surplus account, the tax and Social Security compiles, `validateInput`, the error codes. Tests: T29, T30 with month windows and the indexing of C16, the contribution rule of C26, the fixture's frozen input prepared to stated values. Reason: this is the adapter the designs left unowned; testing it alone keeps unit mistakes out of the loop.
15. `trades.ts`. Tests: T23. Reason: realized gains and basis are pure arithmetic.
16. The loop with stub functions on the real slot layouts (`loop.ts`, `hooks.ts`, `assess`, `testing/stubs.ts`). Tests: T19 to T22, T24 to T28, T31 to T34, T45. Reason: the cash identity is proven before the real tax function can hide an error.
17. The real tax, RMD, Social Security, payroll, limits and basis-reset functions inside `assess` and the loop (section 2.6). Tests: G7, E-cases through the loop, the year-0 double-scaling case (C23), a mid-year claim (C21). Reason: this is where three areas meet; it gets its own step and its own tests.

**Strategies and withdrawal order**

18. `prepareStrategies`, `plannedYear`, `decideSpending`. Tests: ST-1 to ST-17. Reason: pure functions of the view and the state.
19. Tiers, `fill`, `solve`, `planWithdrawals` with the penalty shares of C33. Tests: WD-1 to WD-21. Reason: needs steps 17 and 18; the solver's cost and monotonicity are checked against the real tax function.

**Thread harness and aggregation**

20. `aggregate.ts` and the mappers `toSimSummary`, `toFanSeries`, `toYearTable`. Tests: T35 to T38, T40, T43, OUT-4, OUT-5, OUT-8 to OUT-12. Reason: aggregation is independent of threads.
21. The pool, `runThreadMain`, the facade of section 2.4. Tests: T41, T42, T44, T47; the bench recorded (F13). Reason: chunk and thread invariance is the L5 proof.
22. The independent calculator and fixtures; `reference.test.ts`. Tests: the three-way agreement of R1 and R2, R3, R4. Reason: written from the sheets by an agent that has not read `src/`.

**Database and services**

23. `resolvePlan` and `aggregateContributions` in shared. Tests: inputs 6 to 13, 15, 18, plus the new cases of section 10. Reason: pure; the services and the form both call it.
24. Schema and migration `0007_phase4_retirement`. Tests: inputs 19. Reason: constraints verified before any service writes.
25. `retirementBaseline.ts` (with the expense-ratio measurement) and the two exports from `plan.ts` and `dashboard.ts`. Tests: inputs 20. Reason: read-only, on the fixture.
26. Profile, scenario and run services with the fake engine, retention, the card. Tests: inputs 21 to 31. Reason: the lifecycle is testable without the real engine.

**Worker job**

27. `retirement.simulate`, `simThread.ts`, the second bundle, `env.ts`, `.env.example`, compose. Tests: inputs 38, 39; one run of the real engine inline on the fixture. Reason: error mapping and cancellation need the real error classes.

**API**

28. Routes 1 to 24, `app.planner`, the view mappers. Tests: inputs 32 to 37 with the viewer matrix extended to routes 22 to 24; the tax preview against B1 and C6. Reason: contracts are frozen by step 2, so this is wiring.

**Web**

29. Pure web helpers and chart builders. Tests: CH-1 to CH-5, UI-1 to UI-5. Reason: testable without pages.
30. Pages: profile wizard (with the glide-path editor and the Social Security preview), scenarios and editor (with the custom parametric form and the rule-set picker), results, history, rules, the dashboard card. Tests: typecheck, build. Reason: last, because every state it renders is defined by the contracts.

**Gate**

31. `gate.test.ts` (the union of the hand suites and R1 to R4), `apps/api/src/retirementGate.test.ts`, the full suite, typecheck, lint, build, smoke; the measured run time and storage recorded; the owner's outside comparison in `docs/phase-4-gate.md`. Reason: the spec's gate, on numbers regenerated under the rules that were built.

## 12. Calls for the lead or the owner

These rulings change a result the owner will read, or overrule an area design. Each has a recommendation above; none blocks the skeleton.

1. First partial year by months (C14). All four designs asked for this decision.
2. Fund costs seeded from measured expense ratios (C25); the inputs design decided against.
3. Bond interest from the previous year's bill return plus a spread (C18), in place of a fixed 4.2% or a same-year rate.
4. Payroll tax on by default (C27) and contributions capped at the limits (C26).
5. The default return model of a new scenario (C51), and whether the historical model's default is complete cycles or wrap-around (G5).
6. Full rebalancing of taxable accounts by default, which realizes gains every year, against `flows_only` (engine open question 9).
7. Healthcare amounts kept for the HSA when they are included in base (C35).
8. Regenerating R1 and R2 under statutory rounding and SSA rounding (C50), against adding switches that turn both off for the reference runs. Regeneration is recommended: a switch would mean the gate tests a mode nobody uses.
9. Allowing `www.ssa.gov`, or supplying the life table and confirming the Social Security figures by hand, before the gate (section 9, items 1, 2 and 6).
