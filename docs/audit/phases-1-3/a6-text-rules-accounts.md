# Audit record: Accounts, payees, rules and text safety (a6-text-rules-accounts)

Scope: manual and feed accounts (types, budget flag, balances, net worth), payees (normalization, aliases, rename and merge), the rules engine and its routes and page, and the safety of text from the feed and from imports wherever it is stored or shown (Phases 1 to 3).

Every finding was judged against the spec, the phase plans and the code, and reproduced before it was fixed; all 21 are real and all 21 are fixed. Decisions taken here are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 55 to 68, and `docs/phase-2-plan.md` A16 and A17; the Phase 1 plan's rules semantics and test matrix, the Phase 3 plan's off-budget line, the grid-and-api design's net-worth rule and the README's "Bank sync" section were edited to match. One dependency was added: `re2js` 2.8.6 (pure JavaScript RE2, MIT, no dependencies) in `packages/shared`, `apps/api` and `apps/worker`; it is not in the web bundle.

Test files: `packages/shared/src/sanitize.test.ts`, `rules.test.ts` and `payee.test.ts` (shared); `packages/db/src/services/textRulesAccounts.audit.test.ts` (db); `apps/api/src/textRulesAccounts.audit.test.ts` (api); `apps/web/src/components/charts/chartOptions.test.ts`, `investmentOptions.test.ts`, `apps/web/src/components/investments/GrowthChart.test.ts`, `apps/web/src/lib/accountForms.test.ts` and `rulesForm.test.ts` (web). Each new test was run against the code before its fix and failed; the outputs are in the lane's scratch directory (`a6-red-sanitize.txt`, `a6-red-shared-rules.txt`, `a6-red-shared-payee.txt`, `a6-red-db.txt`, `a6-red-api.txt`, `a6-red-web-charts.txt`, `a6-red-web-accountForms.txt`, `a6-stray-src-before.txt`). The web changes were checked in the built app in headless Chromium on a fresh database (`a6ui/ui-check.cjs`, result in `a6ui/ui-check-result.txt`, screenshots `a6ui/ui-1` to `ui-6`).

## a6-text-rules-accounts-01 (high): chart tooltips insert account and security names as raw HTML

Status: fixed.

What was wrong: `sanitizeText` removed only complete tags, so a feed account name ending in an unclosed `<meta http-equiv=refresh …` was stored as it came, and the three ECharts tooltip formatters (cash flow, Portfolio value over time, Performance growth of $10,000) concatenated the series name into the HTML they return, whose own `: <strong>` closed the injected tag: hovering the cash-flow chart navigated the browser.

What changed: the formatters escape every name and date they put into their HTML (`escapeHtml` in `apps/web/src/lib/format.ts`), whatever the source. `sanitizeText` removes complete tags with a linear pattern and then any `<` or `>` left, so stored feed and import text can no longer open a tag anywhere (decision 61).

Tests: web `chartOptions.test.ts` "tooltip text from the feed is never markup (a6-text-rules-accounts-01) > escapes an account name in the cash-flow tooltip", `investmentOptions.test.ts` "value-over-time tooltip and feed text … > escapes an account name instead of inserting it as markup", `GrowthChart.test.ts` "growth-of-$10,000 tooltip and feed text … > escapes account and benchmark names". shared `sanitize.test.ts` "sanitizeText and markup that is not a complete tag (a6-text-rules-accounts-01) > leaves no angle bracket behind". Browser: an account named `Savings <meta http-equiv=refresh content=0;url=/api/health?`, hover on /cashflow: no `meta` element in the page, the tooltip shows the name as text, the page stays on /cashflow (`ui-check-result.txt` lines "01", `ui-1-cashflow-tooltip.png`).

## a6-text-rules-accounts-02 (high): a rule whose category was deleted fails every import and sync with a matching row

Status: fixed.

What was wrong: `deleteCategory` did not look at rules, and the rule routes did not check `setCategoryId`, so a rule could name a category that no longer existed; every CSV commit and every sync with a matching row then failed on the transaction's foreign key, and the high-water mark kept the failing item in the window.

