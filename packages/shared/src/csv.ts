import { z } from "zod";
import { isIsoDate, type IsoDate } from "./dates.js";
import { sha256Hex } from "./crypto.js";
import { normalizePayee } from "./payee.js";
import { sanitizeText } from "./sanitize.js";

/** RFC 4180 CSV parser: quoted fields, doubled quotes, CR/LF/CRLF, BOM. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export const CsvDateFormat = z.enum([
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "MM/DD/YY",
  "YYYY/MM/DD",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "MMM D, YYYY",
  "D MMM YYYY",
]);
export type CsvDateFormat = z.infer<typeof CsvDateFormat>;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function build(y: number, m: number, d: number): IsoDate | undefined {
  const date = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(date) ? date : undefined;
}

export function parseCsvDate(raw: string, format: CsvDateFormat): IsoDate | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const nums = s.split(/[^0-9A-Za-z]+/).filter((p) => p.length > 0);
  switch (format) {
    case "YYYY-MM-DD":
    case "YYYY/MM/DD": {
      if (nums.length < 3) return undefined;
      return build(Number(nums[0]), Number(nums[1]), Number(nums[2]));
    }
    case "MM/DD/YYYY":
    case "MM-DD-YYYY": {
      if (nums.length < 3) return undefined;
      return build(Number(nums[2]), Number(nums[0]), Number(nums[1]));
    }
    case "MM/DD/YY": {
      if (nums.length < 3) return undefined;
      const yy = Number(nums[2]);
      const year = nums[2]!.length === 2 ? (yy >= 70 ? 1900 + yy : 2000 + yy) : yy;
      return build(year, Number(nums[0]), Number(nums[1]));
    }
    case "DD/MM/YYYY":
    case "DD-MM-YYYY": {
      if (nums.length < 3) return undefined;
      return build(Number(nums[2]), Number(nums[1]), Number(nums[0]));
    }
    case "MMM D, YYYY": {
      if (nums.length < 3) return undefined;
      const m = MONTHS.indexOf(nums[0]!.slice(0, 3).toLowerCase());
      if (m < 0) return undefined;
      return build(Number(nums[2]), m + 1, Number(nums[1]));
    }
    case "D MMM YYYY": {
      if (nums.length < 3) return undefined;
      const m = MONTHS.indexOf(nums[1]!.slice(0, 3).toLowerCase());
      if (m < 0) return undefined;
      return build(Number(nums[2]), m + 1, Number(nums[0]));
    }
  }
}

/** Forgiving money parse for bank exports: "$1,234.56", "(12.34)", "-12.34", "12.34-", "12.34 CR". */
export function parseLooseMoney(raw: string): bigint | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bDR\b/i.test(s)) negative = !negative;
  s = s.replace(/\b(CR|DR)\b/gi, "");
  s = s.replace(/[$€£,\s]/g, "");
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return undefined;
  const whole = BigInt(m[1] || "0");
  const frac = BigInt((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100n + frac;
  return negative ? -cents : cents;
}

/** A column is addressed by header name or zero-based index. */
export const ColumnRef = z.union([z.string().min(1), z.number().int().min(0)]);
export type ColumnRef = z.infer<typeof ColumnRef>;

export const CsvMapping = z.object({
  hasHeader: z.boolean().default(true),
  skipRows: z.number().int().min(0).default(0),
  date: z.object({ column: ColumnRef, format: CsvDateFormat }),
  description: z.object({ column: ColumnRef }),
  memo: z.object({ column: ColumnRef }).optional(),
  externalId: z.object({ column: ColumnRef }).optional(),
  amount: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("single"),
      column: ColumnRef,
      /** True when the file shows outflows as positive numbers. */
      invert: z.boolean().default(false),
    }),
    z.object({
      mode: z.literal("split"),
      debitColumn: ColumnRef,
      creditColumn: ColumnRef,
    }),
  ]),
});
export type CsvMapping = z.infer<typeof CsvMapping>;
export type CsvMappingInput = z.input<typeof CsvMapping>;

