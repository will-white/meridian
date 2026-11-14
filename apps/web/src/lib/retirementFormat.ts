import { PlanBucket, roundDivHalfAway, STRATEGY_INFO, truncDiv, type ReturnModelKind } from "@meridian/shared";

/**
 * Formatting shared by the retirement pages (strategies-outputs-web §5). Money stays integer cents
 * (bigint or decimal strings) until it becomes text; a ratio computed here from cents truncates
 * toward zero (seams C44); a basis-point figure the engine already rounded is shown exactly.
 * Nothing here does money arithmetic in floats.
 */

const abs = (v: bigint) => (v < 0n ? -v : v);
const group3 = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "10,000" from 10000. */
export function countText(n: number): string {
  if (!Number.isSafeInteger(n)) return String(n);
  return `${n < 0 ? "-" : ""}${group3(String(Math.abs(n)))}`;
}

/** Whole dollars, rounded half away from zero: "96000.00" cents "9600000" → "$96,000"; "-50" → "-$1". */
export function wholeDollars(cents: string | bigint): string {
  const dollars = roundDivHalfAway(BigInt(cents), 100n);
  return `${dollars < 0n ? "-" : ""}$${group3(abs(dollars).toString())}`;
}

/**
 * A compact amount for tiles and the dashboard card: "$0", "$950", "$12.3k", "$1.2M", "$3.4B",
 * rounded half away from zero at the shown digit (integer arithmetic on the cents).
 */
export function compactMoney(cents: string | bigint): string {
  const c = BigInt(cents);
  const sign = c < 0n ? "-" : "";
  const a = abs(c);
  const scaled = (unit: bigint, suffix: string): string => {
    const tenths = roundDivHalfAway(a, unit / 10n);
    const whole = tenths / 10n;
    const frac = tenths % 10n;
    return `${sign}$${group3(whole.toString())}${frac === 0n ? "" : `.${frac}`}${suffix}`;
  };
  // Thresholds are on the rounded figure, so 999,950 dollars reads "$1M", not "$1,000k".
  if (roundDivHalfAway(a, 10_000_000n) >= 1_000n * 10n) return scaled(100_000_000_000n, "B");
  if (roundDivHalfAway(a, 10_000n) >= 1_000n * 10n) return scaled(100_000_000n, "M");
  if (roundDivHalfAway(a, 100n) >= 1_000n) return scaled(100_000n, "k");
  return `${sign}$${roundDivHalfAway(a, 100n).toString()}`;
}

/**
 * A percentage from basis points with at most one decimal, truncated toward zero and trimmed:
 * 350 → "3.5%", 400 → "4%", 6000 → "60%", 9420 with `places: 0` → "94%". Truncation never shows a
 * rate above what was measured (C44).
 */
export function percentText(bp: number, places: 0 | 1 = 1): string {
  const unit = places === 0 ? 100 : 10;
  const units = Math.trunc(bp / unit);
  const a = Math.abs(units);
  const sign = units < 0 ? "-" : "";
  if (places === 0) return `${sign}${a}%`;
  const whole = Math.trunc(a / 10);
  const tenth = a % 10;
  return `${sign}${whole}${tenth === 0 ? "" : `.${tenth}`}%`;
}

/** Basis points the engine rounded, exactly with two decimals: 685 → "6.85%", -180 → "-1.80%". */
export function bpExact(bp: number): string {
  const a = Math.abs(bp);
  return `${bp < 0 ? "-" : ""}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}%`;
}

/** A signed change in basis points with the typographic minus: -1000 → "−10%", 333 → "+3.3%", 0 → "0%". */
export function signedPercentText(bp: number): string {
  const text = percentText(Math.abs(bp));
  if (text === "0%") return "0%";
  return `${bp < 0 ? "−" : "+"}${text}`;
}

/** `truncDiv(part × 10000, whole)` in basis points; undefined when the whole is 0 (C44). */
export function ratioBp(part: string | bigint, whole: string | bigint): number | undefined {
  const w = BigInt(whole);
  if (w === 0n) return undefined;
  return Number(truncDiv(BigInt(part) * 10_000n, w));
}

/** "1st", "2nd", "3rd", "4th", "11th", "1,000th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${countText(n)}${suffix}`;
}

/** "67" for one person, "67 / 65" for two; a person not alive shows "—" in their place when `alive` is given. */
export function ageLabel(ages: readonly number[], alive?: readonly boolean[]): string {
  return ages.map((a, i) => (alive !== undefined && alive[i] === false ? "—" : String(a))).join(" / ");
}

