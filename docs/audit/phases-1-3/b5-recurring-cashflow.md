# Audit record: recurring detection, subscriptions, alerts and cash-flow projection (b5-recurring-cashflow)

Scope: the Phase 2 recurring engine and its persistence (detection, matcher, refresh, status transitions, links), the Subscriptions, Recurring and Alerts pages, and the cash-flow loader, engine and page.

All 14 findings were judged real and fixed. The decisions are recorded in `docs/phase-2-plan.md`, "Decisions made during the audit", A7 to A15. The recurring and cash-flow area designs (`docs/design/phase-2/recurring.md`, `docs/design/phase-2/cashflow.md`) point to them where their text changed.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites of every package touched pass: shared, db, api, worker and web, with `TEST_DATABASE_URL` set. `pnpm build` passes. The built app was checked in headless Chromium on port 3491 against a seeded database (16 checks, no console errors).

Test infrastructure: integration suites name their throwaway databases `TEST_DATABASE_PREFIX` (default `meridian_test_`) plus a random suffix. This lets several checkouts share one Postgres server (`packages/db/src/test/db.ts` and the three migration suites; `.env.example`, README).

## b5-recurring-cashflow-01 (high): a card statement already paid before the payment day is paid again

Status: fixed.

What was wrong: the loader passed the card's balance at the last statement close as `knownStatementBalanceCents`, and the engine paid all of it on the payment day. Payments made since the close are already in today's balances, so they were paid a second time. In one case Checking lost 400.00 and the card went to +350.00. The same happened on the payment day itself once the autopay had posted.

What changed: the new `cardUnpaidStatementBalance` computes what is still owed on that statement. It is the balance at the close plus every payment or credit posted to the card since then (positive rows, posted or pending, through today). That equals the opening balance less the card's charges since the close. The loader passes this value, and the engine pays `max(0, −value)`. The engine's field doc says what it holds now. The seed's statement of 625.00, of which 300.00 was paid on 10-08, now leaves 325.00 to pay on 10-25. Decision A7.

Tests:
- `packages/db/src/services/cashflow.audit.test.ts`, suite "cash flow: card payments already made since the statement close (b5-01)":
  - "a statement paid in full on 10-10 is not paid again on 10-25; the 10-11 charge is paid on 11-25"
  - "a partial payment since the close leaves only the rest of the statement owed"
  - "a refund or a pending payment since the close counts as a credit too, and more than the statement owes nothing"
  - "payment day today: an autopay already posted today is not paid a second time on day 0"
  - "without any payment since the close the whole statement is still paid on the payment day"
- Hand numbers updated:
  - `packages/db/src/services/cashflow.test.ts`: "loads the six reads for a 30-day horizon", "card payment entries: …" and "projectForHousehold runs the engine …"
  - `packages/db/src/services/cashflow.extra.test.ts`: "B1. payment day = today: …"
  - `apps/api/src/cashflow.test.ts`: "projects every on-budget open account by default …" and "paymentDay and paymentFromAccountId are set or cleared together …"
- Browser: no Visa payment on 11/25 after the statement was paid on 11/10.

## b5-recurring-cashflow-02 (medium): after a price increase the item plans the old price for two more charges

Status: fixed.

What was wrong: `classifyAmounts` called a series fixed only when its last three charges agreed. After 15.49 × 5 and one charge of 17.99 the item turned variable at 15.49 ± 2.50 for the next two charges. The bills bucket, the Subscriptions page and the cash flow planned 15.49 for that time, and further price-increase alerts were suppressed. This contradicted the recurring design's resolution ("plan the new price immediately") and its risk note.

What changed: a level shift is also fixed. If the newest one or two charges agree with each other and the three before them agreed, the item is fixed at the last charge with a tolerance of max($1, 1%). Any other spread stays variable. A detection's amounts are classified over its on-cycle charges, so an off-cycle one-off can never set the expected amount, and the refresh after a confirm reproduces the detected amounts. The design's corrected TC8 is marked superseded. Decision A8.

