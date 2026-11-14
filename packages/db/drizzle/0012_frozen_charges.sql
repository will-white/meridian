ALTER TABLE "month_plan" ADD COLUMN "frozen_charge_ids" uuid[];--> statement-breakpoint
-- plan.close_month now records the linked charges a value frozen from recurring items counts, so a charge dated in a
-- closed month that reaches the ledger later can be added to it (audit b1-plan-math, second round). Rows it froze
-- before this column existed are given what their category's planning items (active, paused, cancelled) hold in that
-- month now; a charge that arrived after such a freeze is taken as counted, so those values stay as they are.
UPDATE "month_plan" SET "frozen_charge_ids" = coalesce((
  SELECT array_agg(t."id" ORDER BY t."id")
  FROM "transaction" t JOIN "recurring" r ON r."id" = t."recurring_id"
  WHERE r."category_id" = "month_plan"."category_id"
    AND r."status" IN ('active', 'paused', 'cancelled')
    AND to_char(t."date", 'YYYY-MM') = "month_plan"."month"
), '{}')
WHERE "planned_source" = 'recurring' AND "planned_cents" IS NOT NULL;
