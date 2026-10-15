-- oxy:deploy-phase=pre
CREATE TABLE "organization_identity_archives" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"website_url" text,
	"verified_domains" text[] NOT NULL,
	"country_code" text,
	"logo_file_id" text,
	"logo_source_record_id" text,
	"archived_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "normalized_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "organization_identity_archives" ADD CONSTRAINT "organization_identity_archives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_identity_archives" ADD CONSTRAINT "organization_identity_archives_logo_source_record_id_source_records_id_fk" FOREIGN KEY ("logo_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_identity_archives_organization_id_key" ON "organization_identity_archives" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organizations_oxy_account_id_idx" ON "organizations" USING btree ("oxy_account_id");
--> statement-breakpoint
INSERT INTO organization_identity_archives (id, organization_id, name, legal_name, website_url, verified_domains, country_code, logo_file_id, logo_source_record_id)
SELECT id, id, name, legal_name, website_url, verified_domains, country_code, logo_file_id, logo_source_record_id FROM organizations;
--> statement-breakpoint
CREATE FUNCTION mercaria_freeze_organization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.oxy_account_id IS NULL OR length(btrim(NEW.oxy_account_id)) = 0 THEN
      RAISE EXCEPTION 'New organization references require a canonical Oxy account';
    END IF;
    IF NEW.name IS NOT NULL OR NEW.normalized_name IS NOT NULL OR NEW.legal_name IS NOT NULL OR NEW.website_url IS NOT NULL OR cardinality(NEW.verified_domains) <> 0 OR NEW.country_code IS NOT NULL OR NEW.logo_file_id IS NOT NULL OR NEW.logo_source_record_id IS NOT NULL THEN
      RAISE EXCEPTION 'Organization identity is owned by Oxy';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.name, NEW.normalized_name, NEW.name_fold_version, NEW.legal_name, NEW.website_url, NEW.verified_domains, NEW.country_code, NEW.logo_file_id, NEW.logo_source_record_id)
    IS DISTINCT FROM ROW(OLD.name, OLD.normalized_name, OLD.name_fold_version, OLD.legal_name, OLD.website_url, OLD.verified_domains, OLD.country_code, OLD.logo_file_id, OLD.logo_source_record_id) THEN
    RAISE EXCEPTION 'Organization identity is owned by Oxy';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_identity_frozen BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_organization_identity();
--> statement-breakpoint
CREATE FUNCTION mercaria_organization_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organization identity migration evidence is immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER organization_identity_archives_immutable BEFORE UPDATE OR DELETE ON organization_identity_archives FOR EACH ROW EXECUTE FUNCTION mercaria_organization_archive_immutable();

--> statement-breakpoint
CREATE TRIGGER organization_aliases_identity_frozen
BEFORE INSERT OR UPDATE OR DELETE ON organization_aliases
FOR EACH ROW EXECUTE FUNCTION mercaria_organization_archive_immutable();