Tests:
- `packages/shared/src/recurringDetect.audit.test.ts`, suite "b5-02: …":
  - "one, two and three charges at 17.99 after five at 15.49 are all fixed at 17.99 ± 1.00"
  - "a change from a series that was not fixed, or a run that does not agree, stays variable"
  - "detection proposes the new price, and an off-cycle one-off after the series does not set the amount"
- `packages/db/src/services/recurring.audit.test.ts`: "one charge at 17.99 makes it fixed at 17.99 everywhere; the next increase alerts again". It covers the alert, the Subscriptions row, the projected event and the second alert.
- `packages/db/src/services/recurring.test.ts`: "TC8a/c" updated.
- Browser: Netflix is listed at $17.99/mo and $215.88/yr.

## b5-recurring-cashflow-03 (medium): bills and income planned by hand are left out of the cash flow without a warning

Status: fixed.

What was wrong: the loader read only recurring items and the spending plan. A value typed into the grid for income, bills or savings, and a goal contribution without a transfer item, silently dropped out of the projection, with no warnings. The cash-flow design asked the UI to say so.

What changed: following the design, these amounts are still not forecast, since a guessed date or a spread would double count the recurring auto-fill. The new `unscheduledPlans` compares the plan of each income, bills and savings category per month with that category's own dated occurrences:
- In the current month the plan counts as planned less actual. In later months it is the plan as typed.
- An overdue occurrence counts in the current month. The horizon's last month counts in full.
- A month planned automatically from recurring items is skipped, because it is their schedule.

The positive rest comes back in the response as `unscheduled` (month, category, bucket, amount), along with one warning that names the categories. The Cash flow page lists those amounts. Each row links to the Recurring page's add form, prefilled with the category and the direction (`/recurring?new=1&category=…&direction=…`). The contract `CashFlowProjectionResponse` gains `unscheduled`. The grid is now read once for both the spending plan and this check. Decision A14.

Tests:
- `packages/db/src/services/cashflow.audit.test.ts`, suite "cash flow: planned amounts without a schedule (b5-03)":
  - "names every planned amount that no recurring schedule forecasts, with the part that is missing"
  - "a horizon that ends before the month's recurring date still counts that occurrence as scheduled"
  - "a month planned by a recurring item is its schedule: a missed occurrence the plan still holds is not listed"
- `apps/web/src/components/cashflow/unscheduled.test.ts`
- Seed expectations updated:
  - `packages/db/src/services/cashflow.test.ts`
  - `packages/db/src/services/dashboard.test.ts`
  - `apps/api/src/cashflow.test.ts`
  - `apps/api/src/dashboard.test.ts`

  The seed's typed paycheck and its goal contribution are such amounts.
- Browser: the notice, the warning, and the link that opens the prefilled add form.

## b5-recurring-cashflow-04 (medium): the next detector run reverts edits to a suggestion, even a confirm that races a scan

Status: fixed.

What was wrong: the detector rewrote a mapped suggestion with the detection's amounts, schedule and modal category, ignoring `amount_locked`, `schedule_locked` and the owner's category. A scan that had read a row as a suggestion also overwrote it after the owner confirmed it.

What changed: the rewrite (`suggestionRewrite`) keeps:
- a locked amount;
- a locked schedule, with next due taken from the locked schedule;
- any category the row has (a category is filled only when the row has none);
- the row's account, unless the detection's last charge is a new one.

