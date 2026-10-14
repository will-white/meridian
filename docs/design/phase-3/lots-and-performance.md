# Phase 3 design: Lots, cost basis and performance engine

Area: a pure, deterministic TypeScript engine in `packages/shared` that builds lots from `investment_txn`, computes cost basis, realized and unrealized gains and dividend/interest income by month, values accounts, and computes money-weighted (XIRR) and time-weighted (TWR) returns by account and in total against a benchmark fund. Every definition follows a named standard (GIPS 2020 for TWR, external flows and the Modified Dietz approximation; Microsoft's XIRR definition for money-weighted return; IRS Publication 550 and Treas. Reg. §1.1012-1(c) for lot rules) and the document says where it does so. Every number in §7 was re-derived with a BigInt reference run of exactly these rules (scratch only, nothing in the repo was modified): `scratchpad/merge/{engine.mjs,cases.mjs}` for the merged rules on top of the Design A run at `scratchpad/perf/`.

This is the merged area design: Design A is the base, the grafts the judges asked for from Design B are folded in (same-day type rank, nullable amount with `fee_cents` and an `amount_mismatch` check, stable lot ids, a position check against the latest statement, cash anchored on `balance_snapshot`, a `stale_price` flag, a gain summary with integer invariants, `reinvestedCents` per income month, explainability fields, property-based tests, `today` in the request, readable reason strings), and every flaw the judges named is resolved in the text (the opening-value rule is now one rule for single- and multi-account requests; income is computed by the engine, not a second SQL; `detail=full` and the view agree; `accountIds` travel in a POST body like the cash-flow route). §11 is the judging record.

Files this area adds: `packages/shared/src/fixed.ts` (Fixed8 arithmetic), `packages/shared/src/lots.ts` (lot engine, holding period, income, position check, gain summary), `packages/shared/src/performance.ts` (valuation, flows, TWR, Modified Dietz, XIRR, benchmark, household total), their `*.test.ts`, `packages/db/src/schema/investments.ts` (co-owned with the imports and prices areas), `packages/db/src/services/lots.ts`, `packages/db/src/services/performance.ts` and their DB tests, `apps/api/src/routes/investments.ts` (this engine's routes; the views area owns the pages that call them), `apps/api/src/views/investments.ts`, `apps/web/src/components/investments/LotPickDialog.tsx`.

Scope boundary with the other three Phase 3 areas (§9 makes each seam an interface): the imports/data-model area writes `security`, `investment_txn`, `holding_snapshot`; the prices/valuation area writes `price`; the views/API/web area owns the Portfolio, Allocation, Holdings, Performance and Income pages. This document fixes the semantics of every `investment_txn` column the engine reads, owns `lot`, `lot_pick`, `lot_disposal`, and specifies the services, the contracts the pages consume and the tests.

## 1. Decisions (binding)

1. **Numeric representation: `Fixed8 = bigint` scaled by 10^8** for every share quantity and price (`packages/shared/src/fixed.ts`, `FIXED8_SCALE = 100_000_000n`), the exact image of `numeric(20,8)`; over the wire they travel as decimal strings (`Fixed8String`, up to 8 fraction digits); money is `bigint` cents; rates (returns, ratios) are JS `number`, the only floats in the engine, never stored and never fed back into cents. Reason: no float ever touches a quantity, price or cent, and the DB round-trip is lossless; the spec allows floating rates.
2. **One rounding rule for the investment engine: round half away from zero** (`roundDivHalfAway(n, d)`, `d > 0n`). Reason: it is what brokerage confirmations and 1099-Bs do, it is symmetric for negative amounts, and stating it once lets every formula cite it. Phase 2's "bigint division truncates" rule stays confined to the budget engines; this engine never truncates.
3. **quantity × price → cents is `roundDivHalfAway(q8 × p8, 10^14)`** (R1); **cents ÷ price → quantity is `roundDivHalfAway(c × 10^14, p8)`** (R2); **cents ÷ quantity → per-share price is `roundDivHalfAway(c × 10^14, q8)`** (R3); **split scaling is `roundDivHalfAway(q8 × num, den)`** (R5). Reason: one formula each, derivable from the scale factors (10^8 · 10^8 / 10^2).
4. **Proportional allocations of cents across pieces use largest remainder** (`allocateLargestRemainder(total, weights)`, R4), so parts always sum exactly to the total. Reason: proceeds split across lots must reconcile to the cent.
5. **Basis conservation.** Consuming `take` shares of a lot with `Q` shares and basis `B` removes `roundDivHalfAway(B × take, Q)`, or exactly `B` when `take = Q`; the lot keeps the remainder. Reason: Σ open basis + Σ consumed basis = Σ original basis holds in integer arithmetic, so "realized + unrealized = total gain" (§3.15) is exact, never approximate.
6. **Lots are derived, never edited, and keep their identity.** `lot` and `lot_disposal` are rebuilt from `investment_txn` (+ `lot_pick`) per account inside the writing transaction and stored only for reads; **`lot.id` equals the opening transaction's id**, so lot ids survive rebuilds and the UI can link to a lot. Reason: one source of truth, a corrected import never leaves stale lots, and nothing the user bookmarked changes under them (graft from B).
7. **Lot method per account: `account.lot_method ∈ fifo | specific`, default `fifo`.** FIFO orders open lots by `(acquired_date, opening order)`, so a transferred-in lot acquired in 2020 is consumed before last month's buy. `specific` uses `lot_pick` rows on the sell; a sell without picks falls back to FIFO and is flagged `needs_lot_pick`. Reason: IRS Pub 550 ("Identifying stock or bonds sold"): FIFO is the default; specific identification needs an adequate identification per sale (Treas. Reg. §1.1012-1(c)).
8. **Holding period (IRS Pub 550, "Holding Period"): long-term iff `soldDate > addMonthsClamped(acquiredDate, 12)`.** Counting starts the day after acquisition, so a sale on the anniversary is short-term; the month-end clamp follows Rev. Rul. 66-7 (2024-02-29 → 2025-02-28). Reason: exact IRS rule, one comparison, the existing `months.ts` helper.
9. **Amount is the truth; quantity × price ± fee is the check.** `investment_txn.amount_cents` is the signed cash effect on the account (buy ≤ 0 including commission, sell ≥ 0 net of commission); `fee_cents` (≥ 0, nullable = 0) is the commission. When `amount_cents` is null the engine derives it: buy `−(mulQtyPrice(q, p) + fee)`, sell `mulQtyPrice(q, p) − fee`, reinvest `mulQtyPrice(q, p)`. When both are given and they differ by more than 5 cents the engine warns `amount_mismatch` with the difference (amount still wins). A row with neither amount nor price warns `amount_missing` and contributes 0. Basis includes the buy commission; proceeds are net of the sell commission (Pub 550, "Basis of Investment Property" / "Sales and Trades"). Reason: brokerage CSVs carry either column reliably, rarely both consistently; a silent zero basis is the worst outcome (graft from B).
10. **Wash sales are not applied.** The engine never defers a loss under IRC §1091; it reports what was sold at what basis. Reason: Meridian is not a tax-reporting tool; brokerages compute wash adjustments on the 1099-B. Flagged in §8 and shown as a footnote on realized-gains views (`washSalesApplied: false`).
11. **`reinvest` is dividend income plus a lot** at the reinvested amount (cash effect 0); `dividend`, `interest` and `fee` move cash and income only; **`split` is a ratio applied to every open lot** (basis, acquisition date and `original_quantity` unchanged, Pub 550 "Stock splits"; cash in lieu of a fraction is recorded as a `sell`); **`transfer` has a signed quantity** (+ in, − out): an in-leg carries basis and original acquisition date when known (IRS carryover basis for property moved between the owner's own accounts), an out-leg disposes lots FIFO/specific at basis without a gain.
12. **Unknown basis is explicit, never guessed.** A transfer-in without `basis_cents` opens a lot with `basis_known = false`, basis 0, acquired on the transfer date; its unrealized gain is `null`; a disposal of it goes to the "unknown basis" bucket with term `unknown` and a warning. Reason: the IRS treats unknown basis as zero (Pub 550), but presenting that as a gain, or fabricating market value as basis, would mislead; the user is told to supply it.
13. **Oversell never throws.** Quantity beyond all open lots becomes an `unmatched_sell` disposal (basis 0, term `unknown`) with warning `oversell`; the position floors at 0. Reason: the engine must be total over imported data; the warning is the fix prompt.
14. **Same-day order is `(date, type rank, seq, id)`** with rank `split 0 < transfer-in 1 < buy 2 < reinvest 3 < dividend/interest 4 < fee 5 < sell 6 < transfer-out 7`, then `investment_txn.seq` (the row's ordinal in its import file), then id. Reason: a split is applied pre-market, so it must precede every same-day trade whatever order the broker's file lists them in; rank before `seq` is the only order that guarantees it (graft from B). Identical input sets give deep-equal output in any array order.
15. **External flow (GIPS 2020 Glossary, "external cash flow": capital that enters or exits the portfolio)** is defined exactly in §3.8: cash contributions and withdrawals (ledger transfers, cash `investment_txn` transfers), securities transferred in or out valued at market on the date, and an `opening_value` flow when a non-full account's first valuation is after `from`. Dividends, interest, fees, buys, sells and reinvestments are internal.
16. **Flow timing: start of day.** A flow dated d is added to the previous day's closing value and participates in day d's market move; sub-period boundaries are the closing valuations on d − 1. GIPS permits either convention when applied consistently; start-of-day is chosen because a first contribution then funds the account before the first price move (no zero-denominator day at inception, and no failure when the end-of-day value differs from the contribution).
17. **Period semantics: `V(from)` = end-of-day value on `from`; flows dated in `(from, to]` count; `V(to)` = end-of-day value on `to`; `days = dayDiff(from, to)`.** "YTD" is `from = Dec 31 of the previous year`; "since inception" is `from` = the day before the account's first transaction, flow or valuation. Reason: the start valuation must precede the first counted flow.
18. **Opening value: one rule for every request.** A non-full account whose first valuation date `d₁` satisfies `from < d₁ ≤ to` has `V(d) = 0` for `d < d₁`, an `opening_value` flow `+V(d₁)` dated `d₁`, and its flows dated `≤ d₁` are folded into that opening value (they are already inside the statement balance; reported with `internal: true`, reason `before_first_valuation`). This applies to the account's own metrics and to any total that contains it. A non-full account with no valuation on or before `to` gets `reason: no_valuations`. Reason: an account's metrics must not depend on which other accounts were selected (both judges); GIPS: a portfolio enters a composite at its inception value.
19. **Valuation of `full` accounts is price-based, daily-capable, and anchored on statement balances when they exist.** Securities are valued at the latest close on or before the date (carry-forward, `stale_price` when older than 7 days, `price_from_txn` when only a transaction price exists, `no_price` when nothing exists). Cash is `(anchor balance − securities value at the anchor) + Σ cash effects and cash flows after the anchor`, where the anchor is the latest `balance_snapshot` on or before the date; with no anchor, cash is tracked from inception (opening cash 0). On a snapshot date `V(d)` therefore equals the statement balance; between snapshots the engine rolls cash forward and marks securities to market. A `statementCheck` compares tracked cash with the cash the statement implies (§3.6). Reason: removes Design A's "opening cash 0" assumption wherever a statement exists (sweep interest, margin interest, fees paid from outside) while keeping inception-based cash for CSV-only histories (graft from B's anchoring); the check is the value half of the Phase 3 gate.
20. **True time-weighted return for `full` accounts** (GIPS 2020 §2.A.2–2.A.4: valuation at every external flow, sub-period returns geometrically chain-linked); **Modified Dietz between available valuations for `positions` and `balance` accounts** (the GIPS-permitted approximation when a portfolio is not valued on every flow date). The output names the method (`true_twr | modified_dietz`).
21. **Annualize only when `days ≥ 365`** (GIPS: returns for periods of less than one year must not be annualized), exponent `365 / days`. Both the period figure and the annualized figure are returned; the UI shows the period figure for sub-year ranges.
22. **XIRR exactly as Microsoft defines it:** the rate r with Σ Pᵢ · (1 + r)^(−(dᵢ − d₀)/365) = 0 over the investor's dated flows (−V(from), −contributions, +withdrawals, +V(to)). The solver is a deterministic fixed-grid bracket plus bisection to width 1e−10 (≤ 200 iterations), choosing the bracket containing Excel's default guess of 10% (else the nearest) and warning `multiple_roots` when several exist. Failure reasons are typed. The money-weighted period figure is `(1 + xirr)^(investedDays/365) − 1`. Reason: identical definition, reproducible result, no Newton divergence.
23. **Benchmark = the price series the prices area supplies** (close; adjusted or not is their call, flagged). Benchmark TWR = `B(to)/B(from) − 1`; benchmark MWR = XIRR of a shadow portfolio that buys `cents ÷ B(date)` units with every flow (R2) and is valued `units × B(to)` (R1); the legs are returned so the comparison is explainable.
24. **Household total** = Σ account values on every valuation date; a flow whose counterparty account is in the selected set and whose counterpart leg is itself an active flow is internal and dropped; method `true_twr` when every selected account is `full`, else `modified_dietz` with boundaries at the non-full accounts' snapshot dates (§3.13).
25. **Partial data:** `positions` and `balance` accounts get value-based metrics only (start/end value, contributions, withdrawals, growth, Modified Dietz TWR, XIRR, benchmark); no lots, basis, realized/unrealized or income. Reason: the spec's three fidelity levels.
26. **Fidelity is stored (`account.investment_history ∈ balance | positions | full`) and checked.** The import area raises it (positions → `positions`, trade history → `full`, never downward); the user may set it. The engine compares the lot engine's position on the latest `holding_snapshot` date with the statement per security (tolerance 0.001 shares) and emits `position_mismatch` lines; the fidelity badge shows them. Reason: an account with three hand-entered trades is not full history (stored), and the quantity half of the Phase 3 gate needs a checkable statement (graft from B).
27. **No cache, no job.** Performance, realized gains and income are computed per request from the engine; lots are rebuilt synchronously inside the writing transaction. Reason: deterministic reads, nothing to invalidate; the Phase 2 cash-flow precedent holds.
28. **Schema additions beyond the spec's rows** (§8): `investment_txn.seq`, `fee_cents`, `split_numerator/denominator`, `basis_cents`, `basis_acquired_date`, `ledger_transaction_id`, nullable `amount_cents`, type `interest`; tables `lot_pick`, `lot_disposal`; `account.investment_history`, `account.lot_method`; `household_setting.benchmark_security_id`.
29. **Audit:** manual `investment_txn` edits (import area's route) and `lot_pick` changes write `audit_log` (`AuditEntity` gains `investment_txn`, `lot_pick`), one batch per request, via `writeAudit`.
30. **Errors:** the engine throws only on programming errors (non-positive divisor, unsorted price series, `to ≤ from`); every data problem is a typed warning in the result. Request problems are `PlanError(status, code, message)` mapped by `usePlanErrors`.
31. **Tests:** the §7 cases are the contract; floating rates are asserted with `|x − expected| ≤ 1e−9` unless a case says otherwise; cents and quantities are asserted exactly; the invariants of §3.15 are asserted over 500 seeded random histories.

## 2. Data model

Conventions as in Phase 1/2: `uuid` ids with `gen_random_uuid()`, `bigint` cents, `date` for calendar dates, `text` columns with app-level enum validation plus the DB CHECKs listed (drizzle-orm 0.38.4 `check()` from `pg-core` emits them; `pnpm db:generate` carries them into the migration). Drizzle reads `numeric` as a string; the services convert with `parseFixed8` / `formatFixed8` at the boundary and never pass a numeric through `Number`. Ownership: the imports/data-model area owns ingestion into `security`, `price` (prices area), `holding_snapshot`, `investment_txn`; this area owns `lot`, `lot_pick`, `lot_disposal` and the columns marked (engine). DDL is given for every table the engine reads so the four area designs merge line by line.

### security (imports area; engine reads `id`, `type`, `asset_class`)
```sql
CREATE TABLE "security" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticker" text,                                    -- null for funds without a public ticker
  "name" text NOT NULL,
  "type" text NOT NULL,                             -- stock | etf | fund | bond | cash | cd | other
  "asset_class" text NOT NULL DEFAULT 'other',      -- us_stock | intl_stock | bonds | cash | real_estate | other
  "expense_ratio" numeric(8,6),                     -- decimal fraction: 0.03% = 0.000300; null unknown (basis-point integers cannot hold 0.035%)
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "security_ticker_idx" ON "security" (upper("ticker")) WHERE "ticker" IS NOT NULL;
```

### price (prices area; engine reads)
```sql
CREATE TABLE "price" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "security_id" uuid NOT NULL REFERENCES "security"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "close" numeric(20,8) NOT NULL CHECK ("close" > 0),
  "source" text NOT NULL,                           -- provider | provider_adjusted | implied | csv | manual
  "fetched_at" timestamptz
);
CREATE UNIQUE INDEX "price_security_date_idx" ON "price" ("security_id", "date");
```
The engine's `priceAt(security, date)` is "latest close on or before date" (`ORDER BY date DESC LIMIT 1` per security); the unique index serves it.

### holding_snapshot (imports area; engine reads for `positions` valuations and the position check)
```sql
CREATE TABLE "holding_snapshot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "security_id" uuid NOT NULL REFERENCES "security"("id") ON DELETE RESTRICT,
  "date" date NOT NULL,
  "quantity" numeric(20,8) NOT NULL,
  "value_cents" bigint NOT NULL,
  "price" numeric(20,8),                            -- as reported; null = implied from value/quantity (prices area)
  "cost_basis_cents" bigint,                        -- when the positions source reports it; display only at the positions level (OQ2)
  "source" text NOT NULL,                           -- simplefin_extra | csv | manual
  "import_log_id" uuid REFERENCES "import_log"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "holding_snapshot_account_security_date_idx" ON "holding_snapshot" ("account_id", "security_id", "date");
CREATE INDEX "holding_snapshot_account_date_idx" ON "holding_snapshot" ("account_id", "date");
```

### investment_txn (imports area writes; semantics fixed here; engine columns marked)
```sql
CREATE TABLE "investment_txn" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "security_id" uuid REFERENCES "security"("id") ON DELETE RESTRICT,   -- null only for interest / account fee / cash transfer
  "import_log_id" uuid REFERENCES "import_log"("id") ON DELETE SET NULL,
  "external_id" text,                               -- broker id, "itx:" + sha256 content hash with ordinal, or null (manual)
  "source" text NOT NULL,                           -- simplefin | csv | ofx | manual
  "date" date NOT NULL,
  "seq" integer NOT NULL DEFAULT 0,                 -- (engine) order within a day after the type rank: the row's ordinal in its import file; manual rows get max(seq)+1 for that date
  "type" text NOT NULL,                             -- buy | sell | dividend | interest | reinvest | fee | split | transfer
  "quantity" numeric(20,8),                         -- (engine) SIGNED: + shares into the account, − shares out; null for cash-only rows and splits
  "price" numeric(20,8),                            -- (engine) per share, > 0; required when amount_cents is null on buy/sell/reinvest
  "amount_cents" bigint,                            -- (engine) SIGNED cash effect: buy ≤ 0 (incl. commission), sell ≥ 0 (net), dividend/interest ≥ 0, fee ≤ 0; reinvest = the dividend amount (cash effect 0 by rule); split null; transfer: cash moved for cash transfers, null or market value for securities transfers; null on buy/sell/reinvest = derive from quantity × price ± fee
  "fee_cents" bigint,                               -- (engine) commission on buy/sell/reinvest, ≥ 0; null = 0
  "split_numerator" integer,                        -- (engine) split only: new = old × numerator / denominator (3:2 → 3/2; 1:10 reverse → 1/10)
  "split_denominator" integer,
  "basis_cents" bigint,                             -- (engine) transfer-in only: carried cost basis; null = unknown
  "basis_acquired_date" date,                       -- (engine) transfer-in only: original acquisition date; null = the transfer date
  "counterpart_txn_id" uuid,                        -- (engine) securities transfer between two household accounts: the other leg; no FK so either leg can be written first
  "ledger_transaction_id" uuid REFERENCES "transaction"("id") ON DELETE SET NULL, -- the ledger row this activity was derived from (brokerage feeds), so cash is never counted twice
  "description" text NOT NULL DEFAULT '',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "investment_txn_shape" CHECK (
    ("type" IN ('buy','reinvest') AND "security_id" IS NOT NULL AND "quantity" > 0 AND ("price" IS NOT NULL OR "amount_cents" IS NOT NULL))
    OR ("type" = 'sell' AND "security_id" IS NOT NULL AND "quantity" < 0 AND ("price" IS NOT NULL OR "amount_cents" IS NOT NULL))
    OR ("type" IN ('dividend','interest','fee') AND "quantity" IS NULL AND "amount_cents" IS NOT NULL)
    OR ("type" = 'split' AND "security_id" IS NOT NULL AND "quantity" IS NULL AND "split_numerator" > 0 AND "split_denominator" > 0 AND "amount_cents" IS NULL)
    OR ("type" = 'transfer' AND (("security_id" IS NOT NULL AND "quantity" <> 0) OR ("security_id" IS NULL AND "quantity" IS NULL AND "amount_cents" IS NOT NULL AND "amount_cents" <> 0)))
  ),
  CONSTRAINT "investment_txn_price_positive" CHECK ("price" IS NULL OR "price" > 0),
  CONSTRAINT "investment_txn_fee_nonneg" CHECK ("fee_cents" IS NULL OR "fee_cents" >= 0),
  CONSTRAINT "investment_txn_split_only" CHECK ("type" = 'split' OR ("split_numerator" IS NULL AND "split_denominator" IS NULL)),
  CONSTRAINT "investment_txn_basis_carry" CHECK (("basis_cents" IS NULL AND "basis_acquired_date" IS NULL) OR ("type" = 'transfer' AND "quantity" > 0))
);
CREATE UNIQUE INDEX "investment_txn_account_external_idx" ON "investment_txn" ("account_id", "external_id");
CREATE INDEX "investment_txn_account_security_date_idx" ON "investment_txn" ("account_id", "security_id", "date", "seq");
CREATE INDEX "investment_txn_account_date_idx" ON "investment_txn" ("account_id", "date");
CREATE INDEX "investment_txn_date_idx" ON "investment_txn" ("date");
CREATE INDEX "investment_txn_counterpart_idx" ON "investment_txn" ("counterpart_txn_id");
```
Amount signs are validated by the API/import (400 `validation`) and by engine warnings (`buy_amount_sign` etc.), not by CHECK, so a broker's reversal row (a negative dividend) can still be stored.

Sign table (binding for importers and the manual form):

| type | security_id | quantity | price | amount_cents | fee_cents | other |
| --- | --- | --- | --- | --- | --- | --- |
| buy | required | > 0 | optional (required if amount null) | ≤ 0, −(gross + fee), or null | ≥ 0 | |
| sell | required | < 0 | optional (required if amount null) | ≥ 0, gross − fee, or null | ≥ 0 | lot_pick rows optional |
| reinvest | required | > 0 | optional | the dividend amount (≥ 0) or null (→ gross) | ≥ 0 | cash effect is 0 |
| dividend | optional | null | null | ≥ 0 | | security null → account-level row |
| interest | optional | null | null | ≥ 0 | | |
| fee | optional | null | null | ≤ 0 | | |
| split | required | null | null | null | | split_numerator, split_denominator |
| transfer (cash) | null | null | null | ≠ 0, signed | | a flow, never a lot (§3.8) |
| transfer (securities) | required | ≠ 0, signed | optional | null or market value | | basis_cents, basis_acquired_date (in); lot_pick (out); counterpart_txn_id |

### lot_pick (engine; user input for specific identification)
```sql
CREATE TABLE "lot_pick" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sell_txn_id" uuid NOT NULL REFERENCES "investment_txn"("id") ON DELETE CASCADE,  -- a sell or a transfer-out
  "open_txn_id" uuid NOT NULL REFERENCES "investment_txn"("id") ON DELETE CASCADE,  -- the lot (= its opening buy/reinvest/transfer-in)
  "quantity" numeric(20,8) NOT NULL CHECK ("quantity" > 0),
  "position" integer NOT NULL DEFAULT 0,                                            -- consumption order
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "lot_pick_sell_open_idx" ON "lot_pick" ("sell_txn_id", "open_txn_id");
```

### lot (engine; derived; one row per opening transaction)
```sql
CREATE TABLE "lot" (
  "id" uuid PRIMARY KEY REFERENCES "investment_txn"("id") ON DELETE CASCADE,   -- = the opening transaction's id; stable across rebuilds
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "security_id" uuid NOT NULL REFERENCES "security"("id") ON DELETE CASCADE,
  "opened_by" text NOT NULL,                        -- buy | reinvest | transfer_in
  "acquired_date" date NOT NULL,                    -- basis_acquired_date for transfers-in, else the opening date
  "original_quantity" numeric(20,8) NOT NULL CHECK ("original_quantity" > 0),   -- as opened (pre-split)
  "quantity" numeric(20,8) NOT NULL CHECK ("quantity" >= 0),                    -- remaining, split-adjusted; 0 when closed
  "original_cost_basis_cents" bigint NOT NULL CHECK ("original_cost_basis_cents" >= 0),
  "cost_basis_cents" bigint NOT NULL CHECK ("cost_basis_cents" >= 0),           -- remaining (conserved)
  "basis_known" boolean NOT NULL DEFAULT true,
  "closed_date" date,
  "rebuilt_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "lot_account_security_idx" ON "lot" ("account_id", "security_id", "closed_date");
CREATE INDEX "lot_account_open_idx" ON "lot" ("account_id") WHERE "quantity" > 0;
```
This is the spec's row (account, security, acquired date, quantity, cost basis) plus the remaining/original split, the opening kind and the two flags.

### lot_disposal (engine; derived)
```sql
CREATE TABLE "lot_disposal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "security_id" uuid NOT NULL REFERENCES "security"("id") ON DELETE CASCADE,
  "close_txn_id" uuid NOT NULL REFERENCES "investment_txn"("id") ON DELETE CASCADE,  -- the sell / transfer-out
  "lot_id" uuid REFERENCES "lot"("id") ON DELETE CASCADE,                            -- null for unmatched_sell
  "kind" text NOT NULL,                             -- sell | transfer_out | unmatched_sell
  "date" date NOT NULL,
  "acquired_date" date,                             -- null when unmatched
  "quantity" numeric(20,8) NOT NULL CHECK ("quantity" > 0),
  "proceeds_cents" bigint NOT NULL,                 -- 0 for transfer_out
  "basis_cents" bigint NOT NULL,
  "gain_cents" bigint NOT NULL,                     -- proceeds − basis; 0 for transfer_out
  "term" text NOT NULL,                             -- short | long | unknown | none
  "basis_known" boolean NOT NULL,
  "rebuilt_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "lot_disposal_close_lot_idx" ON "lot_disposal" ("close_txn_id", "lot_id");
CREATE INDEX "lot_disposal_account_date_idx" ON "lot_disposal" ("account_id", "date");
CREATE INDEX "lot_disposal_lot_idx" ON "lot_disposal" ("lot_id");
```
Disposal rows have no stable identity across rebuilds; the UI keys them on `(closeTxnId, lotId ?? 'unmatched')`, which is stable.

### account and household_setting (columns)
```sql
ALTER TABLE "account" ADD COLUMN "investment_history" text NOT NULL DEFAULT 'balance';  -- balance | positions | full (spec: each account shows its level)
ALTER TABLE "account" ADD COLUMN "lot_method" text NOT NULL DEFAULT 'fifo';             -- fifo | specific
ALTER TABLE "account" ADD CONSTRAINT "account_investment_history_check" CHECK ("investment_history" IN ('balance','positions','full'));
ALTER TABLE "account" ADD CONSTRAINT "account_lot_method_check" CHECK ("lot_method" IN ('fifo','specific'));
ALTER TABLE "household_setting" ADD COLUMN "benchmark_security_id" uuid REFERENCES "security"("id") ON DELETE SET NULL;
```

### Existing tables the engine reads (Phase 1/2, unchanged)
`balance_snapshot(account_id, date, balance_cents, source)`: the observed end-of-day value points (`source <> 'computed'`), the cash anchor for `full` accounts and the valuation series for `balance`/`positions` accounts. `transaction(account_id, date, amount_cents, is_transfer, transfer_pair_id, pending)`: ledger flows. `household_setting.timezone` for `today`.

### Enums (`packages/shared/src/enums.ts`)
`InvestmentTxnType = buy | sell | dividend | interest | reinvest | fee | split | transfer`; `InvestmentTxnSource = simplefin | csv | ofx | manual`; `InvestmentHistoryLevel = balance | positions | full`; `LotMethod = fifo | specific`; `LotOpenedBy = buy | reinvest | transfer_in`; `GainTerm = short | long | unknown | none`; `DisposalKind = sell | transfer_out | unmatched_sell`; `ReturnMethod = true_twr | modified_dietz`; `ExternalFlowKind = cash | securities | opening_value`; `ReturnFailureReason = no_valuations | zero_denominator | negative_capital | too_few_flows | no_sign_change | no_bracket | no_benchmark_price`; `AuditEntity` += `investment_txn`, `lot_pick`. `JobType` is unchanged by this area.

### Migration `0002_phase3_investments` (this area's steps, merged with the other areas' DDL in one file)
1. Create `security`, `price`, `holding_snapshot`, `investment_txn` (with its CHECKs and indexes), `lot_pick`, `lot`, `lot_disposal` in that order (FK order).
2. Add the `account` columns/constraints and `household_setting.benchmark_security_id`.
3. No data backfill: no investment rows exist before Phase 3. Existing brokerage/retirement accounts keep `investment_history = 'balance'` (their `balance_snapshot` history already feeds value-based metrics).
4. `packages/db/src/schema/investments.ts` holds the Drizzle definitions (CHECKs via `check(name, sql\`…\`)`); `schema/index.ts` re-exports it; `drizzle/meta/0002_snapshot.json` and `_journal.json` are generated by `pnpm db:generate`.

## 3. Algorithms

Files: `packages/shared/src/fixed.ts` (representation, rounding, allocation), `packages/shared/src/lots.ts` (ordering, lots, disposals, income, holding period, position check, gain summary), `packages/shared/src/performance.ts` (valuation, flows, TWR, Modified Dietz, XIRR, benchmark, totals). All exported from `packages/shared/src/index.ts`. No `Date.now()`, no randomness, no DB.

### 3.1 Fixed8 arithmetic and the rounding rules (`fixed.ts`)
```ts
export type Fixed8 = bigint;                         // value × 10^8
export const FIXED8_SCALE = 100_000_000n;
export const FIXED8_SQ_PER_CENT = 10n ** 14n;         // 10^8 · 10^8 / 10^2
export function parseFixed8(s: string): Fixed8;      // "-?\d+(\.\d{1,8})?" else throws
export function formatFixed8(v: Fixed8): string;     // always 8 fraction digits: "123.40000000"
export function roundDivHalfAway(n: bigint, d: bigint): bigint;   // d > 0n; q = n / d, r = n % d; if 2|r| ≥ d then q ± 1 (away from zero)
export function mulQtyPrice(q8: Fixed8, p8: Fixed8): bigint;      // R1: roundDivHalfAway(q8 × p8, 10^14) → cents
export function divCentsByPrice(cents: bigint, p8: Fixed8): Fixed8;// R2: roundDivHalfAway(cents × 10^14, p8); p8 > 0n
export function basisPerShare(cents: bigint, q8: Fixed8): Fixed8;  // R3: roundDivHalfAway(cents × 10^14, q8); q8 > 0n
export function scaleQty(q8: Fixed8, num: number, den: number): Fixed8; // R5 (splits): roundDivHalfAway(q8 × num, den)
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[]; // R4
```
Worked examples (R1): 10.5 × 123.456789 = 1296.2962845 → 129629.62845 cents → **129630**; 0.33333333 × 300 = 99.999999 → **10000**; −2.5 × 1.01 = −252.5 → **−253** (half away from zero), 2.5 × 1.01 → **253**; 1 × 0.005 → **1**; 1 × 0.00499999 → **0**; 3.5 × 101.33 = 354.655 → **35466**; 0.25 × 55 → **1375**. (R2): 100000 cents ÷ 33.333333 → **30.00000030**; 100000 ÷ 3 → **333.33333333**. (R3): 100495 ÷ 100 sh → **10.04950000**; 24000 ÷ 20 → **12.00000000**; 10000 ÷ 3 → **33.33333333**; 1400 ÷ 2.33333333 → **6.00000001**. `roundDivHalfAway`: 7/2 → 4, −7/2 → −4, 5/4 → 1, 6/4 → 2.
(R4) `allocateLargestRemainder(T, w)`: `W = Σw` (> 0n, else throw); work on `|T|`; `partᵢ = (|T|·wᵢ) / W` (floor), `remᵢ = (|T|·wᵢ) mod W`; `left = |T| − Σpart` (0 ≤ left < n); give +1 to the `left` largest `remᵢ`, ties by lower index; negate for negative T. 179995 over [100, 20] → [149996, 29999]; 100 over [1,1,1] → [34, 33, 33]; 10 over [1,1,1,1] → [3, 3, 2, 2]; 0 → zeros; −179995 → [−149996, −29999].
(R5) 15 sh at 1:10 → 1.50000000; 7 sh at 1:3 → 2.33333333 (2.333333333… rounded at the 8th place). Basis per lot is unchanged by a split.
(R6) Returns are IEEE doubles (`number`), never stored, never fed back into cents; the only float operations are one division per sub-period, `Math.pow` for XIRR/annualization, and the Dietz weighted sum in dollars.
(R7) Day count for XIRR and annualization: actual days / 365 (Excel's XIRR convention; GIPS does not prescribe one).
Every division asserts its divisor > 0n; a zero quantity or price reaching R2/R3 is a programming error.

### 3.2 Ordering (`sortInvestmentTxns`)
Key `(date asc, rank asc, seq asc, id asc)`; rank: split 0, transfer-in 1, buy 2, reinvest 3, dividend 4, interest 4, fee 5, sell 6, transfer-out 7 (a securities transfer's direction is the sign of `quantity`; a cash transfer ranks 1). The sorted list is the stream for everything below; lots, disposals, income events and position checkpoints are emitted in stream order. Shuffling the input array changes nothing (D14, TC20).

### 3.3 Lot engine (`buildLots(input): LotBuildResult`, one account)
Input: one account's `txns` (all securities), its `lotPicks`, `lotMethod`. Output: `lots`, `disposals`, `positions` (checkpoint after every transaction), `cashEffects`, `income`, `transferredOut`, `warnings`.

1. **Order** by §3.2. Transfers with `securityId = null` (cash) must not be present (the loader turns them into flows, §3.8); if one is, warning `cash_transfer_in_txns` and it is ignored.
2. **Amount resolution** (D9) for buy/sell/reinvest: `fee = feeCents ?? 0n`; `gross = price === null ? null : mulQtyPrice(|quantity|, price)`; `expected = buy: −(gross + fee); sell: gross − fee; reinvest: gross` (null when gross is null). `amount = amountCents ?? expected`; both null → warning `amount_missing`, amount 0. When `amountCents` and `expected` are both known and `|amountCents − expected| > 5n` → warning `amount_mismatch { txnId, diffCents: amountCents − expected }`; the stored amount still wins.
3. **Process each transaction** (lots are per security; `openLots(sec)` = lots of that security with `quantity > 0n` sorted by `(acquiredDate asc, openSeq asc)`):
   - `buy`: open a lot `{id = txn.id, openedBy buy, acquiredDate = date, quantity, basis = −amount, basisKnown true}`. If `amount > 0n`: warning `buy_amount_sign`, basis = `amount`. Cash effect `amount`.
   - `reinvest`: open a lot `{openedBy reinvest, basis = amount}`; income `dividend += amount`, `reinvested += amount` for `monthKey(date)` and the security; cash effect 0 (the dividend and the purchase cancel).
   - `transfer` with `quantity > 0n`: open a lot `{openedBy transfer_in, acquiredDate = basisAcquiredDate ?? date, basis = basisCents ?? 0n, basisKnown = basisCents !== null}`; warning `basis_unknown` when null. No cash effect.
   - `sell`: `dispose(q = −quantity, kind = 'sell', proceeds = amount)`; cash effect `amount`.
   - `transfer` with `quantity < 0n`: `dispose(q = −quantity, kind = 'transfer_out')`; no cash effect.
   - `split`: for each open lot of the security `quantity = scaleQty(quantity, num, den)` (R5); basis, acquired date and `originalQuantity` unchanged. Closed lots are not touched.
   - `dividend` / `interest`: income (`dividend` / `interest`) `+= amountCents` for the month and the security (`null` security = account-level row); cash effect `amountCents`.
   - `fee`: income `fee += −amountCents` (reported positive); cash effect `amountCents`.
   - `quantity ≤ 0n` on buy/reinvest or `≥ 0n` on sell: warning `bad_quantity`, row ignored.
   After each row, push a position checkpoint `{date, rank, seq, id, quantityBySecurity}`.
4. **`dispose(txn, q, kind, proceeds)`** builds pieces, each `{lot | null, quantity, basisCents, basisKnown, acquiredDate}`:
   a. Picks first (`lot_pick` rows for this txn by `position`): each pick's lot must be open and of the same security (else warning `pick_unavailable`, skipped); `take = min(pick.quantity, lot.quantity, remaining)` with warnings `pick_exceeds_lot` / `pick_exceeds_sale` when capped. `lotMethod = 'specific'` and no picks on a sell → warning `needs_lot_pick`.
   b. FIFO for what remains: walk `openLots(sec)` taking `min(lot.quantity, remaining)`.
   c. Still remaining → an unmatched piece `{lot: null, basis 0, basisKnown false}` and warning `oversell` with the quantity.
   d. **Consuming a lot** (D5): `basis = (take === lot.quantity) ? lot.costBasisCents : roundDivHalfAway(lot.costBasisCents × take, lot.quantity)`; the lot's `quantity −= take`, `costBasisCents −= basis` (the last piece of a lot always takes the exact remainder; the lot's basis never drifts); `closedDate = txn.date` when it reaches 0.
   e. **Proceeds** (sell only): `allocateLargestRemainder(proceeds, pieces.map(quantity))` (R4); transfer-out pieces get 0.
   f. **Term**: `none` for transfer_out; `unknown` when `basisKnown = false` (unmatched pieces and transfers-in without basis, whose acquisition date is not known either); else `isLongTerm(acquiredDate, date)` (§3.4) → `long` / `short`.
   g. One disposal per piece `{closeTxnId, lotId, kind: sell | transfer_out | unmatched_sell, date, quantity, proceedsCents, basisCents, gainCents = proceeds − basis (0 for transfer_out), term, acquiredDate, basisKnown}`. Transfer-out pieces are also appended to `transferredOut` so the import area can mirror them as transfers-in with carried basis and date elsewhere in the household.
5. **Cash effects** are the list of `(date, cents)` from step 3; `income` is grouped by `(YYYY-MM, securityId)` into `{dividendCents, interestCents, feeCents, reinvestedCents}` (reinvested dividends are dividends, and also counted in `reinvestedCents`).

Worked example (FIFO, TC2): buy 100 @ 10 on 2025-03-03, fee 495, amount −100495 (expected −(100000 + 495) = −100495, no warning); buy 50 @ 12 on 2025-09-10 for −60000; sell 120 @ 15 on 2026-04-01, fee 5, amount +179995 (expected 180000 − 5 ✓). Pieces: lot b1 100 sh (fully consumed, basis 100495), lot b2 20 of 50 (basis round(60000 × 20/50) = 24000; lot keeps 30 sh and 36000). Proceeds: 179995 over [100, 20]: floor shares 149995 (rem 0.83) and 29999 (rem 0.17), leftover 1 → [149996, 29999]. Gains: 149996 − 100495 = **49501 long** (2025-03-03 + 12 months = 2026-03-03 < 2026-04-01); 29999 − 24000 = **5999 short**. Position after: 30 sh.
Worked example (specific, TC3): picks `[b2 × 50]`, then FIFO takes 70 from b1: basis round(100495 × 70/100) = 70346.5 → **70347**; b1 keeps 30 sh and 30148. Proceeds over [50, 70]: floor 74997 (rem 0.92) and 104997 (rem 0.08), leftover 1 → **[74998, 104997]**; gains **14998 short**, **34650 long**.
Worked example (amount resolution, TC28): buy 3.5 @ 101.33, fee 199, amount null → gross 35466, amount −35665, basis 35665; buy 1 @ 100, fee 0, amount −10100 → expected −10000, diff −100 → `amount_mismatch`, basis 10100; sell 1 @ 100, amount 9997 → expected 10000, diff −3 → no warning.

### 3.4 Holding period (`isLongTerm(acquired, sold)`)
`sold > addMonthsClamped(acquired, 12)` using the existing `months.ts` helper. 2025-02-05 sold 2026-02-05 → short; 2026-02-06 → long (Pub 550's own example). 2024-02-29: `addMonthsClamped` → 2025-02-28; sold 2025-02-28 → short, 2025-03-01 → long (Rev. Rul. 66-7). 2025-01-31 → 2026-01-31 short, 2026-02-01 long. Unrealized term as of `asOf` uses the same function with `sold = asOf`.

### 3.5 Income by month
`income[(month, securityId)] = {dividendCents: Σ dividend + reinvest amounts, interestCents: Σ interest, feeCents: Σ −fee, reinvestedCents: Σ reinvest amounts}`; account totals per month are the sums over securities (`securityId = null` rows are account-level interest/fees). The period report returns months in `(from, to]` by transaction date. The spec's "feeding the income bucket" is the views area's toggle (OQ3): dividends swept to checking already arrive as ledger income, so only `reinvestedCents` plus dividends kept in the account may be fed without double counting. There is one implementation: the income route runs `buildLots(...).income`, never a separate SQL aggregate.

### 3.6 Valuation of a `full` account (`valueAt(date)`)
- `qty_s(d)` = the position checkpoint with the greatest `(date, rank, seq, id)` whose `date ≤ d` (empty before the first transaction).
- `price_s(d)`: the latest `price.close` with `date ≤ d` (carry-forward; GIPS: "most recent available" when a market is closed), flagged `stale_price {securityId, date, priceDate}` when `dayDiff(priceDate, d) > 7`; else the latest `investment_txn.price` with `date ≤ d` for that security (warning `price_from_txn`); else the security is skipped with warning `no_price` (value 0 for it).
- `securities(d) = Σ_s mulQtyPrice(qty_s(d), price_s(d))` (R1 per security, then summed; never qty × price summed in Fixed8 and rounded once).
- `cash(d)` (D19): `anchor` = the latest `balance_snapshot` of the account with `date ≤ d` and `source <> 'computed'`. With an anchor: `cash(d) = (anchor.balance_cents − securities(anchor.date)) + Σ cashEffects with anchor.date < date ≤ d + Σ cash flows with anchor.date < date ≤ d`. Without: `cash(d) = Σ cashEffects(date ≤ d) + Σ cash flows(date ≤ d)` (opening cash 0 at inception; `openingCashCents` exists as an input for tests only).
- `V(d) = cash(d) + securities(d)`. On a snapshot date this is the statement balance exactly (the securities term cancels); between snapshots the engine rolls cash forward and marks securities to market. The output records `cashAnchor: { date } | null` per valuation.
- `statementCheck(d)` for a date with a snapshot: `securitiesCents = securities(d)`, `impliedCashCents = snapshot − securitiesCents`, `trackedCashCents` = cash rolled forward from the latest snapshot **strictly before** d (or inception), `differenceCents = impliedCashCents − trackedCashCents`, `trackedFrom: date | 'inception'`. A non-zero difference is money the ledger did not see (sweep interest, a fee paid from outside, an unrecorded contribution) or a price difference; `|difference| ≥ 100` cents adds warning `statement_mismatch`. The service computes it at `to` when a snapshot exists on `to`, else at the latest snapshot ≤ `to`.
Worked (TC21): 10 sh bought 2026-01-15 @ 25.5 funded by a 25500 contribution; at 2026-02-10 with closes {02-01: 26, 02-11: 27} → cash 0 + 10 × 26 = **26000** (stale: 9 days > 7); with no series → 10 × 25.5 = **25500** + `price_from_txn`; with only the 02-11 close → 25500 + warning; on 2026-01-01 → 0.
Worked (anchored, TC32): buy 100 VTI @ 10 on 01-02 funded by +100000; dividend +500 on 01-20; closes 01-02: 10, 01-10: 10.1, 01-31: 10.5; snapshots 01-10: 101200, 01-31: 105750. V(01-05) = 0 + 100000 (inception cash); V(01-10) = (101200 − 101000) + 101000 = **101200** (anchor 01-10, implied cash 200); V(01-20) = 200 + 500 + 100 × 10.1 = **101700** (`stale_price`, 10 days); V(01-31) = **105750** (anchor 01-31). Without snapshots V(01-31) would be 500 + 105000 = 105500. `statementCheck(01-31)`: securities 105000, implied cash 750, tracked cash from 01-10 = 200 + 500 = 700, **difference 50**.

### 3.7 Valuation of `positions` / `balance` accounts and the opening value
The loader supplies `valuations: {date, valueCents, source}[]`: `balance_snapshot` rows (`source <> 'computed'`), falling back to Σ `holding_snapshot.value_cents` per date when the account has holdings but no balance snapshots (the loader prefers `balance_snapshot` because it includes cash and is what the statement shows). `V(d)` = the latest valuation on or before d (carry-forward, flagged `valuation_carried` when d is a boundary and not a snapshot date). Let `d₁` be the first valuation date:
- `d₁ ≤ from`: `V(from)` is the carried valuation; no opening flow.
- `from < d₁ ≤ to` (D18): `V(d) = 0` for `d < d₁`; an `opening_value` flow `+V(d₁)` dated `d₁` is added; flows dated `≤ d₁` are folded into it (`internal: true`, `reason: before_first_valuation`, so `contributionsCents` excludes them and `openingValueCents` shows them); `startValueCents = 0`, `openingValue = { date: d₁, cents }`.
- `d₁ > to` or no valuations: every return figure is `{ null, reason: no_valuations }`.
Worked (TC16 last case, single account): valuations 01-31: 100000, 02-28: 130000, contribution +20000 on 02-10, period 01-01 → 02-28 → opening flow +100000 on 01-31; the Dietz sub-period 01-01 → 01-31 has `V₀ = 0, V₁ = 100000, ΣCF = 100000` at weight 1/30 and rate `(1000 − 0 − 1000) / (0 + 33.333) = 0` (it is computed, not skipped); the account's figures are identical whether it is requested alone or with others (TC24).

### 3.8 External flows: the exact definition
| Event | External? | Sign (account view) | Valued at |
| --- | --- | --- | --- |
| Cash deposit from outside the account (checking → brokerage transfer, payroll 401(k) deferral, employer match, rollover in, 529/HSA contribution) | yes, `cash` | + | cents as recorded |
| Cash withdrawal (transfer out, RMD, distribution, fee paid from outside) | yes, `cash` | − | cents |
| Securities transferred in / out (ACATS, in-kind rollover, opening positions when history starts mid-life) | yes, `securities` | ± | `mulQtyPrice(quantity, txn.price ?? price_s(date))` with the §3.6 fallback chain; no price at all → **0** with warning `securities_flow_unpriced` (the position is likewise valued 0 with `no_price` until a price exists, so the unpriced security neither adds a spurious loss nor a spurious gain; when a price later appears the value jump is flagged) |
| A non-full account whose first valuation date `d₁ > from` | yes, `opening_value` on d₁ | + V(d₁) | its first snapshot (§3.7) |
| Dividends, interest, capital-gain distributions, reinvestments | no (income) | | |
| Buys, sells, commissions, account fees, margin interest, tax withheld | no (internal) | | |
| Transfer between two household investment accounts | external to each account; **internal to any total that includes both** (§3.13) | | |

"Contribution versus income": money that enters from outside the account is a contribution; money that the holdings generate inside the account is income. The loader (`loadExternalFlows`, §6) derives cash flows exactly so: (a) every posted `transaction` row of the account with `is_transfer = true` (paired by the Phase 1 matcher, or marked by a rule such as the import area's "Contribution/Rollover → mark transfer" default) → flow `{date, amountCents: amount_cents, kind: 'cash', counterpartyAccountId: the other leg's account when paired, pairId: transfer_pair_id, sourceId: transaction id}`; (b) every `investment_txn` with `type = 'transfer' AND security_id IS NULL` → the same shape (the CSV full-history path, `counterpartyAccountId = null`, `pairId = null`); (c) union of (a) and (b) deduplicated: a (b) row with equal `amountCents` and `|dayDiff| ≤ 3` of an (a) row of the same account is dropped, greedy earliest first (the ledger row wins; the Phase 1 pairing window). Securities flows come from the engine (`securitiesFlows`, with `counterpartyAccountId` and `pairId` from `counterpart_txn_id`), opening-value flows from §3.7. Pending ledger rows are never flows. A securities transfer with `price` null and no close on or before its date but a later close does not use the later close (no look-ahead).

### 3.9 True time-weighted return (`trueTwr(from, to, flows, valueAt)`)
GIPS 2020 §2.A.2–2.A.4: value the portfolio at every external flow, compute sub-period returns, chain-link geometrically.
1. `inWindow = flows with from < date ≤ to` (internal/folded flows excluded).
2. Boundaries `B = sort(unique({from, to} ∪ {addDays(f.date, −1) : f ∈ inWindow}))` (all within `[from, to]`).
3. For consecutive boundaries `(b₀, b₁)`: `CF = Σ amountCents of flows dated b₀ + 1` (by construction every in-window flow is dated boundary + 1); `begin = V(b₀) + CF`; `end = V(b₁)`; if `begin = 0n` and `end = 0n` the sub-period is **skipped** (empty account; `rate = null, skipped = true`); if `begin = 0n` and `end ≠ 0n` the result is `null` with reason `zero_denominator` (value appeared without a flow: a data problem, reported with the date); if `begin < 0n` → `null`, `negative_capital`; else `r = Number(end) / Number(begin) − 1` (the single float division per sub-period).
4. `R = Π(1 + rᵢ) − 1` over non-skipped sub-periods; `days = dayDiff(from, to)`; `annualized = days ≥ 365 ? (1 + R)^(365/days) − 1 : null`.
Worked (TC14): contribution 100000 on 01-02 and buy 100 VTI @ 10; contribution 60000 on 02-01 and buy 50 @ 12; closes 01-02: 10, 01-31: 12, 02-01: 12, 02-28: 11; period 2026-01-01 → 2026-02-28. V: 01-01 = 0; 01-31 = 120000; 02-28 = 165000 (150 × 11, cash 0). Boundaries {01-01, 01-31, 02-28}. SP1: begin 0 + 100000 = 100000, end 120000 → r₁ = 0.2. SP2: begin 120000 + 60000 = 180000, end 165000 → r₂ = −0.0833333. R = 1.2 × 0.9166667 − 1 = **0.1000000**; 58 days → not annualized.

### 3.10 Modified Dietz (`modifiedDietz(from, to, flows, valuations)`)
For an account not valued daily (GIPS-permitted approximation; CFA Institute formula with day-weighted flows): boundaries `B = {from, to} ∪ {snapshot dates in (from, to)}`; for `(b₀, b₁)` with `D = dayDiff(b₀, b₁)`: `V₀ = V(b₀)`, `V₁ = V(b₁)` (carried forward when b is not a snapshot date; flagged; 0 before `d₁`), flows `fⱼ` with `b₀ < dateⱼ ≤ b₁` (including an `opening_value` flow on d₁), weight `wⱼ = (dayDiff(dateⱼ, b₁) + 1) / D` (start-of-day convention: a flow on b₀ + 1 has weight 1, a flow on b₁ has weight 1/D), `r = (V₁ − V₀ − ΣCF) / (V₀ + Σ wⱼ·CFⱼ)` computed in dollars as doubles; `V₀ = V₁ = 0, ΣCF = 0` → skipped; denominator ≤ 0 → `null` with reason (`zero_denominator` / `negative_capital`); chain-link and annualize as §3.9.
Worked (TC16): snapshots 01-31: 100000, 02-28: 130000; contribution 20000 on 02-10. D = 28, w = (18 + 1)/28 = 19/28, weighted = 200 × 19/28 = 135.714; r = (1300 − 1000 − 200) / (1000 + 135.714) = 100 / 1135.714 = **0.08805031**. Second sub-period to 03-31 (105000) with a withdrawal of 30000 on 03-31: D = 31, w = 1/31, r = (1050 − 1300 + 300) / (1300 − 300/31) = 50 / 1290.323 = **0.03875**; chain 1.08805031 × 1.03875 − 1 = **0.13021226**.

### 3.11 Money-weighted return (`xirr(flows)`), Excel's definition
Investor flows for a period: `[{from, −V(from)}, {dateⱼ, −amountⱼ} for each external flow in (from, to], {to, +V(to)}]` (contributions are money the investor pays in, hence negative; `opening_value` flows are contributions). With d₀ = the earliest date, `tᵢ = dayDiff(d₀, dᵢ) / 365`, `f(r) = Σ Pᵢ · (1 + r)^(−tᵢ)` in dollars (`Number(cents)/100`): XIRR is the r with `f(r) = 0` (Microsoft, "XIRR function"). Zero-amount flows are dropped before solving (they do not change the root); the full list is returned as `investorFlows` for the "how this was computed" view.
Solver (deterministic): (1) fewer than two non-zero flows → `null`, `too_few_flows`; no positive or no negative flow → `null`, `no_sign_change` (Excel's #NUM! conditions). (2) Evaluate f on the fixed grid `G = [−0.999999, −0.99, −0.9, −0.75, −0.5, −0.25, −0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 100, 1000, 10000, 100000, 1000000]`; an exact zero at a grid point is the answer (0 iterations); collect every adjacent pair with opposite signs; none → `null`, `no_bracket` (rates below −99.9999% or above 10⁸% are not representable, e.g. a total loss). (3) Choose the bracket containing 0.1 (Excel's default guess), else the one nearest to it, lower on ties; more than one bracket → warning `multiple_roots` (Descartes: a series with several sign changes can have several IRRs). (4) Bisect until `hi − lo ≤ 1e−10` or 200 iterations; return the midpoint. `annualized = r` (XIRR is annual by definition); `period = (1 + r)^(investedDays/365) − 1` with `investedDays = dayDiff(max(from, first non-zero investor flow date), to)`, shown for sub-year ranges.
Worked (Microsoft's documented example, TC11): −10000 (2008-01-01), 2750 (03-01), 4250 (10-30), 3250 (2009-02-15), 2750 (2009-04-01): bracket [0.3, 0.5], 31 bisections → **0.373362533** (Excel shows 0.373362535; the two agree to 1.5e−9, inside Excel's own 1e−8 tolerance).

### 3.12 Benchmark (`benchmarkOf(from, to, vFrom, flows, series)`)
`B(d)` = latest benchmark close on or before d (no close on or before `from` → benchmark `null`, reason `no_benchmark_price`). Shadow portfolio: `units = divCentsByPrice(V(from), B(from)) + Σ divCentsByPrice(amountⱼ, B(dateⱼ))` (R2; withdrawals subtract units; one leg `{date, cents, price, priceDate, units}` per flow), `terminalCents = mulQtyPrice(units, B(to))` (R1); `benchmark.xirr = xirr([−V(from), −flows…, +terminal])`; `benchmark.twr = Number(B(to)) / Number(B(from)) − 1` (a price series has no flows, so chain-linking is the identity), annualized by D21; `shadowValueCents = terminal` for "you vs. the index" display. Worked (TC14 with closes 01-01: 100, 01-02: 100, 01-31: 110, 02-01: 110, 02-28: 105): units 100000/100 = 10.00000000 + 60000/110 = 5.45454545 = 15.45454545; terminal 15.45454545 × 105 = 1622.7272722… → **162273**; benchmark XIRR **0.11902989** (period 57 d: 0.01771771); benchmark TWR 105/100 − 1 = **0.05**; the account's own XIRR is 0.27777696 and TWR 0.10.

### 3.13 Household total (`computePerformance`)
Selected accounts `S`. Values `V_T(d) = Σ_a V_a(d)` with each account valued by its own rule (§3.6, §3.7; 0 before a non-full account's d₁). Flows: the union of the accounts' active flows (after folding) minus every flow with `counterpartyAccountId ∈ S` whose counterpart leg (same `pairId`) is itself an active flow of an account in S (both legs dropped, `internal: true`); a leg whose counterpart was folded into an opening value stays external, so the total sees money leave one account and re-enter at the first statement. Opening-value flows of non-full accounts are kept. Method: `true_twr` (§3.9 over the union flows) when every account in S is `full`; otherwise `modified_dietz` with boundaries `{from, to} ∪ {snapshot dates of non-full accounts in (from, to)}`, full accounts valued by price on those dates. XIRR over the union flows with `V_T(from)` and `V_T(to)`. `contributionsCents` / `withdrawalsCents` sum the external cash and securities flows by sign; `openingValueCents` sums opening flows; `growthCents = end − start − netFlows − openingValue`. Gains (§3.15) total the `full` accounts' summaries with `partial: true` when any selected account is not `full`.
Worked (TC24): A = TC14's account, C balance-only with valuations 01-31: 100000, 02-28: 130000 and +20000 on 02-10; period 01-01 → 02-28. C gets `opening_value +100000 on 01-31`. Boundaries 01-01, 01-31, 02-28; V_T 0 / 220000 / 295000; sub-period 1: ΣCF 200000, weighted 1000 × 30/30 + 1000 × 1/30 = 1033.333, rate (2200 − 2000)/1033.333 = 0.193548387; sub-period 2: ΣCF 80000, weighted 600 + 200 × 19/28 = 735.714, rate (2950 − 2200 − 800)/(2200 + 735.714) = −0.017031630; chain **0.173220312**. The 01-01 → 01-31 sub-period is computed (A's flows and C's opening flow live in it), not skipped.

### 3.14 Holdings and unrealized gains as of `asOf` (full accounts)
Per open lot: `valueCents = mulQtyPrice(quantity, price_s(asOf))` (null when `no_price`), `unrealizedCents = basisKnown && priced ? value − costBasisCents : null`, `term = basisKnown ? (isLongTerm(acquiredDate, asOf) ? long : short) : unknown`, `basisPerShare = basisPerShare(costBasisCents, quantity)` (R3; null when basis unknown). Per (account, security): `quantity`, `valueCents`, `costBasisCents` (known lots only), `unrealizedCents` (known, priced lots only), `unrealizedShortCents`, `unrealizedLongCents`, `unknownBasisQuantity`, `lotCount`, `priceDate`, `priceSource`, `stale`. Cash is one line per account (`securityId = null`, value = `cash(asOf)`). Worked (TC18): VTI lots 100 sh basis 100495 (2025-03-03) and 50 sh basis 60000 (2026-05-10), close 15.25 on 2026-10-13, asOf 2026-10-14: values 152500 and 76250; unrealized 52005 long and 16250 short; security totals qty 150, value 228750, basis 160495, unrealized 68255; a VXUS transfer-in of 40 sh without basis at 62.5 → value 250000, unrealized null, `unknownBasisQuantity = 40`.

### 3.15 Realized summary, gain summary and the invariants
**Realized summary for `(from, to]`:** disposals with `kind ∈ {sell, unmatched_sell}` and `from < date ≤ to`: `shortTerm {proceeds, basis, gain, count}`, `longTerm {…}` over `basisKnown` rows by term, `unknownBasis {proceeds, quantity, count}` over `basisKnown = false` rows; `transfersOut {quantity, basis}` separately (not gains, not proceeds). `washSalesApplied: false`.
**Gain summary as of `asOf` (per full account, all history):** `realizedShortCents`, `realizedLongCents`, `unknownBasisProceedsCents` (sales with unknown basis, reported as a separate line, not as a gain), `realizedCents = short + long`, `unrealizedCents` (open known, priced lots), `totalGainCents = realized + unrealized`, `proceedsCents` (sales only), `basisConsumedCents` (sales only), `transferredOutBasisCents`, `openValueCents` (priced lots), `openBasisCents` (priced lots), `originalBasisCents` (every lot opened in the account), `unpricedSecurityIds`.
**Invariants** (asserted by TC34 over random histories and by TC30 by hand), for histories whose lots all have known basis and a price:
1. **Lots sum to position**: per security, Σ open lot quantity = Σ(buys + reinvests + transfers in) − Σ(sells + transfers out), split-adjusted, and equals the last position checkpoint.
2. **Basis conservation**: Σ open basis + Σ consumed basis (sales and transfers out) = Σ original basis, per security and per account.
3. **Realized + unrealized = total gain**: `realized + unrealized = openValue + proceeds + transferredOutBasis − originalBasis` (exact in integers because every basis movement is one `roundDivHalfAway` applied once). With unknown-basis sales: `+ unknownBasisProceeds` on the left.
4. **Non-negativity**: no lot quantity or basis below 0; `unmatched_sell` is the only way a sale exceeds supply.
5. **Order independence**: `buildLots` of any permutation of the input equals `buildLots` of the sorted input.
Worked (TC30): b1 10 @ 100 (2025-01-15), b2 10 @ 120 (2025-06-15), reinvest 0.5 @ 125 amount 6250 (2025-09-15), split 2/1 (2025-10-01), sell 25 @ 70 fee 100 amount 174900 (2026-01-15), transfer out 6 (2026-02-01), price 75 on 2026-03-01: realized 44900 (all short: 2026-01-15 is exactly one year after 2025-01-15), unrealized 14750, total **59650** = 75000 + 174900 + 36000 − 226250.

### 3.16 Position check (`checkPositions(positions, snapshot)`)
For the account's latest `holding_snapshot` date `d`: per security in the union of the lot engine's `qty_s(d)` and the snapshot's quantities, `|lotsQuantity − snapshotQuantity| > 0.001 sh (100_000n)` → warning `position_mismatch { securityId, lotsQuantity, snapshotQuantity, date }`. A security open in lots but absent from the statement (a missed sell) and one on the statement but absent from lots (a missed buy or an unentered opening position) both mismatch. The warnings are attached to the account in `LotsResponse` and `PerformanceResponse`; they never change `investment_history` (D26). Worked (TC31): lots VTI 60, BND 10.0005; statement VTI 100, BND 10 → one mismatch (VTI 60 vs 100); statement VTI 60, BND 10.002, VXUS 5 → BND (0.0015 > 0.001) and VXUS (0 vs 5).

### 3.17 Determinism and complexity
Transactions sorted once; lots per security in an array; one pass O(n log n). Valuations are needed only at boundary dates (O(boundaries × securities) with binary search on sorted price series and snapshot lists). A household with 5 accounts, 2,000 transactions and 3 years of daily prices computes in a few milliseconds; no cache (D27). Same input set ⇒ deep-equal output: lots, disposals and income events in stream order, flows sorted by `(date, kind, sourceId)`, warnings in discovery order, sub-periods ascending; `Math.pow` is the only platform-dependent operation.

## 4. Contracts

### 4.1 Engine types (`packages/shared/src/lots.ts`, `performance.ts`)
```ts
export interface InvestmentTxnInput { id: string; accountId: string; securityId: string | null; date: IsoDate; seq: number; type: InvestmentTxnType; quantity: Fixed8 | null; price: Fixed8 | null; amountCents: bigint | null; feeCents: bigint | null; splitNumerator: number | null; splitDenominator: number | null; basisCents: bigint | null; basisAcquiredDate: IsoDate | null; counterpartTxnId: string | null; }
export interface LotPickInput { sellTxnId: string; openTxnId: string; quantity: Fixed8; position: number; }
export interface LotBuildInput { accountId: string; lotMethod: LotMethod; txns: readonly InvestmentTxnInput[]; lotPicks: readonly LotPickInput[]; }
export interface LotResult { id: string /* = opening txn id */; securityId: string; openedBy: LotOpenedBy; acquiredDate: IsoDate; originalQuantity: Fixed8; quantity: Fixed8; originalCostBasisCents: bigint; costBasisCents: bigint; basisKnown: boolean; closedDate: IsoDate | null; }
export interface DisposalResult { closeTxnId: string; lotId: string | null; securityId: string; kind: DisposalKind; date: IsoDate; acquiredDate: IsoDate | null; quantity: Fixed8; proceedsCents: bigint; basisCents: bigint; gainCents: bigint; term: GainTerm; basisKnown: boolean; }
export interface PositionCheckpoint { date: IsoDate; rank: number; seq: number; id: string; quantityBySecurity: ReadonlyMap<string, Fixed8>; }
export interface IncomeMonth { month: MonthKey; securityId: string | null; dividendCents: bigint; interestCents: bigint; feeCents: bigint; reinvestedCents: bigint; }
export interface TransferredLot { txnId: string; securityId: string; acquiredDate: IsoDate; quantity: Fixed8; basisCents: bigint; basisKnown: boolean; }
export type EngineWarningCode = 'bad_quantity' | 'buy_amount_sign' | 'amount_missing' | 'amount_mismatch' | 'basis_unknown' | 'needs_lot_pick' | 'pick_unavailable' | 'pick_exceeds_lot' | 'pick_exceeds_sale' | 'oversell' | 'cash_transfer_in_txns' | 'price_from_txn' | 'stale_price' | 'no_price' | 'securities_flow_unpriced' | 'valuation_carried' | 'flow_before_first_valuation' | 'position_mismatch' | 'zero_denominator' | 'negative_capital' | 'multiple_roots' | 'no_benchmark_price' | 'statement_mismatch' | 'no_valuations';
export interface EngineWarning { code: EngineWarningCode; accountId?: string; securityId?: string; txnId?: string; date?: IsoDate; priceDate?: IsoDate; quantity?: Fixed8; lotsQuantity?: Fixed8; snapshotQuantity?: Fixed8; diffCents?: bigint; detail?: string; }
export interface LotBuildResult { lots: LotResult[]; disposals: DisposalResult[]; positions: PositionCheckpoint[]; cashEffects: Array<{ date: IsoDate; cents: bigint }>; income: IncomeMonth[]; transferredOut: TransferredLot[]; warnings: EngineWarning[]; }
export function sortInvestmentTxns(txns: readonly InvestmentTxnInput[]): InvestmentTxnInput[];
export function buildLots(input: LotBuildInput): LotBuildResult;
export function quantityAt(positions: readonly PositionCheckpoint[], date: IsoDate): ReadonlyMap<string, Fixed8>;
export function isLongTerm(acquired: IsoDate, sold: IsoDate): boolean;
export function checkPositions(positions: readonly PositionCheckpoint[], snapshot: { date: IsoDate; quantities: ReadonlyMap<string, Fixed8> }): EngineWarning[];
export interface GainSummary { realizedShortCents: bigint; realizedLongCents: bigint; realizedCents: bigint; unknownBasisProceedsCents: bigint; unrealizedCents: bigint; totalGainCents: bigint; proceedsCents: bigint; basisConsumedCents: bigint; transferredOutBasisCents: bigint; openValueCents: bigint; openBasisCents: bigint; originalBasisCents: bigint; unpricedSecurityIds: string[]; }
export function summarizeGains(lots: readonly LotResult[], disposals: readonly DisposalResult[], priceAt: (securityId: string) => Fixed8 | null): GainSummary;

export interface ExternalFlowInput { date: IsoDate; amountCents: bigint; kind: ExternalFlowKind; counterpartyAccountId: string | null; pairId: string | null; sourceId: string | null; }
export interface ValuationPointInput { date: IsoDate; valueCents: bigint; source: 'balance_snapshot' | 'holding_snapshot'; }
export interface PriceSeriesInput { securityId: string; points: ReadonlyArray<{ date: IsoDate; close: Fixed8 }>; /* sorted asc, unique dates; throws otherwise */ }
export interface PerformanceAccountInput { accountId: string; name: string; type: AccountType; taxTreatment: TaxTreatment; history: InvestmentHistoryLevel; lotMethod: LotMethod; txns: readonly InvestmentTxnInput[]; lotPicks: readonly LotPickInput[]; openingCashCents: bigint; cashFlows: readonly ExternalFlowInput[]; cashAnchors: readonly ValuationPointInput[] /* balance_snapshot rows for full accounts */; valuations: readonly ValuationPointInput[] /* non-full accounts */; latestHoldingSnapshot: { date: IsoDate; quantities: ReadonlyMap<string, Fixed8> } | null; }
export interface PerformanceInput { from: IsoDate; to: IsoDate; asOf: IsoDate; accounts: readonly PerformanceAccountInput[]; prices: readonly PriceSeriesInput[]; benchmark: { securityId: string; points: PriceSeriesInput['points'] } | null; }
export interface ReturnFigure { rate: number | null; annualized: number | null; reason: ReturnFailureReason | null; reasonDate: IsoDate | null; }
export interface XirrFigure { annualized: number | null; period: number | null; investedDays: number; reason: ReturnFailureReason | null; warnings: string[]; investorFlows: Array<{ date: IsoDate; amountCents: bigint }>; }
export interface SubPeriod { from: IsoDate; to: IsoDate; beginValueCents: bigint; flowCents: bigint; weightedFlowDollars: number | null; endValueCents: bigint; rate: number | null; skipped: boolean; beginCarried: boolean; endCarried: boolean; }
export interface FlowResult extends ExternalFlowInput { internal: boolean; internalReason: 'counterparty_in_total' | 'before_first_valuation' | null; }
export interface HoldingResult { securityId: string | null; quantity: Fixed8; valueCents: bigint | null; costBasisCents: bigint | null; unrealizedCents: bigint | null; unrealizedShortCents: bigint; unrealizedLongCents: bigint; unknownBasisQuantity: Fixed8; lotCount: number; priceDate: IsoDate | null; priceSource: 'price' | 'txn' | 'cash' | null; stale: boolean; }
export interface RealizedSummary { shortTerm: GainTotals; longTerm: GainTotals; unknownBasis: { proceedsCents: bigint; quantity: Fixed8; count: number }; transfersOut: { quantity: Fixed8; basisCents: bigint }; washSalesApplied: false; }
export interface GainTotals { proceedsCents: bigint; basisCents: bigint; gainCents: bigint; count: number; }
export interface StatementCheck { date: IsoDate; statementCents: bigint; securitiesCents: bigint; impliedCashCents: bigint; trackedCashCents: bigint; trackedFrom: IsoDate | 'inception'; differenceCents: bigint; }
export interface AccountPerformance { accountId: string; history: InvestmentHistoryLevel; method: ReturnMethod | null; startValueCents: bigint; endValueCents: bigint; openingValue: { date: IsoDate; cents: bigint } | null; contributionsCents: bigint; withdrawalsCents: bigint; netFlowsCents: bigint; growthCents: bigint /* end − start − netFlows − openingValue */; twr: ReturnFigure; xirr: XirrFigure; benchmark: BenchmarkPerformance | null; subPeriods: SubPeriod[]; flows: FlowResult[]; holdings: HoldingResult[]; lots: LotResult[]; disposals: DisposalResult[]; realized: RealizedSummary | null; gains: GainSummary | null; income: IncomeMonth[]; statementCheck: StatementCheck | null; warnings: EngineWarning[]; }
export interface BenchmarkPerformance { securityId: string; twr: ReturnFigure; xirr: XirrFigure; shadowValueCents: bigint; startPrice: Fixed8; endPrice: Fixed8; legs: Array<{ date: IsoDate; cents: bigint; price: Fixed8; priceDate: IsoDate; units: Fixed8 }>; }
export interface PerformanceResult { from: IsoDate; to: IsoDate; asOf: IsoDate; days: number; accounts: AccountPerformance[]; total: Omit<AccountPerformance, 'accountId' | 'history' | 'lots' | 'disposals' | 'statementCheck' | 'holdings'> & { accountIds: string[]; partialGains: boolean; excludedInternalFlows: number }; benchmark: BenchmarkPerformance | null; warnings: EngineWarning[]; }
export function computePerformance(input: PerformanceInput): PerformanceResult;
// exported, unit-tested helpers
export function xirr(flows: ReadonlyArray<{ date: IsoDate; amountCents: bigint }>, opts?: { tol?: number; maxIter?: number }): { rate: number | null; reason: ReturnFailureReason | null; iterations: number; warnings: string[]; bracket: [number, number] | null };
export function trueTwr(from: IsoDate, to: IsoDate, flows: readonly ExternalFlowInput[], valueAt: (d: IsoDate) => bigint): { rate: number | null; annualized: number | null; reason: ReturnFailureReason | null; reasonDate: IsoDate | null; subPeriods: SubPeriod[] };
export function modifiedDietz(from: IsoDate, to: IsoDate, flows: readonly ExternalFlowInput[], valuations: readonly ValuationPointInput[]): ReturnType<typeof trueTwr>;
export function investorFlows(from: IsoDate, to: IsoDate, vFrom: bigint, flows: readonly ExternalFlowInput[], vTo: bigint): Array<{ date: IsoDate; amountCents: bigint }>;
export function annualize(rate: number, days: number): number | null;   // days ≥ 365 ? (1+rate)^(365/days) − 1 : null
export function valueFullAccount(acct: PerformanceAccountInput, prices: ReadonlyMap<string, PriceSeriesInput>, lots: LotBuildResult, date: IsoDate): { valueCents: bigint; securitiesCents: bigint; cashCents: bigint; cashAnchor: IsoDate | null; warnings: EngineWarning[] };
export function securitiesFlows(lots: LotBuildResult, txns: readonly InvestmentTxnInput[], prices: ReadonlyMap<string, PriceSeriesInput>): { flows: ExternalFlowInput[]; warnings: EngineWarning[] };
export function statementCheck(acct: PerformanceAccountInput, prices: ReadonlyMap<string, PriceSeriesInput>, lots: LotBuildResult, date: IsoDate): StatementCheck | null;
```

### 4.2 Zod contracts (`packages/shared/src/api.ts`, Phase 3 section; cents as `CentsString`, quantities/prices as `Fixed8String`, rates as JSON numbers)
```ts
export const Fixed8String = z.string().regex(/^-?\d{1,12}(\.\d{1,8})?$/, "decimal with up to 8 places");
export const RateNumber = z.number().finite();
export const PerformanceRequestBody = z.object({
  today: IsoDateString.optional(),                       // Phase 2 TodayQuery convention; resolved by resolveToday
  from: IsoDateString.optional(),                        // default: since inception (day before the earliest txn/flow/valuation of the selected accounts)
  to: IsoDateString.optional(),                          // default: today; must satisfy from < to ≤ today
  asOf: IsoDateString.optional(),                        // holdings valuation date; default: to
  accountIds: z.array(z.string().uuid()).max(50).optional(), // default: every open account with type ∈ {brokerage, 401k, ira, roth, hsa, 529}
  benchmarkSecurityId: z.string().uuid().nullable().optional(), // absent → household_setting.benchmark_security_id; null → no benchmark
  detail: z.enum(["summary", "full"]).default("summary"), // full adds subPeriods, flows, lots, disposals, investorFlows and benchmark legs; summary returns them empty
});
export const ReturnFailureReasonView = ReturnFailureReason.nullable();
export const ReturnFigureView = z.object({ rate: RateNumber.nullable(), annualized: RateNumber.nullable(), reason: ReturnFailureReasonView, reasonDate: IsoDateString.nullable() });
export const XirrFigureView = z.object({ annualized: RateNumber.nullable(), period: RateNumber.nullable(), investedDays: z.number().int(), reason: ReturnFailureReasonView, warnings: z.array(z.string()), investorFlows: z.array(z.object({ date: IsoDateString, amountCents: CentsString })) });
export const SubPeriodView = z.object({ from: IsoDateString, to: IsoDateString, beginValueCents: CentsString, flowCents: CentsString, weightedFlowDollars: z.number().nullable(), endValueCents: CentsString, rate: RateNumber.nullable(), skipped: z.boolean(), beginCarried: z.boolean(), endCarried: z.boolean() });
export const ExternalFlowView = z.object({ date: IsoDateString, amountCents: CentsString, kind: ExternalFlowKind, counterpartyAccountId: z.string().uuid().nullable(), counterpartyAccountName: z.string().nullable(), internal: z.boolean(), internalReason: z.enum(["counterparty_in_total", "before_first_valuation"]).nullable(), sourceId: z.string().nullable() });
export const EngineWarningView = z.object({ code: z.string(), accountId: z.string().uuid().optional(), securityId: z.string().uuid().optional(), ticker: z.string().nullable().optional(), txnId: z.string().uuid().optional(), date: IsoDateString.optional(), priceDate: IsoDateString.optional(), quantity: Fixed8String.optional(), lotsQuantity: Fixed8String.optional(), snapshotQuantity: Fixed8String.optional(), diffCents: CentsString.optional(), detail: z.string().optional() });
export const LotView = z.object({ id: z.string().uuid() /* = opening txn id */, accountId: z.string().uuid(), accountName: z.string(), securityId: z.string().uuid(), ticker: z.string().nullable(), securityName: z.string(), openedBy: LotOpenedBy, acquiredDate: IsoDateString, originalQuantity: Fixed8String, quantity: Fixed8String, originalCostBasisCents: CentsString, costBasisCents: CentsString, basisPerShare: Fixed8String.nullable(), basisKnown: z.boolean(), closedDate: IsoDateString.nullable(), priceDate: IsoDateString.nullable(), valueCents: CentsString.nullable(), unrealizedCents: CentsString.nullable(), term: GainTerm });
export const LotDisposalView = z.object({ accountId: z.string().uuid(), accountName: z.string(), securityId: z.string().uuid(), ticker: z.string().nullable(), closeTxnId: z.string().uuid(), lotId: z.string().uuid().nullable(), kind: DisposalKind, date: IsoDateString, acquiredDate: IsoDateString.nullable(), quantity: Fixed8String, proceedsCents: CentsString, basisCents: CentsString, gainCents: CentsString, term: GainTerm, basisKnown: z.boolean() });
export const HoldingView = z.object({ accountId: z.string().uuid(), securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), securityName: z.string(), assetClass: z.string(), quantity: Fixed8String, priceDate: IsoDateString.nullable(), price: Fixed8String.nullable(), priceSource: z.enum(["price", "txn", "cash"]).nullable(), stale: z.boolean(), valueCents: CentsString.nullable(), costBasisCents: CentsString.nullable(), unrealizedCents: CentsString.nullable(), unrealizedShortCents: CentsString, unrealizedLongCents: CentsString, unknownBasisQuantity: Fixed8String, lotCount: z.number().int() });
export const GainTotalsView = z.object({ proceedsCents: CentsString, basisCents: CentsString, gainCents: CentsString, count: z.number().int() });
export const RealizedSummaryView = z.object({ shortTerm: GainTotalsView, longTerm: GainTotalsView, unknownBasis: z.object({ proceedsCents: CentsString, quantity: Fixed8String, count: z.number().int() }), transfersOut: z.object({ quantity: Fixed8String, basisCents: CentsString }), washSalesApplied: z.literal(false) });
export const GainSummaryView = z.object({ realizedShortCents: CentsString, realizedLongCents: CentsString, realizedCents: CentsString, unknownBasisProceedsCents: CentsString, unrealizedCents: CentsString, totalGainCents: CentsString, proceedsCents: CentsString, basisConsumedCents: CentsString, transferredOutBasisCents: CentsString, openValueCents: CentsString, openBasisCents: CentsString, originalBasisCents: CentsString, unpricedSecurityIds: z.array(z.string().uuid()) });
export const IncomeMonthView = z.object({ month: MonthString, securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), dividendCents: CentsString, interestCents: CentsString, feeCents: CentsString, reinvestedCents: CentsString });
export const StatementCheckView = z.object({ date: IsoDateString, statementCents: CentsString, securitiesCents: CentsString, impliedCashCents: CentsString, trackedCashCents: CentsString, trackedFrom: z.union([IsoDateString, z.literal("inception")]), differenceCents: CentsString });
export const BenchmarkPerformanceView = z.object({ securityId: z.string().uuid(), ticker: z.string().nullable(), name: z.string(), twr: ReturnFigureView, xirr: XirrFigureView, shadowValueCents: CentsString, startPrice: Fixed8String, endPrice: Fixed8String, legs: z.array(z.object({ date: IsoDateString, cents: CentsString, price: Fixed8String, priceDate: IsoDateString, units: Fixed8String })) });
const PerformanceBlock = { method: ReturnMethod.nullable(), startValueCents: CentsString, endValueCents: CentsString, openingValue: z.object({ date: IsoDateString, cents: CentsString }).nullable(), contributionsCents: CentsString, withdrawalsCents: CentsString, netFlowsCents: CentsString, growthCents: CentsString, twr: ReturnFigureView, xirr: XirrFigureView, benchmark: BenchmarkPerformanceView.nullable(), subPeriods: z.array(SubPeriodView), flows: z.array(ExternalFlowView), realized: RealizedSummaryView.nullable(), gains: GainSummaryView.nullable(), income: z.array(IncomeMonthView), warnings: z.array(EngineWarningView) };
export const AccountPerformanceView = z.object({ accountId: z.string().uuid(), name: z.string(), type: AccountType, taxTreatment: TaxTreatment, history: InvestmentHistoryLevel, ...PerformanceBlock, holdings: z.array(HoldingView), lots: z.array(LotView), disposals: z.array(LotDisposalView), statementCheck: StatementCheckView.nullable() });
export const PerformanceResponse = z.object({ from: IsoDateString, to: IsoDateString, asOf: IsoDateString, today: IsoDateString, days: z.number().int(), detail: z.enum(["summary", "full"]), accounts: z.array(AccountPerformanceView), total: z.object({ ...PerformanceBlock, accountIds: z.array(z.string().uuid()), partialGains: z.boolean(), excludedInternalFlows: z.number().int() }), benchmark: BenchmarkPerformanceView.nullable(), warnings: z.array(EngineWarningView) });
export const LotsQuery = z.object({ accountId: z.string().uuid().optional(), securityId: z.string().uuid().optional(), asOf: IsoDateString.optional(), today: IsoDateString.optional(), includeClosed: QueryBoolean.default("false") });
export const LotsResponse = z.object({ asOf: IsoDateString, lots: z.array(LotView), accounts: z.array(z.object({ accountId: z.string().uuid(), history: InvestmentHistoryLevel, lotMethod: LotMethod, positionCheckDate: IsoDateString.nullable(), warnings: z.array(EngineWarningView) })) });
export const RealizedGainsQuery = z.object({ from: IsoDateString, to: IsoDateString, accountId: z.string().uuid().optional(), securityId: z.string().uuid().optional() });
export const RealizedGainsResponse = z.object({ from: IsoDateString, to: IsoDateString, summary: RealizedSummaryView, byAccount: z.array(z.object({ accountId: z.string().uuid(), name: z.string(), summary: RealizedSummaryView })), disposals: z.array(LotDisposalView) });
export const InvestmentIncomeQuery = z.object({ from: MonthString, to: MonthString, accountId: z.string().uuid().optional(), groupBy: z.enum(["month", "security"]).default("month") });
export const InvestmentIncomeResponse = z.object({ from: MonthString, to: MonthString, months: z.array(z.object({ month: MonthString, dividendCents: CentsString, interestCents: CentsString, feeCents: CentsString, reinvestedCents: CentsString, netCents: CentsString })), rows: z.array(IncomeMonthView.extend({ accountId: z.string().uuid(), accountName: z.string() })), totals: z.object({ dividendCents: CentsString, interestCents: CentsString, feeCents: CentsString, reinvestedCents: CentsString, netCents: CentsString }) });
export const SetLotPicksBody = z.object({ picks: z.array(z.object({ openTxnId: z.string().uuid(), quantity: Fixed8String })).max(200) });  // replaces the sell's picks; [] clears them
export const LotPickView = z.object({ id: z.string().uuid(), sellTxnId: z.string().uuid(), openTxnId: z.string().uuid(), quantity: Fixed8String, position: z.number().int() });
export const SetLotPicksResponse = z.object({ picks: z.array(LotPickView), warnings: z.array(EngineWarningView), batchId: z.string().uuid() });
export const RebuildLotsBody = z.object({ accountId: z.string().uuid().optional() });
export const RebuildLotsResponse = z.object({ accounts: z.number().int(), lots: z.number().int(), disposals: z.number().int(), warnings: z.array(EngineWarningView) });
export const UpdateAccountBody /* extended */ = …extend({ investmentHistory: InvestmentHistoryLevel.optional(), lotMethod: LotMethod.optional() });
export const AccountView /* extended */ = …extend({ investmentHistory: InvestmentHistoryLevel, lotMethod: LotMethod });
export const HouseholdSettingView /* extended */ = …extend({ benchmarkSecurityId: z.string().uuid().nullable() }); UpdateHouseholdSettingBody likewise (optional, nullable).
```
Why a POST for a read: `accountIds` is an array and `today` travels with it; the codebase's only array-carrying read is `POST /api/cashflow/projection` (Phase 2 §14) with `config: { readOnly: true }`, which the auth plugin treats like a GET for the viewer role; Fastify's default querystring parser (no custom parser in `apps/api/src/app.ts`) yields a string for one repeated key and an array for two, so `z.array` in a GET query would 400 on a single account.

Readable reason strings (shipped in `packages/shared/src/api.ts` as `returnReasonText(reason, date)` so the views area renders them, not code names):

| reason / warning | text |
| --- | --- |
| `no_valuations` | "No value is known for this account on or before {to}. Sync it or import a statement." |
| `zero_denominator` | "Value appeared on {date} without a contribution. Add the opening transfer or position." |
| `negative_capital` | "The account's value went negative on {date}." |
| `too_few_flows`, `no_sign_change` | "Money only went one way in this period, so a rate of return is undefined." |
| `no_bracket` | "The return is outside the solvable range (a total loss or an extreme gain)." |
| `no_benchmark_price` | "No benchmark price on or before {from}." |
| `multiple_roots` (warning) | "Several rates fit these flows; showing the one nearest 10%." |
| `valuation_carried` (warning) | "Valued with the {date} statement (no value on the period boundary)." |
| `position_mismatch` (warning) | "{ticker}: lots sum to {lotsQuantity}, the {date} statement shows {snapshotQuantity}." |
| `statement_mismatch` (warning) | "Tracked cash differs from the {date} statement by {difference}." |
| `basis_unknown` (warning) | "Basis unknown for {quantity} {ticker}: enter it on the transfer." |

### 4.3 Routes (`apps/api/src/routes/investments.ts`, behind auth; `usePlanErrors`, `resolveToday`, `auditContext` reused from `routes/plan.ts`)
- `POST /api/investments/performance` (`PerformanceRequestBody` → `PerformanceResponse`; `config: { readOnly: true }`; `Cache-Control: no-store`). `today = resolveToday(app, body.today)`; `to` defaults to `today`, `from` to since-inception; `from < to` else 400 `validation`; `to ≤ today` else 400 `validation`; `to − from ≤ 40 years`; an `accountIds` entry that is unknown, closed or not an investment type → 400 `bad_request`.
- `GET /api/investments/lots` (`LotsQuery` → `LotsResponse`): stored lots joined with `security` and `account`, valued as of `asOf` (default today) via `computeHoldings`; per-account `position_mismatch` warnings from the latest `holding_snapshot`.
- `GET /api/investments/realized` (`RealizedGainsQuery` → `RealizedGainsResponse`): from `lot_disposal` (rebuilt on every write, so it equals the engine's output; TC26 asserts it).
- `GET /api/investments/income` (`InvestmentIncomeQuery` → `InvestmentIncomeResponse`): `buildLots(...).income` per account in scope, filtered to `[from, to]` months (§3.5).
- `PUT /api/investments/txns/:id/lot-picks` (`SetLotPicksBody` → `SetLotPicksResponse`): the txn must be a `sell` or transfer-out (else 400 `not_a_sale`); each `openTxnId` must be an opening txn (buy/reinvest/transfer-in) of the same account and security (400 `pick_security_mismatch`); Σ quantity ≤ |sell quantity| (400 `picks_exceed_sale`); each pick ≤ the lot's quantity open as of the sale (400 `pick_exceeds_lot`, computed from a dry `buildLots` without this sale's picks); writes picks, audits (`lot_pick`, entity id = sell txn id, before/after = the pick lists), calls `rebuildLots` and returns the sell's warnings.
- `POST /api/investments/lots/rebuild` (`RebuildLotsBody` → `RebuildLotsResponse`): owner only; idempotent maintenance after a migration or bulk edit.
- Errors: `PlanError(status, code)` from the services, mapped by `toHttpError`.

## 5. UI
This area owns no page; the views/API/web area builds Portfolio, Allocation, Holdings, Performance and Income. What those pages need from this engine, and the one component that exists only because of it:
- **Performance page** (views area, `apps/web/src/pages/PerformancePage.tsx`): period picker (YTD, 1Y, 3Y, since inception, custom; presets map to `from` per D17), account multi-select, benchmark select (default from settings). Per account and total: start value, opening value (when the account entered mid-period: "entered at $1,000.00 on Jan 31"), contributions, withdrawals, growth; TWR (period; annualized only when `days ≥ 365`, else caption "not annualized"); XIRR (`period` for sub-year ranges, `annualized` otherwise); benchmark TWR/XIRR and the shadow value ("the same deposits in VTI would be worth …"); a method badge (`True TWR` / `Modified Dietz (approximate)`); the `statementCheck` line ("statement $1,057.50, securities $1,050.00, tracked cash $7.00, difference $0.50"); warnings as a yellow strip using the §4.2 strings. Failed metric → the card shows the reason text. Empty states: "No investment accounts yet" (no account of an investment type) / the `no_valuations` text. Error state: `ErrorText` as elsewhere. Rates render as `(x × 100).toFixed(2) + '%'`.
- **"How this was computed" expanders** (`detail=full`): the TWR sub-period table (from, to, begin, flow, end, rate, skipped/carried flags; "carried from {date}" when a boundary was not a snapshot date), the XIRR investor-flow list with the sign convention stated ("negative = money you put in"), the benchmark legs (date, amount, price used and its date, units), and the flow list with internal flows struck through and their reason. The chart (ECharts line via `components/charts/EChart.tsx`) plots the account's cumulative chain against the benchmark's price-relative line, with flow markers.
- **Holdings page**: `HoldingView` rows (quantity, price with its date, source and a "stale" marker, value, basis, unrealized with short/long split, "basis unknown" badge with the unknown quantity); for `positions` accounts the basis column shows `holding_snapshot.cost_basis_cents` with a "from statement" marker when present, else "—"; a row click opens the **Lots drawer** (open lots: acquired, quantity, basis, basis/share, value as of the price date, gain, term as of today; closed lots collapsed; the security's warnings).
- **Fidelity badge** (Accounts, Portfolio, Holdings): `Balance only` / `Positions` / `Full history` from `investmentHistory`, with a popover listing the `position_mismatch` lines ("VTI: lots sum to 60, the 2026-09-30 statement shows 100"), `oversell` and `basis_unknown` lines, each linking to the transactions, and an "Add opening position" action (creates a securities `transfer` with basis and acquired date through the import area's manual form).
- **Lot picker** (`components/investments/LotPickDialog.tsx`, this area): opened from a sell row of a `specific`-method account (and from the `needs_lot_pick` warning): lists the security's lots open as of the sale date with acquired date, quantity available, basis/share, estimated gain and term at the sale date; the user types quantities; validation mirrors the route; save calls `PUT …/lot-picks`; the sell row shows "Specific: 3 lots" or "FIFO (no picks)".
- **Realized gains report** (views area): one row per disposal (date, account, security, quantity, acquired, proceeds, basis, gain, term), totals short/long, unknown-basis rows flagged "basis unknown" and unmatched rows "no matching purchase", footer "Wash sales are not applied".
- **Income page**: month × (dividends, interest, fees, net) table with a "show reinvested separately" toggle (`reinvestedCents`), stacked bar per the `dataviz` conventions already used by the cash-flow chart; empty state "No dividends or interest recorded".
- **Account settings**: `investmentHistory` and `lotMethod` selects on `AccountsPage` (views area wires them; this area defines the fields). Settings page: the benchmark picker.

## 6. Jobs and services
No new job type; `JobType` is unchanged. Lots are rebuilt synchronously; performance, realized gains and income are computed per request (D27). The price-fetch job belongs to the prices area; the engine only reads `price`.

### 6.1 `packages/db/src/services/lots.ts`
- `loadInvestmentTxns(tx, accountId): Promise<InvestmentTxnInput[]>` — numerics parsed with `parseFixed8` (more than 8 decimals cannot occur: the column is `numeric(20,8)`).
- `rebuildLots(tx: DbOrTx, accountId: string): Promise<{ lots: number; disposals: number; warnings: EngineWarning[] }>` — loads the account's `investment_txn` (securities rows only) and `lot_pick`, runs `buildLots`, then in the same transaction `DELETE FROM lot_disposal WHERE account_id = $1; DELETE FROM lot WHERE account_id = $1;` and inserts the new rows (`lot.id` = opening txn id). Idempotent: running it twice yields identical rows (`rebuilt_at` aside). **Must be called by every writer of `investment_txn` for that account inside the same transaction** (import commit, manual create/update/delete, lot-pick change, SimpleFIN-derived rows): the import area's seam (§9). A failure (programming error only) rolls back with the caller's transaction, so stored lots never diverge from stored transactions.
- `setLotPicks(db, sellTxnId, picks, ctx: AuditContext)`, `listLots(db, query & { today })` (joins `security`, `account`, prices via the prices area's `latestPrices`; values and terms as of `asOf`; the position check from the latest `holding_snapshot` per account), `computeHoldings(db, { accountIds, asOf })` (lots + prices + cash → `HoldingResult[]`).
- `rebuildAllLots(db)` — every account with `investment_txn` rows, one transaction per account; used by `POST /api/investments/lots/rebuild` and after migrations.
- `listRealized(db, q)` from `lot_disposal`; `listIncome(db, q)` from `buildLots` per account.

### 6.2 `packages/db/src/services/performance.ts`
- `loadExternalFlows(db, accountId, from, to): Promise<ExternalFlowInput[]>` — the §3.8 derivation ((a) ledger transfers with `pairId = transfer_pair_id` and the pair's other leg as counterparty, (b) cash `investment_txn` transfers, (c) 3-day dedupe, ledger wins).
- `loadPerformanceInput(db, { from, to, asOf, accountIds, benchmarkSecurityId }): Promise<PerformanceInput>` — accounts with their history level and lot method; every account: flows; `full`: txns + picks + `cashAnchors` = `balance_snapshot` rows (`source <> 'computed'`) consisting of the latest on or before `from` plus all in `(from, to]` + `latestHoldingSnapshot`; `positions`/`balance`: `valuations` = the latest `balance_snapshot` on or before `from` (any age) plus all in `(from, to]` (fallback Σ `holding_snapshot.value_cents` per date when no balance snapshots exist); price series for every security held by a `full` account: the latest close on or before `from` plus all closes in `(from, to]` (sorted ascending, unique dates); benchmark series likewise. Investment accounts = `account.type IN ('brokerage','401k','ira','roth','hsa','529')` and not closed.
- `getPerformance(db, query): Promise<PerformanceResult>` — `computePerformance(await loadPerformanceInput(...))`; adds `statement_mismatch` warnings when `|statementCheck.differenceCents| ≥ 100`. Runs inline: 5 accounts × 3 years is sub-50 ms.
- `apps/api/src/views/investments.ts`: `toPerformanceView` stringifies every bigint and formats every Fixed8; `summary` detail empties `subPeriods`, `flows`, `lots`, `disposals`, `investorFlows` and `legs`.

### 6.3 Services this area calls (seams, §9)
`latestPrices`, `loadPriceSeries` (prices area); `getHouseholdSetting` (Phase 2) for `benchmark_security_id` and the timezone; `resolveToday` (API, Phase 2); `writeAudit`, `PlanError` (Phase 2).

### 6.4 Audit and failure handling
`investment_txn` manual writes (import area's route, this area's convention) and `lot_pick` writes use `writeAudit` with the API view as before/after; imports (bulk) are not audited (same as Phase 1 ledger imports; `import_log` is their record). Lots are derived and never audited. Engine warnings are returned, never thrown; `PlanError` for request problems; a `rebuildLots` exception fails the writing request with 500 and rolls back the write.

## 7. Test cases
Files: `packages/shared/src/fixed.test.ts`, `lots.test.ts`, `performance.test.ts`; integration cases in `packages/db/src/services/lots.test.ts` and `performance.test.ts` under `describe.skipIf(!TEST_DATABASE_URL)` using `createTestDb()` from `@meridian/db/testing`.

Notation: quantities in shares, cents as integers, rates as decimals; "→" means expected. Dates are 2026 unless written. Every buy/sell input below carries `feeCents` so that `amount_cents = ∓(gross ± fee)` reconciles exactly; "no warnings" includes no `amount_mismatch`.

### TC1. Fixed8 rounding rules (R1–R3, R5)
INPUT/EXPECTED: `mulQtyPrice(10.5, 123.456789)` → 129630; `(0.33333333, 300)` → 10000; `(−2.5, 1.01)` → −253; `(2.5, 1.01)` → 253; `(1, 0.005)` → 1; `(1, 0.00499999)` → 0; `(2.33333333, 6.01)` → 1402; `(3.5, 101.33)` → 35466; `(0.25, 55)` → 1375. `divCentsByPrice(100000, 33.333333)` → 30.00000030; `(100000, 3)` → 333.33333333. `basisPerShare(100495, 100)` → 10.04950000; `(24000, 20)` → 12.00000000; `(10000, 3)` → 33.33333333; `(1400, 2.33333333)` → 6.00000001. `roundDivHalfAway(7,2)` → 4, `(−7,2)` → −4, `(5,4)` → 1, `(6,4)` → 2; `(1, 0n)` throws. `scaleQty(15, 1, 10)` → 1.50000000; `scaleQty(7, 1, 3)` → 2.33333333. `parseFixed8("123.4")` → 12340000000n, `formatFixed8` → "123.40000000"; `parseFixed8("1.123456789")` throws.

### TC2. FIFO across two lots with commissions, proceeds split by largest remainder
INPUT: b1 buy 100 VTI @ 10 on 2025-03-03, fee 495, amount −100495; b2 buy 50 @ 12 on 2025-09-10, fee 0, amount −60000; s1 sell −120 @ 15 on 2026-04-01, fee 5, amount +179995. `lotMethod = fifo`.
EXPECTED: disposals `[ {s1, lot b1, sell, 100, proceeds 149996, basis 100495, gain 49501, long, acquired 2025-03-03}, {s1, b2, sell, 20, proceeds 29999, basis 24000, gain 5999, short} ]`; lots: b1 `{id b1, openedBy buy, quantity 0, costBasis 0, closedDate 2026-04-01}`, b2 `{quantity 30, costBasis 36000, original 50 / 60000}`; position VTI after s1 = 30; cashEffects `[−100495, −60000, +179995]`; no warnings. Variant: b1 with `feeCents null` → identical lots and disposals plus warning `{amount_mismatch, b1, diffCents −495}`.

### TC3. Specific identification with a partial FIFO remainder; `specific` without picks warns
INPUT: TC2 with `lotMethod = specific` and picks for s1: `[ {b2, 50, position 0} ]`.
EXPECTED: disposals `[ {b2, 50, proceeds 74998, basis 60000, gain 14998, short}, {b1, 70, proceeds 104997, basis 70347, gain 34650, long} ]`; lots: b2 closed; b1 `{quantity 30, costBasis 30148}`. Same input with no picks → identical disposals to TC2 plus warning `{needs_lot_pick, txnId s1}`. Pick `{b2, 60}` → capped at 50 with `pick_exceeds_lot`; pick `{b2, 50}` plus `{b1, 100}` → b1 capped at 70 with `pick_exceeds_sale`.

### TC4. Forward split, reverse split and a fractional lot
INPUT: b1 buy 10 AAA @ 100 on 2025-03-03 (−100000); sp split 3/2 on 2025-06-01; b2 buy 5 @ 70 on 2025-08-01 (−35000); s1 sell −12 @ 80 on 2026-07-01 (+96000).
EXPECTED: position after sp = 15.00000000; after b2 = 20; b1 after sp `{quantity 15, costBasis 100000, originalQuantity 10}`; disposal `{s1, b1, 12, proceeds 96000, basis 80000, gain 16000, long}` (round(100000 × 12/15) = 80000); lots after: b1 `{3, 20000}`, b2 `{5, 35000}`. Separately: 15 sh then split 1/10 → `{1.50000000, basis unchanged 3000}`; 7 sh then split 1/3 → `{2.33333333, 1400}`; a closed lot is not scaled.

### TC5. Reinvested dividend opens a lot, counts as income, and is sold FIFO after the original lot
INPUT: b1 buy 100 FND @ 20 on 2025-01-15 (−200000); d1 reinvest 2.5 @ 20.4 on 2025-03-31, amount 5100; d2 dividend 5200 FND on 2025-06-30; i1 interest 123 on 2025-06-30 (seq 1, securityId null); f1 fee −2500 on 2025-07-01 (securityId null); s1 sell −101 @ 22 on 2026-02-02 (+222200).
EXPECTED: lots: b1 closed 2026-02-02; d1 `{openedBy reinvest, acquired 2025-03-31, original 2.5 / 5100, quantity 1.5, costBasis 3060}`. Disposals: `{b1, 100, proceeds 220000, basis 200000, gain 20000, long}`, `{d1, 1, proceeds 2200, basis 2040, gain 160, short}` (2025-03-31 + 12 m = 2026-03-31 > 2026-02-02). Income rows `(month, security)`: `{2025-03, FND, dividends 5100, reinvested 5100}`, `{2025-06, null, interest 123}`, `{2025-06, FND, dividends 5200, reinvested 0}`, `{2025-07, null, fees 2500}`. cashEffects: `[2025-01-15 −200000, 2025-06-30 +5200, 2025-06-30 +123, 2025-07-01 −2500, 2026-02-02 +222200]` (the reinvest has none). No warnings.

### TC6. Transfer in with carried basis and date; sale uses the carried date; transfer out disposes without gain and reports the carried lots
INPUT: t1 transfer +40 VXUS on 02-01, `basisCents 200000, basisAcquiredDate 2024-01-15`, price 60; b1 buy 10 @ 61 on 02-15 (−61000); s1 sell −10 @ 62 on 03-01 (+62000); t2 transfer −35 on 04-01 (price 63).
EXPECTED: t1 lot `{openedBy transfer_in, acquired 2024-01-15, basisKnown true}`. Disposals: `{s1, t1, sell, 10, 62000, basis 50000, gain 12000, long}`; `{t2, t1, transfer_out, 30, proceeds 0, basis 150000, gain 0, term none}`; `{t2, b1, transfer_out, 5, 0, 30500, 0, none}`. `transferredOut = [ {t2, 2024-01-15, 30, 150000, known}, {t2, 2026-02-15, 5, 30500, known} ]`. Lots after: t1 closed 04-01; b1 `{5, 30500}`. No warnings. Securities flows: see TC23.

### TC7. Transfer in without basis
INPUT: t1 transfer +40 X on 02-01, basis null; s1 sell −10 @ 62 on 03-01 (+62000).
EXPECTED: lot `{acquired 2026-02-01, basis 0, basisKnown false}` with warning `{basis_unknown, t1}`; disposal `{s1, t1, sell, 10, proceeds 62000, basis 0, gain 62000, term unknown, basisKnown false}`; realized summary routes it to `unknownBasis {proceeds 62000, quantity 10, count 1}` and short/long totals stay 0; gain summary `unknownBasisProceedsCents 62000, realizedCents 0`; holdings as of 03-02 at any price: `unrealizedCents null`, `unknownBasisQuantity 30`.

### TC8. Oversell
INPUT: b1 buy 20 X @ 10 on 01-05 (−20000); s1 sell −30 @ 11 on 03-01 (+33000).
EXPECTED: disposals `{s1, b1, sell, 20, proceeds 22000, basis 20000, gain 2000, short}`, `{s1, lot null, unmatched_sell, 10, proceeds 11000, basis 0, gain 11000, unknown, basisKnown false}` (33000 over [20, 10] = [22000, 11000] exactly); warning `{oversell, s1, quantity 10}`; position 0 (not −10); b1 closed 03-01; no `amount_mismatch` (30 × 11 = 33000).

### TC9. Holding-period boundaries
EXPECTED: `isLongTerm(2025-02-05, 2026-02-05)` → false; `(2025-02-05, 2026-02-06)` → true; `(2024-02-29, 2025-02-28)` → false; `(2024-02-29, 2025-03-01)` → true; `(2025-01-31, 2026-01-31)` → false; `(2025-01-31, 2026-02-01)` → true. A lot acquired 2025-03-03 sold 2026-04-01 → long (TC2); acquired 2025-03-31 sold 2026-02-02 → short (TC5); acquired 2025-01-15 sold 2026-01-15 → short (TC30).

### TC10. Income by month across securities, account-level rows and reinvested sub-totals
INPUT: d1 dividend 4321 VTI on 03-25; d2 reinvest 0.5 VXUS @ 60 on 03-27, amount 3000; i1 interest 77 on 03-31 (securityId null); d3 dividend 4400 VTI on 06-25; f1 fee −1250 on 06-30 (securityId null).
EXPECTED: rows `[ {2026-03, null, interest 77}, {2026-03, VTI, dividends 4321, reinvested 0}, {2026-03, VXUS, dividends 3000, reinvested 3000}, {2026-06, null, fees 1250}, {2026-06, VTI, dividends 4400} ]`; account months `[ {2026-03, dividends 7321, interest 77, fees 0, reinvested 3000, net 7398}, {2026-06, 4400, 0, 1250, 0, net 3150} ]`; lot d2 `{0.5, basis 3000}`. Period `[2026-04, 2026-06]` → only the June month. The income route returns exactly these rows (TC26).

### TC11. XIRR, Microsoft's documented example
INPUT: `xirr([ {2008-01-01, −1000000}, {2008-03-01, +275000}, {2008-10-30, +425000}, {2009-02-15, +325000}, {2009-04-01, +275000} ])` (cents).
EXPECTED: rate 0.373362533 (assert `|x − 0.373362535| < 1e−7`, Excel's published figure); bracket [0.3, 0.5]; no warnings.

### TC12. XIRR arithmetic identities
EXPECTED: `[−10000000 @ 2025-10-14, +20000000 @ 2026-10-14]` → exactly 1.0 (grid hit at r = 1, 0 iterations); `[−10000000 @ 2024-10-14, +20000000 @ 2026-10-14]` → 0.414213562 (√2 − 1, 730 days; `|Δ| ≤ 1e−9`); `[−10000000 @ 2025-10-14, −5000000 @ 2026-04-14, +20000000 @ 2026-10-14]` → 0.406700659 (t = 182/365 for the second flow); `[−10000000 @ 2026-01-01, +11000000 @ 2026-07-01]` (181 days) → annualized 0.211912980 and `period = (1.211912980)^(181/365) − 1 = 0.100000000` (`|Δ| ≤ 1e−9`); `[−10000000, +5000000]` one year → exactly −0.5 (grid hit).

### TC13. XIRR failure modes and multiple roots
EXPECTED: `[−10000000 @ 01-01, −500000 @ 07-01, 0 @ 12-31]` → `{rate null, reason no_sign_change}`; a single flow → `too_few_flows`; `[−10000000 @ 2025-10-14, +1 @ 2026-10-14]` (total loss, root at −0.9999999) → `no_bracket`; `[−10000000 @ 2025-01-01, +23000000 @ 2025-07-01, −13200000 @ 2026-01-01]` → brackets [0.15, 0.2] and [0.5, 0.75], chosen 0.177964560 (nearest 0.1), warning `multiple_roots` (f(0.1) = −617.69, f(0.15) = −183.28, f(0.2) = +117.69, f(0.5) = +107.40, f(1) = −2901.51 dollars; the other root is 0.528672073).

### TC14. True TWR, XIRR and benchmark for a full account funded at inception
INPUT: account A `full`, no balance snapshots: contributions +100000 on 01-02 and +60000 on 02-01 (cash flows, counterparty null); txns b1 buy 100 VTI @ 10 on 01-02 (−100000), b2 buy 50 @ 12 on 02-01 (−60000); VTI closes 01-02: 10, 01-31: 12, 02-01: 12, 02-28: 11; benchmark closes 01-01: 100, 01-02: 100, 01-31: 110, 02-01: 110, 02-28: 105; `from 2026-01-01, to 2026-02-28`.
EXPECTED: V(01-01) 0, V(01-02) 100000, V(01-31) 120000, V(02-01) 180000, V(02-28) 165000 (cash anchor null throughout). `startValueCents 0, endValueCents 165000, openingValue null, contributions 160000, withdrawals 0, growth 5000`. TWR subPeriods `[ {01-01→01-31, begin 0, flow 100000, end 120000, 0.2}, {01-31→02-28, 120000, 60000, 165000, −0.0833333333} ]`, rate 0.1 (`|Δ| ≤ 1e−12`), annualized null, days 58, method `true_twr`. Investor flows `[0 @ 01-01, −100000 @ 01-02, −60000 @ 02-01, +165000 @ 02-28]` → xirr annualized 0.277776955, investedDays 57, period 0.039021388. Benchmark: legs `[ {01-01, 0, 100, 0}, {01-02, 100000, 100, 10.00000000}, {02-01, 60000, 110, 5.45454545} ]`, units 15.45454545, shadowValueCents 162273, twr 0.05, xirr annualized 0.119029889 (period 0.017717710). Same input with `from 2026-01-31`: TWR −0.0833333333 (one sub-period), xirr annualized −0.682708917 (period 28 d −0.084294818), benchmark units 10.90909091 + 5.45454545 = 16.36363636, shadow 171818, benchmark twr 105/110 − 1 = −0.0454545455, benchmark xirr −0.458680728. Valuation at 01-20 adds `stale_price` (close 01-02, 18 days); at 01-31 none.

### TC15. Flow dated `from` is excluded; flow dated `to` is counted with its boundary at `to − 1`
INPUT: account `full`: b1 buy 10 P @ 100 on 01-10 (−100000) funded by +100000 on 01-10; contributions +50000 on 01-31 and +10000 on 02-28; P closes 01-10: 100, 02-27: 110, 02-28: 120; period 01-31 → 02-28.
EXPECTED: V(01-31) = 50000 cash + 10 × 100 = 150000 (the 01-31 contribution is inside the start value, not a period flow); V(02-27) 160000; V(02-28) = 60000 + 120000 = 180000. subPeriods `[ {01-31→02-27, 150000, 0, 160000, 0.0666666667}, {02-27→02-28, 160000, 10000, 180000, 0.0588235294} ]`; TWR 0.129411765; flows in the response: only the 02-28 one; xirr annualized 4.112001296, period (28 d) 0.133333333. Cash-only variant (no positions; +999999 on 01-31, +10000 on 02-28): TWR exactly 0 with two sub-periods of rate 0.

### TC16. Modified Dietz for a balance-only account, carried starts, and the opening value
INPUT: `history balance`, valuations 01-31: 100000, 02-28: 130000, 03-31: 105000; flows +20000 on 02-10, −30000 on 03-31.
EXPECTED: period 01-31 → 02-28: one sub-period, weightedFlowDollars 135.714285714, rate 0.088050314, method `modified_dietz`, annualized null. Period 01-31 → 03-31: sub-periods 0.088050314 and 0.03875 (weighted −9.677419355), chain 0.130212264, days 59; xirr `[−100000 @ 01-31, −20000 @ 02-10, +30000 @ 03-31, +105000 @ 03-31]` → annualized 1.116267732, period 0.128824644; growth = 105000 − 100000 − (−10000) = 15000. Period 02-05 → 02-28 (start carried from 01-31): D = 23, weight 19/23 (weighted 165.217391304), rate 0.085820896, `beginCarried true`, warning `valuation_carried`. **Period 01-01 → 02-28 (no valuation ≤ 01-01, single-account request):** `openingValue {01-31, 100000}`, flows `[ {01-31, +100000, opening_value}, {02-10, +20000, cash} ]`; sub-periods `{01-01→01-31, begin 0, flow 100000 (weighted 33.333333333), end 100000, rate 0}`, `{01-31→02-28, 100000, 20000 (135.714285714), 130000, 0.088050314}`; TWR 0.088050314; `startValueCents 0`, contributions 20000, growth 130000 − 0 − 20000 − 100000 = 10000; xirr investor flows `[0 @ 01-01, −100000 @ 01-31, −20000 @ 02-10, +130000 @ 02-28]` → annualized 2.030024781, investedDays 28, period 0.088761757 (identical to C's figures inside TC24's total). Variant with an extra +5000 ledger transfer on 01-15: it is folded (`internal true, before_first_valuation`), every figure above unchanged. Period 01-01 → 01-20 (no valuation ≤ 01-20) → twr `{null, no_valuations}`, xirr `{null, no_valuations}`.

### TC17. Household total: a transfer between two full accounts is internal to the total
INPUT: A `full`: flows +100000 on 01-02 (external), −50000 on 02-01 (`counterpartyAccountId B, pairId p1`); txns buy 100 VTI @ 10 on 01-02, sell −50 @ 12 on 02-01 (+60000). B `full`: flow +50000 on 02-01 (`counterparty A, pairId p1`); txn buy 10 VXUS @ 50 on 02-02 (−50000). Closes VTI 01-02: 10, 01-31: 12, 02-01: 12, 02-28: 13; VXUS 02-02: 50, 02-28: 55. Period 01-01 → 02-28, `accountIds [A, B]`.
EXPECTED: A values 01-31: 120000, 02-01: 70000 (cash 10000 + 50 × 12), 02-28: 75000; A TWR sub-periods 0.2 and 0.0714285714 → 0.285714286; A xirr 4.926841465 (period 57 d: 0.320345154). B values 02-01: 50000, 02-28: 55000; B sub-periods: `{01-01→01-31 skipped}`, `{01-31→02-28, 0, 50000, 55000, 0.1}` → TWR 0.1; B xirr 2.627168915 (period 27 d: exactly 0.1 within 1e−9). Total: flows = only `+100000 on 01-02` (both transfer legs `internal: true, counterparty_in_total`; `excludedInternalFlows 2`); V_T 01-31: 120000, 02-28: 130000; one sub-period `{01-01→02-28, 0, 100000, 130000, 0.3}` → TWR 0.3, method `true_twr`; total xirr 4.365834284 (period 0.3 within 1e−9); total contributions 100000, withdrawals 0, `partialGains false`.

### TC18. Holdings and unrealized gains as of a date with short/long split and an unknown-basis lot
INPUT: b1 buy 100 VTI @ 10 on 2025-03-03 (fee 495, −100495); b2 buy 50 VTI @ 12 on 2026-05-10 (−60000); b3 transfer +40 VXUS on 2026-02-01 without basis; closes 2026-10-13: VTI 15.25, VXUS 62.5; `asOf 2026-10-14`.
EXPECTED: lots: b1 value 152500, unrealized 52005, long, basisPerShare 10.04950000; b2 value 76250, unrealized 16250, short, 12.00000000; b3 value 250000, unrealized null, term unknown, basisPerShare null. Holdings: VTI `{quantity 150, value 228750, costBasis 160495, unrealized 68255, short 16250, long 52005, unknownBasisQuantity 0, lotCount 2, priceDate 2026-10-13, priceSource price, stale false}`; VXUS `{40, 250000, costBasis null, unrealized null, 0, 0, unknownBasisQuantity 40, 1}`; cash line `{securityId null, value −160495}` when no contributions were recorded (the test adds +160495 of flows so cash is 0 and the account value is 478750). Gain summary: `unrealizedCents 68255`, `openValueCents 478750`, `openBasisCents 160495`, `originalBasisCents 160495`, `unpricedSecurityIds []`.

### TC19. Empty stretch before the first contribution is skipped; a value appearing without a flow is an error
INPUT: (a) flow +100000 on 03-01; buy 100 VTI @ 10 on 03-01; closes 03-01: 10, 03-31: 10.5; period 01-01 → 03-31. (b) a value function 0 on 01-01 and 5000 from 02-01 with no flows, period 01-01 → 02-28 (true-TWR helper called directly with `valueAt`).
EXPECTED: (a) sub-periods `{01-01→02-28 skipped (0, 0, 0)}`, `{02-28→03-31, 0, 100000, 105000, 0.05}`; TWR 0.05, days 89, `skipped 1`; xirr annualized 0.810519216 (= 1.05^(365/30) − 1), investedDays 30, period 0.05 (`|Δ| ≤ 1e−9`). (b) `trueTwr` → `{rate null, reason zero_denominator, reasonDate 2026-01-01}`.

### TC20. Determinism: input order, same-day sequencing, type rank and FIFO ties
INPUT: txns given as `[z-sell (01-05, seq 1, −5 @ 10, +5000), a-buy (01-05, seq 0, +5 @ 9, −4500), m-buy (01-04, seq 7, +1 @ 8, −800)]` and the same array reversed.
EXPECTED: processing order `[m-buy, a-buy, z-sell]`; disposals `{z-sell, m-buy, 1, proceeds 1000, basis 800, gain 200, short}`, `{z-sell, a-buy, 4, 4000, 3600, 400, short}`; both input orders produce deep-equal results. Rank case: the same with `z-sell seq 0` and `a-buy seq 1` → identical (buy ranks before sell regardless of `seq`). Tie case: lots `b` (01-05 seq 0, 5 @ 9 for 4500) and `a` (01-05 seq 1, 5 @ 10 for 5000), sell 5 @ 11 on 02-05 for 5500 → consumes `b` (earlier opening), gain 1000. Running `computePerformance` twice on the same input returns deep-equal results; an unsorted `prices[].points` series throws; shuffling `accounts` and `flows` does not change any number.

### TC21. Price fallback chain and staleness in valuation
INPUT: contribution +25500 on 01-15; buy 10 CT1 @ 25.5 on 01-15 (−25500); valuation at 02-10 with (a) no price series, (b) closes 02-01: 26 and 02-11: 27, (c) only 02-11: 27; (d) valuation at 01-01.
EXPECTED: (a) 25500 with warnings `{price_from_txn, CT1, 02-10}` and `{stale_price, CT1, 02-10, priceDate 01-15}`; (b) 26000 with `stale_price` (9 days; no `price_from_txn`); (c) 25500 with `price_from_txn` and `stale_price`; (d) 0 with no holdings. A security with neither closes nor priced transactions → 0 for it plus `no_price`. Staleness boundary with a single close on 01-02: valued on 01-09 → no warning (7 days), on 01-10 → `stale_price` (8 days).

### TC22. Largest-remainder allocation helper
EXPECTED: `allocateLargestRemainder(179995, [100, 20])` → [149996, 29999]; `(100, [1,1,1])` → [34, 33, 33]; `(10, [1,1,1,1])` → [3, 3, 2, 2]; `(0, [3, 7])` → [0, 0]; `(−179995, [100, 20])` → [−149996, −29999]; `(174900, [20, 5])` → [139920, 34980]; `(5, [0, 0])` throws; every result sums to the input.

### TC23. Securities transfer valued at market on its date; unpriced → 0
INPUT: t1 transfer +40 VXUS on 02-01 (basis 200000 carried, no txn price) with closes 01-30: 60.5 and 02-02: 61; variant with txn price 59; variant with no price anywhere.
EXPECTED: flow `{02-01, +242000, securities}` (40 × 60.5, carried from 01-30; the 02-02 close is never used); with the txn price: `+236000`; with no price: `+0` plus warning `{securities_flow_unpriced, t1}`, and the position is valued 0 with `no_price` on every date until a close exists, so TWR sub-periods containing only this security are skipped and no gain or loss is invented. Transfer-out variant (−40 on 04-01 at close 63) → `{04-01, −252000, securities}`.

### TC24. Mixed household total: a full account plus a balance-only account that enters after `from`
INPUT: A = TC14's account; C `balance` with valuations 01-31: 100000, 02-28: 130000 and a +20000 contribution on 02-10; period 01-01 → 02-28, `accountIds [A, C]`.
EXPECTED: C gets `opening_value +100000 on 01-31`; C's own block equals TC16's last case (TWR 0.088050314, xirr 2.030024781, growth 10000). Total: method `modified_dietz`; boundaries 01-01, 01-31, 02-28; V_T 0 / 220000 / 295000; sub-period 1: ΣCF 200000, weighted 1000 × 30/30 + 1000 × 1/30 = 1033.333, rate (2200 − 2000)/1033.333 = 0.193548387 (computed, not skipped); sub-period 2: ΣCF 80000, weighted 600 + 200 × 19/28 = 735.714, rate (2950 − 2200 − 800)/(2200 + 735.714) = −0.017031630; chain 0.173220312; total xirr annualized 0.660047882 (period 57 d: 0.082368140); total `openingValue {01-31, 100000}`, contributions 180000, `partialGains true`; A's Dietz over the same boundaries equals its true TWR 0.1 (sanity: `|Δ| ≤ 1e−12`).

### TC25. Annualization rule
EXPECTED: `annualize(0.10, 365)` → 0.10; `annualize(0.21, 730)` → 0.10 (`|Δ| ≤ 1e−12`); `annualize(0.10, 366)` → 0.099713586; `annualize(0.10, 364)` → null; TC14's 58-day TWR has `annualized null`; TC16's 59-day XIRR reports `annualized 1.116267732` (XIRR is annual by definition) and the UI shows `period`.

### TC26. Service integration (`packages/db`, skipped without `TEST_DATABASE_URL`)
INPUT: insert TC2's rows into `investment_txn` for a brokerage account; `rebuildLots`; set picks as in TC3 through `setLotPicks`; rebuild again; then delete s1 and rebuild; seed TC10's rows in a second account.
EXPECTED: after the first rebuild `lot` has 2 rows with `id ∈ {b1, b2}` (b1 closed, b2 30/36000) and `lot_disposal` 2 rows with TC2's numbers; `rebuildLots` twice → identical rows (`rebuilt_at` aside); after picks: `lot_disposal` rows match TC3, `lot.id` values unchanged, and `audit_log` has one `lot_pick` entry with the batch id; `PUT …/lot-picks` with `{b2, 60}` → 400 `pick_exceeds_lot`, with `{b1, 10}` on the second account's d2 (a reinvest, not a sale) → 400 `not_a_sale`; after deleting s1: no disposals, b1 `{100, 100495}` and b2 `{50, 60000}` open; `GET /api/investments/realized` equals the engine's disposals; `GET /api/investments/income?from=2026-03&to=2026-06` for the second account returns TC10's rows; `POST /api/investments/performance` with `{ accountIds: [first], from: 2025-12-31, to: 2026-10-14, today: 2026-10-14 }` returns `method true_twr` and the holdings of TC18 when its prices are seeded, makes **zero writes** (row counts of every table equal before and after), and succeeds for the viewer role; `from ≥ to` → 400 `validation`; `to` after `today` → 400 `validation`; a checking account in `accountIds` → 400 `bad_request`.

### TC27. External-flow loader
INPUT: a brokerage account with ledger rows: +100000 on 01-02 `is_transfer` paired with checking (`transfer_pair_id p1`); +5000 on 01-15 `is_transfer` (rule-marked "401k contribution", no pair); a +4321 dividend row (not a transfer); a pending +20000 transfer on 02-27; and `investment_txn` cash transfers +100000 on 01-03 (security null) and +7000 on 02-10.
EXPECTED: `loadExternalFlows(01-01 → 02-28)` → `[ {01-02, +100000, cash, counterparty = checking id, pairId p1}, {01-15, +5000, cash, null, null}, {02-10, +7000, cash, null, null} ]`: the 01-03 CSV row is dropped as a duplicate of the 01-02 ledger transfer (equal amount within 3 days), the dividend is income, the pending row is ignored.

### TC28. Amount resolution: null amount, fee in basis, mismatch tolerance
INPUT: b1 buy 3.5 X @ 101.33, fee 199, amount null on 01-15; b2 buy 1 @ 100.00, fee 0, amount −10100 on 01-16; s1 sell −1 @ 100.00, fee 0, amount +9997 on 01-20; r1 reinvest 0.25 Y @ 55, amount null on 01-21; s2 sell −1 Z on 02-01 with neither price nor amount (after a buy of 1 Z for −1000 on 01-01).
EXPECTED: b1 gross 35466, amount −35665, basis 35665, cash −35665; b2 expected −10000 vs −10100 → warning `{amount_mismatch, b2, diffCents −100}`, basis 10100 (amount wins); s1 expected 10000 vs 9997, diff −3 ≤ 5 → no warning; FIFO b1: basis `roundDivHalfAway(35665 × 1, 3.5) = 10190`, proceeds 9997, gain −193, short; lots after: b1 `{2.5, 25475}`, b2 `{1, 10100}`; r1 lot `{0.25, basis 1375}` and income `{2026-01, Y, dividends 1375, reinvested 1375}`; s2 → warning `{amount_missing, s2}`, disposal with proceeds 0, basis 1000, gain −1000 (an engine-level case only: the `investment_txn_shape` CHECK rejects such a row at the DB, so the service path can never produce it).

### TC29. Same-day split listed after a same-day buy is still applied first
INPUT: b1 buy 10 A @ 300 on 2025-01-15 (−300000); b2 buy 5 @ 150 on 2025-06-10, `seq 0` (−75000); sp split 2/1 on 2025-06-10, `seq 1` (the file lists the buy before the split); s1 sell −22 @ 160 on 2025-07-01 (+352000).
EXPECTED: processing order `[b1, sp, b2, s1]`; after 06-10: b1 20 / 300000, b2 5 / 75000 (not scaled), position 25; sell: `{b1, 20, proceeds 320000, basis 300000, gain 20000, short}`, `{b2, 2, 32000, 30000, 2000, short}`; lots after: b1 closed, b2 `{3, 45000}`; position 3. (Under pure `(date, seq, id)` order b2 would have been scaled to 10 and the position would end at 8.)

### TC30. Gain summary: realized + unrealized reconciles to the cent on a mixed history
INPUT: b1 buy 10 A @ 100 on 2025-01-15 (−100000); b2 buy 10 @ 120 on 2025-06-15 (−120000); r1 reinvest 0.5 @ 125 amount 6250 on 2025-09-15; sp split 2/1 on 2025-10-01; s1 sell −25 @ 70, fee 100, amount +174900 on 2026-01-15; t1 transfer −6 (price 72) on 2026-02-01; close 75 on 2026-03-01; `asOf 2026-03-01`.
EXPECTED: after the split b1 20, b2 20, r1 1. Sell: proceeds 174900 over [20, 5] → [139920, 34980]; `{b1, 20, 139920, basis 100000, gain 39920, short}` (2026-01-15 is exactly one year after 2025-01-15), `{b2, 5, 34980, basis 30000, gain 4980, short}`. Transfer out: `{b2, 6, transfer_out, basis 36000, gain 0, none}`. Lots: b1 closed, b2 `{9, 54000}`, r1 `{1, 6250}`. Summary: realizedShort 44900, realizedLong 0, unknownBasisProceeds 0, unrealized 13500 + 1250 = 14750, total **59650**, proceeds 174900, basisConsumed 130000, transferredOutBasis 36000, openValue 75000, openBasis 60250, originalBasis 226250, `unpricedSecurityIds []`; identity `75000 + 174900 + 36000 − 226250 = 59650` ✓; basis conservation `60250 + 130000 + 36000 = 226250` ✓. No warnings (25 × 70 − 100 = 174900).

### TC31. Position check against the latest statement
INPUT: lots give VTI 60 and BND 10.0005 as of 2026-09-30; (a) statement 2026-09-30: VTI 100, BND 10; (b) statement: VTI 60, BND 10.002, VXUS 5.
EXPECTED: (a) one warning `{position_mismatch, VTI, lotsQuantity 60, snapshotQuantity 100, date 2026-09-30}` (BND differs by 0.0005 ≤ 0.001); (b) `{position_mismatch, BND, 10.0005, 10.002}` and `{position_mismatch, VXUS, 0, 5}`. `account.investment_history` is unchanged by either.

### TC32. Anchored cash and the statement check
INPUT: `full` account: flow +100000 on 01-02; b1 buy 100 VTI @ 10 on 01-02 (−100000); d1 dividend +500 on 01-20; closes 01-02: 10, 01-10: 10.1, 01-31: 10.5; `balance_snapshot` 01-10: 101200 (source simplefin), 01-31: 105750; period 01-01 → 01-31.
EXPECTED: V(01-01) 0; V(01-05) 100000 (anchor null); V(01-10) 101200 (anchor 01-10; securities 101000, cash 200); V(01-20) 101700 (securities 101000 with `stale_price` priceDate 01-10, cash 200 + 500); V(01-30) 101700; V(01-31) 105750 (anchor 01-31; securities 105000, cash 750). Without snapshots V(01-20) = 101500 and V(01-31) = 105500. TWR: one sub-period `{01-01→01-31, 0, 100000, 105750, 0.0575}`; xirr annualized 1.021146698, investedDays 29, period 0.0575 (`|Δ| ≤ 1e−9`). `statementCheck(01-31) = {statement 105750, securities 105000, impliedCash 750, trackedCash 700, trackedFrom 01-10, difference 50}` → no `statement_mismatch` (< 100); `statementCheck(01-10) = {101200, 101000, 200, 0, inception, 200}` → `statement_mismatch`. Holdings as of 01-31: cash line 750.

### TC33. XIRR with a contribution, a withdrawal and a loss; a withdrawal larger than the start
INPUT: (a) V(01-01) 1000000, +200000 on 03-01, −300000 on 09-01, V(12-31) 850000. (b) V(01-01) 1000000, −1200000 on 06-01, V(12-31) 0.
EXPECTED: (a) investor flows `[−1000000, −200000, +300000, +850000]`, annualized −0.046990268 (bracket [−0.1, 0]), investedDays 364, period −0.046864593. (b) annualized 0.553811660 (a withdrawal larger than the start is a valid positive IRR), no `multiple_roots`.

### TC34. Property-based invariants (seeded generator, no library: a 32-bit LCG in the test file, 500 histories, seed logged on failure)
INPUT: random histories of 1–60 transactions over 1–3 securities: buys (qty 0.001–500, price 0.5–900, fee 0–999, amount derived or given consistently), sells bounded by the current position (with a 10% chance of picks drawn from open lots), reinvests, dividends, interest, fees, splits (ratios from {1:2, 2:1, 1:3, 3:2, 1:10}), transfers in (always with basis) and out; random positive closes for every security on the last date.
EXPECTED for every history: (1) Σ open lot quantity per security = the last position checkpoint = Σ(ins) − Σ(outs) split-adjusted; (2) Σ open basis + Σ consumed basis (sales and transfers out) = Σ original basis; (3) `realizedCents + unrealizedCents = openValueCents + proceedsCents + transferredOutBasisCents − originalBasisCents` exactly; (4) no `oversell`, `amount_mismatch` or `amount_missing` warning and no negative quantity or basis; (5) any permutation of the input gives a deep-equal result; (6) XIRR: scaling every flow and value by k > 0 leaves `annualized` unchanged within 1e−9, and a history of one start value and one end value satisfies `annualized = (end/start)^(365/days) − 1` within 1e−9; (7) true TWR: inserting a boundary at a non-flow date whose valuation is the carried value leaves the rate unchanged within 1e−12; (8) Modified Dietz on a daily-valued account with flows equals true TWR within 1e−12 when a boundary exists at every flow.

## 8. Deviations from the spec (flagged)
1. **`interest` added to `investment_txn.type`** (spec: buy, sell, dividend, reinvest, fee, split, transfer). Reason: the Income view is "dividends and interest by month"; folding interest into `dividend` would misreport both. A spec-enum change for the phase lead to accept (Design B derived it from the security type instead; the explicit type was kept because a brokerage's cash-sweep interest has no security).
2. **Columns beyond the spec's row**: `seq`, `fee_cents`, `split_numerator/denominator`, `basis_cents`, `basis_acquired_date`, `counterpart_txn_id`, `ledger_transaction_id`, `external_id`, `source`, `import_log_id`; `amount_cents` nullable. Reasons: same-day ordering, commissions reconcilable, ratio-based splits, IRS carryover basis, paired in-kind legs, no double counting with the ledger, idempotent imports (Phase 1 pattern), amounts the file did not carry.
3. **Tables beyond the spec**: `lot_pick` (specific identification needs user input per sale), `lot_disposal` (realized gains need the per-lot record; the spec's `lot` row cannot hold them). `lot` itself gains remaining/original columns and flags, and its id is the opening transaction's id.
4. **`account.investment_history` and `account.lot_method`, `household_setting.benchmark_security_id`**: the spec says each account "shows which level it has" and "FIFO by default, specific-lot optional", and the Performance view compares with "a chosen benchmark index fund"; these are the columns that make those choices persistent.
5. **Wash sales are not computed** (the spec does not ask; stated so nobody assumes 1099-B parity).
6. **Return of capital and capital-gain distributions** are not special-cased: a return of capital imported as `dividend` overstates income and leaves basis unreduced (IRS: basis reduction). Open question 4.
7. **Money-weighted return for sub-year periods** is shown unannualized (`period`), whereas Excel's XIRR is always annual. Both are returned; the spec's "money-weighted return (XIRR)" is the annualized field.
8. **OFX/QFX**: the spec's data-sources table lists it under Phase 3 while its build-phase list puts it under Polish (Phase 6). Treated as out of scope here; the engine input (`InvestmentTxnInput`) and the `source` enum (`ofx`) are shaped so an OFX adapter only maps `INVBUY/INVSELL/INCOME/REINVEST/SPLIT/TRANSFER` records into the same rows. Conflict flagged for the phase lead.
9. **Positions-level cost basis** (`holding_snapshot.cost_basis_cents`) is stored by the import area and shown "from statement" by the Holdings page but not used by this engine; the spec grants gains only at the full-history level.
10. **Benchmark is price-only unless the prices area supplies adjusted closes**: distributions are not reinvested, so a raw-close benchmark understates a dividend-paying fund by its yield; the UI labels it (open question 3).
11. **A POST for a read** (`/api/investments/performance`): the request carries arrays and `today`; precedent `POST /api/cashflow/projection` with `readOnly: true`.
12. **`security.expense_ratio` is `numeric(8,6)`** (a decimal fraction), not the imports area's integer basis points as first drafted, because 0.035% is a common index-fund ratio.

## 9. Seams (what this area assumes the other three provide, as interfaces)

### Imports / data model area
- Writes `investment_txn` rows with the exact conventions of §2: signed `quantity`, signed `amount_cents` (buy includes commission; sell net) or null when the file lacks it, `fee_cents` when the file has a commission column, `seq` = row ordinal within the import, `reinvest` rows carrying the dividend amount, `split` rows as a ratio (when a broker reports "shares added" the importer derives `numerator/denominator = (old + added)/old` from the position before the split, reduced), `transfer` in-legs with `basis_cents` and `basis_acquired_date` when the file gives them, cash contributions/withdrawals in CSV full-history files as `transfer` with `security_id NULL`, `external_id = "itx:" + sha256(date|type|securityId|quantity|amount)` with an ordinal for identical rows (interface `IngestInvestmentTxnInput = Omit<InvestmentTxnInput, 'id'> & { externalId: string | null; source: InvestmentTxnSource; description: string; ledgerTransactionId?: string }`).
- Calls `rebuildLots(tx, accountId)` inside the same transaction after any insert/update/delete of `investment_txn` for that account, and surfaces the returned warnings in the import result (`ImportResult.warnings`), including `amount_mismatch` rows so the user can fix the mapping.
- Marks ledger deposits that are contributions as transfers (`transaction.is_transfer = true`, via pairing or a default rule on descriptions such as "CONTRIBUTION", "EMPLOYER MATCH", "ROLLOVER") so §3.8(a) sees them; dividend/interest ledger rows in brokerage accounts stay non-transfer. Investment account types default to `on_budget = false` so brokerage cash rows stay out of the spending plan (Phase 1 pairing is unchanged).
- Raises `account.investment_history` on import (positions CSV / `extra` holdings → `positions`; trade-history CSV → `full`), never lowers it; writes `holding_snapshot` per positions import (the latest per account feeds the position check).
- Mirrors `transferredOut` lots as transfer-in rows with carried basis/date and `counterpart_txn_id` when the receiving account is in the household (the Phase 3 UI may ask the user to confirm).
- Provides the manual trade form and the "Add opening position" action (a securities `transfer` with basis and acquired date), audited as `investment_txn`.
- Stores raw payloads in `import_log` (already the rule) so a rebuild after a parser fix is possible.

### Prices and valuation area
- `price` rows for every security held by a `full` account for every trading day from the first holding date to today (the engine carries forward over weekends/holidays and gaps, flags `stale_price` past 7 days, and reports `price_from_txn` when a series is missing entirely); implied unit prices for funds without a ticker are inserted into `price` with `source = 'implied'` on the positions-import date (spec); the benchmark series for `household_setting.benchmark_security_id` even when it is not held, with `source = 'provider_adjusted'` when the provider offers adjusted closes.
- `loadPriceSeries(db, securityIds: string[], from: IsoDate, to: IsoDate): Promise<PriceSeriesInput[]>` (the latest close on or before `from` plus all closes in `(from, to]`, sorted ascending, unique dates) and `latestPrices(db, securityIds, asOf): Map<securityId, { date, close } | null>` for the holdings view; closes as `numeric(20,8)` strings parsed with `parseFixed8`.
- The Portfolio value-over-time line and day change come from `balance_snapshot`/`holding_snapshot` (spec), not from this engine; where the prices area needs a priced value series for a `full` account it calls `valueFullAccount` with `buildLots(...)` (this area's functions) rather than re-implementing the valuation.
- `balance_snapshot` continues to be written per sync (Phase 1); for investment accounts it is assumed to be the total account value (securities + cash), which is what SimpleFIN reports as `balance` for brokerages; OQ6 covers the case where it is not.

### Views / API / web area
- Consumes `PerformanceResponse`, `LotsResponse`, `RealizedGainsResponse`, `InvestmentIncomeResponse` for the Performance, Holdings and Income pages; `HoldingView` rows for `full` accounts come from this engine, for `positions` accounts from `holding_snapshot` (their loader), and the Holdings page merges them per security across accounts; the Allocation view uses `security.asset_class` and holdings quantities (from either source) with `mulQtyPrice` for values.
- Renders the §4.2 reason strings and warning strips, the fidelity badge popover (§5), the "how this was computed" expanders, and the account settings (`investmentHistory`, `lotMethod`) and benchmark picker; mounts `LotPickDialog` from the sell row of the Holdings/activity list.
- Uses `resolveToday`/`TODAY_TOLERANCE_DAYS` and sends `today` in every request; period presets map to `from` as D17 states.
- Decides whether investment income feeds the plan's income bucket (OQ3) and how the allocation/rebalance view uses `investmentHistory`.

### Existing (Phases 1–2)
`transaction.is_transfer`, `transfer_pair_id`, signed `amount_cents`, `date`, `pending`; `balance_snapshot(account, date, balance_cents, source)`; `household_setting` (timezone, and the new benchmark column); `PlanError`, `writeAudit`, `AuditContext`, `usePlanErrors`, `resolveToday`, `readOnly` route config, `createTestDb`; `addMonthsClamped`, `dayDiff`, `addDays`, `monthKey`. `enqueueJob` is unused by this area.

## 10. Open questions
1. **Invisible 401(k) contributions.** Payroll deferrals never appear as ledger transfers in a balance-only 401(k) without a checking-side leg, so its XIRR treats contributions as growth. Options: a manual cash `transfer` row per paycheck (works today, flows (b)); or let `loadExternalFlows` synthesize flows from the active recurring item whose `transfer_account_id` is the account (`occurrencesInRange(schedule, from, to)` from the Phase 2 schedule module) when the account has no observed contribution in the period, flagged `flows_synthesized`. Recommendation: the second, decided with the recurring owner and the views area; the engine takes flows as given either way.
2. **Positions-level basis**: positions CSVs (Fidelity, Schwab) carry cost basis per position. Showing `holding_snapshot.cost_basis_cents` as "from statement" is in §5; computing an "unrealized (term unknown)" figure from it is cheap but beyond the spec's level table. Decide with the views area.
3. **Benchmark series: adjusted or raw closes?** With raw closes the benchmark is price-return only and understates an index fund by its yield (≈1.3%/yr for VTI); adjusted closes make it total-return but depend on the provider. Recommendation: adjusted when the provider has them, labelled by `price.source = 'provider_adjusted'` so the Performance page can say "total return" versus "price return".
4. **Return of capital and capital-gain distributions**: add types `return_of_capital` (reduces open lots' basis pro rata, excess is gain) and `capital_gain_distribution` (income, taxed as long-term) in Phase 3 or defer? Deferring means they are imported as `dividend`.
5. **Average-cost basis** (IRS-allowed for mutual fund shares and DRIP plans, common at Vanguard/Fidelity): should `lot_method` gain `average` in Phase 3? It changes per-lot basis to a running average with FIFO ordering for the holding period; the enum is text and extensible; the engine would add one branch in `consume`.
6. **`balance_snapshot` semantics for investment accounts**: the cash anchor (D19) assumes the snapshot is the total account value. If a brokerage's SimpleFIN `balance` turns out to be cash only, the anchor would double count securities; the `statementCheck` difference will show it on real data (it would equal the securities value). Decide after the gate whether the sync needs a per-connection "balance is total value" flag.
7. **Household-internal securities transfers**: the engine drops both legs when both carry `counterpart_txn_id`; if the import area cannot pair them, a household-internal ACATS counts as an external flow on both sides of the total (no error, slightly wrong total TWR for that day). Confirm the import area sets the pair.
8. **Quantity tolerance for the position check** is 0.001 shares; some brokerages display 3 decimals, others 6. A constant now, a setting only if real statements need it.
9. **Period presets and fiscal year**: YTD = from Dec 31; 1Y = `addMonthsClamped(today, −12)`; "since inception" = the day before the account's first transaction, flow or valuation. Confirm with the views area that no preset needs `from` on a non-valuation day for balance-only accounts (carried starts are flagged, not refused).
10. **Currency.** Everything assumes USD; `account.currency` is ignored by the engine. A non-USD brokerage would need price and flow conversion before Phase 3 closes.

## 11. Judging record
Two designs were judged; both judges chose **Design A** as the base. Scores (correctness / spec fidelity / codebase fit / testability): judge 1 gave A 8 / 8 / 9 / 9 and B 6 / 8 / 7 / 8; judge 2 gave A 9 / 9 / 8 / 9 and B 6 / 8 / 7 / 9. Both re-derived every published rate and lot figure in both documents (all reproduced) and checked the codebase facts (drizzle `check()`, numeric-as-string, `addMonthsClamped`/`dayDiff`/`addDays`, `PlanError`/`writeAudit`/`usePlanErrors`/`resolveToday`/`readOnly`, no custom querystring parser).

**Taken from Design A (the base):** Fixed8 arithmetic and the single half-away rounding rule with R1–R5; the lot engine with signed quantities, largest-remainder proceeds, exact basis conservation, specific identification through `lot_pick` with server validation, unknown basis kept unknown (term `unknown`, separate bucket), oversell as `unmatched_sell`, transfers out at basis with `transferredOut` for mirroring; the IRS holding period with the Rev. Rul. 66-7 clamp; the external-flow table and the ledger/CSV dedupe loader; start-of-day flow timing with true TWR for full accounts and GIPS Modified Dietz for snapshot-valued accounts, the method named in the output; opening-value flows for accounts entering a period late; Excel-exact XIRR with a fixed-grid bracket, the 10% guess rule and `multiple_roots`; the benchmark shadow portfolio; the household total with internal-flow dropping; stored `investment_history`, `lot_method`, `benchmark_security_id`; stored `lot`/`lot_disposal` rebuilt in the writing transaction; `statementCheck`; the `interest` type; the §7 cases TC1–TC27 with their numbers.

**Grafted from Design B** (as both judges asked): the same-day type rank (split first) ahead of `seq`; nullable `amount_cents` with `fee_cents`, derived amounts and the 5-cent `amount_mismatch` check; `lot.id` = the opening transaction's id; the position check against the latest `holding_snapshot` (0.001 sh) with `position_mismatch` lines in the fidelity badge; cash anchored on `balance_snapshot` for full accounts; the `stale_price` flag (7 days); the gain summary with the three integer invariants (lots = position, basis conservation, realized + unrealized = open value + proceeds + transferred-out basis − original basis) and the property-based test (TC34); `reinvestedCents` per income month and the no-double-counting note for the plan's income bucket; the explainability fields (`investorFlows`, benchmark `legs`, the sub-period table); `today` in the request and `from` defaulting to inception; readable reason strings; the zero-writes route test; the 401(k) payroll-contribution open question.

**Flaws fixed, each checked against the codebase before deciding:** the opening-value rule is now one rule (D18) for single- and multi-account requests, with `V(from) = 0` and flows before the first valuation folded (judges 1 and 2); the §3.13 prose now says the sub-period before `d₁` is computed under Modified Dietz, not skipped (judge 1; the TC was right); cash is anchored on statements so a fed brokerage no longer depends on every cash row being in `investment_txn` (both); lot ids are stable (judge 1); the income route uses the engine, not a second SQL (judge 2); `detail=full` and `AccountPerformanceView` agree (lots, disposals, flows, sub-periods, investor flows, legs; judge 2); `accountIds` travel in a POST body with `readOnly: true`, the codebase's own precedent for an array-carrying read (both; verified: `apps/api/src/app.ts` sets no querystring parser and `routes/cashflow.ts` is the pattern); `today` is a request field resolved by `resolveToday` (judge 2); `expense_ratio` is a decimal fraction (judge 1); a buy without an amount no longer gets a silent zero basis (judge 2). One judge-2 suggestion was overruled: an unpriced securities transfer is valued at 0 (with the position also valued 0 and warned), not left to fail the sub-period, because failing the whole TWR for one unpriced ticker would make the metric unavailable for everything else in the account while valuing the flow at 0 alongside a 0-valued position is internally consistent and invents neither a loss (basis valuation) nor a gain; the judge's objection to basis valuation is accepted. Design B's `zero_start_value` end-of-day convention, fabricated basis on transfers-in, phantom lots as short-term gains, transfers-out counted as proceeds, null totals when any account lacks a start observation, and the unread lot cache were not carried over, for the reasons the judges gave.
