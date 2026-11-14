/**
 * Versions stamped on every run (L7; engine-and-returns decision 31; seams C11 and §8 D1).
 *
 * - `ENGINE_VERSION` changes with any change that can alter a number the engine produces.
 * - `DATA_VERSION` is `dataVersion` of `data/manifest.json`; any edit to a data file bumps it.
 * - `DATA_CHECKSUM` is the SHA-256 of the manifest's file hashes joined by newlines, in manifest
 *   order (no trailing newline), so it names the exact bytes of every data file.
 *
 * The manifest is a static JSON import, so bundles carry it and nothing is read at run time.
 */

import manifestJson from "../data/manifest.json" with { type: "json" };
import { sha256Hex } from "./sha256.js";

/**
 * 1.0.0 at build step 21; 1.0.1 with the Stage A review fixes that change numbers (the married
 * couple's shared HSA limit, the split of the first drawdown year at spending.startMonth, the
 * boundary rounding of the bracket rates). Bump it with any change that can alter a number the
 * engine produces.
 */
export const ENGINE_VERSION = "1.0.1";

export interface DataManifestFile {
  path: string;
  sha256: string;
  sourceUrl?: string;
  retrieved?: string;
  description?: string;
}

/** The shape of `data/manifest.json` (seams §8 D1). */
export interface DataManifest {
  dataVersion: string;
  firstTaxYear: number;
  lastPublishedYear: number;
  files: DataManifestFile[];
}

const DATA_VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPTIONAL_TEXT = ["sourceUrl", "retrieved", "description"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the manifest's shape; a malformed manifest is a build defect and throws at module load. */
export function parseDataManifest(raw: unknown): DataManifest {
  const fail = (why: string): never => {
    throw new Error(`data/manifest.json: ${why}`);
  };
  if (!isRecord(raw)) return fail("not an object");
  const { dataVersion, firstTaxYear, lastPublishedYear, files } = raw;
  if (typeof dataVersion !== "string" || !DATA_VERSION_PATTERN.test(dataVersion)) fail("dataVersion must look like 2026.11.0");
  if (!Number.isInteger(firstTaxYear)) fail("firstTaxYear must be an integer year");
  if (!Number.isInteger(lastPublishedYear)) fail("lastPublishedYear must be an integer year");
  if (!Array.isArray(files)) return fail("files must be an array");
  const seen = new Set<string>();
  const parsed: DataManifestFile[] = files.map((entry: unknown, i): DataManifestFile => {
    if (!isRecord(entry)) return fail(`files[${i}] is not an object`);
    const { path, sha256 } = entry;
    if (typeof path !== "string" || path.length === 0) return fail(`files[${i}].path must be a non-empty string`);
    if (seen.has(path)) fail(`files[${i}].path ${path} is listed twice`);
    seen.add(path);
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return fail(`files[${i}].sha256 must be 64 lower-case hex digits`);
    const file: DataManifestFile = { path, sha256 };
    for (const key of OPTIONAL_TEXT) {
      const value = entry[key];
      if (value === undefined) continue;
      if (typeof value !== "string") return fail(`files[${i}].${key} must be a string`);
      file[key] = value;
    }
    return file;
  });
  return {
    dataVersion: dataVersion as string,
    firstTaxYear: firstTaxYear as number,
    lastPublishedYear: lastPublishedYear as number,
    files: parsed,
  };
}

/** `DATA_CHECKSUM` for a manifest: SHA-256 of the files' SHA-256 values joined by "\n". */
export function dataChecksum(manifest: DataManifest): string {
  return sha256Hex(manifest.files.map((f) => f.sha256).join("\n"));
}

export const DATA_MANIFEST: DataManifest = parseDataManifest(manifestJson);
export const DATA_VERSION: string = DATA_MANIFEST.dataVersion;
export const DATA_CHECKSUM: string = dataChecksum(DATA_MANIFEST);