The update runs as `… where status = 'suggested' returning`. A row confirmed or dismissed in the meantime only gets `detected_at`, and its links are not touched. Decision A10.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`, suite "b5-04: …":
  - "a locked amount and schedule and a chosen category survive the next run"
  - "a suggestion without a category takes the charges' category once they have one"
  - "a run that read the suggestion before the owner confirmed it only stamps detected_at"

## b5-recurring-cashflow-05 (medium): a cancelled item absorbs its payee's series, so a resubscription is never suggested

Status: fixed.

What was wrong: the whole-payee detection overlapped the cancelled row's old links and mapped to it, which only stamped `detected_at`. New charges after the cancel stayed unlinked, raised no alert, and were neither planned nor projected.

What changed: when a detection maps to a cancelled row, the group's charges that are dated after the row's cancel and that it does not hold are detected on their own. Those detections are mapped like any other. A new series becomes a suggestion, with `new_recurring` when B9 calls it new, and on later runs the same suggestion is updated in place. Dismissed rows stay sticky as designed. Decision A11.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "charges after the cancel form a new suggestion with a new-subscription alert; the cancelled item keeps its history". It covers the suggestion, the alert, a second run with no duplicate, and the projection after the confirm.

## b5-recurring-cashflow-06 (medium): recurring transfers between own accounts are listed and totalled as subscriptions

Status: fixed.

What was wrong: `listSubscriptions` had no transfer filter. A monthly 500.00 transfer to savings showed as the most expensive subscription and took 97% of the total.

What changed: items with `transfer_account_id` are excluded from `items`, `pausedItems` and the totals. They stay on the Recurring page and in the cash flow. Decision A13.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "b5-06: a recurring transfer to the household's own savings is not a subscription"
- `apps/api/src/recurring.audit.test.ts`: "b5-06, b5-10: subscriptions leave out transfers and carry the auto-pause reason"
- Browser: "Save monthly" is not on the Subscriptions page.

## b5-recurring-cashflow-07 (medium): seasonal utility bills are never detected

Status: fixed.

What was wrong: a variable group whose amounts went beyond ×2 of their median was rejected outright and handed to amount clustering. A heating bill (30.00 to 150.00 over a year) splits into clusters too small to be a series, so the spec's own example of a variable bill was never suggested. Two further problems would have broken it once confirmed: the matcher's variable gate (⅓× to 3× the expected amount) refused the winter charges, and the item would then have auto-paused.

What changed: a dispersed group is accepted as one variable series if all of these hold:
- the whole group, the per-account split and the clusters yield fewer than two series;
- it has at least six charges (`MIN_CHARGES_DISPERSED`);
- every charge is on-cycle on the chosen cadence (no extra, no miss).

Two clusters that are each a series, such as iCloud and Music, still win. The matcher's gate for variable items spans ⅓ of the smallest to 3 × the largest of the expected amount and the last six linked charges. Fixed items keep ½× to 2×. Decision A9.

Tests:
- `packages/shared/src/recurringDetect.audit.test.ts`, suite "b5-07: …":
  - "the amounts are dispersed: …"
  - "every charge is on-cycle on one cadence and the fallbacks find nothing, so it is one variable monthly bill"
  - "an extra charge in a period, a missed cadence or too few charges keep a dispersed group rejected"
  - "two amount clusters that are each a series still win over one dispersed series …"
- `packages/db/src/services/recurring.audit.test.ts`:
  - "suggests the gas bill, and after the confirm links the winter bills that swing past three times the summer amount"
  - "a variable item's gate still keeps out a charge far outside everything it has seen"

## b5-recurring-cashflow-08 (medium): changing an item's account is reverted to the last charge's account

Status: fixed.

What was wrong: every refresh set `account_id` to the last link's account, including the refresh at the end of the edit. A user's card change was undone in the same request, and the cash flow kept debiting the old card.

What changed: the refresh moves the account to the last charge's account only when that charge was just linked (by a matcher run, a manual link or a move). A card move is still followed when its first charge arrives, but an edit stands until then. The suggestion rewrite follows the same rule. The edit form says so. Decision A12.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`:
  - "b5-08: an account chosen by the owner stands until a later charge is linked, which it then follows"
  - "b5-08: a suggestion keeps the owner's account across runs until a new charge arrives"

## b5-recurring-cashflow-09 (low): an active item's account can be cleared, which drops it from the projection

Status: fixed.

