/**
 * The periodic catalog integrity checks (#367 Workstream 17).
 *
 * Six questions a CHECK constraint cannot answer, because every one of them
 * spans rows or spans tables: an orphaned pointer, a redirect that no longer
 * resolves, a cycle through `parent_id`, a materialized ancestry that disagrees
 * with the tree it claims to describe, a published row pinning a schema version
 * nothing can retrieve, and a queue row claimed past its lease.
 *
 * ## NOTHING HERE REPAIRS, and that is the design
 *
 * This module issues no `INSERT`, no `UPDATE` and no `DELETE`, and there is no
 * `fix` parameter for one to hide behind — the `payment_discrepancies` posture,
 * for a sharper reason than tidiness. **Every one of these findings can be
 * something an operator did on purpose, mid-migration**: a category suppressed
 * while its subtree is rebuilt, a redirect staged ahead of a cutover, a product
 * type pulled back to `review` because its fields were wrong, a lease held by a
 * task somebody is about to restart. A sweep that "corrected" any of them would
 * undo a decision, silently, at whatever hour it happened to run. Detection and
 * repair are separate acts, and the repair belongs to the domain that owns the
 * write chokepoint.
 *
 * ## `population` is the vacuity floor and it is mandatory
 *
 * A check that scanned nothing and a check that scanned a clean catalogue both
 * report `findings: 0`. `population` — the number of rows the check ACTUALLY
 * examined, from a real count over the same bounded subject set the finding
 * query ran over, never a constant and never the finding count — is the only
 * thing that tells them apart. `population === 0` with a result present is
 * itself worth seeing: it says the table is empty, not that it is healthy.
 *
 * It is also how a reader sees a TRUNCATED scan. Every scan is bounded by
 * {@link INTEGRITY_SCAN_LIMIT} — an unbounded sweep over the whole catalogue is
 * one somebody switches off — so a `population` equal to the limit means the
 * check saw the first page and no more. Nothing hides that: the number is the
 * disclosure.
 *
 * ## What a `sample` may carry
 *
 * Bounded to {@link INTEGRITY_SAMPLE_LIMIT} entries, each a `<table>:<id>`
 * handle an operator can open. No name, no slug, no locale string, no free
 * text, and nothing about a person — these tables carry no buyer, but an
 * operator id and a merchant handle both live one join away and neither belongs
 * in a health report.
 *
 * ## Ordering is newest first
 *
 * Ids in this schema are uuid v7, so `order by id desc` is "most recently
 * created first" — which is the order an operator wants when something has just
 * started going wrong, and it is why a scan truncated at the limit shows the
 * newest breakage rather than the oldest.
 */

import { sql, type SQL } from 'drizzle-orm';
import { inList } from '@oxyhq/db';
import type {
  CatalogIntegrityCheckKind,
  CatalogIntegrityReport,
  CatalogIntegrityResult,
} from '@mercaria/shared-types';
import {
  CATALOG_GOVERNANCE_OPEN_CHANGE_STATES,
  CATALOG_INTEGRITY_CHECK_KINDS,
  PRODUCT_TYPE_EDITABLE_LIFECYCLES,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  resolveCategoryRedirect,
  type CategoryRedirectSubject,
} from '../../db/taxonomy/taxonomyRepository.js';
import { scanOrphanedReferences } from '../catalog-governance/queue.service.js';

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The most rows any single scan here examines.
 *
 * A sweep that table-scans the whole catalogue unbounded is one somebody
 * switches off after the first incident it makes worse, so every subject set is
 * a bounded, ordered page. The cost is stated rather than hidden: a catalogue
 * larger than this is checked one page deep, and `population` is what says so.
 */
export const INTEGRITY_SCAN_LIMIT = 5000;

/** How many offending handles a result carries. */
export const INTEGRITY_SAMPLE_LIMIT = 20;

/**
 * How many redirect chain members are resolved through the OWNING reader.
 *
 * Smaller than the scan limit because each one costs up to `MAX_REDIRECT_HOPS`
 * round trips (see {@link checkInvalidRedirects}), and a chain is rare: it
 * exists only where somebody corrected a redirect, which is the documented
 * correction pattern rather than ordinary traffic.
 */
export const REDIRECT_RESOLUTION_LIMIT = 100;

