/**
 * The operator CORRECTIONS that are not a merge or a split (#59 operator
 * actions 1, 3, 6, 7 and 9).
 *
 * Each one changes exactly one fact and writes exactly one revision. What they
 * share is the shape that makes a correction safe: nothing is deleted, the
 * SOURCE values are all retained, and the change is recorded with an actor and a
 * reason before anybody has to remember to.
 *
 * ## The two actions that live elsewhere, and why
 *
 * Action 8 (verify, reject, expire or revoke a relationship) is #55's, and is
 * reached through `/internal/commerce-graph/relationships/:id/*` — it has its own
 * evidence gate, its own four-eyes device and its own append-only review table,
 * and a second implementation here would be a second answer to "is this badge
 * earned". #59's contribution is the queue item that surfaces the candidate and
 * the revision that records the operator closed it.
 *
 * Action 10 (undo through a compensating correction) is `revision.ts`, because
 * what it produces is a revision — the graph change that reverses an act is one
 * of the acts here, or a split.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type {
  CatalogSuppressibleType,
  CatalogSuppressionReason,
  CurationSubjectType,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  findOpenSuppression,
  insertSuppression,
  liftSuppression,
  listSuppressionsForEntity,
} from '../../db/curation/curationRepository.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariants,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import { offers } from '../../db/schema/offers.js';
import { CURATED_ENTITIES } from './entity-registry.js';
import { recordRevision } from './revision.js';

// ── Action 6: reassign an identifier, with conflict validation ─────────────

export interface ReassignIdentifierInput {
  readonly identifierId: string;
  /** The variant or product the identifier should belong to. */
  readonly targetProductId?: string | null;
  readonly targetVariantId?: string | null;
  readonly reason: string;
  readonly actorOxyUserId: string;
}

/**
 * Move an identifier assertion to a different entity (#59 operator action 6).
 *
 * ## The values never move; the OWNER does
 *
 * `product_identifiers_values_immutable` permits exactly two updates — a status
 * transition and an owner change — and this is the second (ADR 0002 D14). A
 * wrong VALUE is corrected by retiring the row and inserting a successor that
 * names it; a wrong OWNER is this, because the assertion itself was right and
 * only the thing it was attached to was not.
 *
 * ## The conflict validation the issue asks for is the collision gate itself
 *
 * `product_identifiers_canonical_active_key` holds one ACTIVE owner per GTIN,
 * so an identifier moved onto an entity that already asserts it is refused by
 * Postgres. This function READS that first so the operator gets a sentence
 * naming the incumbent instead of a constraint violation — the constraint stays
 * the guarantee, and the read is the message.
 */
export async function reassignIdentifier(input: ReassignIdentifierInput): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(productIdentifiers)
    .where(eq(productIdentifiers.id, input.identifierId))
    .limit(1);
  const identifier = rows[0];
  if (!identifier) throw notFound(`No product identifier ${input.identifierId}.`);
  if (identifier.status !== 'active' && identifier.status !== 'disputed') {
    throw conflict(
      `Identifier ${input.identifierId} is ${identifier.status}; only a live assertion can be reassigned.`,
    );
  }

  const targetProductId = input.targetProductId ?? null;
  const targetVariantId = input.targetVariantId ?? null;
  if ((targetProductId === null) === (targetVariantId === null)) {
    throw validationError(
      'An identifier belongs to exactly one grain: name a product OR a variant, never both and ' +
        'never neither (ADR 0002 D14).',
    );
  }
  if (targetProductId !== null && identifier.productId === null) {
    throw validationError(
      'This identifier is asserted at the VARIANT grain and cannot be moved to a product; the ' +
        "scheme's grain is the scheme's, not the caller's.",
    );
  }
  if (targetVariantId !== null && identifier.variantId === null) {
    throw validationError(
      'This identifier is asserted at the PRODUCT grain and cannot be moved to a variant.',
    );
  }

  const targetTable = targetVariantId !== null ? canonicalVariants : canonicalProducts;
  const targetId = targetVariantId ?? targetProductId;
  const target = await db
    .select({ id: sql<string>`id` })
    .from(targetTable)
    .where(sql`id = ${targetId}`)
    .limit(1);
  if (!target[0]) throw notFound(`No entity ${targetId ?? '(none)'} to reassign the identifier to.`);

  // The collision READ. It answers with the incumbent's id, which is what an
  // operator needs to decide whether they are correcting the wrong row.
  if (identifier.canonicalScheme && identifier.canonicalValue) {
    const incumbent = await db
      .select({ id: productIdentifiers.id, productId: productIdentifiers.productId, variantId: productIdentifiers.variantId })
      .from(productIdentifiers)
      .where(
        and(
          eq(productIdentifiers.canonicalScheme, identifier.canonicalScheme),
          eq(productIdentifiers.canonicalValue, identifier.canonicalValue),
          eq(productIdentifiers.status, 'active'),
          ne(productIdentifiers.id, identifier.id),
        ),
      )
      .limit(1);
    const held = incumbent[0];
    if (held && (held.productId === targetProductId || held.variantId === targetVariantId)) {
      throw conflict(
        `Identifier ${identifier.canonicalScheme}:${identifier.canonicalValue} is already asserted ` +
          `for that entity by ${held.id}; retire one of the two before reassigning.`,
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(productIdentifiers)
      .set(
        targetVariantId !== null
          ? { variantId: targetVariantId, note: input.reason }
          : { productId: targetProductId, note: input.reason },
      )
      .where(eq(productIdentifiers.id, identifier.id));

    await recordRevision(
      {
        entityType: 'product_identifier',
        entityId: identifier.id,
        action: 'reassign_identifier',
        actorKind: 'operator',
        actorOxyUserId: input.actorOxyUserId,
        reason: input.reason,
        before: { productId: identifier.productId, variantId: identifier.variantId },
        after: { productId: targetProductId, variantId: targetVariantId },
      },
      tx,
    );
  });
}

