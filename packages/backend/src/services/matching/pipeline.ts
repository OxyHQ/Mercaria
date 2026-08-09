/**
 * The ordered matching pipeline (#58 pipeline 1–8).
 *
 * One exported function, {@link evaluateMatch}, which is a pure function of a
 * subject, a policy and a {@link MatchCandidateSource}. It reads nothing else —
 * no clock, no request, no database — which is what lets the labelled benchmark
 * measure the SAME code production runs, at a speed that keeps the measurement
 * in CI (see `benchmark/`).
 *
 * ## The order IS the decision procedure
 *
 * Each stage runs only when every stage above it produced nothing, so a
 * deterministic identifier always beats a normalized-name agreement, which
 * always beats a title similarity. `decidedStage` on the stored decision names
 * which one answered, which is what makes "why did this match" answerable
 * without re-running anything against a catalogue that has since moved.
 *
 * 1. **`existing_source_link`** — this exact object is already attached. The
 *    cheapest correct answer, and the reason re-evaluating a whole catalogue
 *    after a policy change is affordable.
 * 2. **`global_identifier`** — a validated GTIN/ISBN with exactly one active
 *    canonical owner.
 * 3. **`brand_scoped_identifier`** — an MPN or model number, under an AGREEING
 *    brand. MPNs collide across brands legitimately (ADR 0002 D14), which is
 *    precisely why the brand check is the stage rather than a bonus.
 * 4. **`normalized_attributes`** — normalized brand + model + axis agreement.
 * 5. **`candidate_retrieval`** — category-aware title/attribute retrieval.
 * 6. **`semantic_assist`** — a rerank of what stage 5 already found. Never a
 *    source of candidates.
 *
 * ## Product identity before variant identity (#58 rule 1)
 *
 * Stages 2–5 resolve a PRODUCT. Only then are that product's variants scored,
 * and a decision that resolved a product and could not choose a variant is a
 * real, recorded state — `matched_canonical_product_id` set,
 * `matched_canonical_variant_id` NULL, blocker `missing_required_attributes`.
 * That is the ordinary outcome for a listing that never said which colour it
 * was, and inventing one would be the invention rule 5 forbids.
 *
 * ## Every stage runs with semantics disabled
 *
 * Stages 1–5 make no call into `semantic.ts` at all. `pipeline-deterministic`
 * in `__tests__` runs the entire dataset with all three levers off and asserts
 * the decisions are byte-identical to the ones the default deployment produces,
 * which is #58 acceptance 6 measured rather than asserted.
 */

import type {
  MatchBlocker,
  MatchOutcome,
  MatchReasonCode,
  MatchStage,
} from '@mercaria/shared-types';
import { normalizeEntityName } from '../canonical/normalization.js';
import type {
  CandidateProduct,
  CandidateVariant,
  MatchCandidateSource,
  ResolvedSubjectIdentifier,
} from './candidate-source.js';
import { scoreVariantCandidate, type ScoringSubject } from './features.js';
import { decideOutcome, type MatchPolicy, type ScoredCandidate } from './policy.js';
import { detectRelation, type SubjectRelation } from './relation-detection.js';
import { resolveSemanticScorer, scoreSemantically } from './semantic.js';
import type { MatchSubject } from './subject.js';
import { discriminatingTokens, normalizeTitle, titleTokens } from './text-similarity.js';

/** The complete, storable result of one evaluation. */
export interface MatchEvaluation {
  readonly outcome: MatchOutcome;
  readonly decidedStage: MatchStage;
  readonly confidence: number | null;
  readonly matchedCanonicalProductId: string | null;
  readonly matchedCanonicalVariantId: string | null;
  readonly reasonCodes: readonly MatchReasonCode[];
  readonly blockers: readonly MatchBlocker[];
  readonly positiveIdentifiers: readonly string[];
  readonly conflictingIdentifiers: readonly string[];
  readonly normalizedBrand: string | null;
  readonly normalizedModel: string | null;
  readonly normalizedTitle: string;
  readonly categoryKey: string | null;
  readonly candidates: readonly ScoredCandidate[];
}

