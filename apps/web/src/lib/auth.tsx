import { useMutation, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "@meridian/shared";
import { api, ApiError, shouldRetry } from "./api.js";
import { isSignedOutError } from "./security.js";

export const AUTH_KEY = ["auth", "status"] as const;
/** A message for the sign-in screen about why the browser is back there (e.g. too many wrong codes). */
export const SIGN_IN_NOTICE_KEY = ["auth", "notice"] as const;

/**
 * The auth status query. A failed refetch keeps the last status (TanStack Query keeps data on
 * error), so App keeps the signed-in shell on screen; a network error or a 5xx is retried like
 * any query, so one dropped request or a proxy restart does not leave the status in error
 * (audit b8-web-layout-01).
 */
export function authStatusQuery() {
  return { queryKey: AUTH_KEY, queryFn: () => api<AuthStatus>("/auth/status"), staleTime: 30_000, retry: shouldRetry };
}

export function useAuthStatus() {
  return useQuery(authStatusQuery());
}

export function useAuthMutation<TBody>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api<AuthStatus>(path, { method: "POST", body }),
    onSuccess: (status) => {
      qc.removeQueries({ queryKey: SIGN_IN_NOTICE_KEY });
      // Written, so watchMember (queryClient.ts) forgets another member's data before anything renders.
      qc.setQueryData(AUTH_KEY, status);
      void qc.invalidateQueries();
    },
    onError: (error) => noteSignedOut(qc, error),
  });
}

/**
 * A sign-in step failed because the password session is gone (it expired after ten minutes,
 * or ended at the fifth wrong code): leave the explanation for the sign-in screen, which
 * main.tsx brings back by refreshing the auth status.
 */
export function noteSignedOut(qc: QueryClient, error: unknown): void {
  if (!isSignedOutError(error)) return;
  qc.setQueryData(SIGN_IN_NOTICE_KEY, error instanceof ApiError && error.code === "sign_in_again" ? error.message : "That sign-in took too long. Enter your password again.");
}

/** Why the browser is back on the sign-in screen, when the server said so. */
export function useSignInNotice(): string | null {
  return useQuery({ queryKey: SIGN_IN_NOTICE_KEY, queryFn: () => null as string | null, enabled: false, staleTime: Infinity }).data ?? null;
}

export const SIGNED_OUT_STATUS: AuthStatus = { setupRequired: false, authenticated: false, totpRequired: false, totpEnrolled: false };

/** The auth status and the sign-in notice: the only queries that belong to the browser, not to a member. */
export function isSignInQuery(query: Query): boolean {
  return query.queryKey[0] === "auth" && (query.queryKey[1] === "status" || query.queryKey[1] === "notice");
}

/** Whose data the cache holds: the signed-in member, or null when no one is (fully) signed in. */
export function memberOf(status: AuthStatus | undefined): string | null {
  if (!status?.authenticated || status.totpRequired) return null;
  return `${status.role ?? ""}\u0000${status.username ?? ""}`;
}

/**
 * Drop everything loaded for a member. Queries no page is showing are removed. When another member
 * is now signed in, the queries a page is showing are reset (their observers see no data, then the
 * new member's), because a removed query tells its observers nothing; when no one is, they are
 * removed too, since App replaces the shell with the sign-in screen on this same status change.
 */
export function forgetMemberData(qc: QueryClient, nextMember: string | null): void {
  const memberQuery = (query: Query) => !isSignInQuery(query);
  if (nextMember === null) {
    qc.removeQueries({ predicate: memberQuery });
    return;
  }
  qc.removeQueries({ predicate: (query) => memberQuery(query) && !query.isActive() });
  void qc.resetQueries({ predicate: memberQuery });
}

/**
 * Keep each member's data to themselves (audit b8-web-layout-02): whenever the auth status names
 * someone else than before (a session that ended, by sign-out, by its lifetime or idle limit or
 * from another device, then a sign-in as another member, or a sign-in in another tab of the same
 * browser), forget what was loaded for the previous one before the new status is rendered.
 * A refetch that fails keeps the last status and changes nothing. Returns the unsubscribe.
 */
export function watchMember(qc: QueryClient): () => void {
  let member = memberOf(qc.getQueryData<AuthStatus>(AUTH_KEY));
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (!isSignInQuery(event.query) || event.query.queryKey[1] !== "status") return;
    const next = memberOf(event.query.state.data as AuthStatus | undefined);
    if (next === member) return;
    member = next;
    forgetMemberData(qc, next);
  });
}

/**
 * This browser's session has just ended (sign-out, or its own session ended from the session
 * list): show the sign-in screen now and forget what was loaded for that member. The auth
 * query is written, not removed: App is observing it, and a removed query tells its observers
 * nothing, which would leave the signed-in shell on screen until a reload.
 */
export function showSignedOut(qc: QueryClient): void {
  qc.setQueryData(AUTH_KEY, SIGNED_OUT_STATUS);
  qc.removeQueries({ predicate: (query) => !isSignInQuery(query) });
  void qc.invalidateQueries({ queryKey: AUTH_KEY });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/auth/logout", { method: "POST", body: {} }),
    onSuccess: () => showSignedOut(qc),
  });
}
