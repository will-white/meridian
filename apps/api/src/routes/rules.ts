import { asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { category, clearStaleNotTransfer, loadRules, rule, runRules, writeAudit, type DbOrTx } from "@meridian/db";
import {
  CreateRuleBody,
  OkResponse,
  ReorderRulesBody,
  ruleInputProblem,
  RuleView,
  RunRulesBody,
  RunRulesResponse,
  UpdateRuleBody,
  UuidParams,
  type RuleActions,
  type RuleConditions,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toRuleView } from "../views.js";
import { auditContext } from "./plan.js";

type StoredRule = typeof rule.$inferSelect;

/** Audit shape of a rule: the stored columns the user edits (timestamps left out). */
function ruleAuditJson(r: StoredRule) {
  return { id: r.id, name: r.name, position: r.position, enabled: r.enabled, conditions: r.conditions, actions: r.actions };
}

/** One lock for the rule order: creating, restoring and reordering rules take it, so positions stay 1..n (audit a6-text-rules-accounts-19). */
const RULE_ORDER_LOCK = 0x4d_52_55_4c; // "MRUL"

async function lockRuleOrder(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RULE_ORDER_LOCK})`);
}

/**
 * What a create or an edit must satisfy beyond the contract: a pattern RE2 runs, an amount range
 * that can match (audit a6-text-rules-accounts-04 and -16), and a category that exists (-02).
 */
async function assertRuleInput(db: DbOrTx, conditions: RuleConditions, actions: RuleActions): Promise<void> {
  const problem = ruleInputProblem(conditions, actions);
  if (problem) throw badRequest(problem.message, problem.code);
  if (typeof actions.setCategoryId === "string") {
    const [found] = await db.select({ id: category.id }).from(category).where(eq(category.id, actions.setCategoryId));
    if (!found) throw badRequest("The category this rule sets does not exist", "unknown_category");
  }
}

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function listViews() {
    const rows = await app.db.select().from(rule);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (await loadRules(app.db, { stored: true })).map((parsed) => toRuleView(byId.get(parsed.id)!, parsed));
  }

  r.get("/rules", { schema: { response: { 200: z.array(RuleView) } } }, async () => listViews());

  r.post("/rules", { schema: { body: CreateRuleBody, response: { 200: z.object({ rule: RuleView, applied: RunRulesResponse }) } } }, async (request) => {
    const ctx = auditContext(request);
    const row = await app.db.transaction(async (tx) => {
      await assertRuleInput(tx, request.body.conditions, request.body.actions);
      await lockRuleOrder(tx);
      const [next] = await tx.select({ n: sql<number>`coalesce(max(${rule.position}), 0)::int + 1` }).from(rule);
      // A position names where the rule goes (a deleted rule restored from its history, audit
      // a6-text-rules-accounts-13): the rules from there move down one when the place is taken.
      const position = Math.min(request.body.position ?? next!.n, next!.n);
      if (position < next!.n) {
        const [taken] = await tx.select({ id: rule.id }).from(rule).where(eq(rule.position, position));
        if (taken) {
          const moved = await tx.select().from(rule).where(gte(rule.position, position));
          const after = await tx
            .update(rule)
            .set({ position: sql`${rule.position} + 1`, updatedAt: new Date() })
            .where(inArray(rule.id, moved.map((m) => m.id)))
            .returning();
          const byId = new Map(after.map((a) => [a.id, a]));
          for (const m of moved) await writeAudit(tx, { ...ctx, entity: "rule", entityId: m.id, action: "update", before: ruleAuditJson(m), after: ruleAuditJson(byId.get(m.id)!) });
        }
      }
      const [created] = await tx
        .insert(rule)
        .values({ name: request.body.name ?? "", position, enabled: request.body.enabled ?? true, conditions: request.body.conditions, actions: request.body.actions })
        .returning();
      await writeAudit(tx, { ...ctx, entity: "rule", entityId: created!.id, action: "create", before: null, after: ruleAuditJson(created!) });
      return created!;
    });
    const parsed = (await loadRules(app.db)).find((x) => x.id === row.id)!;
    let applied = { examined: 0, changed: 0 };
    if (request.body.applyTo !== "none") applied = await runRules(app.db, { scope: request.body.applyTo, rules: [parsed] });
    const stored = (await loadRules(app.db, { stored: true })).find((x) => x.id === row.id)!;
    return { rule: toRuleView(row, stored), applied };
  });

  r.patch("/rules/:id", { schema: { params: UuidParams, body: UpdateRuleBody, response: { 200: RuleView } } }, async (request) => {
    const ctx = auditContext(request);
    const row = await app.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(rule).where(eq(rule.id, request.params.id));
      if (!existing) throw notFound("Rule not found");
      if (request.body.conditions !== undefined || request.body.actions !== undefined) {
        const [current] = (await loadRules(tx, { stored: true })).filter((x) => x.id === existing.id);
        const conditions = request.body.conditions ?? current?.conditions;
        const actions = request.body.actions ?? current?.actions;
        if (conditions && actions) await assertRuleInput(tx, conditions, actions);
      }
      const patch: Partial<typeof rule.$inferInsert> = { updatedAt: new Date() };
      if (request.body.name !== undefined) patch.name = request.body.name;
      if (request.body.enabled !== undefined) patch.enabled = request.body.enabled;
      if (request.body.conditions !== undefined) patch.conditions = request.body.conditions;
      if (request.body.actions !== undefined) patch.actions = request.body.actions;
      const [updated] = await tx.update(rule).set(patch).where(eq(rule.id, existing.id)).returning();
      await writeAudit(tx, { ...ctx, entity: "rule", entityId: existing.id, action: "update", before: ruleAuditJson(existing), after: ruleAuditJson(updated!) });
      return updated!;
    });
    // A rule switched off or changed no longer rules out the rows it ruled out (audit a10-conformance-ledger-03, second round).
    if (request.body.enabled !== undefined || request.body.conditions !== undefined || request.body.actions !== undefined) await clearStaleNotTransfer(app.db);
    const parsed = (await loadRules(app.db, { stored: true })).find((x) => x.id === row.id)!;
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
    // The rows only this rule ruled out as transfers may pair again (audit a10-conformance-ledger-03, second round).
    await clearStaleNotTransfer(app.db);
    return { ok: true as const };
  });

  /** Positions become 1..n in the order given; rules left out keep their relative order after. One audit batch, one entry per moved rule. */
  r.post("/rules/reorder", { schema: { body: ReorderRulesBody, response: { 200: z.array(RuleView) } } }, async (request) => {
    const ctx = auditContext(request);
    await app.db.transaction(async (tx) => {
      await lockRuleOrder(tx);
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
    // A later rule may now override a "not a transfer" (a rule's stop, or its own transfer action): a10-conformance-ledger-03, second round.
    await clearStaleNotTransfer(app.db);
    return listViews();
  });

  r.post("/rules/run", { schema: { body: RunRulesBody, response: { 200: RunRulesResponse } } }, async (request) => runRules(app.db, { scope: request.body.scope }));
}
