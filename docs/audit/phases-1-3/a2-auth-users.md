# Audit record: Authentication and users (a2-auth-users)

Scope: signing in (password, authenticator code, passkeys), sessions and their ends, first-run setup, household members and their management, the sign-in activity and the recovery command line, for Phases 1 to 3.

## First round (commit 2743204)

The first round's findings text is not kept; this section is taken from the commit message of 2743204 ("Audit fixes: authentication and users"). Its decisions are `docs/phase-1-plan.md`, "Decisions made during the audit", 13 to 23.

- **sec-06: a wrong code costs the password session, and attempts are on record.** A password-only session lasts ten minutes, counts its wrong authenticator codes in the database and is deleted at the fifth (401 `sign_in_again`). Failed passwords and codes on real accounts are kept as sign-in activity for 90 days and shown under Settings with a 7-day count.
- **p1-21, sec-07, web-17: a code is accepted once.** The last accepted 30-second step is stored per user (`totp_last_step`) and a code is taken only when its step is later, in the transaction that creates the signed-in session; the enrollment code counts as used.
- **sec-11: first-run setup creates one owner.** Setup takes an advisory lock and re-checks that no user exists, so concurrent setups create one owner (the rest get 403 `already_setup`).
- **sec-12: sessions.** A new session id is issued when the second factor is accepted; the table stores the SHA-256 of the id (migration 0004 hashes existing ids and drops password-only sessions); `SESSION_IDLE_DAYS` (14) beside the 30-day lifetime; expired rows are deleted hourly by the worker and at sign-in; sessions can be listed and ended, one by one or all others; a password change ends the other sessions.
- **p1-15, sec-09, web-18: household members.** Owner-only `/api/users` (add a viewer, set their password, clear their second factor, remove them); own password change, authenticator replacement, session list and sign-in activity under `/api/auth`; a Settings section for all of it; member changes in the audit log; a recovery command line (`apps/api/dist/admin.js`) for a locked-out owner.
- Sign-out and an expired session bring the sign-in screen back at once (the auth status is written, not removed, and a 401 refreshes it).

## Second round

An independent reviewer found no first-round item undone and raised four new issues, all low. Each was reproduced and is real; each is fixed. No new decision number: decisions 13, 17, 19 and 21 of `docs/phase-1-plan.md` were amended, the data model list there names `user.last_sign_in_at` (migration 0011), and the test matrix row "Sign-in hardening" lists the new cases. The README's sign-in activity sentence mentions the new kind of failed attempt.

Every new test was run against the code before its fix and failed; the outputs are in the lane's scratch directory (`laneB/`): `a2r2-red-db.txt` (the three db tests and the migration test), `a2r2-red-api.txt`, `a2r2-red-worker.txt` and `a2r2-red-web.txt`.

### Second round, new issue N1 (low): usernames that differ only by case can both be created when two viewers are added at once

Status: fixed.

What was wrong: decision 19 says usernames are unique whatever their case. `createViewer` looked for `lower(username)` with a plain SELECT in a READ COMMITTED transaction and took no lock, and the only constraint is the exact `UNIQUE` on `user.username`. Two requests for "PatN" and "patN" sent together both passed the check and both inserted: before the fix the new test's first pair already created both.

What changed: adding a viewer takes the same transaction-scoped advisory lock as first-run setup (renamed `MEMBER_LOCK`, same key) before the case-blind check, so of two such requests the second waits for the first to commit and then finds its row (409 `username_taken`). `createOwner` and `createViewer` are the only code that inserts a member and nothing renames one, so the lock covers every way in. The mapping of a unique violation (23505) to 409 stays as the net for exact duplicates. A unique index on `lower(username)` was the other choice; its migration would stop the app from starting wherever two such names are already stored, with no way to remove one while the API is down, so the rule is held by the lock instead.

Tests: db `src/services/sessions.test.ts` "creates one of two viewers whose names differ only by case when both are added at once (audit a2-auth-users N1)": ten pairs, each sent with `Promise.allSettled`; exactly one of each pair is created and the other is refused with 409 `username_taken`; ten names remain, all different in lower case.

### Second round, new issue N2 (low): a wrong current password typed on a signed-in session is not kept as sign-in activity

Status: fixed.

What was wrong: `requirePassword` (`apps/api/src/routes/auth.ts`) threw 403 `wrong_password` without recording anything. It guards `POST /api/auth/password`, `/api/auth/totp/replace` and `/api/auth/passkeys/options`, the barrier between a stolen session and lasting access (a new password, a new authenticator, a planted passkey). Decision 13 keeps failed passwords on real accounts on record; before the fix, three wrong current passwords left `failedLast7Days` and the activity list unchanged.

