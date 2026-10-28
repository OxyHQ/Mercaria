-- oxy:deploy-phase=pre
-- oxy:rollback=derived
ALTER TABLE "collections" ADD CONSTRAINT "collections_id_store_id_key" UNIQUE("id","store_id");
--> statement-breakpoint
CREATE TABLE "store_featured_collections" (
	"store_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "store_featured_collections_store_id_collection_id_pk" PRIMARY KEY("store_id","collection_id"),
	CONSTRAINT "store_featured_collections_position_key" UNIQUE("store_id","position"),
	CONSTRAINT "store_featured_collections_position_check" CHECK ("store_featured_collections"."position" >= 0 AND "store_featured_collections"."position" < 6)
);
--> statement-breakpoint
ALTER TABLE "store_featured_collections" ADD CONSTRAINT "store_featured_collections_collection_id_store_id_collections_id_store_id_fk" FOREIGN KEY ("collection_id","store_id") REFERENCES "public"."collections"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
