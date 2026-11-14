# Audit record: the ledger pages in the web app (a8-ledger-ui)

Scope: the register (Transactions), Accounts, Connections, Rules, Payees and the non-authentication part of Settings in `apps/web`, with the routes and services behind them (`apps/api/src/routes/accounts.ts`, `categories.ts`, `packages/db/src/services/transactions.ts`, `transfers.ts`, `sync.ts`), Phases 1 to 3.

All seventeen findings were judged real against the spec, the phase plans and the code, and reproduced; all seventeen are fixed, none rejected or deferred. Three were already partly fixed in this round by batch b8-web-layout (commit 4ceba54): the register's `.scroll` box (b8-04, part of a8-13), the Accounts total and the register's empty state only for a loaded list (b8-13, part of a8-06), and the accessible names of the per-row selects and the Connect inputs (b8-15, part of a8-15). The sections below say what was left and what this batch changed. The decisions are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 90 to 101 (decision 34 points to 91), and `docs/phase-2-plan.md`, A28 (A5 points to it); the Phase 1 plan's test matrix has a "Ledger pages (audit a8)" row, and the README's "Bank sync" section describes the row editor, Add transaction, closing an account and a type change. One migration: `0008_transfer_splits` (data only; the schema snapshot is unchanged).

Test files: `packages/db/src/services/ledgerUi.audit.test.ts` (db), `apps/api/src/ledgerUi.audit.test.ts` (api), `apps/web/src/components/ledgerAudit.test.tsx` (the pages rendered from a seeded cache) and `apps/web/src/lib/ledgerForms.test.ts` (the pure helpers). Existing tests changed to the new contracts: `apps/api/src/routes.test.ts`, `categories.test.ts`, `hostileInput.test.ts`, `textRulesAccounts.audit.test.ts` (the payee list is now a page), `packages/db/src/services/sync.test.ts` and `apps/worker/src/jobs/sync.test.ts` (an `act.*` message names its account), and the `TransactionView` fixtures of `planAudit.test.tsx` and `shellAudit.test.tsx` (`transferPartner`).

Every new test was run against the code before the fix, on a pristine copy of the branch's HEAD in the lane's scratch directory (`laneA/a8fix/red`), and failed there, except the guards named below: db `red-db.log` 8 of 9 failed (the guard: the replay a reopen relies on recovers the closed days); api `red-api.log` 6 of 7 failed (the guard: a feed account keeps the bank's sign), and the eighth api test, added in review, failed against the first version of the reopen fix; web `red-web-2.log` 19 of 24 failed (the guards: four pages whose every mutation already showed its error, and "a disabled rule, another category or a rule with more conditions still gets the offer"); `ledgerForms.test.ts` does not load before the fix, since it tests helpers the fix adds (`red-web.log`). Logs from the first run of the work are `before-db.log`, `before-api.log` and `before-web.log` beside them.

The web changes were checked in the built app (the API serving `apps/web/dist` on port 3481, database `meridian_fix_a_a8fix`, a seeded household with an owner and a viewer, a feed connection carrying `act.missingdata`, 717 payees, a split Costco row, rules on a hidden category and on a closed account) in headless Chromium: `laneA/a8fix/check-a8.cjs`, output `after-browser.txt`, screenshot `after-phone-connections.png`. The auditor's probes and screenshots of the state before the fix are in `laneA/a8`.

Checks: `pnpm typecheck`, `pnpm lint` and `pnpm build` pass, and every suite passes with `TEST_DATABASE_URL`: shared (47 files, 918 tests), db (48 files, 370 tests), worker (13 files, 110 tests), api (40 files, 320 tests) and web (31 files, 383 tests). Nothing failed inside the Phase 4 paths.

## a8-ledger-ui-01 (medium): changing a manual account's type to Loan or Credit kept the positive balance, so net worth counted the debt as an asset

Status: fixed.

What was wrong: `PATCH /accounts/:id` took a type change without looking at the balance. "Car loan" added with 15,000 under the default type Checking was stored as +15,000; changing it to Loan left +15,000, so net worth and the "Credit and loans" total counted it as an asset, and the balance editor then offered "-15000.00" owed, which it refused. The reverse (a house entered as a Loan and moved to Asset) kept −400,000. Create and record-balance both refuse a positive loan balance (decision 64, 400 `debt_balance_positive`), so a type change left the account in a state neither would make.

What changed: for an account entered by hand (no connection and never fed, so no external id), a type change across the line between a debt (credit, loan) and anything else keeps the amount typed: the balance, the available balance and every balance snapshot change sign in the PATCH's transaction, audited as `account` (before and after type and balance), and an investment type asks for a revaluation. The result must be a balance the account could be given by hand: a loan with a positive balance is 400 `debt_balance_positive` and nothing changes (also for an account left by a removed connection, whose balance keeps the bank's sign). A feed account keeps the bank's balance whatever its type. The Accounts page asks first and says what the balance becomes ("Change Car loan to Loan? It will owe $15,000.00: its balance becomes -$15,000.00, and its earlier balances change the same way."); cancelling sends nothing. Refusing the change with 409 was the other option the auditor gave; it would have made the household record a balance of the wrong sign first (decision 90).