What changed: a category a rule sets is in use (409 `in_use` naming up to three rules); create and edit refuse an unknown category (400 `unknown_category`); `loadRules` drops a category action whose category is gone for evaluation, so a rule left from before sets nothing and imports, syncs and "Run on all" go on; the Rules page reads the stored rule (`loadRules(…, { stored: true })`) and says "(deleted category: sets nothing)" (decision 57).

Tests: db "a6-text-rules-accounts-02: a category a rule sets cannot be deleted (409 in_use naming the rule)", "a6-text-rules-accounts-02: a rule naming a category that no longer exists sets nothing, and imports and syncs go on" (CSV commit, `applyAccountSet` with two matching feed items, `runRules`). api "a6-text-rules-accounts-02: a rule must name a category that exists, and a category a rule sets is not deleted".

## a6-text-rules-accounts-03 (high): a manual account's balance cannot be updated after creation

Status: fixed.

What was wrong: only `POST /accounts` wrote a manual balance, for today; `PATCH /accounts/:id` silently dropped `balanceCents` (Zod strips unknown keys), and no route or page could record a house revalued or a loan paid down.

What changed: `POST /api/accounts/:id/balances { balanceCents, date? }` (`recordManualBalance` in `packages/db/src/services/accounts.ts`) writes a manual balance snapshot for an account without a connection, moves the account's balance when no later one exists, refuses a feed account (409 `feed_account`), a future date (400 `future_date`) and a positive loan balance, is audited and asks an investment account for a revaluation. `UpdateAccountBody` is strict (unknown keys 400). The Accounts page has **update balance** with an optional date (decision 63). A delete route for manual accounts was not part of the finding's fix and is not added.

Tests: api "a6-text-rules-accounts-03: a manual account's balance is recorded by date; PATCH refuses a field it does not take" (hand check: net worth 461,000.00 today, 420,000.00 a year ago, change 41,000.00). Browser: Boat $1,234.56 updated to $2,000.00 (`ui-check-result.txt` "03", `ui-2-accounts.png`).

## a6-text-rules-accounts-04 (medium): a rule regex can hang the API and the worker

Status: fixed.

What was wrong: patterns ran on the backtracking JavaScript engine with no check, so `^(\w+\s?)+$` on a 44-character description ran for minutes inside the request, or inside the synchronous `evaluateRules` of a sync.

What changed: patterns are compiled once per batch and matched with RE2 (`re2js`), linear in the text; create and edit refuse a pattern RE2 cannot run (look-around, back-references, syntax errors) or longer than 200 characters with 400 `invalid_regex` and the reason (decision 55).

Tests: shared "regular expressions run in linear time (a6-text-rules-accounts-04) > answers a pattern with nested quantifiers at once instead of backtracking for minutes" (before the fix: 118,883 ms on the first pattern), "… > refuses a pattern that does not compile, uses look-around or back-references, or is too long". api "a6-text-rules-accounts-04: a rule pattern with nested quantifiers neither hangs the API nor the imports after it", "a6-text-rules-accounts-04/16: a pattern that does not compile, and an amount range that cannot match, are refused". Browser: the editor shows the server's reason for `(?=x)`.

## a6-text-rules-accounts-05 (medium): a manual loan entered as a positive amount adds to net worth

Status: fixed.

What was wrong: the form asked for a "Balance" and stored what was typed, while net worth reads liabilities as negative balances: a $15,000 loan made net worth $30,000 too high.

What changed: for a card or a loan the field is "Amount owed" and is stored negated (`parseManualBalance` in `apps/web/src/lib/accountForms.ts`); the balance editor shows the amount owed back; the API refuses a positive manual loan balance (400 `debt_balance_positive`) at creation and by date (decision 64).

Tests: web `accountForms.test.ts` "loans and cards take the amount owed (a6-text-rules-accounts-05)". api "a6-text-rules-accounts-05: a manual loan is what is owed, so a positive balance is refused" (net worth 1,000.00 − 14,000.00 = −13,000.00). Browser: "15,000" for Car loan shows −$15,000.00.

## a6-text-rules-accounts-06 (medium): feed accounts named "Joint Checking" are typed as brokerage and created off budget