What was wrong: only the category was required for an active item. `PATCH {accountId: null}` was accepted, and the projection then skipped the item.

What changed: a confirm, resume, reactivation or manual create needs an account. So does an edit that leaves the item active. Any of these without an account is answered 400 `account_required` (plan decision 12, "required to activate"; decision A12). A paused or cancelled item may lose its account. In the edit form, the account is marked required and is checked for active items.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "b5-09: an active item cannot lose its account; a paused one can, and then needs one to resume"
- `apps/api/src/recurring.audit.test.ts`: "b5-09: PATCH an active item's account to null is 400 account_required"
- `apps/web/src/components/recurring/recurringAudit.test.ts`: "editing an active item without an account is refused; a paused one may lose it"
- Browser: the form error.

## b5-recurring-cashflow-10 (low): the 'auto-paused' badge disappears after the next nightly run

Status: fixed.

What was wrong: the badge read `consecutiveMissed >= 3`, which the next refresh of a paused item resets to 0.

What changed: `SubscriptionRow` carries `statusReason`, and the badge shows while `status = paused` and `statusReason = 'missed_3'` (`isAutoPaused`). Decision A13.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "b5-10: an auto-paused subscription says so after later nightly runs too"
- `apps/api/src/recurring.audit.test.ts`: the b5-06/b5-10 test
- `apps/web/src/components/recurring/recurringAudit.test.ts`: "is shown while the item is paused for missed charges, whatever the missed count says now"
- Browser: the Gym item, refreshed twice, still shows the badge.

## b5-recurring-cashflow-11 (low): the new-subscription history guard reads the last charge's account

Status: fixed.

What was wrong: `isNewSeries` was given the history start of the last on-cycle charge's account. A long-held subscription that moved to a card with a long history was announced as new.

What changed: `Detection` carries `firstAccountId`, and the guard uses that account's history start, as design B9 says.

Tests:
- `packages/shared/src/recurringDetect.audit.test.ts`: "a subscription that moved cards: firstAccountId is the old card, accountId the new one"
- `packages/db/src/services/recurring.audit.test.ts`: "b5-11: a subscription that moved to a card with long history is not new when it started at the first sync of the old card"

## b5-recurring-cashflow-12 (low): the Charges panel's 'move here' can never succeed

Status: fixed.

What was wrong: the panel offered "move here" for charges linked to another item, and the link route always answered 409 for them. The panel also offered charges of other payees, which the route refuses with 400.

What changed: `POST /api/recurring/:id/link` accepts `move: true`. After the usual checks (same payee and direction, not a transfer, a free period), the charge leaves the other item, which is refreshed, and joins this one in the same transaction. Without `move` the answer is still 409. The panel offers only what the route accepts (`chargeLinkAction`): "link" for a free charge of the item's payee and direction, and "move here" for one held by another item. Decision A15.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "b5-12: a charge linked to one item can be moved to another item of the same payee"
- `apps/api/src/recurring.audit.test.ts`: "b5-12: POST /link with move takes a charge from another item of the same payee; without it, 409"
- `apps/web/src/components/recurring/recurringAudit.test.ts`: "links a free charge of the same payee and direction, moves one linked elsewhere, offers nothing else"
- Browser: Apple iCloud's November charge moved to Apple Music; 200 response, and Apple Music shows 3 linked charges.

## b5-recurring-cashflow-13 (low): a salary raise raises a 'Price increase' alert

Status: fixed.

What was wrong: the refresh's price-increase check did not look at the direction of the item.

