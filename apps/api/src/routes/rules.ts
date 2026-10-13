import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loadRules, rule, runRules } from "@meridian/db";
import { CreateRuleBody, OkResponse, ReorderRulesBody, RuleView, RunRulesBody, RunRulesResponse, UpdateRuleBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toRuleView } from "../views.js";

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function listViews() {
    const rows = await app.db.select().from(rule);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (await loadRules(app.db)).map((parsed) => toRuleView(byId.get(parsed.id)!, parsed));
  }

  r.get("/rules", { schema: { response: { 200: z.array(RuleView) } } }, async () => listViews());

  r.post("/rules", { schema: { body: CreateRuleBody, response: { 200: z.object({ rule: RuleView, applied: RunRulesResponse }) } } }, async (request) => {
    const [next] = await app.db.select({ n: sql<number>`coalesce(max(${rule.position}), 0)::int + 1` }).from(rule);
    const [row] = await app.db
      .insert(rule)
      .values({ name: request.body.name?.trim() ?? "", position: next!.n, conditions: request.body.conditions, actions: request.body.actions })
      .returning();
    const parsed = (await loadRules(app.db)).find((x) => x.id === row!.id)!;
    let applied = { examined: 0, changed: 0 };
    if (request.body.applyTo !== "none") applied = await runRules(app.db, { scope: request.body.applyTo, rules: [parsed] });
    return { rule: toRuleView(row!, parsed), applied };
  });

  r.patch("/rules/:id", { schema: { params: UuidParams, body: UpdateRuleBody, response: { 200: RuleView } } }, async (request) => {
    const patch: Partial<typeof rule.$inferInsert> = { updatedAt: new Date() };
    if (request.body.name !== undefined) patch.name = request.body.name.trim();
    if (request.body.enabled !== undefined) patch.enabled = request.body.enabled;
    if (request.body.conditions !== undefined) patch.conditions = request.body.conditions;
    if (request.body.actions !== undefined) patch.actions = request.body.actions;
    const [row] = await app.db.update(rule).set(patch).where(eq(rule.id, request.params.id)).returning();
    if (!row) throw notFound("Rule not found");
    const parsed = (await loadRules(app.db)).find((x) => x.id === row.id)!;
    return toRuleView(row, parsed);
  });

  r.delete("/rules/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const deleted = await app.db.delete(rule).where(eq(rule.id, request.params.id)).returning({ id: rule.id });
    if (deleted.length === 0) throw notFound("Rule not found");
    return { ok: true as const };
  });

  /** Positions become 1..n in the order given; rules left out keep their relative order after. */
  r.post("/rules/reorder", { schema: { body: ReorderRulesBody, response: { 200: z.array(RuleView) } } }, async (request) => {
    const current = await app.db.select({ id: rule.id, position: rule.position }).from(rule);
    const given = request.body.ids.filter((id) => current.some((c) => c.id === id));
    const rest = current
      .filter((c) => !given.includes(c.id))
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);
    await app.db.transaction(async (tx) => {
      let position = 1;
      for (const id of [...given, ...rest]) {
        await tx.update(rule).set({ position: position++, updatedAt: new Date() }).where(eq(rule.id, id));
      }
    });
    return listViews();
  });

  r.post("/rules/run", { schema: { body: RunRulesBody, response: { 200: RunRulesResponse } } }, async (request) => runRules(app.db, { scope: request.body.scope }));
}
