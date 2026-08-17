/**
 * Definition snapshots (#367 Workstream 12).
 *
 * Catalog DEFINITIONS only — categories, product-type versions, attribute
 * definitions and their controlled values, localizations, navigation trees. No
 * order, payment, buyer or listing row has a column here it could arrive in,
 * and `catalog-governance-isolation.test.ts` walks a real emitted document
 * because the document itself is jsonb and a schema cannot constrain what a
 * composer puts in one.
 */

import { desc, eq } from 'drizzle-orm';
import type { CatalogGovernanceSnapshotScope } from '@mercaria/shared-types';
import { conflict } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../postgres.js';
import { catalogGovernanceDefinitionSnapshots } from '../schema/catalogGovernance.js';

export type CatalogGovernanceSnapshotRow =
  typeof catalogGovernanceDefinitionSnapshots.$inferSelect;

/** The counted parts of a snapshot. The headline is derived, never supplied. */
export interface SnapshotCounts {
  readonly categoryCount: number;
  readonly productTypeCount: number;
  readonly attributeCount: number;
  readonly localizationCount: number;
  readonly navigationTreeCount: number;
}

/** What a new snapshot states. */
export interface NewDefinitionSnapshot {
  readonly scope: CatalogGovernanceSnapshotScope;
  readonly contentDigest: string;
  readonly document: unknown;
  readonly counts: SnapshotCounts;
  readonly createdByOxyUserId: string;
  readonly reason: string;
}

/**
 * Store one snapshot.
 *
 * `entity_count` is DERIVED here from the parts rather than taken from the
 * caller, so the headline and the breakdown cannot disagree — two
 * representations of one fact, and the CHECK would catch it, but catching it at
 * the writer names the caller instead of naming the constraint.
 *
 * An empty export is refused before the statement, because the row CHECK would
 * refuse it with a constraint name and this refusal can say why it matters: a
 * snapshot of nothing digests cleanly, restores cleanly and reports "nothing to
 * do", which is the one failure mode a restore cannot recover from.
 */
export async function insertDefinitionSnapshot(
  db: DatabaseOrTransaction,
  input: NewDefinitionSnapshot,
): Promise<CatalogGovernanceSnapshotRow> {
  const entityCount =
    input.counts.categoryCount +
    input.counts.productTypeCount +
    input.counts.attributeCount +
    input.counts.localizationCount +
    input.counts.navigationTreeCount;

  if (entityCount === 0) {
    throw conflict(
      'This export read no definitions. An empty snapshot restores cleanly and reports nothing to do, which is indistinguishable from a working restore — widen the scope or check the deployment has a catalogue.',
    );
  }

  const [row] = await db
    .insert(catalogGovernanceDefinitionSnapshots)
    .values({
      scope: input.scope,
      contentDigest: input.contentDigest,
      document: input.document,
      entityCount,
      categoryCount: input.counts.categoryCount,
      productTypeCount: input.counts.productTypeCount,
      attributeCount: input.counts.attributeCount,
      localizationCount: input.counts.localizationCount,
      navigationTreeCount: input.counts.navigationTreeCount,
      createdByOxyUserId: input.createdByOxyUserId,
      reason: input.reason,
    })
    .returning();
  return row;
}

/** One snapshot, or `null`. */
export async function findDefinitionSnapshot(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogGovernanceSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(catalogGovernanceDefinitionSnapshots)
    .where(eq(catalogGovernanceDefinitionSnapshots.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The catalogue of snapshots, newest first, WITHOUT their documents.
 *
 * The projection names its columns explicitly — a `select()` would carry every
 * document in the list, which is megabytes of definitions to render a table of
 * dates.
 */
export async function listDefinitionSnapshots(
  db: DatabaseOrTransaction,
  limit: number,
  offset: number,
): Promise<Omit<CatalogGovernanceSnapshotRow, 'document'>[]> {
  return db
    .select({
      id: catalogGovernanceDefinitionSnapshots.id,
      scope: catalogGovernanceDefinitionSnapshots.scope,
      contentDigest: catalogGovernanceDefinitionSnapshots.contentDigest,
      entityCount: catalogGovernanceDefinitionSnapshots.entityCount,
      categoryCount: catalogGovernanceDefinitionSnapshots.categoryCount,
      productTypeCount: catalogGovernanceDefinitionSnapshots.productTypeCount,
      attributeCount: catalogGovernanceDefinitionSnapshots.attributeCount,
      localizationCount: catalogGovernanceDefinitionSnapshots.localizationCount,
      navigationTreeCount: catalogGovernanceDefinitionSnapshots.navigationTreeCount,
      createdByOxyUserId: catalogGovernanceDefinitionSnapshots.createdByOxyUserId,
      reason: catalogGovernanceDefinitionSnapshots.reason,
      createdAt: catalogGovernanceDefinitionSnapshots.createdAt,
    })
    .from(catalogGovernanceDefinitionSnapshots)
    .orderBy(desc(catalogGovernanceDefinitionSnapshots.createdAt))
    .limit(limit)
    .offset(offset);
}
