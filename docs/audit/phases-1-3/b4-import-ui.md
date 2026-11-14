# Audit record: Import pages (b4-import-ui)

Scope: the Import page's three flows (bank transactions, brokerage positions, trade history): `apps/web/src/pages/ImportPage.tsx`, `apps/web/src/components/import/` (the preview query and hook, the positions and trades flows and their mapping editors), `apps/web/src/lib/importMapping.ts`, and the preview routes in `apps/api/src/routes/import.ts`.

## First round (commit 330bcf4)

The first round's findings text is not kept; this section is taken from the commit message of 330bcf4 ("Audit fixes: import pages"). Its decisions are `docs/phase-3-plan.md`, "Decisions made during the audit", A9 and A10, and `docs/phase-1-plan.md` decision 29 (numbered 24 when it was written) with the test matrix's "Import page" row; the imports design (`docs/design/phase-3/imports-and-data.md`) was updated in its preview contract, route table and UI section.

- **web-02: the bank CSV preview is a query keyed by its request** (one per change of the file, account, saved profile or mapping) instead of a mutation re-run by an effect that depended on the mapping object, which every response replaced. The server's guess or the profile's mapping is taken once, without a second request, and never over a mapping the owner edited. The bank, positions and trades flows share one hook (`useCsvPreview`) and pure request builders; a chosen file gets a key that is unique while the app is open; a commit invalidates the previews, and the bank result line keeps the duplicate count taken at the commit.
- **web-03: a positions file that gives no date is previewed, not refused.** `POST /api/import/positions/preview` answers it with 200, its mapping and `asOfRequired` instead of 400 `as_of_required` (also when a date column has no readable date in any row, with the rows listed), so the page shows the mapping editor with the statement date field and previews once the date is entered; the commit still refuses a file without a date. On all three flows a change the server refuses leaves the last preview and the editor on screen with the commit disabled, where before the cards holding the control went away.

## Second round

An independent reviewer left no first-round item open and raised two new issues, one medium and one low. Both were checked against the plan and the code and are real; both are fixed. Decision: `docs/phase-1-plan.md` decision 121 (new), with the CSV import section and the test matrix's "Import page" row; `docs/phase-3-plan.md` A10 gained a sentence marked "second round of the audit"; the imports design's UI section points to decision 121.

The outputs are in the lane's scratch directory (`laneA/`):

- `b4r2-red-web.txt`: the new and changed web tests against the code before the fix. 19 of 58 fail: the 9 new bank editor tests and the 2 kept-state tests on the missing helpers, and the 8 flow tests of `previewQuery.test.ts`, whose `Page` now keeps its answer through `nextKept`. The 4 tests of `useCsvPreview.test.ts` pass there, since they cover behaviour the hook already had.
- `b4r2-green-web.txt`: the web suite after the fix.
- `b4r2-mutations.txt`: the hook tests against five deliberate breakages of the hook.
- `b4r2-ui-head.txt` and `b4r2-ui-fix.txt`: the browser runs before and after the fix, with screenshots `b4r2-head-*.png` and `b4r2-fix-*.png`.
- `b4r2-ui2-fix.txt`: the second browser run after the fix.

### Second round, new issue 1 (medium): a bank CSV without a header row cannot be mapped on the Import page

Status: fixed.

What was wrong: the Phase 1 plan says the bank mapper supports header or index columns, and the mapper does (`mapCsvRows` reads a numeric column with or without a header row). But the bank `MappingEditor` in `ImportPage.tsx` could only produce column names:

- `guessCsvMapping` matches header names, so its guess always reads a header row.
- "Build a mapping by hand" took the names from the first row.
- Every select set `column: e.target.value`, a string. The positions and trades editors go through `columnRef(value, mapping.hasHeader)` instead.
- The option values followed the response's mapping, which never has `hasHeader: false` on a successful answer.

Reproduced at HEAD in headless Chromium (`b4r2-ui-head.txt`) with the reviewer's file `11/07/2026,OAKWOOD APTS RENT,-1800.00` / `11/08/2026,ACME PAYROLL,2500.00` / `11/09/2026,KING SOOPERS,-82.13`:

1. The guess failed.
2. "Build a mapping by hand" sent `{hasHeader: true, date: {column: "11/07/2026"}, …}` and showed "2 rows … Import 2 new transactions", so the rent was lost.
3. Unchecking "first row is a header" sent the same names with `hasHeader: false`, and the server answered 400 "Column "11/07/2026" referenced by name, but the file has no header row".
4. The date options were still `["11/07/2026", "OAKWOOD APTS RENT", "-1800.00"]` as names, and re-picking a column changed nothing. The commit stayed disabled, and no edit could import all three rows.

The defect predates 330bcf4, which left the editor unchanged.

What changed (helpers in `apps/web/src/lib/importMapping.ts`; the editor in `ImportPage.tsx` uses them):

