ALTER TABLE "import_log" DROP CONSTRAINT "import_log_connection_id_connection_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "not_transfer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_log" ADD CONSTRAINT "import_log_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Audit a10-conformance-ledger-03: a rule's "not a transfer", run on a paired row, set is_transfer
-- to false and left the pair id. That row is one a rule ruled out: automatic pairing leaves it
-- alone from now on.
UPDATE "transaction" SET "not_transfer" = true WHERE "transfer_pair_id" IS NOT NULL AND "is_transfer" = false;
--> statement-breakpoint
-- Decision 49: a pair id names two rows, both transfers, of equal and opposite amounts. Pairs
-- left otherwise (a rule's "not a transfer" above, a feed row whose amount changed under its id,
-- a10-conformance-ledger-06, two pairing passes at once, -01) are released: every leg loses the
-- pair id and is_transfer, and a leg the household did not categorize gets its payee's default
-- category back, as a released partner does. The next pairing pass may pair the legs again.
WITH "broken" AS (
  SELECT "transfer_pair_id" AS "pair_id"
  FROM "transaction"
  WHERE "transfer_pair_id" IS NOT NULL
  GROUP BY "transfer_pair_id"
  HAVING count(*) <> 2 OR sum("amount_cents") <> 0 OR bool_or(NOT "is_transfer")
)
UPDATE "transaction" AS t
SET
  "transfer_pair_id" = NULL,
  "is_transfer" = false,
  "category_id" = CASE
    WHEN t."category_id" IS NULL AND NOT t."category_locked" THEN (SELECT p."default_category_id" FROM "payee" AS p WHERE p."id" = t."payee_id")
    ELSE t."category_id"
  END,
  "updated_at" = now()
FROM "broken"
WHERE t."transfer_pair_id" = "broken"."pair_id";
