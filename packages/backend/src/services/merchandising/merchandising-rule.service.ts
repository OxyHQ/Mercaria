/**
 * The paid store-page merchandising rules (#89, `advanced_merchandising_rules`):
 * authoring, the dashboard's reads, and the order preview.
 *
 * ## Enforcement, exactly
 *
 * - **Create** takes ONE unit of the store's `total` allowance with
 *   `consumeCapabilityOrThrow`, in the same transaction as the insert, so a
 *   refused create writes nothing and a failed insert takes nothing.
 * - **Update** and **preview** are the tool's own work, so they ask
 *   `requireCapability` — a store whose plan ended can no longer edit or preview,
 *   and a store sitting at its ceiling still can (it is not creating more).
 * - **Delete** is never gated, and gives the unit back with `releaseCapability`
 *   in the delete's transaction, only when a row was actually deleted.
 * - **Reading** the list or one rule is never gated: what a merchant made stays
 *   readable whatever their plan says (`data_export` is ungateable).
 *
 * What a plan ending changes is whether a rule APPLIES to the store page
 * (`storefront-merchandising.service.ts`), never whether it exists.
 */

import type {
  CreateMerchandisingRuleInput,
  MerchandisingPreview,
  MerchandisingPreviewInput,
  MerchandisingRule,
  MerchandisingRuleStatus,
  UpdateMerchandisingRuleInput,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findCollectionById,
  findCollectionsByStore,
} from '../../db/merchandising/collectionRepository.js';
import {
  deleteMerchandisingRule,
  findFirstImageFileIds,
  findListingIdsOutsideStore,
  findMerchandisingRule,
  findMerchandisingRulesByStore,
  insertMerchandisingRule,
  orderStoreListings,
  updateMerchandisingRule,
  type MerchandisingRuleRow,
  type MerchandisingRuleValues,
} from '../../db/merchandising/merchandisingRuleRepository.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  consumeCapabilityOrThrow,
  holdsCapability,
  releaseCapability,
  requireCapability,
} from '../entitlements/enforce.js';
import { evaluateRules } from './rule-evaluation.js';

/** The one capability this tool is sold as. */
export const MERCHANDISING_CAPABILITY = 'advanced_merchandising_rules' as const;

/** A preview's default length, and its ceiling. */
const DEFAULT_PREVIEW_LIMIT = 24;
const MAX_PREVIEW_LIMIT = 48;

