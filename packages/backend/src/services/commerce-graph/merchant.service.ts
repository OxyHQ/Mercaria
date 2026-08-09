/**
 * Merchant reads and writes over the canonical commerce graph (#54, ADR 0002).
 *
 * ## What resolves where
 *
 *  - A MERGED merchant is a tombstone: public reads follow `merged_into_id`
 *    (one hop — the column is flattened on write, D16) and say so via
 *    `redirectedFrom`, so an old URL keeps answering with the winner.
 *  - A SUPPRESSED merchant is invisible to public reads — suppression is the
 *    operator lever for exactly that — while operator surfaces read the row
 *    raw through the repository.
 *  - Native-checkout eligibility is DERIVED here and stored nowhere (issue
 *    requirement 7): only `native` offers reach checkout structurally
 *    (ADR 0002 D18), so the answer is a conjunction over the claim verdict
 *    and the active native-store link, computed per read. A stored flag could
 *    drift from either conjunct; a derivation cannot.
 */

import type {
  CanonicalAliasKind,
  Merchant,
  MerchantNativeCheckoutEligibility,
  MerchantPublicProfile,
  MerchantType,
} from '@mercaria/shared-types';
import { isLiveEntityId, isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../../db/postgres.js';
import {
  findMerchantById,
  findMerchantBySlug,
  findMerchantDomainsByDomain,
  findMerchantsByNormalizedAlias,
  insertMerchant,
  insertMerchantAlias,
  listMerchantDomains,
  merchantSlugExists,
  observeMerchantDomain,
  verifyMerchantDomain,
  type MerchantRow,
} from '../../db/commerce-graph/merchantRepository.js';
import { findActiveLinkByMerchant } from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import {
  findStorefrontsByMerchant,
  type StorefrontRow,
} from '../../db/commerce-graph/storefrontRepository.js';
import { toStorefrontDTO } from './storefront.service.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { ensureUniqueSlug } from '../../utils/slug.js';

/**
 * The SAME normalization the generated `normalized_alias` column applies
 * (`lower(btrim(alias))`), spelled once so a JS lookup and the SQL key cannot
 * drift per call site.
 */
export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/**
 * Normalize a domain to the form the `merchant_domains_domain_normalized_check`
 * CHECK requires: lowercase hostname, no scheme, no path, no port, no
 * trailing dot. Refuses anything that is not a plausible hostname rather than
 * storing a URL-shaped string the collision gate would then never match.
 */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = value.indexOf('/');
  if (slash !== -1) value = value.slice(0, slash);
  const colon = value.indexOf(':');
  if (colon !== -1) value = value.slice(0, colon);
  value = value.replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    throw validationError(`Not a valid domain: ${input}`);
  }
  return value;
}

