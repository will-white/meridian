# Audit record: Phase 1 conformance (a10-conformance-ledger)

Scope: the Phase 1 ledger checked against the spec and the Phase 1 plan: concurrent ingest, CSV ids and amounts, rules and transfer pairing, stored responses, pending dates, manual entry, and the spec's optional passkeys.

Decisions taken here are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 104 to 112; decisions 33, 42, 43 and 93, the data model, sync pipeline, rules, transfer pairing, CSV import and auth sections and the test matrix were edited to match, and the README's "Accounts and sign-in", "Locked out" and "Bank sync" sections gained the household-facing part. Migration `0009_ledger_conformance` adds `transaction.not_transfer`, makes `import_log.connection_id` `ON DELETE SET NULL` and repairs broken pairs; migration `0010_passkeys` adds `passkey` and `webauthn_challenge`. New dependencies: `@simplewebauthn/server` 13.3.3 (apps/api) and `@simplewebauthn/browser` 13.3.0 (apps/web), both pinned.

Unless a section says otherwise, the test files are `packages/db/src/services/conformanceLedger.audit.test.ts` (db), `packages/db/src/test/ledgerConformanceMigration.test.ts` (db migration), `packages/shared/src/csvConformance.audit.test.ts` (shared), `apps/api/src/conformanceLedger.audit.test.ts` (api), `apps/api/src/passkeys.audit.test.ts` (api passkeys, with the software authenticator in `apps/api/src/test/passkey.ts`), `apps/worker/src/jobs/conformanceLedger.audit.test.ts` (worker), `apps/web/src/lib/connectionsPrompts.test.ts` and `apps/web/src/lib/passkeys.test.ts` (web). Every new test was run against the code before the fix and failed; the outputs are in the lane's scratch directory under `a10/` (`red-db.txt`: 14 of 15 failed, the one that passed is the dated-pending control case; `red-shared.txt`: 5 of 6, the one that passed checks thousands separators that already worked; `red-api.txt`: 4 of 4; `red-api-passkeys.txt`: 5 of 5; `red-worker.txt`: 1 of 1; `red-web.txt`: 3 failed, the wording tests of new helpers). The web changes were checked in the built app in headless Chromium with a virtual authenticator on port 3481 (`a10/ui-check.cjs`, result in `a10/ui-check-result.txt`, screenshots `ui-1` to `ui-5`).

## a10-conformance-ledger-01 (medium): a CSV commit that runs during a sync of the same account doubles every overlapping purchase

Status: fixed.

What was wrong: nothing ordered ingests. The CSV commit runs in the API and the sync in the worker, and each read the other's rows before they were committed, so both inserted every purchase (60 rows for 30 purchases in every round of the auditor's probe, reproduced). Two pairing passes could likewise read the same free legs and pair one leg twice, leaving a pair id on one row.

What changed: one transaction-scoped Postgres advisory lock for the ledger (`lockLedger`, `packages/db/src/services/ledgerLock.ts`), taken first by `ingestTransactions` (feed, bank CSV, trades cash rows, replay), `pairTransfersInDb`, `pairTransactionsByHand`, a rule run's batches, `updateTransaction` when it marks or undoes a transfer or picks a category, `deleteTransaction`, `undoCsvImport` and `linkFeedAccount` (decision 104). One lock rather than one per account, because pairing and partner releases cross accounts; it is re-entrant inside a transaction, so nested calls cannot wait on themselves.

Tests: db "a CSV commit and a feed ingest of the same 30 purchases at the same time leave 30 rows, every round" (five rounds, both orders), "two pairing passes at the same time never leave a pair id on one row" (eight rounds: one outflow within 3 days of two inflows, two passes that each see one of them). Pairs a concurrent pass left broken before the fix are released by migration 0009 (see -03).

## a10-conformance-ledger-02 (medium): two CSV imports of the same rows are never matched: the row id changes with the id-column mapping and with the payee normalizer's version

Status: fixed.

What was wrong: a row without a bank id was keyed `csv:` + SHA-256 of date, cents and `normalizePayee(description)`, so commit 2f7f675 (a6-12) changed the id of rows already imported and the next import of the same file added them again; and the same file read with its id column (`csvid:`) and then without it was never matched, because CSV rows were only compared with feed and manual rows. The preview marked none of them.

