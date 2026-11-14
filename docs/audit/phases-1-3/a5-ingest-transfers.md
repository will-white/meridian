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

## Second round

An independent reviewer confirmed the first round's reported cases (the batch's tests fail before d41b7ac and pass after it) and left three items open: 01 and 02 incomplete, 11 a regression. It raised two new issues, both low. Each was reproduced at HEAD with the reviewer's probes (`check-a5-ingest-transfers/probes/c1.mts` to `c4.mts`, copied to the lane's `laneA/r2probes/` with this lane's database prefix; output `laneA/a5r2-head-probes.txt`) and is real; all five are fixed. Decisions: `docs/phase-1-plan.md` decisions 42, 43, 47, 50 and 53, each with a paragraph marked "Second round of the audit", plus pipeline step 5, the CSV import section and the test matrix's two a5 rows; the README's "Bank sync" section was edited to match.

Every new test was run against the code before the fix and failed; the outputs are in the lane's scratch directory (`laneA/`): `a5r2-red-shared.txt` (1 of 13), `a5r2-red-db.txt` (6 of 17, `ingestDedupe.test.ts`), `a5r2-red-api.txt` (2 of 7, `ledgerCorrections.test.ts`), `a5r2-red-worker.txt` (1 of 3), `a5r2-red-web.txt` (2 of 4, `src/lib/ledgerCorrections.test.ts`). The suites after the fix are `a5r2-green-*.txt`, the reviewer's probes after the fix `a5r2-fix-probes.txt`, and the browser check `a5r2-ui.txt` with screenshots `a5r2-ui-*.png`.

### Second round, a5-ingest-transfers-01 (incomplete): a hold dated by posting in the bank's file, and a tip settled in the file before the feed posts it, still doubled a purchase

Status: fixed.

What was wrong:

- (A) `findSameTransactions` compared a CSV row's date only with a feed row's `date`, the day of the purchase. A car rental made on 10-01 and posted on 10-20 is dated 10-01 by the feed and 10-20 by the bank's file, 19 days apart, so the preview flagged 0 of 1 and the commit added it: −412.00 twice. The feed row's stored `posted_at` was never used, although decision 42 says a bank's export dates by posting.
- (B) The CSV check took only equal amounts. A taphouse charge pending at −50.00 that the bank's file already showed posted at −60.00 was added as a new row; the next sync posted it at −60.00, which replaced the pending row through decision 45's changed-amount pass, and the CSV row stayed: two −60.00 rows. Nothing on the replacement path looked for a CSV or manual row of the posted amount.

What changed (`packages/db/src/services/ingest.ts`, decision 42's second-round paragraph):

- **Posting days.** Rows and items carry the day they posted (`posted_at` as a UTC day, as the Bridge dates). Two rows of one purchase from two sources are within `DUPLICATE_MAX_DAYS` when their dates are, or when the posting day of one is within it of the other's date (`purchaseDays`). The query also fetches rows whose posting day falls in the range. This works both ways round: the file's 10-20 row is the feed's T-CAR, and a feed item made 10-03 and posted 10-20 takes over a file's 10-20 row.
- **A purchase pending in one source and posted in the other.** Decision 45's rule now holds across sources: the same merchant (similarity at least `STRONG_SIMILARITY`), an amount in the same direction within half of it (`isChangedAmountMatch`), and a posted date from 5 days before the pending date to `PENDING_POSTS_WITHIN_DAYS` (31) after it (`postingDays`; decision 44's holds of two to four weeks). A file's posted row is then the later form of the feed's pending row: its id points at that row, the preview marks it, and the feed's posted item replaces the pending row as before. A pending feed item is the earlier form of a posted CSV or manual row in the same way. The 31 days reach only holds in practice: a row is still pending a week after its date only when it is one.
- **A fold when the posted item lands.** A CSV or manual row that is the same purchase as a posted item replacing its pending row is folded into that row (`foldInto`). Examples are a row the household entered by hand with the tip, or one imported before this rule.
  - The pending row keeps its id and its edits.
  - What the household did on the other row counts where the pending row has nothing of its own: a category set by hand wins over an automatic one, then notes, a payee picked by hand, tags, a recurring link, a bucket, a split of the posted amount, and a transfer mark without a pair.
  - The ids that pointed at the other row, and its own, now point at the kept row, so the file's next import knows it. An investment row linked to it follows.
  - Its transfer partner is released, and the pairing pass after the ingest pairs it again. Then the row is deleted.
- `matchPendingToPosted` (`packages/shared/src/pending.ts`) takes the caller's `dayDistance`, which decides both the window and the closest-date tie-break.

Tests:

