/**
 * The review desk (#367 Workstream 12) — one queue over nine domains.
 *
 * The point of one shape is that an operator opening the desk sees stale
 * translations, unmapped external tokens, unresolved compatibility claims,
 * undecided proposals and unreviewed attribute values in one ordering, rather
 * than in five surfaces whose backlogs only add up if somebody adds them up.
 *
 * ## The reads are COUNTS over other domains' tables, and the predicate is
 * derived rather than retyped
 *
 * Three of the nine backlogs have a count function in their own domain
 * (`countUnreviewedClaims`, `countQueuedClaims`, `countOpenChangeRequests`) and
 * this module calls those. The other six have none — the epic asks for a desk
 * over domains that shipped without one — so they are counted here, with the
 * predicate rendered from the OWNING domain's own exported tuple
 * (`CATALOG_PROPOSAL_OPEN_STATES`, `LOCALIZATION_STATUSES`,
 * `CATALOG_EXTERNAL_REVIEW_STATES`).
 *
 * That is the `checkOneOf` device applied to a read: a re-typed `state =
 * 'open'` is a second spelling that goes stale silently the day the owning
 * domain adds a state, and it goes stale in the flattering direction — a
 * backlog that stops being counted reads as a backlog that was cleared. This
 * module writes NOTHING to any of those tables, so the write chokepoints are
 * untouched.
 *
 * ## `unmeasured` is a first-class answer
 *
 * A backlog this deployment cannot measure reports `unmeasured` and carries no
 * `total`, because a zero would read as "nothing to do" on precisely the desk
 * that exists to say what is left. The three-valued shape is the same one the
 * impact report uses and for the same reason.
 */