What changed (decision 105): content ids are now `csv2:` + SHA-256 of date, cents and the raw cell in NFC with white space collapsed and in lower case (`csvIdText`, `csvExternalId`; `mapCsvRows` hashes the cell as the file has it, so neither the payee heuristics nor the sanitizer can move it). `csvIdScheme` names the scheme of an id (`csvid`, `csv2`, and `csv` for ids made before). Within one scheme the ids decide; across schemes `findSameTransactions` matches by content: first a CSV row of another scheme with the same date, amount and description (similarity at least 0.5), then a feed or manual row no CSV id names, then one only ids of another scheme name, each row once. The preview (`csvDuplicateIds`) and undo follow. The old `csv:` ids are not re-keyed: an id kept for a feed row cannot be recomputed (the row's text is the feed's), and the content match recognizes them as they are, so no migration is needed. One existing test (`packages/shared/src/csv.test.ts`, "gives identical rows in one file distinct, stable ids and the same ids on re-import") now expects the `csv2:` prefix.

Tests: db "the same file committed with its id column, then without it, is one set of rows (and the reverse)", "rows stored under the earlier csv: ids (before the payee normalizer changed) are recognized, as rows and as ids kept for feed rows", "two equal purchases on one day stay two rows across id schemes, and a third one is added", "undoing an import that recognized rows of another id scheme forgets those ids and removes nothing else". shared "is csv2: + sha256(date|cents|text in lower case with white space collapsed), with no payee heuristics in it" (hand-computed hashes; "SHELL OIL 57444 FORT COLLINS CO" and "SHELL OIL 57444" are two contents), "maps rows to ids from the raw cell, so the sanitizer's rules do not move them, and numbers equal rows in file order", "names the id schemes". api "a10-conformance-ledger-02: the same file committed with its id column and then without it is marked as duplicates and adds nothing" (preview 2 of 2 duplicates, commit 0 created).

## a10-conformance-ledger-03 (medium): a "not a transfer" rule does not keep a row out of pairing, and run on demand it leaves a pair id on a row that is no longer a transfer

Status: fixed.

What was wrong: a rule's `markTransfer: false` set `is_transfer = false` at import and the next pairing pass paired the row anyway; run on demand on a paired row (`runRules`), it cleared `is_transfer` and left the pair id on both legs, so the $40 coffee stayed out of spending while the Venmo cash-out counted as income, and neither could pair again.

What changed (decision 106): the rule's choice is kept with the row (`transaction.not_transfer`, migration 0009), set by "not a transfer" and cleared by "transfer" at import and on demand (`applyRulesToRow`); `pairTransfersInDb` skips such rows, as it skips hand-categorized ones. On a paired row the rule undoes the pair: the row's pair id goes and its partner is released through `releaseTransferPartners` (pair id and `is_transfer` cleared, rules run again); a rule run that released a partner ends with a pairing pass over its dates. Marking or pairing the row by hand clears `not_transfer`. Migration 0009 marks rows left as the old code left them (`is_transfer` false with a pair id) as ruled out, releases every pair that is not two equal and opposite transfers, and gives a released leg the household did not categorize its payee's default category back.