/** Dedupe while keeping the literal union — a bare `Set` widens it to `string`. */
function dedupeReasons(codes: readonly MatchReasonCode[]): MatchReasonCode[] {
  return [...new Set(codes)];
}

/** The subject reduced to the form every stage reads. */
interface PreparedSubject {
  readonly scoring: ScoringSubject;
  readonly normalizedTitle: string;
  /** The whole title in `normalizeEntityName` space. See {@link prepareSubject}. */
  readonly normalizedNameForMatch: string;
  readonly relation: SubjectRelation;
}

function prepareSubject(subject: MatchSubject): PreparedSubject {
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

  const relation = detectRelation({
    title: subject.title,
    ...(subject.variantText === undefined ? {} : { variantText: subject.variantText }),
    declaredPackCount,
  });

  const brand =
    subject.brandText === undefined ? '' : normalizeEntityName(subject.brandText);
  const model = subject.modelText === undefined ? '' : subject.modelText.trim();

  const rawTitle =
    subject.variantText === undefined ? subject.title : `${subject.title} ${subject.variantText}`;

  return {
    normalizedTitle: normalizeTitle(rawTitle),
    /**
     * The stage-4 comparison key, in `normalizeEntityName` space — which is the
     * space `canonical_products.normalized_name` is MAINTAINED in by
     * `canonical-product.service`.
     *
     * Deliberately NOT the stopword-stripped token join: those are two different
     * normalizations, and comparing one against the other means stage 4 never
     * fires for any product whose name contains "de", "para" or "of". Measured:
     * it never fired for the Spanish half of the fixture catalogue.
     */
    normalizedNameForMatch: normalizeEntityName(rawTitle),
    relation: relation.relation,
    scoring: {
      normalizedBrand: brand.length > 0 ? brand : null,
      normalizedModel: model.length > 0 ? model : null,
      normalizedNameForMatch: normalizeEntityName(rawTitle),
      titleTokens: titleTokens(
        subject.variantText === undefined
          ? subject.title
          : `${subject.title} ${subject.variantText}`,
      ),
      categoryKey: subject.categoryKey ?? null,
      attributes,
      relation: relation.relation,
      gtins: [],
      identifierTargets: new Set<string>(),
    },
  };
}

/** The identifier picture: what validated, what resolved, and what disagrees. */
interface IdentifierPicture {
  readonly gtins: readonly string[];
  readonly variantTargets: ReadonlySet<string>;
  readonly productTargets: ReadonlySet<string>;
  readonly positiveLabels: readonly string[];
  /** Non-empty ⇒ the SUBJECT contradicts itself or names a disputed identifier. */
  readonly selfConflictLabels: readonly string[];
  /** Brand-scoped candidates, kept SEPARATE by grain: an MPN names a variant. */
  readonly brandScopedVariantTargets: ReadonlySet<string>;
  readonly brandScopedProductTargets: ReadonlySet<string>;
  readonly sawAnyIdentifier: boolean;
}

/**
 * Reduce the resolved identifiers to the four facts the stages need.
 *
 * The self-conflict rule is the "source errors and conflicting data" case the
 * evaluation dataset names: a subject asserting two VALID globally-unique
 * identifiers that resolve to two different canonical variants is a source that
 * is wrong about something, and the pipeline must not pick one of them. An
 * INVALID identifier is not a conflict — a mistyped GTIN is evidence somebody
 * typed it wrong, never evidence the product is something else — so it is
 * silently dropped, exactly as `normalizeIdentifier` refuses it.
 */
