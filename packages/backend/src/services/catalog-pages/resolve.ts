/**
 * Turning a handle in a URL into the entity a page is about (#72 brand rule 9,
 * family rule 7).
 *
 * Three ways in and one way out: an id, a slug, or an ALIAS — and whatever it
 * resolves to, a merge tombstone is followed to the entity that absorbed it, so
 * an old link keeps working forever. That is what "alias and merged-brand
 * redirects" means in a catalogue where a slug is unique FOREVER and a merged
 * row keeps its own (ADR 0002 D12).
 *
 * ## Why the redirect is reported in the 200
 *
 * A `301` would cost a second round trip on every stale link, and the client
 * that consumes this is an app that owns its own address bar: it rewrites the
 * URL and renders the page it already has. The reported {@link CatalogPageRedirect}
 * carries the handle that was ASKED for, so a client can tell "you followed an
 * old link" from "you typed the canonical slug" — which decides whether it
 * rewrites history or leaves it alone.
 *
 * ## The chain is followed with a BOUND
 *
 * `merged_into_id` is a self-referential foreign key and the schema forbids a
 * row pointing at itself, but nothing in the database forbids a CYCLE across
 * two rows. A merge that produced one would be a bug in #59, and a page that
 * hung resolving it would be a much worse symptom than a page that gives up —
 * so the walk stops after {@link MERGE_CHAIN_LIMIT} hops and answers with the
 * last live row it saw.
 */

import type { CatalogPageRedirect } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findBrandById,
  findBrandBySlug,
  findBrandIdsByNormalizedAlias,
  type BrandRow,
} from '../../db/canonical/brandRepository.js';
import {
  findProductFamilyById,
  findProductFamilyBySlug,
  findProductFamilyIdsByNormalizedAlias,
  type ProductFamilyRow,
} from '../../db/canonical/productFamilyRepository.js';
import { normalizeAliasLookup } from '../canonical/normalization.js';

/** How many merge hops a resolution follows before it stops. */
export const MERGE_CHAIN_LIMIT = 8;

/** What a handle resolved to, and whether the caller asked for something else. */
export interface ResolvedCatalogEntity<TRow> {
  readonly row: TRow;
  readonly redirect?: CatalogPageRedirect;
}

/**
 * Resolve a brand handle.
 *
 * The order is id, then slug, then alias — narrowest to widest, so an ALIAS can
 * never shadow a real slug. An alias resolving to more than one live brand
 * answers `undefined` rather than picking: "iPhone" naming two brands is a
 * curation problem (#59), and choosing one of them would put a shopper on a
 * page about a competitor with nothing saying so.
 */
export async function resolveBrandHandle(
  db: DatabaseOrTransaction,
  handle: string,
): Promise<ResolvedCatalogEntity<BrandRow> | undefined> {
  const direct = (await findBrandById(db, handle)) ?? (await findBrandBySlug(db, handle));
  if (direct !== undefined) {
    const live = await followBrandMerges(db, direct);
    return live.id === direct.id
      ? { row: live }
      : { row: live, redirect: { from: handle, reason: 'merged' } };
  }

  const lookup = normalizeAliasLookup(handle);
  if (lookup.length === 0) return undefined;
  const aliasIds = await findBrandIdsByNormalizedAlias(db, lookup);
  const live = new Map<string, BrandRow>();
  for (const id of aliasIds) {
    const row = await findBrandById(db, id);
    if (row === undefined) continue;
    const resolved = await followBrandMerges(db, row);
    live.set(resolved.id, resolved);
  }
  if (live.size !== 1) return undefined;
  const [only] = [...live.values()];
  if (only === undefined) return undefined;
  return { row: only, redirect: { from: handle, reason: 'alias' } };
}

/** Follow a brand's merge chain to the live row that absorbed it. */
async function followBrandMerges(db: DatabaseOrTransaction, start: BrandRow): Promise<BrandRow> {
  let current = start;
  for (let hop = 0; hop < MERGE_CHAIN_LIMIT; hop += 1) {
    const next = current.mergedIntoId;
    if (next === null) return current;
    const row = await findBrandById(db, next);
    if (row === undefined) return current;
    current = row;
  }
  return current;
}

/** Resolve a family handle. Same order and the same reasoning as a brand's. */
export async function resolveFamilyHandle(
  db: DatabaseOrTransaction,
  handle: string,
): Promise<ResolvedCatalogEntity<ProductFamilyRow> | undefined> {
  const direct =
    (await findProductFamilyById(db, handle)) ?? (await findProductFamilyBySlug(db, handle));
  if (direct !== undefined) {
    const live = await followFamilyMerges(db, direct);
    return live.id === direct.id
      ? { row: live }
      : { row: live, redirect: { from: handle, reason: 'merged' } };
  }

  const lookup = normalizeAliasLookup(handle);
  if (lookup.length === 0) return undefined;
  const aliasIds = await findProductFamilyIdsByNormalizedAlias(db, lookup);
  const live = new Map<string, ProductFamilyRow>();
  for (const id of aliasIds) {
    const row = await findProductFamilyById(db, id);
    if (row === undefined) continue;
    const resolved = await followFamilyMerges(db, row);
    live.set(resolved.id, resolved);
  }
  if (live.size !== 1) return undefined;
  const [only] = [...live.values()];
  if (only === undefined) return undefined;
  return { row: only, redirect: { from: handle, reason: 'alias' } };
}

/** Follow a family's merge chain to the live row that absorbed it. */
async function followFamilyMerges(
  db: DatabaseOrTransaction,
  start: ProductFamilyRow,
): Promise<ProductFamilyRow> {
  let current = start;
  for (let hop = 0; hop < MERGE_CHAIN_LIMIT; hop += 1) {
    const next = current.mergedIntoId;
    if (next === null) return current;
    const row = await findProductFamilyById(db, next);
    if (row === undefined) return current;
    current = row;
  }
  return current;
}
