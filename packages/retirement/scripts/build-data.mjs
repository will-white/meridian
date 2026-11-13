#!/usr/bin/env node
/**
 * Generates packages/retirement/src/generated/data.ts from the CSV series in packages/retirement/data
 * (seams §8 D13; engine-and-returns §2.8). The JSON tables are imported statically by
 * src/tax/taxData.ts and are not generated.
 *
 *   node packages/retirement/scripts/build-data.mjs          write src/generated/data.ts
 *   node packages/retirement/scripts/build-data.mjs --check  exit 1 if it is stale or a manifest hash is wrong
 *   node packages/retirement/scripts/build-data.mjs --hash   print the SHA-256 of every data file
 *
 * Inputs: us-annual-returns.csv (D2), irs-2010cm-life-table.csv (D3) and, when it is present and
 * listed in the manifest, ssa-period-life-table.csv (D4; plan decision 11). Every input's SHA-256 must
 * equal its manifest entry before anything is written, so the module always names the bytes it was
 * built from (GENERATED_FROM).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DATA_DIR = join(PACKAGE_DIR, "data");
export const GENERATED_PATH = join(PACKAGE_DIR, "src", "generated", "data.ts");

const RETURNS = "us-annual-returns.csv";
const LIFE_2010CM = "irs-2010cm-life-table.csv";
const LIFE_SSA = "ssa-period-life-table.csv";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under the data directory except manifest.json, as manifest paths ("tax/rules.json"). */
export function listDataFiles(dataDir = DEFAULT_DATA_DIR) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dataDir, full).split(sep).join("/"));
    }
  };
  walk(dataDir);
  return out.filter((p) => p !== "manifest.json");
}

export function readManifest(dataDir = DEFAULT_DATA_DIR) {
  return JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
}

/** Problems with the manifest against the files on disk: unlisted, missing, or a wrong SHA-256. */
export function verifyManifest(dataDir = DEFAULT_DATA_DIR, manifest = readManifest(dataDir)) {
  const problems = [];
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  for (const path of listDataFiles(dataDir)) {
    if (!listed.has(path)) problems.push(`${path}: not listed in manifest.json`);
  }
  for (const [path, sha] of listed) {
    const full = join(dataDir, path);
    if (!existsSync(full)) problems.push(`${path}: listed in manifest.json but missing`);
    else if (sha256File(full) !== sha) problems.push(`${path}: SHA-256 ${sha256File(full)} differs from the manifest's ${sha}`);
  }
  return problems;
}

function fail(file, why) {
  throw new Error(`${file}: ${why}`);
}

/** Strict CSV reader: exact header, LF line endings, a trailing newline, fixed decimals. */
function readCsv(path, file, header, decimals) {
  const text = readFileSync(path, "utf8");
  if (text.includes("\r")) fail(file, "CR found; LF line endings only");
  if (!text.endsWith("\n")) fail(file, "no trailing newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== header) fail(file, `header must be ${header}`);
  const cols = header.split(",").length;
  const number = new RegExp(`^-?\\d+\\.\\d{${decimals}}$`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== cols) fail(file, `row ${i + 1} has ${cells.length} cells`);
    const key = cells[0];
    if (!/^\d+$/.test(key)) fail(file, `row ${i + 1}: ${key} is not a whole number`);
    const values = cells.slice(1).map((c) => {
      if (!number.test(c)) fail(file, `row ${i + 1}: ${c} is not a number with ${decimals} decimals`);
      return Number(c);
    });
    return { key: Number(key), values };
  });
}

function readReturns(dataDir) {
  const rows = readCsv(join(dataDir, RETURNS), RETURNS, "year,stocks,bonds,bills,inflation", 6);
  if (rows.length !== 98) fail(RETURNS, `expected 98 rows (1928 to 2025), found ${rows.length}`);
  rows.forEach((r, i) => {
    if (r.key !== 1928 + i) fail(RETURNS, `row ${i + 1} is year ${r.key}, expected ${1928 + i}`);
    if (r.values.some((v) => v <= -1)) fail(RETURNS, `year ${r.key} has a return of -100% or less`);
  });
  return rows;
}

function readLife2010cm(dataDir) {
  const rows = readCsv(join(dataDir, LIFE_2010CM), LIFE_2010CM, "age,lx", 5);
  if (rows.length !== 111) fail(LIFE_2010CM, `expected 111 rows (ages 0 to 110), found ${rows.length}`);
  rows.forEach((r, i) => {
    if (r.key !== i) fail(LIFE_2010CM, `row ${i + 1} is age ${r.key}, expected ${i}`);
  });
  if (rows[0].values[0] !== 100000) fail(LIFE_2010CM, "lx[0] must be 100000");
  for (let i = 1; i < rows.length; i++) {
    if (!(rows[i].values[0] < rows[i - 1].values[0])) fail(LIFE_2010CM, `lx is not strictly decreasing at age ${i}`);
  }
  return rows;
}

