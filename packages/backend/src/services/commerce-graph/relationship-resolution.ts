/**
 * The PUBLIC read side of the relationship graph (#55, product behaviour 1–4).
 *
 * Two questions, and deliberately only two:
 *
 *  - "Is this merchant an official direct channel for this brand, in this
 *    market, right now?" — what a product page asks before rendering a badge.
 *  - "Which merchants are this brand's own channels, and which are its
 *    authorized resellers?" — what a brand page lists, in two SEPARATE lists.
 *
 * ## Why the projection is a different type, not a filtered row
 *
 * `PublicCommerceRelationship` has no field for evidence, reviewer notes, actor
 * ids, confidence or the review round (evidence rule 6). That is what makes a
 * leak a compile error rather than a review catch: there is nowhere for private
 * review material to ride along, so no serializer can forget to strip it.
 *
 * ## Three things this module refuses to do, and each is the point
 *
 *  - **It never reads `status` alone.** Currency is `status = 'verified'` AND
 *    the validity window covering the instant asked about, so a claim that
 *    lapsed an hour ago produces no badge whether or not a sweep has run yet
 *    (acceptance criterion 3, and the reason the sweep is a convenience).
 *  - **It never reads confidence.** A 0.99 machine match is a candidate and
 *    candidates are invisible here — the query filters on `verified` and
 *    confidence is CHECK-restricted to ingestion rows anyway, so the two
 *    together make "a badge from a good guess" unreachable.
 *  - **It never infers.** There is no name, domain or logo comparison in this
 *    file; the only input to a badge is a relationship row (acceptance
 *    criterion 1).
 */

import type {
  BrandChannelDirectory,
  OfficialChannelVerdict,
  PublicCommerceRelationship,
  PublicRelationshipBadge,
  RelationshipKind,
} from '@mercaria/shared-types';
import { RELATIONSHIP_KIND_DEFINITIONS } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findCurrentRelationships,
  type CommerceRelationshipRow,
} from '../../db/commerce-graph/relationshipRepository.js';

/** The two kinds a shopper-facing badge can come from. */
const BADGE_KINDS: readonly RelationshipKind[] = [
  'merchant_official_channel_for_brand',
  'merchant_authorized_reseller_for_brand',
];

/**
 * Project a verified row for public consumption.
 *
 * The `status` literal is asserted from the caller's filter rather than copied
 * from the row: this function is only ever reached through a query that filters
 * `status = 'verified'`, and typing the field as the literal is what stops a
 * future caller passing a candidate through it without a compile error.
 */
function toPublicRelationship(row: CommerceRelationshipRow): PublicCommerceRelationship {
  const definition = RELATIONSHIP_KIND_DEFINITIONS[row.kind];
  const verifiedAt = row.verifiedAt;
  if (row.status !== 'verified' || verifiedAt === null) {
    throw new Error(
      `Relationship ${row.id} reached the public projection without being verified. ` +
        'Only a verified row may be projected publicly.',
    );
  }
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: definition.subject,
    subjectId: publicEndpoint(row, 'subject'),
    objectKind: definition.object,
    objectId: publicEndpoint(row, 'object'),
    territories: row.territories,
    languages: row.languages,
    storefrontId: row.storefrontId,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    status: 'verified',
    verifiedAt: verifiedAt.toISOString(),
    badge: definition.publicBadge,
  };
}

/** The subject/object endpoint id, by the kind's declared entity kinds. */
function publicEndpoint(row: CommerceRelationshipRow, role: 'subject' | 'object'): string {
  const definition = RELATIONSHIP_KIND_DEFINITIONS[row.kind];
  const entityKind = role === 'subject' ? definition.subject : definition.object;
  const value =
    entityKind === 'organization'
      ? row.organizationId
      : entityKind === 'merchant'
        ? row.merchantId
        : entityKind === 'product_family'
          ? row.productFamilyId
          : role === 'object' && definition.subject === 'brand'
            ? row.relatedBrandId
            : row.brandId;
  if (value === null || value === undefined) {
    throw new Error(`Relationship ${row.id} has no ${role} endpoint.`);
  }
  return value;
}

/**
 * "Is this merchant an official direct channel for this brand in this market?"
 *
 * Answers with at most ONE badge. When both a direct-channel and a reseller
 * claim are somehow current for one pair — a state the conflict detector flags
 * and an operator resolves — the direct channel wins, because under-claiming is
 * the safe direction: calling a brand's own store an authorized reseller
 * understates a true relationship, while the reverse asserts a relationship that
 * does not exist.
 *
 * `market` absent means "any scope": the caller has no geography, so a
 * market-scoped claim still answers. A caller that HAS a market gets the strict
 * reading — a claim scoped to `{ES}` is no answer for a shopper in Germany.
 */
export async function resolveOfficialChannel(params: {
  merchantId: string;
  brandId: string;
  market?: string;
  at?: Date;
}): Promise<OfficialChannelVerdict> {
  const db = getDb();
  const rows = await findCurrentRelationships(db, {
    kinds: BADGE_KINDS,
    brandId: params.brandId,
    merchantId: params.merchantId,
    market: params.market?.toUpperCase(),
    at: params.at ?? new Date(),
  });

  const direct = rows.find((row) => row.kind === 'merchant_official_channel_for_brand');
  const chosen = direct ?? rows.find((row) => row.kind === 'merchant_authorized_reseller_for_brand');

  const badge: PublicRelationshipBadge | null =
    chosen === undefined ? null : RELATIONSHIP_KIND_DEFINITIONS[chosen.kind].publicBadge;

  return {
    merchantId: params.merchantId,
    brandId: params.brandId,
    market: params.market?.toUpperCase() ?? null,
    badge,
    relationship: chosen === undefined ? null : toPublicRelationship(chosen),
  };
}

/**
 * A brand's verified channels, in two separate lists (product behaviour 3).
 *
 * Ordinary merchants selling the brand appear in neither, and that is correct:
 * they hold no relationship row at all (ADR 0002 D10), so absence here is the
 * normal state and not a missing record.
 */
export async function listBrandChannels(params: {
  brandId: string;
  market?: string;
  at?: Date;
}): Promise<BrandChannelDirectory> {
  const db = getDb();
  const rows = await findCurrentRelationships(db, {
    kinds: BADGE_KINDS,
    brandId: params.brandId,
    market: params.market?.toUpperCase(),
    at: params.at ?? new Date(),
  });

  return {
    brandId: params.brandId,
    market: params.market?.toUpperCase() ?? null,
    officialChannels: rows
      .filter((row) => row.kind === 'merchant_official_channel_for_brand')
      .map(toPublicRelationship),
    authorizedResellers: rows
      .filter((row) => row.kind === 'merchant_authorized_reseller_for_brand')
      .map(toPublicRelationship),
  };
}

/**
 * The verified relationships a merchant currently holds — the merchant-page
 * mirror of {@link listBrandChannels}, restricted to badge-producing kinds so a
 * public read cannot enumerate ownership or manufacturing claims from here.
 */
export async function listMerchantBrandRelationships(params: {
  merchantId: string;
  market?: string;
  at?: Date;
}): Promise<PublicCommerceRelationship[]> {
  const db = getDb();
  const rows = await findCurrentRelationships(db, {
    kinds: BADGE_KINDS,
    merchantId: params.merchantId,
    market: params.market?.toUpperCase(),
    at: params.at ?? new Date(),
  });
  return rows.map(toPublicRelationship);
}