Status: fixed.

What was wrong: `guessAccountType` tested the brokerage and card words before the bank nouns, so "Joint Checking" became a brokerage (off budget, taxable), "Platinum Checking" a card, "Auto Savings" a loan.

What changed: the account noun decides first (checking, savings, money market, CD), after the retirement and investment words; card and loan words apply only without a bank noun; "Individual" or "Joint" alone still name a brokerage (decision 66).

Tests: db "account types guessed from a feed account's name (a6-text-rules-accounts-06)" (23 names), "a6-text-rules-accounts-06/08: a feed's Joint Checking is a checking account on budget; a feed mortgage starts off budget".

## a6-text-rules-accounts-07 (medium): closing an account rewrites past net worth and the 12-month change

Status: fixed.

What was wrong: both the today and the year-ago sums left out closed accounts, so closing an emptied savings account removed its year-ago balance and showed a $10,000 gain that never happened.

What changed: only today's figure leaves out closed accounts; the year-ago figure counts every account as it stood then (Phase 2 plan A16; the grid-and-api design's rule edited). The existing dashboard test's closed-card case was updated to the new rule.

Tests: db "a6-text-rules-accounts-07: closing an account does not change what the household was worth a year ago" (11,000.00 today and a year ago before and after the close); `dashboard.test.ts` "net worth: clamped year-ago date, closed accounts out of today's figure only, null when nothing that old exists" (year ago 350,000 − 10,000 − 99,999 = 240,001).

## a6-text-rules-accounts-08 (medium): manual houses, vehicles and loans start on budget, so the projection counts them as cash

Status: fixed.

What was wrong: `defaultOnBudget` put every non-investment type on budget, so a house's value and a loan's balance joined the cash-flow projection and the dashboard's 30-day line.

What changed: asset and loan accounts start off budget on both creation paths (decision 65, Phase 2 plan A17); the Budget box still switches any account; existing accounts keep their flag.

Tests: db "houses, vehicles and loans start off budget (a6-text-rules-accounts-08)". api "a6-text-rules-accounts-08: a manual house or loan starts off budget and stays out of the cash-flow projection" (combined opening 100,000, Checking and the card only). Browser: Boat and Car loan unticked.

## a6-text-rules-accounts-09 (medium): manual balance input is parsed with floats

Status: fixed.

What was wrong: the Accounts form computed `Math.round(Number(text) * 100)`: "1,234.56" and "$500" were dropped without a word and "1.005" became $1.00.

What changed: `parseManualBalance` strips `$`, commas and spaces and reads the value with `parseDecimalToCents`; a value it cannot read is shown as an error ("Use at most two decimals", "Not an amount") and nothing is sent (decision 64).

Tests: web `accountForms.test.ts` "manual balance input (a6-text-rules-accounts-09)" (two cases). Browser: "1,234.56" stored $1,234.56; "1.005" shows "Use at most two decimals".

## a6-text-rules-accounts-10 (medium): payee merge breaks rules on the merged name; rename drops the old name; a name clash is a 500

Status: fixed.

What was wrong: after a merge the rules saw only the target's name, so the "always do this" rule written on the variant stopped matching; a rename did not keep the old name, so the next import created the old payee again; renaming onto an existing name hit the unique index (500); no page offered merge or rename.

What changed: a payee condition holds on the payee's name and its aliases, at import, on demand and for released transfer partners; a rename keeps the old name as an alias; a name another payee has (name or alias) is 409 `name_taken`; a new Payees page renames, merges and sets the default category (decision 58).

Tests: shared "payee conditions and merged names (a6-text-rules-accounts-10)". db "a6-text-rules-accounts-10: a rule written on a name keeps working after that name is merged into another payee". api "a6-text-rules-accounts-10: rename keeps the old name, a clash is 409, and rules on a merged name keep working". Browser: merge, rename and the 409 message (`ui-4-payees.png`).

## a6-text-rules-accounts-11 (medium): `sanitizeText` is quadratic on long runs of `<` and runs before truncating

Status: fixed.

What was wrong: `/<[^>]*>/g` scanned to the end of the text from every `<`, and the cut to the length cap came after the patterns: 100,000 `<` took four seconds, a 300,000-character CSV description blocked the API for 39 seconds.