/**
 * How far a parent walk goes before it stops.
 *
 * The same 64 `mercaria_category_hierarchy_guard` refuses to write past. It is
 * restated rather than imported because that one is a `plpgsql` constant inside
 * a migration and there is nothing to import; the two are independent bounds
 * and disagreeing costs no verdict — a genuine cycle is met at its own length,
 * which is far below either number, and a chain deeper than this is a finding
 * of {@link checkAncestryPathDrift} whichever bound stopped the walk.
 */
export const CATEGORY_WALK_DEPTH_CAP = 64;

/* -------------------------------------------------------------------------- */
/* Shared machinery                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Count the rows in a bounded subject set.
 *
 * The SAME fragment the finding query runs over is counted here, which is what
 * makes `population` a fact about this check rather than a number from
 * somewhere near it. A `count(*)` over the unbounded table would report a
 * population the scan never looked at, and it would do so in the flattering
 * direction — a big denominator under a zero numerator reads as a clean sweep.
 */
async function countExamined(db: DatabaseOrTransaction, examined: SQL): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select count(*)::int as total from (${examined}) as examined_subjects`,
  );
  const [row] = rows;
  return Number(row?.total ?? 0);
}

/** Assemble a result, bounding the sample at the one place it is bounded. */
function result(
  kind: CatalogIntegrityCheckKind,
  population: number,
  handles: readonly string[],
): CatalogIntegrityResult {
  return {
    kind,
    population,
    findings: handles.length,
    sample: handles.slice(0, INTEGRITY_SAMPLE_LIMIT),
    checkedAt: new Date().toISOString(),
  };
}

/** A `<table>:<id>` handle. The whole of what a sample may carry. */
function handle(table: string, id: string): string {
  return `${table}:${id}`;
}

/* -------------------------------------------------------------------------- */
/* 1. Orphaned references                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rows pointing at a category, product-type definition or attribute definition
 * that is gone or out of service.
 *
 * ## It CONSUMES `scanOrphanedReferences` and duplicates none of it
 *
 * `services/catalog-governance/queue.service.ts` already answers the three
 * cases where the pointer is a real FOREIGN KEY and the target is merely out of
 * SERVICE — a navigation node on an unpublished category, a published product
 * type every one of whose category scopes is out of service, a live external
 * mapping onto a deprecated product-type version. None of those is a broken
 * key, which is exactly why nothing else reports them, and re-deriving them
 * here would be a second spelling that goes stale the day the owning domain
 * adds a lifecycle value. That scan's `population` and findings are folded into
 * this result whole.
 *
 * ## What is added on top: the pointers that carry NO foreign key
 *
 * `db/schema/CONVENTIONS.md` ledgers the id columns that deliberately carry
 * none, and two of them can genuinely dangle:
 *
 * - **`catalog_governance_change_requests.(subject_kind, subject_id)`** — a
 *   change request still `planned` or `approved` whose subject no longer
 *   exists. It is polymorphic over nine kinds, so no key is possible, and an
 *   undecided request naming a subject that is gone can never be applied. Only
 *   the OPEN states are examined: the tuple is read from
 *   `CATALOG_GOVERNANCE_OPEN_CHANGE_STATES` rather than retyped, and a terminal
 *   request is history, which is a different thing.
 * - **`catalog_proposals.(type, resolved_entity_id)`** — the entity a proposal
 *   became. A resolved id that has since been MERGED is not an orphan (the
 *   tombstone row survives and carries `merged_into_id`), so this finds only a
 *   target with no row at all.
 *
 * **`catalog_governance_audit_events` is deliberately NOT scanned**, though its
 * `(subject_kind, subject_id)` pair has the same shape and no key either. Its
 * own column comment states the reason as the design: *the audit outlives what
 * it describes*. An audit event naming a category somebody removed is the
 * record working, and reporting it would be a false positive that grows without
 * bound — which is the shape of a check somebody eventually mutes.
 */
export async function checkOrphanedReferences(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  const governance = await scanOrphanedReferences(db, limit);
  const handles = governance.findings.map((finding) => handle(finding.kind, finding.referenceId));

  const changeRequests = sql`
    select r.id, r.subject_kind, r.subject_id
      from catalog_governance_change_requests r
     where r.state in (${sql.raw(inList(CATALOG_GOVERNANCE_OPEN_CHANGE_STATES))})
     order by r.id desc
     limit ${limit}
  `;
  const danglingRequests = await db.execute<{ id: string }>(sql`
    with examined as (${changeRequests})
    select e.id
      from examined e
     where (e.subject_kind = 'category'
              and not exists (select 1 from categories c where c.id = e.subject_id))
        or (e.subject_kind = 'product_type_definition'
              and not exists (select 1 from product_type_definitions d where d.id = e.subject_id))
        or (e.subject_kind = 'attribute_definition'
              and not exists (select 1 from attribute_definitions a where a.id = e.subject_id))
     order by e.id desc
     limit ${limit}
  `);
  for (const row of danglingRequests) {
    handles.push(handle('catalog_governance_change_requests', row.id));
  }

  // `type` is aliased out of the CTE. It is a non-reserved keyword in Postgres
  // and would parse, but a bare `e.type` in a later clause is one grammar change
  // from meaning something else, and this one is free.
  const proposals = sql`
    select p.id, p.type as proposal_type, p.resolved_entity_id
      from catalog_proposals p
     where p.resolved_entity_id is not null
       and p.type in ('category', 'product_type', 'attribute')
     order by p.id desc
     limit ${limit}
  `;
  const danglingProposals = await db.execute<{ id: string }>(sql`
    with examined as (${proposals})
    select e.id
      from examined e
     where (e.proposal_type = 'category'
              and not exists (select 1 from categories c where c.id = e.resolved_entity_id))
        or (e.proposal_type = 'product_type'
              and not exists (select 1 from product_type_definitions d where d.id = e.resolved_entity_id))
        or (e.proposal_type = 'attribute'
              and not exists (select 1 from attribute_definitions a where a.id = e.resolved_entity_id))
     order by e.id desc
     limit ${limit}
  `);
  for (const row of danglingProposals) {
    handles.push(handle('catalog_proposals', row.id));
  }

  const population =
    governance.population +
    (await countExamined(db, changeRequests)) +
    (await countExamined(db, proposals));

  return result('orphaned_reference', population, handles);
}

/* -------------------------------------------------------------------------- */
/* 2. Invalid redirects                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One currently-effective redirect, as the SQL pre-filter reads it.
 *
 * A `type` rather than an `interface`: `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, which an interface does not satisfy (interfaces
 * have no implicit index signature) while a type alias does.
 */
