/**
 * Assigning, resolving and correcting product identifiers (#56 identifiers 1–6,
 * ADR 0002 D14).
 *
 * ## The one behaviour everything else is arranged around
 *
 * **A conflicting valid identifier BLOCKS the automatic path and enters review.**
 * When a source asserts a GTIN that a different canonical entity already owns,
 * this service does not move the identifier, does not merge the two entities and
 * does not pick a winner by recency, confidence or source rank. It writes the
 * incoming assertion as `disputed`, pointing at the row it collides with, and
 * returns that outcome to the caller. The newcomer never steals the identifier
 * (#56 identifier rule 5, acceptance 3).
 *
 * That is a service rule with a database floor underneath it: the partial unique
 * `product_identifiers_canonical_active_key` makes two ACTIVE owners of one GTIN
 * unrepresentable, so a future writer that forgets this rule fails its INSERT
 * rather than silently overwriting an owner.
 *
 * ## And the two refusals that make an accidental identity impossible
 *
 * - A scheme may only be written at the grain its registry entry names, so a
 *   GTIN cannot be attached to a product and compared against a variant's.
 * - A brand-scoped scheme (`mpn`, `brand_model`) is refused unless the entity it
 *   binds to actually resolves to a brand. An MPN with no manufacturer is not a
 *   weaker identifier; it is not an identifier (#56 identifier rule 4).
 */

import type {
  IdentifierGrain,
  IdentifierResolution,
  IdentifierScheme,
  IdentifierStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveCanonicalOwner,
  findActiveAssertionsByValue,
  findDisputesForCanonicalValue,
  findIdentifierById,
  insertIdentifierAssertion,
  listIdentifiersForProduct,
  listIdentifiersForVariant,
  retireIdentifier,
  type ProductIdentifierRow,
} from '../../db/canonical/productIdentifierRepository.js';
import { findCanonicalProductById } from '../../db/canonical/canonicalProductRepository.js';
import { findCanonicalVariantById } from '../../db/canonical/canonicalVariantRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { normalizeIdentifier, type IdentifierRejection } from './identifiers.js';

/** Where an assertion is being attached. Exactly one grain, always. */
export type IdentifierTarget =
  | { readonly kind: 'product'; readonly id: string }
  | { readonly kind: 'variant'; readonly id: string };

export interface AssignIdentifierInput {
  target: IdentifierTarget;
  scheme: IdentifierScheme;
  /** Exactly what the source said; stored verbatim and never edited. */
  rawValue: string;
  /** The observation that asserted it, when it came from one. */
  sourceRecordId?: string;
  assignedByOxyUserId?: string;
  note?: string;
}

export type AssignIdentifierResult =
  /** The assertion is the active owner of its value. */
  | { readonly outcome: 'assigned'; readonly identifier: ProductIdentifierRow }
  /** The entity already carried this exact assertion; nothing was written. */
  | { readonly outcome: 'unchanged'; readonly identifier: ProductIdentifierRow }
  /**
   * A different entity actively owns the value. The assertion is stored
   * `disputed` naming that row, and NOTHING about the existing owner moved.
   */
  | {
      readonly outcome: 'disputed';
      readonly identifier: ProductIdentifierRow;
      readonly conflictsWith: ProductIdentifierRow;
    }
  /** The value is not the identifier it claimed to be; nothing was stored. */
  | { readonly outcome: 'invalid'; readonly reason: IdentifierRejection };

/** Which canonical entity an assertion row belongs to, as a grain plus id. */
function grainOf(row: ProductIdentifierRow): { grain: IdentifierGrain; id: string } {
  if (row.variantId !== null) return { grain: 'variant', id: row.variantId };
  if (row.productId !== null) return { grain: 'product', id: row.productId };
  // The `product_identifiers_grain_check` CHECK makes this unreachable from any
  // row the database accepted; throwing rather than defaulting means a schema
  // change that removed the CHECK surfaces here instead of silently picking one.
  throw new Error(`product_identifiers ${row.id} has neither a product nor a variant.`);
}

/**
 * The brand an assertion is scoped to, resolved through the entity it binds to.
 *
 * A variant's brand is its PRODUCT's — the product's own `brand_id`, which is
 * the authority for identifier scoping (see `canonicalCatalog.ts`), never the
 * family's.
 */
async function resolveBrandScope(
  db: DatabaseOrTransaction,
  target: IdentifierTarget,
): Promise<string | null> {
  if (target.kind === 'product') {
    const product = await findCanonicalProductById(db, target.id);
    if (!product) throw notFound(`Canonical product ${target.id} does not exist.`);
    return product.brandId;
  }
  const variant = await findCanonicalVariantById(db, target.id);
  if (!variant) throw notFound(`Canonical variant ${target.id} does not exist.`);
  const product = await findCanonicalProductById(db, variant.productId);
  if (!product) throw notFound(`Canonical product ${variant.productId} does not exist.`);
  return product.brandId;
}

