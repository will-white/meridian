# Audit record: SimpleFIN client and response parsing (a4-sync-parse)

Scope: the SimpleFIN client, how a Bridge response is stored and read, the account upsert and transaction mapping, claims, stale jobs and the text the sync stores for display (Phases 1 to 3).

Decisions taken here are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 30 to 41. Unless a section says otherwise, the test files named below are `packages/shared/src/simplefin.test.ts` (shared), `packages/shared/src/sanitize.test.ts` (sanitize), `packages/db/src/services/sync.test.ts` (db sync), `packages/db/src/services/jobs.test.ts` (db jobs), `apps/worker/src/simplefin/client.test.ts` (client), `apps/worker/src/jobs/sync.test.ts` (worker sync), `apps/worker/src/env.test.ts` (worker env) and `apps/api/src/connections.test.ts` (api). Every new test was run against the code before the fix and failed.

## a4-sync-parse-01 (high): one amount or balance the strict cents parser refuses fails the whole sync

Status: fixed.

What was wrong: the feed's amounts and balances went through `parseDecimalToCents`, which accepts only `-?\d+(\.\d{1,2})?`. A protocol numeric string with a sign, an exponent or a third decimal ("+5.00", "1E+2", "-12.345", "1234.567") threw, so the job failed, every account after the odd one got nothing, transfer pairing did not run, and the high-water mark stayed put. The same item came back on every sync until it was 93 days old, and a balance never aged out.

What changed: `parseSimplefinAmount` (shared) reads an optional sign, digits with a fraction of any length and an optional exponent, rounds half away from zero to the cent and reports whether non-zero digits were dropped. It never throws and never builds a huge number, and anything over 15 digits of cents cannot be read. `applyAccountSet` skips only a transaction whose amount cannot be read (`amount.unreadable` for its account) and counts rounded amounts (`amount.rounded`). `upsertSimplefinAccount` keeps the last known balance when the feed's cannot be read, writes no balance row (`balance.unreadable`), and creates a new account without one. An account with a skipped transaction keeps its unmatched pending rows. These entries do not hold the mark (decision 30). The strict parser stays for what the household types.

Tests: shared "parseSimplefinAmount (a4-sync-parse-01)": "reads a sign, any number of decimals and an exponent" (hand-calculated: "+5.00" → 500, "12.345" → 1235, "1E+2" → 10000, "-0.5e1" → -500, "1234.567" → 123457) and "refuses what is not a number, and values no account holds (more than 15 digits of cents)". db sync "applyAccountSet on odd values from the feed (a4-sync-parse)": "a4-sync-parse-01: reads a sign, an exponent and extra decimals, and skips only a transaction whose amount it cannot read" and "a4-sync-parse-01: rounds a balance with digits below a cent, and keeps the last known balance when one cannot be read".

## a4-sync-parse-02 (high): a response that fails schema validation (or is not JSON) is not kept in import_log

Status: fixed.

What was wrong: `fetchAccounts` validated the body and threw before returning it, and a body that was not JSON was dropped, so `import_log.raw_payload` stayed null for exactly the responses that needed explaining. The spec (sync flow step 6) and the plan (pipeline step 2) say every raw response is kept, before any parsing.

What changed: `fetchAccounts` returns the parsed JSON without judging its shape. The sync job stores it (through `jsonbSafe`, see 05) and only then reads it with `readAccounts`. A 200 that is not JSON fails with the text attached to the error, and the job stores it as `{ "notJson": <text> }`. A body that is not an account set at all fails the sync with its payload kept (decision 31).

Tests: worker sync "sync of odd responses (a4-sync-parse)": "a4-sync-parse-02: a response that is not JSON, or not an account set, is kept in the import log". client "fetchAccounts keeps what it could not read (a4-sync-parse-02)": "a 200 that is not JSON fails with the body attached, for the import log" and "a body that is JSON but not an account set is returned as is; reading it is the job's step, after it is stored".

## a4-sync-parse-03 (medium): one account with an unexpected shape rejects the whole response

Status: fixed.

What was wrong: the whole account set was validated in one `safeParse`. Holdings that are an object keyed by symbol (which the imports design §3.3 says the parser accepts), holdings or `extra` that are null, null text, an amount sent as a JSON number, or an errlist entry with a null `msg` rejected the response, so no account was applied and every later sync failed the same way.

What changed: `readSimplefinAccountSet` (shared) reads each account and each transaction on its own. `holdings` and `extra` take any shape, optional text may be null, an amount may be a JSON number, an out-of-range optional timestamp reads as absent, and an errlist entry is never dropped (no code reads as `unknown`). An account that cannot be read is skipped with an `account.unreadable` entry and holds the mark, as `act.failed` does, unless the household closed it. A transaction that cannot be read is skipped and counted for its account (`transaction.unreadable`), and that account keeps its unmatched pending rows. Only a body that is not an account set fails. `simplefin.reprocess_holdings` reads stored payloads the same way (decision 32).

