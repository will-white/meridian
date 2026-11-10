CREATE TABLE "sign_in_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"username" text NOT NULL,
	"kind" text NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
-- A password-only session used to live as long as a signed-in one; those are dropped (sign in again).
DELETE FROM "session" WHERE "totp_verified" = false;--> statement-breakpoint
-- The table now holds SHA-256(id), so browsers that are signed in stay signed in and a dump holds no usable id.
UPDATE "session" SET "id" = encode(sha256(convert_to("id", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "idle_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "session" SET "idle_expires_at" = "expires_at";--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "idle_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "failed_codes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "user" SET "password_changed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "totp_pending_secret_enc" text;--> statement-breakpoint
ALTER TABLE "sign_in_event" ADD CONSTRAINT "sign_in_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_event_at_idx" ON "sign_in_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sign_in_event_user_idx" ON "sign_in_event" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");