type RedirectCandidateRow = {
  readonly id: string;
  readonly subject_kind: string;
  readonly subject_category_id: string | null;
  readonly subject_locale: string | null;
  readonly subject_slug: string | null;
  readonly target_missing: boolean;
  readonly self_target: boolean;
};

/** The redirect subject a row describes, or `null` when the row is unreadable. */
function redirectSubject(row: RedirectCandidateRow): CategoryRedirectSubject | null {
  if (row.subject_kind === 'category_id' && row.subject_category_id !== null) {
    return { kind: 'category_id', categoryId: row.subject_category_id };
  }
  if (row.subject_kind === 'localized_slug' && row.subject_locale !== null && row.subject_slug !== null) {
    return { kind: 'localized_slug', locale: row.subject_locale, slug: row.subject_slug };
  }
  return null;
}

/**
 * `category_redirects` rows that no longer resolve to a category.
 *
 * ## Only currently-effective rows, and there is no `effective_to`
 *
 * `category_redirects` carries `effective_from` and no closing column: a
 * redirect is append-only and nothing ever ends one, because a URL that
 * resolved last year should resolve today. So "currently effective" is
 * `effective_from <= now()` and nothing else, and a row staged ahead of a
 * cutover is correctly invisible to this check until its date arrives.
 *
 * ## The SQL narrows; the OWNING reader decides
 *
 * Three conditions are read in SQL — a target with no category row, a redirect
 * whose subject IS its target, and a row whose target is itself the subject of
 * another effective redirect (a CHAIN). The first two are refused today by
 * `category_redirects_target_category_id_fkey` and
 * `category_redirects_not_self_check`, so they can only arrive from a bad
 * restore or a stood-down constraint; they are read anyway because they cost
 * one predicate each and the check exists precisely for rows that got in
 * another way.
 *
 * A chain is NOT a fault on its own, and this is the part worth reading. The
 * documented correction for a redirect pointing at the wrong category is to add
 * a redirect FROM that wrong target onward — so chains are DELIBERATE, the
 * resolver follows them, and flagging every chain would report the correction
 * pattern as breakage. What is a fault is a chain the resolver can no longer
 * walk: `resolveCategoryRedirect` answers `chain_exhausted` past
 * `MAX_REDIRECT_HOPS`, which is a module-private constant of the taxonomy
 * repository. Rather than restate that number here — two spellings of one bound
 * disagree the first time somebody moves it, and this one would disagree in the
 * direction that reports nothing — each chain member is resolved through the
 * repository's own function, and the finding is its VERDICT. A loop needs no
 * separate walk: every member of a loop has a redirecting target, so every
 * member is a chain candidate, and its resolution is `chain_exhausted`.
 *
 * ## The chain-candidacy sub-read is deliberately NOT date-filtered
 *
 * Measured while writing this: `findRedirectForSubject`, which is what the
 * resolver walks with, reads no `effective_from` at all — so the resolver
 * follows a future-dated redirect today. The EXAMINED set is still dated,
 * because that is what "currently effective" means on the row and it is the
 * population an operator is asking about; the next-hop sub-read is not, because
 * narrowing it below what the resolver walks would produce FALSE NEGATIVES —
 * a chain the resolver cannot finish would be filtered out of candidacy before
 * the authority ever saw it. A check disagreeing with the reader it is checking
 * has to disagree in the direction that over-reports.
 */
