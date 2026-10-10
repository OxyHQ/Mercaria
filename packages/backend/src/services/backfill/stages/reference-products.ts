/**
 * Stage `reference_products` — an open REFERENCE catalogue mints draft
 * canonical products (ADR 0014 D2).
 *
 * The provisional-products stage mints from a store's listing; this one mints
 * from a source an operator granted `seed_catalog` — Open Food Facts and its
 * siblings, where each record is one trade item identified by its GS1 GTIN.
 * Without it, a price for a product no Mercaria store sells has nowhere to
 * land: #58's matcher records `create_new` for it and, correctly, stops.
 *
 * ## The rules, in the order they are applied
 *
 * 1. **Only `unmatched` objects of a source whose ACTIVE policy grants
 *    `seed_catalog`.** The page query applies it, so an object of any other
 *    source is never examined at all.
 * 2. **The matcher's verdict decides whether minting is permitted.** No
 *    decision yet is `awaiting_match_decision`; `manual_review` is
 *    `blocked_by_decision`. Only `create_new` — the matcher saying it found
 *    nothing this could be — goes on. D23's ordering: identifier matching
 *    precedes creation, because minting first guarantees a duplicate for
 *    every object whose GTIN would have resolved.
 * 3. **A GTIN that validates, or nothing.** A record without one is
 *    `reference_no_identifier`: a name alone is not identity, and a catalogue
 *    keyed on names is the duplicate factory this graph exists to prevent.
 * 4. **A GTIN somebody already owns mints nothing** (`identifier_already_owned`)
 *    — the product appeared after the matcher's verdict, and the object
 *    attaches on the next `source_readvance` instead.
 *
 * ## It links NOTHING
 *
 * The product, its default variant and the GTIN (with the observation as
 * `source_record_id`) are written; no source link, no object state. Attaching
 * an observation is #58's decision alone, and `source_readvance` asks for it —
 * so a seeded product is attached by exactly the path every other one is.
 *
 * ## Idempotent by object and mapping version
 *
 * A previous record for this object under this mapping version and mode names
 * the product it minted; a re-run reuses it. The slug is the name's slug plus
 * the GTIN, so a mint that crashed after the product and before the identifier
 * re-runs into a slug conflict on the SAME product rather than a second one —
 * and the record reuse above means it never gets that far.
 */

import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { IdentifierScheme } from '@mercaria/shared-types';
import { CATALOG_SOURCE_DISPLAYABLE_STATUSES } from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import { catalogSourceConfigs, catalogSourceObjects, catalogSourcePolicies } from '../../../db/schema/ingestion.js';
import { findSourceRecordById } from '../../../db/canonical/provenanceRepository.js';
import { findMatchDecisionById } from '../../../db/matching/matchDecisionRepository.js';
import { findCanonicalProductById } from '../../../db/canonical/canonicalProductRepository.js';
import { findBackfillRecord } from '../../../db/backfill/backfillRecordRepository.js';
import { findCanonicalProductByIdentifier } from '../../canonical/canonical-product.service.js';
import { normalizeIdentifier } from '../../canonical/identifiers.js';
import { slugFromName } from '../../canonical/normalization.js';
import { isDryRunId } from '../graph-writer.js';
import { backfillSubjectKey } from '../mapping-version.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

/** The object facts this stage decides on. */
interface ObjectRow {
  readonly id: string;
  readonly currentSourceRecordId: string | null;
  readonly lastMatchDecisionId: string | null;
}

/**
 * The GTIN-family schemes, tried in this order — `provisional-products.ts`'
 * list and reasoning: the first scheme whose check digit ACCEPTS the digits is
 * what the source asserted.
 */
const GTIN_SCHEMES: readonly IdentifierScheme[] = ['ean', 'upc', 'gtin14', 'gtin8', 'isbn13'];

/** The payload keys a GTIN-family assertion is stored under (`redact.ts`). */
const GTIN_PAYLOAD_KEYS = ['gtin', 'ean', 'upc', 'isbn'] as const;

export async function runReferenceProductsPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const keyset: SQL | undefined = context.cursor === null ? undefined : gt(catalogSourceObjects.id, context.cursor);

  // Rule 1, as the page predicate: an object is examined only while its
  // source's ACTIVE policy grants `seed_catalog` (and the `may_store` it
  // implies) and the source is in a status whose rights resolve at all.
  const rows: ObjectRow[] = await db
    .select({
      id: catalogSourceObjects.id,
      currentSourceRecordId: catalogSourceObjects.currentSourceRecordId,
      lastMatchDecisionId: catalogSourceObjects.lastMatchDecisionId,
    })
    .from(catalogSourceObjects)
    .innerJoin(catalogSourcePolicies, and(
      eq(catalogSourcePolicies.sourceId, catalogSourceObjects.sourceId),
      eq(catalogSourcePolicies.status, 'active'),
      eq(catalogSourcePolicies.maySeedCatalog, true),
      eq(catalogSourcePolicies.mayStore, true),
    ))
    .innerJoin(catalogSourceConfigs, and(
      eq(catalogSourceConfigs.sourceId, catalogSourceObjects.sourceId),
      inArray(catalogSourceConfigs.status, [...CATALOG_SOURCE_DISPLAYABLE_STATUSES]),
    ))
    .where(and(eq(catalogSourceObjects.state, 'unmatched'), keyset))
    .orderBy(asc(catalogSourceObjects.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'source_object', sourceObjectId: row.id }),
    (row) => decideObject(context, row),
  );
  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