- shared pending: "a5-ingest-transfers-01: the caller's day distance decides the window, so a bank file that dates a hold by its posting day finds it".
- db dedupe:
  - "a5-ingest-transfers-01 (second round): a bank CSV that dates a hold by its posting day finds the feed row dated by the day of the purchase, either way round". The reviewer's (A), and the file first, then the feed. A row 7 days from both dates, and another merchant, stay apart.
  - "…a charge in a bank CSV whose tip settled, or a hold posted weeks later, is the pending row the feed has; the next sync posts it as that one row". The reviewer's (B) with an owner's note, and a rental hold of 10-01 in a file dated 10-20. A weak description beyond 5 days, a row dated before the hold and an amount more than half again stay apart. The ledger sums to the hand-calculated −472.00, and re-imports add nothing.
  - "…a bank CSV imported before the feed saw the charge pending, or a row entered by hand, is the row the posted item lands on". A manual −29.00 coffee with a category, a note and a tag is folded into the pending −25.00 row when it posts at −29.00. The row keeps its tag "work" and gains "client"; the ledger sums to −89.00.

### Second round, a5-ingest-transfers-02 (incomplete): a re-issue on the same connection could not be linked, and a full resync after a re-key doubled the older rows

Status: fixed.

What was wrong:

- (a) When the Bridge re-links a bank on the same connection and issues the account a new id (`ACT-CHK-NEW`), the sync creates a second "Everyday Checking" beside the old one, which keeps its connection. That gave five rows and the 1,000.00 balance twice (`c2.mts`). `linkFeedAccount` refused both ways (409 `account_connected`), and the web helper offered nothing for an account with a connection. The README described a path that existed only after removing the whole connection.
- (b) A regular sync from 10-12 took over T3 under its new id. The full resync from 07-20 then brought TRN-T1 and TRN-T2, but the re-key test needs every posted row of the window to be unlisted, and TRN-T3 was listed, so both were inserted next to T1 and T2 (`c3.mts`).

