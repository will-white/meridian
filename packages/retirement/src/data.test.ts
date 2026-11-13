import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AssetClass } from "@meridian/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  GENERATED_FROM,
  LIFE_2010CM_LX,
  LIFE_SSA_FEMALE_QX,
  LIFE_SSA_MALE_QX,
  US_BILLS,
  US_BONDS,
  US_FIRST_YEAR,
  US_INFLATION,
  US_LAST_YEAR,
  US_STOCKS,
} from "./generated/data.js";
import { fraMonths, survivorFraMonths } from "./tax/socialSecurity.js";
import { fullRetirementAgeTable, listTaxRuleSets, pendingLimits, TAX_DATA_FIRST_YEAR, taxDataStale } from "./tax/rulesView.js";
import { fractionValue, loadTaxData, rawTaxData, ssFigureKeys, TaxDataError, validateTaxData, yearValueAt } from "./tax/taxData.js";
import { DATA_CHECKSUM, DATA_MANIFEST, DATA_VERSION } from "./version.js";

// The data suite (seams §8 D1 to D13; engine-and-returns T13; tax-rmd-ss A1 to A7). Every expected
// value below is a validation figure of seams §8 or of the area designs, or is derived in a comment.
// Node APIs and Math.log are allowed here: this is a test, outside the determinism rule.

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = join(PACKAGE_DIR, "data");
const GENERATED_PATH = join(PACKAGE_DIR, "src", "generated", "data.ts");
const BUILD_SCRIPT = join(PACKAGE_DIR, "scripts", "build-data.mjs");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");

interface BuildData {
  renderDataModule(dataDir?: string): string;
  verifyManifest(dataDir?: string, manifest?: unknown): string[];
  listDataFiles(dataDir?: string): string[];
}
const build = (await import(pathToFileURL(BUILD_SCRIPT).href)) as BuildData;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path: string) => sha256(readFileSync(join(DATA_DIR, path)));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const tenths = (x: number) => Math.round(x * 10);

const temps: string[] = [];
function tempCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "meridian-data-"));
  temps.push(dir);
  cpSync(DATA_DIR, dir, { recursive: true });
  return dir;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The checksum each released data version must keep: an edit without a version bump fails here. */
const RELEASED_CHECKSUMS: Record<string, string> = {
  "2026.11.0": "dd158592fa7882bb605d0326440ffb5cf5c74d775771703cbe47639ac139fb37",
};

