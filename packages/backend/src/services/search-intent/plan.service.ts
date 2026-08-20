/**
 * Planning one natural-language shopping query (#95).
 *
 * The orchestrator, and the ORDER of what it does is the contract:
 *
 * ```
 * 1. sanitize            bound, strip control characters and markup
 * 2. load the registry   #94's active definitions, category-scoped when scoped
 * 3. interpret           DETERMINISTICALLY — always, first, unconditionally
 * 4. resolve entities    category slug, brand and merchant, against real tables
 * 5. decide enablement   flag, provider, cohort, benchmark
 * 6. ask a model         only if 5 permitted it; validate every field it returns
 * 7. merge               a model may ADD; it may never weaken or overwrite
 * 8. build constraints   #94's language, from the merged draft
 * 9. VALIDATE            #94's own validator, before anything runs
 * 10. derive filters     #70's shape, with an enforcement site per hard constraint
 * 11. refuse or answer   an unenforceable hard constraint refuses the plan
 * 12. clarify, paraphrase, record
 * ```
 *
 * Step 3 running before step 5 is what makes "with no model configured at all
 * the surface still works" a fact about the call graph. Step 9 running before
 * anything is returned is #95 acceptance 1 verbatim. Step 11 is acceptance 3:
 * a hard requirement retrieval cannot enforce refuses the plan rather than
 * being quietly dropped into a search that runs.
 *
 * ## What a model may do to a deterministic draft, exactly
 *
 * ADD requirements, a category label, a budget, condition groups, channel
 * leanings, use tags and entity mentions where the deterministic pass found
 * NONE. It may not replace one, may not widen one, and may not remove one. The
 * merge is written as a series of "if the deterministic pass produced nothing
 * here" branches for that reason — there is no code path in which a model's
 * reading of a phrase overrides a rule's reading of the same phrase, so a
 * regression in a provider can cost coverage and can never cost correctness.
 */

import {
  INTENT_BUDGET_BASES,
  MAX_UNRESOLVED_PHRASES,
  SHOPPING_INTENT_PARSER_VERSION,
  SHOPPING_INTENT_PROMPT_VERSION,
  SHOPPING_INTENT_SCHEMA_VERSION,
  type IntentBudget,
  type IntentClarificationKind,
  type IntentElementOrigin,
  type IntentFallbackReason,
  type IntentUnresolvedPhrase,
  type InterpretationMode,
  type ShoppingIntentRequest,
  type ShoppingIntentResult,
} from '@mercaria/shared-types';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import {
  findBrandIdsByNormalizedName,
  findMerchantIdsByNormalizedName,
} from '../../db/search/searchCandidateRepository.js';
import { findActiveCategoriesByAliases } from '../../db/taxonomy/taxonomyRepository.js';
import { catalogAliasCandidates } from '../taxonomy/alias-normalization.js';
import {
  resolveAllActiveDefinitions,
  resolveDefinitionsForCategory,
  type ResolvedAttributeDefinition,
} from '../attributes/definition-registry.service.js';
import { validateConstraintSet } from '../attributes/constraint-validation.js';
import { normalizeEntityName } from '../canonical/normalization.js';
import { buildConstraintSet } from './constraints.js';
import {
  clarificationRoundsRemaining,
  selectClarifications,
  type ClarificationCandidate,
} from './clarification.js';
import { INTENT_BENCHMARK_DATASET } from './benchmark/dataset.js';
import { decideEnablement } from './enablement.js';
import { interpretDeterministically, type InterpretationDraft } from './deterministic.js';
import { deriveSearchFilters, unenforceableHardConstraints } from './filters.js';
import { boundedPhrase, sanitizeQueryForModel } from './injection.js';
import { languageOf } from './locale.js';
import { buildModelInput, buildModelVocabulary, validateCandidate } from './model-boundary.js';
import { countInterpretation, countUnsafeCandidate } from './metrics.js';
import { composeParaphrase } from './paraphrase.js';
import { parseWithRegisteredModel, shoppingIntentParserId } from './parser.port.js';

