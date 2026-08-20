/**
 * Whether what a proposal resolved to is in service (#568).
 *
 * `catalog_proposals.state` records a DECISION. It cannot record a publication,
 * because publishing happens later, is performed by somebody else, and applies to
 * a row this table does not own — so the two facts are read from two places and
 * this module is the one that joins them.
 *
 * ## Derived on every read, never stored
 *
 * A column would be a second representation of `attribute_definitions.
 * lifecycle_state`, and the two would disagree the moment an operator published a
 * version — the `deriveNativeCheckoutEligibility` divergence from the
 * one-stored-verdict rule, for the same reason: the input sits on a table in
 * another domain and moves without this one being told.
 *
 * ## Only a controlled value has a publication at all
 *
 * `resolved_entity_id` is polymorphic by `type`, and seven of the eight types are
 * link-only — they name an entity an operator created on its own surface, whose
 * lifecycle is that surface's business. So everything but a resolved
 * `controlled_value` is `not_applicable`, which is a real answer and not a
 * fallback for "we did not look".
 */

import type { CatalogProposal, ResolvedEntityPublication } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { listEnumValueVersions } from '../../db/attributes/definitionRepository.js';
import type { CatalogProposalRow } from '../../db/catalogProposals/proposalRepository.js';
import { projectProposal } from './projection.js';

/** No versioned entity behind this proposal. */
const NOT_APPLICABLE: ResolvedEntityPublication = { state: 'not_applicable' };

/** The one value id a proposal can carry that names a versioned row. */
function versionedEntityId(row: CatalogProposalRow): string | undefined {
  if (row.type !== 'controlled_value') return undefined;
  if (row.resolvedEntityId === null) return undefined;
  return row.resolvedEntityId;
}

/**
 * Publications for a batch, keyed by proposal id.
 *
 * ONE statement for the whole page. A per-row lookup would make the cost of
 * listing proposals a function of how many of them were approved, which is the
 * direction that gets worse as the surface succeeds.
 */
export async function readProposalPublications(
  db: DatabaseOrTransaction,
  rows: readonly CatalogProposalRow[],
): Promise<Map<string, ResolvedEntityPublication>> {
  const byProposal = new Map<string, ResolvedEntityPublication>();
  const valueIds: string[] = [];
  for (const row of rows) {
    const entityId = versionedEntityId(row);
    if (entityId === undefined) {
      byProposal.set(row.id, NOT_APPLICABLE);
      continue;
    }
    valueIds.push(entityId);
  }
  if (valueIds.length === 0) return byProposal;

  const versions = await listEnumValueVersions(db, [...new Set(valueIds)]);
  const byValueId = new Map(versions.map((version) => [version.enumValueId, version]));

  for (const row of rows) {
    const entityId = versionedEntityId(row);
    if (entityId === undefined) continue;
    const version = byValueId.get(entityId);
    if (version === undefined) {
      // The value is gone. `not_applicable` rather than an invented version:
      // there is nothing to publish and nothing to name, and reporting
      // `pending_publication` would send an operator looking for a draft that
      // does not exist.
      byProposal.set(row.id, NOT_APPLICABLE);
      continue;
    }
    byProposal.set(row.id, {
      state:
        version.lifecycleState === 'draft'
          ? 'pending_publication'
          : version.lifecycleState === 'active'
            ? 'published'
            : 'superseded',
      versionId: version.definitionId,
      versionNumber: version.version,
    });
  }
  return byProposal;
}

/** The publication for ONE proposal — the approval path, which has a single row. */
export async function readProposalPublication(
  db: DatabaseOrTransaction,
  row: CatalogProposalRow,
): Promise<ResolvedEntityPublication> {
  const byProposal = await readProposalPublications(db, [row]);
  return byProposal.get(row.id) ?? NOT_APPLICABLE;
}

/**
 * A whole page of rows, projected with their publications.
 *
 * The list surfaces call this rather than reading the map and indexing it
 * themselves. A caller holding the map would reach for `?? not_applicable` on a
 * miss, and that default is the exact failure `publication` exists to prevent —
 * an approved proposal reporting nothing pending. Here a miss is impossible,
 * because the map is built from these same rows.
 */
export async function projectProposals(
  db: DatabaseOrTransaction,
  rows: readonly CatalogProposalRow[],
): Promise<CatalogProposal[]> {
  const byProposal = await readProposalPublications(db, rows);
  return rows.map((row) => projectProposal(row, byProposal.get(row.id) ?? NOT_APPLICABLE));
}
