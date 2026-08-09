/**
 * Canonical variants: creation, option assignment, lookup and merge (#56
 * variant rules 1–7, ADR 0002 D13/D15/D16).
 *
 * ## The axis contract
 *
 * A product DECLARES its option axes (`variant_defining_attribute_keys`), and
 * every variant of that product must supply exactly those keys — no more, no
 * fewer. That is not tidiness; it is what makes the signature well-defined. If
 * one variant could omit an axis, "256 GB" and "256 GB, Black" would hash
 * differently while describing configurations that may be the same thing, and
 * the uniqueness the signature exists to provide would depend on how complete
 * each source happened to be.
 *
 * ## Normalization before hashing
 *
 * An option value is normalized before it enters the signature, and a QUANTITY
 * axis normalizes to its base-unit magnitude. That is what makes "256 GB",
 * "256GB" and "0.256 TB" ONE variant rather than three — the acceptance
 * criterion that one iPhone model with several capacities and colours is one
 * product with canonical variants, rather than one product per feed.
 *
 * ## Merges
 *
 * A variant merge tombstones the loser and repoints its aliases, source links
 * and identifiers at the winner. The loser ROW is never deleted, which is the
 * whole of "merges preserve offer references": anything holding the loser's id —
 * a procurement offer's canonical mapping today, an `offers` row when #57 lands,
 * a native listing link when #57 lands — still resolves, and resolution follows
 * `merged_into_id` to the winner.
 */

import type { CanonicalCatalogStatus } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findCanonicalProductById,
  updateCanonicalProduct,
} from '../../db/canonical/canonicalProductRepository.js';
import {
  countVariantsForProduct,
  findCanonicalVariantById,
  findVariantBySignature,
  findVariantIdsByAttributeValue,
  insertCanonicalVariant,
  insertCanonicalVariantAlias,
  listBundleComponents,
  listVariantAttributes,
  listVariantsForProduct,
  markCanonicalVariantMerged,
  repointCanonicalVariantAliases,
  repointCanonicalVariantSourceLinks,
  replaceBundleComponents,
  replaceVariantAttributes,
  retargetVariantTombstones,
  updateCanonicalVariant,
  type CanonicalVariantAttributeRow,
  type CanonicalVariantRow,
  type VariantAttributeInput,
} from '../../db/canonical/canonicalVariantRepository.js';
import { findActiveAttributeDefinitionsByKeys } from '../../db/attributes/definitionRepository.js';
import { repointVariantIdentifiers } from '../../db/canonical/productIdentifierRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  normalizeAttributeKey,
  normalizeOptionValue,
  variantSignature,
  type VariantOptionAssignment,
} from './variant-signature.js';
import { normalizeQuantity } from './units.js';

/** How many redirect hops resolution tolerates before calling the data corrupt. */
const MAX_MERGE_HOPS = 10;

/** One option assignment as a caller supplies it — display form, unnormalized. */
export interface VariantOptionInput {
  key: string;
  /** The source's own words: "256 GB", "Black Titanium". */
  value: string;
  /** DISPLAY order. Deliberately not an input to the signature. */
  position?: number;
}

/**
 * Normalize one option assignment.
 *
 * A quantity axis (declared through `attribute_definitions`) normalizes to its
 * base-unit magnitude, so unit spellings collapse. Everything else folds case
 * and whitespace and nothing more. A quantity that cannot be parsed keeps the
 * folded text and says so — it is a source fact, not a magnitude to invent.
 */
function normalizeOption(
  option: VariantOptionInput,
  definition: { id: string; version: number } | undefined,
  isQuantity: boolean,
  index: number,
): VariantAttributeInput {
  const attributeKey = normalizeAttributeKey(option.key);
  const displayValue = option.value.trim();

  if (isQuantity) {
    const quantity = normalizeQuantity(displayValue);
    if (
      quantity.state === 'normalized' &&
      quantity.baseMagnitude !== undefined &&
      quantity.baseUnit !== undefined
    ) {
      return {
        attributeKey,
        displayValue,
        normalizedValue: `${quantity.baseMagnitude}${quantity.baseUnit}`,
        normalizedNumber: quantity.baseMagnitude,
        normalizedUnit: quantity.baseUnit,
        normalizationState: 'normalized',
        position: option.position ?? index,
        ...(definition === undefined
          ? {}
          : { attributeDefinitionId: definition.id, definitionVersion: definition.version }),
      };
    }
    return {
      attributeKey,
      displayValue,
      normalizedValue: normalizeOptionValue(displayValue),
      normalizationState: quantity.state,
      position: option.position ?? index,
      ...(definition === undefined
        ? {}
        : { attributeDefinitionId: definition.id, definitionVersion: definition.version }),
    };
  }

  return {
    attributeKey,
    displayValue,
    normalizedValue: normalizeOptionValue(displayValue),
    normalizationState: 'normalized',
    position: option.position ?? index,
    ...(definition === undefined
      ? {}
      : { attributeDefinitionId: definition.id, definitionVersion: definition.version }),
  };
}