export interface MappedRow {
  rowIndex: number;
  date: IsoDate;
  amountCents: bigint;
  description: string;
  memo?: string;
  externalId: string;
}

export interface MappingError {
  rowIndex: number;
  message: string;
}

function resolveColumn(ref: ColumnRef, headers: readonly string[] | undefined): number {
  if (typeof ref === "number") return ref;
  if (!headers) throw new Error(`Column "${ref}" referenced by name, but the file has no header row`);
  const idx = headers.findIndex((h) => h.trim().toLowerCase() === ref.trim().toLowerCase());
  if (idx < 0) throw new Error(`Column "${ref}" not found in header`);
  return idx;
}

/** Stable id for rows without a bank-provided id: csv:<sha256(date|cents|normalized description)>[:n]. */
export async function csvExternalId(date: IsoDate, amountCents: bigint, description: string, ordinal: number): Promise<string> {
  const key = `${date}|${amountCents.toString()}|${normalizePayee(description).toLowerCase()}`;
  const hash = await sha256Hex(key);
  return ordinal === 0 ? `csv:${hash}` : `csv:${hash}:${ordinal}`;
}

/** Apply a mapping to parsed rows. Rows that cannot be mapped are reported, not thrown. */
export async function mapCsvRows(rows: readonly string[][], mappingInput: CsvMappingInput): Promise<{ rows: MappedRow[]; errors: MappingError[] }> {
  const mapping = CsvMapping.parse(mappingInput);
  const body = rows.slice(mapping.skipRows);
  const headers = mapping.hasHeader ? body[0] : undefined;
  const data = mapping.hasHeader ? body.slice(1) : body;

  const dateCol = resolveColumn(mapping.date.column, headers);
  const descCol = resolveColumn(mapping.description.column, headers);
  const memoCol = mapping.memo ? resolveColumn(mapping.memo.column, headers) : undefined;
  const idCol = mapping.externalId ? resolveColumn(mapping.externalId.column, headers) : undefined;
  const amountCols =
    mapping.amount.mode === "single"
      ? { mode: "single" as const, col: resolveColumn(mapping.amount.column, headers), invert: mapping.amount.invert }
      : {
          mode: "split" as const,
          debit: resolveColumn(mapping.amount.debitColumn, headers),
          credit: resolveColumn(mapping.amount.creditColumn, headers),
        };

  const out: MappedRow[] = [];
  const errors: MappingError[] = [];
  const seen = new Map<string, number>();
  const offset = mapping.skipRows + (mapping.hasHeader ? 1 : 0);

  for (let i = 0; i < data.length; i++) {
    const row = data[i]!;
    const rowIndex = i + offset;
    if (row.every((c) => c.trim() === "")) continue;
    const date = parseCsvDate(row[dateCol] ?? "", mapping.date.format);
    if (!date) {
      errors.push({ rowIndex, message: `Unreadable date "${row[dateCol] ?? ""}"` });
      continue;
    }
    let amountCents: bigint | undefined;
    if (amountCols.mode === "single") {
      amountCents = parseLooseMoney(row[amountCols.col] ?? "");
      if (amountCents !== undefined && amountCols.invert) amountCents = -amountCents;
    } else {
      const debit = parseLooseMoney(row[amountCols.debit] ?? "");
      const credit = parseLooseMoney(row[amountCols.credit] ?? "");
      if (debit !== undefined && debit !== 0n) amountCents = debit > 0n ? -debit : debit;
      else if (credit !== undefined) amountCents = credit < 0n ? -credit : credit;
      else amountCents = debit;
    }
    if (amountCents === undefined) {
      errors.push({ rowIndex, message: "Unreadable amount" });
      continue;
    }
    const description = sanitizeText(row[descCol] ?? "", 500);
    const memo = memoCol !== undefined ? sanitizeText(row[memoCol] ?? "", 500) : "";
    let externalId: string;
    const providedId = idCol !== undefined ? sanitizeText(row[idCol] ?? "", 200) : "";
    if (providedId) {
      externalId = `csvid:${providedId}`;
    } else {
      const baseKey = `${date}|${amountCents}|${normalizePayee(description).toLowerCase()}`;
      const ordinal = seen.get(baseKey) ?? 0;
      seen.set(baseKey, ordinal + 1);
      externalId = await csvExternalId(date, amountCents, description, ordinal);
    }
    const mapped: MappedRow = { rowIndex, date, amountCents, description, externalId };
    if (memo) mapped.memo = memo;
    out.push(mapped);
  }
  return { rows: out, errors };
}