function readIdentifiers(resolved: readonly ResolvedSubjectIdentifier[]): IdentifierPicture {
  const gtins: string[] = [];
  const variantTargets = new Set<string>();
  const productTargets = new Set<string>();
  const brandScopedVariantTargets = new Set<string>();
  const brandScopedProductTargets = new Set<string>();
  const positiveLabels: string[] = [];
  const selfConflictLabels: string[] = [];
  let sawAnyIdentifier = false;

  for (const identifier of resolved) {
    if (identifier.resolution.kind === 'invalid') continue;
    sawAnyIdentifier = true;
    if (identifier.globallyUnique && identifier.label.startsWith('gtin:')) {
      gtins.push(identifier.label.slice('gtin:'.length));
    }

    switch (identifier.resolution.kind) {
      case 'resolved': {
        positiveLabels.push(identifier.label);
        const target = identifier.resolution.id;
        if (identifier.requiresBrandScope) {
          (identifier.resolution.grain === 'variant'
            ? brandScopedVariantTargets
            : brandScopedProductTargets
          ).add(target);
        } else if (identifier.resolution.grain === 'variant') {
          variantTargets.add(target);
        } else {
          productTargets.add(target);
        }
        break;
      }
      case 'conflict': {
        /**
         * A conflict means two different things depending on the SCHEME, and
         * collapsing them is how brand scoping stops being scoping.
         *
         * A GLOBALLY UNIQUE identifier has ONE active canonical owner by partial
         * unique index, so a conflict on it is a DISPUTE somebody has to settle
         * (#59's) — the subject goes to a person and no stage below improves on
         * that.
         *
         * A BRAND-SCOPED one collides across brands LEGITIMATELY (ADR 0002 D14
         * gives MPN no database uniqueness for exactly this reason), so a
         * conflict is not a dispute at all: it is a candidate SET, and stage 3
         * resolves it with the brand agreement that makes the number mean
         * something. Treating it as a dispute would send every colliding MPN to
         * review; treating a disputed GTIN as a candidate set would let the
         * matcher pick a side of an argument nobody has settled.
         */
        if (identifier.requiresBrandScope) {
          positiveLabels.push(identifier.label);
          const targets =
            identifier.resolution.grain === 'variant'
              ? brandScopedVariantTargets
              : brandScopedProductTargets;
          targets.add(identifier.resolution.ownerId);
          for (const disputed of identifier.resolution.disputedIds) targets.add(disputed);
        } else {
          selfConflictLabels.push(identifier.label);
        }
        break;
      }
      case 'none':
        break;
    }
  }

  // Two valid globally-unique identifiers naming two different trade items.
  if (variantTargets.size > 1) {
    selfConflictLabels.push(...[...variantTargets].sort().map((id) => `variant:${id}`));
  }

  return {
    gtins: [...new Set(gtins)].sort(),
    variantTargets,
    productTargets,
    brandScopedVariantTargets,
    brandScopedProductTargets,
    positiveLabels: [...new Set(positiveLabels)].sort(),
    selfConflictLabels: [...new Set(selfConflictLabels)].sort(),
    sawAnyIdentifier,
  };
}

/** The canonical text a candidate is compared against. */
function candidateTokens(product: CandidateProduct, variant: CandidateVariant): string[] {
  const variantName = variant.name === null ? '' : variant.name;
  return titleTokens(`${product.name} ${variantName}`);
}

/**
 * Score every variant of the resolved products, and hand the set to the policy.
 *
 * Called once, from ONE place, whichever stage produced the products. That is
 * why a decision from stage 2 and a decision from stage 5 carry comparable
 * feature values: they went through the same scorer over the same features, and
 * only `decidedStage` and the confidence rule differ.
 */
