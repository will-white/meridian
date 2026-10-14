# Phase 3 design: Prices, provider and valuation

Area: the price provider interface and the first free end-of-day source; the `prices.fetch` worker job and its scheduler; implied prices for ticker-less funds and the price precedence rule; the valuation chain (account value on any date, carry-forward over closed days, trading-day staleness, cash inference); the portfolio value-over-time series; day and period change; and the Phase 3 gate (reconciling an account to a brokerage statement to the dollar). Angle: B's shape (one provider, one job, one valuation function with an ordered chain, preview/commit routes on the Phase 2 conventions) carrying A's market semantics (expected price date and trading-day staleness, price-only day change, net-flow-split period change, opt-in cash inference, rank-ordered precedence, a reconciliation record as the gate's evidence).

This is the merged area design. It is self-contained: an implementer builds from it without the two originals. Source of truth is the design spec; `docs/phase-1-plan.md` and `docs/phase-2-plan.md` are binding for conventions. The two sibling Phase 3 designs already on this branch, `docs/design/phase-3/imports-and-data.md` (owns `security`, `price` DDL, `holding_snapshot`, the Fixed8 helpers) and `docs/design/phase-3/lots-and-performance.md` (owns `lot`, `account.investment_history`, the full-account valuation), are treated as the seams this area must fit; where they disagree with each other §9 names the conflict for the phase plan. Every number in §3 and §7 was re-derived with a BigInt reference run of exactly the rules below (`scratchpad/prices-merge/calc.mjs`; scratch only, nothing in the repo was modified).

**Spec conflict flagged up front.** The spec's data-sources table marks OFX/QFX as Phase 3 while its build-phase list puts OFX under Phase 6 Polish. This design treats OFX as out of scope for Phase 3. Nothing here depends on the import format: an OFX positions adapter feeds `holding_snapshot` through the imports area's `replaceHoldingSnapshot`, which then calls this area's `writeImpliedPrices` and `requestPriceRefresh` unchanged (Deviation 1).

## 1. Decisions (binding)

1. **Numeric representation.** Share quantities and prices are `numeric(20,8)` in Postgres, decimal strings on the wire (`Fixed8String`, bounded: `/^-?\d{1,12}(\.\d{1,8})?$/`, the exact image of `numeric(20,8)`), and `Fixed8 = bigint` scaled by 10⁸ in every computation; cents are `bigint`; rates are the only floats and never feed back into cents. One shared helper module (`parseFixed8`, `formatFixed8`, `roundDiv`, `mulToCents`, `impliedPrice`, `centsToFixed8`) is used by all four Phase 3 areas; this document calls the helpers by the imports area's names and §9 asks the phase plan to settle the file name (`decimal.ts` vs the lots area's `fixed.ts`). Reason: no JS `number` ever holds a quantity, a price or cents; one parse at the DB boundary; no decimal library.
2. **One rounding rule, stated once.** quantity × price → cents is `roundDiv(q8 × p8, 10¹⁴)` (round half away from zero on the exact product; §3.1); implied unit price is `roundDiv(cents × 10¹⁴, q8)`. Those are the only rounding sites in this area; everything else is integer sums. Line values are rounded once per (position, date) and then summed, never summed in Fixed8 and rounded once. Reason: brokerage statements round each position's market value to the cent; this is what makes the gate reproducible.
3. **Provider: Tiingo end-of-day**, free Starter key, CSV format, behind one interface (`PriceProvider.fetchDaily(symbol, range)`), chosen because it is the only free source found that covers US stocks, ETFs *and* mutual-fund NAVs (a household's 401(k)/IRA holdings are funds), returns a whole date range in one request (backfill = one request per security), and publishes personal-use limits (500 unique symbols/month, 50 requests/hour, 1,000/day). The limits could not be re-verified from the build container (§1.1): every number is an env default. **No second adapter ships in Phase 3**: Stooq's keyless CSV endpoint has returned a request-an-API-key HTML page since March 2026 (both judges confirmed), so a "keyless fallback" would be dead code; Twelve Data is the documented alternative if Tiingo's fund coverage disappoints (OQ1). A community adapter is one file behind `PRICE_PROVIDER`.
4. **No provider configured = feed off, app still right.** `PRICE_PROVIDER=none` (the default) means the scheduler never queues a fetch, valuations use implied and manual prices, and the Prices page says so. `PRICE_PROVIDER=tiingo` without a key fails the worker at boot (like `SECRETS_KEY`). The API reads `PRICE_PROVIDER` from its own environment to render the state; the compose file's shared `x-app-env` (`env_file: ../.env`) already delivers `.env` to both `web` and `worker` (verified), so nothing is parsed out of `import_log` messages.
5. **Price rows carry provenance and one precedence rule.** `price.source ∈ provider | implied | manual` (the imports area's `PriceSource`), rank `manual 3 > provider 2 > implied 1`; a write replaces an existing `(security, date)` row only when its rank ≥ the existing rank (provider over provider re-fetch is allowed so corrected closes land; a manual price is never overwritten by the feed; an implied price never clobbers a real close). Every valued snapshot line, ticker or not, writes an `implied` row for the snapshot date (imports area Decision 12), so a freshly imported ticker has a sane price before the backfill lands and every account holding it values consistently. Reason: provenance drives both precedence and display; three ranks are enough (A's separate `statement`/`positions` ranks collapse into `implied`: both are "what a document said").
6. **Pricing mode per security is the imports area's `security.price_mode ∈ provider | implied | manual`.** `provider`: fetched. `implied`: unit price = value ÷ quantity of the latest positions import (the spec's rule for funds without a public ticker). `manual`: never fetched; cash is `type = 'cash'` and valued at 1.00000000 by definition without price rows; a money-market fund or a stable-value fund is `manual` with one manual row at its constant NAV, carried forward forever (no separate `fixed_price` column). Reason: one switch, no new enum.
7. **Trading calendar is computed, not stored**: NYSE weekends, the ten rule-based holidays with the Saturday→Friday (except New Year's Day) / Sunday→Monday observance rule, and a short code list of special closures. Reason: "was this a trading day" is needed offline and deterministically for the expected price date, staleness and day change.
8. **Expected price date.** `expectedPriceDate(now)` = the last trading day on or before the America/New_York date if the ET clock is ≥ 18:30, else the previous trading day; for a historical date `D` the expected close is `lastTradingDayOnOrBefore(D)` capped at `expectedPriceDate(now)`. Reason: EOD closes and fund NAVs post after the close; before 18:30 ET yesterday's close is the newest a feed can honestly have.
9. **Staleness is keyed on the security's pricing mode and counted in trading days.** A `provider`-mode position is `stale` when its price date is before the expected close for `D`; `tradingDaysBehind` counts trading days in `(priceDate, expected(D)]`. `implied` and `manual` prices are never stale: they show `as of <date>`. Weekends and holidays inherit Friday's close with status `current`. Reason: a stale flag is a feed-problem signal, not a property of statement data; the 4-calendar-day rule flagged a Thursday close on every long weekend.
10. **Carry-forward.** The close used on `D` is the latest `price` row (any source, by precedence) with date ≤ `D`. A position with no price row at all carries its snapshot value (`carried`), or contributes `null` when there is no value to carry (`unpriced`); an account with an unpriced line has `valueCents = null`, never a partial total.
11. **Positions come from trades only by an explicit switch.** Lots are the basis only when `account.investment_history = 'full'` (the lots area's stored flag, set by the trade-history import or the user after opening lots exist), and then only while the latest trade checkpoint on or before `D` is newer than the latest holding snapshot on or before `D`; a snapshot newer than the last trade wins until the next trade. Reason (shown by the reference run): inferring "newer evidence wins" values a positions account that recorded one 0.5-share reinvest after its statement at $157.63 instead of $32,759.56; and without the tie-break an accepted statement would revert to lots the next day.
12. **Valuation chain for `valueAccountOn(account, D)`**: (a) a holding snapshot dated exactly `D` → Σ its `value_cents` (statement truth); (b) `full` account with a trade checkpoint newer than the snapshot → the lots area's `valueFullAccount(D)` (lots marked to market, cash anchored on `balance_snapshot`); (c) latest snapshot ≤ `D` carried forward at the latest close ≤ `D`; (d) latest `balance_snapshot` ≤ `D`; (e) `null`. Exactly one basis per account per date; a SimpleFIN balance is never added on top of priced positions. Reason: the task's order with the one necessary tie-break.
13. **Cash inference is opt-in** (`account.cash_inference ∈ auto | off`, default `off`). When `auto`: on a snapshot date without a cash line and with a `balance_snapshot` on that date, `balance − Σ positions` is carried as a labelled `Cash (from balance)` line until the next snapshot; transfer legs (`is_transfer`) in the account dated after the snapshot are carried as cash until the next snapshot. The reconcile preview computes both settings and says when turning it on would reconcile. Reason: positions CSVs routinely omit the sweep fund and a contribution that landed last week is money the app knows about; default-off because the plug absorbs any balance-vs-statement timing difference as "cash", so it must be the owner's choice and every inferred line is labelled.
14. **Day change is price movement on today's holdings**, flows excluded: Σ over positions of `mulToCents(qty, close(asOf)) − mulToCents(qty, close(prior))` with `asOf` = the latest priced date on or before `min(D, expectedPriceDate(now))` among the selected feed securities and `prior = previousTradingDay(asOf)`. Balance-only accounts, cash, plug and carried-flow lines contribute nothing; a balance-only account is reported `null` with `reason: 'balance_only'` and the portfolio figure is marked `partial`. Reason: a Saturday HSA deposit is not a market move, and anchoring on the latest priced date gives the last completed session's move in the morning instead of 0.
15. **Period change splits flows from market.** `changeCents = V(end) − V(start)`; `netFlowsCents` = the lots area's external flows in `(start, end]` plus the opening value of every account that had no value at `start` (Phase 2's `newAccounts` convention, with the lots area's opening-value treatment); `marketChangeCents = change − netFlows`, `null` with a reason when an account's value cannot reflect its flows (positions basis with `cash_inference = off` and non-zero flows in the window). Presets: `1w` = `addDays(end, −7)`, `1m|3m|6m|1y` = `addMonthsClamped`, `ytd` = `${year−1}-12-31`, `all` = the first date with data. Reason: the spec recognises contributions as transfers; using them is what makes "change" mean something.
16. **Reconciliation is the gate, in two routes.** `POST /api/reconcile/preview` (no writes, `readOnly`, viewer-callable) compares the app's independent valuation on the statement date with the typed statement per row and in total, with `matchesToTheDollar = |difference| < 100` cents. `POST /api/reconcile/commit` (owner) always writes an `account_reconciliation` row (the evidence) and, when `accept` is true (default), writes the statement as a `holding_snapshot` with `source = 'manual'` (rank 3: no later feed or CSV clobbers it), replaces `balance_snapshot` for that date with the statement total, rebuilds implied prices and audits one batch. **Gate definition:** for at least one investment account, the *pre-commit* valuation on the statement date is within $1 of the statement total and the post-commit valuation equals it exactly. The statement wins on its own date; the provider close stays canonical for every other account and date.
17. **Fetch set and backfill.** Held `provider`-mode securities only (non-zero quantity in the latest snapshot of an open investment account, or open lots in a `full` account), plus `security.always_price` and `household_setting.benchmark_security_id`. Backfill is one request from `firstNeededDate(security) − 7 days` (floored at `PRICE_HISTORY_MAX_YEARS`) to the expected date; nightly re-fetches from `latest provider date − 3 days` (overlap) so late NAV corrections heal.
18. **One job, bounded runs, deduped keys.** `prices.fetch` runs nightly at `PRICE_FETCH_HOUR` household-local (default 18) and as a conditional catch-up at `PRICE_CATCHUP_HOUR` (default 6) that is queued only when some fetched security is behind; both are idempotent (upserts by `(security, date)`; nothing to do = zero requests). A run makes at most `PRICE_MAX_REQUESTS_PER_RUN` (45) requests spaced 1.5 s apart and stops after 20 minutes wall clock; the remainder goes to a continuation job 61 minutes later (at most 5 per root run). `enqueueJob` gains `payload.dedupeKey` so nightly, catch-up, manual, holdings-triggered, refill and continuation jobs dedupe on distinct keys instead of colliding with whatever `prices.fetch` is queued. Reason: the free hourly cap is honoured without a persisted budget table; the existing dedupe (any queued job of the type) would swallow an import-triggered fetch while a continuation waits an hour out.
19. **Retries and failure handling.** Per symbol at most 3 attempts in a run: sleep `Retry-After` (capped 120 s) on 429, else 5 s then 15 s; 404 → `not_found`, no retry, re-tried after 7 days or when the symbol is edited; 401/403 → the run stops with a permanent `PriceFeedError` (the runner's retry decision is generalised to any error with `permanent === true`); network/5xx failures set per-security exponential backoff `price_next_attempt_at = now + min(6 h × 2^(failures−1), 48 h)`. Provider errors never fail the job; only DB errors do (then `failJob` retries with the queue's backoff). A run that fails every request on the network throws a retryable error and queues no continuation.
20. **No new alert kinds.** Feed health surfaces through `GET /api/prices/status`, the Prices page, and a `prices` block the views area may add to the dashboard. Reason: the Phase 2 `alert` table is payee-bound (`payee_id NOT NULL`, inner-joined in `services/alerts.ts`); widening it for feed failures would ripple into Phase 2 pages and tests for a status that one card shows better.
21. **Suspect closes are stored and marked, never dropped.** A provider close that moves more than 50 % against the previous close within 7 calendar days with `splitFactor` 1 (or unknown) sets `price.suspect = true`; the UI shows a marker. Reason: data errors happen at every feed; hiding them hides the explanation for a valuation jump.
22. **Adjusted closes travel on the same row.** `price.adj_close` keeps Tiingo's `adjClose` for provider rows; `loadPriceSeries(…, { adjusted: true })` returns it (falling back to `close`) so the lots area's benchmark can be total-return without a second source value. Valuation always uses the unadjusted `close` (statements quote unadjusted prices against the quantities held).
23. **Manual prices** are `PUT/DELETE /api/prices/:securityId/:date` through the imports area's `setManualPrice` (audited as a `security` update) plus `deleteManualPrice` (manual rows only, `409 manual_only`), and deleting one queues a refill fetch from that date so the feed refills the hole.
24. **`today`** follows Phase 2 §16 on every route (`resolveToday`, ±2 days); the valuation's `expectedThrough` comes from the server clock in America/New_York, independent of `today`.
25. **Audit:** reconciliation commits (`AuditEntity` += `reconciliation`, entity id `${accountId}:${statementDate}`), manual prices (imports area's `security` entity) and pricing changes (`security`); fetch runs are recorded by `import_log` (kind `prices.fetch`), not `audit_log`.
26. **Errors** are `PlanError(status, code, message)` mapped by `usePlanErrors`; codes: `validation`, `not_found`, `bad_request`, `manual_only`, `cash_security_reserved`, `ticker_required`, `duplicate_security`, `unknown_ticker`, `future_date`, `forbidden`.

### 1.1 Provider survey (October 2026)

Direct fetches of the providers' pages failed from the build container (DNS/proxy), so the figures come from web-search snippets of the providers' own pages and third-party summaries. Treat every number as "confirm at signup"; all of them are env defaults (§6.4).

| Source | Key | Free limits (as found) | US stocks / ETFs | Mutual-fund NAV | History | Terms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Tiingo** (EOD) | yes, free | 500 unique symbols/month, 50 req/hour, 1,000 req/day, 1 GB/month (one third-party page says 500 symbols/*day*) | yes | **yes** (daily endpoint returns NAVs; Tiingo cites 65–80k securities incl. mutual funds) | 30+ years, any range per request | individual, non-commercial; no redistribution | **chosen** |
| Twelve Data | yes | 8 credits/min, 800/day (Basic) | yes | no on Basic (NAV is paid) | yes | commercial use needs a paid plan | documented alternative |
| Stooq | key since ~March 2026 (CAPTCHA-issued); keyless CSV returns an HTML page | undocumented daily hits limit, week-long IP blocks reported | yes | unclear | long | unpublished | rejected (dead keyless path, no terms) |
| Alpha Vantage | yes | 25 req/day, 5/min | yes | partial | full needs `outputsize=full` | non-commercial | rejected: 25/day cannot backfill a 20-fund household |
| Finnhub | yes | 60/min | yes | no | candle endpoint reported 403 on free keys | personal | rejected |
| EODHD | yes | 20 calls/day, 1 year | yes | yes | 1 year free | — | rejected: 20/day |
| FMP | yes | 250/day, endpoints being retired | yes | partial | unclear | — | rejected: unstable free surface |
| Polygon / Massive | yes | 5/min, 2 years, EOD | yes | no | 2 years | — | rejected: no funds |
| Yahoo (unofficial) | none | 429s, crumb/cookie churn | yes | yes | long | no terms for this use | rejected on terms and stability |

Budget check: a household holding 30 securities makes 30 requests per nightly run (under 50/hour and 1,000/day) and touches 30 unique symbols a month (under 500); the first backfill is one request per security regardless of depth (20 years ≈ 5,000 rows ≈ 400 KB CSV).

## 2. Data model

Conventions as in Phase 1/2: `uuid` ids, `bigint` cents, `date` for calendar dates, `text` columns validated by app-level enums plus the DB CHECKs listed (`check()` from `drizzle-orm/pg-core` 0.38.4; `pnpm db:generate` carries them into `0002_phase3_investments`). Drizzle `numeric` columns are typed `string`; services call `parseFixed8` on read and `formatFixed8` on write and never pass a numeric through `Number`. Ownership: the imports area owns `security`, `price` and `holding_snapshot` DDL; this area adds the columns listed under them and owns `account_reconciliation`. Drizzle file: `packages/db/src/schema/investments.ts` (co-owned), with `account` changes in `schema/accounts.ts`.

### 2.1 `price` (imports area's table; columns this area adds are marked)

```sql
CREATE TABLE "price" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "security_id" uuid NOT NULL REFERENCES "security"("id") ON DELETE CASCADE,
  "date"        date NOT NULL,
  "close"       numeric(20,8) NOT NULL CHECK ("close" >= 0),
  "source"      text NOT NULL CHECK ("source" IN ('provider','implied','manual')),
  "adj_close"   numeric(20,8) CHECK ("adj_close" IS NULL OR "adj_close" >= 0),   -- (prices) provider rows: dividend/split-adjusted close
  "provider"    text,                                                            -- (prices) 'tiingo' on provider rows, null otherwise
  "suspect"     boolean NOT NULL DEFAULT false,                                  -- (prices) §3.6
  "fetched_at"  timestamp with time zone,                                        -- (prices) provider rows: when fetched
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "price_provider_shape" CHECK (("source" = 'provider') = ("provider" IS NOT NULL))
);
CREATE UNIQUE INDEX "price_security_date_idx" ON "price" ("security_id", "date");
CREATE INDEX "price_date_idx" ON "price" ("date");
```
The unique index serves carry-forward (`WHERE security_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1`). The lots area's DDL draft said `close > 0` and a `provider_adjusted` source; this table keeps the imports area's `>= 0` (a worthless security closes at 0) and carries the adjusted close as a column (D22); §9 flags both for the phase plan.

### 2.2 `security` (imports area's table; this area's columns)

```sql
ALTER TABLE "security"
  ADD COLUMN "always_price"          boolean NOT NULL DEFAULT false,   -- fetched even when not held (benchmarks)
  ADD COLUMN "price_fetched_at"      timestamp with time zone,         -- last attempt that reached the provider
  ADD COLUMN "price_fetch_status"    text CHECK ("price_fetch_status" IN ('ok','not_found','error','rate_limited')),
  ADD COLUMN "price_fetch_message"   text,                             -- sanitized provider text, <= 300 chars
  ADD COLUMN "price_fetch_failures"  integer NOT NULL DEFAULT 0,       -- consecutive network/http failures
  ADD COLUMN "price_next_attempt_at" timestamp with time zone,         -- backoff; null = eligible now
  ADD COLUMN "price_backfilled_from" date;                             -- earliest date a completed request covered
```
Read from the imports area: `id`, `ticker`, `name`, `type` (`cash` is valued at 1), `price_mode ∈ provider|implied|manual`, `provider_symbol` (the symbol at Tiingo when it differs from `ticker`), `archived`, `updated_at`. A `provider`-mode security must have a ticker (the imports area's service enforces "no ticker ⇒ implied or manual"; `PATCH /securities/:id/pricing` returns `400 ticker_required`).

### 2.3 `holding_snapshot` (imports area; what this area reads and writes)

Columns relied upon: `account_id`, `security_id`, `date`, `quantity numeric(20,8) NULL` (null = dollar-only position), `price numeric(20,8) NULL`, `value_cents bigint NOT NULL`, `source ∈ simplefin|csv|manual` with precedence `manual 3 > csv 2 > simplefin 1`, unique `(account_id, security_id, date)`, indexes `(account_id, date)`, `(security_id, date)`. A reconciliation commit writes the statement through `replaceHoldingSnapshot` with `source = 'manual'` (the owner typed it) and `setBalance: true`; `account_reconciliation.holding_snapshot_date` records that the set came from a reconciliation.

### 2.4 `account` (one column)

```sql
ALTER TABLE "account" ADD COLUMN "cash_inference" text NOT NULL DEFAULT 'off';
ALTER TABLE "account" ADD CONSTRAINT "account_cash_inference_check" CHECK ("cash_inference" IN ('auto','off'));
```
`account.investment_history ∈ balance | positions | full` is the lots area's column and this area's lots switch (D11).

### 2.5 `account_reconciliation` (new; the gate's evidence)

```sql
CREATE TABLE "account_reconciliation" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"            uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "statement_date"        date NOT NULL,
  "statement_total_cents" bigint NOT NULL,
  "app_value_cents"       bigint,                      -- null = the app could not value the account that day
  "app_basis"             text NOT NULL CHECK ("app_basis" IN ('snapshot','lots','positions','balance','none')),
  "app_as_of"             date,
  "cash_inference"        text NOT NULL,               -- the account setting in force at preview time
  "diff_cents"            bigint,                      -- app − statement, pre-commit
  "balance_cents"         bigint,                      -- latest balance_snapshot on/before the date, pre-commit
  "balance_diff_cents"    bigint,                      -- balance − statement
  "tolerance_cents"       bigint NOT NULL DEFAULT 100,
  "reconciled"            boolean NOT NULL,            -- |diff| < tolerance
  "rows"                  jsonb NOT NULL DEFAULT '[]', -- ReconcileRowView[] (cents and quantities as strings)
  "accepted"              boolean NOT NULL,
  "holding_snapshot_date" date,                        -- set when accepted
  "note"                  text,
  "user_id"               uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "account_reconciliation_account_idx" ON "account_reconciliation" ("account_id", "statement_date", "created_at");
```
Several rows per `(account, date)` are allowed (a failed attempt and the later accepted one are both evidence); `alreadyReconciled` means an accepted row exists for that date.

### 2.6 Enumerations (`packages/shared/src/enums.ts`; text columns, no DDL)

- `JobType` += `prices.fetch`; `import_log.kind` += `prices.fetch`; `AuditEntity` += `reconciliation`.
- New: `PriceProviderId = z.enum(["tiingo"])`, `PriceFetchStatus = z.enum(["ok","not_found","error","rate_limited"])`, `CashInference = z.enum(["auto","off"])`, `ValuationBasis = z.enum(["snapshot","lots","positions","balance","none"])`, `InvestmentLevel = z.enum(["balance_only","positions","full_history","none"])`, `PriceStatus = z.enum(["statement","current","stale","implied","manual","fixed","carried","missing"])`, `ValueSource = z.enum(["statement","priced","carried","unpriced"])`, `ValuePeriod = z.enum(["1w","1m","3m","6m","1y","ytd","all"])`, `ReconcileRowStatus = z.enum(["match","quantity","price","value","cash","missing_in_app","missing_in_statement","unknown_ticker"])`.
- Reused from the imports area: `PriceSource = provider | implied | manual` (also `security.price_mode`).

### 2.7 Migration `0002_phase3_investments` (this area's share)

1. `price` is created by the imports area's DDL with the four extra columns and the `price_provider_shape` CHECK from §2.1 folded in (one `CREATE TABLE`).
2. `ALTER TABLE security ADD COLUMN` × 7 (§2.2), after `security` exists.
3. `ALTER TABLE account ADD COLUMN cash_inference` + CHECK (§2.4).
4. `CREATE TABLE account_reconciliation` (§2.5), after `account` and `user`.
5. No data backfill: `price` starts empty; the first nightly run (or `POST /api/prices/refresh`) fills it from each security's first needed date. Existing investment accounts keep `cash_inference = 'off'`.

## 3. Algorithms

Files: `packages/shared/src/marketCalendar.ts` (calendar), `packages/shared/src/prices.ts` (expected date, status, Tiingo CSV parsing, symbol mapping, suspect rule), `packages/shared/src/valuation.ts` (the engine, pure), `packages/db/src/services/prices.ts`, `packages/db/src/services/valuation.ts`, `packages/db/src/services/reconcile.ts`, `apps/worker/src/prices/{provider.ts,tiingo.ts}`, `apps/worker/src/jobs/pricesFetch.ts`. Shared code has no `Date.now()`, no DB.

### 3.1 Fixed-point arithmetic (shared module; stated here so this document stands alone)

```ts
export type Fixed8 = bigint;                       // value × 1e8
export const FIXED8_SCALE = 100_000_000n;
export const Fixed8String = z.string().regex(/^-?\d{1,12}(\.\d{1,8})?$/, "decimal with up to 8 places");
export const NonNegFixed8String = z.string().regex(/^\d{1,12}(\.\d{1,8})?$/);
export function parseFixed8(s: string): Fixed8;     // "117.57714286" → 11_757_714_286n; throws on >8 decimals, >12 integer digits, exponents, blanks
export function formatFixed8(n: Fixed8): string;    // canonical, no trailing zeros: "10.5", "1000", "-0.00000001" (Postgres accepts it; DB reads back "10.50000000", which parseFixed8 accepts)
export function roundDiv(n: bigint, d: bigint): bigint;   // d > 0n asserted; q = n / d, r = n % d; if 2|r| ≥ d then q ± 1 away from zero
export function mulToCents(qty: Fixed8, price: Fixed8): bigint;   // roundDiv(qty * price, 10n ** 14n)
export function impliedPrice(cents: bigint, qty: Fixed8): Fixed8;  // qty ≠ 0 asserted; roundDiv(|cents| * 10n ** 14n, |qty|)
export function centsToFixed8(cents: bigint): Fixed8;             // cents * 10n ** 6n (cash quantity in dollars), exact
```
`mulToCents`: `qty × price` is an exact integer in units of 10⁻¹⁶ dollars; dividing by 10¹⁴ gives cents. Worked (all re-run): 123.4567 sh × 45.67 → product 56,382,674,890,000,000,000 ÷ 10¹⁴ = 563,826 remainder 74,890,000,000,000 (≥ half) → **563,827 cents**; 10.5 × 117.57714286 → **123,456**; 0.5 × 0.01 = 0.005 → **1**; −0.5 × 0.01 → **−1**; 2.5 × 0.002 → 1; 0.33333333 × 3 = 0.99999999 → **100**; 1.00000001 × 0.5 → 50; 0.00000001 × 0.00000001 → 0; 0.5 × 315.25 = 157.625 → **15,763**; 999,999.99999999 × 999,999.99999999 → 99,999,999,999,998 (fits).
`impliedPrice`: $1,234.56 ÷ 10.5 sh → 11,757,714,285.71… → **117.57714286** (round trip 123,456); 12,345.67 ÷ 1,234.567 → **10.00000000**; 12,648.00 ÷ 1,240 → **10.20000000**; 9,876.54 ÷ 321.123 → **30.75625228** (round trip 987,654); $45,678.90 ÷ 1,234.5678 → **36.99991203** (round trip 4,567,890); $1.00 ÷ 3 → 0.33333333 (round trip 100). The round trip is exact to the cent whenever quantity < 1,000,000 units, and on the snapshot's own date the statement value is used directly anyway (chain step a).

### 3.2 Market calendar (`marketCalendar.ts`)

```ts
export function isTradingDay(date: IsoDate): boolean;
export function lastTradingDayOnOrBefore(date: IsoDate): IsoDate;
export function previousTradingDay(date: IsoDate): IsoDate;        // strictly before
export function nextTradingDay(date: IsoDate): IsoDate;
export function tradingDaysBetween(from: IsoDate, to: IsoDate): number; // count in (from, to]
export function nyseHolidays(year: number): IsoDate[];
export const SPECIAL_CLOSURES: IsoDate[] = ["2025-01-09"];           // national day of mourning; extend by code
```
Rules: Saturday and Sunday closed. Holidays: New Year's Day (Jan 1), MLK (3rd Monday of January), Presidents (3rd Monday of February), Good Friday (Easter − 2, Easter by the anonymous Gregorian algorithm: 2025-04-20, 2026-04-05, 2027-03-28, 2028-04-16), Memorial (last Monday of May), Juneteenth (Jun 19), Independence (Jul 4), Labor (1st Monday of September), Thanksgiving (4th Thursday of November), Christmas (Dec 25). A fixed-date holiday on Saturday is observed on Friday **except Jan 1** (NYSE rule: 2021-12-31 was open), on Sunday on Monday. Early-close days are trading days. 2026: 01-01, 01-19, 02-16, 04-03, 05-25, 06-19, 07-03 (Jul 4 is Saturday), 09-07, 11-26, 12-25. 2027: 01-01, 01-18, 02-15, 03-26, 05-31, 06-18, 07-05, 09-06, 11-25, 12-24.

### 3.3 Expected price date (`prices.ts`)

```ts
export const EOD_AVAILABLE_AFTER = { hour: 18, minute: 30 };            // America/New_York
export function expectedPriceDate(now: Date): IsoDate {
  const et = localClockInTimeZone(now, "America/New_York");             // new helper in months.ts: { date, hour, minute }
  const d = lastTradingDayOnOrBefore(et.date);
  if (d !== et.date) return d;                                          // weekend/holiday: the last session's close is available
  const afterClose = et.hour > 18 || (et.hour === 18 && et.minute >= 30);
  return afterClose ? d : previousTradingDay(d);
}
export function expectedCloseFor(D: IsoDate, expectedThrough: IsoDate): IsoDate {
  return D > expectedThrough ? expectedThrough : lastTradingDayOnOrBefore(D);
}
```
Examples: Wed 2026-10-14 15:00 MDT (17:00 ET) → **2026-10-13**; 17:00 MDT (19:00 ET) → **2026-10-14**; 18:30 ET exactly → 10-14, 18:29 → 10-13; Sat 10-17 → **10-16**; Mon 10-19 10:00 ET → **10-16**; Sun 2026-04-05 (Easter) → **04-02** (Good Friday closed); Fri 2027-01-01 (holiday) → **2026-12-31**.

### 3.4 Price lookup and status (`valuation.ts`)

`priceOn(security, D)` → the latest row with `date ≤ D` (any source) or null. For a position on `D` with `expectedThrough = expectedPriceDate(now)`:

| security | row | `priceStatus` | `tradingDaysBehind` |
| --- | --- | --- | --- |
| `type = 'cash'` | none needed; close 1.00000000 | `fixed` | 0 |
| `price_mode = 'provider'` | `row.date < expectedCloseFor(D, expectedThrough)` | `stale` | `tradingDaysBetween(row.date, expectedCloseFor(D, expectedThrough))` |
| `price_mode = 'provider'` | otherwise | `current` | 0 |
| `price_mode = 'implied'` | any row | `implied` (shown "as of row.date") | 0 |
| `price_mode = 'manual'` | any row | `manual` | 0 |
| any | no row, snapshot value present | `carried` (valueSource `carried`) | 0 |
| any | no row, no value | `missing` (valueSource `unpriced`) | 0 |
| snapshot date = D | the line's own value | `statement` | 0 |

Example: VFIAX (`provider`) rows 10-09 and 10-13 only, `expectedThrough` 10-20. `priceOn(10-11)` → 10-09 row, expected close 10-09 → **current** (weekend). `priceOn(10-12)` → 10-09 row, expected 10-12 → **stale, 1 trading day behind**. 10-13 → current. 10-16 → 10-13 row, expected 10-16 → stale, **3** behind (10-14, 10-15, 10-16). Account status: `stale` if any line is stale (`stalest` = the line with the largest `tradingDaysBehind`), else `implied` if any line is implied or carried and none stale, else `current`; balance basis → `n/a`.

### 3.5 Implied prices: write and rebuild (`services/prices.ts`)

The imports area's `writeImpliedPrices(tx, date, positions)` writes one `implied` row per valued, non-cash line with quantity ≠ 0 at each positions commit (`close = holding_snapshot.price`, i.e. the reported price or `impliedPrice(value, quantity)`). This area adds the idempotent inverse, `rebuildImpliedPrices(db, { securityIds? })`: for every `holding_snapshot` row with a non-null, non-zero quantity, a non-null `price` and a non-cash security, upsert `(security, date, price, 'implied')` under the precedence rule. When several accounts hold the same security on one date with different prices, the row with the largest `value_cents` wins, ties by `account_id` ascending (the deterministic rule `writeImpliedPrices` must use too, §9). Called after a reconciliation commit (for the committed securities) and by `POST /api/prices/rebuild-implied` (owner; a repair tool). Running it twice leaves one row per `(security, date)`.

Example (401(k) collective trust, no ticker, `implied`): 09-30 import 1,234.567 units, $12,345.67 → 10.00000000; 10-13 import 1,240.000 units, $12,648.00 → 10.20000000. Valuation 10-01..10-12 carries 10.00 with status `implied`, priceDate 2026-09-30; from 10-13 it carries 10.20.

### 3.6 Upsert precedence and the suspect flag (`upsertPrices(tx, rows)`)

```sql
INSERT INTO price (security_id, date, close, adj_close, source, provider, suspect, fetched_at, updated_at) VALUES (...)
ON CONFLICT (security_id, date) DO UPDATE SET
  close = EXCLUDED.close, adj_close = COALESCE(EXCLUDED.adj_close, price.adj_close), source = EXCLUDED.source,
  provider = EXCLUDED.provider, suspect = EXCLUDED.suspect, fetched_at = EXCLUDED.fetched_at, updated_at = now()
WHERE (CASE EXCLUDED.source WHEN 'manual' THEN 3 WHEN 'provider' THEN 2 ELSE 1 END)
   >= (CASE price.source   WHEN 'manual' THEN 3 WHEN 'provider' THEN 2 ELSE 1 END)
  AND (price.close IS DISTINCT FROM EXCLUDED.close OR price.source <> EXCLUDED.source OR price.adj_close IS DISTINCT FROM EXCLUDED.adj_close OR price.suspect <> EXCLUDED.suspect);
```
This is the imports area's `upsertPrice` rule applied in batches of 500 (one `RETURNING (xmax = 0) AS inserted` tells inserted from updated; rows filtered out by the WHERE are `kept`). Returns `{ inserted, updated, kept }`; a re-fetch that changes nothing touches nothing. `suspect` is computed by the caller for provider rows: `prev` = the batch row immediately before by date, or for the first batch row the latest stored close before it; `suspect = prev exists && dayDiff(prev.date, row.date) ≤ 7 && (splitFactor is null || splitFactor == 1) && |close − prev.close| × 2 > prev.close`. Examples: 100 → 40 suspect; 100 → 60 not (exactly 40 % is not > 50 %); 100 → 50 not; 100 → 151 suspect; 100 → 40 with `splitFactor 0.4` not.

### 3.7 Account valuation on a date (`valuation.ts`, pure)

```ts
export interface ValuationSecurity { id: string; ticker: string | null; name: string; type: SecurityType; priceMode: PriceSource }
export interface ValuationPrice { securityId: string; date: IsoDate; close: Fixed8; source: PriceSource }
export interface ValuationSnapshotLine { accountId: string; securityId: string; date: IsoDate; quantity: Fixed8 | null; price: Fixed8 | null; valueCents: bigint }
export interface ValuationBalance { accountId: string; date: IsoDate; balanceCents: bigint }
export interface ValuationFlow { accountId: string; date: IsoDate; amountCents: bigint }          // signed external cash flows (lots area's loadExternalFlows)
export interface ValuationAccount { id: string; name: string; type: AccountType; taxTreatment: TaxTreatment; investmentHistory: InvestmentHistoryLevel; cashInference: CashInference }
export interface FullValuation { valueCents: bigint; cashCents: bigint; cashAnchor: IsoDate | null; lines: Array<{ securityId: string; quantity: Fixed8; priceDate: IsoDate | null; valueCents: bigint }>; warnings: string[] }
export interface ValuationInput {
  expectedThrough: IsoDate; accounts: ValuationAccount[]; securities: ValuationSecurity[]; prices: ValuationPrice[];
  snapshots: ValuationSnapshotLine[]; balances: ValuationBalance[]; flows: ValuationFlow[];
  tradeCheckpoints: Array<{ accountId: string; date: IsoDate }>;                    // one per date a full account's quantities changed (lots area)
  valueFull: (accountId: string, date: IsoDate) => FullValuation | null;             // the lots area's valueFullAccount, injected
}
export type LineKind = "position" | "cash" | "cash_plug" | "carried_flows";
export interface LineValuation { securityId: string | null; kind: LineKind; quantity: Fixed8 | null; price: Fixed8 | null; priceDate: IsoDate | null; priceSource: PriceSource | "fixed" | null; priceStatus: PriceStatus; tradingDaysBehind: number; valueCents: bigint | null; valueSource: ValueSource }
export interface AccountValuation { accountId: string; date: IsoDate; level: InvestmentLevel; basis: ValuationBasis; asOf: IsoDate | null; valueCents: bigint | null; priceStatus: "current" | "stale" | "implied" | "n/a"; stalest: { securityId: string; priceDate: IsoDate; tradingDaysBehind: number } | null; missing: string[]; balanceDiffCents: bigint | null; cashAnchor: IsoDate | null; lines: LineValuation[]; warnings: string[] }
export function valueAccountOn(input: ValuationInput, accountId: string, date: IsoDate): AccountValuation;
```
Steps for `valueAccountOn(A, D)`:
1. `S` = the snapshot set with the greatest date ≤ `D`; `T` = the latest trade checkpoint ≤ `D` (full accounts only); `B` = the latest balance ≤ `D`.
2. **Snapshot date** (`S.date === D`): basis `snapshot`, asOf `D`. Each line: `valueCents` as given, `valueSource statement`, `priceStatus statement`, price = the line's `price`. If `cashInference = 'auto'`, no line is cash (`security.type = 'cash'`) and a balance exists on `D`: add `cash_plug = B.balanceCents − Σ lines` (omitted when 0).
3. **Lots** (`investmentHistory = 'full'` and `T` and (`!S` or `T.date > S.date`)): basis `lots`, asOf `T.date`, `valueFull(A, D)` supplies the value, cash and lines; each line gets `priceStatus` per §3.4 from its `priceDate`. Null from `valueFull` (no lots yet) → step 4.
4. **Positions carried** (`S`): basis `positions`, asOf `S.date`. Each line: cash security → `quantity × 1` (`fixed`); `quantity` null (dollar-only) → `carried` at the snapshot value; else `p = priceOn(sec, D)`: present → `priced`, `mulToCents(quantity, p.close)`, status per §3.4; absent → `carried` at the snapshot value (`missing` lists it only when there is no value either → `unpriced`, value null). With `cashInference = 'auto'`: `cash_plug` as in step 2 computed on `S.date` and carried unchanged; `carried_flows` = Σ `flows` with `S.date < flow.date ≤ D` (omitted when 0). `valueCents = Σ lines`, or `null` when any line is `unpriced`.
5. **Balance** (`B`): basis `balance`, asOf `B.date`, `valueCents = B.balanceCents`, lines `[]`, priceStatus `n/a`.
6. Else basis `none`, value null.
`level` = `full_history` when `investmentHistory = 'full'`, `positions` when any snapshot exists, `balance_only` when only balances, else `none`. `balanceDiffCents = B && B.date === D && basis ∈ {snapshot, positions, lots} ? valueCents − B.balanceCents : null` (diagnostic: "differs from the bank balance by $X"). Lines are emitted in security id order; output is deterministic for any input order.

**Worked example, scenario S1** (used throughout §7). Account A (brokerage, `positions`, `cash_inference = auto`): snapshot 09-30 (csv): VTI 100 sh @ 300.00 = 30,000.00; VFIAX 50.123 sh @ 500.00 = 25,061.50; Cash 1,234.56; `balance_snapshot` 09-30 = 56,296.06 (plug 0). Transfer in +1,000.00 on 10-05 (`is_transfer`). Implied rows from the import: VTI 09-30 300.00, VFIAX 09-30 500.00. Provider closes: VTI 10-09 301.10, 10-12 303.00, 10-13 305.25; VFIAX 10-09 498.75, 10-12 502.00, 10-13 505.10. `expectedThrough = 10-20`.
- V(09-30) = basis `snapshot` = **56,296.06**.
- V(10-09): basis `positions`, asOf 09-30: VTI 100 × 301.10 = 30,110.00; VFIAX 50.123 × 498.75 = 24,998.84625 → 24,998.85; Cash 1,234.56; carried flows 1,000.00 → **57,343.41**, current. V(10-10) = V(10-11) = 57,343.41 (weekend carry, current).
- V(10-12) = 30,300.00 + 25,161.75 (50.123 × 502.00 = 25,161.746) + 1,234.56 + 1,000.00 = **57,696.31**.
- V(10-13) = 30,525.00 + 25,317.13 (25,317.1273) + 1,234.56 + 1,000.00 = **58,076.69**.
- With `cash_inference = off`: V(10-13) = **57,076.69** (no carried-flows line); V(10-12) = 56,696.31; V(10-09) = 56,343.41.
- Plug variant: the CSV has no cash line and `balance_snapshot` 09-30 = 56,800.00 → `cash_plug = 56,800.00 − 55,061.50 = 1,738.50` carried as "Cash (from balance)"; V(09-30) = **56,800.00**; V(10-13) = 30,525.00 + 25,317.13 + 1,738.50 + 1,000.00 = **58,580.63**. With `off`, or with no balance on 09-30: V(09-30) = 55,061.50 and nothing is plugged.
- Scenario S2 (VFIAX 10-12 close missing): V(10-12) = 30,300.00 + 24,998.85 + 1,234.56 + 1,000.00 = **57,533.41**, priceStatus `stale`, stalest VFIAX {10-09, 1 behind}.

### 3.8 Portfolio value series (`valueSeries`)

```ts
export interface SeriesPoint { date: IsoDate; valueCents: bigint | null; partial: boolean; missing: string[]; priceStatus: "current" | "stale" | "implied" | "n/a" }
export function valueSeries(input: ValuationInput, accountIds: string[], from: IsoDate, to: IsoDate, step: "day" | "week" | "month" = "day")
  : { dates: IsoDate[]; accounts: Array<{ accountId: string; level: InvestmentLevel; firstDataDate: IsoDate | null; values: Array<bigint | null> }>; portfolio: SeriesPoint[] }
```
`dates` = every calendar day `from..to` (`week`: Fridays plus `to`; `month`: the last day of each month plus `to`); `dayDiff(from, to) ≤ 3,660` else the service throws `PlanError(400, 'validation')`. Each account is swept once with moving pointers into its sorted snapshots, checkpoints, balances, flows and prices (O(dates × positions); 10 years × 30 positions ≈ 1.1 M multiplications). `portfolio.valueCents = Σ non-null account values`, `partial = missing.length > 0` (missing = account ids with null), `valueCents = null` only when no account is valued; `priceStatus` = the worst over valued accounts (`stale > implied > current`). Investment accounts = open accounts of type `brokerage, 401k, ira, roth, hsa, 529`; an `accountIds` entry outside that set → `400 bad_request`.

Worked (S1 with `auto`, plus B: 401k balance-only, balances 10-01 = 10,000.00, 10-10 = 10,200.00; and C: IRA positions, first snapshot 10-12: FXAIX 10 sh @ 200.00 = 2,000.00, provider close FXAIX 10-13 202.00):

| date | A | B | C | portfolio | partial |
| --- | --- | --- | --- | --- | --- |
| 10-09 | 57,343.41 | 10,000.00 (asOf 10-01) | null | **67,343.41** | yes (missing C) |
| 10-10 | 57,343.41 | 10,200.00 | null | **67,543.41** | yes |
| 10-11 | 57,343.41 | 10,200.00 | null | **67,543.41** | yes |
| 10-12 | 57,696.31 | 10,200.00 | 2,000.00 (snapshot) | **69,896.31** | no |
| 10-13 | 58,076.69 | 10,200.00 | 2,020.00 (positions) | **70,296.69** | no |

`firstDataDate`: A 09-30, B 10-01, C 10-12. S2: portfolio 10-12 = **69,733.41**, priceStatus `stale`.

### 3.9 Day change and period change (`dayChange`, `periodChange`)

`dayChange(accounts, D)`: `asOf` = the latest price date ≤ `min(D, expectedThrough)` among the selected accounts' `provider`-mode positions (any source); none → `null`, reason `no_prices`. `prior = previousTradingDay(asOf)`. Per account with basis `snapshot | positions | lots`: Σ over position lines of `mulToCents(qty_D, closeOn(asOf)) − mulToCents(qty_D, closeOn(prior))` with the quantities held on `D` for both terms; cash, plug and carried-flow lines contribute 0; a line with no close ≤ `prior` contributes null → the account is `null` with reason `missing_prior_price`. Balance basis → `null`, reason `balance_only`. Portfolio = Σ non-null, `partial` when any is null, `excluded` lists `{ accountId, reason }`.

Examples (S1 + B + C): D = 10-13 → asOf 10-13, prior 10-12: A = VTI (30,525.00 − 30,300.00) + VFIAX (25,317.13 − 25,161.75) = 225.00 + 155.38 = **+380.38**; B null (`balance_only`); C = 2,020.00 − 2,000.00 = **+20.00**; portfolio **+400.38, partial**. D = 10-14 at 09:00 ET (expectedThrough 10-13) → the same figures with `asOf 10-13` (the last completed session, not 0). D = 10-12 → prior 10-09: A = 190.00 + 162.90 = **+352.90**. D = 10-09 → prior 10-08 carries the 09-30 implied rows: VTI 30,110.00 − 30,000.00 = 110.00, VFIAX 24,998.85 − 25,061.50 = −62.65 → **+47.35**; the view labels the prior as `implied`. S2 on 10-12: VFIAX's close on 10-12 and on 10-09 are the same row → 0 for that line, A = **+190.00**, line flagged stale.

`periodChange(accounts, period, end)`: `start = periodStart(end, period, firstDataDate)`; `startCents` = Σ over accounts with a non-null value at `start`; accounts with null at `start` but a value by `end` → `newAccounts`, contributing 0 at start; all null → `startCents`, `changeCents` null. `changeCents = V(end) − startCents`. `netFlowsCents` = Σ external flows dated in `(start, end]` over accounts valued at start (lots area's `loadExternalFlows`) + Σ over `newAccounts` of their first value (`opening_value`, the lots area's D18). `marketChangeCents = changeCents − netFlowsCents`, or `null` with `reason: 'flows_not_in_value'` when a `positions`-basis account with `cash_inference = off` has non-zero external flows in the window (its carried value cannot contain them).

Examples (end 10-13): `1w` → start 10-06: A(10-06) = 30,000.00 + 25,061.50 + 1,234.56 + carried 1,000.00 = 57,296.06; B 10,000.00; C null → newAccounts [C]; startCents 67,296.06; change **+3,000.63**; netFlows = 0 (A's 10-05 flow is before the start) + C opening 2,000.00 = 2,000.00; market **+1,000.63** (= A 780.63 + B 200.00 + C 20.00). Account A alone over 09-30 → 10-13: change **+1,780.63**, flows 1,000.00, market **+780.63** (= VTI +525.00 + VFIAX +255.63); with `cash_inference = off`: change 780.63, flows 1,000.00, market `null` (`flows_not_in_value`). `ytd` (start 2025-12-31): no account has data → nulls, newAccounts []. `1m` start = 2026-09-13; `1y` = 2025-10-13.

### 3.10 Reconciliation (`services/reconcile.ts`)

**Preview** (`previewReconciliation(db, body, { today, now })`, no writes):
1. The account must be an open investment account (`400 validation`); `date ≤ today` (`400 future_date`).
2. Resolve each statement row to a security: `securityId` if given; else `ticker` case-insensitively via the imports area's `resolveSecurity(createIfMissing: false)` (alias → ticker); a cash key (`Cash`, `CASH`, `USD`, imports area's `isCashKey`) or `isCash: true` → the currency's cash security; unresolved → row status `unknown_ticker` (not an error: the UI offers "create security"). The same security twice → `400 duplicate_security`.
3. Statement value per row: `valueCents` if given, else `mulToCents(quantity, price)`, else `400 validation` ("give a value or a price"). `statementTotalCents = body.statementTotalCents ?? Σ rows`.
4. App side: `app = valueAccountOn(input, accountId, date)` with the full chain (the app's independent opinion before anything is written). When `cash_inference = off`, the preview also computes the `auto` valuation; `cashInferenceHint = { flowsSinceSnapshotCents, plugCents, wouldReconcile }` when it differs.
5. Rows: the union of app lines and statement rows by security. Cash-kind app lines (`cash`, `cash_plug`, `carried_flows`) are summed into one app cash row and compared with the statement's cash row (status `cash` when the values differ, `match` otherwise). Per other row: `quantityDiff = app.quantity − stmt.quantity` (null when either is null), `priceDiff`, `valueDiffCents = app.valueCents − stmt.valueCents`; status = `missing_in_statement` | `missing_in_app` | `unknown_ticker` | `quantity` (quantities differ) | `price` (quantities equal, values differ, statement price given and ≠ app price) | `value` (quantities equal, values differ, otherwise: statement rounding or no statement price) | `match`.
6. Totals: `differenceCents = app.valueCents − statementTotalCents` (null when the app has no value); `unexplainedCents = differenceCents − Σ row diffs`; `matchesToTheDollar = differenceCents !== null && |differenceCents| < toleranceCents (100)`. `balance = { balanceCents, balanceDate, differenceCents: balance − statementTotal }` from the latest `balance_snapshot ≤ date`. `alreadyReconciled` = an accepted `account_reconciliation` row exists for the date.

**Commit** (`commitReconciliation(db, body, ctx)`), one transaction, owner only:
1. Run the preview; with `accept = true`, any `unknown_ticker` row → `400 unknown_ticker`.
2. Insert `account_reconciliation` from the preview (`accepted = body.accept`, `cash_inference` = the setting used, `user_id`, `note`).
3. If `accept`: `replaceHoldingSnapshot(tx, { accountId, date, source: 'manual', positions: rows → { securityId, quantity, price, valueCents }, setBalance: true, today })` (replaces the whole set for that date; cash rows map to the cash security with quantity = dollars); then `balance_snapshot(account, date, statementTotal, 'manual')` upserted **replacing** an existing row for that date (the statement is the audited truth; the pre-commit difference against the SimpleFIN balance is already in `balance_diff_cents`); `rebuildImpliedPrices(tx, { securityIds: the rows' non-cash securities })`; `holding_snapshot_date = date`.
4. Audit: entity `reconciliation`, entityId `${accountId}:${date}`, action `create` (`update` when an accepted row existed), before = the previous snapshot rows on that date, after = the new rows plus `{ statementTotalCents, differenceCents, accepted }`.
5. `requestPriceRefresh(tx, { reason: 'reconcile', securityIds: newly referenced provider securities })` when any.
6. Return the post-commit valuation on `date` (equal to the statement total by construction when accepted) and the pre-commit figures.

**Worked example (S1, account A, `auto`, statement 10-13):** rows VTI 100 @ 305.25 = 30,525.00; VFIAX 50.123 @ 505.10 = 25,317.13; Cash 2,234.56; total 58,076.69. App 58,076.69 (cash-kind lines 1,234.56 + 1,000.00) → difference **0**, matchesToTheDollar, rows `match, match, match`. With `cash_inference = off` the app shows 57,076.69: the cash row has status `cash`, valueDiff −1,000.00, difference −1,000.00, and `cashInferenceHint = { flowsSinceSnapshotCents: 100000, plugCents: 0, wouldReconcile: true }`. Variant P (statement VFIAX 505.12 → 25,318.13, total 58,077.69): difference **−1.00**, VFIAX status `price` (app 505.10 provider vs 505.12), row diff −1.00, unexplained 0, `|−100| < 100` is false → **not to the dollar** (the boundary case). Variant Q (VTI 101 sh → 30,830.25): VTI `quantity`, row diff −305.25, difference −305.25. Total-only (no rows, total 58,077.00): difference −0.31, matches, one row `match` of kind total. Commit of P with `accept`: snapshot 10-13 (`manual`) holds the statement values; `price` VTI 10-13 stays provider 305.25 and VFIAX stays provider 505.10 (the implied 505.12 ranks lower); `balance_snapshot` 10-13 = 58,077.69 (`manual`); afterwards V(10-13) = basis `snapshot` = **58,077.69**, V(10-14) carries 100 VTI, 50.123 VFIAX and Cash 2,234.56 at the 10-13 closes = 58,076.69 again (the $1.00 was the statement's price); `account_reconciliation.diff_cents = −100, reconciled = false, accepted = true`.

### 3.11 The fetch plan and the `prices.fetch` job (`services/prices.ts`, `jobs/pricesFetch.ts`)

Payload: `{ reason: 'nightly' | 'catchup' | 'manual' | 'holdings' | 'reconcile' | 'refill' | 'continue', day?: IsoDate, securityIds?: string[], from?: IsoDate, continuation?: number, rootJobId?: string, dedupeKey: string }`.

`priceFetchPlan(db, { now, expectedThrough, securityIds?, from?, overlapDays: 3, maxYears })`:
1. **Fetch set** = `provider`-mode, non-archived securities that are held (non-zero quantity in the latest snapshot set of each open investment account, or `lot.quantity > 0` in an open `full` account) or `always_price` or the household benchmark; restricted to `securityIds` when given. `implied`/`manual`/cash never appear.
2. **Eligibility**: skip `price_next_attempt_at > now`; skip `price_fetch_status = 'not_found'` unless 7 days passed since `price_fetched_at`, the security is named in `securityIds`, or `updated_at > price_fetched_at` (ticker or symbol edited).
3. **Range per security**: `latest` = max `price.date` with `source = 'provider'`. `from = payload.from ?? (price_backfilled_from === null ? addDays(firstNeededDate, −7) : addDays(latest ?? price_backfilled_from, −overlapDays))`, where `firstNeededDate` = min over the household of `holding_snapshot.date` and `investment_txn.date` for the security, else (a benchmark) the household's earliest such date, else `addDays(today, −365)`; `from = max(from, addMonthsClamped(today, −12 × maxYears))`. `to = expectedThrough`. Drop when `from > to` (`skipped`). A `payload.from` earlier than `price_backfilled_from` extends the backfill.
4. **Order**: `price_fetched_at` nulls first, then ascending (never-fetched and longest-waiting first, so a continuation resumes where the run stopped); ties by ticker.
5. **Batching**: the first `PRICE_MAX_REQUESTS_PER_RUN` entries are this run's work, the rest `deferred`.

Worked: latest provider close 2026-10-12 → from 10-09; a new security first seen in a 2026-08-03 snapshot → from 07-27; a benchmark with no evidence and the household's earliest snapshot 08-03 → 07-27; the 20-year floor on 2026-10-13 → 2006-10-13; latest 10-13 with expectedThrough 10-13 → from 10-10 ≤ to, still requested (overlap heals corrections); `payload.from = 2015-01-01` → from 2015-01-01.

`runPricesFetchJob(ctx, job)`:
1. `now = ctx.now()`; `expectedThrough = expectedPriceDate(now)`; `setting = getHouseholdSetting`; `today = householdToday(setting, now)`; insert `import_log { kind: 'prices.fetch', status: 'running', connection_id: null }`.
2. `provider = createPriceProvider(ctx.config)`; null (`PRICE_PROVIDER=none`) → finish the log `{ status: 'error', message: 'Price feed not configured' }` and return (no throw; the scheduler never queues in this state, so only a manual request lands here).
3. `plan = priceFetchPlan(...)`; `work`, `deferred` as above; `runStartedAt = now`.
4. For each entry in `work`: if `ctx.now() − runStartedAt > PRICE_RUN_MAX_MS` → move the rest to `deferred` and stop. Else `result = fetchWithRetries(entry)` (§3.12):
   - `ok`: `upsertPrices` of the rows (with `suspect` computed; rows dated after `to` dropped; earlier rows kept, extra history is free); `security.price_fetched_at = now, price_fetch_status = 'ok', price_fetch_message = null, price_fetch_failures = 0, price_next_attempt_at = null, price_backfilled_from = least(price_backfilled_from, entry.from)`; stats. Zero rows for a range that is entirely in the past (delisted) → still `ok`; zero rows for a range ending on `expectedThrough` with ≥ 1 trading day → `ok` too (a fund whose NAV has not posted; the catch-up retries because `latest < expectedThrough`).
   - `not_found`: `price_fetch_status = 'not_found'`, message `"tiingo: symbol <sym> not found"`, `price_fetched_at = now`; continue.
   - `rate_limited` (still 429 after the retries): stop the loop; the remainder joins `deferred`; stats `rateLimited = 1`.
   - `auth`: finish the log `{ status: 'error', message: 'tiingo: API key rejected (401)' }` and `throw new PriceFeedError('auth', …)` (permanent, no retry, no continuation). Rows already written stay written.
   - `http | network | invalid_response`: `price_fetch_status = 'error'`, message (sanitized ≤ 300 chars), `price_fetch_failures++`, `price_next_attempt_at = now + min(6 h × 2^(failures−1), 48 h)`; continue.
   - Sleep `PRICE_REQUEST_SPACING_MS` between requests (`ctx.sleep`, a no-op in tests).
5. If every attempted request failed with `network` (and ≥ 1 was attempted): finish the log `error` and throw a retryable `PriceFeedError('network')` (the queue's backoff applies; **no continuation**).
6. Finish the log `{ status: 'ok', stats: { securities, requests, rowsInserted, rowsUpdated, rowsKept, notFound, errors, rateLimited, deferred, suspect }, message: "tiingo: <requests> requests, <rows> rows; <deferred> deferred" }`.
7. If `deferred.length > 0` and `(payload.continuation ?? 0) < 5`: `enqueueJob(db, 'prices.fetch', { reason: 'continue', securityIds: deferred ids, from: payload.from, continuation: n + 1, rootJobId, dedupeKey: 'prices:continue:<rootJobId>' }, { dedupe: true, runAt: now + 61 min, maxAttempts: 5 })`. More than 5 continuations (270+ symbols) → a warning in the message; the remainder waits for the next night.

Budget examples (45/run): 60 targets → run 1 makes 45 requests, defers 15, queues one continuation at `now + 61 min`; the continuation fetches 15 and queues nothing. A 429 that survives three attempts on request 10 → 9 securities written, 51 deferred, `rateLimited 1`. Idempotency: a second run minutes later re-requests only the 3-day overlap and `upsertPrices` reports `kept` for every unchanged close; `rowsInserted = rowsUpdated = 0`.

### 3.12 Tiingo adapter, parsing and retries (`apps/worker/src/prices/`, `packages/shared/src/prices.ts`)

```ts
export type ProviderFailureKind = "not_found" | "rate_limited" | "auth" | "http" | "network" | "invalid_response";
export interface ProviderBar { date: IsoDate; close: Fixed8; adjClose: Fixed8 | null; splitFactor: Fixed8 | null }
export type ProviderResult = { ok: true; bars: ProviderBar[] } | { ok: false; kind: ProviderFailureKind; message: string; status?: number; retryAfterMs?: number; body?: string /* ≤ 64 KB, kept in import_log.raw_payload for invalid_response */ };
export interface PriceProvider { readonly id: PriceProviderId; mapSymbol(security: { ticker: string; providerSymbol: string | null }): string; fetchDaily(symbol: string, range: { from: IsoDate; to: IsoDate }): Promise<ProviderResult> }
export class PriceFeedError extends Error { constructor(public readonly kind: "not_configured" | "auth" | "network", message: string); get permanent(): boolean /* not_configured | auth */ }
export function createPriceProvider(config: WorkerConfig, fetchImpl?: typeof fetch): PriceProvider | null;   // null when PRICE_PROVIDER=none
```
- `mapSymbol` = `providerSymbol ?? ticker.trim().toUpperCase().replace(/\./g, "-")` (`BRK.B` → `BRK-B`; an override wins as typed).
- Request: `GET https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}/prices?startDate=${from}&endDate=${to}&format=csv&resampleFreq=daily`, headers `Authorization: Token <key>`, `Accept: text/csv`, `User-Agent: Meridian/0.1 (self-hosted personal finance; read-only)`; `AbortSignal.timeout(PRICE_TIMEOUT_MS)`; `redirect: "error"`; HTTPS only, certificate verification on. CSV is requested so a close such as `310.02` arrives as decimal text and never passes through a JS float.
- `parseTiingoCsv(text)` (shared, pure): `parseCsv`; the header must contain `date` and `close` (case-insensitive, any order; `adjClose`, `splitFactor` optional); `date = cell.slice(0, 10)` must satisfy `isIsoDate`; an empty `close` skips the row; a close with more than 8 decimals is rounded half away from zero to 8 (`310.123456789` → 310.12345679); a non-decimal cell (exponent, text) or a bad date → `invalid_response` for the whole symbol (nothing partial is written). Rows sorted ascending, de-duplicated by date (last wins).
- Status mapping: 200 → bars; 404, or a JSON `detail` naming an unknown ticker → `not_found`; 401/403 → `auth`; 429 → `rate_limited` with `Retry-After` seconds when present; other non-2xx → `http`; thrown fetch → `network`; unparsable body → `invalid_response`.
- `fetchWithRetries`: up to 3 attempts per symbol; after `rate_limited` sleep `min(retryAfterMs ?? 5 s, 120 s)`, after `http | network` sleep 5 s then 15 s; `not_found`, `auth` and `invalid_response` are returned at once. Every attempt counts as a request in the run's stats.

### 3.13 Scheduler (`apps/worker/src/scheduler.ts`, `schedulePriceJobs(ctx)`)

Called from the existing tick after `scheduleDailyJobs`. `config.priceProvider === 'none'` → 0. `setting = getHouseholdSetting(db)`; `local = localClockInTimeZone(now, setting.timezone)` (`{ date, hour, minute }`). Nightly: if `local.hour ≥ config.priceFetchHour` and no `prices.fetch` job with `dedupeKey = 'prices:nightly:<local.date>'` exists (any status) → `enqueueJob(db, 'prices.fetch', { reason: 'nightly', day: local.date, dedupeKey }, { dedupe: true, maxAttempts: 5 })`. Catch-up: if `config.priceCatchupHour !== null`, `local.hour ≥ priceCatchupHour`, no `'prices:catchup:<local.date>'` job exists, and `countSecuritiesBehind(db, expectedPriceDate(now)) > 0` (an eligible fetch-set security whose latest provider date < expected, or never fetched) → enqueue likewise. Example (America/Denver, hours 18/6): tick 2026-10-13T23:30Z (17:30 MDT) → nothing; 2026-10-14T00:05Z (18:05 MDT, household day 10-13) → `prices:nightly:2026-10-13`; the next tick finds the key; 2026-10-14T12:00Z (06:00 MDT 10-14) with one security behind → `prices:catchup:2026-10-14`; with none behind → nothing.

`enqueueJob` change (`services/jobs.ts`): with `dedupe: true`, when `payload.dedupeKey` is a string the existing-job check matches `type` and `payload->>'dedupeKey'`; otherwise the Phase 1 behaviour (match `connectionId`, else any queued/running job of the type) is unchanged. Keys used: `prices:nightly:<day>`, `prices:catchup:<day>`, `prices:manual`, `prices:holdings`, `prices:reconcile`, `prices:refill:<securityId>`, `prices:continue:<rootJobId>`.

## 4. Contracts (`packages/shared/src/api.ts`; cents as `CentsString`, quantities and prices as `Fixed8String`)

```ts
// ---- Prices ----
export const PriceView = z.object({ securityId: z.string().uuid(), date: IsoDateString, close: NonNegFixed8String, adjClose: NonNegFixed8String.nullable(), source: PriceSource, provider: PriceProviderId.nullable(), suspect: z.boolean(), updatedAt: z.string() });
export const PriceHistoryQuery = z.object({ from: IsoDateString.optional(), to: IsoDateString.optional(), limit: z.coerce.number().int().min(1).max(5000).default(400), today: IsoDateString.optional() });
export const PriceHistoryResponse = z.object({ securityId: z.string().uuid(), priceMode: PriceSource, expectedDate: IsoDateString, latest: PriceView.nullable(), priceStatus: PriceStatus, tradingDaysBehind: z.number().int(), items: z.array(PriceView) /* descending by date */ });
export const PriceParams = z.object({ securityId: z.string().uuid(), date: IsoDateString });
export const SetPriceBody = z.object({ close: NonNegFixed8String, today: IsoDateString.optional() });
export const RefreshPricesBody = z.object({ securityIds: z.array(z.string().uuid()).max(500).optional(), from: IsoDateString.optional() });
export const RefreshPricesResponse = z.object({ jobId: z.string().uuid(), created: z.boolean(), movedUp: z.boolean() });
export const SecurityPriceStatusView = z.object({
  securityId: z.string().uuid(), ticker: z.string().nullable(), name: z.string(), priceMode: PriceSource, providerSymbol: z.string().nullable(), alwaysPrice: z.boolean(), held: z.boolean(),
  latestPriceDate: IsoDateString.nullable(), latestClose: NonNegFixed8String.nullable(), latestSource: PriceSource.nullable(), priceStatus: PriceStatus, tradingDaysBehind: z.number().int(),
  fetchStatus: PriceFetchStatus.nullable(), fetchMessage: z.string().nullable(), fetchedAt: z.string().nullable(), failures: z.number().int(), nextAttemptAt: z.string().nullable(), backfilledFrom: IsoDateString.nullable(),
});
export const PricesStatusResponse = z.object({
  provider: PriceProviderId.nullable(), configured: z.boolean(), fetchHourLocal: z.number().int(), catchupHourLocal: z.number().int().nullable(), timezone: z.string(), expectedDate: IsoDateString,
  lastRun: z.object({ importLogId: z.string().uuid(), startedAt: z.string(), finishedAt: z.string().nullable(), status: z.enum(["running","ok","error"]), message: z.string().nullable(), stats: z.record(z.number()).nullable() }).nullable(),
  activeJob: z.object({ id: z.string().uuid(), status: JobStatus, reason: z.string(), runAt: z.string() }).nullable(),
  securities: z.array(SecurityPriceStatusView),
  counts: z.object({ current: z.number().int(), stale: z.number().int(), notFound: z.number().int(), error: z.number().int(), implied: z.number().int(), manual: z.number().int() }),
});
export const UpdateSecurityPricingBody = z.object({ priceMode: PriceSource.optional(), providerSymbol: z.string().min(1).max(32).nullable().optional(), alwaysPrice: z.boolean().optional() });

// ---- Valuation ----
export const LineValuationView = z.object({ securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), name: z.string(), kind: z.enum(["position","cash","cash_plug","carried_flows"]), quantity: Fixed8String.nullable(), price: NonNegFixed8String.nullable(), priceDate: IsoDateString.nullable(), priceSource: z.enum(["provider","implied","manual","fixed"]).nullable(), priceStatus: PriceStatus, tradingDaysBehind: z.number().int(), valueCents: CentsString.nullable(), valueSource: ValueSource });
export const DayChangeView = z.object({ cents: CentsString.nullable(), asOf: IsoDateString.nullable(), prior: IsoDateString.nullable(), reason: z.string().nullable() });
export const AccountValuationView = z.object({
  accountId: z.string().uuid(), name: z.string(), type: AccountType, taxTreatment: TaxTreatment, investmentHistory: InvestmentHistoryLevel, cashInference: CashInference,
  date: IsoDateString, level: InvestmentLevel, basis: ValuationBasis, asOf: IsoDateString.nullable(), valueCents: CentsString.nullable(),
  priceStatus: z.enum(["current","stale","implied","n/a"]), stalest: z.object({ securityId: z.string().uuid(), priceDate: IsoDateString, tradingDaysBehind: z.number().int() }).nullable(),
  missing: z.array(z.string().uuid()), balanceDiffCents: CentsString.nullable(), cashAnchor: IsoDateString.nullable(), lines: z.array(LineValuationView), dayChange: DayChangeView,
  lastReconciliation: z.object({ statementDate: IsoDateString, diffCents: CentsString.nullable(), reconciled: z.boolean(), accepted: z.boolean(), createdAt: z.string() }).nullable(), warnings: z.array(z.string()),
});
export const ValuationSummaryQuery = z.object({ date: IsoDateString.optional(), accountIds: z.string().optional() /* comma-separated uuids */, period: ValuePeriod.default("1m"), today: IsoDateString.optional() });
export const PeriodChangeView = z.object({ period: ValuePeriod, startDate: IsoDateString.nullable(), startCents: CentsString.nullable(), changeCents: CentsString.nullable(), netFlowsCents: CentsString.nullable(), marketChangeCents: CentsString.nullable(), marketChangeReason: z.string().nullable(), newAccounts: z.array(z.object({ id: z.string().uuid(), name: z.string(), openingCents: CentsString })) });
export const ValuationSummaryResponse = z.object({
  date: IsoDateString, today: IsoDateString, expectedDate: IsoDateString, totalCents: CentsString.nullable(), partial: z.boolean(), missing: z.array(z.string().uuid()), priceStatus: z.enum(["current","stale","implied","n/a"]),
  dayChange: DayChangeView.extend({ partial: z.boolean(), excluded: z.array(z.object({ accountId: z.string().uuid(), reason: z.string() })) }),
  periodChange: PeriodChangeView, accounts: z.array(AccountValuationView),
});
export const ValuationSeriesQuery = z.object({ from: IsoDateString, to: IsoDateString, accountIds: z.string().optional(), step: z.enum(["day","week","month"]).default("day"), today: IsoDateString.optional() });
export const SeriesPointView = z.object({ date: IsoDateString, valueCents: CentsString.nullable(), partial: z.boolean(), missing: z.array(z.string().uuid()), priceStatus: z.enum(["current","stale","implied","n/a"]) });
export const ValuationSeriesResponse = z.object({ from: IsoDateString, to: IsoDateString, expectedDate: IsoDateString, dates: z.array(IsoDateString), accounts: z.array(z.object({ accountId: z.string().uuid(), name: z.string(), type: AccountType, level: InvestmentLevel, firstDataDate: IsoDateString.nullable(), values: z.array(CentsString.nullable()) })), portfolio: z.array(SeriesPointView) });

// ---- Reconciliation ----
export const ReconcileRowBody = z.object({ securityId: z.string().uuid().optional(), ticker: z.string().max(32).optional(), isCash: z.boolean().default(false), quantity: Fixed8String, price: NonNegFixed8String.optional(), valueCents: CentsString.optional() })
  .refine((r) => r.securityId !== undefined || r.ticker !== undefined || r.isCash, { message: "securityId, ticker or isCash" });
export const ReconcilePreviewBody = z.object({ accountId: z.string().uuid(), date: IsoDateString, statementTotalCents: CentsString.optional(), rows: z.array(ReconcileRowBody).max(500), toleranceCents: NonNegCentsString.optional(), today: IsoDateString.optional() });
export const ReconcileRowView = z.object({
  securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), name: z.string().nullable(), isCash: z.boolean(),
  app: z.object({ quantity: Fixed8String.nullable(), price: NonNegFixed8String.nullable(), priceDate: IsoDateString.nullable(), priceSource: z.enum(["provider","implied","manual","fixed"]).nullable(), valueCents: CentsString.nullable(), valueSource: ValueSource }).nullable(),
  statement: z.object({ quantity: Fixed8String, price: NonNegFixed8String.nullable(), valueCents: CentsString }).nullable(),
  quantityDiff: Fixed8String.nullable(), priceDiff: Fixed8String.nullable(), valueDiffCents: CentsString.nullable(), status: ReconcileRowStatus,
});
export const ReconcilePreviewResponse = z.object({
  accountId: z.string().uuid(), date: IsoDateString, app: AccountValuationView, statementTotalCents: CentsString, differenceCents: CentsString.nullable(), unexplainedCents: CentsString.nullable(), toleranceCents: NonNegCentsString, matchesToTheDollar: z.boolean(),
  rows: z.array(ReconcileRowView), balance: z.object({ balanceCents: CentsString.nullable(), balanceDate: IsoDateString.nullable(), differenceCents: CentsString.nullable() }),
  cashInferenceHint: z.object({ flowsSinceSnapshotCents: CentsString, plugCents: CentsString, wouldReconcile: z.boolean() }).nullable(), alreadyReconciled: z.boolean(),
});
export const ReconcileCommitBody = ReconcilePreviewBody.extend({ accept: z.boolean().default(true), note: z.string().max(500).optional() });
export const ReconcileCommitResponse = z.object({ reconciliationId: z.string().uuid(), batchId: z.string().uuid(), accepted: z.boolean(), preCommitDifferenceCents: CentsString.nullable(), matchesToTheDollar: z.boolean(), app: AccountValuationView, rowsWritten: z.number().int(), impliedPricesWritten: z.number().int() });
export const ReconciliationListQuery = z.object({ accountId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const ReconciliationView = ReconcilePreviewResponse.omit({ app: true, rows: true, cashInferenceHint: true, alreadyReconciled: true }).extend({ id: z.string().uuid(), appValueCents: CentsString.nullable(), appBasis: ValuationBasis, appAsOf: IsoDateString.nullable(), reconciled: z.boolean(), accepted: z.boolean(), holdingSnapshotDate: IsoDateString.nullable(), note: z.string().nullable(), createdAt: z.string() });
```
`AccountView` gains `cashInference: CashInference`; `UpdateAccountBody` gains `cashInference: CashInference.optional()` (`400 validation` on a non-investment type). `DashboardView` may gain `prices: { configured, expectedDate, lastRunAt, counts: { stale, notFound, error } }` (views area, from `priceFeedHealth`).

### 4.1 Routes (behind auth; `usePlanErrors`, `resolveToday`, `auditContext` from `routes/plan.ts`; mappers in `apps/api/src/views/valuation.ts`, one pure function per contract)

| Route | File | Notes |
| --- | --- | --- |
| `GET /api/prices/status` → `PricesStatusResponse` | `routes/prices.ts` | `Cache-Control: no-store`; `configured` and `fetchHourLocal` from the API config; latest `import_log` of kind `prices.fetch`; any queued/running `prices.fetch` job; one row per non-archived security of mode `provider`, plus `implied`/`manual` ones that are held |
| `POST /api/prices/refresh` body `RefreshPricesBody` → `RefreshPricesResponse` | `routes/prices.ts` | owner. `requestPriceRefresh(db, { reason: 'manual', ... })`: a `prices.fetch` running → `{ created: false, movedUp: false }`; one queued with key `prices:manual` → `run_at = now()`, `{ movedUp: true }`; else enqueue with `dedupeKey 'prices:manual'`, `maxAttempts 5`. `503 not_configured` when `PRICE_PROVIDER=none` |
| `POST /api/prices/rebuild-implied` → `{ written }` | `routes/prices.ts` | owner; `rebuildImpliedPrices(db, {})` |
| `GET /api/prices/:securityId` query `PriceHistoryQuery` → `PriceHistoryResponse` | `routes/prices.ts` | descending, default last 400 rows |
| `PUT /api/prices/:securityId/:date` body `SetPriceBody` → `PriceView` | `routes/prices.ts` | owner; `date ≤ today` else `400 future_date`; cash security → `400 cash_security_reserved`; `setManualPrice` (imports area, audited as `security`) |
| `DELETE /api/prices/:securityId/:date` → `OkResponse` | `routes/prices.ts` | owner; non-manual row → `409 manual_only`; audited; then `requestPriceRefresh({ reason: 'refill', securityIds: [id], from: date })` with key `prices:refill:<id>` |
| `PATCH /api/securities/:id/pricing` body `UpdateSecurityPricingBody` → the imports area's `SecurityView` | `routes/prices.ts` | owner; `priceMode = 'provider'` needs a ticker (`400 ticker_required`); switching to `provider` or editing the symbol resets fetch state (`status null, failures 0, next_attempt null`) and queues a backfill (`reason 'manual'`, that id); audited as `security` |
| `GET /api/valuation/summary` query `ValuationSummaryQuery` → `ValuationSummaryResponse` | `routes/valuation.ts` | `date` defaults to `today`; `date > today` → 400; unknown/closed/non-investment `accountIds` → `400 bad_request` |
| `GET /api/valuation/series` query `ValuationSeriesQuery` → `ValuationSeriesResponse` | `routes/valuation.ts` | `from ≤ to ≤ today`, ≤ 3,660 days |
| `POST /api/reconcile/preview` → `ReconcilePreviewResponse` | `routes/reconcile.ts` | `config: { readOnly: true }` (a read with a body, viewer-callable like `cashflow/projection`); no writes |
| `POST /api/reconcile/commit` → `ReconcileCommitResponse` | `routes/reconcile.ts` | owner; one transaction, one audit batch |
| `GET /api/reconcile/history` query `ReconciliationListQuery` → `{ items: ReconciliationView[] }` | `routes/reconcile.ts` | newest first |

## 5. UI (`apps/web`)

- **Prices page** (`pages/PricesPage.tsx`, route `/prices`, nav under Investments). Header card: provider and configured state, expected price date, last run ("6:03 pm · 31 requests, 62 rows, 1 not found"), next nightly ("nightly at 6 pm household time, catch-up at 6 am"), **Refresh prices** (owner; shows "queued" / "already running" / "moved up"; disabled while `activeJob`). Table sorted by status severity then ticker: ticker, name, pricing (Provider / Implied / Manual select → `PATCH /securities/:id/pricing`), provider symbol (inline editable), latest close and date with `PriceStatusChip` (`current` / `stale N trading days` / `implied as of …` / `manual` / `not found` / `error` with message / `carried`), held and benchmark markers, actions: retry (refresh that id), set a price (two-field form date + close → `PUT`; manual rows in the history list carry a "manual" badge with a delete icon), price history drawer (`GET /prices/:id`, ECharts line via `components/charts/EChart.tsx`, suspect points marked). Not-configured state: banner "Price feed not configured: set PRICE_PROVIDER=tiingo and TIINGO_API_KEY in .env (free account, see .env.example) and restart; until then values use statement, positions-implied and manual prices". Empty state: "No securities yet. Import positions or trades." Error state: `ErrorText`.
- **`components/invest/PriceStatusChip.tsx`** (shared with the views area's Holdings/Portfolio pages): renders `priceStatus`, `priceDate`, `tradingDaysBehind` and `valueSource` consistently ("as of Oct 13 · provider", "stale 3 trading days", "implied as of Sep 30", "carried from statement").
- **Reconcile page** (`pages/ReconcilePage.tsx`, route `/investments/reconcile?accountId=`; linked from each investment account row on the Accounts page as "Reconcile to statement"). Steps: (1) account picker (open investment accounts with their level badge) and statement date (default: last day of the previous month); (2) "Prefill from app" copies the app's positions on that date; rows table with Security (ticker input with a datalist of known securities, `Cash` allowed via the cash checkbox), Quantity, Price (optional), Value, a "paste from CSV" helper (`parseCsv`, four-column guess: symbol, quantity, price, value), and a Statement total field (defaults to Σ values, editable); every edit re-POSTs `/reconcile/preview` (debounced 300 ms, TanStack key `['reconcile', body]`, `keepPreviousData`); (3) the preview table: one row per security with app quantity/price/value (and the price's source and date), statement quantity/price/value, the three diffs, a status badge (Match / Quantity / Price / Value / Cash / Missing in app / Missing in statement / Unknown ticker with a "create security" link), a totals line "App $58,076.69 · Statement $58,076.69 · Difference $0.00", the headline **Matches to the dollar** (green) or **Off by $1.00** (amber), the bank-balance line when present, the `cashInferenceHint` callout ("Transfers into this account since the Sep 30 statement total $1,000.00; turning on *Infer cash from balance* would reconcile" with a one-click toggle that PATCHes the account and re-previews), and `alreadyReconciled` as an info bar ("A statement for this date is already on file; accepting replaces it"); (4) **Accept statement** (owner; writes the snapshot) and **Record only** (owner; `accept: false`, the evidence row without changing holdings); success state "Reconciled 2026-10-13: app value now $58,076.69; pre-commit difference $0.00", invalidating `['accounts']`, `['valuation']`, `['prices']`, `['dashboard']`; past reconciliations list below from `/reconcile/history`. Empty state: no investment accounts → "Add a brokerage or retirement account first." Row-level validation inline ("give a value or a price").
- **Accounts page** (investment group): level badge and value badge from `/valuation/summary` ("$58,076.69 as of Oct 13 · positions from Sep 30 statement"), stale warning naming the stalest security, `balanceDiffCents` note ("differs from the bank balance by $12.34"), "Infer cash from balance" toggle in the account editor (`cashInference`), last reconciliation line ("Reconciled Oct 13 · to the dollar" / "off by $1.00"), and the "Reconcile to statement" link. (`investmentHistory` and `lotMethod` selects are the lots area's fields; the views area wires them.)
- **Settings page**: a "Prices" card showing the provider, the two hours and the timezone (read-only, from `/prices/status`), linking to `/prices`.
- **Portfolio / Holdings pages** (views area): consume `ValuationSummaryResponse` and `ValuationSeriesResponse` (bigints as strings; `centsToDollars` for plotting only; gaps for null points, never 0; a "partial" caption when any point is partial), render `PriceStatusChip` per line and per account, and the day/period change with the `partial`/`excluded` and `marketChangeReason` captions.

## 6. Jobs and services

| Name | Where | Trigger | Idempotency | Failure handling |
| --- | --- | --- | --- | --- |
| `prices.fetch` | `apps/worker/src/jobs/pricesFetch.ts` | nightly (`prices:nightly:<day>`), catch-up (`prices:catchup:<day>`), manual (`prices:manual`), holdings import (`prices:holdings`), reconcile (`prices:reconcile`), refill (`prices:refill:<id>`), continuation (`prices:continue:<root>`) | upserts by `(security, date)` under precedence; overlap re-fetch changes nothing; `from > to` → no request | provider errors never fail the job (per-security status and backoff); 429 → remainder deferred; auth → permanent failure; all-network → retryable throw, no continuation; DB error → `failJob` (queue backoff); 20-minute wall-clock cap |
| `schedulePriceJobs` | `apps/worker/src/scheduler.ts` | every 60 s tick | dedupe keys per household-local day | logs and retries next tick; never queues with `PRICE_PROVIDER=none` |
| `priceFetchPlan`, `upsertPrices`, `rebuildImpliedPrices`, `deleteManualPrice`, `listPrices`, `latestPrices`, `loadPriceSeries`, `pricesStatus`, `priceFeedHealth`, `countSecuritiesBehind`, `updateSecurityPricing`, `requestPriceRefresh` | `packages/db/src/services/prices.ts` | routes, job, scheduler, other areas | precedence rule; status reads are pure | `PlanError` codes of D26 |
| `loadValuationInput`, `valuationSummary`, `valuationSeries`, `investmentAccountIds` | `packages/db/src/services/valuation.ts` | valuation routes, views area, reconcile | read-only | `PlanError(400, 'bad_request' | 'validation')` |
| `valueAccountOn`, `valueSeries`, `dayChange`, `periodChange`, `priceOn`, `periodStart` | `packages/shared/src/valuation.ts` | pure | deterministic | throws only on programming errors (unsorted input, `to < from`) |
| `previewReconciliation`, `commitReconciliation`, `listReconciliations` | `packages/db/src/services/reconcile.ts` | reconcile routes | commit is one transaction; the record is always written | `validation`, `future_date`, `duplicate_security`, `unknown_ticker`, `not_found` |

### 6.1 Loader (`loadValuationInput(db, { accountIds, from, to, now })`)
Investment accounts (open; `accountIds` validated); securities referenced by their snapshots, lots and prices; `price` rows with `date ≤ to` plus, per security, the latest row before `from`; `holding_snapshot` sets with `date ≤ to` plus the latest set before `from` per account; `balance_snapshot` rows (`source <> 'computed'`) likewise; external flows in `(from − 1, to]` from the lots area's `loadExternalFlows`; trade checkpoints and `valueFull` from the lots area for `full` accounts; `expectedThrough = expectedPriceDate(now)`. Pure engine calls, no writes.

### 6.2 Runner and queue changes
`apps/worker/src/runner.ts`: the retry decision becomes `const retry = !(typeof (err as { permanent?: unknown }).permanent === "boolean" && (err as { permanent: boolean }).permanent)` so `SimplefinError` and `PriceFeedError` stop retries the same way. `services/jobs.ts`: the `dedupeKey` match of §3.13. `jobs/index.ts`: `case "prices.fetch": return runPricesFetchJob(ctx, job)`.

### 6.3 Services this area calls (seams, §9)
Imports area: `upsertPrice` rule (mirrored by `upsertPrices`), `writeImpliedPrices`, `setManualPrice`, `replaceHoldingSnapshot`, `resolveSecurity`, `isCashKey`, `cashSecurity`, `SecurityView`. Lots area: `valueFullAccount`, `tradeCheckpoints`, `loadExternalFlows`, `account.investment_history`. Phase 2: `getHouseholdSetting`, `householdToday`, `resolveToday`, `auditContext`, `writeAudit`, `PlanError`, `enqueueJob`, `localDateInTimeZone`.

### 6.4 Configuration
Worker (`apps/worker/src/env.ts`, `WorkerConfig`): `PRICE_PROVIDER` (`tiingo | none`, default `none`), `TIINGO_API_KEY` or `TIINGO_API_KEY_FILE` (read like `SECRETS_KEY`; required when the provider is `tiingo`, boot fails otherwise), `PRICE_FETCH_HOUR` (0..23 household-local, default 18), `PRICE_CATCHUP_HOUR` (0..23, default 6; `off` disables), `PRICE_MAX_REQUESTS_PER_RUN` (45), `PRICE_REQUEST_SPACING_MS` (1500), `PRICE_RUN_MAX_MS` (1,200,000), `PRICE_OVERLAP_DAYS` (3), `PRICE_HISTORY_MAX_YEARS` (20), `PRICE_TIMEOUT_MS` (30,000). API (`apps/api/src/config.ts`): `PRICE_PROVIDER`, `PRICE_FETCH_HOUR`, `PRICE_CATCHUP_HOUR` (display and the `not_configured` state only; the API never reads the key). `.env.example` documents them with the Tiingo signup URL; the key never enters the database or the backups.

## 7. Test cases

Shared engine tests are hand-calculated (Vitest); DB suites use `createTestDb()` from `@meridian/db/testing` inside `describe.skipIf(!TEST_DATABASE_URL)`; worker tests inject `fetch`, `now` and `sleep`. Scenario S1 (+ B, C) is §3.7–3.8; cents are shown as dollars.

1. **Fixed8 helpers.** `parseFixed8("117.57714286")` = 11,757,714,286n; `"10.5"` → 1,050,000,000n; `"-0.5"` → −50,000,000n; `"1e3"`, `"1.123456789"`, `"1,000"`, `""`, a 13-digit integer part → throw; `formatFixed8(1,050,000,000n)` = `"10.5"`, `formatFixed8(parseFixed8("10.50000000"))` = `"10.5"`; `Fixed8String` accepts `"310.02"`, `"0"`, `"-2.5"`, rejects `"310."`, `"1e3"`, 13 integer digits.
2. **mulToCents.** (123.4567, 45.67) → 563,827; (10.5, 117.57714286) → 123,456; (0.5, 0.01) → 1; (−0.5, 0.01) → −1; (2.5, 0.002) → 1; (0.33333333, 3) → 100; (1.00000001, 0.5) → 50; (0.00000001, 0.00000001) → 0; (0.5, 315.25) → 15,763; (50.123, 505.10) → 2,531,713; (50.123, 502.00) → 2,516,175; (50.123, 498.75) → 2,499,885; (100, 305.25) → 3,052,500; (999999.99999999, 999999.99999999) → 99,999,999,999,998.
3. **impliedPrice.** (123,456, 10.5) → 117.57714286, round trip 123,456; (1,234,567, 1234.567) → 10.00000000; (1,264,800, 1240) → 10.20000000; (987,654, 321.123) → 30.75625228 (round trip 987,654); (4,567,890, 1234.5678) → 36.99991203 (round trip 4,567,890); (4,725,000, 1250) → 37.80000000; (100, 3) → 0.33333333 (round trip 100); (1, 3) → 0.00333333; quantity 0 → throws.
4. **Calendar.** `isTradingDay`: 2026-04-03 false (Good Friday), 06-19 false, 07-03 false, 07-06 true, 10-12 true (Columbus Day open), 11-27 true, 2025-01-09 false, 2021-12-31 true, 2027-12-24 false. `lastTradingDayOnOrBefore`: 2026-04-05 → 04-02; 07-05 → 07-02; 12-27 → 12-24; 2027-01-03 → 2026-12-31; 2026-10-17 → 10-16. `previousTradingDay('2026-06-22')` = 06-18; `('2026-10-12')` = 10-09. `tradingDaysBetween('2026-10-09','2026-10-13')` = 2; `('2026-10-09','2026-10-20')` = 7; `('2026-10-13','2026-10-16')` = 3. `nyseHolidays(2026)` = exactly the ten dates of §3.2; `nyseHolidays(2027)` likewise (2027-01-01 Friday closed, 2027-12-24 for Christmas on Saturday).
5. **expectedPriceDate.** 2026-10-14T21:00Z (17:00 EDT) → 10-13; 22:29Z → 10-13; 22:30Z (18:30 EDT) → 10-14; 23:00Z → 10-14; Sat 2026-10-17T15:00Z → 10-16; Mon 2026-10-19T14:00Z → 10-16; 2026-04-05T20:00Z → 04-02; 2027-01-01T23:00Z → 2026-12-31. `expectedCloseFor('2026-10-16', '2026-10-13')` = 10-13; `('2026-10-11', '2026-10-20')` = 10-09.
6. **priceOn and status.** VFIAX (`provider`) rows 10-09 and 10-13, `expectedThrough` 10-20: D 10-11 → row 10-09, `current`, 0; 10-12 → 10-09, `stale`, 1; 10-13 → current; 10-16 → 10-13, `stale`, 3; 10-08 → no row → `carried` when a snapshot value exists, else `missing`. Implied security with one `implied` row 09-30: D 10-12 → `implied`, priceDate 09-30, 0 behind. Manual-mode fund with one manual row 1.00 on 2024-01-02: D 2026-10-13 → `manual`, close 1.00000000. Cash security → `fixed`, 1.00000000 for any D.
7. **Precedence upsert (db).** Seed (VFIAX, 10-13) implied 500.00; upsert provider 505.10 → `updated` (source provider, provider tiingo); upsert manual 505.00 → updated; upsert provider 505.10 → `kept` (manual stays); another date provider 505.11 over provider 505.10 → updated; implied 505.12 over provider → kept; a later provider row with `adj_close` null keeps the earlier non-null `adj_close`; an unchanged re-upsert → kept with `updated_at` unmoved; counts `{ inserted: 1, updated: 2, kept: 3 }` for the sequence (VFIAX new date inserted once).
8. **rebuildImpliedPrices (db).** Two accounts hold TGT2045 on 10-31 with values 47,250.00 (1,250 units) and 9,450.00 (250 units, price 37.80) → one row 37.80000000 either way; with the second account's price 37.81 the larger value wins → 37.80000000; running twice → one row per `(security, date)`, `written` counts only changed rows; a manual row on (TGT2045, 10-31) is never overwritten; cash securities get no rows.
9. **Valuation chain (engine, S1 `auto`).** V(09-30) = 5,629,606 (`snapshot`); V(10-09) = 5,734,341 (`positions`, asOf 09-30; lines VTI 3,011,000, VFIAX 2,499,885, cash 123,456 `fixed`, carried_flows 100,000); V(10-10) = V(10-11) = 5,734,341 `current`; V(10-12) = 5,769,631; V(10-13) = 5,807,669; V(09-29) → basis `none`, null. With `off`: V(10-13) = 5,707,669, no `carried_flows` line; V(10-09) = 5,634,341.
10. **Cash plug.** Snapshot 09-30 without a cash line (VTI, VFIAX), balance 09-30 = 5,680,000, `auto` → `cash_plug` 173,850; V(09-30) = 5,680,000; V(10-13) = 3,052,500 + 2,531,713 + 173,850 + 100,000 = 5,858,063. No balance on 09-30 → no plug, V(09-30) = 5,506,150. `off` → no plug. A plug of exactly 0 emits no line.
11. **Lots switch and tie-break.** Account A with a trade delta VTI +0.5 on 10-06 and `investment_history = 'positions'`: V(10-13) still 5,807,669 (the trade is ignored). With `'full'` and `valueFull` returning the lots area's value: V(10-05) → basis `positions` (snapshot 09-30 newer than no checkpoint); V(10-06..) → basis `lots`, value from `valueFull`; a later accepted statement on 10-15 → `snapshot` on 10-15 and `positions` on 10-16..until the next trade checkpoint, then `lots` again. `valueFull` returning null → falls to `positions`.
12. **Dollar-only and unpriced.** A 401(k) `extra` feed with `quantity null`, value 12,345.67 → line `carried`, value 1,234,567 on every later date, account `priceStatus implied`; a `provider` security with no price rows and no snapshot value (lots basis) → `unpriced`, account `valueCents null`, `missing [id]`, series point `partial`.
13. **Balance-only and unknown.** B: V(10-09) = 1,000,000 (`balance`, asOf 10-01); V(10-10..10-13) = 1,020,000; V(09-30) null (`none`). C: V(10-11) null; V(10-12) = 200,000 (`snapshot`); V(10-13) = 202,000 (`positions`).
14. **Series (S1 `auto` + B + C, 10-09..10-13).** Portfolio 6,734,341 (partial, missing [C]), 6,754,341 (partial), 6,754,341 (partial), 6,989,631, 7,029,669; per-account arrays as in the §3.8 table; Σ of non-null account points equals the portfolio point on every date; `firstDataDate` A 09-30, B 10-01, C 10-12; `step = 'week'` over 10-05..10-13 → dates [10-09, 10-13]; `step = 'month'` over 09-15..10-13 → [09-30, 10-13]; a 3,661-day range → `PlanError(400, 'validation')`. S2: 10-12 = 6,973,341 with `priceStatus stale`; 10-13 unchanged.
15. **Day change.** D 10-13: A 38,038 (VTI 22,500 + VFIAX 15,538), B null `balance_only`, C 2,000; portfolio 40,038 partial, excluded [B]. D 10-14 with `expectedThrough` 10-13 and prices through 10-13: identical, `asOf 10-13, prior 10-12`. D 10-12: A 35,290. D 10-09: A 4,735 (prior 10-08 carrying the 09-30 implied rows: VTI 11,000, VFIAX −6,265). S2 D 10-12: A 19,000, VFIAX line stale. No price rows at all → `null`, reason `no_prices`. A balance-only account with balances on 10-12 and 10-13 → still null (flows are not market moves).
16. **Period change.** `1w` at 10-13 (S1 `auto` + B + C): start 10-06, startCents 6,729,606, change 300,063, newAccounts [{ C, openingCents 200,000 }], netFlows 200,000, market 100,063. A alone 09-30 → 10-13: change 178,063, netFlows 100,000, market 78,063; with `off`: change 78,063, netFlows 100,000, market null (`flows_not_in_value`). `ytd` at 10-13 → start 2025-12-31, all null, newAccounts []. `periodStart`: `1m` → 2026-09-13, `1y` → 2025-10-13, `3m` → 07-13, `all` → the earliest `firstDataDate`.
17. **Reconciliation preview (db, S1, A `auto`, statement 10-13).** Rows VTI 100 @ 305.25, VFIAX 50.123 @ 505.10, Cash 2,234.56 (value given), total 5,807,669 → difference 0, `matchesToTheDollar`, statuses `match ×3`, unexplained 0, `alreadyReconciled false`, balance block from the 09-30 balance (5,629,606, difference −178,063). Same with A `off` → app 5,707,669, cash row `cash` with valueDiff −100,000, difference −100,000, `cashInferenceHint { 100000, 0, true }`. Variant P (VFIAX 505.12, total 5,807,769): difference −100, not to the dollar, VFIAX `price` (appPrice 505.10 provider vs 505.12, diff −100), unexplained 0. Variant Q (VTI 101): `quantity`, row diff −30,525, difference −30,525. Total-only (no rows, total 5,807,700): difference −31, matches. Statement row `FXAIX` not held → `missing_in_app`; app VFIAX omitted → `missing_in_statement`; unknown ticker `ZZZZ` → `unknown_ticker`; the same ticker twice → `400 duplicate_security`; a row with neither price nor value → `400 validation`; date after today → `400 future_date`; a viewer may call preview (readOnly) and gets `403` on commit.
18. **Reconciliation commit (db).** S1 commit with `accept`: `holding_snapshot` 10-13 has 3 rows `source manual` (cash row on the cash security, quantity 2,234.56000000); `balance_snapshot` 10-13 = 5,807,669 `manual` replacing a seeded SimpleFIN row of 5,800,000; `price` VTI/VFIAX 10-13 still provider; `account_reconciliation` row `{ diff_cents 0, reconciled true, accepted true, holding_snapshot_date 10-13, app_basis 'positions', app_as_of 09-30, cash_inference 'auto' }`; audit `reconciliation/create` with before null; V(10-13) = 5,807,669 `snapshot`; V(10-14) = 5,807,669 `positions` asOf 10-13 (no carried flows after 10-13). Variant P accepted: V(10-13) = 5,807,769; `diff_cents −100, reconciled false, accepted true`. `accept: false`: the record is written, no snapshot/balance/price changes, V unchanged. A second preview after an accepted commit reports `alreadyReconciled true` and difference 0. A CSV snapshot on the same date is replaced (rows not in the statement deleted; audit `before` lists them); a `manual` snapshot of a different date is untouched.
19. **Gate test (db, end to end).** Seed S1 with provider closes; preview on 10-13 → `|difference| < 100` (0); commit → post-commit valuation equals the statement exactly. Variant P → pre-commit difference −100: the gate reports **fail by $1.00** (boundary), and after acceptance the value equals the statement; the record carries both numbers.
20. **Fetch plan (db).** Held provider securities VTI (A snapshot), FXAIX (C snapshot), a `full` account's lot in BND; TGT2045 (`implied`) and Cash never appear; `SOLD` (quantity 0 in the latest snapshot) excluded; `BENCH` (benchmark, not held) included with from = household earliest snapshot − 7; VTI latest 10-12 → from 10-09, to 10-13; `NEWX` first seen 2026-08-03 never fetched → from 07-27, ordered first; `not_found` 2 days ago → skipped, named in `securityIds` → included, symbol edited → included; `price_next_attempt_at` in the future → skipped; `maxYears 20` floors at 2006-10-13; `from > to` → `skipped`.
21. **Job run with a fake provider (db).** 60 targets, cap 45 → 45 requests, rows written, stats `deferred 15`, one continuation `{ reason 'continue', continuation 1, securityIds: 15 ids, dedupeKey 'prices:continue:<root>' }` at `runAt ≈ now + 61 min`; the continuation processes 15, defers 0, queues nothing; re-running the root job (a retry) does not create a second continuation (key dedupe). 429 with `Retry-After: 30` then 503 then 200 → 3 requests, sleeps [30 s, 15 s], success. Persistent 429 on request 10 → 9 written, 51 deferred, `rateLimited 1`. 401 on request 3 → 2 written, import_log `error` "tiingo: API key rejected (401)", `PriceFeedError.permanent`, job `failed`, attempts 1, no continuation. 404 for one symbol → `not_found` for it, others `ok`, log `ok`, `notFound 1`; 7 days later it is retried. Every request `ECONNRESET` → job throws retryable, `failJob` requeues, log `error`, no continuation. One symbol timing out 3 times → `price_fetch_failures 1`, `price_next_attempt_at = now + 6 h`; a second run after 6 h failing again → 12 h; the next success resets both. A run cap of 10 s with a 3 s-per-call provider and 10 targets → 3–4 fetched, the rest deferred, job `done`.
22. **Idempotent runs.** Two runs against the same fake bars → identical `price` rows; the second reports `rowsInserted 0, rowsUpdated 0, rowsKept = n`; `fetched_at` unchanged on kept rows. A run with `PRICE_PROVIDER=none` → log `error` "Price feed not configured", job `done`, nothing written, nothing queued.
23. **Tiingo CSV parsing.** Header `date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor`; rows `2026-10-13,305.25,…,305.25,…,0.0,1.0` and `2026-10-12T00:00:00.000Z,303,…,1.0` → `[{10-12, 30,300,000,000n, adj 30,300,000,000n, split 100,000,000n}, {10-13, 30,525,000,000n, …}]` (sorted ascending); empty close → row skipped; `310.123456789` → 31,012,345,679n; `3.0525e2` → `invalid_response`; `2026-13-01` → `invalid_response`; an HTML body → `invalid_response` with `body` kept; empty body → 0 bars; `mapSymbol({ ticker: 'brk.b', providerSymbol: null })` = `BRK-B`, override `'BRKB'` wins. Suspect: previous 100.00 → 40.00 with split 1 → true; split 0.4 → false; 100 → 60 → false; 100 → 151 → true; a previous close 10 days earlier → false.
24. **Scheduler (America/Denver, hours 18/6).** 2026-10-13T23:30Z → nothing; 2026-10-14T00:05Z → `prices:nightly:2026-10-13`; next tick → nothing; 2026-10-14T12:00Z with one security behind → `prices:catchup:2026-10-14`, with none → nothing; `PRICE_PROVIDER=none` → nothing ever; `PRICE_CATCHUP_HOUR=off` → no catch-up. `enqueueJob` with `dedupe` and `payload.dedupeKey` ignores `connectionId` and matches the key; without a key the Phase 1 behaviour holds (test on `recurring.detect`).
25. **Manual prices and refresh (db).** Feed writes (VTI, 10-09) 310.00; `PUT /prices/VTI/2026-10-09 { close: "310.02" }` → manual row, audit `security` update with `{ price: { date, close } }`; a later provider upsert leaves 310.02; `rebuildImpliedPrices` never touches it; `DELETE` → removed, audited, job `{ reason 'refill', securityIds [VTI], from 2026-10-09, dedupeKey 'prices:refill:<VTI>' }` queued even while a continuation is queued; `DELETE` on a provider row → `409 manual_only`; `PUT` with date > today → `400 future_date`; cash security → `400 cash_security_reserved`. `POST /prices/refresh`: no job → `{ created true }`; queued `prices:manual` → `{ movedUp true }` and `run_at ≤ now`; running → `{ created false, movedUp false }`; `PRICE_PROVIDER=none` → 503. `PATCH /securities/:id/pricing { priceMode: 'provider' }` on a ticker-less fund → `400 ticker_required`; editing `providerSymbol` resets `price_fetch_status` and queues a backfill.
26. **Status view (db).** After the fixture and one run: `configured true`, `provider 'tiingo'`, `lastRun.status ok`, securities rows VTI/VFIAX/FXAIX `held true, latest 10-13, current` on 10-13; TGT2045 `implied`, latest 09-30, status implied; Cash absent (never priced); counts `{ current 3, stale 0, notFound 0, error 0, implied 1, manual 0 }`. On 10-17 with no later run: `stale 3`, each 3 trading days behind. `PRICE_PROVIDER=none`: `configured false`, `provider null`.

## 8. Deviations from the spec (flagged)

1. **OFX/QFX** (data-sources table: Phase 3; build list: Polish): out of scope here; the import seams are format-agnostic.
2. **`price` columns**: the spec lists security, date, close; `source`, `provider`, `adj_close`, `suspect`, `fetched_at`, `updated_at` are added (provenance drives precedence and display; adjusted closes make the benchmark total-return).
3. **Implied unit prices are stored** (`source = 'implied'`) rather than computed on the fly from "the latest positions import", and recorded for every valued line, not only ticker-less funds (one price lookup for every security; a new ticker is priced before the backfill lands).
4. **Columns beyond the spec**: `security.always_price` and the six `price_fetch_*`/`price_backfilled_from` columns; `account.cash_inference`; the `account_reconciliation` table (the gate's evidence).
5. **"Fetched once a day"**: a nightly run plus a conditional morning catch-up (mutual-fund NAVs post late; a day with nothing to do costs zero requests).
6. **"Held securities only"**: plus `always_price` and the household benchmark (the Performance view cannot exist without a benchmark series).
7. **Free source needs a free API key** (Tiingo); no keyless path ships.
8. **Day change and period change are defined here** (the spec names them without defining them): price movement on held positions anchored on the last completed session; period change split into net flows and market change with Phase 2's `newAccounts` convention.
9. **Cash inference** (balance plug on the snapshot date; transfer legs carried as cash) is not in the spec; opt-in per account, every inferred line labelled.
10. **Statement snapshots are `holding_snapshot.source = 'manual'`** (the highest import rank) rather than a new `statement` source, and an accepted statement replaces that date's `balance_snapshot` (so Phase 2 net worth agrees with the statement on that date).
11. **Trading calendar is computed** (NYSE rules in code) rather than fetched; special closures are a code list.
12. **No alert rows** for feed failures: a status endpoint and page instead (the alert table is payee-bound).
13. **Lots are the basis only by the explicit `investment_history = 'full'` switch**, never inferred from "newer evidence".

## 9. Seams

### Imports / data model area (`docs/design/phase-3/imports-and-data.md`)
- `price` DDL as §2.1 with this area's four columns and CHECK folded into the one `CREATE TABLE`; `upsertPrice(tx, { securityId, date, close, source })` enforcing `manual 3 > provider 2 > implied 1` exactly as `upsertPrices` (§3.6) does in batch; `writeImpliedPrices` using the deterministic same-date tie rule of §3.5 (largest `value_cents`, then `account_id`).
- `security.price_mode`, `provider_symbol`, `type = 'cash'` semantics (valued at 1, no price rows), `resolveSecurity(createIfMissing: false)`, `isCashKey`, `cashSecurity`, `setManualPrice`; `PATCH /api/securities/:id` may absorb `UpdateSecurityPricingBody` as long as it calls `updateSecurityPricing` for the side effects.
- `replaceHoldingSnapshot(tx, { source: 'manual', setBalance: true })` accepting the reconciliation's rows (cash rows on the cash security); `holding_snapshot.quantity` nullable for dollar-only positions (this engine carries their value).
- After every positions commit and holdings sync: `requestPriceRefresh(tx, { reason: 'holdings' })` (which sets `dedupeKey 'prices:holdings'`) instead of a bare `enqueueJob('prices.fetch', …, { dedupe: true })`, which a queued continuation would swallow.
- One Fixed8 module for all areas with the bounded `Fixed8String` of §3.1 (the area's `DecimalString` allows unbounded integer digits and must be tightened or replaced); the phase plan picks the file name (`decimal.ts` here and in the imports design vs `fixed.ts` in the lots design) and the aliases (`mulToCents` ≡ the lots area's `mulQtyPrice`, `roundDiv` ≡ `roundDivHalfAway`, `impliedPrice` ≡ `basisPerShare` on absolute values).
- Conflict to settle: the imports design derives fidelity (no column) while the lots design stores `account.investment_history`; this area needs the stored flag (D11). If the plan chooses derivation, this area adds `account.position_source ∈ snapshots | trades` with the same default-off semantics.

### Lots and performance area (`docs/design/phase-3/lots-and-performance.md`)
- Provides `valueFullAccount(input, date): FullValuation | null` and the loader for its input (`loadFullValuationInput`), `tradeCheckpoints(db, accountIds, through)` (one date per quantity change, from the position checkpoints of its §3.6), `loadExternalFlows(db, accountIds, from, to)` (cash flows signed, with the opening-value convention of its D18), and `account.investment_history`.
- Consumes `loadPriceSeries(db, securityIds, from, to, { adjusted?: boolean })` (the latest close on or before `from` plus all closes in `(from, to]`, ascending, unique dates; `adjusted` returns `adj_close ?? close` and reports `adjusted: boolean` per series) and `latestPrices(db, securityIds, asOf): Map<id, { date, close, source } | null>`; closes as `Fixed8`. Its `price` DDL draft (`close > 0`, `source` with `provider_adjusted`/`csv`, `fetched_at` only) must be read as §2.1: adjusted closes are a column, `close >= 0`. Its `stale_price` warning (7 calendar days) is an engine warning and stays; the user-facing staleness is this area's trading-day rule.
- The benchmark is fetched whenever `household_setting.benchmark_security_id` is set (no need to flip `always_price`); `price.adj_close` is null for securities Tiingo does not adjust and the series then falls back to `close` with `adjusted: false` so the Performance page can label "price return".
- Tiingo's `splitFactor` and `divCash` are parsed but not stored beyond `adj_close`; a split-detection suggestion for `investment_txn` is OQ6.

### Views / API / web area
- Portfolio, Holdings, Allocation pages call `GET /api/valuation/summary` and `/series`; Holdings "value" and "weight" columns use `LineValuationView.valueCents` (never recomputed from floats); `PriceStatusChip` is rendered wherever a price or value appears; null series points are gaps, partial points are captioned.
- Dashboard: an optional `prices` block from `priceFeedHealth(db, now, config)`; the review count stays as is (no new alerts).
- Navigation entries for `/prices` and `/investments/reconcile`; Accounts page additions of §5; `today` sent on every request.

### Existing Phase 1–2 code this area changes
`enqueueJob` (`dedupeKey`), `runner.ts` (generic `permanent`), `scheduler.ts` (`schedulePriceJobs`), `jobs/index.ts`, `apps/worker/src/env.ts` and `apps/api/src/config.ts` (price config), `months.ts` (`localClockInTimeZone`), `enums.ts` (§2.6), `api.ts` (§4, `AccountView.cashInference`, `UpdateAccountBody.cashInference`), `routes/accounts.ts` (`cashInference` patch, investment types only), `Layout.tsx` (nav), `.env.example`, `deploy/docker-compose.yml` (no change needed: the shared `env_file` already carries `PRICE_*` and `TIINGO_API_KEY*` to both containers; a Docker-secret deployment mounts the key file into the worker only).

## 10. Open questions

1. **Tiingo limits and terms** (500 symbols/month, 50/hour, 1,000/day; fund NAVs on the free plan; attribution): confirm at signup; `PRICE_MAX_REQUESTS_PER_RUN` and `PRICE_REQUEST_SPACING_MS` absorb a different hourly cap; Twelve Data is the fallback if fund coverage is missing (it has no NAVs on its free tier, so that fallback covers stocks and ETFs only).
2. **Fund share classes and money-market funds**: Tiingo coverage of institutional/R6 classes, 529 portfolios and sweep funds is unknown; `not_found` → the owner switches the security to `implied` or `manual`. Should the imports area auto-set `manual` with a 1.00 price for recognised sweep funds (`SPAXX`, `VMFXX`, names matching MONEY MARKET)?
3. **Tolerance "to the dollar"**: `|diff| < 100` cents (matching the imports area's `matchesToDollar`); should the gate use ≤ 50 (rounds to the same dollar)?
4. **Net worth vs valuation**: Phase 2 net worth reads `balance_snapshot`; a positions account's priced value can differ from the day's SimpleFIN balance by the market move. Should the dashboard use `valuationSummary` for investment accounts (views area), or should `prices.fetch` write `balance_snapshot(source 'computed')` daily for positions accounts? Not done here to keep one write path.
5. **Cash inference default**: `off` here (every inferred line is labelled and the preview suggests enabling it); if real statements show the plug is almost always right, flip the default in the phase plan.
6. **Splits**: provider closes are unadjusted; a positions snapshot after a split is correct, but lots-derived quantities before the lots area applies a `split` row mis-value by the factor. Should the fetch job suggest an `investment_txn` split when Tiingo reports `splitFactor ≠ 1` on a held security?
7. **Securities sold before Phase 3 went live** are never fetched automatically (history needed for realized-gain views): is `POST /api/prices/refresh { securityIds }` enough, or should the fetch set include anything held within the last 400 days?
8. **Retention**: `price` rows for securities no longer held are kept forever (performance history); confirm no retention requirement.
9. **Branded `Fixed8`**: both sibling designs use `type Fixed8 = bigint`; a branded type would stop cents and quantities being interchangeable to the type checker at the cost of casts in three areas. Decide once in the shared module.
10. **Currency**: valuation is USD-only (`account.currency` ignored); multi-currency is out of scope and should be flagged in the UI by the views area.
11. **Provider day window**: Tiingo's daily counter is assumed to reset at 00:00 UTC and failed requests are assumed to count; neither affects correctness at household volumes.

## 11. Judging record

| Judge | Winner | A (correctness / spec / codebase fit / testability) | B (same) |
| --- | --- | --- | --- |
| 1 | B | 7 / 8 / 6 / 9 = 30 | 7 / 8 / 9 / 8 = 32 |
| 2 | A | 8 / 9 / 7 / 9 = 33 | 6 / 7.5 / 8 / 8 = 29.5 |

A split verdict (A 63, B 61.5 in total). The two grafts lists converge: judge 1 asked B to absorb A's market semantics; judge 2 asked A to absorb B's structure. This document is therefore **B's structure carrying A's semantics**.

**Taken from Design B (the base shape):** one provider behind one interface and the Tiingo CSV client (rounding >8-decimal closes), `createPriceProvider` returning null when unconfigured; `PriceFeedError.permanent` and the runner generalisation; the fetch plan (held ∪ `always_price`, never-fetched-first ordering, 3-day overlap, 7-day `not_found` retry, 20-year floor), the per-run request cap with 1.5 s spacing and the 61-minute continuation; fetch state as columns on `security`; env configuration in the Phase 2 style; the preview/commit route split with `readOnly` preview, `alreadyReconciled`, `duplicate_security`, `unknown_ticker`, the `value` status and B's row statuses; `today` via `resolveToday` on every route and `views/*` mappers; `rebuildImpliedPrices`; manual-price delete refilling the hole; `POST /prices/refresh` with `movedUp`; the Prices card/page and Reconcile page layouts; the explicit position switch (as the lots area's `investment_history`); the Phase 2 `newAccounts` convention; no new alert kinds; the k401 implied-price fixture numbers.

**Grafted from Design A (the semantics):** `Fixed8String` bounded to `numeric(20,8)`; the NYSE calendar, `expectedPriceDate` (18:30 ET) and trading-day staleness keyed on pricing mode; carry-forward with `current` on closed days; the valuation chain with the snapshot-newer-than-trade tie-break, null-never-zero totals with `partial`/`missing` coverage; opt-in cash inference (plug and carried flows, labelled lines) and the reconcile hint; price-only day change on today's quantities (anchored on the latest priced date, which also settles both judges' "0 before the evening fetch" note); period change split into net flows and market change (with the lots area's opening-value treatment); rank-ordered precedence in the `ON CONFLICT … WHERE`, implied rows for every valued line, the suspect flag and `adj_close`; the retry policy (3 attempts, Retry-After capped, 404 no retry, 401/403 abort) and per-security exponential backoff; the 20-minute run cap; `enqueueJob.dedupeKey`; the conditional catch-up run; the `account_reconciliation` table and the two-part gate definition; `PriceStatusChip`; the price-history response with `expectedDate` and `tradingDaysBehind`; scenario S1 and its numbers.

**Flaws resolved** (each verified against the codebase before deciding): A's readOnly-yet-writing reconcile route → preview never writes, commit is owner-only (`readOnly` is static route config in `plugins/auth.ts`, confirmed); A's keyless Stooq fallback → dropped; A's `expectedPriceDate` sample → written correctly once; A's `mixed` status → removed; A's `formatFixed8(trim)` footgun → one canonical form (the sibling designs' choice); A's alert-table change → no alert kinds; A's valuation routes lacking `today` → added; A's implicit lots tie-break → explicit switch plus the tie-break; A's nightly `needFrom = latest + 1` → 3-day overlap; A's ambiguous `empty` handling → one rule (§3.11 step 4); A's muddled scheduler timestamps → recomputed (§3.13, test 24); B's day change counting contributions and balance moves → A's definition; B's calendar-day staleness and manual-after-4-days → mode-keyed trading-day rule; B's swallowed refill/holdings jobs → `dedupeKey`; B's provider-name-from-message → API env; B's 404-vs-409 delete inconsistency → `409 manual_only`; B's zero-filled series total → null points with `partial`; B's unbounded `DecimalString` → bounded; B's nightly failing daily under `PRICE_PROVIDER=none` → the scheduler does not queue; B's continuation-plus-retry double run → continuation only on a non-throwing finish, keyed by root job; B's one-day statement for trades accounts → the tie-break; B's `balance_snapshot` DO NOTHING on commit → replaced by the statement; B's `implied > feed` precedence → `provider > implied`; B's undefined status for value-without-price rows → `value`.

**Judges overruled or qualified:** judge 1's claim that the compose file does not pass the API its environment: `deploy/docker-compose.yml` applies `x-app-env` (`env_file: ../.env`) to both `web` and `worker`, so the API reads `PRICE_PROVIDER` without any compose change (the graft to read the state from env is kept; the premise was wrong). Judge 1's "optionally" on the calendar: taken, because trading-day staleness and the expected date need it and the 4-calendar-day rule was flagged by judge 2. A's four precedence ranks are replaced by the three the sibling designs already fixed (`manual > provider > implied`), since a statement price and a positions-import price are both "what a document said"; judge 1's graft wording ("implied/positions") allows it.
