import type { AuthStatus, PasskeyCeremony } from "@meridian/shared";
import { api, ApiError } from "./api.js";

/**
 * Audit a10-conformance-ledger-09 (spec, Security: "optional passkeys"): the wording and the
 * request flow of passkeys, kept out of the components so they can be tested. The browser's
 * WebAuthn prompt is @simplewebauthn/browser's, loaded only when a passkey is used.
 */

/** The longest name a passkey may have (the API's PasskeyName). */
export const PASSKEY_NAME_MAX = 60;

/** True when this browser can use passkeys at all (WebAuthn, in a secure context: https, or localhost). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true && typeof window.PublicKeyCredential === "function";
}

/** Why a passkey name cannot be saved; null when it can. */
export function passkeyNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name the passkey (the device or app that holds it, for example “Phone”).";
  if (trimmed.length > PASSKEY_NAME_MAX) return `Use at most ${PASSKEY_NAME_MAX} characters.`;
  return null;
}

/**
 * What a person reads when a passkey step fails. The browser's own errors (the prompt was
 * closed, it timed out, the device has this passkey already) get a sentence that says what
 * happened; the API's refusals keep their message.
 */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const name = typeof e?.name === "string" ? e.name : "";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return "This device already holds a passkey for this account.";
  if (code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was closed or timed out. Try again.";
  if (code === "ERROR_INVALID_DOMAIN" || name === "SecurityError") return "Passkeys need the app's secure address (https, or localhost).";
  if (code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT" || code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT")
    return "This authenticator cannot hold a passkey that checks your screen lock. Use the device's own passkeys or a newer security key.";
  return typeof e?.message === "string" && e.message !== "" ? e.message : "The passkey could not be used.";
}

/** Step through adding a passkey: the password, the browser's prompt, the answer. Returns the saved passkey's id. */
export async function addPasskey(input: { password: string; name: string }): Promise<{ id: string }> {
  const ceremony = await api<PasskeyCeremony>("/auth/passkeys/options", { method: "POST", body: { password: input.password } });
  const { startRegistration } = await import("@simplewebauthn/browser");
  const response = await startRegistration({ optionsJSON: ceremony.options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"] });
  return api<{ id: string }>("/auth/passkeys", { method: "POST", body: { challengeId: ceremony.challengeId, name: input.name.trim(), response } });
}

/** Sign in with a passkey: the browser offers this host's passkeys, and the answer signs its member in. */
export async function signInWithPasskey(): Promise<AuthStatus> {
  const ceremony = await api<PasskeyCeremony>("/auth/passkey/options", { method: "POST", body: {} });
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const response = await startAuthentication({ optionsJSON: ceremony.options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
  return api<AuthStatus>("/auth/passkey/verify", { method: "POST", body: { challengeId: ceremony.challengeId, response } });
}
