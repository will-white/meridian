import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { projectForHousehold } from "@meridian/db";
import { CashFlowProjectionBody, CashFlowProjectionResponse, type CashFlowWhatIf, type CashFlowWhatIfBody } from "@meridian/shared";
import { toCashFlowProjectionView } from "../views/cashflow.js";
import { resolveToday, usePlanErrors } from "./plan.js";

/**
 * Cash-flow projection (docs/phase-2-plan.md §14, docs/design/phase-2/cashflow.md "api").
 * One endpoint, `POST /api/cashflow/projection`: POST because the what-if list travels
 * in the body, but it is side-effect free and idempotent (the loader reads, the engine
 * is pure, nothing is written). Runs inline: 366 days × a dozen accounts is sub-10 ms.
 *
 * `today` is the client's local date, accepted within ±2 days of the household's
 * server date (else 400); the horizon defaults to household_setting.projection_default_days
 * and `thresholdCents` overrides the household default for this request only. An
 * `accountIds` entry that is not an on-budget open account is a 400 (the loader's
 * PlanError, rendered by the plan error handler). A what-if naming an unknown recurring
 * id or a non-occurrence date is NOT an error: the engine reports it in `whatIfs[i]` so
 * the UI can keep a stale what-if visible after a due date advances.
 */

/** The wire what-if → the engine's (cents as bigint; optional fields only when present). */
export function toEngineWhatIf(w: CashFlowWhatIfBody): CashFlowWhatIf {
  switch (w.kind) {
    case "skipOccurrence":
      return { kind: "skipOccurrence", recurringId: w.recurringId, occurrenceDate: w.occurrenceDate };
    case "moveOccurrence":
      return {
        kind: "moveOccurrence",
        recurringId: w.recurringId,
        shiftDays: w.shiftDays,
        ...(w.occurrenceDate !== undefined ? { occurrenceDate: w.occurrenceDate } : {}),
      };
    case "oneTime":
      return {
        kind: "oneTime",
        date: w.date,
        amountCents: BigInt(w.amountCents),
        accountId: w.accountId,
        ...(w.label !== undefined ? { label: w.label } : {}),
      };
  }
}

export async function cashflowRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  /** A read that needs a body: open to the viewer role like a GET. */
  r.post("/cashflow/projection", { config: { readOnly: true }, schema: { body: CashFlowProjectionBody, response: { 200: CashFlowProjectionResponse } } }, async (request) => {
    const b = request.body;
    const today = await resolveToday(app, b.today);
    const result = await projectForHousehold(app.db, {
      today,
      ...(b.horizonDays !== undefined ? { horizonDays: b.horizonDays } : {}),
      ...(b.thresholdCents !== undefined ? { thresholdCents: BigInt(b.thresholdCents) } : {}),
      ...(b.accountIds !== undefined ? { accountIds: b.accountIds } : {}),
      whatIfs: b.whatIfs.map(toEngineWhatIf),
    });
    return toCashFlowProjectionView(result);
  });
}
