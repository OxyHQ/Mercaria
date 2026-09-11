/**
 * `asset_variant_bindings` — the one join between the catalogue and the digital
 * domain, read at checkout (#1015, ADR 0010).
 *
 * A repository rather than a query inside `services/checkout/digital-lines.ts`,
 * for the reason every other domain here has one: the service layer is where the
 * RULES live and the repository layer is the only thing that reaches Postgres.
 * The practical half of that boundary is that a service with an inline query
 * cannot be exercised by the mocked checkout suites, which is how this module
 * came to exist — the first draft put the join in the service and turned six
 * unit tests into "PostgreSQL is not connected".
 *
 * It returns ROWS and makes no decision. Which of them are acquirable, and what a
 * purchase then pins, is `digital-lines.ts`'s question.
 */

import { eq, inArray } from 'drizzle-orm';
import type {
  AssetVersionState,
  DigitalAssetState,
  DigitalLicenceUpdatePolicy,
  DigitalLicenceVersionState,
  DigitalVertical,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { assetVersions, digitalAssets } from '../schema/digitalAssets.js';
import {
  assetLicenceOptions,
  assetLicenceVersions,
  assetVariantBindings,
} from '../schema/digitalRights.js';

/** One binding, joined to everything the acquirability decision reads. */
export interface DigitalBindingRow {
  readonly variantId: string;
  readonly assetId: string;
  readonly packageId: string;
  readonly licenceVersionId: string;
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
  readonly optionAcquirable: boolean;
  readonly licenceState: DigitalLicenceVersionState;
  readonly vertical: DigitalVertical;
  readonly assetState: DigitalAssetState;
  readonly currentVersionId: string | null;
  /** The state of `currentVersionId`, or `null` when it names nothing. */
  readonly currentVersionState: AssetVersionState | null;
}

/**
 * Every binding among `variantIds`, joined to its option, licence and asset.
 *
 * ONE statement including the current version's state, rather than a per-row
 * follow-up: a cart of twenty digital lines would otherwise be twenty-one
 * round trips, and the first draft of this was exactly that. The join to
 * `asset_versions` is LEFT, because `current_version_id` is nullable and an asset
 * with no publishable version must come back as a row that the caller then
 * refuses — not as a row that silently vanishes from an inner join, which reads
 * downstream as "this line is physical".
 */
export async function findDigitalBindings(
  variantIds: readonly string[],
  tx?: DatabaseOrTransaction,
): Promise<DigitalBindingRow[]> {
  if (variantIds.length === 0) return [];
  const db = tx ?? getDb();
  return db
    .select({
      variantId: assetVariantBindings.variantId,
      assetId: assetLicenceOptions.assetId,
      packageId: assetLicenceOptions.packageId,
      licenceVersionId: assetLicenceOptions.licenceVersionId,
      updatePolicy: assetLicenceOptions.updatePolicy,
      optionAcquirable: assetLicenceOptions.acquirable,
      licenceState: assetLicenceVersions.state,
      vertical: digitalAssets.vertical,
      assetState: digitalAssets.state,
      currentVersionId: digitalAssets.currentVersionId,
      currentVersionState: assetVersions.state,
    })
    .from(assetVariantBindings)
    .innerJoin(
      assetLicenceOptions,
      eq(assetLicenceOptions.id, assetVariantBindings.licenceOptionId),
    )
    .innerJoin(
      assetLicenceVersions,
      eq(assetLicenceVersions.id, assetLicenceOptions.licenceVersionId),
    )
    .innerJoin(digitalAssets, eq(digitalAssets.id, assetLicenceOptions.assetId))
    .leftJoin(assetVersions, eq(assetVersions.id, digitalAssets.currentVersionId))
    .where(inArray(assetVariantBindings.variantId, [...variantIds]));
}

/** Bind one catalogue variant to one licence option. Idempotent on the variant. */
export async function upsertDigitalBinding(
  input: { readonly variantId: string; readonly licenceOptionId: string },
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db
    .insert(assetVariantBindings)
    .values({ variantId: input.variantId, licenceOptionId: input.licenceOptionId })
    .onConflictDoUpdate({
      target: assetVariantBindings.variantId,
      set: { licenceOptionId: input.licenceOptionId },
    });
}