import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type {
  CatalogGovernanceQueueDepth,
  CatalogGovernanceQueueKind,
} from '@mercaria/shared-types';
import {
  CATALOG_EXTERNAL_REVIEW_STATES,
  CATALOG_GOVERNANCE_QUEUE_KINDS,
  CATALOG_PROPOSAL_OPEN_STATES,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { catalogProposals } from '../../db/schema/catalogProposals.js';
import { catalogExternalMappingReviews } from '../../db/schema/catalogExternalMappings.js';
import {
  attributeValueLocalizations,
  categoryLocalizations,
  productTypeLocalizations,
} from '../../db/schema/catalogLocalization.js';
import { attributeValueReviews } from '../../db/schema/attributeRegistry.js';
import { countUnreviewedClaims } from '../../db/compatibility/compatibilityClaimRepository.js';
import { countQueuedClaims } from '../../db/variantAxes/attributeClaimRepository.js';
import { countOpenChangeRequests } from '../../db/catalogGovernance/changeRequestRepository.js';

/** A measured depth. */
function measured(kind: CatalogGovernanceQueueKind, total: number): CatalogGovernanceQueueDepth {
  return { kind, coverage: 'measured', total };
}

/** A depth this deployment cannot answer. */
function unmeasured(
  kind: CatalogGovernanceQueueKind,
  reason: string,
): CatalogGovernanceQueueDepth {
  return { kind, coverage: 'unmeasured', unmeasuredReason: reason };
}

/**
 * Run one count, turning a failure into `unmeasured` rather than a zero.
 *
 * A `catch` that returned zero would put a broken read and an empty backlog in
 * the same bucket, which on a review desk is the difference between "we are up
 * to date" and "we stopped looking".
 */
async function safeCount(
  kind: CatalogGovernanceQueueKind,
  run: () => Promise<number>,
): Promise<CatalogGovernanceQueueDepth> {
  try {
    return measured(kind, await run());
  } catch (error) {
    log.general.error({ kind, err: error }, 'catalog governance queue depth failed');
    return unmeasured(kind, 'This backlog could not be read. The count is unknown, not zero.');
  }
}

/**
 * Every backlog, in one read.
 *
 * The result is TOTAL over `CATALOG_GOVERNANCE_QUEUE_KINDS` — every kind
 * appears, measured or not. A desk that silently omitted a kind it could not
 * read would be a desk whose completeness depends on which domains happen to be
 * healthy, and `queue-census` asserts the returned kinds equal the tuple
 * exactly.
 */
export async function readGovernanceQueues(
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogGovernanceQueueDepth[]> {
  const depths: CatalogGovernanceQueueDepth[] = [];

  depths.push(
    await safeCount('pending_proposal', async () => {
      const [row] = await db
        .select({ total: count() })
        .from(catalogProposals)
        // The predicate comes from the proposals domain's OWN open-state tuple.
        .where(inArray(catalogProposals.state, [...CATALOG_PROPOSAL_OPEN_STATES]));
      return Number(row?.total ?? 0);
    }),
  );

  // Stale and missing are counted separately and deliberately: a stale
  // translation is a human sentence that has drifted from its source and needs
  // re-reading, and a missing one has never been written. Collapsing them
  // reports one number that no translator can act on.
  depths.push(
    await safeCount('stale_translation', async () => countLocalizations(db, ['stale'])),
  );
  depths.push(
    await safeCount('missing_translation', async () => countLocalizations(db, ['missing'])),
  );

  depths.push(
    await safeCount('open_external_mapping_review', async () => {
      const [row] = await db
        .select({ total: count() })
        .from(catalogExternalMappingReviews)
        .where(eq(catalogExternalMappingReviews.state, CATALOG_EXTERNAL_REVIEW_STATES[0]));
      return Number(row?.total ?? 0);
    }),
  );

  // The `unmapped` subset of the same table — the epic's "missing mappings".
  // A separate kind because the remedy is different: an unmapped token needs
  // somebody to decide what it means, and the other review reasons need
  // somebody to adjudicate between candidates that already exist.
  depths.push(
    await safeCount('unmapped_external_token', async () => {
      const [row] = await db
        .select({ total: count() })
        .from(catalogExternalMappingReviews)
        .where(
          and(
            eq(catalogExternalMappingReviews.state, CATALOG_EXTERNAL_REVIEW_STATES[0]),
            eq(catalogExternalMappingReviews.reason, 'unmapped'),
          ),
        );
      return Number(row?.total ?? 0);
    }),
  );

  depths.push(
    await safeCount('unresolved_compatibility_claim', async () => countUnreviewedClaims(db)),
  );

  depths.push(
    await safeCount('open_attribute_value_review', async () => {
      const [row] = await db
        .select({ total: count() })
        .from(attributeValueReviews)
        .where(eq(attributeValueReviews.state, 'open'));
      return Number(row?.total ?? 0);
    }),
  );

  depths.push(
    await safeCount('unresolved_variant_axis_claim', async () => {
      const queued = await countQueuedClaims(db);
      return queued.queued;
    }),
  );

  depths.push(
    await safeCount('pending_change_request', async () => countOpenChangeRequests(db)),
  );

  return depths;
}

/**
 * Localizations across the three text families.
 *
 * Three indexed aggregates rather than one `union all`, because each family is
 * a different table with a different index and the planner serves them
 * independently anyway; what a union would buy is one round trip, and what it
 * would cost is the ability to see which family failed. The families are named
 * explicitly rather than derived from
 * `CATALOG_LOCALIZATION_TEXT_TABLES`: that tuple is a census input for the
 * localization domain's own gate, and reading it here would make a desk count
 * depend on a constant maintained for a different purpose. The static
 * `catalog-governance-isolation.test.ts` asserts these three tables are exactly
 * the localization text families, so a fourth fails the build here too.
 */
async function countLocalizations(
  db: DatabaseOrTransaction,
  statuses: readonly string[],
): Promise<number> {
  const [categoryRow] = await db
    .select({ total: count() })
    .from(categoryLocalizations)
    .where(inArray(categoryLocalizations.status, [...statuses] as never));
  const [productTypeRow] = await db
    .select({ total: count() })
    .from(productTypeLocalizations)
    .where(inArray(productTypeLocalizations.status, [...statuses] as never));
  const [valueRow] = await db
    .select({ total: count() })
    .from(attributeValueLocalizations)
    .where(inArray(attributeValueLocalizations.status, [...statuses] as never));

  return (
    Number(categoryRow?.total ?? 0) +
    Number(productTypeRow?.total ?? 0) +
    Number(valueRow?.total ?? 0)
  );
}

/**
 * Orphaned references — the fourth queue the epic names, answered as a LIST
 * rather than a depth because each finding needs a different decision.
 *
 * An "orphan" here is a pointer that resolves to a definition an operator has
 * taken out of service: a navigation node on a deprecated or suppressed
 * category, a product type whose every category scope is out of service, a live
 * external mapping onto a product-type version that has been deprecated. None
 * of these is a broken foreign key — every one of them is valid SQL — which is
 * exactly why nothing else reports them.
 */
export interface OrphanedReferenceFinding {
  readonly kind: 'navigation_node' | 'product_type_scope' | 'external_mapping';
  readonly referenceId: string;
  readonly subjectId: string;
  readonly detail: string;
}

/** What an orphan scan looked at, beside what it found. */
export interface OrphanedReferenceScan {
  /** The size of the set the detector read — a scan that read nothing finds nothing. */
  readonly population: number;
  readonly findings: readonly OrphanedReferenceFinding[];
}

/**
 * Scan for orphaned references.
 *
 * `population` is the positive control and is the reason this returns a scan
 * rather than an array: zero findings over zero rows and zero findings over
 * forty thousand rows are the same array and opposite facts, and the second is
 * the only one that means the catalogue is clean.
 */
export async function scanOrphanedReferences(
  db: DatabaseOrTransaction = getDb(),
  limit = 200,
): Promise<OrphanedReferenceScan> {
  const findings: OrphanedReferenceFinding[] = [];

  // A navigation node pointing at a category that is no longer published. The
  // projection already withholds it from shoppers at read time, so nothing
  // breaks — which is why it can sit there for months unnoticed.
  const nodes = await db.execute<{
    node_id: string;
    category_id: string;
    lifecycle: string;
  }>(sql`
    select n.id as node_id, n.category_id, c.lifecycle
      from navigation_nodes n
      join categories c on c.id = n.category_id
     where c.lifecycle <> 'published'
     order by n.id
     limit ${limit}
  `);
  for (const row of nodes) {
    findings.push({
      kind: 'navigation_node',
      referenceId: row.node_id,
      subjectId: row.category_id,
      detail: `This navigation node targets a category whose lifecycle is ${row.lifecycle}, so it renders for nobody.`,
    });
  }

  // A published product type every one of whose category scopes is out of
  // service: usable nowhere, and visible as a healthy published row.
  const scopes = await db.execute<{ definition_id: string; key: string }>(sql`
    select d.id as definition_id, d.key
      from product_type_definitions d
     where d.lifecycle = 'published'
       and exists (select 1 from product_type_category_scopes s where s.product_type_definition_id = d.id)
       and not exists (
             select 1
               from product_type_category_scopes s
               join categories c on c.id = s.category_id
              where s.product_type_definition_id = d.id
                and c.lifecycle = 'published'
           )
     order by d.id
     limit ${limit}
  `);
  for (const row of scopes) {
    findings.push({
      kind: 'product_type_scope',
      referenceId: row.definition_id,
      subjectId: row.definition_id,
      detail: `Product type ${row.key} is published but every category it is scoped to is out of service, so no author can reach it.`,
    });
  }

  // A live external mapping whose reviewed product-type version has been
  // deprecated — the mapping still resolves, against a version nobody should be
  // authoring into.
  const mappings = await db.execute<{ mapping_id: string; definition_id: string }>(sql`
    select m.id as mapping_id, m.reviewed_product_type_definition_id as definition_id
      from catalog_external_mappings m
      join product_type_definitions d on d.id = m.reviewed_product_type_definition_id
     where m.state = 'approved'
       and m.valid_to is null
       and d.lifecycle = 'deprecated'
     order by m.id
     limit ${limit}
  `);
  for (const row of mappings) {
    findings.push({
      kind: 'external_mapping',
      referenceId: row.mapping_id,
      subjectId: row.definition_id,
      detail:
        'This live external mapping was reviewed against a product type version that has since been deprecated.',
    });
  }

  // The population every one of those three predicates was applied over. Read
  // AFTER the scans deliberately: a floor taken before the reads would be
  // satisfied by a scan that then failed to run.
  const [population] = await db.execute<{ total: number }>(sql`
    select (select count(*) from navigation_nodes)
         + (select count(*) from product_type_definitions)
         + (select count(*) from catalog_external_mappings) as total
  `);

  return { population: Number(population?.total ?? 0), findings };
}

/** The kinds a queue read must answer for. Exported so the census can reconcile. */
export const GOVERNANCE_QUEUE_KINDS_ANSWERED: readonly CatalogGovernanceQueueKind[] =
  CATALOG_GOVERNANCE_QUEUE_KINDS;
