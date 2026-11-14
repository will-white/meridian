import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createScenario,
  deleteRun,
  deleteScenario,
  freezeScenarioInput,
  getProfile,
  getRun,
  getRunInput,
  getRunPath,
  getScenario,
  listRuns,
  listScenarios,
  previewBaseline,
  putProfile,
  refreshBaseline,
  requestCancel,
  requestRun,
  revertProfile,
  revertScenario,
  setRunFlags,
  updateScenario,
  type PlannerQuery,
} from "@meridian/db";
import {
  BaselinePreviewResponse,
  BaselineRefreshResponse,
  CreateScenarioBody,
  FederalTaxPreviewRequest,
  FederalTaxPreviewResponse,
  OkResponse,
  ProfileResponse,
  PutProfileBody,
  RefreshBaselineBody,
  RetirementMeta,
  RetirementRulesView,
  RevertProfileBody,
  RevertScenarioBody,
  RunListQuery,
  RunListResponse,
  RunPathParams,
  RunPathResponse,
  RunRequestBody,
  RunRequestResponse,
  ScenarioInputResponse,
  ScenarioListQuery,
  ScenarioListResponse,
  ScenarioView,
  SimInput,
  SimRunDetail,
  SimRunView,
  SocialSecurityPreviewRequest,
  SocialSecurityPreviewResponse,
  TodayQuery,
  UpdateRunBody,
  UpdateScenarioBody,
  UuidParams,
  type IsoDate,
} from "@meridian/shared";
import { preview, runRequestStatus, toRetirementMeta, toScenarioListResponse } from "../views/retirement.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";

/**
 * The retirement planner's routes, registered under `/api/retirement` (app.ts): routes 1 to 21 of
 * docs/design/phase-4/inputs-and-data.md §4.7 and routes 22 to 24 of tax-rmd-ss §4.4 (seams C42),
 * in the designs' numbering, with the contracts of shared `retirement/api.ts` (`RETIREMENT_ROUTES`
 * names the same schemas; retirementRoutes.test.ts checks the two agree).
 *
 * Every handler calls one planner service of packages/db with the request's `today` (the client's
 * date within ±2 days of the server's, `resolveToday`), the server clock, and `app.planner.env`;
 * a mutation also passes one audit batch (`auditContext`). Typed service failures become their
 * status and code through `usePlanErrors` (`{ error, code }`, 400, 404 or 409); a viewer's
 * mutation is refused with 403 `viewer` by the auth plugin before the body is read. The two
 * previews (23 and 24) are read-only POSTs (`config.readOnly`); they and the rules view write
 * nothing. Route 18 re-simulates at most one path, on this thread (seams G11).
 */

const readOnly = { readOnly: true } as const;