Tests: db "a row a rule marks as not a transfer is not paired at import, and its would-be partner stays spending" (+40.00 "VENMO CASHOUT" and −40.00 "BLUE BOTTLE COFFEE" a day apart: 0 pairs), "run on demand, the rule unpairs a pair it rules out: both legs lose the pair id and the partner is free to pair again" (the coffee gets its payee's category back and later pairs with a real +41.00 transfer; marking the Venmo row a transfer by hand clears the flag). db migration "releases the pairs that are not two equal and opposite transfers, and keeps the rule's choice on the ruled-out leg" (the auditor's broken pair, a pair id on one row, a −450.00/+500.00 pair, a healthy pair untouched, a locked category kept). `packages/db/src/test/linkedTransfersMigration.test.ts` now writes its pre-migration rows with SQL, because the schema object has a column the old database lacks.

## a10-conformance-ledger-04 (medium): removing a connection or a CSV mapping profile deletes its stored raw responses and import logs

Status: fixed.

What was wrong: `import_log.connection_id` was `ON DELETE CASCADE`, so removing a SimpleFIN connection (the recovery decision 37 prescribes for a spent token) deleted every stored response that Re-read transactions and reopening a closed account replay (decisions 53 and 91), and deleting a CSV profile deleted its imports' logs, after which **Undo this import** answered 404. The profile's Delete did not ask first, and the Remove prompt did not say what was kept.

What changed (decision 107): the key is `ON DELETE SET NULL` (migration 0009). When a removed connection's accounts come back on a new connection, `upsertSimplefinAccount` gives the new connection the stored SimpleFIN responses that list the re-attached account, so a replay on the new connection reads them. The Connections page asks before a profile's Delete, and both prompts say what stays (`removeConnectionPrompt`, `deleteProfilePrompt` in `apps/web/src/lib/connections.ts`). The claim's import log never held the access URL.

Tests: db "the import logs stay when the connection goes, and the connection added again takes over the responses of its accounts" (a response listing another account stays without a connection), "a CSV mapping profile that is deleted leaves its imports, and they can still be undone"; db migration "keeps a connection's import logs when the connection is removed". worker "re-reads, on the new connection, a payment that only a response stored under the removed one holds" (July's rent, older than the new connection's 93 days, inserted by `simplefin.reprocess_transactions`). api "a10-conformance-ledger-04: removing a connection keeps its stored responses; deleting a CSV profile keeps its imports, and they can be undone" (undo answers 200, removed 2). web "removing a connection keeps its accounts, transactions and stored responses", "deleting a mapping profile keeps its imports, which can still be undone"; `apps/web/src/components/ledgerAudit.test.tsx` (a8-07) follows the buttons through the new prompts. Browser check: both prompts shown on the Connections page and dismissing them removes nothing (`ui-5-connections.png`).

## a10-conformance-ledger-05 (medium): an undated pending item takes each sync's day as its date, so a long hold is not replaced in place when it posts and the household's edits are lost

Status: fixed.

What was wrong: a pending item with neither `transacted_at` nor `posted` is dated by the household's day (decision 33), and the known-row path wrote that day back on every sync, so the hold moved 10-24 → 10-28 → 11-01; when it posted on 11-02 with `transacted_at` 10-24 it was 8 days from the row, outside the 5-day window, and the row with the household's note was deleted as vanished.

What changed (decision 108): `toIncomingTransaction` marks such an item `undated`, and the known-row path keeps a stored row's date while the item carries none; an item that gains a date takes it. The window is not widened.

Tests: db "a hold pending for a week keeps its date and is replaced in place, with the household's note, when it posts" (syncs on 10-24, 10-28, 11-01, posting on 11-02: one row, the same id, dated 10-24, `notes = "work trip"`), "a pending item that gains a date takes it" (control).

## a10-conformance-ledger-06 (low): a paired feed row whose amount changes under the same id keeps its transfer pair

Status: fixed.

What was wrong: the known-row path updated the amount and dropped a split, but left the pair: checking −450.00 and savings +500.00 shared one pair id, $50 unaccounted for. The new-id replacement path already released such a pair (decision 45).

What changed (decision 109): a changed amount on a paired row releases the whole pair (`releaseTransferPairs`, `packages/db/src/services/transfers.ts`): both legs lose the pair id and `is_transfer`, the rules run on both, and `releasedTransfers` / `earliestReleased` make the sync's (and now also a CSV import's) pairing pass run over their dates. Pairs broken this way before are released by migration 0009.

Tests: db "checking -500.00 pending and savings +500.00 are paired; the checking row posts at -450.00: no pair is left, and each leg may pair again" (`updated 1, releasedTransfers 1, earliestReleased 2026-10-10`; the next pass pairs nothing); db migration case `outA`/`inB`.

## a10-conformance-ledger-07 (low): POST /api/transactions takes a zero amount and a future date; unknown references answer 500

Status: fixed.

What was wrong: only the web form checked the date and the zero; the API wrote a $0.00 row and a row dated 2027-06-01, and an unknown account, an unknown category on a transaction and an unknown default category on a payee reached the foreign key and answered 500 (test matrix: "400, never 500").

What changed (decision 110): `createManualTransaction` refuses a zero amount (400 `zero_amount`), a date after the household's today (400 `future_date`; the route passes the API clock's day), an unknown account (404) and an unknown category (400 `unknown_category`) before writing; `updateTransaction` and `PATCH /api/payees/:id` check the category (400 `unknown_category`). Under them the error handler answers a foreign-key violation on an insert or update (SQLSTATE 23503) with 400 `unknown_reference`.

Tests: db "refuses a zero amount, a date after today, an unknown account and an unknown category", "an edit to an unknown category is refused, not a database error". api "a10-conformance-ledger-07: POST /api/transactions refuses a zero amount, a date after today and an unknown account or category with 400/404, never 500" (the API clock at 2026-11-14: 2027-06-01 refused, 2026-11-14 accepted), "a10-conformance-ledger-07: PATCH /api/transactions/:id and PATCH /api/payees/:id answer 400 unknown_category for a category that does not exist".

