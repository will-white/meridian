# Phase 4 design: Simulation engine and return models

Area: the pure engine in `packages/retirement` (`@meridian/retirement`): `EngineInput` and `EngineResult`, the per-path state, the year loop and its hooks, the asset mapping and rebalancing, the three return models, inflation and the cost-of-living index, mortality draws, the random number generator, the worker-thread harness, aggregation, determinism and the performance budget.

This is the merged area design. Design A (fidelity-first) is the base; the grafts both judges asked for from Design B (performance-first) are folded in, and every flaw and wrong figure the judges named is resolved in the text. §12 is the judging record, including the four places where a judge is overruled and why.

How the numbers in this document were produced. A scratch reference implementation of exactly the final rules below (nothing in the repository was modified) is in `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeE/proto/` (`rng.mjs`, `models.mjs`, `loop.mjs` and the runners `t_math.mjs`, `t_models.mjs`, `t_loop.mjs`, `t_more.mjs`, `t_gold.mjs`, `bench.mjs`). It reproduces the Random123 known-answer vectors; its stream values equal the ones Design B published for the same layout although its generator code is Design A's (two independent implementations agree); and it generated every figure in §3 and §7. The historical series and the fallback life table were re-fetched from the primary sources on 2026-11-10 during the merge and reproduce the recorded checksums (§2.8). `www.ssa.gov` is still refused by this environment (HTTP 403 to a direct request, name resolution refused to the fetch tool), so the SSA life table is specified by format and checks only.

Files this area adds (all new; the touch points outside the package are listed in §6):

```
packages/retirement/package.json            name @meridian/retirement; exports "." (core), "./node" (harness) and "./testing" (stub hooks); dependency zod; devDependency tsx
packages/retirement/tsconfig.json, vitest.config.ts
packages/retirement/data/us-annual-returns.csv, us-annual-returns.meta.json
packages/retirement/data/irs-2010cm-life-table.csv, irs-2010cm-life-table.meta.json      labelled fallback life table
packages/retirement/data/ssa-period-life-table.csv, ssa-period-life-table.meta.json      added when www.ssa.gov can be fetched
packages/retirement/data/manifest.json      shared with the tax area's data files
packages/retirement/scripts/build-data.mjs  CSV -> src/generated/data.ts
packages/retirement/src/generated/data.ts   generated, committed
packages/retirement/src/version.ts          ENGINE_VERSION, DATA_VERSION, DATA_CHECKSUM
packages/retirement/src/units.ts            centsToDollars, dollarsToCents
packages/retirement/src/detmath.ts          detExp, detLog, detPow, powInt
packages/retirement/src/rng.ts              threefry2x32, seedKey, uniformAt, invNorm, stream ids
packages/retirement/src/selftest.ts         start-up self-test
packages/retirement/src/input.ts            EngineInputSchema (Zod), EngineInput
packages/retirement/src/prepare.ts          prepare(), error classes, asset mapping, glide tables, death tables
packages/retirement/src/returns/{fixed,historical,bootstrap,parametric,estimate}.ts
packages/retirement/src/mortality.ts
packages/retirement/src/state.ts            PathState, YearView
packages/retirement/src/trades.ts           planTrades (withdraw and rebalance)
packages/retirement/src/loop.ts             simulatePath, simulateChunk, simulatePathDetail
packages/retirement/src/hooks.ts            EngineHooks interfaces and the static registry
packages/retirement/src/aggregate.ts        percentileIndex, wilson95, rankPaths, digest, aggregate
packages/retirement/src/result.ts           EngineResult, PathDetail, ChunkSummary
packages/retirement/src/index.ts            core exports (no node: import anywhere under src/ except src/node)
packages/retirement/src/node/{pool.ts,thread.ts,index.ts,thread.boot.mjs}   worker-thread harness
packages/retirement/src/testing/stubs.ts    stub hooks for tests (flat and bracket stub taxes, constant real spending with lumps, order withdrawal with the reference solver, RMD by divisor, fixed Social Security)
packages/retirement/bench/run.ts            performance measurement
packages/retirement/src/**/*.test.ts        the §7 cases
```

## 1. Decisions (binding)

