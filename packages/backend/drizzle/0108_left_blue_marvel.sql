-- oxy:deploy-phase=pre
-- oxy:rollback=restore: attribute_definitions_axes_domain_check and its three axis siblings are widened for component axes; the previous forms are in 0024 and 0098, and re-adding any of them fails against a stored value naming a component axis
--
-- #367 workstream 4: apparel compound sizes. `ATTRIBUTE_COMPONENT_AXES` gains
-- five garment positions (waist, inseam, chest, sleeve, neck) beside the five
-- object-geometry axes, so a 32x34 jean is one size with two NAMED components
-- rather than the string `32x34` compared as text.
--
-- Additive, and the phase is what says so: every one of these four CHECKs now
-- admits a STRICT SUPERSET of what it admitted before, so no write the serving
-- image performs can fail against the new constraint and no existing row can
-- violate it. A narrowing here would be the other phase; the two are told apart
-- by the superset check recorded in the PR, not by which verbs appear -- a
-- widening and a narrowing are the identical DROP/ADD pair in the diff.
--
-- Four tables and not two: `attribute_definitions.component_axes` (an array, so
-- containment rather than membership), plus a `component_axis` column on
-- `attribute_source_mappings`, `canonical_attribute_values` and
-- `catalog_authoring_draft_values`. The last two carry their CHECK inline from
-- their CREATE TABLE, so grepping the chain for an ADD CONSTRAINT finds only
-- two of the four -- which is how a reader concludes there are two.
--
-- Regenerated at 0108 after #578 took 0107 mid-flight. The file was NOT
-- renamed: the snapshot and journal were restored to main's and drizzle-kit ran
-- again against the post-merge chain, because a renamed migration keeps a
-- snapshot that diffs against the wrong parent and the damage lands on whoever
-- generates next.

ALTER TABLE "attribute_definitions" DROP CONSTRAINT "attribute_definitions_axes_domain_check";--> statement-breakpoint
ALTER TABLE "attribute_source_mappings" DROP CONSTRAINT "attribute_source_mappings_axis_check";--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" DROP CONSTRAINT "canonical_attribute_values_axis_check";--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" DROP CONSTRAINT "catalog_authoring_draft_values_component_axis_check";--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_axes_domain_check" CHECK ("attribute_definitions"."component_axes" <@ array['width', 'height', 'depth', 'diagonal', 'circumference', 'waist', 'inseam', 'chest', 'sleeve', 'neck']::text[]);--> statement-breakpoint
ALTER TABLE "attribute_source_mappings" ADD CONSTRAINT "attribute_source_mappings_axis_check" CHECK ("attribute_source_mappings"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference', 'waist', 'inseam', 'chest', 'sleeve', 'neck'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_axis_check" CHECK ("canonical_attribute_values"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference', 'waist', 'inseam', 'chest', 'sleeve', 'neck'));--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_component_axis_check" CHECK ("catalog_authoring_draft_values"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference', 'waist', 'inseam', 'chest', 'sleeve', 'neck'));