-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "material_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"public_area" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"pickup_instructions" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "material_offers_status_check" CHECK ("material_offers"."status" in ('active', 'closed')),
	CONSTRAINT "material_offers_quantity_check" CHECK ("material_offers"."quantity" between 1 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "material_reservation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"acting_account_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "material_reservation_events_status_check" CHECK ("material_reservation_events"."status" in ('requested', 'accepted', 'cancelled', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "material_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"requester_account_id" text NOT NULL,
	"moovo_transport_id" text,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "material_reservations_status_check" CHECK ("material_reservations"."status" in ('requested', 'accepted', 'cancelled', 'delivered')),
	CONSTRAINT "material_reservations_quantity_check" CHECK ("material_reservations"."quantity" between 1 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "material_reservation_events" ADD CONSTRAINT "material_reservation_events_reservation_id_material_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."material_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_offer_id_material_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."material_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "material_offers_owner_key" ON "material_offers" USING btree ("owner_account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "material_offers_status_id_idx" ON "material_offers" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "material_reservation_events_action_key" ON "material_reservation_events" USING btree ("reservation_id","acting_account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "material_reservations_request_key" ON "material_reservations" USING btree ("requester_account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "material_reservations_offer_status_idx" ON "material_reservations" USING btree ("offer_id","status");--> statement-breakpoint
CREATE INDEX "material_reservations_requester_id_idx" ON "material_reservations" USING btree ("requester_account_id","id");