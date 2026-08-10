/**
 * Building the grounded comparison input (#96 §"Grounded comparison service").
 *
 * The ONE impure module of the comparison half: it reads the products, the
 * attributes, #74's ranked offers, the sellers behind them, #94's constraint
 * evaluation and — only when the deployment publishes it — #78's price signals,
 * and hands the values to the pure table builder.
 *
 * ## It COMPOSES and decides almost nothing
 *
 * The order of offers is #74's. An offer's converted price and its captured
 * quote are #74's. A constraint's satisfaction is #94's. A condition segment is
 * #90's. What #96 adds is the opaque reference layer, the four-state table, the
 * tradeoff derivation and the explanation seam — and
 * `comparison-isolation.test.ts` fails the build if a module here starts to
 * rank, to price, or to read a fee, a plan, a referral or a review.
 *
 * ## Every subject is compared in ONE currency, and the caller names it
 *
 * The same rule #74 states and for its reason: a comparison surface that
 * reached for a display default would make the default a comparison fact. The
 * currency arrives from the controller, which resolves a signed-in buyer's
 * stored preference exactly as `/offer-comparison` does.
 */

import {
  CONSTRAINT_EVALUATION_VERSION,
  COMPARISON_POLICY_VERSION,
  NORMALIZATION_RULE_VERSION,
  hasKnownComparisonMoney,
  type ComparisonFactGap,
  type ComparisonInput,
  type ComparisonMoneyFact,
  type ComparisonOfferRecord,
  type ComparisonPolicyIdentity,
  type ComparisonPriceSignal,
  type ComparisonRelationshipRecord,
  type ComparisonResult,
  type ComparisonSubject,
  type ComparisonSubjectAcquisition,
  type ConditionGroup,
  type CurrencyCode,
  type Offer,
  type OfferRelationshipStanding,
  type RankedOffer,
  type ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { listSelectedAttributeValues, listAttributeValues } from '../../db/canonical/attributeRepository.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { evaluateCandidate } from '../attributes/constraint-evaluation.js';
import { loadCandidateFacts, offerContextFor } from '../attributes/entity-facts.service.js';
import { resolveDefinitionsForCategory } from '../attributes/definition-registry.service.js';
import { getPublicCanonicalProduct } from '../canonical/canonical-product.service.js';
import { resolveOfferSellers } from '../product-page/sellers.js';
import { destinationHostOf } from '../product-page/outbound.js';
import { rankOfferComparison } from '../ranking/comparison.service.js';
import { buildConstraintColumn } from './constraints.js';
import { explainComparison } from './explanation/explanation.service.js';
import { MAX_COMPARISON_SUBJECTS } from './policy.js';
import { ComparisonRecordIndex } from './record-refs.js';
import { collectComparisonRates, toMoneyFact, toTotalFact } from './render.js';
import {
  buildComparisonTable,
  type DeclaredAttribute,
  type TableAttributeFact,
  type TableSubjectInput,
} from './table.js';
import { readSubjectPriceSignal } from './price-signal.js';
import { toAttributeFact } from './attribute-facts.js';

/** One product the caller wants compared. */
export interface ComparisonSubjectRequest {
  /** The canonical product's id or slug. */
  readonly handle: string;
  /** Narrow the comparison to ONE configuration. */
  readonly canonicalVariantId?: string;
}

export interface ProductComparisonRequest {
  readonly subjects: readonly ComparisonSubjectRequest[];
  readonly comparisonCurrency: CurrencyCode;
  readonly market?: string;
  readonly conditionGroups?: readonly ConditionGroup[];
  /** #94's validated set — #95's parser produces one, and so does a filter UI. */
  readonly constraints?: ValidatedConstraintSet;
  /** How many offers per subject #74 is asked for. */
  readonly offerLimit: number;
  /**
   * Whether the offers half may be served at all.
   *
   * Passed IN rather than read here, the `readCanonicalProductPage` decision:
   * the lever is a rollout choice the controller resolves along with the
   * cohort, and a service reading `config` would be a second place the rollout
   * is decided.
   */
  readonly offerComparisonPermitted: boolean;
  /** Whether #78's price signals may enter the input (grounded input item 6). */
  readonly priceSignalsPermitted: boolean;
}

/**
 * Compare two or more canonical products.
 *
 * Throws `validationError` for a subject count outside the policy bounds and
 * for a handle that resolves to nothing — a comparison silently missing one of
 * the products somebody asked for is a comparison of a different question.
 */
export async function compareCanonicalProducts(
  request: ProductComparisonRequest,
): Promise<ComparisonResult> {
  if (request.subjects.length < 2) {
    throw validationError('A comparison needs at least two products');
  }
  if (request.subjects.length > MAX_COMPARISON_SUBJECTS) {
    throw validationError(
      `A comparison holds at most ${String(MAX_COMPARISON_SUBJECTS)} products`,
    );
  }

  const db = getDb();
  const index = new ComparisonRecordIndex();
  const evaluatedAt = new Date().toISOString();

  const subjects: ComparisonSubject[] = [];
  const offerRecords: ComparisonOfferRecord[] = [];
  const relationships: ComparisonRelationshipRecord[] = [];
  const priceSignals: ComparisonPriceSignal[] = [];
  const gaps: ComparisonFactGap[] = [];
  const tableSubjects: TableSubjectInput[] = [];
  const moneyFacts: ComparisonMoneyFact[] = [];
  let rankingPolicyVersion = '';

  for (const requested of request.subjects) {
    const product = await getPublicCanonicalProduct(requested.handle);
    if (!product) throw validationError(`No product resolves to ${requested.handle}`);

    const subjectRef = index.register({
      kind: 'canonical_product',
      recordId: product.id,
      canonicalPath: `/p/${product.slug}`,
      label: product.name,
    });
    const variantRef =
      requested.canonicalVariantId === undefined
        ? undefined
        : index.register({
            kind: 'canonical_variant',
            recordId: requested.canonicalVariantId,
            canonicalPath: `/p/${product.slug}?variant=${requested.canonicalVariantId}`,
          });

    // ── #74's ranked, currency-safe offers ────────────────────────────────
    const ranked = request.offerComparisonPermitted
      ? await rankOfferComparison({
          ...(requested.canonicalVariantId === undefined
            ? { canonicalProductId: product.id }
            : { canonicalVariantId: requested.canonicalVariantId }),
          comparisonCurrency: request.comparisonCurrency,
          ...(request.market === undefined ? {} : { market: request.market }),
          ...(request.conditionGroups === undefined
            ? {}
            : { conditionGroups: request.conditionGroups }),
          limit: request.offerLimit,
        })
      : undefined;
    if (ranked !== undefined) rankingPolicyVersion = ranked.comparison.policy.version;

    const sellers =
      ranked === undefined
        ? new Map()
        : await resolveOfferSellers(
            ranked.comparison.offers
              .map((offer) => ranked.offers.get(offer.offerId))
              .filter((offer): offer is Offer => offer !== undefined),
            db,
          );

    const subjectOffers: ComparisonOfferRecord[] = [];
    if (ranked !== undefined) {
      for (const rankedOffer of ranked.comparison.offers) {
        const offer = ranked.offers.get(rankedOffer.offerId);
        if (offer === undefined) continue;
        const record = projectOffer({
          index,
          subjectRef,
          offer,
          rankedOffer,
          sellerLabel: sellerLabelOf(sellers.get(offer.id)),
        });
        subjectOffers.push(record);
        offerRecords.push(record);
        moneyFacts.push(record.itemPrice, record.deliveryCost);

        const standing = standingOf(rankedOffer);
        if (standing !== undefined && record.merchantRef !== undefined) {
          relationships.push({
            ref: index.register({
              kind: 'relationship',
              recordId: `${offer.merchantId ?? ''}:${standing}`,
            }),
            merchantRef: record.merchantRef,
            standing,
          });
        }
      }
    }

    // ── #94's typed attributes ────────────────────────────────────────────
    const declared = await declaredAttributesFor(db, product.categoryId);
    const facts = await recordedFactsFor(db, index, product.id, requested.canonicalVariantId);

    // ── #94's constraint evaluation ───────────────────────────────────────
    const constraintRefs = new Map<string, string>();
    if (request.constraints !== undefined) {
      for (const constraint of [
        ...request.constraints.hard,
        ...request.constraints.preferences,
      ]) {
        constraintRefs.set(
          constraint.id,
          index.register({ kind: 'constraint', recordId: constraint.id, label: constraint.id }),
        );
      }
    }
    const evaluation =
      request.constraints === undefined
        ? undefined
        : await evaluateSubjectConstraints(
            product.id,
            request.constraints,
            request.comparisonCurrency,
            request.market,
          );

    // ── #78's price signals, only where policy permits ────────────────────
    if (request.priceSignalsPermitted) {
      const signal = await readSubjectPriceSignal({
        index,
        subjectRef,
        canonicalProductId: product.id,
        comparisonCurrency: request.comparisonCurrency,
        ...(request.market === undefined ? {} : { market: request.market }),
      });
      if (signal !== undefined) priceSignals.push(signal);
    }

    const commerce = summariseCommerce(subjectOffers, request.offerComparisonPermitted);
    subjects.push({
      ref: subjectRef,
      ...(variantRef === undefined ? {} : { variantRef }),
      name: product.name,
      ...(product.categoryId === undefined || product.categoryId === null
        ? {}
        : { categoryId: product.categoryId }),
      acquisition: resolveAcquisition(subjectOffers, request.offerComparisonPermitted),
      offerRefs: subjectOffers.map((offer) => offer.ref),
    });

    tableSubjects.push({
      subjectRef,
      declared,
      facts,
      commerce,
      constraints:
        evaluation === undefined
          ? {
              subjectRef,
              verdict: 'included',
              satisfied: [],
              failed: [],
              unknown: [],
              notApplicable: [],
            }
          : buildConstraintColumn({
              subjectRef,
              evaluation,
              constraints: [
                ...(request.constraints?.hard ?? []),
                ...(request.constraints?.preferences ?? []),
              ],
              constraintRefs,
              declaredAttributeKeys: new Set(declared.keys()),
            }),
    });
  }

  const table = buildComparisonTable(tableSubjects);

  // Every unknown cell is ALSO a gap, stated out loud, because explanation
  // rule 7 asks the narrative to name what is missing and a narrative composed
  // from a table cannot tell an uninteresting row from an unknown one.
  for (const row of table.rows) {
    for (const [subjectRef, cell] of Object.entries(row.cells)) {
      if (cell.state !== 'unknown') continue;
      gaps.push({ subjectRef, rowKey: row.key, label: row.label, reason: cell.reason });
    }
  }

  const policy: ComparisonPolicyIdentity = {
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    rankingPolicyVersion,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
  };

  const input: ComparisonInput = {
    policy,
    evaluatedAt,
    comparisonCurrency: request.comparisonCurrency,
    ...(request.market === undefined ? {} : { market: request.market.toUpperCase() }),
    conditionGroups: request.conditionGroups ?? [],
    subjects,
    offers: offerRecords,
    relationships,
    priceSignals,
    gaps,
    table,
    rates: collectComparisonRates(moneyFacts),
    records: index.all(),
  };

  const { explanation } = await explainComparison(input);
  return { input, explanation };
}

/** One #74 ranked offer, projected into the comparison's own record shape. */
function projectOffer(input: {
  index: ComparisonRecordIndex;
  subjectRef: string;
  offer: Offer;
  rankedOffer: RankedOffer;
  sellerLabel: string;
}): ComparisonOfferRecord {
  const { index, offer, rankedOffer } = input;
  const ref = index.register({ kind: 'offer', recordId: offer.id, label: input.sellerLabel });
  const merchantRef =
    offer.merchantId === undefined
      ? undefined
      : index.register({
          kind: 'merchant',
          recordId: offer.merchantId,
          label: input.sellerLabel,
        });
  const storefrontRef =
    offer.storefrontId === undefined
      ? undefined
      : index.register({ kind: 'storefront', recordId: offer.storefrontId });
  const variantRef = index.register({
    kind: 'canonical_variant',
    recordId: offer.canonicalVariantId,
  });

  return {
    ref,
    subjectRef: input.subjectRef,
    variantRef,
    kind: offer.kind,
    ...(merchantRef === undefined ? {} : { merchantRef }),
    ...(storefrontRef === undefined ? {} : { storefrontRef }),
    rank: rankedOffer.rank,
    itemPrice: toMoneyFact(rankedOffer.cost.itemPrice),
    deliveryCost: toMoneyFact(rankedOffer.cost.deliveryCost),
    total: toTotalFact(rankedOffer.cost.total),
    taxInclusion: rankedOffer.cost.taxInclusion,
    availability: offer.availability,
    ...(offer.condition.key === undefined || offer.condition.key === 'unknown'
      ? {}
      : { conditionKey: offer.condition.key }),
    ...(offer.condition.group === undefined ? {} : { conditionGroup: offer.condition.group }),
    ...(standingOf(rankedOffer) === undefined ? {} : { relationship: standingOf(rankedOffer) }),
    nativeCheckoutEligible: offer.checkout.eligible === true,
    ...(offer.delivery.known === true && offer.delivery.maxDays !== undefined
      ? { deliveryMaxDays: offer.delivery.maxDays }
      : {}),
    freshness: offer.freshness.level === 'current' ? 'current' : offer.freshness.level === 'unknown' ? 'unknown' : 'ageing',
    ...(destinationHostOf(offer) === undefined
      ? {}
      : { destinationHost: destinationHostOf(offer) }),
  };
}

/**
 * The verified standing #74 awarded this offer, read off its LABELS.
 *
 * #71 reads it the same way and for the same reason: the labels are the
 * relationship layer's published answer for a comparison surface, and reaching
 * into `commerce_relationships` from here would be a second resolver over a
 * table this domain does not own — with a different validity window every time
 * the two reads did not happen in the same instant.
 */
function standingOf(
  rankedOffer: RankedOffer,
): Exclude<OfferRelationshipStanding, 'none'> | undefined {
  for (const award of rankedOffer.labels) {
    if (award.label === 'official_direct_store') return 'official_channel';
    if (award.label === 'authorized_reseller') return 'authorized_reseller';
  }
  return undefined;
}

/** A short seller name for a record label. Never a sentence, never an id. */
function sellerLabelOf(seller: unknown): string {
  if (seller === undefined || seller === null || typeof seller !== 'object') return 'Seller';
  const value = seller as { kind?: string; name?: string; displayName?: string };
  if (value.kind === 'merchant' || value.kind === 'native_store') return value.name ?? 'Seller';
  if (value.kind === 'native_person') return value.displayName ?? 'Seller';
  return 'Seller';
}

/** Whether the subject can be bought, and how. */
function resolveAcquisition(
  offers: readonly ComparisonOfferRecord[],
  offerComparisonPermitted: boolean,
): ComparisonSubjectAcquisition {
  if (!offerComparisonPermitted) {
    return { state: 'unavailable', reason: 'offer_comparison_withheld' };
  }
  if (offers.length === 0) return { state: 'unavailable', reason: 'no_eligible_offer' };
  const priced = offers.filter((offer) => hasKnownComparisonMoney(offer.itemPrice));
  if (priced.length === 0) return { state: 'unavailable', reason: 'no_convertible_price' };

  const channels = new Set<'native_checkout' | 'external_merchant'>();
  for (const offer of offers) {
    channels.add(offer.nativeCheckoutEligible ? 'native_checkout' : 'external_merchant');
  }
  return {
    state: 'purchasable',
    channels: [...channels].sort(),
    leadOfferRef: offers[0].ref,
    eligibleOfferCount: offers.length,
  };
}

/** The commerce half of a subject's table column. */
function summariseCommerce(
  offers: readonly ComparisonOfferRecord[],
  served: boolean,
): TableSubjectInput['commerce'] {
  const recordRefs = offers.map((offer) => offer.ref);
  let lowestItemPrice: ComparisonMoneyFact = { state: 'unknown', reason: 'not_published' };
  let lowestKnownTotal: ComparisonMoneyFact = { state: 'unknown', reason: 'component_missing' };
  let deliveryMaxDays: number | undefined;
  const availability = new Set<ComparisonOfferRecord['availability']>();
  const conditionGroups = new Set<ConditionGroup>();
  const merchants = new Set<string>();
  let hasOfficialChannel = false;

  for (const offer of offers) {
    if (
      hasKnownComparisonMoney(offer.itemPrice) &&
      (!hasKnownComparisonMoney(lowestItemPrice) ||
        offer.itemPrice.amount.amount < lowestItemPrice.amount.amount)
    ) {
      lowestItemPrice = offer.itemPrice;
    }
    if (
      hasKnownComparisonMoney(offer.total) &&
      (!hasKnownComparisonMoney(lowestKnownTotal) ||
        offer.total.amount.amount < lowestKnownTotal.amount.amount)
    ) {
      lowestKnownTotal = offer.total;
    }
    availability.add(offer.availability);
    if (offer.conditionGroup !== undefined) conditionGroups.add(offer.conditionGroup);
    merchants.add(offer.merchantRef ?? 'native');
    if (offer.relationship === 'official_channel') hasOfficialChannel = true;
    if (offer.deliveryMaxDays !== undefined) {
      deliveryMaxDays =
        deliveryMaxDays === undefined
          ? offer.deliveryMaxDays
          : Math.min(deliveryMaxDays, offer.deliveryMaxDays);
    }
  }

  return {
    served,
    lowestItemPrice,
    lowestKnownTotal,
    availability: [...availability],
    conditionGroups: [...conditionGroups],
    ...(deliveryMaxDays === undefined ? {} : { deliveryMaxDays }),
    merchantCount: offers.length === 0 ? 0 : merchants.size,
    hasOfficialChannel,
    recordRefs,
  };
}

/** Every attribute the subject's category declares, keyed by attribute key. */
async function declaredAttributesFor(
  db: ReturnType<typeof getDb>,
  categoryId: string | null | undefined,
): Promise<ReadonlyMap<string, DeclaredAttribute>> {
  const declared = new Map<string, DeclaredAttribute>();
  if (categoryId === undefined || categoryId === null) return declared;
  for (const definition of await resolveDefinitionsForCategory(db, categoryId)) {
    declared.set(definition.row.key, {
      label: definition.row.label,
      definitionVersion: definition.row.version,
      ...(definition.row.baseUnit === null || definition.row.baseUnit === undefined
        ? {}
        : { unit: definition.row.baseUnit }),
      comparable: definition.row.comparable,
    });
  }
  return declared;
}

/**
 * The subject's own recorded facts.
 *
 * SELECTED values first, then the CONFLICTING ones for keys that have no
 * selection — #94's rule that two disagreeing sources select neither, surfaced
 * as a distinct cell state rather than collapsed into "unknown". A variant
 * scope reads the variant's own values on top of the product's, so a
 * configuration's memory size overrides the family's.
 */
async function recordedFactsFor(
  db: ReturnType<typeof getDb>,
  index: ComparisonRecordIndex,
  productId: string,
  canonicalVariantId: string | undefined,
): Promise<ReadonlyMap<string, TableAttributeFact>> {
  const facts = new Map<string, TableAttributeFact>();

  const productRows = await listSelectedAttributeValues(db, 'product', [productId]);
  for (const row of productRows) {
    const fact = toAttributeFact(row, index);
    if (fact !== undefined) facts.set(fact.key, fact);
  }
  if (canonicalVariantId !== undefined) {
    const variantRows = await listSelectedAttributeValues(db, 'variant', [canonicalVariantId]);
    for (const row of variantRows) {
      const fact = toAttributeFact(row, index);
      if (fact !== undefined) facts.set(fact.key, fact);
    }
  }

  const allRows = await listAttributeValues(db, { kind: 'product', id: productId });
  const conflicting = new Map<string, typeof allRows>();
  for (const row of allRows) {
    if (row.selectionState !== 'conflicting') continue;
    const bucket = conflicting.get(row.attributeKey);
    if (bucket === undefined) conflicting.set(row.attributeKey, [row]);
    else bucket.push(row);
  }
  for (const [key, rows] of conflicting) {
    if (facts.has(key)) continue;
    const candidates = rows
      .map((row) => toAttributeFact(row, index))
      .filter((fact): fact is TableAttributeFact => fact !== undefined);
    if (candidates.length === 0) continue;
    facts.set(key, {
      key,
      label: candidates[0].label,
      definitionVersion: candidates[0].definitionVersion,
      ...(candidates[0].unit === undefined ? {} : { unit: candidates[0].unit }),
      state: 'conflicting',
      candidates: candidates
        .map((fact) => fact.value)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
      recordRefs: candidates.flatMap((fact) => fact.recordRefs),
    });
  }

  return facts;
}

/** #94's evaluation for one subject, with the offer context this comparison names. */
async function evaluateSubjectConstraints(
  productId: string,
  constraints: ValidatedConstraintSet,
  currency: CurrencyCode,
  market: string | undefined,
) {
  const candidateFacts = await loadCandidateFacts(productId, {
    offerContext: offerContextFor(currency, market),
  });
  if (candidateFacts === undefined) return undefined;
  return evaluateCandidate(constraints, candidateFacts);
}
