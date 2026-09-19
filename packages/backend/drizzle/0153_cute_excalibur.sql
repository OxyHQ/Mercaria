-- oxy:deploy-phase=post
-- oxy:rollback=restore: `created_by_oxy_user_id` and `approved_by_oxy_user_id` are DROPPED; their previous form is in 0016, and re-adding the NOT NULL half needs a value for every row
--
-- The DROP half of 0152's two-phase change. `post` because a drop is: the
-- serving image at the moment this runs must already be the one that reads
-- `drafted_by_*` / `approved_by_*`.
--
-- `fee_schedules_activation_audit_check` is dropped and re-added because it
-- NAMED one of the dropped columns. That is worth stating: the first generated
-- version of this file rendered it as `or ( is not null and ...)` — an EMPTY
-- column reference, invalid SQL — because the schema still pointed the CHECK at
-- a property that no longer existed. Reading the generated file caught it; the
-- generator did not.
--
ALTER TABLE "fee_schedules" DROP CONSTRAINT "fee_schedules_activation_audit_check";--> statement-breakpoint
ALTER TABLE "fee_schedules" DROP COLUMN "created_by_oxy_user_id";--> statement-breakpoint
ALTER TABLE "fee_schedules" DROP COLUMN "approved_by_oxy_user_id";--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_activation_audit_check" CHECK ("fee_schedules"."status" not in ('active', 'superseded')
          or ("fee_schedules"."approved_by_authority" is not null and "fee_schedules"."activated_at" is not null));--> statement-breakpoint
-- HAND-WRITTEN, below the generated block. `db:generate` DROPS this on a
-- regeneration; re-apply it at the END of the file and confirm with:
--
--   grep -c '^CREATE OR REPLACE FUNCTION'  drizzle/0153_*.sql   # 1
--   grep -c '^-- oxy:deploy-phase'         drizzle/0153_*.sql   # 1
--
-- The immutability trigger is PL/pgSQL and names its columns by hand, so
-- dropping `created_by_oxy_user_id` above orphans it: `record "new" has no field
-- "created_by_oxy_user_id"`, raised on EVERY update of the table — including the
-- activation that is the whole point of the row. drizzle-kit cannot see a
-- hand-written function, so nothing warned; the realdb suite is what caught it.
--
-- `CREATE OR REPLACE FUNCTION` under the UNCHANGED trigger name is the whole
-- repair: `fee_schedules_immutable_once_active` points at the function by name
-- and keeps pointing at the new body. Dropping and re-creating the trigger would
-- open a window in which the table is unprotected.
--
-- The drafting pair replaces `created_by_oxy_user_id` in the immutable list,
-- because who authored a published rate is exactly as immutable as the rate. The
-- APPROVAL pair is deliberately absent from that list: it is written BY the
-- activation, which is an update of a row whose `OLD.status` is still `draft`,
-- so the guard does not apply — and adding it would refuse every activation.
-- oxy:handwritten-begin=fee_schedule_immutable_drafted_by
CREATE OR REPLACE FUNCTION mercaria_fee_schedule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'fee schedule %.% is %, not draft: published schedule versions are never deleted. Retire it, or publish a new version.',
        OLD.schedule_key, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.schedule_key IS DISTINCT FROM OLD.schedule_key OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.merchant_summary IS DISTINCT FROM OLD.merchant_summary OR
    NEW.effective_start IS DISTINCT FROM OLD.effective_start OR
    NEW.effective_end IS DISTINCT FROM OLD.effective_end OR
    NEW.eligible_seller_type IS DISTINCT FROM OLD.eligible_seller_type OR
    NEW.eligible_currency IS DISTINCT FROM OLD.eligible_currency OR
    NEW.percentage_bps IS DISTINCT FROM OLD.percentage_bps OR
    NEW.fixed_fee_amount IS DISTINCT FROM OLD.fixed_fee_amount OR
    NEW.fixed_fee_currency IS DISTINCT FROM OLD.fixed_fee_currency OR
    NEW.min_fee_minor IS DISTINCT FROM OLD.min_fee_minor OR
    NEW.max_fee_minor IS DISTINCT FROM OLD.max_fee_minor OR
    NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR
    NEW.refund_policy IS DISTINCT FROM OLD.refund_policy OR
    NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
    NEW.drafted_by_authority IS DISTINCT FROM OLD.drafted_by_authority OR
    NEW.drafted_by_ref IS DISTINCT FROM OLD.drafted_by_ref OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'fee schedule %.% is %, not draft: its policy is immutable. Publish a new version instead of editing this one.',
      OLD.schedule_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
-- oxy:handwritten-end=fee_schedule_immutable_drafted_by