Tests:
- api "a8-ledger-ui-01: a type change between a debt and anything else keeps what the household typed": "a car loan entered as Checking with 15,000 owes 15,000 once it is a Loan, history included, and audited" (−1,500,000 and the 2026-10-01 snapshot −1,550,000, then a balance of 14,900 owed can be recorded), "a house entered as a Loan (400,000 owed) is worth 400,000 once it is an Asset", "a change that would leave a loan with a positive balance is refused and changes nothing; a change within one side keeps the balance", and the guard "a feed account keeps the bank's balance whatever its type (the bank's sign is the bank's)".
- web `ledgerForms.test.ts` "a8-ledger-ui-01: a type change says what a hand-entered balance becomes" (three cases, the texts above, nothing asked on the same side, for a feed account or with no balance).
- Browser (`after-browser.txt` "a8-01"): net worth $12,827.00, $27,827.00 with the car loan as Checking, the dialog, one `PATCH {"type":"loan"}`, net worth −$2,173.00 afterwards (12,827 − 15,000); cancelling the change back sends nothing and the select stays Loan.

## a8-ledger-ui-02 (medium): closing a feed account was one click, and the transactions it skipped while closed were never fetched after it was reopened

Status: fixed.

What was wrong: Close sent `PATCH {closed:true}` with no question and the row disappeared (show closed is off by default). While closed, the sync takes no transactions for the account (decision 34) but moves the connection's high-water mark, so after reopening the next sync asked only from the last mark and the closed days were never read again; only Full resync (93 days) or Re-read transactions recovered them, and no page said so.

What changed: Close asks, and for a feed account says that its transactions stop while it is closed and that reopening reads what it missed. Reopening a feed account queues `simplefin.reprocess_transactions` for its connection: every full sync's response is stored (`import_log.raw_payload`) with the closed account's transactions in it, and replay inserts only posted items the ledger lacks (a deleted row stays deleted), so it is safe to repeat and goes back to the day the account was closed, which clearing the mark (93 days at the Bridge) would not. The job carries its own dedupe key (`account_reopened:<account id>`): a replay of the connection that is already running may have read the responses while the account was still closed, so only a waiting reopen of the same account stands in for a new one. The page says "Joint Checking is open again. The transactions it missed while it was closed are being read from the stored sync responses…" (decision 91, decision 34 updated).

Tests:
- api "a8-ledger-ui-02: reopening a feed account queues a replay of the stored sync responses for its connection" (and nothing for closing or for a manual account), and "a8-ledger-ui-02: a replay already running for the connection does not stand in for the reopen (it may have passed the closed days)".
- db guard "a8-ledger-ui-02: a feed account's transactions skipped while it was closed are read again from the stored payloads once it is reopened" (closed from Oct 1, two weekly syncs carry S2 to S4, none is taken; after reopening, the stored payloads replayed add exactly S2, S3 and S4).
- web `ledgerForms.test.ts` "a8-ledger-ui-02: closing a feed account is asked, and reopening it says what happens".
- Browser "a8-02": the close dialog's text, the notice after Reopen, and the queued job `simplefin.reprocess_transactions queued account_reopened`.

## a8-ledger-ui-03 (medium): the Payees page listed only the first 500 payees by name, and merge offered only those as targets

Status: fixed.

What was wrong: `GET /api/payees` returned the first 500 payees by name with no count; the page showed them without saying the list was cut, and each row's merge select offered the same first 500, so "Walmart Supercenter" could not be merged into "Walmart" in a household with 617 payees.