What changed: `price_increase` is raised only for outflows (spec step 5 is about charges). Decision A13.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`: "b5-13: a raise on a paycheck is not a price increase"

## b5-recurring-cashflow-14 (low): the Recurring list's 'net' total drops its sign

Status: fixed.

What was wrong: with "In and out" selected, the totals line showed the magnitude after "net". A net outflow read the same as a net inflow.

What changed: `recurringTotalsLabel` says "net out" or "net in" when both directions are listed, and shows plain magnitudes for a one-direction filter.

Tests:
- `apps/web/src/components/recurring/recurringAudit.test.ts`: "says net out or net in when both directions are listed, and plain magnitudes for one direction"
- Browser: "5 items · net out $2,323.97/mo · $27,887.64/yr".

## Second round

An independent reviewer confirmed twelve of the fourteen first-round fixes and left two open, b5-04 and b5-05, both "incomplete": the reported case is fixed, a nearby case is not. It raised no new issues. Both cases were reproduced at HEAD and are real; both are fixed in `packages/db/src/services/recurring.ts`. Decisions A10 and A11 of `docs/phase-2-plan.md` were amended (no new number), and the recurring design (`docs/design/phase-2/recurring.md`, section C and C1) was edited to match.

Every new test was run against the service as it was before the fix and failed: 6 of 6, output in the lane's scratch directory (`laneB/b5r2-red-db.txt`). The runs after the fix are `laneB/b5r2-green-db.txt`, `-worker.txt` and `-api.txt`.

### Second round, b5-recurring-cashflow-04 (incomplete): an edit that lands while a detection run is in flight is reverted

Status: fixed.

What was wrong: `runRecurringDetection` read every recurring row once at its start, in one transaction and without row locks, and `suggestionRewrite` built on that copy. The first round's conditional update (`where status = 'suggested'`) only caught a confirm or dismiss. An edit that leaves the row a suggestion was overwritten with the copy the run had read. Reproduced with two real transactions (the owner's edit written but not yet committed when the run starts): a suggestion at −9.99 without a category, its charges since categorized as Entertainment. The owner sets −12.99 and Subscriptions, and after the run the row is back at −9.99 in Entertainment, while `amount_locked` still reads true. The run starts often while the owner is using the app: after every sync and after ledger edits, not only at night. The same unlocked read let the cleanup of suggestions that a run does not reproduce delete one the owner confirmed meanwhile. Reproduced: a lapsed suggestion confirmed while the run was about to delete it was deleted, and its links were nulled.

What changed:
- `upsertDetections` reads its group's rows and their links itself, when it upserts that group, with `SELECT … FOR UPDATE` (`lockGroupRows`). It no longer takes an `existing` argument. Three cases follow:
  - An edit, confirm or dismiss that committed while the run was in flight is what the mapping and the rewrite build on.
  - One still in flight holds the row. The run waits for it, then reads the committed row.
  - One that starts after the read waits for the run and lands on top of its rewrite.

  A locked amount, a locked schedule and a category set meanwhile are kept, and a row that is no longer a suggestion only gets `detected_at`. The rewrite therefore no longer needs the conditional update.
- The run calls it only for groups that have a detection or a cancelled row (b5-05 below).
- The cleanup selects the stale suggestions `FOR UPDATE`, so Postgres re-checks a row changed meanwhile. A suggestion confirmed or dismissed in that window is no longer stale and is kept with its links.

The reviewer's other suggestion, `updated_at = best.updatedAt` in the update's condition, was not taken. It would leave an edited suggestion unrefreshed for that run, and it depends on every writer bumping `updated_at`. Decision A10 says so.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`, suite "b5-04 (second round): an edit or a confirm that lands while a detection run is in flight". Each test holds the owner's write open in its own transaction, starts the run, waits until the run waits on the row lock (`pg_stat_activity`) and only then commits:
  - "an edit to a suggestion made after the run read the rows is kept: the rewrite builds on the edited row". The reviewer's P4b: −12.99, `amount_locked`, Subscriptions, 6 links, `detected_at` of the run. Before the fix it was −9.99 in Entertainment.
  - "a suggestion the owner confirms while the run is about to delete it as not reproduced is kept with its links". Last charge 09-05, run on 11-20: the item is active with its 6 links, and only the other lapsed suggestion is deleted. Before the fix both were deleted.
