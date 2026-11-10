ALTER TABLE "connection" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "sync_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A connection that has synced was last tried when it last worked, as far as the old schema can tell.
-- One that never worked is tried once more and is spaced from that attempt on.
UPDATE "connection" SET "last_attempt_at" = "last_sync_at" WHERE "type" = 'simplefin';
