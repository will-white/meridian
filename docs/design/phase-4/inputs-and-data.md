# Phase 4 design: Inputs, data model, seeding and API

Area (lead decision L8): the planner's database tables, the household profile document, scenarios, seeding from live data (the "baseline"), the frozen run input, the `retirement.simulate` job, result storage and retention, the API contracts and routes, and the data behind the dashboard card. The engine, the tax functions, the strategies and the web pages belong to the other three areas; what this area assumes of them is in section 9.

This is the merged design. Two independent designs (A, owner-first; B, contract-first) were scored by two judges, who split one each with equal totals; section 12 records the scores and what was taken from each. The document is self-contained: build from it without the originals.

State of the evidence:

- Nothing in the repository was changed except this file. The repository moved while this was written (audit-remediation commits up to `786cb0d`); every codebase fact below was checked at that commit, and code is cited by function name, never by line.
- Every figure in sections 3 and 7 was recomputed with a BigInt scratch script that mirrors the repository's `truncDiv`, `ceilDiv` and `allocateLargestRemainder` (`/tmp/claude-0/-home-user-meridian/43edefe1-baf6-5f06-8731-a1a0b4944819/scratchpad/merge-inputs/calc.mjs`). No database suite was run.
- Direct fetches of `www.irs.gov` and `www.ssa.gov` were refused again in this session (`ENOTFOUND`; both hosts have to be allowed in the session's network settings). External figures rest on web search and are listed with their status in section 10.

Files this area adds:

- `packages/shared/src/retirement/`: `primitives.ts`, `profile.ts`, `baseline.ts`, `settings.ts`, `input.ts`, `mergePatch.ts`, `resolve.ts`, `freeze.ts`, `baselineDiff.ts`, `percentile.ts`, `api.ts`, `index.ts`, each with its `*.test.ts`. The other areas put their wire schemas in the same directory (section 9).
- `packages/db/src/schema/retirement.ts`; one migration (section 2); services `retirementBaseline.ts`, `retirementProfile.ts`, `retirementScenarios.ts`, `retirementRuns.ts` in `packages/db/src/services/`; fixture `packages/db/src/test/retirementSeed.ts`.
- `apps/api/src/routes/retirement.ts`, `apps/api/src/views/retirement.ts`.
- `apps/worker/src/jobs/retirementSimulate.ts`, `apps/worker/src/simThread.ts`.

Files this area touches: `packages/shared/src/{enums.ts,api.ts,index.ts}`; `packages/db/src/schema/{sources.ts,plan.ts,index.ts}` (`JOB_TYPES`, `AUDIT_ENTITIES`); `packages/db/src/services/plan.ts` (export the private `loadActuals` as `loadCategoryActuals`); `packages/db/src/services/dashboard.ts` (export the private `latestBalances`; fill `retirement`); `packages/db/src/services/index.ts`; `apps/api/src/{app.ts,routes/dashboard.ts,views/cashflow.ts,test/helpers.ts}`; `apps/worker/src/{env.ts,jobs/index.ts,jobs/context.ts}`, `apps/worker/package.json` (second bundle); `.env.example` and `deploy/docker-compose.yml` (three worker variables).

## 1. Decisions (binding)

1. **The profile is one versioned, Zod-validated JSON document** (`plan_profile.doc`, `schemaVersion: 1`) in a singleton row (`id = 1`, the `household_setting` pattern). Reason: it is read, written, frozen, overridden and audited whole, never queried by inner field, and there is one household.
2. **The stored documents hold no nulls and no floats.** The profile, the baseline and the frozen input contain only strings, safe integers, booleans, arrays and objects; an absent value is an absent key; objects are `.strict()`. Collections a scenario may change item by item are maps keyed by a stable id; only lists that are always edited whole are arrays. Reason: RFC 7396 merge patches use `null` for "delete" and replace arrays whole, and canonical hashing is then trivial.
3. **A scenario is a minimal RFC 7396 merge patch over the profile document plus its own run settings.** The editor sends the full edited document; the server stores `diffPatch(profile.doc, edited)`. Reason: the base profile stays the single source, a value edited back to the base leaves the patch, and the patch is v2's "what changed".
4. **Live data enters through a stored baseline** (`plan_profile.baseline`): balances, cost basis, allocation, spending, contributions and the measured savings rate, computed from live data. A run request refreshes it by default (`refresh: true`) and returns what changed; "Refresh from live data" previews the same diff before applying it. A run is refused when the baseline it would use is more than 35 days old. Reason: the spec's "pulled live" is the default path, the starting values of a run are visible before it starts, and two scenarios can still be run on identical starting values (`refresh: false`).
5. **Seedable inputs carry a mode, never a copied number**: base spending, essential spending, each contribution and each employer match are `live` (use the baseline) or a typed value. Reason: a refresh updates every live field and never overwrites something the owner typed.
6. **One pure resolver.** `resolvePlan` (shared, synchronous) turns profile + baseline + overrides + settings into the frozen input and the issue list. The API's preview, the run freezer, the web form's inline validation and the tests all call it.
7. **The frozen input (`SimInput`, stored in `sim_run.input`) is self-contained and hashed.** Resolved calendar months, annual cents, per-account balances, basis and allocation, the settings and the data version. The engine reads nothing else: no database, no clock. `input_hash` is the SHA-256 of its canonical JSON without `meta` and display names. Reason: the spec's accuracy guardrail and L7; the hash gives run reuse and an exact "inputs changed" flag.
8. **Every retirement wire schema lives in `packages/shared/src/retirement/`; `@meridian/retirement` depends on `@meridian/shared`, never the reverse.** `packages/db` depends on neither engine nor data: engine facts (versions, rule set ids, limits) are passed into its services as a `PlannerEnv` value. Reason: no workspace cycle, and the API and web already import contracts from shared.
9. **The planner bucket is derived, not stored** (section 3.1): from the account's tax treatment, or the type's default treatment when the treatment is `none`; checking and savings are `cash`. Reason: tax treatment has one home, the Accounts page.
10. **Ownership is a planner setting per account and is required** for pre-tax, Roth and HSA accounts in a two-person household (`owner_required` blocks a run). Reason: RMD age, the 59½ and 65 penalty ages and "contributions until retirement" follow the owner; a silent default would let them follow the wrong person.
11. **Unknown cost basis counts as 0 unless the owner enters it**, with the affected dollars named in a warning; a typed basis is used as entered, including one above the balance (an unrealized loss). Reason: the Phase 3 rule (unknown basis is 0 in the lot engine) and it errs toward more tax.
12. **The six asset classes reach the engine unchanged.** Unclassified accounts take, in order: the account's own override, the owner's typed default, the household allocation targets, the household's actual mix, then 60/40; every borrowed mix except the owner's own entries raises a warning. Reason: the engine area owns the mapping to return series (L8); a borrowed allocation must be visible.
13. **Base spending = the bills and spending buckets over the last 12 complete months the plan's ledger covers in full, plus uncategorized outflows** (itemized, switchable). Essential spending defaults to the bills bucket. Spending after the first death is a typed share (default 100%). Reason: equals the grid's Actual column plus one visible, conservative addition; the floor-and-ceiling strategy needs the essentials figure.
14. **Contributions = net external cash flows into each investment account over the same window** (the Phase 3 flow loader), moves between plan accounts removed, annualized over the full months with data (at least 3), falling back to an active recurring transfer into the account. They are frozen as year-0 dollars that scale with the owner's (or the household's) salary until retirement.
15. **Employer money is detected by description, else by subtraction, else typed.** Reason: a 401(k) feed does not label the split reliably.
16. **Gross salary and Social Security are typed, never seeded.** Reason: the ledger sees take-home pay only; the benefit comes from the SSA statement.
17. **Raises are real (above inflation), in basis points a year.** Reason: inflation is stochastic per path (L4).
18. **Amounts are today's dollars unless a field says `nominal`** (a pension quoted at 65, a goal with a fixed price).
19. **First, partial year (L3): the plan starts at the month boundary nearest the baseline's as-of date.** `startMonth` is the as-of month when the day is 15 or earlier, else the next month; year 0 runs from `startMonth` through December, `firstYearMonths = 13 − month(startMonth)`. In every year a flow counts the months of its window that fall in that year, twelfths of its annual amount. Resolved once into the frozen input; no area recomputes it.
20. **A person reaches age A in month `birthMonth` of year `birthYear + A`**; every "when" in the profile resolves to a `YYYY-MM` in the frozen input. Reason: annual steps with month-exact prorating, and a monthly engine later needs no contract change.
21. **Results are stored as a summary and a fan chart (jsonb), two per-path series (bytea: ending wealth in today's cents, depletion year) and seven full year tables** (percentiles 5, 10, 25, 50, 75, 90, 95). Any other integer percentile 1..99 is re-simulated on request (L5) while the engine and data versions match, and is checked against the stored series.
22. **A percentile path is a real path**: nearest rank on ending wealth in today's dollars, ties broken by earlier depletion year, then path index.
23. **One job type `retirement.simulate`, keyed per run** (`dedupeKey: "retirement.simulate:<runId>"`), enqueued in the transaction that inserts the `sim_run`. At most one queued or running run per scenario (partial unique index). A request whose input hash equals the active run's, or the newest finished run's under the same engine version, returns that run.
24. **Progress, cancellation and crash recovery**: the worker's throttled progress `UPDATE … RETURNING cancel_requested` carries both; a run is capped at 15 minutes; a job that the stale sweep has requeued past its attempts fails the run with `worker_crashed` instead of looping.
25. **The stored path count is the engine's.** `sim_run.paths` holds the requested count until the engine reports its own (the historical model runs every start year); the success rate divides by the actual count.
26. **Thread count is `RETIREMENT_THREADS`** (worker environment): unset or `auto` = `min(8, max(1, availableParallelism − 1))`. Results never depend on it (L5).
27. **One shared default seed (1).** Scenarios share market paths unless the owner changes a seed, so the difference between two scenarios is not sampling noise.
28. **Retention per scenario**: every pinned run (at most 20), the newest `RETIREMENT_KEEP_RUNS` (default 20) finished unpinned runs, and the newest 5 failed or cancelled runs; pruned in the transaction that finishes a run.
29. **Audit**: `plan_profile`, `plan_baseline`, `scenario` and `sim_run` join `AuditEntity`; one batch per request through `writeAudit`, never when nothing changed; revert routes re-apply an audit row's `before`.
30. **Optimistic concurrency**: the profile and scenarios carry `revision`; writes send `expectedRevision`; a mismatch is `409 revision_conflict`.
31. **Viewer role**: every read is a GET; every mutation, including starting a run, is owner-only through the existing auth plugin.
32. **Saving is lenient, running is strict**: a PUT validates shape only and returns the semantic issues; a run is refused with `409 plan_incomplete` while any issue has severity `error`.
33. **Dashboard card = the newest finished run of the default scenario**, with staleness flags; `null` until a profile exists.
34. **Conventions kept**: service errors are `PlanError` with status 400, 404 or 409 only; deletes answer `200 OkResponse`; request contracts use the bounded wire shapes (`NonNegCentsInput`, `MonthInput`, `IsoDateInput`), because the API refuses to register a route whose request contract uses the loose ones.

## 2. Data model

Conventions as in Phases 1 to 3: `uuid` ids with `gen_random_uuid()`, `bigint` cents, `date` and `timestamptz`, text enums mirrored from `enums.ts` with named CHECKs. JSON columns hold cents as decimal strings; no float is stored. One Drizzle file `packages/db/src/schema/retirement.ts`. No backfill.

**Migration number.** Both source designs named the migration `0004_phase4_retirement`; index 4 is taken by `0004_auth_hardening` (audit remediation). The migration is generated with `pnpm db:generate` and takes the next free index: `0005_phase4_retirement` at commit `786cb0d`. If remediation adds another migration first, use what the generator assigns and keep the suffix.

### 2.1 `plan_profile` (household facts and the stored baseline; one row)

```sql
CREATE TABLE "plan_profile" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "schema_version" integer NOT NULL,                 -- = doc.schemaVersion (count)
  "doc" jsonb NOT NULL,                              -- RetirementProfileDoc (4.2)
  "revision" integer DEFAULT 1 NOT NULL,             -- +1 on every change of doc (count)
  "baseline" jsonb NOT NULL,                         -- RetirementBaseline (4.3)
  "baseline_as_of" date NOT NULL,                    -- = baseline.asOf, the valuation date
  "baseline_hash" text NOT NULL,                     -- 64 hex chars (3.7)
  "baseline_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plan_profile_singleton" CHECK ("id" = 1),
  CONSTRAINT "plan_profile_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "plan_profile_doc_object" CHECK (jsonb_typeof("doc") = 'object'),
  CONSTRAINT "plan_profile_baseline_object" CHECK (jsonb_typeof("baseline") = 'object')
);
```

### 2.2 `scenario` (overrides and run settings)

```sql
CREATE TABLE "scenario" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "notes" text,
  "is_default" boolean DEFAULT false NOT NULL,       -- feeds the dashboard card; exactly one
  "position" integer DEFAULT 0 NOT NULL,             -- list order
  "archived" boolean DEFAULT false NOT NULL,
  "overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,    -- minimal RFC 7396 patch over plan_profile.doc
  "settings" jsonb NOT NULL,                         -- RunSettings (4.4)
  "revision" integer DEFAULT 1 NOT NULL,             -- count
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scenario_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "scenario_overrides_object" CHECK (jsonb_typeof("overrides") = 'object'),
  CONSTRAINT "scenario_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
  CONSTRAINT "scenario_default_not_archived" CHECK (NOT ("is_default" AND "archived")),
  CONSTRAINT "scenario_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "scenario_name_idx" ON "scenario" (lower("name"));
CREATE UNIQUE INDEX "scenario_default_idx" ON "scenario" ("is_default") WHERE "is_default";
```

At most 50 scenarios that are not archived (service check, `409 too_many_scenarios`).

### 2.3 `sim_run` (frozen input, versions, seed, progress, results)

```sql
CREATE TABLE "sim_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scenario_id" uuid NOT NULL REFERENCES "scenario"("id") ON DELETE CASCADE,
  "scenario_name" text NOT NULL,                     -- as it was when frozen
  "job_id" uuid REFERENCES "job"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'queued' NOT NULL,           -- queued | running | done | failed | cancelled
  "cancel_requested" boolean DEFAULT false NOT NULL,
  "input" jsonb NOT NULL,                            -- SimInput (4.5): the frozen snapshot
  "input_schema_version" integer NOT NULL,           -- = input.schemaVersion (count)
  "input_hash" text NOT NULL,                        -- 64 hex chars (3.7)
  "seed" bigint NOT NULL,                            -- = input.settings.seed, 0..4294967295
  "paths" integer NOT NULL,                          -- requested count; the engine's own count from its first progress report on
  "return_model" text NOT NULL,                      -- input.settings.returnModel.kind (for lists)
  "strategy" text NOT NULL,                          -- input.settings.strategy.kind
  "tax_rule_set" text NOT NULL,                      -- input.settings.taxRuleSet
  "data_version" text NOT NULL,                      -- = input.data.version
  "engine_version" text,                             -- stamped by the worker when it starts the run
  "baseline_as_of" date NOT NULL,                    -- = input.meta.asOf
  "profile_revision" integer NOT NULL,
  "scenario_revision" integer NOT NULL,
  "threads" smallint,                                -- worker threads used (count; 0 = inline)
  "paths_done" integer DEFAULT 0 NOT NULL,           -- count
  "progress_at" timestamp with time zone,            -- last progress write (heartbeat)
  "success_paths" integer,                           -- exact count; rate = success_paths / paths
  "summary" jsonb,                                   -- SimSummary (strategies area), cents as strings
  "fan" jsonb,                                       -- FanSeries (strategies area)
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,     -- engine warnings [{ code, message }]
  "error_code" text,
  "error_message" text,                              -- sanitized, at most 500 chars
  "duration_ms" integer,                             -- milliseconds
  "pinned" boolean DEFAULT false NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "sim_run_status_check" CHECK ("status" IN ('queued','running','done','failed','cancelled')),
  CONSTRAINT "sim_run_seed_check" CHECK ("seed" >= 0 AND "seed" <= 4294967295),
  CONSTRAINT "sim_run_paths_check" CHECK ("paths" >= 1 AND "paths_done" >= 0),
  CONSTRAINT "sim_run_done_shape" CHECK ("status" <> 'done' OR (
     "summary" IS NOT NULL AND "fan" IS NOT NULL AND "success_paths" IS NOT NULL AND "engine_version" IS NOT NULL
     AND "finished_at" IS NOT NULL AND "success_paths" >= 0 AND "success_paths" <= "paths" AND "paths_done" = "paths")),
  CONSTRAINT "sim_run_failed_shape" CHECK ("status" <> 'failed' OR "error_code" IS NOT NULL)
);
CREATE INDEX "sim_run_scenario_created_idx" ON "sim_run" ("scenario_id", "created_at" DESC);
CREATE UNIQUE INDEX "sim_run_active_idx" ON "sim_run" ("scenario_id") WHERE "status" IN ('queued','running');
CREATE INDEX "sim_run_done_idx" ON "sim_run" ("scenario_id", "finished_at" DESC) WHERE "status" = 'done';
CREATE INDEX "sim_run_hash_idx" ON "sim_run" ("scenario_id", "input_hash");
```

There is no `paths_done <= paths` CHECK: the engine's count can be below or above the requested one, and both columns are written by the same statement. List queries select named columns and never read `input` or `fan`.

### 2.4 `sim_run_series` (one value per path) and `sim_run_path` (stored year tables)

```sql
CREATE TABLE "sim_run_series" (
  "run_id" uuid NOT NULL REFERENCES "sim_run"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,          -- ending_real_cents | depletion_year
  "encoding" text NOT NULL,      -- i64le: signed 64-bit little-endian, cents in today's dollars
                                 -- i16le: signed 16-bit little-endian, calendar year, -1 = never depleted
  "count" integer NOT NULL,      -- values = sim_run.paths
  "data" bytea NOT NULL,         -- count x 8 bytes (i64le) or count x 2 bytes (i16le), path 0 first
  CONSTRAINT "sim_run_series_pk" PRIMARY KEY ("run_id", "kind"),
  CONSTRAINT "sim_run_series_kind_check" CHECK ("kind" IN ('ending_real_cents','depletion_year')),
  CONSTRAINT "sim_run_series_shape" CHECK (("kind" = 'ending_real_cents' AND "encoding" = 'i64le' AND octet_length("data") = 8 * "count")
                                        OR ("kind" = 'depletion_year' AND "encoding" = 'i16le' AND octet_length("data") = 2 * "count"))
);
CREATE TABLE "sim_run_path" (
  "run_id" uuid NOT NULL REFERENCES "sim_run"("id") ON DELETE CASCADE,
  "percentile" smallint NOT NULL,                    -- 5, 10, 25, 50, 75, 90, 95
  "path_index" integer NOT NULL,                     -- the engine's path k (re-simulatable alone, L5)
  "rank" integer NOT NULL,                           -- position in the rank order (0 = worst)
  "ending_real_cents" bigint NOT NULL,               -- ending wealth in today's dollars
  "depleted_year" integer,                           -- first calendar year the plan ran out; null = never
  "year_table" jsonb NOT NULL,                       -- YearTable (strategies area), cents as strings
  CONSTRAINT "sim_run_path_pk" PRIMARY KEY ("run_id", "percentile"),
  CONSTRAINT "sim_run_path_percentile_check" CHECK ("percentile" BETWEEN 1 AND 99),
  CONSTRAINT "sim_run_path_index_check" CHECK ("path_index" >= 0 AND "rank" >= 0)
);
```

drizzle-orm 0.38 has no built-in `bytea`; `schema/retirement.ts` declares `customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea" })`.

### 2.5 Enum and existing-table touches (code only, no DDL)

`job.type` and `audit_log.entity` carry no database CHECK, so the new members need no migration.

- `JobType` (`enums.ts`) and `JOB_TYPES` (`schema/sources.ts`) += `retirement.simulate`.
- `AuditEntity` (`enums.ts`) and `AUDIT_ENTITIES` (`schema/plan.ts`) += `plan_profile`, `plan_baseline`, `scenario`, `sim_run`.
- New enums in `enums.ts`: `PlanBucket = taxable | pre_tax | roth | hsa | cash`; `PersonId = p1 | p2`; `OwnerId = p1 | p2 | joint`; `SimRunStatus = queued | running | done | failed | cancelled`; `IncomeKind = salary | part_time | pension | annuity | rental | other`; `PlanIssueSeverity = error | warning`; `BasisCoverage = full | partial | none | manual`; `AllocationSource = holdings | override | profile_default | household_target | household_actual | assumed | cash | pretax_mix`; `DollarBasis = today | nominal`.
- `DashboardView.retirement` changes from `z.null()` to the card of 4.9.

### 2.6 Existing tables read, never written

`account`, `balance_snapshot`, `holding_snapshot`, `lot`, `investment_txn`, `price`, `security`, `security_allocation`, `allocation_target`, `transaction`, `split`, `category`, `recurring`, `household_setting`. The planner writes its five tables, `job` and `audit_log`.

### 2.7 Sizes (estimates, not measurements; 10,000 paths, the fixture household: 47 plan years, 8 accounts)

| Item | Count | Bytes |
| --- | --- | --- |
| `input` | 8 accounts, 3 income streams, settings | about 15 KB of JSON |
| `summary` | scalars and percentile sets | about 2 KB |
| `fan` | 2 bases x 7 percentiles x 47 years x about 13 B = about 8.6 KB, plus keys | about 12 KB |
| `sim_run_series` | 10,000 x 8 B + 10,000 x 2 B | 100 KB (1 MB at 100,000 paths) |
| `sim_run_path` | 7 tables x 47 years x about 40 values x about 11 B = about 145 KB, plus keys | about 160 KB |
| **Per run** | | **about 0.3 MB before compression** |

With 20 kept runs that is about 6 MB per scenario. The implementer measures the fixture run once (`pg_column_size`) and records the real figure here; nothing depends on the estimate.

### 2.8 Data files

This area ships none. It records the data manifest version on every run (`input.data.version`, `sim_run.data_version`) and consumes three functions the tax area builds from its data files (section 9).

## 3. Algorithms

Rounding in this area: sums of cents are exact; annualizing, percent-of-salary amounts and basis-point ratios truncate toward zero (`truncDiv`, the Phase 2 rule); weights in basis points use largest remainder (`allocateLargestRemainder`, R4, ties to the lower index) so they sum to 10000. The engine's own conversion to dollars (L1) is outside this area.

### 3.1 Planner bucket (`planBucketOf(type, taxTreatment)`)

| `account.type` | `account.tax_treatment` | Bucket | Note |
| --- | --- | --- | --- |
| `checking`, `savings` | `none` | `cash` | |
| `checking`, `savings` | any other | `cash` | warning `cash_account_treatment` (a bank account type cannot hold a tax treatment in the plan; change the type on the Accounts page if it is an HSA or IRA) |
| `brokerage`, `401k`, `ira`, `roth`, `hsa` | `taxable`, `pre_tax`, `roth`, `hsa` | the treatment | |
| `brokerage`, `401k`, `ira`, `roth`, `hsa` | `none` | `defaultTaxTreatment[type]` (taxable, pre_tax, pre_tax, roth, hsa) | `treatmentDefaulted`, warning `tax_treatment_defaulted` |
| `529` | any | none (`ineligible: education`) | listed, never included |
| `credit`, `loan`, `asset` | any | none | not listed |

Closed accounts are never listed. Default owner: the only person in a one-person household; `joint` for `taxable` and `cash` in a two-person household; none for `pre_tax`, `roth`, `hsa` in a two-person household (error `owner_required` until set). A `pre_tax`, `roth` or `hsa` account cannot be `joint`.

Both source designs differed here and both were faulted: one left an investment account with treatment `none` out of the plan (understating assets), the other taxed it as a brokerage account (a 401(k) with no RMDs). The type's default treatment with a warning is the reading that is right in the common case and visible when it is not.

### 3.2 Baseline (`computeBaseline(db, { today, now })`, `retirementBaseline.ts`, read-only)

`today` is the client's date through `resolveToday`; `now` the server clock.

**B1. Dates.** `asOf = defaultAsOf(today, now)` (the latest close the feed can have, never after today: the investment views' default).

**B2. Investment accounts.** `ctx = investmentContext(db, { today, now })` (one call: the valuation chain per account, securities with splits, the lot engine's holdings, the statement's reported basis, the household targets). For each `ctx.accounts[i]` (the six investment types, by name then id): `valueCents = valuation.valueCents` (absent when the chain has no value), `valuationDate = valuationRef.valuationDate`, `valuationBasis = valuationRef.basis`, `stale = valuationRef.valuationStale`, `fidelity = ref.fidelity`.

**B3. Bank accounts.** Open `checking` and `savings` accounts: the row of `latestBalances(db, today)` (the net worth rule: the latest `balance_snapshot` on or before today, any source), `valuationBasis = "bank_balance"`, `stale` when the row is more than 35 days before `today`. No row: no value. A negative balance is kept in the baseline; the resolver uses 0 and warns `negative_balance`.

**B4. Allocation.** For an account the chain classified (`ctx.accounts[i].classified`: basis `snapshot`, `lots` or `positions`): `classCents[c] = Σ line.classCents[c]` over `classifiedLines(ctx, new Set([id]))` (exact: `splitValue` puts the remainder on the primary class, so the six sums equal the account value). `weights = classWeights(classCents)`: `allocateLargestRemainder(10000n, [us_stock, intl_stock, bonds, cash, real_estate, other])`, and absent when the total is 0 or less or any class sum is negative (`allocateLargestRemainder` throws on a zero total). The baseline also stores `allocationTargets`: `ctx.targets` as six weights when the household has set targets, else absent.

**B5. Cost basis (bucket `taxable` only).** `basis = holdingCostBasis(ctx)`. For each line of the account: a line that is not a position, or whose security is cash, adds its value to `knownCents`; a position looks up `basis.get(accountId + "|" + securityId)`: a non-null `costBasisCents` adds to `knownCents`, and a lot-engine line with `unknownBasisQuantity > 0` also adds `truncDiv(valueCents × unknownBasisQuantity, quantity)` to `unknownValueCents`; a null `costBasisCents` adds the line's whole value to `unknownValueCents`. An unclassified account (balance only) has `knownCents = 0`, `unknownValueCents = valueCents`. `coverage = full` when `unknownValueCents = 0`; `none` when no position has a basis; else `partial`. `source = lots | statement | mixed` over the positions that have one.

**B6. Window.** `m = monthKey(today)`; window = the 12 complete months `[m − 12, m − 1]` (`averageWindow(m, 12)`); `lo = monthStart(m − 12)`, `hi = monthStart(m)`. The plan's ledger covers a month in full from `firstFull = firstFullLedgerMonth(earliest)`, where `earliest` is the earliest transaction date of any on-budget account (the `planAverages` rule since the plan-math remediation: the first month counts only when its first transaction is dated the 1st). Counted months are the window months on or after `firstFull`; `k` is their count (`window.monthsWithData`); `lo′ = max(lo, monthStart(firstFull))`. Every ledger sum below is over `[lo′, hi)`, so a partial first month is in neither the sum nor the divisor.

**B7. Spending and income.** Rows: `loadCategoryActuals(db, lo′, hi)` (the plan's own loader, exported: categorized non-transfer rows, splits replacing their parent, on-budget accounts or the feed category, posted and pending). For each category in bucket `bills` or `spending`: `cents = −Σ signedCents` (bucket-natural; a refund reduces it; may be negative), `activeMonths` = months with a row. `categorizedCents` and `billsCents` are the sums over both buckets and over `bills`. Uncategorized rows over the same dates (the predicate of the plan's `loadUncategorized`, split by sign):

```sql
SELECT count(*)::int,
       coalesce(sum(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0)::bigint AS outflow_cents,
       coalesce(sum(CASE WHEN t.amount_cents > 0 THEN  t.amount_cents ELSE 0 END), 0)::bigint AS inflow_cents
FROM "transaction" t JOIN account a ON a.id = t.account_id
WHERE t.category_id IS NULL AND t.is_transfer = false AND a.on_budget = true
  AND t.date >= $lo_prime AND t.date < $hi
  AND NOT EXISTS (SELECT 1 FROM split s WHERE s.transaction_id = t.id);
```

Income from the same actuals: `takeHomeCents = Σ signedCents` over income-bucket categories other than `household_setting.investment_income_category_id`; `investmentIncomeCents` = that category's sum (shown, never used: investment income is already inside the simulated returns).

**B8. Contributions.** Accounts: the investment accounts with a bucket (`plannerInvestmentIds`). `flows = loadFlowRows(db, ids, addDays(lo, −1), addDays(hi, −1))` (the loader's window is `(from, to]`, so this is every flow dated in the window: posted ledger transfers, investment cash transfers deduplicated, securities transfers at market). Descriptions by `sourceId`: `transaction.raw_description` for ledger flows, `investment_txn.raw_description` then `memo` for the others. First data dates: `firstDataDates(db, ids, ctx.fidelities)`. The pure `aggregateContributions(flows, descriptions, plannerInvestmentIds, firstDataDates, window)`:

- drop `kind = "securities"` flows and any flow whose `counterpartyAccountId` is in `plannerInvestmentIds` (a rollover or a move between plan accounts is internal);
- per account, `coverageStart` = the earlier of its first data date and its earliest remaining flow date; `firstFull = firstFullLedgerMonth(coverageStart)`; flows before `monthStart(firstFull)` are dropped; `k` = window months on or after `firstFull` (`monthsWithData`);
- `grossInCents = Σ positive`, `outCents = Σ |negative|`, `netCents = max(0, grossIn − out)`, `unpairedCents = Σ positive with counterpartyAccountId null` (payroll deferrals and employer money never pass through a bank account);
- employer detection: a positive flow whose description matches `/\b(employer|match|safe harbor|profit.?shar|non.?elective)/i` is employer money; `employerCents = min(netCents, Σ matched)`, `employerDetected = employerCents > 0`, `employeeCents = netCents − employerCents`;
- `k ≥ 12`: the annual figures are the sums; `3 ≤ k < 12`: each is `truncDiv(x × 12, k)`, flag `partial_window`; `k < 3`: the annual figures are absent, flag `insufficient_history`;
- flag `irregular` when one positive flow exceeds half of `grossInCents`; flag `has_withdrawals` when `outCents > 0`.

Recurring fallback (in the service): when an account's `annualNetCents` is absent or 0, `plannedCents = Σ |expected_cents| × CADENCE_TABLE[cadence].occurrencesPerYear` over `recurring` rows with `status = 'active'` and `transfer_account_id = account` (the Phase 2 yearly equivalent: 52, 26, 24, 12, 6, 4, 2, 1). `source = measured` when `annualNetCents > 0`, else `recurring` when `plannedCents > 0`, else `none`.

**B9. Measured savings rate** (reported, never an input): `contributionsCents = Σ annualNetCents`, `payrollCents = Σ annualUnpairedCents`, `baseCents = takeHomeCents + payrollCents` (money that never reached the budget is added back to income), `bp = truncDiv(contributionsCents × 10000, baseCents)` when `baseCents > 0`, else absent.

**B10. Hash.** `baselineHash = sha256Hex(canonicalJson(baseline without computedAt and today))` (3.7).

**Worked example** (the fixture of 7.0; today 2026-10-14, asOf 2026-10-13; amounts in cents):

| Account | Bucket | Value | Basis (taxable) | Weights (bp: US, intl, bonds, cash) |
| --- | --- | --- | --- | --- |
| Vanguard Brokerage (B) | taxable | 2,705,200 | known 2,378,200, unknown 0, `full`, `lots` | 6839, 2632, 0, 529 |
| Old Brokerage (T) | taxable | 432,500 | known 200,000, unknown value 120,000, `partial`, `statement` | 10000, 0, 0, 0 |
| Acme 401(k) (K) | pre_tax | 15,000,000 | | unclassified |
| Fidelity Roth IRA (R) | roth | 1,820,000 | | 4680, 831, 4341, 148 |
| HealthEquity HSA (H) | hsa | 125,000 | | unclassified |
| Checking (C) | cash | 500,000 | | |
| Savings (S) | cash | 2,000,000 | | |
| College 529 (E) | none | 1,200,000 | | `ineligible: education` |

- B's basis: lots VTI 500,000 + 580,000, VXUS 580,000, AAPL 575,000 = 2,235,000, plus the cash line 143,200 = 2,378,200.
- B's weights: class cents 1,850,000 (VTI 1,250,000 + AAPL 600,000) / 712,000 / 0 / 143,200 of 2,705,200; exact shares 6838.68, 2631.97, 529.35; floors 6838 + 2631 + 529 = 9998; the two largest remainders (.97 intl, .68 US) take the two spare points: 6839, 2632, 529.
- R's weights: the target-date fund's 420,000 splits 54/36/10 into 226,800 / 151,200 / 42,000; class cents 851,800 / 151,200 / 790,000 / 27,000 of 1,820,000; shares 4680.22, 830.77, 4340.66, 148.35; floors sum to 9998; remainders .77 (intl) and .66 (bonds) win: 4680, 831, 4341, 148.
- Household targets (the seed's): 5000, 2500, 2000, 500. Household actual mix over the classified accounts B, R, T: 3,134,300 / 863,200 / 790,000 / 170,200 of 4,957,700; shares 6322.08, 1741.13, 1593.48, 343.30; floors sum to 9999; bonds takes the spare point: 6322, 1741, 1594, 343.
- Totals: taxable 3,137,700; pre_tax 15,000,000; roth 1,820,000; hsa 125,000; cash 2,500,000; all bucketed 22,582,700.
- Window 2025-10..2026-09; the earliest on-budget transaction is 2025-09-03, so `firstFull` = 2025-10 and `k` = 12. Rent 12 x 200,000 = 2,400,000 (bills); Groceries 12 x 80,000 − 5,000 refund = 955,000; Childcare 12 x 50,000 = 600,000; `categorizedCents` 3,955,000; `billsCents` 2,400,000; uncategorized: 2 rows, outflows 45,000, inflows 20,000. Income: Paycheck 12 x 700,000 = 8,400,000 take-home; Dividends 4,720 (not used).
- Contributions: K gross 1,800,000, all unpaired, employer detected 600,000, employee 1,200,000, `k` 12; B 500,000 in one paired transfer from Checking (`irregular`); H 120,000 in 4 months (first data date 2026-06-01, so `firstFull` 2026-06 and `k` 4): annual `truncDiv(120,000 × 12, 4)` = 360,000 (`partial_window`); R no flows (first data date 2025-10-13, `firstFull` 2025-11, `k` 11, annual net 0, flag `partial_window`), `plannedCents` 12 x 25,000 = 300,000 from the recurring transfer (`source: recurring`); T first data date 2026-10-13, `k` 0 (`insufficient_history`, `source: none`).
- Savings rate: contributions 1,800,000 + 500,000 + 360,000 = 2,660,000; payroll 1,800,000 + 360,000 = 2,160,000; base 8,400,000 + 2,160,000 = 10,560,000; `truncDiv(2,660,000 × 10000, 10,560,000)` = 2518 bp (25.18%).

### 3.3 Merge patch and minimal patch (`mergePatch.ts`)

`mergePatch(target, patch)` is RFC 7396: when `patch` is not a plain object the result is `patch`; otherwise for each key, `null` deletes the key, an object value merges recursively (into an object, or replaces a non-object), anything else (scalar, array) replaces.

`diffPatch(base, target)` builds the minimal patch: for each key in the union, absent in `target` → `null`; both plain objects → recurse, kept when non-empty; not deep-equal → the target value (arrays compare by deep equality and replace whole); equal → omitted. Invariant: `mergePatch(base, diffPatch(base, target))` deep-equals `target` for null-free documents.

`overrideChanges(doc, overrides)` lists the patch's leaves as `{ path, before?, after? }` (a `null` leaf is a removal).

The effective document of a scenario is `RetirementProfileDoc.parse(mergePatch(profile.doc, scenario.overrides))`. `overrides` never contains `schemaVersion`.

Worked example. Base (abbreviated): `{ "people": { "p1": { "retirementAge": 60 } }, "spending": { "base": { "mode": "manual", "annualCents": "4000000" } }, "incomes": { "salary_p1": { "annualGrossCents": "12000000" }, "pen1": { "monthlyCents": "100000" } } }`. Target: retirement age 58, spending base `{ "mode": "live" }`, salary 11,000,000, no pension. Patch: `{ "people": { "p1": { "retirementAge": 58 } }, "spending": { "base": { "mode": "live", "annualCents": null } }, "incomes": { "salary_p1": { "annualGrossCents": "11000000" }, "pen1": null } }`. `overrideChanges` lists five leaves: `people.p1.retirementAge` (60 → 58), `spending.base.mode`, `spending.base.annualCents` (removed), `incomes.salary_p1.annualGrossCents`, `incomes.pen1` (removed).

### 3.4 Resolution (`resolvePlan`), step by step

**R1. Effective document** = 3.3. A parse failure is the single issue `override_invalid` (error, path into the document) and no input.

**R2. Plan start** (`planStart(asOf)`, decision 19) on `baseline.asOf`. Examples: 2026-11-09 → `startMonth` 2026-11, `firstYearMonths` 2, `startYear` 2026; 2026-10-13 → 2026-10, 3; 2026-11-16 → 2026-12, 1; 2026-12-15 → 2026-12, 1; 2026-12-18 → 2027-01, 12, `startYear` 2027; 2026-01-15 → 2026-01, 12; 2026-01-16 → 2026-02, 11. Errors: `baseline_too_old` when `asOf` is more than 35 days before `ctx.today`; `start_year_unsupported` when `startYear < ctx.minStartYear` (the first year of the tax data). Warning `baseline_stale` when more than 7 days.

**R3. People.** `retirementMonth = person.retirementMonth ?? ageMonth(birthYear, birthMonth, retirementAge)`. A person whose `retirementMonth <= startMonth` is retired: salary and that person's contributions are dropped, with warning `already_retired` when either existed. `filingStatus = p2 ? "married_joint" : "single"` (L2). `lastAge` = the fixed `age`, or `maxAge` in mortality mode; `endYear = max over people (birthYear + lastAge)`. Error `planning_age_low` when `birthYear + lastAge <= startYear`. Error `unknown_person` wherever an item names `p2` (or an owner `joint`, `p2`) in a one-person household.

**R4. Accounts.** For every baseline account with a bucket, `setting = doc.accounts[id] ?? {}`:

- no value → not in the plan, warning `account_no_value`; `setting.include === false` → not in the plan; otherwise included;
- `balanceCents = max(0, valueCents)`;
- `owner = setting.owner ?? default` (3.1); error `owner_required` when there is none, or when a `pre_tax`, `roth` or `hsa` account is `joint`;
- allocation, first match: `setting.allocation` (`override`); the baseline weights (`holdings`); bucket `cash` → cash 10000 (`cash`); `doc.allocation.unclassified` (`profile_default`); `baseline.allocationTargets` (`household_target`); the largest-remainder weights of the summed `classCents` of the included classified accounts (`household_actual`); 6000 / 0 / 4000 / 0 / 0 / 0 (`assumed`). Sources `household_target`, `household_actual` and `assumed` raise warning `allocation_assumed` naming the account, the source and the balance;
- glide path: `setting.glidePath ?? doc.allocation.glidePath`, never for bucket `cash`; ages strictly ascending (error `glide_order`); resolved to `[{ year: birthYear(reference) + age, weights }]`;
- basis (bucket `taxable`): `setting.basisCents` (`manual`; warning `basis_above_value` when it exceeds the balance; never clamped), else `knownCents` with the baseline's coverage and, when `unknownValueCents > 0`, warning `basis_unknown` naming that amount;
- `rothContributionBasisCents` (bucket `roth`): the setting when present, else absent (unknown);
- a setting for an account not in the baseline is ignored with warning `dangling_account_setting`; a bucketed baseline account with no key in `doc.accounts` raises warning `account_unreviewed` (it appeared after the last save and is included with defaults); `tax_treatment_defaulted`, `cash_account_treatment`, `negative_balance` and `valuation_stale` are raised from the baseline's flags.

Error `no_accounts` when nothing is included.

**R5. Synthetic accounts.** A Roth conversion for a person with no included Roth account adds `{ id: "synthetic:roth:<pid>", bucket: "roth", owner: pid, balanceCents: "0", allocation: the largest-remainder weights of that person's pre-tax accounts weighted by balance, allocationSource: "pretax_mix", synthetic: true }`. A conversion for a person with no included pre-tax account is error `conversion_no_pretax`.

**R6. Income streams.** Each `When` resolves to a month: `start` → `startMonth`; `year` → January of it; `age` → `ageMonth`; `retirement` → the person's `retirementMonth`. An absent `end` leaves `endMonth` absent (for life, or to the end of the plan for a household stream). Windows are `[startMonth, endMonth)`; a start before the plan start is raised to it; error `stream_window` when the end is not after the start.

| Kind | Window | `annualCents` | Other |
| --- | --- | --- | --- |
| `salary` | `[plan start, retirementMonth)` | `annualGrossCents` | `realGrowthBp = realRaiseBp`, `earned: true`; error `salary_duplicate` for a second salary of one person |
| `part_time` | as entered | `annualCents` | `earned: true` |
| `pension` | from `start`, for life | `12 × monthlyCents` | `dollars`, `cola`, `survivorBp`, `taxableBp` 10000 |
| `annuity` | `start` to `end` or for life | `12 × monthlyCents` | `dollars`, `cola`, `survivorBp`, `taxableBp` |
| `rental` | as entered | `annualNetCents` | `realGrowthBp`; household-level |
| `other` | as entered | `annualCents` | `dollars`, `realGrowthBp`, `taxableBp`; person optional |

Fields a kind does not have are frozen as: `dollars` today, `cola` `{ mode: "cpi" }`, `realGrowthBp` 0, `survivorBp` 0, `taxableBp` 10000, `earned` false; `part_time` also carries its `realGrowthBp`.

**R7. Social Security.** One entry per person. `estimate`: `claimMonth = ageMonth(birthYear, birthMonth, claimAge.years, claimAge.months)`, `claimAgeMonths = 12 × years + months`; error `claim_in_past` when `claimMonth < startMonth` (switch to `receiving`). `receiving`: copied. `none`: an entry with `mode: "none"`, and warning `ss_missing` when the person reaches 70 after the plan start. A spouse with no earnings record uses `estimate` with `monthlyAtFraCents: "0"` and a claim age, so a spousal or survivor benefit has a start date. `spousal`, `survivor` and `adjustment` are copied.

**R8. Spending.**

- Base: the manual `annualCents`, or live: `Σ baseline.spending.byCategory[c].cents` over categories not in `excludedCategoryIds`, annualized `truncDiv(x × 12, k)` when `3 ≤ k < 12` (warning `spending_short_history`), plus `uncategorized.outflowCents` (same annualization) when `includeUncategorized` (warning `uncategorized_in_spending` naming the count and the amount), floored at 0. `k < 3` in live mode is error `spending_missing`.
- Essential: the manual `annualCents`, or live: the annualized sum over the bills-bucket categories that are not excluded (no uncategorized part) when `k ≥ 3`, else the base. Always capped at the base.
- `spending.startMonth` = the earliest `retirementMonth`, not before `startMonth`.
- Phases: ages strictly ascending (error `phase_order`); `fromYear = birthYear(phaseAnchor) + fromAge`.
- Goals: each repeat expands to `year + i × everyYears` for `i < times`; occurrences before `startYear` or after `endYear` are dropped; error `goal_in_past` when every occurrence is before `startYear`; warning `goal_before_retirement` for an occurrence before the year of `spending.startMonth` (it is paid from savings while still working, section 9).
- Healthcare, per person: `preMedicareFrom = max(retirementMonth, startMonth)`, `medicareFrom = max(ageMonth(birthYear, birthMonth, 65), startMonth)`; both amounts are "0" when `includedInBase`; warning `healthcare_zero` when not included in base and both amounts are 0.
- Long-term care: one entry per named person when `reserveCents > 0`.

**R9. Contributions**, per included investment account. `setting = doc.contributions[id] ?? { employee: live, employer: live }`; `m` = the baseline's measurement; `scaleWith` = the owner (`p1`, `p2`), or `household` for a joint account; `salary` = that person's gross salary, or the household sum.

- Employee: `live` → `m.annualEmployeeCents` when `m.source = measured`, `m.plannedCents` when `recurring` (warning `contribution_from_recurring`), else 0; `annual` → the amount; `pct_salary` → `truncDiv(salary × bp, 10000)`; `none` → 0.
- Employer: `live` → `m.annualEmployerCents` when `m.employerDetected`; else `max(0, m.annualNetCents − employee)` when the employee mode is not `live`; else 0, with warning `match_unknown` when the account type is `401k` and it has measured contributions. `formula` → `truncDiv(min(employee, truncDiv(salary × capBpOfSalary, 10000)) × matchBp, 10000)`; `annual`; `none`.
- `endMonth` = the scaling person's `retirementMonth` (household: the latest). A contribution whose scaling salary is missing gets `scaleWith: "inflation"` and warning `salary_missing`. `salaryBasisCents = salary` otherwise.
- Warnings from the baseline flags, only when `m.source = measured` and the live amount is used: `contribution_partial_window`, `irregular_contributions`. `contribution_unmeasured` when flows exist (`grossInCents > 0`) but the record is `insufficient_history`. Warning `contribution_over_limit` when, for one person and one kind (`employer_plan`: type `401k`; `ira`: types `ira` and `roth`; `hsa_family`: type `hsa`), the summed employee amounts exceed `ctx.contributionLimit(startYear, startYear − birthYear, kind)`. The amounts are not capped here.
- Accounts whose two amounts are both 0 are left out. Bank accounts have contributions only when set by hand.

Worked on the fixture (p1 salary 12,000,000, p2 6,000,000):

- K (owner p1), live and live → employee 1,200,000, employer 600,000, `scaleWith: p1`, `salaryBasisCents` 12,000,000, `endMonth` 2035-06.
- K with `employee: { mode: "pct_salary", bp: 1000 }` and no description match: employee `truncDiv(12,000,000 × 1000, 10000)` = 1,200,000, employer `max(0, 1,800,000 − 1,200,000)` = 600,000.
- K with `employer: { mode: "formula", matchBp: 5000, capBpOfSalary: 600 }`: cap `truncDiv(12,000,000 × 600, 10000)` = 720,000; `min(1,200,000, 720,000) × 5000 ÷ 10000` = 360,000.
- K live and live with no description match: employee 1,800,000, employer 0, warning `match_unknown`.
- H (p1) 360,000 and 0; B (joint) 500,000 and 0, `scaleWith: household`, `salaryBasisCents` 18,000,000, `endMonth` 2039-09; R (p2) 300,000 from the recurring transfer, `endMonth` 2039-09.
- Plan savings rate shown to the owner: `truncDiv((1,200,000 + 600,000 + 360,000 + 500,000 + 300,000) × 10000, 18,000,000)` = `truncDiv(2,960,000 × 10000, 18,000,000)` = 1644 bp of gross salary, beside the measured 2518 bp of take-home plus payroll savings.
- Limit check with the 2026 figures (deferral 24,500 plus 8,000 catch-up at 50, section 10): p1 is 51 in 2026, limit 3,250,000 cents; an employee amount of 3,300,000 on K raises `contribution_over_limit`.

**R10. Roth conversions.** Each range expands to one entry per year in `[fromYear, toYear]`; error `conversion_in_past` when `fromYear < startYear`; error `conversion_overlap` when two entries share a year and a person.

**R11. Settings.** Copied; `taxRuleSet` must be in `ctx.ruleSets` (error `unknown_rule_set`).

**R12. Assembly.** Arrays are sorted: people p1 then p2; accounts, incomes and contributions by id (plain string order); goals by (year, id); conversions by (year, person). `data.version = ctx.dataVersion`. `meta` carries the dates, the revisions, the scenario, `provenance` and the warnings in force. The result is parsed with `SimInput` before it is returned; `input` is absent when any issue is an error.

**R13. Provenance** (`meta.provenance[path]`), for the seeded fields `accounts.<id>.balance`, `.basis`, `.allocation`, `.owner`, `spending.base`, `spending.essential`, `contributions.<id>.employee`, `.employer`: `scenario` when the override patch touches the document path that decides the field; else `profile` when the profile document sets it; else `live` when the value is the account's or the ledger's own measurement in the baseline; else `default` (a stated fallback). For allocation: sources `override` and `profile_default` are `profile` or `scenario`; `holdings` and `cash` are `live`; `household_target`, `household_actual`, `assumed` and `pretax_mix` are `default`. A default owner is `default`; a balance is always `live`.

### 3.5 Issues

`PlanIssue = { code, severity, path, message, accountId? }`; `path` is a dot path into the profile document.

Errors (block a run): `override_invalid`, `owner_required`, `no_accounts`, `unknown_person`, `planning_age_low`, `claim_in_past`, `spending_missing`, `stream_window`, `salary_duplicate`, `phase_order`, `glide_order`, `goal_in_past`, `conversion_no_pretax`, `conversion_in_past`, `conversion_overlap`, `unknown_rule_set`, `baseline_too_old`, `start_year_unsupported`.

Warnings: `baseline_stale`, `valuation_stale`, `account_no_value`, `account_unreviewed`, `dangling_account_setting`, `tax_treatment_defaulted`, `cash_account_treatment`, `negative_balance`, `basis_unknown`, `basis_above_value`, `allocation_assumed`, `uncategorized_in_spending`, `spending_short_history`, `contribution_partial_window`, `irregular_contributions`, `contribution_unmeasured`, `contribution_from_recurring`, `match_unknown`, `salary_missing`, `already_retired`, `contribution_over_limit`, `ss_missing`, `healthcare_zero`, `goal_before_retirement`.

### 3.6 Baseline diff (`diffBaselines(before, after): BaselineChange[]`)

Ordered rows `{ kind, path, label, accountId?, beforeCents?, afterCents?, deltaCents?, note?, material }`: `as_of`; per account by name: `account_added`, `account_removed`, `account_value`, `account_bucket`, `account_basis`, `account_allocation` (one row when any weight moved by at least 1 bp, the weights in `note`); `bucket_total` per bucket; `total`; `allocation_targets`; `spending_category` per category; `spending_categorized`; `spending_uncategorized`; `income`; `contribution` per account; `savings_rate` (bp in `note`). Equal baselines give `[]`.

`material`: value and total rows when `|Δ| ≥ 100,000` cents or at least 1% of the before value; spending rows when `|Δ|` is at least 2% of the before `categorizedCents`; allocation rows when any class moved 200 bp or more; `account_added`, `account_removed` and `account_bucket` always; `as_of` never.

The preview also returns the effective inputs before and after (`includedTotalCents`, `baseSpendingCents`, `contributionsCents`) so the dialog can say what the refresh does to the plan.

Worked example (test 15): on the fixture, add a manual balance for K on 2026-10-13 of 15,250,000 and categorize the −45,000 row as Groceries. Rows: `account_value` K 15,000,000 → 15,250,000 (+250,000, 1.66%, material); `bucket_total` pre_tax 15,000,000 → 15,250,000 (material); `total` 22,582,700 → 22,832,700 (material); `spending_category` Groceries 955,000 → 1,000,000 (+45,000; 1.13% of 3,955,000, not material); `spending_categorized` 3,955,000 → 4,000,000 (not material); `spending_uncategorized` outflow 45,000 → 0, count 2 → 1 in `note` (not material). Effective base spending is 4,000,000 before and after; the included total moves from 22,582,700 to 22,832,700.

### 3.7 Canonical JSON and hashes (`freeze.ts`)

`canonicalJson(value)`: objects with keys in ascending UTF-16 code-unit order, arrays in given order, strings through `JSON.stringify`, numbers only when `Number.isSafeInteger`, booleans as they are; `null`, `undefined`, non-integers, `NaN` and non-plain objects throw `CanonicalJsonError`.

`hashableInput(input)` = the input without `meta` and without the `name` property of people, accounts, incomes and goals (a rename is not a change of inputs). `inputHash(input): Promise<string>` = `sha256Hex(canonicalJson(hashableInput(input)))`, lowercase hex, using the existing asynchronous `sha256Hex` (Web Crypto). `resolvePlan` stays synchronous; the services await the hash.

Worked example: `canonicalJson({ b: 1, a: { d: "x", c: [2, 1] } })` is `{"a":{"c":[2,1],"d":"x"},"b":1}` and its SHA-256 is `be443ac6d288a3a8c08f56c7542cc1a267664f64b11042b4b1b1ed8b99be2da0` (recomputed with Node's `crypto`).

### 3.8 Percentile paths (`percentile.ts`)

`rankIndex(p, N) = max(0, ceilDiv(p × N, 100) − 1)` for integer `p` in 1..99 (nearest rank). `rankPaths(endingRealCents, depletionYear)` orders the path indices by ending wealth ascending, then depletion year ascending with "never" (−1) last, then path index. `selectPercentilePath(ending, depletion, p)` is the index at `rankIndex(p, N)`. Failed paths (ending wealth 0) are therefore ordered by how early they ran out.

`encodeI64le` / `decodeI64le` (`BigInt64Array` ↔ bytes) and `encodeI16le` / `decodeI16le` (`Int16Array` ↔ bytes) are the series codecs.

Worked example, N = 10 (index: ending cents, depletion year): 0: 0, 2051; 1: 500; 2: 0, 2047; 3: 300; 4: 1200; 5: 150; 6: 700; 7: 400; 8: 900; 9: 200. Order: 2, 0, 5, 9, 3, 7, 1, 6, 8, 4. Percentiles 5, 10, 25, 50, 75, 90, 95 → ranks 0, 0, 2, 4, 7, 8, 9 → paths 2, 2, 5, 3, 6, 8, 4. Percentile 60 → rank `ceilDiv(600, 100) − 1` = 5 → path 7. Eight of ten paths never deplete. Other ranks: (10, 10000) → 999; (50, 10000) → 4999; (90, 10000) → 8999; (1, 100) → 0; (99, 100) → 98; (33, 250) → 82; (10, 200) → 19.

### 3.9 Glide weights (`glideWeightsAt(points, year)`, shared; the form's preview and the engine both call it)

Before the first point the first point's weights apply; after the last, the last's. Between points at years `y0 < y1` with `d = year − y0` and `span = y1 − y0`: `allocateLargestRemainder(10000n, [a_c × (span − d) + b_c × d for each class c])`, where `a` and `b` are the two points' weights (linear interpolation, exact in integers, summing to 10000).

Worked example: 2030 → 6000 / 2000 / 1500 / 500 (US, intl, bonds, cash) and 2033 → 4000 / 1000 / 4000 / 1000. At 2031 (`d` 1, `span` 3): raw 16000, 5000, 7000, 2000 of 30000; shares 5333.33, 1666.67, 2333.33, 666.67; floors 9998; the two .67 remainders (intl, cash) take the spare points: 5333, 1667, 2333, 667. With the second point at 2040, at 2033 (`d` 3, `span` 10): 5400, 1700, 2250, 650 exactly.

### 3.10 Thread count

`RETIREMENT_THREADS` unset, empty or `auto` → `min(8, max(1, os.availableParallelism() − 1))`: 1 core → 1; 2 → 1; 4 → 3; 8 → 7; 16 → 8. An integer 1..64 is used as given. `inline` → 0 (the simulation runs on the job's own thread: tests and development). Anything else falls back to `auto` with a boot warning.

### 3.11 Retention (`pruneSimRuns(tx, scenarioId, keep)`)

Called in the transaction that finishes a run (done, failed or cancelled). Deletes the scenario's unpinned `done` runs beyond the newest `keep` by `finished_at`, and its unpinned `failed` or `cancelled` runs beyond the newest 5. Children cascade. Example with `keep` = 2: done runs r1 (pinned), r2, r3 in that order, then r4 finishes → the unpinned done runs are r2, r3, r4; r2 is deleted; r1, r3, r4 remain. Seven failed runs f1..f7 → f1 and f2 are deleted.

## 4. Contracts

All in `packages/shared/src/retirement/`. Request bodies use only the bounded wire shapes; the profile document is itself a request body, so its money and month fields are `NonNegCentsInput` and `MonthInput`. Responses that carry database values (the baseline, run views) use the loose shapes.

### 4.1 Primitives (`primitives.ts`)

```ts
export const PlanCents = NonNegCentsInput;                    // integer cents as a decimal string, 0 .. 999,999,999,999,999
export const PlanMonth = MonthInput;                          // YYYY-MM, 1900-01 .. 2199-12
export const PlanYear = z.number().int().min(1900).max(2199);
export const bp = (min = 0, max = 10000) => z.number().int().min(min).max(max);   // basis points, 100 bp = 1%
export const PlanItemId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const ClassWeights = z.object({ us_stock: bp(), intl_stock: bp(), bonds: bp(), cash: bp(), real_estate: bp(), other: bp() }).strict()
  .refine((w) => w.us_stock + w.intl_stock + w.bonds + w.cash + w.real_estate + w.other === 10000, "weights must sum to 10000 bp");
export const MEDICARE_AGE = 65;
export const MIN_PATHS = 100, MAX_PATHS = 100_000, DEFAULT_PATHS = 10_000;
export const STORED_PERCENTILES = [5, 10, 25, 50, 75, 90, 95] as const;
export const BASELINE_STALE_DAYS = 7, BASELINE_MAX_DAYS = 35;
export const PLANNER_DISCLAIMER = "The planner is an estimate, not tax or investment advice.";
```

`PlanIssue` (shown in 4.8) is declared here too, so `input.ts` and `resolve.ts` can use it without importing `api.ts`. The `PersonId`, `OwnerId`, `PlanBucket`, `DollarBasis`, `IncomeKind`, `BasisCoverage` and `AllocationSource` enums come from `enums.ts` (2.5).

### 4.2 Profile document (`profile.ts`)

```ts
export const Longevity = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fixed"), age: z.number().int().min(50).max(119) }).strict(),         // alive through the year of this age
  z.object({ mode: z.literal("mortality"), sex: z.enum(["female", "male"]),
             adjustYears: z.number().int().min(-10).max(10).default(0),                            // shifts the table: +2 = two years healthier
             maxAge: z.number().int().min(90).max(119).default(110) }).strict(),                   // cap of the drawn life
]);
export const Person = z.object({
  name: z.string().trim().min(1).max(40),
  birthYear: PlanYear, birthMonth: z.number().int().min(1).max(12),
  retirementAge: z.number().int().min(18).max(90),
  retirementMonth: PlanMonth.optional(),                        // an exact month; wins over the age
  longevity: Longevity,
}).strict();
export const GlidePath = z.object({ reference: PersonId,       // whose age drives the path
  points: z.array(z.object({ age: z.number().int().min(18).max(119), weights: ClassWeights }).strict()).min(1).max(12) }).strict();
export const When = z.discriminatedUnion("at", [
  z.object({ at: z.literal("start") }).strict(),
  z.object({ at: z.literal("year"), year: PlanYear }).strict(),
  z.object({ at: z.literal("age"), personId: PersonId, age: z.number().int().min(18).max(110) }).strict(),
  z.object({ at: z.literal("retirement"), personId: PersonId }).strict(),
]);
export const Cola = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("cpi") }).strict(),
  z.object({ mode: z.literal("fixed"), bp: bp(0, 1000) }).strict(),                                // nominal bp a year
]);
const name60 = z.string().trim().min(1).max(60);
export const IncomeStream = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("salary"), personId: PersonId, annualGrossCents: PlanCents, realRaiseBp: bp(-500, 1000).default(0) }).strict(),
  z.object({ kind: z.literal("part_time"), personId: PersonId, annualCents: PlanCents, start: When, end: When, realGrowthBp: bp(-500, 500).default(0) }).strict(),
  z.object({ kind: z.literal("pension"), personId: PersonId, name: name60, monthlyCents: PlanCents, dollars: DollarBasis.default("nominal"),
             start: When, cola: Cola, survivorBp: bp().default(0) }).strict(),
  z.object({ kind: z.literal("annuity"), personId: PersonId, name: name60, monthlyCents: PlanCents, dollars: DollarBasis.default("nominal"),
             start: When, end: When.optional(), cola: Cola, survivorBp: bp().default(0), taxableBp: bp().default(10000) }).strict(),
  z.object({ kind: z.literal("rental"), name: name60, annualNetCents: PlanCents, start: When, end: When.optional(), realGrowthBp: bp(-500, 500).default(0) }).strict(),
  z.object({ kind: z.literal("other"), name: name60, personId: PersonId.optional(), annualCents: PlanCents, dollars: DollarBasis.default("today"),
             start: When, end: When.optional(), realGrowthBp: bp(-500, 500).default(0), taxableBp: bp().default(10000) }).strict(),
]);
const ClaimAge = z.object({ years: z.number().int().min(62).max(70), months: z.number().int().min(0).max(11) }).strict()
  .refine((c) => c.years < 70 || c.months === 0, "claim by 70");
export const SocialSecurityInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("estimate"), monthlyAtFraCents: PlanCents, asOfYear: PlanYear, claimAge: ClaimAge }).strict(),
  z.object({ mode: z.literal("receiving"), monthlyCents: PlanCents, asOfYear: PlanYear, startedMonth: PlanMonth,
             monthlyAtFraCents: PlanCents.optional() }).strict(),                                 // the full-retirement-age amount, when known
]);
export const AccountSetting = z.object({
  include: z.boolean().optional(), owner: OwnerId.optional(), allocation: ClassWeights.optional(), glidePath: GlidePath.optional(),
  basisCents: PlanCents.optional(), rothContributionBasisCents: PlanCents.optional(),
}).strict();
const EmployeeContribution = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(), z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("annual"), annualCents: PlanCents }).strict(),
  z.object({ mode: z.literal("pct_salary"), bp: bp() }).strict(),
]);
const EmployerContribution = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(), z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("annual"), annualCents: PlanCents }).strict(),
  z.object({ mode: z.literal("formula"), matchBp: bp(0, 20000), capBpOfSalary: bp() }).strict(),  // matchBp of deferrals up to capBpOfSalary of pay
]);
export const ContributionSetting = z.object({ employee: EmployeeContribution, employer: EmployerContribution }).strict();
const LiveOrManual = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(), z.object({ mode: z.literal("manual"), annualCents: PlanCents }).strict() ]);
export const Spending = z.object({
  base: LiveOrManual,
  essential: LiveOrManual,                                       // the floor for the floor-and-ceiling strategy
  excludedCategoryIds: z.record(z.string().uuid(), z.literal(true)).default({}),   // a set, as a map so a scenario can add or drop one id
  includeUncategorized: z.boolean().default(true),
  survivorBp: bp().default(10000),                               // base spending after the first death, share of the couple's
  phaseAnchor: PersonId.default("p1"),
  phases: z.array(z.object({ label: z.string().trim().max(40), fromAge: z.number().int().min(40).max(110), multiplierBp: bp(0, 20000) }).strict()).max(4).default([]),
  goals: z.record(PlanItemId, z.object({ name: name60, year: PlanYear, amountCents: PlanCents, dollars: DollarBasis.default("today"),
          repeat: z.object({ everyYears: z.number().int().min(1).max(50), times: z.number().int().min(1).max(20) }).strict().optional() }).strict()).default({}),
  healthcare: z.object({ includedInBase: z.boolean().default(false), preMedicareAnnualCents: PlanCents.default("0"),
          medicareAnnualCents: PlanCents.default("0"), realGrowthBp: bp(0, 1000).default(0) }).strict(),       // per person a year
  longTermCare: z.object({ reserveCents: PlanCents.default("0"), lastYears: z.number().int().min(1).max(10).default(2),
          people: z.enum(["each", "p1", "p2"]).default("each") }).strict(),                                    // reserve per named person
}).strict();
export const RothConversion = z.object({ personId: PersonId, fromYear: PlanYear, toYear: PlanYear, annualCents: PlanCents,
  dollars: DollarBasis.default("today") }).strict().refine((c) => c.toYear >= c.fromYear, "toYear before fromYear");
export const RetirementProfileDoc = z.object({
  schemaVersion: z.literal(1),
  people: z.object({ p1: Person, p2: Person.optional() }).strict(),
  state: z.string().regex(/^[A-Z]{2}$/),                         // stored, not taxed in v1
  accounts: z.record(z.string().uuid(), AccountSetting).default({}),
  allocation: z.object({ unclassified: ClassWeights.optional(), glidePath: GlidePath.optional() }).strict(),
  incomes: z.record(PlanItemId, IncomeStream).default({}),
  socialSecurity: z.object({ p1: SocialSecurityInput, p2: SocialSecurityInput.optional(), spousal: z.boolean().default(true), survivor: z.boolean().default(true),
    adjustment: z.object({ fromYear: PlanYear, factorBp: bp() }).strict().optional() }).strict(),             // benefits x factor from that year on
  spending: Spending,
  contributions: z.record(z.string().uuid(), ContributionSetting).default({}),
  rothConversions: z.record(PlanItemId, RothConversion).default({}),
}).strict();
```

Units: every `…Cents` is integer cents as a decimal string; `monthly…` is per month, `annual…` per year; amounts are today's dollars at the plan start unless `dollars` is `nominal` (the amount as quoted, in the dollars of the stream's first year or the goal's year); `…Bp` is basis points; ages are whole years; months are `YYYY-MM`. Stored documents are always the parsed (normalized) output. `upgradeProfileDoc(raw)` dispatches on `schemaVersion`; version 1 is the identity; a new version ships with a pure upgrade and `sim_run.input` is never rewritten.

`defaultProfileDoc(people, baseline)`: state `CO`; an empty `{}` setting for every bucketed baseline account (which marks it reviewed); `allocation: {}`; no incomes; Social Security `none` for each person, `spousal` and `survivor` true; spending `base` and `essential` live, three phases at 10000 bp anchored on p1 ("Early active years" from p1's retirement age, "Slower years" from 75, "Late life" from 85; a phase whose age is not above the previous one is left out), no goals, healthcare zeros, no long-term care reserve; no contribution settings (all live); no conversions. No reduction is assumed that the owner did not type.

### 4.3 Baseline (`baseline.ts`; response only)

```ts
export const BaselineAccount = z.object({
  accountId: z.string().uuid(), name: z.string(), type: AccountType, taxTreatment: TaxTreatment,
  bucket: PlanBucket.optional(), ineligible: z.enum(["education"]).optional(), treatmentDefaulted: z.boolean(),
  valueCents: CentsString.optional(), valuationDate: IsoDateString.optional(),
  valuationBasis: z.enum(["snapshot", "lots", "positions", "balance", "none", "bank_balance"]), stale: z.boolean(),
  fidelity: InvestmentFidelity.optional(),
  basis: z.object({ knownCents: CentsString, unknownValueCents: CentsString, coverage: z.enum(["full", "partial", "none"]),
                    source: z.enum(["lots", "statement", "mixed"]).optional() }).strict().optional(),          // bucket taxable only
  classCents: z.record(AssetClass, CentsString).optional(),      // classified accounts with a positive value
  weights: ClassWeights.optional(),
}).strict();
export const BaselineContribution = z.object({
  accountId: z.string().uuid(), monthsWithData: z.number().int().min(0).max(12),
  grossInCents: CentsString, outCents: CentsString, netCents: CentsString, unpairedCents: CentsString,
  employerCents: CentsString, employeeCents: CentsString, employerDetected: z.boolean(),
  annualNetCents: CentsString.optional(), annualEmployeeCents: CentsString.optional(), annualEmployerCents: CentsString.optional(),
  annualUnpairedCents: CentsString.optional(), plannedCents: CentsString, source: z.enum(["measured", "recurring", "none"]),
  flags: z.array(z.enum(["partial_window", "insufficient_history", "irregular", "has_withdrawals"])),
}).strict();
export const RetirementBaseline = z.object({
  schemaVersion: z.literal(1), asOf: IsoDateString, today: IsoDateString, computedAt: z.string(),
  window: z.object({ from: MonthString, to: MonthString, monthsWithData: z.number().int().min(0).max(12) }).strict(),
  accounts: z.array(BaselineAccount),
  totals: z.object({ byBucket: z.record(PlanBucket, CentsString), totalCents: CentsString }).strict(),
  allocationTargets: ClassWeights.optional(),
  spending: z.object({ byCategory: z.array(z.object({ categoryId: z.string().uuid(), name: z.string(), bucket: z.enum(["bills", "spending"]),
                         cents: CentsString, activeMonths: z.number().int() }).strict()),
                       categorizedCents: CentsString, billsCents: CentsString,
                       uncategorized: z.object({ count: z.number().int(), outflowCents: CentsString, inflowCents: CentsString }).strict() }).strict(),
  income: z.object({ takeHomeCents: CentsString, investmentIncomeCents: CentsString }).strict(),
  contributions: z.array(BaselineContribution),
  savingsRate: z.object({ bp: z.number().int().optional(), contributionsCents: CentsString, payrollCents: CentsString, baseCents: CentsString }).strict(),
}).strict();
```

### 4.4 Run settings (`settings.ts`; the envelope is this area's, the three inner shapes are the other areas', all in shared)

```ts
export const RunSettings = z.object({
  schemaVersion: z.literal(1),
  paths: z.number().int().min(MIN_PATHS).max(MAX_PATHS).default(DEFAULT_PATHS),   // ignored by the historical model, which reports its own count
  seed: z.number().int().min(0).max(4294967295).default(1),
  stepsPerYear: z.literal(1),                                     // 12 reserved (L3)
  returnModel: ReturnModelConfig,                                 // ./returnModel.ts, engine-and-returns
  strategy: StrategyConfig,                                       // ./strategy.ts, strategies-outputs-web
  withdrawalOrder: WithdrawalOrderConfig,                         // ./strategy.ts; v1: { kind: "default" }
  taxRuleSet: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).default("current_law"),
}).strict();
export function defaultRunSettings(): RunSettings;                // from DEFAULT_RETURN_MODEL, DEFAULT_STRATEGY, DEFAULT_WITHDRAWAL_ORDER
```

### 4.5 Frozen input (`input.ts`; `sim_run.input`)

```ts
export const SimInput = z.object({
  schema: z.literal("meridian.retirement.input"), schemaVersion: z.literal(1),
  meta: z.object({                                                // not hashed, not read by the engine
    createdAt: z.string(), today: IsoDateString, asOf: IsoDateString,
    profileRevision: z.number().int(), baselineHash: z.string(),
    scenarioId: z.string().uuid(), scenarioRevision: z.number().int(), scenarioName: z.string(),
    provenance: z.record(z.enum(["live", "profile", "scenario", "default"])),
    warnings: z.array(PlanIssue) }).strict(),
  data: z.object({ version: z.string() }).strict(),               // the data manifest the run must load
  plan: z.object({ startYear: PlanYear, startMonth: MonthString, firstYearMonths: z.number().int().min(1).max(12), endYear: PlanYear,
    stepsPerYear: z.literal(1), currency: z.literal("USD") }).strict(),
  household: z.object({ filingStatus: z.enum(["single", "married_joint"]), state: z.string(),
    people: z.array(z.object({ id: PersonId, name: z.string(), birthYear: PlanYear, birthMonth: z.number().int().min(1).max(12),
      retirementMonth: MonthString, longevity: Longevity }).strict()).min(1).max(2) }).strict(),
  accounts: z.array(z.object({ id: z.string(), name: z.string(), type: AccountType.optional(), bucket: PlanBucket, owner: OwnerId,
    balanceCents: NonNegCentsString,
    basisCents: NonNegCentsString.optional(), basisCoverage: BasisCoverage.optional(),               // bucket taxable only
    rothContributionBasisCents: NonNegCentsString.optional(),                                        // bucket roth; absent = unknown
    allocation: ClassWeights, allocationSource: AllocationSource,
    glidePath: z.array(z.object({ year: PlanYear, weights: ClassWeights }).strict()).optional(),
    synthetic: z.boolean() }).strict()).min(1),
  incomes: z.array(z.object({ id: z.string(), kind: IncomeKind, personId: PersonId.optional(), name: z.string(),
    annualCents: NonNegCentsString, dollars: DollarBasis, startMonth: MonthString, endMonth: MonthString.optional(),   // [start, end)
    realGrowthBp: z.number().int(), cola: Cola, survivorBp: bp(), taxableBp: bp(), earned: z.boolean() }).strict()),
  socialSecurity: z.object({
    people: z.array(z.discriminatedUnion("mode", [
      z.object({ personId: PersonId, mode: z.literal("none") }).strict(),
      z.object({ personId: PersonId, mode: z.literal("estimate"), monthlyAtFraCents: NonNegCentsString, asOfYear: PlanYear,
                 claimMonth: MonthString, claimAgeMonths: z.number().int() }).strict(),
      z.object({ personId: PersonId, mode: z.literal("receiving"), monthlyCents: NonNegCentsString, asOfYear: PlanYear,
                 startedMonth: MonthString, monthlyAtFraCents: NonNegCentsString.optional() }).strict() ])),
    spousal: z.boolean(), survivor: z.boolean(),
    adjustment: z.object({ fromYear: PlanYear, factorBp: bp() }).strict().optional() }).strict(),
  spending: z.object({ baseAnnualCents: NonNegCentsString, essentialAnnualCents: NonNegCentsString, startMonth: MonthString, survivorBp: bp(),
    phases: z.array(z.object({ fromYear: PlanYear, multiplierBp: bp(0, 20000) }).strict()),
    goals: z.array(z.object({ id: z.string(), name: z.string(), year: PlanYear, amountCents: NonNegCentsString, dollars: DollarBasis }).strict()),
    healthcare: z.array(z.object({ personId: PersonId, preMedicareAnnualCents: NonNegCentsString, preMedicareFrom: MonthString,
      medicareFrom: MonthString, medicareAnnualCents: NonNegCentsString, realGrowthBp: z.number().int() }).strict()),
    longTermCare: z.array(z.object({ personId: PersonId, reserveCents: NonNegCentsString, lastYears: z.number().int() }).strict()) }).strict(),
  contributions: z.array(z.object({ accountId: z.string(), employeeAnnualCents: NonNegCentsString, employerAnnualCents: NonNegCentsString,
    scaleWith: z.enum(["p1", "p2", "household", "inflation"]), salaryBasisCents: NonNegCentsString.optional(), endMonth: MonthString }).strict()),
  rothConversions: z.array(z.object({ year: PlanYear, personId: PersonId, amountCents: NonNegCentsString, dollars: DollarBasis }).strict()),
  settings: RunSettings,
}).strict();
```

The frozen input holds no float and no null (a recursive test asserts it). Every amount is annual cents unless its name says monthly.

### 4.6 Pure functions (`packages/shared/src/retirement`)

```ts
planBucketOf(type: AccountType, taxTreatment: TaxTreatment): { bucket?: PlanBucket; ineligible?: "education"; listed: boolean; treatmentDefaulted: boolean }
planStart(asOf: IsoDate): { startYear: number; startMonth: MonthKey; firstYearMonths: number }
ageMonth(birthYear: number, birthMonth: number, years: number, months?: number): MonthKey
classWeights(classCents: Readonly<Partial<Record<AssetClass, bigint>>>): ClassWeights | undefined
glideWeightsAt(points: ReadonlyArray<{ year: number; weights: ClassWeights }>, year: number): ClassWeights
mergePatch(target: unknown, patch: unknown): unknown
diffPatch(base: unknown, target: unknown): Record<string, unknown>
overrideChanges(doc: RetirementProfileDoc, overrides: Record<string, unknown>): Array<{ path: string; before?: unknown; after?: unknown }>
upgradeProfileDoc(raw: unknown): RetirementProfileDoc
defaultProfileDoc(people: { p1: Person; p2?: Person }, baseline: RetirementBaseline): RetirementProfileDoc
aggregateContributions(flows: readonly ExternalFlowInput[], descriptions: ReadonlyMap<string, string>, plannerInvestmentIds: ReadonlySet<string>,
  firstDataDates: ReadonlyMap<string, IsoDate | null>, window: { from: MonthKey; to: MonthKey }): BaselineContributionRecord[]
interface ResolveContext { today: IsoDate; ruleSets: readonly string[]; minStartYear: number; dataVersion: string;
  contributionLimit?: (year: number, age: number, kind: "employer_plan" | "ira" | "hsa_family") => bigint | null;
  meta: { createdAt: string; profileRevision: number; baselineHash: string; scenarioId: string; scenarioRevision: number; scenarioName: string } }
resolvePlan(a: { doc: RetirementProfileDoc; baseline: RetirementBaseline; overrides: Record<string, unknown>; settings: RunSettings }, ctx: ResolveContext):
  { input?: SimInput; issues: PlanIssue[]; effective?: EffectiveInputs; doc?: RetirementProfileDoc }
diffBaselines(before: RetirementBaseline | null, after: RetirementBaseline): BaselineChange[]
canonicalJson(value: unknown): string;  hashableInput(input: SimInput): unknown;  inputHash(input: SimInput): Promise<string>
rankIndex(percentile: number, paths: number): number
rankPaths(endingRealCents: BigInt64Array, depletionYear: Int16Array): Uint32Array
selectPercentilePath(endingRealCents: BigInt64Array, depletionYear: Int16Array, percentile: number): number
encodeI64le / decodeI64le / encodeI16le / decodeI16le
```

`EffectiveInputs = { includedTotalCents, byBucketCents, baseSpendingCents, essentialSpendingCents, contributionsCents (employee plus employer), employerCents, planSavingsRateBp?, accounts: [{ accountId, included, bucket, owner?, balanceCents, basisCents?, basisCoverage?, allocation?, allocationSource? }] }` (bigint in the services, strings on the wire as `EffectiveInputsView`).

### 4.7 Routes (`apps/api/src/routes/retirement.ts`, prefix `/api/retirement`, `usePlanErrors`, `resolveToday`, `auditContext`)

| # | Method and path | Role | Body or query | Response |
| --- | --- | --- | --- | --- |
| 1 | `GET /meta` | any | | `RetirementMeta` |
| 2 | `GET /profile` | any | `today?` | `ProfileResponse` |
| 3 | `PUT /profile` | owner | `{ doc, expectedRevision, today? }` | `ProfileResponse`. `expectedRevision: 0` creates the profile, the stored baseline and the default scenario "Base plan" (`defaultRunSettings()`, empty overrides) |
| 4 | `POST /profile/revert` | owner | `{ auditId, expectedRevision, today? }` | `ProfileResponse` |
| 5 | `GET /baseline/preview` | any | `today?` | `BaselinePreviewResponse` (computes, writes nothing) |
| 6 | `POST /baseline/refresh` | owner | `{ today?, expectedHash? }` | `{ profile: ProfileResponse, changes: BaselineChange[] }`; `409 baseline_changed` when the fresh hash differs from `expectedHash` |
| 7 | `GET /scenarios` | any | `includeArchived?` | `{ items: ScenarioSummary[] }` |
| 8 | `POST /scenarios` | owner | `{ name, notes?, copyFromId?, doc?, profileRevision?, settings? }` | 201 `ScenarioView` |
| 9 | `GET /scenarios/:id` | any | `today?` | `ScenarioView` |
| 10 | `PATCH /scenarios/:id` | owner | `{ expectedRevision, name?, notes?, doc?, profileRevision?, settings?, isDefault?, archived?, position? }` | `ScenarioView` |
| 11 | `DELETE /scenarios/:id` | owner | | `OkResponse` (runs cascade); `409 default_scenario` |
| 12 | `POST /scenarios/:id/revert` | owner | `{ auditId, expectedRevision }` | `ScenarioView` |
| 13 | `GET /scenarios/:id/input` | any | `today?` | `{ input: SimInput \| null, inputHash: string \| null, issues, effective: EffectiveInputsView \| null, reusableRunId: uuid \| null }` |
| 14 | `POST /scenarios/:id/runs` | owner | `{ today?, refresh?: boolean = true, force?: boolean = false }` | 202 `RunRequestResponse` (200 when an existing run is returned) |
| 15 | `GET /runs` | any | `scenarioId?`, `limit?` (1..100, default 20), `cursor?` | `{ items: SimRunView[], nextCursor }`, newest first |
| 16 | `GET /runs/:id` | any | | `SimRunDetail` |
| 17 | `GET /runs/:id/input` | any | | the stored `SimInput` |
| 18 | `GET /runs/:id/paths/:percentile` | any | percentile 1..99 | `RunPathResponse` |
| 19 | `POST /runs/:id/cancel` | owner | | `SimRunView` |
| 20 | `PATCH /runs/:id` | owner | `{ pinned?, note? }` | `SimRunView` |
| 21 | `DELETE /runs/:id` | owner | | `OkResponse`; `409 run_active` while queued or running |

`doc` in routes 8 and 10 is the full effective document as edited; the server stores `diffPatch(profile.doc, doc)`. `profileRevision` (required with `doc`) is the profile revision the editor loaded; a mismatch is `409 revision_conflict`, so a profile change made meanwhile is never frozen into the scenario as an override. History uses the existing `GET /api/audit?entity=…&entityId=…`.

### 4.8 Response shapes (`api.ts`)

```ts
export const PlanIssue = z.object({ code: z.string(), severity: PlanIssueSeverity, path: z.string(), message: z.string(), accountId: z.string().optional() }).strict();
export const BaselineChange = z.object({ kind: z.string(), path: z.string(), label: z.string(), accountId: z.string().uuid().optional(),
  beforeCents: CentsString.optional(), afterCents: CentsString.optional(), deltaCents: CentsString.optional(), note: z.string().optional(), material: z.boolean() });
export const RetirementMeta = z.object({ engineVersion: z.string(), dataVersion: z.string(), ruleSets: z.array(z.object({ id: z.string(), label: z.string() })),
  limits: z.object({ minPaths: z.number().int(), maxPaths: z.number().int(), defaultPaths: z.number().int() }), defaultSettings: RunSettings,
  storedPercentiles: z.array(z.number().int()), medicareAge: z.number().int(),
  fullRetirementAge: z.array(z.object({ fromBirthYear: z.number().int(), toBirthYear: z.number().int().nullable(), years: z.number().int(), months: z.number().int() })),
  disclaimer: z.string() });
export const ProfileResponse = z.object({
  exists: z.boolean(), revision: z.number().int(),                // 0 when it does not exist
  doc: RetirementProfileDoc.nullable(), updatedAt: z.string().nullable(),
  baseline: RetirementBaseline,                                   // stored; a live preview when !exists
  baselineStored: z.boolean(), baselineHash: z.string(), baselineAgeDays: z.number().int(), baselineStale: z.boolean(),
  effective: EffectiveInputsView.nullable(), issues: z.array(PlanIssue),      // resolved with no overrides and the default scenario's settings
  scenarioIssues: z.array(z.object({ scenarioId: z.string().uuid(), name: z.string(), issues: z.array(PlanIssue) })),
  defaultScenarioId: z.string().uuid().nullable() });
export const BaselinePreviewResponse = z.object({ current: RetirementBaseline.nullable(), proposed: RetirementBaseline, proposedHash: z.string(),
  changes: z.array(BaselineChange), effectiveBefore: EffectiveInputsView.nullable(), effectiveAfter: EffectiveInputsView.nullable() });
export const SimRunView = z.object({ id: z.string().uuid(), scenarioId: z.string().uuid(), scenarioName: z.string(), status: SimRunStatus,
  cancelRequested: z.boolean(), stalled: z.boolean(),             // running and no progress write for 120 s
  paths: z.number().int(), pathsDone: z.number().int(), progressBp: z.number().int(),       // truncDiv(pathsDone x 10000, paths), at most 10000
  seed: z.number().int(), returnModel: z.string(), strategy: z.string(), taxRuleSet: z.string(), baselineAsOf: IsoDateString,
  dataVersion: z.string(), engineVersion: z.string().nullable(), threads: z.number().int().nullable(), inputHash: z.string(),
  successPaths: z.number().int().nullable(), successBp: z.number().int().nullable(),         // truncDiv(successPaths x 10000, paths)
  medianEndingRealCents: CentsString.nullable(), p10EndingRealCents: CentsString.nullable(), // from summary.endingWealthReal
  errorCode: z.string().nullable(), errorMessage: z.string().nullable(), pinned: z.boolean(), note: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), durationMs: z.number().int().nullable(),
  current: z.boolean() });                                        // input_hash equals what the scenario would freeze now, same engine version
export const SimRunDetail = SimRunView.extend({ summary: SimSummary.nullable(), fan: FanSeries.nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })), storedPercentiles: z.array(z.number().int()) });
export const RunPathResponse = z.object({ percentile: z.number().int(), pathIndex: z.number().int(), rank: z.number().int(),
  source: z.enum(["stored", "resimulated"]), endingRealCents: CentsString, depletedYear: z.number().int().nullable(), table: YearTable });
export const RunRequestResponse = z.object({ run: SimRunView, created: z.boolean(), reused: z.boolean(), baselineChanges: z.array(BaselineChange) });
export const ScenarioSummary = z.object({ id: z.string().uuid(), name: z.string(), notes: z.string().nullable(), isDefault: z.boolean(), archived: z.boolean(),
  position: z.number().int(), revision: z.number().int(), updatedAt: z.string(), changeCount: z.number().int(),
  latestRun: SimRunView.nullable(), activeRunId: z.string().uuid().nullable() });
export const ScenarioView = ScenarioSummary.extend({ overrides: z.record(z.unknown()), doc: RetirementProfileDoc.nullable(),   // null when override_invalid
  changes: z.array(z.object({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })),
  settings: RunSettings, issues: z.array(PlanIssue), inputHash: z.string().nullable(), profileRevision: z.number().int() });
```

Error codes (all `{ error, code }` through `PlanError`):

| Status | Code | When |
| --- | --- | --- |
| 400 | `validation` | a body, query or path parameter fails its contract (a claim age of 71, percentile 0 or 100) |
| 400 | `today_out_of_range` | as in Phase 2 |
| 403 | `viewer` | a viewer calls a mutating route (auth plugin) |
| 404 | `not_found` | scenario, run or audit row, named in the message (the profile route never answers 404) |
| 409 | `profile_missing` | a scenario or run write before a profile exists |
| 409 | `revision_conflict` | `expectedRevision` or `profileRevision` differs from the stored revision |
| 409 | `baseline_changed` | the fresh baseline's hash differs from `expectedHash` |
| 409 | `name_taken`, `too_many_scenarios`, `default_scenario` | scenario name in use (case-insensitive); more than 50; deleting or archiving the default |
| 409 | `plan_incomplete` | the resolved plan has an error issue (the message is the first one; the list is at route 13) |
| 409 | `run_in_progress` | a different input is queued or running for the scenario (the message carries the run id) |
| 409 | `run_active`, `run_not_active`, `run_not_done` | deleting an active run; cancelling a finished run; paths of an unfinished run |
| 409 | `engine_changed` | a non-stored percentile after the engine or data version moved |
| 409 | `not_reproducible` | a re-simulated path does not match the stored series |
| 409 | `pin_limit` | a 21st pinned run in one scenario |
| 409 | `revert_invalid` | the audit row is not of that entity, or its `before` no longer parses |

### 4.9 Dashboard card (`DashboardView.retirement`)

```ts
retirement: z.object({
  state: z.enum(["no_run", "running", "ready", "failed"]),
  scenarioId: z.string().uuid(), scenarioName: z.string(),
  active: z.object({ runId: z.string().uuid(), status: z.enum(["queued", "running"]), progressBp: z.number().int() }).nullable(),
  run: z.object({ id: z.string().uuid(), finishedAt: z.string(), paths: z.number().int(), successPaths: z.number().int(), successBp: z.number().int(),
          medianEndingRealCents: CentsString, p10EndingRealCents: CentsString, baselineAsOf: IsoDateString, ageDays: z.number().int(),
          stale: z.object({ inputsChanged: z.boolean(), engineChanged: z.boolean() }).nullable() }).nullable(),   // stale null = not evaluated
  issues: z.number().int(),                                       // error issues on the default scenario
}).nullable()                                                     // null: no profile yet
```

`run` is the newest `done` run of the default scenario. `state`: `running` while that scenario has an active run; `failed` when its newest run failed and none is done; `ready` with a run; `no_run` otherwise. `inputsChanged` = the run's `input_hash` differs from the hash the default scenario would freeze now from the stored documents (true as well when the plan no longer resolves); `engineChanged` = the run's engine or data version differs from the current one. This area owns the contract and the service; the card component is the strategies-outputs-web area's.

## 5. UI (the states these contracts are shaped for; the pages belong to strategies-outputs-web)

Setup wizard and edit form, six steps, each a card of the profile document. Every seeded value shows its evidence, its provenance ("from live data", "typed", "this scenario") and a "use my own number" switch. The form runs `resolvePlan` in the browser (the same shared function) for inline issues by `path`.

| Step | The owner types (source) | Pulled live (evidence shown) |
| --- | --- | --- |
| 1 People | name, birth month and year, retirement age, state (prefilled CO), life expectancy; a second person or not | |
| 2 Accounts | the owner of each pre-tax, Roth and HSA account (two-person households); include switches; basis for accounts flagged unknown; "what is this invested in" for unclassified accounts; Roth contributions to date (optional) | balance, valuation date, bucket, basis coverage, allocation bar and its source |
| 3 Income | gross salary per person (pay stub: gross per paycheck x paychecks a year), raises above inflation; pensions, annuities, part-time, rental, other | take-home from the plan beside the salary field |
| 4 Social Security | monthly benefit at full retirement age and the statement year (SSA statement), claiming age (defaults to the full retirement age from `GET /meta`), or "already receiving"; spousal and survivor switches | |
| 5 Spending | nothing required; optional exclusions, essentials, phases, goals, healthcare, long-term care, the share after a death | the 12-month total with the category list (checkboxes), the uncategorized outflows line with its inflows beside it, the bills share |
| 6 Savings | deferral and match only when the measured split is wrong | contributions per account with months measured, source (measured or recurring), employer part, the measured and plan savings rates |

States:

- **No profile**: `GET /profile` → `exists: false` with a live baseline; the wizard builds `defaultProfileDoc` and PUTs with `expectedRevision: 0`.
- **Saved with errors**: the issue list links to the field; Run is disabled with the first error.
- **Baseline banner**: "Balances as of <date>" with Refresh; the dialog shows the rows of 3.6 (material ones first) and the before and after of base spending, contributions and the included total; Apply sends `expectedHash`; `409 baseline_changed` reloads the preview.
- **Run**: the button posts with `refresh` on; a "keep these starting values" switch posts `refresh: false` (for comparing scenarios). The response's `baselineChanges` are listed. Progress polls `GET /runs/:id` every second while queued or running, with Cancel; `stalled` reads "the worker stopped responding" with Cancel; a reused run reads "identical inputs, showing the run from <time>"; failed shows the code and message with Run again.
- **Empty states**: no eligible accounts ("connect or add an investment account"); fewer than 3 full months of ledger ("enter your yearly spending").
- **Viewer**: every editor, Refresh, Run, Cancel, Pin and Delete hidden; results and previews readable.
- Every result view carries `PLANNER_DISCLAIMER`. Account and category names originate in SimpleFIN or imports and are rendered as text only.

## 6. Jobs and services

### 6.1 The planner environment

`packages/db` never imports the engine. Its services take:

```ts
export interface PlannerEnv { engineVersion: string; dataVersion: string; ruleSets: readonly string[]; minStartYear: number;
  contributionLimit?: (year: number, age: number, kind: "employer_plan" | "ira" | "hsa_family") => bigint | null }
```

The API builds it once from `@meridian/retirement` and decorates `app.planner` (`PlannerEnv` plus `simulatePath`, the rule set labels and the full-retirement-age table); `BuildAppOptions.planner` and `createTestApp({ planner })` inject a fake. The worker reads the engine from `JobContext.sim?: { runSimulation, simulatePath, ENGINE_VERSION, DATA_VERSION }` (default: the real package).

### 6.2 Services (`packages/db/src/services/`)

- `retirementBaseline.ts`: `computeBaseline(db, { today, now })` (3.2, read-only), `baselineHash(b)`, `baselineAuditJson(b)` (bucket totals, total, categorized and bills spending, uncategorized outflow, take-home, contributions total, savings rate, account count; no dates, so a baseline whose only change is its as-of date writes no audit row).
- `retirementProfile.ts`: `getProfile(db, { today, now, env })`; `putProfile(db, { doc, expectedRevision, today, now, env }, auditCtx)` (one transaction: lock the row `FOR UPDATE`; revision check; the first write computes and stores the baseline and inserts the default scenario; `revision + 1` only when the document changed; audit `plan_profile` with `{ doc }`, and on creation `plan_baseline` and `scenario`; returns `scenarioIssues` for every scenario that is not archived); `revertProfile`; `previewBaseline(db, q)`; `refreshBaseline(db, { today, now, expectedHash, env }, auditCtx)` (recompute; `409 baseline_changed` on a mismatch; when the hash differs from the stored one, store `baseline`, `baseline_as_of`, `baseline_hash`, `baseline_at` and audit `plan_baseline` with `baselineAuditJson` before and after; the profile `revision` is untouched).
- `retirementScenarios.ts`: `listScenarios`, `getScenario` (resolve, issues, `overrideChanges`, current hash), `createScenario` (name unique ignoring case; `copyFromId` copies overrides and settings; `doc` stored as `diffPatch`), `updateScenario` (revision checks; `isDefault: true` clears the previous default in the same transaction; archiving the default is `409 default_scenario`), `deleteScenario`, `revertScenario`. Every write audits entity `scenario` with `{ name, notes, isDefault, archived, position, overrides, settings }`.
- `retirementRuns.ts`: `freezeScenarioInput`, `requestRun`, `beginSimRun`, `reportSimProgress`, `completeSimRun`, `failSimRun`, `cancelSimRun`, `requestCancel`, `pruneSimRuns`, `listRuns`, `getRun`, `getRunInput`, `getRunPath`, `setRunFlags` (audit `sim_run` with `{ pinned, note }`), `deleteRun` (audit), `retirementCard(db, { today, env? })`.

`requestRun(db, { scenarioId, today, now, refresh, force, userId, env })`, one transaction:

1. Load the profile (`409 profile_missing`) and lock it and the scenario row `FOR UPDATE` (`404 not_found`).
2. When `refresh`: compute the baseline; when its hash differs from the stored one, store it, diff it and audit it as `refreshBaseline` does; `baselineChanges` is returned (empty otherwise).
3. Resolve. Any error issue → `409 plan_incomplete` (the transaction rolls back, so a refresh in step 2 is not kept).
4. `inputHash`.
5. An active run of the scenario: the same hash → return it (`created: false, reused: true`); a different hash → `409 run_in_progress`. The partial unique index enforces it under a race.
6. Unless `force`: the newest `done` run of the scenario with the same hash and `engine_version = env.engineVersion` → return it (`reused: true`). The data version is inside the hash.
7. Insert `sim_run` (`queued`, with the copies of seed, paths, model, strategy, rule set, data version, revisions, `baseline_as_of`); `enqueueJob(tx, "retirement.simulate", { runId, dedupeKey: "retirement.simulate:" + runId }, { dedupe: true, maxAttempts: 2 })`; store `job_id`.

The key is per run because `enqueueJob` returns any queued or running job with the same key: a per-scenario key would hand a new run the job of a run that was just cancelled (still queued, or still marked running until the stale sweep), and the new run would wait forever.

`completeSimRun(db, runId, result)`, one transaction: `UPDATE sim_run SET status = 'done', paths = result.paths, paths_done = result.paths, success_paths, summary, fan, warnings, duration_ms, finished_at = now() WHERE id = $1 AND status = 'running'` (no row: the run was cancelled meanwhile; nothing is written); delete then insert the two series and the stored path rows; `pruneSimRuns`. Guards before writing: both series have `result.paths` values; every stored table is within 2 MB of JSON and parses as `YearTable`; `summary.endingWealthReal.p50` and `.p10` are cents strings.

`getRunPath(db, runId, percentile, engine)`: the run must be `done` (`409 run_not_done`). A stored percentile returns its row (`source: "stored"`). Otherwise `engine_version` and `data_version` must equal the current ones (`409 engine_changed`); decode the series; `k = selectPercentilePath(…)`; `engine.simulatePath(SimInput.parse(input), k)`; the result's ending wealth and depletion year must equal the series values at `k` (`409 not_reproducible`); answer with `source: "resimulated"`. Nothing is written.

`requestCancel`: a `queued` run becomes `cancelled` at once (its job later finds no active row and skips); a `running` run gets `cancel_requested = true` and the worker stops it within about a second; a `running` run whose `progress_at` is more than 120 seconds old (the worker is gone) becomes `cancelled` at once; a finished run is `409 run_not_active`.

`retirementCard(db, { today, env })`: no profile → `null`. Otherwise four small reads (the profile row, the default scenario, its active run, its newest done run's scalar columns and `summary`), one pure resolve of the stored documents and one hash. Without `env` (the Phase 2 and 3 suites call `getDashboard(db, { today })`) the card reports the run with `stale: null`. `getDashboard` gains `planner?: PlannerEnv`; the dashboard route passes `app.planner`; both `toDashboardView` mappers (`services/dashboard.ts` and `apps/api/src/views/cashflow.ts`) map the card.

### 6.3 Job `retirement.simulate` (`apps/worker/src/jobs/retirementSimulate.ts`)

Trigger: `requestRun` only; nothing simulates on a timer in v1. Payload `{ runId, dedupeKey }`, `maxAttempts` 2.

1. **Crash guard.** `job.attempts > job.maxAttempts` (the runner counts every claim, and `requeueStaleJobs` requeues a dead worker's job without looking at attempts): `failSimRun(runId, "worker_crashed", …)`, return. A run that kills the worker is therefore tried twice, not every 30 minutes for ever.
2. **Claim.** `beginSimRun(db, runId, { engineVersion, threads, jobId })`: `UPDATE sim_run SET status = 'running', started_at = now(), paths_done = 0, progress_at = now(), engine_version, threads WHERE id = $1 AND status IN ('queued','running') AND NOT cancel_requested RETURNING input, data_version`. No row: an active row with `cancel_requested` becomes `cancelled`; return `{ skipped: true }`. A row that was already `running` is an earlier attempt that died; it restarts from path 0.
3. **Checks.** `data_version ≠ DATA_VERSION` → `failSimRun("data_version_changed")`. `SimInput.safeParse(input)` failing → `failSimRun("bad_input")`. Both return normally (retrying cannot help).
4. **Run.** `controller = new AbortController()`; a timer aborts with reason `timeout` after `RETIREMENT_RUN_MAX_MS` (default 900,000, below the runner's 30-minute stale sweep). `result = await sim.runSimulation(input, { threads, threadEntry, signal, onProgress })`. `onProgress(done, total)` is throttled to one write a second with an in-flight guard: `reportSimProgress` runs `UPDATE sim_run SET paths_done = $2, paths = $3, progress_at = now() WHERE id = $1 AND status = 'running' RETURNING cancel_requested`; `true` or no row aborts with reason `cancelled`.
5. **Stored paths and the reproducibility check.** For each of `STORED_PERCENTILES`: `k = selectPercentilePath(result.endingRealCents, result.depletionYear, p)`; `detail = sim.simulatePath(input, k)` once per distinct `k`; `detail.endingRealCents` and `detail.depletionYear` must equal the series values at `k`, else `failSimRun("not_reproducible")`.
6. **Finish.** `completeSimRun`.

Errors: `SimAborted` with reason `cancelled` → `cancelSimRun` (status `cancelled`, `finished_at`, prune); the job completes. Reason `timeout` → `failSimRun("timeout")`; the job completes. `SimInputError` → `failSimRun(err.code, err.message)`; the job completes. Any other error thrown by the engine → `failSimRun("engine_error", message)` and rethrow with `permanent = true` (the runner fails the job without a retry: the engine is a pure function of its input). An error from anywhere else (a database write) is rethrown as it is: the queue retries with its backoff while the run stays `running`; on the last attempt the run is failed with `worker_error` before the rethrow.

Idempotency: the claim and the completing update are conditional; results are written with the status flip in one transaction; a second delivery of a finished run finds no active row and skips.

Thread entry: the worker app owns `apps/worker/src/simThread.ts` (it only calls the engine's `runThreadMain()`); `apps/worker/package.json` builds it as a second bundle (`node ../../scripts/bundle.mjs src/simThread.ts dist/simThread.js` after the main one), and the job passes `threadEntry = new URL("./simThread.js", import.meta.url)` when that file exists. When it does not (`tsx watch` in development, Vitest), or `RETIREMENT_THREADS=inline`, `threads` is 0 and the harness runs inline on the job's thread, yielding to the event loop between chunks so the progress writes and the scheduler still run. The boot log says which mode is in use.

Queue behaviour: the runner is serial, so a sync queued during a run waits for it (at most the 15-minute cap). No run-time figure is claimed here; the engine area benchmarks it.

Environment (`apps/worker/src/env.ts`, `WorkerConfig.retirement`, `.env.example`, compose): `RETIREMENT_THREADS` (3.10), `RETIREMENT_RUN_MAX_MS` (900000), `RETIREMENT_KEEP_RUNS` (20).

## 7. Test cases

### 7.0 Fixture

`seedRetirementFixture(db)` (`packages/db/src/test/retirementSeed.ts`) = `seedInvestmentFixture` + `seedInvestmentLots` (today 2026-10-14, `INV_SEED_NOW`, expected price date 2026-10-13; household targets 5000 / 2500 / 2000 / 500) plus:

- Accounts: K "Acme 401(k)" (`401k`, `pre_tax`, off budget; manual balances 2025-09-30 12,000,000 and 2026-10-10 15,000,000); H "HealthEquity HSA" (`hsa`, `hsa`, off budget; manual balances 2026-06-01 0 and 2026-10-10 125,000); T "Old Brokerage" (`brokerage`, `taxable`, off budget; csv holding snapshot 2026-10-13: VTI 10 at 312.5 = 312,500 with reported basis 200,000, AAPL 5 at 240 = 120,000 with no reported basis; csv balance 2026-10-13 432,500); S "Savings" (`savings`, `none`, on budget; manual balance 2026-10-13 2,000,000); E "College 529" (`529`, `none`; manual balance 2026-10-10 1,200,000); V "Visa" (`credit`, on budget; −150,000). The seed's Checking keeps its 500,000.
- Categories: Paycheck (income), Rent (bills), Groceries (spending), Childcare (spending), Emergency Fund (savings).
- Ledger on Checking, each month 2025-10 through 2026-09: day 1 Paycheck +700,000; day 3 Rent −200,000; day 10 Groceries −80,000; day 12 Childcare −50,000; day 20 a paired transfer −30,000 to Savings (+30,000). Also: 2025-09-03 Rent −200,000; 2026-03-20 Groceries +5,000; 2026-06-18 uncategorized −45,000; 2026-07-02 uncategorized +20,000; 2026-10-05 Groceries −99,900. The seed's 2026-06-26 VTI dividend row (+4,720) gets the Dividends category.
- Ledger on K (unpaired transfers), day 15 of each of the 12 months: +100,000 "EMPLOYEE PRE-TAX CONTRIBUTION" and +50,000 "EMPLOYER MATCH". On H (unpaired): 2026-06-15, 07-15, 08-17, 09-15, +30,000 "PAYROLL HSA CONTRIBUTION".
- Recurring: an active monthly transfer from Checking with `transfer_account_id` = the Roth account, `expected_cents` −25,000.
- `retirementFixtureDoc(seed)`: p1 Alex born 1975-06, retires at 60, fixed 95; p2 Sam born 1977-09, retires at 62, fixed 95; state CO; account settings `{}` for B, T, Checking, Savings and owners K → p1, H → p1, R → p2; incomes `salary_p1` 12,000,000 (raise 100 bp), `salary_p2` 6,000,000, `pen1` pension for p2 100,000 a month, `nominal`, from p2's age 62, no COLA, survivor 5000 bp; Social Security p1 `estimate` 280,000 a month, p2 190,000, both as of 2026, claim 67 years 0 months; spending base and essential live, the three default phases (ages 60, 75, 85 at 10000 bp), goal `roof` 2031 1,800,000 today's dollars, healthcare included in base; conversion `conv1` p1, 2036 to 2036, 3,000,000 today's dollars.
- Fake engine for the lifecycle cases: whatever is requested, it returns the ten-path result of 3.8 (`paths` 10, `successPaths` 8, the two series, a small summary with `endingWealthReal.p50` and `.p10`, a fan) and a `simulatePath` that returns a two-row table with the series values of the asked path.

### Pure (`packages/shared/src/retirement/*.test.ts`)

1. **Bucket table.** Every row of 3.1, including `401k` with `none` → `pre_tax` with `treatmentDefaulted`, `savings` with `hsa` → `cash`, `529` → no bucket, `ineligible: education`, listed; `credit` → not listed.
2. **Start rule.** 2026-11-09 → (2026, 2026-11, 2); 2026-10-13 → (2026, 2026-10, 3); 2026-11-16 → (2026, 2026-12, 1); 2026-12-15 → (2026, 2026-12, 1); 2026-12-18 → (2027, 2027-01, 12); 2026-01-15 → (2026, 2026-01, 12); 2026-01-16 → (2026, 2026-02, 11).
3. **Age months.** `ageMonth(1975, 6, 60)` = 2035-06; `(1977, 9, 62)` = 2039-09; `(1975, 6, 67)` = 2042-06; `(1977, 9, 67)` = 2044-09; `(1977, 9, 66, 8)` = 2044-05 (month 17 carries into the year); `(1975, 6, 65)` = 2040-06.
4. **Weights.** `classWeights` of (1,850,000; 712,000; 0; 143,200; 0; 0) = 6839, 2632, 0, 529, 0, 0; of (851,800; 151,200; 790,000; 27,000; 0; 0) = 4680, 831, 4341, 148, 0, 0; of (3,134,300; 863,200; 790,000; 170,200; 0; 0) = 6322, 1741, 1594, 343, 0, 0; all zero → undefined; a negative class → undefined.
5. **Merge patch and minimal patch.** The 3.3 example: `diffPatch` gives exactly that patch; `mergePatch(base, patch)` deep-equals the target; `diffPatch(x, x)` is `{}`; `overrideChanges` lists the five leaves; an array value replaces whole; a patch that would set `schemaVersion` is rejected.
6. **Contribution aggregation.** Literal flows. K, 24 rows as in the fixture, first data date 2025-09-30 → gross 1,800,000, unpaired 1,800,000, employer 600,000 (detected), employee 1,200,000, `monthsWithData` 12, annual figures equal. H, four rows of 30,000, first data date 2026-06-01 → `monthsWithData` 4, annual net `truncDiv(120,000 × 12, 4)` = 360,000, `partial_window`. The same H with first data date 2026-06-02 and no earlier flow → `firstFull` 2026-07, the June flow dropped, 90,000 over 3 months → 360,000, `partial_window`. Flows +500,000 and −200,000 → net 300,000, `has_withdrawals`. A +15,000,000 flow whose counterparty is another plan investment account is dropped (net 0). One +900,000 flow among 1,000,000 gross → `irregular`. `monthsWithData` 2 → annual figures absent, `insufficient_history`. Out greater than in → net 0. "EMPLOYEE PRE-TAX CONTRIBUTION" does not match the employer pattern; "ER SAFE HARBOR", "PROFIT SHARING" and "EMPLOYER MATCH" do.
7. **Spending resolution** on the fixture baseline: default → base 3,955,000 + 45,000 = 4,000,000, essential 2,400,000; Childcare excluded → 3,355,000 + 45,000 = 3,400,000; `includeUncategorized: false` → 3,955,000; manual 4,400,000 → 4,400,000; manual base 2,000,000 with live essential → essential 2,000,000 (capped); Rent excluded → essential 0; with `monthsWithData` 6 and the same sums → `truncDiv(3,955,000 × 12, 6) + truncDiv(45,000 × 12, 6)` = 7,910,000 + 90,000 = 8,000,000, essential 4,800,000, warning `spending_short_history`; `monthsWithData` 2 in live mode → error `spending_missing`.
8. **Contribution resolution**: the K variants, H, B and R of 3.4 R9 (1,200,000 / 600,000; 1,200,000 / 600,000; 1,200,000 / 360,000; 1,800,000 / 0 with `match_unknown`; H 360,000 / 0; B 500,000 / 0 with `scaleWith: household`, `salaryBasisCents` 18,000,000, `endMonth` 2039-09; R 300,000 / 0 with `contribution_from_recurring`); plan savings rate 1644 bp; with a `contributionLimit` that returns 3,250,000 for `employer_plan` at age 51, an employee amount of 3,300,000 on K raises `contribution_over_limit` and 3,250,000 does not.
9. **Basis**: T → `basisCents` 200,000, coverage `partial`, warning `basis_unknown` naming 120,000; with `basisCents: "300000"` → 300,000, `manual`, no warning; with `basisCents: "9999999"` → 9,999,999 kept as entered, warning `basis_above_value`; B → 2,378,200, `full`.
10. **Allocation fallbacks** for K: fixture → 5000 / 2500 / 2000 / 500, `household_target`, warning `allocation_assumed`; baseline without targets → 6322 / 1741 / 1594 / 343, `household_actual`, warning; without targets and with B, R, T excluded → 6000 / 0 / 4000 / 0, `assumed`, warning; `allocation.unclassified` = 7000 / 0 / 3000 / 0 → that, `profile_default`, no warning; a per-account override wins over all, `override`.
11. **Full resolution of the fixture** (default scenario, no overrides): `plan` = { 2026, 2026-10, 3, endYear 2072 }; `filingStatus` `married_joint`; retirement months 2035-06 and 2039-09; claim months 2042-06 and 2044-09, `claimAgeMonths` 804; pension `annualCents` 1,200,000, `nominal`, from 2039-09, survivor 5000; salaries `[2026-10, 2035-06)` and `[2026-10, 2039-09)`; `spending` = base 4,000,000, essential 2,400,000, `startMonth` 2035-06, `survivorBp` 10000, phases from 2035, 2050, 2060 at 10000, goals [roof 2031 1,800,000 today]; healthcare entries p1 (2035-06, 2040-06) and p2 (2039-09, 2042-09) with zero amounts; no long-term care; conversions [2036, p1, 3,000,000, today]; eight accounts (B, T, K, R, H, Checking, Savings and `synthetic:roth:p1` with balance 0 and allocation 5000 / 2500 / 2000 / 500, `pretax_mix`); K and H `household_target`; bank accounts 0 / 0 / 0 / 10000; balances summing to 22,582,700; four contributions (K, H, B, R as in case 8). Issues: no errors; exactly eight warnings: `basis_unknown` (T), `allocation_assumed` (K), `allocation_assumed` (H), `uncategorized_in_spending`, `contribution_partial_window` (H), `irregular_contributions` (B), `contribution_from_recurring` (R), `goal_before_retirement` (roof). The input contains no float and no null (recursive check).
12. **Override scenario** `{ people: { p1: { retirementAge: 58 } } }`: p1 `retirementMonth` 2033-06; `spending.startMonth` 2033-06; K and H `endMonth` 2033-06; B and R unchanged (2039-09); p1's healthcare `preMedicareFrom` 2033-06; the hash differs from case 11.
13. **Errors**, each giving no input: R's owner removed → `owner_required` at `accounts.<R>.owner`; R's owner `joint` → `owner_required`; a person born 1960-03 with fixed age 65 → `planning_age_low` (1960 + 65 = 2025 ≤ 2026); a conversion for p2 (no pre-tax account) → `conversion_no_pretax`; a conversion from 2025 → `conversion_in_past`; two conversions for p1 covering 2036 → `conversion_overlap`; `estimate` for a person born 1958-03 claiming at 67 years 0 months (2025-03) → `claim_in_past`; phases at ages 75 then 70 → `phase_order`; a goal in 2025 with no repeat → `goal_in_past`; a one-person document with K's owner `p2` → `unknown_person`; `ctx.today` 2026-11-20 against the fixture baseline (38 days) → `baseline_too_old`; `ctx.minStartYear` 2027 → `start_year_unsupported`; a scenario patch editing `incomes.pen1.monthlyCents` after the profile deleted `pen1` → `override_invalid`.
14. **Canonical JSON and hash.** The 3.7 example gives exactly that string and digest. `1.5`, `null`, `undefined`, `NaN` and `2 ** 53` each throw `CanonicalJsonError`. Two inputs that differ only in `meta` or in an account's `name` have equal hashes; an input rebuilt with keys in another order has the same hash; `settings.seed + 1` changes it.
15. **Baseline diff.** Equal baselines → `[]`; the 3.6 pair → exactly those six rows with their `material` flags.
16. **Percentile paths and codecs.** The 3.8 example: paths 2, 2, 5, 3, 6, 8, 4; percentile 60 → 7; 1 → 2; 99 → 4; the listed `rankIndex` values. `encodeI64le` of the ten endings is 80 bytes and round-trips; `encodeI16le` of the depletion years (−1 for the eight that never deplete) is 20 bytes and round-trips.
17. **Glide weights.** The two 3.9 examples (5333 / 1667 / 2333 / 667 and 5400 / 1700 / 2250 / 650); before the first point and after the last the end points apply.
18. **Provenance.** T's basis: baseline only → `live`; profile `basisCents` → `profile`; a scenario patch on `accounts.<T>.basisCents` → `scenario`. K's allocation in the fixture → `default`; `spending.base` → `live`.

### Database (`describe.skipIf(!TEST_DATABASE_URL)`, `createTestDb()`)

19. **Migration constraints** (in `migration.test.ts`): a second `plan_profile` row; two default scenarios; an archived default; names differing only in case; a `done` run without `summary`; a `done` run with `paths_done ≠ paths`; a second `queued` run for one scenario; a series with an unknown kind; an `ending_real_cents` series whose length is not `8 × count` are each rejected. Deleting a scenario removes its runs, series and path rows.
20. **`computeBaseline` on the fixture**: every number of the 3.2 worked example (eight accounts in name order with values, buckets, bases, weights; `valuationBasis` `snapshot` for B and T, `positions` for R, `balance` for K, H and E, `bank_balance` for Checking and Savings; totals; targets; window 2025-10..2026-09 with 12 months; categories Rent 2,400,000 / Groceries 955,000 / Childcare 600,000; uncategorized 2 rows, 45,000 out, 20,000 in; take-home 8,400,000; investment income 4,720; the five contribution records; savings rate 2518 bp with 2,660,000 / 2,160,000 / 10,560,000). The 2026-10-05 and 2025-09-03 rows, the Savings transfers, E and V move no figure. A second call returns the same hash. With K's `tax_treatment` set to `none`: bucket `pre_tax`, `treatmentDefaulted`.
21. **Create**: `putProfile` with `expectedRevision: 0` → revision 1, the stored baseline equals case 20, one default scenario "Base plan" with `{}` overrides, three audit rows in one batch (`plan_profile`, `plan_baseline`, `scenario`, all `create`). The same document again: revision stays 1, no audit row. A changed retirement age → revision 2 and one `update` row whose `before` holds 60. `expectedRevision: 1` afterwards → `409 revision_conflict`. `revertProfile` with that audit row restores 60 at revision 3.
22. **Refresh**: after the two edits of the 3.6 example, `previewBaseline` returns the six rows and writes nothing; `refreshBaseline` with the preview's hash stores it (one `plan_baseline` audit row; `revision` unchanged); with a stale hash → `409 baseline_changed`; a refresh with nothing changed writes nothing.
23. **Scenarios**: create "Retire at 58" from a document with p1's retirement age 58 → stored overrides exactly `{ "people": { "p1": { "retirementAge": 58 } } }`, `changeCount` 1. Changing the profile's p1 salary to 13,000,000 shows in the scenario's effective document. A `doc` sent with a stale `profileRevision` → `409 revision_conflict`. Deleting `pen1` from the profile while a scenario patch edits it → the PUT succeeds and `scenarioIssues` lists that scenario with `override_invalid`; its run request → `409 plan_incomplete`. A second scenario named "retire AT 58" → `409 name_taken`. Setting another scenario default flips both rows in one audit batch; deleting or archiving the default → `409 default_scenario`. `revertScenario` restores the audited overrides.
24. **Request a run** (`refresh: false`): a `queued` run whose `input` deep-equals case 11's, `data_version` = the environment's, `paths` 10,000, `seed` 1; one job of type `retirement.simulate` whose payload is `{ runId, dedupeKey: "retirement.simulate:<runId>" }`; re-hashing the stored `input` gives `input_hash`. The same request again → the same run, `created: false`, `reused: true`, still one job. After changing the scenario's seed while the first is queued → `409 run_in_progress`. With `refresh: true` and nothing new → `baselineChanges` empty, no audit row; after adding K's 15,250,000 balance → the baseline is stored with one audit row, the changes are returned and the new input holds 15,250,000 for K. A plan with an error → `409 plan_incomplete` and no rows written, the refreshed baseline included.
25. **Lifecycle with the fake engine**: `beginSimRun` → `running` with engine version and threads; `reportSimProgress(4, 10)` → `paths_done` 4, `paths` 10, returns false; `completeSimRun` → `done`, `paths` 10, `success_paths` 8; series of 80 and 20 bytes that decode to the inputs; seven `sim_run_path` rows with `path_index` 2, 2, 5, 3, 6, 8, 4, `rank` 0, 0, 2, 4, 7, 8, 9, `ending_real_cents` 0, 0, 150, 300, 700, 900, 1200 and `depleted_year` 2047, 2047, then null; the view's `successBp` = `truncDiv(8 × 10000, 10)` = 8000. A later identical request returns this run (`reused: true`); with `force` it creates a new one; after a profile edit that changes the input the old run reports `current: false`.
26. **Run after cancel** (the per-run key): cancel a queued run, request again at once → a new run with its own job; draining the queue skips the first job and completes the second run. The same after cancelling a stalled run whose job row is still `running`.
27. **Cancel**: a queued run → `cancelled` at once and its job returns `{ skipped: true }`; a running run → `cancel_requested`, the next `reportSimProgress` returns true, `cancelSimRun` → `cancelled`, no series or path rows, a late `completeSimRun` writes nothing; a running run whose `progress_at` is 3 minutes old → `cancelled` at once; a `done` run → `409 run_not_active`.
28. **Failure**: `SimInputError("bad_allocation")` → run `failed` with that code, job `done`; an unknown engine error → run `failed` `engine_error`, job `failed` after one attempt; a job with `attempts` 3 and `maxAttempts` 2 → run `failed` `worker_crashed` without calling the engine; a stored input that does not parse → `bad_input`; a run whose `data_version` differs from the worker's → `data_version_changed`; a fake `simulatePath` whose ending wealth differs from the series → `not_reproducible`; a database error in `completeSimRun` on attempt 1 → the job is requeued and the run stays `running`; on attempt 2 → run `failed` `worker_error`.
29. **Retention** (`keep` = 2): the 3.11 example: r2 and its children are deleted, r1 (pinned), r3, r4 remain; of seven failed runs the two oldest are deleted. A 21st pin in one scenario → `409 pin_limit`.
30. **Paths**: percentile 50 → `source: "stored"`, path 3; percentile 60 → path 7, `source: "resimulated"`, the fake `simulatePath` called with 7; with a different `engine_version` on the row → `409 engine_changed` for 60 and still the stored table for 50; a fake `simulatePath` that disagrees with the series → `409 not_reproducible`; a queued run → `409 run_not_done`.
31. **Card**: no profile → `null`; a profile without a run → `no_run`; an active run → `running` with `active.progressBp` 0; after case 25 → `ready`, `successBp` 8000, `stale` = { false, false }; after a profile edit → `inputsChanged` true; with a newer engine version in the environment → `engineChanged` true; a failed run newer than the success → still `ready`; without `env` → `stale: null`.

### API (`createTestApp` with the fake planner, fixture)

32. **The app builds**: registering the retirement routes passes the request-guard check (no loose wire shape in any body, query or path contract).
33. **Viewer matrix**: a viewer gets 200 on routes 1, 2, 5, 7, 9, 13, 15, 16, 17, 18 and 403 `viewer` on 3, 4, 6, 8, 10, 11, 12, 14, 19, 20, 21; the row counts of the five tables, `job` and `audit_log` are unchanged.
34. **Profile round trip**: GET before creation → `exists: false`, `revision` 0, `doc` null, `baselineStored: false`, the baseline of case 20; PUT → 200; GET → the same document, `effective.baseSpendingCents` "4000000", `effective.essentialSpendingCents` "2400000", `effective.includedTotalCents` "22582700", `effective.planSavingsRateBp` 1644, `defaultScenarioId` set. A body with `claimAge.years` 71 → 400 `validation`. `today` 5 days off → 400 `today_out_of_range`.
35. **End to end**: PUT profile → POST scenario → POST run (202, `created: true`) → GET run (`queued`, `pathsDone` 0) → drain the queue → GET run (`done`, `successBp` 8000) → GET input equals the stored document → GET paths/50 (stored) → GET paths/60 (resimulated) → GET dashboard (`ready`). Every response parses with its contract.
36. **Error codes**: one request per row of the 4.8 table returns the listed status and code, including `profile_missing` for scenario and run writes before a profile exists.
37. **Dashboard**: `GET /api/dashboard` validates against the new `DashboardView` in each state of case 31; the Phase 2 and 3 dashboard suites pass unchanged (no profile → `retirement: null`).

### Worker

38. **Job through `dispatchJob`** with `ctx.sim` faked: cases 25, 27 and 28; the progress throttle (ten `onProgress` calls inside one second produce one write; a call after the interval produces the second).
39. **Thread default** (`env.test.ts`): parallelism 1 → 1; 2 → 1; 4 → 3; 8 → 7; 16 → 8; `RETIREMENT_THREADS=12` → 12; `=inline` → 0; `=0`, `=65` or `=abc` → auto.

## 8. Deviations and simplifications (flagged)

- **JSON documents instead of normalized planner tables**; `plan_profile` is a singleton. References from the document to accounts and categories are checked when the plan is resolved (a dangling setting is ignored with a warning), not by foreign keys.
- **Two tables beyond the spec's three rows** (`sim_run_series`, `sim_run_path`); `job` and `audit_log` are written as well (the spec says the planner writes only its own tables).
- **A stored baseline rather than values read while simulating.** With the default `refresh: true` a run starts from today's data; with `refresh: false` it is as old as the baseline shown, warned at 7 days and refused at 35.
- **"Any percentile path"** is served from seven stored tables plus on-demand re-simulation; after an engine or data upgrade only the stored seven remain for an old run.
- **Debts, property, vehicles and 529 accounts are not in the plan.** A mortgage stays inside base spending for life unless its category is excluded or a phase lowers spending; home equity is ignored; net worth on the dashboard is larger than the plan's starting assets.
- **Uncategorized outflows count as spending by default** (a switch; itemized; a warning names them). The grid ignores them, so the seeded figure can exceed the grid's 12-month actuals by exactly the listed amount. Uncategorized inflows are shown beside them and never netted.
- **Months of history follow the plan-math remediation's full-month rule**, applied to spending and to each account's contributions; both source designs counted a partial first month as a whole one.
- **Unknown cost basis is treated as 0** unless entered: tax on taxable withdrawals is overstated for those positions.
- **An investment account without a tax treatment takes its type's default**, with a warning.
- **Employer money is found by a description pattern, then by subtraction.** When neither applies the whole measured amount is treated as the employee's deferral: the amount saved is right, taxable wages while working are understated by the match.
- **Saving into bank accounts is not seeded as a contribution**; it can be entered by hand.
- **Gross salary and Social Security are typed.** The statement's figure assumes work continues to the claim age; an early retiree should enter the figure from SSA's calculator with a stop-work year (the form says so). People born on 1 January take the previous year's full retirement age; the plan knows only the birth month, so they set the claim age by hand.
- **Raises are real only; contributions scale with salary and are not capped at statutory limits here** (a warning uses the tax area's limit function; capping, if wanted, is the engine's).
- **Spending is modelled from the first retirement.** Before it, income is assumed to cover spending and taxes, the contributions are the explicit items, and a working household's surplus is not saved beyond them; a goal dated before retirement is the one outflow in those years.
- **Phase multipliers default to flat**; healthcare has no default dollar figure; the long-term care reserve is an expense over the last years of each named person's life, not a floor on ending wealth.
- **Filing status follows the number of people** (L2); two unmarried people are treated as married filing jointly.
- **One salary stream per person**; pension lump sums, annuity exclusion ratios beyond a flat taxable share, and rental depreciation are not modelled.
- **Fund costs are not deducted from returns.** One source design seeded a per-account cost drag from the holdings' expense ratios; it is left out (the spec names no such input, and the gate compares against an independent calculator), and is an open question.
- **Additions not in the spec**, each without effect until the owner types it: the optional Social Security benefit factor from a chosen year, the `other` income kind, excluded spending categories, the share of spending after a death, Roth contributions to date.
- **State of residence is stored and not taxed** (spec, v2).
- **Viewers cannot start runs**; progress is polled every second, not pushed.

## 9. Seams

**Package rule (to the lead and all areas).** Every wire and document schema of the four areas lives in `packages/shared/src/retirement/`; `@meridian/retirement` imports them and exports code and data only. Assumed files: `returnModel.ts` (engine-and-returns: `ReturnModelConfig`, `DEFAULT_RETURN_MODEL`), `strategy.ts` (strategies-outputs-web: `StrategyConfig`, `WithdrawalOrderConfig`, their defaults), `results.ts` (strategies-outputs-web: `SimSummary`, `FanSeries`, `YearTable`, each with `schemaVersion`, cents as strings).

**From engine-and-returns** (`@meridian/retirement`; the thread harness under `@meridian/retirement/node`):

```ts
export const ENGINE_VERSION: string;              // bumped on any change that can alter a number
export const DATA_VERSION: string;                // packages/retirement/data manifest version
export function simulatePath(input: SimInput, pathIndex: number): PathResult;     // pure, one path, deterministic (L5)
export interface RunSimulationOptions { threads: number; threadEntry?: URL; signal?: AbortSignal; onProgress?: (pathsDone: number, pathsTotal: number) => void }
export function runSimulation(input: SimInput, opts: RunSimulationOptions): Promise<SimOutput>;   // threads 0 = inline
export function runThreadMain(): void;            // the body of the worker-thread entry
export class SimInputError extends Error { readonly code: string }
export class SimAborted extends Error { readonly reason: "cancelled" | "timeout" }
export interface SimOutput { paths: number; successPaths: number; endingRealCents: BigInt64Array; depletionYear: Int16Array;   // one per path; -1 = never
  summary: SimSummary; fan: FanSeries; warnings: Array<{ code: string; message: string }> }
export interface PathResult { pathIndex: number; endingRealCents: bigint; depletionYear: number; table: YearTable }
```

Assumed behaviour:

- cents become dollars once on entry and are rounded half away from zero on exit (L1); `simulatePath` reproduces path k of `runSimulation` bit for bit; the inline mode yields to the event loop between chunks; an abort rejects with `SimAborted`;
- the plan clock is read from `plan` and the resolved months, never from the system clock; a flow with window `[startMonth, endMonth)` counts the months of each calendar year that fall in the window, twelfths of its annual amount (so year 0 counts at most `firstYearMonths`); how returns and inflation are scaled in the partial first year is the engine's rule to state;
- balances are as of `meta.asOf` and are taken as the balances at `startMonth`;
- the six asset classes map to the engine's return series (assumed: US and international stock, real estate and other → stocks; bonds → bonds; cash → bills); an account is rebalanced each year to `glideWeightsAt(glidePath, year)` when it has a glide path, else to `allocation`; `synthetic` accounts start at 0;
- a `fixed` life ends with the calendar year of `birthYear + age`; in `mortality` mode the engine draws the death year from the table for `sex`, shifted by `adjustYears`, capped at `maxAge`;
- a contribution in year t is its year-0 annual amount × (salary paid in year t to `scaleWith`) ÷ `salaryBasisCents`, so it follows raises and stops with the salary; `scaleWith: "inflation"` follows the path's price level until `endMonth`;
- today's-dollar amounts are indexed by the path's inflation from the plan start; a `nominal` stream starts at its quoted amount; after its first year a stream follows `cola` (pension, annuity) or inflation plus `realGrowthBp` (the others);
- the historical model reports its own `paths`; `paths` in the settings is a request.

**From tax-rmd-ss:**

- `listTaxRuleSets(): Array<{ id: string; label: string }>` (contains `current_law`) and `TAX_DATA_FIRST_YEAR: number` (2026; `PlannerEnv.minStartYear`);
- `contributionLimit(year, age, kind: "employer_plan" | "ira" | "hsa_family"): bigint | null` in cents (2026 as published; later years as that area indexes them; `hsa_family` is the family limit plus the age-55 catch-up, because the plan does not know the coverage tier);
- the full-retirement-age table for `GET /meta` (the form's default claim age);
- Social Security from the frozen entries: the amount entered with `asOfYear` is indexed by published COLAs up to the start year and by path inflation after; `estimate` with a zero amount is a person with no own benefit who can still receive spousal and survivor benefits from the claim month; for `receiving` without `monthlyAtFraCents` the full-retirement-age amount is derived from the benefit and `startedMonth`; `spousal`, `survivor` and `adjustment` (benefits × `factorBp` ÷ 10000 from `fromYear`) are honoured;
- tax character of income: `salary` and `part_time` are wages (`earned`); `pension`, `annuity`, `rental` and `other` are ordinary income × `taxableBp`; employee contributions to `pre_tax` and `hsa` accounts reduce that person's taxable wages; employer contributions are never income;
- early-withdrawal rules read `owner`, the person's birth month, `rothContributionBasisCents` (absent = unknown, assumed no basis) and `basisCoverage`.

**From strategies-outputs-web:**

- `StrategyConfig` (the five strategies), `WithdrawalOrderConfig` (`{ kind: "default" }` in v1), `SimSummary` (must expose `endingWealthReal.p50` and `.p10` as cents strings for the run list and the card), `FanSeries`, `YearTable` (carrying nominal cents and the path's cumulative inflation index, so either basis can be shown);
- the success criterion behind `successPaths`;
- confirmation of the rank rule of decision 22, which this area implements in `rankPaths` because it stores and serves the paths;
- spending semantics: the need of a year is base × phase multiplier × (`survivorBp` after the first death) + goals + healthcare + long-term care, each in today's dollars and then indexed; only the base is subject to a strategy's cuts and raises; the floor-and-ceiling strategy reads `essentialAnnualCents`; a goal is withdrawn in its year whether or not anyone has retired; healthcare before 65 applies only once the person has retired; the long-term care reserve is spent evenly over the last `lastYears` years of that person's life; conversions move the amount from the person's pre-tax accounts pro rata to that person's Roth account (the synthetic one when there is no other);
- the web pages and the card component, which call the routes of 4.7.

**What this area gives the others:** the `SimInput` type and the fixture's frozen input (case 11) as a shared test fixture; `glideWeightsAt`; `rankPaths` and `selectPercentilePath`; the run, input and path routes; `DashboardView.retirement`; `provenance` and `issues` for the forms.

**From Phases 1 to 3 (existing code, unchanged unless listed under "touches"):** `investmentContext`, `classifiedLines`, `holdingCostBasis`, `defaultAsOf`; `firstDataDates`; `loadFlowRows`; `firstFullLedgerMonth`, `averageWindow`; `CADENCE_TABLE`; `allocateLargestRemainder`, `truncDiv`, `ceilDiv`; `sha256Hex`; `enqueueJob` with `dedupeKey`; `writeAudit`; `resolveToday`, `usePlanErrors`, `auditContext`; `defaultTaxTreatment`.

## 10. Sources

Code read at commit `786cb0d`: `packages/db/src/services/{jobs,valuation,lots,investmentViews,investmentIncome,accountFidelity,plan,planScope,performance,settings,dashboard,audit}.ts`; `packages/db/src/schema/{plan,recurring,investments,ledger}.ts`; `packages/db/drizzle/` and its journal; `packages/db/src/test/investmentSeed.ts`; `packages/shared/src/{api,enums,wire,decimal,months,dates,plan,schedule,crypto,performance,valuation}.ts`; `apps/worker/src/{runner,env}.ts`, `apps/worker/src/jobs/{index,context}.ts`, `apps/worker/package.json`; `apps/api/src/{app.ts,plugins/auth.ts,plugins/requestGuards.ts,routes/plan.ts,routes/dashboard.ts,routes/goals.ts,lib/limits.ts,test/helpers.ts}`; `scripts/bundle.mjs`; `docs/phase-2-plan.md`, `docs/phase-3-plan.md`; the spec.

Judges' claims checked against that code and found correct: `enqueueJob` returns a queued or running job with the same `dedupeKey`; `requeueStaleJobs` ignores attempts while `claimNextJob` counts every claim; the request-guard plugin throws at route registration on `CentsString`, `NonNegCentsString`, `IsoDateString` or `MonthString` in a request contract; `sha256Hex` is asynchronous; `loadActuals` and `latestBalances` are private; `allocateLargestRemainder` throws on a zero total; the Roth seed account is valued on the `positions` basis; `household_setting` is a `smallint` singleton; `PlanError` is used with 400, 404 and 409 (one 403, one 500), never 422; deletes answer `OkResponse`. One judge fetched `www.irs.gov` successfully in its session; that could not be repeated here.

Found during the merge, in neither design and neither verdict: migration index 4 is taken (section 2); `planAverages` now counts only months the on-budget ledger covers in full (`firstFullLedgerMonth`), which this design adopts.

External figures this area uses (web search only; status after each):

- Full retirement age: 66 for 1943 to 1954, then 66 and 2, 4, 6, 8, 10 months for 1955 to 1959, 67 for 1960 and later; a person born on 1 January uses the previous year. https://www.capitalone.com/learn-grow/life-events/full-retirement-age/ , https://www.everycrsreport.com/files/20140123_R41962_755888d1f82be73392d9362198fc9e18b013f1a4.html , https://fool.com/retirement/2023/02/16/the-most-important-social-security-table-youll-eve . Corroborated; the table itself is the tax area's.
- Claiming ages 62 to 70 (delayed credits stop at 70) and Medicare eligibility at 65 (the healthcare boundary): https://www.aetna.com/medicare/understanding-medicare/social-security-medicare-enrollment.html , https://www.medicareresources.org/faqs/do-i-need-to-be-on-social-security-to-get-medicare-coverage/ , https://investmentnews.com/retirement-planning/countdown-to-medicare-and-social-security-checklist/77090 . Corroborated by secondary sources; no primary page fetched.
- 2026 contribution limits (the `contribution_over_limit` example): 401(k) deferral $24,500, catch-up $8,000 at 50, $11,250 at 60 to 63, IRA $7,500 plus $1,100. IR-2025-111 and Notice 2025-67 as reported by https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (search result, not fetched), https://kpmg.com/us/en/taxnewsflash/news/2025/11/notice-2025-67-increased-retirement-plan-contribution-limits-2026.html , https://www.cpapracticeadvisor.com/2025/11/13/irs-bumps-up-401k-ira-contribution-limits-for-2026/173130/ . Corroborated. One source design marked the $8,000 catch-up as unconfirmed because one page said $8,600; that page is wrong.
- HSA limits: 2026 $4,400 self-only and $8,750 family; 2027 $4,500 and $9,000 (Rev. Proc. 2026-24); catch-up $1,000 at 55. https://thelink.ascensus.com/articles/2026/7/13/2027-hsa-limits-released , https://401kspecialistmag.com/2027-hsa-contribution-limits-released-by-irs/ , https://www.ifebp.org/detail-pages/news/2026/06/01/irs-releases-2027-hsa--hdhp--and-hra-inflation-adjusted-amounts . Corroborated.
- RMD ages 73 (born 1951 to 1959) and 75 (1960 and later), with the 1959 drafting error resolved to 73 by the July 2024 proposed regulations: https://www.milliman.com/en/insight/irs-proposed-regulations-rmd , https://irahelp.com/slottreport/whats-the-first-rmd-year-for-those-born-in-1959 , https://www.plansponsor.com/irs-proposes-regulations-for-changes-to-secure-2-0-rmds/ . Corroborated; the spec's reading stands.
- Penalty ages that follow the account owner: 10% additional tax before 59½ on pre-tax accounts (Roth contributions come out free at any time); 20% on non-medical HSA withdrawals before 65. https://www.irs.gov/es/retirement-plans/plan-participant-employee/retirement-topics-exceptions-to-tax-on-early-distributions (search result), https://www.capitalone.com/learn-grow/money-management/roth-ira-withdrawal-rules/ , https://livelyme.com/blog/guide-to-hsa-withdrawals , https://kiplinger.com/article/retirement/t037-c001-s003-making-the-most-of-a-health-savings-account-age-65.html . Corroborated; the rules are the tax area's.
- Cost-of-living adjustments: 3.6% for 2027 (announced 2026-10-14) and 2.8% for 2026. https://goodmorningamerica.com/news/story/social-security-administration-cost-living-adjustment-rise-36-137234823 ; the source designs also cited AP and Fox Business reports. One post-announcement source found in this session; the tax area checks SSA's page.
- Methods cited from knowledge, not fetched: RFC 7396 JSON Merge Patch (https://www.rfc-editor.org/rfc/rfc7396); canonical key ordering after RFC 8785, restricted here to integers; the nearest-rank percentile; Node `os.availableParallelism()` and `worker_threads`.

Unverified (the implementer checks before relying on them):

- 2027 401(k) and IRA limits: not published on 2026-11-10; $25,500 is a forecast (https://401kspecialistmag.com/2027-401k-contribution-limits-all-but-official-25500-expected/). The tax data file must not carry it as published.
- That the SSA statement's estimates are in today's dollars and assume work continues to the claim age: secondary sources only.
- Medicare at 65 and the claiming ages against medicare.gov and ssa.gov; the 2027 COLA against SSA's own release.
- The storage sizes of 2.7 (estimates).
- No run-time figure is given anywhere in this document.

No table contents were invented; this area ships no data file.

## 11. Open questions

1. Baseline policy: refresh on every run by default (this design) with an opt-out, or never opt out so "latest run" always means "today's balances"?
2. Uncategorized outflows in base spending: on by default (this design, conservative) or off (the grid's reading)?
3. Should checking accounts count as plan assets by default, or only savings?
4. Long-term care: an expense over the last years of life (this design) or a floor that ending wealth must clear? It changes the success definition, which the strategies area owns.
5. First-year rule (decision 19): the engine area may prefer day-exact prorating; whichever wins must be the single rule in `SimInput`.
6. A goal before retirement is withdrawn from savings (assumed in section 9). Should a goal be able to say "paid from income"?
7. Does the dashboard card follow the default scenario (decision 33) or literally the newest run of any scenario?
8. May a viewer start a run? It writes rows and uses the processor, so this design says no.
9. Should 529 money, property and a mortgage payoff be assignable to the plan in v1?
10. Two unmarried people in one household (L2 forces married filing jointly).
11. Account ownership lives in the profile document. Would a column on `account` serve other features better?
12. Fund costs: add a per-account cost drag from the holdings' expense ratios (measured 270 ppm for the seed's brokerage account) in v2, or leave returns gross?
13. The Social Security benefit factor is a scenario field here; the spec's "law change" rule sets could carry it instead. One mechanism or both?
14. Retention (20 finished runs a scenario, about 6 MB estimated) once nightly encrypted backups multiply it.
15. Should simulations run on a second queue lane or a second worker container, so a sync never waits behind a run? (The server's processor count is still the spec's open question; `RETIREMENT_THREADS` covers it meanwhile.)
16. The network allowlist needs `www.irs.gov`, `www.ssa.gov` and `pages.stern.nyu.edu` before the data files' provenance can be completed.

## 12. Judging record

Scores (correctness / spec fidelity / codebase fit / testability):

| | Design A | Design B | Winner |
| --- | --- | --- | --- |
| Judge 1 | 6.5 / 7.5 / 7 / 8 = 29.0 | 7.5 / 8 / 7.5 / 8 = 31.0 | B, "by a small margin" |
| Judge 2 | 7 / 7 / 7.5 / 8 = 29.5 | 6 / 7.5 / 7 / 7 = 27.5 | A |
| Total | 58.5 | 58.5 | tie |

The judges split and the totals are equal. The merge starts from A: judge 1 called A's three blocking defects "small edits" and listed A's month-resolved timing, required ownership, shared seed and worker specifics as grafts, while B's defects that both judges named (every age event on 1 January, owners defaulting to p1, the three-class collapse, a random seed per scenario) sit in its structure. B's contract discipline is carried in whole.

Taken from A: the document shape and its modes (`live` or typed); the baseline with preview, `expectedHash` and effective before and after; the bucket table; required ownership; month-resolved timing and the nearest-month start rule; real raises; the match formula and description detection; Roth contribution basis; `claim_in_past`; the three-month minimum for annualizing; lenient save and strict run with the input preview route; the engine's own path count; the crash guard; the shared seed; conventions (409, `OkResponse`, the `smallint` singleton, a `plan_baseline` audit entity); `JobContext.sim`, inline mode and the second bundle; the fixture.

Taken from B: the frozen input as a strict, null-free, float-free contract with `meta` outside the hash; all schemas in shared and the one-way package rule; the per-run job key; server-side `diffPatch`, `overrideChanges` and provenance; refresh on run by default with the diff in the response and the `material` flag; the per-path series, the worker's re-simulation of the stored paths and `not_reproducible`; the rank rule with ties; essential spending and the survivor share; the household target as an allocation fallback; the recurring-transfer fallback; the spousal and survivor switches; three labelled phases; the `other` income kind; nominal goals; per-person longevity; `data.version` in the hash and `data_version_changed`; revert routes; the disclaimer; the one-request-per-error-code and end-to-end API tests; tighter canonical JSON with a pinned digest.

Every flaw the judges named was fixed as follows where the fix is not obvious from the lists above: the dependency cycle by the package rule; the unregistrable `PUT /profile` by bounded wire shapes throughout the document; the stale plan clock by refresh on run, the 35-day limit and `start_year_unsupported`; bank accounts with a tax treatment by typing the bucket first; the impossible `planning_age_low` test by a person aged 66 with a fixed age of 65; the missing `irregular_contributions` expectation by adding it (the rule stands); the manual-basis clamp by removing it; the allocation order by putting the owner's typed default first and warning on every borrowed mix; a spouse without a benefit by `estimate` with a zero amount and a claim age; goals before retirement by a stated treatment and a warning; zero-value accounts by `classWeights` returning nothing; B's test errors (the Roth account's valuation basis, the missing uncategorized warning, twelve against thirteen runs) do not arise in the fixture kept and are asserted correctly in cases 11, 20 and 29.

Where a judge was overruled, or the judges disagreed:

- **Uncategorized outflows in base spending** stay on by default. Judge 2 faulted the default (an unflagged transfer inflates spending); judge 1 listed the itemized, switchable addition as a graft. Netting inflows instead would let an uncategorized deposit hide real spending, which is the dangerous direction for a retirement plan; the line is itemized, warned and switchable, with the inflows shown beside it.
- **Refresh on run rewrites the baseline every scenario shares.** Both judges noted the side effect; judge 2 still grafted the default and judge 1 counted it as B's closest reading of "pulled live". It is kept: the other scenarios' runs then report `current: false`, which is true, a same-day refresh with no new data changes nothing, and `refresh: false` plus the shared seed serve side-by-side comparison.
- **The Social Security benefit factor** is kept (judge 2's graft) although judge 1 listed it among unasked additions: it has no effect until the owner types it, and a benefit cut is the commonest what-if; it is flagged in sections 8 and 11.
- **The per-account cost drag** (judge 2: optional) is not taken, with judge 1: it would change results by default without the spec asking for it.
- **Manual accounts and a per-account balance override** (B) are not taken, with judge 1; an account that is not connected is added on the Accounts page.
- **`irregular` on a single yearly deposit**: judge 1 read the missing warning as a contradiction; the warning is the right outcome for one deposit that is the whole year's saving, so the expectation was fixed, not the rule.
- **Wrong figures**: neither judge found a wrong tax, RMD or Social Security figure, and none was found here. A's "seconds to a minute at 10,000 paths" and B's compressed-size figure were unsupported and are removed; A's unsourced statement about the IRS default for unprovable basis is dropped (the Phase 3 rule is the stated reason); the 2026 age-50 catch-up is $8,000; the 2027 401(k) and IRA limits remain unpublished.