export async function checkInvalidRedirects(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  const examined = sql`
    select r.id,
           r.subject_kind,
           r.subject_category_id,
           r.subject_locale,
           r.subject_slug,
           r.target_category_id
      from category_redirects r
     where r.effective_from <= now()
     order by r.id desc
     limit ${limit}
  `;

  const candidates = await db.execute<RedirectCandidateRow>(sql`
    with examined as (${examined})
    select e.id,
           e.subject_kind,
           e.subject_category_id,
           e.subject_locale,
           e.subject_slug,
           not exists (select 1 from categories c where c.id = e.target_category_id) as target_missing,
           (e.subject_category_id is not distinct from e.target_category_id) as self_target
      from examined e
     where not exists (select 1 from categories c where c.id = e.target_category_id)
        or e.subject_category_id is not distinct from e.target_category_id
        or exists (
             select 1
               from category_redirects n
              where n.subject_kind = 'category_id'
                and n.subject_category_id = e.target_category_id
           )
     order by e.id desc
     limit ${limit}
  `);

  const handles: string[] = [];
  let resolved = 0;
  for (const row of candidates) {
    if (row.target_missing || row.self_target) {
      handles.push(handle('category_redirects', row.id));
      continue;
    }
    // A chain, which is legitimate until the resolver can no longer walk it.
    //
    // `continue` and not `break`: past the resolution cap the cheap SQL facts
    // above are still read for every remaining candidate. Breaking would stop
    // reporting a MISSING TARGET because too many chains happened to sort ahead
    // of it, which is a bound quietly deciding which faults get reported.
    if (resolved >= REDIRECT_RESOLUTION_LIMIT) continue;
    const subject = redirectSubject(row);
    if (subject === null) {
      // A row whose discriminant and columns disagree. Three biconditional
      // CHECKs make it unrepresentable, so reaching here IS the finding.
      handles.push(handle('category_redirects', row.id));
      continue;
    }
    resolved += 1;
    const resolution = await resolveCategoryRedirect(subject, db);
    if (resolution.outcome === 'chain_exhausted' || resolution.outcome === 'unresolved') {
      handles.push(handle('category_redirects', row.id));
    }
  }

  return result('invalid_redirect', await countExamined(db, examined), handles);
}

/* -------------------------------------------------------------------------- */
/* 3. Category cycles                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A category reachable from itself through `parent_id`.
 *
 * ## Why this exists when a trigger already refuses one
 *
 * `mercaria_category_hierarchy_guard` refuses a cycle at write time, on INSERT
 * and on any UPDATE that moves `parent_id` (ADR 0007 D2), and
 * `categories_parent_not_self_check` covers the one-row case. So a cycle cannot
 * arrive through this application at all — which is the whole reason to look
 * for one. What a trigger cannot stop is a restore from a dump taken while the
 * guard did not exist, a bulk load run with `session_replication_role =
 * replica`, a `psql` session that stood the trigger down, or a logical
 * replication stream (replica role suppresses user triggers by definition). A
 * cycle from any of those is invisible until something walks the tree and does
 * not come back, and by then the caller is a shopper.
 *
 * The walk is bounded at {@link CATEGORY_WALK_DEPTH_CAP} in the recursive term,
 * so a real cycle cannot hang the sweep — a `WITH RECURSIVE` over a cyclic
 * graph with no bound runs until the connection dies, which is the failure mode
 * this check would otherwise INTRODUCE.
 */
