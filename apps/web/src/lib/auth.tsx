import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "@meridian/shared";
import { api, ApiError } from "./api.js";
import { isSignedOutError } from "./security.js";

export const AUTH_KEY = ["auth", "status"] as const;
/** A message for the sign-in screen about why the browser is back there (e.g. too many wrong codes). */
export const SIGN_IN_NOTICE_KEY = ["auth", "notice"] as const;

export function useAuthStatus() {
  return useQuery({ queryKey: AUTH_KEY, queryFn: () => api<AuthStatus>("/auth/status"), staleTime: 30_000, retry: false });
}

export function useAuthMutation<TBody>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api<AuthStatus>(path, { method: "POST", body }),
    onSuccess: (status) => {
      qc.removeQueries({ queryKey: SIGN_IN_NOTICE_KEY });
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

/**
 * This browser's session has just ended (sign-out, or its own session ended from the session
 * list): show the sign-in screen now and forget what was loaded for that member. The auth
 * query is written, not removed: App is observing it, and a removed query tells its observers
 * nothing, which would leave the signed-in shell on screen until a reload.
 */
export function showSignedOut(qc: QueryClient): void {
  qc.setQueryData(AUTH_KEY, SIGNED_OUT_STATUS);
  qc.removeQueries({ predicate: (query) => !(query.queryKey[0] === "auth" && (query.queryKey[1] === "status" || query.queryKey[1] === "notice")) });
  void qc.invalidateQueries({ queryKey: AUTH_KEY });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/auth/logout", { method: "POST", body: {} }),
    onSuccess: () => showSignedOut(qc),
  });
}