1. **Package.** `packages/retirement` is pure TypeScript with no I/O. Only `src/node/*` imports `node:` modules. The web and the API import `"@meridian/retirement"`; the worker imports `"@meridian/retirement/node"`. Reason: L1; tests and, later, the browser run the same core.
2. **Units.** At the boundary money is integer cents as decimal strings, rates are fractions per year (0.07), weights are integer basis points summing to 10000, expense ratios are ppm, years are calendar years, the seed is a decimal string. Inside the engine money is float64 nominal dollars. `prepare()` converts once (`Number(cents) / 100`); results are converted once (`dollarsToCents`, half away from zero). Reason: L1 and the Phase 2/3 wire conventions.
3. **Three simulated assets plus inflation: `stocks`, `bonds`, `bills`.** The app's six asset classes map onto them through a recorded matrix `assetClassMap` (default: us_stock, intl_stock, real_estate, other → stocks; bonds → bonds; cash → bills). Reason: these are the four series the spec names and the only ones with a continuous US record; one state layout serves all three models.
4. **Historical data is Damodaran's workbook, sheet "Returns by year", 1928–2025 (98 years):** S&P 500 total return, 10-year Treasury total return, 3-month T-bill return, CPI-U inflation. Reason: exactly the spec's "stocks, bonds, bills, inflation", annual, primary source, pinned by checksum. The sheet "Nominal vs Real Data" of the same workbook must not be used (§2.8).
5. **Accounts are simulated individually (1 to 32),** each with a tax treatment (`taxable | pre_tax | roth | hsa | cash`), an owner (person 0, person 1 or joint), balances and cost basis by simulated asset, its own target mix or glide path and its own expense ratio. Reason: the spec's five account groups, "allocation per account" and "withdrawals by account"; RMDs and age rules are per owner.
6. **Annual calendar-year steps; every cash flow of year t happens at the start of the year, in the spec's order, and the year's returns then apply to what is left.** Reason: the spec lists returns last; it is the convention of FIRECalc-style calculators (cFIREsim's source withdraws at the beginning of the year); it is conservative for a retiree.
7. **One rule for the partial first year.** Year 0 is the rest of the current calendar year with `f0 = (days from asOf through Dec 31, inclusive) / (days in the year)`. Every recurring per-year amount is multiplied by `f0`; a dated lump (a one-off goal, a scheduled Roth conversion) is never scaled; a per-year probability `q` becomes `1 − (1 − q)^f0`; the year's log return and log inflation are `f0·m + √f0·(x − m)` with `m` the model's mean (§3.5), which is plain compounding `(1 + r)^f0` for a deterministic series; tax is computed by annualization (`f0 × T(income / f0)`), so the tax function never sees `f0`. Later years have `f = 1`. Reason: L3; one parameter `f` in every formula, which is also the seam for monthly steps; the √f term keeps the right dispersion for a part-year.
8. **One price index, one cost-of-living index.** `cpi[t]` is the price level at the start of year t (`cpi[0] = 1` = today's dollars); it indexes spending, real income streams, contributions and tax thresholds. `colaIndex[t]` is what a Social Security benefit in today's dollars is multiplied by in year t: it follows `cpi` but never falls, and it takes an already published cost-of-living adjustment where one exists (§3.1). Flows of year t are deflated by `cpi[t]`, end-of-year balances by `cpi[t+1]`. Reason: the spec's "inflation drives spending, brackets and COLAs together"; L4; current law pays no negative adjustment.
9. **Two phases.** Before the first person's retirement year the household is in *accumulation*: contributions go in, wages pay for taxes and living costs, and the portfolio is touched only for one-off goals and forced distributions (RMDs, scheduled conversions). From that year on it is in *drawdown*: the full cash identity holds each year. Reason: measured contributions are reliable, pre-retirement spending versus take-home pay is not; a mismatch must not create phantom withdrawals.
10. **Taxes for year t are settled in year t.** The withdrawal hook finds the withdrawals that close the cash identity using an engine-supplied `assess(w)` that returns tax and net cash for a candidate withdrawal vector, including the gains the resulting trades realize and the year's dividends and coupons. Reason: the lead's same-year rule; one place knows what a withdrawal means for tax.
11. **Taxable-account yields.** Stock dividends (`stockDividendYield`, default 0.013, all qualified) and bond coupons (`bondInterestYield`, default 0.042) are fixed yields on the account's post-trade balances, taxed in the same year and added to basis. Interest on bills (in taxable and cash accounts) is the whole actual bill return; it is only known after the year's returns, so it is taxed with year t+1 through the carry-over state. Reason: tax drag must exist and must not need look-ahead; value and basis stay consistent for cash.
12. **Rebalancing is annual, per account, to that account's target (or glide path), executed together with the year's flows as one trade list per account.** In taxable accounts sales realize gains at the average cost of that account and asset, taxed in the same year because `assess` previews the same trades. Option `taxableRebalance: 'flows_only'` never sells beyond what the withdrawal needs. Reason: the cited historical studies assume annual rebalancing; combining flow and rebalance avoids selling and buying the same asset.
13. **Fund costs are a per-account annual drag** `(1 − expenseRatioPpm / 1e6)` on the growth factor. Reason: index returns are gross of fees; Phase 3 already knows each account's weighted expense ratio.
14. **Historical model = rolling cohorts.** Path k uses cohort `k mod C`; a cohort is a start year followed in calendar order. `cohorts: 'complete'` uses only start years whose whole window fits in the record (the Trinity/FIRECalc/cFIREsim rule); `'wrap'` uses all 98 start years and continues from 1928 after 2025; `'auto'` (default) is complete when every person has a fixed life expectancy and at least 30 complete cohorts exist, else wrap. The result states which was used. Reason: the spec's "every rolling start year"; with mortality draws the horizon runs to the end of the life table, and complete windows would then discard every start year after the mid-1960s although almost no path lives that long.
15. **10,000 paths versus under 100 start years.** With fixed life expectancy the historical model runs exactly C paths (one per cohort) and ignores `pathCount`; with table mortality it runs `C × ceil(pathCount / C)` paths so every cohort gets the same number of mortality draws. Reason: repeating identical market paths adds nothing; stratifying keeps every cohort's weight equal.
16. **Block bootstrap = the stationary bootstrap of Politis and Romano:** each year a new block starts with probability `1 / meanBlockYears` at a uniformly random year, otherwise the next calendar year follows, wrapping 2025 → 1928; whole rows (stocks, bonds, bills, inflation) are resampled together. Default mean block 10 years. Reason: the spec's "multi-year blocks"; random lengths keep the resampled series stationary; joint rows keep correlations and the inflation link.
17. **Parametric model = correlated lognormal.** The four innovations (stocks, bonds, bills, inflation) are jointly normal through a 4×4 Cholesky factor. Log inflation is AR(1); log bill returns may be AR(1) too (`persistence`, default 0). With every persistence 0 this is exactly the spec's iid correlated lognormal. User means are read as arithmetic or geometric per `meanKind`, volatility as the standard deviation of the simple annual return; presets `historical` (estimated from the data file by a stated estimator) and `conservative`. Reason: the standard model, with the one extension inflation needs and an optional one for cash.
18. **Mortality:** a fixed age, or one uniform draw per person per path inverted through a life table; the probability of dying in a calendar year is the mean of the table's values at the two ages the person has in that year, times `qScale`; a death takes effect at the end of its calendar year. The table is the SSA period life table by sex when installed, otherwise the IRS Table 2010CM (unisex), clearly labelled in the result. Reason: the spec's two options; one draw per person keeps a path re-simulatable; a real published table is the fallback, no table values are invented.
19. **End of plan and success.** A path ends with the year of the last death. A path succeeds when in every drawdown year the funded spending is at least the floor the spending strategy declares for that year; a failure is permanent but the path keeps running so shortfalls are measured. Reason: one definition that works for one or two people and for all five strategies.
20. **Random numbers are Threefry2x32 with 20 rounds: key = the 64-bit seed, counter = (path index, purpose·2^24 + step·2^8 + slot);** uniforms use 52 bits; normals are the inverse normal CDF (Wichura AS241, PPND16) of one uniform each. Reason: L5; it needs only 32-bit adds, rotates and xors (exact in JavaScript), has published known-answer vectors, and any draw is addressable without generating the ones before it, so two scenarios with one seed see identical markets.
21. **Determinism rule: the core uses only `+ − × ÷`, `Math.sqrt`, `Math.floor/round/abs/min/max/imul` and integer operations; it never calls `Math.exp/log/pow/sin/cos` or `**`.** Exponentials and logarithms are the engine's own `detExp` / `detLog`. Reason: ECMAScript specifies the listed operations exactly and leaves `Math.exp` and friends implementation-approximated (V8's current source delegates them to LLVM libc where Node 22 uses an fdlibm port); results must not change with the CPU, the Node version or, later, the browser.
22. **Hooks are static modules selected by id; `EngineInput` carries data only.** Tests may inject hook objects in-process. Hooks write into preallocated out-records and typed arrays and return nothing. Reason: functions cannot cross a thread boundary or be stored in `sim_run`; no allocation in the year loop.
23. **No look-ahead.** Hooks receive a view of the start-of-year state and last year's outcomes, never the current year's return or inflation. Reason: a strategy that sees the year's return is not a strategy.
24. **Harness:** a pool of `worker_threads` owned by the caller for one job, fixed chunks of 250 paths handed out on request, results returned as transferred typed arrays, progress per chunk, cancellation by terminating the workers, a start-up self-test in every thread, thread count from a setting (`0` = run inline) with default `max(1, min(8, availableParallelism() − 1))`. The thread entry is a bundled JS file in production and a small `tsx` bootstrap file in dev and tests. Reason: simple, measurable, independent of how paths are split; a `.ts` worker entry started with `--import tsx` cannot resolve the repo's `.js` import specifiers (reproduced), the bootstrap can.
25. **Aggregation is exact.** The run keeps three numbers per path-year (portfolio value nominal and in today's dollars, funded spending in today's dollars) and a few per path, as float64; no path detail is kept. Percentiles are nearest-rank order statistics (`percentileIndex`), so every reported percentile is an actual path's value; the success-rate interval is Wilson's. Reason: sketches are approximate and order-dependent; 10,000 × 61 × 24 bytes is under 15 MB.
26. **A "percentile path" is a real path, and it carries the headline number:** paths are ranked by ending wealth in today's dollars (ties: earlier failure first, then larger shortfall, then path index) and percentile p is the path at the nearest rank; its year table comes from re-simulating that one path with detail on, so the table's last row equals the reported percentile of ending wealth. Reason: a band edge of the fan chart is not a path anyone could have lived, and a table that does not end at the headline number confuses.
27. **Path count** defaults to 10,000 and is capped at 100,000; the horizon is capped at 120 years; `paths × years ≤ 6,000,000`. Reason: spec default; bounded memory (144 MB at the cap).
28. **First death:** the deceased's pre-tax, Roth and HSA accounts roll to the survivor; the basis of every taxable holding is reset toward its value by a share that follows ownership (the decedent's own account: all of the gap, a joint account: half by default, the survivor's own account: none), up or down; the survivor files single from the next year. Reason: L2; IRC §1014(a) resets basis to fair market value in both directions and §2040(b) includes half of a spousal joint interest.
29. **All realized gains are long-term; losses go to the tax function, which returns the carryforward the engine stores.** Reason: annual steps cannot see holding periods under a year.
30. **A fourth, deterministic model `fixed`** (a listed or constant series) exists for hand-calculated tests and reference scenarios. Reason: the gate needs paths anyone can check with a calculator, through the public API.
31. **Versions and digest.** `ENGINE_VERSION` changes with any change in numeric behaviour, `DATA_VERSION` with any data file. Every result carries both, the data checksum, the seed and a digest (FNV-1a over the ending nominal wealth and failure-year arrays). A pinned golden run fails the build when numbers change without a version bump. Reason: the spec's accuracy guardrails and L7; the digest makes cross-machine reproducibility checkable.
32. **Errors.** Bad input raises `EngineInputError(code, message)` from `prepare()` before any thread starts; a hook that breaks its contract raises `EngineInvariantError`; both are permanent (no job retry) and keep their class across the thread boundary; data problems inside a path never throw. Reason: the engine must be total over valid input, and a deterministic failure must not be retried.
33. **Performance budget:** 10,000 paths over 60 years in at most 3 s on one thread (5 µs per path-year) and 2 s wall on three threads of the reference machine, at most 24 `assess` calls in any year, measured by `bench/run.ts`. Reason: the spec's open question on engine speed; Phase 5 runs grids of such runs.

## 2. Data model

### 2.1 Constants

```ts
export const ENGINE_VERSION = "1.0.0";
export const SIM_ASSETS = ["stocks", "bonds", "bills"] as const;      // index 0, 1, 2
export const TREATMENT = { taxable: 0, pre_tax: 1, roth: 2, hsa: 3, cash: 4 } as const;
export const PURPOSE = { MARKET: 0, BOOT: 2, MORTALITY: 3 } as const;  // 1 reserved; 4..15 reserved for the engine; 16..255 free for later hooks
export const LIMITS = { maxAccounts: 32, maxPaths: 100_000, defaultPaths: 10_000, maxYears: 120, maxPathYears: 6_000_000,
                        chunkPaths: 250, minCompleteCohorts: 30, assessMaxCalls: 24 };
export const CASH_TOL = 0.005;                                         // dollars: half a cent
export const DEFAULT_FAN_PERCENTILES_BP = [1000, 2500, 5000, 7500, 9000];
export const DEFAULT_ASSET_CLASS_MAP = {                               // basis points to [stocks, bonds, bills]
  us_stock: [10000, 0, 0], intl_stock: [10000, 0, 0], bonds: [0, 10000, 0],
  cash: [0, 0, 10000], real_estate: [10000, 0, 0], other: [10000, 0, 0] };
```

The six asset-class keys are the values of `AssetClass` in `packages/shared/src/enums.ts`; the engine declares them itself (it depends only on `zod`) and a test in the inputs area asserts the two lists are equal.

### 2.2 `EngineInput` (the boundary type; plain JSON; stored whole in `sim_run`)

Conventions: `Cents` is a decimal string of integer cents, `/^-?\d{1,15}$/`, in today's dollars at `asOf` unless stated; `Rate` is a JSON number, a fraction per year; `Bp` is an integer 0..10000; `Year` is a calendar year.

| Field | Type | Unit and meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | shape version |
| `asOf` | `YYYY-MM-DD` | the plan's "today" (from `resolveToday`); `startYear = year(asOf)`; fixes `f0`. Neither is a separate input, so they cannot disagree |
| `seed` | decimal string, 0 .. 18446744073709551615 | run seed (64 bits) |
| `pathCount` | integer 1..100000 | requested paths (decision 15) |
| `persons` | `PersonInput[1..2]` | index 0 is the primary person |
| `accounts` | `AccountInput[1..32]` | liquid, investable accounts only |
| `assetClassMap` | `Record<AssetClass, [Bp, Bp, Bp]>` | each row sums to 10000 |
| `incomes` | `IncomeStreamInput[]` | salary, part-time, pension, annuity, rental |
| `contributions` | `ContributionInput[]` | by account |
| `conversions` | `RothConversionInput[]` | the user-entered schedule (L6) |
| `socialSecurity` | owned by tax-rmd-ss | opaque to the loop; read by their hook |
| `spending` | owned by strategies | strategy id and parameters; opaque to the loop |
| `withdrawal` | owned by strategies | `{ orderId, ... }` |
| `tax` | owned by tax-rmd-ss | `{ lawScenario, ... }` |
| `portfolio.taxableRebalance` | `'full' \| 'flows_only'` | default `full` |
| `portfolio.stockDividendYield` | Rate | of the post-trade stock balance in taxable accounts, per year; default 0.013 |
| `portfolio.bondInterestYield` | Rate | of the post-trade bond balance in taxable accounts, per year; default 0.042 |
| `portfolio.jointBasisStepUp` | `'half' \| 'full' \| 'none'` | share of the gap between value and basis reset in joint taxable accounts at the first death; default `half` (`full` = community property) |
| `portfolio.surplusAccountId` | string or null | where surplus cash goes; null = first taxable account, else first cash account |
| `returnModel` | `ReturnModelInput` | below |
| `returnShift` | `{ stocks, bonds, bills }` Rate, optional | added to every simple annual return in every model (times `f0` in year 0); default 0 (the seam for v2 sensitivity) |

`PersonInput`: `birthYear: Year`; `retirementYear: Year` (first year without wages; birth year plus retirement age); `mortality: { kind: 'fixed', age: 50..119 } | { kind: 'table', sex: 'male' | 'female' | 'unisex', qScale: 0.25..4 (default 1) }`; `rothContributionBasisCents: Cents` (regular Roth contributions not yet withdrawn, default "0"); `rothRecentConversions: { year: Year, amountCents: Cents }[]` (conversions made in `startYear − 4 .. startYear`, default empty). The last two seed the Roth state the tax area's ordering function reads.

`AccountInput`: `id: string`; `name: string`; `treatment`; `owner: 0 | 1 | null` (null = joint; required non-null for `pre_tax`, `roth`, `hsa`); `holdingsCents: Record<AssetClass, Cents>` (current value by class, each ≥ 0); `basisCents: Record<AssetClass, Cents> | null` (cost basis by class; required for `taxable`, null elsewhere); `target: { year: Year, weightsBp: Record<AssetClass, Bp> }[] | null` (glide points sorted by year, each summing to 10000; null = hold the current mix); `expenseRatioPpm: integer ≥ 0`. Accounts with treatment `cash` are simulated as 100% bills whatever their holdings say.

`IncomeStreamInput`: `id`; `person: 0 | 1 | null`; `kind: 'salary' | 'part_time' | 'pension' | 'annuity' | 'rental' | 'other'`; `annualCents: Cents` (per year at plan start); `startYear`, `endYear: Year | null` (inclusive; null = for the owner's life, or while anyone is alive for a joint stream); `growth: { kind: 'real', rate: Rate } | { kind: 'nominal', rate: Rate }` (`real`: `× cpi[t] × (1 + rate)^t`, a salary with raises above inflation, or a pension with a cost-of-living clause at rate 0; `nominal`: `× (1 + rate)^t`, rate 0 is a pension without one); `taxCharacter: 'wages' | 'ordinary' | 'rental' | 'exempt'`; `taxableShare: 0..1` (default 1; the taxable part of an annuity payment); `survivorShare: 0..1` (default 0; the share that continues to the surviving spouse after the owner's death).

`ContributionInput`: `id`; `accountId`; `person: 0 | 1`; `source: 'employee_pre_tax' | 'employee_roth' | 'employee_after_tax' | 'employer'`; `amount: { kind: 'real', annualCents: Cents } | { kind: 'share_of_income', incomeId: string, share: Rate }`; `startYear`, `endYear` (inclusive). Contribution limits are not enforced.

`RothConversionInput`: `year`; `fromAccountId` (pre_tax); `toAccountId` (roth, same owner); `amountCents`; `real: boolean` (true = today's dollars, indexed by `cpi`). Never scaled by `f0`.

`ReturnModelInput`:
```ts
| { kind: 'historical'; cohorts: 'auto' | 'complete' | 'wrap' }
| { kind: 'bootstrap'; meanBlockYears: number }                         // 1..30, default 10
| { kind: 'parametric'; preset: 'historical' | 'conservative' | 'custom'; params?: ParametricParams }
| { kind: 'fixed'; series: { stocks: Rate; bonds: Rate; bills: Rate; inflation: Rate }[] }   // >= 1 row; the last row repeats
interface ParametricParams {
  meanKind: 'arithmetic' | 'geometric';
  stocks: { mean: Rate; vol: Rate }; bonds: { mean: Rate; vol: Rate };
  bills: { mean: Rate; vol: Rate; persistence: number /* 0..0.95, default 0 */; initial: Rate /* last observed annual bill return; used only when persistence > 0 */ };
  inflation: { mean: Rate; vol: Rate; persistence: number /* 0..0.95 */; initial: Rate /* last observed annual inflation */ };
  correlation: number[][];   // 4x4 symmetric, unit diagonal, of the four innovations, order: stocks, bonds, bills, inflation
}
```

### 2.3 `PreparedRun` (internal, built by `prepare()` on the calling thread and again in each worker)

`startYear`, `f0`, `years` (Y = horizon in plan years, §3.6), `P`, `A`, `pathCount` (effective), `key: [k0, k1]` (the seed's two 32-bit halves); `treatment: Uint8Array(A)`; `owner0: Int8Array(A)` (−1 joint); `bal0: Float64Array(A×3)` and `basis0: Float64Array(A×3)` (dollars, by account and simulated asset, after applying `assetClassMap`); `weights: Float64Array(Y×A×3)` (target fractions per plan year, glide path resolved); `fee: Float64Array(A)` (`1 − ppm/1e6`); `drawdownStart` (plan-year index); the model block (`cohortStarts: Int16Array`, `cohortMode`, `restartP`, `logMeans: Float64Array(4)`, `grossFirst: Float64Array(98×4)` (year-0 factors of every data row when `f0 < 1`), `mu: Float64Array(4)`, `chol: Float64Array(16)`, `phiBills`, `phiInflation`, `lnBills0`, `lnInfl0`, `fixedSeries`); `deathCdf: Float64Array(P×Y)` when a person uses a table; `colaPublished: Float64Array(Y+1)` (published adjustments by plan year, NaN where none); resolved income, contribution and conversion tables with account ids replaced by indices; the opaque blocks for the other areas' hooks.

### 2.4 `PathState` (one per thread, allocated once, reset per path; no allocation inside the year loop)

| Field | Type and size | Unit and meaning |
| --- | --- | --- |
| `bal` | `Float64Array(A×3)` | nominal dollars by account and simulated asset |
| `basis` | `Float64Array(A×3)` | cost basis, nominal dollars; taxable accounts only, 0 elsewhere |
| `owner` | `Int8Array(A)` | 0, 1 or −1; changes at a first death |
| `growth` | `Float64Array(Y×3)` | gross period factors for this path (the year-0 entry is already the part-year factor), filled before the loop |
| `priceFactor` | `Float64Array(Y)` | period factor of the price level (`1 + inflation`; part-year in year 0) |
| `cpi` | `Float64Array(Y+1)` | price level at the start of year t; `cpi[0] = 1`; entries after the current year are NaN until written |
| `cola` | `Float64Array(Y+1)` | cost-of-living index at the start of year t; `cola[0] = 1` |
| `deathIdx` | `Int16Array(P)` | plan-year index of each death |
| `alive`, `retired` | `Uint8Array(P)` | flags for the current year |
| `age` | `Int16Array(P)` | `year − birthYear` (age attained in the year) |
| `carry` | `Float64Array(8)` | carry-over tax state, nominal dollars: [0] bill and cash interest earned last year, [1] reserved, [2] capital-loss carryforward, [3] MAGI of year t−1, [4] MAGI of year t−2 (kept for v2's IRMAA), [5] the price level at the last cost-of-living determination, [6..7] reserved |
| `roth` | `Float64Array(P×8)` | per person: [0] contribution basis, [1..5] conversion principal made 0..4 calendar years ago, [6] conversions older than that, [7] reserved; shifted each new year |
| `strategy` | `Float64Array(16)` | owned by the spending strategy hook; zeroed per path |
| `prev` | `Float64Array(4)` | last year's nominal portfolio return, last year's inflation, last year's funded spending (nominal), reserved; NaN in year 0 |
| scratch | `Float64Array(A)` each | `value`, `rmd`, `deposit`, `convOut`, `convIn`, `available`, `w`, `dividends`, `coupons` |
| path totals | scalars | `failed`, `failIdx`, `shortfallReal`, `taxesReal`, `spendReal`, `notConverged` |

### 2.5 `ChunkSummary` and `RunSummary`

A chunk of n paths returns typed arrays whose buffers are transferred: `endReal: Float64Array(n)` (ending wealth, today's dollars), `endNominal: Float64Array(n)`, `flags: Uint8Array(n)` (bit 0 success, bit 1 cohort wrapped, bit 2 a gross-up did not converge), `failIdx: Int16Array(n)` (first failing plan year, −1 if none), `endIdx: Int16Array(n)` (last plan year), `deathIdx: Int16Array(n×P)`, `shortfallReal`, `taxesReal`, `spendReal: Float64Array(n)` (lifetime sums, today's dollars), and three per-year matrices `totalReal`, `totalNominal`, `spendingReal: Float64Array(n×Y)` (end-of-year portfolio value; funded spending of the year in today's dollars), `NaN` after the path's last year and, for spending, in accumulation years. `RunSummary` is the same arrays for all paths, each chunk copied to its `pathStart` offset. Memory is `24 × N × Y` bytes for the matrices plus about 60 bytes per path: 14.6 MB + 0.6 MB for 10,000 × 61, 144 MB of matrices at the `maxPathYears` cap.

### 2.6 `EngineResult` (plain JSON; cents as strings)

```ts
interface EngineResult {
  engineVersion: string; dataVersion: string; dataChecksum: string; seed: string;
  model: { kind: string; pathCount: number; requestedPathCount: number;
           cohortMode?: 'complete' | 'wrap'; cohortCount?: number; firstStartYear?: number; lastStartYear?: number;
           replicatesPerCohort?: number; meanBlockYears?: number; preset?: string };
  mortalityTable: 'fixed' | 'ssa_period' | 'irs_2010cm_fallback';
  startYear: number; firstYearFraction: number;
  years: number[];                       // calendar year of each plan year, length Y
  ages: number[][];                      // [person][plan year]
  successCount: number; successRate: number;          // fraction 0..1
  successCi95: [number, number] | null;  // Wilson; null for the historical and fixed models
  endingWealthReal: { p10: Cents; p25: Cents; median: Cents; p75: Cents; p90: Cents; mean: Cents };
  endingWealthNominal: { p10: Cents; median: Cents; p90: Cents };
  endingWealthRealQuantiles: Cents[];    // 101 values, percentiles 0..100; [p] is the ending wealth of percentilePathIndex[p]
  percentilesBp: number[];               // the fan percentiles, default [1000, 2500, 5000, 7500, 9000]
  fanReal: (Cents | null)[][];           // [percentile][plan year]: portfolio value, today's dollars
  fanNominal: (Cents | null)[][];
  fanSpendingReal: (Cents | null)[][];   // funded spending, today's dollars; null in years with no drawdown path
  aliveCount: number[];                  // paths whose plan is still running in each plan year
  failureYearCounts: number[];           // first-failure count by plan year
  lifetimeTaxesRealMedian: Cents; lifetimeSpendingRealMedian: Cents; shortfallRealMedianOfFailures: Cents | null;
  percentilePathIndex: number[];         // 101 entries; [p] = path index at percentile p ([0] = worst, [100] = best)
  digest: string;                        // 8 hex digits
  warnings: { code: string; message: string; count?: number }[];
}
```
Warning codes: `historical_wrapped`, `other_mapped_to_stocks` (class `other` above 5% of the portfolio under the default map), `intl_modelled_as_us`, `few_alive_paths` (fewer than 100 paths alive in some plan year), `first_year_lump` (a conversion or one-off goal dated in a partial first year: its tax is overstated, §8), `path_count_adjusted`, `mortality_fallback_table`, `grossup_not_converged` (count of path-years).

Wall-clock timing is not part of `EngineResult` (it would make the stored JSON differ between identical runs); the harness returns it beside the result.

### 2.7 `PathDetail` (re-simulation of one path; cents strings)

`pathIndex`, `cohortStartYear | null`, `sampledYears: number[] | null` (the historical year used in each plan year for the historical and bootstrap models), `deathYear: number[]`, and one `YearRow` per plan year: `year`, `yearFraction`, `ages`, `alive`, `phase` (`accumulation | drawdown`), `filingStatus`, `returns: { stocks, bonds, bills }` and `inflation` (period rates), `cpiStart`, `cpiEnd`, `colaIndex`, `income: { wages, pensionAnnuity, rental, other, socialSecurity: Cents[], total }`, `contributions: { byAccount: Cents[], employee, employer }`, `spending: { recurring, lump, floor, funded, shortfall, healthcare }`, `rmdByAccount: Cents[]`, `withdrawalByAccount: Cents[]`, `conversions`, `tax` (the tax area's `TaxResult` in cents), `realizedGains`, `dividends`, `coupons`, `surplusSaved`, `endBalanceByAccount: Cents[]`, `endBasisByAccount: Cents[]`, `endTotal`, `endTotalReal`, `failed`. The strategies-outputs-web area maps this to its wire shape.

### 2.8 Data files (L7)

**`data/us-annual-returns.csv`** — canonical. Header `year,stocks,bonds,bills,inflation`; 98 rows 1928..2025 ascending; each value a simple annual return as a fraction with exactly six decimals (`%d,%.6f,%.6f,%.6f,%.6f`), LF line endings, trailing newline. sha256 `ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c`.

- Source: Aswath Damodaran, "Historical Returns on Stocks, Bonds and Bills: 1928–2025", `https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls` (sha256 `28b8110916a15a4dcc11c87c6422510704608ddedcdfa67a1298abdc22e49c69`) or the same workbook as `histretSP.xlsx` (sha256 `d7245bc8b09cd56cab5505188fe4aaddf6e0385b969310f33a4918019c321196`); page `https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html`. Both workbooks were fetched again on 2026-11-10 during the merge and reproduce these checksums; re-extracting from the `.xls` reproduces the CSV checksum above.
- Extraction: sheet `Returns by year`, header in spreadsheet row 20, data rows 21–118; column A (Year), B ("S&P 500 (includes dividends)") → `stocks`, E ("US T. Bond (10-year)") → `bonds`, D ("3-month T.Bill") → `bills`, U ("Inflation Rate") → `inflation`.
- Definitions (the workbook's "Explanations and FAQ" sheet): stocks = dividends plus price change over the start level; bonds = the coupon promised at the prior year-end 10-year yield plus the price change of a constant-maturity 10-year bond; bills = the average 3-month rate over the year; inflation = CPI for all urban consumers, not seasonally adjusted (FRED).
- **Do not use the sheet "Nominal vs Real Data"** (the lead's scratch extract `scratchpad/data/us-annual-returns-1928-2025.csv` reads it): against "Returns by year" at six decimals its bill column differs in 42 years and its inflation column in 73 (re-checked during the merge; stocks and bonds are equal).
- Validation the build script and `data.test.ts` assert (values computed from the re-extracted file):

| Check | Expected |
| --- | --- |
| rows, first, last | 98, 1928, 2025 |
| 1928 | stocks 0.438112, bonds 0.008355, bills 0.030800, inflation −0.011561 |
| 1931 | −0.438375, −0.025589, 0.023100, −0.093168 |
| 1974 | −0.259018, 0.019886, 0.078458, 0.123377 |
| 2008 | −0.365523, 0.201013, 0.014000, 0.000914 |
| 2022 | −0.180375, −0.178282, 0.020900, 0.064544 |
| 2025 | 0.177237, 0.077955, 0.042100, 0.027351 |
| extremes | stocks min 1931, max 0.525633 (1954); bonds min 2022, max 0.328145 (1982); bills min 0.000300 (2014), max 0.140362 (1981); inflation min −0.102740 (1932), max 0.181319 (1946) |
| column sums (six decimals) | 11.617562 / 4.725913 / 3.346646 / 3.046171 |
| arithmetic means | stocks 0.118547, bonds 0.048224, bills 0.034149, inflation 0.031083 (the first three equal the workbook's own "1928-2025" row) |
| geometric means | 0.100177 / 0.045346 / 0.033716 / 0.030357 (the first three equal the workbook's own row) |

- Note: the HTML page shows 17.78% for the 2025 S&P 500 return while the workbook holds 0.177237; the workbook is the source of record.
- Fallback, clearly labelled: the workbook is replaced every January. If it has changed at build time, the committed CSV (whose checksum is in the manifest) stays, and `meta.json` records `"provenance": "extract of 2026-11-10, not re-fetched"`; a new workbook is a data-version bump with new expected values.

**`data/irs-2010cm-life-table.csv`** — the fallback life table, used while the SSA file is absent. Header `age,lx`; 111 rows, ages 0..110; `lx` = survivors out of 100,000 births, five decimals (`%d,%.5f`), LF, trailing newline; sha256 `3ba08d9b67a2ff1c465b177563c8c6364eb99427c1ceda1cd05fd4b529b5a978`. Source: IRS Table 2010CM (the unisex mortality table from the 2010 census used by the section 7520 regulations; Publication 1457), `https://www.irs.gov/pub/irs-tege/table-2010cm-final.xlsx`, sha256 of the workbook `51de7bde99fd2693994ac3ac3e894311048ed6009572679e9303d1a4d931e931` (fetched again on 2026-11-10 during the merge; equal to the lead's copy; the lead's extraction script is `scratchpad/tools/extract_2010cm.py`). The engine derives `q[x] = 1 − lx[x+1] / lx[x]` for x = 0..108 and sets `q[109] = 1` (`M = 109`). Checks: 111 rows; `lx[0] = 100000`; `lx` strictly decreasing; `lx[65] = 84221.59`, `lx[85] = 41399.79`, `lx[95] = 8975.661`, `lx[100] = 1882.108`, `lx[109] = 15.47804`, `lx[110] = 0`; `q[65] = 0.012814`, `q[85] = 0.084651`, `q[108] = 0.487009`; `q` non-decreasing from age 11; survival from 65 to 95 = 0.1066; life expectancy at 65 (`Σ_{x=66..110} lx[x] / lx[65] + 0.5`) = 19.11. It is unisex and older than the SSA table; a result that used it says `mortalityTable: 'irs_2010cm_fallback'` and carries the warning `mortality_fallback_table`.

**`data/ssa-period-life-table.csv`** — not retrieved; no value of it is reproduced here. Header `age,male_qx,female_qx`; 120 rows, ages 0..119; `qx` = probability of death within one year at exact age x, six decimals as published. Source: Social Security Administration, Office of the Chief Actuary, "Actuarial Life Table" (period life table), `https://www.ssa.gov/oact/STATS/table4c6.html`; dated archive copies follow the pattern `table4c6_2022_TR2025.html`. `meta.json` records the table year and Trustees Report. Checks the implementer runs after fetching: 120 rows; every `qx` in (0, 1]; `qx` non-decreasing from age 40; `l_x` rebuilt from `l_0 = 100000`, `l_{x+1} = l_x (1 − q_x)` matches the published "number of lives" column within 1; the life expectancy recomputed from `q` is within 0.02 years of the published column at ages 60, 65, 70, 80, 90; and the age-65 row matches the published values (from web search of the SSA page, not from the page itself, so to be confirmed: 2023 table used in the 2026 Trustees Report: male q 0.016455, l 79,084, e 18.12; female q 0.010188, l 87,399, e 20.66). The engine sets `q[119] = 1` (`M = 119`); `unisex` is the mean of the two columns. When the file is present `mortality.kind = 'table'` uses it and the result says `ssa_period`.

**`data/manifest.json`** — `{ dataVersion: "2026.11.0", files: [{ path, sha256, sourceUrl, retrieved, description }] }`, covering these files and the tax area's. `DATA_CHECKSUM` is the sha256 of the files' sha256 values joined by newlines in manifest order.

**`src/generated/data.ts`** — written by `scripts/build-data.mjs`: `US_FIRST_YEAR = 1928`, `US_STOCKS`, `US_BONDS`, `US_BILLS`, `US_INFLATION: Float64Array(98)`, `LIFE_2010CM_LX: Float64Array(111)`, `LIFE_SSA_MALE_QX`, `LIFE_SSA_FEMALE_QX: Float64Array(120) | null`, `DATA_VERSION`, `DATA_CHECKSUM`. Every number is written as a decimal literal in shortest round-trip form. `data.test.ts` (Node APIs allowed in tests) recomputes the checksums from the CSVs and fails if the generated module is stale.

## 3. Algorithms

### 3.1 Calendar, first-year fraction, price index, cost-of-living index

`startYear = year(asOf)`; plan year t is calendar year `startYear + t`. `f0 = (daysInYear − dayOfYear(asOf) + 1) / daysInYear`; `f_t = 1` for t ≥ 1.

Worked: `asOf = 2026-11-10` is day 314 of 365, so `f0 = 52/365 = 0.14246575342465753`. `asOf = 2027-01-01` gives 1. `asOf = 2028-03-01` (leap year, day 61) gives 306/366. `asOf = 2028-12-31` gives 1/366.

**Price index.** `cpi[0] = 1`; `cpi[t+1] = cpi[t] × priceFactor[t]`, where `priceFactor[t]` is `1 + inflation` of the path's year t (the part-year factor of §3.5 in year 0). Indexed amounts of year t are today's dollars times `cpi[t]`.

**Cost-of-living index** (what a Social Security benefit in today's dollars is multiplied by). `cola[0] = 1`, reference level `ref = 1`. At the end of each year t:

```
if a published adjustment c exists for January of year startYear + t + 1:
    cola[t+1] = cola[t] × (1 + c);   ref = cpi[t+1]
else:
    cola[t+1] = cola[t] × max(1, cpi[t+1] / ref);   ref = max(ref, cpi[t+1])
```

Without a published adjustment this is the running maximum of the price index: the adjustment paid from January equals the price rise over the previous year, measured from the highest level reached so far, and after a fall in prices benefits stay flat until prices pass their old peak (the statutory rule measures from the highest prior third-quarter average). A published adjustment (the tax area's data file supplies it through `publishedCola(year)`, for example the one announced in October 2026 for January 2027) replaces the simulated one for that January, exactly as published tax tables replace indexed ones, and the reference level restarts from that January's price level. Without it a plan started on 2026-11-10 would carry a 2026 benefit into 2027 with only 52 days of simulated inflation.

Worked: inflation 3%, −2%, 5% in full years gives `cpi` = 1, 1.03, 1.0094, 1.05987 and `cola` = 1, 1.03, 1.03, 1.05987. The same inflation from `asOf = 2026-11-10` with a published 3.6% for January 2027 gives `cpi` = 1, 1.004220, 0.984136, 1.033342 and `cola` = 1, 1.036, 1.036, 1.066044 (`1.036 × 1.033342 / 1.004220`).

Powers with a fractional exponent use `detPow(x, f) = detExp(f × detLog(x))` and occur only in year 0 and in `prepare()`; integer powers (income growth `(1 + rate)^t`) use repeated multiplication `powInt`.

### 3.2 Asset classes, targets and glide paths

`prepare()` collapses each account's six-class holdings to three simulated assets: `bal0[a][j] = Σ_c holdings[a][c] × map[c][j] / 10000`, and the same for basis and for target weights. Default treatment and its effect:

- **International stock → stocks.** There is no international series in the US record. Effect: no diversification benefit and no currency risk is modelled, and international holdings earn the US equity return, which over 1928–2025 was high by world standards (optimistic); warning `intl_modelled_as_us`.
- **Real estate → stocks.** Listed real-estate funds behave like equities in return and volatility; the workbook's real-estate column is a house-price index without rents and is not used.
- **Other → stocks**, with warning `other_mapped_to_stocks` above 5% of the portfolio; the map is editable per scenario (for example 50/50 stocks and bills).
- **Bonds → bonds** (10-year Treasury total return; credit spread and shorter duration are not modelled). **Cash → bills.** Accounts with treatment `cash` are always 100% bills.

Target of account a in calendar year y: with `target = null` the current mix; otherwise piecewise linear through the glide points, constant before the first and after the last point. Worked: points (2030: 80/20/0) and (2040: 50/40/10) give 2027 → 80/20/0, 2034 → 68/28/4 (`x = 0.4`), 2045 → 50/40/10.

### 3.3 Random numbers

**Threefry2x32, 20 rounds** (Random123). All arithmetic is on unsigned 32-bit words (`>>> 0`).

```
rot = [13, 15, 26, 6, 17, 29, 16, 24];  parity = 0x1BD11BDA
threefry2x32(k0, k1, c0, c1):
  ks = [k0, k1, parity ^ k0 ^ k1]
  x0 = c0 + ks[0];  x1 = c1 + ks[1]
  for r in 0..19:
    x0 = x0 + x1;  x1 = rotl32(x1, rot[r mod 8]);  x1 = x1 ^ x0
    if r mod 4 == 3:
      s = (r + 1) / 4                       // 1..5
      x0 = x0 + ks[s mod 3];  x1 = x1 + ks[(s + 1) mod 3] + s
  return (x0, x1)
```

**Key and counter.** `k0 = seed mod 2^32`, `k1 = floor(seed / 2^32)` (the seed string is parsed with `BigInt`). `c0 = pathIndex`. `c1 = (purpose << 24) | (step << 8) | slot`, with `step < 65,536` and `slot < 256`.

| Purpose | Id | Step | Slots |
| --- | --- | --- | --- |
| `MARKET` | 0 | plan year t | 0 stocks, 1 bonds, 2 bills, 3 inflation (the parametric model's normals) |
| reserved | 1 | | |
| `BOOT` | 2 | plan year t | 0 new-block decision, 1 block start row |
| `MORTALITY` | 3 | 0 | person index |
| reserved for the engine | 4–15 | | |
| free for later hooks | 16–255 | | none used in v1 |

Adding a purpose in v2 changes no existing draw. The historical and fixed models draw nothing for the market. A market variate depends only on (seed, path, year, slot), so changing the horizon, the strategy, the mortality mode or the withdrawal order leaves every market path of the bootstrap and parametric models unchanged: two scenarios run with one seed are compared on identical markets, which Phase 5's optimizers need.

**Uniform.** One call gives one uniform: `n = (x0 >>> 6) × 2^26 + (x1 >>> 6)` (52 bits); `u = (n + 0.5) / 2^52`, which lies in `[2^-53, 1 − 2^-53]`, never 0 or 1, and is symmetric about 0.5. Both the sum and the division are exact. An index in `[0, n)` is `floor(u × n)`; its bias is below `n × 2^-52`.

**Normal.** `z = invNorm(u)`, Wichura's AS241 routine PPND16 with `detLog` in the tail; one uniform per normal, no rejection, so every normal is addressable and monotone in its uniform.

```
q = u − 0.5
if |q| <= 0.425:  r = 0.180625 − q*q;  z = q * A(r) / B(r)
else:             r = sqrt(−detLog(q < 0 ? u : 1 − u))
                  if r <= 5:  r = r − 1.6;  z = C(r) / D(r)   else:  r = r − 5;  z = E(r) / F(r)
                  if q < 0:  z = −z
A(r), ..., F(r) are degree-7 polynomials evaluated by Horner from the highest coefficient: v = c[7]; for i = 6..0: v = v*r + c[i].
Coefficients, listed from the constant term c[0] up to c[7]:
A = [3.3871328727963666080e0, 1.3314166789178437745e+2, 1.9715909503065514427e+3, 1.3731693765509461125e+4, 4.5921953931549871457e+4, 6.7265770927008700853e+4, 3.3430575583588128105e+4, 2.5090809287301226727e+3]
B = [1, 4.2313330701600911252e+1, 6.8718700749205790830e+2, 5.3941960214247511077e+3, 2.1213794301586595867e+4, 3.9307895800092710610e+4, 2.8729085735721942674e+4, 5.2264952788528545610e+3]
C = [1.42343711074968357734e0, 4.63033784615654529590e0, 5.76949722146069140550e0, 3.64784832476320460504e0, 1.27045825245236838258e0, 2.41780725177450611770e-1, 2.27238449892691845833e-2, 7.74545014278341407640e-4]
D = [1, 2.05319162663775882187e0, 1.67638483018380384940e0, 6.89767334985100004550e-1, 1.48103976427480074590e-1, 1.51986665636164571966e-2, 5.47593808499534494600e-4, 1.05075007164441684324e-9]
E = [6.65790464350110377720e0, 5.46378491116411436990e0, 1.78482653991729133580e0, 2.96560571828504891230e-1, 2.65321895265761230930e-2, 1.24266094738807843860e-3, 2.71155556874348757815e-5, 2.01033439929228813265e-7]
F = [1, 5.99832206555887937690e-1, 1.36929880922735805310e-1, 1.48753612908506148525e-2, 7.86869131145613259100e-4, 1.84631831751005468180e-5, 1.42151175831644588870e-7, 2.04426310338993978564e-15]
```

The largest possible |z| is 8.209536151601386 (`invNorm(2^-53) = −8.209536151601386`).

### 3.4 Deterministic math (`detmath.ts`)

The bit patterns of T5 depend on the exact order of operations, so the two functions are given as code (plain TypeScript; `POW2` is a table of `2^k` for k = −1074..1023 built by repeated doubling and halving, which is exact):

```ts
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
const SQRT2 = 1.4142135623730951, SQRT1_2 = 0.7071067811865476, INV_LN2 = 1.4426950408889634;
export function detLog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let k = 0;
  while (x >= SQRT2) { x *= 0.5; k++; }
  while (x < SQRT1_2) { x *= 2; k--; }
  const s = (x - 1) / (x + 1);
  const z = s * s;
  let p = 1 / 25;
  p = 1 / 23 + z * p; p = 1 / 21 + z * p; p = 1 / 19 + z * p; p = 1 / 17 + z * p; p = 1 / 15 + z * p; p = 1 / 13 + z * p;
  p = 1 / 11 + z * p; p = 1 / 9 + z * p; p = 1 / 7 + z * p; p = 1 / 5 + z * p; p = 1 / 3 + z * p;
  const r = 2 * s + 2 * s * z * p;
  return k * LN2_HI + (r + k * LN2_LO);
}
export function detExp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let p = 1 / 87178291200;
  p = 1 / 6227020800 + r * p; p = 1 / 479001600 + r * p; p = 1 / 39916800 + r * p; p = 1 / 3628800 + r * p; p = 1 / 362880 + r * p;
  p = 1 / 40320 + r * p; p = 1 / 5040 + r * p; p = 1 / 720 + r * p; p = 1 / 120 + r * p; p = 1 / 24 + r * p; p = 1 / 6 + r * p; p = 0.5 + r * p;
  const e = 1 + (r + r * r * p);
  if (k > 1023) return e * POW2[1023 + 1074] * POW2[k - 1023 + 1074];
  if (k < -1022) return e * POW2[k + 1022 + 1074] * POW2[-1022 + 1074];
  return e * POW2[k + 1074];
}
export function detPow(x: number, y: number): number { return detExp(y * detLog(x)); }
export function powInt(x: number, n: number): number { let r = 1; for (let i = 0; i < n; i++) r *= x; return r; }
```

`detLog` reduces x to `[1/√2, √2)` by exact halving or doubling and sums `2·atanh(s)` to twelve terms; `detExp` reduces by a two-part `ln 2` and sums the Taylor series to degree 14. Measured against the platform functions on 100,000 seeded arguments (and on 2,000,000 by the designers): maximum relative difference 2.2e-16 for the exponential and 4.3e-16 for the logarithm, under 2 units in the last place. Only their own bit patterns are part of the contract (T5).

`cholesky(M, n)` is Cholesky–Banachiewicz, row by row: `L_ij = (M_ij − Σ_{k<j} L_ik L_jk) / L_jj` for j < i, `L_ii = sqrt(M_ii − Σ_{k<i} L_ik²)`; a pivot ≤ 1e-14 raises `correlation_not_positive_definite`.

### 3.5 Return models

Every model fills, for one path, `growth[t][j]` (gross period factor of stocks, bonds, bills) and `priceFactor[t]` for t = 0..Y−1. Let `x` be a year's log return (or log inflation) and `m` the model's mean of it.

**Year-0 rule (all models, only when `f0 < 1`).** The part-year factor is `detExp(f0·m + √f0·(x − m))`: mean log return `f0·m` and variance `f0·σ²`, the right first two moments for a fraction of a year. What `m` is: the fixed model has no dispersion, `m = x`, so the factor is `detPow(1 + r, f0)`; the historical and bootstrap models use the data file's mean log returns (`logMeans`, the first output of the estimator below: 0.095471, 0.044348, 0.033160, 0.029906), precomputed for all 98 rows in `grossFirst`; the parametric model uses the conditional mean and the innovation directly (below). With `f0 = 1` no transformation is applied and the factors are the row's or draw's own.

`returnShift`, when given, replaces `growth[t][j]` by `max(0, growth[t][j] + f_t × shift_j)` after the model has filled it.

**(a) Fixed.** Row `min(t, series.length − 1)`.

**(b) Historical cohorts** (Bengen 1994; Cooley, Hubbard and Walz 1998; FIRECalc; cFIREsim). N = 98 data years, Y plan years.

1. `complete = N − Y + 1`. Mode: `complete` requires `complete ≥ 1` (else `historical_horizon_too_long`); `wrap` always works; `auto` is `complete` when every person has fixed mortality and `complete ≥ 30`, else `wrap`.
2. Cohort starts are data indices `0 .. C−1`, with `C = complete` (complete) or `N` (wrap).
3. Path k uses cohort `c = k mod C` and replicate `m = floor(k / C)`; plan year t uses data index `(c + t) mod N`. In complete mode the modulo never wraps.
4. Effective path count: `C` when every person has fixed mortality; otherwise `C × ceil(pathCount / C)`.
5. With table mortality Y runs to the end of the life table (§3.6), so an explicit `complete` then leaves few cohorts; that is why `auto` wraps.

Worked: fixed mortality, Y = 30 → 69 complete cohorts (start years 1928–1996), mode complete, 69 paths. Y = 61 → 38, complete. Y = 75 → 24 < 30, so auto wraps: 98 cohorts. Table mortality (any Y) with `pathCount = 10000` → wrap, 98 cohorts × 103 replicates = 10,094 paths; path 10,093 is start year 2025, replicate 102. A wrapped cohort starting in 2020 (index 92) with Y = 8 uses 2020, 2021, 2022, 2023, 2024, 2025, 1928, 1929.

Inflation is the same row's CPI change, so stock, bond, bill and price history stay aligned exactly as they happened. The success-rate interval is `null`: overlapping cohorts are not independent draws.

**(c) Stationary block bootstrap** (Politis and Romano 1994). With `p = 1 / meanBlockYears`:

```
for t = 0 .. Y−1:
  if t == 0 or uniformAt(BOOT, t, 0) < p:  i = floor(uniformAt(BOOT, t, 1) × N)     // new block at a uniformly random year
  else:                                     i = (i + 1) mod N                        // next calendar year, circular
  growth[t] = 1 + (stocks[i], bonds[i], bills[i]);  priceFactor[t] = 1 + inflation[i]
```

Block lengths are geometric with mean `1/p`; the series is circular so every year is equally likely at every position; one index selects the whole row, so cross-asset correlation and the return–inflation link are those of history, and serial dependence (inflation persistence, crash and recovery) survives inside blocks. `meanBlockYears = 1` is the plain independent bootstrap (`u < 1` always).

Worked (seed 20261110, path 0): see T11; with mean block 10 the path uses 2007–2014, restarts at 1982–1985 and then at 1974.

**(d) Parametric correlated lognormal.**

1. Each of the four variables has a mean and a volatility S (standard deviation of the simple annual rate). Convert to log parameters:
   - arithmetic mean A: `σ² = ln(1 + S² / (1 + A)²)`, `μ = ln(1 + A) − σ²/2`;
   - geometric mean G: `μ = ln(1 + G)`, `y = (1 + sqrt(1 + 4 S² / (1 + G)²)) / 2`, `σ² = ln y`.
   Both reproduce the requested mean and the requested S exactly for a lognormal. Worked: A = 7%, S = 18% → μ = 0.053705456397, σ = 0.167052040258 (median growth 5.5174%); G = 5%, S = 18% → μ = 0.048790164169, σ = 0.167841821268 (expected return 6.4894%).
2. Innovation volatilities `s = (σ_S, σ_B, σ_C sqrt(1 − φ_C²), σ_π sqrt(1 − φ_π²))`, with `φ_C` the bill persistence and `φ_π` the inflation persistence, so the stationary volatility of each series is the one requested. Covariance `Σ_ij = ρ_ij s_i s_j` with `ρ` the input correlation matrix of the innovations; `L = cholesky(Σ, 4)`.
3. Each plan year: `z_j = invNorm(uniformAt(MARKET, t, j))`, `e = L z`. Conditional means: `c_S = μ_S`, `c_B = μ_B`, `c_C = μ_C + φ_C (ℓC_{t−1} − μ_C)`, `c_π = μ_π + φ_π (ℓπ_{t−1} − μ_π)`, with `ℓC_{−1} = ln(1 + bills.initial)` and `ℓπ_{−1} = ln(1 + inflation.initial)`. The year's log rates are `c_j + e_j`; the two persistent ones are stored as `ℓC_t`, `ℓπ_t`. Factors: `growth[t][j] = detExp(c_j + e_j)`, `priceFactor[t] = detExp(c_π + e_π)`; in a partial year 0, `detExp(f0·c_j + √f0·e_j)` (the stored `ℓ` values stay the full-year rates).

Presets:
- **`historical`**: log parameters estimated from the data file by `estimateLogMoments()`: `ℓ_j,t = detLog(1 + r_j,t)`; means; sample standard deviations (n − 1); `φ_π` = lag-1 autocorrelation of the inflation logs, `Σ_{t=2..N}(ℓ_t − m)(ℓ_{t−1} − m) / Σ_{t=1..N}(ℓ_t − m)²`; shocks `ε_t = ℓ_t − m − φ_π(ℓ_{t−1} − m)` for t = 2..N; Pearson correlations among the three asset logs over all N years and between each asset log (t = 2..N) and ε; `φ_C = 0`. Values the estimator returns on the pinned file: μ = (0.095471, 0.044348, 0.033160, 0.029906); σ = (0.188737, 0.074201, 0.028969, 0.037719); `φ_π` = 0.6190; inflation shock volatility 0.029624; ρ(stocks, bonds) = 0.0224, ρ(stocks, bills) = −0.0043, ρ(bonds, bills) = 0.2664, ρ(stocks, ε) = 0.0164, ρ(bonds, ε) = −0.2066, ρ(bills, ε) = 0.1247; `inflation.initial` = the last data year's inflation (0.027351), `bills.initial` = 0.042100. Its Cholesky factor (rows, six decimals, from the unrounded moments): (0.188737); (0.001661, 0.074182); (−0.000125, 0.007722, 0.027921); (0.000487, −0.006133, 0.005532, 0.028446). For information, the lag-1 autocorrelations of the four log series are 0.023, −0.045, 0.918 and 0.619: bills are as persistent as inflation, which is what `bills.persistence` is for.
- **`conservative`** ("conservative future"): geometric nominal means stocks 5.5%, bonds 4.5%, bills 3.2%, inflation 2.5%; volatilities are the sample standard deviations of the data file's simple returns (0.194034, 0.079024, 0.030358, 0.038953); persistence and correlations as in `historical`. Log parameters (from the unrounded volatilities): stocks μ 0.053541, σ 0.179523; bonds 0.044017, 0.075300; bills 0.031499, 0.029398; inflation 0.024693, 0.037961 (shock 0.029814). The means are this design's assumption, placed between published ten-year outlooks (§10), and are editable.
- **`custom`**: the user's `ParametricParams`.

### 3.6 Mortality, horizon and end of plan

Age in plan year t is `startYear + t − birthYear`, the age attained in that calendar year.

- **Fixed:** `deathIdx = max(0, birthYear + age − startYear)`; the person is alive through that year.
- **Table.** The table has `q[x]` for exact ages x = 0..M with `q[M] = 1` (M = 119 for the SSA table, 109 for the fallback). A person who attains age a during a calendar year is aged a − 1 for the first part of it and a for the rest, so the probability of dying in that year is
  `qCal(a) = min(1, qScale × (q[a−1] + q[a]) / 2)` for 1 ≤ a ≤ M, and `qCal(a) = 1` for a > M.
  `prepare()` builds each person's cumulative death probability by plan year: `S_{−1} = 1`, `S_t = S_{t−1} × (1 − qCal(age(t)))^{f_t}`, `cdf[t] = 1 − S_t` (set to exactly 1 where `qCal = 1`). Per path: `u = uniformAt(MORTALITY, 0, person)`; `deathIdx` is the first t with `cdf[t] > u` (strict).

A person is alive during the whole of the death year and gone from the next. `endIdx = max_i deathIdx_i`. Horizon `Y = 1 + max_i(last possible deathIdx_i)`: the fixed age, or age M + 1 for a table. `Y > 120` raises `horizon_too_long`.

Worked: fixture `q[88..94] = 0.10, 0.12, 0.15, 0.20, 0.30, 0.50, 1` (M = 94), both persons attain 90 in year 0, `f0 = 1`: `qCal(90..95)` = 0.135, 0.175, 0.25, 0.40, 0.75, 1; `cdf` = 0.135, 0.286375, 0.46478125, 0.67886875, 0.9197171875, 1. Path 0 of seed 20261110 has `u_0 = 0.9664983621314399` → `deathIdx_0 = 5`, and `u_1 = 0.6475357745930787` → `deathIdx_1 = 3`; the plan ends in year 5.

### 3.7 The year loop

For each path: fill the market arrays (§3.5), draw the deaths (§3.6), copy `bal0`, `basis0`, `owner0`, zero the carry and strategy state, then for t = 0 .. `endIdx`:

**Timing of every flow**

| Flow | When | Price level |
| --- | --- | --- |
| Wages, pensions, annuities, rental, Social Security | start of year (today, in year 0) | `cpi[t]`; Social Security by `cola[t]` |
| Contributions, employee and employer | start of year | `cpi[t]` |
| RMDs | start of year, on the balance before any flow (the prior December 31) | — |
| Scheduled Roth conversions | start of year, after the RMD | `cpi[t]` when `real` |
| Spending (recurring and one-off) | start of year | `cpi[t]` |
| Withdrawals, taxes and penalties of year t | start of year, one instant, settled together | thresholds at `cpi[t]` |
| Rebalancing | start of year, in the same trades as the flows | — |
| Surplus deposit | start of year, after the trades | — |
| Dividends and coupons in taxable accounts | fixed yields on post-trade balances, taxed in year t, reinvested (added to basis) | — |
| Returns and fund costs | over the year | — |
| Bill and cash interest in taxable and cash accounts | accrues over the year, reinvested, taxed with year t+1 | — |
| Inflation | over the year, giving `cpi[t+1]` and `cola[t+1]` | — |
| Deaths, rollovers, basis reset | end of year | — |

**Step 0, begin.** `f = f_t`; ages; `alive[i] = deathIdx[i] ≥ t`; `retired[i] = year ≥ retirementYear_i`; filing status `mfj` when two persons are alive, else `single`; phase `accumulation` when `t < drawdownStart`, where `drawdownStart = max(0, min_i retirementYear_i − startYear)`; `value[a] = Σ_j bal[a][j]`. From t ≥ 1 the Roth conversion layers shift by one year (`[6] += [5]`, `[5] = [4]`, …, `[1] = 0`).

**Step 1, income.** For each stream active in the year whose owner is alive (or, after the owner's death, with `survivorShare > 0` and a survivor; a joint stream while anyone is alive): `amount = annual × index × share × f`, `index = cpi[t] × powInt(1 + rate, t)` (real) or `powInt(1 + rate, t)` (nominal). Sorted into wages, taxable ordinary (`amount × taxableShare`), rental, exempt, and summed in full as cash income. Social Security comes from the hook as full-year nominal benefits per person, times `f`. Worked: a salary of $100,000 with a 1% real raise, 3% inflation, full first year: year 2 is 100,000 × 1.0609 × 1.0201 = $108,222.41.

**Step 2, contributions.** `annual × cpi[t] × f` (or `share × this year's stream amount`) is added to `deposit[account]`; the three employee kinds count as cash uses, `employee_pre_tax` also reduces taxable wages, `employee_roth` adds to the person's Roth contribution basis, `employer` is neither income nor a cash use.

**Step 3, spending need.** The spending hook fills `SpendDecision { spend, floor, lump, lumpFloor, healthcare }`: `spend` and `floor` are full-year recurring amounts in nominal dollars (`spend` includes `healthcare`), `lump` is the total of one-off goals dated in this calendar year in nominal dollars, `lumpFloor ≤ lump` the part of it that counts toward the floor. The loop sets `need = spend × f + lump` and `floorNeed = floor × f + lumpFloor`; lumps are never scaled. In accumulation `need = lump` and `floorNeed = 0`.

**Step 3b, forced flows.** `hooks.rmd(view, out)` gives the full-year RMD per account; for every pre-tax account whose owner is alive `rmd[a] = min(value[a], out[a] × f)`. Scheduled conversions dated this year move `min(amount, value[from] − rmd[from] − convOut[from])`, in full (no `f`). `available[a] = value[a] − rmd[a] − convOut[a]`.

**Step 4, withdrawals; step 5, taxes.** The withdrawal hook fills `w[a]` (0 ≤ w[a] ≤ available[a]) using `assess` (§3.9). The loop calls `assess(w)` once more for the record: `net ≥ 0` is surplus, `net < 0` is a shortfall of `min(need, −net)`; `funded = need − shortfall`. If `funded + CASH_TOL < floorNeed` and the path has not failed, `failed = true` and `failIdx = t`. Tax and penalties are paid before spending; the tax function's loss carryforward and MAGI go to `carry`; the record call's dividends and coupons per account are kept for step 7; the Roth state is reduced by what the ordering function attributed to each layer.

**Step 6, trades.** For each account `netOut = w + rmd + convOut − deposit − convIn`; `planTrades(a, netOut, apply)` (§3.8). Then the surplus, if any, is deposited into the surplus account at its target weights (basis rises by the deposit in a taxable account). With no taxable or cash account the surplus is counted as spent.

**Step 7, returns.** For each taxable account: bill interest `max(0, g_C − 1) × bal_C` is added to next year's `carry[0]` and to the bill basis; the year's dividends and coupons (from the record call) are added to the stock and bond basis. For each cash account the same bill interest is added to next year's `carry[0]`. Then `bal[a][j] ← bal[a][j] × growth[t][j] × fee_a` (`fee_a^f` by `detPow` in year 0). `cpi[t+1]` and `cola[t+1]` follow §3.1.

**Step 8, end of year.** Record `totalNominal[t] = Σ bal`, `totalReal[t] = totalNominal[t] / cpi[t+1]`, `spendingReal[t] = funded / cpi[t]` (drawdown years); add `tax / cpi[t]`, `funded / cpi[t]` and `shortfall / cpi[t]` to the lifetime sums; store last year's portfolio return `Σ bal_end / Σ bal_after_trades − 1`, inflation and funded spending in `prev`. If a person died this year and the other lives on: every taxable holding gets `basis ← basis + s × (value − basis)` with `s = 1` for an account the decedent owned alone, the `jointBasisStepUp` share (0.5, 1 or 0) for a joint account and 0 for an account the survivor owned alone (a holding worth less than its basis steps down by the same rule); every account the decedent owned gets the survivor as owner; the decedent's Roth state is added to the survivor's.

After the last year: `endNominal = Σ bal`, `endReal = endNominal / cpi[endIdx + 1]`.

**Monthly steps later.** Every formula is written with the period fraction `f`; a monthly engine runs the same step twelve times with `f = 1/12`, a monthly market file (or the year-0 rule with `f = 1/12`) and settles tax in the December period. Nothing in the types is annual-only except the name of the data file.

### 3.8 Trades: withdraw and rebalance in one step

```
planTrades(a, netOut, apply):                         // netOut > 0 = money leaving the account
  V = Σ_j bal[a][j];   V' = V − netOut                // V' >= 0 because w <= available
  Δ_j = bal[a][j] − weight[t][a][j] × V'              // Σ_j Δ_j = netOut
  full (and every non-taxable account):  sell_j = max(Δ_j, 0);  buy_j = max(−Δ_j, 0)
  flows_only (taxable accounts only):
     netOut > 0:  P = Σ max(Δ, 0);  sell_j = max(Δ_j, 0) × netOut / P;  buy_j = 0
     netOut < 0:  Q = Σ max(−Δ, 0); buy_j = max(−Δ_j, 0) × (−netOut) / Q;  sell_j = 0
     netOut = 0:  no trade
  realizedGain (taxable) = Σ_{j: bal_j > 0} sell_j × (1 − basis_j / bal_j)        // may be negative
  post_j = bal_j − sell_j + buy_j
  if apply:  for j with bal_j > 0:  basis_j −= sell_j × basis_j / bal_j
             basis_j += buy_j;  bal_j = post_j
  return realizedGain (and post_j, which assess uses for the yields)
```

Guards: a holding with `bal_j = 0` has `Δ_j ≤ 0`, is never sold, and is skipped in the gain and basis terms, so no division by zero occurs (an all-stock taxable account is the normal case). In `flows_only`, `Σ Δ = netOut`, so `P ≥ netOut > 0` and `Q ≥ −netOut > 0` whenever they are used; the scale factors are at most 1 and no underweight asset is ever sold. With `apply = false` it is a pure preview, which is what `assess` uses.

Worked (T23): taxable account, stocks 700,000 (basis 300,000), bonds 300,000 (basis 290,000), target 60/40, withdrawal 50,000. `V' = 950,000`; `Δ_S = 700,000 − 570,000 = +130,000`; `Δ_B = 300,000 − 380,000 = −80,000`. Full: sell 130,000 of stocks, buy 80,000 of bonds; gain `130,000 × (1 − 3/7) = 74,285.71`; basis 244,285.71 and 370,000; holdings 570,000 / 380,000. Flows only: `P = 130,000`, sell `130,000 × 50,000/130,000 = 50,000` of stocks; gain 28,571.43; basis 278,571.43 and 290,000; holdings 650,000 / 300,000.

### 3.9 Tax settlement: `assess`, gross-up, partial year, carry-over

`assess(w, out)` is built by the loop for the year and handed to the withdrawal hook. For a candidate `w`:

1. For each account `netOut_a = w_a + rmd_a + convOut_a − deposit_a − convIn_a`. For a taxable account `planTrades(a, netOut_a, false)` gives the realized gain and the post-trade balances; dividends are `stockDividendYield × f × post_S`, coupons `bondInterestYield × f × post_B`.
2. Portfolio distributions: `rmd + w` from pre-tax accounts are ordinary income by owner; Roth withdrawals are split by the tax area's ordering function using the owner's Roth state, Roth balance and age; HSA withdrawals are qualified up to the year's `healthcare × f` and non-qualified beyond; cash withdrawals carry nothing.
3. The year's `TaxInput`: wages (after pre-tax deferrals), taxable pensions and annuities, rental, interest (last year's carried bill and cash interest plus this year's coupons), qualified dividends, realized gains, the loss carryforward, conversions, the distributions of step 2, Social Security, filing status and ages.
4. Annualization (only when `f < 1`): every dollar amount of the `TaxInput` is divided by `f`, the tax function is called with the year's parameters, and its dollar results (tax, penalties, taxable Social Security, loss carry-out) are multiplied by `f`. The MAGI stored in `carry[3]` is the annualized figure, the best estimate of the calendar year's MAGI. With `f = 1` no division is done.
5. Net cash:
   - drawdown: `net = cashIncome + Σ rmd + Σ w − employeeContributions − need − tax`, with `tax = TaxResult.total` (income tax, net investment income tax and penalties);
   - accumulation: `net = Σ rmd + Σ w − need − (tax − taxBaseline)`, with `taxBaseline` the same computation with `rmd = w = 0`, evaluated once per year (wages pay the baseline, which includes the tax on dividends and on scheduled conversions; the portfolio pays only what its own distributions add).

**Contract for the withdrawal hook.** If `assess(0).net ≥ −CASH_TOL` return `w = 0`. Otherwise return the `w` that follows the configured order with `|net| ≤ CASH_TOL`, or all of `available` if even that leaves `net < 0`. Use at most 24 `assess` calls (`LIMITS.assessMaxCalls`; the loop's own record call and the baseline are not counted). If the solver has not converged by its last call it returns the smallest amount it found with `net ≥ 0`; the loop deposits that small surplus, sets the path's "not converged" flag and counts the warning `grossup_not_converged`. The loop raises `EngineInvariantError` when `w` is outside `[0, available]`, when `net < −CASH_TOL` while money remains, or on a 25th call.

`net` is continuous, piecewise linear and strictly increasing in total withdrawals as long as the marginal tax plus penalty rate is below 100% (annualization keeps the slope: `d(f·T(x/f))/dx = T'(x/f)`), so the root is unique. The reference solver (the stub used for §7, and the recommended one): parametrize by the total amount x taken along the order (`fill(x)` empties accounts in order), evaluate `h(0)` and `h(total)`, then iterate the false-position step `x = lo − h_lo (hi − lo)/(h_hi − h_lo)` with the Illinois modification (halve the retained end's value when the same end is retained twice) and a bisection fallback when the step leaves the bracket. On a piecewise-linear function this is exact once both ends share a linear piece with the root. Measured on the reference workload of §3.15: 2.2 hook calls per path-year on average, 12 at most.

**Worked gross-ups** (T24), stub tax = 20% of ordinary income + 10% of gains and qualified dividends, yields 0, need $40,000:
- one pre-tax account: `W − 0.2 W = 40,000` → `W = 50,000`, tax 10,000;
- the taxable account of §3.8, full rebalancing: `Δ_S = 100,000 + 0.6 W`, gain `(100,000 + 0.6 W) × 4/7`, tax `5,714.2857 + 0.0342857 W`; `W − tax = 40,000` → `W = 47,337.28`, tax 7,337.28, gain 73,372.78;
- the same with `flows_only`: gain `W × 4/7`, `W (1 − 0.0571429) = 40,000` → `W = 42,424.24`, tax 2,424.24.

**Carry-over state.** `carry[0]` (bill and cash interest: written in step 7 of year t, read by every `assess` of year t+1, overwritten in step 7 of year t+1; never cleared by `assess`, which runs many times a year), `carry[2]` (loss carryforward returned by the tax function), `carry[3..4]` (MAGI history), `carry[5]` (the cost-of-living reference level). Year 0 starts with nothing carried and the bill interest of the last plan year is never taxed; both are stated simplifications (§8).

### 3.10 A whole year by hand (W1)

`asOf = 2035-01-01` (f = 1, `cpi = 1`), persons born 1960 and 1962 (ages 75 and 73), both alive. Joint taxable account: stocks 330,000 (basis 190,000), bonds 130,000 (basis 120,000), bills 40,000 (basis 40,000), target 60/30/10, full rebalancing. Pre-tax account of person 0: 200,000 / 200,000, target 50/50. Roth of person 1: 100,000 in stocks. Nominal pension 12,000 (ordinary). Stub hooks: Social Security 30,000 and 20,000 (untaxed by the stub), RMD = balance / 24.6 from age 75, spending 100,000, tax = 15% of ordinary income + 10% of qualified dividends and gains, order taxable → pre-tax → Roth. Yields 1.5% (stocks) and 4% (bonds). Market: stocks +10%, bonds +2%, bills +3%, inflation 4%.

- Income 12,000 + 50,000 = 62,000. RMD = 400,000 / 24.6 = 16,260.16. Cash in = 78,260.16. Need 100,000.
- Withdrawing W from the taxable account: `V' = 500,000 − W`; `Δ_S = 330,000 − 0.6 V' = 30,000 + 0.6 W` (sold); bonds and bills are bought. Gain = `(30,000 + 0.6 W) × (1 − 190/330) = 12,727.27 + 0.254545 W`. Dividends = `0.015 × 0.6 V' = 4,500 − 0.009 W`; coupons = `0.04 × 0.3 V' = 6,000 − 0.012 W`.
- Ordinary income = 12,000 + 16,260.16 + coupons = `34,260.16 − 0.012 W`. Tax = `0.15 × (34,260.16 − 0.012 W) + 0.10 × (17,227.27 + 0.245545 W) = 6,861.75 + 0.0227545 W`.
- Identity: `78,260.16 + W − 100,000 − 6,861.75 − 0.0227545 W = 0` → **W = 29,267.56**, **tax 7,527.72**; gain 20,177.20, dividends 4,236.59, coupons 5,648.79.
- After trades: taxable 282,439.46 / 141,219.73 / 47,073.24; pre-tax 191,869.92 / 191,869.92; Roth 100,000.
- After returns: taxable 310,683.41 / 144,044.13 / 48,485.44; pre-tax 211,056.91 / 195,707.32; Roth 110,000; total **1,019,977.21**; `cpi[1] = 1.04`; in today's dollars **980,747.31**.
- Basis after the year: stocks `190,000 − 47,560.54 × 190/330 + 4,236.59 = 166,853.25`; bonds `120,000 + 11,219.73 + 5,648.79 = 136,868.52`; bills `40,000 + 7,073.24 + 1,412.20 = 48,485.44`. Bill interest carried into 2036: `0.03 × 47,073.24 = 1,412.20`.
- With `taxableRebalance = 'flows_only'`: only stocks are overweight, so the whole sale is stocks: gain `0.424242 W`, dividends `0.015 × (330,000 − W)`, coupons 5,200; tax `5,514.02 + 0.0409242 W`; **W = 28,416.80**, tax 6,676.96, gain 12,055.61; after trades 301,583.20 / 130,000 / 40,000; total after returns 1,022,305.75.

### 3.11 Success, failure and the path summary

Success = no drawdown year with `funded + CASH_TOL < floorNeed`. After a failure the path continues with whatever income it has; shortfalls keep accumulating. If the tax of a year exceeds all the cash there is, the shortfall is capped at `need` and the unpaid tax is dropped (the path has already failed). Summary per path: `endReal`, `endNominal`, `flags`, `failIdx`, `endIdx`, `deathIdx`, `shortfallReal`, `taxesReal`, `spendReal`, and the three per-year arrays.

Worked (T28): cash account $50,000, spending $40,000 real, 25% inflation, no returns, exempt income of $10,000 real from year 2. Year 0 funds 40,000 (left 10,000). Year 1: need 50,000, only 10,000 → shortfall 40,000, the path fails with `failIdx = 1`. Year 2: need 62,500, income 15,625 → shortfall 46,875. Year 3: 78,125 − 19,531.25 = 58,593.75. `shortfallReal = 40,000/1.25 + 46,875/1.5625 + 58,593.75/1.953125 = 92,000`. Funded spending in today's dollars by year: 40,000, 8,000, 10,000, 10,000.

### 3.12 Aggregation

Input: the `RunSummary` arrays in path order. Every reduction walks them in path-index order, so the result does not depend on chunking or thread count.

- **Percentile (nearest rank).** `percentileIndex(pBp, n) = max(0, floor((pBp × n + 9999) / 10000) − 1)` on values sorted ascending: the smallest value with at least p percent of the data at or below it. Integer arithmetic; `pBp` is the percentile in basis points (5000 = median). For an even n the median is the lower of the two middle values.
- **Ranking.** `order` = path indices sorted by `endReal` ascending; ties by `failIdx` ascending with −1 (never failed) last; then `shortfallReal` descending; then path index. **Percentile path** p (0..100): `percentilePathIndex[p] = order[percentileIndex(100 p, N)]`.
- **Ending wealth.** `endingWealthRealQuantiles[p] = endReal[percentilePathIndex[p]]`; p10, p25, median, p75, p90 are entries of it; the mean is summed in path order. Nominal percentiles use `endNominal` sorted on its own.
- **Fan chart.** For each of the three per-year arrays and each plan year t take the non-NaN values of the paths with `endIdx ≥ t`, sort, and report the value at `percentileIndex(pBp, count)` for each fan percentile, `null` when there is none; `aliveCount[t]` is the number of paths with `endIdx ≥ t`. With table mortality the bands are conditional on the household being alive, and `aliveCount` is the survival curve; the UI should stop the bands where `aliveCount` falls below 100 (warning `few_alive_paths`).
- **Success rate**: `successCount / N`. **Wilson 95% interval** (bootstrap and parametric models) with z = 1.959963984540054: `center = (p̂ + z²/2N)/(1 + z²/N)`, `half = z sqrt(p̂(1 − p̂)/N + z²/4N²)/(1 + z²/N)`, clamped to [0, 1]. It measures simulation noise only, not model error.
- **Digest.** FNV-1a, 32 bits (offset basis 0x811C9DC5, prime 0x01000193, `Math.imul`), over the little-endian bytes of `endNominal` (float64, written through a `DataView`) followed by the little-endian bytes of `failIdx` (int16), as 8 hex digits.
- **Year table.** `simulatePathDetail(run, percentilePathIndex[p])` re-runs that path with detail recording on (the same function as the fast path, with a recorder branch), on the calling thread of the worker for the default set {5, 10, 25, 50, 75, 90, 95} and on demand in the API for any other p when engine and data versions match the stored run.

### 3.13 Worker-thread harness (`src/node`)

`createSimPool({ threads, threadEntry? })` returns a pool whose workers live until `close()`; `pool.run(input, opts)` runs one simulation; `runSimulation(input, opts)` is create, run, close. A Phase 5 grid reuses one pool for all its runs inside one job; nothing outlives the job, and there is no idle timer.

1. `prepare(input)` on the calling thread; an `EngineInputError` stops here.
2. Chunks: `[pathStart, pathStart + 250)` until the effective path count; 10,000 paths = 40 chunks.
3. `threads = clamp(opts.threads ?? defaultThreads(), 0, 16)`, never more than the number of chunks; `defaultThreads() = max(1, min(8, os.availableParallelism() − 1))`. With `threads = 0` the same chunk loop runs inline on the calling thread, yielding to the event loop between chunks.
4. **Thread entry.** A worker is `new Worker(entry)`. `entry` is `opts.threadEntry` when given; otherwise `new URL("./simThread.js", import.meta.url)` when that file exists (the production bundle, beside `main.js`), else `new URL("./thread.boot.mjs", import.meta.url)` (dev and tests). `thread.boot.mjs` is three lines: `import { register } from "tsx/esm/api"; register(); await import("./thread.ts");`. Reproduced on Node 22.22 with the repo's tsx 4.23: a `.ts` entry with `execArgv: ["--import", "tsx"]` fails with "Cannot find module …/helper.js imported from …/thread.ts" as soon as the entry has a relative `.js` import; the bootstrap file and the bundled file both work.
5. Protocol. Main → worker `{ type: 'init', input }` (structured clone, a few kilobytes; data tables are compiled into the worker bundle). Worker: run the self-test (below), `prepare(input)`, allocate one `PathState`, reply `{ type: 'ready', engineVersion }`. Main → worker `{ type: 'chunk', chunkId, pathStart, pathCount }`. Worker → main `{ type: 'chunkDone', chunkId, pathStart, pathCount, summary }` with every typed array's buffer in the transfer list (moved, not copied). Worker → main `{ type: 'error', name, code, message, stack, permanent }`.
6. Dispatch is by request: a worker gets its next chunk when it reports one done, which balances uneven chunks.
7. Main copies each chunk into the run arrays at `pathStart`, counts done paths and calls `opts.onProgress({ donePaths, totalPaths, elapsedMs })`.
8. Cancellation: when `opts.signal` aborts, or `opts.maxRunMs` (default 600,000) passes, main terminates every worker and rejects with `SimulationCancelledError` (`code: 'cancelled' | 'timeout'`); the pool starts fresh workers on its next run. A chunk takes tens of milliseconds, so no flag inside the loop is needed.
9. Errors keep their class: an `error` message with `name` `EngineInputError`, `EngineInvariantError` or `EngineRuntimeError` is rethrown as that class with `permanent = true`; a worker that exits or throws anything else terminates the others and rejects with `SimulationWorkerError` (retryable).
10. When all chunks are in: `aggregate()`, re-simulate the detail paths, resolve with `{ result, details, raw: { endReal, failIdx }, timing }`.

**Self-test** (`selftest.ts`, run once per thread and once inline): the three Threefry vectors of T1, `detExp(1) = 2.7182818284590455`, `detLog(2) = 0.6931471805599453`, `invNorm(0.975) = 1.9599639845400536`, `Math.sqrt(2) = 1.4142135623730951`; a mismatch throws `EngineRuntimeError('self_test_failed')` and nothing is simulated.

Structured clone and transfer are used, not `SharedArrayBuffer`, so the same protocol works in a browser worker later. `simulateChunk` is also callable inline (tests, and the API's single-path re-simulation).

### 3.14 Numerical determinism

1. Allowed operations as in decision 21. JavaScript engines evaluate each arithmetic operation separately in IEEE 754 binary64 with round-to-nearest and may not fuse a multiply and an add, and the ECMAScript specification defines `Math.sqrt` as the correctly rounded square root, so the same source gives the same bits on x64 and arm64, in Node and in a browser.
2. Constants are written as decimal literals in shortest round-trip form or as divisions of exact integers; no constant comes from `Math.E`, `Math.LN2` or `Math.pow`.
3. Typed-array views of a float's bytes are never used in the core (endianness); the digest and the tests read bytes through `DataView` with an explicit byte order.
4. Each path depends only on `(PreparedRun, pathIndex)`; aggregation is in path order; sorting uses a numeric comparator with the path index as the final tie-breaker.
5. Enforcement, two layers. A Vitest source scan (`determinism.test.ts`) fails on `Math.(exp|log|log2|log10|log1p|expm1|pow|sin|cos|tan|sinh|cosh|tanh|atan|atan2|cbrt|hypot|random)` or the `**` operator anywhere under `packages/retirement/src` outside `*.test.ts`, and is itself tested against a fixture string containing `Math.exp(`. The same list is an ESLint `no-restricted-properties` / `no-restricted-syntax` block for `packages/retirement/src/**` in the root `eslint.config.js` (a touch point, §6), for feedback in the editor.
6. The self-test of §3.13 refuses to run on a machine that disagrees; golden tests (T5, T41) pin exact bit patterns and counts.

### 3.15 Performance budget and measurement

Reference workload (`bench/run.ts`): two persons aged 45 and 43 planned to ages 104 and 102 (Y = 60), `asOf = 2026-11-10`, seven accounts (taxable, two pre-tax with one glide path, two Roth, HSA, cash), two salaries, one pension, five contributions, constant real spending, 10,000 paths, parametric and bootstrap models. It prints microseconds per path-year, `assess` calls and tax evaluations per path-year, the number of garbage collections during the run (a `PerformanceObserver` on `gc` entries) and wall time for one thread and for the default thread count.

What has been measured (4 vCPU Xeon at 2.1 GHz, Node 22.22, one thread, bracket-style stub tax functions, not the tax area's):

| Prototype | µs per path-year | Tax evaluations per path-year | Notes |
| --- | --- | --- | --- |
| Design A (allocates per year, 60-step bisection) | 8–9.5 | 18 | reproduced by both judges |
| Design B (struct of arrays, no allocation, simplified cash identity) | 0.8–1.0 | 3.2 | reproduced by both judges; 0 garbage collections; 0.43–0.59 s wall on 3 threads |
| This merged design (allocates per year, false-position solver, full rules of §3.7–3.9) | 4.4 (bootstrap) – 5.5 (parametric) | 3.5 (2.2 hook calls + baseline + record) | at most 12 hook calls in a year |

Budget for the real engine: **at most 5 µs per path-year on one thread** of the reference machine (3 s for the reference workload; the target is 4) and **at most 2 s wall on three threads** including pool start and aggregation; at most 24 `assess` calls in any year and 6 tax evaluations per path-year on average; **no garbage collection during the simulate phase** after warm-up. The loop meets the last point by construction: all state is in arrays created once per thread, hooks write into out-records, and `loop.ts`, `trades.ts` and the hooks create no closures, objects, strings or arrays per year. The GC count and the timings are asserted by `bench/run.ts` (its own process) and by `perf.test.ts` only when `PERF=1` is set; an always-on GC assertion inside Vitest would count Vitest's own allocations. A plain Vitest guard runs 500 paths × 60 years inline and fails above 5 s (it catches order-of-magnitude regressions only).

## 4. Contracts

### 4.1 Zod (in `packages/retirement/src/input.ts`; the inputs area re-exports what its API needs)

```ts
const Cents = z.string().regex(/^-?\d{1,15}$/);
const NonNegCents = z.string().regex(/^\d{1,15}$/);
const Rate = z.number().finite();
const Bp = z.number().int().min(0).max(10000);
const Year = z.number().int().min(1900).max(2200);
const Seed = z.string().regex(/^\d{1,20}$/);                       // prepare() rejects values above 2^64 − 1 (seed_invalid)
const AssetClassRecord = <T extends z.ZodTypeAny>(v: T) => z.object({ us_stock: v, intl_stock: v, bonds: v, cash: v, real_estate: v, other: v });
const Mortality = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), age: z.number().int().min(50).max(119) }),
  z.object({ kind: z.literal("table"), sex: z.enum(["male", "female", "unisex"]), qScale: z.number().min(0.25).max(4).default(1) }) ]);
const PersonInput = z.object({ birthYear: Year, retirementYear: Year, mortality: Mortality,
  rothContributionBasisCents: NonNegCents.default("0"),
  rothRecentConversions: z.array(z.object({ year: Year, amountCents: NonNegCents })).default([]) });
const GlidePoint = z.object({ year: Year, weightsBp: AssetClassRecord(Bp) });
const AccountInput = z.object({ id: z.string().min(1), name: z.string(), treatment: z.enum(["taxable", "pre_tax", "roth", "hsa", "cash"]),
  owner: z.union([z.literal(0), z.literal(1), z.null()]), holdingsCents: AssetClassRecord(NonNegCents),
  basisCents: AssetClassRecord(NonNegCents).nullable(), target: z.array(GlidePoint).min(1).max(40).nullable(),
  expenseRatioPpm: z.number().int().min(0).max(100000) });
const Growth = z.discriminatedUnion("kind", [ z.object({ kind: z.literal("real"), rate: Rate }), z.object({ kind: z.literal("nominal"), rate: Rate }) ]);
const IncomeStreamInput = z.object({ id: z.string(), person: z.union([z.literal(0), z.literal(1), z.null()]),
  kind: z.enum(["salary", "part_time", "pension", "annuity", "rental", "other"]), annualCents: NonNegCents,
  startYear: Year, endYear: Year.nullable(), growth: Growth, taxCharacter: z.enum(["wages", "ordinary", "rental", "exempt"]),
  taxableShare: z.number().min(0).max(1).default(1), survivorShare: z.number().min(0).max(1).default(0) });
const ContributionInput = z.object({ id: z.string(), accountId: z.string(), person: z.union([z.literal(0), z.literal(1)]),
  source: z.enum(["employee_pre_tax", "employee_roth", "employee_after_tax", "employer"]),
  amount: z.discriminatedUnion("kind", [ z.object({ kind: z.literal("real"), annualCents: NonNegCents }),
    z.object({ kind: z.literal("share_of_income"), incomeId: z.string(), share: z.number().min(0).max(1) }) ]),
  startYear: Year, endYear: Year });
const RothConversionInput = z.object({ year: Year, fromAccountId: z.string(), toAccountId: z.string(), amountCents: NonNegCents, real: z.boolean() });
const MeanVol = z.object({ mean: Rate.min(-0.5).max(1), vol: z.number().min(0).max(1) });
const ParametricParams = z.object({ meanKind: z.enum(["arithmetic", "geometric"]), stocks: MeanVol, bonds: MeanVol,
  bills: MeanVol.extend({ persistence: z.number().min(0).max(0.95).default(0), initial: Rate.min(-0.2).max(0.5).optional() }),
  inflation: MeanVol.extend({ persistence: z.number().min(0).max(0.95), initial: Rate.min(-0.2).max(0.5) }),
  correlation: z.array(z.array(z.number().min(-1).max(1)).length(4)).length(4) });
const ReturnModelInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("historical"), cohorts: z.enum(["auto", "complete", "wrap"]).default("auto") }),
  z.object({ kind: z.literal("bootstrap"), meanBlockYears: z.number().min(1).max(30).default(10) }),
  z.object({ kind: z.literal("parametric"), preset: z.enum(["historical", "conservative", "custom"]), params: ParametricParams.optional() }),
  z.object({ kind: z.literal("fixed"), series: z.array(z.object({ stocks: Rate, bonds: Rate, bills: Rate, inflation: Rate })).min(1).max(120) }) ]);
export const EngineInputSchema = z.object({ schemaVersion: z.literal(1), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seed: Seed, pathCount: z.number().int().min(1).max(100000).default(10000),
  persons: z.array(PersonInput).min(1).max(2), accounts: z.array(AccountInput).min(1).max(32),
  assetClassMap: AssetClassRecord(z.tuple([Bp, Bp, Bp])), incomes: z.array(IncomeStreamInput).max(40),
  contributions: z.array(ContributionInput).max(64), conversions: z.array(RothConversionInput).max(120),
  socialSecurity: z.unknown(), spending: z.unknown(), withdrawal: z.unknown(), tax: z.unknown(),   // each replaced by the owning area's schema
  portfolio: z.object({ taxableRebalance: z.enum(["full", "flows_only"]).default("full"),
    stockDividendYield: z.number().min(0).max(0.2).default(0.013), bondInterestYield: z.number().min(0).max(0.2).default(0.042),
    jointBasisStepUp: z.enum(["half", "full", "none"]).default("half"), surplusAccountId: z.string().nullable().default(null) }),
  returnModel: ReturnModelInput,
  returnShift: z.object({ stocks: Rate, bonds: Rate, bills: Rate }).optional() });
export type EngineInput = z.infer<typeof EngineInputSchema>;
```
`bills.initial` defaults to the data file's last bill return when omitted. `EngineResultSchema` and `PathDetailSchema` mirror §2.6 and §2.7 field for field (`Cents` strings, numbers, arrays).

Checks `prepare()` adds beyond the schema, each an `EngineInputError(code, message)`: `seed_invalid`, `weights_sum` (a map row or glide point not summing to 10000), `owner_required`, `basis_required`, `unknown_account` (a contribution, conversion or surplus account naming a missing account), `conversion_accounts` (not pre-tax → Roth of one owner), `person_missing` (owner or person index 1 with one person), `custom_params_required`, `correlation_not_symmetric`, `correlation_not_positive_definite`, `historical_horizon_too_long`, `horizon_too_long`, `path_years_too_many`, `no_investable_balance` (every account zero and no contribution). The inputs area maps these to `PlanError(400, code, message)`.

### 4.2 Pure functions

```ts
// core ("@meridian/retirement")
export function prepare(input: EngineInput, hooks?: Partial<EngineHooks>): PreparedRun;            // throws EngineInputError
export function simulateChunk(run: PreparedRun, pathStart: number, pathCount: number, state?: PathState): ChunkSummary;
export function simulatePathDetail(run: PreparedRun, pathIndex: number): PathDetail;
export function aggregate(run: PreparedRun, summary: RunSummary): EngineResult;
export function simulateInline(input: EngineInput, hooks?: Partial<EngineHooks>): EngineResult;    // prepare + one chunk + aggregate; tests and small runs
export function selfTest(): void;                                   // throws EngineRuntimeError('self_test_failed')
export function firstYearFraction(asOf: string): number;
export function centsToDollars(c: string): number;                 // Number(c) / 100
export function dollarsToCents(x: number): string;                 // sign(x) and floor(|x| * 100 + 0.5); "-0" is "0"
export function threefry2x32(k0: number, k1: number, c0: number, c1: number, out: Uint32Array): void;
export function seedKey(seed: string): [number, number];           // [seed mod 2^32, floor(seed / 2^32)]
export function uniformAt(key: readonly [number, number], path: number, purpose: number, step: number, slot: number): number;
export function invNorm(u: number): number;
export function detExp(x: number): number; export function detLog(x: number): number;
export function detPow(x: number, y: number): number; export function powInt(x: number, n: number): number;
export function lognormalFromArithmetic(mean: number, vol: number): { mu: number; sigma: number };
export function lognormalFromGeometric(mean: number, vol: number): { mu: number; sigma: number };
export function cholesky(m: Float64Array, n: number): Float64Array;                                 // row-major lower factor
export function estimateLogMoments(): ParametricLogParams;                                           // the `historical` preset
export function bootstrapIndices(seed: string, path: number, years: number, n: number, meanBlockYears: number): Int16Array;
export function cohortFor(run: PreparedRun, pathIndex: number): { startIndex: number; startYear: number; replicate: number; wrapped: boolean };
export function calendarDeathProbability(q: Float64Array, maxAge: number, qScale: number, age: number): number;   // qCal of §3.6
export function percentileIndex(pBp: number, n: number): number;
export function wilson95(successes: number, n: number): [number, number];
export function rankPaths(s: RunSummary): Uint32Array;
export function digest(endNominal: Float64Array, failIdx: Int16Array): string;
// harness ("@meridian/retirement/node")
export interface PoolOptions { threads?: number; threadEntry?: URL }
export interface RunOptions { onProgress?: (p: { donePaths: number; totalPaths: number; elapsedMs: number }) => void;
  signal?: AbortSignal; maxRunMs?: number; detailPercentiles?: number[] }
export interface RunOutput { result: EngineResult; details: Record<number, PathDetail>;
  raw: { endReal: Float64Array; failIdx: Int16Array };              // per path, for Phase 5's paired scenario comparison
  timing: { elapsedMs: number; threads: number; pathYears: number; assessCalls: number } }
export interface SimPool { readonly threads: number; run(input: EngineInput, opts?: RunOptions): Promise<RunOutput>; close(): Promise<void> }
export function createSimPool(opts?: PoolOptions): SimPool;
export function runSimulation(input: EngineInput, opts?: RunOptions & PoolOptions): Promise<RunOutput>;
export function defaultThreads(): number;
// errors (core)
export class EngineInputError extends Error { readonly permanent = true; constructor(readonly code: string, message: string) }
export class EngineInvariantError extends Error { readonly permanent = true; constructor(readonly code: string, message: string) }
export class EngineRuntimeError extends Error { readonly permanent = true; constructor(readonly code: 'self_test_failed', message: string) }
// errors (harness)
export class SimulationCancelledError extends Error { readonly permanent = true; constructor(readonly code: 'cancelled' | 'timeout') }
export class SimulationWorkerError extends Error { }               // retryable
```

### 4.3 Hooks (`src/hooks.ts`): what the loop calls and what it hands over

```ts
export interface YearView {                 // one instance per thread, mutated in place; read-only for hooks; valid only during the call; money in nominal dollars
  readonly pathIndex: number; readonly t: number; readonly year: number; readonly yearFraction: number;
  readonly cpi: number;                     // price level at the start of this year; today = 1
  readonly colaIndex: number;               // cost-of-living index at the start of this year (§3.1)
  readonly cpiSeries: Float64Array;         // cpi[0..t]; later entries are NaN
  readonly phase: 0 | 1;                    // 0 accumulation, 1 drawdown
  readonly filingStatus: 0 | 1;             // 0 single, 1 married filing jointly
  readonly personCount: 1 | 2;
  readonly alive: Uint8Array; readonly retired: Uint8Array; readonly age: Int16Array; readonly birthYear: Int16Array;
  readonly accountCount: number; readonly treatment: Uint8Array; readonly owner: Int8Array;
  readonly balance: Float64Array;           // per account, before any flow of this year (the prior year-end balance)
  readonly available: Float64Array;         // balance − RMD − conversions out (valid from step 3b)
  readonly portfolioStart: number;          // sum of balance
  readonly wages: number;                   // this year, full-year amounts
  readonly guaranteedIncome: number;        // pensions + annuities + Social Security, full-year
  readonly otherIncome: number; readonly socialSecurity: Float64Array;
  readonly prevPortfolioReturn: number;     // last year's nominal return; NaN in year 0
  readonly prevInflation: number;           // last year's inflation; NaN in year 0
  readonly prevFundedSpend: number;         // last year's funded spending, nominal; NaN in year 0
  readonly input: EngineInput;              // the owning area reads its own opaque block
}
export interface SpendDecision { spend: number; floor: number; lump: number; lumpFloor: number; healthcare: number }
export interface Assessment { net: number; tax: number; taxResult: TaxResult }      // taxResult is engine-owned and overwritten by every call
export type AssessFn = (w: Float64Array, out: Assessment) => void;
export interface RothQuery { person: number; amount: number; age: number; balance: number }   // one engine-owned record, refilled per call
export interface EngineHooks {
  publishedCola(year: number): number;                                     // tax-rmd-ss; the adjustment effective January of `year`, NaN when not published; called by prepare() only
  socialSecurity(view: YearView, out: Float64Array): void;                 // tax-rmd-ss: full-year benefit per person, incl. spousal and survivor, already times view.colaIndex
  rmd(view: YearView, out: Float64Array): void;                            // tax-rmd-ss: full-year RMD per account; 0 for other accounts and before the owner's start age
  resolveTaxYear(view: YearView, out: TaxYearParams): void;                // tax-rmd-ss: published years as published, later years indexed by cpi
  federalTax(input: TaxInput, params: TaxYearParams, out: TaxResult): void;// tax-rmd-ss: pure; writes into out
  splitRothWithdrawal(q: RothQuery, rothState: Float64Array, offset: number, out: RothSplit): void; // tax-rmd-ss: the ordering rules over the layout of §2.4
  decideSpending(view: YearView, strategyState: Float64Array, out: SpendDecision): void;   // strategies
  planWithdrawals(view: YearView, assess: AssessFn, w: Float64Array): void;                // strategies: the order and the gross-up
}
```
Rules for every hook: pure apart from its `out` argument and (for `decideSpending`) the strategy state; no allocation; no randomness; no access to this year's return or inflation; none of the banned `Math` functions (use `detExp`, `detLog`, `detPow`, `powInt`). Results travel in the preallocated `out` record or array, never as a returned number or a new object: V8 boxes a double that crosses a non-inlined call, which is what the zero-GC budget of §3.15 measures. The default registry maps the ids in `input.spending`, `input.withdrawal` and `input.tax` to the modules of the other areas inside the same package; `prepare(input, hooks)` and `simulateInline(input, hooks)` let a test replace any of them, which is how every loop case of §7 runs through the public API with stub hooks and the `fixed` model. The stubs live in `src/testing/stubs.ts` (export `"@meridian/retirement/testing"`): `flatTax(ordinaryRate, gainRate)`, `bracketTax(threshold, lowRate, highRate)`, `noTax`, `constantRealSpending(annual, lumpsByYear)`, `orderWithdrawals(treatmentOrder)` (the reference solver of §3.9), `rmdByDivisor(divisor, fromAge)`, `fixedSocialSecurity(amounts)` and `noPublishedCola`; they are test doubles and also let this area's suite run before the other areas' modules exist.

## 5. UI

This area has no screens. The pages, the fan chart and the dashboard card are owned by strategies-outputs-web. What they receive from this area and what it asks of them:

- **Headline:** `successRate` with `successCi95`, labelled as simulation noise; when the interval is `null` (historical) the caption is "all N historical start years" with `model.cohortMode` and `cohortCount`, not a margin of error.
- **Fan charts:** `percentilesBp`, `fanReal`, `fanNominal`, `fanSpendingReal` and `aliveCount`; a band value is `null` where no path is running; stop or fade the bands where `aliveCount` is below 100.
- **Year table:** `PathDetail` for `percentilePathIndex[p]`; its last `endTotalReal` equals `endingWealthRealQuantiles[p]`; with the historical model `cohortStartYear` lets the page say "the path that starts in 1966".
- **States driven by the engine:** running with `{ donePaths, totalPaths }`; cancelled; failed with an input error code, each needing a plain sentence, for example `historical_horizon_too_long`: "This plan is longer than the historical record allows with complete cycles; switch to wrap-around or shorten the plan"; `correlation_not_positive_definite`: "These correlations cannot all hold at once; lower one of them"; `horizon_too_long`: "A plan cannot run for more than 120 years".
- **Notes from warnings:** `mortality_fallback_table` ("Life expectancy draws use the IRS 2010 table for both sexes because the Social Security table is not installed"), `first_year_lump` ("A conversion or one-off goal dated in the rest of this year is taxed as if it repeated at that pace, which overstates its tax"), `historical_wrapped`, `intl_modelled_as_us`, `other_mapped_to_stocks`.
- **Settings:** one read-only line showing the thread count in use (from the worker's `SIM_THREADS`).

## 6. Jobs and services

- **`createSimPool` / `runSimulation`** (`@meridian/retirement/node`) is the only service this area provides. A run is idempotent: the same `EngineInput` with the same engine and data versions returns the same result and the same digest, so a retried job cannot produce a different answer and the job can compare digests to detect drift.
- **The job** (owned by inputs-and-data; assumed name `retirement.simulate`, payload `{ simRunId }`): load the stored input snapshot, call `runSimulation(input, { threads: config.simThreads, onProgress, signal, detailPercentiles: [5, 10, 25, 50, 75, 90, 95] })`, store `result`, `details`, `raw` and `timing`. Progress writes should be throttled to one per second. The runner drains one job at a time, so other jobs wait for the seconds a run takes; the 30-minute stale-job sweep is far longer than any run.
- **Failure handling:** `EngineInputError`, `EngineInvariantError`, `EngineRuntimeError` and `SimulationCancelledError` carry `permanent = true` (the runner's `isPermanentError` then does not retry; the run is marked failed or cancelled with the code). `SimulationWorkerError` is retryable. A cancel request is delivered by aborting the `AbortSignal`.
- **Touch points outside the package** (for the skeleton step):
  - `apps/worker/package.json` and `apps/api/package.json` gain `"@meridian/retirement": "workspace:*"`; the worker's `build` gains a second bundle, `node ../../scripts/bundle.mjs ../../packages/retirement/src/node/thread.ts dist/simThread.js`.
  - `apps/worker/Dockerfile` and `apps/api/Dockerfile` copy `packages/retirement/package.json` in the runtime stage, next to the lines for `packages/db` and `packages/shared` (the runtime stage runs `pnpm install --frozen-lockfile --prod --filter …`, which needs every workspace manifest; the API needs it because it calls `simulatePathDetail`).
  - `apps/worker/src/env.ts` gains `simThreads` from `SIM_THREADS` (integer 0..16; unset = `defaultThreads()`; 0 = inline), documented in `.env.example` with the note that the server's core count is unknown and one core is left for Postgres and the API.
  - the root `eslint.config.js` gains the restricted-`Math` block of §3.14 for `packages/retirement/src/**`.
- **API-side re-simulation** (route owned by the other areas): `simulatePathDetail(prepare(snapshot), percentilePathIndex[p])` in the API process when `ENGINE_VERSION` and `DATA_VERSION` equal the run's; otherwise answer from the stored `details` or ask for a re-run. The API never starts threads.

## 7. Test cases

Conventions: integers, indices, hex words and bit patterns are asserted exactly; dollars within 0.005; rates within 1e-9 unless stated. "Stub tax" = 20% of ordinary income plus 10% of gains and qualified dividends, a test double, not the tax area's function. Unless stated: one person, `asOf` on January 1 (f = 1), no income, yields 0, full rebalancing, stub order cash → taxable → pre-tax → Roth → HSA with the reference solver of §3.9. Every loop case runs through the public API: `simulateInline(input, stubHooks)` or `simulatePathDetail(prepare(input, stubHooks), k)`, with the `fixed` model unless a historical cohort is named. Seed "20261110" throughout.

**Generator and math**

**T1. Threefry known answers** (Random123 `kat_vectors`, counter then key): ctr (0, 0), key (0, 0) → `6b200159 99ba4efe`; ctr (ffffffff, ffffffff), key (ffffffff, ffffffff) → `1cb996fc bb002be7`; ctr (243f6a88, 85a308d3), key (13198a2e, 03707344) → `c4923a9c 483df7a0`.

**T2. Seed split and counter packing.** "20261110" → k0 = 20261110 = 0x013528f6, k1 = 0. "1311768467294899695" (0x1234567890abcdef) → k0 = 0x90abcdef = 2427178479, k1 = 0x12345678 = 305419896. "18446744073709551615" → (4294967295, 4294967295); "18446744073709551616" → `seed_invalid`. Purpose 3, step 258, slot 5 → c1 = 0x03010205; purpose 0, step 59, slot 3 → 0x00003b03.

**T3. Stream outputs and the uniform.**

| path | purpose | step | slot | words | u |
| --- | --- | --- | --- | --- | --- |
| 0 | MARKET | 0 | 0 | `691cfdbf 6b6ad584` | 0.4105986121237116 |
| 0 | MARKET | 0 | 1 | `604c3d1f a52691e0` | 0.3761633134651151 |
| 0 | MARKET | 0 | 2 | `34c86542 793c9e14` | 0.20618279983969334 |
| 0 | MARKET | 0 | 3 | `a6550a56 0187d3c3` | 0.6497351081070127 |
| 1 | MARKET | 0 | 0 | `208659bb 02d6d548` | 0.1270500125153452 |
| 0 | MARKET | 1 | 0 | `3feaecd3 8549679f` | 0.2496784257985848 |
| 9999 | MARKET | 59 | 3 | `e9e4ab17 2d6f8a4e` | 0.9136454489452127 |
| 0 | BOOT | 0 | 0 | `b790d2ed cd15d199` | 0.7170535892414179 |
| 0 | BOOT | 0 | 1 | `cf9cc367 eeef446a` | 0.8109857728084687 |
| 0 | MORTALITY | 0 | 0 | `f76c6ff5 23f7e8d1` | 0.9664983621314399 |
| 0 | MORTALITY | 0 | 1 | `a5c4e7ba 3b781db8` | 0.6475357745930787 |

First row by hand: `0x691cfdbf >>> 6 = 27554806`, `0x6b6ad584 >>> 6 = 28158806`; `n = 27554806 × 67108864 + 28158806 = 1849171756559190`; `u = (n + 0.5)/2^52 = 0.4105986121237116`. Edges: words (0, 0) → `1.1102230246251565e-16`; (ffffffff, ffffffff) → `0.9999999999999999`; (80000000, 0) → `0.5000000000000001`.

**T4. Inverse normal.** `invNorm(0.975) = 1.9599639845400536`; `invNorm(0.025) = −1.9599639845400538`; `invNorm(0.5) = 0`; `invNorm(0.9) = 1.2815515655446008`; `invNorm(0.3) = −0.5244005127080407`; `invNorm(0.001) = −3.090232306167813`; `invNorm(1e-10) = −6.361340902404056`; `invNorm(0.01) = −2.3263478740408408` (bits `c0029c5c4630ff0e`); `invNorm(2^-53) = −8.209536151601386`. Branch boundary: `invNorm(0.075) = −1.4395314709384557` takes the central branch (in binary64, `0.075 − 0.5` is exactly `−0.425`); `invNorm(0.07) = −1.4757910281791702` is the first tail value tested. From T3: the four MARKET uniforms of path 0, year 0 give −0.22600539504450393, −0.31557300938964367, −0.8197377940839978 (bits `bfea3b4ac11c59ba`), 0.3846054120421159; `invNorm(0.9664983621314399) = 1.8316520570794343` (tail). Property: `invNorm(u) = −invNorm(1 − u)` exactly for the uniforms of paths 0..999 at (MARKET, 0, 0) (on the generator's grid `1 − u` is exact).

**T5. Deterministic exp and log.** `detExp(0) = 1`, `detLog(1) = 0`, `detLog(2) = 0.6931471805599453` (bits `3fe62e42fefa39ef`), `detExp(1) = 2.7182818284590455` (bits `4005bf0a8b14576a`, one unit above `Math.E`), `detExp(−0.5) = 0.6065306597126334`, `detLog(1.07) = 0.06765864847381485`, `detExp(detLog(1.07)) = 1.07`. Golden bit patterns: `detExp(0.5)` → `3ffa61298e1e069c`; `detExp(−1.25)` → `3fd25618372a584f`; `detLog(1.07)` → `3fb15213c27c917f`; `detLog(0.561625)` → `bfe27622d7f54a80` (the last two differ from this machine's `Math.log` by one unit in the last place, which is why the engine owns the function). `detPow(1.10, 52/365) = 1.0136710422166744`; `detPow(1.03, 52/365) = 1.0042199962444256`. `detLog(Infinity) = Infinity`, `detLog(0) = −Infinity`, `detLog(−1)` is NaN. Property: within 4 ulp of `Math.exp` / `Math.log` on 100,000 seeded arguments.

**T6. Lognormal conversions.** Arithmetic 7%, vol 18%: `σ² = ln(1 + 0.0324/1.1449) = 0.027906384154`, σ = 0.167052040258, μ = ln 1.07 − σ²/2 = 0.053705456397; check `exp(μ + σ²/2) − 1 = 0.07`. Geometric 5%, vol 18%: `y = (1 + sqrt(1 + 4 × 0.0324/1.1025))/2`, σ² = 0.028170876967, σ = 0.167841821268, μ = ln 1.05 = 0.048790164169; check: standard deviation of the simple return = 0.18, expected return 0.0648943610.

**T7. Cholesky of a stated matrix.** `[[4, 12, −16], [12, 37, −43], [−16, −43, 98]]` → `L = [[2, 0, 0], [6, 1, 0], [−8, 5, 3]]` (by hand: `L11 = 2`; `L21 = 12/2 = 6`; `L22 = sqrt(37 − 36) = 1`; `L31 = −16/2 = −8`; `L32 = (−43 + 48)/1 = 5`; `L33 = sqrt(98 − 64 − 25) = 3`).

**T8. Cholesky from volatilities and correlations; rejection.** Vols (0.20, 0.08, 0.03), ρ(1,2) = 0.2, ρ(1,3) = 0, ρ(2,3) = 0.3: covariance rows (0.04, 0.0032, 0), (0.0032, 0.0064, 0.00072), (0, 0.00072, 0.0009); `L11 = 0.2`; `L21 = 0.0032/0.2 = 0.016`; `L22 = sqrt(0.0064 − 0.000256) = 0.0783836718`; `L31 = 0`; `L32 = 0.00072/0.0783836718 = 0.0091855865`; `L33 = sqrt(0.0009 − 0.0000843750) = 0.0285591491`. Correlations ρ(1,2) = ρ(1,3) = 0.9, ρ(2,3) = −0.9 (determinant −2.888) raise `correlation_not_positive_definite`.

**Return models and indexes**

**T9. Parametric path.** Parameters: arithmetic; stocks 7% / 18%, bonds 4% / 7%, bills 3% / 2% (persistence 0), inflation 2.5% / 2% with persistence 0.5 and initial 3%; innovation correlations stocks–bonds 0.1, bonds–bills 0.3, bonds–inflation −0.2, bills–inflation 0.4, others 0. Then μ = (0.0537054564, 0.0369606659, 0.0293703186, 0.0245022859), innovation volatilities (0.1670520403, 0.0672316474, 0.0194156458, 0.0168964486), `L` rows: (0.1670520403); (0.0067231647, 0.0668946445); (0, 0.0058540375, 0.0185120919); (0, −0.0033963140, 0.0081624667, 0.0143989293). Path 0, full first year:

| t | z0 | z1 | z2 | z3 | stocks factor | bonds factor | bills factor | inflation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | −0.2260053950 | −0.3155730094 | −0.8197377941 | 0.3846054120 | 1.0160786871 | 1.0144342320 | 1.0124244308 | 0.0273155653 |
| 1 | −0.6755020465 | 0.2502430413 | −1.5082554605 | 0.0474222089 | 0.9425761769 | 1.0503874265 | 1.0029185376 | 0.0133356972 |
| 2 | 0.9222214077 | −0.0499065316 | −0.1329648740 | 2.2105835696 | 1.2309231596 | 1.0406259766 | 1.0269740942 | 0.0510494446 |

Year 0 by hand: stocks `0.0537054564 + 0.1670520403 × (−0.2260053950) = 0.0537054564 − 0.0377546624 = 0.0159507940`, `e^x = 1.0160787`; bonds `0.0369606659 − 0.0015194715 − 0.0211101443 = 0.0143310502` → 1.0144342; bills `0.0293703186 − 0.0018473762 − 0.0151750614 = 0.0123478810` → 1.0124244; inflation innovation `0.0010717850 − 0.0066910824 + 0.0055379061 = −0.0000813913`; conditional mean `0.0245022859 + 0.5 × (ln 1.03 − 0.0245022859) = 0.0270305441`; `ℓ_0 = 0.0269491528` → inflation 0.0273156.

Same path with `f0 = 52/365` (`√f0 = 0.3774463583`): year-0 factors 0.9934225552, 0.9967295228, 0.9977617162 and price factor 1.0038275123 (stocks by hand: `0.1424657534 × 0.0537054564 + 0.3774463583 × (−0.0377546624) = −0.0065991715`; inflation: `0.1424657534 × 0.0270305441 + 0.3774463583 × (−0.0000813913) = 0.0038202060`); year 1 is unchanged, because the AR state carries the full-year rate.

Same parameters with `bills.persistence = 0.9`, `bills.initial = 0.0421`: bill innovation volatility `0.0194156458 × sqrt(0.19) = 0.0084630838`; third row of `L` (0, 0.0025517158, 0.0080692338); year 0 conditional mean `0.0293703186 + 0.9 × (ln 1.0421 − 0.0293703186) = 0.0400511491`, innovation `−0.0008052526 − 0.0066146559 = −0.0074199085`, bills factor 1.0331694780; years 1 and 2: 1.0209904969, 1.0206428443; the other three series are unchanged.

**T10. One AR step.** μ = (0.07, 0.04, 0.03, 0.025), persistence bills 0.9 and inflation 0.6, previous log rates bills 0.045 and inflation 0.04, `L` rows [0.18], [0.004, 0.07], [0, 0.003, 0.012], [0.002, −0.003, 0.008, 0.028], z = (−1, 0.5, 1, 2). Innovations −0.18, 0.031, 0.0135, 0.0605; log rates −0.11, 0.071, 0.057 (`0.03 + 0.9 × 0.015 + 0.0135`), 0.0945 (`0.025 + 0.6 × 0.015 + 0.0605`); factors 0.8958341353, 1.0735812259, 1.0586558104, 1.0991091631.

**T11. Bootstrap index selection** (N = 98).

Path 0, mean block 10 (`p = 0.1`):

| t | decision uniform | start uniform | result | year |
| --- | --- | --- | --- | --- |
| 0 | (first year) | 0.810986 → `floor(79.48)` | new block, index 79 | 2007 |
| 1–7 | 0.622843, 0.903712, 0.501262, 0.801991, 0.577918, 0.342818, 0.375882 | — | all ≥ 0.1, next | 2008–2014 |
| 8 | 0.073413 | 0.558246 → `floor(54.71)` | < 0.1, new block, index 54 | 1982 |
| 9–11 | 0.144596, 0.370339, 0.468951 | — | next | 1983–1985 |
| 12 | 0.081533 | 0.474322 → `floor(46.48)` | new block, index 46 | 1974 |
| 13 | 0.144629 | — | next | 1975 |

Path 0 with mean block 5 (`p = 0.2`) is the same through year 8; year 9 restarts (0.144596 < 0.2, start 0.223205 → index 21, 1949) and years 10, 11 are 1950, 1951. Path 7, mean block 5: starts at 1938 (start uniform 0.111365 → index 10) and runs unbroken through 1949. Path 1, mean block 4, twelve years: `*1980 1981 1982 1983 *2016 2017 2018 2019 2020 2021 2022 2023` (`*` = new block; year 0 start uniform 0.531158 → 52; year 4 decision 0.077454 < 0.25, start 0.905000 → 88). Unit checks: previous index 97 and no restart gives index 0; mean block 1 restarts every year.

**T12. Cohort mapping and path counts** (N = 98). Fixed mortality: Y = 30 → complete, 69 cohorts, start years 1928–1996, 69 paths (warning `path_count_adjusted` for `pathCount = 10000`); Y = 61 → complete, 38 cohorts (1928–1965); Y = 75 → auto wraps, 98 cohorts; Y = 99 with `cohorts: 'complete'` → `historical_horizon_too_long`; Y = 99 with `wrap` → 98 paths. Table mortality, person born 1962, `asOf = 2027-01-01`, table with M = 119 (Y = 56): auto → wrap, 98 cohorts × 103 = 10,094 paths; explicit `complete` → 43 cohorts (1928–1970) × 233 = 10,019 paths; `pathCount = 500` → 588 paths (6 per cohort). Path 45 with 69 cohorts → cohort 1973; path 114 → cohort 1973, replicate 1; wrap, path 10,093 → start year 2025, replicate 102. Wrap, start index 92, Y = 8 → 2020, 2021, 2022, 2023, 2024, 2025, 1928, 1929 and flag bit 1 set.

**T13. Data files.** Every row of the validation tables in §2.8 for the return series and the fallback life table; the estimator outputs of §3.5 to four decimals (μ, σ, `φ_π`, shock volatility, the six correlations, the ten non-zero entries of `L`); the conservative preset's log parameters to four decimals; a manifest whose checksum does not match fails.

**T14. First-year fraction.** 2026-11-10 → 52/365; 2027-01-01 → 1; 2028-12-31 → 1/366; 2028-03-01 → 306/366; 2028-07-02 → 183/366 = 0.5.

**T15. Year-0 scaling of a history row.** `f0 = 52/365`, row 1973, data means of §3.5: stocks `x = ln(0.856920) = −0.154411`, `f0·m = 0.013601`, `√f0 (x − m) = −0.094317`, log −0.080716, factor 0.922456; bonds 1.003147; bills 1.018031; price factor 1.024782. With `f0 = 1` the factors are exactly the row's own (no exp/log round trip). Fixed model: `1.10^(52/365) = 1.013671042`.

**T16. Price and cost-of-living indexes.** The two worked cases of §3.1: `cola` = 1, 1.03, 1.03, 1.05987; and with `asOf = 2026-11-10` and a published 3.6% for January 2027: `cpi` = 1, 1.004220, 0.984136, 1.033342, `cola` = 1, 1.036, 1.036, 1.066044. A published adjustment for the start year itself is ignored (it is already in today's dollars).

**Mortality**

**T17. Calendar-year probabilities and draws.** The fixture of §3.6. `qScale = 0.5` → `qCal(90) = 0.0675`, `qCal(94) = 0.375`, `qCal(95) = 1`; `qScale = 2` → `qCal(90) = 0.27`, `qCal(93) = 0.8`, `qCal(94) = 1`. Draws for two persons who attain 90 in year 0, `f0 = 1`: path 0 → `[5, 3]`; path 1 (u = 0.5219427464730636, 0.7826978958245384) → `[3, 4]`; path 2 (u = 0.461106800847343, 0.2094269807901371) → `[2, 1]`. Strictness: u = 0.135 exactly → index 1; u = 0.1349999 → index 0. `f0 = 0.5`: year-0 survival `0.865^0.5 = 0.9300537619`, `cdf` = 0.0699462381, 0.2327056464, 0.4245292348, 0.6547175409, 0.9136793852, 1 → paths 0, 1, 2 → `[5, 3]`, `[3, 4]`, `[3, 1]`.

**T18. Fixed ages and the horizon.** Born 1962, fixed age 95, `startYear = 2027` → `deathIdx = 30`, Y = 31. Two people born 1960 and 1962, fixed ages 84 and 93, start 2027 → `deathIdx = [17, 28]`, Y = 29, married filing jointly through plan year 17 (2044), single from plan year 18. A table with M = 109 and a person born 1962, start 2027: Y = 46 (last possible death at age 110).

**Year loop**

**T19. A fixed historical path, year by year.** `asOf = 2027-01-01`, born 1962, fixed age 69 (Y = 5), one Roth account $600,000 stocks / $400,000 bonds, target 60/40, constant real spending $40,000, no tax, historical model with complete cohorts (94), path 45 = cohort 1973.

| Year | Hist. | cpi start | Spend | After flows, stocks / bonds | Returns stocks / bonds | Inflation | End stocks / bonds | End total | End, today's $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2027 | 1973 | 1.000000 | 40,000.00 | 576,000.00 / 384,000.00 | −14.3080% / 3.6587% | 8.7059% | 493,585.92 / 398,049.41 | 891,635.33 | 820,227.17 |
| 2028 | 1974 | 1.087059 | 43,482.36 | 508,891.78 / 339,261.19 | −25.9018% / 1.9886% | 12.3377% | 377,079.65 / 346,007.74 | 723,087.38 | 592,123.29 |
| 2029 | 1975 | 1.221177 | 48,847.08 | 404,544.18 / 269,696.12 | 36.9951% / 3.6053% | 6.9364% | 554,205.71 / 279,419.47 | 833,625.18 | 638,361.40 |
| 2030 | 1976 | 1.305883 | 52,235.31 | 468,833.92 / 312,555.95 | 23.8310% / 15.9846% | 4.8649% | 580,561.73 / 362,516.77 | 943,078.50 | 688,673.69 |
| 2031 | 1977 | 1.369413 | 54,776.51 | 532,981.19 / 355,320.80 | −6.9797% / 1.2900% | 6.7010% | 495,780.71 / 359,904.43 | 855,685.14 | 585,613.59 |

First row by hand: 1,000,000 − 40,000 = 960,000; 60% = 576,000 × 0.856920 = 493,585.92; 40% = 384,000 × 1.036587 = 398,049.41; total 891,635.33; ÷ 1.087059 = 820,227.17. Second row: spend 40,000 × 1.087059 = 43,482.36; 848,152.97 left; 508,891.78 × 0.740982 = 377,079.65; 339,261.19 × 1.019886 = 346,007.74. Result: success, `endReal` = "58561359" cents, `endIdx` = 4.

**T20. Engine-level reference on the pinned data.** Same household with fixed age 94 (Y = 30) and $40,000 real spending from $1,000,000, `cohorts: 'auto'`: 69 complete cohorts, 65 succeed (94.2%); the failing start years are 1965, 1966, 1968 and 1969 (first failing plan years 27, 25, 27, 27). Ending wealth in today's dollars: 10th percentile 156,910.48 (the path that starts in 1967), median 1,387,869.67 (the path that starts in 1951), 90th percentile 3,865,589.65; `successCi95` is null. With a 50/50 mix: 64 of 69; failing 1964, 1965, 1966, 1968, 1969 (plan years 29, 26, 24, 27, 27). With `cohorts: 'wrap'`: 98 paths, 94 succeed, the same four failures.

**T21. Partial first year, fixed model.** `asOf = 2026-11-10` (f0 = 52/365), born 1960, fixed age 68, Roth $500,000 all stocks, spending $36,500 real, fixed series stocks +10%, inflation 3%. Year 2026: spend 36,500 × 52/365 = 5,200.00; after flows 494,800.00; factor `1.10^(52/365) = 1.013671042`; end 501,564.43; `cpi[1] = 1.03^(52/365) = 1.004219996`; today's dollars 499,456.73. Year 2027: spend 36,500 × 1.004219996 = 36,654.03; after 464,910.40; end 511,401.44; `cpi[2] = 1.034346596`; today's dollars 494,419.80. Year 2028: spend 37,753.65; end 521,012.57; today's dollars 489,040.57.

**T22. Partial first year, historical cohort.** `asOf = 2026-11-10`, born 1960, fixed age 67 (Y = 2), Roth $600,000 / $400,000 at 60/40, spending $36,500 real, complete cohorts, path 45 (1973). 2026: spend 5,200.00; after flows 596,880.00 / 397,920.00; period returns −7.7544% / 0.3147% (T15); price factor 1.024782; end 550,595.51 / 399,172.28; total 949,767.79; today's dollars 926,799.40. 2027 (1974, a full year): spend 37,404.56; after flows 547,417.94 / 364,945.29; end 405,626.84 / 372,202.59; total 777,829.43; today's dollars 675,658.35.

**T23. Trades, realized gains and the guards.** The two worked cases of §3.8 (full: gain 74,285.71, basis 244,285.71 / 370,000, holdings 570,000 / 380,000; flows only: gain 28,571.43, basis 278,571.43 / 290,000, holdings 650,000 / 300,000). A Roth account with the same numbers trades the same amounts and reports no gain. A single-asset taxable account (100,000 stocks, basis 40,000, target 100/0/0, no returns) with 10,000 withdrawn in each of two years: gain 6,000 each year, holdings 90,000 then 80,000, basis 36,000 then 32,000, in both modes, with no NaN anywhere. A taxable account exactly on target (60,000 / 40,000, target 60/40) with no flow under `flows_only`: no trade, gain 0, balances and basis unchanged.

**T24. Same-year settlement.** The three gross-up results of §3.9 with the stub tax: 50,000.00 / 10,000.00; 47,337.28 / 7,337.28 (gain 73,372.78; holdings after 571,597.63 / 381,065.09; basis 244,970.41 / 371,065.09); 42,424.24 / 2,424.24 (gain 24,242.42; holdings 657,575.76 / 300,000; basis 281,818.18 / 290,000). In each, the recorded `net` is within 0.005 of zero and the reference solver used 3, 4 and 6 hook calls.

**T25. Dividends and coupons taxed in the year, bill interest a year later.** Taxable account 100,000 / 100,000 / 50,000 with basis equal to value, target 40/40/20, yields 1.3% and 4.2%, fixed returns 8% / 3% / 4%, no inflation, no spending, stub tax, two years. Year 1: the tax on the year's own dividends and coupons is raised from the account. `V' = 250,000 − W`; dividends `0.013 × 0.4 V'`, coupons `0.042 × 0.4 V'`, no gain; tax `(0.2 × 0.0168 + 0.1 × 0.0052) V' = 0.00388 V'`; `W = 0.00388 (250,000 − W)` → W = 966.25 = tax; dividends 1,294.98, coupons 4,183.77; after trades 99,613.50 / 99,613.50 / 49,806.75; end 107,582.58 / 102,601.90 / 51,799.02; basis 100,908.48 / 103,797.27 / 51,799.02; bill interest `0.04 × 49,806.75 = 1,992.27` is carried, untaxed in year 1. Year 2: ordinary income = 1,992.27 + coupons `0.0168 (261,983.50 − W)`; `Δ_S = 2,789.18 + 0.4 W` is sold at gain fraction `1 − 100,908.48/107,582.58 = 0.062037`; dividends `0.0052 (261,983.50 − W)`; tax `1,432.2532 − 0.0013985 W = W` → W = 1,430.25 = tax; gain 208.52, dividends 1,354.88, coupons 4,377.29; after trades 104,221.30 / 104,221.30 / 52,110.65; bill interest carried 2,084.43.

**T26. RMD first, surplus reinvested.** Age 75, pre-tax 500,000 / 500,000 (target 50/50), taxable 30,000 / 20,000 with basis 10,000 / 20,000 (target 60/40), spending 20,000, stub tax, stub RMD = balance / 25. RMD 40,000; tax 8,000; no further withdrawal; surplus 40,000 − 20,000 − 8,000 = 12,000 goes to the taxable account at 60/40: holdings 37,200 / 24,800, basis 17,200 / 24,800; pre-tax 480,000 / 480,000; no gain realized.

**T27. First death.** Persons born 1947 (fixed age 81) and 1950 (fixed age 80), `asOf = 2027-01-01`: `deathIdx = [1, 3]`, the plan ends in 2030. Person 0 owns a pre-tax account (300,000 bonds) and a nominal pension of 30,000 with `survivorShare = 0.5`. Three taxable accounts, all in stocks: joint 400,000 with basis 100,000; person 0's own 50,000 with basis 80,000 (a loss); person 1's own 60,000 with basis 20,000. Spending 30,000; no inflation, no returns, no tax; the stub order draws the joint account first. 2027 and 2028: `mfj`, income 30,000, no withdrawal. End of 2028: the pre-tax account and person 0's taxable account pass to person 1; joint basis `100,000 + 0.5 × 300,000 = 250,000`; the decedent's own account steps down to 50,000; the survivor's own account stays at 20,000. 2029: `single`, income 15,000, withdrawal 15,000 from the joint account, its basis `250,000 − 15,000 × 250/400 = 240,625`. 2030: single, basis 231,250, balance 370,000. With `jointBasisStepUp = 'full'` the joint basis becomes 400,000; with `'none'` it stays 100,000.

**T28. Failure and shortfall.** The worked case of §3.11: `success = false`, `failIdx = 1`, `shortfallReal = 92,000.00`, `endReal = 0`, spending series in today's dollars 40,000, 8,000, 10,000, 10,000.

**T29. Glide path.** The worked case of §3.2: 2027 → (0.8, 0.2, 0); 2034 → (0.68, 0.28, 0.04); 2045 → (0.5, 0.4, 0.1). With `target = null` the weights equal the starting mix in every year.

**T30. Income streams.** Salary 100,000, real growth 1%, inflation 3%: year 2 = 108,222.41. Nominal pension 24,000 with rate 0 stays 24,000; a real pension with rate 0 is 24,000 × cpi[t]. `taxableShare = 0.6` on an annuity of 10,000 gives 6,000 ordinary and 10,000 cash.

**T31. Accumulation phase.** Born 1981, retires 2028, pre-tax account 100,000 all stocks, salary 150,000 (real +1%) for 2026–2027, employee pre-tax 23,000 and employer 7,500 (both real), fixed stocks +10%, inflation 3%, stub tax, spending strategy asking for 110,000. `asOf = 2026-01-01`: 2026 deposit 30,500 → 130,500 → end 143,550.00; tax 0.2 × (150,000 − 23,000) = 25,400 is reported, equals the baseline and is not drawn; no withdrawal; `need = 0`. 2027: wages 150,000 × 1.03 × 1.01 = 156,045; deposit 31,415 → 174,965 → end 192,461.50; tax 26,471. With `asOf = 2026-11-10`: 2026 wages 21,369.86, deposit 30,500 × 52/365 = 4,345.21 → 104,345.21 → end 105,771.71, tax reported 3,618.63 (52/365 of 25,400); 2027: `cpi` 1.004220, wages 152,139.33, deposit 30,628.71, after flows 136,400.42, end 150,040.47, tax 25,808.45.

**T32. Scheduled conversion.** Pre-tax 300,000 / 200,000 (60/40), Roth 100,000, cash 80,000, conversion of 50,000 in the first year, spending 30,000, stub tax: tax 10,000; cash withdrawal 40,000; after trades pre-tax 270,000 / 180,000, Roth 150,000, cash 40,000; `conversions` = 50,000 in the year row. The same with `asOf = 2028-07-02` (f0 = 0.5) and a stub tax of 10% of ordinary income up to 50,000 and 30% above: the conversion is still 50,000 (not scaled), `need = 15,000`; annualized ordinary income 100,000, `T = 5,000 + 15,000 = 20,000`, tax `0.5 × 20,000 = 10,000` (a full-year return holding only this conversion would owe 5,000: the stated overstatement, warning `first_year_lump`); cash withdrawal 25,000; cash after 55,000.

**T33. Partial-year lumps.** `asOf = 2028-07-02` (f0 = 0.5): an exempt pension of 60,000 a year pays 30,000; spending 40,000 a year plus a goal of 15,000 dated 2028 gives `need = 20,000 + 15,000 = 35,000` and `floorNeed = 35,000`; pre-tax 500,000 bonds with stub RMD = balance / 25: RMD `20,000 × 0.5 = 10,000`; cash account 100,000; no tax: no withdrawal, surplus 5,000 to the cash account (105,000), pre-tax 490,000. Without the pension and with the stub tax: tax `0.5 × 0.2 × 20,000 = 2,000`; cash withdrawal `35,000 + 2,000 − 10,000 = 27,000`; cash after 73,000.

**T34. The whole year W1** of §3.10: RMD 16,260.16; withdrawal 29,267.56; tax 7,527.72; gain 20,177.20; dividends 4,236.59; coupons 5,648.79; after trades 282,439.46 / 141,219.73 / 47,073.24; end total 1,019,977.21; today's dollars 980,747.31; basis 166,853.25 / 136,868.52 / 48,485.44; carried bill interest 1,412.20; reference solver 4 hook calls. `flows_only`: withdrawal 28,416.80; tax 6,676.96; gain 12,055.61; dividends 4,523.75; coupons 5,200.00; end total 1,022,305.75; basis 178,162.56 / 125,200.00 / 41,200.00.

**Aggregation and harness**

**T35. Percentile index.** `percentileIndex(pBp, n)`: (1000, 10000) → 999; (5000, 10000) → 4999; (9000, 10000) → 8999; (1000, 98) → 9; (5000, 98) → 48; (9000, 98) → 88; (0, 98) → 0; (10000, 98) → 97; (1000, 69) → 6; (5000, 69) → 34; (1000, 7) → 0; (5000, 7) → 3; (9000, 7) → 6; (2500, 10094) → 2523.

**T36. Ranking and percentile paths.** Seven paths, `endReal` = [500, 0, 120, 0, 900, 300, 0], `failIdx` = [−1, 12, −1, 7, −1, −1, 20] → order [3, 1, 6, 2, 5, 0, 4]; the 10th, 50th and 90th percentile paths are 3, 2 and 4, with ending wealth 0, 120 and 900. Ten paths, `endReal` = [500000, 0, 250000, 0, 1200000, 250000, 0, 90000, 2000000, 700000], `failIdx` = [−1, 22, −1, 17, −1, −1, 22, 9, −1, −1], `shortfallReal` = [0, 50000, 0, 120000, 0, 0, 80000, 3000, 0, 0] → order [3, 6, 1, 7, 2, 5, 0, 9, 4, 8]: among the depleted paths the earliest failure (path 3) is worst and, of the two that failed in year 22, the larger shortfall (path 6) is worse; path 7 broke its floor in year 9 but ended with 90,000 and ranks by that wealth; paths 2 and 5 tie and keep index order. Percentile paths: p1 → 3, p10 → 3, p25 → 1, p50 → 2, p75 → 9, p90 → 4, p99 → 8; `[0]` = 3, `[100]` = 8; in every case `endingWealthRealQuantiles[p]` is that path's `endReal`.

**T37. Wilson interval.** 8,700 of 10,000 → [0.863266, 0.876450]; 9,865 of 10,000 → [0.984044, 0.988582]; 9,257 of 10,000 → [0.920395, 0.930678]; 30 of 100 → [0.218949, 0.395849]; 10,000 of 10,000 → [0.999616, 1]; 0 of 50 → [0, 0.071348].

**T38. Fan chart with deaths.** Four paths over four years, `NaN` after a path's end: `[100, 110, 120, 130]`, `[90, 80, NaN, NaN]`, `[100, 100, 100, NaN]`, `[50, 40, 30, 20]`. Alive counts 4, 4, 3, 2; p10 / p25 / p50 / p75 / p90: year 0 → 50 / 50 / 90 / 100 / 100; year 1 → 40 / 40 / 80 / 100 / 110; year 2 → 30 / 30 / 100 / 120 / 120; year 3 → 20 / 20 / 20 / 130 / 130.

**T39. Cents boundary.** `centsToDollars("100000000") = 1000000`; `dollarsToCents(0.125) = "13"`; `dollarsToCents(−0.125) = "-13"`; `dollarsToCents(891635.328) = "89163533"`; `dollarsToCents(−0.004) = "0"`; `dollarsToCents(585613.59) = "58561359"`.

**T40. Digest.** FNV-1a of the bytes of float64 `[1, 2.5]` in little-endian order (`00 00 00 00 00 00 f0 3f 00 00 00 00 00 00 04 40`) = `5dd3b45c`; `digest([1, 2.5], [−1, 3])` (those bytes followed by `ff ff 03 00`) = `a28ee979`; the empty input gives `811c9dc5`.

**T41. Golden runs; chunk and thread invariance.** The T20 household (fixed age 94, $40,000 real from $1,000,000 at 60/40, no tax, `asOf = 2027-01-01`):

| Model | Paths | `successCount` | Other pinned values |
| --- | --- | --- | --- |
| bootstrap, mean block 10 | 2,000 | 1,848 | Wilson [0.911556, 0.934818]; ending wealth p10 / median / p90 = 92,319.12 / 1,612,693.34 / 4,666,633.54; path 0 `endReal` = 1599167.000970203 (bits `413866bf003f954e`); digest `c2b4dbe3` |
| bootstrap, mean block 5 | 2,000 | 1,857 | digest `cae5b0c5` |
| parametric, preset `historical` | 2,000 | 1,766 | path 0 `endReal` = 670698.7676922221; digest `4db78afd` |
| parametric, preset `historical` | 10,000 | 8,753 | Wilson [0.868680, 0.881632]; median 1,506,275.14; p10 0; digest `dd3a637f` |
| parametric, preset `conservative` | 10,000 | 6,858 | median 381,115.41; digest `5b7fc1d7` |
| historical, complete | 69 | 65 | digest `6b3b946c` |

The counts are the portable assertions. The bit pattern and the digests come from the reference prototype; if the real implementation orders a floating-point sum differently they may differ in the last bit and are then re-pinned once from the implementation, with the counts unchanged (a judge's independent loop reproduced the earlier count with a different last digit in path 0). After that they change only with `ENGINE_VERSION` or `DATA_VERSION`. For the first row the run summary is identical bit for bit when produced (a) inline in one chunk, (b) in chunks of 250 forward, (c) in chunks of 7 in reverse order, (d) through a pool with 1, 2 and 3 threads, (e) with `threads = 0`.

**T42. Common random numbers.** For the bootstrap and the parametric model, the `growth` and `priceFactor` arrays of path 123 (first 40 years) are unchanged when the spending input, a retirement year, the withdrawal order or the mortality kind changes.

**T43. Detail equals the fast path.** For 200 seeded path indices of the first T41 run, the last row of `simulatePathDetail` has `endTotalReal = dollarsToCents(endReal[k])` and the row count is `endIdx[k] + 1`; with the historical model `cohortStartYear = 1928 + (k mod C)`; for every percentile p, the detail of `percentilePathIndex[p]` ends at `endingWealthRealQuantiles[p]`.

**T44. Harness behaviour.** 1,000 paths in four chunks on two threads: `onProgress` reports 250, 500, 750, 1000. Aborting the signal after the first chunk rejects with `SimulationCancelledError('cancelled')` and leaves no live worker; the pool then runs again. `maxRunMs = 1` rejects with code `timeout`. A stub hook that violates the withdrawal contract in a worker rejects with `EngineInvariantError` (`permanent = true`), not `SimulationWorkerError`; a worker that exits rejects with `SimulationWorkerError`. An invalid input rejects with `EngineInputError` before any worker starts. The dev entry (`thread.boot.mjs`) is what these tests run, so they also prove that a worker can import the package's `.ts` sources with `.js` specifiers.

**T45. Contract guards and invariants.** A withdrawal hook that returns `w` above `available`, leaves `net < −CASH_TOL` while money remains, or calls `assess` a 25th time raises `EngineInvariantError`. A hook that stops early with a positive `net` yields the warning `grossup_not_converged` and the surplus is deposited. A property test over 300 seeded random households (stub hooks) asserts for every path-year: no negative balance and no NaN; basis ≥ 0; in drawdown years sources equal uses within 0.01 (`cash income + rmd + w = funded spending + tax + employee contributions + surplus`); `Σ end balances = Σ after-trade balances × factors`; `totalReal = totalNominal / cpi[t+1]`; `cola` never falls; success implies zero shortfall; under `flows_only` the amount sold never exceeds the net outflow.

**T46. Determinism scan and self-test.** The source scan of §3.14 passes on the package and fails on a fixture string containing `Math.exp(` and on one containing `**`. `selfTest()` passes; with `detExp` replaced by `Math.exp` in a test double it throws `self_test_failed` (the two differ at `detExp(1)`).

**T47. Performance guard.** 500 paths × 60 years of the reference workload inline under 5 s. With `PERF=1`: the budget rows of §3.15, including zero `gc` entries over 2,000 paths after a 300-path warm-up.

## 8. Deviations from the spec and deliberate simplifications

1. **Three simulated assets for six asset classes.** International stock, real estate and "other" earn US stock returns by default. Effect: no international diversification, and US-history optimism for international holdings; flagged by warnings; the map is editable.
2. **A fourth model, `fixed`.** Added for tests and reference scenarios; not offered as a planning model unless the UI chooses to.
3. **Start-of-year cash flows.** Spending and withdrawals leave a year earlier than money spent through the year (conservative in drawdown, by roughly half a year's return on one year's spending: at 4% withdrawals and a 6% return, about 0.12% of the portfolio a year); contributions arrive early (optimistic in accumulation, by roughly half a year's return on one year's contributions).
4. **Partial first year.** Recurring amounts are prorated, the year-0 return has the right mean and variance for a part-year but is not the year's actual year-to-date return, and tax is annualized. A lump dated in the partial year (a conversion, a one-off goal and the withdrawals that fund it) is paid in full but taxed as if it recurred at that pace, which overstates its tax (T32: 10,000 where a full-year view gives 5,000); warning `first_year_lump`. The year-0 RMD is the annual amount times `f0` on today's balance. All confined to year 0.
5. **Accumulation is contributions-only.** Base spending, take-home pay and payroll taxes are not modelled before the first retirement; taxes are computed and reported for those years but only the tax caused by portfolio distributions is paid from the portfolio. Effect: the plan cannot show a pre-retirement shortfall, and taxes on dividends and on conversions scheduled before retirement are assumed paid from salary.
6. **Bill and cash interest is taxed one year late; none is carried into year 0; the last year's is never taxed.** Dividends and coupons on a surplus deposited during the year are not taxed that year. Effect: a one-year timing shift of a small tax.
7. **Constant yield assumptions** for dividends and bond coupons in taxable accounts, all dividends qualified, all gains long-term, average cost per account and asset rather than lots. Effect: tax drag is approximate; with historical returns the 1930s–1950s dividend yields (4–7%) and the coupons of high-rate decades are not reproduced; lifetime realized gain is conserved, only its timing differs from lot-level accounting.
8. **Full rebalancing of taxable accounts by default.** A tax-aware investor would rebalance inside tax-advantaged accounts; the default realizes gains earlier (conservative). `flows_only` is offered; under it a taxable account can drift from its target after long rallies.
9. **Rebalancing is per account, never across accounts,** so a household-level target is met only if each account's target is set accordingly.
10. **Bills in the parametric presets are independent draws.** Real bill returns are highly persistent (lag-1 autocorrelation 0.92 in the data) and never negative; multi-year dispersion of cash returns is understated and small negative years occur. `bills.persistence` is available in custom parameters; the bootstrap keeps the persistence within blocks.
11. **Inflation is AR(1) in the parametric model,** an extension of the spec's "correlated lognormal"; `persistence = 0` restores the plain model.
12. **Wrap-around cohorts** join 2025 to 1928, a sequence that never happened; used when fewer than 30 complete cohorts exist, with mortality draws, or on request, and always reported.
13. **The historical model ignores `pathCount`** with fixed life expectancy and rounds it up to a multiple of the cohort count with mortality draws (10,094 for 10,000); the spec's "10,000 paths by default" applies to the two random models.
14. **Period mortality without improvement; birthdays spread over the year; deaths at year end.** Effect: lifespans are somewhat short for healthy planners (`qScale` and fixed ages are available); the year of death is fully funded. Until the SSA table is installed the life table is the IRS 2010 unisex table: no difference between the sexes and mortality of 2010.
15. **Spousal rollover of every tax-advantaged account and a basis reset by ownership** at the first death; no estate tax, no inherited-account rules, no reset at the second death (the plan has ended).
16. **Bank cash earns the T-bill return;** most deposit accounts earn less.
17. **The fan chart is conditional on the household being alive** under table mortality, and portfolio values are balances at face value (pre-tax accounts are not reduced for the tax due on them).
18. **Contribution limits, the first-RMD April 1 deferral, the still-working exception and qualified charitable distributions are not modelled** by the loop.
19. **`successCi95` covers sampling noise only** and is absent for the historical model.
20. **Percentiles are nearest-rank, not interpolated.** For an even number of paths the median is the lower of the two middle values; with 10,000 paths the difference from an interpolated percentile is negligible, with 69 cohorts it is one cohort's spacing.
21. **The cost-of-living index is annual.** It follows the simulated calendar-year inflation rather than the third-quarter CPI-W, and a pension with a cost-of-living clause (`growth.kind = 'real'`) follows `cpi`, which can fall.
22. **Own `exp` and `log`.** They differ from `Math.exp` / `Math.log` by at most 2 units in the last place.
23. **Unpaid tax is dropped** in a year in which tax exceeds all available cash (the path has already failed).
24. **US record only, 1928–2025.** The survivorship of the US market is built into the historical and bootstrap models; the conservative preset exists for that reason, and its means are a judgement (§10).

## 9. Seams: what this area assumes from the others

**inputs-and-data**
- Builds a valid `EngineInput` (`asOf` from `resolveToday`) and stores it whole with the seed, `ENGINE_VERSION`, `DATA_VERSION`, `DATA_CHECKSUM` and the result's `digest` on `sim_run`; stores the `EngineResult` JSON and the `details` map. Recommended: also store `raw.endReal` and `raw.failIdx` (about 100 KB for 10,000 paths, 60 KB with `endReal` as float32) so Phase 5 can compare scenarios path by path without rerunning.
- Chooses the seed: a decimal string of an unsigned 64-bit integer, fixed per scenario by default so an unchanged scenario gives unchanged numbers.
- Sends only liquid, investable accounts. A taxable account always carries a basis by asset class (from the lots where known, otherwise a stated assumption the user can see); every account carries holdings by asset class (balance-only accounts get an assumed mix) and its weighted expense ratio in ppm; joint versus individual ownership is resolved; bank accounts (tax treatment `none`) arrive as treatment `cash`; Roth contribution basis and recent conversions are supplied or defaulted.
- Resolves "until retirement" and ages into calendar years, and derives contributions from the measured flows (`loadExternalFlows`) and the budget.
- Owns the job, progress storage, the cancellation flag and `SIM_THREADS`; maps `EngineInputError.code` to `PlanError(400, …)`.
- Supplies `sex` (and optionally `qScale`) when table mortality is chosen.

**tax-rmd-ss** (modules inside `packages/retirement`, pure, allocation-free, none of the banned `Math` functions)
- `publishedCola(year)`: the Social Security adjustment effective January of `year` from their data file, NaN when not published (for example 2027 → the adjustment announced in October 2026).
- `resolveTaxYear(view, out)`: parameters for `view.year` under `input.tax.lawScenario`; published years as published; later years indexed by `view.cpi / view.cpiSeries[lastPublishedYear − startYear]`. The function never sees `f0`: the loop annualizes.
- `federalTax(input, params, out)` with at least these `TaxInput` fields, all full-year nominal dollars: `filingStatus`, `ages`, `alive`, `wages[P]` (after pre-tax deferrals), `pensionAnnuity`, `rentalNet`, `otherOrdinary`, `taxableInterest`, `qualifiedDividends`, `longTermGains` (may be negative), `capitalLossCarryIn`, `socialSecurityGross`, `preTaxDistributions[P]`, `rothConversions[P]`, `rothTaxableEarnings[P]`, `rothEarlyConversionPrincipal[P]`, `hsaNonQualified[P]`; and `TaxResult` with `total` (income tax + net investment income tax + penalties), `incomeTax`, `niit`, `penalties`, `taxableSocialSecurity`, `agi`, `magi`, `capitalLossCarryOut`. The function must be non-decreasing in every distribution field with a marginal rate below 1; the gross-up's uniqueness rests on it.
- `rmd(view, out)`: for each pre-tax account, the prior-year-end balance (`view.balance[a]`) over the divisor for the owner's age and birth year; 0 before the start age and for other accounts.
- `socialSecurity(view, out)`: full-year benefit per person from the FRA benefit, claiming ages and spousal and survivor rules, already multiplied by `view.colaIndex`.
- `splitRothWithdrawal(q, rothState, offset, out)`: the ordering rules over the Roth state layout of §2.4 (contributions, then conversions oldest first, then earnings), reporting how much came from each layer so the loop can reduce the state.
- Question for them: payroll tax on wages. Without it, a working spouse's or part-timer's take-home pay in drawdown years is overstated by about 7.65% of wages.

**strategies-outputs-web**
- `decideSpending(view, strategyState, out)`: the five strategies, phase multipliers, healthcare, and one-off goals as `lump` (never part of `spend`); `floor` and `lumpFloor` define failure; state lives in the 16 floats; `view.guaranteedIncome` is available for floor-and-ceiling.
- `planWithdrawals(view, assess, w)`: the default order after RMDs and the gross-up, within the contract of §3.9 (tolerance 0.005, at most 24 `assess` calls, graceful non-convergence). v2's order optimizer replaces this one function.
- Maps `EngineResult` and `PathDetail` to wire shapes, pages, the fan charts and the dashboard card.
- Owns the gate's reference scenarios. Guidance: use `historical` with `cohorts: 'complete'`, `asOf` on January 1 (f = 1) and a fixed life expectancy, so the run lines up with calculators that follow full historical cycles and withdraw at the start of the year; T20 (65 of 69 cohorts at 4% over 30 years with 60/40) and the `fixed` model are ready-made building blocks.

**What this area gives all three:** `YearView` (no look-ahead), the price and cost-of-living indexes, the Roth and carry state, `assess` with the trade preview and the annualization inside it, the hook-injection seam for tests, and `EngineInvariantError` when a contract is broken.

## 10. Sources

Fetched from the primary source during the merge (2026-11-10):
- Damodaran, historical returns workbook, both formats, and page: `https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls`, `https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xlsx`, `https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html` (all series values, definitions, summary rows, the 2025 dividend yield 1.34% and 10-year yields 4.12% / 4.18% behind the default yields).
- IRS Table 2010CM: `https://www.irs.gov/pub/irs-tege/table-2010cm-final.xlsx` (the fallback life table).

Fetched by the designers and re-checked by the judges (the generator, the normal quantile and the bootstrap sampler are also exercised by the merged prototype):
- Random123 known-answer vectors and header (rotation constants, parity constant, 20 rounds): `https://raw.githubusercontent.com/DEShawResearch/random123/main/tests/kat_vectors`, `https://raw.githubusercontent.com/DEShawResearch/random123/main/include/Random123/threefry.h`; Salmon, Moraes, Dror and Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC11, `https://www.thesalmons.org/john/random123`.
- AS241 coefficients: CPython `statistics.py`, `https://raw.githubusercontent.com/python/cpython/main/Lib/statistics.py`, and R's `qnorm.c`, `https://github.com/wch/r-source/blob/trunk/src/nmath/qnorm.c`; Wichura, "Algorithm AS 241: The Percentage Points of the Normal Distribution", Applied Statistics 37(3), 1988, 477–484.
- cFIREsim open-source code (withdrawal at the beginning of the year; complete cycles only): `https://raw.githubusercontent.com/boknows/cFIREsim-open/master/js/cFIREsimOpen.js`.
- `arch` bootstrap sampler (new block with probability 1/mean block, else next index, circular): `https://raw.githubusercontent.com/bashtage/arch/main/arch/bootstrap/_samplers_python.py`; Politis and Romano, "The Stationary Bootstrap", JASA 89(428), 1994, 1303–1313.
- ECMAScript specification (`Math.sqrt` exact; `Math.exp` and others implementation-approximated): `https://tc39.es/ecma262/#sec-function-properties-of-the-math-object`; V8 `src/base/ieee754.cc` delegating to LLVM libc: `https://github.com/v8/v8/blob/main/src/base/ieee754.cc`.
- Node 22 documentation (`postMessage` transfer list, `worker.terminate()`, `os.availableParallelism()`): `https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/worker_threads.md`, `https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/os.md`.
- IRS Publication 590-B (RMD on the prior year-end balance and the age attained in the year): `https://www.irs.gov/pub/irs-pdf/p590b.pdf`.

Through web search during the merge (secondary):
- SSA period life table: `https://www.ssa.gov/oact/STATS/table4c6.html`, `https://www.ssa.gov/oact/STATS/table4c6_2022_TR2025.html`, `https://ustax.tools/life-expectancy-calculator/`.
- No negative cost-of-living adjustment, measured from the highest prior third-quarter average; zero adjustments in 2010, 2011 and 2016: Congressional Research Service 94-803, `https://www.everycrsreport.com/files/2026-05-27_94-803_762bfeccaf329e58861fb430cc0290720125f04e.html`.
- The adjustment for January 2027 (3.6%, announced 2026-10-14; the number belongs to the tax area's data file, this area only defines how it is applied): `https://foxbusiness.com/economy/social-security-announces-cost-of-living-adjustment-2027`, `https://goodmorningamerica.com/news/story/social-security-administration-cost-living-adjustment-rise-36-137234823`, `https://keepingupwithinflation.com/post/social-security-cola-2027-3-6-percent/`.
- Basis at death: IRC §2040(b) (half of a spousal joint interest is included in the decedent's estate), `https://www.law.cornell.edu/uscode/text/26/2040`; §1014(a) (basis becomes fair market value, up or down), `https://greenleaftrust.com/missives/joint-ownership-joint-trusts-and-basis-step-up/`, `https://www.cobar.org/Portals/COBAR/Repository/Sections/TE/newsletter/Step%20Up%20In%20Basis.pdf`.
- Ten-year outlooks behind the conservative preset: Vanguard 2026 outlook (US equities 4.0–5.0%, US bonds 3.8–4.8%), `https://corporate.vanguard.com/content/corporatesite/us/en/corp/who-we-are/pressroom/press-release-vanguard-releases-2026-economic-and-market-outlook-121025.html`, `https://www.fool.com/investing/2026/02/22/vanguard-says-international-stocks-could-beat-the/`; Schwab 2026 (US large cap 5.9%, aggregate bonds 4.8%), `https://www.advisorperspectives.com/commentaries/2026/01/05/2026-long-term-market-expectations`, `https://www.schwab.com/learn/story/schwabs-long-term-capital-market-expectations`.
- Trinity study (Cooley, Hubbard and Walz, AAII Journal, February 1998): `https://www.aaii.com/journal/article/will-your-savings-last-what-the-withdrawal-rate-studies-show`; Wilson interval: Brown, Cai and DasGupta (2001), `https://projecteuclid.org/download/pdf_1/euclid.ss/1009213286`.

**Unverified figures** (the implementer checks these against the primary source):
1. The SSA life-table check values at age 65 (2023 table, 2026 Trustees Report: male q 0.016455, l 79,084, e 18.12; female q 0.010188, l 87,399, e 20.66): returned by web search of the SSA page and by one third-party calculator, never read on `www.ssa.gov`, which this environment refuses and which has to be allowed. Which vintage the current page holds is unconfirmed for the same reason.
2. The 3.6% adjustment for January 2027: several secondary outlets, no SSA page reached. Owned by the tax area's data file.
3. The conservative preset's means (5.5%, 4.5%, 3.2%, 2.5%) are assumptions of this design. Of the outlooks they sit between, Schwab's cash (3.3%) and inflation (2.4%) figures and one alternative reading of Vanguard's equity range (3.5–5.5%) rest on a single source each; J.P. Morgan's figures were not retrieved and are not used.
4. The default mean block of 10 years is this design's choice; no published recommendation for annual retirement simulations was found.
5. The default yields 1.3% and 4.2% are rounded from one year (2025) of the workbook; they are assumptions, not estimates.
6. The performance figures come from prototypes with stub tax functions on one 4-vCPU machine; the budget of §3.15 has not been measured on the real engine.
7. AS241's stated accuracy ("about 1 part in 10^16") was not read in the paper; the routine was checked numerically against CPython and R.
8. The 2025 S&P 500 return: 17.72% in the workbook (used), 17.78% on the HTML page.
9. Whether `os.availableParallelism()` reflects a container CPU quota; `SIM_THREADS` exists for that reason.
10. FIRECalc's own statement of start-of-year withdrawals and the Trinity study's rebalancing convention (cFIREsim's source was read instead).
11. The description of Table 2010CM as the unisex 2010-census table of the section 7520 regulations is from the IRS actuarial-tables page as summarized by the lead; the values themselves were read from the workbook.

## 11. Open questions

1. **Who assembles the tax input (a challenge to the reading of L8).** L8 gives "the gross-up logic that calls the tax function" to strategies-outputs-web. Here the engine builds `assess` (tax input assembly, Roth split, HSA qualification, trade preview, annualization) and the strategies area owns the order and the solver that calls it. The alternative is to export the assembly as a function the strategies area calls before `federalTax` itself. The engine-side `assess` keeps one owner for the cash identity and keeps `f0` away from both other areas; the seam step should confirm it.
2. **Accumulation rule (decision 9).** Is "contributions only until the first retirement" acceptable, or should pre-retirement years run the full cash identity with spending from the budget? The first is robust to measurement gaps; the second can show a pre-retirement shortfall.
3. **Who evaluates income streams and contributions.** This design does it inside the loop from typed records; if inputs-and-data prefers to pre-expand them per year, the loop accepts year tables instead.
4. **Individual accounts or buckets.** The engine takes up to 32 accounts; inputs-and-data may aggregate by owner and treatment if per-account rows are not wanted in the year table.
5. **Default historical mode.** `auto` (complete cycles for fixed life expectancy when at least 30 exist, wrap otherwise) versus always wrap, which gives every calendar year equal weight but splices 2025 to 1928 and departs from the calculators the gate compares against.
6. **Mean block length** default (10 years; 5 keeps more variety, 10 keeps whole market cycles and inflation regimes together) and whether to expose it at all.
7. **Conservative preset values,** and whether its volatilities should also differ from history.
8. **Mortality table.** `www.ssa.gov` must be allowed, or the owner must supply the table file, before sex-specific draws are possible; which vintage to pin; whether the SSA cohort tables (with projected improvement) should replace the period table; whether `qScale` should default below 1 for a healthier-than-average household.
9. **Taxable rebalancing default:** `full` (matches the cited studies, taxed in the same year) or `flows_only` (what a tax-aware household does).
10. **Payroll tax** on wages in drawdown years (a tax-area decision that changes the cash identity).
11. **Mid-year flows.** Applying half the year's growth before the flows and half after is a small change to steps 6 and 7 if the owner prefers it to the start-of-year convention; it would no longer match FIRECalc-style calculators.
12. **Partial-year lumps.** Annualization overstates the tax on a conversion or goal dated in the rest of the current year. Taxing lumps at the margin on top of the annualized recurring income (`T(A + L) − (1 − f0) T(A)`) is more accurate, but it makes net cash non-monotone in withdrawals when the lump crosses a bracket, which breaks the gross-up's uniqueness; it was therefore not adopted. Should the UI forbid lumps dated in the current partial year, or is the warning enough?
13. **Thread default** once the server's core count is known; and whether a run should be allowed to use every core.
14. **Stored detail paths.** Keeping year tables for the seven default percentiles in `sim_run` makes them survive an engine upgrade; any other percentile needs matching versions or a re-run.
15. **Joint basis reset** default for a household in a common-law state (`half`) versus community property (`full`).
16. **Bill persistence in the `historical` preset:** 0 (the spec's plain lognormal, current default) or the estimated 0.92.
17. **Seed type.** A 64-bit decimal string is the engine's contract; if inputs-and-data stores a 32-bit integer the engine works unchanged (the upper key word is 0), but the two designs must agree on the wire type.
18. **International stocks and real estate.** Accept the mapping onto US stocks for v1, or add a fourth simulated series in the parametric model only?
19. **The spec's open question on the engine's language.** Answered by measurement: TypeScript runs 10,000 paths over 60 years in a few seconds on one thread and around a second on three, so there is no case for Rust or Python in Phase 4.

## 12. Judging record

**Scores** (correctness / spec fidelity / codebase fit / testability, out of 10):

| | Design A (fidelity-first) | Design B (performance-first) |
| --- | --- | --- |
| Judge 1 | 8 / 8.5 / 7 / 9 | 7.5 / 7.5 / 7.5 / 7 |
| Judge 2 | 8 / 8 / 7 / 9 | 7 / 7 / 7 / 8 |

Both judges chose A. Both re-worked every hand-calculated case of both designs and found the arithmetic right; the decision rested on tax-law state, spec fidelity and testability (A), against harness wiring and speed (B).

**Kept from A (the base):** the package layout and the core/`node` split; per-account state with five treatments including `cash`; per-asset average-cost basis and trade-level gains; `planTrades` (withdraw and rebalance in one trade list, `full` and `flows_only`); the engine-built `assess` with the trade preview; the two phases with forced flows and one-off goals before retirement; annualization for the partial year, so the tax function never sees `f0`; the Roth state with five conversion layers; the MAGI history; typed income, contribution and conversion records with `taxableShare` and `survivorShare`; `asOf` as the only date input; rolling cohorts with `auto` mode and stratified replicates; the estimator of the `historical` preset with AR(1) inflation; the `fixed` model and hook injection (`prepare(input, hooks)`), which let every loop case run through the public API; `returnShift`; `detExp` / `detLog` and their golden bit patterns; float64 result matrices; transfer-based chunks of 250; the Wilson interval; the warnings; most of the test suite (T1, T4–T8, T19–T21, T23, T24, T26–T32, T37, T39, T45).

**Taken from B:** the dev/test thread entry (a bootstrap `.mjs` that registers tsx, then imports `thread.ts`) and `SIM_THREADS = 0` as an inline mode; the 64-bit seed and the counter layout (key = seed, counter = path and packed purpose/step/slot) with uniform-based bootstrap decisions; `annual × f + lump` for the spending need, with lumps never scaled; same-year taxation of dividends and coupons; the cost-of-living index as a running maximum of the price index, extended here with published adjustments; the `√f` year-0 return rule; the calendar-year death probability as the mean of two adjacent ages and `qScale`; the basis reset by ownership, in both directions; out-record hooks with no returned doubles, the false-position gross-up with a 24-call limit, the zero-GC budget and a much tighter time budget; the per-year real spending matrix and spending fan; nearest-rank percentiles and a percentile path ranked by ending wealth, so the year table ends at the headline number; the start-up self-test and the FNV-1a digest; raw per-path `endReal` and `failIdx` for Phase 5; optional bill persistence; the warning against the "Nominal vs Real Data" sheet; the common-random-numbers, detail-equals-fast-path and lint-fixture tests; the reference-scenario guidance and plain-sentence error messages; the whole-year worked example (re-worked under the final rules as W1).

**Flaws the judges named, and where they are resolved:** the failing `.ts` worker entry (§3.13, reproduced during the merge); unguarded divisions in `planTrades` (§3.8, T23); the partial-year lump contradiction (decision 7, §3.7 step 3, T32, T33); the one-year lag on dividend and coupon tax and the wrong "cleared by `assess`" wording (decision 11, §3.9, T25); the loose budget and 60-call bisection (§3.9, §3.15); the percentile path not ending at the reported percentile (decision 26, §3.12, T36, T43); table mortality disabled without the SSA file (decision 18, §2.8: the IRS 2010CM table as labelled fallback, not a fitted curve); January-1 birthdays (§3.6); negative cost-of-living adjustments and the missing 2027 adjustment (§3.1, T16); understated touch points (§6: both Dockerfiles, the ESLint block); a deterministic invariant error retried as a worker error (§3.13 item 9, T44); the non-portable golden bit pattern (T41); `growth^f` volatility in year 0 (decision 7, §3.5, T9, T15, T22); the single household-wide step-up without step-down (decision 28, T27); complete cohorts judged against age 119 under table mortality (decision 14, T12); only a lifetime spending total (decision 25); `P = 0` in `flows_only` (§3.8).

**Wrong or doubtful figures the judges named:** `invNorm(0.075)` was labelled a tail-branch case; it is the central branch (`0.075 − 0.5 = −0.425` exactly, re-checked), and T4 now uses 0.07 for the tail. The historical preset's Cholesky factor is reprinted from the unrounded moments (0.001661, 0.000487, 0.005532, re-computed). The conservative preset's log volatilities are reprinted from the unrounded data volatilities (0.179523, 0.037961). B's eight-decimal factor, reproducible only from three-digit correlations, and B's Gompertz fallback are not carried over. The claim that a `.ts` worker "was run and returned transferred arrays" is withdrawn.

**Where a judge is overruled, and why:**
1. *Yields "on start-of-year balances"* (both judges' graft wording). Same-year taxation is adopted, but on post-trade balances: with per-asset basis the amount taxed and the amount added to basis must be the same number, and a holding sold in January earns no dividend; judge 2's own flaw note describes the yields as known from the post-trade balance at the start of the year.
2. *An always-on GC-count test* (judge 2). It runs in the bench process and under `PERF=1` only, for the reason judge 1 gave: Vitest's own allocations in the same isolate would fail it.
3. *A warm pool with an idle timeout* (judge 2). The pool is owned by the caller for one job and has no timer: judge 1 counted the persistent pool as needless machinery for 10,000 paths, and a job-scoped pool gives Phase 5 grids the same saving.
4. *"`growth^f` can stay for the historical model"* (judge 2, permissive). The `√f` rule is applied to the historical model too, so there is one year-0 rule for every model with dispersion; plain compounding remains only for the `fixed` model, where it is the same rule with no dispersion.

The seam risk judge 1 raised (the engine building `assess` although L8 gives the gross-up to the strategies area) is kept as designed in A and put to the lead as open question 1.
