import type { SignInEventKind } from "@meridian/shared";
import { ApiError } from "./api.js";

/** The server's minimum (shared `Password`); checked here too so the form answers before a round trip. */
export const MIN_PASSWORD_LENGTH = 12;

/** What is wrong with a change-password form, or null when it can be sent. */
export function passwordChangeProblem(form: { current: string; next: string; confirm: string }): string | null {
  if (form.current === "") return "Enter your current password";
  if (form.next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password`;
  if (form.next === form.current) return "The new password is the same as the current one";
  if (form.confirm !== form.next) return "The two new passwords do not match";
  return null;
}

/** What is wrong with a new password typed twice (adding a viewer, setting a viewer's password), or null. */
export function newPasswordProblem(form: { password: string; confirm: string }): string | null {
  if (form.password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (form.confirm !== form.password) return "The two passwords do not match";
  return null;
}

/** What is wrong with an add-a-viewer form, or null. */
export function newMemberProblem(form: { username: string; password: string; confirm: string }): string | null {
  const name = form.username.trim();
  if (name === "") return "Enter a username";
  if (name.length > 64) return "A username is at most 64 characters";
  return newPasswordProblem(form);
}

/**
 * "Firefox on Linux" from a User-Agent header, for telling sessions apart. Order matters:
 * Edge and Opera also say Chrome, Chrome also says Safari, Android also says Linux.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const system = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /CrOS/.test(userAgent)
            ? "ChromeOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  if (browser && system) return `${browser} on ${system}`;
  // Not a browser we know (a script, a new client): show what it calls itself, shortened.
  return browser ?? system ?? (userAgent.length > 40 ? `${userAgent.slice(0, 40)}…` : userAgent);
}

const EVENT_LABELS: Record<SignInEventKind, string> = {
  signed_in: "Signed in",
  password_failed: "Wrong password",
  code_failed: "Wrong authenticator code",
  code_lockout: "Fifth wrong code: sign-in stopped",
  passkey_signed_in: "Signed in with a passkey",
  passkey_failed: "Passkey not accepted",
};

export function signInEventLabel(kind: SignInEventKind): string {
  return EVENT_LABELS[kind];
}

export function isFailedSignIn(kind: SignInEventKind): boolean {
  return kind !== "signed_in" && kind !== "passkey_signed_in";
}

/** The line above the activity table; null when there is nothing to warn about. */
export function failedSignInWarning(failedLast7Days: number): string | null {
  if (failedLast7Days <= 0) return null;
  const attempts = failedLast7Days === 1 ? "1 failed sign-in attempt" : `${failedLast7Days} failed sign-in attempts`;
  return `${attempts} in the last 7 days. If that was not someone in the household, change the password of the account it names.`;
}

/**
 * True when a request failed because this browser is no longer signed in (the session
 * expired, was signed out elsewhere, or ended after wrong codes): the app should ask the
 * server who we are again and show the sign-in screen, not an error on the page.
 */
export function isSignedOutError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && (error.code === "unauthorized" || error.code === "sign_in_again" || error.code === "totp_required");
}
