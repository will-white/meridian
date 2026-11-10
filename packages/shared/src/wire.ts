import { z } from "zod";
import { isIsoDate } from "./dates.js";

/**
 * The primitive shapes of the wire format, in two strengths.
 *
 * Responses use the loose shapes (`CentsString`, `IsoDateString`, `MonthString`): whatever
 * the database holds, from a bank feed or an import, must always serialize.
 *
 * Requests use the bounded shapes (`CentsInput`, `IsoDateInput`, `MonthInput`). A value that
 * is well-formed but absurd (the 31st of February, month 9999-12, cents beyond a bigint) is
 * answered 400 at the edge instead of failing inside Postgres or in date arithmetic.
 * `looseWireFields` finds a request contract that forgot to use them; the API refuses to
 * register such a route.
 */

/** Cents as an integer string. */
export const CentsString = z.string().regex(/^-?\d+$/, "cents as an integer string");
export const NonNegCentsString = z.string().regex(/^\d+$/, "cents as a non-negative integer string");
export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const MonthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");

/**
 * The largest amount a caller may send: 15 digits of cents, a little under ten trillion
 * dollars. A bigint column holds 9.2 × 10^18, so thousands of such amounts still add up
 * without overflowing.
 */
export const MAX_INPUT_CENTS = 999_999_999_999_999n;
/** The years a caller may name. Day and month arithmetic (a year either side, 36 months back) stays far inside what JS dates and Postgres handle. */
export const MIN_INPUT_YEAR = 1900;
export const MAX_INPUT_YEAR = 2199;

const yearInRange = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  return year >= MIN_INPUT_YEAR && year <= MAX_INPUT_YEAR;
};

/** True for a real calendar date inside the years a caller may name (what `IsoDateInput` accepts). */
export function isInputDate(value: string): boolean {
  return isIsoDate(value) && yearInRange(value);
}

/** Cents a caller sends: an integer string of at most 15 digits. */
export const CentsInput = z.string().regex(/^-?\d{1,15}$/, "cents as an integer string of at most 15 digits");
export const NonNegCentsInput = z.string().regex(/^\d{1,15}$/, "cents as a non-negative integer string of at most 15 digits");
/** A date a caller sends: a real calendar date from 1900-01-01 to 2199-12-31. */
export const IsoDateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .refine(isInputDate, `a calendar date between ${MIN_INPUT_YEAR}-01-01 and ${MAX_INPUT_YEAR}-12-31`);
/** A month a caller sends: 1900-01 to 2199-12. */
export const MonthInput = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM")
  .refine(yearInRange, `a month between ${MIN_INPUT_YEAR}-01 and ${MAX_INPUT_YEAR}-12`);

/** The longest list (or map) a request may carry; every contract's own limit is at or below it. */
export const MAX_LIST_ITEMS = 5000;
/** The largest side of a split ratio (new:old) a caller or a trade file may state; far inside an integer column. */
export const MAX_SPLIT_TERM = 1_000_000;

const LOOSE = new Map<z.ZodTypeAny, string>([
  [CentsString, "CentsString"],
  [NonNegCentsString, "NonNegCentsString"],
  [IsoDateString, "IsoDateString"],
  [MonthString, "MonthString"],
]);

/**
 * Paths inside a request contract that still use a loose wire shape, e.g.
 * `["date (IsoDateString)", "edits[].month (MonthString)"]`. Empty when the contract only
 * uses the bounded inputs. Follows objects, arrays, unions, optionals, defaults, refinements,
 * transforms, pipelines, records, tuples and intersections.
 */
export function looseWireFields(schema: z.ZodTypeAny | undefined, path = ""): string[] {
  if (schema === undefined) return [];
  const found: string[] = [];
  const seen = new Set<z.ZodTypeAny>();
  const visit = (node: z.ZodTypeAny | undefined, at: string): void => {
    if (node === undefined || node === null || typeof node !== "object") return;
    const loose = LOOSE.get(node);
    if (loose !== undefined) {
      found.push(`${at || "(root)"} (${loose})`);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const def = (node as { _def?: Record<string, unknown> })._def;
    if (def === undefined) return;
    const child = (value: unknown, suffix = ""): void => visit(value as z.ZodTypeAny | undefined, `${at}${suffix}`);
    switch (def["typeName"]) {
      case "ZodObject": {
        const shape = (node as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
        for (const [key, value] of Object.entries(shape)) visit(value, at ? `${at}.${key}` : key);
        child(def["catchall"], ".*");
        break;
      }
      case "ZodArray":
      case "ZodSet":
        child(def["type"] ?? def["valueType"], "[]");
        break;
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodCatch":
      case "ZodReadonly":
        child(def["innerType"]);
        break;
      case "ZodBranded":
      case "ZodPromise":
        child(def["type"]);
        break;
      case "ZodEffects":
        child(def["schema"]);
        break;
      case "ZodLazy":
        child((def["getter"] as () => z.ZodTypeAny)());
        break;
      case "ZodPipeline":
        child(def["in"]);
        child(def["out"]);
        break;
      case "ZodUnion":
        for (const option of def["options"] as z.ZodTypeAny[]) child(option);
        break;
      case "ZodDiscriminatedUnion":
        for (const option of (def["options"] as z.ZodTypeAny[]).values()) child(option);
        break;
      case "ZodIntersection":
        child(def["left"]);
        child(def["right"]);
        break;
      case "ZodRecord":
      case "ZodMap":
        child(def["keyType"], "{key}");
        child(def["valueType"], "{}");
        break;
      case "ZodTuple":
        for (const item of def["items"] as z.ZodTypeAny[]) child(item, "[]");
        child(def["rest"], "[]");
        break;
      default:
        break;
    }
  };
  visit(schema, path);
  return found;
}
