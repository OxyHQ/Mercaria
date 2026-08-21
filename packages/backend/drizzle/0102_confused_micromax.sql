-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Catalog administration and governance (#367 Workstream 12).
--
-- Additive in whole: five new tables, two new foreign keys among them,
-- eleven indexes and five hand-written trigger pairs. No statement here
-- breaks a write the serving image performs, and nothing outside
-- `catalog_governance_*` is touched -- read back off the generated half
-- before the hand-written half was appended, with the shared-types dist
-- rebuilt from scratch first so no closed-value-set CHECK could be
-- re-rendered from a stale tuple.
--
-- The hand-written half below is preserved VERBATIM from
-- `src/db/schema/catalogGovernance.pending.sql`, sliced on its
-- column-0-anchored markers. A regeneration DROPS every one of these, so
-- the markers are what a later `db:generate` needs in order to put them
-- back.

CREATE TABLE "catalog_governance_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"change_request_id" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_governance_audit_events_domain_check" CHECK ("catalog_governance_audit_events"."domain" in ('taxonomy', 'product_type', 'attribute', 'controlled_value', 'localization', 'external_mapping', 'navigation', 'compatibility', 'proposal', 'governance')),
	CONSTRAINT "catalog_governance_audit_events_action_check" CHECK ("catalog_governance_audit_events"."action" in ('taxonomy_rename', 'taxonomy_move', 'taxonomy_merge', 'taxonomy_redirect', 'taxonomy_publish', 'taxonomy_deprecate', 'taxonomy_suppress', 'taxonomy_restore', 'product_type_publish', 'product_type_deprecate', 'attribute_publish', 'attribute_deprecate', 'attribute_retire', 'navigation_publish', 'navigation_archive', 'definition_snapshot_restore', 'vertical_package_apply', 'localization_review', 'external_mapping_approve', 'external_mapping_reject', 'external_mapping_fan_out_approve', 'compatibility_claim_review', 'proposal_approve', 'proposal_merge', 'proposal_reject', 'proposal_request_information', 'proposal_defer', 'proposal_redirect', 'change_requested', 'change_approved', 'change_applied', 'change_rejected', 'change_withdrawn', 'change_failed', 'role_granted', 'role_revoked', 'snapshot_exported')),
	CONSTRAINT "catalog_governance_audit_events_subject_kind_check" CHECK ("catalog_governance_audit_events"."subject_kind" in ('category', 'product_type_definition', 'attribute_definition', 'navigation_tree', 'definition_snapshot', 'vertical_package', 'operator_role', 'external_mapping', 'compatibility_claim')),
	CONSTRAINT "catalog_governance_audit_events_actor_kind_check" CHECK ("catalog_governance_audit_events"."actor_kind" in ('operator', 'system')),
	CONSTRAINT "catalog_governance_audit_events_source_check" CHECK ("catalog_governance_audit_events"."source" in ('operator_console', 'change_request', 'definition_snapshot', 'vertical_package')),
	CONSTRAINT "catalog_governance_audit_events_actor_presence_check" CHECK (("catalog_governance_audit_events"."actor_kind" = 'system') = ("catalog_governance_audit_events"."actor_oxy_user_id" is null)),
	CONSTRAINT "catalog_governance_audit_events_reason_check" CHECK (btrim("catalog_governance_audit_events"."reason") <> '' and btrim("catalog_governance_audit_events"."subject_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "catalog_governance_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"parameters" jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requires_second_approval" boolean DEFAULT false NOT NULL,
	"approved_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"failure_detail" text,
	"impact_coverage" text NOT NULL,
	"impact_relations_declared" integer,
	"impact_relations_counted" integer,
	"impact_total" integer,
	"impact_measured_at" timestamp with time zone,
	"impact_unmeasured_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_governance_change_requests_domain_check" CHECK ("catalog_governance_change_requests"."domain" in ('taxonomy', 'product_type', 'attribute', 'controlled_value', 'localization', 'external_mapping', 'navigation', 'compatibility', 'proposal', 'governance')),
	CONSTRAINT "catalog_governance_change_requests_action_check" CHECK ("catalog_governance_change_requests"."action" in ('taxonomy_rename', 'taxonomy_move', 'taxonomy_merge', 'taxonomy_redirect', 'taxonomy_publish', 'taxonomy_deprecate', 'taxonomy_suppress', 'taxonomy_restore', 'product_type_publish', 'product_type_deprecate', 'attribute_publish', 'attribute_deprecate', 'attribute_retire', 'navigation_publish', 'navigation_archive', 'definition_snapshot_restore', 'vertical_package_apply')),
	CONSTRAINT "catalog_governance_change_requests_subject_kind_check" CHECK ("catalog_governance_change_requests"."subject_kind" in ('category', 'product_type_definition', 'attribute_definition', 'navigation_tree', 'definition_snapshot', 'vertical_package', 'operator_role', 'external_mapping', 'compatibility_claim')),
	CONSTRAINT "catalog_governance_change_requests_state_check" CHECK ("catalog_governance_change_requests"."state" in ('planned', 'approved', 'applied', 'rejected', 'withdrawn', 'failed')),
	CONSTRAINT "catalog_governance_change_requests_impact_coverage_check" CHECK ("catalog_governance_change_requests"."impact_coverage" in ('measured', 'unmeasured')),
	CONSTRAINT "catalog_governance_change_requests_reason_check" CHECK (btrim("catalog_governance_change_requests"."reason") <> '' and btrim("catalog_governance_change_requests"."requested_by_oxy_user_id") <> ''),
	CONSTRAINT "catalog_governance_change_requests_subject_check" CHECK (btrim("catalog_governance_change_requests"."subject_id") <> ''),
	CONSTRAINT "catalog_governance_change_requests_impact_measured_check" CHECK ("catalog_governance_change_requests"."impact_coverage" <> 'measured'
          or (num_nonnulls(
                "catalog_governance_change_requests"."impact_relations_declared",
                "catalog_governance_change_requests"."impact_relations_counted",
                "catalog_governance_change_requests"."impact_total",
                "catalog_governance_change_requests"."impact_measured_at"
              ) = 4
              and "catalog_governance_change_requests"."impact_unmeasured_reason" is null
              and "catalog_governance_change_requests"."impact_relations_counted" >= "catalog_governance_change_requests"."impact_relations_declared"
              and "catalog_governance_change_requests"."impact_total" >= 0)),
	CONSTRAINT "catalog_governance_change_requests_impact_unmeasured_check" CHECK ("catalog_governance_change_requests"."impact_coverage" <> 'unmeasured'
          or (num_nonnulls(
                "catalog_governance_change_requests"."impact_relations_declared",
                "catalog_governance_change_requests"."impact_relations_counted",
                "catalog_governance_change_requests"."impact_total",
                "catalog_governance_change_requests"."impact_measured_at"
              ) = 0
              and btrim(coalesce("catalog_governance_change_requests"."impact_unmeasured_reason", '')) <> '')),
	CONSTRAINT "catalog_governance_change_requests_approver_distinct_check" CHECK ("catalog_governance_change_requests"."approved_by_oxy_user_id" is null
          or "catalog_governance_change_requests"."approved_by_oxy_user_id" <> "catalog_governance_change_requests"."requested_by_oxy_user_id"),
	CONSTRAINT "catalog_governance_change_requests_approval_pair_check" CHECK (("catalog_governance_change_requests"."approved_by_oxy_user_id" is null) = ("catalog_governance_change_requests"."approved_at" is null)),
	CONSTRAINT "catalog_governance_change_requests_second_approval_check" CHECK (not "catalog_governance_change_requests"."requires_second_approval"
          or "catalog_governance_change_requests"."state" in ('planned', 'rejected', 'withdrawn')
          or "catalog_governance_change_requests"."approved_by_oxy_user_id" is not null),
	CONSTRAINT "catalog_governance_change_requests_applied_pair_check" CHECK (("catalog_governance_change_requests"."state" = 'applied') = ("catalog_governance_change_requests"."applied_at" is not null)),
	CONSTRAINT "catalog_governance_change_requests_failure_check" CHECK (("catalog_governance_change_requests"."state" = 'failed') = ("catalog_governance_change_requests"."failure_detail" is not null)),
	CONSTRAINT "catalog_governance_change_requests_unmeasured_not_applied_check" CHECK ("catalog_governance_change_requests"."impact_coverage" = 'measured' or "catalog_governance_change_requests"."state" <> 'applied')
);
--> statement-breakpoint
CREATE TABLE "catalog_governance_definition_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"content_digest" text NOT NULL,
	"document" jsonb NOT NULL,
	"entity_count" integer NOT NULL,
	"category_count" integer NOT NULL,
	"product_type_count" integer NOT NULL,
	"attribute_count" integer NOT NULL,
	"localization_count" integer NOT NULL,
	"navigation_tree_count" integer NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_governance_definition_snapshots_scope_check" CHECK ("catalog_governance_definition_snapshots"."scope" in ('taxonomy', 'product_types', 'attributes', 'localization', 'navigation', 'all')),
	CONSTRAINT "catalog_governance_definition_snapshots_digest_check" CHECK ("catalog_governance_definition_snapshots"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_governance_definition_snapshots_actor_check" CHECK (btrim("catalog_governance_definition_snapshots"."created_by_oxy_user_id") <> '' and btrim("catalog_governance_definition_snapshots"."reason") <> ''),
	CONSTRAINT "catalog_governance_definition_snapshots_counts_check" CHECK ("catalog_governance_definition_snapshots"."category_count" >= 0
          and "catalog_governance_definition_snapshots"."product_type_count" >= 0
          and "catalog_governance_definition_snapshots"."attribute_count" >= 0
          and "catalog_governance_definition_snapshots"."localization_count" >= 0
          and "catalog_governance_definition_snapshots"."navigation_tree_count" >= 0
          and "catalog_governance_definition_snapshots"."entity_count" = "catalog_governance_definition_snapshots"."category_count"
                                + "catalog_governance_definition_snapshots"."product_type_count"
                                + "catalog_governance_definition_snapshots"."attribute_count"
                                + "catalog_governance_definition_snapshots"."localization_count"
                                + "catalog_governance_definition_snapshots"."navigation_tree_count"),
	CONSTRAINT "catalog_governance_definition_snapshots_vacuity_check" CHECK ("catalog_governance_definition_snapshots"."entity_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_governance_impact_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"change_request_id" text NOT NULL,
	"reference_table" text NOT NULL,
	"reference_column" text NOT NULL,
	"disposition" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_governance_impact_counts_disposition_check" CHECK ("catalog_governance_impact_counts"."disposition" in ('blocks', 'cascades', 'rewired_by_domain', 'rewire_path_missing')),
	CONSTRAINT "catalog_governance_impact_counts_row_count_check" CHECK ("catalog_governance_impact_counts"."row_count" >= 0),
	CONSTRAINT "catalog_governance_impact_counts_reference_check" CHECK (btrim("catalog_governance_impact_counts"."reference_table") <> '' and btrim("catalog_governance_impact_counts"."reference_column") <> '')
);
--> statement-breakpoint
CREATE TABLE "catalog_governance_role_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_oxy_user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_oxy_user_id" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"revoked_by_oxy_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_governance_role_grants_role_check" CHECK ("catalog_governance_role_grants"."role" in ('view', 'propose', 'review', 'translate', 'publish')),
	CONSTRAINT "catalog_governance_role_grants_actor_check" CHECK (btrim("catalog_governance_role_grants"."subject_oxy_user_id") <> ''
          and btrim("catalog_governance_role_grants"."granted_by_oxy_user_id") <> ''
          and btrim("catalog_governance_role_grants"."reason") <> ''),
	CONSTRAINT "catalog_governance_role_grants_revocation_pair_check" CHECK (("catalog_governance_role_grants"."revoked_by_oxy_user_id" is null) = ("catalog_governance_role_grants"."revoked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "catalog_governance_audit_events" ADD CONSTRAINT "catalog_governance_audit_events_change_request_id_catalog_governance_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."catalog_governance_change_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_governance_impact_counts" ADD CONSTRAINT "catalog_governance_impact_counts_change_request_id_catalog_governance_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."catalog_governance_change_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_governance_audit_events_subject_idx" ON "catalog_governance_audit_events" USING btree ("subject_kind","subject_id","at");--> statement-breakpoint
CREATE INDEX "catalog_governance_audit_events_actor_idx" ON "catalog_governance_audit_events" USING btree ("actor_oxy_user_id","at");--> statement-breakpoint
CREATE INDEX "catalog_governance_audit_events_request_idx" ON "catalog_governance_audit_events" USING btree ("change_request_id","at");--> statement-breakpoint
CREATE INDEX "catalog_governance_change_requests_queue_idx" ON "catalog_governance_change_requests" USING btree ("state","requested_at");--> statement-breakpoint
CREATE INDEX "catalog_governance_change_requests_subject_idx" ON "catalog_governance_change_requests" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "catalog_governance_change_requests_domain_idx" ON "catalog_governance_change_requests" USING btree ("domain","state","requested_at");--> statement-breakpoint
CREATE INDEX "catalog_governance_definition_snapshots_scope_idx" ON "catalog_governance_definition_snapshots" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "catalog_governance_definition_snapshots_digest_idx" ON "catalog_governance_definition_snapshots" USING btree ("content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_governance_impact_counts_relation_key" ON "catalog_governance_impact_counts" USING btree ("change_request_id","reference_table","reference_column");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_governance_role_grants_live_key" ON "catalog_governance_role_grants" USING btree ("subject_oxy_user_id","role") WHERE "catalog_governance_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_governance_role_grants_subject_idx" ON "catalog_governance_role_grants" USING btree ("subject_oxy_user_id");

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