/**
 * Normalize a whole option set against the product's declared axes.
 *
 * @throws When the keys do not match the declared axes exactly. Refusing here
 *   rather than storing a partial set is the point: a variant missing an axis
 *   would hash to a signature that means something different from what it says.
 */
async function normalizeOptionSet(
  db: DatabaseOrTransaction,
  declaredAxes: readonly string[],
  options: readonly VariantOptionInput[],
): Promise<VariantAttributeInput[]> {
  const axes = declaredAxes.map(normalizeAttributeKey);
  const supplied = options.map((option) => normalizeAttributeKey(option.key));

  const duplicates = supplied.filter((key, index) => supplied.indexOf(key) !== index);
  if (duplicates.length > 0) {
    throw validationError(
      `A variant carries one value per axis; '${duplicates[0]}' was supplied twice.`,
    );
  }
  const missing = axes.filter((axis) => !supplied.includes(axis));
  const unexpected = supplied.filter((key) => !axes.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw validationError(
      `Variant options must match the product's declared axes exactly. ` +
        `Missing: [${missing.join(', ')}]. Not declared: [${unexpected.join(', ')}].`,
    );
  }

  const definitions = await findActiveAttributeDefinitionsByKeys(db, supplied);
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));

  return options.map((option, index) => {
    const definition = byKey.get(normalizeAttributeKey(option.key));
    return normalizeOption(
      option,
      definition === undefined ? undefined : { id: definition.id, version: definition.version },
      definition?.valueType === 'measurement',
      index,
    );
  });
}

export interface CreateVariantInput {
  productId: string;
  options: VariantOptionInput[];
  /** Display name of the configuration. Optional — the options are the identity. */
  name?: string;
  /** Only where a single default configuration is a meaningful concept. */
  isDefault?: boolean;
  releasedAt?: Date;
  status?: CanonicalCatalogStatus;
  actorOxyUserId?: string;
}

export interface CreateVariantResult {
  variant: CanonicalVariantRow;
  attributes: CanonicalVariantAttributeRow[];
  /** `false` when a variant with this exact option set already existed. */
  created: boolean;
}

/**
 * Mint a variant, or return the existing one carrying the same option set.
 *
 * Converging rather than throwing is deliberate: ingesting the same
 * configuration from a second source is the normal case, and it must produce one
 * variant. The convergence key is the SIGNATURE, so it holds however the two
 * sources ordered or spelled their options.
 */
