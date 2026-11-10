# Phase 4 design: Withdrawal strategies, outputs, web and the gate

Area (lead decision L8): the five spending strategies, the default withdrawal order and the gross-up that calls the tax function, the result shapes shown to the user, the Retirement web pages, the dashboard card component and the Phase 4 gate with its reference scenarios.

This is the merged area design. Design A (literature-first) is the base, as both judges chose; the grafts they asked for from Design B (owner-first) are folded in, and every flaw and wrong figure they named is resolved in the text. Section 12 is the judging record, including the places where a judge is overruled and why. The document is self-contained: build from it without the originals.

**How this design fits the other areas.** Two merged area designs existed when this one was written: `docs/design/phase-4/engine-and-returns.md` ("the engine design") and `docs/design/phase-4/inputs-and-data.md` ("the inputs design"). Both source designs of this area had assumed their own engine seams (A's `Buckets` and `resolveYear`, B's `settleYear`) and their own routes and storage. Those are replaced here by what the two merged designs fixed: the engine's two hooks `decideSpending` and `planWithdrawals`, its `assess` function, its aggregation and its `PathDetail`; the inputs design's routes, `sim_run` storage, frozen input and dashboard contract. Where this area needs something those designs do not yet offer, section 9 states it as a numbered, minimal request. The tax area's merged design did not exist yet; what is assumed of it is in section 9.

**How the numbers were produced.** Every figure in sections 3 and 7 was recomputed during the merge with a scratch reference of exactly the final rules (Python, nothing in the repository was modified), in `/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/mergeS/`: `tax.py` (federal tax), `strat.py` (the five strategies), `sim.py` (one deterministic path under the engine design's year loop with this area's hooks), `wd.py`, `sweep.py`, `r1.py`, `r1b_final.py`, `r2.py`, `r3.py`. The reference loop reproduces the engine design's worked year W1 to the cent (withdrawal 29,267.56, tax 7,527.72, end total 1,019,977.21), and its historical run reproduces the engine design's T20 (65 of 69 at 60/40, the same failing years and percentiles).

**State of the research.** The tax figures were checked against local copies of the primary documents fetched earlier in this session: Rev. Proc. 2025-32 and Rev. Proc. 2026-35 (checksums in section 10) and IRS Publication 590-B. The historical series is the engine design's pinned file. No new web search was possible during the merge (the session's search budget was used up) and `www.financialplanningassociation.org` does not resolve from this environment, so the strategy literature rests on the designers' and the judges' recorded searches; section 10 lists what remains unverified.

Files this area adds:

```
packages/shared/src/retirement/strategy.ts      StrategyConfig, WithdrawalOrderConfig, defaults, STRATEGY_INFO (card texts)
packages/shared/src/retirement/results.ts       SimSummary, FanSeries, YearTable, YearRow, deflateYearRow, addUp, pathStory, fundedShareBp
packages/retirement/src/strategies/             prepare.ts, planned.ts, decide.ts, guardrails.ts, vpw.ts, floorCeiling.ts
packages/retirement/src/withdrawals/            tiers.ts, solve.ts, plan.ts
packages/retirement/src/results/                summary.ts, fan.ts, yearTable.ts
packages/retirement/reference/                  independent.ts, sheets.md, fixtures/, reference.test.ts
packages/retirement/src/gate.test.ts
apps/api/src/retirementGate.test.ts
apps/web/src/pages/retirement/                  RetirementLayout, ResultsPage, ProfilePage, ScenariosPage, ScenarioEditorPage, RunsPage (+ css)
apps/web/src/components/retirement/             queries.ts and the components named in section 5
apps/web/src/components/charts/retirementOptions.ts (+ test)
apps/web/src/components/dashboard/RetirementCard.tsx
apps/web/src/lib/retirement.ts (+ test)         successTone, changeLabel, describeAssumptions, fanMarkers, strategyHints, yearTableCsv
```

Files this area touches: `apps/web/src/App.tsx` (routes), `apps/web/src/components/Layout.tsx` (nav entry "Retirement" after "Investments"), `apps/web/src/pages/DashboardPage.tsx` (the card), `apps/web/src/components/dashboard/dashboard.ts` (text helpers). No table, migration, route or job is added by this area.

## 1. Decisions (binding)

