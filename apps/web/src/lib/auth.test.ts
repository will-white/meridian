import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AuthStatus } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { AUTH_KEY, noteSignedOut, showSignedOut, SIGN_IN_NOTICE_KEY, SIGNED_OUT_STATUS } from "./auth.js";

const SIGNED_IN: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" };

describe("showSignedOut", () => {
  it("tells whoever observes the auth status at once, and drops everything else that was cached", async () => {
    const qc = new QueryClient();
    let server: AuthStatus = SIGNED_IN;
    // App's subscription to the auth status.
    const observer = new QueryObserver<AuthStatus>(qc, { queryKey: AUTH_KEY, queryFn: async () => server, staleTime: 30_000 });
    const seen: (boolean | undefined)[] = [];
    const unsubscribe = observer.subscribe((result) => seen.push(result.data?.authenticated));
    await qc.fetchQuery({ queryKey: AUTH_KEY, queryFn: async () => server });
    qc.setQueryData(["accounts"], [{ id: "a", name: "Checking" }]);
    qc.setQueryData(["auth", "sessions"], []);
    expect(observer.getCurrentResult().data).toEqual(SIGNED_IN);

    server = SIGNED_OUT_STATUS; // the session is gone on the server
    showSignedOut(qc);
    // Synchronously: the observer has the signed-out status (no reload, no refetch needed).
    expect(observer.getCurrentResult().data).toEqual(SIGNED_OUT_STATUS);
    expect(seen.at(-1)).toBe(false);
    // The previous member's data is gone, their session list included; only the status stays.
    expect(qc.getQueryData(["accounts"])).toBeUndefined();
    expect(qc.getQueryData(["auth", "sessions"])).toBeUndefined();
    expect(qc.getQueryData(AUTH_KEY)).toEqual(SIGNED_OUT_STATUS);

    // The follow-up refetch asks the server; whatever it says is what the app shows next.
    await qc.refetchQueries({ queryKey: AUTH_KEY });
    expect(observer.getCurrentResult().data).toEqual(SIGNED_OUT_STATUS);
    unsubscribe();
    qc.clear();
  });
});

describe("noteSignedOut", () => {
  it("leaves the server's explanation for the sign-in screen when a sign-in step failed because the session is gone", () => {
    const qc = new QueryClient();
    noteSignedOut(qc, new ApiError(401, "That code is not valid", "bad_totp"));
    expect(qc.getQueryData(SIGN_IN_NOTICE_KEY)).toBeUndefined();
    noteSignedOut(qc, new ApiError(401, "Too many wrong codes. Sign in again with your password.", "sign_in_again"));
    expect(qc.getQueryData(SIGN_IN_NOTICE_KEY)).toBe("Too many wrong codes. Sign in again with your password.");
    noteSignedOut(qc, new ApiError(401, "Sign in required", "unauthorized"));
    expect(qc.getQueryData(SIGN_IN_NOTICE_KEY)).toBe("That sign-in took too long. Enter your password again.");
    qc.clear();
  });
});
