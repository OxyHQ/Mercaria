-- Catalog administration and governance (#367 Workstream 12) — the hand-written
-- half of the migration.
--
-- NOT APPLIED. This file is plain text held under `db/schema/` until the
-- migration slot is handed over, because `main` is past `0100` and two branches
-- generating against the same base collide on the journal. When the slot
-- arrives:
--
--   1. `bun run build:shared-types`  ← BEFORE `db:generate`, always. A stale
--      `dist/` makes drizzle-kit render every closed-value-set CHECK from the
--      OLD tuple and emit `DROP CONSTRAINT … ADD CONSTRAINT` pairs that narrow a
--      sibling branch's widening back. Measured on #61.
--   2. `bun run db:generate`
--   3. READ the generated file for statements nobody intended — not only for
--      the ones you wanted.
--   4. Append every block below, VERBATIM, inside its
--      `-- oxy:handwritten-begin=` / `-- oxy:handwritten-end=` markers.
--      `db/__tests__/migration-handwritten-markers.test.ts` fails the build on
--      an unmarked hand-written function, and an unmarked one is silently
--      dropped by the NEXT regeneration.
--   5. The generated file's first line must read `-- oxy:deploy-phase=pre`.
--      Everything here is additive: five new tables, five new triggers, and no
--      statement that breaks a write the serving image performs.
--
-- `SCHEMA_TABLE_COUNT` in `db/__tests__/schema-conventions.test.ts` must be
-- raised by exactly FIVE in the same PR. That file is outside this branch's
-- territory; whoever integrates owns the one-token edit.

-- ---------------------------------------------------------------------------
-- 1. The plan is frozen once the request leaves `planned`.
--
-- The impact an approver read and the parameters they approved are the ones
-- that execute. Without this, "approve" would mean "approve whatever this row
-- says at apply time" — the shape of every four-eyes bypass there has ever
-- been. `state`, `approved_*`, `applied_at`, `failure_detail` and `updated_at`
-- are the only columns that may still move, because they ARE the lifecycle.
-- ---------------------------------------------------------------------------

-- oxy:handwritten-begin=mercaria_catalog_governance_change_frozen
CREATE OR REPLACE FUNCTION mercaria_catalog_governance_change_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'catalog_governance_change_requests refuses DELETE: a decision is a record, and a correction is a NEW request.'
      using errcode = 'restrict_violation';
  end if;

  if old.state <> 'planned' then
    if new.domain is distinct from old.domain
       or new.action is distinct from old.action
       or new.subject_kind is distinct from old.subject_kind
       or new.subject_id is distinct from old.subject_id
       or new.parameters is distinct from old.parameters
       or new.reason is distinct from old.reason
       or new.requested_by_oxy_user_id is distinct from old.requested_by_oxy_user_id
       or new.requested_at is distinct from old.requested_at
       or new.requires_second_approval is distinct from old.requires_second_approval
       or new.impact_coverage is distinct from old.impact_coverage
       or new.impact_relations_declared is distinct from old.impact_relations_declared
       or new.impact_relations_counted is distinct from old.impact_relations_counted
       or new.impact_total is distinct from old.impact_total
       or new.impact_measured_at is distinct from old.impact_measured_at
       or new.impact_unmeasured_reason is distinct from old.impact_unmeasured_reason
    then
      raise exception
        'catalog_governance_change_requests is frozen once it leaves planned: the plan an approver read is the plan that executes.'
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- An approval is written once. Re-approving would let a second operator
  -- replace the first's attribution on a request that has already acted.
  if old.approved_by_oxy_user_id is not null
     and new.approved_by_oxy_user_id is distinct from old.approved_by_oxy_user_id then
    raise exception
      'catalog_governance_change_requests: an approval is written once. Open a new request.'
      using errcode = 'restrict_violation';
  end if;

  -- A terminal state is terminal. Without this the CAS in the repository is the
  -- only thing between a decided request and a second decision, and a CAS is a
  -- statement somebody can forget to write.
  if old.state in ('applied', 'rejected', 'withdrawn', 'failed')
     and new.state is distinct from old.state then
    raise exception
      'catalog_governance_change_requests: % is terminal and cannot become %.', old.state, new.state
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_governance_change_frozen
BEFORE UPDATE OR DELETE ON catalog_governance_change_requests
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_governance_change_frozen();
-- oxy:handwritten-end=mercaria_catalog_governance_change_frozen

-- ---------------------------------------------------------------------------
-- 2. Impact counts are append-only.
--
-- The measurement an approver read must be the measurement that is still
-- there. A re-measured relation is not an edit — it is a NEW request, because
-- the blast radius moving is exactly the fact a second look is for.
-- ---------------------------------------------------------------------------

-- oxy:handwritten-begin=mercaria_catalog_governance_impact_append_only
CREATE OR REPLACE FUNCTION mercaria_catalog_governance_impact_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_governance_impact_counts is append-only: % is refused. A re-measurement is a new change request.', tg_op
    using errcode = 'restrict_violation';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_governance_impact_append_only
BEFORE UPDATE OR DELETE ON catalog_governance_impact_counts
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_governance_impact_append_only();
-- oxy:handwritten-end=mercaria_catalog_governance_impact_append_only

-- ---------------------------------------------------------------------------
-- 3. The audit trail is append-only against UPDATE *and* DELETE.
--
-- `rewrite_audit_history` is named in
-- `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES`; this is where it stops being a
-- word. The foreign key onto the change request is `restrict`, so the
-- declaration agrees with the trigger — a cascade beside a no-delete trigger is
-- a way to remove the trail by removing its parent.
-- ---------------------------------------------------------------------------

-- oxy:handwritten-begin=mercaria_catalog_governance_audit_append_only
CREATE OR REPLACE FUNCTION mercaria_catalog_governance_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_governance_audit_events is append-only: % is refused. A correction is a new event that names what it corrects.', tg_op
    using errcode = 'restrict_violation';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_governance_audit_append_only
BEFORE UPDATE OR DELETE ON catalog_governance_audit_events
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_governance_audit_append_only();
-- oxy:handwritten-end=mercaria_catalog_governance_audit_append_only

-- ---------------------------------------------------------------------------
-- 4. A role grant is revoked, never rewritten and never deleted.
--
-- "Who could publish last March" is a question an incident asks first, and a
-- deleted row cannot answer it. Only the revocation pair may move, and only
-- once — a re-revocation would replace the attribution on an act that already
-- happened.
-- ---------------------------------------------------------------------------

-- oxy:handwritten-begin=mercaria_catalog_governance_role_grant_frozen
CREATE OR REPLACE FUNCTION mercaria_catalog_governance_role_grant_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'catalog_governance_role_grants refuses DELETE: revoke the grant instead, so the record of who held it survives.'
      using errcode = 'restrict_violation';
  end if;

  if new.subject_oxy_user_id is distinct from old.subject_oxy_user_id
     or new.role is distinct from old.role
     or new.granted_by_oxy_user_id is distinct from old.granted_by_oxy_user_id
     or new.granted_at is distinct from old.granted_at
     or new.reason is distinct from old.reason
  then
    raise exception
      'catalog_governance_role_grants: a grant is immutable. Revoke it and grant again.'
      using errcode = 'restrict_violation';
  end if;

  if old.revoked_at is not null then
    raise exception
      'catalog_governance_role_grants: this grant was already revoked at %.', old.revoked_at
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_governance_role_grant_frozen
BEFORE UPDATE OR DELETE ON catalog_governance_role_grants
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_governance_role_grant_frozen();
-- oxy:handwritten-end=mercaria_catalog_governance_role_grant_frozen

-- ---------------------------------------------------------------------------
-- 5. A definition snapshot is immutable.
--
-- The digest is over the document. A snapshot whose document could move would
-- be a restore target that no longer matches the digest an operator compared
-- against, which is worse than having no digest at all. DELETE is permitted
-- deliberately — a snapshot is bulk working state under a retention policy, the
-- `analytics_events` posture, and a trigger refusing it would make a retention
-- sweep fail silently on every row it is meant to remove.
-- ---------------------------------------------------------------------------

-- oxy:handwritten-begin=mercaria_catalog_governance_snapshot_immutable
CREATE OR REPLACE FUNCTION mercaria_catalog_governance_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_governance_definition_snapshots is immutable: UPDATE is refused. Export a new snapshot.'
    using errcode = 'restrict_violation';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_governance_snapshot_immutable
BEFORE UPDATE ON catalog_governance_definition_snapshots
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_governance_snapshot_immutable();
-- oxy:handwritten-end=mercaria_catalog_governance_snapshot_immutable
