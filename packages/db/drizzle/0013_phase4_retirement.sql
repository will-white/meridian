CREATE TABLE "plan_profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"schema_version" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"baseline" jsonb NOT NULL,
	"baseline_as_of" date NOT NULL,
	"baseline_hash" text NOT NULL,
	"baseline_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_profile_singleton" CHECK ("id" = 1),
	CONSTRAINT "plan_profile_revision_check" CHECK ("revision" >= 1),
	CONSTRAINT "plan_profile_doc_object" CHECK (jsonb_typeof("doc") = 'object'),
	CONSTRAINT "plan_profile_baseline_object" CHECK (jsonb_typeof("baseline") = 'object'),
	CONSTRAINT "plan_profile_baseline_hash_shape" CHECK ("baseline_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "scenario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "scenario_overrides_object" CHECK (jsonb_typeof("overrides") = 'object'),
	CONSTRAINT "scenario_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
	CONSTRAINT "scenario_default_not_archived" CHECK (NOT ("is_default" AND "archived")),
	CONSTRAINT "scenario_revision_check" CHECK ("revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sim_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"scenario_name" text NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"input" jsonb NOT NULL,
	"input_schema_version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"seed" bigint NOT NULL,
	"paths" integer NOT NULL,
	"return_model" text NOT NULL,
	"strategy" text NOT NULL,
	"tax_rule_set" text NOT NULL,
	"data_version" text NOT NULL,
	"engine_version" text,
	"baseline_as_of" date NOT NULL,
	"profile_revision" integer NOT NULL,
	"scenario_revision" integer NOT NULL,
	"threads" smallint,
	"paths_done" integer DEFAULT 0 NOT NULL,
	"progress_at" timestamp with time zone,
	"success_paths" integer,
	"summary" jsonb,
	"fan" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"duration_ms" integer,
	"pinned" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sim_run_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "sim_run_seed_check" CHECK ("seed" >= 0 AND "seed" <= 4294967295),
	CONSTRAINT "sim_run_paths_check" CHECK ("paths" >= 1 AND "paths_done" >= 0),
	CONSTRAINT "sim_run_input_object" CHECK (jsonb_typeof("input") = 'object'),
	CONSTRAINT "sim_run_input_hash_shape" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sim_run_error_message_length" CHECK ("error_message" IS NULL OR char_length("error_message") <= 500),
	CONSTRAINT "sim_run_done_shape" CHECK ("status" <> 'done' OR ("summary" IS NOT NULL AND "fan" IS NOT NULL AND "success_paths" IS NOT NULL AND "engine_version" IS NOT NULL AND "finished_at" IS NOT NULL AND "success_paths" >= 0 AND "success_paths" <= "paths" AND "paths_done" = "paths")),
	CONSTRAINT "sim_run_failed_shape" CHECK ("status" <> 'failed' OR "error_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sim_run_path" (
	"run_id" uuid NOT NULL,
	"percentile" smallint NOT NULL,
	"path_index" integer NOT NULL,
	"rank" integer NOT NULL,
	"ending_real_cents" bigint NOT NULL,
	"depletion_year" integer,
	"year_table" jsonb NOT NULL,
	CONSTRAINT "sim_run_path_pk" PRIMARY KEY("run_id","percentile"),
	CONSTRAINT "sim_run_path_percentile_check" CHECK ("percentile" BETWEEN 1 AND 99),
	CONSTRAINT "sim_run_path_index_check" CHECK ("path_index" >= 0 AND "rank" >= 0),
	CONSTRAINT "sim_run_path_year_table_object" CHECK (jsonb_typeof("year_table") = 'object')
);
--> statement-breakpoint
CREATE TABLE "sim_run_series" (
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"encoding" text NOT NULL,
	"count" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "sim_run_series_pk" PRIMARY KEY("run_id","kind"),
	CONSTRAINT "sim_run_series_kind_check" CHECK ("kind" IN ('ending_real_cents', 'depletion_year', 'lifetime_tax_real_cents', 'lifetime_spending_real_cents')),
	CONSTRAINT "sim_run_series_shape" CHECK (("kind" IN ('ending_real_cents', 'lifetime_tax_real_cents', 'lifetime_spending_real_cents') AND "encoding" = 'i64le' AND octet_length("data") = 8 * "count") OR ("kind" = 'depletion_year' AND "encoding" = 'i16le' AND octet_length("data") = 2 * "count"))
);
--> statement-breakpoint
ALTER TABLE "sim_run" ADD CONSTRAINT "sim_run_scenario_id_scenario_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenario"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_run" ADD CONSTRAINT "sim_run_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_run" ADD CONSTRAINT "sim_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_run_path" ADD CONSTRAINT "sim_run_path_run_id_sim_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_run_series" ADD CONSTRAINT "sim_run_series_run_id_sim_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scenario_name_idx" ON "scenario" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "scenario_default_idx" ON "scenario" USING btree ("is_default") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "sim_run_scenario_created_idx" ON "sim_run" USING btree ("scenario_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sim_run_active_idx" ON "sim_run" USING btree ("scenario_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "sim_run_done_idx" ON "sim_run" USING btree ("scenario_id","finished_at" DESC NULLS LAST) WHERE "status" = 'done';--> statement-breakpoint
CREATE INDEX "sim_run_hash_idx" ON "sim_run" USING btree ("scenario_id","input_hash");