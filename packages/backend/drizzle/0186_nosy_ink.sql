-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Named POS registers (#89, the paid `expanded_pos_registers` tool). Additive:
-- a new table, a NULLable `orders.pos_register_id` (NULL = the location's
-- default register, i.e. every existing sale) and the constraints that keep a
-- register inside its own store. `locations_id_store_id_key` comes FIRST: the
-- composite foreign key from `pos_registers` needs it to exist.
ALTER TABLE "locations" ADD CONSTRAINT "locations_id_store_id_key" UNIQUE("id","store_id");--> statement-breakpoint
CREATE TABLE "pos_registers" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"location_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "pos_registers_id_store_id_key" UNIQUE("id","store_id"),
	CONSTRAINT "pos_registers_name_check" CHECK (char_length("pos_registers"."name") between 1 and 60 and "pos_registers"."name" = btrim("pos_registers"."name"))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pos_register_id" text;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_location_id_store_id_fkey" FOREIGN KEY ("location_id","store_id") REFERENCES "public"."locations"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_live_name_key" ON "pos_registers" USING btree ("location_id",lower("name")) WHERE "pos_registers"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "pos_registers_store_id_location_id_idx" ON "pos_registers" USING btree ("store_id","location_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pos_register_id_store_id_fkey" FOREIGN KEY ("pos_register_id","store_id") REFERENCES "public"."pos_registers"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_pos_register_id_idx" ON "orders" USING btree ("pos_register_id") WHERE "orders"."pos_register_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pos_register_channel_check" CHECK ("orders"."pos_register_id" is null or ("orders"."source_channel" = 'pos' and "orders"."store_id" is not null));