const DATE_HEADERS = ["date", "transaction date", "posted date", "post date", "trans date", "posting date"];
const DESC_HEADERS = ["description", "payee", "name", "merchant", "details", "memo", "narrative", "transaction"];
const AMOUNT_HEADERS = ["amount", "transaction amount", "amt"];
const DEBIT_HEADERS = ["debit", "withdrawal", "withdrawals", "money out", "outflow", "debit amount"];
const CREDIT_HEADERS = ["credit", "deposit", "deposits", "money in", "inflow", "credit amount"];
const ID_HEADERS = ["transaction id", "id", "reference", "reference number", "fitid"];

function findHeader(headers: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx >= 0) return headers[idx];
  }
  for (const c of candidates) {
    const idx = lower.findIndex((h) => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

function guessDateFormat(samples: readonly string[]): CsvDateFormat {
  const s = samples.map((x) => x.trim()).filter((x) => x.length > 0);
  if (s.some((x) => /^\d{4}-\d{2}-\d{2}/.test(x))) return "YYYY-MM-DD";
  if (s.some((x) => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(x))) return "YYYY/MM/DD";
  if (s.some((x) => /^[A-Za-z]{3}/.test(x))) return "MMM D, YYYY";
  if (s.some((x) => /^\d{1,2}\s+[A-Za-z]{3}/.test(x))) return "D MMM YYYY";
  if (s.some((x) => /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(x))) return "MM/DD/YY";
  if (s.some((x) => /^\d{1,2}-\d{1,2}-\d{4}$/.test(x))) return "MM-DD-YYYY";
  // Disambiguate MM/DD vs DD/MM: if any first part exceeds 12 it's DD/MM.
  if (s.some((x) => Number(x.split(/[/-]/)[0]) > 12)) return "DD/MM/YYYY";
  return "MM/DD/YYYY";
}

/** Guess a mapping from a header row and a few sample rows. Returns undefined when no date column is found. */
export function guessCsvMapping(headers: readonly string[], samples: readonly string[][]): CsvMappingInput | undefined {
  const date = findHeader(headers, DATE_HEADERS);
  const description = findHeader(headers, DESC_HEADERS);
  if (!date || !description) return undefined;
  const dateIdx = headers.indexOf(date);
  const format = guessDateFormat(samples.map((r) => r[dateIdx] ?? ""));
  const amount = findHeader(headers, AMOUNT_HEADERS);
  const debit = findHeader(headers, DEBIT_HEADERS);
  const credit = findHeader(headers, CREDIT_HEADERS);
  const id = findHeader(headers, ID_HEADERS);
  const memo = headers.find((h) => /^(memo|notes?)$/i.test(h.trim()) && h !== description);

  const base: CsvMappingInput = {
    hasHeader: true,
    date: { column: date, format },
    description: { column: description },
    amount: amount
      ? { mode: "single", column: amount, invert: false }
      : debit && credit
        ? { mode: "split", debitColumn: debit, creditColumn: credit }
        : { mode: "single", column: headers[headers.length - 1] ?? 0, invert: false },
  };
  if (memo) base.memo = { column: memo };
  if (id) base.externalId = { column: id };
  return base;
}
