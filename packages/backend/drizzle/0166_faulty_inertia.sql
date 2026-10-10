-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "review_media" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "review_media_kind_check" CHECK ("review_media"."kind" in ('image', 'video')),
	CONSTRAINT "review_media_file_id_check" CHECK ("review_media"."file_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "review_media_position_check" CHECK ("review_media"."position" >= 0 and "review_media"."position" < 10)
);
--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_media_review_id_position_key" ON "review_media" USING btree ("review_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "review_media_review_id_file_id_key" ON "review_media" USING btree ("review_id","file_id");