export async function checkCategoryCycles(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  // Only a category WITH a parent can be in a cycle, so that is the population:
  // counting parentless roots would inflate the denominator with rows the
  // predicate cannot apply to.
  const examined = sql`
    select c.id, c.parent_id
      from categories c
     where c.parent_id is not null
     order by c.id desc
     limit ${limit}
  `;

  const cycles = await db.execute<{ id: string }>(sql`
    with recursive examined as (${examined}),
    walk (subject_id, node_id, depth) as (
      select e.id, e.parent_id, 1
        from examined e
      union all
      select w.subject_id, c.parent_id, w.depth + 1
        from walk w
        join categories c on c.id = w.node_id
       where c.parent_id is not null
         and w.node_id <> w.subject_id
         and w.depth < ${CATEGORY_WALK_DEPTH_CAP}
    )
    select distinct w.subject_id as id
      from walk w
     where w.node_id = w.subject_id
     order by w.subject_id desc
     limit ${limit}
  `);

  const handles = [...cycles].map((row) => handle('categories', row.id));
  return result('category_cycle', await countExamined(db, examined), handles);
}

/* -------------------------------------------------------------------------- */
/* 4. Ancestry path drift                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `categories.ancestor_ids` disagreeing with the path `parent_id` describes.
 *
 * ## This is the one that fails SILENTLY, which is why it is here
 *
 * ADR 0007 D2 makes `ancestor_ids` a MATERIALIZED PATH — root-first, excluding
 * the row itself — maintained by the move statement and read by
 * `categories_ancestor_ids_idx` for every descendants query in the taxonomy. No
 * constraint can hold it: a CHECK may not read another row, and a trigger that
 * recomputed it would be a second writer for the fact the move statement owns.
 *
 * So drift produces no error anywhere. Every descendants read simply returns
 * the wrong set: a subtree that quietly stops appearing under the parent it was
 * moved to, a category that keeps appearing under the parent it left, a facet
 * scope that covers products nobody filed there. Each of those looks like a
 * catalogue somebody mis-filed rather than like a bug, and the whole class is
 * invisible until it is measured against the `parent_id` edges themselves.
 *
 * The true path is recomputed here from `parent_id` alone, bounded at
 * {@link CATEGORY_WALK_DEPTH_CAP} in the recursive term so a cycle cannot hang
 * it. A category IN a cycle also reports here, and deliberately: its stored
 * ancestry cannot be right, and {@link checkCategoryCycles} names the cause
 * beside it.
 */
export async function checkAncestryPathDrift(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  const examined = sql`
    select c.id, c.parent_id, c.ancestor_ids
      from categories c
     order by c.id desc
     limit ${limit}
  `;

  const drifted = await db.execute<{ id: string }>(sql`
    with recursive examined as (${examined}),
    walk (subject_id, node_id, depth, path) as (
      select e.id, e.parent_id, 1, array[e.parent_id]
        from examined e
       where e.parent_id is not null
      union all
      select w.subject_id, c.parent_id, w.depth + 1, array[c.parent_id] || w.path
        from walk w
        join categories c on c.id = w.node_id
       where c.parent_id is not null
         and w.depth < ${CATEGORY_WALK_DEPTH_CAP}
    ),
    truth as (
      select distinct on (w.subject_id) w.subject_id, w.path
        from walk w
       order by w.subject_id, w.depth desc
    )
    select e.id
      from examined e
      left join truth t on t.subject_id = e.id
     where e.ancestor_ids is distinct from coalesce(t.path, '{}'::text[])
     order by e.id desc
     limit ${limit}
  `);

  const handles = [...drifted].map((row) => handle('categories', row.id));
  return result('ancestry_path_drift', await countExamined(db, examined), handles);
}

/* -------------------------------------------------------------------------- */
/* 5. Unretrievable pinned schema versions                                     */
/* -------------------------------------------------------------------------- */

