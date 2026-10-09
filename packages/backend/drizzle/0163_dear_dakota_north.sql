-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "review_helpful_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_helpful_votes" ADD CONSTRAINT "review_helpful_votes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_helpful_votes_review_user_key" ON "review_helpful_votes" USING btree ("review_id","oxy_user_id");
