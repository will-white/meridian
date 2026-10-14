import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loadRules, rule, runRules, writeAudit } from "@meridian/db";
import { CreateRuleBody, OkResponse, ReorderRulesBody, RuleView, RunRulesBody, RunRulesResponse, UpdateRuleBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toRuleView } from "../views.js";
import { auditContext } from "./plan.js";

type StoredRule = typeof rule.$inferSelect;

/** Audit shape of a rule: the stored columns the user edits (timestamps left out). */
function ruleAuditJson(r: StoredRule) {
  return { id: r.id, name: r.name, position: r.position, enabled: r.enabled, conditions: r.conditions, actions: r.actions };
}

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function listViews() {
    const rows = await app.db.select().from(rule);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (await loadRules(app.db)).map((parsed) => toRuleView(byId.get(parsed.id)!, parsed));
  }

  r.get("/rules", { schema: { response: { 200: z.array(RuleView) } } }, async () => listViews());

  r.post("/rules", { schema: { body: CreateRuleBody, response: { 200: z.object({ rule: RuleView, applied: RunRulesResponse }) } } }, async (request) => {
    const ctx = auditContext(request);
    const row = await app.db.transaction(async (tx) => {
      const [next] = await tx.select({ n: sql<number>`coalesce(max(${rule.position}), 0)::int + 1` }).from(rule);
      const [created] = await tx
        .insert(rule)
        .values({ name: request.body.name?.trim() ?? "", position: next!.n, conditions: request.body.conditions, actions: request.body.actions })
        .returning();
      await writeAudit(tx, { ...ctx, entity: "rule", entityId: created!.id, action: "create", before: null, after: ruleAuditJson(created!) });
      return created!;
    });
    const parsed = (await loadRules(app.db)).find((x) => x.id === row.id)!;
    let applied = { examined: 0, changed: 0 };
    if (request.body.applyTo !== "none") applied = await runRules(app.db, { scope: request.body.applyTo, rules: [parsed] });
    return { rule: toRuleView(row, parsed), applied };
  });

  r.patch("/rules/:id", { schema: { params: UuidParams, body: UpdateRuleBody, response: { 200: RuleView } } }, async (request) => {
    const ctx = auditContext(request);
    const row = await app.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(rule).where(eq(rule.id, request.params.id));
      if (!existing) throw notFound("Rule not found");
      const patch: Partial<typeof rule.$inferInsert> = { updatedAt: new Date() };
      if (request.body.name !== undefined) patch.name = request.body.name.trim();
      if (request.body.enabled !== undefined) patch.enabled = request.body.enabled;
      if (request.body.conditions !== undefined) patch.conditions = request.body.conditions;
      if (request.body.actions !== undefined) patch.actions = request.body.actions;
      const [updated] = await tx.update(rule).set(patch).where(eq(rule.id, existing.id)).returning();
      await writeAudit(tx, { ...ctx, entity: "rule", entityId: existing.id, action: "update", before: ruleAuditJson(existing), after: ruleAuditJson(updated!) });
      return updated!;
    });
    const parsed = (await loadRules(app.db)).find((x) => x.id === row.id)!;
    return toRuleView(row, parsed);
  });

  r.delete("/rules/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const ctx = auditContext(request);
    await app.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(rule).where(eq(rule.id, request.params.id));
      if (!existing) throw notFound("Rule not found");
      await tx.delete(rule).where(eq(rule.id, existing.id));
      await writeAudit(tx, { ...ctx, entity: "rule", entityId: existing.id, action: "delete", before: ruleAuditJson(existing), after: null });
    });
    return { ok: true as const };
  });

  /** Positions become 1..n in the order given; rules left out keep their relative order after. One audit batch, one entry per moved rule. */
  r.post("/rules/reorder", { schema: { body: ReorderRulesBody, response: { 200: z.array(RuleView) } } }, async (request) => {
    const ctx = auditContext(request);
    await app.db.transaction(async (tx) => {
      const current = await tx.select().from(rule).orderBy(asc(rule.position), asc(rule.id));
      const byId = new Map(current.map((c) => [c.id, c]));
      const given = request.body.ids.filter((id) => byId.has(id));
      const rest = current.filter((c) => !given.includes(c.id)).map((c) => c.id);
      let position = 0;
      for (const id of [...given, ...rest]) {
        position++;
        const before = byId.get(id)!;
        if (before.position === position) continue;
        const [after] = await tx.update(rule).set({ position, updatedAt: new Date() }).where(eq(rule.id, id)).returning();
        await writeAudit(tx, { ...ctx, entity: "rule", entityId: id, action: "update", before: ruleAuditJson(before), after: ruleAuditJson(after!) });
      }
    });
    return listViews();
  });

  r.post("/rules/run", { schema: { body: RunRulesBody, response: { 200: RunRulesResponse } } }, async (request) => runRules(app.db, { scope: request.body.scope }));
}