Tests: shared "readSimplefinAccountSet (a4-sync-parse-03)": "accepts the shapes the holdings parser and the protocol allow: holdings keyed by symbol, nulls for optional text, amounts as JSON numbers", "skips and reports one account or one transaction it cannot read, and keeps the rest" and "refuses a body that is not an account set at all". db sync "a4-sync-parse-03: an account the reader skipped holds the mark unless it is closed, and a partly read account keeps its pending rows". worker sync "a4-sync-parse-03: holdings keyed by symbol, null text and an account that cannot be read do not stop the other accounts". client "reads an account set entry by entry and refuses only a body that is not one".

## a4-sync-parse-04 (medium): the protocol's transacted_at is ignored

Status: fixed.

What was wrong: the schema read `transaction_date`, which the protocol does not have, so a posted item took its post date and a pending item took the sync's clock (moving forward each day it stayed pending). Spending made late in a month landed in the next month's plan. The fixture used the same wrong name.

What changed: the schema reads `transacted_at`. `simplefinTransactionDate` takes it first, then `posted`, then the household's day for a pending item with neither. The fixture and the tests use the protocol's name (decision 33).

Tests: shared "transacted_at (a4-sync-parse-04, a4-sync-parse-08)": "dates a transaction by when it happened, then when it posted, then the household's day" and "is the field the schema reads"; shared "simplefinTransactionDate": "prefers transacted_at, then posted, then the day it is given". db sync "a4-sync-parse-04, a4-sync-parse-08: dates by transacted_at, then posted, then the household's day" (a posted item with `posted` 2026-10-31 and `transacted_at` 2026-10-28 is stored on 2026-10-28).

## a4-sync-parse-05 (medium): a NUL character anywhere in a response makes the raw-payload insert fail

Status: fixed.

What was wrong: Postgres `jsonb` refuses `\u0000` (and unpaired surrogate escapes). One NUL in a description failed the raw-payload write, so the sync failed, nothing was kept, and the item kept failing every sync while it stayed in the window.

What changed: `jsonbSafe` (shared) copies the parsed body iteratively, so a deeply nested one cannot exhaust the stack, and turns every NUL and unpaired surrogate in a string or a key into U+FFFD. The sync stores that copy and reads the same copy, so an id with a NUL in it is the same id on every sync and never reaches a text column (decision 31).

Tests: shared "jsonbSafe (a4-sync-parse-05)": "replaces NUL and unpaired surrogates in every string and key, which Postgres jsonb refuses" and "copies deeply nested values without recursion". worker sync "a4-sync-parse-05: NUL characters in a description, a payee, an errlist message and an id leave the sync working and the payload kept".

## a4-sync-parse-06 (medium): a setup-token claim that fails three times for a transient reason leaves a connection that can never be claimed

Status: fixed.

What was wrong: after a transient claim failure the connection's status became `error` with the token kept. Once the queue's three attempts were spent, `POST /connections/:id/sync` re-queued a claim only while the status was `claiming`, so it answered 400 "paste a new setup token", and no route takes a new token on an existing connection.

What changed: the claim job deletes the token only when the Bridge spent it (403, or an access URL on another host that was not stored; see 15). After any other failure the connection says "The setup token could not be claimed yet: …. Press Sync now to try again.", or names `SIMPLEFIN_ALLOWED_HOSTS` for a host that is not listed. `POST /connections/:id/sync` queues the claim (status `claiming`) whenever a token is stored and there is no access URL, whatever the status. With neither a token nor an access URL, the 400 `no_access_url` tells the household to remove the connection and add it again with a new setup token (decision 37).

Tests: worker sync "claim after a transient failure (a4-sync-parse-06)": "keeps the token through three failed attempts, says to press Sync now, and claims it when queued again". api "connections: a setup token that could not be claimed yet": "Sync now queues the claim again while the token is stored and there is no access URL" and "says what the household can do when there is neither a token nor an access URL".

## a4-sync-parse-07 (medium): requeueStaleJobs puts a dead worker's job back without checking attempts or adding backoff

Status: fixed.

What was wrong: a job left `running` by a worker that died went straight back to the queue with no attempt limit and no wait, so a job that kills the worker (for example a response too large for its memory, see 13) ran again every half hour for ever. It ignored `max_attempts`, the single try a failing connection gets, and its import log row stayed `running`.

