import { z } from "zod";

/**
 * Money is integer cents, never floats. The DB column is bigint; over the
 * wire it travels as a string so values above 2^53 can't be corrupted.
 */
export const Cents = z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform((v) =>
  typeof v === "bigint" ? v : BigInt(v),
);
export type Cents = bigint;

/** Parse a decimal amount string such as "-33293.43" (SimpleFIN format) into cents. */
export function parseDecimalToCents(input: string): bigint {
  const trimmed = input.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error(`Not a money amount: "${input}"`);
  const [, sign, whole, frac = ""] = match;
  const cents = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

/** Format cents as a plain decimal string, e.g. -1234n -> "-12.34". */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}