/** The clock, injectable so a schedule is tested at a chosen instant. */
export interface Clock {
  at?: Date;
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The DTO, with the status and `applying` derived at `at`. */
export function toMerchandisingRuleDTO(
  row: MerchandisingRuleRow,
  status: MerchandisingRuleStatus,
  applying: boolean,
): MerchandisingRule {
  return {
    id: row.id,
    storeId: row.storeId,
    kind: row.kind,
    title: row.title,
    target: row.target,
    collectionId: row.collectionId,
    enabled: row.enabled,
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    sortStrategy: row.sortStrategy,
    bestSellingWindowDays: row.bestSellingWindowDays,
    inStockFirst: row.inStockFirst,
    pinnedListingIds: [...row.pinnedListingIds],
    spotlightItemLimit: row.spotlightItemLimit,
    status,
    applying,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Render a store's rules at `at`: statuses with precedence, and whether each applies. */
async function present(
  storeId: string,
  rows: readonly MerchandisingRuleRow[],
  at: Date,
  /** The rules competing for precedence — every rule of the store. */
  all: readonly MerchandisingRuleRow[] = rows,
): Promise<MerchandisingRule[]> {
  const statuses = evaluateRules(all, at);
  const entitled = await holdsCapability({ storeId, capability: MERCHANDISING_CAPABILITY, at });
  const published = new Set(
    (await findCollectionsByStore(storeId, { publishedOnly: true })).map((c) => c.id),
  );
  return rows.map((row) => {
    const status = statuses.get(row.id) ?? 'paused';
    const visible = row.target === 'store' || published.has(row.collectionId ?? '');
    return toMerchandisingRuleDTO(row, status, entitled && status === 'live' && visible);
  });
}

/** Every rule of the store — NEVER gated. */
export async function listMerchandisingRules(
  storeId: string,
  clock: Clock = {},
): Promise<MerchandisingRule[]> {
  const rows = await findMerchandisingRulesByStore(storeId);
  return present(storeId, rows, clock.at ?? new Date());
}

/** One rule of the store — NEVER gated. */
export async function getMerchandisingRule(
  storeId: string,
  ruleId: string,
  clock: Clock = {},
): Promise<MerchandisingRule> {
  const all = await findMerchandisingRulesByStore(storeId);
  const row = all.find((rule) => rule.id === ruleId);
  if (!row) throw notFound('Merchandising rule not found');
  const [dto] = await present(storeId, [row], clock.at ?? new Date(), all);
  return dto;
}

function parseInstant(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw validationError(`${field} is not a valid date`);
  return parsed;
}

/**
 * The kind rules a row must satisfy, checked BEFORE the database's CHECKs so the
 * merchant is told which field is wrong rather than receiving a constraint name.
 */
function assertShape(values: MerchandisingRuleValues, pins: readonly string[]): void {
  if (values.startsAt && values.endsAt && values.endsAt.getTime() <= values.startsAt.getTime()) {
    throw validationError('endsAt must be after startsAt');
  }
  if (values.kind === 'sort') {
    if (values.sortStrategy === null) throw validationError('A sort rule needs a sortStrategy');
    if (values.sortStrategy === 'best_selling' && values.bestSellingWindowDays === null) {
      throw validationError('A best-selling sort needs bestSellingWindowDays');
    }
  } else {
    if (values.target !== 'collection') throw validationError('A spotlight shows one collection');
    if (values.spotlightItemLimit === null) {
      throw validationError('A spotlight needs a spotlightItemLimit');
    }
    if (pins.length > 0) throw validationError('Only a sort rule pins listings');
    if (values.inStockFirst) throw validationError('Only a sort rule orders in-stock first');
  }
  if (new Set(pins).size !== pins.length) throw validationError('A listing is pinned twice');
}

/** Refuse a pin that is not a listing of this store. */
async function assertPinsInStore(storeId: string, pins: readonly string[]): Promise<void> {
  const outside = await findListingIdsOutsideStore(storeId, pins);
  if (outside.length > 0) throw validationError('Pinned listings must belong to this store');
}

/**
 * Create a rule, taking one unit of the allowance in the same transaction.
 *
 * Throws `PlanCapabilityRefusal` (403 `PLAN_CAPABILITY_REQUIRED` /
 * `PLAN_LIMIT_REACHED`) when the plan refuses it; nothing is written then.
 */
export async function createMerchandisingRule(
  storeId: string,
  input: CreateMerchandisingRuleInput,
  clock: Clock = {},
): Promise<MerchandisingRule> {
  const target = input.target;
  if (target === 'collection') {
    if (!input.collectionId)
      throw validationError('collectionId is required for a collection rule');
    const collection = await findCollectionById(storeId, input.collectionId);
    if (!collection) throw validationError('collectionId does not name a collection of this store');
  } else if (input.collectionId) {
    throw validationError('A store-wide rule names no collection');
  }

  const isSort = input.kind === 'sort';
  const strategy = isSort ? (input.sortStrategy ?? null) : null;
  const values: MerchandisingRuleValues = {
    kind: input.kind,
    title: input.title.trim(),
    target,
    collectionId: target === 'collection' ? (input.collectionId ?? null) : null,
    enabled: input.enabled ?? true,
    startsAt: parseInstant(input.startsAt, 'startsAt'),
    endsAt: parseInstant(input.endsAt, 'endsAt'),
    sortStrategy: strategy,
    bestSellingWindowDays:
      strategy === 'best_selling' ? (input.bestSellingWindowDays ?? null) : null,
    // A spotlight's `inStockFirst: true` is carried through so `assertShape` names it.
    inStockFirst: input.inStockFirst ?? false,
    spotlightItemLimit: isSort ? null : (input.spotlightItemLimit ?? null),
  };
  const pins = input.pinnedListingIds ?? [];
  assertShape(values, pins);
  await assertPinsInStore(storeId, pins);

  const row = await getDb().transaction(async (tx) => {
    await consumeCapabilityOrThrow(tx, { storeId, capability: MERCHANDISING_CAPABILITY });
    return insertMerchandisingRule(tx, storeId, values, pins);
  });
  return getMerchandisingRule(storeId, row.id, clock);
}

/** Edit a rule. Gated: editing is the tool's own work. */
export async function updateMerchandisingRuleById(
  storeId: string,
  ruleId: string,
  patch: UpdateMerchandisingRuleInput,
  clock: Clock = {},
): Promise<MerchandisingRule> {
  await requireCapability({ storeId, capability: MERCHANDISING_CAPABILITY });
  const current = await findMerchandisingRule(storeId, ruleId);
  if (!current) throw notFound('Merchandising rule not found');

  const isSort = current.kind === 'sort';
  if (!isSort) {
    for (const field of [
      'sortStrategy',
      'bestSellingWindowDays',
      'inStockFirst',
      'pinnedListingIds',
    ] as const) {
      if (patch[field] !== undefined) throw validationError(`${field} applies to a sort rule only`);
    }
  } else if (patch.spotlightItemLimit !== undefined) {
    throw validationError('spotlightItemLimit applies to a spotlight only');
  }

  const strategy = isSort ? (patch.sortStrategy ?? current.sortStrategy) : null;
  const windowDays =
    strategy === 'best_selling'
      ? patch.bestSellingWindowDays === undefined
        ? current.bestSellingWindowDays
        : patch.bestSellingWindowDays
      : null;
  const values: MerchandisingRuleValues = {
    kind: current.kind,
    target: current.target,
    collectionId: current.collectionId,
    title: patch.title === undefined ? current.title : patch.title.trim(),
    enabled: patch.enabled ?? current.enabled,
    startsAt:
      patch.startsAt === undefined ? current.startsAt : parseInstant(patch.startsAt, 'startsAt'),
    endsAt: patch.endsAt === undefined ? current.endsAt : parseInstant(patch.endsAt, 'endsAt'),
    sortStrategy: strategy,
    bestSellingWindowDays: windowDays,
    inStockFirst: isSort ? (patch.inStockFirst ?? current.inStockFirst) : false,
    spotlightItemLimit: isSort ? null : (patch.spotlightItemLimit ?? current.spotlightItemLimit),
  };
  const pins = patch.pinnedListingIds;
  assertShape(values, pins ?? current.pinnedListingIds);
  if (pins !== undefined) await assertPinsInStore(storeId, pins);

  const { kind: _kind, target: _target, collectionId: _collectionId, ...mutable } = values;
  const updated = await getDb().transaction((tx) =>
    updateMerchandisingRule(tx, storeId, ruleId, mutable, pins),
  );
  if (!updated) throw notFound('Merchandising rule not found');
  return getMerchandisingRule(storeId, ruleId, clock);
}

/**
 * Delete a rule and give its unit back — NEVER gated, so a store whose plan
 * ended can always tidy up.
 */
export async function deleteMerchandisingRuleById(storeId: string, ruleId: string): Promise<void> {
  const deleted = await getDb().transaction(async (tx) => {
    const gone = await deleteMerchandisingRule(tx, storeId, ruleId);
    if (gone) await releaseCapability(tx, { storeId, capability: MERCHANDISING_CAPABILITY });
    return gone;
  });
  if (!deleted) throw notFound('Merchandising rule not found');
}

/** The resulting order of a draft `sort` rule, before it is saved. Gated. */
export async function previewMerchandisingOrder(
  storeId: string,
  input: MerchandisingPreviewInput,
  clock: Clock = {},
): Promise<MerchandisingPreview> {
  const at = clock.at ?? new Date();
  await requireCapability({ storeId, capability: MERCHANDISING_CAPABILITY, at });
  let collectionId: string | null = null;
  if (input.target === 'collection') {
    if (!input.collectionId)
      throw validationError('collectionId is required for a collection rule');
    const collection = await findCollectionById(storeId, input.collectionId);
    if (!collection) throw validationError('collectionId does not name a collection of this store');
    collectionId = collection.id;
  }
  const pins = input.pinnedListingIds ?? [];
  if (new Set(pins).size !== pins.length) throw validationError('A listing is pinned twice');
  if (input.sortStrategy === 'best_selling' && input.bestSellingWindowDays === undefined) {
    throw validationError('A best-selling sort needs bestSellingWindowDays');
  }
  const limit = Math.min(input.limit ?? DEFAULT_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);
  const { rows, total } = await orderStoreListings({
    storeId,
    collectionId,
    strategy: input.sortStrategy,
    bestSellingWindowDays: input.bestSellingWindowDays ?? null,
    inStockFirst: input.inStockFirst ?? false,
    pinnedListingIds: pins,
    at,
    offset: 0,
    limit,
  });
  const images = await findFirstImageFileIds(rows.map((row) => row.listingId));
  return {
    total,
    items: rows.map((row) => ({
      listingId: row.listingId,
      title: row.title,
      imageFileId: images.get(row.listingId) ?? null,
      pinned: row.pinned,
      inStock: row.inStock,
      unitsSold: row.unitsSold,
      priceMinAmount: row.priceMinAmount,
      priceCurrency: row.priceCurrency,
    })),
  };
}