async function scoreProducts(input: {
  readonly prepared: PreparedSubject;
  readonly products: readonly CandidateProduct[];
  readonly variants: readonly CandidateVariant[];
  readonly policy: MatchPolicy;
  readonly blockedProductIds: ReadonlySet<string>;
  readonly blockedVariantIds: ReadonlySet<string>;
  readonly semanticScores: ReadonlyMap<string, number>;
}): Promise<ScoredCandidate[]> {
  const productsById = new Map(input.products.map((product) => [product.productId, product]));
  const scored: ScoredCandidate[] = [];

  for (const variant of input.variants) {
    const product = productsById.get(variant.productId);
    if (!product) continue;

    const semantic = input.semanticScores.get(variant.variantId);
    const { features, blockers } = scoreVariantCandidate({
      subject: input.prepared.scoring,
      product,
      variant,
      candidateTitleTokens: candidateTokens(product, variant),
      minTitleSimilarity: input.policy.minTitleSimilarity,
      ...(semantic === undefined ? {} : { semanticSimilarity: semantic }),
    });

    // A blocked pair is REMOVED from the running rather than blocking the
    // decision: an operator rejected (this subject, that product), and said
    // nothing whatsoever about the other candidates. Blocking the decision would
    // turn one person's correction into a permanent refusal to match anything.
    const blocked =
      input.blockedVariantIds.has(variant.variantId) ||
      input.blockedProductIds.has(product.productId);

    scored.push({
      canonicalProductId: product.productId,
      canonicalVariantId: variant.variantId,
      features,
      blockers,
      rejection: blocked ? 'blocked_pair' : null,
      score: 0,
    });
  }
  return scored;
}

/** Attach the policy's confidence to each candidate as its comparable score. */
function withScores(candidates: readonly ScoredCandidate[], policy: MatchPolicy): ScoredCandidate[] {
  return candidates.map((candidate) => {
    let weighted = 0;
    let total = 0;
    for (const [name, weight] of Object.entries(policy.weights)) {
      const value = candidate.features[name as keyof typeof candidate.features];
      if (value === undefined || value === null || weight <= 0) continue;
      weighted += weight * value;
      total += weight;
    }
    return { ...candidate, score: total === 0 ? 0 : Math.min(1, Math.max(0, weighted / total)) };
  });
}

/**
 * Evaluate one subject.
 *
 * @param subject The thing being matched, already normalized by its loader.
 * @param policy The ACTIVE policy version. Its id is stored on the decision, so
 *   an outcome is always attributable to the rule that produced it.
 * @param source The read-only port. Everything the pipeline knows comes through
 *   it, which is what makes this function testable without a database.
 */