1. **This area is two engine hooks, three mappers and the web.** `decideSpending(view, strategyState, out)` and `planWithdrawals(view, decision, assess, w)` plug into the engine design's year loop (its §3.7 and §4.3); `toSimSummary`, `toFanSeries` and `toYearTable` turn the engine's `EngineResult` and `PathDetail` into the stored shapes. This area never computes a tax, a realized gain, a Roth layer or a return: the engine's `assess(w)` does, with the tax area's functions. Reason: L8 as the engine design reads it; one owner for the cash identity.
2. **Strategies return full-year nominal amounts; the loop multiplies recurring amounts by the year fraction `f` and never scales a dated lump.** The partial first year is therefore the engine design's rule (its decision 7), and the fraction appears in this area only where a hook must agree with the loop: the HSA tier's cap (§3.5) and what a rule still releases in a gross year (§3.6). Design A's own rule (start on the nearest January 1) is dropped: both merged designs prorate the first year, and L3 asks for one rule everywhere. Every hand case and reference scenario here starts on January 1 (`f = 1`).
3. **A drawdown year is either a target year or a gross year.** In a target year the strategy sets the household's after-tax spending and withdrawals are grossed up to deliver it. In a gross year the strategy sets the gross amount taken from the portfolio, as the published rule states it, and spending is what is left after tax, but never less than the floor. Reason: constant spending, guardrails and floor-and-ceiling act on spending; fixed-percentage and VPW are defined on the portfolio withdrawal and lose their defining property (the rule cannot empty the portfolio) if tax is added on top.
4. **Strategy kinds:** `constant_dollar` (target), `guardrails` (target), `floor_ceiling` (target), `fixed_percentage` (gross), `vpw` (gross). Reason: the spec's five, each in the form its source uses.
5. **Three household phases.** *Accumulation* (before the first retirement year): no spending is modelled; only dated goals and forced distributions touch the portfolio (the engine's rule). *Transition* (someone living is retired and someone living still works): the plan's spending is funded as under `constant_dollar` whatever the strategy, and wages above it are saved by the loop. *Retirement* (every living person is retired): the chosen strategy applies; path-dependent rules start in the first such year. Reason: a percentage rule applied while a spouse still earns would withdraw money only to add it to wages; graft from B.
6. **Strategies govern core spending only.** Healthcare, dated goals and long-term care are scheduled needs added on top and never cut by a rule. Reason: a roof or a Medicare premium is not discretionary, and a one-off must never trigger a permanent guardrail cut.
7. **Essentials are always funded: every year has a floor.** In a target year the floor is the year's whole target. In a gross year the floor is essential core spending plus healthcare plus long-term care; when the rule's withdrawal cannot pay it after tax, the withdrawal is topped up through the same order. Dated goals count toward the floor in every drawdown year. Reason: nobody skips rent because a rule said 3.1%, and it gives one failure definition for all five strategies; graft from B, asked for by both judges.
8. **Success = the floor was funded in every drawdown year through the year of the last death** (the engine design's decision 19, tolerance `CASH_TOL` = half a cent). A floor can go unfunded only when every account is empty, so failure always means "the money ran out". A failed path stays failed and keeps running on income alone. Design A's `belowFloor` trigger and both designs' $1 tolerances are dropped.
9. **One alternative rate is reported beside it: the full-plan rate,** the share of paths in which funded spending never fell below the plan's spending. Under `constant_dollar` it equals the success rate. A's `neverDepleted` rate is dropped (it now equals success) and B's reserve-intact rate is dropped (decision 12).
10. **Planned spending** of a year = base spending × phase multiplier × survivor share, plus healthcare, long-term care and goals, in today's dollars and then indexed by the path's price level; phases are keyed to calendar years (resolved by the inputs design from the anchor person's ages, so a death never moves a boundary); essential core is the same share of core every year (`essentialAnnualCents ÷ baseAnnualCents`).
11. **The spendable portfolio `P_t`** is the sum of all account balances at the start of the year (the engine's `portfolioStart`) minus the long-term care money still set aside, floored at 0. Every percentage rule uses it.
12. **The long-term care reserve is a set-aside that is spent on care in the last `lastYears` years of each named person's life** (the inputs design freezes `longTermCare[]` per person, default 2 years). Until care starts the reserve is excluded from `P_t`; in each care year `reserve ÷ k` (indexed) is a scheduled need. Reason: it makes "reserve" both an exclusion and a real cost without a care model. Judge 2 objected that this reads the path's death year; it is kept because judge 1 counted a reserve that never costs anything as a flaw, the inputs design already freezes it this way, and the death year is read by this one scheduled cost only, never by a strategy rule (§3.2).
13. **`constant_dollar` spends the plan.** The classic 4% rule is a profile whose base spending is 4% of the starting portfolio. A's `initial_rate` basis is dropped for this strategy and for guardrails: every strategy is anchored to the spending seeded from the budget (judge 2's objection to B), and one option fewer has to be tested.
14. **`fixed_percentage`:** gross withdrawal = `rate × P_t`, default 4%.
15. **`guardrails` are the Guyton and Klinger (2006) rules run on a reference withdrawal track,** and the track's cumulative adjustment scales the portfolio-funded part of the plan. Rules: the inflation raise is skipped after a losing year when the current rate is above the initial rate (never made up); a 10% cut when the rate is more than 20% above the initial rate, except in the final 15 planning years; a 10% raise when it is more than 20% below. No 6% inflation cap (dropped by the 2006 paper). Spending never falls below essential core. With no outside income, healthcare or phases this is the published rule to the cent; with them it is an adaptation and the UI says so. Reason: A's version tested a rate net of income but cut total spending, which both judges faulted (§3.4c shows the failing case and its fix).
16. **`vpw`:** percentage = `PMT(g, n, −1, 0, 1)` with `g = stockShare × 5.0% + (1 − stockShare) × 1.9%` real, `n = 100 − age of the younger living person`, capped at 10%. Reason: it reproduces the published table to the printed 0.1% from four parameters.
17. **`floor_ceiling`:** core spending = essential core + a percentage of the portfolio clamped to a band around the plan's discretionary spending. The percentage defaults to the plan's own (so the first year is the plan); the band defaults to 15% below and 20% above. With no essentials, income or phases it is Bengen's floor-and-ceiling rule. Reason: the spec's sentence for the essentials split, Bengen for the clamp, the plan as anchor (judge 1's objection to A's default). The band figures could not be confirmed against the paper; A's 25% and 10% are not used as defaults because the judges could not corroborate them (section 10).
18. **Default withdrawal order `default`** (L6), after the engine has taken RMDs and scheduled conversions: cash above the reserve → HSA for the year's healthcare → taxable → pre-tax of owners past 59½ → Roth that can leave without tax or penalty → the cash reserve → pre-tax of younger owners (10% additional tax) → the rest of younger owners' Roth → HSA beyond healthcare. Reason: taxable first and Roth last, with every penalty-free source used before any penalized one. v2's order optimizer replaces `planWithdrawals`.
19. **Within a tier, accounts are drawn pro rata to what each can still supply.** Reason: deterministic and neutral between spouses and accounts.
20. **A cash reserve** (`cashReserveCents`, today's dollars, indexed, default "0") is kept in the cash accounts until every other penalty-free source is used. It is not refilled: surplus goes to the engine's surplus account. Reason: graft from B that settles A's open question on a cash floor; no amount is assumed that the owner did not type.
21. **The gross-up is false position with the Illinois modification, bracketed, stopping at half a cent of net cash, within the engine's limit of 24 `assess` calls.** Reason: the engine design fixes the tolerance, the call limit and the behaviour on non-convergence, and names this method as its reference solver; one solver serves the stub and the real hook. A's clamped secant was measured slightly cheaper by judge 1 (3.2 against 4.3 evaluations) but its 45-evaluation worst case does not fit the limit.
22. **Surplus.** In a target year, cash beyond the target is saved by the loop. In a gross year only the part of the RMDs that exceeds the rule's withdrawal is saved; everything else the rule released is spent.
23. **Roth conversions** are the user-entered schedule (L6); the engine moves the money after the RMD; their tax is paid from the year's cash. In a gross year that tax reduces spending down to the floor.
24. **Percentiles are nearest-rank order statistics** (the engine design's decision 25). A's interpolated percentiles are dropped: aggregation is the engine area's, and a nearest-rank percentile is a value some path really had.
25. **A percentile path is a real path:** ranked by ending wealth in today's dollars (cents) ascending, then earlier failure year, then path index; percentile p is the path at the nearest rank (the inputs design's decision 22, confirmed here). The table's last row therefore ends at the reported percentile of ending wealth. Both source designs ranked failed paths first; with decision 8 a failed path ends with nothing unless later income rebuilt a balance, so the two orders differ only for such paths.
26. **Ending wealth** = all accounts at the end of the year of the last death, divided by the price level at that moment; pre-tax balances are not reduced for the tax due on them. Reason: the spec's wording; an after-tax figure belongs with v2's optimizers.
27. **Stored shapes carry no float:** cents as decimal strings, rates as integer basis points, price levels as the shortest decimal string that parses back to the same number, `schemaVersion: 1`. Money is nominal; one shared pure function gives the today's-dollars view.
28. **Tables add up, and they end at the headline.** Every total in a year row is the engine's own rounded total; when the rounded parts do not sum to it, the largest part absorbs the difference (a few cents at most). The today's-dollars view is derived the same way by `deflateYearRow`, and the row's ending total in today's dollars is the engine's own figure. Reason: an owner who adds a row by hand gets the printed total (B's rule), and the percentile table still ends at the reported percentile (the engine design's decision 26).
29. **The year table shows withdrawals and balances by account and by account type,** RMDs and conversions, income by source, spending planned and funded, taxes by component, and the strategy's events. Reason: the spec's "withdrawals by account".
30. **A year drawer answers "what was I taxed on" from the scalar lines of the tax result** (income lines, taxable Social Security, AGI, deduction, taxable income, ordinary and capital gains tax, net investment income tax, penalties). No bracket-by-bracket array and no marginal rate is asked of the tax function. Reason: judge 2 wanted the worksheet, judge 1 objected to per-bracket arrays in the hot loop; the scalar lines exist anyway.
31. **A short path story is computed in the browser from the year table:** outcome, the order in which account types ran dry, the path's real return over its first ten drawdown years beside the median path's, counts of cuts and raises. Worst, best and "typical shortfall" paths are percentile shortcuts (1, 99 and the middle of the failed group); nothing extra is stored.
32. **No route and no job is added.** Results are read through the inputs design's routes 15 to 18; a non-stored percentile is re-simulated by its route 18. B's preview route is not built: the Run page's hints are computed in the browser from `GET /scenarios/:id/input` (judge 1 counted the route as scope beyond v1; judge 2 wanted the hints).
33. **The web area is a Retirement shell like Investments:** Results, Profile, Scenarios (with the run settings and the Run button in the scenario editor), History. Charts use the line-series ECharts bundle already registered.
34. **The dashboard card** renders the inputs design's `DashboardView.retirement` (the newest finished run of the default scenario, with staleness). Tones: 90% and above good, 75% to under 90% warning, below 75% bad.
35. **The viewer reads everything and changes nothing.**
36. **The gate** is the hand-calculated suite of all four areas plus four reference scenarios checked against an independently written calculator: R1 a deterministic household to the dollar; R2 a second deterministic household that exercises dividends, interest, the HSA, RMDs from 73 and from 75, a first death, the survivor benefit and single filing, to the dollar; R3 the 4% rule on the historical record, exact against the independent calculator and within 5 points of the Trinity study; R4 a lognormal case within 1.5 points. An API test proves the plumbing, and the owner records one outside comparison.
37. **The independent calculator is TypeScript under `packages/retirement/reference/`, imports nothing from `src/`, and is written from the reference sheets of section 7.** Reason: independence without a second language in the repository (B's Python calculators conflict with the fixed "TypeScript everywhere" decision).
38. **Hooks never throw on data, allocate nothing and use none of the banned `Math` functions** (the engine design's hook rules). Powers are integer powers (`powInt`).
39. **Strategy decisions are annual by definition.** A later monthly engine calls `decideSpending` in January and spreads the amount (L3 is not precluded).
40. **Every result view shows `PLANNER_DISCLAIMER`** ("The planner is an estimate, not tax or investment advice.", the spec's sentence, declared by the inputs design).

## 2. Data model

This area owns no table. It owns two schema files in `packages/shared/src/retirement/` (§4), the engine-side tables its hooks read, and the reference fixtures. Units are stated on every number.

### 2.1 What the hooks read: `StrategyTables` (`strategies/prepare.ts`)

Built once by `prepareStrategies(input)` inside the engine's `prepare()` and reached by the hooks through the view (request E3 in section 9). Money in dollars (float64), today's dollars unless stated; one entry per plan year where an array is named.

| Field | Type | Unit and meaning |
| --- | --- | --- |
| `kind` | 0..4 | `constant_dollar`, `fixed_percentage`, `guardrails`, `vpw`, `floor_ceiling` |
| `base` | number | base core spending, dollars a year |
| `essentialShare` | number | `essentialAnnualCents ÷ baseAnnualCents`, 0 when the base is 0; fraction 0..1 |
| `survivorShare` | number | `survivorBp ÷ 10000` |
| `phase` | `Float64Array(Y)` | phase multiplier of each plan year (the last phase with `fromYear ≤ year`, 1 when none) |
| `coreShare` | `Float64Array(Y)` | share of the year in which core spending runs (`yearShare` of §3.2 for the window from `spending.startMonth`) |
| `goalReal`, `goalNominal` | `Float64Array(Y)` | dated goals of the year: today's-dollar goals (to be indexed) and goals quoted in the dollars of their year |
| `healthPre`, `healthMedicare` | `Float64Array(P × Y)` | per person and plan year: the pre-Medicare and Medicare amounts already multiplied by the year's shares of their windows and by `(1 + realGrowthBp/10000)^t`; dollars a year in today's dollars |
| `ltcReserve`, `ltcYears` | `Float64Array(P)`, `Int16Array(P)` | reserve per person in today's dollars (0 = none) and `lastYears` |
| `fixedRate` | number | fraction a year (`rateBp ÷ 10000`) |
| `gk` | record | `upper`, `lower`, `cut`, `raise` (fractions), `skipAfterLoss` (0 or 1), `cutoffYears`, `planningAge` |
| `vpw` | record | `stockReal`, `bondReal` (fractions a year), `lastAge` (years), `maxRate` (fraction) |
| `fc` | record | `rate` (fraction, NaN = derive from the plan), `floor`, `ceiling` (fractions) |
| `horizonYear` | `Int16Array(P)` | `birthYear + (fixed life-expectancy age, or gk.planningAge under table mortality)` |
| `cashReserve` | number | dollars, today's dollars |

### 2.2 What `decideSpending` writes: `SpendDecision`

The engine design's record (`spend`, `floor`, `lump`, `lumpFloor`, `healthcare`) with three fields this area adds (request E1). All nominal dollars; recurring fields are full-year amounts.

| Field | Target year | Gross year | Accumulation year |
| --- | --- | --- | --- |
| `spend` | core + healthcare + long-term care | essential core + healthcare + long-term care | 0 |
| `floor` | = `spend` | = `spend` | 0 |
| `lump` | dated goals of the year | same | same |
| `lumpFloor` | = `lump` | = `lump` | 0 |
| `healthcare` | the year's healthcare (caps the HSA's qualified tier) | same | 0 |
| `gross` (new) | NaN | the rule's gross portfolio withdrawal, including released long-term care money | NaN |
| `planned` (new) | the plan's recurring spending: planned core + healthcare + long-term care | same | 0 |
| `rule` (new) | bit flags: 1 freeze, 2 cut, 4 raise, 8 band floor, 16 band ceiling, 32 cap, 64 held at essentials | same | 0 |

### 2.3 Strategy state (`PathState.strategy`, 16 floats, zeroed per path)

| Slot | Used by | Meaning |
| --- | --- | --- |
| 0 | guardrails, floor_ceiling | 1 once the rule has started |
| 1 | guardrails | `x0`: the spendable portfolio of the start year in today's dollars (`P_R ÷ cpi_R`) |
| 2 | guardrails | `a`: the adjustment factor, 1 at the start |
| 3 | floor_ceiling | the percentage in use (fraction) |
| 4..15 | | reserved |

### 2.4 Tiers (`withdrawals/tiers.ts`)

A tier is a list of (account index, cap in dollars) pairs with a total cap. Nine tiers are rebuilt each year into preallocated arrays (`tierCap: Float64Array(9)`, `tierAccountCap: Float64Array(9 × A)`). `fill(x, w)` writes the per-account withdrawals for a total of `x` dollars taken through the tiers in order.

### 2.5 Reference fixtures (`packages/retirement/reference/fixtures/`)

| File | Format | Content |
| --- | --- | --- |
| `r1.input.json`, `r2.input.json`, `r3.input.json`, `r4.input.json` | the engine's boundary input (the engine design's `EngineInput`; cents as strings) | exactly the values of the reference sheets in §7.6 to §7.9 |
| `r1.expected.csv`, `r2.expected.csv` | CSV, one row per plan year, dollars with two decimals | every money column of the year row (§4.2), written by the independent calculator |
| `r3.expected.json` | JSON | `dataSha256`, and per stock share (5000 and 7500 bp): `paths`, `successPaths`, `failures[] { startYear, failIndex, shortfallReal }`, `endingReal { p10, p50, p90, startYearOfEach }`, `samples[] { startYear, endNominal, endReal }`, `path1966[]`; plus `trinityConvention[] { stockBp, startYears, successCount }` |
| `r4.expected.json` | JSON | `successRate` (large-sample value), `toleranceAbs`, `medianEndingReal`, `medianToleranceRel`, the parameters |
| `published.json` | JSON array | `{ id, claim, value, unit, source, url, verified, tolerance }` for each published comparator (Trinity 95% and 98%) |

The strategies need no data file: the VPW growth rates and the guardrail bands are fields of `StrategyConfig` with the published values as defaults.

## 3. Algorithms

### 3.1 Notation and where the hooks sit

`t` plan-year index, `y` its calendar year, `f` the year fraction (1 except in a partial first year). From the engine's `YearView`: `cpi` the price level at the start of the year (today = 1), `π₋₁ = prevInflation`, `r₋₁ = prevPortfolioReturn`, `portfolioStart`, `G = wages + guaranteedIncome + otherIncome` (gross recurring income of the year, full-year), `alive`, `retired`, `age`. This area's quantities: `P` spendable portfolio, `C` core spending, `H` healthcare, `L` long-term care, `K` dated goals, `E` essential core.

The engine's year (its §3.7) calls this area twice:

1. Income, contributions (engine).
2. **`decideSpending`** fills the `SpendDecision` of §2.2. The loop sets `need = spend × f + lump` and `floorNeed = floor × f + lumpFloor` (in accumulation: `need = lump`, `floorNeed = 0`).
3. RMDs and scheduled conversions (engine); `available[a]` is what each account can still give.
4. **`planWithdrawals`** fills `w[a]` using `assess(w)`, which returns the year's tax and `net` (cash left after tax and `need`) for a candidate.
5. The loop records the year (§3.8), trades, applies returns and inflation, and handles a death.

### 3.2 Planned spending (`plannedYear`, `strategies/planned.ts`)

For plan year t, with `s` = `survivorShare` when the household has two persons and exactly one is alive, else 1:

- `corePlanned = base × phase[t] × s × coreShare[t] × cpi`; `E = essentialShare × corePlanned`.
- `H = cpi × Σ over living persons of (healthPre[i][t] + healthMedicare[i][t])`.
- `K = goalReal[t] × cpi + goalNominal[t]`.
- Long-term care, for each living person i with a reserve: `d = yearsToDeath[i]` (0 in the year of death); `k = min(ltcYears[i], d + t − drawdownStart + 1)` (the care years that fall in the plan's drawdown; constant along a path). When `d < k` the year is a care year: `L += ltcReserve[i] × cpi ÷ k`. Set aside at the start of the year: `reserved += ltcReserve[i] × cpi × min(k, d + 1) ÷ k` (the whole reserve until care starts, then the part not yet spent).
- `P = max(0, portfolioStart − reserved)`.

`yearShare(window, year)` = (months of the window that fall inside the plan's part of that calendar year) ÷ (months of the plan in that year: 12, or the first year's months). It is 0 or 1 for every window that starts in January. It turns the inputs design's month windows (`spending.startMonth`, each person's `preMedicareFrom` and `medicareFrom`) into full-year rates, so that after the loop's multiplication by `f` each month of a window counts one twelfth of the annual amount. `prepareStrategies` applies it; the hooks never see a month.

`yearsToDeath` is read here and nowhere else in this area. A strategy rule sees only `P`, which shrinks by the reserve until care starts; it never learns when the path ends.

Worked examples:

- Phases: base 60,000; multipliers 1, 1, 0.9; `cpi` 1, 1.03, 1.0609 → planned core 60,000.00, 61,800.00, `60,000 × 0.9 × 1.0609 = 57,288.60`.
- A goal year (R2, 2030, `cpi` = 1.076890625): `(99,600 + 2 × 6,000 + 30,000) × 1.076890625 = 152,487.71`.
- After a first death (R2, 2035, `cpi` = 1.218403, survivor share 0.7): core `99,600 × 0.7 × 1.218403 = 84,947.05`, healthcare `6,000 × 1.218403 = 7,310.42`, need 92,257.47.
- Long-term care (R2: reserve 60,000 for person 2, 2 years, death in 2056): no care through 2054; 2055: `30,000 × 1.996495 = 59,894.85` with 119,789.70 set aside at the start of the year; 2056: `30,000 × 2.046407 = 61,392.22` with 61,392.22 set aside.
- A month window: retirement in June 2035 gives `coreShare = 7/12` for 2035; base 84,000 at `cpi` = 1.1: `84,000 × 7/12 × 1.1 = 53,900.00`.
- Reserve exclusion: accounts 1,000,000, reserve 200,000 not yet started, `cpi` = 1.1: `P = 1,000,000 − 220,000 = 780,000`.

### 3.3 Phases and what `decideSpending` returns

| Phase of the year | Test | Decision |
| --- | --- | --- |
| Accumulation | `view.phase = 0` | `spend = floor = 0`, `lump = K`, `lumpFloor = 0`, `gross = NaN`; strategy state untouched |
| Transition | drawdown, and some living person is not retired | the `constant_dollar` decision, whatever the strategy; state untouched |
| Retirement | drawdown, and every living person is retired | the chosen strategy |

In every drawdown year `healthcare = H`, `lump = lumpFloor = K` and `planned = corePlanned + H + L`.

### 3.4 The five strategies

**(a) `constant_dollar` (Bengen 1994).** Bengen's rule withdraws a fixed share of the starting portfolio in the first year and raises that dollar amount with inflation every year afterwards, whatever the portfolio does. Here the amount is the plan: `C = corePlanned`. Target year: `spend = floor = C + H + L`.

Example: planned core 96,000 at `cpi` = 1.025, no healthcare: `spend = floor = 98,400.00`.

**(b) `fixed_percentage`.** `gross = fixedRate × P + L`. Gross year: `spend = floor = E + H + L`. The rule cannot empty the portfolio; income moves with the market.

Examples: 4% of 1,234,567.89 = 49,382.72. With the reserve example of §3.2: 4% of 780,000 = 31,200.00.

**(c) `guardrails` (Guyton and Klinger 2006).** The published rules, as the FPA abstract and the descriptions by Pfau, RightCapital and others give them (section 10): a withdrawal rule (raise the withdrawal with inflation, but not after a year in which the portfolio lost money when the current withdrawal rate is above the initial rate; a skipped raise is never made up), a capital preservation rule (when the current rate exceeds the initial rate by more than 20%, cut the withdrawal 10%; not in the final 15 years) and a prosperity rule (when the current rate is more than 20% below the initial rate, raise the withdrawal 10%).

*The reference track.* Let `W` be a withdrawal that starts at any positive amount `W_R` in the start year R and follows those rules. The rules only ever compare `W_t ÷ P_t` with `W_R ÷ P_R`. Write `a_t = (W_t ÷ cpi_t) ÷ (W_R ÷ cpi_R)` for the track's cumulative adjustment in real terms (1 at the start; an inflation raise leaves it unchanged, a freeze divides it by `1 + π`, a cut multiplies it by 0.9, a raise by 1.1). Then

`ρ_t = (W_t ÷ P_t) ÷ (W_R ÷ P_R) = a_t × x0 × cpi_t ÷ P_t`, with `x0 = P_R ÷ cpi_R`.

`W_R` cancels, so the rules run on `a` alone and stay defined when the first-year draw is zero.

*What the factor scales.* The plan's portfolio-funded part of a year is `planDraw = max(0, corePlanned + H − G)`: it already contains every planned step (Social Security starting, a pension without a cost-of-living clause losing value, a phase change). Guardrails scale that part: `C = corePlanned − (1 − a) × planDraw`, and never below `E`.

```
if not started:
    if P > 0:  started = 1;  x0 = P / cpi;  a = 1
else if P > 0:
    ρ = a × x0 × cpi / P
    froze = false
    if skipAfterLoss and π₋₁ > 0 and r₋₁ < 0 and ρ > 1:
        a = a / (1 + π₋₁);  ρ = ρ / (1 + π₋₁);  froze = true;  rule |= FREEZE
    if ρ > 1 + upper and yearsRemaining > cutoffYears:   a = a × (1 − cut);    rule |= CUT
    else if not froze and ρ < 1 − lower:                  a = a × (1 + raise);  rule |= RAISE
planDraw = max(0, corePlanned + H − G)
C = corePlanned − (1 − a) × planDraw
if C < E:  C = E;  rule |= ESSENTIALS
```

`yearsRemaining = max over living persons of horizonYear[i] − y + 1`. With `P ≤ 0` no rule is applied and `a` is kept. If `P` is 0 in every retirement year the rule never starts and spending is the plan. Target year: `spend = floor = C + H + L`.

With no outside income and no healthcare, `planDraw = corePlanned` and `C = a × corePlanned = W`: the published rule. Worked trace (plan 50,000 on 1,000,000, so the initial rate is 5% and the guardrails sit at 6% and 4%; inflation 3% every year; 40 years remaining; `P` of the next year = `(P − C) × (1 + return)`):

| Year | Return of previous year | `P` | Planned core | ρ before / after a freeze | Rule | `a` | `C` | `C ÷ P` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | | 1,000,000.00 | 50,000.00 | 1 | start | 1 | 50,000.00 | 5.0000% |
| 1 | −15% | 807,500.00 | 51,500.00 | 1.275542 / 1.238390 | freeze, cut | 0.873786 | 45,000.00 | 5.5728% |
| 2 | −10% | 686,250.00 | 53,045.00 | 1.350819 / 1.311475 | freeze, cut | 0.763503 | 40,500.00 | 5.9016% |
| 3 | +25% | 807,187.50 | 54,636.35 | 1.033589 | none | 0.763503 | 41,715.00 | 5.1679% |
| 4 | +30% | 995,114.25 | 56,275.44 | 0.863548 | none | 0.763503 | 42,966.45 | 4.3177% |
| 5 | +20% | 1,142,577.36 | 57,963.70 | 0.774660 | raise | 0.839853 | 48,680.99 | 4.2606% |

Year 1 by hand: `ρ = 1 × 1,000,000 × 1.03 ÷ 807,500 = 1.275542 > 1` after a losing year, so the raise is skipped: `a = 1 ÷ 1.03 = 0.970874`, `ρ = 1.238390 > 1.2`, so cut: `a = 0.873786`; `C = 0.873786 × 51,500 = 45,000.00`.

The case both judges raised against Design A (guaranteed income covers most of the need): planned core 100,000, income 95,000 rising with prices, `P` = 1,000,000; the first year draws 5,000; then a −20% year with 3% inflation. `P = 995,000 × 0.8 = 796,000`; `ρ = 1.293970`, freeze to 1.256281, cut: `a = 0.873786`. Planned core 103,000, income 97,850, `planDraw = 5,150`: `C = 103,000 − 0.126214 × 5,150 = 102,350.00`, a draw of 4,500.00. The freeze and the cut together take 650.00 off a plan of 103,000 (0.6%), because the portfolio pays only 5% of it. (A's rule raised spending to 110,000 in this year.) The year after (+10%, 3%): `P = (796,000 − 4,500) × 1.10 = 870,650`, `ρ = 0.873786 × 1,060,900 ÷ 870,650 = 1.064722`, no rule, `C = 106,090 − 0.126214 × 5,304.50 = 105,420.50`.

A planned income step: retire with 1,500,000 and planned core 90,000, no income. Year 1 (return 3%, inflation 3%): `P = 1,452,300`, `ρ = 1.063830`. Year 2: `P = 1,400,388`, `cpi = 1.0609`, `ρ = 1.136364`, inside the band; Social Security of 40,000 starts, `planDraw = 95,481 − 40,000 = 55,481`; no rule, `C = 95,481.00`. A rule that tested the household's actual draw rate (`55,481 ÷ 1,400,388 = 3.96%`) against the initial 6% would raise spending 10% here and again in the following years; the reference track does not, because the step was planned.

Income covers everything in the start year (planned core 50,000, income 60,000, `P` = 500,000): `planDraw = 0`, `C = 50,000`. After a −24% year with 3% inflation (`P` = 380,000): `ρ = 1.355263`, freeze to 1.315789, cut: `a = 0.873786`, still `C = 51,500.00` because nothing is drawn. When a draw appears later (planned core 53,045, income 48,045, `P` = 400,000, `ρ = 1.158750`, no rule): `C = 53,045 − 0.126214 × 5,000 = 52,413.93`.

**(d) `vpw` (Bogleheads variable percentage withdrawal).** Each year withdraw a percentage of the current portfolio that rises with age, sized so that level real withdrawals would empty the portfolio at the horizon if it grew at fixed long-run real rates.

- `age` = age attained this year by the younger living person; `n = max(1, lastAge + 1 − age)`.
- `g = stockShare × stockReal + (1 − stockShare) × bondReal`, with `stockShare` the stock fraction of the year's target mix (request E3).
- `raw = g ÷ (1 − 1 ÷ powInt(1 + g, n)) ÷ (1 + g)` (the payment of an annuity-due on 1; `1 ÷ n` when `g = 0`); `pct = min(raw, maxRate)`, `rule |= CAP` when the cap binds.
- `gross = pct × P + L`. Gross year: `spend = floor = E + H + L`.

By hand at 65 with 60% stocks: `g = 0.6 × 5% + 0.4 × 1.9% = 3.76%`, `n = 35`, `1.0376^35 = 3.6395`, `1 − 1 ÷ 3.6395 = 0.72524`, `0.0376 ÷ 0.72524 ÷ 1.0376 = 0.049966`: the table's 5.0%.

| Age, stock share | n | Percentage | Published table |
| --- | --- | --- | --- |
| 60, 50% | 40 | 4.4915% | 4.5% |
| 62, 50% | 38 | 4.6036% | 4.6% |
| 65, 50% | 35 | 4.7991% | |
| 65, 60% | 35 | 4.9966% | 5.0% |
| 66, 60% | 34 | 5.0688% | 5.1% |
| 69, 60% | 31 | 5.3171% | 5.3% |
| 70, 60% | 30 | 5.4122% | 5.4% |
| 71, 60% | 29 | 5.5145% | 5.5% |
| 40, 40% | 60 | 3.6090% | 3.6% |
| 65, 40% | 35 | 4.6049% | 4.6% |
| 75, 50% | 25 | 5.8333% | |
| 88, 50% | 12 | 9.9739% | |
| 89, 50% | 11 | 10% (raw 10.7094%) | |
| 64 (a couple aged 70 and 64), 50% | 36 | 4.7299% | |
| any, `g = 0`, n = 35 | 35 | 2.8571% | |

**(e) `floor_ceiling` (Bengen 2001, with the spec's essentials split).** Bengen's method takes a fixed percentage of the portfolio each year but never lets the withdrawal rise more than a ceiling above, or fall more than a floor below, the first year's withdrawal in real terms. The spec adds the safety-first reading: guaranteed income is meant to cover essentials and the portfolio the rest.

- Planned discretionary spending of the year: `disc = corePlanned − E`.
- Start year: the percentage is `fc.rate` when given, else `disc ÷ P` (0 when `P` is 0); stored in the state.
- Every year: `raw = rate × P`; `lo = (1 − floor) × disc`; `hi = (1 + ceiling) × disc`; `D = min(max(raw, lo), hi)`, with `rule |= BAND_FLOOR` or `BAND_CEILING` when clamped.
- `C = E + D`. Target year: `spend = floor = C + H + L`.

`disc` carries inflation, phases and the survivor share, so the band follows the plan. With no essentials, phases or survivor change, `disc` is the first year's withdrawal carried by inflation and the rule is Bengen's.

Example (planned discretionary 45,000 in today's dollars, no essentials, `P` = 1,000,000 in the start year, so the derived percentage is 4.5%; band 15% below and 20% above):

| `P` | `cpi` | `raw` | `lo` | `hi` | `D` | Rule |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000,000 | 1 | 45,000.00 | 38,250.00 | 54,000.00 | 45,000.00 | none |
| 800,000 | 1.03 | 36,000.00 | 39,397.50 | 55,620.00 | 39,397.50 | floor |
| 1,500,000 | 1.0609 | 67,500.00 | 40,579.43 | 57,288.60 | 57,288.60 | ceiling |
| 1,100,000 | 1.092727 | 49,500.00 | 41,796.81 | 59,007.26 | 49,500.00 | none |

With essentials of 50,000 beside the same 45,000 (planned core 95,000), the second row gives `C = 50,000 × 1.03 + 39,397.50 = 90,897.50`.

### 3.5 The default order (`buildTiers`, policy `default`)

The engine has already taken each owner's RMD and the scheduled conversions; `available[a]` is what is left in each account. A person is *early* for pre-tax and Roth money when the tax area's predicate says a distribution this year carries the 10% additional tax (assumed: age attained under 60, request T3), and early for the HSA under 65. `rothFree[i]` is the amount person i can take from Roth accounts this year with no tax and no penalty (request E3): the whole Roth balance when not early, otherwise the contribution basis plus conversions at least five years old.

| Tier | Source | Cap | What `assess` makes of it |
| --- | --- | --- | --- |
| 1 | Cash accounts, above the reserve | `max(0, Σ cash − cashReserve × cpi)` | nothing taxable |
| 2 | HSA, for the year's healthcare | `min(Σ HSA of living owners, healthcare × f)` | qualified: nothing taxable |
| 3 | Taxable accounts | their balances | the gains the engine's trades realize |
| 4 | Pre-tax accounts of owners who are not early | their balances | ordinary income |
| 5 | Roth, free part | per person `min(Σ own Roth, rothFree[i])` | nothing taxable |
| 6 | The cash reserve | the rest of the cash | nothing taxable |
| 7 | Pre-tax accounts of early owners | their balances | ordinary income + 10% |
| 8 | Roth of early owners beyond the free part | the rest of their Roth | recent conversions: 10%; earnings: ordinary income + 10% (the tax area's ordering) |
| 9 | HSA beyond the year's healthcare | the rest of the HSA | ordinary income, + 20% when the owner is under 65 |

Within a tier each account's cap is its share of the tier's cap in proportion to its `available` balance (tiers 1 and 6 split each cash account in the same proportion, tiers 2 and 9 each HSA, tiers 5 and 8 each Roth account of a person). `fill(x)` takes `x` dollars through the tiers in order: tiers before the one that `x` ends in are taken whole, that one in proportion to its accounts' caps. `fill` is continuous and non-decreasing in every account, which is all the solver needs; a v2 policy supplies another `fill`.

Example (single, age 57, 2027; cash 10,000 with a reserve of 5,000; a taxable account of 20,000 at basis 20,000; pre-tax 300,000; Roth 80,000 of which 30,000 free): 90,000 taken through the order is cash 5,000 (tier 1), taxable 20,000 (tier 3), Roth 30,000 (tier 5), the reserve 5,000 (tier 6) and pre-tax 30,000 (tier 7). Tax on that: taxable income `30,000 − 16,600 = 13,400`, `1,280 + 12% × 600 = 1,352.00`, additional tax 3,000.00.

Example (two pre-tax accounts of 600,000 and 200,000 in tier 4, 40,000 taken from the tier): 30,000 and 10,000.

### 3.6 `planWithdrawals(view, decision, assess, w)`

`net(x)` below means: `fill(x, w)`, `assess(w, out)`, `out.net`. `total` = the sum of all tier caps. `TOL = CASH_TOL = 0.005`.

**Target and accumulation years** (`decision.gross` is NaN):

```
h0 = net(0)                               // call 1
if h0 >= −TOL:  w = 0;  return            // income and RMDs already cover the year; the loop saves the rest
hT = net(total)                           // call 2
if hT <= TOL:   w = fill(total);  return  // short (the loop records the shortfall) or exactly enough
x = solve(0, h0, total, hT);  w = fill(x)
```

**Gross years:**

```
wd = min(total, max(0, gross × f + lump − Σ rmd))    // what the rule still releases after the RMDs
h1 = net(wd)                              // call 1
if h1 >= −TOL or wd = total:  w = fill(wd);  return   // the rule's withdrawal pays the floor (or nothing more exists)
hT = net(total)                           // call 2
if hT <= TOL:   w = fill(total);  return
x = solve(wd, h1, total, hT);  w = fill(x)            // topped up to the floor
```

In a gross year `need` is the floor (§2.2), so `net ≥ 0` means the floor is paid and the top-up is the ordinary gross-up started from `wd`.

Worked examples (2026 or 2027 parameters as stated; yields 0; no reserve unless stated):

- *Closed form, one bracket.* Married, both 60, 2026, pre-tax only, target 100,000, no income. Standard deduction 32,200; in the 12% bracket `x − [2,480 + 0.12(x − 32,200 − 24,800)] = 100,000` gives `x = 108,681.82`, tax 8,681.82.
- *Social Security phasing in.* Single, 70, 2026, Social Security 30,000, target 61,000, pre-tax only. Deductions `16,100 + 2,050 + 6,000 = 24,150`. Taxable benefits `0.85(x − 19,000) + 4,500`; tax `1,240 + 0.12(1.85x − 48,200) = 0.222x − 4,544`; `30,000 + x − tax = 61,000` gives `x = 34,005.14`; taxable benefits 17,254.37, taxable income 27,109.51, tax 3,005.14. Each dollar withdrawn costs 22.2 cents.
- *Benefits phasing in, joint.* Married, both 67, 2027, Social Security 50,000, target 90,000, pre-tax only: `x = 41,871.17`, taxable benefits 25,440.49, taxable income 18,711.66, tax 1,871.17 (`0.815x = 34,125`).
- *Penalty tiers.* Single, 50, 2026, target 40,000; cash 10,000; Roth 60,000 of which 15,000 free; pre-tax 500,000. Cash 10,000 and Roth 15,000 are free; the last 15,000 must come from pre-tax with the additional tax: `x − 0.10(x − 16,100) − 0.10x = 15,000` gives 16,737.50; income tax 63.75, additional tax 1,673.75.
- *Gross year, RMD below the rule.* 2027, married, both born 1952 (75); pre-tax 1,200,000 owned by one spouse; a taxable account of 100,000 at basis 100,000; Social Security 50,000; `vpw` at 50% stocks; no essentials. `P = 1,300,000`, percentage 5.83328%, `gross = 75,832.60`. RMD `1,200,000 ÷ 24.6 = 48,780.49`; `wd = 27,052.11`, from the taxable account with no gain. Provisional income `48,780.49 + 25,000 = 73,780.49`; taxable benefits `0.85 × 29,780.49 + 6,000 = 31,313.41`; AGI 80,093.90; deductions `33,200 + 3,400 + 12,000 = 48,600`; taxable income 31,493.90; tax `2,560 + 12% × 5,893.90 = 3,267.27`. Spending `50,000 + 75,832.60 − 3,267.27 = 122,565.33`.
- *Gross year, RMD above the rule.* The same household with `fixed_percentage` at 3%: `gross = 39,000` is below the RMD, `wd = 0`; the tax is the same; 9,780.49 (the RMD beyond the rule) is saved and spending is `50,000 + 39,000 − 3,267.27 = 85,732.73`.
- *Gross year with a top-up.* Single, 67 (born 1960, no RMD yet), 2027, Social Security 24,000, pre-tax 1,000,000, `fixed_percentage` 4%: `gross = 40,000`. Provisional income 52,000: taxable benefits `min(20,400, 0.85 × 18,000 + 4,500) = 19,800`; AGI 59,800; deductions `16,600 + 2,100 + 6,000 = 24,700`; taxable income 35,100; tax `1,280 + 12% × 22,300 = 3,956.00`; the rule pays `24,000 + 40,000 − 3,956 = 60,044.00`. With a floor of 50,000 the rule stands. With a floor of 65,000 a top-up is needed: up to 40,705.88 each dollar also makes 85 cents of benefits taxable; there benefits reach their 85% cap and 60,593.17 is available; beyond it the marginal rate is 12%: `x = 40,705.88 + (65,000 − 60,593.17) ÷ 0.88 = 45,713.64`, tax 4,713.64, spending 65,000.00, top-up 5,713.64.
- *Shortfall.* Single, 80 (born 1947), 2027, Social Security 24,000, pre-tax 20,000, target 60,000. RMD `20,000 ÷ 20.2 = 990.10`; everything else (19,009.90) is drawn; provisional income 32,000, taxable benefits 3,500, AGI 23,500 under the deductions, tax 0; funded 44,000.00, shortfall 16,000.00, the path fails this year.
- *Surplus.* Married, both 75 (born 1952), 2027, one pre-tax account of 2,000,000, a cash account of 5,000, Social Security 60,000, target 100,000. RMD 81,300.81; taxable benefits 51,000 (the 85% cap); AGI 132,300.81; taxable income 83,700.81; tax `2,560 + 12% × 58,100.81 = 9,532.10`; `net(0) = 60,000 + 81,300.81 − 9,532.10 − 100,000 = 31,768.72` (31,768.7154 before rounding): nothing is withdrawn and the loop saves 31,768.72.
- *A goal before retirement.* Married, 2026, both under 65, wages 150,000, a goal of 20,000, a taxable account of 100,000 at basis 50,000. Baseline tax 15,340 (taxable income 117,800, above the 98,900 gains threshold), so half of each dollar withdrawn is gain taxed at 15%: `x − 0.075x = 20,000` gives 21,621.62 and 1,621.62 of added tax; wages pay the baseline.

### 3.7 The solver (`solve`, `withdrawals/solve.ts`)

```
solve(lo, hlo, hi, hhi):                  // hlo < −TOL, hhi > TOL; calls counts every net() of the year, the two above included
    x = lo − hlo                          // first trial: add the raw shortfall
    if x >= hi:  x = lo + (hi − lo) × (−hlo) / (hhi − hlo)
    side = 0
    while calls < 24:
        hx = net(x)
        if |hx| <= TOL:  return x
        if hx < 0:  lo = x;  hlo = hx;  if side = −1: hhi = hhi / 2;  side = −1
        else:       hi = x;  hhi = hx;  if side = +1: hlo = hlo / 2;  side = +1
        if hi − lo <= TOL / 2:  return hi
        x = lo + (hi − lo) × (−hlo) / (hhi − hlo)
        if not (lo < x < hi):  x = (lo + hi) / 2
    return hi                             // not converged: the smallest amount found with net >= 0
```

`net` is continuous, piecewise linear and increasing in `x` as long as the marginal tax plus penalty rate stays below 100%. The steepest stack found in v1 is about 63% (the 12% bracket and 15% on gains pushed out of the 0% band, both multiplied by 1.85 while benefits phase in, multiplied again by 1.06 while the senior deduction phases out, plus the 10% additional tax). Dividends and coupons shrink as a taxable account is drawn, so the slope can also exceed 1 slightly. False position is exact once both ends lie on the root's linear piece; the Illinois halving prevents one end from sticking.

Measured with the scratch reference on 39,838 random household-years against the 2027 tax function (one or two persons aged 50 to 92, every account kind, reserves, free Roth amounts, wages, pensions, goals, all strategies; 19,902 target years, 15,317 gross years that needed no top-up, 4,619 top-ups): 2.71 `assess` calls a year on average; among the 19,551 years that entered the loop 4.45 on average, 7 at the 99th percentile, 10 at most; none reached 24. The reference scenarios R1 and R2 use at most 5 and 6.

A v2 note: IRMAA and ACA cliffs make `net` discontinuous; the bracket then still returns an amount with `net ≥ 0`, which is the contract the optimizers need.

### 3.8 What the loop does with the result

As in the engine design's step 5, with one addition for gross years (request E1). The loop calls `assess(w)` once more for the record.

- `net < 0`: `shortfall = min(need, −net)`, `funded = need − shortfall`.
- `net ≥ 0` in a target or accumulation year: `funded = need`, `surplus = net`, saved to the surplus account.
- `net ≥ 0` in a gross year: `excess = max(0, Σ rmd − (gross × f + lump))`; `extra = max(0, net − excess)`; `funded = need + extra`; `surplus = net − extra`. The rule's money is spent; only RMDs the rule did not call for are saved.
- Failure: `funded + CASH_TOL < floorNeed` in a drawdown year (the first such year is the failure year).
- Below plan (new flag): `funded + CASH_TOL < planned × f + lump` in a drawdown year.

The cash identity of every row, asserted in tests: income + withdrawals (RMDs included) = tax + employee contributions + funded spending + surplus saved. It holds in a shortfall year too, with `funded = need − shortfall`; the one exception is the engine's: when the year's tax alone exceeds all the cash there is, the unpaid tax is dropped.

### 3.9 Success, the full-plan rate, ending wealth

- `successPaths` = paths with no failure year; the success rate is `successPaths ÷ paths`; `successBp = truncDiv(successPaths × 10000, paths)` (the inputs design's rule): 64 of 69 → 9275; 65 of 69 → 9420.
- `fullPlanPaths` = paths with no below-plan year. It equals `successPaths` under `constant_dollar`; under the other strategies it counts the futures in which the rule never had to give less than the plan.
- The interval beside the success rate is the engine's Wilson interval, absent for the historical and fixed models.
- Ending wealth as decision 26; failed paths are included with whatever they hold.
- Alternatives considered and not made primary: portfolio never empty (identical to decision 8 once essentials are always funded), spending never below plan (reported as the full-plan rate), real capital preserved (not a retirement goal).

### 3.10 Summary and fan (`toSimSummary`, `toFanSeries`)

Pure mappers from the engine's `EngineResult` (already cents strings) to the stored shapes of §4.2:

- `endingWealthReal` p10, p25, p50, p75, p90 and mean, and `endingWealthNominal` p10, p50, p90: copied (nearest rank).
- `successCi95Bp` = the Wilson bounds × 10000, rounded half away from zero, or null.
- `failure.byYear` = `failureYearCounts`; `firstYear` = the calendar year of the first non-zero entry; `medianYear` = the calendar year at which the running count first reaches `ceil(failures ÷ 2)`.
- Fan: the engine's five percentiles of end-of-year portfolio value (today's dollars and nominal) and of funded spending (today's dollars), cut after the last plan year whose `aliveCount` is at least `min(100, paths)` (`truncated` says whether anything was cut). The spending bands start at the first drawdown year (`spendingFromIndex`), so no array holds a null.
- `fundedBp[t]` = the share of all paths not yet failed at the end of plan year t: `truncDiv((paths − Σ_{u ≤ t} failureYearCounts[u]) × 10000, paths)`. Example: 4 paths with first failures in plan years 3 and 5 give 10000, 10000, 10000, 7500, 7500, 5000.

### 3.11 The year table (`toYearTable`, `deflateYearRow`, `addUp`)

`toYearTable(detail, input)` maps the engine's `PathDetail` to `YearTable` (§4.2):

1. Account columns keep the engine's order; each account's bucket, owner and name come from the input. By-type figures are sums over the accounts of a bucket.
2. `phase`: the engine's `accumulation`, or `transition` / `retirement` by the test of §3.3 on the row's `alive` flags and the persons' retirement years.
3. Spending lines: `planned`, `healthcare`, `longTermCare` and `goals` are recomputed with `plannedYear` from the row's year, `alive` flags, price level and death years; `funded` and `shortfall` are the engine's. In a year without shortfall `core = funded − healthcare − longTermCare − goals`; in a shortfall year the funded amount is allotted in the order healthcare, long-term care, goals, core.
4. Events: the rule flags of §2.2, plus `topped_up` (a gross year in which more than `wd` was withdrawn) and `rmd_excess` (a gross year with `Σ rmd > gross × f + lump`).
5. **Adding up** (`addUp(totalCents, parts)`): every total is the engine's own rounded total. When the rounded parts sum to something else, the difference is added to the part with the largest absolute value (the first such part on a tie). Applied to income, withdrawals by account, taxes, and ending balances by account. Example (R1, 2047): the rounded ending balances are 36,788.20 + 904,127.71 + 932,634.14 = 1,873,550.05 while the rounded total is 1,873,550.06; the Roth account is shown as 932,634.15.
6. `growthCents` is the plug of the roll-forward: `ending total − (previous ending total + contributions + surplus saved − withdrawals)`, with the starting total for the first row. Conversions move money between accounts and do not enter it.
7. Derived figures: `withdrawalRateBp = (withdrawals − surplus saved) ÷ portfolio at the start of the year` (R1, 2027: `122,696 ÷ 1,790,000` → 685); `portfolioReturnBp = growth ÷ (ending total − growth)`; `essentialCoverageBp = min(20000, (Social Security + pensions and annuities) ÷ (essential core + healthcare))`, absent when the denominator is 0 (the diagnostic "guaranteed income covers N% of essentials"). Ratios are rounded half away from zero to whole basis points; only `successBp` truncates. A ratio whose denominator is 0 (a year after the money ran out) is 0, so every row of a failed path still parses.

`deflateYearRow(row)` gives the today's-dollars view, on the server or in the browser, with the same result: every flow is `dollarsToCents(cents ÷ 100 ÷ cpiStart)`, every ending balance uses `cpiEnd`, the ending total is the row's own `totalRealCents` (the engine's figure, so the last row equals the reported percentile), every other total is the deflated total, and `addUp` is applied again. Example: three parts of 100.00 at a price level of 1.07 deflate to 93.46 each (sum 280.38) while the total deflates to 280.37; the first part is shown as 93.45.

### 3.12 The path story (`pathStory(table, medianTable)`, shared, pure)

```ts
interface PathStory {
  outcome: "funded" | "failed";
  failureYear?: number; failureAges?: number[];
  endingRealCents: string;
  depletion: Array<{ bucket: PlanBucket; year: number }>;     // first year a bucket ended at zero after holding money, in order
  first10: { realReturnBp?: number; medianRealReturnBp?: number };   // annualized real portfolio return over the first 10 drawdown years
  events: { cuts: number; raises: number; freezes: number; topUps: number; bandFloors: number; bandCeilings: number };
  belowPlanYears: number;
  peakTax: { year: number; cents: string };
}
```

The real return of a year is `(1 + portfolioReturn) ÷ (cpiEnd ÷ cpiStart) − 1`; the ten-year figure is the geometric mean (fewer years when the path is shorter; absent in a path with no drawdown year). `medianTable` is the stored 50th-percentile table. The web turns the record into sentences, for example: "The money ran out in 2053, at ages 91 and 88." "Markets returned −1.8% a year after inflation over the first 10 retirement years; the median path had +3.1%." "The taxable accounts were empty by 2037, the pre-tax accounts by 2049, the Roth accounts by 2053." For a funded path: "Every year of spending was funded; the plan ended with $1,115,486 in today's dollars."

### 3.13 Assumptions (`describeAssumptions(input, run)`, web, pure)

A list of `{ group, label, value }` built from the run's frozen input (`GET /runs/:id/input`) and the run view. Groups: Run (scenario, as-of date, first-year share, paths, seed, threads with the note that results do not depend on them, engine and data versions, duration); Markets (return model and its parameters, inflation, rebalancing, yields); Household (ages, retirement dates, life expectancy, filing status rule); Starting balances by bucket with the accounts whose basis or allocation was assumed; Spending (base, essentials, phases, healthcare, goals, survivor share, long-term care); Strategy (kind and every parameter in words); Withdrawals (the order in one sentence, the cash reserve, the conversion schedule); Taxes (rule set, last published year, the indexing rule, what is not modelled); Simplifications (the rows of section 8 that change results).

## 4. Contracts

### 4.1 Strategy and order settings (`packages/shared/src/retirement/strategy.ts`)

Embedded by the inputs design in `RunSettings.strategy` and `RunSettings.withdrawalOrder`, so they obey its rule for stored documents: no float, no null, strict objects. `bp` and `PlanCents` are the inputs design's primitives.

```ts
export const StrategyKind = z.enum(["constant_dollar", "fixed_percentage", "guardrails", "vpw", "floor_ceiling"]);
export const StrategyConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("constant_dollar") }).strict(),
  z.object({ kind: z.literal("fixed_percentage"), rateBp: bp(50, 2000).default(400) }).strict(),               // of the spendable portfolio, a year
  z.object({ kind: z.literal("guardrails"),
    upperBandBp: bp(100, 10000).default(2000), lowerBandBp: bp(100, 9000).default(2000),                        // of the initial rate
    cutBp: bp(0, 5000).default(1000), raiseBp: bp(0, 5000).default(1000),                                       // of the portfolio-funded part of the plan
    skipInflationAfterLoss: z.boolean().default(true),
    preservationCutoffYears: z.number().int().min(0).max(60).default(15),                                       // years
    planningAge: z.number().int().min(80).max(119).default(95) }).strict(),                                     // horizon age under table mortality
  z.object({ kind: z.literal("vpw"),
    stockRealBp: bp(0, 1500).default(500), bondRealBp: bp(0, 1000).default(190),                                // real growth a year
    lastWithdrawalAge: z.number().int().min(85).max(119).default(99), maxRateBp: bp(100, 10000).default(1000) }).strict(),
  z.object({ kind: z.literal("floor_ceiling"),
    rateBp: bp(50, 2000).optional(),                                                                            // absent = the plan's own percentage
    floorBp: bp(0, 9000).default(1500), ceilingBp: bp(0, 20000).default(2000) }).strict(),                      // below and above planned discretionary spending
]);
export const WithdrawalOrderConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default"), cashReserveCents: PlanCents.default("0") }).strict(),                 // today's dollars
]);
export const DEFAULT_STRATEGY = { kind: "constant_dollar" } as const;
export const DEFAULT_WITHDRAWAL_ORDER = { kind: "default", cashReserveCents: "0" } as const;
export const STRATEGY_INFO: Record<StrategyKind, { label: string; summary: string; source: string }>;           // the card texts of §5.4
```

`sim_run.strategy` holds `kind`. `prepareStrategies` divides basis points by 10,000 and cents by 100; it is the only place the two forms meet.

### 4.2 Result shapes (`packages/shared/src/retirement/results.ts`)

Stored by the inputs design in `sim_run.summary`, `sim_run.fan` and `sim_run_path.year_table`, and returned inside its `SimRunDetail` and `RunPathResponse`. `Cents` is `CentsString`; every `…Bp` is an integer in basis points; price levels are decimal strings written with `String(x)` (they parse back to the same float64).

```ts
const Wealth5 = z.object({ p10: Cents, p25: Cents, p50: Cents, p75: Cents, p90: Cents, mean: Cents });
export const SimSummary = z.object({
  schemaVersion: z.literal(1),
  paths: z.number().int(), successPaths: z.number().int(), fullPlanPaths: z.number().int(),
  successCi95Bp: z.tuple([z.number().int(), z.number().int()]).nullable(),            // Wilson; null for the historical and fixed models
  endingWealthReal: Wealth5,                                                           // today's dollars; p50 and p10 feed the run list and the card
  endingWealthNominal: z.object({ p10: Cents, p50: Cents, p90: Cents }),
  failure: z.object({ paths: z.number().int(), firstYear: z.number().int().nullable(), medianYear: z.number().int().nullable(),
    byYear: z.array(z.number().int()) }),                                              // first-failure count by plan year
  lifetimeSpendingRealP50: Cents, lifetimeTaxesRealP50: Cents, shortfallRealP50OfFailures: Cents.nullable(),
  model: z.object({ kind: z.string(), requestedPaths: z.number().int(), cohortMode: z.string().optional(), cohortCount: z.number().int().optional(),
    firstStartYear: z.number().int().optional(), lastStartYear: z.number().int().optional(), meanBlockYears: z.number().optional(), preset: z.string().optional() }),
  mortalityTable: z.string(), strategy: StrategyKind,
  startYear: z.number().int(), firstYearFractionPpm: z.number().int(),                // 1000000 = a full first year
  digest: z.string(),
});

const Bands = z.object({ p10: z.array(Cents), p25: z.array(Cents), p50: z.array(Cents), p75: z.array(Cents), p90: z.array(Cents) });
export const FanSeries = z.object({
  schemaVersion: z.literal(1),
  years: z.array(z.number().int()),                                                    // calendar years shown
  ages: z.array(z.array(z.number().int())),                                            // [person][index]: age attained
  aliveCount: z.array(z.number().int()), fundedBp: z.array(z.number().int()),
  truncated: z.boolean(),                                                              // later years omitted: too few paths alive
  real: Bands, nominal: Bands,                                                         // end-of-year portfolio value
  spendingFromIndex: z.number().int(), spendingReal: Bands,                            // funded spending, from the first drawdown year
});

const ByBucket = z.object({ cash: Cents, taxable: Cents, preTax: Cents, roth: Cents, hsa: Cents });
export const StrategyEvent = z.enum(["freeze", "cut", "raise", "band_floor", "band_ceiling", "cap", "essentials", "topped_up", "rmd_excess"]);
export const YearRow = z.object({
  year: z.number().int(), yearFractionPpm: z.number().int(),
  ages: z.array(z.number().int()), alive: z.array(z.boolean()),
  phase: z.enum(["accumulation", "transition", "retirement"]), filingStatus: z.enum(["single", "married_joint"]),
  cpiStart: z.string(), cpiEnd: z.string(),                                            // price level at the start and the end of the year; today = "1"
  inflationBp: z.number().int(), portfolioReturnBp: z.number().int(),
  income: z.object({ wages: Cents, socialSecurity: z.array(Cents), pensionAnnuity: Cents, rental: Cents, other: Cents, total: Cents }),
  contributions: z.object({ employee: Cents, employer: Cents }),
  spending: z.object({ planned: Cents, funded: Cents, core: Cents, healthcare: Cents, longTermCare: Cents, goals: Cents,
    floor: Cents, shortfall: Cents, ruleGross: Cents.optional() }),                    // ruleGross: gross years only
  strategy: z.object({ events: z.array(StrategyEvent), withdrawalRateBp: z.number().int(), essentialCoverageBp: z.number().int().optional() }),
  withdrawals: z.object({ byAccount: z.array(Cents), byBucket: ByBucket, total: Cents,  // gross, RMDs included, conversions excluded
    rmdByAccount: z.array(Cents), rmdTotal: Cents }),
  conversions: Cents,
  investment: z.object({ realizedGains: Cents, dividends: Cents, coupons: Cents }),
  tax: z.object({ total: Cents, ordinary: Cents, capitalGains: Cents, niit: Cents, penalties: Cents,
    taxableSocialSecurity: Cents, agi: Cents, deduction: Cents, taxableIncome: Cents }),
  surplusSaved: Cents, growth: Cents,
  ending: z.object({ byAccount: z.array(Cents), basisByAccount: z.array(Cents), byBucket: ByBucket, total: Cents, totalReal: Cents }),
  failed: z.boolean(),                                                                 // this year has a shortfall against the floor
});
export const YearTable = z.object({
  schemaVersion: z.literal(1), pathIndex: z.number().int(),
  historicalStartYear: z.number().int().optional(),                                    // historical model: "the path that starts in 1966"
  deathYears: z.array(z.number().int()),
  accounts: z.array(z.object({ id: z.string(), name: z.string(), bucket: PlanBucket, owner: OwnerId })),
  startingTotal: Cents, rows: z.array(YearRow),
});
```

Money in a row is nominal. A row is about 2 KB of JSON with eight accounts, so a table of 47 years is roughly 90 KB and the seven stored tables roughly 0.6 MB (an estimate, well under the inputs design's 2 MB guard per table, but above its 160 KB estimate for the seven; see section 9).

### 4.3 Pure functions

```ts
// @meridian/retirement, strategies/
export function prepareStrategies(input: EngineInput): StrategyTables;                                          // throws EngineInputError on a malformed block
export function plannedYear(tb: StrategyTables, t: number, cpi: number, alive: ArrayLike<number>, yearsToDeath: ArrayLike<number>,
  drawdownStart: number, portfolioStart: number, out: PlannedYear): void;                                       // corePlanned, essentialCore, healthcare, longTermCare, goals, reserved, spendable
export const decideSpending: EngineHooks["decideSpending"];                                                     // §3.3, §3.4
export function vpwPercentage(age: number, stockShare: number, p: { stockReal: number; bondReal: number; lastAge: number; maxRate: number }): number;
// withdrawals/
export function buildTiers(view: YearView, healthcareCap: number, reserve: number, tiers: TierBuffers): void;
export function fill(tiers: TierBuffers, x: number, w: Float64Array): void;
export function solve(net: (x: number) => number, lo: number, hlo: number, hi: number, hhi: number, calls: { n: number }): number;
export const planWithdrawals: (view: YearView, decision: SpendDecision, assess: AssessFn, w: Float64Array) => void;
// results/
export function toSimSummary(result: EngineResult, input: EngineInput): SimSummary;
export function toFanSeries(result: EngineResult): FanSeries;
export function toYearTable(detail: PathDetail, input: EngineInput): YearTable;
// @meridian/shared, retirement/results.ts
export function addUp(totalCents: bigint, parts: bigint[]): bigint[];
export function deflateYearRow(row: YearRow): YearRow;
export function pathStory(table: YearTable, medianTable?: YearTable): PathStory;
export function fundedShareBp(paths: number, failureYearCounts: readonly number[]): number[];
```

The hooks follow the engine design's rules: results go into the `out` record or array, nothing is allocated, the closures the solver needs are created once per thread.

### 4.4 Routes

This area adds none. The pages call the inputs design's routes (its §4.7): 1 (`GET /meta`), 2 to 6 (profile and baseline), 7 to 14 (scenarios, the frozen input preview and the run request), 15 to 21 (runs, the stored input, percentile paths, cancel, pin, delete), `GET /api/audit` for history and `GET /api/dashboard` for the card. All money on those routes is cents as decimal strings.

## 5. UI

### 5.1 Shell and routes

`RetirementLayout` copies `InvestmentsLayout`: an `h1` "Retirement", a sub-navigation of `NavLink`s and the outlet; under the outlet the disclaimer line. `Layout.tsx` gains the nav entry after "Investments".

| Path | Page | Sub-nav label |
| --- | --- | --- |
| `/retirement` | `ResultsPage` for the newest finished run of the selected scenario (`?scenario=`, default scenario first) | Results |
| `/retirement/runs/:id` | `ResultsPage` for that run | (Results stays active) |
| `/retirement/profile` | `ProfilePage` | Profile |
| `/retirement/scenarios` | `ScenariosPage` | Scenarios |
| `/retirement/scenarios/:id` | `ScenarioEditorPage` (changes, run settings, Run) | (Scenarios stays active) |
| `/retirement/history` | `RunsPage` | History |

URL state on Results: `?scenario=`, `?p=` (percentile 1..99, default 50), `?dollars=today|nominal`, `?view=portfolio|spending`. Query keys live under `['retirement', view, params]`; `invalidateRetirement(qc)` in `components/retirement/queries.ts` invalidates `['retirement']` and `['dashboard']`.

### 5.2 Profile page

The inputs design's six-step form (People, Accounts, Income, Social Security, Spending, Savings) on `GET/PUT /profile`, with `resolvePlan` run in the browser for inline issues by path. What this design fixes:

- **Seed hints** (`SeedHint`). Every seeded field (base spending, essential spending, each contribution, each account's balance, basis and allocation) shows its provenance from the response ("from live data", "typed", "this scenario", "default") and its evidence (for spending: "last 12 months of the plan, Nov 2025 to Oct 2026"). A typed value shows the live value beside it with "Use live value"; the hint is prominent when the two differ by more than 2% or $500 a year, whichever is larger.
- **Baseline banner**: "Balances as of 11/08/26" with Refresh. The dialog lists the `changes` of `GET /baseline/preview`, material ones first ("401(k) +$12,300", "Base spending $84,200 → $86,050"); Apply posts `POST /baseline/refresh` with `expectedHash`; `409 baseline_changed` reloads the preview.
- **Accounts step**: the live accounts grouped by bucket with balance, valuation date, owner, basis coverage, allocation bar and its source, each group linking to Accounts; an account with a borrowed allocation or unknown basis carries its warning from `issues`.
- **Spending step**: the 12-month total with the category list, the essentials figure with its share of the base ("Essentials are 60% of your spending"), phases, goals, healthcare, long-term care (amount per person and "spent over the last N years of life"), the share after a death.

States: no profile → the wizard opens with `defaultProfileDoc` and a banner "Seeded from your accounts and the last 12 months of your plan. Review and save."; saved with errors → the issue list links to each field; fewer than 3 full months of ledger → "enter your yearly spending"; no eligible account → "Connect or add an investment account" with a link; validation errors appear beside the field from the API's message; the viewer sees values and hints with no inputs and no Save.

### 5.3 Scenarios page and scenario editor

`ScenariosPage`: the list from `GET /scenarios` (name, default badge, number of changes, the latest run with its success rate, an active run's progress). Actions for the owner: New (a copy of the profile with no changes), Duplicate, Rename, Make default, Archive, Delete (not the default; the confirmation says its runs go with it). With only the default scenario: a line explaining that a scenario is a set of changes on top of the profile.

`ScenarioEditorPage` has three parts:

- **Changes.** The profile form with the scenario's document; each changed field is marked with the profile's value greyed beside it and "Reset to profile". `ChangeChips` lists `ScenarioView.changes` through the pure `changeLabel(path, before, after)` ("Retire at 62 instead of 65", "Spending −10%"; an unknown path falls back to the path and the two values). The Roth conversion schedule is edited here (person, from year, to year, amount a year, today's dollars or nominal).
- **Run settings** (§5.4), saved with `PATCH /scenarios/:id { settings }`.
- **History**: the scenario's audit entries from `GET /api/audit` with before and after, and Revert for the owner.

### 5.4 Run settings

- **Return model** (`ReturnModelPicker`): three cards (Historical sequences; Block bootstrap; Parametric with the presets "Long-run history" and "Conservative future") rendering the engine area's settings.
- **Strategy** (`StrategyPicker` and `StrategyParamsForm`): five cards with the texts of `STRATEGY_INFO`, each with its parameters and defaults and a hint computed in the browser by `strategyHints(effective, settings)` from `GET /scenarios/:id/input` (today's included total, base and essential spending, ages):
  - Constant inflation-adjusted: "Spend your plan every year, raised only for inflation, whatever markets do. This is the rule behind William Bengen's 4% (1994). Spending is steady; the risk is running out after a bad early stretch." Hint: "Your plan spends $96,000 a year, 3.5% of today's portfolio."
  - Fixed percentage: "Take the same percentage of whatever the portfolio is worth each year. The rule cannot empty the portfolio, but your income rises and falls with the market. Essentials are topped up if the percentage falls short." Hint: "At 4% the first withdrawal would be $54,400."
  - Guardrails: "Follow your plan, but skip the inflation raise after a losing year, cut the portfolio-funded part 10% when the withdrawal rate climbs more than 20% above where it started (not in the last 15 years), and raise it 10% when it falls more than 20% below (Guyton and Klinger, 2006)." Note: "The published rules assume no other income. Here they run on a reference withdrawal and scale what your portfolio pays, so Social Security starting is not mistaken for prosperity. If your plan draws heavily before Social Security starts, expect cuts during those years."
  - Variable percentage: "Each year withdraw a percentage of the portfolio that rises with age, sized so the money would last to age 100 at long-run growth rates for your stock and bond mix (the Bogleheads VPW method). Income varies with the market." Hint: "At your ages and mix the first percentage is 4.9%." Note on both percentage strategies: "Other income is spent in addition, so spending steps up when Social Security starts."
  - Floor and ceiling: "Essential spending is paid every year, by Social Security, pensions and annuities first. Discretionary spending is a percentage of the portfolio, kept between 15% below and 20% above your plan (after Bengen, 2001)." Hint: "Essentials are 60% of your plan; your discretionary budget is $38,400, 1.4% of the portfolio."
- **Withdrawals**: the default order in one sentence ("Cash, then taxable, then pre-tax, then Roth; penalties last") and the field "Cash to keep on hand" (`cashReserveCents`). v2's order choices are not shown.
- **Simulation**: paths (default 10,000; disabled for the historical model with "one path per historical start year"), seed, tax rule set, threads (read-only, from the latest run).
- **Run** (owner): `POST /scenarios/:id/runs`; a switch "keep these starting values" sends `refresh: false`. Disabled with the first error when the scenario has error issues. The response's `baselineChanges` are listed; a reused run reads "identical inputs, showing the run from 11/08/26". It then navigates to `/retirement/runs/:id`.

### 5.5 Results page

Top to bottom:

1. **Header**: scenario name, "run 11/08/26 · 10,000 paths · seed 1", the dollars toggle (today's dollars by default), Run again (owner). A stale banner from `SimRunView.current` and the versions: "Your accounts or profile changed since this run" / "The engine or its data was updated", with Run again.
2. **`RunSummaryStrip`**: the success rate large with its tone; "9,402 of 10,000 simulated futures funded the plan (between 93.5% and 94.5% with this many paths)" or, for the historical model, "64 of 69 historical start years". One sentence states the test in use: "Funded means your planned spending was paid every year" (`constant_dollar`), "the spending the rule called for" (guardrails, floor and ceiling) or "your essential spending, healthcare and goals" (the percentage strategies). Tiles: median and 10th-percentile ending wealth in today's dollars; for strategies other than `constant_dollar` "Never below plan: 61%"; when any path failed, "In the futures that fell short, half had run out by 2053 (age 91); the earliest in 2046" and a small bar list of first failures by age (`failure.byYear`).
3. **`FanChart`**: 10th to 90th and 25th to 75th percentile bands with the median line, the selected path overlaid as a thin line, markers from `fanMarkers(input)` (retirement, Social Security, first RMD, Medicare), the toggle Portfolio / Spending, an HTML legend, and "Show as table". The x axis is the first person's age ("67", or "67 / 65" for two). The tooltip lists the five percentiles and "N% of futures still funded at this age". When `truncated`: "Later ages are omitted: too few simulated lifetimes reach them."
4. **`PercentilePicker`**: chips 5, 10, 25, 50, 75, 90, 95 (stored), a slider 1 to 99, and the shortcuts Worst (1), Best (99) and, when paths failed, Typical shortfall (percentile `max(1, round(100 × failures ÷ 2 ÷ paths))`). Caption: "Path #4,312, ranked 1,000th of 10,000 by ending wealth. One simulated future, not a forecast, and not the same percentile of every column." With the historical model: "the path that starts in 1966".
5. **`PathStory`**: the sentences of §3.12.
6. **`YearTable`**: one row per year; column groups that expand in place: year, ages and phase; income (total, then wages, Social Security per person, pensions and annuities, rental, other); spending (funded, then planned, core, healthcare, long-term care, goals, shortfall); withdrawals (total, then by account type, then by account; "of which RMD"; rate); conversions; taxes (total, then ordinary, capital gains, net investment income tax, penalties); contributions; ending balance (total, then by account type, then by account); inflation index and the year's return. The first shortfall year is marked "money ran out" in the bad tone and later ones are tinted; below-plan years carry the warning tone; events are chips ("raise skipped", "cut 10%", "raise 10%", "at the floor", "at the ceiling", "capped at 10%", "held at essentials", "topped up to essentials", "RMD above the rule"). "Export CSV" (`yearTableCsv`) writes the expanded table in the unit shown, built in the browser, with the disclaimer as the last line.
7. **`YearDrawer`** on a row: two lists that each add up to the row. "Where the money came from and went": income lines and withdrawals by account (RMD marked) = taxes + contributions + spending + surplus saved. "What you were taxed on": wages, pensions and annuities, pre-tax withdrawals (of which RMD), conversions, interest and coupons, dividends, realized gains, Social Security received and its taxable part with the percentage, AGI, deductions, taxable income, ordinary tax, capital gains tax, net investment income tax, penalties, total and the effective rate. Footnote: state tax, IRMAA and ACA are not modelled in this version.
8. **`AssumptionsPanel`**: the list of §3.13, collapsed by default, with the as-of date and the engine and data versions always visible, the engine's warnings as plain sentences, and the disclaimer.

States:

| State | What is shown |
| --- | --- |
| No profile | "Set up your retirement profile to run a plan" with a link (owner); "No retirement plan has been set up yet" (viewer) |
| Profile, no run of this scenario | "No run yet for this scenario" with a link to its Run settings |
| Queued or running | `RunProgress` (paths done of total, elapsed, Cancel for the owner), polling `GET /runs/:id` every second; `stalled` reads "the worker stopped responding"; the previous result stays visible underneath, marked "Previous run" |
| Failed | the run's code and message, as a plain sentence for the engine's input errors, with Run again (owner) |
| Cancelled | "This run was cancelled", Run again |
| `409 engine_changed` on a percentile | the seven stored percentiles stay usable; the slider explains that other percentiles need a new run |
| `409 not_reproducible` | "This path could not be reproduced; run the plan again" |
| No failures | the failure line, the bar list and the Typical shortfall shortcut are omitted |
| Fewer than 1,000 paths (not historical) | "Percentiles from N paths are coarse" |
| Query error | `ErrorText` |

### 5.6 History page

`RunsPage` on `GET /runs`: started, scenario, return model, strategy, paths, seed, success rate, median ending wealth, duration, engine and data versions, status, pinned, note. Active runs show the progress bar and Cancel. Row actions: Open, Pin and note (`PATCH /runs/:id`), Delete (owner; not while active). Empty: "No runs yet."

### 5.7 Chart builder (`components/charts/retirementOptions.ts`)

```ts
export interface FanChartInput {
  labels: string[];                                    // x categories: ages, "67" or "67 / 65"
  years: number[];
  bands: { p10: string[]; p25: string[]; p50: string[]; p75: string[]; p90: string[] };   // cents
  overlay?: { name: string; points: string[] };        // the selected path, cents
  markers?: Array<{ index: number; label: string }>;
  fundedBp?: number[];
  theme: ChartTheme;
}
export function fanChartOption(input: FanChartInput): EChartOption;
```

Built from what `EChart.tsx` already registers (`LineChart`, `GridComponent`, `TooltipComponent`, `MarkLineComponent`); no new ECharts module:

0. base: `p10`, `stack: "fan"`, line opacity 0, no area, `silent`.
1. `p25 − p10`, stacked, no line, area in the accent colour at opacity 0.15.
2. `p50 − p25`, stacked, opacity 0.30.
3. `p75 − p50`, stacked, opacity 0.30.
4. `p90 − p75`, stacked, opacity 0.15.
5. median: `p50`, not stacked, width 3, accent colour, `z` above the bands, carrying the `markLine` entries (`xAxis: index`, label at the top).
6. the overlay when given: not stacked, width 1.5, ink colour, dashed.

Differences are taken in cents with BigInt and converted with `centsToDollars` for plotting only; a negative difference is plotted as 0. The y axis starts at 0 with `axisMoney` labels; `animation: false`; grid and tooltip styling as `valueOverTimeOption`. The tooltip is built from the cents strings, never from the stacked values: "Age 67 (2029)", then 90th, 75th, median, 25th, 10th with `money()`, the path, and the funded share when given. The spending view calls the same builder with the spending bands.

### 5.8 Dashboard card (`RetirementCard`)

Placed after `InvestmentsCard`; it renders the inputs design's `DashboardView.retirement`. Text helpers (`successTone`, `successText`, `retirementStaleText`) go in `components/dashboard/dashboard.ts` with tests.

| State | Content |
| --- | --- |
| `retirement` is null | "Plan your retirement" with a link to `/retirement/profile` (owner); nothing for the viewer |
| `no_run` | "No simulation yet" with a link to the default scenario; when `issues > 0`: "N things to fix before a run" |
| `running` | "Simulating: 62%" with a progress bar; the previous run's figures stay underneath when there is one |
| `failed` | "The last run failed" with a link to History |
| `ready` | Hero "94%" with its tone; "9,402 of 10,000 simulated futures funded the plan"; "Median ending wealth $1.2M, 10th percentile $0 (today's dollars)"; "Base plan · run 11/08/26"; a warning line when stale ("Your accounts or profile changed since this run" / "The engine or its data was updated"); link "Open retirement plan"; the disclaimer as the card's title attribute |

### 5.9 Viewer

Every page renders for the viewer with editors, Refresh, Run, Cancel, Pin, Revert and Delete hidden (`useIsViewer`). Results, percentile paths and the frozen input are GETs. The API refuses the mutations in any case.

## 6. Jobs and services

This area adds no job, service or table. It supplies pure code to the simulation job owned by the inputs design (`retirement.simulate`) and to its path service.

| Piece | Where it runs | Trigger | Idempotency | Failure handling |
| --- | --- | --- | --- | --- |
| `decideSpending`, `planWithdrawals` | inside the engine, in worker threads (or inline) | every path-year | pure functions of the view and the path's strategy state | never throw on data; a broken contract is the engine's `EngineInvariantError` (permanent, no retry) |
| `toSimSummary`, `toFanSeries` | the worker, once after aggregation | job completion | pure | throw only on a malformed result; the job fails with `engine_error` |
| `toYearTable` | the worker for the seven stored percentiles; the API process for any other percentile (the inputs design's route 18) | job completion; percentile picker | pure, deterministic (L5) | the inputs design's `not_reproducible` and `engine_changed` checks |
| `deflateYearRow`, `pathStory`, chart builders | the browser | display | pure | none |
| The card | `getDashboard` (the inputs design's `retirementCard`) | every dashboard request | read-only | the inputs design's service; the component renders every state of §5.8 |

A run is capped at 15 minutes by the inputs design, below the runner's 30-minute stale sweep (`requeueStaleJobs(ctx.db, 30)`), so the heartbeat on `job.started_at` that both judges asked to carry from B is not needed.

## 7. Test cases

Conventions. Dollar amounts are asserted within 0.005 unless stated; amounts that come out of the gross-up (a withdrawal, and the tax and income lines that depend on it) within 0.02, because the solver stops at half a cent of net cash; percentages within 1e-6; cents on the wire exactly. Expected values are the exact roots rounded to the cent; none of them lies on a half-cent boundary (judge 1's finding against both designs; A's WD-2 and its 59,675.625 ceiling were changed for that reason). Hook cases run through the engine's public API with the `fixed` model, `asOf` on January 1, yields 0 and the real tax function unless a case says otherwise.

### 7.1 Strategies (`packages/retirement/src/strategies/*.test.ts`)

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| ST-1 | planned core with phases | base 60,000; `cpi` 1, 1.03, 1.0609; multipliers 1, 1, 0.9 | 60,000.00; 61,800.00; 57,288.60 |
| ST-2 | goal, survivor, long-term care, month window, reserve | the five examples of §3.2 | 152,487.71; 84,947.05 and 7,310.42; 59,894.85 and 61,392.22 with 119,789.70 and 61,392.22 set aside; 53,900.00; `P` = 780,000 |
| ST-3 | fixed percentage | 4%; `P` 1,234,567.89; then the reserve example | 49,382.72; 31,200.00 |
| ST-4 | guardrails trace | the table of §3.4c | `C` = 50,000; 45,000; 40,500; 41,715; 42,966.45; 48,680.99; `a` = 1; 0.873786; 0.763503; 0.763503; 0.763503; 0.839853; flags none, freeze+cut, freeze+cut, none, none, raise |
| ST-5 | final 15 years | year 1 of ST-4 with `yearsRemaining` = 15 | the freeze applies, no cut: `a` = 0.970874, `C` = 50,000.00 |
| ST-6 | no freeze after a gain | start 1,000,000; then `P` 800,000, `cpi` 1.03, previous return +5%, planned core 51,500 | ρ = 1.287500, cut, `C` = 46,350.00 |
| ST-7 | freeze needs positive inflation | ST-4 year 1 with inflation −1% (`cpi` 0.99, planned core 49,500) | ρ = 1.226006, no freeze, cut, `C` = 44,550.00 |
| ST-8 | income covers most of the need | the judges' case of §3.4c | year 1: `a` = 0.873786, `C` = 102,350.00 (draw 4,500.00); year 2: ρ = 1.064722, no rule, `C` = 105,420.50 |
| ST-9 | planned income step | the 1,500,000 example | year 1 ρ = 1.063830; year 2 ρ = 1.136364, no rule, `C` = 95,481.00 |
| ST-10 | pension without a cost-of-living clause | planned core 60,000, nominal pension 20,000, `P` 800,000; next year `P` = 782,800, `cpi` 1.03 | ρ = 1.052632, no rule, `planDraw` = 41,800, `C` = 61,800.00 |
| ST-11 | income covers everything at the start | the last example of §3.4c | 50,000.00; 51,500.00 with `a` = 0.873786; 52,413.93 |
| ST-12 | held at essentials | `a` = 0.5, planned core 50,000, essential core 40,000, no income | `C` = 40,000.00, flag essentials |
| ST-13 | empty portfolio | started; `P` = 0 | no rule, `a` unchanged, `C` = planned core |
| ST-14 | VPW values | the table of §3.4d | every row to four decimals of a percent; the cap flag at 89 |
| ST-15 | floor and ceiling | the table of §3.4e and the essentials line | 45,000.00; 39,397.50 (floor); 57,288.60 (ceiling); 49,500.00; 90,897.50; with `rateBp` 400 given: first year 40,000.00 |
| ST-16 | phases | a couple with one still working; then both retired; then accumulation | transition returns the constant decision for all five kinds and leaves the state untouched; guardrails and floor-and-ceiling start in the first retirement-phase year; accumulation returns `spend = floor = 0` with the goal as `lump` |
| ST-17 | purity and rules | call `decideSpending` twice on equal state and view; scan the sources | equal decisions; no banned `Math` call; no allocation in 10,000 calls (heap unchanged within noise) |

### 7.2 Withdrawals (`packages/retirement/src/withdrawals/*.test.ts`)

| # | Case | Expected |
| --- | --- | --- |
| WD-1 | married, both 60, 2026, pre-tax only, target 100,000 | pre-tax 108,681.82; tax 8,681.82 |
| WD-2 | single 70, 2026, Social Security 30,000, target 61,000, pre-tax only | pre-tax 34,005.14; taxable benefits 17,254.37; taxable income 27,109.51; tax 3,005.14 |
| WD-3 | married, both 67, 2027, Social Security 50,000, target 90,000, pre-tax only | pre-tax 41,871.17; taxable benefits 25,440.49; taxable income 18,711.66; tax 1,871.17 |
| WD-4 | single 62, 2027, pre-tax only, targets 60,000 and 100,000 | 65,627.27 with tax 5,627.27; 116,525.00 with tax 16,525.00 |
| WD-5 | R1 year 2028 (§7.6): gains reach the 15% band while the senior deduction phases out | taxable 133,550.95; gain 54,056.34; ordinary tax 8,548.61; gains tax 3,752.34 |
| WD-6 | single 50, 2026, target 40,000; cash 10,000; Roth 60,000 of which 15,000 free; pre-tax 500,000 | cash 10,000; Roth 15,000; pre-tax 16,737.50; income tax 63.75; additional tax 1,673.75 |
| WD-7 | the tier example of §3.5 as a target of 85,648 | cash 5,000; taxable 20,000; Roth 30,000; reserve 5,000; pre-tax 30,000; tax 1,352.00 + 3,000.00 |
| WD-8 | reserve and HSA tiers: single 66, 2027, cash 30,000 with a reserve of 10,000, HSA 5,000, a taxable account of 8,000 at basis 8,000, Roth 20,000; healthcare 8,000; core 40,000, then 52,000 | need 48,000: cash 20,000, HSA 5,000, taxable 8,000, Roth 15,000, reserve untouched; need 60,000: Roth 20,000 and 7,000 of the reserve; tax 0 in both |
| WD-9 | HSA beyond healthcare: single 62, 2027, pre-tax 30,000, HSA 10,000, no healthcare, target 35,448 | pre-tax 30,000; HSA 10,000 non-qualified; taxable income 23,400; tax 2,552.00 + 2,000.00 |
| WD-10 | shortfall (§3.6) | RMD 990.10; everything drawn; taxable benefits 3,500; tax 0; funded 44,000.00; shortfall 16,000.00; failure year |
| WD-11 | gross year, RMD below the rule (§3.6) | gross 75,832.60; RMD 48,780.49; taxable 27,052.11; tax 3,267.27; funded 122,565.33; nothing saved |
| WD-12 | gross year, RMD above the rule | no withdrawal beyond the RMD; 9,780.49 saved (taxable basis + 9,780.49); funded 85,732.73 |
| WD-13 | gross year with a top-up | floor 50,000: withdrawal 40,000, tax 3,956.00, funded 60,044.00; floor 65,000: withdrawal 45,713.64, tax 4,713.64, funded 65,000.00, event `topped_up` |
| WD-14 | surplus (§3.6) | no withdrawal; tax 9,532.10; 31,768.72 saved to the cash account (36,768.72 after) |
| WD-15 | taxable runs out mid-year: R1 year 2031 | taxable 43,539.05; pre-tax 21,062.59 and 8,834.51 (pro rata to the start-of-year balances 869,376.38 and 364,651.88); tax 5,520.10 |
| WD-16 | conversion: R1 year 2027 | pre-tax of A 900,000 → 820,000 before returns; Roth + 80,000; tax 4,696.00 with no gains tax |
| WD-17 | a goal before retirement (§3.6) | taxable 21,621.62; added tax 1,621.62; wages pay the baseline 15,340.00 |
| WD-18 | pro rata | two pre-tax accounts of 600,000 and 200,000, 40,000 from the tier: 30,000 and 10,000 |
| WD-19 | solver cost and contract | each of WD-1 to WD-9 uses at most 7 `assess` calls; a seeded sweep of 5,000 random household-years never exceeds 24, and ends with `|net| ≤ 0.005`, or with a surplus and no withdrawal beyond `wd`, or with everything drawn |
| WD-20 | monotonicity | for 1,000 seeded household-years, `net(x + 1) > net(x)` at 50 points each (the uniqueness the solver rests on, checked against the real tax function) |
| WD-21 | cash identity | for every row of R1 and R2 and for 1,000 seeded settles: income + withdrawals = tax + contributions + funded + surplus, within 0.005 |

### 7.3 Outputs (`packages/retirement/src/results/*.test.ts`, `packages/shared/src/retirement/results.test.ts`)

| # | Case | Expected |
| --- | --- | --- |
| OUT-1 | rank rule | five paths: failed in year 12 (ends 0), failed in year 20 (ends 0), funded ending 100,000, 500,000, 900,000 → that order; percentile 10 → the year-12 path; 50 → the 100,000 path; 90 → the 900,000 path. A path that failed in year 10 but ends with 50,000 ranks after both paths that end with 0 |
| OUT-2 | success rounding | 64 of 69 → 9275; 65 of 69 → 9420 |
| OUT-3 | `fundedShareBp` | 4 paths, first failures in plan years 3 and 5 → 10000, 10000, 10000, 7500, 7500, 5000 |
| OUT-4 | failure summary | `byYear` = [0, 0, 1, 0, 2, 1] from start year 2027 → `paths` 4, `firstYear` 2029, `medianYear` 2031 |
| OUT-5 | fan cut | 1,000 paths with alive counts 1000, 400, 99 → two years, `truncated` true; 69 paths all alive → no cut |
| OUT-6 | `addUp` | (187355006, [3678820, 90412771, 93263414]) → [3678820, 90412771, 93263415]; equal parts [9346, 9346, 9346] against 28037 → [9345, 9346, 9346]; parts that already sum are returned unchanged |
| OUT-7 | `deflateYearRow` | a flow of 98,400.00 at `cpiStart` "1.025" → 96,000.00; R1's last row keeps `totalReal` = 1,115,486.01 and its by-account real balances sum to it |
| OUT-8 | rows add up | for every row of R1 and R2, in both units: income, withdrawals, taxes and ending balances equal the sums of their parts in cents; previous total + contributions + surplus − withdrawals + growth = total |
| OUT-9 | derived figures | R1 2027: `withdrawalRateBp` 685; a row with guaranteed income 72,516 against essentials 81,948.75 → `essentialCoverageBp` 8849 |
| OUT-10 | wire validity | `toSimSummary`, `toFanSeries` and `toYearTable` outputs parse with their schemas; no number in them is a non-integer; bands are non-decreasing across percentiles |
| OUT-11 | story | a table whose taxable bucket ends at zero in 2037, pre-tax in 2049 and Roth in 2053 with a first shortfall in 2053 → outcome failed, failure year 2053, depletion in that order; R1 → funded, depletion lists cash (2027) and taxable (2031), `belowPlanYears` 0 |
| OUT-12 | stored table equals re-simulation | for a 200-path run the stored 50th-percentile table deep-equals `toYearTable(simulatePathDetail(…))` for the same path |

### 7.4 Web and API

| # | Case | Expected |
| --- | --- | --- |
| CH-1 | `fanChartOption` series | six series without an overlay, seven with; series 0 stacked and invisible; the median unstacked with width 3 |
| CH-2 | band data | p10 "100000", p25 "150000", p50 "225000", p75 "300000", p90 "500000" → 1000, 500, 750, 750, 2000 and median 2250 |
| CH-3 | tooltip | "Age 67 (2029)" then "90th: $5,000.00", "75th: $3,000.00", "Median: $2,250.00", "25th: $1,500.00", "10th: $1,000.00" from the cents strings; "" for an empty parameter list |
| CH-4 | markers | a marker at index 2 → one `markLine` entry with `xAxis: 2` on the median series; the y axis starts at 0 |
| CH-5 | bad input | p25 below p10 → that difference plotted as 0; the tooltip still shows the true strings |
| UI-1 | `successTone` | 9000 good; 8999 warning; 7500 warning; 7499 bad |
| UI-2 | `changeLabel` | retirement age 65 → 62: "Retire at 62 instead of 65"; base spending 8,400,000 → 7,560,000: "Spending −10%"; an unknown path → the path with both values |
| UI-3 | `strategyHints` | included total 2,742,857.00, base 96,000.00 → "3.5% of today's portfolio"; ages 70 and 64 at 50% stocks → "4.7%" |
| UI-4 | `yearTableCsv` | R1's table in today's dollars: 21 data rows, the header of the expanded groups, the disclaimer as the last line |
| UI-5 | card texts | each state of §5.8; `successBp` 9420 → "94%" |
| API-1 | results | on the inputs design's fixture run: `GET /runs/:id` returns a `summary` and `fan` that parse; the viewer reads them |
| API-2 | paths | percentile 50 is `stored`; percentile 37 is `resimulated` with the same number of rows and parses as `YearTable`; 0 and 100 → 400 |
| API-3 | dashboard | no profile → `retirement: null`; after the run → state `ready` with the run's `successBp` |

### 7.5 The hand-calculated suite across all areas (gate, part A)

`packages/retirement/src/gate.test.ts` re-exports the area suites; the gate requires at least the cases below. The owning areas' designs carry the full derivations of their own cases; where they define more, the suite is the union. Tax parameters: 2026 from Rev. Proc. 2025-32, 2027 from Rev. Proc. 2026-35. All were recomputed during the merge.

| # | Area | Case | Expected |
| --- | --- | --- | --- |
| HC-T1 | tax | 2026, joint, under 65, wages 150,000 | taxable income 117,800; tax `11,600 + 22% × 17,000 = 15,340.00` |
| HC-T2 | tax | 2026, single, under 65, ordinary 60,000 | taxable income 43,900; tax `1,240 + 12% × 31,500 = 5,020.00` |
| HC-T3 | tax | 2026, joint, ordinary 80,000 + long-term gains 60,000 | ordinary tax on 47,800 = 5,240.00; gains 51,100 at 0%, 8,900 at 15% = 1,335.00; total 6,575.00 |
| HC-T4 | tax | 2026, joint, ordinary 200,000 + gains 100,000 | 26,340 + 15,000 + net investment income tax `3.8% × 50,000 = 1,900` → 43,240.00 |
| HC-T5 | tax | Social Security 40,000 with other income 30,000, joint; 24,000 with 20,000, single; 30,000 with 100,000, single | taxable benefits 11,100.00; 3,500.00; 25,500.00 (the 85% cap) |
| HC-T6 | tax | 2026, single, 67, ordinary 100,000 | standard 18,150; senior deduction `6,000 − 6% × 25,000 = 4,500`; taxable income 77,350; tax `5,800 + 22% × 26,950 = 11,729.00` |
| HC-T7 | tax | 2026, joint, both 68, ordinary 190,000 | senior `2 × (6,000 − 6% × 40,000) = 7,200`; taxable income 147,300; tax `11,600 + 22% × 46,500 = 21,830.00` |
| HC-T8 | tax | 2027, joint, both 65, ordinary 92,000 | deductions `33,200 + 3,400 + 12,000`; taxable income 43,400; tax `2,560 + 12% × 17,800 = 4,696.00` |
| HC-T9 | tax | 2026, single, 67, pension 40,000, Social Security 24,000, qualified dividends 5,000, long-term gains 10,000 | taxable benefits 20,400; AGI 75,400; senior `6,000 − 6% × 400 = 5,976`; taxable income 51,274; ordinary on 36,274 = 4,104.88; gains 13,176 at 0%, 1,824 at 15% = 273.60; total 4,378.48 |
| HC-T10 | tax | 2027, joint, under 65, wages 240,000, interest 10,000, qualified dividends 20,000, gains 30,000 | taxable income 266,800; ordinary on 216,800 = 36,779.00; gains at 15% = 7,500.00; net investment income tax `3.8% × min(60,000, 50,000) = 1,900.00`; total 46,179.00 |
| HC-T11 | tax | 2027, joint, under 65, wages 600,000, gains 200,000 | ordinary on 566,800 = 133,893.00; gains 66,800 at 15% and 133,200 at 20% = 36,660.00; net investment income tax 7,600.00; total 178,153.00 |
| HC-T12 | tax | 2027, joint, both 70, pre-tax 20,000, Social Security 40,000, dividends 6,000, gains 30,000 | taxable benefits 33,200; taxable income 40,600; ordinary on 4,600 = 460.00; every gain at 0%; total 460.00 |
| HC-T13 | tax | 2029 (senior deduction expired; 2027 thresholds unindexed for the test), joint, both 68, ordinary 100,000 | taxable income 63,400; tax `2,560 + 12% × 37,800 = 7,096.00` |
| HC-T14 | tax data | tax at a threshold equals the amount printed in the revenue procedure | 2026 joint at 211,400: 35,932; at 768,700: 206,583.50; 2026 single at 640,600: 192,979.25; 2027 joint at 104,050: 11,974; at 793,650: 213,290.50; 2027 single at 661,375: 199,237.75 |
| HC-T15 | tax data | indexing after the last published year | 2028 at 2.5% inflation: joint standard deduction with two aged additions `36,600 × 1.025 = 37,515.00` |
| HC-T16 | penalties | pre-tax 16,737.50 at 50; HSA non-medical 10,000 at 60; 2027 single 57 with 50,000 early from pre-tax | 1,673.75; 2,000.00; income tax 3,752.00 + 5,000.00 = 8,752.00 |
| HC-R1 | RMD | the Pub. 590-B example: 100,000 at 75 | `100,000 ÷ 24.6 = 4,065.04` |
| HC-R2 | RMD | 500,000 at 73; 250,000 at 80; 100,000 at 100; 50,000 at 121 | 18,867.92; 12,376.24; 15,625.00; 25,000.00 |
| HC-R3 | RMD | first RMD year | born 1951 → 2024; 1958 → 2031; 1959 → 2032; 1960 → 2035; 1961 → 2036 |
| HC-S1 | Social Security | claim factors, full retirement age 67, benefit 3,000 | 62 → 2,100; 64 → 2,400; 65 → 2,600; 67 → 3,000; 70 → 3,720 |
| HC-S2 | Social Security | spousal | worker 3,000 and spouse's own 800, both at full retirement age → the spouse receives 1,500; a spousal benefit of 1,000 claimed at 62 → 650.00 |
| HC-S3 | Social Security | survivor and cost-of-living | the survivor receives the larger benefit (R2, 2035: 36,552.09); 36,000 a year in plan-start dollars at 2.5% inflation → 37,822.50 in the third plan year |
| HC-E1 | engine | a fixed historical path | the engine design's T19 (cohort 1973, five years) and the 1966 path of §7.8 |
| HC-E2 | engine | a whole year by hand | the engine design's T34 (W1): withdrawal 29,267.56, tax 7,527.72, end total 1,019,977.21 |
| HC-E3 | engine | determinism | the engine design's T41 and T43: the same result with 1 and 4 threads and any chunking; a path re-simulated alone equals its bulk value |
| HC-D1 | inputs | seeds and freezing | the inputs design's cases 7 (spending resolution) and 11 (full resolution of the fixture) |
| HC-W | this area | ST-1 to ST-17, WD-1 to WD-21, OUT-1 to OUT-12 | as above |

### 7.6 Reference scenario R1: a deterministic household, to the dollar (gate, part B)

Reference sheet (everything the independent calculator may use):

- `asOf` 2027-01-01, plan years 2027 to 2047. Persons A and B, both born in January 1962, both already retired, married filing jointly throughout, both alive through 2047 (fixed age 85).
- Markets: the `fixed` model, every asset 5.0% a year, inflation 2.5% a year (`cpi` = 1 in 2027). Yields 0 (no dividends or coupons are distributed). No fund costs.
- Accounts: a cash account of 40,000; one taxable account of 400,000 at basis 250,000, all stocks; pre-tax of A 900,000; pre-tax of B 300,000; Roth of A 150,000; no HSA. No cash reserve.
- Income: B's pension 12,000 a year, nominal, no cost-of-living clause. Social Security: A 3,000 and B 1,800 a month at full retirement age in 2027 dollars, both claimed at 67 years 0 months, so paid for all of 2029 and every later year; the annual amount is `12 × benefit × cpi`.
- Spending: `constant_dollar`; base 130,000 a year; multiplier 1.0 to 2036, 0.9 for 2037 to 2041, 0.7 from 2042; one goal of 40,000 (today's dollars) in 2030; no separate healthcare, no long-term care.
- Roth conversions: A converts 80,000 in 2027 and 110,000 in 2028 (nominal).
- Order: cash, the taxable account (gain = sale × (1 − basis ÷ balance)), pre-tax pro rata to the two accounts' balances after their RMDs, Roth.
- RMDs from 2037 (age 75): the balance at the start of the year ÷ the Uniform Lifetime divisor (75: 24.6; 76: 23.7; 77: 22.9; 78: 22.0; 79: 21.1; 80: 20.2; 81: 19.4; 82: 18.5; 83: 17.7; 84: 16.8; 85: 16.0).
- Federal tax, 2027 parameters (Rev. Proc. 2026-35), joint: 10% to 25,600, 12% to 104,050, 22% to 218,250, 24% to 416,650; standard deduction 33,200 plus 1,700 per spouse 65 or older; gains taxed at 0% up to 102,100 of taxable income and 15% up to 633,600, stacked on top of ordinary taxable income. For years after 2027 each of these figures is multiplied by `cpi` of the year, unrounded. Not indexed: the Social Security thresholds 32,000 and 44,000; the net investment income threshold 250,000; the senior deduction of 6,000 per person 65 or older, in 2027 and 2028 only, reduced by 6% of AGI above 150,000 (per person). Taxable Social Security, with `PI` = other income + half of benefits: 0 up to 32,000; `min(0.5 × benefits, 0.5 × (PI − 32,000))` up to 44,000; above, `min(0.85 × benefits, 0.85 × (PI − 44,000) + min(0.5 × benefits, 6,000))`. Tax is paid in the year.
- All flows happen at the start of the year in the order income, RMDs, conversions, withdrawals and tax, spending; then returns. Cash beyond the year's spending and tax is deposited in the taxable account at the start of the year (basis rises by the deposit).

Worked years:

- 2027. Without any withdrawal: ordinary income `12,000 + 80,000 = 92,000`; deductions `36,600 + 12,000`; taxable income 43,400; tax `2,560 + 12% × 17,800 = 4,696.00`. Needed from the portfolio: `130,000 + 4,696 − 12,000 = 122,696`. Cash 40,000; taxable 82,696 at gain fraction `1 − 250,000 ÷ 400,000 = 0.375`, gain 31,011, which stacks from 43,400 to 74,411, under 102,100: no further tax. End: taxable `317,304 × 1.05 = 333,169.20` (basis 198,315.00); pre-tax A `820,000 × 1.05 = 861,000`; B 315,000; Roth `230,000 × 1.05 = 241,500`; total 1,750,669.20.
- 2028 (`cpi` 1.025). Without a withdrawal: ordinary 122,000; deductions `37,515 + 12,000`; taxable income 72,485; tax `2,624 + 12% × 46,245 = 8,173.40`. Needed: `133,250 + 8,173.40 − 12,000 = 129,423.40`, all from taxable at gain fraction `1 − 198,315 ÷ 333,169.20 = 0.404762`. Solution 133,550.95: gain 54,056.34; AGI 176,056.34; senior deduction `2 × (6,000 − 6% × 26,056.34) = 8,873.24`; taxable income 129,668.10, of which ordinary 75,611.76: tax `2,624 + 12% × 49,371.76 = 8,548.61`; gains: `104,652.50 − 75,611.76 = 29,040.74` at 0%, 25,015.60 at 15% = 3,752.34; total 12,300.95; `133,550.95 − (12,300.95 − 8,173.40) = 129,423.40`.
- 2031 (`cpi` 1.1038129). Needed `143,495.68 − 12,000 − 63,579.62 = 67,916.05` plus tax. The taxable account is emptied: 43,539.05 (gain 21,151.75); then pre-tax 29,897.10. Provisional income `41,897.10 + 21,151.75 + 31,789.81 = 94,838.66`; taxable Social Security `0.85 × 50,838.66 + 6,000 = 49,212.86`; taxable income 71,862.16, of which ordinary 50,710.41: tax `2,825.76 + 12% × 22,452.80 = 5,520.10`; gains at 0%. `43,539.05 + 29,897.10 − 5,520.10 = 67,916.05`.
- 2037 (`cpi` 1.2800845, age 75). RMDs `781,497.56 ÷ 24.6 = 31,768.19` and `327,791.92 ÷ 24.6 = 13,324.87`. Tax with the RMDs alone 6,389.50. Needed beyond them: `149,769.89 + 6,389.50 − 12,000 − 73,732.87 − 45,093.07 = 25,333.46` after tax. Further pre-tax 30,725.39: taxable Social Security reaches its 85% cap, 62,672.94; taxable income 103,640.30; tax `3,277.02 + 12% × 70,870.14 = 11,781.43`; `30,725.39 − (11,781.43 − 6,389.50) = 25,333.46`.
- 2042 (`cpi` 1.4482982, age 80). RMDs `33,168.88 + 13,912.38`; tax 6,500.11; `83,421.97 + 12,000 + 47,081.26 − 6,500.11 − 131,795.13 = 4,207.99` is left over and saved to the taxable account, 4,418.39 at year end.

Expected table (dollars; combined columns are rounded sums, so they can differ by a cent from the sum of the rounded per-account cells; the fixture carries every column of the year row by account):

| Year | Age | Social Security | Core spending | Goal | RMD (A+B) | Conversion | From cash | From taxable | From pre-tax (incl. RMD) | Realized gain | Taxable SS | Total tax | Surplus saved | End taxable | End pre-tax (A+B) | End Roth | End total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2027 | 65 | 0.00 | 130,000.00 | 0.00 | 0.00 | 80,000.00 | 40,000.00 | 82,696.00 | 0.00 | 31,011.00 | 0.00 | 4,696.00 | 0.00 | 333,169.20 | 1,176,000.00 | 241,500.00 | 1,750,669.20 |
| 2028 | 66 | 0.00 | 133,250.00 | 0.00 | 0.00 | 110,000.00 | 0.00 | 133,550.95 | 0.00 | 54,056.34 | 0.00 | 12,300.95 | 0.00 | 209,599.16 | 1,119,300.00 | 369,075.00 | 1,697,974.16 |
| 2029 | 67 | 60,516.00 | 136,581.25 | 0.00 | 0.00 | 0.00 | 0.00 | 64,236.71 | 0.00 | 27,821.34 | 28,167.44 | 171.46 | 0.00 | 152,630.58 | 1,175,265.00 | 387,528.75 | 1,715,424.33 |
| 2030 | 68 | 62,028.90 | 139,995.78 | 43,075.62 | 0.00 | 0.00 | 0.00 | 111,164.82 | 0.00 | 51,147.10 | 48,637.32 | 2,122.31 | 0.00 | 43,539.05 | 1,234,028.25 | 406,905.19 | 1,684,472.49 |
| 2031 | 69 | 63,579.62 | 143,495.68 | 0.00 | 0.00 | 0.00 | 0.00 | 43,539.05 | 29,897.10 | 21,151.75 | 49,212.86 | 5,520.10 | 0.00 | 0.00 | 1,264,337.70 | 427,250.45 | 1,691,588.15 |
| 2032 | 70 | 65,169.11 | 147,083.07 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 82,332.70 | 0.00 | 55,393.75 | 12,418.75 | 0.00 | 0.00 | 1,241,105.25 | 448,612.97 | 1,689,718.22 |
| 2033 | 71 | 66,798.34 | 150,760.14 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 84,691.02 | 0.00 | 56,778.59 | 12,729.22 | 0.00 | 0.00 | 1,214,234.94 | 471,043.62 | 1,685,278.56 |
| 2034 | 72 | 68,468.30 | 154,529.15 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 87,108.30 | 0.00 | 58,198.05 | 13,047.45 | 0.00 | 0.00 | 1,183,482.98 | 494,595.80 | 1,678,078.78 |
| 2035 | 73 | 70,180.01 | 158,392.38 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 89,586.00 | 0.00 | 59,653.01 | 13,373.63 | 0.00 | 0.00 | 1,148,591.83 | 519,325.59 | 1,667,917.41 |
| 2036 | 74 | 71,934.51 | 162,352.19 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 92,125.65 | 0.00 | 61,144.33 | 13,707.97 | 0.00 | 0.00 | 1,109,289.48 | 545,291.87 | 1,654,581.35 |
| 2037 | 75 | 73,732.87 | 149,769.89 | 0.00 | 45,093.07 | 0.00 | 0.00 | 0.00 | 75,818.45 | 0.00 | 62,672.94 | 11,781.43 | 0.00 | 0.00 | 1,085,144.58 | 572,556.46 | 1,657,701.04 |
| 2038 | 76 | 75,576.19 | 153,514.14 | 0.00 | 45,786.69 | 0.00 | 0.00 | 0.00 | 78,013.92 | 0.00 | 64,239.76 | 12,075.97 | 0.00 | 0.00 | 1,057,487.20 | 601,184.28 | 1,658,671.48 |
| 2039 | 77 | 77,465.60 | 157,351.99 | 0.00 | 46,178.48 | 0.00 | 0.00 | 0.00 | 80,264.26 | 0.00 | 65,845.76 | 12,377.87 | 0.00 | 0.00 | 1,026,084.08 | 631,243.50 | 1,657,327.58 |
| 2040 | 78 | 79,402.24 | 161,285.79 | 0.00 | 46,640.19 | 0.00 | 0.00 | 0.00 | 82,570.87 | 0.00 | 67,491.90 | 12,687.31 | 0.00 | 0.00 | 990,688.87 | 662,805.67 | 1,653,494.54 |
| 2041 | 79 | 81,387.29 | 165,317.94 | 0.00 | 46,952.08 | 0.00 | 0.00 | 0.00 | 84,935.14 | 0.00 | 69,179.20 | 13,004.50 | 0.00 | 0.00 | 951,041.41 | 695,945.96 | 1,646,987.37 |
| 2042 | 80 | 83,421.97 | 131,795.13 | 0.00 | 47,081.26 | 0.00 | 0.00 | 0.00 | 47,081.26 | 0.00 | 54,273.41 | 6,500.11 | 4,207.99 | 4,418.39 | 949,158.16 | 730,743.26 | 1,684,319.81 |
| 2043 | 81 | 85,507.52 | 135,090.01 | 0.00 | 48,925.68 | 0.00 | 0.00 | 0.00 | 48,925.68 | 0.00 | 56,727.52 | 6,838.37 | 4,504.82 | 9,369.38 | 945,244.11 | 767,280.42 | 1,721,893.90 |
| 2044 | 82 | 87,645.21 | 138,467.26 | 0.00 | 51,094.28 | 0.00 | 0.00 | 0.00 | 51,094.28 | 0.00 | 59,479.35 | 7,246.82 | 5,025.41 | 15,114.52 | 938,857.32 | 805,644.44 | 1,759,616.28 |
| 2045 | 83 | 89,836.34 | 141,928.94 | 0.00 | 53,042.79 | 0.00 | 0.00 | 0.00 | 53,042.79 | 0.00 | 62,066.81 | 7,604.59 | 5,345.60 | 21,483.13 | 930,105.26 | 845,926.66 | 1,797,515.05 |
| 2046 | 84 | 92,082.25 | 145,477.17 | 0.00 | 55,363.41 | 0.00 | 0.00 | 0.00 | 55,363.41 | 0.00 | 64,993.85 | 8,043.09 | 5,925.40 | 28,778.96 | 918,478.95 | 888,222.99 | 1,835,480.90 |
| 2047 | 85 | 94,384.31 | 149,114.10 | 0.00 | 57,404.93 | 0.00 | 0.00 | 0.00 | 57,404.93 | 0.00 | 67,707.52 | 8,417.72 | 6,257.43 | 36,788.20 | 904,127.71 | 932,634.14 | 1,873,550.06 |

Ending wealth in today's dollars: `1,873,550.06 ÷ 1.025^21 = 1,115,486.01`. The path succeeds. Lifetime spending in today's dollars 2,471,000.00; lifetime federal tax in today's dollars 153,633.07. The gross-up needs at most 5 `assess` calls in any year. Corrections against Design A's table, found by judge 2 and by the recomputation: 2030 "End pre-tax" is 1,234,028.25 (A summed two separately rounded halves), and the combined RMD and pre-tax cells of 2035, 2037, 2038, 2040 and 2042 to 2047 are the rounded sums.

R1 exercises: the order through cash, taxable, pre-tax pro rata and no Roth draw; average-cost gains; the 0% and 15% gains bands; the senior deduction with its phase-out and its expiry; benefits phasing in to the 85% cap; indexing after the last published year; nominal conversions; RMDs from 75; phase multipliers; a goal year; surplus saved to a taxable account that had been emptied.

### 7.7 Reference scenario R2: yields, the HSA, a first death (gate, part B)

Graft asked for by both judges: Design B's household, re-specified and recomputed under the final rules (the engine design's trades, yields and basis reset; this area's order and reserve). Design B's own figures are not carried over: its pooled 4.8% return, same-year cash interest and unchanged basis at death are not the engine's rules.

Reference sheet:

- `asOf` 2027-01-01, plan years 2027 to 2056. Person 1 born 1958, alive through 2034 (fixed age 76); person 2 born 1961, alive through 2056 (fixed age 95). Both retired and both already receiving Social Security: 30,000 and 18,000 a year in 2027 dollars, × `cpi`.
- Markets: the `fixed` model, stocks 6%, bonds 4%, bills 2%, inflation 2.5% every year. No fund costs.
- Accounts: cash (joint) 40,000; taxable (joint) stocks 300,000 at basis 150,000 and bonds 200,000 at basis 190,000, target 60/40; pre-tax of person 1 400,000 at 60/40; pre-tax of person 2 150,000 at 60/40; Roth of person 1 60,000 and Roth of person 2 40,000, all stocks; HSA of person 2 20,000 at 60/40. Cash accounts hold bills.
- Each year every account is brought to its target in the same trades as the year's flows: with `V'` the balance after the flow, an asset above `target × V'` is sold down to it and one below is bought up to it. In the taxable account a sale realizes `sale × (1 − basis ÷ balance)` of that asset (long-term) and removes basis in proportion; a purchase adds its amount to basis.
- Yields in the taxable account, on the balances after the trades: dividends 1.5% of stocks (qualified) and coupons 3% of bonds (ordinary), taxed in the same year and added to basis. Interest on the cash account is its whole 2% return; it is ordinary income (and net investment income) of the following year.
- Spending: `constant_dollar`; base 99,600; share after the first death 70%; healthcare 6,000 a year per living person; a goal of 30,000 (today's dollars) in 2030; a long-term care reserve of 60,000 for person 2 spent over the last 2 years (2055 and 2056: 30,000 × `cpi` each). Cash reserve 20,000 (today's dollars, × `cpi`).
- Roth conversions: person 1 converts 20,000 in today's dollars in 2028 and in 2029 (20,500.00 and 21,012.50), pre-tax to Roth.
- RMDs: person 1 from 2031 (age 73), person 2 from 2036 (age 75); divisors 73: 26.5; 74: 25.5; 75: 24.6; 76: 23.7; 77: 22.9; 78: 22.0; 79: 21.1; 80: 20.2; 81: 19.4; 82: 18.5; 83: 17.7; 84: 16.8; 85: 16.0; 86: 15.2; 87: 14.4; 88: 13.7; 89: 12.9.
- Order: cash above the reserve; the HSA up to the year's healthcare; the taxable account; pre-tax pro rata; Roth pro rata; the reserve.
- Federal tax as in R1, with the single filer's 2027 figures from 2035: 10% to 12,800, 12% to 52,025, 22% to 109,125; standard deduction 16,600 plus 2,100 at 65 or older; gains at 0% up to 51,050; Social Security thresholds 25,000 and 34,000 (second-tier addition `min(0.5 × benefits, 4,500)`); net investment income threshold 200,000.
- The first death: person 1 dies at the end of 2034. After that year's returns, each holding of the joint taxable account has its basis moved half-way to its value (stocks 35,316.23 → 61,059.81 on 86,803.39; bonds 50,880.08 → 53,828.57 on 56,777.06). From 2035: single filing; person 1's accounts belong to person 2 and follow person 2's RMD age (none in 2035, from 2036 on both pre-tax accounts); the survivor receives the larger benefit (30,000 × `cpi`); core spending × 70%; healthcare for one. The 2034 row shows the basis before the reset.

Worked years:

- 2027. Need `99,600 + 12,000 = 111,600`; Social Security 48,000; 63,600 from the portfolio if no tax is due. Cash above the reserve 20,000; HSA 12,000; taxable 31,600. Trades in the taxable account: `V' = 468,400`, targets 281,040 and 187,360, so 18,960 of stocks and 12,640 of bonds are sold: gain `18,960 × 0.5 + 12,640 × 0.05 = 10,112.00`. Dividends `1.5% × 281,040 = 4,215.60`; coupons `3% × 187,360 = 5,620.80`. Provisional income `19,948.40 + 24,000 = 43,948.40`: taxable Social Security `0.5 × 11,948.40 = 5,974.20`; AGI 25,922.60, under the deductions 48,600: tax 0. End of year: basis `150,000 − 9,480 + 4,215.60 = 144,735.60` and `190,000 − 12,008 + 5,620.80 = 183,612.80`; taxable `281,040 × 1.06 + 187,360 × 1.04 = 492,756.80`; cash `20,000 × 1.02 = 20,400` (400 of interest carried into 2028); HSA `4,800 × 1.06 + 3,200 × 1.04 = 8,416.00`; pre-tax 420,800 and 157,800; Roth 63,600 and 42,400; total 1,206,172.80.
- 2028 (`cpi` 1.025). Need 114,390.00; Social Security 49,200; conversion 20,500. Cash 20,400 is below the reserve 20,500; HSA 8,416 (all of it, under the healthcare of 12,300); taxable 57,650.81. Gain 20,141.40, dividends 3,915.95, coupons 5,221.27, interest 400. Ordinary income `20,500 + 5,221.27 + 400 = 26,121.27`; taxable Social Security 32,161.83; AGI 82,340.46; deductions `37,515 + 12,000 = 49,515`; taxable income 32,825.46, of which gains and dividends 24,057.35 at 0% and ordinary 8,768.10: tax 876.81. `49,200 + 8,416 + 57,650.81 − 876.81 = 114,390.00`.
- 2035 (`cpi` 1.218403, single). Need `84,947.05 + 7,310.42 = 92,257.47`; Social Security 36,552.09; taxable 55,705.38 with a gain of only 11,229.85 after the reset (22,718.51 on 57,232.77 the year before). AGI 16,940.07, under the deductions `18,700 × 1.218403 = 22,784.13`: tax 0.
- 2056 (`cpi` 2.0464074). Need `(69,720 + 6,000 + 30,000) × 2.0464074 = 216,346.19` (core 142,675.52, healthcare 12,278.44, long-term care 61,392.22); Social Security 61,392.22. The Roth accounts are emptied (143,709.48) and 11,244.49 comes from the reserve; 24,757.85 of cash is left after the year's 2%.

Expected tables (the fixture carries every column by account):

| Year | Ages | Filing | Spending need | Social Security | RMD | Conversion | From cash | From HSA | From taxable | From pre-tax (incl. RMD) | From Roth | Total tax |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2027 | 69 / 66 | joint | 111,600.00 | 48,000.00 | 0.00 | 0.00 | 20,000.00 | 12,000.00 | 31,600.00 | 0.00 | 0.00 | 0.00 |
| 2028 | 70 / 67 | joint | 114,390.00 | 49,200.00 | 0.00 | 20,500.00 | 0.00 | 8,416.00 | 57,650.81 | 0.00 | 0.00 | 876.81 |
| 2029 | 71 / 68 | joint | 117,249.75 | 50,430.00 | 0.00 | 21,012.50 | 0.00 | 0.00 | 69,197.11 | 0.00 | 0.00 | 2,377.36 |
| 2030 | 72 / 69 | joint | 152,487.71 | 51,690.75 | 0.00 | 0.00 | 0.00 | 0.00 | 100,796.96 | 0.00 | 0.00 | 0.00 |
| 2031 | 73 / 70 | joint | 123,185.52 | 52,983.02 | 16,709.27 | 0.00 | 0.00 | 0.00 | 54,272.89 | 16,709.27 | 0.00 | 779.66 |
| 2032 | 74 / 71 | joint | 126,265.16 | 54,307.59 | 17,578.15 | 0.00 | 0.00 | 0.00 | 55,219.95 | 17,578.15 | 0.00 | 840.54 |
| 2033 | 75 / 72 | joint | 129,421.79 | 55,665.28 | 18,417.05 | 0.00 | 0.00 | 0.00 | 56,225.18 | 18,417.05 | 0.00 | 885.73 |
| 2034 | 76 / 73 | joint | 132,657.33 | 57,056.92 | 19,292.98 | 0.00 | 0.00 | 0.00 | 57,232.77 | 19,292.98 | 0.00 | 925.34 |
| 2035 | – / 74 | single | 92,257.47 | 36,552.09 | 0.00 | 0.00 | 0.00 | 0.00 | 55,705.38 | 0.00 | 0.00 | 0.00 |
| 2036 | – / 75 | single | 94,563.90 | 37,465.89 | 29,325.23 | 0.00 | 0.00 | 0.00 | 31,168.83 | 29,325.23 | 0.00 | 3,396.05 |
| 2037 | – / 76 | single | 96,928.00 | 38,402.54 | 30,719.97 | 0.00 | 0.00 | 0.00 | 31,440.86 | 30,719.97 | 0.00 | 3,635.37 |
| 2038 | – / 77 | single | 99,351.20 | 39,362.60 | 32,035.16 | 0.00 | 0.00 | 0.00 | 31,802.74 | 32,035.16 | 0.00 | 3,849.30 |
| 2039 | – / 78 | single | 101,834.98 | 40,346.66 | 33,547.81 | 0.00 | 0.00 | 0.00 | 3,088.24 | 68,339.24 | 0.00 | 9,939.17 |
| 2040 | – / 79 | single | 104,380.86 | 41,355.33 | 33,390.41 | 0.00 | 0.00 | 0.00 | 0.00 | 73,942.03 | 0.00 | 10,916.50 |
| 2041 | – / 80 | single | 106,990.38 | 42,389.21 | 32,840.92 | 0.00 | 0.00 | 0.00 | 0.00 | 75,789.86 | 0.00 | 11,188.70 |
| 2042 | – / 81 | single | 109,665.14 | 43,448.94 | 31,863.49 | 0.00 | 0.00 | 0.00 | 0.00 | 77,683.88 | 0.00 | 11,467.69 |
| 2043 | – / 82 | single | 112,406.77 | 44,535.17 | 30,733.63 | 0.00 | 0.00 | 0.00 | 0.00 | 79,625.23 | 0.00 | 11,753.63 |
| 2044 | – / 83 | single | 115,216.93 | 45,648.55 | 29,060.57 | 0.00 | 0.00 | 0.00 | 0.00 | 81,615.10 | 0.00 | 12,046.72 |
| 2045 | – / 84 | single | 118,097.36 | 46,789.76 | 27,098.83 | 0.00 | 0.00 | 0.00 | 0.00 | 83,654.71 | 0.00 | 12,347.11 |
| 2046 | – / 85 | single | 121,049.79 | 47,959.51 | 24,433.07 | 0.00 | 0.00 | 0.00 | 0.00 | 85,745.28 | 0.00 | 12,655.00 |
| 2047 | – / 86 | single | 124,076.04 | 49,158.49 | 21,121.94 | 0.00 | 0.00 | 0.00 | 0.00 | 87,888.11 | 0.00 | 12,970.57 |
| 2048 | – / 87 | single | 127,177.94 | 50,387.46 | 17,034.02 | 0.00 | 0.00 | 0.00 | 0.00 | 90,084.49 | 0.00 | 13,294.01 |
| 2049 | – / 88 | single | 130,357.39 | 51,647.14 | 11,917.97 | 0.00 | 0.00 | 0.00 | 0.00 | 92,335.76 | 0.00 | 13,625.52 |
| 2050 | – / 89 | single | 133,616.32 | 52,938.32 | 5,785.21 | 0.00 | 0.00 | 0.00 | 0.00 | 74,629.26 | 16,066.64 | 10,017.90 |
| 2051 | – / 90 | single | 136,956.73 | 54,261.78 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 82,694.95 | 0.00 |
| 2052 | – / 91 | single | 140,380.65 | 55,618.32 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 84,762.32 | 0.00 |
| 2053 | – / 92 | single | 143,890.16 | 57,008.78 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 86,881.38 | 0.00 |
| 2054 | – / 93 | single | 147,487.42 | 58,434.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 89,053.42 | 0.00 |
| 2055 | – / 94 | single | 211,069.45 | 59,894.85 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 151,174.60 | 0.00 |
| 2056 | – / 95 | single | 216,346.19 | 61,392.22 | 0.00 | 0.00 | 11,244.49 | 0.00 | 0.00 | 0.00 | 143,709.48 | 0.00 |

| Year | Realized gain | Dividends | Coupons | Interest taxed | Taxable SS | AGI | Taxable income | End cash | End taxable | Taxable basis | End pre-tax | End Roth | End HSA | End total | End total, today's $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2027 | 10,112.00 | 4,215.60 | 5,620.80 | 0.00 | 5,974.20 | 25,922.60 | 0.00 | 20,400.00 | 492,756.80 | 328,348.40 | 578,600.00 | 106,000.00 | 8,416.00 | 1,206,172.80 | 1,176,753.95 |
| 2028 | 20,141.40 | 3,915.95 | 5,221.27 | 400.00 | 32,161.83 | 82,340.46 | 32,825.46 | 20,808.00 | 457,731.50 | 299,976.21 | 587,121.20 | 134,090.00 | 0.00 | 1,199,750.70 | 1,141,939.99 |
| 2029 | 24,668.25 | 3,496.81 | 4,662.41 | 408.00 | 36,143.53 | 90,391.51 | 51,938.63 | 21,224.16 | 408,738.18 | 263,606.58 | 595,546.35 | 164,408.65 | 0.00 | 1,189,917.35 | 1,104,956.55 |
| 2030 | 36,447.62 | 2,771.47 | 3,695.29 | 416.16 | 27,399.54 | 70,730.09 | 31,315.89 | 21,648.64 | 323,954.16 | 205,724.01 | 626,514.76 | 174,273.17 | 0.00 | 1,146,390.74 | 1,038,573.43 |
| 2031 | 20,389.35 | 2,427.13 | 3,236.18 | 424.48 | 27,826.23 | 71,012.64 | 30,613.09 | 22,081.62 | 283,704.70 | 177,503.78 | 641,515.38 | 184,729.56 | 0.00 | 1,132,031.25 | 1,000,550.68 |
| 2032 | 21,168.70 | 2,056.36 | 2,741.82 | 432.97 | 29,062.03 | 73,040.04 | 31,630.50 | 22,523.25 | 240,365.96 | 148,250.71 | 656,381.96 | 195,813.33 | 0.00 | 1,115,084.50 | 961,533.87 |
| 2033 | 21,951.95 | 1,657.27 | 2,209.69 | 441.63 | 30,233.69 | 74,911.28 | 32,466.50 | 22,973.71 | 193,716.09 | 117,844.43 | 671,139.09 | 207,562.13 | 0.00 | 1,095,391.03 | 921,514.39 |
| 2034 | 22,718.51 | 1,228.35 | 1,637.80 | 450.46 | 31,378.08 | 76,706.18 | 33,200.28 | 23,433.19 | 143,580.45 | 86,196.31 | 685,742.10 | 220,015.86 | 0.00 | 1,072,771.60 | 880,473.61 |
| 2035 | 11,229.85 | 790.88 | 1,054.50 | 459.47 | 3,405.37 | 16,940.07 | 0.00 | 23,901.85 | 92,444.57 | 72,258.22 | 721,400.69 | 233,216.81 | 0.00 | 1,070,963.93 | 857,551.19 |
| 2036 | 6,879.52 | 551.48 | 735.31 | 468.66 | 23,789.18 | 61,749.39 | 38,395.65 | 24,379.89 | 64,462.08 | 49,255.70 | 728,063.38 | 247,209.82 | 0.00 | 1,064,115.17 | 831,285.07 |
| 2037 | 7,458.91 | 297.19 | 396.25 | 478.04 | 25,368.89 | 64,719.26 | 40,781.68 | 24,867.49 | 34,738.33 | 25,967.20 | 733,605.27 | 262,042.41 | 0.00 | 1,055,253.49 | 804,255.94 |
| 2038 | 8,033.87 | 26.42 | 35.23 | 487.60 | 26,854.64 | 67,472.92 | 42,936.90 | 25,364.84 | 3,088.24 | 2,259.98 | 738,051.75 | 277,764.95 | 0.00 | 1,044,269.78 | 776,472.94 |
| 2039 | 828.26 | 0.00 | 0.00 | 497.35 | 34,294.67 | 103,959.52 | 78,810.10 | 25,872.13 | 0.00 | 0.00 | 704,537.55 | 294,430.85 | 0.00 | 1,024,840.54 | 743,440.21 |
| 2040 | 0.00 | 0.00 | 0.00 | 507.30 | 35,152.03 | 109,601.35 | 83,823.20 | 26,389.58 | 0.00 | 0.00 | 663,386.50 | 312,096.70 | 0.00 | 1,001,872.77 | 709,052.61 |
| 2041 | 0.00 | 0.00 | 0.00 | 517.44 | 36,030.83 | 112,338.14 | 85,915.53 | 26,917.37 | 0.00 | 0.00 | 618,151.66 | 330,822.51 | 0.00 | 975,891.53 | 673,819.49 |
| 2042 | 0.00 | 0.00 | 0.00 | 527.79 | 36,931.60 | 115,143.27 | 88,060.10 | 27,455.71 | 0.00 | 0.00 | 568,572.11 | 350,671.86 | 0.00 | 946,699.68 | 637,720.51 |
| 2043 | 0.00 | 0.00 | 0.00 | 538.35 | 37,854.89 | 118,018.47 | 90,258.22 | 28,004.83 | 0.00 | 0.00 | 514,372.11 | 371,712.17 | 0.00 | 914,089.11 | 600,734.84 |
| 2044 | 0.00 | 0.00 | 0.00 | 549.11 | 38,801.27 | 120,965.48 | 92,511.22 | 28,564.92 | 0.00 | 0.00 | 455,260.37 | 394,014.90 | 0.00 | 877,840.20 | 562,841.21 |
| 2045 | 0.00 | 0.00 | 0.00 | 560.10 | 39,771.30 | 123,986.10 | 94,820.48 | 29,136.22 | 0.00 | 0.00 | 390,929.16 | 417,655.79 | 0.00 | 837,721.18 | 524,017.82 |
| 2046 | 0.00 | 0.00 | 0.00 | 571.30 | 40,765.58 | 127,082.16 | 97,187.40 | 29,718.95 | 0.00 | 0.00 | 321,053.44 | 442,715.14 | 0.00 | 793,487.53 | 484,242.38 |
| 2047 | 0.00 | 0.00 | 0.00 | 582.72 | 41,784.72 | 130,255.55 | 99,613.43 | 30,313.33 | 0.00 | 0.00 | 245,289.93 | 469,278.05 | 0.00 | 744,881.30 | 443,492.11 |
| 2048 | 0.00 | 0.00 | 0.00 | 594.38 | 42,829.34 | 133,508.21 | 102,100.03 | 30,919.59 | 0.00 | 0.00 | 163,276.12 | 497,434.73 | 0.00 | 691,630.45 | 401,743.69 |
| 2049 | 0.00 | 0.00 | 0.00 | 606.27 | 43,900.07 | 136,842.10 | 104,648.72 | 31,537.99 | 0.00 | 0.00 | 74,629.26 | 527,280.81 | 0.00 | 633,448.06 | 358,973.26 |
| 2050 | 0.00 | 0.00 | 0.00 | 618.39 | 44,997.57 | 120,245.22 | 87,247.00 | 32,168.74 | 0.00 | 0.00 | 0.00 | 541,887.02 | 0.00 | 574,055.77 | 317,381.28 |
| 2051 | 0.00 | 0.00 | 0.00 | 630.76 | 1,380.82 | 2,011.58 | 0.00 | 32,812.12 | 0.00 | 0.00 | 0.00 | 486,743.59 | 0.00 | 519,555.71 | 280,243.46 |
| 2052 | 0.00 | 0.00 | 0.00 | 643.37 | 1,726.27 | 2,369.64 | 0.00 | 33,468.36 | 0.00 | 0.00 | 0.00 | 426,100.15 | 0.00 | 459,568.51 | 241,840.91 |
| 2053 | 0.00 | 0.00 | 0.00 | 656.24 | 2,080.32 | 2,736.56 | 0.00 | 34,137.73 | 0.00 | 0.00 | 0.00 | 359,571.89 | 0.00 | 393,709.62 | 202,130.41 |
| 2054 | 0.00 | 0.00 | 0.00 | 669.37 | 2,443.18 | 3,112.55 | 0.00 | 34,820.48 | 0.00 | 0.00 | 0.00 | 286,749.58 | 0.00 | 321,570.07 | 161,067.30 |
| 2055 | 0.00 | 0.00 | 0.00 | 682.75 | 2,815.09 | 3,497.84 | 0.00 | 35,516.89 | 0.00 | 0.00 | 0.00 | 143,709.48 | 0.00 | 179,226.37 | 87,580.98 |
| 2056 | 0.00 | 0.00 | 0.00 | 696.41 | 3,196.26 | 3,892.67 | 0.00 | 24,757.85 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 24,757.85 | 11,803.12 |

The path succeeds with 24,757.85 left (11,803.12 in today's dollars). Lifetime federal tax in today's dollars 106,838.15. The gross-up needs at most 6 `assess` calls in any year.

R2 exercises what R1 does not: the cash reserve (never touched until 2056) and cash above it; the HSA tier; trade-level gains with rebalancing; same-year dividends and coupons with basis growth; cash interest taxed a year late; conversions in today's dollars; RMDs from 73 for one person and 75 for the other; the first death with the rollover, the basis reset, the survivor benefit, the survivor share of spending and single filing; pre-tax running out (2050); Roth draws; long-term care years; a draw on the reserve in the last year.

Procedure and tolerance for R1 and R2. (1) `reference/independent.ts` (`runR1()`, `runR2()`) is written from the two sheets, with its own transcription of the tax figures, its own trade arithmetic and a bisection gross-up (200 halvings); it writes `r1.expected.csv` and `r2.expected.csv`. A source scan asserts that nothing under `reference/` imports from `src/`. (2) A test asserts the two files equal the tables above within 0.01 per cell (three derivations: this document's scratch reference, the independent calculator, the engine). (3) `gate.test.ts` runs the engine on `r1.input.json` and `r2.input.json` (one path) and compares every money cell of the year table with the expected file: pass when every absolute difference is at most 1.00; the test prints the largest difference, expected under 0.02. (4) If the seams step changes a rule a sheet uses (yield timing, indexing or rounding of thresholds, the basis reset, the survivor benefit), the sheet, the tables and the independent calculator are changed together and the change is recorded in the Phase 4 plan.

### 7.8 Reference scenario R3: the 4% rule on the historical record (gate, part B)

Sheet. One person, 65 in 2027, fixed age 94 (30 plan years), `asOf` 2027-01-01; one Roth account of 1,000,000 (withdrawals after 59½, so no tax and no RMD); no income; `constant_dollar` with base spending 40,000 and nothing else; the historical model with complete cohorts: start years 1928 to 1996, 69 paths, inflation from the same rows; the account rebalanced every year. Two runs: 50% stocks and 50% bonds; 75% and 25%. Data: the engine design's pinned `us-annual-returns.csv` (sha256 `ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c`, six decimals, from the "Returns by year" sheet of Damodaran's workbook). Every figure below was recomputed from that file; Design A's and B's dollar figures came from the workbook's unrounded values and differ by a few dollars.

Expected, from the independent calculation on that file:

| Stocks | Funded | Failing start years (first failing plan-year index; lifetime shortfall in today's dollars) | Ending wealth, today's dollars: 10th / median / 90th percentile (start year of that path) |
| --- | --- | --- | --- |
| 50% | 64 of 69 (`successBp` 9275) | 1964 (29; 14,423.36), 1965 (26; 156,709.24), 1966 (24; 203,703.70), 1968 (27; 112,088.42), 1969 (27; 105,299.70) | 28,267.59 (1967) / 1,069,960.25 (1928) / 3,300,302.14 (1991) |
| 75% | 65 of 69 (`successBp` 9420) | 1965 (29; 17,881.33), 1966 (26; 142,871.79), 1968 (28; 57,007.81), 1969 (27; 92,165.01) | 278,163.95 (1973) / 2,410,396.03 (1941) / 4,719,965.05 (1991) |

Spot values. 50% stocks: start 1928 ends with 1,756,469.89 nominal, price level 1.641622, 1,069,960.25 in today's dollars; start 1982 ends with 12,134,994.85 (5,054,626.07). 75% stocks: start 1929 ends with 466,954.35 (276,294.08); start 1973 with 1,183,999.20 (278,163.95); start 1982 with 13,690,993.58 (5,702,750.93).

The 1966 path at 50% stocks (also hand case HC-E1):

| Year | Start balance | Spending need | Portfolio return | End balance | Inflation |
| --- | --- | --- | --- | --- | --- |
| 1966 | 1,000,000.00 | 40,000.00 | −3.5316% | 926,097.12 | 3.4591% |
| 1967 | 926,097.12 | 41,383.64 | +11.1112% | 983,015.76 | 3.0395% |
| 1968 | 983,015.76 | 42,641.50 | +7.0447% | 1,006,621.28 | 4.7198% |
| 1969 | 1,006,621.28 | 44,654.09 | −6.6277% | 898,210.90 | 6.1972% |
| … | | | | | |
| 1988 | 382,832.63 | 145,157.37 | +12.3804% | 267,100.41 | 4.4194% |
| 1989 | 267,100.41 | 151,572.46 | +24.5844% | 143,929.80 | 4.6473% |
| 1990 | 143,929.80 | 158,616.48 (only 143,929.80 available) | | 0.00 | 6.1063% |

1966 by hand: `(1,000,000 − 40,000) × (1 + 0.5 × (−0.099710) + 0.5 × 0.029079) = 960,000 × 0.9646845 = 926,097.12`. The path fails in plan-year index 24 with a shortfall of 14,686.68 in that year.

Pass criteria:

1. Engine against the independent calculator, both runs: the same 69 start years, the same funded count, the same failing start years with the same failure index, each lifetime shortfall and each path's ending wealth in today's dollars within 1.00.
2. The data file against the study it is compared with. The Trinity study (Cooley, Hubbard and Walz 1998, Table 3: 1926 to 1995, S&P 500 and long-term high-grade corporate bonds, 4% inflation-adjusted, 30 years) reports 95% for 50% stocks and 98% for 75% stocks. The independent calculator, run in the study's convention on this file (start years 1928 to 1966, 39 periods; each year the balance first earns the year's return, then 40,000 × the price level at that year-end is withdrawn), gives 37 of 39 (94.9%) and 38 of 39 (97.4%): within 1.5 points of the study (observed 0.1 and 0.6). The convention matters and is stated exactly because judge 2 found Design B's wording ambiguous: a year-end withdrawal at the year's starting price level gives 38 and 39 of 39.
3. Engine against the study: within 5 points for both mixes (92.8% against 95%; 94.2% against 98%). The gap is the withdrawal timing (start of year) and the 30 later start years: on the same 69 windows the study's convention gives 65 and 68 of 69 where the engine's gives 64 and 65.
4. For information in `r3.expected.json`, not asserted against a publication: the independent calculator's counts for 100%, 25% and 0% stocks are 37, 28 and 4 of 39 in the study's convention and 64, 51 and 27 of 69 in the engine's. The study's values for those mixes (95%, 71%, 20%) rest on a single secondary source.

The data file's validation values are the engine design's (its §2.8): 98 rows, 1928: 0.438112, 0.008355, 0.030800, −0.011561; 1974: −0.259018, 0.019886, 0.078458, 0.123377; 2008: −0.365523, 0.201013, 0.014000, 0.000914. They reject the sheet "Nominal vs Real Data", which both judges found in the lead's draft extract (1966 inflation 3.36% there against 3.4591% here).

### 7.9 Reference scenario R4: a lognormal sanity check (gate, part B)

Sheet. One person, 30 plan years (65 in 2027, fixed age 94), a Roth account of 1,000,000 held entirely in stocks, no income, `constant_dollar` with base spending 40,000. Parametric model, custom parameters, arithmetic means: stocks mean 6%, volatility 12%; inflation mean 2.5%, volatility 1%, persistence 0; bonds 4% and 7%, bills 3% and 2% (unused by the account, non-zero because the engine's Cholesky step rejects a zero variance, which is why Design A's fixed 2.5% inflation was replaced); all correlations 0; 10,000 paths; no fund costs. For a lognormal growth factor with mean `1 + A` and standard deviation `S`: `σ² = ln(1 + (S ÷ (1 + A))²)`, `μ = ln(1 + A) − σ² ÷ 2`.

Expected, from an independent run of 4,000,000 paths: success 69.97%; median ending wealth about 337,500 in today's dollars; the 10th and 25th percentiles are 0; the 75th about 1,005,000. Forty independent runs of 10,000 paths ranged from 68.8% to 70.7% (standard deviation 0.43 points, the binomial 0.46) with medians from 320,800 to 358,100. Pass: the engine's success rate within 1.5 points of `r4.expected.json` (about three standard errors) and its median ending wealth within 8%. The independent calculator uses its own generator (mulberry32 with Box–Muller), not the engine's.

### 7.10 Gate procedure

1. `pnpm test` runs the suites of §7.1 to §7.5 and the reference tests of §7.6 to §7.9 in `packages/retirement/src/gate.test.ts`.
2. `apps/api/src/retirementGate.test.ts` (database suite, the real engine inline): seed the inputs design's fixture, save its profile, request a run of the default scenario through the API, drain the queue, then assert: the run is `done`; `summary` and `fan` parse; `summary.successPaths` and the digest equal a direct engine run on the stored input; the stored 50th-percentile table equals a re-simulation of the same path; `GET /runs/:id/paths/37` answers `resimulated`; the dashboard card is `ready`; the viewer can read all of it and is refused `POST /scenarios/:id/runs`.
3. `pnpm typecheck`, lint, build, smoke boot.
4. Owner acceptance, recorded in `docs/phase-4-gate.md`, not automated: the owner enters the R3 case (1,000,000, 40,000 a year, 30 years, 75% stocks, no fees) in an outside calculator of their choice and notes its success rate, and does the same for one scenario of their own; a difference above 10 points on their own scenario is investigated before Phase 5 starts. FIRECalc and cFIREsim use Shiller's data from 1871, so they see more start years.

## 8. Deviations from the spec and deliberate simplifications

| # | Deviation or simplification | Reason | Effect |
| --- | --- | --- | --- |
| 1 | Two kinds of year: fixed-percentage and VPW take tax out of the withdrawal | their sources define a portfolio withdrawal | with taxes, spending under these two is lower than "percentage × portfolio" by the tax on it |
| 2 | Essentials are topped up under the percentage strategies; essential spending is an input the spec does not list | one failure definition; the floor-and-ceiling rule needs it | percentage strategies can fail; without the floor they never would |
| 3 | While one spouse still works, the plan's spending is funded as under constant spending whatever the strategy | a percentage rule would withdraw money only to add it to wages | path-dependent rules start a few years later for such couples |
| 4 | Guardrails run on a reference withdrawal and scale the portfolio-funded part of the plan | the published rules assume no other income | with no outside income it is the published rule; with a bridge to Social Security the reference rate rises as the portfolio is drawn down as planned, so cuts can fire during the bridge (it errs toward spending less); when income covers the whole plan the factor still moves but has nothing to scale |
| 5 | Guardrails: no portfolio management rule; no inflation cap; no freeze when inflation is zero or negative; the prosperity rule is kept in the final 15 years and skipped in a freeze year; cuts stop at essential spending | the engine rebalances every year; the 2006 paper dropped the cap; the sources are silent on the rest | small |
| 6 | Constant spending and guardrails are anchored to the plan; there is no "initial rate" setting | every strategy starts from the spending seeded from the budget | a classic 4% or 5.2% plan is entered as base spending |
| 7 | Floor and ceiling combines Bengen's clamp with an essentials split; the band is around the plan's discretionary spending; the default band (15% below, 20% above) is unconfirmed | the spec's sentence; the plan as anchor | with no essentials, income or phases it is Bengen's rule |
| 8 | VPW uses the younger person's age and the target stock share; no bridge for delayed Social Security under either percentage strategy | simplest faithful reading | spending steps up when Social Security or a pension starts; the Run page says so; a goal entry per gap year is the manual workaround |
| 9 | Long-term care is a deterministic cost in the last years of each named person's life, read from the path's death year; it is not charged before the first retirement | no care model in v1; the inputs design freezes it this way | understates the spread of late-life costs; the reserve is excluded from the percentage rules until care starts |
| 10 | The cash reserve is never refilled and defaults to 0 | surplus goes to the engine's surplus account; no amount is assumed | with the default, bank cash is spent first |
| 11 | The HSA pays the year's healthcare before taxable money is touched | simple and never penalized | the HSA drains early in retirement instead of compounding |
| 12 | Every dated goal counts toward the floor in drawdown years; goals before retirement never fail the plan | the frozen input has no "essential" flag on goals; the engine's accumulation rule | a path that cannot pay a late roof counts as failed |
| 13 | In a gross year the tax on a scheduled conversion reduces spending (down to the floor) | `assess` always includes the forced flows | converting under a percentage strategy lowers that year's spending |
| 14 | The percentile table is one real path ranked by ending wealth, not column-wise percentiles | coherent rows that end at the headline number | the table's balances match the fan only approximately; the caption says so |
| 15 | Ending wealth is not reduced for the tax embedded in pre-tax accounts | the spec's wording | overstates what heirs keep |
| 16 | Parts of a row are adjusted by a cent or two so that they add to the engine's totals | tables add up and end at the headline | none beyond the cent |
| 17 | A failure is any shortfall above half a cent | the engine's tolerance | none: a shortfall only occurs when everything is drawn |
| 18 | Added outputs beyond the spec: the full-plan rate, the spending fan, the funded share by age, the 25th and 75th percentile bands, the path story, the year drawer, failures by age | the variable strategies and the owner's "why did this path fail" need them | none on the spec's outputs |
| 19 | Not built (Phase 5): order alternatives, comparisons across scenarios and strategies, sensitivity, lifetime taxes compared; the stored per-path series and the hook seams are what Phase 5 builds on | scope | none |
| 20 | Inherited from the engine design and visible in this area's results: start-of-year flows (on the historical file, success 1.4 points lower at 50% stocks and 4.3 at 75% than under the Trinity study's year-end convention, §7.8), spending not modelled before the first retirement, payroll tax not modelled (a working spouse's take-home pay is overstated), the fan conditional on the household being alive | stated there | as stated there |

## 9. Seams

What this area assumes of the others. Each item names what exists in the merged designs and what must be added. If the seams step decides otherwise, the named item changes and nothing else.

**To engine-and-returns** (references are to `engine-and-returns.md`)

- **E1. Gross years.** `SpendDecision` (§4.3) gains `gross` (NaN in a target year), `planned` and `rule` (§2.2 here). The loop's step 5 gains the gross-year branch and the below-plan flag of §3.8 here: three lines. The chunk `flags` gains bit 3 "below plan in some drawdown year" and `EngineResult` gains `fullPlanCount`. The detail row's `spending` gains `planned`, `gross` and `rule`. In a gross year a positive `net` with a withdrawal is the rule, not a failure to converge; the "not converged" flag applies there only after a top-up.
- **E2. `planWithdrawals(view, decision, assess, w)`**: the year's `SpendDecision` is passed read-only (the hook needs `gross`, `lump` and `healthcare`). The contract of §3.9 there ("if `assess(0).net ≥ −CASH_TOL` return `w = 0`") holds for target and accumulation years; §3.6 here states the gross-year contract.
- **E3. `YearView` gains, read-only:** `rmd: Float64Array(A)` (valid from step 3b); `stockShare` (the stock fraction of this year's target mixes, weighted by the accounts' start balances); `rothFree: Float64Array(P)` (from the Roth state and the tax area's ordering rules); `yearsToDeath: Int16Array(P)`; `drawdownStart`; `strategies` (the `StrategyTables` that `prepare()` builds once by calling `prepareStrategies(input)`).
- **E4. Input blocks.** `EngineInput.spending = { plan, strategy }` with `plan` the inputs design's frozen `spending` block unchanged and `strategy` a `StrategyConfig`; `EngineInput.withdrawal` a `WithdrawalOrderConfig`. Which account a person's conversion moves from and to is resolved before the engine sees it.
- **E5. Detail rows.** `PathDetail` as in §2.7 there, with the tax lines of T2, `endBasisByAccount` recorded before a death's basis reset, and the cohort start year for the historical model.
- **E6. One rank rule.** The inputs design's `rankPaths` (ending wealth in cents, then earlier failure year, then path index) is the one implementation; the engine's `percentilePathIndex` comes from it. The engine design's third key (larger shortfall) is dropped; it only orders paths that end with the same cents and failed in the same year.
- **E7. Facts the reference scenarios rely on:** the `fixed` model; yields settable to 0; a single-asset taxable account realizes `sale × (1 − basis ÷ balance)`; surplus deposited at the surplus account's target weights with basis; the basis reset at the first death applied after the year's returns; complete cohorts with one path per start year; the parametric model with custom arithmetic parameters.
- **E8. Open between the two merged designs, consumed here but not decided here:** the frozen input's shape (`EngineInput` there, `SimInput` in the inputs design) and who adapts one to the other; the first-year fraction by days (engine) or months (inputs), which `yearShare` of §3.2 follows; the thread setting's name; the seed's width. This area's fixtures are written in the engine's boundary shape and its pages read `SimRunView.threads` and `summary.firstYearFractionPpm`.

**To tax-rmd-ss**

- **T1.** `federalTax` is continuous, non-decreasing in every distribution, with a marginal tax plus penalty rate below 1 (WD-20 checks it from this side).
- **T2.** `TaxResult` carries, besides the engine design's list (`total`, `incomeTax`, `niit`, `penalties`, `taxableSocialSecurity`, `agi`, `magi`): `ordinaryTax` and `capitalGainsTax` (their sum is `incomeTax`), `deduction` (standard, aged and senior together) and `taxableIncome`. Scalars only.
- **T3.** The early-distribution predicate the tax function itself applies is exported for the order: `isEarly(kind, ageAttained)` for pre-tax and Roth money (assumed: under 60, the first calendar year in which every owner has reached 59½ by year end) and the HSA age 65. The hand cases use ages well away from the boundary.
- **T4.** Roth ordering: contributions, then conversions oldest first, then earnings; conversions under five years old carry the 10% only; an owner who is not early takes everything free.
- **T5.** After the last published year the bracket thresholds, standard deduction, aged addition and gains thresholds are multiplied by the path's price level relative to that year, unrounded; the Social Security and net investment income thresholds are not indexed; the senior deduction (6,000 per person 65 or older, reduced by 6% of AGI above 75,000 or 150,000) applies through 2028 and is not indexed. R1, R2 and HC-T15 depend on all three; if thresholds are rounded as the IRS rounds them, the two sheets and tables are regenerated.
- **T6.** Social Security: a claim at exactly the full retirement age pays 100%; a person whose claim month is January is paid for that whole year; a benefit entered for the plan's start year is multiplied by the cost-of-living index; after a death the survivor receives the larger of the two benefits from the following year (R1, R2).
- **T7.** RMD = the prior year-end balance ÷ the Uniform Lifetime divisor for the age attained, from 73 (born 1951 to 1959) or 75 (born 1960 or later), taken in the year the age is attained.

**To inputs-and-data**

- **I1.** `strategy.ts` provides `StrategyConfig`, `WithdrawalOrderConfig`, `DEFAULT_STRATEGY`, `DEFAULT_WITHDRAWAL_ORDER` for `RunSettings`; `results.ts` provides `SimSummary` (with `endingWealthReal.p50` and `.p10`), `FanSeries` and `YearTable`. The job stores what `toSimSummary`, `toFanSeries` and `toYearTable` return; `successPaths` is the summary's; the depletion year of a path is the calendar year of its first failure.
- **I2.** The rank rule of its decision 22 is confirmed (E6).
- **I3.** Spending semantics of its section 9 are confirmed, with two precisions: every dated goal counts toward the floor in drawdown years (deviation 12), and long-term care is charged only in drawdown years.
- **I4.** Storage: the year table is about 2 KB a row with eight accounts, so the seven stored tables are about 0.6 MB for a 47-year plan, above that design's 160 KB estimate and under its 2 MB guard per table.
- **I5.** Pages rely on: `provenance` and `issues` in the profile and scenario responses; `effective` in `GET /scenarios/:id/input` for the strategy hints; `changes` in `ScenarioView`; `SimRunView.current`, `stalled`, `threads`; the audit route for history and revert.
- **I6.** The card renders `DashboardView.retirement` as that design defines it; nothing is added to the contract.

**Offered to the others and to Phase 5:** the tier model (`buildTiers` and `fill` over accounts, so an order that mixes account types is another `fill`); the strategy slot (a new kind is a branch of `decideSpending` and a `StrategyConfig` member); the below-plan flag and the stored per-path series for paired scenario comparison under one seed; `pathStory` and `deflateYearRow` as shared pure functions; the reference calculator as a regression harness for the optimizers.

## 10. Sources

Primary documents, checked during this session from local copies (fetched 2026-11-10):

| Source | URL | SHA-256 | Used for |
| --- | --- | --- | --- |
| Rev. Proc. 2025-32 | https://www.irs.gov/pub/irs-drop/rp-25-32.pdf | e9ada115fb43a4af5ea326ca91edd40ab0bf29b9be01d2c13d7b8fa96214635b | 2026 brackets (joint 24,800 / 100,800 / 211,400 / 403,550 / 512,450 / 768,700; single 12,400 / 50,400 / 105,700 / 201,775 / 256,225 / 640,600), standard deduction 32,200 and 16,100, aged addition 1,650 and 2,050, gains thresholds 98,900 / 613,700 and 49,450 / 545,500 |
| Rev. Proc. 2026-35 | https://www.irs.gov/pub/irs-drop/rp-26-35.pdf | 87b383c6ce6e616fd006a61f5eed46fe67099b9c23fb1e1c42ff5359474513b8 | 2027 brackets (joint 25,600 / 104,050 / 218,250 / 416,650 / 529,100 / 793,650; single 12,800 / 52,025 / 109,125 / 208,325 / 264,550 / 661,375), standard deduction 33,200 and 16,600, aged addition 1,700 and 2,100, gains thresholds 102,100 / 633,600 and 51,050 / 563,200 |
| IRS Publication 590-B (2025) | https://www.irs.gov/pub/irs-pdf/p590b.pdf | d18a592e55ce56d43953dc338272ece3984565792d6dca06989a6ca8121f7360 | Uniform Lifetime Table (72: 27.4 … 100: 6.4, 120 and over: 2.0), the 100,000 ÷ 24.6 example |
| Damodaran, historical returns 1928 to 2025 | https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls | 28b8110916a15a4dcc11c87c6422510704608ddedcdfa67a1298abdc22e49c69 (workbook); ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c (the engine design's pinned CSV) | R3 |

Read by the designers from the primary pages (not re-fetched in the merge): IRS Topic 559 (net investment income tax, 3.8%, 200,000 and 250,000): https://www.irs.gov/taxtopics/tc559 ; IRS Publication 915 (Social Security base amounts): https://www.irs.gov/publications/p915 ; IRS Topic 557 (10% additional tax before 59½): https://www.irs.gov/taxtopics/tc557 ; IRS Publication 969 (20% additional tax on HSA distributions before 65): https://www.irs.gov/pub/irs-pdf/p969.pdf ; IRS newsroom on the senior deduction (6,000, 2025 to 2028, phase-out from 75,000 and 150,000): https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors

Secondary sources recorded by the designers and the judges (web search; not re-run in the merge):

- Senior deduction's 6% phase-out: https://www.cpapracticeadvisor.com/2025/09/17/2025-tax-law-sweetens-the-deal-for-seniors-and-retirement-benefits-obbba/168996/ ; https://www.kiplinger.com/retirement/roth-iras/six-ways-to-cash-in-on-the-usd6-000-senior-bonus-deduction ; https://www.doeren.com/viewpoint/tax-planning-to-maximize-the-new-senior-deduction
- Rev. Proc. 2026-35 in the press: https://www.journalofaccountancy.com/news/2026/nov/irs-announces-inflation-adjustments-for-tax-year-2027/ ; https://kpmg.com/us/en/taxnewsflash/news/2026/11/rev-proc-2026-35-inflation-adjustments-2027.html
- Social Security cost-of-living adjustments (2.8% for 2026, 3.6% for 2027): https://www.ssa.gov/blog/en/posts/2026-10-14.html ; https://www.cnbc.com/2026/10/14/social-security-cola-2027.html ; https://www.foxbusiness.com/economy/social-security-announces-cost-of-living-adjustment-2027
- Social Security claiming factors and spousal reduction: https://www.ssa.gov/oact/quickcalc/early_late.html ; https://www.ssa.gov/OP_Home/cfr20/404/404-0410.htm ; https://www.kitces.com/blog/social-security-full-retirement-age-fra-increasing-from-age-66-to-67/
- Bengen (1994), "Determining Withdrawal Rates Using Historical Data", Journal of Financial Planning 7(4): https://robberger.com/research/determining-withdrawal-rates-using-historical-data/ ; https://en.wikipedia.org/wiki/William_Bengen
- Cooley, Hubbard and Walz (1998), the Trinity study: https://www.aaii.com/journal/199802/feature.pdf ; https://en.wikipedia.org/wiki/Trinity_study ; https://retirementresearcher.com/safe-withdrawal-rates-for-retirement-and-the-trinity-study ; https://thepoorswiss.com/trinity-study/
- Guyton and Klinger (2006), "Decision Rules and Maximum Initial Withdrawal Rates": https://www.financialplanningassociation.org/article/journal/MAR06-decision-rules-and-maximum-initial-withdrawal-rates ; descriptions: https://retirementresearcher.com/original-retirement-spending-decision-rules/ ; https://help.rightcapital.com/knowledge-base/advisor-portal/models/retirement-spending/guardrails ; https://finalytiq.co.uk/guyton-klinger-sustainable-withdrawal-rules/ ; https://incomelaboratory.com/risk-based-vs-guyton-klinger-guardrails/
- Variable percentage withdrawal: https://www.bogleheads.org/wiki/Variable_percentage_withdrawal ; https://www.bogleheads.org/forum/viewtopic.php?t=120430 ; https://www.bogleheads.org/forum/viewtopic.php?t=356421 ; https://www.finiki.org/wiki/Variable_percentage_withdrawal ; https://thriftyfeds.com/vpw-calculator/
- Bengen (2001), "Conserving Client Portfolios During Retirement, Part IV": https://www.financialplanningassociation.org/sites/default/files/2021-11/MAY01%20Bengen%20PDF.pdf ; descriptions: https://retirementresearcher.com/floor-ceiling-retirement-spending-strategy/ ; https://www.fa-mag.com/news/article-1086.html?page=2 ; https://portfoliocharts.com/charts/retirement-spending/
- FIRECalc and cFIREsim (owner acceptance only): https://firecalc.com/dev/faq.php ; https://raw.githubusercontent.com/boknows/cFIREsim-open/master/js/cFIREsimOpen.js

**Unverified figures and definitions** (the implementer checks each against the primary source before the gate):

1. Bengen 2001's band. Secondary sources disagree: 20% above and 15% below (Retirement Researcher, found by both judges; the default here) and 25% above and 10% below (one source found by judge 2, two cited by Design A). The paper could not be fetched.
2. The exact wording of the Guyton and Klinger rules: all from secondary descriptions, which agree on 20%, 10%, the 15-year cut-off and the dropped inflation cap; which withdrawal amount enters the freeze test (the inflation-raised one is used here), whether the prosperity rule also lapses in the final 15 years, and the treatment of negative inflation are not confirmed.
3. VPW's growth rates (5.0% and 1.9%) and depletion age: corroborated by reproducing nine published table values; the 10% cap rests on search summaries; using the younger spouse's age is this design's choice.
4. The Trinity study's 95% (50% stocks) and 98% (75% stocks) at 4% over 30 years are corroborated by several secondary sources; its values for 100%, 25% and 0% stocks (95%, 71%, 20%) rest on one secondary source and are not asserted; its withdrawal timing is not confirmed (the 5-point tolerance covers it).
5. The senior deduction's 6% phase-out rate: secondary sources only; the IRS page confirms the amount, the years and the thresholds.
6. The 3.6% cost-of-living adjustment for January 2027: secondary outlets and an SSA blog address that could not be opened. It belongs to the tax area's data file and no figure here depends on it.
7. Social Security claiming fractions and the spousal reduction (HC-S1, HC-S2): the totals agree with search results; the SSA pages were not reachable.
8. The 59½ rule as "age attained under 60" is an assumption about the tax area's predicate, not a published figure.
9. The solver's cost figures come from the scratch reference with this document's tax function, not from the real engine.

Hosts that have to be allowed for a direct check: `www.financialplanningassociation.org`, `www.bogleheads.org`, `www.finiki.org`, `www.ssa.gov`, `www.aaii.com`.

## 11. Open questions

1. Guardrails with a bridge to Social Security: the reference track errs toward cuts during the bridge. Is that acceptable for v1, or should the owner be offered a variant that tests the household's actual draw rate (which errs toward raises when Social Security starts)?
2. Fixed-percentage and VPW take tax out of the withdrawal. Would the owner rather read the percentage as after-tax spending, with the withdrawal grossed up?
3. Should the percentage strategies bridge the years before Social Security starts (set the gap years aside and pay them from the portfolio), or is the note on the Run page enough until Phase 5?
4. Long-term care: a cost in the last years of life (this design and the inputs design), a pure set-aside that ending wealth must clear, or a random care event in v2?
5. Floor-and-ceiling defaults: 15% and 20%, or 10% and 25%? To be settled against the paper.
6. Should a dated goal be allowed to be "nice to have" (not counted toward the floor)? It needs a flag in the profile, which the inputs design does not have.
7. Cash reserve: is 0 the right default, or should the form suggest a figure (for example six months of spending)?
8. HSA: pay healthcare first (this design) or hold it to the end?
9. Payroll tax in years when one spouse still works: inside the tax function or ignored? It changes take-home pay by 7.65% of wages (also asked by the engine design).
10. Should the summary also show ending wealth after an estimate of the tax embedded in pre-tax accounts, ahead of v2's optimizers?
11. Is a TypeScript independent calculator independent enough for the gate, or does the owner want it in a second language outside the workspace?
12. Dashboard tones at 90% and 75%: keep, change, or show no colour?
13. Challenge to the reading of L8 (shared with the engine design's open question 1): the engine builds `assess` and this area owns only the order and the solver. This design accepts it; if the lead moves the tax-input assembly here, `planWithdrawals` grows by that assembly and nothing else changes.
14. Challenge to L3 as the two merged designs apply it: they prorate the first year by days (engine) and by months (inputs). This area follows whichever fraction the loop uses; the seams step has to pick one.

## 12. Judging record

**Scores** (correctness / spec fidelity / codebase fit / testability, out of 10):

| | Design A (literature-first) | Design B (owner-first) |
| --- | --- | --- |
| Judge 1 | 7 / 8 / 8 / 8.5 | 7.5 / 7 / 7 / 8 |
| Judge 2 | 9 / 8 / 9 / 9 | 8 / 7 / 7 / 8 |

Both judges chose A, narrowly, and both re-worked the hand cases of both designs and found the arithmetic right apart from cent-level slips. The choice rested on A staying inside TypeScript, funding goals before retirement, gating the stochastic layer and keeping Bengen's clamp; B was credited with the better failure definition, the household phases, the cash reserve, modelled yields, a broader deterministic scenario and the Trinity tie-out.

**Kept from A (the base):** the two kinds of year (spending targets and gross withdrawals) and the mapping of the five strategies onto them; strategies as pure functions of a yearly context; core spending as the only thing a rule governs; phases as planned steps; the spendable portfolio net of the long-term care reserve and the reserve as an end-of-life cost; the VPW formula with its nine-value table check; Bengen's clamp for floor and ceiling; the order's principle (taxable first, Roth last, penalties after everything penalty-free) and Roth basis before penalized money; pro rata within a kind; basis points and cents strings on the wire; a real path as the percentile table; the Retirement shell, the strategy card texts, the stacked-line fan chart built from registered components, the browser-built CSV; a TypeScript independent calculator written from reference sheets; R1 with its full 21-year table; the three-layer gate (deterministic, historical, lognormal) with its tolerances; most of the strategy, withdrawal and chart test cases.

**Taken from B:** essentials always funded and failure as "the money ran out", with the full-plan rate beside it; the three household phases; the tiered order with a cash reserve and the HSA as a tier used only on need; the worked gross-year examples (rule stands, top-up, RMD above the rule) and the surplus and shortfall examples; the cash identity and monotonicity tests; tables that add up; the tax lines of the year drawer; the path story and failures by age; constant spending as "spend the plan"; phases keyed to calendar years; the dashboard states for "no profile", "no run" and "simulating" (through the inputs design's contract); the deterministic household with yields, an HSA, RMDs from 73 and 75, a first death, the survivor benefit and single filing (as R2, re-specified under the final rules); the Trinity tie-out in the study's own convention and the 75% stocks run; the solver family (false position with the Illinois modification) and its measured cost; the spec's own sentence as the disclaimer; the v2 notes on cliffs and on per-path series.

**Decided by the two merged designs rather than by A or B:** the hooks and `assess` (engine); proration of the first year (both); nearest-rank percentiles, the ranking by ending wealth, the Wilson interval and aggregation (engine and inputs); routes, storage, the seven stored percentiles, re-simulation in the API, the 15-minute cap and the dashboard contract (inputs); trade-level gains, yields, the basis reset at death (engine).

**Flaws the judges named, and where each is resolved.** Against A: guardrails misfiring when income covers most of the need, iwr reaching 0, pension without COLA read as a yearly step, no tests of those branches (decision 15, §3.4c, ST-8 to ST-13); no top-up, wealthy "failed" paths ranked at the bottom (decisions 7, 8 and 25); percentage rules applied while a spouse works (decision 5); the unconditional HSA draw and cash drawn to zero (decisions 18 and 20); no place for dividends and interest (they are the engine's `assess`; R2 exercises them); R1's narrow coverage (R2, HC-T9 to HC-T13); browser deflation from a six-digit index and totals that need not add (decisions 27 and 28); re-simulation in the API unlisted and placed in a route (it is the inputs design's service); threads and duration inside the result (they live on the run row; the summary holds neither); undeclared and undefined types (the mappers take the engine's declared `EngineResult` and `PathDetail`); the solver's "stop" (§3.7 returns `x`); values on half-cent boundaries and the two misprints (§7 conventions; WD-2 re-specified; the 2030 cell corrected; WD-15 quotes the start-of-year balances); the unanchored floor-and-ceiling default and its uncorroborated band (decision 17); a draw step limited to one account kind (tiers are lists of accounts); the 30-minute stale sweep (the inputs design's cap); the first plan year (decision 2); the disclaimer (decision 40); the long-term care cost reading the death year (kept, decision 12). Against B: Python calculators (decision 37); `f` threaded through every formula and applied to lumps (decision 2; the engine never scales a lump); withdrawal-driven guardrails that ignore the plan and jump when Social Security starts, undefined at a zero portfolio (decision 15); goals before retirement never funded (the engine's accumulation rule, WD-17); non-nullable ratios dividing by zero after depletion (§3.11); nominal stored rows served in today's dollars (`deflateYearRow`); no policy interface (decision 18, the tier model); `z.any()` and string events (typed `PathStory`, `StrategyEvent`); scope (no preview route, no pin or revert machinery of its own, no bracket arrays); summaries and fans overlapping the engine's aggregation (pure mappers only); assumptions listing threads (built in the browser from the stored input and the run row); the inert long-term care earmark (decision 12); floor and ceiling as 50% to 150% of discretionary spending without a default percentage (decision 17); the under-specified Trinity convention (§7.8); no check of a stochastic model (R4); the truncated values (WD-3 is 41,871.17; the surplus is 31,768.72); ten of thirty rows printed (both R2 tables are complete); 59½ as age attained 60 (request T3); conversions only in today's dollars (the inputs design's `dollars` field).

**Wrong or doubtful figures, and what was done.** A's WD-2 taxable income 24,731.61 (24,731.62) and its tie at 16,161.825: the case now uses a target of 61,000. A's 2030 "End pre-tax" 1,234,028.26: 1,234,028.25. A's WD-9 weights: the start-of-year balances 869,376.38 and 364,651.88. A's slope bound "0.39, 61%": about 63% with the senior deduction's phase-out stacked (§3.7). A's 4.502% geometric mean for bonds, its "33-year minimum" and its 4.15% assertion: not used; the data checks are the engine design's. A's 25% and 10% band: not used as defaults. B's 41,871.16, 18,711.65 and 31,768.71: 41,871.17, 18,711.66 and 31,768.72. B's "1 to 4 points" for start-of-year timing: on the 69 windows the gap to the study's convention is 1.4 points at 50% stocks and 4.3 at 75% (65 and 68 of 69 against 64 and 65), and 2.9 and 5.8 at 100% and 25% (66 and 55 against 64 and 51). B's Trinity values for 100%, 25% and 0% stocks: listed for information, not asserted. B's default guardrail rate of 5.0% and band of 50% to 150%: gone with the settings they belonged to. Every R3 dollar figure was recomputed from the pinned six-decimal file (the 1928 path ends at 1,069,960.25 in today's dollars, not 1,069,964.25).

**Where a judge is overruled, or a graft is not taken, and why.**

1. *The long-term care cost reads the death year* (judge 2's flaw against A). Kept: judge 1 counted a reserve that never costs anything as a flaw, the inputs design freezes the cost per person, and the death year is read by that scheduled cost only.
2. *"Use B's gross-withdrawal Guyton-Klinger"* (judge 1's first suggestion). Not taken as written: both judges faulted that variant for ignoring the plan and for the jump when Social Security starts. The reference track is B's rule when there is no outside income, compares the same two quantities as A's "rebase" test until a rule fires, and removes the defect judge 1 demonstrated by applying cuts and raises to the portfolio-funded part only.
3. *Tax worksheet with ordinary tax by bracket and a marginal rate* (judge 2). The drawer is built from scalar lines only, for judge 1's reason: nothing is added to the tax function's result in the hot loop.
4. *A read-only preview route* (judge 2). Not built, for judge 1's reason; the hints it fed are computed in the browser from a route that already exists.
5. *Stored worst, best and typical-failure paths and selection by path index* (judge 2; judge 1 in part). They are percentile shortcuts: the inputs design stores tables by percentile and re-simulates the rest.
6. *An essential flag on goals* (judge 1). Not taken: the frozen input has no such field; every dated goal is required (open question 6).
7. *A heartbeat on `job.started_at`* (both). Not needed: the inputs design caps a run at 15 minutes, below the 30-minute sweep.
8. *A's simpler first-year rule* (both judges counted it in A's favour). Dropped because both merged designs prorate; the strategy formulas stay free of the fraction all the same (decision 2).
9. *A success-rate standard error* (both). The engine's Wilson interval is shown instead; it is absent for the historical model, as the judges asked of the standard error.