describe("D1 manifest.json (tax-rmd-ss A1)", () => {
  it("D1 lists every file under data/ and every SHA-256 is the file's (recomputed with node:crypto)", () => {
    const listed = DATA_MANIFEST.files.map((f) => f.path).sort();
    expect(listed).toEqual(build.listDataFiles(DATA_DIR).sort());
    for (const f of DATA_MANIFEST.files) expect(fileSha(f.path), f.path).toBe(f.sha256);
    expect(build.verifyManifest(DATA_DIR)).toEqual([]);
  });

  it("D1 every entry carries its retrieval date and a description; every data entry its source URL", () => {
    for (const f of DATA_MANIFEST.files) {
      expect(f.retrieved, f.path).toBe("2026-11-13");
      expect(f.description?.length ?? 0, f.path).toBeGreaterThan(10);
      if (f.path !== "README.md") expect(f.sourceUrl, f.path).toMatch(/^https:\/\//);
    }
  });

  it("A1 D1 dataVersion is 2026.11.0, firstTaxYear 2026, lastPublishedYear 2027", () => {
    // tax-rmd-ss A1 says 2026.11.1; seams C11 and phase-4-plan "Data files" fix the first version at 2026.11.0.
    expect(DATA_VERSION).toBe("2026.11.0");
    expect(DATA_MANIFEST.firstTaxYear).toBe(2026);
    expect(DATA_MANIFEST.lastPublishedYear).toBe(2027);
    expect(TAX_DATA_FIRST_YEAR).toBe(2026);
  });

  it("D1 DATA_CHECKSUM is the SHA-256 of the files' hashes joined by newlines in manifest order", () => {
    const joined = DATA_MANIFEST.files.map((f) => f.sha256).join("\n");
    expect(DATA_CHECKSUM).toBe(sha256(joined));
  });

  it("D1 any data edit bumps dataVersion: the released version keeps its checksum", () => {
    expect(RELEASED_CHECKSUMS[DATA_VERSION], `record DATA_CHECKSUM ${DATA_CHECKSUM} for a new dataVersion`).toBe(DATA_CHECKSUM);
  });

  it("T13 a manifest whose checksum does not match fails, and so do an unlisted and a missing file", () => {
    const bad = structuredClone(DATA_MANIFEST);
    const entry = bad.files.find((f) => f.path === "us-annual-returns.csv");
    if (!entry) throw new Error("fixture");
    entry.sha256 = "0".repeat(64);
    expect(build.verifyManifest(DATA_DIR, bad)).toEqual([expect.stringMatching(/^us-annual-returns\.csv: SHA-256 .* differs/)]);

    const dir = tempCopy();
    writeFileSync(join(dir, "stray.json"), "{}\n");
    rmSync(join(dir, "tax", "rules.json"));
    const problems = build.verifyManifest(dir);
    expect(problems).toContain("stray.json: not listed in manifest.json");
    expect(problems).toContain("tax/rules.json: listed in manifest.json but missing");
  });

  it("A1 every data file parses with its schema and the loader's invariants hold", () => {
    const data = loadTaxData();
    expect(data.dataVersion).toBe(DATA_VERSION);
    expect([...data.years.keys()]).toEqual([2026, 2027]);
    expect(Object.isFrozen(data.rules)).toBe(true);
    for (const s of data.sources) expect(s.url, s.title).toMatch(/^https:\/\//);
    // Table II's sources come from its meta file (the table keeps the pinned layout).
    const p590b = "d18a592e55ce56d43953dc338272ece3984565792d6dca06989a6ca8121f7360";
    expect(data.sources.filter((s) => s.sha256 === p590b).map((s) => s.file)).toEqual(["rmd/uniform-lifetime.json", "rmd/joint-life.json"]);
  });
});

describe("D13 src/generated/data.ts", () => {
  it("D13 is not stale: build-data.mjs renders exactly the committed module", () => {
    expect(build.renderDataModule(DATA_DIR)).toBe(readFileSync(GENERATED_PATH, "utf8"));
  });

  it("D13 GENERATED_FROM names the manifest's SHA-256 of each CSV input", () => {
    const listed = new Map(DATA_MANIFEST.files.map((f) => [f.path, f.sha256]));
    expect(Object.keys(GENERATED_FROM)).toEqual(["us-annual-returns.csv", "irs-2010cm-life-table.csv"]);
    for (const [file, sha] of Object.entries(GENERATED_FROM)) expect(sha, file).toBe(listed.get(file));
  });

  it("D13 a CSV edited without updating the manifest is refused", () => {
    const dir = tempCopy();
    const path = join(dir, "us-annual-returns.csv");
    writeFileSync(path, readFileSync(path, "utf8").replace("1928,0.438112", "1928,0.438113"));
    expect(() => build.renderDataModule(dir)).toThrow(/us-annual-returns\.csv: SHA-256 .* differs from the manifest/);
  });

  it("D4 is absent (plan decision 11): the SSA arrays are null and the manifest does not list the file", () => {
    expect(LIFE_SSA_MALE_QX).toBeNull();
    expect(LIFE_SSA_FEMALE_QX).toBeNull();
    expect(DATA_MANIFEST.files.some((f) => f.path.startsWith("ssa-period-life-table"))).toBe(false);
  });

  it("D4 the loader accepts the SSA table when it is present and listed (synthetic fixture, not data)", () => {
    const dir = tempCopy();
    // Synthetic q_x (0.0005 + age / 200, capped at 1), only to exercise the reader; no external figure.
    const rows = Array.from({ length: 120 }, (_, age) => {
      const q = Math.min(1, 0.0005 + age / 200);
      return `${age},${q.toFixed(6)},${(q * 0.8).toFixed(6)}`;
    });
    const csv = ["age,male_qx,female_qx", ...rows].join("\n") + "\n";
    const unlisted = join(dir, "ssa-period-life-table.csv");
    writeFileSync(unlisted, csv);
    expect(() => build.renderDataModule(dir)).toThrow(/present but not listed/);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: Array<{ path: string; sha256: string }> };
    manifest.files.push({ path: "ssa-period-life-table.csv", sha256: sha256(csv) });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const text = build.renderDataModule(dir);
    expect(text).toContain('"ssa-period-life-table.csv": "' + sha256(csv) + '"');
    expect(text).toMatch(/export const LIFE_SSA_MALE_QX: Float64Array \| null = new Float64Array\(\[\n {2}0\.0005, 0\.0055,/);
    expect(text).not.toContain("= null;");
  });
});

describe("D2 us-annual-returns.csv (engine-and-returns §2.8, T13)", () => {
  const years = Array.from({ length: US_STOCKS.length }, (_, i) => US_FIRST_YEAR + i);
  const row = (y: number) => {
    const i = y - US_FIRST_YEAR;
    return [US_STOCKS[i], US_BONDS[i], US_BILLS[i], US_INFLATION[i]];
  };

  it("T13 D2 reproduces the pinned SHA-256 of the lost extract", () => {
    expect(fileSha("us-annual-returns.csv")).toBe("ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c");
  });

  it("T13 D2 98 rows, 1928 to 2025, four columns of equal length", () => {
    expect([US_STOCKS.length, US_BONDS.length, US_BILLS.length, US_INFLATION.length]).toEqual([98, 98, 98, 98]);
    expect(US_FIRST_YEAR).toBe(1928);
    expect(US_LAST_YEAR).toBe(2025);
  });

  it.each([
    [1928, 0.438112, 0.008355, 0.0308, -0.011561],
    [1931, -0.438375, -0.025589, 0.0231, -0.093168],
    [1966, -0.09971, 0.029079, 0.048557, 0.034591],
    [1974, -0.259018, 0.019886, 0.078458, 0.123377],
    [2008, -0.365523, 0.201013, 0.014, 0.000914],
    [2022, -0.180375, -0.178282, 0.0209, 0.064544],
    [2025, 0.177237, 0.077955, 0.0421, 0.027351],
  ])("T13 D2 row %i (never the sheet 'Nominal vs Real Data': its 1966 inflation is 3.36%%)", (year, s, b, c, inf) => {
    expect(row(year)).toEqual([s, b, c, inf]);
  });

  it("T13 D2 extremes", () => {
    const at = (a: Float64Array, v: number) => years[a.indexOf(v)];
    expect([Math.min(...US_STOCKS), at(US_STOCKS, Math.min(...US_STOCKS))]).toEqual([-0.438375, 1931]);
    expect([Math.max(...US_STOCKS), at(US_STOCKS, Math.max(...US_STOCKS))]).toEqual([0.525633, 1954]);
    expect([Math.min(...US_BONDS), at(US_BONDS, Math.min(...US_BONDS))]).toEqual([-0.178282, 2022]);
    expect([Math.max(...US_BONDS), at(US_BONDS, Math.max(...US_BONDS))]).toEqual([0.328145, 1982]);
    expect([Math.min(...US_BILLS), at(US_BILLS, Math.min(...US_BILLS))]).toEqual([0.0003, 2014]);
    expect([Math.max(...US_BILLS), at(US_BILLS, Math.max(...US_BILLS))]).toEqual([0.140362, 1981]);
    expect([Math.min(...US_INFLATION), at(US_INFLATION, Math.min(...US_INFLATION))]).toEqual([-0.10274, 1932]);
    expect([Math.max(...US_INFLATION), at(US_INFLATION, Math.max(...US_INFLATION))]).toEqual([0.181319, 1946]);
  });

  it("T13 D2 column sums 11.617562 / 4.725913 / 3.346646 / 3.046171 (exact, in millionths)", () => {
    const micro = (a: Float64Array) => a.reduce((s, v) => s + Math.round(v * 1e6), 0);
    expect([US_STOCKS, US_BONDS, US_BILLS, US_INFLATION].map(micro)).toEqual([11617562, 4725913, 3346646, 3046171]);
  });

  it("T13 D2 arithmetic means 0.118547 / 0.048224 / 0.034149 / 0.031083 and geometric means 0.100177 / 0.045346 / 0.033716 / 0.030357", () => {
    const cols = [US_STOCKS, US_BONDS, US_BILLS, US_INFLATION];
    expect(cols.map((a) => round(a.reduce((s, v) => s + v, 0) / a.length, 6))).toEqual([0.118547, 0.048224, 0.034149, 0.031083]);
    const geo = (a: Float64Array) => Math.exp(a.reduce((s, v) => s + Math.log(1 + v), 0) / a.length) - 1;
    expect(cols.map((a) => round(geo(a), 6))).toEqual([0.100177, 0.045346, 0.033716, 0.030357]);
  });

  it("T13 D2 the estimator figures of engine-and-returns §3.5, recomputed from the file to four decimals or better", () => {
    // Reference computation of §3.5 'historical' (log means, sample sd with n - 1, phi_pi as the lag-1
    // coefficient, shocks for t = 2..N, Pearson correlations); step 13's estimateLogMoments must match.
    const n = US_STOCKS.length;
    const logs = [US_STOCKS, US_BONDS, US_BILLS, US_INFLATION].map((a) => Array.from(a, (v) => Math.log(1 + v)));
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mu = logs.map(mean);
    const sd = logs.map((a, j) => Math.sqrt(a.reduce((s, v) => s + (v - (mu[j] as number)) ** 2, 0) / (n - 1)));
    const li = logs[3] as number[];
    const mi = mu[3] as number;
    let num = 0;
    for (let t = 1; t < n; t++) num += ((li[t] as number) - mi) * ((li[t - 1] as number) - mi);
    const phi = num / li.reduce((s, v) => s + (v - mi) ** 2, 0);
    const eps = li.slice(1).map((v, k) => v - mi - phi * ((li[k] as number) - mi));
    const pearson = (a: number[], b: number[]) => {
      const ma = mean(a);
      const mb = mean(b);
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      a.forEach((x, k) => {
        const y = b[k] as number;
        sab += (x - ma) * (y - mb);
        saa += (x - ma) ** 2;
        sbb += (y - mb) ** 2;
      });
      return sab / Math.sqrt(saa * sbb);
    };
    const [lS, lB, lC] = logs as [number[], number[], number[], number[]];
    expect(mu.map((v) => round(v, 6))).toEqual([0.095471, 0.044348, 0.03316, 0.029906]);
    expect(sd.map((v) => round(v, 6))).toEqual([0.188737, 0.074201, 0.028969, 0.037719]);
    expect(round(phi, 4)).toBe(0.619);
    const shock = (sd[3] as number) * Math.sqrt(1 - phi * phi);
    expect(round(shock, 6)).toBe(0.029624);
    const rho = {
      sb: pearson(lS, lB), sc: pearson(lS, lC), bc: pearson(lB, lC),
      se: pearson(lS.slice(1), eps), be: pearson(lB.slice(1), eps), ce: pearson(lC.slice(1), eps),
    };
    expect(Object.values(rho).map((v) => round(v, 4))).toEqual([0.0224, -0.0043, 0.2664, 0.0164, -0.2066, 0.1247]);
    // Cholesky of Sigma_ij = rho_ij s_i s_j with s = (sigma_S, sigma_B, sigma_C, sigma_pi sqrt(1 - phi^2)) (phi_C = 0).
    const R = [
      [1, rho.sb, rho.sc, rho.se],
      [rho.sb, 1, rho.bc, rho.be],
      [rho.sc, rho.bc, 1, rho.ce],
      [rho.se, rho.be, rho.ce, 1],
    ];
    const s = [sd[0], sd[1], sd[2], shock] as number[];
    const L = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j <= i; j++) {
        let v = (R[i] as number[])[j]! * s[i]! * s[j]!;
        for (let k = 0; k < j; k++) v -= L[i]![k]! * L[j]![k]!;
        L[i]![j] = i === j ? Math.sqrt(v) : v / L[j]![j]!;
      }
    }
    expect(L.map((r, i) => r.slice(0, i + 1).map((v) => round(v, 6)))).toEqual([
      [0.188737],
      [0.001661, 0.074182],
      [-0.000125, 0.007722, 0.027921],
      [0.000487, -0.006133, 0.005532, 0.028446],
    ]);
    // Conservative preset: geometric means 5.5%, 4.5%, 3.2%, 2.5% with the simple-return sds;
    // mu = ln(1 + G), sigma^2 = ln((1 + sqrt(1 + 4 S^2 / (1 + G)^2)) / 2).
    const simpleSd = [US_STOCKS, US_BONDS, US_BILLS, US_INFLATION].map((a) => {
      const m = a.reduce((t, v) => t + v, 0) / n;
      return Math.sqrt(a.reduce((t, v) => t + (v - m) ** 2, 0) / (n - 1));
    });
    expect(simpleSd.map((v) => round(v, 6))).toEqual([0.194034, 0.079024, 0.030358, 0.038953]);
    const cons = [0.055, 0.045, 0.032, 0.025].map((g, j) => {
      const S = simpleSd[j] as number;
      return [round(Math.log(1 + g), 6), round(Math.sqrt(Math.log((1 + Math.sqrt(1 + (4 * S * S) / (1 + g) ** 2)) / 2)), 6)];
    });
    expect(cons).toEqual([
      [0.053541, 0.179523],
      [0.044017, 0.0753],
      [0.031499, 0.029398],
      [0.024693, 0.037961],
    ]);
    expect(round(0.037961 * Math.sqrt(1 - 0.619 * 0.619), 4)).toBe(round(0.029814, 4));
  });
});

describe("D3 irs-2010cm-life-table.csv (T13)", () => {
  const lx = LIFE_2010CM_LX;
  const q = (x: number) => (x >= 109 ? 1 : 1 - (lx[x + 1] as number) / (lx[x] as number));

  it("T13 D3 reproduces the pinned SHA-256 of the lost extract", () => {
    expect(fileSha("irs-2010cm-life-table.csv")).toBe("3ba08d9b67a2ff1c465b177563c8c6364eb99427c1ceda1cd05fd4b529b5a978");
  });

  it("T13 D3 111 rows; lx[0] = 100000; strictly decreasing; the listed cells", () => {
    expect(lx.length).toBe(111);
    expect(lx[0]).toBe(100000);
    for (let x = 1; x < 111; x++) expect(lx[x]!).toBeLessThan(lx[x - 1]!);
    expect([lx[65], lx[85], lx[95], lx[100], lx[109], lx[110]]).toEqual([84221.59, 41399.79, 8975.661, 1882.108, 15.47804, 0]);
  });

  it("T13 D3 q[65] = 0.012814, q[85] = 0.084651, q[108] = 0.487009, q[109] = 1; q non-decreasing from 11", () => {
    expect([65, 85, 108].map((x) => round(q(x), 6))).toEqual([0.012814, 0.084651, 0.487009]);
    expect(q(109)).toBe(1);
    for (let x = 12; x <= 109; x++) expect(q(x), `age ${x}`).toBeGreaterThanOrEqual(q(x - 1));
  });

  it("T13 D3 survival 65 to 95 = 0.1066; life expectancy at 65 = 19.11", () => {
    expect(round(lx[95]! / lx[65]!, 4)).toBe(0.1066);
    let sum = 0;
    for (let x = 66; x <= 110; x++) sum += lx[x]!;
    expect(round(sum / lx[65]! + 0.5, 2)).toBe(19.11);
  });
});

describe("D5 and D6 tax/federal-2026.json and tax/federal-2027.json (tax-rmd-ss A2)", () => {
  const data = loadTaxData();
  const y = (year: number) => {
    const r = data.years.get(year);
    if (!r) throw new Error(`no ${year} file`);
    return r;
  };
  /** Tax at each threshold 2..7 in cents: sum of rate x width of the brackets below (rates are whole percents). */
  const cumulativeCents = (year: number, s: "single" | "mfj") => {
    const t = y(year).ordinary.thresholds[s];
    const pct = y(year).ordinary.rates.map((r) => Math.round(r * 100));
    const out: number[] = [];
    let acc = 0;
    for (let i = 1; i < 7; i++) {
      acc += pct[i - 1]! * (t[i]! - t[i - 1]!);
      out.push(acc);
    }
    return out;
  };

  it.each([
    [2026, "single", [1240, 5800, 17966, 41024, 58448, 192979.25]],
    [2026, "mfj", [2480, 11600, 35932, 82048, 116896, 206583.5]],
    [2027, "single", [1280, 5987, 18549, 42357, 60349, 199237.75]],
    [2027, "mfj", [2560, 11974, 37098, 84714, 120698, 213290.5]],
  ] as const)("A2 %i %s: the cumulative tax at thresholds 2 to 7 equals the published amounts", (year, s, expected) => {
    expect(cumulativeCents(year, s)).toEqual(expected.map((d) => Math.round(d * 100)));
  });

  it.each([2026, 2027])("A2 %i: single thresholds 1 to 5 are half the joint ones; joint standard deduction and 0%% maximum are twice the single", (year) => {
    const r = y(year);
    for (let i = 1; i <= 5; i++) expect(r.ordinary.thresholds.single[i]! * 2).toBe(r.ordinary.thresholds.mfj[i]);
    expect(r.ordinary.thresholds.single[6]! * 2).not.toBe(r.ordinary.thresholds.mfj[6]);
    expect(r.standardDeduction.single * 2).toBe(r.standardDeduction.mfj);
    expect(r.capitalGains.zeroRateMax.single * 2).toBe(r.capitalGains.zeroRateMax.mfj);
    for (const s of ["single", "mfj"] as const) {
      const t = r.ordinary.thresholds[s];
      expect(t.every((v, i) => i === 0 || v > t[i - 1]!)).toBe(true);
    }
  });

  it("D5 2026: standard deduction 16,100 / 32,200; 0% maximum 49,450 / 98,900; 15% maximum 545,500 / 613,700; pending empty", () => {
    const r = y(2026);
    expect(r.standardDeduction).toEqual({ single: 16100, mfj: 32200 });
    expect(r.additionalAged).toEqual({ single: 2050, mfj: 1650 });
    expect(r.capitalGains.zeroRateMax).toEqual({ single: 49450, mfj: 98900 });
    expect(r.capitalGains.fifteenRateMax).toEqual({ single: 545500, mfj: 613700 });
    expect(r.contributionLimits.pending).toEqual([]);
    expect(r.payroll.oasdiWageBase).toBe(184500);
  });

  it("D6 2027: standard deduction 16,600 / 33,200; 0% maximum 51,050 / 102,100; 15% maximum 563,200 / 633,600; six plan fields pending at the 2026 amounts", () => {
    const r = y(2027);
    const p = y(2026);
    expect(r.standardDeduction).toEqual({ single: 16600, mfj: 33200 });
    expect(r.additionalAged).toEqual({ single: 2100, mfj: 1700 });
    expect(r.capitalGains.zeroRateMax).toEqual({ single: 51050, mfj: 102100 });
    expect(r.capitalGains.fifteenRateMax).toEqual({ single: 563200, mfj: 633600 });
    const six = ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50"] as const;
    expect(r.contributionLimits.pending).toEqual([...six]);
    for (const f of six) expect(r.contributionLimits[f], f).toBe(p.contributionLimits[f]);
    expect([r.contributionLimits.hsaSelf, r.contributionLimits.hsaFamily]).toEqual([4500, 9000]);
  });

  it("D5 D6 the statutory amounts are the same in both years (tax-rmd-ss decision 8)", () => {
    const [a, b] = [y(2026), y(2027)];
    expect(b.seniorDeduction).toEqual(a.seniorDeduction);
    expect(b.niit).toEqual(a.niit);
    expect(b.socialSecurityTaxation).toEqual(a.socialSecurityTaxation);
    expect(b.additionalTaxes).toEqual(a.additionalTaxes);
    expect(b.capitalGains.netLossLimit).toBe(a.capitalGains.netLossLimit);
    expect(b.ordinary.rates).toEqual(a.ordinary.rates);
    expect(b.contributionLimits.hsaCatchUp55).toBe(1000);
  });

  it("A2 a year file whose single threshold is not half the joint one is refused", () => {
    const raw = structuredClone(rawTaxData());
    const y27 = raw.years["tax/federal-2027.json"] as { ordinary: { thresholds: { single: number[] } } };
    y27.ordinary.thresholds.single[2] = 52050;
    expect(() => validateTaxData(raw)).toThrow(/tax\/federal-2027\.json: single threshold 2 must be half the joint one/);
  });
});

describe("D7 tax/rules.json (tax-rmd-ss A6, J1)", () => {
  const data = loadTaxData();

  it("A6 listTaxRuleSets returns the four ids, current_law first, and every law-change id resolves", () => {
    expect(listTaxRuleSets().map((r) => r.id)).toEqual(["current_law", "senior_deduction_permanent", "ss_shortfall_2033", "rates_plus_2pts_2031"]);
    for (const set of data.rules.ruleSets) {
      expect(set.id).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      for (const id of set.lawChanges) expect(data.rules.lawChanges[id], id).toBeDefined();
    }
    expect(data.rules.staleInflation).toBe(0.025);
  });

  it("A6 a rules file with path ordinary.rate fails to load", () => {
    const raw = structuredClone(rawTaxData());
    const rules = raw.rules as { lawChanges: Record<string, { ops: Array<{ path?: string }> }> };
    rules.lawChanges.senior_deduction_sunset!.ops[0]!.path = "ordinary.rate";
    let err: unknown;
    try {
      validateTaxData(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaxDataError);
    expect((err as TaxDataError).code).toBe("tax_data_invalid");
    expect((err as TaxDataError).message).toMatch(/^tax\/rules\.json: lawChanges\.senior_deduction_sunset\.ops\.0\.path/);
  });

  it("D7 an unknown law change in a rule set, a missing current_law and an indexed path absent from the year files are refused", () => {
    const withRules = (edit: (r: { ruleSets: Array<{ id: string; lawChanges: string[] }>; indexing: Array<{ path: string }> }) => void) => {
      const raw = structuredClone(rawTaxData());
      edit(raw.rules as never);
      return () => validateTaxData(raw);
    };
    expect(withRules((r) => r.ruleSets[1]!.lawChanges.push("no_such_change"))).toThrow(/unknown law change no_such_change/);
    expect(withRules((r) => (r.ruleSets[0]!.id = "current"))).toThrow(/current_law must be present/);
    expect(withRules((r) => (r.indexing[0]!.path = "ordinary.thresholdz"))).toThrow(/indexed path ordinary\.thresholdz is not an amount/);
  });

  it("D7 every indexed path exists in both year files", () => {
    for (const rule of data.rules.indexing) {
      for (const year of [2026, 2027]) expect(yearValueAt(data.years.get(year)!, rule.path), `${rule.path} ${year}`).toBeDefined();
    }
  });

  it("J1 D7 inflation +3.0%, +2.5%, -1.0% reproduces the 2028 to 2030 rows with the file's rounding steps", () => {
    // value_Y = value_2027 + floor(value_2027 x (F_Y - 1) / step + 1e-9) x step (tax-rmd-ss decision 7),
    // F_2028 = 1.03, F_2029 = 1.03 x 1.025 = 1.05575, F_2030 = 1.05575 x 0.99 = 1.0451925.
    const y27 = data.years.get(2027)!;
    const step = (path: string, s: "single" | "mfj") => {
      const rule = data.rules.indexing.find((r) => r.path === path);
      if (!rule || rule.round !== "floor_increase") throw new Error(path);
      return typeof rule.step === "number" ? rule.step : rule.step[s];
    };
    const idx = (v: number, F: number, st: number) => v + Math.floor((v * (F - 1)) / st + 1e-9) * st;
    const row = (F: number) => ({
      single: y27.ordinary.thresholds.single.slice(1).map((v) => idx(v, F, step("ordinary.thresholds", "single"))),
      mfj: y27.ordinary.thresholds.mfj.slice(1).map((v) => idx(v, F, step("ordinary.thresholds", "mfj"))),
      std: (["single", "mfj"] as const).map((s) => idx(y27.standardDeduction[s], F, step("standardDeduction", s))),
      aged: (["single", "mfj"] as const).map((s) => idx(y27.additionalAged[s], F, step("additionalAged", s))),
      zero: (["single", "mfj"] as const).map((s) => idx(y27.capitalGains.zeroRateMax[s], F, step("capitalGains.zeroRateMax", s))),
      fifteen: (["single", "mfj"] as const).map((s) => idx(y27.capitalGains.fifteenRateMax[s], F, step("capitalGains.fifteenRateMax", s))),
    });
    expect(row(1.03)).toEqual({
      single: [13175, 53575, 112375, 214550, 272475, 681200],
      mfj: [26350, 107150, 224750, 429100, 544950, 817450],
      std: [17050, 34100], aged: [2150, 1750], zero: [52575, 105150], fifteen: [580050, 652600],
    });
    expect(row(1.03 * 1.025)).toEqual({
      single: [13500, 54925, 115200, 219925, 279275, 698225],
      mfj: [27000, 109850, 230400, 439850, 558550, 837850],
      std: [17500, 35000], aged: [2200, 1750], zero: [53875, 107750], fifteen: [594550, 668900],
    });
    expect(row(1.03 * 1.025 * 0.99)).toEqual({
      single: [13375, 54375, 114050, 217725, 276500, 691250],
      mfj: [26750, 108750, 228100, 435450, 553000, 829500],
      std: [17350, 34700], aged: [2150, 1750], zero: [53350, 106700], fifteen: [588650, 662200],
    });
  });
});

describe("D8 ss/rules.json (tax-rmd-ss A5; plan decision 11)", () => {
  const data = loadTaxData();

  it("A5 fraMonths: 1937 780; 1938 782; 1943 and 1954 792; 1955 794; 1957 798; 1959 802; 1960 and 1975 804", () => {
    expect([1937, 1938, 1943, 1954, 1955, 1957, 1959, 1960, 1975].map((y) => fraMonths(y))).toEqual([780, 782, 792, 792, 794, 798, 802, 804, 804]);
  });

  it("A5 survivorFraMonths: 1945 and 1956 792; 1957 794; 1960 800; 1961 802; 1962 804; the retirement table at birthYear - 2", () => {
    expect([1945, 1956, 1957, 1960, 1961, 1962].map((y) => survivorFraMonths(y))).toEqual([792, 792, 794, 800, 802, 804]);
    for (let y = 1900; y <= 2010; y++) expect(survivorFraMonths(y)).toBe(fraMonths(y - 2));
  });

  it("A5 fullRetirementAgeTable has 13 rows from 1900 and ends { 1960, null, 67, 0 }", () => {
    const t = fullRetirementAgeTable();
    expect(t).toHaveLength(13);
    expect(t[0]).toEqual({ fromBirthYear: 1900, toBirthYear: 1937, years: 65, months: 0 });
    expect(t[6]).toEqual({ fromBirthYear: 1943, toBirthYear: 1954, years: 66, months: 0 });
    expect(t[12]).toEqual({ fromBirthYear: 1960, toBirthYear: null, years: 67, months: 0 });
  });

  it("D8 the claim-age factors for a full retirement age of 67 are 7/10, 3/4, 4/5, 13/15, 14/15, 1, 27/25, 29/25, 31/25", () => {
    // Exact rationals in 1/180000ths (lcm of 900, 1200 and 150 is 3600; 180000 keeps every step whole).
    const D = 180000;
    const part = (f: string) => {
      const [n, d] = f.split("/").map(Number) as [number, number];
      return (n * D) / d;
    };
    const ss = data.ss;
    const fra = 804;
    const factor = (claim: number) => {
      const early = Math.max(0, fra - claim);
      const late = Math.max(0, Math.min(claim, ss.latestCreditMonths) - fra);
      const first = Math.min(early, ss.earlyReduction.firstMonths);
      return D - first * part(ss.earlyReduction.first) - (early - first) * part(ss.earlyReduction.later) + late * part(ss.delayedCreditPerMonth);
    };
    const expected = [[7, 10], [3, 4], [4, 5], [13, 15], [14, 15], [1, 1], [27, 25], [29, 25], [31, 25]];
    expect([744, 756, 768, 780, 792, 804, 816, 828, 840].map(factor)).toEqual(expected.map(([n, d]) => (n! * D) / d!));
    expect(ss.earliestRetirementMonths).toBe(744);
    expect(ss.latestCreditMonths).toBe(840);
    expect(1 - fractionValue(ss.survivor.maxReduction)).toBeCloseTo(0.715, 12);
    expect(fractionValue(ss.survivor.widowLimitShare)).toBeCloseTo(0.825, 12);
    expect(fractionValue(ss.spousalShare)).toBe(0.5);
  });

  it("D8 COLA history is contiguous 2017 to 2025 and ends the year before the first year file", () => {
    expect(data.ss.colaHistory).toEqual({
      "2017": 0.003, "2018": 0.02, "2019": 0.028, "2020": 0.016, "2021": 0.013,
      "2022": 0.059, "2023": 0.087, "2024": 0.032, "2025": 0.025,
    });
    expect(data.years.get(2026)!.socialSecurity.cola).toBe(0.028);
    expect(data.years.get(2027)!.socialSecurity.cola).toBe(0.036);
  });

  it("D8 every figure carries a verification mark; secondary names two sources; no COLA year is unverified", () => {
    const ss = data.ss;
    const keys = ssFigureKeys(ss);
    expect(Object.keys(ss.verification).sort()).toEqual([...keys].sort());
    const titles = new Set(ss.sources.map((s) => s.title));
    for (const key of keys) {
      const v = ss.verification[key]!;
      for (const s of v.sources) expect(titles.has(s), `${key}: ${s}`).toBe(true);
      if (v.status === "secondary") expect(v.sources.length, key).toBeGreaterThanOrEqual(2);
      if (key.startsWith("colaHistory.")) expect(v.status, key).not.toBe("unverified");
    }
    // What stays flagged for the owner (docs/phase-4-gate.md): the four FRA rows 1939 to 1942 and the survivor shift.
    expect(keys.filter((k) => ss.verification[k]!.status === "unverified")).toEqual([
      "retirementFraMonths.1939", "retirementFraMonths.1940", "retirementFraMonths.1941", "retirementFraMonths.1942", "survivorFraBirthYearShift",
    ]);
  });

  it("D8 a COLA year marked unverified is refused (it must be deleted instead), and so is a secondary mark with one source", () => {
    const edit = (f: (ss: { verification: Record<string, { status: string; sources: string[] }> }) => void) => {
      const raw = structuredClone(rawTaxData());
      f(raw.ss as never);
      return () => validateTaxData(raw);
    };
    expect(edit((ss) => (ss.verification["colaHistory.2017"] = { status: "unverified", sources: [] }))).toThrow(/colaHistory\.2017 is unverified/);
    expect(edit((ss) => (ss.verification["colaHistory.2020"]!.sources = ["WICPA 2020 COLA"]))).toThrow(/colaHistory\.2020 is secondary but names fewer than two/);
    expect(edit((ss) => delete ss.verification.earningsTest)).toThrow(/figure earningsTest has no verification mark/);
  });
});

describe("D9 rmd/uniform-lifetime.json (tax-rmd-ss A3)", () => {
  const u = loadTaxData().uniform;
  const at = (age: number) => u.divisors[age - u.firstAge];

  it("A3 D9 49 divisors for 72 to 120, strictly decreasing, sum 532.0", () => {
    expect([u.firstAge, u.lastAge, u.divisors.length]).toEqual([72, 120, 49]);
    expect(u.divisors.every((d, i) => i === 0 || d < u.divisors[i - 1]!)).toBe(true);
    expect(u.divisors.reduce((s, d) => s + tenths(d), 0)).toBe(5320);
  });

  it("A3 D9 27.4 at 72, 26.5 at 73, 24.6 at 75, 20.2 at 80, 16.0 at 85, 12.9 at 89, 6.4 at 100, 2.0 at 120", () => {
    expect([72, 73, 75, 80, 85, 89, 100, 120].map(at)).toEqual([27.4, 26.5, 24.6, 20.2, 16, 12.9, 6.4, 2]);
  });

  it("D9 start ages 72 (born 1950 or earlier), 73 (1951 to 1959), 75 (1960 and later)", () => {
    expect(u.startAge).toEqual([[1950, 72], [1959, 73], [9999, 75]]);
    expect(u.jointTableSpouseGapYears).toBe(10);
  });
});

describe("D10 rmd/joint-life.json (tax-rmd-ss A4)", () => {
  const data = loadTaxData();
  const rows = data.joint.rows;
  const cell = (a: number, b: number) => rows[a - 20]![b - 20]!;

  it("D10 reproduces the pinned layout byte for byte (60,575 bytes)", () => {
    const bytes = readFileSync(join(DATA_DIR, "rmd", "joint-life.json"));
    expect(bytes.length).toBe(60575);
    expect(sha256(bytes)).toBe("bd8af7bf76d6d97c5e822834def6975ce09e7821c39917bc32faf5f247ee5350");
  });

  it("A4 D10 101 x 101, symmetric, every row non-increasing, sum of all cells 368,500.6", () => {
    expect(rows).toHaveLength(101);
    let sum = 0;
    for (let a = 20; a <= 120; a++) {
      expect(rows[a - 20]).toHaveLength(101);
      for (let b = 20; b <= 120; b++) {
        expect(cell(a, b)).toBe(cell(b, a));
        if (b > 20) expect(cell(a, b)).toBeLessThanOrEqual(cell(a, b - 1));
        sum += tenths(cell(a, b));
      }
    }
    expect(sum).toBe(3685006);
  });

  it.each([
    [75, 64, 25.3], [73, 62, 27.2], [73, 60, 28.6], [73, 50, 36.8], [80, 65, 23.8],
    [85, 70, 19.5], [90, 75, 15.4], [100, 85, 8.5], [20, 20, 72.0], [120, 120, 1.0],
  ])("A4 D10 (%i, %i) = %d", (a, b, v) => {
    expect(cell(a, b)).toBe(v);
  });

  it("A4 D10 rows[a][a - 10] equals the Uniform divisor for 72 to 120 except 112 (3.2 against 3.3)", () => {
    const u = data.uniform;
    const differs: number[] = [];
    for (let a = 72; a <= 120; a++) if (cell(a, a - 10) !== u.divisors[a - 72]) differs.push(a);
    expect(differs).toEqual([112]);
    expect([cell(112, 102), u.divisors[112 - 72]]).toEqual([3.2, 3.3]);
  });

  it("D10 the schema accepts the fallback (no rows) and refuses an asymmetric table", () => {
    const raw = structuredClone(rawTaxData());
    (raw.joint as { rows: number[][] }).rows = [];
    expect(validateTaxData(raw).joint.rows).toEqual([]);
    const bad = structuredClone(rawTaxData());
    (bad.joint as { rows: number[][] }).rows[0]![5] = 70.1;
    expect(() => validateTaxData(bad)).toThrow(/rmd\/joint-life\.json: not symmetric at \(20, 25\)/);
  });
});

describe("D11 taxable/tax-drag.json (tax-rmd-ss 2.6 with seams C17, C18, C19)", () => {
  const drag = loadTaxData().drag;

  it("D11 six classes; shares in [0, 1]; yields in [0, 0.15]; fallbackCashYield removed", () => {
    expect(Object.keys(drag.classes)).toEqual([...AssetClass.options]);
    for (const [name, c] of Object.entries(drag.classes)) {
      for (const share of [c.qualifiedShare, c.taxExemptShare]) expect(share, name).toBeGreaterThanOrEqual(0);
      for (const share of [c.qualifiedShare, c.taxExemptShare]) expect(share, name).toBeLessThanOrEqual(1);
      expect(c.dividendYield, name).toBeGreaterThanOrEqual(0);
      expect(c.dividendYield, name).toBeLessThanOrEqual(0.15);
    }
    expect(drag).not.toHaveProperty("fallbackCashYield");
    expect(drag.classes.bonds).toMatchObject({ interest: "prior_bill_plus_spread", interestSpread: 0.01 });
    expect(drag.classes.cash.interest).toBe("bill_return");
    expect([drag.classes.us_stock.dividendYield, drag.classes.intl_stock.dividendYield, drag.classes.real_estate.dividendYield]).toEqual([0.013, 0.028, 0.035]);
    expect([drag.classes.us_stock.qualifiedShare, drag.classes.intl_stock.qualifiedShare, drag.classes.real_estate.qualifiedShare]).toEqual([0.95, 0.75, 0]);
  });

  it("D11 basis shares at the first death and the nine community-property states of Pub. 551", () => {
    expect(drag.basisStepUp).toEqual({
      ownAccount: 1, jointAccount: 0.5, jointAccountCommunityProperty: 1,
      communityPropertyStates: ["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"],
    });
  });
});

describe("A7 staleness and pending limits", () => {
  it("A7 the tables are stale from 2028-01-01, not on 2027-12-31", () => {
    expect(taxDataStale("2027-12-31")).toBe(false);
    expect(taxDataStale("2028-01-01")).toBe(true);
    expect(() => taxDataStale("2028-13-01")).toThrow(RangeError);
  });

  it("A7 pendingLimits is one entry for 2027 with the six plan fields", () => {
    expect(pendingLimits()).toEqual([{ year: 2027, fields: ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50"] }]);
  });
});

describe("seams §9 item 20: static JSON imports under the repository's toolchain", () => {
  it("the esbuild bundle of scripts/bundle.mjs carries the JSON tables and the generated series", () => {
    // The bundle keeps zod external (as in production), so it must sit where Node resolves the
    // package's dependencies: a scratch directory under the package's own node_modules.
    const cache = join(PACKAGE_DIR, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, "meridian-bundle-"));
    temps.push(dir);
    const entry = join(dir, "entry.ts");
    const index = join(PACKAGE_DIR, "src", "index.ts");
    const generated = join(PACKAGE_DIR, "src", "generated", "data.ts");
    writeFileSync(
      entry,
      [
        `import { DATA_VERSION, loadTaxData, listTaxRuleSets, selfTest } from ${JSON.stringify(index)};`,
        `import { US_STOCKS } from ${JSON.stringify(generated)};`,
        "selfTest();",
        "const d = loadTaxData();",
        "console.log(JSON.stringify([DATA_VERSION, d.joint.rows.length, d.years.get(2027)?.standardDeduction.mfj, listTaxRuleSets().length, US_STOCKS[0]]));",
      ].join("\n"),
    );
    const out = join(dir, "out.mjs");
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "bundle.mjs"), entry, out], { cwd: REPO_ROOT, stdio: "pipe" });
    const printed = execFileSync(process.execPath, [out], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(printed)).toEqual(["2026.11.0", 101, 33200, 4, 0.438112]);
  });
});
