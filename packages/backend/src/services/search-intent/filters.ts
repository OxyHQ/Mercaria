/**
 * Deriving #70's retrieval filters from a validated constraint set — and
 * proving every hard requirement is enforced SOMEWHERE (#95 acceptance 3).
 *
 * PURE: no database, no clock, no configuration.
 *
 * ## The failure this module exists to make impossible
 *
 * "Hard constraints are never silently weakened during retrieval" is easy to
 * satisfy by accident and easy to break by accident, because the two languages
 * are not the same shape. #94's constraint set can express `ne`, `not_in`,
 * `missing`, an exclusive bound and an "any of" group; #70's `SearchFilters`
 * can express none of them. A translator that emitted what it could and dropped
 * the rest would produce a search that runs, returns results, and quietly
 * ignores a requirement the shopper stated — which looks exactly like a working
 * feature.
 *
 * So the translation is TOTAL by construction: every hard constraint is
 * assigned an {@link IntentEnforcementSite}, and `unenforceable` is one of the
 * three. `assertHardConstraintsEnforced` then refuses a plan carrying one,
 * naming it. A requirement Mercaria cannot enforce is a refusal a shopper can
 * act on — remove it, or loosen it — and never a search that pretends.
 *
 * ## Two sites, and the second one is not a weaker version of the first
 *
 * `retrieval_filter` narrows in SQL before any scoring, and is what every
 * expressible constraint gets. `constraint_evaluation` means the requirement is
 * enforced by #94's own evaluator over the retrieved candidates — the same
 * evaluator `POST /catalog-attributes/constraints/evaluate` runs — which is a
 * real enforcement and not a downgrade: it produces the identical
 * three-valued outcome and honours the same `missingDataPolicy`. What it costs
 * is retrieval efficiency, not correctness, and the result names which
 * constraints carry that cost so a client can show them.
 */

import type {
  ConditionGroup,
  ConstraintValue,
  IntentEnforcement,
  OfferAvailability,
  OfferKind,
  ProductConstraint,
  SearchAttributeFilter,
  SearchFilters,
  ValidatedConstraintSet,
} from '@mercaria/shared-types';

/** What the derivation needs beyond the validated set. */
export interface DeriveFiltersInput {
  readonly set: ValidatedConstraintSet;
  /**
   * The slug of the category a taxonomy constraint names.
   *
   * #70 filters categories by SLUG and #94 constrains them by ID, so the
   * planner resolves the pair once and hands both here. A category constraint
   * whose slug did not resolve is `constraint_evaluation` rather than dropped.
   */
  readonly categorySlugById: Readonly<Record<string, string>>;
  /** The market the request named, which is a request property and not a constraint. */
  readonly market?: string;
  /** Filters the shopper selected in the UI, merged in unchanged. */
  readonly selectedFilters?: SearchFilters;
}

/** The filters #70 will run, and where every hard constraint is enforced. */
export interface DerivedFilters {
  readonly filters: SearchFilters;
  readonly enforcement: readonly IntentEnforcement[];
}

/**
 * Translate a validated set into #70's filters.
 *
 * Only HARD constraints become filters. A preference that narrowed retrieval
 * would be a hard constraint wearing a preference's name — the exact
 * downgrade-in-reverse #94's two types exist to prevent — so preferences are
 * carried in the result for #74 and for the paraphrase and reach no filter
 * here.
 */
