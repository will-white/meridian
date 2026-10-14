# Phase 3 design: Data model and imports

Area: migration `0002_phase3_investments` and the tables `security`, `security_alias`, `price`, `holding_snapshot`, `investment_txn`, `lot`, `lot_disposal`, `allocation_target` (plus the benchmark and dividends-as-income settings); the security master; the SimpleFIN `extra` holdings parser inside the existing sync; positions-CSV and trade-history-CSV importers on the Phase 1 mapper pattern; manual positions and trades; the derived account fidelity level; corporate-action rows and their import semantics; contributions into investment accounts as transfers; the API contracts for imports and manual entry.

Angle: correctness first (every write path idempotent, every raw payload kept, every uniqueness rule and conflict path named), with the household-first ergonomics the judges asked for grafted in (per-institution action maps, newest-first files, the to-the-dollar reconciliation line shown before commit, editable imported rows).

Source of truth is the design spec; `docs/phase-1-plan.md` and `docs/phase-2-plan.md` are binding for conventions. Section 8 flags every deviation. This document is self-contained: an implementer builds from it without the two original designs.

**Spec conflict flagged up front.** The spec's data-sources table puts OFX/QFX in phase 3 while its build-phase list puts OFX under Phase 6 Polish. This design treats OFX as out of scope for Phase 3 and shapes both importers as consumers of `MappedPosition[]` / `MappedTrade[]`, so a later OFX adapter is a parser only and feeds `importPositions` / `importTrades` without touching the services (Deviation 1).

## 1. Decisions (binding)

