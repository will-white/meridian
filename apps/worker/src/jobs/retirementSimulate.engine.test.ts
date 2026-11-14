import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { job, putProfile, requestRun, simRun, simRunPath, simRunSeries, storedPercentilePaths, type AuditContext, type Db } from "@meridian/db";
import { createTestDb, RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { contributionLimit, DATA_VERSION, ENGINE_VERSION, listTaxRuleSets, TAX_DATA_FIRST_YEAR, validateInput } from "@meridian/retirement";
import { decodeI16le, decodeI64le, NEVER_DEPLETED, type PlannerEnv, type SimSummary, type YearTable } from "@meridian/shared";
import { loadRetirementConfig, type WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";

/**
 * Seams §11 step 27 on the real engine: one run of the inputs fixture through the job, inline on
 * the job's thread (the default of a context without `sim` and of a config without thread entry),
 * and the same run on 2 threads started from the worker's bundled thread entry, which must store
 * the same series, summary, fan and percentile tables byte for byte (L5).
 *
 * The thread entry is bundled by scripts/bundle.mjs from src/simThread.ts, as `pnpm build` makes
 * dist/simThread.js. It keeps every npm package external, as in the image, so it is written under
 * this app's node_modules, where Node resolves the worker's own dependencies (zod, re2js).
 */

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = path.join(APP_DIR, "..", "..");
const TODAY = RETIREMENT_SEED_TODAY;

/** The planner environment from the real engine, as the API builds `app.planner` (inputs-and-data §6.1). */
const ENV: PlannerEnv = {
  engineVersion: ENGINE_VERSION,
  dataVersion: DATA_VERSION,
  ruleSets: listTaxRuleSets().map((r) => r.id),
  minStartYear: TAX_DATA_FIRST_YEAR,
  contributionLimit: (year, age, kind) => contributionLimit(year, age, kind),
  validateInput,
};
const q = { today: TODAY, now: RETIREMENT_SEED_NOW, env: ENV };
let batch = 0;
const audit = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-9000-${String(++batch).padStart(12, "0")}` });

const config: WorkerConfig = {
  databaseUrl: "unused",
  secretsKey: "unused",
  workerId: "test-worker",
  syncIntervalHours: 6,
  pollIntervalMs: 10,
  initialWindowDays: 93,
  overlapDays: 7,
  requestTimeoutMs: 5000,
};

interface StoredRun {
  row: typeof simRun.$inferSelect;
  series: Map<string, Uint8Array>;
  paths: Array<typeof simRunPath.$inferSelect>;
}

describe.skipIf(!TEST_DATABASE_URL)("retirement.simulate on the real engine (seams §11 step 27)", () => {
  let t: TestDb;
  let db: Db;
  let scenarioId: string;
  let bundleDir: string;
  let threadEntry: URL;
  let inline: StoredRun;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };

  async function stored(runId: string): Promise<StoredRun> {
    const [row] = await db.select().from(simRun).where(eq(simRun.id, runId));
    const series = await db.select().from(simRunSeries).where(eq(simRunSeries.runId, runId));
    const paths = await db.select().from(simRunPath).where(eq(simRunPath.runId, runId)).orderBy(asc(simRunPath.percentile));
    return { row: row!, series: new Map(series.map((s) => [s.kind, s.data])), paths };
  }

  /** Requests a run of the default scenario and drains the queue with `ctx`; returns the run and what the runner logged for it. */
  async function runThroughJob(ctx: JobContext): Promise<{ runId: string; outcome: unknown }> {
    const r = await requestRun(db, { ...q, scenarioId, refresh: false, force: true }, audit());
    expect(r.created).toBe(true);
    logs.length = 0;
    await drainQueue(ctx);
    const line = logs.find((l) => l.startsWith("[job] retirement.simulate "));
    expect(line, logs.join("\n")).toMatch(/ done in \d+ms /);
    const [j] = await db.select().from(job).where(eq(job.id, (await stored(r.run.id)).row.jobId!));
    expect(j).toMatchObject({ status: "done", attempts: 1 });
    return { runId: r.run.id, outcome: JSON.parse(line!.slice(line!.indexOf("{"))) as unknown };
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const seed = await seedRetirementFixture(db);
    const p = await putProfile(db, { ...q, doc: retirementFixtureDoc(seed), expectedRevision: 0 }, audit());
    scenarioId = p.defaultScenarioId!;

    const cache = path.join(APP_DIR, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    bundleDir = mkdtempSync(path.join(cache, "meridian-simthread-"));
    const outfile = path.join(bundleDir, "simThread.js");
    const built = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "bundle.mjs"), path.join(APP_DIR, "src", "simThread.ts"), outfile], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    // The second bundle has its source map beside it, as in the image (audit a9-dependencies-02).
    expect(existsSync(`${outfile}.map`)).toBe(true);
    threadEntry = pathToFileURL(outfile);
  }, 120_000);
  afterAll(async () => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    await t?.cleanup();
  });

  it("bundled, the worker finds its thread entry beside itself: env.ts in a bundle next to simThread.js runs 2 threads from it", () => {
    // A bundle of env.ts in the folder of the thread entry stands for dist/main.js beside dist/simThread.js.
    const probe = path.join(bundleDir, "probe.ts");
    writeFileSync(
      probe,
      [
        `import { describeRetirementConfig, loadRetirementConfig, SIM_THREAD_ENTRY } from ${JSON.stringify(path.join(APP_DIR, "src", "env.ts"))};`,
        'const r = loadRetirementConfig({ RETIREMENT_THREADS: "2" });',
        "console.log(JSON.stringify({ entry: SIM_THREAD_ENTRY.href, config: { ...r.config, threadEntry: r.config.threadEntry?.href ?? null }, notes: r.notes, line: describeRetirementConfig(r.config) }));",
      ].join("\n"),
    );
    const main = path.join(bundleDir, "main.js");
    const built = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "bundle.mjs"), probe, main], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const ran = spawnSync(process.execPath, [main], { cwd: bundleDir, encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      entry: threadEntry.href,
      config: { threads: 2, threadEntry: threadEntry.href, runMaxMs: 900_000, keepRuns: 20 },
      notes: [],
      line: `retirement simulations run on 2 threads from ${threadEntry.href}, stop after 900000 ms, keep 20 finished runs per scenario`,
    });
  });

  it("one run of the fixture inline through the job: 10,000 paths, the four series, the seven stored tables checked against them", async () => {
    // No `sim` and no thread entry in the config: the real engine, inline.
    const { runId, outcome } = await runThroughJob({ db, config, client: {}, now: () => new Date(), log });
    expect(outcome).toMatchObject({ runId, outcome: "done", paths: 10_000, threads: 0 });
    inline = await stored(runId);
    const { row } = inline;
    expect(row).toMatchObject({ status: "done", engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, threads: 0, paths: 10_000, pathsDone: 10_000, errorCode: null });
    expect(row.durationMs).toBeGreaterThan(0);

    const endings = decodeI64le(inline.series.get("ending_real_cents")!);
    const depletion = decodeI16le(inline.series.get("depletion_year")!);
    expect([...inline.series.keys()].sort()).toEqual(["depletion_year", "ending_real_cents", "lifetime_spending_real_cents", "lifetime_tax_real_cents"]);
    for (const data of inline.series.values()) expect(data.byteLength).toBeGreaterThanOrEqual(20_000);
    expect(endings).toHaveLength(10_000);
    expect(depletion).toHaveLength(10_000);
    // A path succeeds exactly when it never depletes (the loop's success flag is failIdx < 0).
    expect(row.successPaths).toBe(depletion.filter((d) => d === NEVER_DEPLETED).length);
    expect(row.successPaths).toBeGreaterThan(0);

    // The stored rows are the series' own percentile paths, each with its re-simulated table: 2026 to 2072.
    const expected = storedPercentilePaths(endings, depletion);
    expect(inline.paths.map((p) => [p.percentile, p.pathIndex, p.rank])).toEqual(expected.map((e) => [e.percentile, e.pathIndex, e.rank]));
    for (const p of inline.paths) {
      expect(p.endingRealCents).toBe(endings[p.pathIndex]);
      expect(p.depletionYear).toBe(depletion[p.pathIndex] === NEVER_DEPLETED ? null : depletion[p.pathIndex]);
      const table = p.yearTable as YearTable;
      expect(table.pathIndex).toBe(p.pathIndex);
      expect(table.rows.map((r) => r.year)).toEqual(Array.from({ length: 47 }, (_, i) => 2026 + i));
      expect(table.rows.at(-1)!.ending.totalReal).toBe(endings[p.pathIndex]!.toString());
    }
    // The summary's median ending wealth is the stored median path's.
    const summary = row.summary as SimSummary;
    expect(summary.paths).toBe(10_000);
    expect(summary.successPaths).toBe(row.successPaths);
    expect(summary.endingWealthReal.p50).toBe(inline.paths.find((p) => p.percentile === 50)!.endingRealCents.toString());
  }, 180_000);

  it("the same run on 2 threads from the bundled thread entry stores the same series, summary, fan and tables as inline", async () => {
    expect(inline, "the inline run ran first").toBeDefined();
    const settings = loadRetirementConfig({ RETIREMENT_THREADS: "2" }, { threadEntry });
    expect(settings).toEqual({ config: { threads: 2, threadEntry, runMaxMs: 900_000, keepRuns: 20 }, notes: [] });
    const { runId, outcome } = await runThroughJob({ db, config: { ...config, retirement: settings.config }, client: {}, now: () => new Date(), log });
    expect(outcome).toMatchObject({ runId, outcome: "done", paths: 10_000, threads: 2 });
    const threaded = await stored(runId);
    expect(threaded.row).toMatchObject({ status: "done", threads: 2, inputHash: inline.row.inputHash, successPaths: inline.row.successPaths });
    for (const [kind, data] of inline.series) expect(Buffer.from(threaded.series.get(kind)!).equals(Buffer.from(data)), kind).toBe(true);
    expect(threaded.row.summary).toEqual(inline.row.summary);
    expect(threaded.row.fan).toEqual(inline.row.fan);
    expect(threaded.row.warnings).toEqual(inline.row.warnings);
    const strip = (p: (typeof threaded.paths)[number]) => ({ ...p, runId: undefined });
    expect(threaded.paths.map(strip)).toEqual(inline.paths.map(strip));
  }, 180_000);
});
