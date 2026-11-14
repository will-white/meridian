import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { PASSKEY_NAME_MAX, passkeyErrorMessage, passkeyNameProblem } from "./passkeys.js";
import { isFailedSignIn, signInEventLabel } from "./security.js";

/** Audit a10-conformance-ledger-09: what the passkey screens say. */
describe("passkey wording (audit a10-conformance-ledger-09)", () => {
  it("asks for a name of 1 to 60 characters", () => {
    expect(passkeyNameProblem("  ")).toContain("Name the passkey");
    expect(passkeyNameProblem("x".repeat(PASSKEY_NAME_MAX + 1))).toBe("Use at most 60 characters.");
    expect(passkeyNameProblem(" Phone ")).toBeNull();
  });

  it("says what a failed prompt means, and keeps the API's own message", () => {
    expect(passkeyErrorMessage({ name: "NotAllowedError", message: "The operation either timed out or was not allowed." })).toBe("The passkey prompt was closed or timed out. Try again.");
    expect(passkeyErrorMessage({ name: "InvalidStateError", code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", message: "x" })).toBe("This device already holds a passkey for this account.");
    expect(passkeyErrorMessage({ name: "SecurityError", code: "ERROR_INVALID_DOMAIN", message: "x" })).toBe("Passkeys need the app's secure address (https, or localhost).");
    expect(passkeyErrorMessage(new ApiError(401, "This passkey is not one of Meridian's. Sign in with your password; you can add the passkey under Settings.", "passkey_unknown"))).toContain("not one of Meridian's");
    expect(passkeyErrorMessage(new Error(""))).toBe("The passkey could not be used.");
  });

  it("names passkey sign-ins in the sign-in activity, and counts a refused answer as a failed attempt", () => {
    expect(signInEventLabel("passkey_signed_in")).toBe("Signed in with a passkey");
    expect(signInEventLabel("passkey_failed")).toBe("Passkey not accepted");
    expect(isFailedSignIn("passkey_signed_in")).toBe(false);
    expect(isFailedSignIn("passkey_failed")).toBe(true);
  });
});
