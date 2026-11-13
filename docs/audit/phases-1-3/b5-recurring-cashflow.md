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