What changed: `GET /api/payees` returns `{ items, total, nextCursor }`: a page by name (default 100, at most 500), the number that match and an offset cursor (400 `invalid_cursor` for one the server did not issue); `q` matches the name or any other name the payee answers to, escaped as every search. The page says "Showing 100 of 617 payees, by name.", has Load more, and its search is debounced. Merge is a searched picker over every payee ("merge into Walmart", with the target's transaction count and other names) instead of a select of the first page. The register's payee suggestions and the Recurring page's use the new shape (decision 92).

Tests:
- api "a8-ledger-ui-03: every payee can be reached: pages with a total, and a search that matches other names too" (617 payees paged to the end with no duplicate, both Walmarts found by "walmart" and one by its alias, a forged cursor refused).
- web `ledgerAudit.test.tsx` "a8-ledger-ui-03: the Payees page reaches every payee and says when its list is cut".
- Browser "a8-03": "Showing 100 of 717 payees", 200 after Load more, the search, the picker offering "merge into Walmart", its confirm and "Merged into Walmart; it now answers to 1 other name."

## a8-ledger-ui-04 (medium): the register could not edit a transaction's payee, tags or notes, nor add a transaction

Status: fixed.

What was wrong: the API took `payeeName`, `notes` and `tags` on `PATCH /transactions/:id` and had `POST /transactions`, but no page sent them: the row's more panel offered only pairing, marking as a transfer and delete, so a wrong payee could not be corrected and a row could be tagged only by writing a rule.

What changed: more opens "Payee, notes and tags" for the owner: the payee with suggestions from the payees, tags as a comma list (a leading # dropped, duplicates removed, 50 tags of at most 50 characters) and notes (at most 2,000), sending only what changed; a payee set there is locked against rules, as before. Add transaction enters a row by hand (account, a date not after the household's day, a signed non-zero amount read with string math, payee, category, notes); a feed or CSV row of the same purchase takes it over later (decision 42). A viewer sees neither (decision 93). Not added: the rule prompt after a payee change, which the auditor offered as an option; the change is locked against rules and the Rules page writes a rename.

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-04: the register edits a row's payee, notes and tags, and adds a transaction".
- web `ledgerForms.test.ts` "a8-ledger-ui-04: a row's payee, notes and tags, and a transaction added by hand" (three cases).
- Browser "a8-04": `PATCH {"payeeName":"Amazon","notes":"the broken lamp","tags":["returns","house project"]}` and the row showing them; "Farmers market −$12.50" added; −99,999,999,999,999,999 refused with "Too large".

## a8-ledger-ui-05 (low): the register, Accounts and Connections offered every change to a viewer, and the rule prompt appeared when the recategorization failed

Status: fixed.

What was wrong: a viewer got the register's category select, split and undo, every select, checkbox, Close and the add form on Accounts, and Connect, Sync, Disable and Remove on Connections; each change ended in the API's 403. The register set the "always do this" prompt before the PATCH answered, so it showed beside "Failed to fetch", and its rule then categorized the very row whose PATCH had failed.

What changed: those pages use `useIsViewer` as the Plan, Rules, Payees and Settings pages do (Phase 2 A24): a viewer reads the category, type, tax treatment and budget flag as text and gets no change control (decision 94). The register's category change is its own mutation (`recategorizeOptions`), and the prompt is offered from its `onSuccess` only (decision 95).

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-05: a viewer is offered no change on the register, Accounts or Connections" (three pages, each also checked for the owner).
- web `ledgerForms.test.ts` "a8-ledger-ui-16 and -05: the category change shows at once, goes back on failure, and prompts only after a save": "a failed save puts the row back and offers no prompt".
- Browser "a8-05": as the viewer 0 category selects, split buttons and Add; on Accounts 0 selects, checkboxes, Close and add form; on Connections only "Log". As the owner with the PATCH dropped: no prompt, "Can't reach Meridian…", the select back on the old category.

## a8-ledger-ui-06 (low): load failures and loading showed as empty data

Status: fixed (Accounts' total and empty state and the register's empty state had been fixed by b8-web-layout-13).

What was wrong: Connections never rendered its list's error and showed "No SimpleFIN connections yet" and "No saved mappings" for a failed load; Rules showed "No rules yet" for a failed load and, while the rules loaded, planned every history revert against an empty list ("The rule was deleted since" on every create, revert offered on deletes of rules that exist); the register and Accounts had no loading line.

What changed: Connections shows the load error and its empty states only for a loaded list; Rules shows "Loading rules…", "No rules yet" only for a loaded list, and plans a revert only once the rules are loaded; the register, Accounts and Payees show a loading line (decision 95).

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-06: loading and a failed load are never shown as empty data": "Connections: a failed load says why, with no 'No SimpleFIN connections yet' and no 'No saved mappings'", "Rules: a failed load is not 'No rules yet', and while the rules load the history offers no revert and calls nothing deleted", "the register, Accounts and Payees say they are loading, with no total and no empty state".
- Browser "a8-06": a 500 on `/api/connections` shows "Something went wrong on the server" and no empty text; with `/api/rules` delayed, "Loading rules", nothing called deleted and no revert, then three revert buttons once loaded.

## a8-ledger-ui-07 (low): a failed Disable, Remove, CSV-profile Delete or rule enable/disable showed no error

Status: fixed.

What was wrong: Connections never rendered `toggle.error` or `remove.error` (the CSV profile's Delete shared `remove`), and a rule's enable/disable went through the editor's `update` mutation, whose error showed only inside an open editor.

What changed: Connections renders the toggle and remove errors, and the profile's Delete has its own mutation with its error beside the profiles; Rules has a `toggle` mutation with a page-level error; the buttons are disabled while their request runs (decision 95).

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-07: Disable, Remove, a CSV profile's Delete and a rule's enable or disable report their failure on the page" ("ConnectionsPage: Disable / Enable", "ConnectionsPage: Remove", "ConnectionsPage: a CSV profile's Delete", "RulesPage: a rule's enable / disable": the mutation each button calls has its error rendered at page level), and "a8-ledger-ui-07: every change on Connections, Rules, Accounts, the register and Payees shows its failure" (every `useMutation` of the five pages has its error rendered or handed to the editor that shows it). The suite has no DOM, so these read the page's source; the behaviour is checked in the browser.
- Browser "a8-07": Disable answered 500 shows "Something went wrong on the server", and so does disable on the rule "Old stuff".

## a8-ledger-ui-08 (low): the rule editor showed "leave as it is" or "any account" for a rule on a hidden category or a closed account, and saved the old value

Status: fixed.

What was wrong: the editor offered only visible categories and open accounts, so the select of a rule that sets a hidden category read "leave as it is" and that of a rule limited to a closed account read "any account", while saving it untouched kept the hidden category and the closed account.

What changed: the options include the rule's own category when it is hidden ("Old hidden (hidden)") or gone ("(deleted category: sets nothing)") and its own account when it is closed ("Savings (closed)") or removed, as the goal form does (b7-plan-ui-09); other rules are not offered them (`ruleCategoryOptions`, `ruleAccountOptions`; decision 96).

Tests:
- web `ledgerForms.test.ts` "a8-ledger-ui-08: the rule editor shows the category and account the rule has, hidden or closed" (two cases).
- Browser "a8-08": editing "Old stuff" shows "Old hidden (hidden)" with the stored id as the value; "Savings interest" shows "Savings (closed)", and saving it untouched sends the Savings id.

## a8-ledger-ui-09 (low): "Always do this" was offered, and wrote a duplicate, when the same payee rule existed

Status: fixed.

What was wrong: the prompt never looked at the rules, so with "Blue Bottle Coffee → Coffee" at #1, recategorizing another Blue Bottle row to Coffee offered it again and wrote an identical rule at #4.

What changed: the prompt reads the rules (`["rules"]`) and, when an enabled rule has that payee as its only condition, equal as the rules engine compares it (`matchString`: NFKC, Latin accents folded, case ignored unless the rule says otherwise), sets that category and does not mark the row a transfer, it says "Rule #3 "Blue Bottle Coffee → Coffee" already categorizes Blue Bottle Coffee as Coffee." with dismiss instead of the offer; Always do this waits for the rules to load (decision 96). In review the comparison was changed from a local NFKC-and-lower-case fold to the engine's own, so "Café Rio" finds a rule on "cafe rio" as the engine would apply it.

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-09: 'always do this' is not offered for a rule that already exists" (and the guard "a disabled rule, another category, or a rule with more conditions still gets the offer").
- web `ledgerForms.test.ts` "a8-ledger-ui-09: the rule 'always do this' would duplicate is found as the rules engine matches" (accents and case folded, a case-sensitive rule compared exactly; not a contains rule, an added condition, another category, a disabled rule or one that marks a transfer).
- Browser "a8-09": the notice naming rule #3, no Always do this button, still one Blue Bottle rule.

## a8-ledger-ui-10 (low): a split row marked or paired as a transfer kept its split lines, and the register's category filter listed it as spending

Status: fixed.

What was wrong: A5 refuses to split a transfer, but marking or pairing a split row left its lines, so the plan's actual left it out (transfers are not spending) while the register's category filter, "as the plan counts it" included, listed Costco as "−$1,000.00 of −$1,234.56" Groceries, and the row's split could no longer be seen or edited.

What changed: `dropTransferSplits` removes the lines of rows that are transfers now and runs on every path that makes a row a transfer: the register's mark (`updateTransaction`), a pair by hand, a pair by the sync (`pairTransfersInDb`), a rule's `markTransfer` and an investment cash link (`markAsTransfers`). The register asks before a split row is marked or paired ("This transaction is split across 3 lines. A transfer has no split, so the lines are removed and the plan no longer counts it."). Migration `0008_transfer_splits` deletes the lines of rows that were transfers already. Undoing the transfer leaves the row uncategorized; the lines are not restored (Phase 2 A28, A5 updated).

Tests:
- db "a8-ledger-ui-10: a row that becomes a transfer loses its split lines (a transfer has no split)": "marked as a transfer without its other leg" (and gone from the Groceries list with and without plan scope), "paired by hand with the other leg", "marked by a rule run over every row", "linked to an investment cash transfer (markAsTransfers)", "a row that stays a transfer keeps nothing, and a row that is not one keeps its lines"; and "a8-ledger-ui-10: migration 0008 removes the lines of rows that were made transfers before the fix, and only theirs".
- web `ledgerForms.test.ts` "a8-ledger-ui-10: a split row asks before it becomes a transfer".
- Browser "a8-10": the question, 0 split lines left, and Costco no longer in the plan-scope Groceries list for November.

## a8-ledger-ui-11 (low): `act.*` connection entries named the account by the Bridge's opaque id

Status: fixed.

What was wrong: `errorsFromAccountSet` stored the Bridge's `account_id` and the page appended "(account ACT-9f8e7d6c-5b4a)", an id no page shows, so the household could not tell which account the entry was about.

What changed: the sync resolves the id to the local name of the connection's account and starts the message with it ("Joint Checking: The Bridge returned incomplete data for this account. It will retry on the next sync."), as its own per-account entries do; the renamed name if the household renamed it, and "(Bridge account …)" for an id the app has no account for. `accountId` stays in the entry for the code that reads it; the page no longer prints it (decision 98).

Tests:
- db "a8-ledger-ui-11: an act.* entry names the account by the name the household knows, not the Bridge's id".
- web `ledgerAudit.test.tsx` "a8-ledger-ui-11: the Connections page shows no Bridge account id".
- Browser "a8-11": the entry reads with the account's name and no Bridge id.

## a8-ledger-ui-12 (low): a transfer leg did not show its other leg

Status: fixed.

What was wrong: "Transfers only" listed each leg with only a transfer badge, so with two equal transfers on nearby days the pairing could not be checked in the register.

What changed: `TransactionView.transferPartner` carries the paired row's id, account and date (null when the row is not paired). The register shows "to Savings · 11/06/26" on an outflow, "from Checking · 11/05/26" on an inflow and "no other leg in the app" on a transfer marked alone (decision 97).

Tests:
- db "a8-ledger-ui-12: each leg of a pair names its other leg (account and date); a hand-marked transfer names none".
- api "a8-ledger-ui-12: a paired leg carries its other leg's account and date" (the pair route's answer and the list).
- web `ledgerAudit.test.tsx` "a8-ledger-ui-12: a transfer leg names the row it is paired with"; `ledgerForms.test.ts` "a8-ledger-ui-12: which row a transfer leg is paired with".
- Browser "a8-12": the five transfer rows with their partners.

## a8-ledger-ui-13 (low): at phone width the register and Connections overflowed the page

Status: fixed (the register by b8-web-layout-04, which put it in a `.scroll` box before this batch).

What was wrong: what was left after b8: the Connections page's connect form and each connection's button row did not wrap, so the page was 735 px wide at 390.

What changed: both rows are wrapping rows (`row wrap`, `conn-actions`) (decision 101).

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-13: rows of buttons wrap at phone width".
- Browser "a8-13": document width 390 at a 390 px window on /transactions, /connections, /accounts, /payees and /rules; screenshot `after-phone-connections.png`.

## a8-ledger-ui-14 (low): too-large amounts and an over-long search showed the wire contract's text

Status: fixed.

What was wrong: an amount past 15 digits of cents reached the API from the manual balance, the account's low-balance threshold, a rule's amount bounds and a split line, and came back as "balanceCents: cents as an integer string of at most 15 digits"; a 201-character search came back as a 400 beside "No transactions match".

What changed: `lib/amounts.ts` holds the wire's bound (also the plan grid's, b7-plan-ui-13), and each of those fields, the household threshold on Settings and a new transaction refuse an amount past 9,999,999,999,999.99 with "Too large (at most 9,999,999,999,999.99)" before sending; the thresholds are read with string math (`parseThreshold`). The register's search takes at most 200 characters, also when it comes from a link (a `maxLength` does not trim a value set by code) (decision 99). The household threshold on Settings is not named in the finding; it had the same defect and was found while fixing it. The investment settings' minimum trade (`dollarsToCents`, the investment views' batch) is not changed here.

Tests:
- web `ledgerForms.test.ts` "a8-ledger-ui-14: amounts past the wire's 15 digits are refused in dollars before sending" and "a8-ledger-ui-14: the household's low-balance threshold on Settings is bounded the same way".
- web `ledgerAudit.test.tsx` "a8-ledger-ui-14: the register's search is bounded like the API's": "the search field takes at most 200 characters", "a deep link with a longer search is cut to 200 characters (maxLength does not trim a value set by code)".
- Browser "a8-14": "Too large" on the add-account form and on Settings; 201 typed characters and a 300-character link both search with 200 and no error.

## a8-ledger-ui-15 (low): per-row selects had no accessible name, and account types read "Ira", "Hsa", "Pre Tax"

Status: fixed (the accessible names by b8-web-layout-15 before this batch).

What was wrong: what was left after b8: types and tax treatments were shown through `titleCase` of the enum ("Ira", "Hsa", "401k", "Roth", "Pre Tax").

What changed: `accountTypeLabel` ("Checking", "Credit card", "401(k)", "IRA", "Roth IRA", "HSA", "529 plan", "Asset") on Accounts, Settings, Holdings and the account's investments page, and the existing `taxTreatmentLabel` ("Pre-tax") on Accounts (decision 100).

Tests:
- web `ledgerAudit.test.tsx` "a8-ledger-ui-15: account types and tax treatments read as people write them"; `ledgerForms.test.ts` "a8-ledger-ui-15: account types as people write them".
- Browser "a8-15": the type and tax options as listed.

## a8-ledger-ui-16 (low): the register's category select jumped back to the old category until the save and refetch finished

Status: fixed.

What was wrong: the select was controlled by the cached row, which changed only after the PATCH and the refetch of every loaded page, so for the length of a slow save it showed the old category again.

What changed: the category change updates every cached register page at once (`withCategory`, in `onMutate`), puts them back if the save fails, and refetches when it settles (decision 95).

Tests:
- web `ledgerForms.test.ts` "a8-ledger-ui-16 and -05: the category change shows at once, goes back on failure, and prompts only after a save": "while the save is on the way the row shows the pick; on success the prompt is offered", "a failed save puts the row back and offers no prompt", "withCategory leaves other rows and data it does not hold alone".
- Browser "a8-16": with the PATCH delayed 2.5 s, "Groceries" 400 ms after the pick and after the save.

## a8-ledger-ui-17 (low): the Accounts page's net worth changed when "show closed" was ticked

Status: fixed.

What was wrong: the header summed the listed accounts, so ticking show closed added the closed Savings ($10,000) to "Net worth", which the dashboard leaves out (Phase 2 A16).

What changed: the header sums the open accounts whatever is listed (`netWorthCents`); the group totals still sum the accounts listed (decision 101).

Tests:
- web `ledgerForms.test.ts` "a8-ledger-ui-17: today's net worth leaves closed accounts out, whatever is listed" (2,500 + 10,000 closed − 450 = 2,050.00).
- Browser "a8-17": −$12,173.00 after closing Savings, the same with show closed ticked.
