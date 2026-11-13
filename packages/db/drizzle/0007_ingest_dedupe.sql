CREATE TABLE "transaction_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"transaction_id" uuid,
	"source" text NOT NULL,
	"import_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_dismissal" (
	"first_id" uuid NOT NULL,
	"second_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_dismissal_first_id_second_id_pk" PRIMARY KEY("first_id","second_id")
);
--> statement-breakpoint
ALTER TABLE "transaction_alias" ADD CONSTRAINT "transaction_alias_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_alias" ADD CONSTRAINT "transaction_alias_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_alias" ADD CONSTRAINT "transaction_alias_import_log_id_import_log_id_fk" FOREIGN KEY ("import_log_id") REFERENCES "public"."import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dismissal" ADD CONSTRAINT "transfer_dismissal_first_id_transaction_id_fk" FOREIGN KEY ("first_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dismissal" ADD CONSTRAINT "transfer_dismissal_second_id_transaction_id_fk" FOREIGN KEY ("second_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_alias_account_external_idx" ON "transaction_alias" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "transaction_alias_transaction_idx" ON "transaction_alias" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_alias_import_log_idx" ON "transaction_alias" USING btree ("import_log_id");--> statement-breakpoint
CREATE INDEX "transfer_dismissal_second_idx" ON "transfer_dismissal" USING btree ("second_id");