- The first round's "a run that detected before the owner confirmed the suggestion only stamps detected_at" now calls the new signature (detections from a read before the confirm).

### Second round, b5-recurring-cashflow-05 (incomplete): a resubscription on a different billing day is never suggested

Status: fixed.

What was wrong: the first round ran the detection of the charges after a cancel only when a detection of the whole group mapped to the cancelled row. That needs the old and new charges to score as one series, which happens only when the new charges fall on the old billing day. Billing usually restarts on the signup date, so the common case did not work. Reproduced (the reviewer's P5a): Netflix −15.49 on the 5th from March to August 2026, confirmed and cancelled on 08-10, then −15.49 on the 20th from 2026-11-20 on the same account. `detectRecurring` of the whole group returns nothing, while the new charges alone form a series. Monthly runs up to 2027-07-22 (9 new charges) created nothing, and the projection had no Netflix event.

While fixing it, a second defect was found in the first round's code. The detection of the charges after a cancel took every later charge of the payee that the cancelled row did not hold, so it also detected the payee's other series. That series' row had already been claimed in the run, so it was inserted again as a duplicate suggestion, which took its charges. Reproduced: Apple with iCloud on the 10th (a suggestion) and Music on the 5th, cancelled and taken again on the same day. The run created 2 suggestions instead of 1.

What changed:
- For every cancelled row of a group, whether or not a detection mapped to it, the charges dated after its cancel (`status_changed_at`) that no cancelled row holds are detected on their own (`resubscriptionDetections`). That runs after the group's own detections, and the detections are mapped like any other:
  - the suggestion of an earlier run is updated in place;
  - a dismissed one absorbs them, as designed;
  - a new series becomes a suggestion, with `new_recurring` when B9 calls it new.
- Such a detection is dropped when it shares a charge with a series the run already placed on a row that is not cancelled: another series of the payee, or the resubscription when the whole group already proposes it. So nothing is suggested twice.
- These detections are computed before the group writes anything. If the engine throws there, the payee is skipped (`groupsSkipped`, `onGroupError`) and its rows are left untouched, as when the engine throws for the whole group (C1).

Decision A11 says so.

Tests:
- `packages/db/src/services/recurring.audit.test.ts`, suite "b5-05 (second round): every cancelled item hands on the charges after its cancel":
  - "a resubscription billed on a different day is suggested, with a new-subscription alert, and stays one suggestion as it grows". The whole group detects nothing. The run on 2027-01-22 creates one suggestion: −15.49 fixed, anchor day 20, 3 links, next due 02-20, on Checking, in Subscriptions, with `new_recurring`. Checking's history starts 03-05, so the first new charge is 260 days in and 63 days old. Six monthly runs to 2027-07-22 each update it in place and raise nothing (9 links, next due 08-20). Confirmed, it is projected on 2027-08-20.
  - "a resubscription the owner dismissed stays dismissed as its charges continue". Two more charges and a run: no suggestion and no alert.
  - "another series of the same payee is not suggested a second time beside the resubscription". The Apple case: 3 rows. iCloud keeps its 11 links, the cancelled Music row keeps its 6, and the new Music suggestion has the 3 new charges and one `new_recurring`.
- `packages/db/src/services/recurring.engineError.test.ts`, "logs the payee, counts it skipped, keeps its rows and finishes the run for the others". The engine is mocked to throw for a group of charges dated only after the cancel. The result is `groupsSkipped` 1, the error logged against Netflix, the cancelled row unchanged, and another payee's suggestion still created.

### Checks

`pnpm typecheck`, `pnpm lint` and `pnpm build` pass. The suites of the packages touched and of those that run the detection, with `TEST_DATABASE_URL` and prefix `meridian_fix_b_`, all pass: db 61 files and 455 tests, worker 15 and 130, api 46 and 375. Only `packages/db` changed (no app and no web code), so no browser check was needed. The two lock-wait tests passed in five repeated runs. No check failed inside the Phase 4 paths.