function readLifeSsa(dataDir) {
  const rows = readCsv(join(dataDir, LIFE_SSA), LIFE_SSA, "age,male_qx,female_qx", 6);
  if (rows.length !== 120) fail(LIFE_SSA, `expected 120 rows (ages 0 to 119), found ${rows.length}`);
  rows.forEach((r, i) => {
    if (r.key !== i) fail(LIFE_SSA, `row ${i + 1} is age ${r.key}, expected ${i}`);
    if (r.values.some((q) => !(q > 0 && q <= 1))) fail(LIFE_SSA, `age ${i}: every qx must lie in (0, 1]`);
  });
  return rows;
}

/** Shortest round-trip decimal literals, ten to a line. */
function float64Array(values) {
  const lines = [];
  for (let i = 0; i < values.length; i += 10) {
    lines.push("  " + values.slice(i, i + 10).map((v) => String(v)).join(", ") + ",");
  }
  return `new Float64Array([\n${lines.join("\n")}\n])`;
}

/** The text of src/generated/data.ts for the data directory (pure apart from reading the files). */
export function renderDataModule(dataDir = DEFAULT_DATA_DIR) {
  const manifest = readManifest(dataDir);
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const inputs = [RETURNS, LIFE_2010CM];
  const ssaPresent = existsSync(join(dataDir, LIFE_SSA));
  if (ssaPresent && !listed.has(LIFE_SSA)) fail(LIFE_SSA, "present but not listed in manifest.json");
  if (!ssaPresent && listed.has(LIFE_SSA)) fail(LIFE_SSA, "listed in manifest.json but missing");
  if (ssaPresent) inputs.push(LIFE_SSA);
  const from = {};
  for (const file of inputs) {
    const sha = sha256File(join(dataDir, file));
    if (listed.get(file) !== sha) fail(file, `SHA-256 ${sha} differs from the manifest's ${listed.get(file) ?? "(not listed)"}`);
    from[file] = sha;
  }

  const returns = readReturns(dataDir);
  const lx = readLife2010cm(dataDir);
  const ssa = ssaPresent ? readLifeSsa(dataDir) : null;
  const col = (rows, k) => rows.map((r) => r.values[k]);

  const out = [
    "// Generated by packages/retirement/scripts/build-data.mjs from the data files named in GENERATED_FROM.",
    "// Do not edit: change the CSV, update data/manifest.json and run the script (data.test.ts fails when stale).",
    "",
    "/** SHA-256 of each input file, equal to its entry in data/manifest.json when this module was written. */",
    `export const GENERATED_FROM: Readonly<Record<string, string>> = ${JSON.stringify(from, null, 2)};`,
    "",
    "/** us-annual-returns.csv (seams §8 D2): simple annual rates as fractions, one entry per calendar year. */",
    "export const US_FIRST_YEAR = 1928;",
    `export const US_LAST_YEAR = ${returns[returns.length - 1].key};`,
    `export const US_STOCKS = ${float64Array(col(returns, 0))};`,
    `export const US_BONDS = ${float64Array(col(returns, 1))};`,
    `export const US_BILLS = ${float64Array(col(returns, 2))};`,
    `export const US_INFLATION = ${float64Array(col(returns, 3))};`,
    "",
    "/** irs-2010cm-life-table.csv (seams §8 D3): survivors out of 100,000 births at ages 0 to 110 (unisex). */",
    `export const LIFE_2010CM_LX = ${float64Array(col(lx, 0))};`,
    "",
    "/** ssa-period-life-table.csv (seams §8 D4): q_x at ages 0 to 119, or null while the table is not installed. */",
    `export const LIFE_SSA_MALE_QX: Float64Array | null = ${ssa ? float64Array(col(ssa, 0)) : "null"};`,
    `export const LIFE_SSA_FEMALE_QX: Float64Array | null = ${ssa ? float64Array(col(ssa, 1)) : "null"};`,
    "",
  ];
  return out.join("\n");
}

function main(argv) {
  const mode = argv[0] ?? "--write";
  if (mode === "--hash") {
    for (const path of listDataFiles()) console.log(`${sha256File(join(DEFAULT_DATA_DIR, path))}  ${path}`);
    return 0;
  }
  const problems = verifyManifest();
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    return 1;
  }
  const text = renderDataModule();
  if (mode === "--check") {
    const current = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, "utf8") : "";
    if (current !== text) {
      console.error(`${relative(process.cwd(), GENERATED_PATH)} is stale: run node packages/retirement/scripts/build-data.mjs`);
      return 1;
    }
    console.log("data files match the manifest; src/generated/data.ts is current");
    return 0;
  }
  if (mode !== "--write") {
    console.error("usage: build-data.mjs [--check | --hash]");
    return 2;
  }
  writeFileSync(GENERATED_PATH, text);
  console.log(`wrote ${relative(process.cwd(), GENERATED_PATH)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
