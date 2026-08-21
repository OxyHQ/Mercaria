-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_merge_jobs_phase_check and catalog_merge_job_phases_phase_check are widened for the alerts phase; the previous forms are in 0079 and re-adding them fails against any job that recorded it
-- #717: `navigation` joins CATALOG_MERGE_PHASES, so both CHECKs rendered from
-- that tuple are widened to a SUPERSET. `pre` because it is additive from the
-- serving image's point of view: every value the running code writes is still
-- admitted, and the phase has to be writable BEFORE the image that reaches it
-- deploys. A `post` marker here would let the first merge to reach the phase
-- fail its CHECK in production with a green build.
ALTER TABLE "catalog_merge_job_phases" DROP CONSTRAINT "catalog_merge_job_phases_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" ADD CONSTRAINT "catalog_merge_job_phases_phase_check" CHECK ("catalog_merge_job_phases"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'agents', 'navigation', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_phase_check" CHECK ("catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'agents', 'navigation', 'redirects', 'rollups', 'verify', 'done'));
