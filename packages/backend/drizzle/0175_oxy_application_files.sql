-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "oxy_application_files" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_application_files_file_id_check" CHECK ("oxy_application_files"."file_id" ~ '^[A-Za-z0-9_-]+$' and length("oxy_application_files"."file_id") <= 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_application_files_file_id_key" ON "oxy_application_files" USING btree ("file_id");