/** Map a row onto the public DTO — every field named, nothing extra rides along. */
export function toMerchantDTO(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    merchantType: row.merchantType,
    description: row.description,
    claimState: row.claimState,
    status: row.status,
    mergedIntoId: row.mergedIntoId,
    rating: row.rating,
    ratingCount: row.ratingCount,
    offerCount: row.offerCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateMerchantParams {
  name: string;
  merchantType?: MerchantType;
  description?: string;
  /** Explicit slug wins; otherwise minted from the name via `ensureUniqueSlug`. */
  slug?: string;
  aliases?: readonly { alias: string; kind: CanonicalAliasKind; language?: string }[];
  createdByOxyUserId?: string;
}

/**
 * Create a merchant with its aliases in one transaction.
 *
 * Creating an entity grants NOTHING (issue acceptance 5): the row is born
 * `claim_state='unclaimed'` with no relationships — claiming is #40/#83, and
 * official/authorized status only ever arrives through #55's evidence-gated
 * relationship rows.
 */
export async function createMerchant(params: CreateMerchantParams): Promise<MerchantRow> {
  const name = params.name.trim();
  if (name === '') {
    throw validationError('A merchant needs a non-empty name.');
  }
  const db = getDb();
  const slug = params.slug ?? (await ensureUniqueSlug(name, (c) => merchantSlugExists(db, c)));
  return db.transaction(async (tx) => {
    const merchant = await insertMerchant(tx, {
      name,
      slug,
      merchantType: params.merchantType ?? null,
      description: params.description,
    });
    for (const alias of params.aliases ?? []) {
      await insertMerchantAlias(tx, {
        merchantId: merchant.id,
        alias: alias.alias,
        kind: alias.kind,
        language: alias.language,
        createdByOxyUserId: params.createdByOxyUserId,
      });
    }
    return merchant;
  });
}

/** Resolve an id-or-slug to a row, without redirect or visibility policy. */
async function findByIdOrSlug(idOrSlug: string): Promise<MerchantRow | undefined> {
  const db = getDb();
  if (isLiveEntityId(idOrSlug)) {
    const byId = await findMerchantById(db, idOrSlug);
    if (byId) return byId;
  }
  return findMerchantBySlug(db, idOrSlug);
}

/**
 * The public merchant read: tombstones redirect, suppressed rows do not
 * exist, and the profile carries the merchant's channels and VERIFIED domains
 * (observations stay graph-internal until verified — showing them would let a
 * crawler sighting put an unverified association on a public page).
 */
export async function getMerchantPublic(idOrSlug: string): Promise<MerchantPublicProfile> {
  const db = getDb();
  const requested = await findByIdOrSlug(idOrSlug);
  if (!requested || requested.status === 'suppressed') {
    throw notFound('Merchant not found');
  }

  let merchant = requested;
  let redirectedFrom: string | undefined;
  if (requested.status === 'merged' && requested.mergedIntoId) {
    const winner = await findMerchantById(db, requested.mergedIntoId);
    if (!winner || winner.status === 'suppressed') {
      throw notFound('Merchant not found');
    }
    merchant = winner;
    redirectedFrom = requested.id;
  }

  const [storefronts, domains] = await Promise.all([
    findStorefrontsByMerchant(db, merchant.id),
    listMerchantDomains(db, merchant.id),
  ]);

  const profile: MerchantPublicProfile = {
    merchant: toMerchantDTO(merchant),
    storefronts: storefronts
      .filter((row: StorefrontRow) => row.status !== 'suppressed' && row.status !== 'merged')
      .map(toStorefrontDTO),
    verifiedDomains: domains
      .filter((row) => row.status === 'verified')
      .map((row) => row.domain)
      .sort(),
  };
  if (redirectedFrom !== undefined) {
    profile.redirectedFrom = redirectedFrom;
  }
  return profile;
}

/** Domain lookup: every non-suppressed merchant with a row for this domain. */
export async function lookupMerchantsByDomain(
  rawDomain: string,
): Promise<{ merchant: Merchant; domainStatus: string }[]> {
  const db = getDb();
  const domain = normalizeDomain(rawDomain);
  const domainRows = await findMerchantDomainsByDomain(db, domain);
  const results: { merchant: Merchant; domainStatus: string }[] = [];
  for (const row of domainRows) {
    const merchant = await findMerchantById(db, row.merchantId);
    if (merchant && merchant.status !== 'suppressed') {
      results.push({ merchant: toMerchantDTO(merchant), domainStatus: row.status });
    }
  }
  // Verified holder first, then observers — the order a resolver wants.
  return results.sort((a, b) =>
    a.domainStatus === b.domainStatus ? 0 : a.domainStatus === 'verified' ? -1 : 1,
  );
}

/** Alias lookup: every non-suppressed merchant the normalized alias resolves to. */
export async function lookupMerchantsByAlias(alias: string): Promise<Merchant[]> {
  const db = getDb();
  const rows = await findMerchantsByNormalizedAlias(db, normalizeAlias(alias));
  return rows.filter((row) => row.status !== 'suppressed').map(toMerchantDTO);
}

/** Record a public-website observation (issue merchant requirement 5). */
export async function recordDomainObservation(params: {
  merchantId: string;
  domain: string;
  observedAt?: Date;
  note?: string;
}): Promise<void> {
  const db = getDb();
  const merchant = await findMerchantById(db, params.merchantId);
  if (!merchant) {
    throw notFound('Merchant not found');
  }
  await observeMerchantDomain(db, {
    merchantId: params.merchantId,
    domain: normalizeDomain(params.domain),
    observedAt: params.observedAt ?? new Date(),
    note: params.note,
  });
}

/**
 * Verify a domain for a merchant — the write the collision gate protects.
 *
 * A domain already VERIFIED for a DIFFERENT merchant is a 409, surfaced from
 * the partial unique index rather than a read-then-write that two concurrent
 * verifications would race straight past. The domain must already be an
 * observation for this merchant: verification confirms a recorded fact, it
 * never invents one.
 */
export async function verifyDomainForMerchant(params: {
  merchantId: string;
  domain: string;
  verifiedByOxyUserId?: string;
}): Promise<void> {
  const db = getDb();
  const domain = normalizeDomain(params.domain);
  try {
    const updated = await verifyMerchantDomain(db, {
      merchantId: params.merchantId,
      domain,
      verifiedAt: new Date(),
      verifiedByOxyUserId: params.verifiedByOxyUserId,
    });
    if (!updated) {
      throw notFound(`No recorded observation of ${domain} for this merchant to verify.`);
    }
  } catch (error) {
    // `isUniqueViolation` walks the cause chain — drizzle wraps the driver's
    // error in `DrizzleQueryError`, so a bare `error.code` read sees nothing.
    if (isUniqueViolation(error, 'merchant_domains_domain_verified_key')) {
      throw conflict(`${domain} is already verified for another merchant.`);
    }
    throw error;
  }
}

/**
 * Native-checkout eligibility, derived and never stored (issue requirement 7).
 * Pure over its two conjuncts so the rule itself is unit-testable.
 */
export function deriveNativeCheckoutEligibility(
  merchant: Pick<MerchantRow, 'id' | 'claimState'>,
  hasActiveNativeStoreLink: boolean,
): MerchantNativeCheckoutEligibility {
  return {
    merchantId: merchant.id,
    eligible: merchant.claimState === 'claimed' && hasActiveNativeStoreLink,
    claimState: merchant.claimState,
    hasActiveNativeStoreLink,
  };
}

/** The read-time composition of {@link deriveNativeCheckoutEligibility}. */
export async function getNativeCheckoutEligibility(
  merchantId: string,
): Promise<MerchantNativeCheckoutEligibility> {
  const db = getDb();
  const merchant = await findMerchantById(db, merchantId);
  if (!merchant) {
    throw notFound('Merchant not found');
  }
  const activeLink = await findActiveLinkByMerchant(db, merchantId);
  return deriveNativeCheckoutEligibility(merchant, activeLink !== undefined);
}
