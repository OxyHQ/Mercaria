-- oxy:deploy-phase=pre
-- oxy:rollback=derived
ALTER TABLE "attribute_definitions" ADD COLUMN "replaced_by_definition_id" text;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_replaced_by_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("replaced_by_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_replaced_by_self_check" CHECK ("attribute_definitions"."replaced_by_definition_id" is null or "attribute_definitions"."replaced_by_definition_id" <> "attribute_definitions"."id");--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_replaced_by_lifecycle_check" CHECK ("attribute_definitions"."replaced_by_definition_id" is null
          or "attribute_definitions"."lifecycle_state" in ('deprecated', 'retired'));