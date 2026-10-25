import { formatFixed8, parseFixed8, type Fixed8 } from "@meridian/shared";

/**
 * `numeric(20,8)` ↔ Fixed8 at the driver boundary. postgres.js returns a numeric column as
 * its text form ("12.50000000") and Drizzle types the column `string`; nothing in the
 * services ever passes a quantity or a price through `Number`. Writes use the canonical
 * form (no trailing zeros), which Postgres accepts for any scale.
 */

/** A non-null numeric column value → Fixed8. */
export function fixed8FromDb(value: string): Fixed8 {
  return parseFixed8(value);
}

/** Fixed8 → the text a numeric column takes. */
export function fixed8ToDb(value: Fixed8): string {
  return formatFixed8(value);
}

/** A nullable numeric column value (quantity, price) → Fixed8 | null. */
export function qtyFromDb(value: string | null | undefined): Fixed8 | null {
  return value === null || value === undefined ? null : parseFixed8(value);
}

/** Fixed8 | null → the text a nullable numeric column takes. */
export function qtyToDb(value: Fixed8 | null | undefined): string | null {
  return value === null || value === undefined ? null : formatFixed8(value);
}
