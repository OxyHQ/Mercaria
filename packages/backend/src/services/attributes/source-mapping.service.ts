/**
 * Recording how one source's FIELD is read, and telling the index it changed
 * (#94 coverage rule 8, #821).
 *
 * A source mapping is not a fact about a product — it is the rule under which
 * this source's facts are READ. `applyAttributeObservation` looks one up by
 * `(catalogSourceId, sourceField)` and hands its `assumedUnit` and
 * `componentAxis` to `normalizeAttributeObservation`, so `assumed_unit` is the
 * one place a unit may come from for a value the source published as a bare
 * number. Change it and every magnitude already recorded through that field
 * means something different from what is stored beside it.
 *
 * ## Why this is a REINDEX and not an authoring-schema bump
 *
 * The two mechanisms answer different questions and a writer owes whichever of
 * them reads what it changed. `bumpAuthoringSchemaInvalidation` raises a
 * revision that sits in the memoized authoring schema's CACHE KEY, and its
 * `attribute_values` subject is keyed on an `attribute_definitions` row id —
 * "one definition's CONTROLLED VALUES changed". A source mapping is neither: the
 * composition in `catalog-authoring/schema.service.ts` reads no source mapping
 * and no stored value at all, so a bump here would move a revision nothing
 * reads. What a mapping change does invalidate is the search index, which
 * follows the canonical product row and can never see it.
 *
 * `normalization_rules_changed` is the reason, and it is the vocabulary's own
 * word for exactly this: the rules a stored value was normalized under moved.
 *
 * ## Both keys, because an upsert can RE-POINT the field
 *
 * The unique is `(catalog_source_id, source_field)` and `attributeKey` is in the
 * `set`, so one call can move a field from `screen_size` to `display_diagonal`.
 * Fanning out over the NEW key alone would leave every entity whose value this
 * mapping produced under the OLD key holding a magnitude read under a rule that
 * no longer exists, and told nothing — the under-enqueue direction, which is the
 * bug. So the prior row is read inside the transaction and both keys are swept.
 *
 * The sweep is unconditional rather than gated on a value actually having
 * changed. `enqueueAttributeReindex` is `ON CONFLICT DO NOTHING` on a
 * deterministic id, so a repeat writes nothing at all; the alternative is a
 * change-detection comparison over seven columns whose failure direction is a
 * silently skipped invalidation.
 */

import { getDb } from '../../db/postgres.js';
import {
  enqueueAttributeReindex,
  findAttributeSourceMapping,
  upsertAttributeSourceMapping,
  type AttributeSourceMappingRow,
} from '../../db/attributes/attributeOpsRepository.js';
import { listEntityIdsWithAttribute } from '../../db/canonical/attributeRepository.js';
import type { AttributeComponentAxis } from '@mercaria/shared-types';

export interface RecordAttributeSourceMappingInput {
  readonly catalogSourceId: string;
  /** Stored folded; `attribute_source_mappings_field_shape_check` requires it. */
  readonly sourceField: string;
  readonly attributeKey: string;
  readonly assumedUnit: string | null;
  readonly componentAxis: AttributeComponentAxis | null;
  readonly categoryIds: string[];
  readonly note: string | null;
  readonly createdByOxyUserId: string;
}

/**
 * Write the mapping and enqueue a reindex for every entity it can have read.
 *
 * One transaction: a reindex must never be owed for a mapping change that rolled
 * back, and a mapping must never land without one.
 */
export async function recordAttributeSourceMapping(
  input: RecordAttributeSourceMappingInput,
): Promise<AttributeSourceMappingRow> {
  const sourceField = input.sourceField.trim().toLowerCase();

  return getDb().transaction(async (tx) => {
    const previous = await findAttributeSourceMapping(tx, input.catalogSourceId, sourceField);

    const mapping = await upsertAttributeSourceMapping(tx, {
      catalogSourceId: input.catalogSourceId,
      sourceField,
      attributeKey: input.attributeKey,
      assumedUnit: input.assumedUnit,
      componentAxis: input.componentAxis,
      categoryIds: input.categoryIds,
      note: input.note,
      createdByOxyUserId: input.createdByOxyUserId,
    });

    // The STORED spellings, from rows the database accepted, rather than the
    // request's: `attribute_source_mappings_key_shape_check` already holds the
    // key to the folded form `canonical_attribute_values.attribute_key` is
    // written in, and comparing anything else would silently sweep nothing.
    const keys = new Set<string>([mapping.attributeKey]);
    if (previous) keys.add(previous.attributeKey);

    for (const attributeKey of keys) {
      // One row per ENTITY rather than one naming the key: the consumer's unit
      // of work is a document, and a single "everything under key X" row would
      // have to be expanded by whoever drained it — unbounded work inside a
      // lease. `definition-registry.service.ts` makes the same choice.
      for (const entity of await listEntityIdsWithAttribute(tx, attributeKey)) {
        await enqueueAttributeReindex(tx, {
          entityKind: entity.kind,
          entityId: entity.id,
          attributeKey,
          reason: 'normalization_rules_changed',
        });
      }
    }

    return mapping;
  });
}