/**
 * A published row pinning a `product_type_definitions` version that can no
 * longer be retrieved.
 *
 * ## What "retrievable" means, derived rather than retyped
 *
 * `composeAuthoringSchema` refuses a definition whose lifecycle is neither
 * `published` nor `deprecated` — a version that is still `draft` or `review` is
 * NOT frozen, so its fields, its requirements and its value policies can still
 * move, and the schema a row's answers were recorded under is no longer
 * obtainable. Those two sets are complements over
 * `PRODUCT_TYPE_LIFECYCLES`, and this check reads the exported
 * `PRODUCT_TYPE_EDITABLE_LIFECYCLES` rather than restating the composition's
 * condition: one tuple, so the day a fifth lifecycle lands the answer moves in
 * both places at once instead of in one.
 *
 * ## The two kinds of row that pin one
 *
 * - **`catalog_authoring_drafts` with `status = 'published'`** — the audit
 *   record of what a merchant published, which ADR 0007 D5 says pins the EXACT
 *   version. If that version is unretrievable the published listing's schema
 *   cannot be re-derived at all.
 * - **`native_listing_variant_axes` on an ACTIVE listing** — the product-type
 *   version a live listing's typed axes were declared under (ADR 0007 D6).
 *
 * The foreign key is `restrict` on both, so the row cannot VANISH; what it can
 * do is go back to being editable, which no key expresses.
 */
export async function checkSchemaVersionAvailability(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  const editable = sql.raw(inList(PRODUCT_TYPE_EDITABLE_LIFECYCLES));

  const drafts = sql`
    select d.id, d.product_type_definition_id
      from catalog_authoring_drafts d
     where d.status = 'published'
     order by d.id desc
     limit ${limit}
  `;
  const unavailableDrafts = await db.execute<{ id: string }>(sql`
    with examined as (${drafts})
    select e.id
      from examined e
      join product_type_definitions p on p.id = e.product_type_definition_id
     where p.lifecycle in (${editable})
     order by e.id desc
     limit ${limit}
  `);

  const axes = sql`
    select a.id, a.product_type_definition_id
      from native_listing_variant_axes a
      join listings l on l.id = a.listing_id
     where a.product_type_definition_id is not null
       and l.status = 'active'
     order by a.id desc
     limit ${limit}
  `;
  const unavailableAxes = await db.execute<{ id: string }>(sql`
    with examined as (${axes})
    select e.id
      from examined e
      join product_type_definitions p on p.id = e.product_type_definition_id
     where p.lifecycle in (${editable})
     order by e.id desc
     limit ${limit}
  `);

  const handles = [
    ...[...unavailableDrafts].map((row) => handle('catalog_authoring_drafts', row.id)),
    ...[...unavailableAxes].map((row) => handle('native_listing_variant_axes', row.id)),
  ];

  const population = (await countExamined(db, drafts)) + (await countExamined(db, axes));
  return result('schema_version_unavailable', population, handles);
}

/* -------------------------------------------------------------------------- */
/* 6. Stalled queue leases                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A queue row still holding a claim whose lease has expired.
 *
 * ## The population is the CLAIMED rows, not the tables
 *
 * A stalled lease is a property of a row that holds one, so the denominator is
 * "rows currently holding a claim" and the numerator is "of those, the ones
 * past their deadline". Two reasons, and the second is the one that matters:
 * a claimed row is a tiny, indexed subset (`catalog_backfill_runs_reclaim_idx`
 * exists for exactly this), so the scan stays bounded without truncation —
 * whereas paging the whole table would examine the NEWEST rows and a stalled
 * lease is by definition old, so the bound would systematically hide the thing
 * being looked for.
 *
 * The three lease-bearing tables and their spellings, none of which is
 * interchangeable with another:
 *
 * - `catalog_backfill_runs` — `lease_owner` / `lease_until`, and only while
 *   `status = 'running'`; a `paused` run legitimately holds nothing.
 * - `catalog_external_mapping_runs` — `claimed_at` / `claimed_by` /
 *   `claim_expires_at`, and only while `finished_at is null`; a run that
 *   completed keeps its claim columns as history.
 * - `catalog_external_token_observations` — `reprocess_claimed_at` /
 *   `reprocess_claim_expires_at`, and only while `reprocessed_at is null`,
 *   which is the same distinction one table over.
 *
 * Each of the three has a `num_nonnulls(...) in (0, N)` CHECK making half a
 * claim unrepresentable, so reading the expiry column alone is sufficient and a
 * row cannot be claimed without a deadline.
 *
 * A finding is NOT a fault by itself: a task restarting mid-page leaves exactly
 * this, and the reclaim path takes the lease back on the next tick. What it
 * measures is work that has stopped moving, which is why nothing here clears a
 * lease — clearing one under a task that is merely slow is how two workers end
 * up on one page.
 */
