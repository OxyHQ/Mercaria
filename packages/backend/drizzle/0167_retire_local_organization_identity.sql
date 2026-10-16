-- oxy:deploy-phase=post
-- oxy:rollback=restore: Restore organizations identity columns and indexes from the prior schema snapshot, then recover source facts from organization_identity_archives and recompute normalized_name and search_vector before rolling back the application.
-- A nonempty installation must run the reviewed source-ID backfill before cutover.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE oxy_account_id IS NULL OR length(btrim(oxy_account_id)) = 0) THEN
    RAISE EXCEPTION 'Central organization migration incomplete: run backfill-central-organizations in dry-run then approved apply mode';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organizations o LEFT JOIN organization_identity_archives a ON a.organization_id = o.id
    WHERE o.name IS NOT NULL AND (a.id IS NULL OR
      ROW(o.name,o.legal_name,o.website_url,o.verified_domains,o.country_code,o.logo_file_id,o.logo_source_record_id)
      IS DISTINCT FROM ROW(a.name,a.legal_name,a.website_url,a.verified_domains,a.country_code,a.logo_file_id,a.logo_source_record_id))
  ) THEN
    RAISE EXCEPTION 'Organization migration evidence does not match frozen source identities';
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER organizations_identity_frozen ON organizations;
--> statement-breakpoint
DROP FUNCTION mercaria_freeze_organization_identity();
--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_country_code_check";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_logo_source_record_id_source_records_id_fk";
--> statement-breakpoint
DROP INDEX "organizations_normalized_name_idx";--> statement-breakpoint
DROP INDEX "organizations_normalized_name_trgm_idx";--> statement-breakpoint
DROP INDEX "organizations_verified_domains_idx";--> statement-breakpoint
DROP INDEX "organizations_search_vector_idx";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "oxy_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "normalized_name";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "name_fold_version";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "legal_name";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "website_url";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "verified_domains";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "country_code";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "logo_file_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "logo_source_record_id";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_oxy_account_id_nonempty_check" CHECK (length(btrim("organizations"."oxy_account_id")) > 0);