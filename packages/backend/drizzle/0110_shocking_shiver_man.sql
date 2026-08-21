-- oxy:deploy-phase=pre
-- oxy:rollback=restore: awin_advertiser_quality_nonnegative_check, awin_advertiser_quality_coverage_check and awin_link_samples_findings_check are widened; the previous forms are in the #66 migration and re-adding any of them fails against a stored quality snapshot or link sample using the added vocabulary
--
-- #589, the ADDITIVE half. The clean cut it precedes is the next migration.
--
-- Two new counters on `awin_advertiser_quality` and one WIDENED findings CHECK
-- on `awin_link_samples`. Every statement admits something the previous image
-- never writes, so nothing here breaks a write that image performs:
--
--   * `destination_tracking_host` / `destination_tracked_only` default to 0 and
--     the previous image names neither column, so its inserts take the defaults
--     and both re-added CHECKs read `0 >= 0` and `0 + 0 <= mapped` on every
--     existing row.
--   * The findings CHECK gains `destination_is_tracking_host` and LOSES
--     nothing. It has to permit the value BEFORE the image that offers it on
--     `POST /internal/awin/advertisers/:id/samples` is serving, or an operator
--     recording it between the rollout and the `post` migration gets a 23514.
--
-- The two counter CHECKs are DROPPED and re-ADDED rather than altered because
-- that is how drizzle-kit expresses a changed CHECK. Each re-add is validated
-- against every existing row, which is safe here: the findings predicate is
-- strictly weaker than the one it replaces, and the two counter predicates are
-- equivalent on every existing row, whose new columns are 0.
ALTER TABLE "awin_advertiser_quality" DROP CONSTRAINT "awin_advertiser_quality_nonnegative_check";--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" DROP CONSTRAINT "awin_advertiser_quality_coverage_check";--> statement-breakpoint
ALTER TABLE "awin_link_samples" DROP CONSTRAINT "awin_link_samples_findings_check";--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD COLUMN "destination_tracking_host" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD COLUMN "destination_tracked_only" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_nonnegative_check" CHECK ("awin_advertiser_quality"."scanned" >= 0 and "awin_advertiser_quality"."mapped" >= 0 and "awin_advertiser_quality"."rejected" >= 0
          and "awin_advertiser_quality"."with_gtin" >= 0 and "awin_advertiser_quality"."with_mpn" >= 0 and "awin_advertiser_quality"."with_brand" >= 0
          and "awin_advertiser_quality"."with_image" >= 0 and "awin_advertiser_quality"."with_price" >= 0
          and "awin_advertiser_quality"."duplicate_external_ids" >= 0 and "awin_advertiser_quality"."duplicate_gtins" >= 0
          and "awin_advertiser_quality"."rejected_currency" >= 0 and "awin_advertiser_quality"."rejected_price" >= 0
          and "awin_advertiser_quality"."contradictory_availability" >= 0
          and "awin_advertiser_quality"."tracking_approved" >= 0 and "awin_advertiser_quality"."tracking_rejected" >= 0
          and "awin_advertiser_quality"."destination_tracking_host" >= 0 and "awin_advertiser_quality"."destination_tracked_only" >= 0);--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_coverage_check" CHECK ("awin_advertiser_quality"."with_gtin" <= "awin_advertiser_quality"."mapped" and "awin_advertiser_quality"."with_mpn" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."with_brand" <= "awin_advertiser_quality"."mapped" and "awin_advertiser_quality"."with_image" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."with_price" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."tracking_approved" + "awin_advertiser_quality"."tracking_rejected" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."destination_tracking_host" + "awin_advertiser_quality"."destination_tracked_only" <= "awin_advertiser_quality"."mapped");--> statement-breakpoint
ALTER TABLE "awin_link_samples" ADD CONSTRAINT "awin_link_samples_findings_check" CHECK ("awin_link_samples"."findings" <@ array['tracking_missing', 'tracking_host_not_approved', 'destination_insecure_scheme', 'destination_unresolvable', 'destination_host_mismatch', 'destination_is_tracking_host', 'destination_missing']::text[]);