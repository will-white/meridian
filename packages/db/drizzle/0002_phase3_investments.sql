CREATE TABLE "account_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_total_cents" bigint NOT NULL,
	"app_value_cents" bigint,
	"app_basis" text NOT NULL,
	"app_as_of" date,
	"cash_inference" text NOT NULL,
	"diff_cents" bigint,
	"balance_cents" bigint,
	"balance_diff_cents" bigint,
	"tolerance_cents" bigint DEFAULT 100 NOT NULL,
	"reconciled" boolean NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted" boolean NOT NULL,
	"holding_snapshot_date" date,
	"note" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_reconciliation_app_basis_check" CHECK ("app_basis" IN ('snapshot', 'lots', 'positions', 'balance', 'none'))
);
--> statement-breakpoint
CREATE TABLE "allocation_target" (
	"asset_class" text PRIMARY KEY NOT NULL,
	"target_bp" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_target_bp_range" CHECK ("target_bp" >= 0 AND "target_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "holding_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(20, 8),
	"price" numeric(20, 8),
	"value_cents" bigint NOT NULL,
	"reported_cost_basis_cents" bigint,
	"source" text NOT NULL,
	"import_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hs_price_needs_quantity" CHECK ("price" IS NULL OR "quantity" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "investment_txn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid,
	"date" date NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric(20, 8),
	"price" numeric(20, 8),
	"amount_cents" bigint NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"split_num" integer,
	"split_den" integer,
	"transfer_direction" text,
	"counterparty_account_id" uuid,
	"transfer_group_id" uuid,
	"cost_basis_cents" bigint,
	"acquired_date" date,
	"ledger_transaction_id" uuid,
	"external_id" text,
	"source" text NOT NULL,
	"import_log_id" uuid,
	"raw_description" text,
	"memo" text,
	"user_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itx_quantity_nonneg" CHECK ("quantity" IS NULL OR "quantity" >= 0),
	CONSTRAINT "itx_price_nonneg" CHECK ("price" IS NULL OR "price" >= 0),
	CONSTRAINT "itx_fee_nonneg" CHECK ("fee_cents" >= 0),
	CONSTRAINT "itx_buy" CHECK ("type" <> 'buy' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" <= 0)),
	CONSTRAINT "itx_sell" CHECK ("type" <> 'sell' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" >= 0)),
	CONSTRAINT "itx_reinvest" CHECK ("type" <> 'reinvest' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" <= 0)),
	CONSTRAINT "itx_fee" CHECK ("type" <> 'fee' OR "amount_cents" <= 0),
	CONSTRAINT "itx_split" CHECK ((("type" = 'split') = ("split_num" IS NOT NULL)) AND (("type" = 'split') = ("split_den" IS NOT NULL)) AND ("type" <> 'split' OR ("security_id" IS NOT NULL AND "split_num" > 0 AND "split_den" > 0 AND "amount_cents" = 0))),
	CONSTRAINT "itx_transfer" CHECK ((("type" = 'transfer') = ("transfer_direction" IS NOT NULL)) AND ("type" <> 'transfer' OR (("security_id" IS NOT NULL AND "amount_cents" = 0 AND "quantity" > 0) OR ("security_id" IS NULL AND "amount_cents" <> 0 AND (("transfer_direction" = 'in') = ("amount_cents" > 0)))))),
	CONSTRAINT "itx_basis_only_in" CHECK (("cost_basis_cents" IS NULL AND "acquired_date" IS NULL) OR ("type" = 'transfer' AND "transfer_direction" = 'in' AND "security_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"opened_by_txn_id" uuid NOT NULL,
	"ordinal" smallint DEFAULT 0 NOT NULL,
	"origin_lot_id" uuid,
	"opened_by" text NOT NULL,
	"acquired_date" date NOT NULL,
	"original_quantity" numeric(20, 8) NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"original_cost_basis_cents" bigint NOT NULL,
	"cost_basis_cents" bigint NOT NULL,
	"basis_known" boolean DEFAULT true NOT NULL,
	"closed_date" date,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lot_original_quantity_pos" CHECK ("original_quantity" > 0),
	CONSTRAINT "lot_quantity_nonneg" CHECK ("quantity" >= 0),
	CONSTRAINT "lot_original_basis_nonneg" CHECK ("original_cost_basis_cents" >= 0),
	CONSTRAINT "lot_basis_nonneg" CHECK ("cost_basis_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lot_disposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"close_txn_id" uuid NOT NULL,
	"lot_id" uuid,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"acquired_date" date,
	"quantity" numeric(20, 8) NOT NULL,
	"proceeds_cents" bigint NOT NULL,
	"basis_cents" bigint NOT NULL,
	"gain_cents" bigint NOT NULL,
	"term" text NOT NULL,
	"basis_known" boolean NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lot_disposal_quantity_pos" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "lot_pick" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sell_txn_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lot_pick_quantity_pos" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"security_id" uuid NOT NULL,
	"date" date NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"source" text NOT NULL,
	"adj_close" numeric(20, 8),
	"provider" text,
	"suspect" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_close_nonneg" CHECK ("close" >= 0),
	CONSTRAINT "price_adj_close_nonneg" CHECK ("adj_close" IS NULL OR "adj_close" >= 0),
	CONSTRAINT "price_source_check" CHECK ("source" IN ('provider', 'implied', 'manual')),
	CONSTRAINT "price_provider_shape" CHECK (("source" = 'provider') = ("provider" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "security" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"asset_class" text DEFAULT 'other' NOT NULL,
	"expense_ratio_ppm" integer,
	"cusip" text,
	"isin" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_mode" text NOT NULL,
	"provider_symbol" text,
	"needs_review" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"notes" text,
	"always_price" boolean DEFAULT false NOT NULL,
	"price_fetched_at" timestamp with time zone,
	"price_fetch_status" text,
	"price_fetch_message" text,
	"price_fetch_failures" integer DEFAULT 0 NOT NULL,
	"price_next_attempt_at" timestamp with time zone,
	"price_backfilled_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_ticker_shape" CHECK ("ticker" IS NULL OR "ticker" ~ '^[A-Z0-9][A-Z0-9./-]{0,11}$'),
	CONSTRAINT "security_expense_ratio_range" CHECK ("expense_ratio_ppm" IS NULL OR ("expense_ratio_ppm" >= 0 AND "expense_ratio_ppm" <= 1000000)),
	CONSTRAINT "security_cash_shape" CHECK ("type" <> 'cash' OR ("ticker" IS NULL AND "asset_class" = 'cash')),
	CONSTRAINT "security_price_fetch_status_check" CHECK ("price_fetch_status" IS NULL OR "price_fetch_status" IN ('ok', 'not_found', 'error', 'rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "security_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"security_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_allocation" (
	"security_id" uuid NOT NULL,
	"asset_class" text NOT NULL,
	"weight_bp" integer NOT NULL,
	CONSTRAINT "security_allocation_pk" PRIMARY KEY("security_id","asset_class"),
	CONSTRAINT "security_allocation_class_check" CHECK ("asset_class" IN ('us_stock', 'intl_stock', 'bonds', 'cash', 'real_estate', 'other')),
	CONSTRAINT "security_allocation_weight_check" CHECK ("weight_bp" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "csv_kind" text DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "lot_method" text DEFAULT 'fifo' NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "cash_inference" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "investment_income_feed" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "household_setting" ADD COLUMN "benchmark_security_id" uuid;--> statement-breakpoint
ALTER TABLE "household_setting" ADD COLUMN "investment_income_category_id" uuid;--> statement-breakpoint
ALTER TABLE "household_setting" ADD COLUMN "rebalance_band_bp" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "household_setting" ADD COLUMN "rebalance_min_trade_cents" bigint DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_reconciliation" ADD CONSTRAINT "account_reconciliation_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_reconciliation" ADD CONSTRAINT "account_reconciliation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_snapshot" ADD CONSTRAINT "holding_snapshot_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_snapshot" ADD CONSTRAINT "holding_snapshot_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_snapshot" ADD CONSTRAINT "holding_snapshot_import_log_id_import_log_id_fk" FOREIGN KEY ("import_log_id") REFERENCES "public"."import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_txn" ADD CONSTRAINT "investment_txn_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_txn" ADD CONSTRAINT "investment_txn_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_txn" ADD CONSTRAINT "investment_txn_counterparty_account_id_account_id_fk" FOREIGN KEY ("counterparty_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_txn" ADD CONSTRAINT "investment_txn_ledger_transaction_id_transaction_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_txn" ADD CONSTRAINT "investment_txn_import_log_id_import_log_id_fk" FOREIGN KEY ("import_log_id") REFERENCES "public"."import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot" ADD CONSTRAINT "lot_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot" ADD CONSTRAINT "lot_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot" ADD CONSTRAINT "lot_opened_by_txn_id_investment_txn_id_fk" FOREIGN KEY ("opened_by_txn_id") REFERENCES "public"."investment_txn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot" ADD CONSTRAINT "lot_origin_lot_id_lot_id_fk" FOREIGN KEY ("origin_lot_id") REFERENCES "public"."lot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_disposal" ADD CONSTRAINT "lot_disposal_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_disposal" ADD CONSTRAINT "lot_disposal_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_disposal" ADD CONSTRAINT "lot_disposal_close_txn_id_investment_txn_id_fk" FOREIGN KEY ("close_txn_id") REFERENCES "public"."investment_txn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_disposal" ADD CONSTRAINT "lot_disposal_lot_id_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_pick" ADD CONSTRAINT "lot_pick_sell_txn_id_investment_txn_id_fk" FOREIGN KEY ("sell_txn_id") REFERENCES "public"."investment_txn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_pick" ADD CONSTRAINT "lot_pick_lot_id_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price" ADD CONSTRAINT "price_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alias" ADD CONSTRAINT "security_alias_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_allocation" ADD CONSTRAINT "security_allocation_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_reconciliation_account_idx" ON "account_reconciliation" USING btree ("account_id","statement_date","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "holding_snapshot_account_security_date_idx" ON "holding_snapshot" USING btree ("account_id","security_id","date");--> statement-breakpoint
CREATE INDEX "holding_snapshot_account_date_idx" ON "holding_snapshot" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "holding_snapshot_security_date_idx" ON "holding_snapshot" USING btree ("security_id","date");--> statement-breakpoint
CREATE INDEX "holding_snapshot_date_idx" ON "holding_snapshot" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_txn_account_external_idx" ON "investment_txn" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "investment_txn_account_security_date_idx" ON "investment_txn" USING btree ("account_id","security_id","date","sequence");--> statement-breakpoint
CREATE INDEX "investment_txn_security_date_idx" ON "investment_txn" USING btree ("security_id","date");--> statement-breakpoint
CREATE INDEX "investment_txn_transfer_group_idx" ON "investment_txn" USING btree ("transfer_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_txn_ledger_idx" ON "investment_txn" USING btree ("ledger_transaction_id") WHERE "ledger_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "investment_txn_date_idx" ON "investment_txn" USING btree ("date");--> statement-breakpoint
CREATE INDEX "investment_txn_account_type_date_idx" ON "investment_txn" USING btree ("account_id","type","date");--> statement-breakpoint
CREATE UNIQUE INDEX "lot_opened_by_ordinal_idx" ON "lot" USING btree ("opened_by_txn_id","ordinal");--> statement-breakpoint
CREATE INDEX "lot_account_security_idx" ON "lot" USING btree ("account_id","security_id","closed_date");--> statement-breakpoint
CREATE INDEX "lot_account_open_idx" ON "lot" USING btree ("account_id") WHERE "quantity" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "lot_disposal_close_lot_idx" ON "lot_disposal" USING btree ("close_txn_id",COALESCE("lot_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "lot_disposal_account_date_idx" ON "lot_disposal" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "lot_disposal_lot_idx" ON "lot_disposal" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lot_pick_sell_lot_idx" ON "lot_pick" USING btree ("sell_txn_id","lot_id");--> statement-breakpoint
CREATE INDEX "lot_pick_lot_idx" ON "lot_pick" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_security_date_idx" ON "price" USING btree ("security_id","date");--> statement-breakpoint
CREATE INDEX "price_date_idx" ON "price" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "security_ticker_idx" ON "security" USING btree ("ticker") WHERE "ticker" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "security_cusip_idx" ON "security" USING btree ("cusip") WHERE "cusip" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "security_isin_idx" ON "security" USING btree ("isin") WHERE "isin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "security_cash_currency_idx" ON "security" USING btree ("currency") WHERE "type" = 'cash';--> statement-breakpoint
CREATE INDEX "security_name_norm_idx" ON "security" USING btree (upper(regexp_replace("name", '[^A-Za-z0-9]+', ' ', 'g')));--> statement-breakpoint
CREATE INDEX "security_needs_review_idx" ON "security" USING btree ("needs_review");--> statement-breakpoint
CREATE UNIQUE INDEX "security_alias_kind_value_idx" ON "security_alias" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "security_alias_security_idx" ON "security_alias" USING btree ("security_id");--> statement-breakpoint
ALTER TABLE "household_setting" ADD CONSTRAINT "household_setting_benchmark_security_id_security_id_fk" FOREIGN KEY ("benchmark_security_id") REFERENCES "public"."security"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_setting" ADD CONSTRAINT "household_setting_investment_income_category_id_category_id_fk" FOREIGN KEY ("investment_income_category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_lot_method_check" CHECK ("lot_method" IN ('fifo', 'specific'));--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_cash_inference_check" CHECK ("cash_inference" IN ('auto', 'off'));--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_income_feed_check" CHECK ("investment_income_feed" IN ('off', 'link', 'create'));--> statement-breakpoint
ALTER TABLE "household_setting" ADD CONSTRAINT "household_setting_rebalance_band_check" CHECK ("rebalance_band_bp" >= 0 AND "rebalance_band_bp" <= 5000);--> statement-breakpoint
ALTER TABLE "household_setting" ADD CONSTRAINT "household_setting_min_trade_check" CHECK ("rebalance_min_trade_cents" >= 0);