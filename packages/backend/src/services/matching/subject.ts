/**
 * What is being matched, and the ONE key that identifies it durably (#58).
 *
 * A native `product_variants` row and a `source_records` observation are the two
 * things this domain matches, and they are deliberately reduced to ONE shape
 * before the pipeline sees either. The pipeline then has no branch on where a
 * title came from — which is the only way the deterministic stages can be
 * genuinely identical for both, rather than identical-looking and subtly
 * divergent.
 *
 * ## `matchSubjectKey` is not the row id, and that is the point
 *
 * A source that re-publishes a product mints a NEW `source_records` row (the
 * content-hash unique, ADR 0002 D19). So a rejected pair recorded against an
 * observation id would evaporate on the next crawl and the matcher would propose
 * the same wrong merge again — exactly the failure #58 acceptance 4 forbids. The
 * subject key is therefore the STABLE identity of the thing observed:
 * `(source_id, external_type, external_id)` for an observation, the variant id
 * for a native variant. Blocked pairs, the queue's convergence unique and the
 * "every decision ever made about this thing" index all key on it.
 *
 * ## What a merchant SKU is allowed to do here
 *
 * Carried, recorded, and never compared across sources (#58 rule 6). It names a
 * row in one seller's system; two sellers using the same SKU string for
 * different products is ordinary, so a cross-source SKU comparison is a false
 * merge waiting for a coincidence. It appears on the subject so an operator
 * reviewing a decision can see it, and there is deliberately no feature that
 * reads it.
 */

import type { IdentifierScheme, MatchSubjectKind } from '@mercaria/shared-types';

/** One option assignment observed on the subject, already normalized. */
export interface MatchSubjectAttribute {
  /** The normalized axis key — `storage`, `color`, `pack_count`, `region`. */
  readonly key: string;
  /** The normalized value: a quantity's base-unit magnitude, or folded text. */
  readonly normalizedValue: string;
  /** What the source actually said, preserved for the operator trace. */
  readonly displayValue: string;
}

/** One identifier assertion observed on the subject, before validation. */
export interface MatchSubjectIdentifier {
  readonly scheme: IdentifierScheme;
  readonly rawValue: string;
}

/**
 * The normalized input to the pipeline.
 *
 * Optional fields are genuinely optional: a P2P listing declares no brand and no
 * category, and #58 rule 5 says a missing attribute REDUCES confidence rather
 * than being invented. Every one of them therefore arrives as `undefined` and
 * becomes a NULL feature, never a zero.
 */
export interface MatchSubject {
  readonly kind: MatchSubjectKind;
  /** The stable identity. Built by {@link matchSubjectKey}, never by a caller. */
  readonly key: string;
  /** Set exactly when `kind` is `source_record`. */
  readonly sourceRecordId?: string;
  /** Set exactly when `kind` is `native_variant`. */
  readonly productVariantId?: string;
  /** The listing this native variant belongs to; the offer seam needs it. */
  readonly listingId?: string;
  /** The seller's or source's own words for the product. */
  readonly title: string;
  /** The variant's own words — "256 GB, Black". Native side only. */
  readonly variantText?: string;
  /** The declared brand or vendor. Free text; a seller types whatever they like. */
  readonly brandText?: string;
  /** A declared model name or number, when the source has a field for one. */
  readonly modelText?: string;
  /** The taxonomy position, as a slug. Drives category-aware retrieval and the gate. */
  readonly categoryKey?: string;
  readonly identifiers: readonly MatchSubjectIdentifier[];
  /** Recorded and never compared across sources. See the note above. */
  readonly merchantSku?: string;
  readonly attributes: readonly MatchSubjectAttribute[];
  /** A used listing matches the same product and keeps its own condition (rule 8). */
  readonly condition?: 'new' | 'used';
}

/** The stable identity of a native variant. */
export function nativeVariantSubjectKey(productVariantId: string): string {
  return `native_variant:${productVariantId}`;
}

/**
 * The stable identity of an observed external object.
 *
 * The triple, not the observation id: `source_records` is append-only and mints
 * a new row per content change, so the row id names WHEN something was seen and
 * this names WHAT was seen.
 */
export function sourceObjectSubjectKey(input: {
  sourceId: string;
  externalType: string;
  externalId: string;
}): string {
  return `source_object:${input.sourceId}:${input.externalType}:${input.externalId}`;
}

/**
 * The subject key for whichever kind this is.
 *
 * Exhaustive by construction: the union has no common id field, so the compiler
 * forces the switch and neither branch can silently read the other's identity
 * (the `CommerceActor` device, ADR 0003 I1).
 */
export function matchSubjectKey(
  input:
    | { readonly kind: 'native_variant'; readonly productVariantId: string }
    | {
        readonly kind: 'source_record';
        readonly sourceId: string;
        readonly externalType: string;
        readonly externalId: string;
      },
): string {
  switch (input.kind) {
    case 'native_variant':
      return nativeVariantSubjectKey(input.productVariantId);
    case 'source_record':
      return sourceObjectSubjectKey(input);
  }
}