/** The plan, or the reason there is none. A string discriminant, as everywhere. */
export type ShoppingIntentPlan =
  | { readonly status: 'planned'; readonly result: ShoppingIntentResult }
  | {
      readonly status: 'refused';
      readonly code: 'hard_constraint_unenforceable' | 'constraint_set_invalid' | 'empty_query';
      /** The constraints or issues that caused it. Never a bare sentence. */
      readonly details: readonly { readonly id: string; readonly message: string }[];
    };

/** Everything the planner needs beyond the request. */
export interface PlanShoppingIntentInput {
  readonly request: ShoppingIntentRequest;
  /** The session's clarification state, when the request named a live session. */
  readonly session?: {
    readonly id: string;
    readonly askedKinds: readonly IntentClarificationKind[];
    readonly rounds: number;
  };
  /** The answer a shopper gave, already resolved against the open question. */
  readonly appliedAnswer?: { readonly kind: IntentClarificationKind; readonly optionId: string };
}

/**
 * Plan one query.
 *
 * Never throws for an interpretation problem — every one of those is a
 * `refused` result or an unresolved report — so the only exceptions that escape
 * are genuine faults (a lost connection, a bug), which the controller maps to a
 * 500 rather than to a shopper-visible refusal that would read like their fault.
 */
export async function planShoppingIntent(
  input: PlanShoppingIntentInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingIntentPlan> {
  const started = Date.now();
  const request = input.request;
  const query = sanitizeQueryForModel(request.query);
  if (query.length === 0) {
    return { status: 'refused', code: 'empty_query', details: [] };
  }
  const language = languageOf(request.locale);

  // 2. The registry, scoped to the category the request already knows about,
  //    and the operator-authored category aliases this query could be naming.
  //
  //    Both are loaded BEFORE the interpretation and handed to it, which is
  //    what keeps `interpretDeterministically` free of a database handle while
  //    still letting it read a table. One indexed `= ANY` over the query's own
  //    word runs; a query nobody recorded an alias for reads nothing.
  const [definitions, categoryAliases] = await Promise.all([
    loadDefinitions(db, request.categoryId),
    findActiveCategoriesByAliases(catalogAliasCandidates(query), db),
  ]);

  // 3. The deterministic interpretation — always, and before anything else.
  //
  // A clarification answer is applied HERE, as an INPUT to the interpretation
  // rather than as an edit to its output: an answer says how to READ a phrase,
  // and re-reading is the only way that produces the same object shape a fresh
  // query would. Patching the output afterwards would leave the paraphrase, the
  // unresolved list and the constraint set describing a reading nobody made.
  const answeredAttributeKeys =
    input.appliedAnswer?.kind === 'attribute_disambiguation' ? [input.appliedAnswer.optionId] : [];
  const draft = applyNonAttributeAnswer(
    interpretDeterministically({
      query,
      locale: request.locale,
      ...(request.currency === undefined ? {} : { currency: request.currency }),
      definitions,
      categoryAliases,
      ...(answeredAttributeKeys.length === 0
        ? {}
        : { preferredAttributeKeys: answeredAttributeKeys }),
    }),
    input.appliedAnswer,
  );

  // 4. Resolve what the draft NAMED against real tables.
  const resolved = await resolveEntities(db, draft, request.categoryId);

  // 5–7. The model half.
  const enablement = await decideEnablement(db, {
    language,
    ...(request.market === undefined ? {} : { market: request.market }),
    ...(resolved.categoryId === undefined ? {} : { categoryId: resolved.categoryId }),
    datasetDigest: INTENT_BENCHMARK_DATASET.digest,
    deterministicOnly: request.deterministicOnly === true,
  });

  let mode: InterpretationMode = 'deterministic';
  let fallbackReason: IntentFallbackReason | undefined =
    enablement.status === 'deterministic' ? enablement.reason : undefined;
  let merged = draft;
  let model: string | undefined;

  if (enablement.status === 'model_permitted') {
    const attempt = await parseWithRegisteredModel(
      buildModelInput({
        query,
        locale: request.locale,
        language,
        ...(request.market === undefined ? {} : { market: request.market }),
        ...(request.currency === undefined ? {} : { currency: request.currency }),
        ...(resolved.categoryName === undefined ? {} : { categoryLabel: resolved.categoryName }),
        vocabulary: buildModelVocabulary(definitions),
        draft,
      }),
      config.searchIntent.parseTimeoutMs,
    );
    const applied = applyModelAttempt(attempt, definitions, draft);
    mode = applied.mode;
    fallbackReason = applied.fallbackReason;
    merged = applied.draft;
    model = applied.model;
    if (applied.fallbackReason === 'unsafe_model_output') countUnsafeCandidate();
  }

  // A model may have named a brand, a merchant or a category the deterministic
  // pass did not. Those resolve through the SAME deterministic lookups — never
  // through anything the model supplied — which is model-boundary rule 5 as a
  // property of the call graph.
  const mergedResolved =
    merged === draft ? resolved : await resolveEntities(db, merged, request.categoryId);

  // 8. #94's language.
  const built = buildConstraintSet({
    draft: merged,
    brandIds: mergedResolved.brandIds,
    merchantIds: mergedResolved.merchantIds,
    ...(mergedResolved.categoryId === undefined ? {} : { categoryId: mergedResolved.categoryId }),
    ...(request.selectedFilters === undefined ? {} : { selectedFilters: request.selectedFilters }),
  });

  // 9. #94's own validator, before anything runs. Acceptance 1.
  const validation = await validateConstraintSet(db, built.set, {
    ...(mergedResolved.categoryId === undefined ? {} : { categoryId: mergedResolved.categoryId }),
  });
  // `=== false` rather than `!validation.valid`: the backend compiles with
  // `strict: false`, under which TypeScript does not narrow a union on the
  // TRUTHINESS of a boolean-literal discriminant (the #68 finding), so the
  // negated form leaves the caller holding the whole union and `issues` fails
  // to resolve. An explicit comparison narrows under both settings.
  if (validation.valid === false) {
    return {
      status: 'refused',
      code: 'constraint_set_invalid',
      details: validation.issues.map((issue) => ({
        id: issue.constraintId,
        message: issue.message,
      })),
    };
  }

  // 10–11. #70's shape, and the enforcement proof.
  const derived = deriveSearchFilters({
    set: validation.set,
    categorySlugById: mergedResolved.categorySlugById,
    ...(request.market === undefined ? {} : { market: request.market }),
    ...(request.selectedFilters === undefined ? {} : { selectedFilters: request.selectedFilters }),
  });
  const unenforceable = unenforceableHardConstraints(derived.enforcement);
  if (unenforceable.length > 0) {
    return {
      status: 'refused',
      code: 'hard_constraint_unenforceable',
      details: unenforceable.map((entry) => ({
        id: entry.constraintId,
        message: entry.explanation,
      })),
    };
  }

  // 12. Questions, sentence, record.
  const clarificationState = {
    askedKinds: input.session?.askedKinds ?? [],
    rounds: input.session?.rounds ?? 0,
  };
  const clarifications = selectClarifications(
    clarificationState,
    composeClarificationCandidates(merged, mergedResolved.categoryName),
  );

  const unresolved: IntentUnresolvedPhrase[] = [...merged.unresolved].slice(
    0,
    MAX_UNRESOLVED_PHRASES,
  );

  const origins: Record<string, IntentElementOrigin> = { ...built.origins };
  for (const tag of merged.useTags) origins[`use-${tag}`] = 'deterministic_rule';

  const result: ShoppingIntentResult = {
    schemaVersion: SHOPPING_INTENT_SCHEMA_VERSION,
    mode,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    provenance: {
      provider: mode === 'model' ? shoppingIntentParserId() : 'deterministic',
      ...(model === undefined ? {} : { model }),
      promptVersion: SHOPPING_INTENT_PROMPT_VERSION,
      schemaVersion: SHOPPING_INTENT_SCHEMA_VERSION,
      parserVersion: SHOPPING_INTENT_PARSER_VERSION,
    },
    interpretation: {
      searchText: merged.searchText,
      ...(mergedResolved.categoryId === undefined || mergedResolved.categoryName === undefined
        ? {}
        : {
            category: {
              categoryId: mergedResolved.categoryId,
              slug: mergedResolved.categorySlugById[mergedResolved.categoryId] ?? '',
              name: mergedResolved.categoryName,
              origin: origins.category ?? 'deterministic_rule',
              sourcePhrase: merged.categorySlug?.sourcePhrase ?? '',
            },
          }),
      constraints: built.set,
      preferenceRanking: built.preferenceRanking,
      ...(merged.budget === undefined ? {} : { budget: merged.budget }),
      commerce: {
        ...(merged.condition === undefined ? {} : { conditionGroups: merged.condition.groups }),
        ...(merged.availability === undefined ? {} : { availability: merged.availability }),
        ...(merged.officialChannelOnly === undefined
          ? {}
          : { officialChannelOnly: merged.officialChannelOnly }),
        ...(request.market === undefined ? {} : { market: request.market }),
        ...(merged.nearby === undefined ? {} : { nearby: merged.nearby }),
      },
      useTags: merged.useTags,
      brandIds: mergedResolved.brandIds,
      merchantIds: mergedResolved.merchantIds,
      origins,
    },
    filters: derived.filters,
    enforcement: derived.enforcement,
    unresolved,
    clarifications,
    paraphrase: composeParaphrase({
      searchText: merged.searchText,
      set: built.set,
      origins,
      ...(merged.budget === undefined ? {} : { budget: merged.budget }),
      useTags: merged.useTags,
      unresolved,
      ...(mergedResolved.categoryName === undefined
        ? {}
        : { categoryName: mergedResolved.categoryName }),
    }),
    warnings: validation.warnings,
    ...(input.session === undefined ? {} : { sessionId: input.session.id }),
    clarificationRoundsRemaining: clarificationRoundsRemaining(clarificationState),
  };

  countInterpretation(mode, fallbackReason);
  return { status: 'planned', result: withLatency(result, Date.now() - started) };
}

/**
 * The latency is carried on the RESULT for the caller to record, not measured
 * again by it.
 *
 * A second measurement in the controller would time a different thing — the
 * serialization and the response write — and the number an operator compares
 * against a provider's SLA has to be the one the planner actually spent. A
 * `WeakMap` rather than a field, because latency is an OBSERVATION about
 * producing the result and not part of the contract a client reads: putting it
 * on the DTO would make it a number a client could send back.
 */
const latencies = new WeakMap<ShoppingIntentResult, number>();

function withLatency(result: ShoppingIntentResult, latencyMs: number): ShoppingIntentResult {
  latencies.set(result, latencyMs);
  return result;
}

/** How long the planner spent on this result. Zero for a result it did not make. */
export function planLatencyMs(result: ShoppingIntentResult): number {
  return latencies.get(result) ?? 0;
}

/* -------------------------------------------------------------------------- */
/*  The pieces                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * #94's active definitions, scoped when the request is scoped.
 *
 * Scoping matters for accuracy rather than for cost: `14 inches` resolves to
 * exactly one attribute inside `laptops` and to three across the whole
 * registry, and the unscoped case is precisely the one the interpreter refuses
 * and asks about. So a shopper browsing a category gets a better answer, and
 * one who is not gets an honest question.
 */
async function loadDefinitions(
  db: DatabaseOrTransaction,
  categoryId: string | undefined,
): Promise<readonly ResolvedAttributeDefinition[]> {
  return categoryId === undefined
    ? resolveAllActiveDefinitions(db)
    : resolveDefinitionsForCategory(db, categoryId);
}

/** Everything a draft named, resolved against Mercaria's own tables. */
interface ResolvedEntities {
  readonly categoryId?: string;
  readonly categoryName?: string;
  readonly categorySlugById: Readonly<Record<string, string>>;
  readonly brandIds: readonly string[];
  readonly merchantIds: readonly string[];
}

/**
 * Resolve a draft's names into ids.
 *
 * EXACT normalized-name matches only, through #70's own lookups. A fuzzy
 * resolution here would be a brand filter nobody asked for: `apple` matching
 * `Applelectronics` is a hard taxonomy constraint invented from a typo, and the
 * shopper would see an empty page with no way to tell why. A name that resolves
 * to nothing is simply not a filter, and #70's ordinary brand and merchant
 * stages still find it as a search term.
 *
 * A name resolving to SEVERAL entities is also not a filter — that is the
 * ambiguity `entity_disambiguation` asks about, and picking the
 * lowest-id one would be a coin flip wearing an id's authority.
 */
async function resolveEntities(
  db: DatabaseOrTransaction,
  draft: InterpretationDraft,
  requestCategoryId: string | undefined,
): Promise<ResolvedEntities> {
  const categorySlugById: Record<string, string> = {};
  let categoryId = requestCategoryId;
  let categoryName: string | undefined;

  if (requestCategoryId !== undefined) {
    const [row] = await db
      .select({ id: categories.id, slug: categories.slug, name: categories.name })
      .from(categories)
      .where(eq(categories.id, requestCategoryId))
      .limit(1);
    if (row !== undefined) {
      categorySlugById[row.id] = row.slug;
      categoryName = row.name;
    }
  } else if (draft.categorySlug !== undefined) {
    const [row] = await db
      .select({ id: categories.id, slug: categories.slug, name: categories.name })
      .from(categories)
      .where(and(eq(categories.slug, draft.categorySlug.slug), eq(categories.isActive, true)))
      .limit(1);
    if (row !== undefined) {
      categoryId = row.id;
      categorySlugById[row.id] = row.slug;
      categoryName = row.name;
    }
  }

  const brandIds: string[] = [];
  const merchantIds: string[] = [];
  for (const mention of draft.entityMentions) {
    const normalized = normalizeEntityName(mention.text);
    if (normalized.length === 0) continue;
    // Two is the LIMIT rather than one, deliberately: asking for two is how the
    // resolver learns that the name is ambiguous, and asking for one would make
    // an ambiguous name indistinguishable from a unique one.
    const ids =
      mention.kind === 'brand'
        ? await findBrandIdsByNormalizedName(db, normalized, 2)
        : await findMerchantIdsByNormalizedName(db, normalized.toLowerCase(), 2);
    if (ids.length !== 1) continue;
    const [id] = ids;
    if (id === undefined) continue;
    if (mention.kind === 'brand') brandIds.push(id);
    else merchantIds.push(id);
  }

  return {
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(categoryName === undefined ? {} : { categoryName }),
    categorySlugById,
    brandIds,
    merchantIds,
  };
}

/** What one model attempt did to the draft. */
interface AppliedModel {
  readonly mode: InterpretationMode;
  readonly fallbackReason?: IntentFallbackReason;
  readonly draft: InterpretationDraft;
  readonly model?: string;
}

/**
 * Apply one model attempt to the deterministic draft.
 *
 * Every failure path returns the UNCHANGED draft with a named reason, so a
 * provider problem costs coverage and never correctness. The success path
 * merges, and the merge only ever fills gaps — see the module header.
 */
function applyModelAttempt(
  attempt: Awaited<ReturnType<typeof parseWithRegisteredModel>>,
  definitions: readonly ResolvedAttributeDefinition[],
  draft: InterpretationDraft,
): AppliedModel {
  if (attempt.status === 'unconfigured') {
    return { mode: 'deterministic', fallbackReason: 'provider_unconfigured', draft };
  }
  if (attempt.status === 'timeout') {
    return { mode: 'deterministic', fallbackReason: 'provider_timeout', draft };
  }
  if (attempt.status === 'threw') {
    return { mode: 'deterministic', fallbackReason: 'provider_error', draft };
  }
  const outcome = attempt.outcome;
  if (outcome.status === 'refused') {
    return {
      mode: 'deterministic',
      fallbackReason: 'provider_refused',
      draft,
      ...(outcome.model === undefined ? {} : { model: outcome.model }),
    };
  }
  if (outcome.status === 'failed') {
    return {
      mode: 'deterministic',
      fallbackReason: 'provider_error',
      draft,
      ...(outcome.model === undefined ? {} : { model: outcome.model }),
    };
  }

  const validated = validateCandidate(outcome.candidate, definitions, 'm');
  if (validated.status === 'rejected') {
    const reason: IntentFallbackReason =
      validated.reason === 'unsafe'
        ? 'unsafe_model_output'
        : validated.reason === 'unresolvable'
          ? 'model_output_unresolvable'
          : 'invalid_model_output';
    return {
      mode: 'deterministic',
      fallbackReason: reason,
      draft,
      ...(outcome.model === undefined ? {} : { model: outcome.model }),
    };
  }

  // The merge. Every branch is "the deterministic pass produced nothing here".
  const budget: IntentBudget | undefined =
    draft.budget ??
    (validated.budget === undefined
      ? undefined
      : {
          basis: validated.budget.basis,
          currency: validated.budget.currency,
          ...(validated.budget.minMinor === undefined ? {} : { minMinor: validated.budget.minMinor }),
          ...(validated.budget.maxMinor === undefined ? {} : { maxMinor: validated.budget.maxMinor }),
          origin: 'model_inferred',
          sourcePhrase: boundedPhrase(validated.budget.sourcePhrase),
        });

  return {
    mode: 'model',
    ...(outcome.model === undefined ? {} : { model: outcome.model }),
    draft: {
      // The SEARCH TEXT stays the deterministic one. A model rewriting what is
      // searched for is the one edit that could remove a word the shopper typed
      // without anything in the response saying so — and #70's own retrieval is
      // what makes a plain-text query work in the first place.
      searchText: draft.searchText,
      ...(draft.categorySlug === undefined ? {} : { categorySlug: draft.categorySlug }),
      requirements: [
        ...draft.requirements,
        // A model requirement on an attribute a RULE already read is dropped:
        // two constraints on one attribute is an unintended intersection, and
        // the rule's reading is the one derived from the shopper's own tokens.
        ...validated.requirements.filter(
          (requirement) =>
            !draft.requirements.some(
              (existing) => existing.attributeKey === requirement.attributeKey,
            ),
        ),
      ],
      ...(budget === undefined ? {} : { budget }),
      ...(draft.condition === undefined
        ? validated.conditionGroups === undefined
          ? {}
          : {
              condition: {
                groups: validated.conditionGroups,
                origin: 'model_inferred' as const,
                sourcePhrase: '',
              },
            }
        : { condition: draft.condition }),
      ...(draft.availability === undefined ? {} : { availability: draft.availability }),
      ...(draft.officialChannelOnly === undefined
        ? validated.officialChannelOnly === true
          ? { officialChannelOnly: true }
          : {}
        : { officialChannelOnly: draft.officialChannelOnly }),
      ...(draft.nativeOnly === undefined ? {} : { nativeOnly: draft.nativeOnly }),
      ...(draft.nearby === undefined
        ? validated.nearby === true
          ? { nearby: true }
          : {}
        : { nearby: draft.nearby }),
      useTags: draft.useTags.length > 0 ? draft.useTags : validated.useTags,
      entityMentions: validated.entityMentions,
      unresolved: [...draft.unresolved, ...validated.unresolved].slice(0, MAX_UNRESOLVED_PHRASES),
      ambiguities: [...draft.ambiguities, ...validated.clarificationKinds],
      attributeAmbiguities: draft.attributeAmbiguities,
      identifiers: draft.identifiers,
    },
  };
}

/**
 * Turn the draft's ambiguities into askable questions.
 *
 * Every question and every option is COMPOSED here from the structure, never
 * taken from a model — a model's own `clarificationKinds` name a KIND and carry
 * no text at all, which is why that field is a closed enum rather than a
 * question string. A model that could write the question could write a leading
 * one.
 */
function composeClarificationCandidates(
  draft: InterpretationDraft,
  categoryName: string | undefined,
): ClarificationCandidate[] {
  const candidates: ClarificationCandidate[] = [];
  const seen = new Set<IntentClarificationKind>();
  for (const kind of draft.ambiguities) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    if (kind === 'budget_basis') {
      candidates.push({
        kind,
        question: 'Is that price before delivery, or the total you want to pay?',
        options: [
          { id: 'item_price', label: 'Before delivery' },
          { id: 'known_total', label: 'Total, delivery included' },
        ],
      });
      continue;
    }
    if (kind === 'attribute_disambiguation') {
      const phrase = draft.attributeAmbiguities[0]?.phrase;
      candidates.push({
        kind,
        question:
          phrase === undefined
            ? 'Which measurement did you mean?'
            : `What does “${phrase}” describe?`,
        // The options are the CANDIDATE ATTRIBUTES the interpreter refused to
        // choose between, named in the unresolved report's own explanation. A
        // client renders them; the ids are the attribute keys, so an answer
        // resolves without a second lookup.
        // The options are the CANDIDATE ATTRIBUTES the interpreter refused to
        // choose between, carried on the draft by the pass that refused. The id
        // is the attribute KEY, so an answer feeds straight back into the
        // interpreter's `preferredAttributeKeys` with no second lookup.
        options: (draft.attributeAmbiguities[0]?.candidates ?? []).map((candidate) => ({
          id: candidate.key,
          label: candidate.label,
        })),
      });
      continue;
    }
    if (kind === 'category') {
      candidates.push({
        kind,
        question: 'Which of these are you looking for?',
        options:
          categoryName === undefined
            ? []
            : [
                { id: 'keep', label: categoryName },
                { id: 'any', label: 'Anything' },
              ],
      });
      continue;
    }
    // The remaining kinds — `missing_unit`, `requirement_strength`,
    // `entity_disambiguation`, `condition` — are DEFINED and are not produced by
    // the deterministic interpreter today, because none of them arises from a
    // reading it makes: it refuses a unitless magnitude rather than guessing,
    // it defaults strength by an explicit rule, it resolves an entity only when
    // exactly one matches, and it reads condition from a closed dictionary. A
    // model may name them, and closing the composition for each is one branch
    // here. Emitting an empty-option question would be worse than none:
    // `selectClarifications` drops a question with fewer than two options, so a
    // half-built one is silently invisible rather than visibly missing.
  }
  return candidates;
}