export function deriveSearchFilters(input: DeriveFiltersInput): DerivedFilters {
  const enforcement: IntentEnforcement[] = [];
  const attributes: SearchAttributeFilter[] = [];
  const brandIds: string[] = [];
  const merchantIds: string[] = [];
  const categorySlugs: string[] = [];
  const conditionGroups: ConditionGroup[] = [];
  const availability: OfferAvailability[] = [];
  const offerKinds: OfferKind[] = [];
  let officialChannelOnly = false;
  let price: SearchFilters['price'];
  let market = input.market;

  for (const constraint of input.set.hard) {
    const site = applyHardConstraint(constraint, {
      attributes,
      brandIds,
      merchantIds,
      categorySlugs,
      conditionGroups,
      availability,
      offerKinds,
      categorySlugById: input.categorySlugById,
      setOfficialChannelOnly: () => {
        officialChannelOnly = true;
      },
      setPrice: (value) => {
        price = value;
      },
      setMarket: (value) => {
        market = value;
      },
    });
    enforcement.push({
      constraintId: constraint.id,
      site,
      explanation: constraint.explanation,
    });
  }

  const selected = input.selectedFilters;
  const filters: SearchFilters = {
    ...(categorySlugs.length === 0 && selected?.categorySlugs === undefined
      ? {}
      : { categorySlugs: dedupe([...categorySlugs, ...(selected?.categorySlugs ?? [])]) }),
    ...(brandIds.length === 0 && selected?.brandIds === undefined
      ? {}
      : { brandIds: dedupe([...brandIds, ...(selected?.brandIds ?? [])]) }),
    ...(market === undefined ? {} : { market }),
    ...(price === undefined ? (selected?.price === undefined ? {} : { price: selected.price }) : { price }),
    ...(conditionGroups.length === 0 ? {} : { conditionGroups: dedupe(conditionGroups) }),
    ...(availability.length === 0 && selected?.availability === undefined
      ? {}
      : { availability: dedupe([...availability, ...(selected?.availability ?? [])]) }),
    ...(offerKinds.length === 0 && selected?.offerKinds === undefined
      ? {}
      : { offerKinds: dedupe([...offerKinds, ...(selected?.offerKinds ?? [])]) }),
    ...(officialChannelOnly || selected?.officialChannelOnly === true
      ? { officialChannelOnly: true }
      : {}),
    ...(merchantIds.length === 0 && selected?.merchantIds === undefined
      ? {}
      : { merchantIds: dedupe([...merchantIds, ...(selected?.merchantIds ?? [])]) }),
    ...(attributes.length === 0 && selected?.attributes === undefined
      ? {}
      : { attributes: [...attributes, ...(selected?.attributes ?? [])] }),
  };

  return { filters, enforcement };
}

/** The accumulators one constraint may contribute to. */
interface FilterSink {
  readonly attributes: SearchAttributeFilter[];
  readonly brandIds: string[];
  readonly merchantIds: string[];
  readonly categorySlugs: string[];
  readonly conditionGroups: ConditionGroup[];
  readonly availability: OfferAvailability[];
  readonly offerKinds: OfferKind[];
  readonly categorySlugById: Readonly<Record<string, string>>;
  readonly setOfficialChannelOnly: () => void;
  readonly setPrice: (value: SearchFilters['price']) => void;
  readonly setMarket: (value: string) => void;
}

/**
 * Apply one hard constraint, and say where it ended up.
 *
 * The function is exhaustive over `ProductConstraint`'s discriminants and every
 * branch RETURNS a site, so there is no path that applies nothing and reports
 * nothing — which is the shape that would reintroduce the silent weakening.
 */