export async function retirementRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  /** The services' query: the effective `today`, the server clock and the engine's facts. */
  const planner = async (requested: IsoDate | undefined): Promise<PlannerQuery> => ({ today: await resolveToday(app, requested), now: app.now(), env: app.planner.env });

  // 1
  r.get("/meta", { schema: { response: { 200: RetirementMeta } } }, async () => toRetirementMeta(app.planner));

  // 2: `exists: false` with a live baseline before the profile exists; never 404.
  r.get("/profile", { schema: { querystring: TodayQuery, response: { 200: ProfileResponse } } }, async (request) => getProfile(app.db, await planner(request.query.today)));

  // 3: `expectedRevision: 0` creates the profile, its baseline and the default scenario "Base plan".
  r.put("/profile", { schema: { body: PutProfileBody, response: { 200: ProfileResponse } } }, async (request) => {
    const q = await planner(request.body.today);
    return putProfile(app.db, { ...q, doc: request.body.doc, expectedRevision: request.body.expectedRevision }, auditContext(request));
  });

  // 4
  r.post("/profile/revert", { schema: { body: RevertProfileBody, response: { 200: ProfileResponse } } }, async (request) => {
    const q = await planner(request.body.today);
    return revertProfile(app.db, { ...q, auditId: request.body.auditId, expectedRevision: request.body.expectedRevision }, auditContext(request));
  });

  // 5: computes, writes nothing.
  r.get("/baseline/preview", { schema: { querystring: TodayQuery, response: { 200: BaselinePreviewResponse } } }, async (request) =>
    previewBaseline(app.db, await planner(request.query.today)),
  );

  // 6: `409 baseline_changed` when live data moved since the preview's `proposedHash`.
  r.post("/baseline/refresh", { schema: { body: RefreshBaselineBody, response: { 200: BaselineRefreshResponse } } }, async (request) => {
    const q = await planner(request.body.today);
    return refreshBaseline(app.db, { ...q, expectedHash: request.body.expectedHash }, auditContext(request));
  });

  // 7
  r.get("/scenarios", { schema: { querystring: ScenarioListQuery, response: { 200: ScenarioListResponse } } }, async (request) => {
    const q = await planner(undefined);
    return toScenarioListResponse(await listScenarios(app.db, { ...q, includeArchived: request.query.includeArchived }));
  });

  // 8
  r.post("/scenarios", { schema: { body: CreateScenarioBody, response: { 201: ScenarioView } } }, async (request, reply) => {
    const q = await planner(undefined);
    const view = await createScenario(app.db, request.body, q, auditContext(request));
    return reply.status(201).send(view);
  });

  // 9
  r.get("/scenarios/:id", { schema: { params: UuidParams, querystring: TodayQuery, response: { 200: ScenarioView } } }, async (request) =>
    getScenario(app.db, request.params.id, await planner(request.query.today)),
  );

  // 10
  r.patch("/scenarios/:id", { schema: { params: UuidParams, body: UpdateScenarioBody, response: { 200: ScenarioView } } }, async (request) =>
    updateScenario(app.db, request.params.id, request.body, await planner(undefined), auditContext(request)),
  );

  // 11: its runs cascade; `409 default_scenario`.
  r.delete("/scenarios/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteScenario(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  // 12
  r.post("/scenarios/:id/revert", { schema: { params: UuidParams, body: RevertScenarioBody, response: { 200: ScenarioView } } }, async (request) =>
    revertScenario(app.db, request.params.id, request.body, await planner(undefined), auditContext(request)),
  );

  // 13: the input the scenario would freeze now, its issues, and a run it could reuse.
  r.get("/scenarios/:id/input", { schema: { params: UuidParams, querystring: TodayQuery, response: { 200: ScenarioInputResponse } } }, async (request) =>
    freezeScenarioInput(app.db, request.params.id, await planner(request.query.today)),
  );

  // 14: 202 with a new run, 200 when an existing one is returned.
  r.post(
    "/scenarios/:id/runs",
    { schema: { params: UuidParams, body: RunRequestBody, response: { 200: RunRequestResponse, 202: RunRequestResponse } } },
    async (request, reply) => {
      const q = await planner(request.body.today);
      const result = await requestRun(app.db, { ...q, scenarioId: request.params.id, refresh: request.body.refresh, force: request.body.force }, auditContext(request));
      return reply.status(runRequestStatus(result)).send(result);
    },
  );

  // 15: newest first.
  r.get("/runs", { schema: { querystring: RunListQuery, response: { 200: RunListResponse } } }, async (request) => {
    const q = await planner(undefined);
    return listRuns(app.db, { ...q, scenarioId: request.query.scenarioId, limit: request.query.limit, cursor: request.query.cursor });
  });

  // 16
  r.get("/runs/:id", { schema: { params: UuidParams, response: { 200: SimRunDetail } } }, async (request) => getRun(app.db, request.params.id, await planner(undefined)));

  // 17: the frozen input as stored.
  r.get("/runs/:id/input", { schema: { params: UuidParams, response: { 200: SimInput } } }, async (request) => getRunInput(app.db, request.params.id));

  // 18: a stored percentile from its row; any other re-simulated alone (G11).
  r.get("/runs/:id/paths/:percentile", { schema: { params: RunPathParams, response: { 200: RunPathResponse } } }, async (request) =>
    getRunPath(app.db, request.params.id, request.params.percentile, { env: app.planner.env, engine: app.planner }),
  );

  // 19
  r.post("/runs/:id/cancel", { schema: { params: UuidParams, response: { 200: SimRunView } } }, async (request) => requestCancel(app.db, request.params.id, await planner(undefined)));

  // 20: pin and note.
  r.patch("/runs/:id", { schema: { params: UuidParams, body: UpdateRunBody, response: { 200: SimRunView } } }, async (request) =>
    setRunFlags(app.db, request.params.id, request.body, await planner(undefined), auditContext(request)),
  );

  // 21: `409 run_active` while queued or running.
  r.delete("/runs/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteRun(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  // 22: the tax data, its provenance and staleness on `today`.
  r.get("/rules", { schema: { querystring: TodayQuery, response: { 200: RetirementRulesView } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    return app.planner.rulesView(today);
  });

  // 23: one household-year through the federal tax function (the gate's comparison tool).
  r.post("/tax-preview", { config: readOnly, schema: { body: FederalTaxPreviewRequest, response: { 200: FederalTaxPreviewResponse } } }, async (request) =>
    preview(() => app.planner.taxPreview(request.body)),
  );

  // 24: the benefit by claiming age for the Social Security step of the form.
  r.post(
    "/social-security-preview",
    { config: readOnly, schema: { body: SocialSecurityPreviewRequest, response: { 200: SocialSecurityPreviewResponse } } },
    async (request) => preview(() => app.planner.socialSecurityPreview(request.body)),
  );
}
