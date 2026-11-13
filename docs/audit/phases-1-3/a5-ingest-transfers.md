# Audit record: Ingest, pending replacement, transfers and duplicates (a5-ingest-transfers)

Scope: how bank rows enter the ledger from the feed and from bank CSV files, how pending rows are replaced or removed, transfer pairing and its corrections, and duplicates across sources, reconnections and re-keyed feeds (Phases 1 to 3).

Decisions taken here are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 42 to 54; the plan's pipeline, transfer pairing, CSV import, data model and test matrix sections were edited to match, and the README's "Bank sync" section gained the household-facing part. Migration `0007_ingest_dedupe` adds `transaction_alias` and `transfer_dismissal`. Unless a section says otherwise, the test files are `packages/db/src/services/ingestDedupe.test.ts` (db dedupe), `packages/db/src/services/transferCorrections.test.ts` (db corrections), `packages/shared/src/pending.test.ts` (shared pending), `packages/shared/src/transfers.test.ts` (shared transfers), `apps/api/src/ledgerCorrections.test.ts` (api), `apps/worker/src/jobs/reprocessTransactions.test.ts` (worker) and `apps/web/src/lib/ledgerCorrections.test.ts` (web). Every new test except the web wording helpers (a new module) was run against the code before the fix and failed; the outputs are kept in the lane's scratch directory (`red-shared.txt`, `red-db.txt`, `red-api.txt`, `red-worker.txt`). The web changes were checked in the built app in headless Chromium (`ui-check.cjs`, result in `ui-check-result.txt`, screenshots `ui-1` to `ui-6`).

## a5-ingest-transfers-01 (high): a bank CSV over days the sync covers duplicates every overlapping row, and the preview flags none

Status: fixed.

What was wrong: duplicates were matched only on the external id, and a CSV row's id (`csv:` + hash, or `csvid:`) never equals a SimpleFIN id, so a bank export over synced days inserted every overlapping row again and the preview said none was a duplicate. CSV ingest also replaced any pending feed row of the account in place (it had no window) and took its id, so the next sync inserted the posted item as a new row: six rows for three purchases.

