import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
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

export function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

export const TOTP_ISSUER = "Meridian";

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpFor(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: TOTP_ISSUER, label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretBase32) });
}

/** Accepts the current code and one step either side. */
export function verifyTotp(secretBase32: string, label: string, code: string, now = Date.now()): boolean {
  const delta = totpFor(secretBase32, label).validate({ token: code, window: 1, timestamp: now });
  return delta !== null;
}