## a10-conformance-ledger-08 (low): bank CSV amounts with a decimal comma are read 100 times too large without a warning

Status: fixed.

What was wrong: `parseLooseMoney` removed every comma as a thousands separator, so "12,50" was 1,250.00, "€12,50" the same and "1 234,56" 123,456.00, with nothing said.

What changed (decision 111): a comma is read only in groups of three digits before the decimal point; any other comma makes the amount unreadable. `mapCsvRows` says why when a cell looks like a decimal comma (`looksLikeDecimalComma`): `Unreadable amount "12,50": a comma before the cents is not read; export the file with a decimal point`. The trades importer uses the same parser. A decimal-separator option was not added: the household's banks are US banks, and a refusal cannot put a wrong amount in the ledger.

Tests: shared "refuses a comma before the cents and comma groups that are not thousands" ("12,50", "€12,50", "-12,50", "1 234,56", "1.234,56", "12,5", ",50", "1,23,456.00", "(12,50)", "12,50 DR", "1,2345.00"), "still reads thousands separators, signs and currency signs" ("1,234.56" = 123456, "$1,234,567.89", "1,234" = 123400, "-1,000", "1 234.56", "€12.50", "(1,234.50)"), "says why such an amount was not read". The existing `packages/shared/src/csv.test.ts` and `wire.test.ts` amount cases pass unchanged.

## a10-conformance-ledger-09 (low): optional passkeys are neither built nor deferred

Status: fixed.

What was wrong: the spec's Security section names "optional passkeys" beside password and TOTP, Phase 1 builds "auth", and no later phase lists passkeys; nothing was built and nothing recorded a deferral.

What changed (decision 112): passkeys are an optional way to sign in. Settings > Sign-in and security has a Passkeys card: a member re-enters the password (`POST /api/auth/passkeys/options`, counted like the other password re-entries), the browser creates a discoverable credential with user verification, and `POST /api/auth/passkeys` verifies it with `@simplewebauthn/server` (attestation "none", this host's origin and RP id, the one-use five-minute challenge issued to that session) and stores it (`passkey`; `GET` lists and `DELETE /api/auth/passkeys/:id` removes one's own). The sign-in screen has **Sign in with a passkey** (`POST /api/auth/passkey/options` and `/verify`, public, 20 a minute per address): a verified answer (signature, counter moving forward, user verification, origin, the user handle of the passkey's member) creates a signed-in session as after the code and is recorded as `passkey_signed_in`; an answer from a member's passkey that does not verify is a failed attempt (`passkey_failed`, counted in the 7-day warning). The relying party is the browser's address (the request's `Origin`, which must name the request's host). Clearing a member's second factor (owner's clear, `admin.js reset-totp`) also removes their passkeys; removing a member removes theirs. Password and authenticator stay, so a passkey is never the only way in. Audited as `user`, by name only.

Tests: api passkeys "adds a passkey only with the password, verified against this host and its challenge" (403 `wrong_password`; an answer made on another site refused and its challenge spent; an authenticator without user verification refused; 409 for the same authenticator twice; `origin_required` and `cross_site_request`; the audit holds the name and never the credential), "signs in with the passkey alone: a signed-in session, recorded as such", "refuses a replayed answer, a forged signature, a counter that goes back, no user verification, another site and an unknown passkey" (five `passkey_failed` events, no prompt left stored), "a removed passkey no longer signs in; clearing a member's second factor removes their passkeys" (a viewer adds their own; the owner's clear removes it), "a passkey sign-in before the owner exists is refused, like every sign-in". `apps/api/src/admin.test.ts` expects the new `reset-totp` line. web "asks for a name of 1 to 60 characters", "says what a failed prompt means, and keeps the API's own message", "names passkey sign-ins in the sign-in activity, and counts a refused answer as a failed attempt". Browser check with Chromium's virtual authenticator (`ui-check.cjs`): a passkey added under Settings (one discoverable credential for RP id `localhost`, `ui-1-passkey-added.png`), signed out, signed in with the passkey alone (`ui-2-sign-in.png`, `ui-3-signed-in-with-passkey.png`, activity "Signed in with a passkey", last used shown), the passkey removed and refused with the explanation (`ui-4-unknown-passkey.png`; that 401 is the only refused request and the only console line).

## Checks

`pnpm typecheck`, `pnpm lint` and `pnpm build` pass. Suites (with `TEST_DATABASE_URL`, prefix `meridian_fix_a_`): shared, db, api, worker and web all pass; the counts after the final merge are in the commit's check list (`a10/` holds the logs).