What changed: `requeueStaleJobs` counts the crash as a failed attempt. A job whose attempts are spent is failed with "The worker stopped before this job finished …"; any other goes back after the same backoff `failJob` gives (`retryDelayMs`). A SimpleFIN job's open import log rows are closed as errors, and a sync's connection records the attempt (status `error`, `last_attempt_at`), so the scheduler spaces the next one from it and gives it a single try. It returns `{ requeued, failed }` and the runner logs both (decision 38).

Tests: db jobs "job queue": "a4-sync-parse-07: a job a dead worker left behind is failed once its attempts are spent, else retried after the backoff", plus "requeues stale running jobs" (updated for the new return value).

## a4-sync-parse-08 (low): the sync clock's day is UTC, not the household's day

Status: fixed.

What was wrong: a pending item without a date was dated `now.toISOString().slice(0, 10)`, and the sync's window and mark used the UTC day. At 01:00 UTC on Nov 1 the household is still on Oct 31 (America/Denver), so the item landed in November. Phase 2 plan decision 16 says worker jobs compute today in the household time zone.

What changed: `readHouseholdToday` (db, reads the setting without creating it) gives the household's day. `runSyncJob` uses it for the window and the mark, and `applyAccountSet` uses it as the date of a pending item without one. The holdings' future-date check keeps the later of the household's and the UTC day, as before (decision 33).

Tests: worker sync "a4-sync-parse-08: the window and the mark are the household's day, not the UTC day" (at 2026-11-01T01:00Z: start-date 2026-07-30, mark 2026-10-31, hold dated 2026-10-31). db sync "a4-sync-parse-04, a4-sync-parse-08: dates by transacted_at, then posted, then the household's day".

## a4-sync-parse-09 (low): every full sync requests and ingests every account, including accounts the household closed

Status: fixed (ingest); the request filter was decided against and the reason recorded.

What was wrong: transactions the Bridge sent for an account the household closed were ingested into it.

What changed: `applyAccountSet` gives a closed account its balance and holdings but no transactions, and its pending rows are not touched. The request is not filtered with `account=`: a filtered request would hide an account added at the Bridge, which the new-account rule of decision 24 needs to find, and the Bridge limits requests, not the accounts in them. So the spec's "requests only accounts that need transactions" is met in what is ingested. The open accounts are the ones that need transactions. This is decision 34, and the plan flags it under "Deviations and open points".

Tests: db sync "a4-sync-parse-09, a4-sync-parse-10: ingests nothing into an account the household closed, and its problems hold nothing back".

## a4-sync-parse-10 (low): an act.* entry for an account the household closed holds the high-water mark for ever

Status: fixed.

What was wrong: `simplefinFeedHealth(...).incomplete` was true for any `act.*` entry, whichever account it named. A closed account the Bridge could not read held the mark at its old day, every sync asked for the full 93 days, and from day 87 the connection showed a false `sync.gap` notice.

What changed: `simplefinFeedHealth` takes `closedAccountIds` and leaves out account problems that name one of them. `applyAccountSet` passes the connection's closed accounts, and treats the reader's `account.unreadable` entries for closed accounts the same way (decision 34).

Tests: shared "simplefinFeedHealth with closed accounts (a4-sync-parse-10)": "a problem with an account the household closed does not make the response incomplete". db sync "a4-sync-parse-09, a4-sync-parse-10: ingests nothing into an account the household closed, and its problems hold nothing back".

## a4-sync-parse-11 (low): server text is echoed unsanitized and unbounded into lastError and import_log.message

Status: fixed.

What was wrong: the parser's error quoted the raw value, and the sync job and the runner stored `err.message` as it was. A 5,000-character amount with markup reached `connection.last_error` and `import_log.message` in full, and `job.last_error` at 2,000 characters.

What changed: the feed's amounts no longer go through a parser that throws (01). The entries name the field and the account, never the value. `errorMessageText` (shared: `sanitizeText`, at most 300 characters) is applied before `connection.last_error`, `import_log.message` and every job's `last_error` are written, in the sync job, the claim job and the runner (decision 35).

Tests: sanitize "errorMessageText (a4-sync-parse-11)": "sanitizes and bounds an error's message before it is stored for display". worker sync "a4-sync-parse-11: a long junk amount never reaches the error text, and stored error text is sanitized and bounded" (the junk amount gives a plain `amount.unreadable` entry, and a database error that quotes a 5,000-character value is stored sanitized and at most 300 characters).

## a4-sync-parse-12 (low): when the Bridge sends errlist and the same text in errors, each problem is shown twice

Status: fixed.

What was wrong: `errorsFromAccountSet` compared a plain string from `errors` only with the decorated errlist message ("The bank connection needs … (Please re-login)"), so the same text never matched and each problem showed twice.

What changed: a plain string is dropped when it equals an errlist entry's sanitized `msg` or decorated message, or a string already listed (decision 36).

Tests: db sync "a4-sync-parse-12: a plain error string that repeats an errlist entry is shown once".

