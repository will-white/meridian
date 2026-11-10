import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { describeDevice, failedSignInWarning, isFailedSignIn, isSignedOutError, newMemberProblem, newPasswordProblem, passwordChangeProblem, signInEventLabel } from "./security.js";

describe("passwordChangeProblem", () => {
  const ok = { current: "old password 123", next: "new password 456", confirm: "new password 456" };

  it("accepts a current password, a new one of 12 characters or more, typed twice", () => {
    expect(passwordChangeProblem(ok)).toBeNull();
    expect(passwordChangeProblem({ current: "x", next: "exactly12ch!", confirm: "exactly12ch!" })).toBeNull();
  });

  it("names the first thing that is wrong", () => {
    expect(passwordChangeProblem({ ...ok, current: "" })).toBe("Enter your current password");
    expect(passwordChangeProblem({ current: "x", next: "only11chars", confirm: "only11chars" })).toBe("Use at least 12 characters for the new password");
    expect(passwordChangeProblem({ current: "same password 1", next: "same password 1", confirm: "same password 1" })).toBe("The new password is the same as the current one");
    expect(passwordChangeProblem({ ...ok, confirm: "new password 457" })).toBe("The two new passwords do not match");
  });
});

describe("newMemberProblem and newPasswordProblem", () => {
  it("want a name and a 12-character password typed twice", () => {
    expect(newMemberProblem({ username: " Sam ", password: "viewer first pw", confirm: "viewer first pw" })).toBeNull();
    expect(newMemberProblem({ username: "   ", password: "viewer first pw", confirm: "viewer first pw" })).toBe("Enter a username");
    expect(newMemberProblem({ username: "s".repeat(65), password: "viewer first pw", confirm: "viewer first pw" })).toBe("A username is at most 64 characters");
    expect(newMemberProblem({ username: "Sam", password: "short", confirm: "short" })).toBe("Use at least 12 characters");
    expect(newPasswordProblem({ password: "viewer first pw", confirm: "viewer first pW" })).toBe("The two passwords do not match");
    expect(newPasswordProblem({ password: "viewer first pw", confirm: "viewer first pw" })).toBeNull();
  });
});

describe("describeDevice", () => {
  it("names the browser and the system from common User-Agent headers", () => {
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox on Linux");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")).toBe("Safari on macOS");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("Edge on Windows");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  });

  it("falls back to what the client calls itself, shortened, or says it does not know", () => {
    expect(describeDevice("curl/8.5.0")).toBe("curl/8.5.0");
    expect(describeDevice("x".repeat(41))).toBe(`${"x".repeat(40)}…`);
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("")).toBe("Unknown device");
  });
});

describe("sign-in activity wording", () => {
  it("labels each kind and marks everything but a completed sign-in as a failure", () => {
    expect(signInEventLabel("signed_in")).toBe("Signed in");
    expect(signInEventLabel("password_failed")).toBe("Wrong password");
    expect(signInEventLabel("code_failed")).toBe("Wrong authenticator code");
    expect(signInEventLabel("code_lockout")).toBe("Fifth wrong code: sign-in stopped");
    expect((["signed_in", "password_failed", "code_failed", "code_lockout"] as const).map(isFailedSignIn)).toEqual([false, true, true, true]);
  });

  it("warns only when there were failures, with the count", () => {
    expect(failedSignInWarning(0)).toBeNull();
    expect(failedSignInWarning(1)).toMatch(/^1 failed sign-in attempt in the last 7 days\./);
    expect(failedSignInWarning(6)).toMatch(/^6 failed sign-in attempts in the last 7 days\./);
  });
});

describe("isSignedOutError", () => {
  it("is true for the 401s that mean this browser is not signed in any more", () => {
    expect(isSignedOutError(new ApiError(401, "Sign in required", "unauthorized"))).toBe(true);
    expect(isSignedOutError(new ApiError(401, "Too many wrong codes", "sign_in_again"))).toBe(true);
    expect(isSignedOutError(new ApiError(401, "Enter your authenticator code", "totp_required"))).toBe(true);
  });

  it("is false for a wrong password or code, a refusal, and other errors", () => {
    expect(isSignedOutError(new ApiError(401, "Wrong username or password", "bad_credentials"))).toBe(false);
    expect(isSignedOutError(new ApiError(401, "That code is not valid", "bad_totp"))).toBe(false);
    expect(isSignedOutError(new ApiError(403, "Viewers cannot make changes", "viewer"))).toBe(false);
    expect(isSignedOutError(new ApiError(500, "Internal error", "internal"))).toBe(false);
    expect(isSignedOutError(new Error("network"))).toBe(false);
  });
});