export async function createVariant(input: CreateVariantInput): Promise<CreateVariantResult> {
  return getDb().transaction(async (tx) => {
    const product = await findCanonicalProductById(tx, input.productId);
    if (!product) throw notFound(`Canonical product ${input.productId} does not exist.`);
    if (product.status === 'merged') {
      throw conflict(
        `Canonical product ${input.productId} is merged into ${String(product.mergedIntoId)}; add the variant to the winner.`,
      );
    }

    const normalized = await normalizeOptionSet(
      tx,
      product.variantDefiningAttributeKeys,
      input.options,
    );
    const signature = variantSignature(
      normalized.map(
        (attribute): VariantOptionAssignment => ({
          key: attribute.attributeKey,
          normalizedValue: attribute.normalizedValue,
        }),
      ),
    );

    const existing = await findVariantBySignature(tx, product.id, signature);
    if (existing) {
      return {
        variant: existing,
        attributes: await listVariantAttributes(tx, existing.id),
        created: false,
      };
    }

    const variant = await insertCanonicalVariant(tx, {
      productId: product.id,
      name: input.name?.trim() ?? null,
      signature,
      isDefault: input.isDefault ?? false,
      releasedAt: input.releasedAt ?? null,
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    const attributes = await replaceVariantAttributes(tx, variant.id, normalized);

    if (input.name !== undefined && input.name.trim().length > 0) {
      await insertCanonicalVariantAlias(tx, {
        variantId: variant.id,
        alias: input.name.trim(),
        kind: 'name_variant',
        ...(input.actorOxyUserId === undefined
          ? {}
          : { createdByOxyUserId: input.actorOxyUserId }),
      });
    }

    await updateCanonicalProduct(tx, product.id, {
      variantCount: await countVariantsForProduct(tx, product.id),
    });

    return { variant, attributes, created: true };
  });
}

/**
 * Replace a variant's option set, recomputing the signature in the same
 * transaction.
 *
 * The two halves cannot be separated: a stored signature that does not describe
 * the stored assignments would sit inside `UNIQUE(product_id, signature)` and
 * make a genuinely different configuration collide with this one.
 */
export async function replaceVariantOptions(
  variantId: string,
  options: VariantOptionInput[],
): Promise<CreateVariantResult> {
  return getDb().transaction(async (tx) => {
    const variant = await findCanonicalVariantById(tx, variantId);
    if (!variant) throw notFound(`Canonical variant ${variantId} does not exist.`);
    if (variant.status === 'merged') {
      throw conflict(`Canonical variant ${variantId} is a merge tombstone; edit the winner.`);
    }
    const product = await findCanonicalProductById(tx, variant.productId);
    if (!product) throw notFound(`Canonical product ${variant.productId} does not exist.`);

    const normalized = await normalizeOptionSet(
      tx,
      product.variantDefiningAttributeKeys,
      options,
    );
    const signature = variantSignature(
      normalized.map(
        (attribute): VariantOptionAssignment => ({
          key: attribute.attributeKey,
          normalizedValue: attribute.normalizedValue,
        }),
      ),
    );

    const collision = await findVariantBySignature(tx, product.id, signature);
    if (collision && collision.id !== variant.id) {
      throw conflict(
        `Variant ${collision.id} of product ${product.id} already carries this option set; ` +
          'a duplicate configuration is a merge, never a second row.',
      );
    }

    const attributes = await replaceVariantAttributes(tx, variant.id, normalized);
    const updated = await updateCanonicalVariant(tx, variant.id, { signature });
    if (!updated) throw new Error(`Canonical variant ${variant.id} vanished mid-transaction.`);
    return { variant: updated, attributes, created: false };
  });
}

/**
 * Guarantee the ≥1-variant invariant (ADR 0002 D13).
 *
 * A product with no meaningful options gets exactly ONE default variant with
 * zero assignments, which gives the whole system one attachment grain: offers,
 * identifiers and native links always target a variant, and no code path
 * branches on "product without variants".
 */
export async function ensureDefaultVariant(productId: string): Promise<CanonicalVariantRow> {
  const existing = await listVariantsForProduct(getDb(), productId);
  const alreadyDefault = existing.find((variant) => variant.isDefault);
  if (alreadyDefault) return alreadyDefault;
  const result = await createVariant({ productId, options: [], isDefault: true });
  return result.variant;
}

/** Follow `merged_into_id` to the live variant. One hop by invariant; bounded anyway. */
export async function resolveVariantRow(
  db: DatabaseOrTransaction,
  row: CanonicalVariantRow,
): Promise<CanonicalVariantRow> {
  let current = row;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (current.status !== 'merged' || !current.mergedIntoId) return current;
    const next = await findCanonicalVariantById(db, current.mergedIntoId);
    if (!next) {
      throw new Error(
        `Canonical variant ${current.id} redirects to missing variant ${current.mergedIntoId}.`,
      );
    }
    current = next;
  }
  throw new Error(`Canonical variant merge chain exceeds ${MAX_MERGE_HOPS} hops from ${row.id}.`);
}

/** The live variant an id resolves to — a tombstone answers with its winner. */
export async function resolveVariant(variantId: string): Promise<CanonicalVariantRow | undefined> {
  const db = getDb();
  const row = await findCanonicalVariantById(db, variantId);
  if (!row) return undefined;
  return resolveVariantRow(db, row);
}

/** Every variant of a product, in creation order. */
export async function listVariants(productId: string): Promise<CanonicalVariantRow[]> {
  return listVariantsForProduct(getDb(), productId);
}

export async function listVariantOptions(
  variantId: string,
): Promise<CanonicalVariantAttributeRow[]> {
  return listVariantAttributes(getDb(), variantId);
}

/**
 * Reverse lookup by option: which variants are 256 GB?
 *
 * The value is normalized the same way a stored assignment is, including the
 * quantity collapse — so a caller may ask in whichever unit it has.
 */
export async function findVariantIdsByOption(
  key: string,
  value: string,
  isQuantity = false,
): Promise<string[]> {
  const attributeKey = normalizeAttributeKey(key);
  const quantity = isQuantity ? normalizeQuantity(value.trim()) : undefined;
  const normalizedValue =
    quantity !== undefined &&
    quantity.state === 'normalized' &&
    quantity.baseMagnitude !== undefined &&
    quantity.baseUnit !== undefined
      ? `${quantity.baseMagnitude}${quantity.baseUnit}`
      : normalizeOptionValue(value.trim());
  return findVariantIdsByAttributeValue(getDb(), attributeKey, normalizedValue);
}

export interface MergeVariantsInput {
  winnerId: string;
  loserId: string;
  /** Merges are operator decisions; the actor is mandatory, not decorative. */
  actorOxyUserId: string;
}

export interface MergeVariantsResult {
  /** `false` when the loser was already merged — the idempotent re-run. */
  merged: boolean;
  winnerId: string;
  loserId: string;
}

/**
 * Merge one variant into another (ADR 0002 D16).
 *
 * The CAS comes FIRST, so a concurrent duplicate merge loses and walks away
 * having written nothing at all — not with half its repoints in.
 */
export async function mergeVariants(input: MergeVariantsInput): Promise<MergeVariantsResult> {
  if (input.winnerId === input.loserId) {
    throw validationError('mergeVariants: a variant cannot be merged into itself.');
  }
  if (input.actorOxyUserId.trim().length === 0) {
    throw validationError('mergeVariants: an actor is required.');
  }

  return getDb().transaction(async (tx) => {
    const loser = await findCanonicalVariantById(tx, input.loserId);
    if (!loser) throw notFound(`Canonical variant ${input.loserId} does not exist.`);
    const winnerRow = await findCanonicalVariantById(tx, input.winnerId);
    if (!winnerRow) throw notFound(`Canonical variant ${input.winnerId} does not exist.`);

    if (loser.status === 'merged') {
      return { merged: false, winnerId: loser.mergedIntoId ?? input.winnerId, loserId: loser.id };
    }
    const winner = await resolveVariantRow(tx, winnerRow);
    if (winner.id === loser.id) {
      throw validationError('mergeVariants: the winner resolves to the loser — refusing a cycle.');
    }

    const stamped = await markCanonicalVariantMerged(tx, loser.id, winner.id);
    if (!stamped) return { merged: false, winnerId: winner.id, loserId: loser.id };

    await repointCanonicalVariantAliases(tx, loser.id, winner.id);
    await repointCanonicalVariantSourceLinks(tx, loser.id, winner.id);
    await repointVariantIdentifiers(tx, loser.id, winner.id);
    await retargetVariantTombstones(tx, loser.id, winner.id);

    if (loser.name !== null && loser.name.trim().length > 0) {
      await insertCanonicalVariantAlias(tx, {
        variantId: winner.id,
        alias: loser.name,
        kind: 'former_name',
        createdByOxyUserId: input.actorOxyUserId,
      });
    }

    // The loser's assignments go with it: the tombstone keeps its identity while
    // its option set stops competing for the winner's product signature space.
    await updateCanonicalVariant(tx, winner.id, { lastReviewedAt: new Date() });
    await updateCanonicalProduct(tx, loser.productId, {
      variantCount: await countVariantsForProduct(tx, loser.productId),
    });
    if (winner.productId !== loser.productId) {
      await updateCanonicalProduct(tx, winner.productId, {
        variantCount: await countVariantsForProduct(tx, winner.productId),
      });
    }

    return { merged: true, winnerId: winner.id, loserId: loser.id };
  });
}

export interface SetBundleComponentsInput {
  bundleVariantId: string;
  components: { variantId: string; quantity: number }[];
}

/**
 * Declare what a bundle variant contains (ADR 0002 D15).
 *
 * Component references are RESTRICT at the database, so a variant a bundle names
 * cannot vanish — the bundle would otherwise claim to contain something with no
 * identity.
 */
export async function setBundleComponents(
  input: SetBundleComponentsInput,
): Promise<{ componentVariantId: string; quantity: number }[]> {
  if (input.components.some((component) => component.quantity <= 0)) {
    throw validationError('A bundle component quantity must be positive.');
  }
  if (input.components.some((component) => component.variantId === input.bundleVariantId)) {
    throw validationError('A bundle cannot contain itself.');
  }

  return getDb().transaction(async (tx) => {
    const bundle = await findCanonicalVariantById(tx, input.bundleVariantId);
    if (!bundle) throw notFound(`Canonical variant ${input.bundleVariantId} does not exist.`);
    for (const component of input.components) {
      const row = await findCanonicalVariantById(tx, component.variantId);
      if (!row) throw notFound(`Canonical variant ${component.variantId} does not exist.`);
    }
    const rows = await replaceBundleComponents(
      tx,
      input.bundleVariantId,
      input.components.map((component) => ({
        componentVariantId: component.variantId,
        quantity: component.quantity,
      })),
    );
    return rows.map((row) => ({
      componentVariantId: row.componentVariantId,
      quantity: row.quantity,
    }));
  });
}

/** What a bundle variant contains. Empty for every non-bundle — the derived read. */
export async function getBundleComponents(
  bundleVariantId: string,
): Promise<{ componentVariantId: string; quantity: number }[]> {
  const rows = await listBundleComponents(getDb(), bundleVariantId);
  return rows.map((row) => ({ componentVariantId: row.componentVariantId, quantity: row.quantity }));
}