/** "Age 67" or "Ages 67 / 65". */
export function agePhrase(label: string): string {
  return label.includes("/") ? `Ages ${label}` : `Age ${label}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2035-06" → "June 2035"; with `short`, "Jun 2035". */
export function monthText(month: string, short = false): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7);
  return `${short ? name.slice(0, 3) : name} ${month.slice(0, 4)}`;
}

/** A run's duration: "850 ms", "1.9 s", "2 min 5 s". */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.trunc(ms)} ms`;
  if (ms < 60_000) {
    const tenths = Math.trunc(ms / 100);
    return `${Math.trunc(tenths / 10)}.${tenths % 10} s`;
  }
  const seconds = Math.trunc(ms / 1000);
  return `${Math.trunc(seconds / 60)} min ${seconds % 60} s`;
}

/** A stored nine-decimal price level, trimmed to at most four decimals (cut, not rounded): "1.218402898" → "1.2184", "1.000000000" → "1". */
export function priceLevelText(level: string): string {
  const [whole, frac = ""] = level.split(".");
  const cut = frac.slice(0, 4).replace(/0+$/, "");
  return cut === "" ? (whole ?? level) : `${whole}.${cut}`;
}

/** Plain decimal for a CSV cell: "123456" → "1234.56". */
export function csvMoney(cents: string | bigint): string {
  const c = BigInt(cents);
  const a = abs(c);
  return `${c < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

const BUCKET_LABELS: Record<PlanBucket, string> = { taxable: "Taxable", pre_tax: "Pre-tax", roth: "Roth", hsa: "HSA", cash: "Cash" };

/** The planner buckets as people say them. */
export function bucketLabel(bucket: PlanBucket): string {
  return BUCKET_LABELS[bucket];
}

/** The buckets in the order the pages show them. */
export const BUCKETS: readonly PlanBucket[] = PlanBucket.options;

const RETURN_MODEL_LABELS: Record<ReturnModelKind, string> = {
  historical: "Historical sequences",
  bootstrap: "Block bootstrap",
  parametric: "Parametric",
  fixed: "Fixed (test model)",
};

/** A return model's name; an unknown stored string is shown as it is. */
export function returnModelLabel(kind: string): string {
  return (RETURN_MODEL_LABELS as Record<string, string>)[kind] ?? kind;
}

/** A strategy's card label (`STRATEGY_INFO`); an unknown stored string is shown as it is. */
export function strategyLabel(kind: string): string {
  return (STRATEGY_INFO as Record<string, { label: string } | undefined>)[kind]?.label ?? kind;
}

/**
 * Text for an ECharts label drawn on the canvas: ECharts reads `{a}`, `{b}` and `{style|text}`
 * inside label strings, so braces are replaced; control characters are dropped. Names typed by
 * the household (a person's name in a marker) go through this.
 */
export function chartText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch === "{" ? "(" : ch === "}" ? ")" : ch;
  }
  return out;
}

/** A dollar amount typed into a form ("1,234.56", "$12", " 500 ") to cents; null when it is not a non-negative amount with at most two decimals. */
export function parseDollarsInput(raw: string): bigint | null {
  let s = raw.replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** Cents as the text a dollar input starts with: "350000" → "3500", "123456" → "1234.56". */
export function dollarsInputValue(cents: string | bigint): string {
  const c = BigInt(cents);
  const cent = c % 100n;
  return cent === 0n ? (c / 100n).toString() : csvMoney(c);
}

/**
 * A signed percent typed into a form ("-12.5", "7", "+3.25%") to basis points; null when it is
 * not a number with at most two decimals or lies outside [minBp, maxBp].
 */
export function parseSignedPercent(raw: string, minBp: number, maxBp: number): number | null {
  const s = raw.replace(/[%\s]/g, "").replace(/−/g, "-");
  const m = /^([+-]?)(\d{1,5})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const magnitude = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  const bp = m[1] === "-" ? -magnitude : magnitude;
  return bp < minBp || bp > maxBp ? null : bp;
}

/** Basis points as the text a percent input starts with, trailing zeros trimmed: 1185 → "11.85", -250 → "-2.5", 400 → "4". */
export function percentInputValue(bp: number): string {
  const a = Math.abs(bp);
  const frac = String(a % 100).padStart(2, "0").replace(/0+$/, "");
  return `${bp < 0 ? "-" : ""}${Math.trunc(a / 100)}${frac ? `.${frac}` : ""}`;
}

/** A whole number typed into a form, within [min, max]; null otherwise. */
export function parseWholeNumber(raw: string, min: number, max: number): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n < min || n > max ? null : n;
}