1. **Numeric representation.** Share quantities and prices are `numeric(20,8)` in Postgres, decimal strings with at most 8 fraction digits on the wire and in Drizzle (`numeric` columns are typed `string`; postgres-js returns them as text), and scaled bigint (`Fixed8` = value × 10⁸) in every computation. Helpers live in `packages/shared/src/decimal.ts`. No JS `number` ever holds a quantity, price or cents. Reason: extends the bigint-cents discipline with one parse at the service boundary and no decimal library.
2. **One rounding rule, three conversions.** `roundDiv(n, d)` = round half away from zero (d > 0 asserted). It is used exactly three times: `mulToCents(qty, price) = roundDiv(qty × price, 10¹⁴)`, `fixed8ToCents(v) = roundDiv(v, 10⁶)`, `impliedPrice(cents, qty) = roundDiv(|cents| × 10¹⁴, |qty|)`. Every other division in the app keeps the Phase 2 rule (bigint `/` truncates toward zero). Reason: brokerage statements round each position's market value to the nearest cent; truncation would undervalue large accounts by whole dollars and fail the gate. Flagged as a stated exception (Deviation 2).
3. **`investment_txn` is the only source of truth for full-history accounts; `lot` and `lot_disposal` are a materialized cache** rebuilt per `(account, security)` by the engine area's `rebuildLots` inside the same transaction as any `investment_txn` write. Lot ids are stable across rebuilds: a rebuild upserts by `(opened_by_txn_id, ordinal)` and keeps the existing `id`, so `lot_selection` entries survive. Opening positions and outside transfers are `transfer in` rows carrying `cost_basis_cents` and `acquired_date`. There are no manual lots. Reason: an idempotent re-import can never corrupt lots; a rebuild always converges.
4. **A holding snapshot is a complete picture per `(account, date)`.** A write replaces the whole set for that key. Source precedence `manual (3) > csv (2) > simplefin (1)`: a write may replace an existing set of equal or lower rank; a lower-ranked write is refused (`409 snapshot_precedence`) and counted. Reason: the gate compares whole statements; a 6-hourly SimpleFIN sync must never clobber a hand-checked snapshot.
5. **`investment_txn.amount_cents` is always the signed cash effect on the account's cash** (buy/reinvest/fee ≤ 0, sell ≥ 0, dividend/interest the income as the file says, share transfers 0, cash transfers signed). Carried-in basis lives in `cost_basis_cents`, commissions in `fee_cents` (already inside `amount_cents`). Reason: one meaning per column for the engine, the income view and the cash-flow link.
6. **A reinvested dividend is always two rows**: a `dividend` (income) and a `reinvest` (purchase, amount = −cost). Brokerage history files (Fidelity, Schwab, Vanguard) list the dividend on its own line, so the trades mapping defaults to `reinvestRows: 'separate'` (a reinvest row is the purchase only); a single-line DRIP source sets `reinvestRows: 'combined'` once per institution profile and each such row is emitted as both legs. A reinvest-looking row without a quantity is income only. Reason: income counted exactly once for both file conventions; lots always see a buy.
7. **Stable trade ids.** File-provided id → `csvid:<id>`; else `inv:<sha256(date|type|securityKey|quantityCanonical|amountCents)>` with a `:n` ordinal for identical keys in one file. Dedupe key is `(account_id, external_id)`. Re-import refreshes source-owned columns unless the row is `user_edited`; user-owned columns (`memo`, `lot_selection`, `transaction_id`, `counterparty_account_id`, `transfer_group_id`, `cost_basis_cents`, `acquired_date`) are never touched by an import. Reason: Phase 1 pattern; overlapping files create no duplicates and never undo a hand fix.
8. **Every raw payload is kept.** CSV text plus mapping go to `import_log` (kinds `csv.positions`, `csv.trades`); the whole SimpleFIN response already sits in the sync's `raw_payload`; the `simplefin.reprocess_holdings` job re-parses stored payloads after a parser change. Reason: parser fixes must be replayable without a resync.
9. **The SimpleFIN holdings parser is defensive and loud.** It recognises the Bridge's own `account.holdings` array plus five `extra` container shapes and a fixed synonym table, accepts dollar-only positions (value known, units not reported: `quantity NULL`), rejects anything else with a per-account `holdings.unrecognized` / `holdings.partial` error naming the keys it saw, never invents a cash position and never dates a snapshot by the clock. Reason: which brokerages put holdings in `extra` is unknown; wrong holdings are worse than none.
10. **Security master resolution order**: alias → ticker → CUSIP → ISIN → normalized name (name only when the key has no ticker). Securities created by a sync or an import carry `needs_review = true`; the preview lets the owner link a file identity to an existing security or edit the suggested new one before commit, and the chosen spelling is learned as an alias (`security_alias(kind, value)`, unique across securities). One canonical cash security per currency. Merging repoints every referencing row and leaves aliases behind. Reason: dedupe across sources without silent guessing, and a 401(k) trust with no ticker resolves on its own the second time.
11. **Expense ratio is an integer in parts per million** (`expense_ratio_ppm`; 0.03 % = 300). Reason: no floats for stored ratios; exact entry; the weighted expense ratio becomes integer math.
12. **Implied prices and price precedence.** Every position with quantity ≠ 0 and a non-cash security writes a `price` row with `source = 'implied'` for the snapshot date; precedence `manual (3) > provider (2) > implied (1)`, a write may overwrite equal or lower rank only. Cash securities never get price rows (valued at 1.00000000 by definition). `security.price_mode ∈ provider | implied | manual` tells the prices area which securities to fetch. Reason: the spec's unit-price rule for ticker-less funds, extended to cover provider gaps without ever overriding a real close.
13. **Fidelity is derived, never stored**: `full_history` when the account has any `buy | sell | reinvest | split` row or a `transfer` row with a security, else `positions` when it has any `holding_snapshot`, else `balance_only`; `null` for non-investment account types. Reason: a stored flag drifts from the data.
14. **Contributions.** (a) Ledger inflows into investment-type accounts whose description matches the contribution patterns are marked `is_transfer = true` at ingest (an unpaired leg, which Phase 1 already supports; "not a transfer" clears it through the existing `PATCH /transactions/:id { isTransfer: false }`). (b) Cash rows in a trade-history file (`cash_in` / `cash_out`) always become `investment_txn` cash `transfer` rows; for an account that has no SimpleFIN connection they also become ledger `transaction` rows (`source csv`, `is_transfer = true`, Phase 1 external id) linked through `transaction_id`, so goals and pairing see them; for a SimpleFIN-fed account they link to the Bridge's ledger row instead (`linkToLedger`). (c) The engine's external-flow source is ledger rows with `is_transfer = true` in the account ∪ `investment_txn` cash transfers with `transaction_id IS NULL`, which never double counts under (b). Reason: 401(k) payroll contributions have no checking-side leg; CSV-only brokerages must reach goals through the ledger (Phase 2 §7 reads `loadGoalNets` from the ledger).
15. **Balances from positions and the reconciliation line.** A snapshot write updates `balance_snapshot` and `account.balance_cents` only when the account is not SimpleFIN-fed, or when the owner ticks "also set the balance" (`setBalance: true`). For SimpleFIN-fed accounts the preview and the result carry `knownBalanceCents` (the Bridge's balance on/before the date), `differenceCents` and `matchesToDollar = |difference| < 100`. Reason: that line is the gate stated literally, shown before anything is written.
16. **CSV profiles carry a kind**: `connection.csv_kind ∈ bank | positions | trades`, one mapping per institution per kind. The trades mapping carries `rowOrder`, `actionMap`, `fee.columns`, `amountIncludesFees`, `reinvestRows` and an optional `accountFilter`; the positions mapping carries `asOf` and an optional `accountFilter`. Reason: three mapper shapes, one profile mechanism; a broker-specific action is fixed once per institution, not per file.
17. **Allocation targets and household investment settings.** `allocation_target(asset_class PK, target_bp)` is replaced as a whole set that sums to 10 000 bp (or is empty); `household_setting.benchmark_security_id` and `household_setting.dividends_as_income` (the spec's "feeding the income bucket if desired") are household facts with one owner. Reason: the views area can assume them.
18. **Audit scope.** Manual mutations are audited (`security`, `investment_txn`, `holding_snapshot` for manual snapshots and snapshot deletes, `allocation_target`, `household_setting`); imports and syncs are recorded by `import_log`, not `audit_log`. Reason: Phase 2's audit rule; row-level audit of a 400-row import is noise, the raw file is the record.
19. **OFX is out of Phase 3** (conflict flagged above); the importers are shaped for a later adapter.
20. **Same-day order is deterministic.** `investment_txn.sequence` is assigned by the importer after a stable sort by date that honours `rowOrder` (`oldest_first | newest_first | auto`); manual rows get `max(sequence) + 1` for that `(account, date)`. The engine replays by `(date, sequence, created_at, id)`. Reason: Fidelity's history export is newest-first; a same-day buy-then-sell must replay as buy-then-sell.
21. **Own-account securities transfers** are two rows sharing `transfer_group_id`: a manual request creates both legs; CSV legs are paired by `pairInvestmentTransfers` (same security, equal quantity, opposite direction, different accounts, ≤ 3 days). Reason: mirrors ledger transfer pairing; the engine moves lots with their basis.
22. **Ledger linking.** An imported or manual `dividend`, `interest`, `fee` or cash `transfer` row links to at most one ledger `transaction` (same account, exact amount, date within 3 days, nearest, unlinked) via `transaction_id`; syncs re-run the link for still-unlinked rows when new ledger rows arrive. The income view and XIRR dedupe by it. Reason: SimpleFIN already delivers the cash view of these events.
23. **No future dates.** Snapshot and trade dates must be ≤ the household's `today` (`resolveToday`, Phase 2 §16): `400 future_date`. Reason: a value "as of" a date that has not happened is not a statement.
24. **Imported rows are editable and deletable.** Editing a source-owned column of an imported row sets `user_edited = true` and re-imports skip that row's source-owned columns; deleting an imported row is allowed (audited) and a later overlapping file recreates it as "new" in the preview unless its action is mapped to `skip`. Reason: a wrong broker row must be fixable without re-entering the file by hand.
25. **Specific-lot sales span lots.** `investment_txn.lot_selection` is `[{ lotId, quantity }]` on `sell` and `transfer out` rows; Σ quantity must equal the row's quantity and every lot must belong to the same `(account, security)`; null = FIFO. The engine never throws on an oversell or a stale selection (partial histories are common): it records warnings and the account's `reconciled` flag shows the mismatch. Reason: the spec's "specific-lot optional" with multi-lot sales; an import must not be refused because the file starts mid-history.
26. **Investment accounts default off-budget on creation; no migration backfill.** `upsertSimplefinAccount` and `POST /accounts` insert `on_budget = false` for `brokerage, 401k, ira, roth, hsa, 529`. Existing accounts are not changed by the migration; the Accounts page shows a one-click "Move off budget" prompt for investment accounts still on budget. Phase 2's plan loaders (`loadActuals`, `loadUncategorized`, `countUncategorized`) gain an `account.on_budget = true` filter (two-line change, flagged in Deviation 12); `loadGoalNets` is unchanged because it reads linked accounts. Reason (verified in `services/plan.ts`): a SimpleFIN brokerage feed delivers buys, sells and dividends as ledger rows that today surface as uncategorized spending in the plan and on the dashboard; a migration must not silently change the owner's budget numbers.

## 2. Data model

All money columns are `bigint` cents; quantities and prices `numeric(20,8)`. `CHECK` constraints are declared with `check()` from `drizzle-orm/pg-core` (present in 0.38.4, the installed version) and every CHECK is mirrored by a service validation that returns a named error code before the database sees the row. New Drizzle file `packages/db/src/schema/investments.ts` (exported from `schema/index.ts`); existing tables change in `sources.ts`, `accounts.ts` and `plan.ts`.

### 2.1 `security` (spec table)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK default gen_random_uuid() | no | |
| ticker | text | yes | normalized (trim, upper, strip leading `$` and trailing `*`); CHECK `ticker IS NULL OR ticker ~ '^[A-Z0-9][A-Z0-9.\-/]{0,11}$'`; null for ticker-less funds and cash |
| name | text | no | sanitized, ≤ 200 |
| type | text | no | `stock, etf, fund, bond, cash, cd, other` (TS enum `SecurityType`) |
| asset_class | text | no | `us_stock, intl_stock, bonds, cash, real_estate, other` (`AssetClass`), default `'other'` |
| expense_ratio_ppm | integer | yes | CHECK `>= 0 AND <= 1000000`; null = unknown |
| cusip | text | yes | 9 chars, upper |
| isin | text | yes | 12 chars, upper |
| currency | text | no | default `'USD'` |
| price_mode | text | no | `provider, implied, manual` (`PriceSource`); default on create: `provider` when a ticker is present, else `implied`; cash: `manual` (never fetched, valued at 1) |
| provider_symbol | text | yes | symbol at the price provider when it differs from `ticker` (prices area reads `provider_symbol ?? ticker`) |
| needs_review | boolean | no | default true; cleared when the owner saves the row |
| archived | boolean | no | default false; hidden from pickers, kept for history |
| notes | text | yes | |
| created_at, updated_at | timestamptz | no | default now() |

Indexes: `security_ticker_idx UNIQUE (ticker) WHERE ticker IS NOT NULL`; `security_cusip_idx UNIQUE (cusip) WHERE cusip IS NOT NULL`; `security_isin_idx UNIQUE (isin) WHERE isin IS NOT NULL`; `security_cash_currency_idx UNIQUE (currency) WHERE type = 'cash'`; `security_name_norm_idx (upper(regexp_replace(name, '[^A-Za-z0-9]+', ' ', 'g')))` (expression index for name resolution, the same normalization as `normalizeName`); `security_needs_review_idx (needs_review)`.
CHECK `security_cash_shape`: `type <> 'cash' OR (ticker IS NULL AND asset_class = 'cash')`.

### 2.2 `security_alias` (addition)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | |
| security_id | uuid FK security ON DELETE CASCADE | no | |
| kind | text | no | `ticker, cusip, isin, name` |
| value | text | no | normalized as the resolver normalizes that kind |
| created_at | timestamptz | no | |

Unique `(kind, value)` across all securities, so resolution is never row-order dependent (a jsonb alias column cannot enforce this). Written by merges (the loser's identifiers), by the preview's "link to existing" choice (`learnAliases`) and by the owner (`POST /securities/:id/aliases`, e.g. FB → META).

### 2.3 `price` (spec table)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | |
| security_id | uuid FK security ON DELETE CASCADE | no | |
| date | date | no | |
| close | numeric(20,8) | no | CHECK `close >= 0` |
| source | text | no | `provider, implied, manual` (`PriceSource`) |
| updated_at | timestamptz | no | |

Unique `(security_id, date)`; index `(date)`. Precedence on write: manual 3 > provider 2 > implied 1; `upsertPrice` is the only writer and enforces "replace equal or lower rank only"; the prices area's fetch job calls it with `provider`.

### 2.4 `holding_snapshot` (spec table)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | |
| account_id | uuid FK account ON DELETE CASCADE | no | |
| security_id | uuid FK security ON DELETE RESTRICT | no | merges repoint; a referenced security cannot be deleted |
| date | date | no | the as-of date of the statement or feed, never "today" |
| quantity | numeric(20,8) | yes | null = dollar-only position (value known, units not reported); may be negative (margin cash, shorts) |
| price | numeric(20,8) | yes | as reported, or implied `impliedPrice(value, qty)`; null when quantity is null or 0 |
| value_cents | bigint | no | market value as the source reported it (or `mulToCents(qty, price)` when the source gave only a price) |
| reported_cost_basis_cents | bigint | yes | the source's cost basis, when present |
| source | text | no | `simplefin, csv, manual` (`HoldingSource`) |
| import_log_id | uuid FK import_log ON DELETE SET NULL | yes | |
| created_at, updated_at | timestamptz | no | |

Unique `(account_id, security_id, date)`; indexes `(account_id, date)`, `(security_id, date)`, `(date)`. A snapshot set is all rows with one `(account_id, date)`; `replaceHoldingSnapshot` is the only writer. CHECK `hs_price_needs_quantity`: `price IS NULL OR quantity IS NOT NULL`.

### 2.5 `investment_txn` (spec table)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | |
| account_id | uuid FK account ON DELETE CASCADE | no | |
| security_id | uuid FK security ON DELETE RESTRICT | yes | null only for cash transfers, account-level fees and interest on cash |
| date | date | no | trade date |
| sequence | integer | no | default 0; same-day order (Decision 20) |
| type | text | no | `buy, sell, dividend, interest, reinvest, fee, split, transfer` (`InvestmentTxnType`) |
| quantity | numeric(20,8) | yes | always ≥ 0; direction comes from `type` / `transfer_direction`; split: shares added as reported (informational), may be null |
| price | numeric(20,8) | yes | per share; CHECK `price IS NULL OR price >= 0` |
| amount_cents | bigint | no | signed cash effect (Decision 5) |
| fee_cents | bigint | no | default 0, CHECK `>= 0`; included in a buy's basis, deducted from a sell's proceeds |
| split_num, split_den | integer | yes | split ratio new:old (2:1 → 2,1; reverse 1:10 → 1,10) |
| transfer_direction | text | yes | `in, out`; required for `transfer` |
| counterparty_account_id | uuid FK account ON DELETE SET NULL | yes | the other own account of a transfer |
| transfer_group_id | uuid | yes | shared by the two legs |
| cost_basis_cents | bigint | yes | basis carried in on a `transfer in` from outside |
| acquired_date | date | yes | original acquisition date for that lot |
| lot_selection | jsonb | yes | `[{ "lotId": uuid, "quantity": "4.00000000" }]` on `sell` / `transfer out`; null = FIFO (Decision 25) |
| transaction_id | uuid FK transaction ON DELETE SET NULL | yes | the ledger cash row (Decision 22) |
| external_id | text | yes | `csvid:…` / `inv:…`; null for manual rows |
| source | text | no | `csv, manual` (`simplefin` reserved; v2 has no trades object) |
| import_log_id | uuid FK import_log ON DELETE SET NULL | yes | |
| raw_description | text | yes | the file's action + description, sanitized ≤ 500 |
| memo | text | yes | user-owned |
| user_edited | boolean | no | default false; set by any edit of a source-owned column on an imported row (Decision 24) |
| created_at, updated_at | timestamptz | no | |

Indexes: unique `(account_id, external_id)` (Postgres treats nulls as distinct, so manual rows never collide); `(account_id, security_id, date, sequence)`; `(security_id, date)`; `(transfer_group_id)`; `(transaction_id)`; `(date)`.
CHECKs (named so failures are readable; the service raises `400 txn_invalid` with the same name first):
- `itx_quantity_nonneg`: `quantity IS NULL OR quantity >= 0`
- `itx_buy`: `type <> 'buy' OR (security_id IS NOT NULL AND quantity > 0 AND amount_cents <= 0)`
- `itx_sell`: `type <> 'sell' OR (security_id IS NOT NULL AND quantity > 0 AND amount_cents >= 0)`
- `itx_reinvest`: `type <> 'reinvest' OR (security_id IS NOT NULL AND quantity > 0 AND amount_cents <= 0)`
- `itx_fee`: `type <> 'fee' OR amount_cents <= 0`
- `itx_split`: `((type = 'split') = (split_num IS NOT NULL)) AND ((type = 'split') = (split_den IS NOT NULL)) AND (type <> 'split' OR (security_id IS NOT NULL AND split_num > 0 AND split_den > 0 AND amount_cents = 0))`
- `itx_transfer`: `((type = 'transfer') = (transfer_direction IS NOT NULL)) AND (type <> 'transfer' OR ((security_id IS NOT NULL AND amount_cents = 0 AND quantity > 0) OR (security_id IS NULL AND amount_cents <> 0 AND ((transfer_direction = 'in') = (amount_cents > 0)))))`
- `itx_basis_only_in`: `cost_basis_cents IS NULL OR (type = 'transfer' AND transfer_direction = 'in' AND security_id IS NOT NULL)`
- `itx_lot_selection`: `lot_selection IS NULL OR type = 'sell' OR (type = 'transfer' AND transfer_direction = 'out')`

Dividend and interest rows carry no sign CHECK (reversals exist); the importer stores them positive and a reversal row negative as the file says.

### 2.6 `lot` (spec table; rows defined here, math owned by the engine area)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | stable across rebuilds (Decision 3) |
| account_id | uuid FK account ON DELETE CASCADE | no | |
| security_id | uuid FK security ON DELETE RESTRICT | no | |
| opened_by_txn_id | uuid FK investment_txn ON DELETE CASCADE | no | the buy / reinvest / transfer-in row |
| ordinal | smallint | no | default 0; a transfer-in that moves several source lots creates one lot per source lot |
| acquired_date | date | no | |
| quantity | numeric(20,8) | no | original, split-adjusted, > 0 |
| remaining_quantity | numeric(20,8) | no | 0 ≤ remaining ≤ quantity |
| cost_basis_cents | bigint | yes | original total basis including fees; null = unknown (transfer-in from outside without basis) |
| remaining_cost_basis_cents | bigint | yes | null when `cost_basis_cents` is null |
| origin_lot_id | uuid | yes | lineage across an own-account in-kind transfer |
| closed_date | date | yes | set when remaining_quantity reaches 0 |
| updated_at | timestamptz | no | |

Unique `(opened_by_txn_id, ordinal)`; indexes `(account_id, security_id, closed_date)`, `(security_id)`. Rows exist only as the output of `rebuildLots(tx, accountId, securityId)`; the API never writes them directly.

### 2.7 `lot_disposal` (addition; rows defined here, filled by the engine)

| column | type | null | notes |
| --- | --- | --- | --- |
| id | uuid PK | no | |
| lot_id | uuid FK lot ON DELETE CASCADE | no | |
| txn_id | uuid FK investment_txn ON DELETE CASCADE | no | the `sell` or `transfer out` row |
| kind | text | no | `sell, transfer_out` |
| date | date | no | |
| quantity | numeric(20,8) | no | > 0 |
| cost_basis_cents | bigint | yes | basis of the disposed part; null when the lot's basis is unknown |
| proceeds_cents | bigint | no | this lot's share of the sell's net proceeds; 0 for `transfer_out`, which is excluded from realized gains |

Unique `(lot_id, txn_id)`; indexes `(txn_id)`, `(date)`. Invariants pinned on the engine seam (§9): Σ `quantity` per sell = the sell's quantity; proceeds split by quantity with the cent remainder on the last lot; a `transfer out` with a `transfer_group_id` writes disposals of kind `transfer_out` and the counterparty's lots carry `origin_lot_id`.

### 2.8 `allocation_target` (addition)

| column | type | null | notes |
| --- | --- | --- | --- |
| asset_class | text PK | no | one of `AssetClass` |
| target_bp | integer | no | CHECK `0..10000` |
| updated_at | timestamptz | no | |

Replaced as a whole set; the service rejects a non-empty set whose sum ≠ 10 000 (`400 allocation_sum`). An empty table means "no targets set".

### 2.9 Alterations

- `household_setting.benchmark_security_id uuid NULL REFERENCES security(id) ON DELETE SET NULL`; `household_setting.dividends_as_income boolean NOT NULL DEFAULT false`.
- `connection.csv_kind text NOT NULL DEFAULT 'bank'` (`CsvKind`: `bank, positions, trades`); `csv_mapping` holds the mapping for that kind. Existing rows become `bank` by the default.
- `import_log.kind` gains `csv.positions`, `csv.trades`, `simplefin.reprocess` (text column; TS enum only, no DDL).
- `job.type` gains `simplefin.reprocess_holdings` (and the prices area's `prices.fetch`; TS enum only).
- `audit_log.entity` gains `security`, `investment_txn`, `holding_snapshot`, `allocation_target` (TS enum only).
- `account`: no new columns (fidelity is derived); `on_budget` default for new investment-type accounts is set by the two creation paths (Decision 26), not by DDL.

### 2.10 Migration `0002_phase3_investments` steps

1. `pnpm db:generate` from the new schema file: creates `security`, `security_alias`, `price`, `holding_snapshot`, `investment_txn`, `lot`, `lot_disposal`, `allocation_target` with their FKs, unique/partial indexes and CHECKs; adds `household_setting.benchmark_security_id`, `household_setting.dividends_as_income` and `connection.csv_kind`.
2. Verify the generated SQL contains the partial unique indexes (`WHERE "ticker" IS NOT NULL` etc.), the expression index on `security.name` and every named CHECK; drizzle-kit 0.30 emits `.where(sql…)` on `uniqueIndex`, `sql`-expression indexes and `check()` constraints (the 0001 snapshot is schema version 7 and carries `checkConstraints`). If an expression index is not emitted, append it as a raw statement before `--> statement-breakpoint` and keep the snapshot in sync.
3. Order inside the file: `security` before `security_alias` / `price` / `holding_snapshot` / `investment_txn`; `investment_txn` before `lot`; `lot` before `lot_disposal`. Drizzle emits FKs as separate `ALTER TABLE … ADD CONSTRAINT` statements after all tables, so the `investment_txn ↔ lot` relation (lots reference their opening transaction; selections reference lots only through jsonb) needs no special ordering.
4. No data seeding and no `UPDATE` of existing rows (Decision 26). The cash security per currency is created lazily on first use (`cashSecurity`), allocation targets stay empty, the benchmark stays null.
5. Journal entry idx 2, tag `0002_phase3_investments`; `createTestDb()` applies it automatically.

## 3. Algorithms

### 3.1 Fixed-point decimals — `packages/shared/src/decimal.ts`

```ts
export type Fixed8 = bigint;                       // value × 1e8
export const FIXED8_SCALE = 100_000_000n;
export const DecimalString = z.string().regex(/^-?\d+(\.\d{1,8})?$/);   // wire + DB text form
export function parseFixed8(s: string): Fixed8;    // throws on >8 decimals, exponent, blanks, thousands separators
export function formatFixed8(n: Fixed8): string;   // canonical: no trailing zeros, no "-0": "12.5", "1000", "-0.00000001"
export function roundDiv(n: bigint, d: bigint): bigint;    // half away from zero; d > 0 asserted
export function mulToCents(qty: Fixed8, price: Fixed8): bigint;   // roundDiv(qty * price, 10n ** 14n)
export function fixed8ToCents(v: Fixed8): bigint;                 // roundDiv(v, 10n ** 6n)
export function centsToFixed8(c: bigint): Fixed8;                 // c * 10n ** 6n (exact)
export function impliedPrice(cents: bigint, qty: Fixed8): Fixed8; // roundDiv(|cents| * 10n ** 14n, |qty|); qty ≠ 0 asserted
export function parseLooseDecimal(raw: string): Fixed8 | undefined; // "1,234.5", "$1,234.50", "(12.5)", "12.5-" → undefined when unreadable or >8 decimals
export function fixed8FromJsonNumber(n: number): Fixed8 | undefined; // String(n); undefined on exponent form, >8 decimals, non-finite
export function percentToPpm(s: string): number;   // "0.03" → 300: parseFixed8(s) / 10_000n, must divide exactly else throws
export function ppmToPercent(ppm: number): string; // 300 → "0.03": formatFixed8(BigInt(ppm) * 10_000n)
```

`roundDiv`: `q = n / d; r = n % d; if 2·|r| ≥ d then q += sign(n)`. Worked: `roundDiv(5, 2) = 3`, `roundDiv(−5, 2) = −3`, `roundDiv(7, 2) = 4`, `roundDiv(1, 3) = 0`.

`mulToCents` worked examples (all re-run with a bigint reference script):
- 12.345 × 101.23: product 12 496 843 500 000 000 000 / 10¹⁴ = 124 968.435 → **124 968** ($1 249.68).
- 0.5 × 10.01 = 5.005 → 500.5 → **501** (half away from zero). 1.5 × 0.01 = 0.015 → **2**; −1.5 × 0.01 → **−2**.
- 3 × 33.333333 = 99.999999 → 9 999.9999 → **10 000**; 3 × 33.33333333 → **10 000** (round trip with `impliedPrice(10 000, 3) = 33.33333333` holds).
- −1.5 × 2.01 = −3.015 → −301.5 → **−302**.
- 41.2 × 210.1234 = 8 657.08408 → **865 708**; 0.0523 × 236.04 = 12.344892 → **1 234**; 12.5 × 123.456 → **154 320**; 7 × 51.37 → **35 959**; 5 × 48.123 = 240.615 → **24 062**; 100 × 0.00000001 → **0**.

`impliedPrice` worked examples: 124 968 cents / 12.345 → 10 122 964 763.06… → **101.22964763**; 100 000 / 7 → **142.85714286**; 318 750 / 12.75 → **250** exactly; 865 708 / 41.2 → **210.12330097** (not the 210.1234 the feed gave: an implied price is a derived number and is stored with `source = 'implied'`); 1 234 / 0.0523 → **235.94646272**; 179 011 / 14.5 → 12 345 586 206.896… → **123.45586207**.

JSON numbers: `JSON.parse` yields doubles. `fixed8FromJsonNumber(41.2)` reads `"41.2"` (shortest round-trip string) → 4 120 000 000; `1e-9`, `1e21` and `0.30000000000000004` (more than 8 decimals) are rejected, never rounded.

DB boundary: Drizzle `numeric(...)` columns are typed `string`; services call `parseFixed8` on read and `formatFixed8` on write (helpers `qtyFromDb` / `qtyToDb` in `packages/db/src/services/decimalDb.ts`; `parseFixed8` accepts Postgres' `"12.50000000"` form).

### 3.2 Security master — `packages/db/src/services/securities.ts`

Normalization (pure, `packages/shared/src/investments.ts`): `normalizeTicker(s)` = `sanitizeText`, trim, upper-case, strip leading `$`, strip trailing `*`s, collapse inner whitespace; returns null when empty or when the result fails `^[A-Z0-9][A-Z0-9.\-/]{0,11}$` (so a fund name in a symbol column is not a ticker). `normalizeName(s)` = `sanitizeText`, upper, non-alphanumerics → single space, trim (matches the expression index). `normalizeCusip/Isin` = upper, strip spaces; validated by length (9/12).

```ts
resolveSecurity(tx, key: { ticker?, cusip?, isin?, name?, currency?, hints? }, opts: { createIfMissing: boolean; source: HoldingSource | 'csv' })
  → { id, created, matchedBy: 'alias' | 'ticker' | 'cusip' | 'isin' | 'name' | 'created' | 'cash' }
  | { id: null, matchedBy: 'unresolved', suggestion: { ticker, cusip, isin, name, type, assetClass } }   // only when createIfMissing is false
```
1. Cash key (`isCashKey`): ticker ∈ {`CASH`, `USD`, `**CASH**`, `CASH & CASH INVESTMENTS`} or (no ticker and normalized name matches `^CASH( |$)|CORE CASH|FDIC INSURED DEPOSIT|CASH AND CASH INVESTMENTS|CASH BALANCE|US DOLLARS?$`) → `cashSecurity(tx, currency ?? 'USD')`.
2. `security_alias` lookup in order ticker, cusip, isin, name (each only when the key has it).
3. `security.ticker = normalized ticker`.
4. `security.cusip`, then `security.isin`.
5. Only when the key has no ticker: `security` by normalized name (expression index). A key with a ticker that matches nothing by ticker/cusip/isin creates a new security even if a name matches (a new ticker is a new security; the owner merges if it is the same fund).
6. `createIfMissing` → insert with `guessSecurityHints(key)`, `needs_review = true`, `price_mode = ticker ? 'provider' : 'implied'`, `ticker` set only when the key had one. Unique-index race (two importers inserting the same ticker) → catch 23505, re-run step 3. Without `createIfMissing` the suggestion is returned for the preview.

`guessSecurityHints({ ticker, name, hints })` (pure):
- type: hint or name matches `/\bETF\b/` → `etf`; `/MONEY MARKET|MMF|CORE POSITION|SWEEP/` → `fund` with asset class `cash`; `/\bCD\b|CERTIFICATE OF DEPOSIT/` → `cd`; `/BOND|TREASURY|NOTE\b|BILL\b/` → `bond`; `/FUND|INDEX|TRUST|POOL|PORTFOLIO|TARGET|CLASS [A-Z]\b|INSTL|ADMIRAL|INVESTOR/` or a 5-letter ticker ending in `X` → `fund`; else `stock`.
- asset class, first match on the upper-cased name: `/MONEY MARKET|CASH RESERVES|TREASURY ONLY|FDIC/` → `cash`; `/REIT|REAL ESTATE/` → `real_estate`; `/BOND|TREASURY|FIXED INCOME|INCOME FUND|AGGREGATE|TIPS|MUNICIPAL/` → `bonds`; `/INTERNATIONAL|INTL|EMERGING|EX[- ]?US|EAFE|GLOBAL|FOREIGN|DEVELOPED MARKETS|EUROPE|PACIFIC|ASIA/` → `intl_stock`; `/500|TOTAL STOCK|TOTAL MARKET|S&P|RUSSELL|NASDAQ|GROWTH|VALUE|SMALL CAP|MID CAP|LARGE CAP|EQUITY|STOCK/` → `us_stock`; else `other`.
- The guess is shown as "guessed" until the owner saves the row; the allocation view reads `needs_review` (views area) and never trusts it silently.

`cashSecurity(tx, currency)`: get-or-create `{ type: 'cash', asset_class: 'cash', ticker: null, name: 'Cash (USD)', currency, price_mode: 'manual', needs_review: false }`; the unique partial index makes the create idempotent under concurrency (catch 23505, re-select).

`learnAliases(tx, securityId, key)`: for each of the key's normalized ticker / cusip / isin / name that is not already the security's own identifier, insert `security_alias(kind, value)` with `ON CONFLICT DO NOTHING`; when the conflicting row belongs to another security the service raises `409 alias_taken` (the owner merges instead). Capped at 50 aliases per security.

`mergeSecurities(db, survivorId, loserId, ctx)` in one transaction, audited as `security` update on the survivor with `before/after` and a `security` delete on the loser:
1. Both exist, differ (`400 merge_self`), neither is `cash` (`400 cash_security_reserved`).
2. `holding_snapshot`: for each loser row, if the survivor has a row for the same `(account, date)` → merge into it (`quantity` summed when both non-null else null, `value_cents` summed, `reported_cost_basis_cents` summed when both non-null else null, `price = impliedPrice(value, quantity)` or null when quantity is null or 0, `source = max rank`), delete the loser row; else repoint `security_id`.
3. `price`: repoint loser rows whose date the survivor lacks; on a collision keep the higher-ranked row (survivor's on a tie); drop the rest.
4. `investment_txn`, `lot`: repoint; then `rebuildLots` for every `(account, survivor)` pair touched (lot_disposal follows the lots).
5. `security_alias`: repoint; add aliases for the loser's ticker, cusip, isin and normalized name (ignore duplicates).
6. Delete the loser; `household_setting.benchmark_security_id = loser` → survivor.

`deleteSecurity`: `409 security_in_use` when any `holding_snapshot`, `investment_txn`, `lot` or `price` row references it; the owner merges or archives instead.

### 3.3 SimpleFIN `extra` holdings parser — `packages/shared/src/simplefinHoldings.ts` (pure)

```ts
export interface ParsedPosition { index: number; ticker: string | null; name: string | null; cusip: string | null; isin: string | null;
  quantity: Fixed8 | null; price: Fixed8 | null; valueCents: bigint; costBasisCents: bigint | null; currency: string | null; asOf: IsoDate | null;
  hints: string[]; isCash: boolean; warnings: Array<'value_mismatch' | 'value_rounded' | 'asof_mixed' | 'dollar_only'> }
export interface RejectedPosition { index: number; reason: 'missing_identity' | 'missing_value' | `unparseable:${string}`; keys: string[] }
export interface HoldingsParseResult { status: 'none' | 'parsed' | 'partial' | 'unrecognized'; container: string | null; asOf: IsoDate | null;
  positions: ParsedPosition[]; rejected: RejectedPosition[]; skipped: Array<{ index: number; reason: 'pending_activity' | 'zero_position' }>; keysSeen: string[] }
export function parseSimplefinHoldings(account: SimplefinAccount): HoldingsParseResult;
```

Steps:
1. **Container.** Candidates in order: `account.holdings` (the Bridge's own array, which the Phase 1 schema already keeps), `extra.holdings`, `extra.positions`, `extra.investments`, `extra.securities`, then any other `extra.<key>` whose value is a non-empty array of objects of which at least one element has both an identity key and a quantity-or-value key. A candidate may also be an **object keyed by symbol** (`{ VTI: { shares: … } }`): its entries become elements with the key as `symbol` when the element lacks an identity key. Elements that are not plain objects are rejected `unparseable:element`. No candidate → `status: 'none'`, nothing else happens (a counter in stats only).
2. **Key normalization**: lower-case, drop `_`, `-`, spaces. Synonyms: identity `symbol, ticker, securitysymbol, tickersymbol, fundsymbol`; name `name, description, securityname, security, fundname, investmentname, holdingname`; `cusip`; `isin`; quantity `quantity, shares, units, qty, sharesowned, sharecount, unitsheld, numberofshares`; price `price, unitprice, marketprice, lastprice, close, closeprice, currentprice, shareprice, nav`; value `value, marketvalue, currentvalue, totalvalue, balance, positionvalue`; cost `costbasis, cost, basis, totalcost, costbasistotal`; `currency`; asOf `date, asof, asofdate, balancedate, pricedate` (unix seconds or `YYYY-MM-DD`); hints `type, securitytype, assettype, assetclass` (kept as text for the guesser). `amount`, `purchaseprice` and `created` are deliberately not synonyms (ambiguous).
3. **Values.** Numbers → `fixed8FromJsonNumber`; strings → `parseLooseDecimal`. Quantity and price stay Fixed8; value and cost → `fixed8ToCents` (warning `value_rounded` when dropped digits were non-zero). A field present but unparseable rejects the element with `unparseable:<field>`.
4. **Element rules.** Identity = ticker or cusip or isin or name, else `missing_identity`. A name matching `^PENDING ACTIVITY` → skipped `pending_activity`. Cash identity (§3.2 step 1): quantity defaults to `centsToFixed8(value)` and price to 1 when absent. Otherwise: value present, quantity absent → **dollar-only** position (`quantity null, price null`, warning `dollar_only`); quantity present, value absent → price required (`missing_value`) and `valueCents = mulToCents(quantity, price)`; both present, price absent → `price = quantity ≠ 0 ? impliedPrice(value, quantity) : null`; all three present and `|value − mulToCents(qty, price)| > max(1, value / 200)` (0.5 %) → warning `value_mismatch`, the source value is kept (the broker's number is what the statement shows); neither quantity nor value → `missing_value`. Quantity 0 and value 0 → skipped `zero_position`.
5. **asOf**: if every parsed element carries the same asOf → that date; mixed → `unixToIsoDate(account['balance-date'])` with `asof_mixed` on each; none → the balance-date. Never the clock.
6. **Status**: no elements parsed and ≥ 1 element seen → `unrecognized`; some rejected → `partial`; else `parsed`. `keysSeen` = the union of the elements' original keys (≤ 30, sanitized) for the error message; values are never echoed.

Worked example A (`extra.holdings`, strings): `[{ symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: "12.345", price: "250.66", market_value: "3,094.40", cost_basis: "2500.00" }, { symbol: "CASH", market_value: "150.25" }]`, balance-date 1791900000 (2026-10-13T14:00Z) → `parsed`, asOf 2026-10-13, positions: VTI qty 1 234 500 000, price 25 066 000 000, value 309 440 (check: 12.345 × 250.66 = 3 094.3977 → 309 440, equal, no warning), cost 250 000; CASH isCash, value 15 025, quantity 15 025 000 000 (150.25), price 1.
Worked example B (`account.holdings`, numbers): `[{ ticker: "FXAIX", shares: 41.2, last_price: 210.1234, cusip: "315911750" }]` → value absent → 865 708; price kept 210.1234 (the implied 210.12330097 is not used because the feed gave a price).
Worked example C (`extra: { positions: [{ foo: 1, bar: "x" }] }`) → candidate array present, element has no identity → `unrecognized`, `keysSeen: ["foo","bar"]`.
Worked example D (`extra: { "account-type": "brokerage" }`) → `none`.
Worked example E (dollar-only 401(k) feed): `[{ name: "Vanguard Target Retirement 2045 Trust Plus", market_value: "12,345.67" }]` → `parsed`, one position `quantity null, price null, valueCents 1 234 567`, warning `dollar_only`.

`applySimplefinHoldings(db, { accountId, accountType, connectionId, simplefinAccountId, parsed, importLogId })` (`services/holdings.ts`) is called by `applyAccountSet` for every account right after the account upsert, for full and balances-only syncs alike, in its own `db.transaction` wrapped in try/catch so a parser bug or a constraint failure for one account never fails the sync or aborts another account's work:
1. `status none` → return `{ skipped: true }`. Non-investment account types (a bank that puts junk in `extra`) → the parse result is counted (`holdingsIgnoredAccounts`) and nothing is written.
2. Resolve each position to a security (`createIfMissing: true`, source `simplefin`, hints from the element); aggregate by `security_id` (Σ quantity when all non-null else null, Σ value, Σ cost when all present; price = reported when all rows agree else implied, null when quantity is null).
3. `replaceHoldingSnapshot(tx, { accountId, date: asOf, source: 'simplefin', importLogId, positions, setBalance: false })`; a `snapshot_precedence` refusal is caught and counted as `holdingsSnapshotsKept`.
4. `writeImpliedPrices` (§3.5); `enqueueJob('prices.fetch', { reason: 'holdings' }, { dedupe: true })` when a security was created.
5. Stats merged into the sync's `import_log.stats`: `holdingsAccounts, holdingsPositions, holdingsRejected, holdingsUnrecognizedAccounts, holdingsIgnoredAccounts, holdingsSnapshotsKept, securitiesCreated, impliedPrices`. Errors appended to the sync's `errors` (and therefore `connection.last_errors`): `{ code: 'holdings.unrecognized' | 'holdings.partial' | 'holdings.parse_error', message: "<account name>: N of M holding rows could not be read (keys: symbol, qty, mv)", accountId }`, sanitized, ≤ 300 chars. Connection status is not changed by holdings errors.
6. After the account's ledger ingest, `linkUnlinkedInvestmentTxns(tx, accountId, windowStart)` re-runs `linkToLedger` for the account's unlinked `dividend | interest | fee | cash transfer` rows dated inside the window ± 3 days (Decision 22).

### 3.4 Snapshot replacement — `replaceHoldingSnapshot` (`services/holdings.ts`)

```ts
interface SnapshotPosition { securityId: string; quantity: Fixed8 | null; price: Fixed8 | null; valueCents: bigint; reportedCostBasisCents: bigint | null }
replaceHoldingSnapshot(tx, { accountId, date, source, importLogId?, positions, setBalance, today })
  : Promise<{ inserted; updated; unchanged; deleted; totalValueCents; knownBalanceCents: bigint | null; differenceCents: bigint | null; matchesToDollar: boolean | null; balanceWritten: boolean }>
```
1. `date ≤ today` else `400 future_date`. Positions must be unique by `securityId` (assert; importers aggregate first). Rows with quantity 0 (or null) and value 0 are dropped from the set.
2. Load existing rows for `(account_id, date)`. If any existing row's source outranks `source` (manual 3 > csv 2 > simplefin 1) → throw `PlanError(409, 'snapshot_precedence', 'A <source> snapshot already exists for <date>')`. Equal or lower → proceed.
3. Upsert on `(account_id, security_id, date)`: update only when a column differs (`updated`), else `unchanged`; new rows `inserted`. Delete existing rows whose security is not in the set (`deleted`).
4. `totalValueCents = Σ valueCents`. `knownBalanceCents` = for a SimpleFIN-fed account (`connection_id` set and the connection's type is `simplefin`) the latest `balance_snapshot` with `source = 'simplefin'` on/before `date`, else null. `differenceCents = total − known` (null when unknown); `matchesToDollar = known !== null && |difference| < 100n`.
5. Balance write when `setBalance` (default: the account is not SimpleFIN-fed): upsert `balance_snapshot(account, date, totalValueCents, source)` and, when `date ≥ account.balance_date` or it is null, set `account.balance_cents = total`, `balance_date = date`. Otherwise nothing touches balances (the views area shows `balance − Σ value` as "cash & other / unexplained").
6. Return counts; the caller writes stats or audit.

Idempotency: the same set written twice yields `inserted 0, updated 0, deleted 0`.

### 3.5 Implied prices — `writeImpliedPrices(tx, date, positions)`

For each position with quantity ≠ null, quantity ≠ 0, price ≠ null and a security whose `type ≠ 'cash'`: `upsertPrice(tx, { securityId, date, close: price, source: 'implied' })`. `upsertPrice` reads the existing row; writes when none exists or `rank(existing.source) ≤ rank(new.source)`; returns `inserted | updated | kept` (`kept` also when the value is unchanged, so `updated_at` does not move). The prices area's fetch job calls the same function with `provider`, so a later real close replaces the implied one and a manual price is never overwritten by either. `setManualPrice(db, securityId, { date, close }, ctx)` is the owner's path (`400 cash_security_reserved` for cash), audited as `security` update with `{ price: { date, close } }` before/after.

### 3.6 Positions CSV — `packages/shared/src/investmentsCsv.ts`

```ts
export const PositionsCsvMapping = z.object({
  hasHeader: z.boolean().default(true), skipRows: z.number().int().min(0).default(0),
  asOf: z.discriminatedUnion('mode', [ z.object({ mode: z.literal('column'), column: ColumnRef, format: CsvDateFormat }), z.object({ mode: z.literal('request') }) ]),
  symbol: z.object({ column: ColumnRef }).optional(), name: z.object({ column: ColumnRef }).optional(), cusip: z.object({ column: ColumnRef }).optional(),
  quantity: z.object({ column: ColumnRef }).optional(), price: z.object({ column: ColumnRef }).optional(), value: z.object({ column: ColumnRef }).optional(),
  costBasis: z.object({ column: ColumnRef }).optional(), accountFilter: z.object({ column: ColumnRef }).optional(),
}).refine(m => m.symbol || m.name, 'symbol or name column required').refine(m => m.value || (m.quantity && m.price), 'value, or quantity and price, required');
export interface MappedPosition { rowIndex: number; ticker: string | null; name: string | null; cusip: string | null; quantity: Fixed8 | null; price: Fixed8 | null; valueCents: bigint; costBasisCents: bigint | null; isCash: boolean; warnings: string[] }
export function mapPositionsCsvRows(rows: string[][], mapping: PositionsCsvMappingInput, opts: { asOfDate?: IsoDate; accountFilterValue?: string }): { positions: MappedPosition[]; asOf: IsoDate; errors: MappingError[]; skipped: Array<{ rowIndex; reason }>; filterValues: string[]; pendingActivityCents: bigint }
export function guessPositionsMapping(headers: string[], samples: string[][]): PositionsCsvMappingInput | undefined;
```
Rules: blank rows skipped; rows whose symbol/name matches `^(TOTAL|ACCOUNT TOTAL|GRAND TOTAL)\b` or that have no identity and no quantity/value skipped `totals_row` (statement footers such as "The data and information in this spreadsheet…" fall here); `Pending Activity` skipped `pending_activity` with its value summed into `pendingActivityCents`; `accountFilter` set → rows whose column value ≠ `accountFilterValue` skipped `other_account` (`filterValues` lists the distinct values for the UI); quantity via `parseLooseDecimal` (unreadable when the column is mapped and non-blank → error); price via `parseLooseDecimal`; value/cost via `parseLooseDecimal` → `fixed8ToCents` (warning `value_rounded`); an unreadable cost → `costBasisCents null` with warning `cost_unreadable` (cost is optional, never an error); value/price/quantity fallbacks, dollar-only rows and the mismatch check exactly as §3.3 step 4; `asOf.mode = 'request'` without `asOfDate` → thrown `as_of_required` (a snapshot is never dated by the clock); `mode = 'column'` → every row must parse to the same date, otherwise error `asof_mixed` on the differing rows. Same security on several rows (sub-lots) → aggregated after mapping: Σ quantity (null if any null), Σ value, Σ cost (null if any null), price = reported when identical on all rows else implied.
Header guesses (Phase 1's `findHeader`, exact then contains): date `as of, as of date, date, price date`; symbol `symbol, ticker`; name `description, investment name, security name, security description, fund name, name, security, investment, holding`; cusip `cusip`; quantity `quantity, shares, units, qty, quantity (shares)`; price `last price, price, unit price, share price, market price, current price, nav, last`; value `current value, market value, total value, value, position value, balance`; cost `cost basis total, cost basis, total cost, basis, cost`; accountFilter `account number, account name, account` (only when present). No date header → `asOf.mode = 'request'`.

Worked example: Fidelity-style file rows (`Symbol, Description, Quantity, Last Price, Current Value, Cost Basis Total`): `VTI, VANGUARD TOTAL STOCK MKT ETF, 10.5, 250.00, $2,625.00, $2,100.00`; `VTI, …, 2.25, 250.00, $562.50, $500.00`; `SPAXX**, FIDELITY GOVERNMENT MONEY MARKET, 150.25, 1.00, $150.25, --`; `Pending Activity, , , , $12.34, `; `Account Total, , , , $3,350.09, ` with `asOfDate 2026-10-13` → positions: VTI qty 12.75, value 318 750, cost 260 000, price 250 (reported, identical); SPAXX (ticker normalized from `SPAXX**`) qty 150.25, price 1, value 15 025, cost null (`cost_unreadable`); skipped: pending_activity (`pendingActivityCents 1234`), totals_row. Σ value 333 775.

### 3.7 Positions preview and commit — `importPositions` (`services/holdings.ts`)

Preview (`POST /api/import/positions/preview`): parse → map → resolve each position **without creating** (`createIfMissing: false`) → rows with `security: { id, ticker, name, matchedBy, isNew, needsReview, isCash, suggestion }` and `existing` (the current snapshot row for that date, if any) → `snapshotExists`, `existingSource`, `willReplace = rank(csv) ≥ rank(existing)`, `totalValueCents`, `knownBalanceCents`, `differenceCents`, `matchesToDollar`, `setBalanceDefault = !simplefinFed`. The owner may override any row's security with a `SecurityChoice` (link to an existing security, or edit the suggested new one) and the preview re-runs with those `choices`.
Commit (`POST /api/import/positions/commit`), one transaction after the `import_log` row (kind `csv.positions`, raw `{ csvText, mapping, asOfDate, accountFilterValue, choices }`) is written first:
1. Account must be an investment type (`brokerage, 401k, ira, roth, hsa, 529`) else `400 not_investment_account`; `asOfDate ≤ today` else `400 future_date`.
2. Map; zero positions → `400 no_rows`.
3. Save/update the profile when asked (`connection` type `csv`, `csv_kind = 'positions'`).
4. Apply `choices`: `existing` → that security id and `learnAliases(key)`; `create` → `createSecurity` from the edited suggestion (`needs_review = false` because the owner typed it); rows without a choice resolve with `createIfMissing: true` (source `csv`, `needs_review = true`). Aggregate; `replaceHoldingSnapshot` (source `csv`, `setBalance` from the body or the default; a `manual` snapshot on that date → `409 snapshot_precedence`, the import_log row is marked `error` with that message, nothing written).
5. `writeImpliedPrices`; enqueue `prices.fetch { reason: 'holdings' }` deduped (seam, §9).
6. Finish the import_log row with stats `{ rowsRead, rowsRejected, rowsSkipped, positions, inserted, updated, unchanged, deleted, securitiesCreated, impliedPrices, balanceWritten (0/1) }` (`stats` is `Record<string, number>`; the total and the difference are written into `message`: "Snapshot 2026-10-13: 3 positions, $3,337.75 (Bridge balance $3,350.09, difference $12.34)").
Re-importing the same file is a no-op for rows (`updated 0`), creates a second import_log row, and never duplicates a snapshot (Test 8).

### 3.8 Trade-history CSV — `packages/shared/src/investmentsCsv.ts`

```ts
export const TradeKind = z.enum(['buy','sell','dividend','interest','reinvest','reinvest_combined','fee','split','transfer_in','transfer_out','cash_in','cash_out','skip']);
export const TradesCsvMapping = z.object({
  hasHeader: z.boolean().default(true), skipRows: z.number().int().min(0).default(0),
  date: z.object({ column: ColumnRef, format: CsvDateFormat }), action: z.object({ column: ColumnRef }),
  symbol: z.object({ column: ColumnRef }).optional(), name: z.object({ column: ColumnRef }).optional(), cusip: z.object({ column: ColumnRef }).optional(),
  quantity: z.object({ column: ColumnRef }).optional(), price: z.object({ column: ColumnRef }).optional(),
  amount: z.object({ column: ColumnRef, invert: z.boolean().default(false) }).optional(),
  /** Commission and fee columns are summed (Fidelity has both). */
  fee: z.object({ columns: z.array(ColumnRef).min(1) }).optional(),
  /** False when the amount column is the principal (price × quantity) and fees are separate. */
  amountIncludesFees: z.boolean().default(true),
  /** How a reinvest-looking row with a quantity is read (Decision 6). */
  reinvestRows: z.enum(['separate','combined']).default('separate'),
  rowOrder: z.enum(['oldest_first','newest_first','auto']).default('auto'),
  /** actionKey(text) → kind; consulted before the regex classifier (exact key, then longest prefix). */
  actionMap: z.record(z.string(), TradeKind).default({}),
  externalId: z.object({ column: ColumnRef }).optional(), description: z.object({ column: ColumnRef }).optional(), accountFilter: z.object({ column: ColumnRef }).optional(),
}).refine(m => m.symbol || m.name);
export function actionKey(action: string): string;                       // sanitizeText, lower, collapse whitespace
export function classifyTradeAction(action: string, description: string, row: { hasQuantity: boolean; amountSign: -1 | 0 | 1 | null }, mapping): TradeKind | undefined;
export interface MappedTrade { rowIndex: number; sequence: number; date: IsoDate; type: InvestmentTxnType; kind: TradeKind; ticker; name; cusip; quantity: Fixed8 | null; price: Fixed8 | null; amountCents: bigint; feeCents: bigint; splitNum: number | null; splitDen: number | null; transferDirection: 'in' | 'out' | null; externalId: string; rawDescription: string; derived: Array<'amount' | 'price'>; warnings: string[] }
export async function mapTradesCsvRows(rows, mapping, opts: { accountFilterValue?: string; choices?: RowChoice[] }): Promise<{ trades: MappedTrade[]; errors: MappingError[]; skipped: Array<{ rowIndex; reason; text }>; actionsFound: Array<{ key: string; sample: string; count: number; kind: TradeKind | null; fromProfile: boolean; sampleRowIndex: number }>; unknownActions: number; rowOrder: 'oldest_first' | 'newest_first'; filterValues: string[] }>;
export function guessTradesMapping(headers, samples): TradesCsvMappingInput | undefined;
```

**Classification** (`classifyTradeAction`), first hit wins:
1. `actionMap[actionKey(action)]` exact, else the longest `actionMap` key that is a prefix of `actionKey(action)` (so one entry `journaled` covers every journal variant).
2. Regexes over `ACTION + ' ' + DESCRIPTION` (upper-cased, collapsed), in this order:
   a. `/REINVEST|DRIP|DIVIDEND REINVESTED/` → `reinvest` when the row has a quantity and `reinvestRows = 'separate'`; `reinvest_combined` when the row has a quantity and `reinvestRows = 'combined'`; `dividend` when the row has no quantity (Schwab's "Reinvest Dividend" income line; Fidelity's and Schwab's share lines carry a quantity).
   b. `/DIVIDEND|\bDIV\b|CAPITAL GAIN|CAP GAIN|QUALIFIED|DISTRIBUTION\b(?!.*(IRA|TRANSFER))/` → `dividend`.
   c. `/INTEREST/` → `interest`.
   d. `/\bFEE\b|COMMISSION|ADR FEE|ADVISORY/` → `fee`.
   e. `/SPLIT/` → `split`.
   f. `/\b(BUY|BOUGHT|PURCHASE|YOU BOUGHT|BUY TO COVER)\b/` → `buy`; `/\b(SELL|SOLD|YOU SOLD|REDEMPTION|SELL SHORT)\b/` → `sell`.
   g. `/TRANSFER (OF )?(SHARES|SECURITIES)|JOURNAL|ACATS|RECEIVED|DELIVERED|IN KIND|SECURITIES (RECEIVED|DELIVERED)/` with a symbol and a quantity → `transfer_out` when `/OUT|DELIVERED|TO\b/` else `transfer_in`.
   h. `/CONTRIBUTION|DEPOSIT|EFT (IN|RECEIVED)|ELECTRONIC FUNDS TRANSFER RECEIVED|ACH|WIRE IN|FUNDS RECEIVED|TRANSFER IN|ROLLOVER|EMPLOYER MATCH/` → `cash_in`; `/WITHDRAWAL|EFT OUT|TRANSFER OUT|WIRE OUT|DISBURSEMENT|REDEMPTION TO BANK/` → `cash_out`.
   i. `/SWEEP|CORE FUND|MONEY MARKET (PURCHASE|REDEMPTION)|JOURNALED CASH|ADJUSTMENT/` → `skip` (internal cash sweeps).
   j. Otherwise `undefined` (unclassified): the row is listed under `actionsFound` with `kind null`, excluded from `trades`, counted in `unknownActions`; commit is refused (`400 unknown_action`) until every unknown key is mapped (to a kind or to `skip`). Nothing is ever imported silently.

**Row order and sequence** (Decision 20): `rowOrder auto` resolves to `newest_first` when the first readable date in the file is later than the last readable date, else `oldest_first`. Rows are reversed when `newest_first`, then stable-sorted by date ascending; `sequence` = index within the date group. The two halves of a combined reinvest get consecutive sequences (dividend first).

**Row rules after classification** (`|x|` = absolute value; `Q`, `P` via `parseLooseDecimal`, `A` via `parseLooseMoney` then `invert`, `F = Σ |parseLooseMoney(fee columns)|`, default 0):
- Quantity: `|Q|` (sells are often negative in exports); required for `buy | sell | reinvest | reinvest_combined | transfer_in | transfer_out` (error `quantity_required`), must be > 0. `split`: `|Q|` or null (informational).
- Amount sign is **forced by type** after `invert`: buy/reinvest/fee → `−|A|`, sell/dividend/interest → `+|A|`, `cash_in` → `+|A|`, `cash_out` → `−|A|`; share transfers and splits → 0. A reversal row (negative dividend/interest) keeps its sign only when the text contains `REVERSAL|ADJUSTMENT|CORRECTION`.
- `amountIncludesFees = false`: buy `amount = −(|A| + F)`, sell `amount = |A| − F`; `true`: `−|A|` / `|A|` (F is informational). `feeCents = F`.
- Derivations, recorded in `derived[]`: amount absent → buy/reinvest `−(mulToCents(Q, P) + F)`, sell `mulToCents(Q, P) − F`; price absent with amount and quantity → buy `impliedPrice(|amount| − F, Q)`, sell `impliedPrice(amount + F, Q)`, reinvest `impliedPrice(|amount|, Q)`. Both absent → error `amount_or_price_required`.
- Consistency warning `amount_mismatch` when `A`, `Q` and `P` are all present and `||A| − mulToCents(Q, P) ∓ F| > max(100, |A| / 100)`.
- `reinvest_combined` → two `MappedTrade`s: `dividend` with `amountCents = +|A|`, no quantity, and `reinvest` with `amountCents = −|A|`, quantity, `price = P ?? impliedPrice(|A|, Q)`.
- `dividend` without a resolvable security → error `security_required` ("map the action to interest if it is cash interest").
- `cash_in` / `cash_out` → `type transfer`, `security null`, `transferDirection in/out`, quantity null; `rawDescription = sanitizeText(action + ' ' + description, 500)`.
- `split` → ratio parsed from the text `(\d+)[:\/ ]?(?:FOR|:)?[ ]?(\d+)` (new:old; "2 FOR 1" → 2,1; "1:10" → 1,10); absent → the row needs a `choices[].split = { num, den }` from the preview, else error `split_ratio_required`.
- External id: file id → `csvid:<id>` (the two halves of a combined reinvest get `csvid:<id>:div` and `csvid:<id>:buy`); else `inv:<sha256(date|type|securityKey|quantityCanonical|amountCents)>` where `securityKey` = normalized ticker, else `cusip:<cusip>`, else `name:<normalizedName>`, else `cash`; `quantityCanonical = formatFixed8(quantity)` or empty; ordinal `:n` (n ≥ 1) for identical keys within one file in file order. Ids never depend on `sequence`, so re-ordering a file changes nothing.
- `accountFilter`: as for positions (`other_account` skips, `filterValues`).

Worked ids (SHA-256 of the exact key text): `2026-10-01|buy|VTI|10|-250000` → `inv:bf027e8fe6751b5f9f78153eb9203337d9c774ca457f722f5e6856f301fa1cf0`; `2026-09-15|dividend|VTI||1234` → `inv:1b5dee9faca1b69be9c22b24de4d893acb547d73d083f14dfbb4c5728aa1e294`; `2026-09-15|reinvest|VTI|0.0523|-1234` → `inv:5d65e799012bb0146bb1180d2ca7987ddd9e74db98817d57f22961200c581c2c`; `2026-10-05|sell|VTI|4|99860` → `inv:38638c9dc3e6f19929e61e0fd5a3841ad5aed967fddc90a1a233dbd75687955a`; `2026-10-02|buy|ABC|5|-24557` → `inv:e57ec0a7ccbde687c2bb76b31cf5da260594af4b266bc9d660e17eb6d67bdf65`.

Header guesses: date `run date, trade date, transaction date, activity date, date`; action `action, activity, transaction type, type` (never the description column); symbol `symbol, ticker`; name `description, investment name, security description, security, name`; quantity `quantity, shares, units, qty`; price `price ($), price, unit price, share price`; amount `amount ($), net amount, amount, total, net` → `amountIncludesFees true`; `principal amount, principal` → `amountIncludesFees false`; fee columns: every header matching `commission ($), commission, fees ($), fees, fees & comm`; externalId `transaction id, reference, confirmation, id`; `settlement date` and `accrued interest ($)` are recognised and ignored.

Worked example (Fidelity-shaped, `Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date`, newest-first, defaults):

| file row | kind | normalized |
| --- | --- | --- |
| 10/09/2026 `YOU SOLD … (VTI)` Q −4, P 130.00, Fees 0.02, A 519.98 | sell | qty 4, price 130, amount **+51 998**, fee 2 (check: 4 × 130 = 52 000; 52 000 − 2 = 51 998 matches A, no warning) |
| 10/06/2026 `REINVESTMENT … (VTI)` Q 0.1, P 123.40, A −12.34 | reinvest (purchase only) | qty 0.1, price 123.4, amount **−1 234** |
| 10/05/2026 `DIVIDEND RECEIVED … (VTI)` A 12.34 | dividend | amount **+1 234** |
| 10/02/2026 `YOU BOUGHT … (VTI)` Q 10, P 123.45, A −1234.50 | buy | qty 10, price 123.45, amount **−123 450**, fee 0 |
| 10/01/2026 `ELECTRONIC FUNDS TRANSFER RECEIVED` A 5000.00 | cash_in | `transfer in`, security null, amount **+500 000** |
| 10/12/2026 `JOURNALED SPP PURCHASE CREDIT (Cash)` A 0.00 | unclassified | `actionsFound: { key 'journaled spp purchase credit (cash)', kind null }`; owner maps `journaled` → skip once |

`rowOrder` resolves to `newest_first` (10/09 before 10/01 in the file, ignoring the unclassified 10/12 row which is still a readable date: first readable date 10/12 > last 10/01). With `amountIncludesFees false` and Commission 4.95 on the buy: amount = −(123 450 + 495) = **−123 945**, fee 495. Same-day check: a file listing `10/05 YOU SOLD 4` above `10/05 YOU BOUGHT 4` gets sequences buy 0, sell 1.

### 3.9 Trade upsert and commit — `upsertInvestmentTxns`, `importTrades` (`services/investmentTxns.ts`)

`upsertInvestmentTxns(tx, { accountId, trades: MappedTrade[], source: 'csv', importLogId })` → `{ created, updated, unchanged, skippedEdited, touchedPairs: Array<[accountId, securityId | null]>, cashRows: Array<{ txnId, date, amountCents, description }> }`:
1. Resolve securities (`choices` first, then `createIfMissing: true`, source `csv`); cash transfers get `security_id = null`.
2. Load existing rows by `(account_id, external_id IN ids)` in chunks of 500.
3. Existing and `user_edited = false`: compare source-owned columns (`date, sequence, type, security_id, quantity, price, amount_cents, fee_cents, split_num/den, transfer_direction, raw_description`); write only the diff (`updated`) else `unchanged`. Existing and `user_edited = true`: `skippedEdited`. User-owned columns (`lot_selection, memo, transaction_id, counterparty_account_id, transfer_group_id, cost_basis_cents, acquired_date`) are never touched by an import. A type change on re-import that violates `itx_lot_selection` clears `lot_selection` and records a warning `lot_selection_cleared`.
4. New: insert `ON CONFLICT DO NOTHING` (guards a concurrent import); `created`.
5. `linkToLedger` for new `dividend | interest | fee | transfer(cash)` rows: the unlinked ledger `transaction` in the same account with `amount_cents = amount_cents`, `|dayDiff| ≤ 3`, not linked to another investment_txn, nearest date then earliest `id`; sets `transaction_id`.
6. `pairInvestmentTransfers` over the account's unpaired share `transfer` rows dated within the import's date range ± 3 days.
7. `rebuildLots` for every touched `(account, security)` pair with security ≠ null (engine seam), inside the same transaction.

`importTrades(db, { accountId, accountType, simplefinFed, trades, importLogId, today })` (called by the commit route after the `import_log` row of kind `csv.trades` with raw `{ csvText, mapping, accountFilterValue, choices }` is written):
1. Investment account (`400 not_investment_account`); every row `date ≤ today` (`400 future_date` naming the first offending row); `unknownActions > 0` → `400 unknown_action` listing the keys.
2. One transaction: `upsertInvestmentTxns`; then, **only when the account is not SimpleFIN-fed**, the new cash rows become ledger rows: `ingestTransactions(tx, cashRows → IncomingTransaction { externalId: csvExternalId(date, amount, description, ordinal), date, amountCents, description, pending: false }, { accountId, accountType, source: 'csv', rules, importLogId })`, then `UPDATE transaction SET is_transfer = true WHERE id IN (insertedIds)`, `investment_txn.transaction_id` = the ledger row, and `pairTransfersInDb(tx, { since, until })`. (`ingestTransactions`'s first parameter widens from `Db` to `DbOrTx`; a nested call inside a transaction becomes a savepoint in drizzle, and existing callers are unchanged.) For a SimpleFIN-fed account step 5 above already linked the cash rows to the Bridge's ledger rows.
3. After commit: `enqueueJob('recurring.detect', { reason: 'ledger' }, { dedupe: true })` when ledger rows were created (Phase 2 §17); `enqueueJob('prices.fetch', { reason: 'holdings' }, { dedupe: true })` when a security was created.
4. Finish the import_log row with stats `{ rowsRead, rowsRejected, rowsSkipped, created, updated, unchanged, skippedEdited, linked, ledgerCreated, ledgerSkipped, transfersPaired, securitiesCreated, lotsRebuilt }`.

Idempotency: the same file twice yields `created 0, unchanged n`, `ledgerSkipped` for the cash rows (Phase 1 dedupe), no new pairs, identical lots after rebuild.

`pairInvestmentTransfers(tx, { since, until })`: candidates = `transfer` rows with `security_id` set and `transfer_group_id IS NULL`; for each `out` leg in `(date, id)` order, the `in` leg in a different account with the same `security_id`, equal `quantity`, `|dayDiff| ≤ 3`, smallest distance (earliest date, then id); both get one `transfer_group_id` and each other's `counterparty_account_id`; the engine then moves the source lots (basis and acquired dates travel, `origin_lot_id` set). Unpaired `in` legs from outside use `cost_basis_cents` / `acquired_date`; when null, the lot is built with `cost_basis_cents = null` (unknown basis).

### 3.10 Manual entry

`createManualInvestmentTxn(db, input, ctx)` validates per type (§2.5 CHECKs, surfaced as `400 txn_invalid` with the rule's name), `date ≤ ctx.today` (`400 future_date`), investment account only, defaults `amountCents` when absent (buy `−(mulToCents(qty, price) + fee)`, sell `mulToCents(qty, price) − fee`, reinvest `−mulToCents(qty, price)`), requires it for dividend/interest/fee (`400 amount_required`), sets `sequence = max(sequence) + 1` for `(account, date)`, `source = 'manual'`, `external_id = null`. A `transfer` with `counterpartyAccountId`: both accounts must be investment types and differ (`400 transfer_same_account`); the mirror leg is inserted with the opposite direction (cash: negated amount; shares: same quantity, amount 0) and the same `transfer_group_id`; both audited in one batch. `lotSelection` on a sell or transfer-out: every lot must belong to the same `(account, security)`, be open, have `remaining_quantity ≥ entry.quantity`, and Σ entries must equal the row's quantity (`400 lot_not_found` / `lot_insufficient` / `lot_selection_sum`); the engine's rebuild re-validates and downgrades a stale selection to a warning. `linkToLedger` runs for dividend/interest/fee/cash rows; `rebuildLots` for the pair(s). Worked: manual buy 5 × 48.123, fee $4.95 → `mulToCents = 24 062` (240.615 → half away), amount `−(24 062 + 495) = −24 557`; 7 × 51.37 → −35 959, with fee 495 → −36 454.

`updateInvestmentTxn(db, id, patch, ctx)`: any column may change, including `type` and `transferDirection` (re-validated as a whole row; a type or security change re-runs the rebuild for the old and the new pairs). On an imported row a change to a source-owned column sets `user_edited = true`; changing only user-owned columns does not. A paired transfer leg cannot change `type`, `securityId` or `quantity` while paired (`409 transfer_leg_linked`; unlink by deleting the group or clearing the pair through `PATCH { transferGroupId: null }`, which clears both legs). Audited (`investment_txn`, entity id = row id, before/after = the API view without timestamps).

`deleteInvestmentTxn(db, id, { deleteGroup }, ctx)`: manual and imported rows delete alike (Decision 24); a transfer leg with a group → `409 transfer_leg_linked` unless `deleteGroup: true`, which deletes both legs; lots are rebuilt for the affected pairs; `lot_disposal` rows cascade. Audited as `delete` per row.

`setManualPositions(db, { accountId, asOfDate, positions, setBalance }, ctx)`: each position names a `SecurityChoice` (`existing` or `create`; cash resolves by key); quantity optional (dollar-only allowed); price or valueCents required (the other derived by §3.1); aggregated by security; `replaceHoldingSnapshot(source 'manual')` (always allowed: manual is the top rank); `writeImpliedPrices`; audited as `holding_snapshot`, entity id `${accountId}:${asOfDate}`, before/after = the position list (`securityId, quantity, price, valueCents, reportedCostBasisCents`) so an unchanged re-save writes nothing. `deleteSnapshot(accountId, date)`: csv/manual snapshots only (simplefin snapshots are regenerated by the next sync; `409 snapshot_source`); also removes the derived `balance_snapshot` row of the same date and source and re-derives `account.balance_cents` from the latest remaining snapshot when that account's balance came from positions; audited as `holding_snapshot` delete.

### 3.11 Contribution classifier — `packages/shared/src/investments.ts`

`classifyInvestmentInflow(accountType, description, amountCents): 'contribution' | null`, called by `ingestTransactions` for every new row (SimpleFIN and bank CSV) **after** the rules when no rule set `transfer` or a category, and only when `accountType ∈ INVESTMENT_ACCOUNT_TYPES` and `amountCents > 0`. Text = upper-cased, collapsed `payee ?? description`. Exclusions first: `/DIVIDEND|INTEREST|CAPITAL GAIN|REINVEST|REFUND|REBATE|\bSOLD\b|\bSELL\b|REDEMPTION/` → null. Then `/CONTRIBUTION|EMPLOYER (MATCH|CONTRIB)|EMPLOYEE (PRE-?TAX|ROTH|AFTER-?TAX)|SALARY DEFERRAL|401\(?K\)? (DEFERRAL|CONTRIB)|PAYROLL|ROLLOVER|EFT (IN|RECEIVED)|ELECTRONIC FUNDS TRANSFER RECEIVED|ACH (DEPOSIT|CREDIT|IN)|WIRE IN|FUNDS RECEIVED|TRANSFER (IN|FROM)|\bDEPOSIT\b/` → `contribution`: the row is inserted with `is_transfer = true`, `category_id = null`, no pair id. Outflows are not touched (an IRA distribution's checking-side leg is categorised by the owner or paired). Cross-account pairing (`pairTransfersInDb`) still runs afterwards and may pair the leg with a checking outflow (the pair id is added; `is_transfer` is already true). "Not a transfer" (`PATCH /transactions/:id { isTransfer: false }`) clears the flag and any pair through the existing `unpairTransfer`. Goals (Phase 2 §7) count these legs when the account is a goal's linked account.
`ingestTransactions` needs the account type: `IngestOptions` gains `accountType` (looked up once by `applyAccountSet` / `importCsvRows` / `importTrades`).

### 3.12 Fidelity — `accountFidelity(flags)` (`packages/shared/src/investments.ts`)

```ts
export type InvestmentFidelity = 'balance_only' | 'positions' | 'full_history';
export function accountFidelity(f: { hasTrades: boolean; hasSnapshots: boolean }): InvestmentFidelity
// hasTrades → 'full_history'; else hasSnapshots → 'positions'; else 'balance_only'
```
`hasTrades` = exists `investment_txn` for the account with `type IN ('buy','sell','reinvest','split') OR (type = 'transfer' AND security_id IS NOT NULL)`; `hasSnapshots` = exists `holding_snapshot`. `loadAccountInvestmentInfo(db, accountIds)` returns per account `{ fidelity, lastSnapshotDate, lastSnapshotSource, lastTradeDate, securityCount, needsReviewCount }` with two grouped queries; `GET /api/accounts` attaches it as `investment` for investment-type accounts (null otherwise). The reconciliation of lots against the latest snapshot (`reconciled: boolean | null`) is computed by the engine area and merged into the same block (seam).

### 3.13 Allocation targets and household investment settings

`setAllocationTargets(db, targets, ctx)`: duplicate asset classes are rejected by the Zod body (`400 validation`); the service rejects a non-empty set whose Σ `target_bp` ≠ 10 000 (`400 allocation_sum`, message names the sum); replaces the table as a whole set (`DELETE` then `INSERT`, one transaction); audited as `allocation_target`, entity id `household`, before/after = the sorted `[{ assetClass, targetBp }]` lists (an identical re-send writes nothing). `updateHouseholdSetting` gains `benchmarkSecurityId` (must exist and not be `cash`, else `400 validation`; null clears) and `dividendsAsIncome`; `householdSettingAuditJson` includes both.

## 4. Contracts (`packages/shared/src/api.ts`, section "Phase 3: investments"; enums in `enums.ts`)

```ts
// enums.ts
export const SecurityType = z.enum(['stock','etf','fund','bond','cash','cd','other']);
export const AssetClass = z.enum(['us_stock','intl_stock','bonds','cash','real_estate','other']);
export const InvestmentTxnType = z.enum(['buy','sell','dividend','interest','reinvest','fee','split','transfer']);
export const TransferDirection = z.enum(['in','out']);
export const HoldingSource = z.enum(['simplefin','csv','manual']);
export const PriceSource = z.enum(['provider','implied','manual']);
export const InvestmentFidelity = z.enum(['balance_only','positions','full_history']);
export const CsvKind = z.enum(['bank','positions','trades']);
export const JobType = z.enum([...existing, 'simplefin.reprocess_holdings', 'prices.fetch']);
export const AuditEntity = z.enum([...existing, 'security','investment_txn','holding_snapshot','allocation_target']);
export const INVESTMENT_ACCOUNT_TYPES = ['brokerage','401k','ira','roth','hsa','529'] as const;

// api.ts
export const DecimalString = z.string().regex(/^-?\d+(\.\d{1,8})?$/, 'decimal with up to 8 places');
export const QuantityString = DecimalString; export const PriceString = z.string().regex(/^\d+(\.\d{1,8})?$/);
export const PercentString = z.string().regex(/^\d{1,2}(\.\d{1,4})?$/);   // expense ratio entry: "0.03" → 300 ppm
export const SecurityIdentityKind = z.enum(['ticker','cusip','isin','name']);

export const SecuritySuggestion = z.object({ ticker: z.string().nullable(), cusip: z.string().nullable(), isin: z.string().nullable(), name: z.string(), type: SecurityType, assetClass: AssetClass });
export const SecurityView = z.object({ id: z.string().uuid(), ticker: z.string().nullable(), name: z.string(), type: SecurityType, assetClass: AssetClass,
  expenseRatioPpm: z.number().int().nullable(), cusip: z.string().nullable(), isin: z.string().nullable(), currency: z.string(), priceMode: PriceSource, providerSymbol: z.string().nullable(),
  needsReview: z.boolean(), archived: z.boolean(), notes: z.string().nullable(), aliases: z.array(z.object({ kind: SecurityIdentityKind, value: z.string() })),
  held: z.boolean(), heldInAccounts: z.number().int(), latestPrice: z.object({ date: IsoDateString, close: PriceString, source: PriceSource }).nullable(), createdAt: z.string(), updatedAt: z.string() });
export const SecurityQuery = z.object({ q: z.string().max(100).optional(), needsReview: QueryBoolean.optional(), held: QueryBoolean.optional(), type: SecurityType.optional(), includeArchived: QueryBoolean.optional() });
export const CreateSecurityBody = z.object({ ticker: z.string().max(20).nullable().optional(), name: z.string().min(1).max(200), type: SecurityType, assetClass: AssetClass,
  expenseRatioPercent: PercentString.nullable().optional(), cusip: z.string().length(9).nullable().optional(), isin: z.string().length(12).nullable().optional(),
  currency: z.string().length(3).optional(), priceMode: PriceSource.optional(), providerSymbol: z.string().max(20).nullable().optional(), notes: z.string().max(2000).nullable().optional() });
export const UpdateSecurityBody = CreateSecurityBody.partial().extend({ needsReview: z.boolean().optional(), archived: z.boolean().optional() });
export const MergeSecurityBody = z.object({ fromId: z.string().uuid() });
export const AddSecurityAliasBody = z.object({ kind: SecurityIdentityKind, value: z.string().min(1).max(200) });
export const SetPriceBody = z.object({ date: IsoDateString, close: PriceString });
export const ResolveSecurityQuery = z.object({ ticker: z.string().max(20).optional(), cusip: z.string().length(9).optional(), isin: z.string().length(12).optional(), name: z.string().max(200).optional() });
export const ResolveSecurityResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), security: SecurityView, matchedBy: z.enum(['alias','ticker','cusip','isin','name','cash']) }),
  z.object({ status: z.literal('unresolved'), suggestion: SecuritySuggestion }) ]);
/** How a preview row names its security on commit. */
export const SecurityChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), securityId: z.string().uuid() }),
  z.object({ kind: z.literal('create'), security: SecuritySuggestion }) ]);
export const RowChoice = z.object({ rowIndex: z.number().int(), security: SecurityChoice.optional(), split: z.object({ num: z.number().int().min(1), den: z.number().int().min(1) }).optional() });
export const PreviewSecurityRef = z.object({ id: z.string().uuid().nullable(), ticker: z.string().nullable(), name: z.string(), matchedBy: z.enum(['alias','ticker','cusip','isin','name','cash','choice','new']),
  isNew: z.boolean(), needsReview: z.boolean(), isCash: z.boolean(), suggestion: SecuritySuggestion.nullable() });

export const PositionsPreviewBody = z.object({ csvText: z.string().min(1).max(10_000_000), accountId: z.string().uuid(), mapping: PositionsCsvMapping.optional(), profileId: z.string().uuid().optional(),
  asOfDate: IsoDateString.optional(), accountFilterValue: z.string().max(100).optional(), choices: z.array(RowChoice).default([]) });
export const MappedPositionView = z.object({ rowIndex: z.number().int(), security: PreviewSecurityRef, quantity: QuantityString.nullable(), price: PriceString.nullable(), valueCents: CentsString,
  costBasisCents: CentsString.nullable(), warnings: z.array(z.string()), existing: z.object({ quantity: QuantityString.nullable(), valueCents: CentsString }).nullable() });
export const PositionsPreviewResponse = z.object({ headers: z.array(z.string()), sampleRows: z.array(z.array(z.string())), mapping: PositionsCsvMapping.nullable(), asOf: IsoDateString.nullable(),
  positions: z.array(MappedPositionView), totalValueCents: CentsString, knownBalanceCents: CentsString.nullable(), differenceCents: CentsString.nullable(), matchesToDollar: z.boolean().nullable(),
  setBalanceDefault: z.boolean(), filterValues: z.array(z.string()), pendingActivityCents: CentsString,
  snapshotExists: z.boolean(), existingSource: HoldingSource.nullable(), willReplace: z.boolean(), rowsRead: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })), skipped: z.array(z.object({ rowIndex: z.number().int(), reason: z.string() })) });
export const PositionsCommitBody = PositionsPreviewBody.extend({ mapping: PositionsCsvMapping, asOfDate: IsoDateString.optional(), setBalance: z.boolean().optional(),
  saveProfile: z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100) }).optional() });
export const PositionsImportResult = z.object({ importLogId: z.string().uuid(), asOf: IsoDateString, positions: z.number().int(), inserted: z.number().int(), updated: z.number().int(), unchanged: z.number().int(),
  deleted: z.number().int(), securitiesCreated: z.number().int(), impliedPrices: z.number().int(), totalValueCents: CentsString, knownBalanceCents: CentsString.nullable(), differenceCents: CentsString.nullable(),
  matchesToDollar: z.boolean().nullable(), balanceWritten: z.boolean(), errors: z.array(z.object({ rowIndex: z.number().int().optional(), message: z.string() })) });

export const TradesPreviewBody = z.object({ csvText: z.string().min(1).max(10_000_000), accountId: z.string().uuid(), mapping: TradesCsvMapping.optional(), profileId: z.string().uuid().optional(),
  accountFilterValue: z.string().max(100).optional(), choices: z.array(RowChoice).default([]) });
export const MappedTradeView = z.object({ rowIndex: z.number().int(), sequence: z.number().int(), date: IsoDateString, type: InvestmentTxnType, kind: TradeKind, security: PreviewSecurityRef.nullable(),
  quantity: QuantityString.nullable(), price: PriceString.nullable(), amountCents: CentsString, feeCents: CentsString, splitNum: z.number().int().nullable(), splitDen: z.number().int().nullable(),
  transferDirection: TransferDirection.nullable(), externalId: z.string(), rawDescription: z.string(), derived: z.array(z.enum(['amount','price'])), warnings: z.array(z.string()),
  duplicate: z.boolean(), changed: z.boolean(), userEdited: z.boolean(), ledgerMatch: z.object({ transactionId: z.string().uuid(), date: IsoDateString }).nullable() });
export const ActionFoundView = z.object({ key: z.string(), sample: z.string(), count: z.number().int(), kind: TradeKind.nullable(), fromProfile: z.boolean(), sampleRowIndex: z.number().int() });
export const TradesPreviewResponse = z.object({ headers: z.array(z.string()), sampleRows: z.array(z.array(z.string())), mapping: TradesCsvMapping.nullable(), rowOrder: z.enum(['oldest_first','newest_first']).nullable(),
  trades: z.array(MappedTradeView), totalRows: z.number().int(), duplicateCount: z.number().int(), changedCount: z.number().int(), userEditedCount: z.number().int(),
  actionsFound: z.array(ActionFoundView), unknownActions: z.number().int(), filterValues: z.array(z.string()),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })), skipped: z.array(z.object({ rowIndex: z.number().int(), reason: z.string(), text: z.string() })) });
export const TradesCommitBody = TradesPreviewBody.extend({ mapping: TradesCsvMapping, saveProfile: z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100) }).optional() });
export const TradesImportResult = z.object({ importLogId: z.string().uuid(), created: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), skippedEdited: z.number().int(), linked: z.number().int(),
  ledgerCreated: z.number().int(), ledgerSkipped: z.number().int(), transfersPaired: z.number().int(), securitiesCreated: z.number().int(), lotsRebuilt: z.number().int(),
  warnings: z.array(z.object({ rowIndex: z.number().int().optional(), message: z.string() })), errors: z.array(z.object({ rowIndex: z.number().int().optional(), message: z.string() })) });

export const HoldingRowView = z.object({ securityId: z.string().uuid(), ticker: z.string().nullable(), name: z.string(), quantity: QuantityString.nullable(), price: PriceString.nullable(), valueCents: CentsString, reportedCostBasisCents: CentsString.nullable() });
export const HoldingSnapshotView = z.object({ accountId: z.string().uuid(), date: IsoDateString, source: HoldingSource, importLogId: z.string().uuid().nullable(), rows: z.array(HoldingRowView), totalValueCents: CentsString,
  knownBalanceCents: CentsString.nullable(), differenceCents: CentsString.nullable(), matchesToDollar: z.boolean().nullable(), updatedAt: z.string() });
export const SnapshotSummaryView = z.object({ date: IsoDateString, source: HoldingSource, positions: z.number().int(), totalValueCents: CentsString });
export const ManualPositionInput = z.object({ security: SecurityChoice, quantity: QuantityString.nullable().optional(), price: PriceString.optional(), valueCents: CentsString.optional(), costBasisCents: CentsString.nullable().optional() })
  .refine(p => p.price !== undefined || p.valueCents !== undefined, 'price or valueCents required').refine(p => p.price === undefined || (p.quantity !== undefined && p.quantity !== null), 'price needs a quantity');
export const ManualPositionsBody = z.object({ asOfDate: IsoDateString, setBalance: z.boolean().optional(), positions: z.array(ManualPositionInput).min(1).max(500) });

export const LotSelection = z.array(z.object({ lotId: z.string().uuid(), quantity: PriceString })).min(1).max(200);
export const InvestmentTxnView = z.object({ id: z.string().uuid(), accountId: z.string().uuid(), accountName: z.string(), securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), securityName: z.string().nullable(),
  date: IsoDateString, sequence: z.number().int(), type: InvestmentTxnType, quantity: QuantityString.nullable(), price: PriceString.nullable(), amountCents: CentsString, feeCents: NonNegCentsString,
  splitNum: z.number().int().nullable(), splitDen: z.number().int().nullable(), transferDirection: TransferDirection.nullable(), counterpartyAccountId: z.string().uuid().nullable(), transferGroupId: z.string().uuid().nullable(),
  costBasisCents: CentsString.nullable(), acquiredDate: IsoDateString.nullable(), lotSelection: LotSelection.nullable(), transactionId: z.string().uuid().nullable(), externalId: z.string().nullable(),
  source: z.enum(['csv','manual']), importLogId: z.string().uuid().nullable(), rawDescription: z.string().nullable(), memo: z.string().nullable(), userEdited: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
export const InvestmentTxnQuery = z.object({ accountId: z.string().uuid().optional(), securityId: z.string().uuid().optional(), type: InvestmentTxnType.optional(), from: IsoDateString.optional(), to: IsoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional() });
export const InvestmentTxnList = z.object({ items: z.array(InvestmentTxnView), nextCursor: z.string().nullable() });
const TradeBase = { accountId: z.string().uuid(), date: IsoDateString, memo: z.string().max(2000).optional(), today: IsoDateString.optional() };
export const CreateInvestmentTxnBody = z.discriminatedUnion('type', [
  z.object({ ...TradeBase, type: z.enum(['buy','reinvest']), securityId: z.string().uuid(), quantity: PriceString, price: PriceString, amountCents: CentsString.optional(), feeCents: NonNegCentsString.optional() }),
  z.object({ ...TradeBase, type: z.literal('sell'), securityId: z.string().uuid(), quantity: PriceString, price: PriceString, amountCents: CentsString.optional(), feeCents: NonNegCentsString.optional(), lotSelection: LotSelection.optional() }),
  z.object({ ...TradeBase, type: z.enum(['dividend','interest']), securityId: z.string().uuid().nullable().optional(), amountCents: CentsString }),
  z.object({ ...TradeBase, type: z.literal('fee'), securityId: z.string().uuid().nullable().optional(), amountCents: CentsString }),
  z.object({ ...TradeBase, type: z.literal('split'), securityId: z.string().uuid(), splitNum: z.number().int().min(1), splitDen: z.number().int().min(1), quantity: PriceString.optional() }),
  z.object({ ...TradeBase, type: z.literal('transfer'), direction: TransferDirection, securityId: z.string().uuid().nullable().optional(), quantity: PriceString.optional(), amountCents: CentsString.optional(),
    counterpartyAccountId: z.string().uuid().optional(), costBasisCents: NonNegCentsString.nullable().optional(), acquiredDate: IsoDateString.nullable().optional(), lotSelection: LotSelection.optional() }),
]);
export const UpdateInvestmentTxnBody = z.object({ type: InvestmentTxnType.optional(), transferDirection: TransferDirection.nullable().optional(), date: IsoDateString.optional(), securityId: z.string().uuid().nullable().optional(),
  quantity: PriceString.nullable().optional(), price: PriceString.nullable().optional(), amountCents: CentsString.optional(), feeCents: NonNegCentsString.optional(),
  splitNum: z.number().int().min(1).nullable().optional(), splitDen: z.number().int().min(1).nullable().optional(), costBasisCents: NonNegCentsString.nullable().optional(), acquiredDate: IsoDateString.nullable().optional(),
  lotSelection: LotSelection.nullable().optional(), transactionId: z.string().uuid().nullable().optional(), transferGroupId: z.null().optional(), memo: z.string().max(2000).nullable().optional(), today: IsoDateString.optional() });
export const DeleteInvestmentTxnQuery = z.object({ deleteGroup: QueryBoolean.optional() });
export const CreateInvestmentTxnResponse = z.object({ items: z.array(InvestmentTxnView), batchId: z.string().uuid() });

export const AllocationTargetsView = z.object({ targets: z.array(z.object({ assetClass: AssetClass, targetBp: z.number().int().min(0).max(10000) })), updatedAt: z.string().nullable() });
export const SetAllocationTargetsBody = z.object({ targets: z.array(z.object({ assetClass: AssetClass, targetBp: z.number().int().min(0).max(10000) })).max(6) })
  .refine(b => new Set(b.targets.map(t => t.assetClass)).size === b.targets.length, 'duplicate asset class');   // the 10 000 bp sum is checked by the service (400 allocation_sum)

export const AccountInvestmentView = z.object({ fidelity: InvestmentFidelity, lastSnapshotDate: IsoDateString.nullable(), lastSnapshotSource: HoldingSource.nullable(), lastTradeDate: IsoDateString.nullable(),
  securityCount: z.number().int(), needsReviewCount: z.number().int(), reconciled: z.boolean().nullable() });
// AccountView gains: investment: AccountInvestmentView.nullable()
// HouseholdSettingView gains: benchmarkSecurityId: z.string().uuid().nullable(), dividendsAsIncome: z.boolean(); UpdateHouseholdSettingBody gains both, optional (benchmark nullable)
// ConnectionView gains: csvKind: CsvKind, positionsMapping: PositionsCsvMapping.nullable(), tradesMapping: TradesCsvMapping.nullable()  (csvMapping stays the bank mapping and is null for other kinds, so ConnectionsPage's typed rendering is unchanged)
// ImportLogView.kind and JobView.type accept the new values (z.string() / the widened JobType)
```

Routes (`apps/api/src/routes/investments.ts`, plus the four import routes added to `routes/import.ts`; all behind auth; GETs allowed to the viewer role, mutations owner-only; `usePlanErrors` maps `PlanError` codes; `resolveToday` and `auditContext` from `routes/plan.ts`):

| Method and path | Body → response | Notes |
| --- | --- | --- |
| `GET /api/investments/securities` | `SecurityQuery` → `SecurityView[]` | archived hidden unless asked |
| `POST /api/investments/securities` | `CreateSecurityBody` → `SecurityView` | 409 `duplicate_ticker` / `duplicate_cusip` / `duplicate_isin`; 400 `cash_security_reserved` for type `cash`; audited |
| `PATCH /api/investments/securities/:id` | `UpdateSecurityBody` → `SecurityView` | saving clears `needsReview` unless the body sets it; cash: 400 `cash_security_reserved`; audited |
| `DELETE /api/investments/securities/:id` | → `OkResponse` | 409 `security_in_use` |
| `POST /api/investments/securities/:id/merge` | `MergeSecurityBody` → `SecurityView` | 400 `merge_self`; audited |
| `POST /api/investments/securities/:id/aliases` | `AddSecurityAliasBody` → `SecurityView` | 409 `alias_taken` |
| `POST /api/investments/securities/:id/prices` | `SetPriceBody` → `OkResponse` | source `manual`; audited |
| `GET /api/investments/securities/resolve` | `ResolveSecurityQuery` → `ResolveSecurityResponse` | typeahead for the preview and the manual forms; never creates |
| `POST /api/import/positions/preview` | `PositionsPreviewBody` → `PositionsPreviewResponse` | 400 `empty_csv`, `bad_mapping`, `bad_profile`, `as_of_required` |
| `POST /api/import/positions/commit` | `PositionsCommitBody` → `PositionsImportResult` | 400 `no_rows`, `as_of_required`, `not_investment_account`, `future_date`; 409 `snapshot_precedence`; profile `csv_kind positions` |
| `POST /api/import/trades/preview` | `TradesPreviewBody` → `TradesPreviewResponse` | |
| `POST /api/import/trades/commit` | `TradesCommitBody` → `TradesImportResult` | 400 `unknown_action` (lists keys), `no_rows`, `not_investment_account`, `future_date`, `split_ratio_required`; profile `csv_kind trades` |
| `GET /api/investments/accounts/:id/snapshots` | → `SnapshotSummaryView[]` | for the date picker |
| `GET /api/investments/accounts/:id/snapshots/:date` | → `HoldingSnapshotView` | 404 `snapshot_not_found` |
| `GET /api/investments/accounts/:id/positions` | `?date=` → `HoldingSnapshotView` | latest snapshot on/before date (default today) |
| `PUT /api/investments/accounts/:id/positions` | `ManualPositionsBody` → `HoldingSnapshotView` | manual; audited |
| `DELETE /api/investments/accounts/:id/snapshots/:date` | → `OkResponse` | 409 `snapshot_source` for simplefin; audited |
| `GET /api/investments/transactions` | `InvestmentTxnQuery` → `InvestmentTxnList` | keyset on `(date, sequence, id)` descending |
| `POST /api/investments/transactions` | `CreateInvestmentTxnBody` → `CreateInvestmentTxnResponse` | one or two rows (transfer legs); audited; rebuilds lots |
| `PATCH /api/investments/transactions/:id` | `UpdateInvestmentTxnBody` → `InvestmentTxnView` | 409 `transfer_leg_linked`; sets `userEdited` on imported rows |
| `DELETE /api/investments/transactions/:id?deleteGroup=` | → `OkResponse` | 409 `transfer_leg_linked` |
| `GET /api/investments/allocation-targets` | → `AllocationTargetsView` | |
| `PUT /api/investments/allocation-targets` | `SetAllocationTargetsBody` → `AllocationTargetsView` | 400 `allocation_sum`; audited `allocation_target/household` |
| `POST /api/connections/:id/reprocess-holdings` | → `JobView` | enqueues `simplefin.reprocess_holdings { connectionId }` deduped; 400 `not_simplefin` |
| `PATCH /api/settings` | gains `benchmarkSecurityId`, `dividendsAsIncome` | audited as today |
| `PATCH /api/accounts/:id` | existing | a `type` change into or out of the investment types is refused with 409 `account_has_investment_data` when the account has snapshots or trades |

Error codes (PlanError → HttpError): `validation`, `txn_invalid`, `amount_required`, `quantity_required`, `security_required`, `not_investment_account`, `future_date`, `snapshot_precedence`, `snapshot_not_found`, `snapshot_source`, `security_not_found`, `security_in_use`, `duplicate_ticker`, `duplicate_cusip`, `duplicate_isin`, `cash_security_reserved`, `merge_self`, `alias_taken`, `lot_not_found`, `lot_insufficient`, `lot_selection_sum`, `transfer_same_account`, `transfer_leg_linked`, `allocation_sum`, `bad_mapping`, `bad_profile`, `empty_csv`, `no_rows`, `as_of_required`, `unknown_action`, `split_ratio_required`, `not_simplefin`, `account_has_investment_data`.

## 5. UI (`apps/web`)

- **Import page** (`/import`, existing `ImportPage.tsx`): a kind switch at the top — Bank transactions (unchanged) / Brokerage positions / Trade history. Shared three-card skeleton: 1. file + account (investment accounts only for the two new kinds) + saved profile of that kind → 2. mapping editor (`components/import/PositionsMappingEditor.tsx`, `TradesMappingEditor.tsx`, same select-per-field style as the bank editor; positions adds an "as of" date input when the file has no date column and an account-filter picker listing `filterValues` when the column is set; trades adds the fee-columns multi-select, the "amount includes fees" and "reinvest rows carry the dividend" toggles and the row-order select) → 3. preview → commit.
  Positions preview: table of positions with security badges (`new` with inline name/type/asset-class edit and a "link to existing…" picker backed by `GET /securities/resolve`, `guessed`, `cash`), quantity (or "value only"), price, value, cost, the existing row's values when a snapshot for that date exists; a reconciliation line "Positions total $3,337.75 · Bridge balance $3,350.09 · difference $12.34" in `ok` tone with "matches to the dollar" when `matchesToDollar`, `warn` otherwise, hidden when `knownBalanceCents` is null; the "also set the account balance" checkbox (default `setBalanceDefault`); a yellow bar "A csv snapshot for 2026-10-13 exists and will be replaced" / red "A manual snapshot exists; delete it first" (commit disabled); lists of skipped rows with reasons and the pending-activity amount. Commit button: "Import N positions as of DATE".
  Trades preview: an "Actions found" table above the rows (key, sample text, count, kind select over every `TradeKind` including `skip`, "saved" marker when it came from the profile); unknown actions highlighted and commit disabled while `unknownActions > 0` ("3 rows were not recognised; map them or skip them"); rows grouped by date with the resolved row order shown ("file is newest-first; imported oldest-first"); `duplicate` rows muted, `changed` rows marked, `userEdited` rows marked "edited by hand, kept"; derived values italic; warnings as a tooltip icon; the ledger link shown as "↔ ledger 2026-09-16"; a hint under the table when `reinvest_without_dividend` warnings exist. Commit button: "Import N trades (M already imported)". After commit: the result line and a "Review 2 new securities" link when `securitiesCreated > 0`.
  Empty states: no investment accounts → "Add a brokerage or retirement account first (Accounts page)"; mapping not guessable → the Phase 1 "build a mapping by hand" button. Errors through `ErrorText`; row errors listed (first 50).
- **Securities page** (`/investments/securities`, `SecuritiesPage.tsx`, nav "Securities"): filter chips All / Needs review / Held (Needs review on by default when any exist); table with inline edit of ticker, name, type, asset class, expense ratio (entered as a percent string, `percentToPpm` client-side: `"0.03"` → 300), price mode, latest price with its source badge, held-in-N-accounts; row actions Merge into… (dialog listing other securities; confirmation shows the row counts that will move), Add alias, Set price, Archive, Delete (disabled with the reason when in use). Empty state: "Securities appear here when positions or trades are imported or synced."
- **Accounts page**: investment accounts show a fidelity badge — "Balance only" (neutral), "Positions as of Oct 13" (info), "Full history" (ok) — with `needsReviewCount`, a "not reconciled" marker when `reconciled === false`, and links "Positions" / "Trades" / "Import". Investment accounts still on budget show "On budget — move off budget?" with a one-click PATCH `onBudget: false` (Decision 26). Changing an account's type into or out of the investment types is refused by the API when it has snapshots or trades (`409 account_has_investment_data`).
- **Account investments page** (`/investments/accounts/:id`, `AccountInvestmentsPage.tsx`) with two tabs. *Positions*: the latest snapshot table with a date picker fed by `GET …/snapshots`, the reconciliation line, "Edit positions" opening `PositionsEditor` (rows pre-filled from the snapshot: security typeahead with "create new" inline, quantity, price or value with the other shown computed, optional cost basis; as-of date; totals; Save → `PUT …/positions`), "Import positions CSV" link, snapshot history with delete for csv/manual snapshots. *Trades*: `InvestmentTxnTable` newest first with type badges and lock/edited markers ("imported from <profile> on <date>" with an Edit that warns "re-imports will no longer refresh this row"), "Record trade" opening `components/investments/TradeForm.tsx`, a type-switched form matching `CreateInvestmentTxnBody` (buy/sell/reinvest: quantity, price, fee, amount auto-filled from the rounding rule and editable; sell: optional lot picker fed by the engine's lot list, several lots allowed; dividend/interest/fee: amount; split: ratio new:old; transfer: direction, security or cash, counterparty account, basis and acquired date for outside transfers), "Move to another account" (a transfer with counterparty pre-set), "Import trade history" link.
- **Investment transactions list** (`/investments/transactions`, `InvestmentTransactionsPage.tsx`): filterable across accounts (account, security, type, dates) reusing `InvestmentTxnTable` and `TradeForm`.
- **Settings page**: an "Investments" card with the Benchmark select (securities typeahead), the "Count dividends and interest as plan income" toggle (`dividendsAsIncome`) and the `AllocationTargetsEditor` component (`components/investments/AllocationTargetsEditor.tsx`: six rows with percent inputs, live sum, save disabled unless 100.00 % or all blank); the views area embeds the same component on the Allocation view.
- **Connections page**: csv profiles show their kind ("Fidelity · positions"); per SimpleFIN connection a "Holdings" line from the last sync's stats/errors ("2 accounts with positions · 1 account unrecognised — keys: foo, bar") and a "Re-process holdings" button (`POST …/reprocess-holdings`).
- States: every page has loading, empty and error states via the existing `Card`, `Empty`, `ErrorText`, `Badge`; mutations invalidate `['accounts']`, `['securities']`, `['snapshots', accountId]`, `['investment-transactions']`, `['connections']`, `['settings']`.

## 6. Jobs and services

Services (`packages/db/src/services`, all take `DbOrTx` where read-only and `Db` where they open a transaction, as the Phase 2 ones do; exported from `services/index.ts`):
- `securities.ts`: `resolveSecurity`, `cashSecurity`, `learnAliases`, `listSecurities`, `createSecurity`, `updateSecurity`, `deleteSecurity`, `mergeSecurities`, `addSecurityAlias`, `upsertPrice`, `setManualPrice`, `securityAuditJson`, `listHeldSecurityIds(db)` (latest snapshot per account with value ≠ 0 ∪ lots with `remaining_quantity > 0`; the prices area's "held securities only").
- `holdings.ts`: `replaceHoldingSnapshot`, `writeImpliedPrices`, `applySimplefinHoldings`, `importPositions`, `setManualPositions`, `listSnapshots`, `getSnapshot`, `latestSnapshot`, `deleteSnapshot`, `loadAccountInvestmentInfo`.
- `investmentTxns.ts`: `upsertInvestmentTxns`, `importTrades`, `createManualInvestmentTxn`, `updateInvestmentTxn`, `deleteInvestmentTxn`, `linkToLedger`, `linkUnlinkedInvestmentTxns`, `pairInvestmentTransfers`, `listInvestmentTxns`, `investmentTxnAuditJson`.
- `allocationTargets.ts`: `getAllocationTargets`, `setAllocationTargets`.
- `decimalDb.ts`: `qtyFromDb`, `qtyToDb`.
- Changed: `sync.ts` (`applyAccountSet` runs `applySimplefinHoldings` per account in its own transaction and merges its stats/errors; then `linkUnlinkedInvestmentTxns`), `ingest.ts` (`IngestOptions.accountType`, first parameter `DbOrTx`, the contribution classifier after rules), `accounts.ts` (`upsertSimplefinAccount` inserts `onBudget = false` for investment types), `settings.ts` (two new patch fields), `plan.ts` / `transactions.ts` (`on_budget = true` filter in `loadActuals`, `loadUncategorized`, `countUncategorized`; Deviation 12).
- Shared pure modules: `decimal.ts`, `investments.ts` (`normalizeTicker`, `normalizeName`, `isCashKey`, `guessSecurityHints`, `accountFidelity`, `classifyInvestmentInflow`, `tradeExternalId`, `actionKey`), `investmentsCsv.ts`, `simplefinHoldings.ts`; all exported from `packages/shared/src/index.ts`.

Jobs (`apps/worker/src/jobs`, dispatched by `dispatchJob`):
- `simplefin.sync` / `simplefin.balances` (existing): unchanged flow; the holdings parse and apply run inside `applyAccountSet` per account, each in its own transaction wrapped so a failure records `holdings.parse_error` and the sync still completes; stats and errors land on the same `import_log` row and `connection.last_errors`; `prices.fetch { reason: 'holdings' }` is enqueued (deduped) when a security was created.
- `simplefin.reprocess_holdings` (new, `jobs/reprocessHoldings.ts`), payload `{ connectionId, importLogId? }`, deduped by connection (the existing `enqueueJob` dedupe keys on `payload.connectionId`): loads the connection's `import_log` rows of kind `simplefin.sync | simplefin.balances` with `status = 'ok'` and a non-null `raw_payload` (one row when `importLogId` is given, else all, oldest first, capped at 200), parses each with `SimplefinAccountSet.safeParse` (a payload that fails to parse is skipped and counted, never fatal), maps accounts by `(connection_id, external_id)` (unknown accounts skipped and counted), runs `applySimplefinHoldings` with source `simplefin` so csv/manual snapshots are never replaced, sets `stats.reprocessedAt` (unix ms, a number) on each processed row, and writes its own summary `import_log` row of kind `simplefin.reprocess` with `message = 'Reprocessed holdings from N payloads'`, the merged stats and no raw payload (nothing new was fetched). Idempotent: running it twice yields `updated 0`.
- `prices.fetch` (prices area): enqueued here with `{ reason: 'holdings' }`, deduped by type, after every positions import, manual snapshot save and security creation; its handler is theirs.
- `recurring.detect` is enqueued only when a trades import created ledger rows (CSV-only accounts); positions imports never touch the ledger.
- Lot rebuilds run inline inside the importing/mutating transaction (engine's `rebuildLots`); no job.
- Failure handling: the import routes write the `import_log` row before any mutation and mark it `error` with the message on failure (the Phase 1 pattern), so a failed commit is visible and the raw file is still kept; everything after the log row runs in one transaction (securities, snapshot or trades, ledger rows, prices, balance, lots), so a failure leaves no partial snapshot or half-imported trades. The reprocess job retries with the runner's backoff (nothing in it is permanent).

## 7. Test cases

Pure tests in `packages/shared/src/{decimal,simplefinHoldings,investmentsCsv,investments}.test.ts`; DB tests in `packages/db/src/services/{securities,holdings,investmentTxns,allocationTargets}.test.ts` inside `describe.skipIf(!TEST_DATABASE_URL)` with `createTestDb()`; route tests in `apps/api/src/investments.test.ts`; the sync integration in `apps/worker/src/jobs/sync.test.ts` (fixture extended with a fourth account `ACT-BRK-001`). Today = 2026-10-14 unless stated. Every number below was re-run with a bigint reference script.

1. **Fixed8 parse/format.** `parseFixed8("12.345")` = 1 234 500 000n; `parseFixed8("-0.00000001")` = −1n; `parseFixed8("1000")` = 100 000 000 000n; `parseFixed8("12.50000000")` = 1 250 000 000n (Postgres form); `parseFixed8("1.123456789")`, `"1e5"`, `""`, `"1,000"` throw. `formatFixed8`: `"12.345"`, `"-0.00000001"`, `"1000"`, `formatFixed8(parseFixed8("12.50000000"))` = `"12.5"`, `formatFixed8(0n)` = `"0"`. `parseLooseDecimal("$1,234.50")` = 123 450 000 000n; `"(12.5)"` → −1 250 000 000n; `"12.5-"` → −1 250 000 000n; `"0.123456789"`, `"abc"`, `""` → undefined. `fixed8FromJsonNumber(41.2)` = 4 120 000 000n; `210.1234` → 21 012 340 000n; `1e-9`, `1e21`, `0.1 + 0.2`, `NaN` → undefined. `percentToPpm("0.03")` = 300, `"0.015"` = 150, `"1.25"` = 12 500, `"0.00001"` throws; `ppmToPercent(300)` = `"0.03"`.
2. **Rounding rule.** `roundDiv`: (5,2)→3, (−5,2)→−3, (7,2)→4, (−7,2)→−4, (4,2)→2, (1,3)→0, (−1,3)→0; (1,0) throws. `mulToCents`: 12.345 × 101.23 → 124 968; 0.5 × 10.01 → 501; 3 × 33.333333 → 10 000; −1.5 × 2.01 → −302; 0.001 × 0.5 → 0; 1 × 0.005 → 1; 2.5 × 0.002 → 1; 1.5 × 0.01 → 2; 100 × 0.00000001 → 0; 150.25 × 123.4567 → 1 854 937; 12.5 × 123.456 → 154 320; 0.333 × 10.01 → 333. `fixed8ToCents(parseFixed8("3094.4025"))` → 309 440 (caller flags `value_rounded`); `"3094.405"` → 309 441.
3. **Implied price.** `impliedPrice(124968n, 12.345)` → `"101.22964763"`; `(100000n, 7)` → `"142.85714286"`; `(318750n, 12.75)` → `"250"`; `(865708n, 41.2)` → `"210.12330097"`; `(1234n, 0.0523)` → `"235.94646272"`; `(1250000n, 37.123)` → `"336.71847642"`; `(10000n, 3)` → `"33.33333333"` and `mulToCents(3, "33.33333333")` → 10 000 (round trip); qty 0 throws; negative cents/qty use absolute values (`(−124968n, 12.345)` → same as the first).
4. **SimpleFIN parser, shape A (strings under `extra.holdings`).** Input of §3.3 example A with `balance-date 1791900000`. Expected: `status 'parsed'`, `container 'extra.holdings'`, `asOf '2026-10-13'`, 2 positions: VTI `{ ticker 'VTI', name 'Vanguard Total Stock Market ETF', quantity 1234500000n, price 25066000000n, valueCents 309440n, costBasisCents 250000n, isCash false, warnings [] }`; CASH `{ isCash true, quantity 15025000000n, price 100000000n, valueCents 15025n, costBasisCents null }`; `rejected []`, `keysSeen` ⊇ `['symbol','description','quantity','price','market_value','cost_basis']`. Mismatch tolerance pinned: VTI `market_value "3,100.00"` → `valueCents 310000n`, no warning (|310 000 − 309 440| = 560 ≤ max(1, 1 550)); `"3,200.00"` → `valueCents 320000n` kept with `warnings ['value_mismatch']` (10 560 > 1 600).
5. **SimpleFIN parser, shape B, keyed object, dollar-only, rejects.** Example B → `parsed`, container `'holdings'`, FXAIX `quantity 4120000000n, price 21012340000n, valueCents 865708n, cusip '315911750'`. Keyed object `extra: { positions: { VTI: { shares: "2", market_value: "500.00" } } }` → one position ticker `VTI`, quantity 200 000 000n, value 50 000n, price implied `"250"`. Example E → one position `quantity null, price null, valueCents 1234567n, warnings ['dollar_only']`. `{ symbol: "VTI", quantity: 1e-9 }` → rejected `unparseable:quantity`. `{ symbol: "VTI", shares: "3" }` (no price, no value) → rejected `missing_value`. `{ name: "Pending Activity", market_value: "12.34" }` → skipped `pending_activity`. `"junk"` as an element → rejected `unparseable:element`. Mixed asOf (`date: 1791900000` and `date: "2026-10-12"`) → asOf = balance-date, each position warned `asof_mixed`.
6. **SimpleFIN parser unrecognised/none; sync integration.** Example C → `unrecognized`, `keysSeen ['foo','bar']`; example D → `none`. DB (worker): a sync whose account set carries example A for the `brokerage` account `ACT-BRK-001` and example C for a second investment account → `import_log.stats` has `holdingsAccounts 1, holdingsPositions 2, holdingsUnrecognizedAccounts 1, securitiesCreated 2` (VTI with `needs_review true`, `Cash (USD)` with `needs_review false`), `import_log.errors` and `connection.last_errors` contain `{ code: 'holdings.unrecognized', message: 'Other: 1 of 1 holding rows could not be read (keys: foo, bar)', accountId: '<sf id>' }`; `holding_snapshot` has exactly 2 rows for (brokerage, 2026-10-13) with `source 'simplefin'`; `price` has one row `(VTI, 2026-10-13, 250.66, 'implied')` and none for cash; `connection.status` is still `ok`; the transaction counts of the sync match a run without holdings; a `prices.fetch` job with `reason 'holdings'` is queued once; the checking account's empty `extra` writes nothing and its `investment` view is `null`; the brokerage account was created with `on_budget false`. Running the same payload again → `updated 0, inserted 0, deleted 0` and no second `prices.fetch`. A `simplefin.balances` refresh also writes snapshots.
7. **Positions CSV mapping guess and aggregation.** The §3.6 Fidelity-style file. `guessPositionsMapping` → `{ hasHeader: true, asOf: { mode: 'request' }, symbol: { column: 'Symbol' }, name: { column: 'Description' }, quantity: { column: 'Quantity' }, price: { column: 'Last Price' }, value: { column: 'Current Value' }, costBasis: { column: 'Cost Basis Total' } }`. `mapPositionsCsvRows(rows, mapping, { asOfDate: '2026-10-13' })` → positions: VTI `quantity 1275000000n, price 25000000000n, valueCents 318750n, costBasisCents 260000n`; SPAXX `ticker 'SPAXX', quantity 15025000000n, price 100000000n, valueCents 15025n, costBasisCents null, warnings ['cost_unreadable']`; `skipped [{ rowIndex 4, reason 'pending_activity' }, { rowIndex 5, reason 'totals_row' }]`; `pendingActivityCents 1234n`; `errors []`; Σ value 333 775n. A row `VTI, …, 12.5, 123.456, $1,600.00` → warning `value_mismatch` (|160 000 − 154 320| = 5 680 > max(1, 800)). A row with quantity `abc` → error `unreadable quantity`. Without `asOfDate` → throws `as_of_required`. With `accountFilter` on an `Account Number` column and `accountFilterValue 'X123'`, rows with `Z999` are skipped `other_account` and `filterValues = ['X123','Z999']`.
8. **Positions commit idempotency, replacement, balance write.** DB: manual brokerage account (no connection), commit the Test 7 file as of 2026-10-13 → result `positions 2, inserted 2, securitiesCreated 2, impliedPrices 1, totalValueCents '333775', knownBalanceCents null, matchesToDollar null, balanceWritten true`; `balance_snapshot(account, 2026-10-13) = 333775, source 'csv'`; `account.balance_cents = 333775n, balance_date '2026-10-13'`; `import_log` row kind `csv.positions`, `raw_payload.csvText` equals the file, status `ok`. Commit the identical file again → `inserted 0, updated 0, unchanged 2, deleted 0`, a second `import_log` row, still 2 snapshot rows, `audit_log` unchanged (imports are not audited). Commit a file for the same date containing only SPAXX with quantity 160.00 → `updated 1, deleted 1`, VTI row gone, `balance_snapshot = 16000`, `account.balance_cents = 16000n`. Commit for 2026-09-30 (earlier) → `account.balance_date` stays 2026-10-13. Commit with `asOfDate 2026-10-15` → `400 future_date`, no import_log mutation beyond `status error`.
9. **Snapshot precedence and the reconciliation line.** DB: SimpleFIN-fed brokerage with `balance_snapshot(2026-10-13) = 335009 (simplefin)` and a csv snapshot for 2026-10-13 (VTI 12.75 / 318 750, SPAXX 150.25 / 15 025). Preview for that date → `knownBalanceCents '335009', differenceCents '-1234', matchesToDollar false, setBalanceDefault false, snapshotExists true, existingSource 'csv', willReplace true`. A file totalling 334 950 → `differenceCents '-59', matchesToDollar true`. A sync carrying extra holdings for the same date (VTI 12.345) → the csv rows are unchanged, `stats.holdingsSnapshotsKept = 1`, no error entry; `account.balance_cents` (335 009) untouched. A manual `PUT …/positions` for that date (VTI 13 @ 250) replaces the csv rows (`source 'manual'`) and is audited (`holding_snapshot`, entity `<accountId>:2026-10-13`, before = csv list, after = manual list). A later csv commit for that date → `409 snapshot_precedence`, its `import_log` row status `error`, rows unchanged. Commit with `setBalance: true` on the SimpleFIN-fed account → `balance_snapshot(2026-10-13)` becomes `333775 (csv)` and `balanceWritten true`; without it `balance_snapshot` is untouched. `DELETE …/snapshots/2026-10-13` → ok and audited; a `DELETE` of a simplefin snapshot → `409 snapshot_source`.
10. **Trade classification and sign forcing.** With defaults: `("YOU BOUGHT", "", qty)` → buy; `("Sold", "", qty)` → sell; `("DIVIDEND RECEIVED", "", no qty)` → dividend; `("REINVESTMENT", "", qty, amount −12.34)` → reinvest; `("Reinvest Dividend", "", no qty, +12.34)` → dividend; `("Reinvest Shares", "", qty, −12.34)` → reinvest; `("QUALIFIED DIVIDEND", "")` → dividend; `("INTEREST", "FDIC INTEREST")` → interest; `("Bank Interest", "")` → interest; `("", "ADR FEE")` → fee; `("Stock Split", "2 FOR 1")` → split num 2 den 1; `("Reverse Split", "1:10")` → 1, 10; `("TRANSFER OF SHARES", "RECEIVED FROM XYZ", qty)` → transfer_in; `("JOURNAL", "DELIVERED TO 1234", qty)` → transfer_out; `("ELECTRONIC FUNDS TRANSFER RECEIVED", "")` → cash_in; `("WITHDRAWAL", "")` → cash_out; `("Buy to Cover", "")` → buy; `("Sweep", "CORE FUND PURCHASE")` → skip; `("Foo", "Bar")` → undefined. With `reinvestRows 'combined'`: `("Dividend Reinvestment", "", qty, +12.34)` → reinvest_combined. `actionMap { "journaled": "skip" }` → `("JOURNALED SPP PURCHASE CREDIT (Cash)", "")` → skip by prefix; `actionMap { "foo": "fee" }` → `("Foo", "Bar")` → fee. Mapping a row `2026-10-01, YOU BOUGHT, VTI, -10, 250.00, , -2,500.00` (quantity negative in the file) → `type buy, quantity 1000000000n, price 25000000000n, amountCents −250000n, feeCents 0n, derived []`. Row `2026-10-05, Sold, VTI, 4, 249.65, 0, 998.60` → sell, amount +99 860n (sign forced even with `invert: true`). Row `2026-10-02, YOU BOUGHT, ABC, 5, 48.123, 4.95, ` (no amount) → `amountCents −24557n, feeCents 495n, derived ['amount']`. Row `2026-10-03, Sold, ABC, 5, , 0, 240.00` (no price) → `price "48"`, `derived ['price']`. Row with neither → error `amount_or_price_required`. Fidelity row with `Commission ($) 4.95`, `Fees ($) 0.02`, `amountIncludesFees false`, amount −1234.50 → buy amount −(123 450 + 497) = −123 947n, feeCents 497n. Dividend row with an empty symbol → error `security_required`.
11. **Stable ids and the two reinvest conventions.** File rows (defaults, no id column): `2026-10-01, YOU BOUGHT, VTI, 10, 250.00, , -2500.00` twice; `2026-09-15, DIVIDEND RECEIVED, VTI, , , , 12.34`; `2026-09-15, REINVESTMENT, VTI, 0.0523, , , -12.34`; `2026-10-05, Sold, VTI, 4, 249.65, 0, 998.60`. Expected externalIds: `inv:bf027e8f…1fa1cf0` and `…:1` (full hash in §3.8), `inv:1b5dee9f…aa1e294` (dividend +1 234n, quantity null), `inv:5d65e799…c581c2c` (reinvest −1 234n, quantity 5 230 000n, price implied `"235.94646272"`, `derived ['price']`), `inv:38638c9d…687955a` (sell +99 860n). The same file with the two 09-15 rows replaced by one row `2026-09-15, Dividend Reinvested, VTI, 0.0523, , , 12.34` and `reinvestRows 'combined'` yields the **same** dividend and reinvest ids; with the default `'separate'` it yields only the reinvest row plus a `reinvest_without_dividend` warning. With an id column (`T1`) the combined row yields `csvid:T1:div` and `csvid:T1:buy`. Reordering the file's rows changes `sequence` but not the ids.
12. **Row order and same-day sequence.** Newest-first file: `10/05/2026 Sold VTI 4 @ 249.65`, `10/05/2026 YOU BOUGHT VTI 4 @ 249.00`, `10/01/2026 YOU BOUGHT VTI 10 @ 250.00` → `rowOrder` resolves `newest_first`; sequences: 10-01 buy 0; 10-05 buy 0, sell 1; the engine replays buy 10, buy 4, sell 4 (holdings 10). The same rows in oldest-first order → `oldest_first`, identical sequences. `rowOrder 'oldest_first'` forced on the newest-first file → the sell gets 0 and the buy 1 (the owner's choice is honoured).
13. **Trade commit: idempotency, user edits, deletes.** DB: commit the Test 11 file → `created 5, lotsRebuilt 1`. Set `memo 'first lot'` on the first buy and `lotSelection [{ lotId, quantity '4' }]` on the sell via PATCH (audited; `userEdited` stays false because only user-owned columns changed). Commit a file whose sell row now reads `998.75` → `updated 1, unchanged 4, created 0`; the sell's `amount_cents = 99875n`, its `lot_selection` and the buy's `memo` unchanged; `rebuildLots` called once for (account, VTI). PATCH the sell's `price` to `249.70` → `userEdited true`; commit the file again → `skippedEdited 1`, the price stays 249.70; the preview showed `userEdited true` on that row. Commit a third file where the sell became a `YOU BOUGHT` row with the same id (and `user_edited` reset to false by hand) → type changes, `lot_selection` cleared, warning `lot_selection_cleared` with rowIndex. DELETE the first buy (imported) → ok, audited; re-committing the file recreates it (`created 1`), shown as non-duplicate in the preview.
14. **Unknown actions block commit; profile saves the map.** Preview the §3.8 worked file → `unknownActions 1`, `actionsFound` contains `{ key 'journaled spp purchase credit (cash)', count 1, kind null, fromProfile false }`; commit → `400 unknown_action` naming the key. Commit with `actionMap { 'journaled': 'skip' }` and `saveProfile { name: 'Fidelity' }` → ok, `skipped` contains the journal row with reason `skip`; the saved profile has `csv_kind 'trades'` and the map; a later preview with `profileId` shows `fromProfile true` for that key.
15. **Transfer legs: manual pair and CSV pairing.** DB: `POST /api/investments/transactions { type 'transfer', direction 'out', accountId A, securityId VTI, quantity '10', date '2026-10-06', counterpartyAccountId B }` → two rows, A: out, B: in, same `transfer_group_id`, `counterparty_account_id` crossed, both `amount_cents 0n`, one audit batch with two `investment_txn` create entries. PATCH the in leg's `quantity` → `409 transfer_leg_linked`. `DELETE` of the out leg without `deleteGroup` → `409 transfer_leg_linked`; with `deleteGroup=true` → both gone. CSV: A's file has `JOURNAL, DELIVERED, VTI, 10` on 2026-10-06 and B's file has `TRANSFER OF SHARES, RECEIVED, VTI, 10` on 2026-10-08 → after the second commit `pairInvestmentTransfers` links them (`transfersPaired 1`); a third unpaired in-leg of 10 VTI on 2026-10-20 in C stays unpaired (12 days). Cash: `{ type 'transfer', direction 'in', amountCents '50000', counterpartyAccountId B }` → A row `+50000n`, B row `−50000n`, `security_id null`; `direction 'in'` with `amountCents '-5'` → `400 txn_invalid` (`itx_transfer`).
16. **Cash rows reach the ledger for CSV-only accounts only.** DB: `chk` (checking) with a `−500 000` row on 2026-09-30 "TRANSFER TO BROKERAGE"; `brk` (CSV-only brokerage) linked to a goal. Commit the §3.8 file (journal mapped to skip) → `created 5` (4 trades + 1 cash transfer), `ledgerCreated 1`, `transfersPaired 1`; the ledger row has `source 'csv'`, `is_transfer true`, external id = `csvExternalId('2026-10-01', 500000n, 'ELECTRONIC FUNDS TRANSFER RECEIVED', 0)`, shares `transfer_pair_id` with the checking row; the investment cash row's `transaction_id` points at it; the goal's October actual includes +500 000; a `recurring.detect { reason: 'ledger' }` job is queued. Second commit → `created 0, unchanged 5, ledgerSkipped 1, transfersPaired 0`. The same file into a SimpleFIN-fed brokerage whose Bridge delivered `+5000.00 "EFT RECEIVED"` on 2026-10-02 → `ledgerCreated 0`, `linked 1` (`transaction_id` = the Bridge row, 1 day away); engine external flows for that account count the contribution once.
17. **Contribution classifier and ingest.** `classifyInvestmentInflow('401k', 'EMPLOYEE PRE-TAX CONTRIBUTION', 50000n)` → contribution; `('401k', 'EMPLOYER MATCH', 25000n)` → contribution; `('brokerage', 'ELECTRONIC FUNDS TRANSFER RECEIVED', 100000n)` → contribution; `('brokerage', 'DIVIDEND RECEIVED VTI', 1234n)` → null; `('brokerage', 'REINVESTMENT', 1234n)` → null; `('brokerage', 'YOU SOLD VTI', 99860n)` → null; `('checking', 'DEPOSIT', 100000n)` → null; `('ira', 'DISTRIBUTION', −200000n)` → null. DB: a SimpleFIN sync into a `401k` account with `EMPLOYEE PRE-TAX CONTRIBUTION +500.00` and `DIVIDEND +12.34` → the first has `is_transfer true, transfer_pair_id null, category_id null`, the second `is_transfer false`; a goal linked to the account counts +50 000 for the month; a checking outflow of −500.00 within 3 days then pairs with it; `PATCH { isTransfer: false }` on the contribution clears the pair and the flag; a rule "description contains CONTRIBUTION → category Income" wins (row keeps `is_transfer false`, category set).
18. **Fidelity derivation and the account block.** `accountFidelity({ hasTrades: false, hasSnapshots: false })` → `balance_only`; `(false, true)` → `positions`; `(true, false)` → `full_history`; `(true, true)` → `full_history`. DB: `GET /api/accounts` for a brokerage with one csv snapshot (2 securities, 1 needing review) and no trades → `investment: { fidelity 'positions', lastSnapshotDate '2026-10-13', lastSnapshotSource 'csv', lastTradeDate null, securityCount 2, needsReviewCount 1 }`; after a dividend-only trades import still `positions`; after one buy → `full_history`, `lastTradeDate` = the buy's date; after deleting that buy → `positions`; a checking account → `investment: null`. `PATCH /accounts/:id { type: 'checking' }` on that brokerage → `409 account_has_investment_data`.
19. **Security resolution, aliases and merge.** DB: `resolveSecurity({ ticker: 'spaxx**' }, createIfMissing)` → creates `ticker 'SPAXX'`, `type 'fund'`, `assetClass 'cash'` (money market), `needsReview true`, `priceMode 'provider'`; resolving `{ ticker: '$SPAXX' }` → same id, `matchedBy 'ticker'`. `{ name: 'Fidelity 500 Index Pool Class K' }` → created without ticker, `priceMode 'implied'`, guessed `type 'fund', assetClass 'us_stock'`; `{ name: 'FIDELITY 500 INDEX POOL - CLASS K' }` → same id by normalized name. `{ ticker: 'FXAIX', name: 'Fidelity 500 Index Pool Class K' }` → a **new** security (a ticker key never matches by name). `{ symbol: 'VANGUARD TARGET 2045 TRUST' }` in a symbol column → `normalizeTicker` null, resolved by name. Preview choice `existing FXAIX` for the pool row → `learnAliases` writes `name:'FIDELITY 500 INDEX POOL CLASS K'`; the next preview resolves it `matchedBy 'alias'`; adding the same alias to another security → `409 alias_taken`. Merge FXAIX ← the pool: snapshot rows for (acct, 2026-10-13) of both (qty 10 value 2 101.23 and qty 5 value 1 050.62) combine to qty 15, value 315 185n, price implied `"210.12333333"`; the loser row is gone; audit has an update (survivor) and a delete (loser) in one batch; merge A into A → `400 merge_self`. `cashSecurity('USD')` twice → one row; `POST /securities { type: 'cash' }` → `400 cash_security_reserved`; `DELETE` of a security with a snapshot → `409 security_in_use`. `resolveSecurity({ ticker: 'ZZZZ', name: 'UNKNOWN CO' }, { createIfMissing: false })` → `unresolved` with suggestion `{ ticker 'ZZZZ', name 'UNKNOWN CO', type 'stock', assetClass 'other' }`.
20. **Price precedence.** DB: `writeImpliedPrices` on 2026-10-13 for VTI 250.66 → `inserted`; `upsertPrice(provider, 250.70)` → `updated`, `close 250.7`; a later implied write of 250.66 → `kept`, close stays 250.7; `upsertPrice(manual, 251)` → `updated`; provider write → `kept`; re-running the implied write for the same value → `kept` (`updated_at` unchanged). Cash securities never get price rows; `POST /securities/<cash>/prices` → `400 cash_security_reserved`. A dollar-only position writes no price.
21. **Allocation targets and settings.** `PUT /allocation-targets` with `us_stock 6000, intl_stock 2000, bonds 1500, cash 500` → ok, `GET` returns the four rows (others absent), audit entry `allocation_target/household` with before `[]` and after the list; the same PUT again → no audit row; `us_stock 6000, bonds 3000` → `400 allocation_sum` (message "sums to 9000 bp"); a duplicate class → `400 validation` (Zod); `targets: []` clears the table. `PATCH /settings { benchmarkSecurityId: VTI, dividendsAsIncome: true }` → ok and audited with both fields; an unknown id or the cash security → `400 validation`; merging VTI into VOO repoints the setting.
22. **Ledger linking.** DB: brokerage account with ledger rows `2026-09-16 +12.34 "DIVIDEND VTI"` (SimpleFIN) and `2026-09-30 +12.34 "DIVIDEND BND"`. Trades import with a `dividend` 2026-09-15 +1 234n → links to the 09-16 row (distance 1 < 15); a second dividend 2026-09-29 +1 234n → links to the 09-30 row; a third on 2026-09-15 +1 234n → unlinked (both candidates taken); preview shows `ledgerMatch { transactionId, date '2026-09-16' }` on the first. A manual fee −495n on 2026-10-02 with a ledger row −4.95 on 2026-10-06 → unlinked (4 days). A sync that later delivers `−4.95` on 2026-10-03 → `linkUnlinkedInvestmentTxns` links the fee. Unlinking via PATCH `transactionId: null` is audited.
23. **Manual trade defaults and validation.** `POST { type 'buy', securityId ABC, quantity '5', price '48.123', feeCents '495' }` → `amountCents '-24557'`, `sequence 0`, `source 'manual'`, `external_id null`; a second buy the same day → `sequence 1`. `{ type 'sell', quantity '4', price '249.65' }` → `amountCents '99860'`; with `amountCents '-1'` → `400 txn_invalid` (`itx_sell`); `quantity '0'` → `400 validation`. `{ type 'split', splitNum 2, splitDen 1 }` → `amount_cents 0n, quantity null`; `splitNum 0` → `400 validation`. `{ type 'reinvest', quantity '0.0523', price '236.04' }` → `amountCents '-1234'`. `{ type 'dividend', amountCents '1234' }` without `securityId` → ok with `security_id null`; `{ type 'dividend' }` without amount → `400 validation`. `date '2026-10-15'` → `400 future_date`. A buy into a checking account → `400 not_investment_account`. Sell of 15 with `lotSelection [{ lotA, '10' }, { lotB, '5' }]` where lotA/lotB are open with remaining 10 and 5 → ok; `[{ lotA, '10' }]` → `400 lot_selection_sum`; `[{ lotA, '11' }, { lotB, '4' }]` → `400 lot_insufficient`; a lot of another security → `400 lot_not_found`. PATCH `type` from `buy` to `sell` on a manual row → re-validated, rebuild runs for the pair. Every create/update/delete writes one `investment_txn` audit row per affected row under the request's batch id.
24. **Balances from positions vs SimpleFIN-fed; snapshot delete.** DB: manual account, manual snapshot 2026-10-10 total 100 000 and csv snapshot 2026-10-13 total 333 775 → `balance_snapshot` rows (100000, manual), (333775, csv); `account.balance_cents 333775n`; delete the 2026-10-13 snapshot → that balance row deleted, `account.balance_cents 100000n, balance_date '2026-10-10'`. SimpleFIN-fed account with `balance_cents 335009n`: the §3.6 file preview shows `knownBalanceCents '335009', differenceCents '-1234', matchesToDollar false`; commit without `setBalance` leaves `balance_snapshot` untouched.
25. **Reprocess job and raw-payload retention.** DB: two stored sync payloads for one connection (2026-10-12 with holdings VTI 12.345; 2026-10-13 with VTI 12.5) imported when the parser was stubbed to return `none` (no snapshots exist). Enqueue `simplefin.reprocess_holdings { connectionId }` and drain → snapshots for both dates exist with the right quantities, a `simplefin.reprocess` import_log row says `Reprocessed holdings from 2 payloads`, each original row's `stats.reprocessedAt` is a number; draining a second enqueue → `updated 0`. A csv snapshot for 2026-10-13 created before the job is kept (`holdingsSnapshotsKept 1`). `enqueueJob(..., { dedupe: true })` twice → `created false` the second time. A payload whose `raw_payload` fails `SimplefinAccountSet.safeParse` is skipped and counted, not fatal.
26. **Off-budget default and plan loaders (cross-area, Deviation 12).** DB: `POST /accounts { type: 'brokerage' }` → `on_budget false`; `{ type: 'checking' }` → `true`; a SimpleFIN account guessed `roth` → `false`. Migration 0002 leaves an existing on-budget brokerage on budget. With a brokerage `on_budget false` holding an uncategorized `−250 000 "BUY VTI"` row: `GET /api/plan` summary `uncategorized.count` and `GET /api/dashboard review.uncategorized` are 0 and the Spending bucket actuals exclude it; flipping the account on budget makes it count; a goal linked to that brokerage still counts its `is_transfer` contribution either way.
27. **Engine seam invariants exercised from this area's data.** After Test 11's commit (buy 10 @ 250 total −250 000 twice, reinvest 0.0523 for 1 234, sell 4 for 99 860): lots for (account, VTI) have ids that survive a second `rebuildLots` call unchanged (same `(opened_by_txn_id, ordinal)` → same `id`); `lot_disposal` for the sell has Σ quantity 4, `proceeds_cents 99860`, `cost_basis_cents 100000` (FIFO from the first lot: 250 000 × 4 / 10); holdings 10 + 10 + 0.0523 − 4 = 16.0523. Move 6 VTI to another account (Test 15 shape) → the receiving lot has `origin_lot_id` set, basis 150 000 (250 000 × 6 / 10), `acquired_date 2026-10-01`, and the out leg's disposal has `kind 'transfer_out'`, `proceeds_cents 0`.

## 8. Deviations from the spec (flagged)

1. **OFX/QFX deferred to Polish** despite the data-sources table saying phase 3 (the build-phase list says Polish). The importers consume `MappedPosition[]` / `MappedTrade[]`, so an OFX adapter is a parser only.
2. **Rounding**: `mulToCents`, `fixed8ToCents` and `impliedPrice` round half away from zero, a stated exception to Phase 2's "bigint division truncates toward zero". Reason: statements round market value to the cent and the gate compares against them.
3. `security.type` gains `other`; the six spec types are kept verbatim. Reason: options, crypto and private holdings need a bucket that is not a lie.
4. `investment_txn` gains the type `interest` and the columns `sequence, fee_cents, split_num, split_den, transfer_direction, counterparty_account_id, transfer_group_id, cost_basis_cents, acquired_date, lot_selection, transaction_id, external_id, source, import_log_id, raw_description, memo, user_edited`. Reason: the Income view separates dividends from interest; the rest are needed for idempotent imports, deterministic order, multi-lot specific-lot sells, corporate actions, own-account transfers and editable imported rows.
5. `lot` is a derived cache with `remaining_quantity, remaining_cost_basis_cents, opened_by_txn_id, ordinal, origin_lot_id, closed_date` and a nullable basis; the spec's four fields are present. Added table `lot_disposal` (realized gains per sale are what full history unlocks and what the Phase 4 tax engine reads per sale). Reason: Decision 3.
6. `holding_snapshot` gains `price, reported_cost_basis_cents, import_log_id` and a **nullable `quantity`** for dollar-only positions some 401(k) feeds report. Cost: every per-share reader carries a null branch (implied price, lot reconciliation, weight); benefit: the account's value is stored instead of rejected. Reason: Decision 9.
7. Added tables `security_alias`, `allocation_target`; added columns `security.price_mode / provider_symbol / archived / needs_review`, `household_setting.benchmark_security_id / dividends_as_income`, `connection.csv_kind`, `price.source`. Reason: dedupe, the Allocation view's targets, the benchmark, the income-bucket toggle, three mapper kinds, price precedence, the prices area's fetch list.
8. Expense ratio stored as integer ppm rather than a ratio. Reason: Decision 11.
9. Implied prices are written for every position lacking a provider/manual price, not only for ticker-less funds. Reason: Decision 12; precedence prevents them from ever overriding a real close.
10. Contributions are recognised by an ingest-time classifier in investment accounts, not only by transfer pairing, and trade-file cash rows become ledger rows for CSV-only accounts. Reason: payroll contributions have no second leg; goals read the ledger.
11. Positions imports write `balance_snapshot` for non-SimpleFIN accounts (and for SimpleFIN-fed ones on request). Reason: the gate ("values match statements") needs a value history for CSV-only accounts; `balance_snapshot.source` already allows `csv` / `manual`.
12. **Investment accounts default off-budget on creation, and Phase 2's `loadActuals`, `loadUncategorized` and `countUncategorized` gain an `account.on_budget = true` filter.** This is the only Phase 2 code this area touches (verified: today those loaders have no account filter, so a SimpleFIN brokerage's buys, sells and dividends surface as uncategorized spending in the plan and on the dashboard). No migration backfill: existing accounts keep their flag and the Accounts page offers a one-click move. `loadGoalNets` is unchanged (linked accounts count regardless of budget status).
13. Imports are not audited row by row (import_log is their record); manual mutations are. Reason: Phase 2 audit rule, noise.
14. SimpleFIN: the parser also reads the Bridge's top-level `account.holdings` array (already allowed by the Phase 1 schema), not only `extra`.

## 9. Seams (what this area assumes from the other three)

**Engine area (lots, cost basis, performance)**
- `rebuildLots(tx: DbOrTx, accountId: string, securityId: string): Promise<{ lots: number; disposals: number; warnings: Array<{ txnId: string; code: 'oversold' | 'lot_selection_stale' | 'unknown_basis'; message: string }> }>` in `packages/db/src/services/lots.ts`, reading `investment_txn` for the pair ordered by `(date, sequence, created_at, id)` and rewriting `lot` and `lot_disposal` in the same transaction; called by `upsertInvestmentTxns`, manual CRUD, `mergeSecurities`. **Lot ids are stable**: upsert by `(opened_by_txn_id, ordinal)` keeping the existing `id`, delete only keys no longer produced. **Never throws** for data inconsistencies (an oversell from a partial history, a stale `lot_selection`): it records a warning, falls back to FIFO for that row, and the pair's `reconciled` flag shows the mismatch.
- Row semantics it must honour: buy/reinvest open a lot with basis `−amount_cents` (which already includes `fee_cents`); sell consumes `quantity` FIFO by `(acquired_date, id)` unless `lot_selection` names lots, proceeds `amount_cents` split by quantity with the cent remainder on the last lot (`lot_disposal.kind = 'sell'`); split scales open lots' `remaining_quantity` by `split_num / split_den` with per-lot truncation to 8 decimals and the residual on the latest lot so Σ is exact (quantity rounding is the engine's rule, stated once there); `transfer out` with a `transfer_group_id` writes `transfer_out` disposals with `proceeds_cents 0` (excluded from realized gains) and the counterparty's lots are reproduced with `origin_lot_id`, the same `acquired_date` and basis share; `transfer out` without a group closes the lots the same way (moved out, not sold); `transfer in` without a group opens one lot with `cost_basis_cents` / `acquired_date` (null basis when unknown); dividend/interest/fee/cash transfers do not touch lots.
- External flows for money-weighted return: ledger `transaction` rows with `is_transfer = true` in the account ∪ `investment_txn` rows `type = 'transfer' AND security_id IS NULL AND transaction_id IS NULL` (Decision 14); reinvested dividends are not external flows; `fee` rows are internal.
- `reconcileHoldings(db, accountId, date)` comparing Σ `lot.remaining_quantity` per security with the latest `holding_snapshot` on/before `date` (dollar-only rows compare by value); its boolean is merged into `AccountInvestmentView.reconciled`.
- `holdingsFromTxns(txns)` (pure) if the UI's lot picker needs it; the lot list endpoint is theirs.

**Prices and valuation area**
- `upsertPrice` and the precedence manual > provider > implied (§3.5) are defined here; their fetch job writes with `source = 'provider'` through it, fetches only securities with `price_mode = 'provider'` (symbol `provider_symbol ?? ticker`) among `listHeldSecurityIds(db)`, and never prices cash.
- Job type `prices.fetch` with payload `{ reason: 'holdings' | 'nightly' | 'manual' }`, deduped by type; this area enqueues it after positions imports, manual snapshots, syncs that created securities and security creation.
- Valuation of an account on a date = latest `holding_snapshot` set on/before the date, revalued with the latest price on/before the date (their rule); dollar-only rows are valued at `value_cents` as stored; `balance_snapshot` remains the account-level value for SimpleFIN-fed accounts.
- They may enrich `name / type / asset_class` from provider metadata only for rows with `needs_review = true`, never overwriting a reviewed row.

**Views / API / web area**
- `allocation_target(asset_class, target_bp)`, `household_setting.benchmark_security_id` and `dividends_as_income` exist as specified; `AllocationTargetsEditor` is reusable.
- `AccountView.investment` block (§4) and `security.needs_review` for the "securities to review" dashboard item.
- Holdings/Income views read `holding_snapshot`, `investment_txn` (`dividend` / `interest`, deduped against the ledger through `transaction_id`; `dividends_as_income` decides whether they feed the income bucket) and the `SecurityView` fields `expenseRatioPpm`, `assetClass`. They must not redefine `SecurityView`.
- The Portfolio value line uses `balance_snapshot` for SimpleFIN-fed accounts and the snapshot totals written by this area for CSV/manual accounts (both land in `balance_snapshot`).
- The gap `account.balance_cents − Σ latest snapshot value` is computed by them for display ("cash & other"); it is not stored. The dashboard review count inherits the `on_budget` filter through `countUncategorized` (Deviation 12).

## 10. Open questions

1. Which brokerages actually populate `extra` (or the top-level `holdings` array) on the owner's Bridge, and in what shape? The parser's synonym table is a starting point; real payloads from the first syncs (kept in `import_log`) decide the next additions, replayed with `simplefin.reprocess_holdings`.
2. Should an `implied` price from a positions import be allowed to overwrite a `provider` close on the same date when the statement is the source of truth for that day? Current rule: no (rank), so the statement value is preserved only in `holding_snapshot.value_cents`.
3. Should trade imports into a SimpleFIN-connected brokerage also create ledger rows for dividends, fees or contributions when the Bridge's feed lacks them (balance reconstruction), or is the Bridge's balance always authoritative? Current design: never; unlinked investment rows still count as external flows and income, and `linkUnlinkedInvestmentTxns` catches late Bridge rows.
4. Should the account-filter value for multi-account exports be persisted on the account (`account.external_id` for CSV-only accounts) so re-imports need no re-selection?
5. Negative quantities (short positions, margin cash) are stored but no view is designed for them; acceptable for this household?
6. Average-cost basis for mutual funds (an IRS-permitted method) is not modelled; if wanted, a `cost_basis_method` column per account belongs to the engine area.
7. Multi-currency securities: `currency` is carried but no FX conversion exists; values are assumed USD for the gate; a non-USD holding in a USD account is a preview warning.
8. Same-day order across two different overlapping trade files can change `sequence` on re-import; acceptable, or should `sequence` be frozen on first import?
9. Should a deleted imported row leave a tombstone so a re-import does not recreate it? Current design: no (the action map's `skip` is the per-institution tool; a single wrong row is edited instead).

## 11. Judging record

Scores (correctness / spec fidelity / codebase fit / testability): judge 1 — A 8 / 8 / 8 / 9, B 7 / 7 / 7 / 8, winner A; judge 2 — A 7.5 / 8 / 8.5 / 9, B 7 / 7.5 / 7.5 / 8, winner A. Both judges re-ran every hand-calculated number and the SHA-256 ids in both designs against a bigint reference script and found them exact; this merge re-ran them again and added its own (Test 10's 123 947, Test 27's basis figures, the new id for the ABC buy).

**Taken from design A (the base):** the Fixed8 representation and the single `roundDiv` rule; snapshot source precedence with `409 snapshot_precedence`; the defensive SimpleFIN parser (key normalization, keyed-object shape, per-element as-of, value-mismatch tolerance, pending/zero skips, `partial` vs `unrecognized`); the `simplefin.reprocess_holdings` replay job; the account filter for multi-account exports; `security_alias` with a cross-security unique index; single-meaning `amount_cents`; dividend + reinvest as two rows; exact split ratios; `linkToLedger`; automatic pairing of in-kind transfers; the `transfer` type with a direction column; separate `positionsMapping` / `tradesMapping` fields on `ConnectionView`; the contracts, services, stats and import_log conventions in the codebase's own idioms; the test list.

**Grafted from design B:** `rowOrder` with sequence assigned after a stable date sort (A's newest-first bug); `actionMap` saved in the profile plus the "Actions found" table and `400 unknown_action`; `fee.columns` summed and `amountIncludesFees` (A's "principal amount" guess silently dropped commissions); `user_edited` as the escape hatch for imported rows; `lot_selection` spanning several lots and `lot_disposal` defined in 0002 now, with stable lot ids pinned on the engine seam; the reconciliation line (`knownBalanceCents`, `differenceCents`, `matchesToDollar`) and the `setBalance` override; cash rows reaching the ledger for CSV-only accounts (resolving A's open question 4 without B's duplicate rows on connected accounts); dollar-only positions accepted; `price_mode`; `dividends_as_income`; `future_date`; per-row `SecurityChoice` with `GET /securities/resolve` and alias learning; `archived`; the Phase 2 off-budget finding; B's open questions 2 and 8 carried into §10.

**Flaws fixed:** every A flaw named by either judge (same-day order, readonly/undeletable imported rows, `lot_id` dangling across rebuilds, Test 19's Zod-vs-service conflict — the sum check moved to the service, Phase 2 uncategorized leakage, the double-counted "DIVIDEND REINVESTED" row — now `reinvestRows` plus the no-quantity rule, dollar-only positions, `UpdateInvestmentTxnBody.type`, cash contributions missing from goals, `writeImpliedPrices`' cash exclusion stated, the unspecified transfer-out disposal, and the left-in drafting in A's §6 and Test 4).

**Judges overruled or reconciled, with reasons:** (1) Judge 2's graft of B's migration backfill of `on_budget` is not adopted; judge 1 asked for the opposite. A migration must not silently change the owner's budget numbers for accounts they may have set on budget deliberately; the default applies to new accounts, existing ones get a one-click prompt, and the loader filter is a flagged two-line change. (2) Judge 2 listed B's nullable `holding_snapshot.quantity` as a flaw while judge 1 grafted dollar-only acceptance; dollar-only positions are accepted (a 401(k) feed's value must not be rejected) with the null-branch cost stated in Deviation 6. (3) B's "reinvest defaults to buy" and B's directed `transfer_in` / `transfer_out` types are not adopted (both judges preferred A's two-row reinvest and A's single `transfer` type). (4) Judge 1's wish that imported rows be deletable is adopted, but without a tombstone (open question 9). (5) B's single-transaction claim for ledger rows is made true by widening `ingestTransactions` to `DbOrTx` (nested calls are savepoints in drizzle) rather than by giving up atomicity.
