/** Request body limits in bytes. Fastify refuses a larger body with 413 before parsing it. */
export const BODY_LIMIT = {
  /** Every route unless it says otherwise. */
  default: 1024 * 1024,
  /** The public sign-in routes: a username, a password, a six-digit code. */
  signIn: 8 * 1024,
  /** CSV uploads travel in JSON bodies (`csvText` is capped at 10,000,000 characters). */
  csvImport: 12 * 1024 * 1024,
} as const;

/**
 * Sign-in attempt limits. The per-address ones run before the body is read; the per-account
 * ones do not depend on the address at all, so a client that can vary its address (many
 * devices, many addresses on one LAN host) is still held to a fixed number of guesses.
 */
export const SIGN_IN_LIMIT = {
  setupPerAddress: { max: 5, timeWindow: "1 minute" },
  passwordPerAddress: { max: 10, timeWindow: "1 minute" },
  /** Per username, as typed (trimmed, case-folded). */
  passwordPerUsername: { max: 20, timeWindow: "1 minute" },
  codePerAddress: { max: 10, timeWindow: "1 minute" },
  /**
   * Per user: 5 codes per 15 minutes is 480 guesses a day against a 6-digit code with a 3-step window.
   * Separately (in the database, not here) a password-only session is deleted at its fifth wrong code.
   */
  codePerUser: { max: 5, timeWindow: "15 minutes" },
} as const;
