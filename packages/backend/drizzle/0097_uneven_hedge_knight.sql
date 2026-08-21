-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "native_listing_attribute_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"kind" text NOT NULL,
	"raw_name" text NOT NULL,
	"raw_value" text,
	"raw_name_normalized" text GENERATED ALWAYS AS (lower(btrim("raw_name"))) STORED NOT NULL,
	"raw_value_key" text GENERATED ALWAYS AS (lower(btrim(coalesce("raw_value", '')))) STORED NOT NULL,
	"provenance" text NOT NULL,
	"source_connection_id" text,
	"asserted_by_oxy_user_id" text,
	"asserted_at" timestamp with time zone NOT NULL,
	"attribute_resolution" text DEFAULT 'unresolved' NOT NULL,
	"attribute_refusal" text,
	"value_resolution" text DEFAULT 'unresolved' NOT NULL,
	"value_refusal" text,
	"attribute_definition_id" text,
	"attribute_definition_version" integer,
	"enum_value_id" text,
	"normalized_value" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_listing_attribute_claims_kind_check" CHECK ("native_listing_attribute_claims"."kind" in ('attribute_value', 'axis_declaration')),
	CONSTRAINT "native_listing_attribute_claims_raw_name_check" CHECK (btrim("native_listing_attribute_claims"."raw_name") <> ''),
	CONSTRAINT "native_listing_attribute_claims_kind_shape_check" CHECK (("native_listing_attribute_claims"."kind" = 'attribute_value') = ("native_listing_attribute_claims"."raw_value" is not null)),
	CONSTRAINT "native_listing_attribute_claims_declaration_value_check" CHECK ("native_listing_attribute_claims"."kind" = 'attribute_value' or "native_listing_attribute_claims"."value_resolution" = 'unresolved'),
	CONSTRAINT "native_listing_attribute_claims_provenance_check" CHECK ("native_listing_attribute_claims"."provenance" in ('merchant_declared', 'p2p_seller_declared', 'connector_import', 'operator_correction', 'legacy_option_migration')),
	CONSTRAINT "native_listing_attribute_claims_connector_provenance_check" CHECK (("native_listing_attribute_claims"."provenance" = 'connector_import') = ("native_listing_attribute_claims"."source_connection_id" is not null)),
	CONSTRAINT "native_listing_attribute_claims_legacy_provenance_check" CHECK ("native_listing_attribute_claims"."provenance" <> 'legacy_option_migration' or "native_listing_attribute_claims"."asserted_by_oxy_user_id" is null),
	CONSTRAINT "native_listing_attribute_claims_attribute_resolution_check" CHECK ("native_listing_attribute_claims"."attribute_resolution" in ('unresolved', 'resolved', 'blocked', 'refused')),
	CONSTRAINT "native_listing_attribute_claims_attribute_refusal_check" CHECK ("native_listing_attribute_claims"."attribute_refusal" in ('unmapped', 'ambiguous', 'not_variant_defining', 'forbidden_as_axis', 'operator_refused')),
	CONSTRAINT "native_listing_attribute_claims_value_resolution_check" CHECK ("native_listing_attribute_claims"."value_resolution" in ('unresolved', 'resolved', 'blocked', 'refused')),
	CONSTRAINT "native_listing_attribute_claims_value_refusal_check" CHECK ("native_listing_attribute_claims"."value_refusal" in ('unmapped', 'ambiguous', 'not_controlled', 'attribute_unresolved', 'operator_refused')),
	CONSTRAINT "native_listing_attribute_claims_attribute_refusal_shape_check" CHECK (("native_listing_attribute_claims"."attribute_resolution" in ('blocked', 'refused')) = ("native_listing_attribute_claims"."attribute_refusal" is not null)),
	CONSTRAINT "native_listing_attribute_claims_value_refusal_shape_check" CHECK (("native_listing_attribute_claims"."value_resolution" in ('blocked', 'refused')) = ("native_listing_attribute_claims"."value_refusal" is not null)),
	CONSTRAINT "native_listing_attribute_claims_attribute_operator_refusal_check" CHECK (("native_listing_attribute_claims"."attribute_resolution" = 'refused') = ("native_listing_attribute_claims"."attribute_refusal" is not distinct from 'operator_refused')),
	CONSTRAINT "native_listing_attribute_claims_value_operator_refusal_check" CHECK (("native_listing_attribute_claims"."value_resolution" = 'refused') = ("native_listing_attribute_claims"."value_refusal" is not distinct from 'operator_refused')),
	CONSTRAINT "native_listing_attribute_claims_attribute_resolved_check" CHECK (("native_listing_attribute_claims"."attribute_resolution" = 'resolved') = ("native_listing_attribute_claims"."attribute_definition_id" is not null)),
	CONSTRAINT "native_listing_attribute_claims_attribute_version_check" CHECK (("native_listing_attribute_claims"."attribute_definition_id" is null) = ("native_listing_attribute_claims"."attribute_definition_version" is null)),
	CONSTRAINT "native_listing_attribute_claims_value_resolved_check" CHECK (("native_listing_attribute_claims"."value_resolution" = 'resolved') = ("native_listing_attribute_claims"."normalized_value" is not null)),
	CONSTRAINT "native_listing_attribute_claims_enum_value_check" CHECK ("native_listing_attribute_claims"."enum_value_id" is null or "native_listing_attribute_claims"."value_resolution" = 'resolved'),
	CONSTRAINT "native_listing_attribute_claims_value_depends_on_attribute_check" CHECK ("native_listing_attribute_claims"."value_resolution" <> 'resolved' or "native_listing_attribute_claims"."attribute_resolution" = 'resolved'),
	CONSTRAINT "native_listing_attribute_claims_resolver_audit_check" CHECK (num_nonnulls("native_listing_attribute_claims"."resolved_by_oxy_user_id", "native_listing_attribute_claims"."resolved_at") <> 1),
	CONSTRAINT "native_listing_attribute_claims_operator_refusal_audit_check" CHECK (("native_listing_attribute_claims"."attribute_resolution" <> 'refused' and "native_listing_attribute_claims"."value_resolution" <> 'refused')
          or ("native_listing_attribute_claims"."resolved_by_oxy_user_id" is not null and "native_listing_attribute_claims"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "native_listing_variant_axes" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"attribute_definition_version" integer NOT NULL,
	"product_type_definition_id" text,
	"legacy_option_name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_listing_variant_axes_attribute_key_shape_check" CHECK ("native_listing_variant_axes"."attribute_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "native_listing_variant_axes_attribute_version_check" CHECK ("native_listing_variant_axes"."attribute_definition_version" >= 1),
	CONSTRAINT "native_listing_variant_axes_position_check" CHECK ("native_listing_variant_axes"."position" >= 0),
	CONSTRAINT "native_listing_variant_axes_forbidden_key_check" CHECK ("native_listing_variant_axes"."attribute_key" <> all (array['price', 'sale_price', 'list_price', 'current_price', 'total_price', 'known_total', 'availability', 'in_stock', 'stock', 'stock_level', 'inventory', 'condition', 'shipping_cost', 'shipping_price', 'delivery_cost', 'delivery_days', 'lead_time', 'seller', 'merchant', 'offer_count', 'vehicle_make', 'vehicle_model', 'vehicle_generation', 'vehicle_configuration', 'vehicle_year', 'vehicle_year_range', 'model_year', 'year_range', 'fitment', 'fits_vehicle', 'compatible_with', 'compatible_model', 'compatibility']::text[]))
);
--> statement-breakpoint
CREATE TABLE "native_variant_attribute_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"raw_name" text NOT NULL,
	"raw_value" text NOT NULL,
	"raw_name_normalized" text GENERATED ALWAYS AS (lower(btrim("raw_name"))) STORED NOT NULL,
	"raw_value_key" text GENERATED ALWAYS AS (lower(btrim("raw_value"))) STORED NOT NULL,
	"provenance" text NOT NULL,
	"source_connection_id" text,
	"asserted_by_oxy_user_id" text,
	"asserted_at" timestamp with time zone NOT NULL,
	"attribute_resolution" text DEFAULT 'unresolved' NOT NULL,
	"attribute_refusal" text,
	"value_resolution" text DEFAULT 'unresolved' NOT NULL,
	"value_refusal" text,
	"attribute_definition_id" text,
	"attribute_definition_version" integer,
	"enum_value_id" text,
	"normalized_value" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_variant_attribute_claims_raw_name_check" CHECK (btrim("native_variant_attribute_claims"."raw_name") <> ''),
	CONSTRAINT "native_variant_attribute_claims_provenance_check" CHECK ("native_variant_attribute_claims"."provenance" in ('merchant_declared', 'p2p_seller_declared', 'connector_import', 'operator_correction', 'legacy_option_migration')),
	CONSTRAINT "native_variant_attribute_claims_connector_provenance_check" CHECK (("native_variant_attribute_claims"."provenance" = 'connector_import') = ("native_variant_attribute_claims"."source_connection_id" is not null)),
	CONSTRAINT "native_variant_attribute_claims_legacy_provenance_check" CHECK ("native_variant_attribute_claims"."provenance" <> 'legacy_option_migration' or "native_variant_attribute_claims"."asserted_by_oxy_user_id" is null),
	CONSTRAINT "native_variant_attribute_claims_attribute_resolution_check" CHECK ("native_variant_attribute_claims"."attribute_resolution" in ('unresolved', 'resolved', 'blocked', 'refused')),
	CONSTRAINT "native_variant_attribute_claims_attribute_refusal_check" CHECK ("native_variant_attribute_claims"."attribute_refusal" in ('unmapped', 'ambiguous', 'not_variant_defining', 'forbidden_as_axis', 'operator_refused')),
	CONSTRAINT "native_variant_attribute_claims_value_resolution_check" CHECK ("native_variant_attribute_claims"."value_resolution" in ('unresolved', 'resolved', 'blocked', 'refused')),
	CONSTRAINT "native_variant_attribute_claims_value_refusal_check" CHECK ("native_variant_attribute_claims"."value_refusal" in ('unmapped', 'ambiguous', 'not_controlled', 'attribute_unresolved', 'operator_refused')),
	CONSTRAINT "native_variant_attribute_claims_attribute_refusal_shape_check" CHECK (("native_variant_attribute_claims"."attribute_resolution" in ('blocked', 'refused')) = ("native_variant_attribute_claims"."attribute_refusal" is not null)),
	CONSTRAINT "native_variant_attribute_claims_value_refusal_shape_check" CHECK (("native_variant_attribute_claims"."value_resolution" in ('blocked', 'refused')) = ("native_variant_attribute_claims"."value_refusal" is not null)),
	CONSTRAINT "native_variant_attribute_claims_attribute_operator_refusal_check" CHECK (("native_variant_attribute_claims"."attribute_resolution" = 'refused') = ("native_variant_attribute_claims"."attribute_refusal" is not distinct from 'operator_refused')),
	CONSTRAINT "native_variant_attribute_claims_value_operator_refusal_check" CHECK (("native_variant_attribute_claims"."value_resolution" = 'refused') = ("native_variant_attribute_claims"."value_refusal" is not distinct from 'operator_refused')),
	CONSTRAINT "native_variant_attribute_claims_attribute_resolved_check" CHECK (("native_variant_attribute_claims"."attribute_resolution" = 'resolved') = ("native_variant_attribute_claims"."attribute_definition_id" is not null)),
	CONSTRAINT "native_variant_attribute_claims_attribute_version_check" CHECK (("native_variant_attribute_claims"."attribute_definition_id" is null) = ("native_variant_attribute_claims"."attribute_definition_version" is null)),
	CONSTRAINT "native_variant_attribute_claims_value_resolved_check" CHECK (("native_variant_attribute_claims"."value_resolution" = 'resolved') = ("native_variant_attribute_claims"."normalized_value" is not null)),
	CONSTRAINT "native_variant_attribute_claims_enum_value_check" CHECK ("native_variant_attribute_claims"."enum_value_id" is null or "native_variant_attribute_claims"."value_resolution" = 'resolved'),
	CONSTRAINT "native_variant_attribute_claims_value_depends_on_attribute_check" CHECK ("native_variant_attribute_claims"."value_resolution" <> 'resolved' or "native_variant_attribute_claims"."attribute_resolution" = 'resolved'),
	CONSTRAINT "native_variant_attribute_claims_resolver_audit_check" CHECK (num_nonnulls("native_variant_attribute_claims"."resolved_by_oxy_user_id", "native_variant_attribute_claims"."resolved_at") <> 1),
	CONSTRAINT "native_variant_attribute_claims_operator_refusal_audit_check" CHECK (("native_variant_attribute_claims"."attribute_resolution" <> 'refused' and "native_variant_attribute_claims"."value_resolution" <> 'refused')
          or ("native_variant_attribute_claims"."resolved_by_oxy_user_id" is not null and "native_variant_attribute_claims"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "native_variant_axis_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"axis_id" text NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"display_value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"enum_value_id" text,
	"normalized_number" double precision,
	"normalized_unit" text,
	"source_claim_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_variant_axis_assignments_attribute_key_shape_check" CHECK ("native_variant_axis_assignments"."attribute_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "native_variant_axis_assignments_normalized_shape_check" CHECK ("native_variant_axis_assignments"."normalized_value" = lower(btrim("native_variant_axis_assignments"."normalized_value")) and "native_variant_axis_assignments"."normalized_value" <> ''),
	CONSTRAINT "native_variant_axis_assignments_unit_check" CHECK ("native_variant_axis_assignments"."normalized_unit" is null or "native_variant_axis_assignments"."normalized_number" is not null)
);
--> statement-breakpoint
CREATE TABLE "native_variant_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"signature" text NOT NULL,
	"axis_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_variant_signatures_signature_shape_check" CHECK ("native_variant_signatures"."signature" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "native_variant_signatures_axis_count_check" CHECK ("native_variant_signatures"."axis_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "native_listing_attribute_claims" ADD CONSTRAINT "native_listing_attribute_claims_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_attribute_claims" ADD CONSTRAINT "native_listing_attribute_claims_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_attribute_claims" ADD CONSTRAINT "native_listing_attribute_claims_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_attribute_claims" ADD CONSTRAINT "native_listing_attribute_claims_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_variant_axes" ADD CONSTRAINT "native_listing_variant_axes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_variant_axes" ADD CONSTRAINT "native_listing_variant_axes_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_variant_axes" ADD CONSTRAINT "native_listing_variant_axes_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_attribute_claims" ADD CONSTRAINT "native_variant_attribute_claims_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_attribute_claims" ADD CONSTRAINT "native_variant_attribute_claims_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_attribute_claims" ADD CONSTRAINT "native_variant_attribute_claims_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_attribute_claims" ADD CONSTRAINT "native_variant_attribute_claims_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_axis_assignments" ADD CONSTRAINT "native_variant_axis_assignments_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_axis_assignments" ADD CONSTRAINT "native_variant_axis_assignments_axis_id_native_listing_variant_axes_id_fk" FOREIGN KEY ("axis_id") REFERENCES "public"."native_listing_variant_axes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_axis_assignments" ADD CONSTRAINT "native_variant_axis_assignments_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_axis_assignments" ADD CONSTRAINT "native_variant_axis_assignments_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_signatures" ADD CONSTRAINT "native_variant_signatures_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_variant_signatures" ADD CONSTRAINT "native_variant_signatures_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_listing_attribute_claims_identity_key" ON "native_listing_attribute_claims" USING btree ("listing_id","provenance","kind","raw_name_normalized","raw_value_key");--> statement-breakpoint
CREATE INDEX "native_listing_attribute_claims_queue_idx" ON "native_listing_attribute_claims" USING btree ("attribute_resolution","created_at") WHERE "native_listing_attribute_claims"."attribute_resolution" in ('unresolved', 'blocked') or "native_listing_attribute_claims"."value_resolution" in ('unresolved', 'blocked');--> statement-breakpoint
CREATE INDEX "native_listing_attribute_claims_raw_name_idx" ON "native_listing_attribute_claims" USING btree ("raw_name_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "native_listing_variant_axes_listing_attribute_key" ON "native_listing_variant_axes" USING btree ("listing_id","attribute_key");--> statement-breakpoint
CREATE INDEX "native_listing_variant_axes_listing_position_idx" ON "native_listing_variant_axes" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "native_listing_variant_axes_definition_idx" ON "native_listing_variant_axes" USING btree ("attribute_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_variant_attribute_claims_identity_key" ON "native_variant_attribute_claims" USING btree ("variant_id","provenance","raw_name_normalized","raw_value_key");--> statement-breakpoint
CREATE INDEX "native_variant_attribute_claims_queue_idx" ON "native_variant_attribute_claims" USING btree ("attribute_resolution","created_at") WHERE "native_variant_attribute_claims"."attribute_resolution" in ('unresolved', 'blocked') or "native_variant_attribute_claims"."value_resolution" in ('unresolved', 'blocked');--> statement-breakpoint
CREATE INDEX "native_variant_attribute_claims_raw_name_idx" ON "native_variant_attribute_claims" USING btree ("raw_name_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "native_variant_axis_assignments_variant_axis_key" ON "native_variant_axis_assignments" USING btree ("variant_id","axis_id");--> statement-breakpoint
CREATE INDEX "native_variant_axis_assignments_axis_idx" ON "native_variant_axis_assignments" USING btree ("axis_id");--> statement-breakpoint
CREATE INDEX "native_variant_axis_assignments_value_idx" ON "native_variant_axis_assignments" USING btree ("attribute_key","normalized_value");--> statement-breakpoint
CREATE INDEX "native_variant_axis_assignments_claim_idx" ON "native_variant_axis_assignments" USING btree ("source_claim_id") WHERE "native_variant_axis_assignments"."source_claim_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "native_variant_signatures_variant_key" ON "native_variant_signatures" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_variant_signatures_listing_signature_key" ON "native_variant_signatures" USING btree ("listing_id","signature");--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_native_variant_axis_citation
CREATE OR REPLACE FUNCTION mercaria_native_variant_axis_citation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_key text;
  v_version integer;
  v_variant_defining boolean;
begin
  select d.key, d.version, d.variant_defining
    into v_key, v_version, v_variant_defining
    from attribute_definitions d
   where d.id = new.attribute_definition_id;

  if v_key is null then
    raise exception
      'native_listing_variant_axes %: attribute definition % does not exist.',
      new.id, new.attribute_definition_id
      using errcode = 'raise_exception';
  end if;

  if new.attribute_key is distinct from v_key
     or new.attribute_definition_version is distinct from v_version then
    raise exception
      'native_listing_variant_axes %: the citation (%, v%) disagrees with definition % (%, v%).',
      new.id, new.attribute_key, new.attribute_definition_version,
      new.attribute_definition_id, v_key, v_version
      using errcode = 'raise_exception';
  end if;

  if v_variant_defining is not true then
    raise exception
      'native_listing_variant_axes %: attribute "%" is not `variant_defining` in the registry, '
      'so it may not be an axis. Publish a definition version that says it is.',
      new.id, v_key
      using errcode = 'raise_exception';
  end if;

  if new.product_type_definition_id is not null
     and not exists (
       select 1
         from product_type_fields f
        where f.product_type_definition_id = new.product_type_definition_id
          and f.attribute_definition_id = new.attribute_definition_id
          and f.variant_capable is true
          and f.scope = 'variant'
     ) then
    raise exception
      'native_listing_variant_axes %: product type version % declares no `variant_capable` '
      'variant-scope field for attribute "%".',
      new.id, new.product_type_definition_id, v_key
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_axis_citation
BEFORE INSERT OR UPDATE ON native_listing_variant_axes
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_axis_citation();
-- oxy:handwritten-end=mercaria_native_variant_axis_citation
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A declaration is FROZEN. Only its display order moves.
--
-- Re-pointing an axis at a different attribute — or at a different VERSION of
-- the same one — silently reinterprets every assignment already normalized under
-- the old meaning AND every signature computed from it, with nothing in the data
-- saying so. #94's whole versioning posture is that changing what an attribute
-- MEANS schedules a re-normalization rather than rewriting facts; the native
-- form of that is a NEW axis row, which cascades away the assignments that were
-- normalized under the old one.
--
-- `position` is display order and is deliberately not an input to the signature,
-- so moving it changes nothing anybody has recorded.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_variant_axis_frozen
CREATE OR REPLACE FUNCTION mercaria_native_variant_axis_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.listing_id is distinct from old.listing_id
     or new.attribute_definition_id is distinct from old.attribute_definition_id
     or new.attribute_key is distinct from old.attribute_key
     or new.attribute_definition_version is distinct from old.attribute_definition_version
     or new.product_type_definition_id is distinct from old.product_type_definition_id
     -- Provenance, frozen with the rest: which legacy option this axis was
     -- resolved from is the audit trail of the migration, and an editable one
     -- would make the backfill's own report unverifiable afterwards.
     or new.legacy_option_name is distinct from old.legacy_option_name
  then
    raise exception
      'native_listing_variant_axes %: a declared axis is immutable except for its display '
      'position. Declare a new axis and let the old one cascade its assignments away.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_axis_frozen
BEFORE UPDATE ON native_listing_variant_axes
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_axis_frozen();
-- oxy:handwritten-end=mercaria_native_variant_axis_frozen
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. An assignment belongs to ITS OWN listing's axis, and cites ITS OWN
--    variant's claim.
--
-- Four cross-row facts, and the first is the one that matters: without it a
-- variant of listing A could be assigned an axis of listing B, and
-- `native_variant_signatures_listing_signature_key` would then be comparing
-- digests over dimensions the listing does not have. The correct shape is a
-- composite foreign key onto a `unique(id, listing_id)` on `product_variants`
-- (the `product_type_field_groups` device); that target does not exist and this
-- branch may not add it, which is stated in `docs/variant-axes.md` as the change
-- that would retire this half.
--
-- The claim check replaces the foreign key `source_claim_id` deliberately does
-- not carry (see `deferredForeignKeys.ts` for why it does not), and it adds
-- something a foreign key could not: the claim must be about the SAME variant.
-- A typed value citing another variant's assertion is an audit trail that points
-- at the wrong person.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_variant_axis_assignment_scope
CREATE OR REPLACE FUNCTION mercaria_native_variant_axis_assignment_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_axis_listing_id text;
  v_axis_definition_id text;
  v_axis_key text;
  v_variant_listing_id text;
begin
  select a.listing_id, a.attribute_definition_id, a.attribute_key
    into v_axis_listing_id, v_axis_definition_id, v_axis_key
    from native_listing_variant_axes a
   where a.id = new.axis_id;

  select v.listing_id into v_variant_listing_id
    from product_variants v
   where v.id = new.variant_id;

  if v_axis_listing_id is distinct from v_variant_listing_id then
    raise exception
      'native_variant_axis_assignments %: axis % belongs to listing % and variant % to listing %.',
      new.id, new.axis_id, v_axis_listing_id, new.variant_id, v_variant_listing_id
      using errcode = 'raise_exception';
  end if;

  if new.attribute_definition_id is distinct from v_axis_definition_id
     or new.attribute_key is distinct from v_axis_key then
    raise exception
      'native_variant_axis_assignments %: the citation (%, "%") disagrees with axis % (%, "%").',
      new.id, new.attribute_definition_id, new.attribute_key,
      new.axis_id, v_axis_definition_id, v_axis_key
      using errcode = 'raise_exception';
  end if;

  if new.enum_value_id is not null
     and not exists (
       select 1 from attribute_enum_values e
        where e.id = new.enum_value_id
          and e.attribute_definition_id = new.attribute_definition_id
     ) then
    raise exception
      'native_variant_axis_assignments %: controlled value % does not belong to definition %.',
      new.id, new.enum_value_id, new.attribute_definition_id
      using errcode = 'raise_exception';
  end if;

  if new.source_claim_id is not null
     and not exists (
       select 1 from native_variant_attribute_claims c
        where c.id = new.source_claim_id
          and c.variant_id = new.variant_id
     ) then
    raise exception
      'native_variant_axis_assignments %: claim % is not a claim about variant %.',
      new.id, new.source_claim_id, new.variant_id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_axis_assignment_scope
BEFORE INSERT OR UPDATE ON native_variant_axis_assignments
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_axis_assignment_scope();
-- oxy:handwritten-end=mercaria_native_variant_axis_assignment_scope
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A signature's `listing_id` is the variant's own.
--
-- The denormalization exists because `UNIQUE(listing_id, signature)` — the
-- order-independence gate — needs the column, and an index cannot join. This is
-- what makes it safe rather than merely conventional: the composite foreign key
-- that would make it structural needs a `unique(id, listing_id)` on
-- `product_variants` this branch may not add.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_variant_signature_scope
CREATE OR REPLACE FUNCTION mercaria_native_variant_signature_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_variant_listing_id text;
begin
  select v.listing_id into v_variant_listing_id
    from product_variants v
   where v.id = new.variant_id;

  if v_variant_listing_id is distinct from new.listing_id then
    raise exception
      'native_variant_signatures %: variant % belongs to listing %, not to %.',
      new.id, new.variant_id, v_variant_listing_id, new.listing_id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_signature_scope
BEFORE INSERT OR UPDATE ON native_variant_signatures
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_signature_scope();
-- oxy:handwritten-end=mercaria_native_variant_signature_scope
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A signature covers EXACTLY the assignments that exist — checked at COMMIT.
--
-- A signature is a claim about a SET of rows in another table, so no row trigger
-- can see whether the set is what was hashed, and no statement order makes every
-- intermediate state consistent: writing a variant's axes inserts assignments and
-- upserts a signature, and one of them is always first. That is exactly what a
-- DEFERRABLE constraint trigger is for — the `mercaria_catalog_source_rights_agree`
-- device, one domain over.
--
-- It is mounted on BOTH tables and on all three operations, because the failure
-- it exists to catch is one-sided by nature: an assignment inserted or removed
-- without the signature being recomputed leaves two distinct variants colliding
-- (or one failing to collide with itself), and a signature removed while its
-- assignments remain leaves a variant with axes and no identity.
--
-- What it does NOT check is that the digest covers the right VALUES. Re-hashing
-- in plpgsql would need a digest function this schema does not otherwise require,
-- and the count is what is affordable; `variant-axes.realdb.test.ts` covers the
-- content half by writing an assignment, recomputing, and asserting the digest
-- moved.
--
-- The existence guard is load-bearing: deleting a variant cascades BOTH tables,
-- and at commit this trigger would otherwise fire for every deleted assignment
-- and find no signature. `return null` in an AFTER trigger discards nothing.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_variant_signature_agrees
CREATE OR REPLACE FUNCTION mercaria_native_variant_signature_agrees()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_variant_id text;
  v_assignments integer;
  v_declared integer;
begin
  if tg_op = 'DELETE' then
    v_variant_id := old.variant_id;
  else
    v_variant_id := new.variant_id;
  end if;

  -- The variant went away in this same transaction, which cascaded both tables.
  -- There is nothing left to reconcile and nothing wrong with that.
  if not exists (select 1 from product_variants v where v.id = v_variant_id) then
    return null;
  end if;

  select count(*) into v_assignments
    from native_variant_axis_assignments a
   where a.variant_id = v_variant_id;

  select s.axis_count into v_declared
    from native_variant_signatures s
   where s.variant_id = v_variant_id;

  if v_declared is null then
    if v_assignments = 0 then
      return null;
    end if;
    raise exception
      'variant % has % axis assignment(s) and no signature row. Write both, in one transaction.',
      v_variant_id, v_assignments
      using errcode = 'raise_exception';
  end if;

  if v_declared <> v_assignments then
    raise exception
      'variant %: its signature declares % axis/axes and % assignment row(s) exist. '
      'Recompute the signature in the same transaction that writes the assignments.',
      v_variant_id, v_declared, v_assignments
      using errcode = 'raise_exception';
  end if;

  return null;
end;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER mercaria_native_variant_signature_agrees
AFTER INSERT OR UPDATE OR DELETE ON native_variant_axis_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_signature_agrees();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER mercaria_native_signature_agrees
AFTER INSERT OR UPDATE OR DELETE ON native_variant_signatures
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_signature_agrees();
-- oxy:handwritten-end=mercaria_native_variant_signature_agrees
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 6. A LISTING claim's assertion is frozen; only its resolution moves.
--
-- ADR 0007 D7: a canonical fact never overwrites the claim that disagreed with
-- it, and both are retained, which is what makes a correction auditable. An
-- editable `raw_name` or `raw_value` is exactly the hole in that sentence — the
-- assertion somebody is being held to could be rewritten to whatever the
-- resolution turned out to be, and the disagreement would vanish rather than be
-- recorded.
--
-- The subject, the kind, the provenance and the assertion instant are frozen with
-- the text, for the same reason `catalog_external_mapping_reviews` freezes its
-- subject: the answer in `attribute_definition_id` would otherwise be an answer
-- to a question nobody can see any more.
--
-- `raw_name_normalized` and `raw_value_key` are STORED GENERATED and are NOT
-- compared here — see the file header.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_listing_claim_frozen
CREATE OR REPLACE FUNCTION mercaria_native_listing_claim_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.listing_id is distinct from old.listing_id
     or new.kind is distinct from old.kind
     or new.raw_name is distinct from old.raw_name
     or new.raw_value is distinct from old.raw_value
     or new.provenance is distinct from old.provenance
     or new.source_connection_id is distinct from old.source_connection_id
     or new.asserted_by_oxy_user_id is distinct from old.asserted_by_oxy_user_id
     or new.asserted_at is distinct from old.asserted_at
  then
    raise exception
      'native_listing_attribute_claims %: what a party asserted is immutable. '
      'Record a new claim; both are retained (ADR 0007 D7).', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_listing_claim_frozen
BEFORE UPDATE ON native_listing_attribute_claims
FOR EACH ROW EXECUTE FUNCTION mercaria_native_listing_claim_frozen();
-- oxy:handwritten-end=mercaria_native_listing_claim_frozen
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 7. And the same for a VARIANT claim.
--
-- A separate function rather than one shared body, because the two tables carry
-- different columns (`kind` and `listing_id` against `variant_id`) and a shared
-- body would have to reach them through `to_jsonb(new)` — at which point the
-- column list stops being greppable and the declared-partition census in
-- `variant-axis-schema.test.ts` has nothing to match against. The census is worth
-- more than the duplication it costs.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_variant_claim_frozen
CREATE OR REPLACE FUNCTION mercaria_native_variant_claim_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.variant_id is distinct from old.variant_id
     or new.raw_name is distinct from old.raw_name
     or new.raw_value is distinct from old.raw_value
     or new.provenance is distinct from old.provenance
     or new.source_connection_id is distinct from old.source_connection_id
     or new.asserted_by_oxy_user_id is distinct from old.asserted_by_oxy_user_id
     or new.asserted_at is distinct from old.asserted_at
  then
    raise exception
      'native_variant_attribute_claims %: what a party asserted is immutable. '
      'Record a new claim; both are retained (ADR 0007 D7).', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_claim_frozen
BEFORE UPDATE ON native_variant_attribute_claims
FOR EACH ROW EXECUTE FUNCTION mercaria_native_variant_claim_frozen();
-- oxy:handwritten-end=mercaria_native_variant_claim_frozen
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 8. A claim cannot be deleted while its subject exists.
--
-- The #90 revision-trail device, and the PRECISION is the point: a blanket
-- `BEFORE DELETE` refusal would fire during the cascade from `listings` and
-- `product_variants` too, so deleting a listing would become impossible. Refusing
-- only while the parent is still there leaves the declared `ON DELETE cascade`
-- working and closes the one thing it must: an operator removing the assertion
-- their own resolution disagreed with.
--
-- ONE function, TWO mounts, ONE marker block. Two blocks would have to share a
-- name.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_native_claim_no_delete
CREATE OR REPLACE FUNCTION mercaria_native_claim_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_subject_alive boolean;
begin
  if tg_table_name = 'native_listing_attribute_claims' then
    select exists (select 1 from listings l where l.id = old.listing_id) into v_subject_alive;
  else
    select exists (select 1 from product_variants v where v.id = old.variant_id) into v_subject_alive;
  end if;

  if v_subject_alive then
    raise exception
      '% %: a retained claim may not be deleted while its subject exists. '
      'Refuse it instead — the row is the record that somebody asserted it.',
      tg_table_name, old.id
      using errcode = 'raise_exception';
  end if;

  return old;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_native_listing_claim_no_delete
BEFORE DELETE ON native_listing_attribute_claims
FOR EACH ROW EXECUTE FUNCTION mercaria_native_claim_no_delete();--> statement-breakpoint
CREATE TRIGGER mercaria_native_variant_claim_no_delete
BEFORE DELETE ON native_variant_attribute_claims
FOR EACH ROW EXECUTE FUNCTION mercaria_native_claim_no_delete();
-- oxy:handwritten-end=mercaria_native_claim_no_delete
