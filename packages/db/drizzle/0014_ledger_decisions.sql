ALTER TABLE "transaction" ADD COLUMN "transfer_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "pending_seen_through" date;--> statement-breakpoint
-- Audit a10-conformance-ledger-03, second round: a pair the household made by hand is its
-- decision, which the rules leave alone. Pairing by hand writes an audit entry per leg naming the
-- pair id it gave, so the legs of a pair that still has that id are marked as decided by hand.
UPDATE "transaction" AS t
SET "transfer_locked" = true
WHERE t."transfer_pair_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "audit_log" AS a
    WHERE a."entity" = 'transaction'
      AND a."entity_id" = t."id"::text
      AND a."action" = 'update'
      AND a."after" ->> 'transferPairId' = t."transfer_pair_id"::text
  );
