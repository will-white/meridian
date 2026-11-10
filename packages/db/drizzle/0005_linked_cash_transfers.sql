-- A bank row that an investment cash transfer is linked to is a transfer in the ledger: the linker
-- now marks it when it links (docs/phase-3-plan.md, audit decision A5). Links made before that are
-- repaired once here, the way the linker does it: the row becomes a transfer and loses its category
-- unless the owner locked one. Rows linked to income or fees, and unlinked rows, are not touched.
UPDATE "transaction" AS t
SET "is_transfer" = true,
    "category_id" = CASE WHEN t."category_locked" THEN t."category_id" ELSE NULL END,
    "updated_at" = now()
FROM "investment_txn" AS i
WHERE i."ledger_transaction_id" = t."id"
  AND i."type" = 'transfer'
  AND i."security_id" IS NULL
  AND t."is_transfer" = false;
