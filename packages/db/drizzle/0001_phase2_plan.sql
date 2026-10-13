CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"batch_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "category_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"bucket" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_setting" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"plan_start_month" text NOT NULL,
	"zero_based" boolean DEFAULT false NOT NULL,
	"low_balance_threshold_cents" bigint DEFAULT 0 NOT NULL,
	"primary_account_id" uuid,
	"projection_default_days" integer DEFAULT 90 NOT NULL,
	"timezone" text DEFAULT 'America/Denver' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "month_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"month" text NOT NULL,
	"planned_cents" bigint,
	"planned_source" text,
	"rollover_mode" text,
	"carried_in_override_cents" bigint,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"linked_account_id" uuid,
	"target_cents" bigint NOT NULL,
	"target_date" date,
	"starting_cents" bigint DEFAULT 0 NOT NULL,
	"start_month" text NOT NULL,
	"monthly_contribution_cents" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_goal_category_id_unique" UNIQUE("category_id")
);
--> statement-breakpoint
CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"recurring_id" uuid,
	"payee_id" uuid NOT NULL,
	"transaction_id" uuid,
	"due_date" date,
	"old_cents" bigint,
	"new_cents" bigint,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recurring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payee_id" uuid NOT NULL,
	"category_id" uuid,
	"account_id" uuid,
	"transfer_account_id" uuid,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"anchor_day" smallint,
	"anchor_day2" smallint,
	"anchor_month" smallint,
	"anchor_date" date,
	"expected_cents" bigint NOT NULL,
	"tolerance_cents" bigint DEFAULT 0 NOT NULL,
	"amount_mode" text DEFAULT 'fixed' NOT NULL,
	"amount_locked" boolean DEFAULT false NOT NULL,
	"schedule_locked" boolean DEFAULT false NOT NULL,
	"next_due_date" date,
	"first_charge_date" date,
	"last_charge_date" date,
	"last_charge_cents" bigint,
	"last_transaction_id" uuid,
	"charge_count" integer DEFAULT 0 NOT NULL,
	"consecutive_missed" smallint DEFAULT 0 NOT NULL,
	"missed_from_date" date,
	"confidence" smallint,
	"source" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detected_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "low_balance_threshold_cents" bigint;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "payment_day" smallint;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "payment_from_account_id" uuid;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "statement_day" smallint;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "rollover_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "rollover_from_month" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "recurring_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_setting" ADD CONSTRAINT "household_setting_primary_account_id_account_id_fk" FOREIGN KEY ("primary_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_plan" ADD CONSTRAINT "month_plan_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goal" ADD CONSTRAINT "savings_goal_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goal" ADD CONSTRAINT "savings_goal_linked_account_id_account_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_recurring_id_recurring_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_batch_idx" ON "audit_log" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "category_group_bucket_name_idx" ON "category_group" USING btree ("bucket","name");--> statement-breakpoint
CREATE INDEX "category_group_bucket_position_idx" ON "category_group" USING btree ("bucket","position");--> statement-breakpoint
CREATE UNIQUE INDEX "month_plan_category_month_idx" ON "month_plan" USING btree ("category_id","month");--> statement-breakpoint
CREATE INDEX "month_plan_month_idx" ON "month_plan" USING btree ("month");--> statement-breakpoint
CREATE INDEX "savings_goal_linked_account_idx" ON "savings_goal" USING btree ("linked_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_dedupe_key_idx" ON "alert" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alert_created_idx" ON "alert" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recurring_payee_idx" ON "recurring" USING btree ("payee_id");--> statement-breakpoint
CREATE INDEX "recurring_status_next_due_idx" ON "recurring" USING btree ("status","next_due_date");--> statement-breakpoint
CREATE INDEX "recurring_account_status_idx" ON "recurring" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "category_group_position_idx" ON "category" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "category_bucket_position_idx" ON "category" USING btree ("bucket","position");--> statement-breakpoint
CREATE INDEX "transaction_recurring_idx" ON "transaction" USING btree ("recurring_id");--> statement-breakpoint
CREATE INDEX "transaction_payee_date_idx" ON "transaction" USING btree ("payee_id","date");