/**
 * Assert one identifier for one canonical entity.
 *
 * One transaction: the collision read and the write that depends on it must not
 * be separated, or two concurrent assertions of one GTIN both read "unowned" and
 * the second is refused by the unique index with an error nobody can act on
 * instead of a `disputed` row somebody can.
 */
export async function assignIdentifier(
  input: AssignIdentifierInput,
): Promise<AssignIdentifierResult> {
  const normalization = normalizeIdentifier(input.scheme, input.rawValue);
  if (normalization.kind === 'invalid') return { outcome: 'invalid', reason: normalization.reason };
  const identifier = normalization.identifier;

  if (identifier.grain !== input.target.kind) {
    throw validationError(
      `Scheme '${input.scheme}' identifies a ${identifier.grain}; it cannot be attached to a ${input.target.kind}.`,
    );
  }

  return getDb().transaction(async (tx) => {
    if (identifier.requiresBrandScope) {
      const brandId = await resolveBrandScope(tx, input.target);
      if (brandId === null) {
        throw validationError(
          `Scheme '${input.scheme}' is scoped to a brand or manufacturer, and ${input.target.kind} ${input.target.id} resolves to no brand. ` +
            'An unscoped part number identifies nothing.',
        );
      }
    }

    // The collision gate. Only a globally unique scheme has a canonical value,
    // so MPN and brand_model reach the plain insert below and collide with
    // nothing — which is correct, and is why they get no database uniqueness.
    if (identifier.canonicalScheme !== undefined && identifier.canonicalValue !== undefined) {
      const owner = await findActiveCanonicalOwner(
        tx,
        identifier.canonicalScheme,
        identifier.canonicalValue,
      );
      if (owner) {
        const ownerGrain = grainOf(owner);
        const sameEntity =
          ownerGrain.grain === input.target.kind && ownerGrain.id === input.target.id;
        if (!sameEntity) {
          const disputed = await insertIdentifierAssertion(tx, {
            ...(input.target.kind === 'product'
              ? { productId: input.target.id }
              : { variantId: input.target.id }),
            scheme: identifier.scheme,
            rawValue: input.rawValue.trim(),
            normalizedValue: identifier.normalizedValue,
            canonicalScheme: identifier.canonicalScheme,
            canonicalValue: identifier.canonicalValue,
            status: 'disputed',
            conflictsWithIdentifierId: owner.id,
            ...(input.sourceRecordId === undefined
              ? {}
              : { sourceRecordId: input.sourceRecordId }),
            ...(input.assignedByOxyUserId === undefined
              ? {}
              : { assignedByOxyUserId: input.assignedByOxyUserId }),
            ...(input.note === undefined ? {} : { note: input.note }),
          });
          if (!disputed) throw new Error('A disputed identifier insert returned no row.');
          return { outcome: 'disputed', identifier: disputed, conflictsWith: owner };
        }
        // The same entity re-asserting what it already owns.
        return { outcome: 'unchanged', identifier: owner };
      }
    }

    const inserted = await insertIdentifierAssertion(tx, {
      ...(input.target.kind === 'product'
        ? { productId: input.target.id }
        : { variantId: input.target.id }),
      scheme: identifier.scheme,
      rawValue: input.rawValue.trim(),
      normalizedValue: identifier.normalizedValue,
      ...(identifier.canonicalScheme === undefined
        ? {}
        : { canonicalScheme: identifier.canonicalScheme }),
      ...(identifier.canonicalValue === undefined
        ? {}
        : { canonicalValue: identifier.canonicalValue }),
      ...(input.sourceRecordId === undefined ? {} : { sourceRecordId: input.sourceRecordId }),
      ...(input.assignedByOxyUserId === undefined
        ? {}
        : { assignedByOxyUserId: input.assignedByOxyUserId }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });

    if (inserted) return { outcome: 'assigned', identifier: inserted };

    // The per-entity active unique absorbed it: this entity already carries the
    // assertion. A no-op, and the existing row is the answer.
    const existing = await findActiveAssertionsByValue(
      tx,
      identifier.scheme,
      identifier.normalizedValue,
    );
    const mine = existing.find((row) => {
      const rowGrain = grainOf(row);
      return rowGrain.grain === input.target.kind && rowGrain.id === input.target.id;
    });
    if (!mine) {
      throw new Error(
        `Identifier ${identifier.scheme}:${identifier.normalizedValue} was neither inserted nor found for ${input.target.kind} ${input.target.id}.`,
      );
    }
    return { outcome: 'unchanged', identifier: mine };
  });
}

/**
 * Look one identifier up.
 *
 * `conflict` is a first-class answer, not an error: an identifier under dispute
 * has one active owner AND at least one contesting assertion, and a caller that
 * cannot tell that apart from a clean resolution will happily attach an offer to
 * a product review has not confirmed.
 */
export async function resolveIdentifier(
  scheme: IdentifierScheme,
  rawValue: string,
): Promise<IdentifierResolution> {
  const normalization = normalizeIdentifier(scheme, rawValue);
  if (normalization.kind === 'invalid') return { kind: 'invalid', reason: normalization.reason };
  const identifier = normalization.identifier;
  const db = getDb();

  if (identifier.canonicalScheme !== undefined && identifier.canonicalValue !== undefined) {
    const owner = await findActiveCanonicalOwner(
      db,
      identifier.canonicalScheme,
      identifier.canonicalValue,
    );
    if (!owner) return { kind: 'none' };
    const ownerGrain = grainOf(owner);
    const disputes = await findDisputesForCanonicalValue(
      db,
      identifier.canonicalScheme,
      identifier.canonicalValue,
    );
    if (disputes.length > 0) {
      return {
        kind: 'conflict',
        grain: ownerGrain.grain,
        ownerId: ownerGrain.id,
        disputedIds: [...new Set(disputes.map((row) => grainOf(row).id))].sort(),
      };
    }
    return { kind: 'resolved', grain: ownerGrain.grain, id: ownerGrain.id };
  }

  // A brand-scoped scheme has no global owner by construction. Several entities
  // may hold the same MPN legitimately, so more than one active assertion is a
  // conflict for the matcher to resolve with brand agreement, not an error.
  const assertions = await findActiveAssertionsByValue(db, scheme, identifier.normalizedValue);
  if (assertions.length === 0) return { kind: 'none' };
  const owners = [...new Set(assertions.map((row) => grainOf(row).id))];
  const first = assertions[0];
  if (!first) return { kind: 'none' };
  const firstGrain = grainOf(first);
  if (owners.length === 1) {
    return { kind: 'resolved', grain: firstGrain.grain, id: firstGrain.id };
  }
  const [ownerId, ...rest] = owners.sort();
  if (ownerId === undefined) return { kind: 'none' };
  return { kind: 'conflict', grain: firstGrain.grain, ownerId, disputedIds: rest };
}

export interface CorrectIdentifierInput {
  identifierId: string;
  /** The value that should have been asserted. Validated like any other. */
  rawValue: string;
  scheme: IdentifierScheme;
  actorOxyUserId: string;
  note?: string;
}

/**
 * Correct a wrong identifier: retire the old row, insert a new one naming it.
 *
 * The old row keeps its values forever — the database refuses to edit them —
 * so "what did this source actually say before somebody fixed it" stays
 * answerable (#56 identifier rule 6). One transaction, because a retirement with
 * no successor and a successor with no retirement are both worse than either
 * half of the change.
 */
export async function correctIdentifier(
  input: CorrectIdentifierInput,
): Promise<{ retired: ProductIdentifierRow; replacement: ProductIdentifierRow }> {
  return getDb().transaction(async (tx) => {
    const existing = await findIdentifierById(tx, input.identifierId);
    if (!existing) throw notFound(`Identifier ${input.identifierId} does not exist.`);
    if (existing.status !== 'active') {
      throw conflict(
        `Identifier ${input.identifierId} is '${existing.status}'; only an active assertion can be corrected.`,
      );
    }

    const normalization = normalizeIdentifier(input.scheme, input.rawValue);
    if (normalization.kind === 'invalid') {
      throw validationError(
        `The replacement value is not a valid ${input.scheme}: ${normalization.reason}.`,
      );
    }
    const identifier = normalization.identifier;
    const grain = grainOf(existing);
    if (identifier.grain !== grain.grain) {
      throw validationError(
        `Scheme '${input.scheme}' identifies a ${identifier.grain}; the corrected row binds to a ${grain.grain}.`,
      );
    }

    const retired = await retireIdentifier(tx, existing.id, 'corrected', input.note);
    if (!retired) {
      throw conflict(`Identifier ${input.identifierId} was already retired by another writer.`);
    }

    const replacement = await insertIdentifierAssertion(tx, {
      ...(grain.grain === 'product' ? { productId: grain.id } : { variantId: grain.id }),
      scheme: identifier.scheme,
      rawValue: input.rawValue.trim(),
      normalizedValue: identifier.normalizedValue,
      ...(identifier.canonicalScheme === undefined
        ? {}
        : { canonicalScheme: identifier.canonicalScheme }),
      ...(identifier.canonicalValue === undefined
        ? {}
        : { canonicalValue: identifier.canonicalValue }),
      supersedesIdentifierId: retired.id,
      assignedByOxyUserId: input.actorOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    if (!replacement) {
      throw conflict(
        `The corrected value is already an active assertion for this ${grain.grain}.`,
      );
    }
    return { retired, replacement };
  });
}

/** Every assertion a variant carries, disputed and retired ones included. */
export async function listVariantIdentifiers(variantId: string): Promise<ProductIdentifierRow[]> {
  return listIdentifiersForVariant(getDb(), variantId);
}

/** Every assertion a product carries, disputed and retired ones included. */
export async function listProductIdentifiers(productId: string): Promise<ProductIdentifierRow[]> {
  return listIdentifiersForProduct(getDb(), productId);
}

/** The identifier statuses a public read surface shows. */
export function isPubliclyVisibleIdentifier(status: IdentifierStatus): boolean {
  return status === 'active';
}