- **Columns, by name or by position.**
  - The editor's options come from the page's own mapping: by header name while it reads a header row, by position otherwise (`bankColumnOptions`). Each position is labelled with the first row's cell, "Column 1 (11/07/2026)", cut to 30 characters.
  - The first row is read from the sample rows (`bankFirstRow`), because a header-less preview names its headers "Column 1", "Column 2"….
  - Every select goes through `setBankColumn`, that is `columnRef(value, hasHeader)`. The memo and id selects clear their column with "".
  - The amount-layout switch takes the last column or the last two by name or by position (`setBankAmountMode`).
- **The header box carries every column over (`setBankHasHeader`).**
  - A name becomes the position of the first-row cell it finds, matched with `headerKey` as the server matches it (sanitized, any case).
  - A position becomes its cell's name, unless that cell is empty or another column has the name first (a name finds the first column that has it). In that case it stays a position, which the mapper reads with a header row too.
  - A name the row does not have stays, so the preview says which column it cannot find.
  - So the box alone yields a valid mapping, in both directions.
- **"Build a mapping by hand" (`handBuiltBankMapping`).**
  - When the guess failed and the first row is data, it maps by position with no header row. The row is data when one cell reads as a date in some format and another as an amount (`firstRowLooksLikeData`); header names have neither.
  - The date is the first column that holds one. The amount is the first column that looks like one: cents, a sign, a currency symbol or parentheses, so a numeric id is not taken. The description is the first other column with letters.
  - The date format is the first of `CsvDateFormat` that reads that column in every sample row, so 13/11/2026 gives DD/MM/YYYY.
  - Wells Fargo's header-less export (date, amount, "*", check number, description) maps to columns 0, 1 and 4.
  - A header row the guess did not recognise still gives names (first, second, last), now with a date format read from the rows under it.
- The server is unchanged. A guess of a header-less mapping on the server was the other choice. It would change what a failed guess answers for every caller, and the owner reaches this mapping in one click under the "Could not guess" message.

Tests:

- web `src/lib/importMapping.test.ts`, "the bank mapping editor, with and without a header row" (9 tests):
  - `bankFirstRow` reads the sample rows of a header-less preview.
  - The options are names, or positions labelled `Column 1 (11/07/2026)` … `Column 4` for an empty cell, with the label cut.
  - `setBankColumn` stores positions (0, 1, 2) without a header row and names with one, including a header literally named "2". A column of the other amount layout leaves the mapping as it is (the same object).
  - `setBankAmountMode`: split gives 1 and 2 by position, or "Debit" and "Credit" by name.
  - `setBankHasHeader`:
    - The reviewer's by-name mapping turns into `{hasHeader: false, date: 0, description: 1, amount: 2}` and back.
    - A full mapping, with memo, id, split columns, `skipRows` and a lower-case "posted", gives positions 1, 2, 3, 0, 4 and 5, and comes back with "Posted".
    - A name the row lacks, an empty header, a repeated header ("Amount" twice: the second stays 2) and a position past the row are kept.
  - `firstRowLooksLikeData` is true for the reviewer's row, Wells Fargo's and an ISO row with "(4.50)", and false for header rows, a date alone and an amount alone.
  - `handBuiltBankMapping`:
    - The reviewer's file maps to positions 0, 1 and 2 with MM/DD/YYYY.
    - Wells Fargo's row maps to 0, 4 and 1.
    - 07/11 and 13/11 give DD/MM/YYYY, and an ISO date gives YYYY-MM-DD.
    - `10442,2026-11-07,RENT,-1800.00` maps the date to 1, the description to 2 and the amount to 3, not the id.
    - The header case gives names with YYYY-MM-DD read from the data row, MM/DD/YYYY without rows, and positions 0, 1 and 2 for an empty file, as before.
- web `src/components/import/previewQuery.test.ts`, "the bank preview flow for a file without a header row". The preview route is stubbed with the shared mapper the API runs (`parseCsv`, `guessCsvMapping`, `mapCsvRows`, `previewCells`, `CsvMapping`):
  - "finds no guess, and the mapping built by hand reads every row by position": one request, no guess, the first row read back. The built mapping previews 3 rows (−180000, 250000 and −8213 cents) under the headers "Column 1" to "Column 3". Picks made from the options are positions, and they preview (memo "KING SOOPERS" on row 3).
  - "turns a mapping by name into one by position when 'first row is a header' is unchecked, and back when it is checked":
    - The old hand-built names preview 2 rows.
    - The old box answers 400 "Column "11/07/2026" referenced by name…" with the 2-row preview kept on screen.
    - `setBankHasHeader` gives 3 rows, current and without an error.
    - Checking the box again gives the names back, answered from the cache (4 requests in all).
