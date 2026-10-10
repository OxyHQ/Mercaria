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

import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { IdentifierScheme } from '@mercaria/shared-types';
import { CATALOG_SOURCE_DISPLAYABLE_STATUSES } from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
} from '../../../db/schema/ingestion.js';
import { findSourceRecordById } from '../../../db/canonical/provenanceRepository.js';
import { findMatchDecisionById } from '../../../db/matching/matchDecisionRepository.js';
import { findCanonicalProductById } from '../../../db/canonical/canonicalProductRepository.js';
import { findProductOfSourceGroup } from '../../../db/canonical/canonicalVariantRepository.js';
import { normalizeAttributeKey } from '../../canonical/variant-signature.js';
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
  readonly sourceId: string;
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
  const keyset: SQL | undefined =
    context.cursor === null ? undefined : gt(catalogSourceObjects.id, context.cursor);

  // Rule 1, as the page predicate: an object is examined only while its
  // source's ACTIVE policy grants `seed_catalog` (and the `may_store` it
  // implies) and the source is in a status whose rights resolve at all.
  const rows: ObjectRow[] = await db
    .select({
      id: catalogSourceObjects.id,
      sourceId: catalogSourceObjects.sourceId,
      currentSourceRecordId: catalogSourceObjects.currentSourceRecordId,
      lastMatchDecisionId: catalogSourceObjects.lastMatchDecisionId,
    })
    .from(catalogSourceObjects)
    .innerJoin(
      catalogSourcePolicies,
      and(
        eq(catalogSourcePolicies.sourceId, catalogSourceObjects.sourceId),
        eq(catalogSourcePolicies.status, 'active'),
        eq(catalogSourcePolicies.maySeedCatalog, true),
        eq(catalogSourcePolicies.mayStore, true),
      ),
    )
    .innerJoin(
      catalogSourceConfigs,
      and(
        eq(catalogSourceConfigs.sourceId, catalogSourceObjects.sourceId),
        inArray(catalogSourceConfigs.status, [...CATALOG_SOURCE_DISPLAYABLE_STATUSES]),
      ),
    )
    .where(and(inArray(catalogSourceObjects.state, ['unmatched', 'review_required']), keyset))
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

  // Rule 2. `unmatched` and `review_required` carry a decision by
  // `catalog_source_objects`' own shape CHECK; reading it anyway costs one row
  // and keeps the verdict honest.
  const decision =
    object.lastMatchDecisionId === null
      ? undefined
      : await findMatchDecisionById(db, object.lastMatchDecisionId);
  if (decision === undefined) {
    return {
      reasonCode: 'awaiting_match_decision',
      detail: `object ${object.id} has no match decision yet`,
    };
  }
  if (decision.outcome === 'automatic_match') {
    return {
      reasonCode: 'awaiting_match_decision',
      detail: `object ${object.id}: automatic_match awaiting attachment`,
    };
  }

  const observation =
    object.currentSourceRecordId === null
      ? undefined
      : await findSourceRecordById(db, object.currentSourceRecordId);
  const payload = (observation?.payload ?? {}) as Readonly<Record<string, unknown>>;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const gtin = readGtin(payload);
  const groupKey =
    typeof payload.productGroupKey === 'string' && payload.productGroupKey.trim() !== ''
      ? payload.productGroupKey.trim()
      : undefined;

  // Rule 3: a GTIN that validates, or the source's own product key, or nothing.
  if (observation === undefined || title === '' || (gtin === undefined && groupKey === undefined)) {
    return {
      reasonCode: 'reference_no_identifier',
      detail: `object ${object.id} asserts no valid GTIN and no source product key${title === '' ? ', and no title' : ''}`,
    };
  }
  if (gtin === undefined && groupKey !== undefined) {
    return decideAnchored(context, object, observation.id, payload, title, groupKey);
  }
  if (decision.outcome === 'manual_review') {
    return { reasonCode: 'blocked_by_decision', detail: `object ${object.id}: manual_review` };
  }
  if (gtin === undefined) {
    return {
      reasonCode: 'reference_no_identifier',
      detail: `object ${object.id} asserts no valid GTIN`,
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

  const description = readDescription(payload);
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

  const canonicalIds = canonicalIdsOf(product.id, variant.id);

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

/**
 * ADR 0016 — a product whose identity is the SOURCE'S own product key.
 *
 * A Scryfall card, a GOG game or a Shopify store's product has no GTIN, but the
 * source names it: `productGroupKey`, shared by the records that are variants of
 * one product (a card's foil and non-foil prices). Within its source that key IS
 * identity, so the matcher's heuristic verdict does not decide here — a reprint
 * whose title resembles another printing went to review only because of that
 * resemblance. Joining products ACROSS sources stays #59's curation.
 *
 * 1. The product is the one a sibling of the same key was seeded into, or a
 *    previous run's, or a new DRAFT whose axes are the record's option names.
 * 2. The variant converges on the record's option values.
 * 3. The observation is anchored to both (`connector_declared` source links),
 *    and the object is re-advanced: the matcher's existing-link stage attaches
 *    it and its offer materializes, exactly as for any matched object.
 */
async function decideAnchored(
  context: StageContext,
  object: ObjectRow,
  sourceRecordId: string,
  payload: Readonly<Record<string, unknown>>,
  title: string,
  groupKey: string,
): Promise<SubjectVerdict> {
  const db = getDb();
  const options = readOptions(payload);
  const sibling = await findProductOfSourceGroup(db, {
    sourceId: object.sourceId,
    productGroupKey: groupKey,
    excludeObjectId: object.id,
  });
  const reused = sibling?.productId ?? (await previousProductFor(context, object.id));

  const description = readDescription(payload);
  const product =
    reused === undefined
      ? await context.writer.createDraftProduct({
          name: title,
          // Names repeat across a source (a card reprinted in twenty sets); the
          // key never does, so a digest of it makes the slug unique and stable.
          slug: `${slugFromName(title) ?? 'product'}-${anchorDigest(object.sourceId, groupKey)}`,
          ...(description === undefined ? {} : { description }),
          categoryId: null,
          variantDefiningAttributeKeys: options.map((option) => option.key),
          actorOxyUserId: context.actorOxyUserId,
        })
      : { id: reused, persisted: false };

  const variant = await context.writer.createProductVariant({
    productId: product.id,
    name: null,
    options,
    actorOxyUserId: context.actorOxyUserId,
  });

  await context.writer.anchorSourceObservation({
    productId: product.id,
    variantId: variant.id,
    sourceRecordId,
    matchRule: `source_anchor:${String(context.mappingVersion)}`,
  });
  const readvanced = await context.writer.readvanceSourceObject(object.id);

  return {
    reasonCode: 'reference_product_minted',
    detail:
      `${reused === undefined ? 'product' : 'variant of product'} ${product.id} for source product ${groupKey}` +
      ` (attachment: ${readvanced.outcome})`,
    ...canonicalIdsOf(product.id, variant.id),
  };
}

function canonicalIdsOf(
  productId: string,
  variantId: string,
): { canonicalProductId?: string; canonicalVariantId?: string } {
  if (isDryRunId(productId)) return {};
  return {
    canonicalProductId: productId,
    ...(isDryRunId(variantId) ? {} : { canonicalVariantId: variantId }),
  };
}

function readDescription(payload: Readonly<Record<string, unknown>>): string | undefined {
  return typeof payload.description === 'string' && payload.description.trim() !== ''
    ? payload.description.trim()
    : undefined;
}

/** The record's option values (`redact.ts` stores them as `attributes`), as variant options. */
function readOptions(
  payload: Readonly<Record<string, unknown>>,
): { key: string; value: string; position: number }[] {
  const attributes = payload.attributes;
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) return [];
  return Object.entries(attributes as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
    )
    .map(([key, value], position) => ({
      key: normalizeAttributeKey(key),
      value: value.trim(),
      position,
    }));
}

/** Ten hex digits of sha-256 over (source, key) — the slug suffix of an anchored product. */
function anchorDigest(sourceId: string, groupKey: string): string {
  return createHash('sha256').update(`${sourceId}:${groupKey}`).digest('hex').slice(0, 10);
}

/** The first stored GTIN-family assertion whose check digit validates. */
function readGtin(
  payload: Readonly<Record<string, unknown>>,
): { scheme: IdentifierScheme; value: string } | undefined {
  for (const key of GTIN_PAYLOAD_KEYS) {
    const raw = payload[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    const scheme = GTIN_SCHEMES.find(
      (candidate) => normalizeIdentifier(candidate, value).kind !== 'invalid',
    );
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
async function previousProductFor(
  context: StageContext,
  sourceObjectId: string,
): Promise<string | undefined> {
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