function applyHardConstraint(constraint: ProductConstraint, sink: FilterSink): IntentEnforcement['site'] {
  switch (constraint.kind) {
    case 'attribute': {
      const filter = attributeFilterFor(constraint);
      if (filter === undefined) return 'constraint_evaluation';
      sink.attributes.push(filter);
      return 'retrieval_filter';
    }
    case 'taxonomy': {
      // `not_in` has no #70 filter — every filter there is a membership test —
      // so an exclusion is enforced by evaluation rather than approximated as
      // "everything except", which is not a set #70 can be handed.
      if (constraint.op !== 'in') return 'constraint_evaluation';
      if (constraint.subject === 'brand') {
        sink.brandIds.push(...constraint.ids);
        return 'retrieval_filter';
      }
      if (constraint.subject === 'merchant') {
        sink.merchantIds.push(...constraint.ids);
        return 'retrieval_filter';
      }
      if (constraint.subject === 'category') {
        const slugs = constraint.ids
          .map((id) => sink.categorySlugById[id])
          .filter((slug): slug is string => slug !== undefined);
        if (slugs.length !== constraint.ids.length) return 'constraint_evaluation';
        sink.categorySlugs.push(...slugs);
        return 'retrieval_filter';
      }
      // `product_family` — #70 has no family filter (a family is a RESULT kind
      // there, not a narrowing), so it is evaluated.
      return 'constraint_evaluation';
    }
    case 'commerce':
      return applyCommerceConstraint(constraint.predicate, sink);
    case 'any_of':
      // A disjunction has no filter representation at all: #70's filters are a
      // conjunction of membership tests, and expressing "A or B" by widening one
      // of them would admit candidates satisfying neither.
      return 'constraint_evaluation';
    case 'text':
      // Unreachable: `TextPreference` is typed `strength: 'preference'` and this
      // loop runs over the HARD partition. The branch exists so the switch is
      // exhaustive rather than defaulted, and so adding a hard text kind would
      // fail `tsc` here instead of silently landing in a default.
      return 'constraint_evaluation';
  }
}

/** Apply one commerce predicate. */
function applyCommerceConstraint(
  predicate: Extract<ProductConstraint, { kind: 'commerce' }>['predicate'],
  sink: FilterSink,
): IntentEnforcement['site'] {
  switch (predicate.facet) {
    case 'offer_price': {
      if (predicate.op === 'between') {
        const lower = predicate.lower?.value;
        const upper = predicate.upper?.value;
        // An EXCLUSIVE bound is not the same requirement as an inclusive one and
        // #70's filter has only inclusive bounds, so it is evaluated rather than
        // widened by one minor unit — a widening is a weakening, however small.
        if (predicate.lower?.inclusive !== true || predicate.upper?.inclusive !== true) {
          return 'constraint_evaluation';
        }
        if (lower?.type !== 'money' || upper?.type !== 'money') return 'constraint_evaluation';
        sink.setPrice({
          currency: predicate.currency,
          minMinor: lower.amountMinor,
          maxMinor: upper.amountMinor,
        });
        return 'retrieval_filter';
      }
      if (predicate.amountMinor === undefined) return 'constraint_evaluation';
      // `lt` and `gt` are STRICT and #70's bounds are inclusive — evaluated.
      if (predicate.op === 'lte') {
        sink.setPrice({ currency: predicate.currency, maxMinor: predicate.amountMinor });
        return 'retrieval_filter';
      }
      if (predicate.op === 'gte') {
        sink.setPrice({ currency: predicate.currency, minMinor: predicate.amountMinor });
        return 'retrieval_filter';
      }
      return 'constraint_evaluation';
    }
    case 'known_total':
      // #70's price filter compares the OFFER price. A delivered total needs the
      // delivery component, which #57's offer facts supply and #70's filter does
      // not read — so this is genuinely a different question and is enforced by
      // the evaluator. Mapping it onto the price filter would answer "under 900
      // before delivery" to somebody who asked for "under 900 delivered".
      return 'constraint_evaluation';
    case 'availability':
      sink.availability.push(...(predicate.values as readonly OfferAvailability[]));
      return 'retrieval_filter';
    case 'condition':
      if (predicate.op !== 'in') return 'constraint_evaluation';
      sink.conditionGroups.push(...(predicate.values as readonly ConditionGroup[]));
      return 'retrieval_filter';
    case 'market': {
      const [territory, ...rest] = predicate.territories;
      // #70's `market` is a single territory. A set of them is not expressible
      // and is not approximated by picking the first.
      if (territory === undefined || rest.length > 0) return 'constraint_evaluation';
      sink.setMarket(territory);
      return 'retrieval_filter';
    }
    case 'official_channel':
      // `official_channel is false` — "do NOT show me official channels" — has
      // no #70 filter: `officialChannelOnly` is a narrowing and its absence is
      // not its negation.
      if (predicate.value !== true) return 'constraint_evaluation';
      sink.setOfficialChannelOnly();
      return 'retrieval_filter';
    case 'offer_channel': {
      for (const kind of predicate.values) {
        if (kind === 'native') sink.offerKinds.push('native');
        // #94's `external` is #57's THREE non-native kinds. Expanding it here is
        // not a widening: it is the same set under the other vocabulary, and
        // pushing only `external` would silently exclude every affiliate and
        // informational offer from a request that asked for third-party sellers.
        else sink.offerKinds.push('external', 'affiliate', 'informational');
      }
      return 'retrieval_filter';
    }
    case 'proximity':
      // #70's request contract has NO proximity parameter, deliberately: #93
      // supplies no pickup publication or collectable-inventory state, so there
      // is nothing to filter against. Reported as unenforceable, which refuses
      // the plan — the alternative is a distance requirement that changes
      // nothing and reads as a working filter.
      return 'unenforceable';
  }
}