What changed (decision 43's second-round paragraph):

- **Same-connection link.** An account of the feed account's own connection may take it over once the Bridge no longer lists the account's id.
  - `feedListedAccountIds` (`packages/db/src/services/accounts.ts`) reads the connection's latest stored response that worked: a full sync or a balances refresh, its account ids and the ids its `errlist` names.
  - While that response lists the account, the link answers 409 `account_still_listed`, because the next sync would create the account again. An account of another connection is still 409 `account_connected`.
  - `GET /api/accounts` carries `inFeed`: false when that response did not list the account, null without a connection or a stored response. On the Accounts page, **same as a feed account…** is offered on an account with `inFeed` false, listing the accounts of its connection the Bridge still sends (`linkableFeedAccounts`), with its own tooltip.
- **A re-key seen in part.** Each posted feed row of the window that the feed no longer lists by id, while it lists others, is a candidate for a posted item of the same day, amount and merchant (similarity at least `STRONG_SIMILARITY`); the new id takes it over. An item of another day stays a new purchase. As before, the test is off for an account with a reported problem.
- Limit, stated in decision 43: the account's old id goes, so stored responses that name it are counted as `accountsUnknown` by **Re-read transactions**. Keeping former ids would need a column.

Tests:

- db dedupe:
  - "a5-ingest-transfers-02 (second round): an account the Bridge re-issued on the same connection is linked to its new feed account once the Bridge no longer lists the old one". Responses are stored as the worker stores them. The link is refused while both are listed and refused the other way round; after that, one checking account holds NT1 and NT2 with the owner's category, the card payment is still one pair, the balance is counted once, and the next sync adds nothing.
  - "…after a re-key a regular sync saw, a full resync over older days still keeps one row per purchase". The reviewer's c3, plus a purchase of the same amount and merchant on another day, which stays new.
- api: "a5-ingest-transfers-02 (second round): GET /api/accounts says which accounts the Bridge no longer lists, and link-feed folds a re-issued one on the same connection". It checks `inFeed` false, true and null, then 409 `account_still_listed`, 409 `account_connected` and the link.
- web: "a5-ingest-transfers-02 (second round): an account the Bridge no longer lists can take over a feed account of its own connection". The confirmation (`linkConfirmText`) also says which of the two accounts of one name stays, since a re-link usually keeps the name.
- Browser: the Accounts page offers the menu on the old account only and links it (`a5r2-ui-3-accounts-link.png`, `a5r2-ui-4-accounts-linked.png`).

### Second round, a5-ingest-transfers-11 (regression): a posted fare took over a later fare still pending

Status: fixed.

What was wrong: the listed-pending pass matched a posted item to any pending row the feed still listed: an equal amount, similarity at least 0.5, within 5 days. Monday's −2.75 RTD fare, posted (its pending form never seen), took over Tuesday's fare, which was still pending and carried the note "tuesday commute". The ledger was one purchase short while Tuesday's was listed. On Thursday T-TUE was inserted without the note, so the note stayed on Monday's fare for good (`c4.mts`). Before d41b7ac this case was right.

What changed (decision 47's second-round paragraph):

- A pending item and its posted form share the moment of the purchase (`transacted_at`, to the second). The sync now keeps it on each item (`IncomingTransaction.transactedAt`).
- A pending row the feed still lists is replaced only by a posted item with the same `transacted_at` as the pending item, the same amount and a strong description match. Both forms must carry the time. Otherwise the posted item is a second purchase, and the pending row is replaced when its own posted form comes.
- The first round's case (both forms listed with one time) is still one row.
- Residual risk, stated in the decision: a Bridge that dates by day only gives two purchases of one day the same time. A same-day repeat whose earlier pending form was never seen is then one row while the later one is listed. The two are alike in amount, day and merchant, so at most a note sits on the other one.

Tests:

- db dedupe "a5-ingest-transfers-11 (second round): a posted fare the feed lists next to a later fare of the same amount still pending is a second purchase":
  - The reviewer's c4: on Wednesday two rows, with the note on the pending fare; on Thursday T-TUE replaces it and keeps the note.
  - The same day at 8:00 and 18:00: the morning fare posts while the evening fare is still pending, and they stay two rows.
- The first round's a5-11 test still passes.

### Second round, new issue 1 (low): the undo of a CSV import was offered only right after the commit

Status: fixed.

What was wrong: the only caller of `POST /api/import/csv/:id/undo` was the result line of the commit just made, which kept `importLogId` in mutation state. After a reload or another page the id was gone. A commit without a saved profile has no connection, so no Connections log showed it, and a profile's log had no undo. So a file committed into the wrong account or with the wrong sign, and noticed later in the register, could only be deleted row by row. Even the delete prompt of a mapping profile said its imports "can still be undone from the Import page".

What changed (decision 50's second-round paragraph):

- `GET /api/import/csv/history` (`listCsvImports`, `packages/db/src/services/csvImport.ts`) lists the latest 25 bank imports, newest first. Each item carries:
  - the account it went into;
  - its saved mapping;
  - the rows read, added and already there;
  - the rows it still holds (what an undo removes);
  - when it was undone, and `canUndo`.
- The commit now keeps `accountId` in the log's stored payload. For an older import the account is that of a row it created or an id it recorded, and an undo writes it into the payload, so the list still names it once the rows are gone.
- **Recent bank imports** at the foot of the Import page lists them, each with **Undo** for the owner (a viewer sees the list without it), and the undo notice shows there. `importHistoryLine` words each line, with the time, so two imports of one day are told apart.
- The history is read with a handful of queries over the listed imports (rows held counted in one grouped query, the account from the stored payload first), so its cost does not grow with the ledger.

Tests:

- api: "a5-ingest-transfers (second round): GET /api/import/csv/history lists past bank imports with their account, and one is undone from the list". Two imports, one with a saved mapping; the older one is stored without its account as before. The older one is undone from the list after the newer one was made, and still names its account.
- web: "a5-ingest-transfers (second round): a past bank import says when, where, what it did and whether it was undone".
- Browser: two imports, a reload, then Undo on the older one (`a5r2-ui-1-history.png`, `a5r2-ui-2-history-undone.png`, and the phone width `a5r2-ui-5-phone.png`).

### Second round, new issue 2 (low): Re-read transactions skipped the responses of syncs that failed while applying

Status: fixed.

What was wrong: the sync stores a response before applying it, so that a crash loses nothing, and marks the log `error` when the apply fails. `runReprocessTransactionsJob` read only `ok` payloads, so the responses an older ingest crashed on, the ones an ingest fix most needs to replay, were never re-read. One older than the 93-day window was lost to the replay.

What changed (decision 53's second-round paragraph, and the button's tooltip): `error` payloads of `simplefin.sync` are replayed too (`apps/worker/src/jobs/reprocessTransactions.ts`) when they read as an account set with an account, counted as `payloadsFailedSync`. Replay mode is already idempotent. A failed sync's body that is not an account set (a 502 page kept as `{ notJson }`) is passed over, and not counted as unreadable.

Tests: worker "a5-ingest-transfers (second round): a response whose sync failed while it was applied is replayed too; one that is not an account set is passed over". The crashed response's posted −96.40 is inserted with its log id; its pending item is not; a second run adds nothing.
