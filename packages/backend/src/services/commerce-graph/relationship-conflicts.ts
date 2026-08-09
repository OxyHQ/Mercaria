/**
 * Conflict detection for mutually inconsistent active claims (#55, operator
 * workflow 4).
 *
 * DERIVED on read, never stored — the `procurement-eligibility` precedent. A
 * stored conflict verdict is a function of four other rows and goes stale the
 * moment any one of them moves; the place that must not happen is a queue an
 * operator trusts to be complete.
 *
 * ## What the database already prevents, and therefore is not here
 *
 * Two of the six kinds can only ever be REPORTED, never encountered as stored
 * state, because an index refuses the write: `duplicate_open_claim` (the partial
 * unique on `(kind, endpoint_key) WHERE valid_to IS NULL`) and
 * `contested_brand_ownership` in its verified form (the partial unique on the
 * brand owner). They are detected anyway, for the case the index cannot see: two
 * CANDIDATE ownership claims from different organizations are a legitimate
 * dispute an operator must resolve, and a duplicate is worth naming in the
 * refusal message rather than surfacing as a 23505.
 *
 * The rest are genuinely undetectable by any constraint, and each for a stated
 * reason: territory OVERLAP between two different kinds needs array
 * intersection across rows, a succession CYCLE needs graph traversal, "verified
 * with no active evidence" is cross-table, and "verified past its validity" is
 * a comparison against `now()` — which no CHECK may contain.
 */

import type {
  RelationshipConflict,
  RelationshipKind,
  RelationshipVerificationState,
} from '@mercaria/shared-types';

/** The subset of a relationship row the detector reads. */
export interface ConflictCandidateRow {
  id: string;
  kind: RelationshipKind;
  organizationId: string | null;
  brandId: string | null;
  merchantId: string | null;
  productFamilyId: string | null;
  relatedBrandId: string | null;
  storefrontId: string | null;
  territories: string[];
  status: RelationshipVerificationState;
  validFrom: Date;
  validTo: Date | null;
}

/** Evidence, reduced to what a conflict answer needs. */
export interface ConflictEvidenceFact {
  relationshipId: string;
  status: 'active' | 'expired' | 'revoked';
}

/** Live at the given instant — inside its window, whatever the status says. */
function isWithinWindow(row: ConflictCandidateRow, at: Date): boolean {
  if (row.validFrom.getTime() > at.getTime()) return false;
  return row.validTo === null || row.validTo.getTime() > at.getTime();
}

/**
 * Markets two claims share.
 *
 * `'{}'` means WORLDWIDE on both sides, so an empty list intersects everything —
 * getting this backwards would silently report no conflict for the two broadest
 * claims in the system, which are exactly the two most worth catching. The
 * worldwide ∩ worldwide case returns `['*']` so a caller can render "every
 * market" without having to re-derive the emptiness convention.
 */
export function overlappingTerritories(left: string[], right: string[]): string[] {
  if (left.length === 0 && right.length === 0) return ['*'];
  if (left.length === 0) return [...right].sort();
  if (right.length === 0) return [...left].sort();
  const rightSet = new Set(right);
  return left.filter((code) => rightSet.has(code)).sort();
}

/**
 * Every conflict involving `subject`, given the other rows that touch the same
 * endpoints and the evidence backing them.
 *
 * Pure: the caller fetches, this decides. That is what lets the whole matrix be
 * table-tested without a database, and what keeps the same answer coming out of
 * the candidate queue, the single-relationship read and the pre-verification
 * gate — three callers that would otherwise each grow their own version.
 */
