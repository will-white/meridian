import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getDashboard } from "@meridian/db";
import { DashboardView, TodayQuery } from "@meridian/shared";
import { toDashboardView } from "../views/cashflow.js";
import { resolveToday, usePlanErrors } from "./plan.js";

/**
 * `GET /api/dashboard` (docs/phase-2-plan.md §15, grid-and-api `DashboardView`): the
 * current month's summary strip, the 30-day combined cash-flow line with its low point,
 * bills due in the next 14 days (plus overdue items), net worth with its 12-month change,
 * the review counts and the sync status. Computed per request from the services, never
 * cached or written, and sent with `Cache-Control: no-store` so no proxy keeps a copy;
 * the client's own staleTime is its only cache. `today` is the client's local date,
 * bounded to ±2 days of the server's household date (else 400).
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/dashboard", { schema: { querystring: TodayQuery, response: { 200: DashboardView } } }, async (request, reply) => {
    const today = await resolveToday(app, request.query.today);
    const view = toDashboardView(await getDashboard(app.db, { today }));
    reply.header("Cache-Control", "no-store");
    return view;
  });
}
