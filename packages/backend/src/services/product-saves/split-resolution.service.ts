/**
 * Answering a split ambiguity — the buyer's half of #80 migration rule 8.
 *
 * The split job MARKED the save (`services/curation/split.service.ts`); nothing
 * moved it, because no rule can say which of two products a person meant. This
 * is where they say.
 *
 * ## Three answers, and why none of them is a default
 *
 * - `keep_source` — the save stays where it is and the flag clears.
 * - `move_to_target` — the save moves to the entity the split produced.
 * - `keep_both` — the save stays AND a second one is created on the target.
 *
 * `keep_both` exists because the honest reading of a split is often "these were
 * always two things and I wanted both": refusing it would push a buyer to
 * answer a question wrongly rather than completely. It is also why the
 * resolution is an explicit three-way choice and not a boolean — a
 * `move: true|false` contract cannot express it, and the affordance a client
 * builds from a boolean is the one that quietly loses half a buyer's interest.
 *
 * ## Every answer converges on a repeat
 *
 * Each path is a CAS on "still ambiguous" plus, where a row is created, the
 * ordinary `ON CONFLICT DO NOTHING`. A buyer who taps twice, or whose client
 * retries a request it never saw the response of, ends in the same state as one
 * who tapped once — the same property `saveProduct` has and for the same
 * reason.
 */

import type { ProductSave, ProductSaveSplitResolution } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { catalogSplitJobs } from '../../db/schema/curation.js';
import { eq } from 'drizzle-orm';
import {
  clearProductSaveAmbiguity,
  deleteProductSave,
  findProductSave,
  findProductSaveByIdForOwner,
  insertProductSave,
  repointProductSave,
} from '../../db/productSaves/productSaveRepository.js';
import { rebuildProductSaveAggregate } from '../../db/productSaves/productSaveAggregateRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { toProductSaveDTO } from './product-save.service.js';

export interface ResolveSplitInput {
  readonly oxyUserId: string;
  readonly saveId: string;
  readonly resolution: ProductSaveSplitResolution;
}

/**
 * Apply a buyer's answer to a split ambiguity.
 *
 * The save is fetched SCOPED TO ITS OWNER, so a save id belonging to somebody
 * else is a 404 and not a 403 — the id is opaque and a distinguishable response
 * would confirm that a stranger's save exists.
 */
export async function resolveSplitAmbiguity(
  input: ResolveSplitInput,
): Promise<{ kept: ProductSave; created?: ProductSave }> {
  const db = getDb();
  const save = await findProductSaveByIdForOwner(input.saveId, input.oxyUserId, db);
  if (!save) throw notFound('You have not saved that product.');
  if (save.resolutionState !== 'ambiguous_after_split' || !save.ambiguousSplitJobId) {
    throw conflict('That save is not waiting on a decision.');
  }

  if (input.resolution === 'keep_source') {
    if (!(await clearProductSaveAmbiguity(save.id, db))) {
      throw conflict('That save is not waiting on a decision.');
    }
    const refreshed = await findProductSaveByIdForOwner(save.id, input.oxyUserId, db);
    if (!refreshed) throw notFound('You have not saved that product.');
    return { kept: toProductSaveDTO(refreshed) };
  }

  const targetId = await readSplitTarget(save.ambiguousSplitJobId);
  if (!targetId) {
    // A split that reached the `saves` phase has minted or revived its
    // destination, so this is unreachable unless the job was interrupted before
    // `mint` — in which case the honest answer is that there is nothing to
    // choose yet, never a silent `keep_source`.
    throw conflict(
      'The other product this split produced does not exist yet. Please try again shortly.',
    );
  }
  if (targetId === save.canonicalProductId) {
    throw validationError('That split did not produce a different product to move to.');
  }

  if (input.resolution === 'move_to_target') return moveToTarget(save.id, input, targetId);
  return keepBoth(save.id, input, targetId);
}

/** `move_to_target` — one save, on the other product. */
async function moveToTarget(
  saveId: string,
  input: ResolveSplitInput,
  targetId: string,
): Promise<{ kept: ProductSave }> {
  const db = getDb();

  const { moved, sourceProductId } = await db.transaction(async (tx) => {
    const save = await findProductSaveByIdForOwner(saveId, input.oxyUserId, tx);
    if (!save) throw notFound('You have not saved that product.');

    const existing = await findProductSave(input.oxyUserId, targetId, tx);
    if (existing) {
      // The buyer already saves the destination — an ordinary state, because a
      // split can divide a product somebody had already saved BOTH halves of
      // under their previous identities. Moving would violate
      // `product_saves_oxy_user_id_canonical_product_id_key`, so the ambiguous
      // row is removed and the existing save is the answer. Nothing is lost:
      // their saved list ends with exactly one entry for the destination, which
      // is what "move it there" means when they are already there.
      await deleteProductSave(input.oxyUserId, save.canonicalProductId, tx);
      return { moved: existing, sourceProductId: save.canonicalProductId };
    }
    const repointed = await repointProductSave(saveId, targetId, tx);
    if (!repointed) throw conflict('That save changed while it was being resolved.');
    return { moved: repointed, sourceProductId: save.canonicalProductId };
  });

  await rebuildProductSaveAggregate(sourceProductId, db);
  await rebuildProductSaveAggregate(targetId, db);
  return { kept: toProductSaveDTO(moved) };
}

/** `keep_both` — the save stays, and a second one is created on the target. */
async function keepBoth(
  saveId: string,
  input: ResolveSplitInput,
  targetId: string,
): Promise<{ kept: ProductSave; created: ProductSave }> {
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    if (!(await clearProductSaveAmbiguity(saveId, tx))) {
      throw conflict('That save is not waiting on a decision.');
    }
    const kept = await findProductSaveByIdForOwner(saveId, input.oxyUserId, tx);
    if (!kept) throw notFound('You have not saved that product.');
    const { save: created } = await insertProductSave(
      {
        oxyUserId: input.oxyUserId,
        canonicalProductId: targetId,
        sourceContext: 'split_resolution',
        // The preferences are deliberately NOT copied. A preferred variant of
        // the product being kept does not exist under the one being added, and
        // a preferred seller carried across would narrow a brand-new save to a
        // merchant the buyer never chose for it.
      },
      tx,
    );
    return { kept, created };
  });

  await rebuildProductSaveAggregate(targetId, db);
  return { kept: toProductSaveDTO(result.kept), created: toProductSaveDTO(result.created) };
}

/** The entity a split job produced, if it has produced one yet. */
async function readSplitTarget(splitJobId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ targetEntityId: catalogSplitJobs.targetEntityId })
    .from(catalogSplitJobs)
    .where(eq(catalogSplitJobs.id, splitJobId))
    .limit(1);
  return rows[0]?.targetEntityId ?? undefined;
}