async function decideObject(context: StageContext, object: ObjectRow): Promise<SubjectVerdict> {
  const db = getDb();

  // Rule 2. `unmatched` carries a decision by `catalog_source_objects`' own
  // shape CHECK; reading it anyway costs one row and keeps the verdict honest.
  const decision = object.lastMatchDecisionId === null ? undefined : await findMatchDecisionById(db, object.lastMatchDecisionId);
  if (decision === undefined) {
    return { reasonCode: 'awaiting_match_decision', detail: `object ${object.id} has no match decision yet` };
  }
  if (decision.outcome === 'manual_review') {
    return { reasonCode: 'blocked_by_decision', detail: `object ${object.id}: manual_review` };
  }
  if (decision.outcome !== 'create_new') {
    return { reasonCode: 'awaiting_match_decision', detail: `object ${object.id}: ${decision.outcome} awaiting attachment` };
  }

  const observation = object.currentSourceRecordId === null ? undefined : await findSourceRecordById(db, object.currentSourceRecordId);
  const payload = (observation?.payload ?? {}) as Readonly<Record<string, unknown>>;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const gtin = readGtin(payload);

  // Rule 3.
  if (observation === undefined || gtin === undefined || title === '') {
    return {
      reasonCode: 'reference_no_identifier',
      detail: `object ${object.id} asserts no valid GTIN${title === '' ? ' and no title' : ''}`,
    };
  }

  const reused = await previousProductFor(context, object.id);
  if (reused === undefined) {
    // Rule 4.
    const owner = await findCanonicalProductByIdentifier(gtin.scheme, gtin.value);
    if (owner !== undefined) {
      const ownerId = 'productId' in owner ? owner.productId : owner.conflictOwnerId;
      return {
        reasonCode: 'identifier_already_owned',
        detail: `GTIN ${gtin.value} is owned by product ${ownerId}; the object attaches on source_readvance`,
      };
    }
  }

  const description = typeof payload.description === 'string' && payload.description.trim() !== '' ? payload.description.trim() : undefined;
  const product =
    reused === undefined
      ? await context.writer.createDraftProduct({
          // The reference record's NAME. A draft until `reference_promotion`
          // finds something to compare it on (ADR 0014 D3).
          name: title,
          slug: `${slugFromName(title) ?? 'product'}-${gtin.value}`,
          ...(description === undefined ? {} : { description }),
          categoryId: null,
          // One trade item per GTIN: no option axes, so the default variant
          // the product is minted with IS the variant the GTIN identifies.
          variantDefiningAttributeKeys: [],
          actorOxyUserId: context.actorOxyUserId,
        })
      : { id: reused, persisted: false };

  const variant = await context.writer.createProductVariant({
    productId: product.id,
    name: null,
    options: [],
    actorOxyUserId: context.actorOxyUserId,
  });

  const assigned = await context.writer.assignVariantIdentifier({
    variantId: variant.id,
    scheme: gtin.scheme,
    rawValue: gtin.value,
    sourceRecordId: observation.id,
  });

  const canonicalIds = isDryRunId(product.id)
    ? {}
    : {
        canonicalProductId: product.id,
        ...(isDryRunId(variant.id) ? {} : { canonicalVariantId: variant.id }),
      };

  if (assigned.outcome === 'disputed') {
    // Another variant took the GTIN between the read above and this write.
    // The assertion is stored `disputed` and moved nothing (ADR 0002 D14);
    // the product stays a draft for #59 to merge or suppress.
    return {
      reasonCode: 'identifier_disputed',
      detail: `GTIN ${gtin.value} is disputed; product ${product.id} holds it only as a disputed assertion`,
      ...canonicalIds,
    };
  }

  return {
    reasonCode: 'reference_product_minted',
    detail: `product ${product.id} for GTIN ${gtin.value}${reused === undefined ? '' : ' (reused from a previous run)'}`,
    ...canonicalIds,
  };
}

/** The first stored GTIN-family assertion whose check digit validates. */
function readGtin(payload: Readonly<Record<string, unknown>>): { scheme: IdentifierScheme; value: string } | undefined {
  for (const key of GTIN_PAYLOAD_KEYS) {
    const raw = payload[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    const scheme = GTIN_SCHEMES.find((candidate) => normalizeIdentifier(candidate, value).kind !== 'invalid');
    if (scheme !== undefined) return { scheme, value };
  }
  return undefined;
}

/**
 * The product a previous run of this stage minted for this object, if it still
 * exists — `provisional-products.ts`' reasoning: a record naming a product an
 * operator has since merged or suppressed must not send the stage attaching an
 * identifier to a row that has moved on.
 */
async function previousProductFor(context: StageContext, sourceObjectId: string): Promise<string | undefined> {
  const record = await findBackfillRecord({
    mappingVersion: context.mappingVersion,
    mode: context.mode,
    stage: context.stage,
    subjectKey: backfillSubjectKey({ kind: 'source_object', sourceObjectId }),
  });
  const productId = record?.canonicalProductId ?? undefined;
  if (productId === undefined) return undefined;
  const product = await findCanonicalProductById(getDb(), productId);
  return product === undefined || product.status === 'merged' ? undefined : product.id;
}