What changed: a wrong current password is recorded as a new kind, `reauth_failed` ("Wrong current password while signed in" under Settings > Sign-in activity), for the session's member, with the address and browser of the request, then answered 403 `wrong_password` as before. It counts as a failed attempt: it is in `FAILED_SIGN_IN_KINDS`, and `countFailedSignIns` now filters on that list instead of repeating the kinds in SQL, so the 7-day warning includes it. A kind of its own rather than `password_failed`, because it says something different to the owner: whoever typed it already holds a signed-in session, so the answer is to end sessions as well as to change the password. The kind was added to the shared enum (`SignInEventKind`), the schema's `SIGN_IN_EVENT_KINDS` (a text column with no database check, so no migration) and the web labels; the right password records nothing, as before.

Tests: api `src/users.test.ts` "keeps a wrong current password typed on a signed-in session as a failed attempt, on every route that asks for it (audit a2-auth-users N2)": each of the three routes answers 403 `wrong_password`, the activity gains three `reauth_failed` rows for the owner with the browser's User-Agent, `failedLast7Days` rises by 3, and the right password adds nothing. db `src/services/sessions.test.ts` "counts a wrong current password on a signed-in session as a failed attempt (audit a2-auth-users N2)". web `src/lib/security.test.ts` "labels each kind and marks everything but a completed sign-in as a failure" (the new label, counted as a failure). The existing test that the schema's kinds mirror the shared enum still holds.

### Second round, new issue N3 (low): a member's "Last sign-in" becomes "never" once their sign-in events pass the 90-day retention

Status: fixed.

What was wrong: `listUsers` derived `lastSignInAt` from the newest `signed_in` or `passkey_signed_in` row of `sign_in_event`, and the worker deletes those rows after 90 days. The contract (`UserView.lastSignInAt`, "null when they never signed in"), the Members table ("never") and `admin.js users` ("never signed in") then said that a member who had signed in never had.

What changed: the last sign-in is kept on the member's row, `user.last_sign_in_at` (migration 0011). `recordSignInEvent` writes a completed sign-in (`signed_in`, `passkey_signed_in`; `SIGNED_IN_KINDS`) and sets the column to that event's own instant in one transaction, so the Members table and the activity show the same time; a failed attempt does not move it. `listUsers` reads the column, which serves the API, the Settings page and the recovery command alike. The migration fills the column from the activity there is, sign-ins only; the activity exists since migration 0004 (2026-11-10), so none of it has passed the retention yet and the fill is complete. The contract comment says the value outlives the activity.

Tests: db `src/services/sessions.test.ts` "keeps a member's last sign-in after the activity that recorded it passes the 90-day retention (audit a2-auth-users N3)": null before any sign-in; the sign-in's instant after a password sign-in; unchanged by a wrong password and a wrong code; the passkey sign-in's instant after one; still that instant, through `getUser` and `listUsers`, once every event is 91 days old and purged. db `src/test/lastSignInMigration.test.ts` "gives each member the time of their latest sign-in, password or passkey, and nothing to one who never signed in": the migrations up to 0010, members and events written, then 0011 (microseconds kept; a later wrong password and a code lockout ignored; a member with only a wrong password and one with nothing stay null).

### Second round, new issue N4 (low): a failing sign-in purge stops sync, daily and price scheduling on every tick

Status: fixed.

What was wrong: `startScheduler` ran the hourly sign-in purge first, inside the same try block as `scheduleDueSyncs`, `scheduleDailyJobs` and `schedulePriceJobs`. `atMostEvery` counts only a run that succeeds, so a purge that kept failing (a permission, a lock) was retried on every tick, and every tick stopped before anything was queued. Before the first round nothing ran ahead of the sync scheduling. The new test, before the fix, queued nothing in 3 seconds of 5 ms ticks.

What changed: the tick queues the due syncs, the daily jobs and the price jobs first, then runs the purge in a try block of its own; a failure is logged as `[scheduler] sign-in purge failed: <message>` and the purge is tried again on the next tick, as before, without holding anything up. The function `startScheduler` returns now resolves once a tick in progress has finished, and the worker's shutdown waits for it before it closes the database client.

Tests: worker `src/scheduler.test.ts` "startScheduler when the sign-in purge fails" / "logs the failure and still queues the due sync and the daily jobs, every tick": a database whose deletes are refused, a due connection, a 5 ms tick after the daily hour; the sync and the three daily jobs are queued once each, the purge failure is logged on more than one tick, and no other error is logged.

### Checks

`pnpm typecheck`, `pnpm lint` and `pnpm build` pass. Suites (with `TEST_DATABASE_URL`, prefix `meridian_fix_b_`): shared 52 files and 1013 tests, db 52 and 394, worker 14 and 112, api 42 and 337, web 44 and 531, all passing. Browser check on the built app (`apps/api/dist/server.js` serving `apps/web/dist` on 127.0.0.1:3491, headless Chromium, `laneB/ui-check.js`): the owner created and enrolled through the pages, a wrong current password typed under Settings > Password showed "That is not your current password", and after a reload Sign-in activity showed "Wrong current password while signed in" in the failure colour under the warning "1 failed sign-in attempt in the last 7 days" (`settings-activity.png`); with every sign-in event moved back 91 days and deleted as the worker's purge would, the Members table still showed the owner's last sign-in (`settings-members.png`). The only console line was that 403.
