import { isIsoDate } from "@meridian/shared";

/**
 * Text that arrives in a query and ends up inside SQL parameters: search patterns and the
 * opaque keyset cursors. Both are validated or escaped here, so a caller's string is never
 * interpreted by Postgres (as a wildcard, or as a malformed date or uuid).
 */

/**
 * `%text%` for ILIKE with the caller's `%`, `_` and `\` matched literally: searching for
 * `_` or `100%` finds those characters instead of everything.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export type CursorField = "date" | "timestamp" | "int" | "uuid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres `timestamptz::text`: `2026-11-10 16:35:52.123456+00`. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?[+-](0\d|1[0-5])(:[0-5]\d){0,2}$/;
/** Fits an integer column. */
const INT = /^-?\d{1,9}$/;

function isField(kind: CursorField, value: string): boolean {
  switch (kind) {
    case "date":
      return isIsoDate(value);
    case "timestamp": {
      const m = TIMESTAMP.exec(value);
      return m !== null && isIsoDate(m[1]!);
    }
    case "int":
      return INT.test(value);
    case "uuid":
      return UUID.test(value);
  }
}

export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join("|"), "utf8").toString("base64url");
}

/**
 * The fields of a cursor this server issued, or undefined for anything else: wrong
 * encoding, wrong number of fields, or a field that is not the date, timestamp, integer
 * or uuid it should be. Callers answer undefined with 400 `invalid_cursor`.
 */
export function decodeCursor(cursor: string, fields: readonly CursorField[]): string[] | undefined {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== fields.length) return undefined;
  if (encodeCursor(parts) !== cursor) return undefined; // not canonical base64url of exactly these fields
  return fields.every((kind, i) => isField(kind, parts[i]!)) ? parts : undefined;
}
