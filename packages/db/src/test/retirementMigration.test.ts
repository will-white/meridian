import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { job, planProfile, scenario, simRun, simRunPath, simRunSeries } from "../schema/index.js";
import { driverError } from "../services/driverError.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./db.js";

/**
 * Inputs-and-data §7 case 19: the constraints of migration `phase4_retirement` (the planner's five
 * tables, inputs §2.1 to §2.4 with seams C46 and F9), each verified by an insert or update that
 * must fail and name it; one valid row per table is accepted; deleting a scenario removes its runs,
 * series and path rows.
 */

/** A refused query rejects with Postgres's own error, which names the constraint (drizzle-orm wraps it, see driverError). */
const refused = (query: PromiseLike<unknown>): Promise<unknown> =>
  Promise.resolve(query).catch((error: unknown) => {
    throw driverError(error);
  });

const PLANNER_TABLES = ["plan_profile", "scenario", "sim_run", "sim_run_series", "sim_run_path"] as const;
const HASH = "a".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("migration phase4_retirement", () => {
  let t: TestDb;
  let scenarioId: string;

  /** A queued run of `scenarioId` with the columns the request copies from the frozen input. */
  const run = (o: Partial<typeof simRun.$inferInsert> = {}) => ({
    scenarioId,
    scenarioName: "Base plan",
    input: { schemaVersion: 1 },
    inputSchemaVersion: 1,
    inputHash: HASH,
    seed: 1,
    paths: 10,
    returnModel: "bootstrap" as const,
    strategy: "constant_dollar" as const,
    taxRuleSet: "current_law",
    dataVersion: "2026.11.1",
    baselineAsOf: "2026-10-13",
    profileRevision: 1,
    scenarioRevision: 1,
    ...o,
  });
  /** The columns a finished run must carry (`sim_run_done_shape`). */
  const done = { status: "done" as const, pathsDone: 10, successPaths: 8, summary: { schemaVersion: 1 }, fan: { schemaVersion: 1 }, engineVersion: "1.0.1", finishedAt: new Date() };

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("creates the five planner tables", async () => {
    const rows = await t.db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ${PLANNER_TABLES}`);
    expect([...rows].map((r) => r.table_name).sort()).toEqual([...PLANNER_TABLES].sort());
  });

  it("plan_profile: one row only, revision at least 1, object documents, a hex hash", async () => {
    const row = { schemaVersion: 1, doc: { schemaVersion: 1 }, baseline: { schemaVersion: 1 }, baselineAsOf: "2026-10-13", baselineHash: HASH };
    const [created] = await t.db.insert(planProfile).values(row).returning();
    expect(created).toMatchObject({ id: 1, revision: 1, baselineAsOf: "2026-10-13" });

    // A second row: the primary key with the default id, the singleton CHECK with any other.
    await expect(refused(t.db.insert(planProfile).values(row))).rejects.toThrow(/plan_profile_pkey/);
    await expect(refused(t.db.insert(planProfile).values({ ...row, id: 2 }))).rejects.toThrow(/plan_profile_singleton/);
    await expect(refused(t.db.update(planProfile).set({ revision: 0 }))).rejects.toThrow(/plan_profile_revision_check/);
    await expect(refused(t.db.execute(sql`update "plan_profile" set "doc" = '[]'::jsonb`))).rejects.toThrow(/plan_profile_doc_object/);
    await expect(refused(t.db.execute(sql`update "plan_profile" set "baseline" = '"x"'::jsonb`))).rejects.toThrow(/plan_profile_baseline_object/);
    await expect(refused(t.db.update(planProfile).set({ baselineHash: HASH.toUpperCase() }))).rejects.toThrow(/plan_profile_baseline_hash_shape/);
  });

  it("scenario: one default, never archived, names unique ignoring case, 1 to 80 characters", async () => {
    const [base] = await t.db.insert(scenario).values({ name: "Base plan", isDefault: true, settings: { schemaVersion: 1 } }).returning();
    scenarioId = base!.id;
    expect(base).toMatchObject({ overrides: {}, revision: 1, position: 0, archived: false, notes: null });
    const [other] = await t.db.insert(scenario).values({ name: "Retire at 58", settings: { schemaVersion: 1 } }).returning();

    await expect(refused(t.db.insert(scenario).values({ name: "Second default", isDefault: true, settings: {} }))).rejects.toThrow(/scenario_default_idx/);
    await expect(refused(t.db.update(scenario).set({ archived: true }).where(eq(scenario.id, scenarioId)))).rejects.toThrow(/scenario_default_not_archived/);
    await expect(refused(t.db.insert(scenario).values({ name: "retire AT 58", settings: {} }))).rejects.toThrow(/scenario_name_idx/);
    await expect(refused(t.db.insert(scenario).values({ name: "", settings: {} }))).rejects.toThrow(/scenario_name_length/);
    await expect(refused(t.db.insert(scenario).values({ name: "x".repeat(81), settings: {} }))).rejects.toThrow(/scenario_name_length/);
    await expect(refused(t.db.insert(scenario).values({ name: "Array overrides", overrides: sql`'[]'::jsonb` as never, settings: {} }))).rejects.toThrow(/scenario_overrides_object/);
    await expect(refused(t.db.insert(scenario).values({ name: "Array settings", settings: sql`'[]'::jsonb` as never }))).rejects.toThrow(/scenario_settings_object/);
    await expect(refused(t.db.update(scenario).set({ revision: 0 }).where(eq(scenario.id, other!.id)))).rejects.toThrow(/scenario_revision_check/);

    // Archiving a scenario that is not the default is allowed, and so is a name of 80 characters.
    await t.db.update(scenario).set({ archived: true, name: "y".repeat(80) }).where(eq(scenario.id, other!.id));
  });

  it("sim_run: the done and failed shapes, one active run per scenario, the seed and path ranges", async () => {
    const [queued] = await t.db.insert(simRun).values(run()).returning();
    expect(queued).toMatchObject({ status: "queued", cancelRequested: false, pathsDone: 0, seed: 1, warnings: [], pinned: false, engineVersion: null, jobId: null });

    // A second queued (or running) run of the same scenario.
    await expect(refused(t.db.insert(simRun).values(run()))).rejects.toThrow(/sim_run_active_idx/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "running" })))).rejects.toThrow(/sim_run_active_idx/);

    // A done run without summary, or with paths_done other than paths.
    await expect(refused(t.db.update(simRun).set({ ...done, summary: null }).where(eq(simRun.id, queued!.id)))).rejects.toThrow(/sim_run_done_shape/);
    await expect(refused(t.db.update(simRun).set({ ...done, pathsDone: 9 }).where(eq(simRun.id, queued!.id)))).rejects.toThrow(/sim_run_done_shape/);
    for (const missing of [{ fan: null }, { successPaths: null }, { engineVersion: null }, { finishedAt: null }, { successPaths: 11 }, { successPaths: -1 }]) {
      await expect(refused(t.db.update(simRun).set({ ...done, ...missing }).where(eq(simRun.id, queued!.id)))).rejects.toThrow(/sim_run_done_shape/);
    }
    // The engine's own count may differ from the requested one; both columns move together.
    await t.db.update(simRun).set({ ...done, paths: 69, pathsDone: 69, successPaths: 65 }).where(eq(simRun.id, queued!.id));

    // Once the first run is done, a new one may queue; a failed run needs its code.
    const [second] = await t.db.insert(simRun).values(run({ seed: 4294967295 })).returning();
    expect(second!.seed).toBe(4294967295);
    await expect(refused(t.db.update(simRun).set({ status: "failed", finishedAt: new Date() }).where(eq(simRun.id, second!.id)))).rejects.toThrow(/sim_run_failed_shape/);
    await t.db.update(simRun).set({ status: "failed", errorCode: "timeout", errorMessage: "x".repeat(500), finishedAt: new Date() }).where(eq(simRun.id, second!.id));
    await expect(refused(t.db.update(simRun).set({ errorMessage: "x".repeat(501) }).where(eq(simRun.id, second!.id)))).rejects.toThrow(/sim_run_error_message_length/);

    await expect(refused(t.db.execute(sql`update "sim_run" set "status" = 'paused' where "id" = ${second!.id}`))).rejects.toThrow(/sim_run_status_check/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", seed: -1 })))).rejects.toThrow(/sim_run_seed_check/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", seed: 4294967296 })))).rejects.toThrow(/sim_run_seed_check/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", paths: 0 })))).rejects.toThrow(/sim_run_paths_check/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", pathsDone: -1 })))).rejects.toThrow(/sim_run_paths_check/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", input: sql`'[]'::jsonb` as never })))).rejects.toThrow(/sim_run_input_object/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", inputHash: "abc" })))).rejects.toThrow(/sim_run_input_hash_shape/);
    await expect(refused(t.db.insert(simRun).values(run({ status: "cancelled", scenarioId: "00000000-0000-4000-8000-000000000000" })))).rejects.toThrow(/sim_run_scenario_id_scenario_id_fk/);
  });

  it("sim_run: a deleted job leaves the run with no job", async () => {
    const [j] = await t.db.insert(job).values({ type: "retirement.simulate", payload: { runId: "r", dedupeKey: "retirement.simulate:r" } }).returning();
    const [r] = await t.db.insert(simRun).values(run({ jobId: j!.id })).returning();
    await t.db.delete(job).where(eq(job.id, j!.id));
    const [after] = await t.db.select({ jobId: simRun.jobId }).from(simRun).where(eq(simRun.id, r!.id));
    expect(after!.jobId).toBeNull();
    await t.db.update(simRun).set({ status: "cancelled", finishedAt: new Date() }).where(eq(simRun.id, r!.id));
  });

  it("sim_run_series: known kinds only, each with its encoding and 8 or 2 bytes a value; bytea round-trips", async () => {
    const [r] = await t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "done"));
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
    const ending = bytes(80);
    await t.db.insert(simRunSeries).values([
      { runId: r!.id, kind: "ending_real_cents", encoding: "i64le", count: 10, data: ending },
      { runId: r!.id, kind: "depletion_year", encoding: "i16le", count: 10, data: bytes(20) },
      { runId: r!.id, kind: "lifetime_tax_real_cents", encoding: "i64le", count: 10, data: bytes(80) },
      { runId: r!.id, kind: "lifetime_spending_real_cents", encoding: "i64le", count: 10, data: bytes(80) },
    ]);
    const [stored] = await t.db.select({ data: simRunSeries.data }).from(simRunSeries).where(eq(simRunSeries.kind, "ending_real_cents"));
    expect(stored!.data).toBeInstanceOf(Uint8Array);
    expect([...stored!.data]).toEqual([...ending]);

    await expect(refused(t.db.execute(sql`insert into "sim_run_series" ("run_id", "kind", "encoding", "count", "data") values (${r!.id}, 'ending_nominal_cents', 'i64le', 1, '\\x0000000000000000'::bytea)`))).rejects.toThrow(
      /sim_run_series_kind_check/,
    );
    // The key is (run, kind): one series of each kind.
    await expect(refused(t.db.insert(simRunSeries).values({ runId: r!.id, kind: "ending_real_cents", encoding: "i64le", count: 10, data: ending }))).rejects.toThrow(/sim_run_series_pk/);

    const [s] = await t.db.insert(scenario).values({ name: "Series shapes", settings: {} }).returning();
    const [other] = await t.db.insert(simRun).values(run({ scenarioId: s!.id })).returning();
    const series = (o: Partial<typeof simRunSeries.$inferInsert>) => t.db.insert(simRunSeries).values({ runId: other!.id, kind: "ending_real_cents", encoding: "i64le", count: 10, data: bytes(80), ...o });
    // An ending_real_cents series whose length is not 8 × count, or with the 16-bit encoding.
    await expect(refused(series({ data: bytes(79) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(series({ data: bytes(20) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(series({ encoding: "i16le", data: bytes(20) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(series({ kind: "lifetime_tax_real_cents", data: bytes(81) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(series({ kind: "depletion_year", encoding: "i16le", data: bytes(80) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(series({ kind: "depletion_year", encoding: "i64le", data: bytes(80) }))).rejects.toThrow(/sim_run_series_shape/);
    await expect(refused(t.db.execute(sql`insert into "sim_run_series" ("run_id", "kind", "encoding", "count", "data") values (${other!.id}, 'depletion_year', 'i8', 2, '\\x0000'::bytea)`))).rejects.toThrow(
      /sim_run_series_shape/,
    );
  });

  it("sim_run_path: percentiles 1 to 99, a path index and rank of at least 0, one row per percentile, a null depletion year for never", async () => {
    const [r] = await t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "done"));
    const path = (o: Partial<typeof simRunPath.$inferInsert> = {}) => ({ runId: r!.id, percentile: 50, pathIndex: 3, rank: 4, endingRealCents: 300n, yearTable: { schemaVersion: 1 }, ...o });
    const [stored] = await t.db.insert(simRunPath).values([path(), path({ percentile: 5, pathIndex: 2, rank: 0, endingRealCents: 0n, depletionYear: 2047 })]).returning();
    expect(stored).toMatchObject({ percentile: 50, endingRealCents: 300n, depletionYear: null });

    await expect(refused(t.db.insert(simRunPath).values(path()))).rejects.toThrow(/sim_run_path_pk/);
    await expect(refused(t.db.insert(simRunPath).values(path({ percentile: 0 })))).rejects.toThrow(/sim_run_path_percentile_check/);
    await expect(refused(t.db.insert(simRunPath).values(path({ percentile: 100 })))).rejects.toThrow(/sim_run_path_percentile_check/);
    await expect(refused(t.db.insert(simRunPath).values(path({ percentile: 60, pathIndex: -1 })))).rejects.toThrow(/sim_run_path_index_check/);
    await expect(refused(t.db.insert(simRunPath).values(path({ percentile: 60, rank: -1 })))).rejects.toThrow(/sim_run_path_index_check/);
    await expect(refused(t.db.insert(simRunPath).values(path({ percentile: 60, yearTable: sql`'[]'::jsonb` as never })))).rejects.toThrow(/sim_run_path_year_table_object/);
  });

  it("deleting a scenario removes its runs, series and path rows, and nothing of another scenario", async () => {
    const count = async (table: "sim_run" | "sim_run_series" | "sim_run_path") => {
      const [row] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
      return row!.n;
    };
    const [r] = await t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "done"));
    expect([await count("sim_run_series"), await count("sim_run_path")]).toEqual([4, 2]);
    const ownRuns = (await t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.scenarioId, scenarioId))).length;
    const allRuns = await count("sim_run");
    expect(ownRuns).toBeGreaterThan(1);
    expect(allRuns).toBeGreaterThan(ownRuns);

    // The default scenario cannot be removed by the services (409 default_scenario); the tables allow it.
    await t.db.delete(scenario).where(eq(scenario.id, scenarioId));
    expect(await count("sim_run")).toBe(allRuns - ownRuns);
    expect(await count("sim_run_series")).toBe(0);
    expect(await count("sim_run_path")).toBe(0);
    expect(await t.db.select().from(simRun).where(eq(simRun.id, r!.id))).toEqual([]);
  });
});