// ── Action 7: change the SELECTED value, keeping every source value ────────

export interface SelectAttributeValueInput {
  readonly valueId: string;
  readonly reason: string;
  readonly actorOxyUserId: string;
}

/**
 * Choose which of several disagreeing source values is the one Mercaria shows
 * (#59 operator action 7).
 *
 * ## Every source value SURVIVES, and that is the whole design
 *
 * `canonical_attribute_values` holds one row per (entity, key, observation,
 * slot). Selecting one moves its `selection_state` to `selected` and moves the
 * others in the same SLOT to `superseded` — it does not delete them, it does not
 * edit them, and the row that was chosen still names the observation that
 * asserted it. So "retaining all source values" is not a promise this function
 * keeps; it is a shape it cannot break.
 *
 * ## The field is PINNED afterwards
 *
 * ADR 0002 D16: an operator override adds the field name to the entity's
 * `pinned_fields`, which ingestion respects on every subsequent apply. Without
 * it the next crawl re-selects whatever the source says and the correction is
 * silently undone — the failure that makes operators stop trusting the tool.
 */
export async function selectAttributeValue(input: SelectAttributeValueInput): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(canonicalAttributeValues)
    .where(eq(canonicalAttributeValues.id, input.valueId))
    .limit(1);
  const value = rows[0];
  if (!value) throw notFound(`No canonical attribute value ${input.valueId}.`);
  if (value.normalizationState !== 'normalized') {
    throw conflict(
      `Value ${input.valueId} is ${value.normalizationState}; only a NORMALIZED value may be the ` +
        'one shown, and the CHECK refuses anything else.',
    );
  }

  await db.transaction(async (tx) => {
    const sameSlot = value.productId
      ? and(
          eq(canonicalAttributeValues.productId, value.productId),
          eq(canonicalAttributeValues.attributeKey, value.attributeKey),
          eq(canonicalAttributeValues.valueSlot, value.valueSlot),
          ne(canonicalAttributeValues.id, value.id),
        )
      : and(
          eq(canonicalAttributeValues.variantId, value.variantId ?? ''),
          eq(canonicalAttributeValues.attributeKey, value.attributeKey),
          eq(canonicalAttributeValues.valueSlot, value.valueSlot),
          ne(canonicalAttributeValues.id, value.id),
        );

    // The others FIRST: the partial unique holds at most one selected value per
    // slot, so promoting before demoting would collide with the incumbent.
    await tx
      .update(canonicalAttributeValues)
      .set({ selectionState: 'superseded' })
      .where(and(sameSlot, eq(canonicalAttributeValues.selectionState, 'selected')));
    await tx
      .update(canonicalAttributeValues)
      .set({ selectionState: 'selected' })
      .where(eq(canonicalAttributeValues.id, value.id));

    // The PIN. `pinned_fields` is a `text[]` of stable KEYS, and the append is
    // idempotent so pinning twice adds nothing.
    const entityType: CurationSubjectType = value.productId ? 'canonical_product' : 'canonical_variant';
    const definition = CURATED_ENTITIES[entityType];
    const entityId = value.productId ?? value.variantId;
    if (entityId) {
      await tx.execute(
        sql`update ${definition.table}
            set pinned_fields = (
              select array_agg(distinct field) from unnest(pinned_fields || ${[value.attributeKey]}::text[]) as field
            ), updated_at = now()
            where id = ${entityId}`,
      );
      await recordRevision(
        {
          entityType,
          entityId,
          action: 'correct',
          actorKind: 'operator',
          actorOxyUserId: input.actorOxyUserId,
          reason: input.reason,
          note: `selected ${value.attributeKey} and pinned it against source re-application`,
          sourceRecordId: value.sourceRecordId,
          before: { selectedValueId: null, attributeKey: value.attributeKey },
          after: { selectedValueId: value.id, attributeKey: value.attributeKey },
        },
        tx,
      );
    }
  });
}

