/**
 * The deterministic gate a SELLER's declared match passes through (#91 listing
 * creation 6, acceptance 4).
 *
 * ## The failure mode this exists for
 *
 * #58's header names it: the false merge looks exactly like a correct match,
 * contaminates every product page downstream, and is discovered by a customer. A
 * "Sell yours" flow is the most direct way to cause one — a person can attach
 * their listing to whatever product page they navigated from, and a marketplace
 * that took that on trust would let anybody put a counterfeit on a flagship
 * product's page by tapping a button.
 *
 * So a seller's declaration is EVIDENCE and not a verdict. It is compared
 * against the same pair-level facts #58's scorer compares — the subject's own
 * validated identifiers, the brand, the pack count, the bundle relation, the
 * category, and any pair an operator has already rejected — and a disagreement
 * REFUSES the attachment. The listing still publishes; it publishes unmatched,
 * which #91 requires to be a fully valid state anyway.
 *
 * ## What a seller's word IS enough for, and why the exemptions are not holes
 *
 * {@link SELLER_DECLARATION_EXEMPT_BLOCKERS} names six of #58's sixteen blockers
 * that do NOT refuse a declaration, and every one of them is a property of a
 * SCORER's uncertainty rather than a fact about the pair:
 *
 *  - `missing_required_attributes` — the axis is not absent, it was CHOSEN. #58
 *    raises this because a matcher must never invent which colour a listing is;
 *    a seller who selected the 256 GB variant on its own page invented nothing.
 *    Applying it would refuse nearly every declaration, which is the same shape
 *    as #58's own note that gating the identifier stages would leave a fresh
 *    deployment unable to attach a single barcode listing.
 *  - `category_gate_closed` — a benchmark measures how often the MATCHER is
 *    right in a category. A human declaration has no error rate that measurement
 *    could be about, which is #58's stated reason for exempting the identifier
 *    stages from the same gate.
 *  - `no_deterministic_support`, `below_auto_threshold`, `ambiguous_candidates`,
 *    `unresolved_product` — all four say "the scorer was not sure". Nobody
 *    scored this; a person stated it.
 *
 * The refusing set is derived by SUBTRACTION from `MATCH_BLOCKERS`, so a blocker
 * #58 adds later REFUSES by default. That direction is deliberate: the safe
 * failure for a new fact nobody has considered is to send the pair to a person.
 */

import { MATCH_BLOCKERS } from '@mercaria/shared-types';
import type { MatchBlocker, SellerMatchGateOutcome } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { normalizeEntityName } from '../canonical/normalization.js';
import type { MatchCandidateSource } from '../matching/candidate-source.js';
import { scoreVariantCandidate, type ScoringSubject } from '../matching/features.js';
import { PostgresCandidateSource } from '../matching/postgres-candidate-source.js';
import { detectRelation } from '../matching/relation-detection.js';
import { loadNativeVariantSubject } from '../matching/subject-loader.js';
import type { MatchSubject } from '../matching/subject.js';
import { normalizeTitle, titleTokens } from '../matching/text-similarity.js';

/**
 * The blockers a seller's own word overrides.
 *
 * Listed here and subtracted below, never listed the other way round — see this
 * module's header for why each is exempt and why the derivation runs in this
 * direction.
 */
export const SELLER_DECLARATION_EXEMPT_BLOCKERS: readonly MatchBlocker[] = [
  'missing_required_attributes',
  'category_gate_closed',
  'no_deterministic_support',
  'below_auto_threshold',
  'ambiguous_candidates',
  'unresolved_product',
];

/** Every blocker that REFUSES a seller-declared attachment. */
export const SELLER_DECLARATION_BLOCKERS: readonly MatchBlocker[] = MATCH_BLOCKERS.filter(
  (blocker) => !SELLER_DECLARATION_EXEMPT_BLOCKERS.includes(blocker),
);

/** What the gate was asked about. */
export interface SellerMatchGateInput {
  /** The native variant the listing already has — the gate runs at publication. */
  readonly productVariantId: string;
  readonly declaredCanonicalProductId: string;
  /**
   * The exact configuration the seller chose.
   *
   * REQUIRED, and its absence is answered by the readiness gate rather than
   * here: `native_listing_links` attaches a native variant to a canonical
   * VARIANT, so a product-only declaration has nothing to write. The flow asks
   * the seller to pick one before publication (`match_variant_missing`), because
   * picking one for them is precisely the invention #58 rule 5 forbids.
   */
  readonly declaredCanonicalVariantId: string;
  /**
   * The publication's own transaction.
   *
   * REQUIRED rather than defaulted, and this is load-bearing: the gate runs
   * against a variant the same transaction has just inserted, which is invisible
   * to any other connection. Defaulting to the pool would make every gate answer
   * `unmatched` — a silent, permanent refusal to attach anything, indistinguishable
   * from a catalogue with no matching products in it.
   */
  readonly db: DatabaseOrTransaction;
  /** Injectable so the gate is measurable against an in-memory catalogue. */
  readonly source?: MatchCandidateSource;
}

/**
 * Reduce a loaded subject to what the scorer reads.
 *
 * A narrower copy of the pipeline's own `prepareSubject`, and deliberately not a
 * call into it: that function is private to `pipeline.ts` and prepares a subject
 * for a five-stage RETRIEVAL this gate does not run. What is shared is the thing
 * that must not diverge — `scoreVariantCandidate`, `detectRelation`,
 * `normalizeEntityName`, `titleTokens` — so the pair-level facts the gate reads
 * are byte-identical to the ones #58's own decision reads.
 */
