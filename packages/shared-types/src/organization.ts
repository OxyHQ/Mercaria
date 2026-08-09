/**
 * Canonical Organization and Brand DTOs (ADR 0002 D1/D12/D16, #53).
 *
 * An ORGANIZATION is the accountable actor — it can own brands, operate
 * merchants, be verified against a legal register (Apple Inc.). A BRAND is a
 * consumer-facing mark products are marketed under (Apple) — never a seller,
 * never a legal entity. They are separate types because the relationship is
 * many-to-many over time; nothing here carries a `company` field on a brand or
 * infers ownership from name equality (ADR 0002 D1 forbids both).
 *
 * The DTOs in this file are the PUBLIC read projections: verified facts plus
 * safe source freshness only. Internal review state, link confidences, match
 * rules and source ids never appear here — a serializer cannot leak what the
 * type does not carry.
 */

import type { SourceFreshness } from './provenance';

/**
 * Lifecycle of a canonical entity (organization or brand).
 *
 * `merged` rows are tombstones: they survive forever, keep their slug (never
 * reused) and point at their winner via `mergedIntoId` — resolution follows the
 * pointer, flattened on write so chains do not grow (ADR 0002 D12/D16).
 * `suppressed` is the operator's "do not show" without destroying anything.
 */
export type CanonicalEntityStatus = 'active' | 'inactive' | 'merged' | 'suppressed';

export const CANONICAL_ENTITY_STATUSES: readonly CanonicalEntityStatus[] = [
  'active',
  'inactive',
  'merged',
  'suppressed',
];

/**
 * Why an alias exists (ADR 0002 D16). Aliases resolve TO an entity and are
 * search input, never identity — source aliases are kept even after a canonical
 * name is selected.
 */
export type CanonicalAliasKind =
  | 'name_variant'
  | 'former_name'
  | 'localized_name'
  | 'marketing_name'
  | 'misspelling';

export const CANONICAL_ALIAS_KINDS: readonly CanonicalAliasKind[] = [
  'name_variant',
  'former_name',
  'localized_name',
  'marketing_name',
  'misspelling',
];

/** One alternate or historical name that resolves to a canonical entity. */
export interface CanonicalAlias {
  /** The alias exactly as observed — original display form, never normalized away. */
  alias: string;
  kind: CanonicalAliasKind;
  /** BCP-47 language tag for a `localized_name`, when known. */
  language?: string;
}

/** The public read projection of an organization. */
export interface Organization {
  id: string;
  /** URL-safe canonical handle; unique forever, never reused after a merge. */
  slug: string;
  status: CanonicalEntityStatus;
  /** Canonical display name — the original form, never a normalization. */
  name: string;
  /** Legal or operating name, when known (e.g. "Apple Inc."). */
  legalName?: string;
  websiteUrl?: string;
  /**
   * Domains VERIFIED for this organization. Verification is evidence-backed
   * (ADR 0002 D10/D17) — a domain observed in a feed never lands here, and a
   * domain match alone never proves ownership.
   */
  verifiedDomains: string[];
  /** ISO 3166-1 alpha-2 home country/market, when known. */
  countryCode?: string;
  /** Oxy media file id of the logo; resolve through the canonical media chokepoint. */
  logoFileId?: string;
  /** Alternate and historical names, original display forms preserved. */
  aliases: CanonicalAlias[];
  /** Set exactly when `status` is `merged` — the redirect target. */
  mergedIntoId?: string;
  /** ISO-8601 time Mercaria first saw evidence of this organization. */
  firstSeenAt: string;
  /** ISO-8601 time of the most recent supporting observation. */
  lastSeenAt?: string;
  /** Safe freshness of the most recent source observation, when any exists. */
  freshness?: SourceFreshness;
  createdAt: string;
  updatedAt: string;
}

/** The public read projection of a brand. */
export interface Brand {
  id: string;
  /** URL-safe canonical handle; unique forever, never reused after a merge. */
  slug: string;
  status: CanonicalEntityStatus;
  /** Canonical display name — the original form, never a normalization. */
  name: string;
  description?: string;
  websiteUrl?: string;
  /**
   * Domains OBSERVED for this brand. Observations, not ownership proof
   * (#53 brand rule 5) — organization ownership is proven only through
   * evidence-backed relationships (#55).
   */
  observedDomains: string[];
  /** Oxy media file id of the logo; resolve through the canonical media chokepoint. */
  logoFileId?: string;
  /** Alternate and historical names, original display forms preserved. */
  aliases: CanonicalAlias[];
  /** Set exactly when `status` is `merged` — the redirect target. */
  mergedIntoId?: string;
  /**
   * Derived counts, maintained by the canonical catalogue and offer chokepoints
   * once #56/#57 land. Until then they are 0 — a seam, not an invention.
   */
  productCount: number;
  activeOfferCount: number;
  /** ISO-8601 time Mercaria first saw evidence of this brand. */
  firstSeenAt: string;
  /** ISO-8601 time of the most recent supporting observation. */
  lastSeenAt?: string;
  /** Safe freshness of the most recent source observation, when any exists. */
  freshness?: SourceFreshness;
  createdAt: string;
  updatedAt: string;
}

/**
 * The answer to a reverse lookup (alias, source id or domain) — one canonical
 * id or an EXPLICIT ambiguity result, never a silent first-match (#53
 * acceptance 3). `candidateIds` preserves every distinct canonical target so an
 * ambiguous result is actionable rather than merely refused.
 */
export type AliasResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'none' };
