DROP INDEX "security_name_norm_idx";--> statement-breakpoint
CREATE INDEX "security_name_norm_idx" ON "security" USING btree (btrim(upper(regexp_replace("name", '[^A-Za-z0-9]+', ' ', 'g'))));