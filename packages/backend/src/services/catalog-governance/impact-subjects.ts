/**
 * WHICH definition versions a governance action disturbs (#367 Workstream 12,
 * issue #587).
 *
 * `impact-plan.ts` answers "which relations point at a governed definition".
 * This answers the question in front of it — "which definitions does this
 * particular action touch" — and the two are not the same question for a
 * PUBLICATION.
 *
 * ## The measured hole this module closes
 *
 * `planChange` measured inbound references to the request's own `subjectId`.
 * For `product_type_publish` and `attribute_publish` that subject is the
 * version being published, which is a `draft` — and a draft is exactly what
 * nothing may point at yet:
 *
 * - `RETRIEVABLE_AUTHORING_LIFECYCLES` (`catalog-authoring/schema.service.ts`)
 *   is `['published', 'deprecated']`, so `catalog_authoring_drafts` and every
 *   other record that pins a product-type version can only pin one of those.
 * - `attribute_definitions_one_active_per_key` plus
 *   `publishAttributeDefinition`'s own `draft` precondition put the attribute
 *   half in the same position: canonical values, variant attributes and seller
 *   claims resolve to the ACTIVE version, never to the draft.
 *
 * So every count that matters was **zero by construction**, and an operator
 * publishing v3 read "nothing is affected" while every draft, listing and axis
 * pinned to v2 was about to be reinterpreted. Not a stale number — a number
 * structurally incapable of being anything else.
 *
 * The population a publication actually disturbs is the INCUMBENT it
 * deprecates. Both publishers deprecate it FIRST, in the same transaction, and
 * that order is the partial unique index's rather than a preference —
 * `product_type_definitions_one_published_per_key` and
 * `attribute_definitions_one_active_per_key` refuse the other order.
 *
 * ## Why the union, and not the incumbent alone
 *
 * `catalog_governance_impact_counts_relation_key` is UNIQUE on
 * `(change_request_id, reference_table, reference_column)`: a request has
 * exactly one measurement per relation. That constraint decides the shape —
 * the measurement is over the whole affected population, counted once per
 * relation with an `IN`, and not one measurement per version.
 *
 * Given one measurement, the subject stays IN it for two reasons. The plan's
 * own note on `product_type_fields` says that count "is what a diff is a diff
 * OF, so it is the first number an operator reads before publishing", and
 * dropping the subject would drop it. And a union can only make a publication
 * read as LARGER, which errs toward the second pair of eyes
 * (`GOVERNANCE_HIGH_IMPACT_THRESHOLD`); measuring the incumbent alone could
 * make one read as smaller than it is, which is the direction of the bug being
 * fixed.
 *
 * ## Why the superseded ids are not a field on the report
 *
 * `CatalogGovernanceImpactReport` is rebuilt from stored rows by
 * `reportFromStoredRows` every time a planned request is read back, and there
 * is no column holding what was superseded. A field that is right at plan time
 * and wrong on every later read is worse than no field — two representations
 * of one fact that can disagree. So the superseded versions are recorded where
 * this domain already records facts about a plan: the `change_requested` audit
 * event's `after` snapshot, which is append-only jsonb already carrying
 * `impactTotal` and `impactCoverage`.
 *
 * ## What is deliberately NOT resolved here
 *
 * The KEY is read from the subject ROW, never from `parameters`.
 * `attribute_publish` carries `attributeKey` and `attributeVersion` as
 * operator-supplied parameters, and resolving the measured population from
 * those would let the caller choose which population is measured — a parameter
 * naming another key would measure somebody else's records and report them as
 * this change's blast radius.
 */

import type { CatalogGovernanceAction, CatalogGovernanceSubjectKind } from '@mercaria/shared-types';
import { CATALOG_GOVERNANCE_ACTION_SUBJECTS } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findAttributeDefinitionById, findActiveAttributeDefinition } from '../../db/attributes/definitionRepository.js';
import {
  findProductTypeDefinitionById,
  findPublishedProductTypeDefinition,
} from '../../db/productTypes/productTypeRepository.js';

/**
 * The definition versions one change touches.
 *
 * `supersededIds` is the versions the change DEPRECATES in the same
 * transaction. It never contains `subjectId` — a publication cannot supersede
 * itself, and the two publishers both compare ids before deprecating.
 */
export interface ImpactSubjects {
  readonly subjectId: string;
  readonly supersededIds: readonly string[];
}

/**
 * Every id the impact counts cover.
 *
 * DERIVED rather than stored beside the pair, so the set that is counted and
 * the set that is reported cannot drift apart.
 */
export function countedSubjectIds(subjects: ImpactSubjects): readonly string[] {
  return [subjects.subjectId, ...subjects.supersededIds];
}

/** A change that touches its subject and nothing else — every action but the two publications. */
export function onlySubject(subjectId: string): ImpactSubjects {
  return { subjectId, supersededIds: [] };
}

/**
 * Which versions this action disturbs.
 *
 * The two PUBLICATIONS are the only actions that touch a version other than
 * their subject, and they are stated as explicit cases rather than derived from
 * a lifecycle: "this subject is a draft and a published sibling exists" is a
 * shape several actions share, and reading a publication out of it would make
 * the measured population a function of the row's state at plan time rather
 * than of what the operator asked for.
 *
 * A first publication has no incumbent and answers `supersededIds: []`, which
 * is the true answer — nothing is deprecated, so nothing pinned elsewhere is
 * disturbed. It is not the same as a missing measurement: the relations are
 * still counted, against the subject, and every count is still a read that ran.
 */
export async function resolveImpactSubjects(
  db: DatabaseOrTransaction,
  action: CatalogGovernanceAction,
  subjectId: string,
): Promise<ImpactSubjects> {
  if (action === 'product_type_publish') {
    const subject = await findProductTypeDefinitionById(db, subjectId);
    if (subject === null) return onlySubject(subjectId);
    const incumbent = await findPublishedProductTypeDefinition(db, subject.key);
    if (incumbent === null || incumbent.id === subjectId) return onlySubject(subjectId);
    return { subjectId, supersededIds: [incumbent.id] };
  }

  if (action === 'attribute_publish') {
    const subject = await findAttributeDefinitionById(db, subjectId);
    if (subject === undefined) return onlySubject(subjectId);
    const incumbent = await findActiveAttributeDefinition(db, subject.key);
    if (incumbent === undefined || incumbent.id === subjectId) return onlySubject(subjectId);
    return { subjectId, supersededIds: [incumbent.id] };
  }

  return onlySubject(subjectId);
}

/**
 * The subject kind an action acts on — the one map, never a second spelling.
 *
 * Exported so the standalone impact preview can refuse a `subjectKind` that
 * disagrees with the `action` it was given, rather than measuring one kind's
 * relations against another kind's id and reporting the zeros that produces.
 */
export function subjectKindForAction(
  action: CatalogGovernanceAction,
): CatalogGovernanceSubjectKind {
  return CATALOG_GOVERNANCE_ACTION_SUBJECTS[action];
}