/**
 * The #70 attribute filter for one hard attribute constraint, when there is one.
 *
 * `SearchAttributeFilter` expresses exactly three things: an exact normalized
 * text match, an inclusive numeric floor and an inclusive numeric ceiling. Every
 * other operator — `ne`, `not_in`, `exists`, `missing`, `is`, a strict bound, a
 * set membership — returns `undefined` and is enforced by evaluation.
 *
 * The numeric value travels in the attribute's BASE UNIT, because that is what
 * `canonical_attribute_values.normalized_number` holds; the caller has already
 * converted through #94's table, so nothing here guesses a unit.
 */
function attributeFilterFor(
  constraint: Extract<ProductConstraint, { kind: 'attribute' }>,
): SearchAttributeFilter | undefined {
  const predicate = constraint.predicate;
  switch (predicate.op) {
    case 'eq': {
      if (predicate.value.type === 'string') {
        return { key: constraint.attributeKey, value: predicate.value.value };
      }
      const magnitude = baseMagnitudeOf(predicate.value);
      if (magnitude === undefined) return undefined;
      // An equality on a MEASUREMENT becomes a degenerate inclusive range rather
      // than a text match: `16 GB` stored as 17179869184 bytes is not the string
      // `16 GB`, and a text filter would match nothing at all.
      return { key: constraint.attributeKey, minNumber: magnitude, maxNumber: magnitude };
    }
    case 'gte': {
      const magnitude = baseMagnitudeOf(predicate.value);
      return magnitude === undefined
        ? undefined
        : { key: constraint.attributeKey, minNumber: magnitude };
    }
    case 'lte': {
      const magnitude = baseMagnitudeOf(predicate.value);
      return magnitude === undefined
        ? undefined
        : { key: constraint.attributeKey, maxNumber: magnitude };
    }
    case 'between': {
      if (predicate.lower.inclusive !== true || predicate.upper.inclusive !== true) return undefined;
      const lower = baseMagnitudeOf(predicate.lower.value);
      const upper = baseMagnitudeOf(predicate.upper.value);
      if (lower === undefined || upper === undefined) return undefined;
      return { key: constraint.attributeKey, minNumber: lower, maxNumber: upper };
    }
    default:
      return undefined;
  }
}

/** The comparable number a constraint value carries, when it carries one. */
function baseMagnitudeOf(value: ConstraintValue): number | undefined {
  if (value.type === 'integer' || value.type === 'decimal') return value.value;
  if (value.type === 'measurement') return value.magnitude;
  return undefined;
}

/**
 * Every hard constraint that has nowhere to be enforced.
 *
 * Returned rather than thrown, because the caller composes the refusal: it
 * names the constraints, and #95 acceptance 3 is satisfied by the plan being
 * REFUSED rather than by an exception's message.
 */
export function unenforceableHardConstraints(
  enforcement: readonly IntentEnforcement[],
): readonly IntentEnforcement[] {
  return enforcement.filter((entry) => entry.site === 'unenforceable');
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
