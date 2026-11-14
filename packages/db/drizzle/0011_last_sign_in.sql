ALTER TABLE "user" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
-- The last sign-in was read from the sign-in activity, which is deleted after 90 days; it is kept on the member's row from now on.
-- Filled from the activity there is: completed sign-ins only (password and code, or a passkey), never a failed attempt.
UPDATE "user" SET "last_sign_in_at" = (SELECT max(e."at") FROM "sign_in_event" e WHERE e."user_id" = "user"."id" AND e."kind" IN ('signed_in', 'passkey_signed_in'));