What changed: `findSameTransactions` (`packages/db/src/services/ingest.ts`) finds the rows of the account that are the same purchase from another source: equal amount, dates at most 5 days apart, descriptions that share something, best similarity then closest date, each row once (decision 42). A CSV row that matches a feed row (pending or posted) or a manual one is not inserted; its id goes to `transaction_alias`, pointing at that row. A posted feed item that matches a CSV or manual row takes the row over (id, source, bank-owned fields; the household's edits stay) and the old CSV id is kept; a pending feed item that matches a posted CSV row points at it. CSV ingest no longer replaces pending rows. The preview uses the same rules (`csvDuplicateIds`), and the commit reports `duplicates`. The trades importer's cash rows follow: one the account already had is linked to that row and marked a transfer (`investmentTxns.ts`).

Tests: db dedupe "a5-ingest-transfers-01: a bank CSV over days the sync covers is flagged in the preview and adds only the rows the feed lacks; sync, CSV, sync again" (the gate case: sync, CSV over the same days, sync again; the ledger sums to the hand-calculated −$133.31 for four purchases (45.32 + 12.50 + 15.49 + 60.00)), "a5-ingest-transfers-01: rows imported from a CSV first are taken over by the feed's items, not doubled, and a re-import stays idempotent", "keeps two purchases of one amount at one merchant on one day apart (no false merge)". api "a5-ingest-transfers-01: the CSV preview marks the rows the sync already brought, and the commit adds only the rest". `packages/db/src/services/investmentTxns.test.ts` "Audit a5-ingest-transfers-01: a cash row whose deposit the account has by hand five days off …" (inside the trades import case).

## a5-ingest-transfers-02 (high): reconnecting a bank creates a second set of accounts and duplicates every transaction and balance

Status: fixed.

What was wrong: accounts were found only by (connection, external id), so after the household removed a connection and added it again (the recovery decision 37 prescribes) every account, balance and transaction was created a second time. A feed that re-keyed transaction ids doubled rows in place, and nothing let the household attach a feed account to an account it already had.

What changed: `upsertSimplefinAccount` attaches an account without a connection that carries the feed's id to the new connection (`accountsReattached`, counted as new for the high-water mark). A re-keyed account (none of its posted feed rows in the window listed by id while the feed sends posted items, and no problem reported for it) offers those rows to the same-purchase match, so the new ids take them over. `linkFeedAccount` (`POST /api/accounts/:id/link-feed`, "same as a feed account…" on the Accounts page) makes an account without a connection the one a feed account fills and folds that feed account in without doubling, for a Bridge that re-issued an account under a new id and for CSV history imported before the bank was connected (decision 43).

Tests: db dedupe "a5-ingest-transfers-02: removing a connection and adding it again re-attaches its accounts, so nothing is doubled" (two accounts, balances 1,000.00 and −200.00 counted once: 800.00), "a5-ingest-transfers-02: a feed that re-keys the transaction ids of an account keeps one row per purchase", "a5-ingest-transfers-02: an account the Bridge re-issued under a new id, or one with CSV history, can be linked to the feed account without doubling" (the card payment stays one transfer). api "a5-ingest-transfers-02: POST /api/accounts/:id/link-feed folds a feed account into an account without a connection" (409 for an account with a connection). Browser check: the Accounts page link (`ui-4-accounts-link.png`).

## a5-ingest-transfers-03 (high): pending rows dated more than about 14 days before the sync are never matched or removed

Status: fixed.

What was wrong: local pending rows were looked at only from `windowStart − 7 days`, so a hold pending for two to four weeks was never replaced when it posted (both rows counted) and a dropped authorization stayed for good, also in the cash flow's opening balance.

What changed: every pending row of the account is a candidate for replacement, and one the feed no longer returns is removed whatever its date; an account with a reported problem still keeps its pending rows (decision 44, with the flagged assumption that the feed's pending list is not bounded by the start date).

Tests: db dedupe "a5-ingest-transfers-03: a hold pending for weeks is replaced when it posts, and one that dropped is removed" (a −412.00 rental hold from 10-01 and a −300.00 hotel authorization from 10-02, through syncs on 10-02, 10-09, 10-16, 10-19; on 10-20 one row, the posted −412.00).

## a5-ingest-transfers-04 (high): "transfer · undo" does not stick

Status: fixed.

What was wrong: undo only cleared the pair, nothing recorded the refusal, and `pairTransfersInDb` took every unpaired row (category-locked ones included), so the next sync or CSV commit paired the rows again over the categories the owner had given them.

What changed: undo records the two rows in `transfer_dismissal` and the pairing pass never pairs them with each other again (`pairTransfers` takes an `isDismissed` test). A row the household categorized by hand is not a candidate unless it is marked as a transfer (decision 48).

Tests: shared transfers "a5-ingest-transfers-04: never pairs two legs the household said are not a transfer". db corrections "a5-ingest-transfers-04: 'transfer · undo' lasts through the next sync and the next CSV import, with the categories the owner gave", "a5-ingest-transfers-04: a row the owner categorized by hand is not paired by automation". api "a5-ingest-transfers-12: a row is paired by hand … and undo lasts".

## a5-ingest-transfers-05 (medium): deleting a paired pending leg leaves its partner with a dangling pair id

Status: fixed.

What was wrong: a pending leg removed as stale left its partner with `is_transfer` and the old pair id, so the posted payment could never pair and counted as spending.

What changed: `releaseTransferPartners` clears the partner's pair and `is_transfer` and runs the rules on it again before any paired row is removed (stale pending, delete, undo of an import, a folded feed account, and a replaced row whose amount changed). The sync's pairing pass runs whenever a partner was released and covers its date (decision 49).

Tests: db corrections "a5-ingest-transfers-05: removing a paired pending leg releases its partner, which pairs with the posted payment" (drop in sync 2, `releasedTransfers: 1`; the posted −500.00 pairs in sync 3). db corrections and api 09 cases check the partner of a deleted row.

## a5-ingest-transfers-06 (medium): a pending charge that posts with a changed amount loses the owner's edits

Status: fixed.

What was wrong: matching required an equal amount, so a posted item with a tip or a settled hold was inserted as new and the pending row, with the owner's category, notes and tags, was deleted; under an account problem both rows stayed.

What changed: after the equal amounts, a posted item may take a pending row of the same merchant (similarity at least 0.5) whose amount is in the same direction and within half of it either way; the closest amount wins. The row keeps its id and edits; a split is dropped and a pair released as for any amount change (decision 45).

Tests: shared pending "a5-ingest-transfers-06: a tip or a settled hold posts with another amount and still replaces its pending row" (−50.00 → −60.00, −120.00 → −135.40, a fuel hold −75.00 → −43.10), "a5-ingest-transfers-06: a changed amount needs the same merchant, the same direction and at most half again", "a5-ingest-transfers-06: an equal amount is matched before a changed one". db dedupe "a5-ingest-transfers-06: a pending charge that posts with a tip, or a hold that settles higher under an account problem, keeps its row and the owner's edits".

## a5-ingest-transfers-07 (medium): a posted charge from a different merchant replaces an unrelated pending row

Status: fixed.

What was wrong: a description similarity of 0 was enough when the amount and the window matched, so a posted Costco charge took over a pending Shell row with its locked payee, category and notes.

What changed: an equal-amount match needs descriptions that share something (similarity above 0); otherwise the posted item is new and the pending row goes as any vanished one (decision 46).

Tests: shared pending "a5-ingest-transfers-07: never replaces a pending row whose description shares nothing with the posted item". db dedupe "a5-ingest-transfers-07: a posted charge from another merchant never takes over a pending row's payee, category or notes".

## a5-ingest-transfers-08 (medium): at import, rules see the raw normalized name, not the merged payee

Status: fixed.

What was wrong: a new row's rules were evaluated against the normalized name before it was resolved through payee aliases, so a rule on a merged payee missed its variants at import while the on-demand run caught them.

What changed: the name is looked up through aliases first (`PayeeCache.find`, which creates nothing) and the rules see that payee's name (decision 54).

Tests: db dedupe "a5-ingest-transfers-08: rules at import see the merged payee, so a rule on it applies to every merged variant" (no payee is created for the alias).

## a5-ingest-transfers-09 (medium): no way to delete a transaction or undo an import

Status: fixed.

What was wrong: no route removed a ledger row or undid a CSV commit, so duplicates, rows imported with the wrong sign or account, and manual typos were permanent.

What changed: `DELETE /api/transactions/:id` (`deleteTransaction`; the register's "more" → delete) removes a manual, CSV or feed row, releases its partner, unlinks a recurring item and is audited; a feed or CSV row's ids stay as removed in `transaction_alias`, so the next sync or a re-import does not bring it back; investment rows are refused. `POST /api/import/csv/:id/undo` (`undoCsvImport`; "Undo this import" on the Import page's result line, the commit now returns `importLogId`) removes the rows the import created, forgets the ids it recorded and marks the log `undoneAt` (decision 50).

Tests: db corrections "a5-ingest-transfers-09: a row can be deleted; its partner is released, a feed row and a CSV row do not come back, an import can be undone". api "a5-ingest-transfers-09: DELETE /api/transactions/:id removes a row, audits it and releases its transfer partner" and the undo steps of the api 01 case. web "a5-ingest-transfers-09: says where a deleted row came from and that it will not come back". Browser check: delete in the register, undo on the Import page (`ui-2`, `ui-3`).

## a5-ingest-transfers-10 (low): greedy pairing leaves one hop of a same-day checking → savings → brokerage move unpaired

Status: fixed.

What was wrong: each outflow took the first closest inflow by id, so with unlucky ids the checking outflow took the brokerage inflow and both savings legs stayed unpaired (244 of 1,000 random runs).

What changed: `pairTransfers` still gives each outflow its closest free inflow, and when none is free it moves an earlier outflow to another inflow it can reach (an augmenting path), so it finds as many pairs as the legs allow (decision 51).

Tests: shared transfers "a5-ingest-transfers-10: pairs both hops of a same-day checking -> savings -> brokerage move, whatever the ids" (all 24 id orders), "a5-ingest-transfers-10: a later outflow gets a leg when the earlier one can take another within the window". The existing tie and closest-date cases still pass.

## a5-ingest-transfers-11 (low): a pending item listed next to its posted form is stored twice

Status: fixed.

What was wrong: pending rows whose ids were in the payload were never replacement candidates, so a posted item listed next to its pending copy was inserted beside it, and when the pending copy dropped its edits were lost.

What changed: after the rows the feed no longer lists, a posted item may replace a pending row the feed still lists (equal amount, strong description match); the pending id goes to `transaction_alias` and is ignored while it is listed (decision 47). Two new items of one response are both kept until the pending one drops (stated in the decision).

Tests: db dedupe "a5-ingest-transfers-11: a pending item listed next to its posted form is one row, with the owner's edits, while both are listed and after".

## a5-ingest-transfers-12 (low): the register can undo a pair but cannot mark a row as a transfer or pair two rows by hand

Status: fixed.

What was wrong: the register offered only "transfer · undo"; the API's `isTransfer: true` kept an automatic category and created no pair, so a missed card payment could be fixed only with a rule.

What changed: "more" on a register row lists the equal and opposite rows in other accounts within 14 days (`GET /api/transactions/:id/transfer-candidates`) and pairs with one (`POST /api/transactions/:id/pair`, `pairTransactionsByHand`: one pair id, `is_transfer`, an automatic category cleared, a dismissal removed, audited); "mark as a transfer without its other leg" now also clears an automatic category (decision 52).

Tests: db corrections "a5-ingest-transfers-12: two rows can be paired by hand and a row marked as a transfer loses an automatic category". api "a5-ingest-transfers-12: a row is paired by hand with a candidate the API offers, and undo lasts". web "a5-ingest-transfers-12 and -02: candidates and feed accounts". Browser check: pairing in the register (`ui-1-pair-candidates.png`).

## a5-ingest-transfers-13 (low): stored SimpleFIN payloads cannot be re-processed for transactions

Status: fixed.

What was wrong: only holdings could be replayed from `import_log.raw_payload`; transactions older than the 93-day window could never be read again after a reader or ingest fix, and replaying through `applyAccountSet` would have re-inserted old pending items.

What changed: `simplefin.reprocess_transactions` (`apps/worker/src/jobs/reprocessTransactions.ts`, `POST /api/connections/:id/reprocess-transactions`, "Re-read transactions" on the Connections page) replays every stored sync payload, oldest first, through `replayAccountSetTransactions`: replay mode inserts only posted items the ledger lacks, leaves known rows (and their splits) alone, never inserts a pending item or removes a pending row, and does not touch accounts, balances or holdings (decision 53).

Tests: worker "inserts the posted items the ledger lacks, never a pending one, and a second run changes nothing" (a deleted row is not brought back; a split on a row whose older payload carried another amount stays), "a missing connection is a no-op". api "a5-ingest-transfers-13: POST /api/connections/:id/reprocess-transactions queues the replay". Browser check: the Connections page button queues the job (`ui-5-connections.png`).