export async function checkStalledQueueLeases(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityResult> {
  const backfillClaims = sql`
    select r.id, r.lease_until
      from catalog_backfill_runs r
     where r.status = 'running'
       and r.lease_until is not null
     order by r.id desc
     limit ${limit}
  `;
  const mappingClaims = sql`
    select r.id, r.claim_expires_at
      from catalog_external_mapping_runs r
     where r.claim_expires_at is not null
       and r.finished_at is null
     order by r.id desc
     limit ${limit}
  `;
  const observationClaims = sql`
    select o.id, o.reprocess_claim_expires_at
      from catalog_external_token_observations o
     where o.reprocess_claim_expires_at is not null
       and o.reprocessed_at is null
     order by o.id desc
     limit ${limit}
  `;

  const stalledBackfills = await db.execute<{ id: string }>(sql`
    with examined as (${backfillClaims})
    select e.id from examined e where e.lease_until < now() order by e.id desc limit ${limit}
  `);
  const stalledMappings = await db.execute<{ id: string }>(sql`
    with examined as (${mappingClaims})
    select e.id from examined e where e.claim_expires_at < now() order by e.id desc limit ${limit}
  `);
  const stalledObservations = await db.execute<{ id: string }>(sql`
    with examined as (${observationClaims})
    select e.id
      from examined e
     where e.reprocess_claim_expires_at < now()
     order by e.id desc
     limit ${limit}
  `);

  const handles = [
    ...[...stalledBackfills].map((row) => handle('catalog_backfill_runs', row.id)),
    ...[...stalledMappings].map((row) => handle('catalog_external_mapping_runs', row.id)),
    ...[...stalledObservations].map((row) =>
      handle('catalog_external_token_observations', row.id),
    ),
  ];

  const population =
    (await countExamined(db, backfillClaims)) +
    (await countExamined(db, mappingClaims)) +
    (await countExamined(db, observationClaims));

  return result('stalled_queue_lease', population, handles);
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/** Every check, in the order {@link CATALOG_INTEGRITY_CHECK_KINDS} names them. */
const CHECKS: Readonly<
  Record<
    CatalogIntegrityCheckKind,
    (db: DatabaseOrTransaction, limit: number) => Promise<CatalogIntegrityResult>
  >
> = {
  orphaned_reference: checkOrphanedReferences,
  invalid_redirect: checkInvalidRedirects,
  category_cycle: checkCategoryCycles,
  schema_version_unavailable: checkSchemaVersionAvailability,
  ancestry_path_drift: checkAncestryPathDrift,
  stalled_queue_lease: checkStalledQueueLeases,
};

/**
 * Run every integrity check.
 *
 * ## Sequentially, and that is not an oversight
 *
 * `db` may be a TRANSACTION handle — the realdb suite passes one, so a
 * deliberately broken row can be created, detected and rolled back without ever
 * committing into a database parallel test files share. postgres.js pipelines
 * onto a single connection, so concurrent statements on one transaction handle
 * interleave; running the six in parallel would be correct against the pool and
 * wrong against a transaction, which is the worst of the two.
 *
 * ## `complete` is FALSE when a check did not run
 *
 * `CatalogIntegrityResult` has no failed state and must not grow one: a result
 * present in `results` is a scan that happened. A check that threw is therefore
 * OMITTED and logged, and `complete` says so — a partial sweep reporting zero
 * findings across five checks is not a clean catalogue, and `complete` is the
 * only thing standing between those two readings.
 */
export async function runCatalogIntegrityChecks(
  db: DatabaseOrTransaction = getDb(),
  limit: number = INTEGRITY_SCAN_LIMIT,
): Promise<CatalogIntegrityReport> {
  const results: CatalogIntegrityResult[] = [];

  for (const kind of CATALOG_INTEGRITY_CHECK_KINDS) {
    try {
      results.push(await CHECKS[kind](db, limit));
    } catch (error) {
      log.general.error({ kind, err: error }, 'catalog integrity check failed');
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    results,
    complete: results.length === CATALOG_INTEGRITY_CHECK_KINDS.length,
  };
}