export async function evaluateMatch(
  subject: MatchSubject,
  policy: MatchPolicy,
  source: MatchCandidateSource,
): Promise<MatchEvaluation> {
  const prepared = prepareSubject(subject);
  const reasonCodes: MatchReasonCode[] = [];
  const decisionBlockers: MatchBlocker[] = [];

  const blocks = await source.findOpenBlocks(subject.key);
  const categoryAutomatic = await source.isCategoryAutomatic({
    policyVersionId: policy.id,
    categoryKey: prepared.scoring.categoryKey,
  });

  if (subject.merchantSku !== undefined && subject.merchantSku.length > 0) {
    // Recorded so a reviewer can see it; never compared. #58 rule 6.
    reasonCodes.push('sku_scoped_to_source');
  }
  if (subject.condition === 'used') reasonCodes.push('used_condition_preserved');

  const emptyResult = (
    stage: MatchStage,
    outcome: MatchOutcome,
    extraReasons: readonly MatchReasonCode[],
  ): MatchEvaluation => ({
    outcome,
    decidedStage: stage,
    confidence: null,
    matchedCanonicalProductId: null,
    matchedCanonicalVariantId: null,
    reasonCodes: dedupeReasons([...reasonCodes, ...extraReasons, ...decisionBlockers]),
    blockers: [...new Set(decisionBlockers)],
    positiveIdentifiers: [],
    conflictingIdentifiers: [],
    normalizedBrand: prepared.scoring.normalizedBrand,
    normalizedModel: prepared.scoring.normalizedModel,
    normalizedTitle: prepared.normalizedTitle,
    categoryKey: prepared.scoring.categoryKey,
    candidates: [],
  });

  // ── Stage 1: the attachment that already exists ────────────────────────────
  const existing = await source.findExistingAttachment(subject);
  if (existing !== null && !blocks.variantIds.has(existing.canonicalVariantId)) {
    return {
      outcome: 'automatic_match',
      decidedStage: 'existing_source_link',
      confidence: null,
      matchedCanonicalProductId: existing.canonicalProductId,
      matchedCanonicalVariantId: existing.canonicalVariantId,
      reasonCodes: dedupeReasons([...reasonCodes, 'existing_link_reused']),
      blockers: [],
      positiveIdentifiers: [],
      conflictingIdentifiers: [],
      normalizedBrand: prepared.scoring.normalizedBrand,
      normalizedModel: prepared.scoring.normalizedModel,
      normalizedTitle: prepared.normalizedTitle,
      categoryKey: prepared.scoring.categoryKey,
      candidates: [],
    };
  }

  // ── Identifier resolution, feeding stages 2 and 3 ──────────────────────────
  const identifiers = readIdentifiers(await source.resolveSubjectIdentifiers(subject));
  if (!identifiers.sawAnyIdentifier) reasonCodes.push('no_identifier_present');

  const scoringSubject: ScoringSubject = {
    ...prepared.scoring,
    gtins: identifiers.gtins,
    identifierTargets: identifiers.variantTargets,
  };
  const preparedWithIdentifiers: PreparedSubject = { ...prepared, scoring: scoringSubject };

  if (identifiers.selfConflictLabels.length > 0) {
    // The subject's own identifiers disagree, or one of them is disputed. No
    // stage below can improve on that, and picking a side would be the false
    // merge this whole domain exists to prevent.
    decisionBlockers.push('conflicting_identifier');
    return {
      ...emptyResult('global_identifier', 'manual_review', []),
      conflictingIdentifiers: identifiers.selfConflictLabels,
      positiveIdentifiers: identifiers.positiveLabels,
    };
  }

  /** Run the shared scoring + policy tail for a resolved product set. */
  const finish = async (
    stage: MatchStage,
    productIds: readonly string[],
    stageReasons: readonly MatchReasonCode[],
    semanticScores: ReadonlyMap<string, number>,
  ): Promise<MatchEvaluation> => {
    const products = await source.loadProducts(productIds);
    if (products.length === 0) return emptyResult(stage, 'create_new', ['no_candidate_found']);
    const variants = await source.loadVariants(products.map((product) => product.productId));

    const scored = withScores(
      await scoreProducts({
        prepared: preparedWithIdentifiers,
        products,
        variants,
        policy,
        blockedProductIds: blocks.productIds,
        blockedVariantIds: blocks.variantIds,
        semanticScores,
      }),
      policy,
    );

    const decision = decideOutcome(scored, policy, {
      stage,
      decisionBlockers,
      reasonCodes: [...reasonCodes, ...stageReasons],
      categoryAutomatic,
    });

    const selected = decision.selected;
    // A product resolved but no variant chosen is a real outcome (rule 1); the
    // selected candidate always names both, so this reads the pair off it.
    const matchedProductId = selected === null ? null : selected.canonicalProductId;
    const matchedVariantId =
      selected === null || decision.outcome === 'create_new' ? null : selected.canonicalVariantId;

    // `conflicting_identifiers` is populated EXACTLY when the blocker is
    // present. The column's CHECK enforces one direction (values imply the
    // blocker); computing it here from the final blocker set is what keeps the
    // other direction true, so the audit array and the outcome cannot disagree.
    const conflicting = decision.blockers.includes('conflicting_identifier')
      ? identifiers.gtins.map((gtin) => `gtin:${gtin}`)
      : [];

    return {
      outcome: decision.outcome,
      decidedStage: stage,
      confidence: decision.confidence,
      matchedCanonicalProductId: decision.outcome === 'create_new' ? null : matchedProductId,
      matchedCanonicalVariantId: matchedVariantId,
      reasonCodes: decision.reasonCodes,
      blockers: decision.blockers,
      positiveIdentifiers:
        decision.outcome === 'create_new' ? [] : identifiers.positiveLabels,
      conflictingIdentifiers: conflicting,
      normalizedBrand: prepared.scoring.normalizedBrand,
      normalizedModel: prepared.scoring.normalizedModel,
      normalizedTitle: prepared.normalizedTitle,
      categoryKey: prepared.scoring.categoryKey,
      candidates: scored,
    };
  };

  // ── Stage 2: a validated, globally unique identifier ───────────────────────
  if (identifiers.variantTargets.size === 1 || identifiers.productTargets.size > 0) {
    const targetVariants = await source.loadVariantsByIds([...identifiers.variantTargets]);
    const productIds = [
      ...new Set([
        ...targetVariants.map((variant) => variant.productId),
        ...identifiers.productTargets,
      ]),
    ];
    if (productIds.length > 0) {
      return await finish('global_identifier', productIds, ['gtin_exact_match'], new Map());
    }
  }

  // ── Stage 3: a brand-scoped MPN or model number ────────────────────────────
  if (
    identifiers.brandScopedVariantTargets.size > 0 ||
    identifiers.brandScopedProductTargets.size > 0
  ) {
    const targetVariants = await source.loadVariantsByIds([
      ...identifiers.brandScopedVariantTargets,
    ]);
    const productIds = [
      ...new Set([
        ...targetVariants.map((variant) => variant.productId),
        ...identifiers.brandScopedProductTargets,
      ]),
    ];
    const products = await source.loadProducts(productIds);
    // The brand agreement IS the stage. An MPN collides across brands
    // legitimately (ADR 0002 D14), so an MPN whose owner's brand disagrees with
    // the subject's is not a weaker match — it is a different manufacturer's
    // part that happens to share a number.
    const agreeing = products.filter(
      (product) =>
        prepared.scoring.normalizedBrand !== null &&
        product.brandNames.includes(prepared.scoring.normalizedBrand),
    );
    if (agreeing.length > 0) {
      return await finish(
        'brand_scoped_identifier',
        agreeing.map((product) => product.productId),
        ['mpn_brand_scoped_match', 'brand_agreed'],
        new Map(),
      );
    }
  }

  // ── Stage 4: normalized brand, model and axis agreement ────────────────────
  const normalizedNameIds = await source.retrieveByNormalizedName({
    normalizedName: prepared.normalizedNameForMatch,
    limit: policy.maxCandidates,
  });
  if (normalizedNameIds.length > 0) {
    return await finish('normalized_attributes', normalizedNameIds, ['model_name_exact'], new Map());
  }

  // ── Stage 5: category-aware title and attribute retrieval ──────────────────
  const tokens = prepared.scoring.titleTokens;
  const retrieved = await source.retrieveByTitle({
    normalizedTitle: prepared.normalizedTitle,
    titleTokens: tokens,
    discriminatingTokens: discriminatingTokens(tokens),
    normalizedBrand: prepared.scoring.normalizedBrand,
    categoryKey: prepared.scoring.categoryKey,
    limit: policy.maxCandidates,
  });
  if (retrieved.length === 0) {
    return emptyResult('no_candidate', 'create_new', ['no_candidate_found']);
  }

  // ── Stage 6: the OPTIONAL semantic rerank ──────────────────────────────────
  const scorer = resolveSemanticScorer(policy.semanticEnabled);
  if (scorer === null) {
    return await finish(
      'candidate_retrieval',
      retrieved,
      ['title_candidate_retrieved', 'semantic_disabled'],
      new Map(),
    );
  }

  const products = await source.loadProducts(retrieved);
  const variants = await source.loadVariants(products.map((product) => product.productId));
  const productsById = new Map(products.map((product) => [product.productId, product]));
  const texts = new Map<string, string>();
  for (const variant of variants) {
    const product = productsById.get(variant.productId);
    if (!product) continue;
    texts.set(variant.variantId, `${product.name} ${variant.name === null ? '' : variant.name}`.trim());
  }

  const semanticScores = await scoreSemantically(scorer, {
    subjectTitle: subject.title,
    subjectBrand: prepared.scoring.normalizedBrand,
    candidates: texts,
  });

  return await finish(
    semanticScores.size > 0 ? 'semantic_assist' : 'candidate_retrieval',
    retrieved,
    semanticScores.size > 0
      ? ['title_candidate_retrieved', 'semantic_reranked']
      : ['title_candidate_retrieved'],
    semanticScores,
  );
}