// ── Action 9: suppress an entity or an offer, keeping every piece of evidence ─

export interface SuppressInput {
  readonly entityType: CatalogSuppressibleType;
  readonly entityId: string;
  readonly reason: CatalogSuppressionReason;
  readonly note: string | null;
  readonly actorOxyUserId: string;
}

/**
 * Hide something from public discovery without deleting anything (#59 operator
 * action 9).
 *
 * The register row and the entity's own `status = 'suppressed'` are two
 * different facts and both are written: the status is what a public query
 * filters on, and a status alone cannot say whether a person decided it or a bug
 * did. An OFFER has no `suppressed` status — its lifecycle is `active | retired`
 * — so an offer suppression is the register row plus a retirement, which is the
 * offer domain's own word for "not current".
 */
export async function suppressEntity(input: SuppressInput): Promise<void> {
  const db = getDb();
  const existing = await findOpenSuppression(input.entityType, input.entityId, 'public_discovery', db);
  if (existing) {
    throw conflict(
      `${input.entityType} ${input.entityId} is already suppressed (${existing.id}); lift that one first.`,
    );
  }

  await db.transaction(async (tx) => {
    const record = await insertSuppression(
      {
        entityType: input.entityType,
        entityId: input.entityId,
        scope: 'public_discovery',
        reason: input.reason,
        note: input.note,
        suppressedByOxyUserId: input.actorOxyUserId,
      },
      tx,
    );

    if (input.entityType === 'offer') {
      await tx
        .update(offers)
        .set({ status: 'retired', retirementReason: 'operator', retiredAt: new Date() })
        .where(and(eq(offers.id, input.entityId), eq(offers.status, 'active')));
    } else {
      const definition = CURATED_ENTITIES[input.entityType];
      await tx
        .update(definition.table)
        .set({ status: 'suppressed' })
        .where(and(eq(definition.idColumn, input.entityId), ne(definition.statusColumn, 'merged')));
    }

    await recordRevision(
      {
        entityType: input.entityType === 'offer' ? 'offer' : input.entityType,
        entityId: input.entityId,
        action: 'suppress',
        actorKind: 'operator',
        actorOxyUserId: input.actorOxyUserId,
        reason: `${input.reason}${input.note ? `: ${input.note}` : ''}`,
        note: `suppression ${record.id}`,
        after: { scope: 'public_discovery', reason: input.reason },
      },
      tx,
    );
  });
}

export interface LiftSuppressionInput {
  readonly entityType: CatalogSuppressibleType;
  readonly entityId: string;
  readonly reason: string;
  readonly actorOxyUserId: string;
}

/**
 * Bring something back.
 *
 * The entity's status returns to `active` — never to whatever it was before,
 * because a suppression does not record that and guessing would be worse than
 * the honest default. An OFFER is deliberately NOT un-retired: retirement is
 * one-way in the offer domain (a fresh observation creates a new active offer),
 * and reviving one here would be this domain writing a rule the offer domain
 * owns.
 */
export async function liftEntitySuppression(input: LiftSuppressionInput): Promise<void> {
  const db = getDb();
  const open = await findOpenSuppression(input.entityType, input.entityId, 'public_discovery', db);
  if (!open) throw notFound(`${input.entityType} ${input.entityId} is not suppressed.`);

  await db.transaction(async (tx) => {
    await liftSuppression(open.id, input.actorOxyUserId, input.reason, tx);
    if (input.entityType !== 'offer') {
      const definition = CURATED_ENTITIES[input.entityType];
      await tx
        .update(definition.table)
        .set({ status: 'active' })
        .where(
          and(eq(definition.idColumn, input.entityId), eq(definition.statusColumn, 'suppressed')),
        );
    }
    await recordRevision(
      {
        entityType: input.entityType === 'offer' ? 'offer' : input.entityType,
        entityId: input.entityId,
        action: 'unsuppress',
        actorKind: 'operator',
        actorOxyUserId: input.actorOxyUserId,
        reason: input.reason,
        note: `suppression ${open.id} lifted`,
        before: { scope: 'public_discovery', reason: open.reason },
      },
      tx,
    );
  });
}

/** Every suppression ever applied to one entity — the operator trace's own read. */
export async function suppressionHistory(entityType: CatalogSuppressibleType, entityId: string) {
  return listSuppressionsForEntity(entityType, entityId, getDb());
}
