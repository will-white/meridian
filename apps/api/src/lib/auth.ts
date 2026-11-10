import { Algorithm, hash, verify } from "@node-rs/argon2";
import * as OTPAuth from "otpauth";

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export const TOTP_ISSUER = "Meridian";

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpFor(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: TOTP_ISSUER, label, algorithm: "SHA1", digits: 6, period: TOTP_PERIOD_SECONDS, secret: OTPAuth.Secret.fromBase32(secretBase32) });
}

export const TOTP_PERIOD_SECONDS = 30;

/**
 * The 30-second step `code` belongs to when it is the code for now or for one step either
 * side (clock drift); null when it is none of those. The caller must then take the step with
 * `acceptTotpStep`, which refuses a step that is not later than the last one used: a code
 * that matches is not yet a code that may be accepted.
 */
export function matchTotpStep(secretBase32: string, label: string, code: string, now: number): number | null {
  const delta = totpFor(secretBase32, label).validate({ token: code, window: 1, timestamp: now });
  return delta === null ? null : Math.floor(now / 1000 / TOTP_PERIOD_SECONDS) + delta;
}
