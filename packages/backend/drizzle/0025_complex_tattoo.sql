-- oxy:deploy-phase=post
-- oxy:rollback=restore: attribute_definitions.allowed_values, attribute_definitions.is_active and canonical_attribute_values.selected and every value in them. Only a snapshot from before this ran has them; the pre-#94 image reads all three
--
-- #94's NARROWING half, split from 0024 because each statement here breaks a
-- write the PREVIOUS image still performs:
--
--   * `attribute_definitions.value_type` moves from #56's
--     `text | number | boolean | enum | quantity` to #94's nine-member
--     vocabulary. That is a clean cut, not a widening: `quantity` became
--     `measurement` (the issue's word, and now covering the dimensionless
--     families), `number` split into `integer` and `decimal` because their
--     validation genuinely differs, and `text` became `string`. Applied early,
--     the previous image's writes would fail this CHECK.
--   * `attribute_definitions_quantity_unit_check` is replaced by
--     `attribute_definitions_measurement_unit_check` — the same biconditional
--     against the renamed value type, widened to cover `structured`, whose
--     components are magnitudes on named axes and therefore need a base unit
--     of their own.
--   * `canonical_attribute_values.normalization_state` drops `conflicting` and
--     gains `out_of_range`, `implausible` and `marketing_claim`. Disagreement is
--     a property of the SELECTION between two well-parsed facts, not of either
--     one's parse; conflating them made "we could not read it" and "two sources
--     disagree" indistinguishable in the one place an operator needs them apart.
--   * `allowed_values` and `is_active` leave `attribute_definitions`. The first
--     is superseded by `attribute_enum_values` + `attribute_value_aliases` (an
--     alias must resolve to exactly one canonical value, which needs a row to
--     point at, and keeping both would be two representations of the permitted
--     set). The second is superseded by `lifecycle_state`, which distinguishes
--     the four states a boolean collapsed into two.
--   * `canonical_attribute_values.selected` leaves, superseded by
--     `selection_state`, which can say WHY a value is not shown.
--   * The two `definition_version` biconditionals arrive here rather than in
--     0022 because the previous image writes `attribute_definition_id` with no
--     version, which they refuse.
--
-- Nothing here rewrites a row. The tables this touches are empty on every
-- deployment today (the canonical graph is unbackfilled and the operator
-- surface is unmounted without `CATALOG_OPERATOR_OXY_USER_IDS`), so the value
-- renames need no data migration; if that ever stops being true, a data
-- migration belongs in its own file BEFORE this one, not folded into it.

ALTER TABLE "attribute_definitions" DROP CONSTRAINT "attribute_definitions_quantity_unit_check";--> statement-breakpoint
ALTER TABLE "attribute_definitions" DROP CONSTRAINT "attribute_definitions_value_type_check";--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" DROP CONSTRAINT "canonical_attribute_values_state_check";--> statement-breakpoint
ALTER TABLE "attribute_definitions" DROP COLUMN "allowed_values";--> statement-breakpoint
ALTER TABLE "attribute_definitions" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" DROP COLUMN "selected";--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_measurement_unit_check" CHECK (("attribute_definitions"."value_type" in ('measurement', 'structured')) = ("attribute_definitions"."unit_family" is not null));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_value_type_check" CHECK ("attribute_definitions"."value_type" in ('boolean', 'integer', 'decimal', 'string', 'enum', 'date', 'money', 'measurement', 'structured'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_definition_version_check" CHECK (("canonical_attribute_values"."attribute_definition_id" is null) = ("canonical_attribute_values"."definition_version" is null));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_state_check" CHECK ("canonical_attribute_values"."normalization_state" in ('normalized', 'unknown_unit', 'unparsed', 'out_of_range', 'implausible', 'marketing_claim'));--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" ADD CONSTRAINT "canonical_variant_attrs_definition_version_check" CHECK (("canonical_variant_attributes"."attribute_definition_id" is null) = ("canonical_variant_attributes"."definition_version" is null));