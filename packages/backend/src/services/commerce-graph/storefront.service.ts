/**
 * Storefront reads and the source-observation upsert (#54, ADR 0002 D3/D22).
 *
 * The upsert is the ingestion seam #62 will drive: one observation of an
 * external shop converges on one `(provider, external_shop_id)` row however
 * many times it is delivered, re-run or raced. The public read follows the
 * same tombstone-redirect / suppression policy as merchants.
 */

import type {
  Storefront,
  StorefrontChannelKind,
  StorefrontPublicProfile,
} from '@mercaria/shared-types';
import { isLiveEntityId } from '@oxyhq/db';
import { getDb } from '../../db/postgres.js';
import { findMerchantById } from '../../db/commerce-graph/merchantRepository.js';
import {
  findStorefrontById,
  findStorefrontBySlug,
  findStorefrontBySource,
  findStorefrontsByDomain,
  insertStorefront,
  storefrontSlugExists,
  upsertStorefrontFromSource,
  type StorefrontObservation,
  type StorefrontRow,
} from '../../db/commerce-graph/storefrontRepository.js';
import { normalizeDomain } from './merchant.service.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { ensureUniqueSlug } from '../../utils/slug.js';

/** Map a row onto the public DTO — every field named explicitly. */
export function toStorefrontDTO(row: StorefrontRow): Storefront {
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    slug: row.slug,
    channelKind: row.channelKind,
    provider: row.provider,
    domain: row.domain,
    externalShopId: row.externalShopId,
    country: row.country,
    languages: row.languages,
    currency: row.currency,
    publicUrl: row.publicUrl,
    affiliateCapable: row.affiliateCapable,
    status: row.status,
    mergedIntoId: row.mergedIntoId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    verificationState: row.verificationState,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateStorefrontParams {
  merchantId: string;
  name: string;
  channelKind: StorefrontChannelKind;
  provider?: string;
  domain?: string;
  externalShopId?: string;
  country?: string;
  languages?: string[];
  currency?: string;
  publicUrl?: string;
  affiliateCapable?: boolean;
}

/** Create a channel directly (operator/claimed-merchant path, not ingestion). */
export async function createStorefront(params: CreateStorefrontParams): Promise<StorefrontRow> {
  const db = getDb();
  const name = params.name.trim();
  if (name === '') {
    throw validationError('A storefront needs a non-empty name.');
  }
  const merchant = await findMerchantById(db, params.merchantId);
  if (!merchant) {
    throw notFound('Merchant not found');
  }
  const slug = await ensureUniqueSlug(name, (c) => storefrontSlugExists(db, c));
  return insertStorefront(db, {
    merchantId: params.merchantId,
    name,
    slug,
    channelKind: params.channelKind,
    provider: params.provider?.trim().toLowerCase(),
    domain: params.domain === undefined ? undefined : normalizeDomain(params.domain),
    externalShopId: params.externalShopId,
    country: params.country?.trim().toUpperCase(),
    languages: params.languages?.map((tag) => tag.trim().toLowerCase()),
    currency: params.currency?.trim().toUpperCase(),
    publicUrl: params.publicUrl,
    affiliateCapable: params.affiliateCapable,
    firstSeenAt: new Date(),
  });
}

export interface SourceObservationParams {
  merchantId: string;
  provider: string;
  externalShopId: string;
  channelKind: StorefrontChannelKind;
  name: string;
  domain?: string;
  country?: string;
  languages?: string[];
  currency?: string;
  publicUrl?: string;
  affiliateCapable?: boolean;
  observedAt?: Date;
}

/**
 * Apply one source observation of an external shop, idempotently (D22).
 *
 * The slug is minted only when the row does not exist yet; on convergence the
 * existing identity is untouched — as are `status`, `merchant_id` and
 * anything an operator pinned (filtered here, the `pinned_fields` contract
 * from D16).
 */
export async function applySourceObservation(
  params: SourceObservationParams,
): Promise<StorefrontRow> {
  const db = getDb();
  const merchant = await findMerchantById(db, params.merchantId);
  if (!merchant) {
    throw notFound('Merchant not found');
  }
  const name = params.name.trim();
  if (name === '') {
    throw validationError('A storefront observation needs a non-empty name.');
  }

  const provider = params.provider.trim().toLowerCase();
  const observation: StorefrontObservation = {
    name,
    domain: params.domain === undefined ? undefined : normalizeDomain(params.domain),
    country: params.country?.trim().toUpperCase(),
    languages: params.languages?.map((tag) => tag.trim().toLowerCase()),
    currency: params.currency?.trim().toUpperCase(),
    publicUrl: params.publicUrl,
    affiliateCapable: params.affiliateCapable,
    observedAt: params.observedAt ?? new Date(),
  };

  const existing = await findStorefrontBySource(db, provider, params.externalShopId);
  if (existing && existing.pinnedFields.length > 0) {
    // An operator's correction outranks every subsequent observation (D16).
    for (const field of existing.pinnedFields) {
      if (field === 'name') observation.name = existing.name;
      if (field === 'domain') observation.domain = existing.domain ?? undefined;
      if (field === 'country') observation.country = existing.country ?? undefined;
      if (field === 'languages') observation.languages = existing.languages ?? undefined;
      if (field === 'currency') observation.currency = existing.currency ?? undefined;
      if (field === 'publicUrl') observation.publicUrl = existing.publicUrl ?? undefined;
      if (field === 'affiliateCapable') observation.affiliateCapable = existing.affiliateCapable;
    }
  }

  const slug =
    existing?.slug ?? (await ensureUniqueSlug(name, (c) => storefrontSlugExists(db, c)));
  return upsertStorefrontFromSource(db, {
    merchantId: params.merchantId,
    provider,
    externalShopId: params.externalShopId,
    slug,
    channelKind: params.channelKind,
    observation,
  });
}

/** Public storefront read with the tombstone-redirect / suppression policy. */
export async function getStorefrontPublic(idOrSlug: string): Promise<StorefrontPublicProfile> {
  const db = getDb();
  let requested: StorefrontRow | undefined;
  if (isLiveEntityId(idOrSlug)) {
    requested = await findStorefrontById(db, idOrSlug);
  }
  requested = requested ?? (await findStorefrontBySlug(db, idOrSlug));
  if (!requested || requested.status === 'suppressed') {
    throw notFound('Storefront not found');
  }

  if (requested.status === 'merged' && requested.mergedIntoId) {
    const winner = await findStorefrontById(db, requested.mergedIntoId);
    if (!winner || winner.status === 'suppressed') {
      throw notFound('Storefront not found');
    }
    return { storefront: toStorefrontDTO(winner), redirectedFrom: requested.id };
  }
  return { storefront: toStorefrontDTO(requested) };
}

/** Source-id lookup — the read side of the convergence key. */
export async function lookupStorefrontBySource(
  provider: string,
  externalShopId: string,
): Promise<Storefront | undefined> {
  const db = getDb();
  const row = await findStorefrontBySource(db, provider.trim().toLowerCase(), externalShopId);
  if (!row || row.status === 'suppressed') return undefined;
  return toStorefrontDTO(row);
}

/** Domain lookup — several country sites may legitimately share one domain. */
export async function lookupStorefrontsByDomain(rawDomain: string): Promise<Storefront[]> {
  const db = getDb();
  const rows = await findStorefrontsByDomain(db, normalizeDomain(rawDomain));
  return rows
    .filter((row) => row.status !== 'suppressed' && row.status !== 'merged')
    .map(toStorefrontDTO);
}