## a4-sync-parse-13 (low): no limit on response size

Status: fixed.

What was wrong: `res.json()` and `res.text()` read the whole body, whatever its size. A 400 MB body under a 512 MB heap ended the worker, which left the job `running` (and, with 07, looping).

What changed: the client reads the body as a stream with a byte limit: `SIMPLEFIN_MAX_RESPONSE_MB` (default 50) for an account set, 64 KB for a claim answer, checked against the declared length and while reading. A larger body fails as `too_large`, which is not retried within the job; the schedule is not paused, so the next scheduled sync tries again. `SimplefinError.pausesSchedule` is now separate from `permanent` (decision 39). The setting is in `.env.example`, the README and the worker's config.

Tests: client "response size limit (a4-sync-parse-13)": "refuses an account set larger than the limit, by its declared length or while reading it" and "refuses a claim answer of more than a few kilobytes". worker env "SimpleFIN hosts and response size (a4-sync-parse-13, a4-sync-parse-15)": "reads at most 50 MB of a response unless SIMPLEFIN_MAX_RESPONSE_MB says otherwise". Recorded check against a real local HTTPS server and Node's fetch (scratch `verify-net.mts`, output `verify-net.out`): a 64 MiB body fails `too_large` in 293 ms at 170 MB RSS with the default limit and is read with the limit raised to 100 MB.

## a4-sync-parse-14 (low): a timeout while the body is being read is reported as "not JSON"

Status: fixed.

What was wrong: the timeout signal does cover the body, but the catch around `res.json()` replaced the `TimeoutError` with "SimpleFIN returned a response that is not JSON".

What changed: an error while the body is being read (timeout, dropped connection) is a `network` failure described by `describeFetchFailure`, for example "Could not reach the SimpleFIN server: timeout (no answer within 60 seconds)". "Not JSON" is kept for a body that arrived whole and does not parse (decision 39).

Tests: client "a timeout while the body is read (a4-sync-parse-14)": "is a network failure that says so, not 'not JSON'". Recorded check (scratch `verify-net.out`): against a server that sends headers and then one byte a second, with a 3 s timeout the request fails after 3,008 ms with "Could not reach the SimpleFIN server: timeout (no answer within 3 seconds)".

## a4-sync-parse-15 (low): claim and access URLs may point at any https host

Status: fixed.

What was wrong: any token that decoded to an https URL was claimed, including a LAN address, and the access URL a claim returned was stored whatever its host. A forged token could point the worker's POST, and every later sync, at any host. The spec limits outbound calls to the SimpleFIN host and the price provider.

What changed: the client checks the claim URL's host against `SIMPLEFIN_ALLOWED_HOSTS` before any request (default `bridge.simplefin.org, beta-bridge.simplefin.org`), requires the access URL to be on the claim's host, and checks the access URL's host again on every sync. A host that is not listed fails as `host_not_allowed` (no retry). The token is kept, so Sync now claims it once the host is listed and the worker restarted. An access URL on another host fails as `access_url_refused` and is not stored, and the token counts as spent. Private and loopback addresses are refused like any other host that is not listed. The setting is read and checked at boot: host names only (decision 40). The Bridge's host names come from the public protocol documentation and could not be checked from the build container.

Tests: client "which hosts the worker talks to (a4-sync-parse-15)": "defaults to the SimpleFIN Bridge's hosts", "refuses a setup token whose claim URL is on another host, before any request", "refuses an access URL on a different host than the claim, and does not keep it" and "refuses to sync from an access URL whose host is not allowed". worker env "allows the Bridge's hosts unless SIMPLEFIN_ALLOWED_HOSTS lists others, and refuses anything that is not a host name". Recorded check (scratch `verify-net.out`): a token for `https://192.168.1.1/admin/reboot` is refused with no request; a claim on the local server that answers with `https://user:pw@evil.example.invalid/simplefin` is refused without quoting the credentials; a redirect is still refused.

## a4-sync-parse-16 (low): sanitizeText keeps bidirectional overrides and zero-width characters

Status: fixed.

What was wrong: `sanitizeText` stripped only C0 and C1 controls, so a right-to-left override (U+202E) in a payee could show "00.005$" as "$500.00", and zero-width characters passed through.

What changed: `sanitizeText` also removes U+061C, U+200B, U+200E, U+200F, U+202A to U+202E, U+2060 to U+2069 and U+FEFF. The zero-width joiner and non-joiner (U+200C, U+200D) stay, because emoji sequences and some scripts need them and they reorder nothing (decision 41).

Tests: sanitize "sanitizeText and invisible formatting (a4-sync-parse-16)": "strips bidirectional overrides, embeddings, isolates and zero-width characters" and "keeps the joiners that emoji and some scripts need".