function scoringSubjectFor(
  subject: MatchSubject,
  gtins: readonly string[],
  identifierTargets: ReadonlySet<string>,
): ScoringSubject {
  const attributes = new Map<string, string>();
  for (const attribute of subject.attributes) {
    attributes.set(attribute.key, attribute.normalizedValue);
  }
  const declaredPackCount = (() => {
    const raw = attributes.get('pack_count');
    if (raw === undefined) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  })();

  const rawTitle =
    subject.variantText === undefined ? subject.title : `${subject.title} ${subject.variantText}`;
  const brand = subject.brandText === undefined ? '' : normalizeEntityName(subject.brandText);
  const model = subject.modelText === undefined ? '' : subject.modelText.trim();

  return {
    normalizedBrand: brand.length > 0 ? brand : null,
    normalizedModel: model.length > 0 ? model : null,
    normalizedNameForMatch: normalizeEntityName(rawTitle),
    titleTokens: titleTokens(rawTitle),
    categoryKey: subject.categoryKey ?? null,
    attributes,
    relation: detectRelation({
      title: subject.title,
      ...(subject.variantText === undefined ? {} : { variantText: subject.variantText }),
      declaredPackCount,
    }).relation,
    gtins,
    identifierTargets,
  };
}

/**
 * Decide whether a seller's declaration may be written as an attachment.
 *
 * Returns `unmatched` — never a refusal — when there is nothing to attach TO:
 * the variant is gone, the canonical rows are gone, or the subject could not be
 * loaded. A refusal means "somebody must look at this", and a vanished row is
 * not something a reviewer can do anything about.
 */
export async function evaluateSellerDeclaredMatch(
  input: SellerMatchGateInput,
): Promise<SellerMatchGateOutcome> {
  const source = input.source ?? new PostgresCandidateSource(input.db);

  const subject = await loadNativeVariantSubject(input.productVariantId, input.db);
  if (subject === null) return { state: 'unmatched' };

  const [products, variants] = await Promise.all([
    source.loadProducts([input.declaredCanonicalProductId]),
    source.loadVariantsByIds([input.declaredCanonicalVariantId]),
  ]);
  const product = products.find((row) => row.productId === input.declaredCanonicalProductId);
  const variant = variants.find((row) => row.variantId === input.declaredCanonicalVariantId);
  if (!product || !variant) return { state: 'unmatched' };

  // A variant that belongs to another product is not a mismatch to review — it
  // is a request that does not describe anything. Refusing it as `unmatched`
  // would hide a client bug; naming the category disagreement would be a
  // fabricated reason, so this is the one shape answered with `unresolved_product`.
  if (variant.productId !== product.productId) {
    return {
      state: 'refused',
      blockers: ['unresolved_product'],
      reasonCodes: ['declared_variant_belongs_to_another_product'],
    };
  }

  const resolved = await source.resolveSubjectIdentifiers(subject);
  const gtins: string[] = [];
  const identifierTargets = new Set<string>();
  const conflictingIdentifiers: string[] = [];

  for (const identifier of resolved) {
    if (identifier.resolution.kind === 'invalid') continue;
    if (identifier.globallyUnique && identifier.label.startsWith('gtin:')) {
      gtins.push(identifier.label.slice('gtin:'.length));
    }
    if (identifier.resolution.kind === 'resolved' && identifier.resolution.grain === 'variant') {
      identifierTargets.add(identifier.resolution.id);
      /**
       * The core false-merge guard, and the reason it is stated here rather than
       * left to the scorer: a VALID, globally unique identifier on the seller's
       * own listing that resolves to a different canonical variant outranks
       * anything a person typed or tapped. A barcode is the manufacturer saying
       * what the object is.
       *
       * Brand-scoped identifiers are excluded on purpose: an MPN collides across
       * brands legitimately (ADR 0002 D14), so a disagreement there is not
       * evidence of anything, which is exactly why #58 gives them their own
       * stage rather than treating a collision as a dispute.
       */
      if (
        identifier.globallyUnique &&
        !identifier.requiresBrandScope &&
        identifier.resolution.id !== input.declaredCanonicalVariantId
      ) {
        conflictingIdentifiers.push(identifier.label);
      }
    }
  }

  const blocks = await source.findOpenBlocks(subject.key);
  const { blockers: pairBlockers } = scoreVariantCandidate({
    subject: scoringSubjectFor(subject, [...new Set(gtins)].sort(), identifierTargets),
    product,
    variant,
    candidateTitleTokens: titleTokens(`${product.name} ${variant.name ?? ''}`),
    // The scorer only uses this to decide whether a title similarity is worth
    // reporting; it produces no blocker, and this gate never reads a similarity.
    minTitleSimilarity: 0,
  });

  const refusing = new Set<MatchBlocker>(
    pairBlockers.filter((blocker) => SELLER_DECLARATION_BLOCKERS.includes(blocker)),
  );
  if (conflictingIdentifiers.length > 0) refusing.add('conflicting_identifier');
  if (
    blocks.variantIds.has(input.declaredCanonicalVariantId) ||
    blocks.productIds.has(input.declaredCanonicalProductId)
  ) {
    refusing.add('blocked_pair');
  }

  if (refusing.size > 0) {
    return {
      state: 'refused',
      blockers: [...refusing].sort(),
      reasonCodes: [
        'seller_declared_match',
        ...conflictingIdentifiers,
        // `normalizeTitle` is what the operator trace shows beside a decision,
        // so the refusal carries the same normalized form #58 stored.
        `normalized_title:${normalizeTitle(subject.title)}`,
      ],
    };
  }

  return {
    state: 'attach',
    canonicalProductId: input.declaredCanonicalProductId,
    canonicalVariantId: input.declaredCanonicalVariantId,
  };
}
