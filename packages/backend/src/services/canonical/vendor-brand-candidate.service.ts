/**
 * `Listing.vendor` → brand CANDIDATES (#53 migration, ADR 0002 D23 phase 1).
 *
 * A SERVICE, not a data migration, and emphatically not a brand minter:
 *
 * - **No brand row is ever created here.** D23 is explicit — vendor strings
 *   become candidates "routed to review, never auto-minted brands". The
 *   deterministic rule set for automatic attachment is exact GTIN and exact
 *   connector identity, and a vendor string is neither. What this writes is
 *   PROVENANCE: one `source_records` row per candidate group under the
 *   registered backfill source, which is exactly the durable evidence #59's
 *   review tooling will read as its intake.
 * - **`listings.vendor` is never touched** — not rewritten, not cleared, not
 *   annotated (#53 migration rule 3). The one query against `listings` is a
 *   read-only aggregate.
 * - **Nothing becomes official.** No store, no relationship, no verification —
 *   the service never imports a store or relationship module at all (#53
 *   migration rule 4).
 * - **Re-runs converge.** The record's identity is
 *   `(source, 'brand', normalized-name, content-hash)`; an unchanged catalogue
 *   re-hashes identically and writes nothing. A changed catalogue (new vendor
 *   spelling, moved listing counts) is a genuinely new observation and appends.
 *
 * Grouping is CONSERVATIVE: exact equality of the normalized name, nothing
 * fuzzy (#53 migration rule 2). Anything doubtful — an un-normalizable value,
 * several distinct spellings collapsing together, a collision with an existing
 * brand or alias — is flagged `ambiguous` with named reasons. A clean group is
 * still only a candidate; "not ambiguous" means "review will be easy", never
 * "skip review".
 */

import { count, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import {
  ensureCatalogSource,
  recordSourceObservation,
} from '../../db/canonical/provenanceRepository.js';
import { findBrandIdsByNormalizedAlias, findBrandsByNormalizedName } from '../../db/canonical/brandRepository.js';
import { contentHashOf, type JsonValue } from './content-hash.js';
import { normalizeAliasLookup, normalizeEntityName } from './normalization.js';

/**
 * The backfill's own registry entry (ADR 0002 D19: the backfill is a source
 * like any other, so provenance has no "no source" special case). Vendor
 * strings are seller-entered free text: storable evidence, not display
 * material, hence `mayDisplay: false`.
 */
export const VENDOR_BACKFILL_SOURCE = {
  kind: 'backfill',
  name: 'mercaria:listing-vendor-backfill',
  mayDisplay: false,
  mayStore: true,
  attributionRequired: false,
  rightsNote:
    "Seller-entered `listings.vendor` free text, extracted as brand candidates for review. Never displayed as a brand fact.",
} as const;

/** Why a candidate group needs a closer look before any brand exists for it. */
export type VendorCandidateReviewReason =
  | 'unnormalizable_value'
  | 'multiple_display_forms'
  | 'matches_existing_brand'
  | 'matches_existing_alias';

/** One conservatively-grouped candidate — evidence for review, never a brand. */
export interface VendorBrandCandidate {
  /** `''` exactly when the group is `unnormalizable_value`. */
  normalizedName: string;
  /** Every distinct raw spelling in the group, sorted, verbatim. */
  displayForms: string[];
  /** How many listings carry one of those spellings. */
  listingCount: number;
  /** Existing brand ids the group collides with (name or alias) — sorted. */
  existingBrandIds: string[];
  ambiguous: boolean;
  reviewReasons: VendorCandidateReviewReason[];
}

export interface ExtractVendorBrandCandidatesResult {
  /** Distinct raw vendor strings seen. */
  totalVendorValues: number;
  candidates: VendorBrandCandidate[];
  /** Source records written this run. */
  recorded: number;
  /** Groups whose identical observation already existed — the converged re-run. */
  unchanged: number;
}

/**
 * Extract, group, flag, and durably record — see the module header for every
 * rule this deliberately does and does not follow.
 */
export async function extractVendorBrandCandidates(): Promise<ExtractVendorBrandCandidatesResult> {
  const db = getDb();

  const vendorRows = await db
    .select({ vendor: listings.vendor, listingCount: count() })
    .from(listings)
    .where(sql`${listings.vendor} is not null and btrim(${listings.vendor}) <> ''`)
    .groupBy(listings.vendor);

  // Conservative grouping: exact normalized equality, nothing fuzzy.
  const groups = new Map<string, { displayForms: Set<string>; listingCount: number }>();
  for (const row of vendorRows) {
    if (row.vendor === null) continue;
    const raw = row.vendor.trim();
    const key = normalizeEntityName(raw);
    const group = groups.get(key) ?? { displayForms: new Set<string>(), listingCount: 0 };
    group.displayForms.add(raw);
    group.listingCount += row.listingCount;
    groups.set(key, group);
  }

  const source = await ensureCatalogSource(db, VENDOR_BACKFILL_SOURCE);

  const candidates: VendorBrandCandidate[] = [];
  let recorded = 0;
  let unchanged = 0;

  for (const [normalizedName, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const displayForms = [...group.displayForms].sort();
    const reviewReasons: VendorCandidateReviewReason[] = [];

    if (normalizedName.length === 0) reviewReasons.push('unnormalizable_value');
    if (displayForms.length > 1) reviewReasons.push('multiple_display_forms');

    // A name collision with an existing brand is REVIEW input, never an
    // attachment: a matching name is not sufficient to connect two identities
    // (#53 identity rule 1), so the deterministic answer here is "a human
    // decides whether this is the same brand".
    const existingIds = new Set<string>();
    if (normalizedName.length > 0) {
      for (const brand of await findBrandsByNormalizedName(db, normalizedName)) {
        existingIds.add(brand.id);
      }
      if (existingIds.size > 0) reviewReasons.push('matches_existing_brand');

      const aliasMatchIds: string[] = [];
      for (const form of displayForms) {
        for (const id of await findBrandIdsByNormalizedAlias(db, normalizeAliasLookup(form))) {
          if (!existingIds.has(id)) aliasMatchIds.push(id);
          existingIds.add(id);
        }
      }
      if (aliasMatchIds.length > 0) reviewReasons.push('matches_existing_alias');
    }

    const candidate: VendorBrandCandidate = {
      normalizedName,
      displayForms,
      listingCount: group.listingCount,
      existingBrandIds: [...existingIds].sort(),
      ambiguous: reviewReasons.length > 0,
      reviewReasons,
    };
    candidates.push(candidate);

    // The durable evidence. Everything in the payload is derived from catalogue
    // CONTENT — no run timestamp, no random id — so an unchanged catalogue
    // re-hashes identically and the insert is a genuine no-op.
    const payload: JsonValue = {
      candidateKind: 'listing_vendor',
      normalizedName: candidate.normalizedName,
      displayForms: candidate.displayForms,
      listingCount: candidate.listingCount,
      existingBrandIds: candidate.existingBrandIds,
      ambiguous: candidate.ambiguous,
      reviewReasons: [...candidate.reviewReasons].sort(),
    };
    const externalId =
      normalizedName.length > 0
        ? normalizedName
        : `unnormalizable:${normalizeAliasLookup(displayForms[0] ?? '')}`;

    const { inserted } = await recordSourceObservation(db, {
      sourceId: source.id,
      externalType: 'brand',
      externalId,
      observedAt: new Date(),
      contentHash: contentHashOf(payload),
      payload,
    });
    if (inserted) recorded += 1;
    else unchanged += 1;
  }

  return {
    totalVendorValues: vendorRows.length,
    candidates,
    recorded,
    unchanged,
  };
}