export function detectConflicts(input: {
  subject: ConflictCandidateRow;
  related: readonly ConflictCandidateRow[];
  evidence: readonly ConflictEvidenceFact[];
  at: Date;
}): RelationshipConflict[] {
  const { subject, related, evidence, at } = input;
  const conflicts: RelationshipConflict[] = [];
  const others = related.filter((row) => row.id !== subject.id);

  // 1. Another OPEN row already holds this exact claim. Only reachable through
  //    a read (the index refuses the write), and named so a refusal can say so.
  for (const other of others) {
    if (
      other.kind === subject.kind &&
      other.validTo === null &&
      subject.validTo === null &&
      other.organizationId === subject.organizationId &&
      other.brandId === subject.brandId &&
      other.merchantId === subject.merchantId &&
      other.productFamilyId === subject.productFamilyId &&
      other.relatedBrandId === subject.relatedBrandId &&
      other.storefrontId === subject.storefrontId
    ) {
      conflicts.push({
        kind: 'duplicate_open_claim',
        relationshipId: subject.id,
        otherRelationshipId: other.id,
        overlappingTerritories: overlappingTerritories(subject.territories, other.territories),
        detail: `An open ${subject.kind} claim with the same endpoints already exists.`,
      });
    }
  }

  // 2. Two organizations claiming one brand. Verified-versus-verified is
  //    impossible (the partial unique), so what this catches in practice is the
  //    dispute BEFORE a decision: two live candidates naming different owners.
  if (subject.kind === 'organization_owns_brand' && subject.brandId !== null) {
    for (const other of others) {
      if (
        other.kind !== 'organization_owns_brand' ||
        other.brandId !== subject.brandId ||
        other.organizationId === subject.organizationId
      ) {
        continue;
      }
      if (!isLive(other, at) || !isLive(subject, at)) continue;
      conflicts.push({
        kind: 'contested_brand_ownership',
        relationshipId: subject.id,
        otherRelationshipId: other.id,
        overlappingTerritories: overlappingTerritories(subject.territories, other.territories),
        detail:
          `Organizations ${subject.organizationId} and ${other.organizationId} both claim ` +
          `brand ${subject.brandId}.`,
      });
    }
  }

  // 3. One merchant verified as BOTH a brand's own store and its authorized
  //    reseller in overlapping markets. Two different public labels for one
  //    seller-brand pair in one market cannot both be true, and a shopper shown
  //    either one would be told something the other contradicts.
  if (
    (subject.kind === 'merchant_official_channel_for_brand' ||
      subject.kind === 'merchant_authorized_reseller_for_brand') &&
    subject.merchantId !== null &&
    subject.brandId !== null
  ) {
    const opposite: RelationshipKind =
      subject.kind === 'merchant_official_channel_for_brand'
        ? 'merchant_authorized_reseller_for_brand'
        : 'merchant_official_channel_for_brand';
    for (const other of others) {
      if (
        other.kind !== opposite ||
        other.merchantId !== subject.merchantId ||
        other.brandId !== subject.brandId
      ) {
        continue;
      }
      if (!isLive(other, at) || !isLive(subject, at)) continue;
      const overlap = overlappingTerritories(subject.territories, other.territories);
      if (overlap.length === 0) continue;
      conflicts.push({
        kind: 'channel_and_reseller_overlap',
        relationshipId: subject.id,
        otherRelationshipId: other.id,
        overlappingTerritories: overlap,
        detail:
          `Merchant ${subject.merchantId} is claimed as both a direct channel and an ` +
          `authorized reseller for brand ${subject.brandId} in the same market.`,
      });
    }
  }

  // 4. A succeeds B while B succeeds A. Succession is a sequence; a cycle means
  //    at least one of the two rows is wrong and neither can be read forward.
  if (subject.kind === 'brand_succeeds_brand') {
    for (const other of others) {
      if (
        other.kind === 'brand_succeeds_brand' &&
        other.brandId === subject.relatedBrandId &&
        other.relatedBrandId === subject.brandId
      ) {
        conflicts.push({
          kind: 'succession_cycle',
          relationshipId: subject.id,
          otherRelationshipId: other.id,
          overlappingTerritories: [],
          detail: `Brands ${subject.brandId} and ${subject.relatedBrandId} each succeed the other.`,
        });
      }
    }
  }

  // 5. Verified, but nothing active is left holding it up. Revoking evidence
  //    never revokes the relationship (evidence rule 5) — this is how that stops
  //    being a silent state and becomes an operator decision.
  if (subject.status === 'verified') {
    const own = evidence.filter((row) => row.relationshipId === subject.id);
    if (own.length > 0 && own.every((row) => row.status !== 'active')) {
      conflicts.push({
        kind: 'verified_without_active_evidence',
        relationshipId: subject.id,
        otherRelationshipId: null,
        overlappingTerritories: [],
        detail: 'Every evidence row backing this verified claim is revoked or expired.',
      });
    }
  }

  // 6. Still marked verified with a window that has already closed. The public
  //    resolver already ignores it (it checks the window, not the status), so
  //    this is the operator's view of the same fact — and the reason the sweep
  //    is a convenience rather than a correctness requirement.
  if (subject.status === 'verified' && !isWithinWindow(subject, at)) {
    conflicts.push({
      kind: 'verified_past_validity',
      relationshipId: subject.id,
      otherRelationshipId: null,
      overlappingTerritories: [],
      detail: 'This claim is still marked verified while its validity window has closed.',
    });
  }

  return conflicts;
}

/** Live for conflict purposes: not a closed-out verdict, and inside its window. */
function isLive(row: ConflictCandidateRow, at: Date): boolean {
  if (row.status === 'rejected' || row.status === 'revoked' || row.status === 'expired') {
    return false;
  }
  return isWithinWindow(row, at);
}