/**
 * Apply the two answers that are NOT about which attribute a magnitude names.
 *
 * `budget_basis` and `category` change what a reading MEANS rather than how a
 * phrase is read, so they are applied to the draft; `attribute_disambiguation`
 * changes how a phrase is READ and is applied as an input to the interpreter
 * instead. The split is not cosmetic — an attribute choice re-runs the unit
 * lookup, the strength rule and the explanation, and patching a requirement in
 * afterwards would produce one whose explanation described a different reading.
 */
function applyNonAttributeAnswer(
  draft: InterpretationDraft,
  answer: PlanShoppingIntentInput['appliedAnswer'],
): InterpretationDraft {
  if (answer === undefined) return draft;
  if (answer.kind === 'budget_basis' && draft.budget !== undefined) {
    const basis = INTENT_BUDGET_BASES.find((candidate) => candidate === answer.optionId);
    if (basis === undefined) return draft;
    return {
      ...draft,
      budget: { ...draft.budget, basis, origin: 'user_explicit' },
      ambiguities: draft.ambiguities.filter((kind) => kind !== 'budget_basis'),
    };
  }
  if (answer.kind === 'category' && answer.optionId === 'any') {
    // "Anything" removes the category the interpreter guessed. The rest of the
    // reading stands — a shopper widening the category has not withdrawn their
    // budget.
    const { categorySlug: _dropped, ...rest } = draft;
    return { ...rest, ambiguities: draft.ambiguities.filter((kind) => kind !== 'category') };
  }
  return draft;
}