- Manual, headless Chromium on the built app (port 3481, databases `meridian_fix_a_b4r2_*`):
  - `b4r2-ui-fix.txt`, the reviewer's file:
    - The guess fails.
    - "Build a mapping by hand" gives `{hasHeader: false, date: 0, description: 1, amount: 2}`, "3 rows · 0 already imported", "Import 3 new transactions", and options "Column 1 (11/07/2026)" and so on.
    - Checking the box gives names and 2 rows; unchecking it gives positions and 3 rows again.
    - Re-picking the date and setting the memo with the selects sends positions.
    - The commit imports 3 rows, and the ledger holds all three. The preview then reads "3 rows · 3 already imported".
    - No page errors.
  - `b4r2-ui2-fix.txt`:
    - A header file (Date, Description, Withdrawal, Deposit) still guesses by name. The layout switch gives "Deposit" as the single column and Withdrawal and Deposit as the split. The header box off gives positions (the debit column at 2, the options "Column 1 (Date)" to "Column 4 (Deposit)"), with the header row read as an unreadable data row; on again gives the names back.
    - Wells Fargo's header-less layout, built by hand, maps to 0, 4 and 1. It was imported with "save this mapping for Wells Fargo", and the stored profile is `{hasHeader: false, date: 0, description: 4, amount: 1}`. Chosen with a longer file, the profile shows "3 rows · 2 already imported", the box unchecked and the options by position.

### Second round, new issue 2 (low): `useCsvPreview`, the hook the three import flows depend on, has no test of its own

Status: fixed.

What was wrong: nothing imported or ran `apps/web/src/components/import/useCsvPreview.ts`. The flow tests drove a `Page` class that re-implemented the hook's loop: it called `adoptPreviewMapping` itself, and the tests passed `kept` to `previewView` by hand. So the hook's own behaviour could regress with every test still passing. That is the kept-per-file state (the last answer stays on screen after a refusal, never another file's) and the effect and its dependency list (the guess adopted once, without a second request). The web package has no DOM test environment.

What changed:

- The kept state is now two pure functions in `previewQuery.ts`, which the hook uses.
  - `nextKept(prev, fileKey, settled)` returns the settled answer when there is one, else what was kept. It returns the same object while nothing changed, so the state update renders nothing more.
  - `keptFor(kept, fileKey)` returns the chosen file's answer only.
- The flow tests' `Page` keeps its answer through the same functions and shows `previewView(result, keptFor(kept, fileKey))` (`page.view()`). The refusal test checks that against the hand-passed view.
- A new test file, `useCsvPreview.test.ts`, runs the hook itself.
  - React's two hooks that the module imports are replaced, through `vi.mock`, by a minimal hooks runtime that keeps React's documented rules:
    - State and effects are found by call order.
    - An update to a value `Object.is` the current one changes nothing.
    - After each render, the effects whose dependencies changed (compared one by one with `Object.is`) run, and a state update renders again.
  - `useQuery` is a real `QueryObserver` on a real `QueryClient` (a change of its result renders again), and `fetch` is stubbed.
  - What runs is the module's own code: the query options, the effect with its dependency list, the kept state and the view.
  - A light renderHook with jsdom or happy-dom was the reviewer's other suggestion. It would add a test-only dependency to the web package and the lockfile for one file.

Tests:

- web `src/components/import/previewQuery.test.ts`, "the response kept on screen":
  - `nextKept` gives null without an answer, the same object for the same answer and after a refusal, and a new object for a new answer.
  - `keptFor` returns nothing for another file. A refused first preview of a second file shows nothing of the first; the same refusal on the first file shows its last answer.
- web `src/components/import/useCsvPreview.test.ts` (4 tests):
  - "previews a chosen file once and takes the server's guess without a second request": one request (`{csvText}`) and `onMapping` called once with the guess. The view is current. Three more renders make no request and no further adoption, and render nothing extra.
  - "asks once per change, and a response's mapping never replaces the owner's":
    - The account and an edited mapping are one request each, and the owner's mapping object is kept.
    - A saved profile, chosen with the mapping cleared, is one request, its mapping taken once (`onMapping` twice in all), and no request after.
  - "keeps the file's last answer on screen when the server refuses a change": the refused body shows the same response object (not current, the error's message). Undoing is current again with no request.
  - "never shows another file's answer":
    - A second file starts from `reading` with nothing shown, while its request is held.
    - Its refusal still shows nothing of the first file, and nothing is adopted.
- Mutations (`b4r2-mutations.txt`), each applied to the hook alone and reverted:
  - Leaving `settled` out of the effect's dependencies fails all 4 tests.
  - Removing the kept state fails the refusal test.
  - A `keptFor` that ignores the file fails the other-file test.
  - Not storing the adopted mapping fails 3 tests.
  - A `nextKept` that returns a new object every time passes the hook tests: it only costs a render, since the effect does not run again. The kept-state unit test catches it (`toBe(kept)`).

Checks: `pnpm typecheck` and `pnpm lint` pass. The web suite passes: 46 files and 554 tests, 537 before the round. Only the web app changed (no package, API or worker code), so no other suite was affected. `pnpm build` passes. The browser checks are above.
