-- oxy:deploy-phase=pre
-- oxy:rollback=derived
ALTER TABLE "attribute_enum_values" ADD COLUMN "replaces_enum_value_id" text;--> statement-breakpoint
ALTER TABLE "attribute_enum_values" ADD CONSTRAINT "attribute_enum_values_replaces_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("replaces_enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_enum_values_replaces_key" ON "attribute_enum_values" USING btree ("replaces_enum_value_id") WHERE "attribute_enum_values"."replaces_enum_value_id" is not null;--> statement-breakpoint
ALTER TABLE "attribute_enum_values" ADD CONSTRAINT "attribute_enum_values_replaces_self_check" CHECK ("attribute_enum_values"."replaces_enum_value_id" is null or "attribute_enum_values"."replaces_enum_value_id" <> "attribute_enum_values"."id");