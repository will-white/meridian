import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { account, getHouseholdSetting, updateHouseholdSetting, type HouseholdSettingPatch } from "@meridian/db";
import { HouseholdSettingView, UpdateHouseholdSettingBody } from "@meridian/shared";
import { badRequest } from "../lib/errors.js";
import { toHouseholdSettingView } from "../views/plan.js";
import { auditContext, usePlanErrors } from "./plan.js";

/** The household_setting singleton: plan start month, zero-based toggle, cash-flow defaults, time zone. */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/settings", { schema: { response: { 200: HouseholdSettingView } } }, async () => toHouseholdSettingView(await getHouseholdSetting(app.db)));

  r.patch("/settings", { schema: { body: UpdateHouseholdSettingBody, response: { 200: HouseholdSettingView } } }, async (request) => {
    const b = request.body;
    if (b.primaryAccountId) {
      const [row] = await app.db.select({ onBudget: account.onBudget, closed: account.closed }).from(account).where(eq(account.id, b.primaryAccountId));
      if (!row) throw badRequest("Primary account not found", "validation");
      // The primary account is the projection's spending fallback, so it must be one the projection can include.
      if (!row.onBudget || row.closed) throw badRequest("Primary account must be an on-budget open account", "validation");
    }
    const patch: HouseholdSettingPatch = {
      ...(b.planStartMonth !== undefined ? { planStartMonth: b.planStartMonth } : {}),
      ...(b.zeroBased !== undefined ? { zeroBased: b.zeroBased } : {}),
      ...(b.lowBalanceThresholdCents !== undefined ? { lowBalanceThresholdCents: BigInt(b.lowBalanceThresholdCents) } : {}),
      ...(b.primaryAccountId !== undefined ? { primaryAccountId: b.primaryAccountId } : {}),
      ...(b.projectionDefaultDays !== undefined ? { projectionDefaultDays: b.projectionDefaultDays } : {}),
      ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
    };
    return toHouseholdSettingView(await updateHouseholdSetting(app.db, patch, auditContext(request)));
  });
}