What changed: the input is cut to four times the cap plus 256 characters first, the tag pattern is `<[^<>]*>` (linear), leftover brackets go, and a cut never splits a surrogate pair (decision 61).

Tests: shared "sanitizeText on enormous fields (a6-text-rules-accounts-11) > takes linear time on long runs of '<' and cuts before any pattern runs" (before the fix: 37 s), "… > never cuts a surrogate pair in half".

## a6-text-rules-accounts-12 (medium): city/state stripping keeps half of multi-word cities, eats a merchant word, keeps ride times

Status: fixed.

What was wrong: `normalizePayee` dropped the state and exactly one word before it, after the store number was gone, so "SAN FRANCISCO" left "San", "TACO BELL 1234 CO" became "Taco", and "LYFT *RIDE TUE 5PM" kept "Tue 5pm": one merchant, several payees.

What changed: a store number, phone number, masked card or processor code marks where the merchant ends, and the words between it and the state (none to three) are the city; without a mark the city is the last word widened by lists of city prefixes and suffixes; a weekday before a time and hour-only times are dropped (decision 60). A bare "ST LOUIS BREAD CO" still reads CO as Colorado; that is the documented limit, which a rename (finding 10) corrects once.

Tests: shared `payee.test.ts` "a6-text-rules-accounts-12: …" (19 hand cases, the auditor's included) and "a6: stays idempotent on the new cases"; the 19 earlier cases still pass. The auditor's 47-description probe was run before and after (`payee-before.txt`, `payee-after.txt`): every changed output is one of the fixed cases, plus "Amazon Mktp" (before "Amazon", "MKTP" was taken for a city) and "Atm Withdrawal" (before "Atm Withdrawal Main St").

## a6-text-rules-accounts-13 (medium): rule history cannot be reviewed or reverted in the app, and rules cannot be edited

Status: fixed.

What was wrong: the audit log kept rule history but no page read it; the Rules page could not create or edit a rule (only "always do this" wrote one), deleted without asking, and the documented revert of a delete recreated the rule last and ran it over existing rows.

What changed: the Rules page has a rule editor with every condition and action, asks before deleting, and lists the rule history with a revert per entry through the normal routes (`revertPlan` in `apps/web/src/lib/rulesForm.ts`). `POST /api/rules` takes `position` and `enabled`, so a deleted rule comes back at its old place, in its old state, with `applyTo: "none"` (decision 67).

Tests: web `rulesForm.test.ts` "rule editor (a6-text-rules-accounts-13)" (three cases) and "rule history and revert (a6-text-rules-accounts-13)" (three cases). api "a6-text-rules-accounts-13: a deleted rule is restored at its old position without running over existing rows". Browser: create, edit, delete with the confirmation, revert of the delete (`ui-3-rules.png`, `ui-5-rules-phone.png`).

## a6-text-rules-accounts-14 (low): a new manual account's balance is dated by the UTC day

Status: fixed.

What was wrong: `POST /accounts` dated the balance with `toIsoDate(new Date())`, the machine's UTC date, not the household's day on the injectable API clock.

What changed: the route uses `serverToday(app)` (household time zone, `app.now()`), as the other Phase 2 routes do (decision 63).

Tests: api "a6-text-rules-accounts-14: a new manual account's balance is dated by the household's day" (API clock 2027-03-02 03:00 UTC is 1 March in Denver).

## a6-text-rules-accounts-15 (low): CSV previews return headers, sample cells and the bank importer's date error unsanitized

Status: fixed.

What was wrong: the three previews returned the file's header and first rows as they were, right-to-left overrides and markup included, and the bank mapper quoted a bad date in full.

What changed: headers and sample cells go through `previewCells` (`sanitizeText`, 100 characters); mappings are resolved by the sanitized header name (`headerKey`), so a mapping built from the preview still finds the raw header; the bad date is quoted sanitized, at most 50 characters (decision 62).

Tests: api "a6-text-rules-accounts-15: CSV previews return sanitized headers, sample cells and date errors" (also the guessed mapping over a header with an override).

## a6-text-rules-accounts-16 (low): rule contracts accept rules that silently never match or match everything

Status: fixed.

What was wrong: a pattern that did not compile was saved and never matched; `amount: {}` matched every row; `min > max` was accepted; a day range could not span the month end, and day 31 missed shorter months.

What changed: `ruleInputProblem` refuses the pattern (400 `invalid_regex`) and an amount condition without a bound or with min above max (400 `invalid_amount_range`); a day range whose start is after its end wraps past the month end, and a day past the end of a month is its last day (decision 56). The stored contract stays loose so older rules still list.

Tests: shared "rules saved as written or refused (a6-text-rules-accounts-16)" (two cases). api "a6-text-rules-accounts-04/16: …".

## a6-text-rules-accounts-17 (low): accented letters are cut from payees, and rule matching does not normalize

Status: fixed.

What was wrong: the token trim used the ASCII-only `\w`, so "Café Rio" became "Caf Rio" next to "Cafe Rio", and "İSTANBUL" lost its first letter; rules compared with `toLowerCase` only, so NFC and NFD spellings differed and "istanbul" was not found in "İSTANBUL".

What changed: `sanitizeText` stores NFC; `normalizePayee` trims and title-cases by Unicode letter classes and folds Latin accents (`foldLatinAccents`), so "Café Rio" and "CAFE RIO #23" are one payee; case-insensitive matching compares NFKC with Latin accents folded, case-sensitive matching compares NFC (decision 59).

Tests: shared `payee.test.ts` "a6-text-rules-accounts-17: …" (8 cases), `rules.test.ts` "rule matching and Unicode (a6-text-rules-accounts-17)", `sanitize.test.ts` "sanitizeText and Unicode normalization (a6-text-rules-accounts-17)".

## a6-text-rules-accounts-18 (low): "Always do this" fails with a 400 for long payee names

Status: fixed.

What was wrong: the register names the rule `${payee} → ${category}` and the contract refused a name over 100 characters, while payee names may be 200.

What changed: the server cuts a rule name over 100 characters to 99 plus "…" instead of refusing the rule (contracts accept up to 1,000 characters), so every client gets the same behaviour (decision 67).

Tests: api "a6-text-rules-accounts-18: \"always do this\" on a long payee name writes the rule, with its name cut".

## a6-text-rules-accounts-19 (low): concurrent rule creation produces duplicate positions

Status: fixed.

What was wrong: `POST /rules` read `max(position)` without a lock, so concurrent creates took the same position and their order fell to the id.

What changed: creating, restoring and reordering rules take one transaction-scoped advisory lock before reading the order (decision 67).

Tests: api "a6-text-rules-accounts-19: rules created at the same time get positions 1..n" (six concurrent requests; before the fix 1, 1, 2, 2, 2, 3).

## a6-text-rules-accounts-20 (low): a blank account name is accepted

Status: fixed.

What was wrong: `min(1)` was checked before the trim, so "   " became an unnamed account.

What changed: both account contracts use `z.string().trim().min(1).max(100)`.

Tests: api "a6-text-rules-accounts-20: a blank account name is refused on create and on rename".

## a6-text-rules-accounts-21 (low): stray files: KICKOFF.md and the root src/ directory

Status: fixed.

What was wrong: `KICKOFF.md` (the original Phase 1 prompt) read as live instructions, and the root `src/` held early copies of the API tests that could not load (`otpauth` does not resolve there) but were still linted.

What changed: both were removed (git history keeps them; decision 68).

Tests: api `deployConfig.test.ts` "repository layout (audit a6-text-rules-accounts-21) > has no stray root sources or superseded kickoff instructions" (failed with the files present).

## Found while testing

At phone width every page with a wide table widened the whole page (the shell's grid column was `1fr`, whose minimum is the content's width), so the Accounts page was 1,163 pixels wide on a 390-pixel screen. The shell's content column is now `minmax(0, 1fr)` and the content has `min-width: 0`, so tables scroll inside their `.scroll` box; the Dashboard, Connections, Rules, Payees and Accounts pages measure 390 pixels at 390 (`a6ui/phone.cjs`).
