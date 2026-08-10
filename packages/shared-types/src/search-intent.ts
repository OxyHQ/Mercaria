/**
 * Natural-language shopping intent (#95).
 *
 * Turning "a laptop with at least 16 GB, 14 inches or smaller, USB-C, not
 * refurbished, under 900 € delivered" into #94's validated constraint language
 * and #70's deterministic retrieval — **without letting a model invent a
 * product, a specification, a price, a merchant or availability**.
 *
 * ## The one rule everything here is shaped around
 *
 * A model may only ever produce a CANDIDATE. Every field of that candidate is
 * untrusted input that must resolve against something Mercaria already knows —
 * an attribute definition in #94's registry, a unit in its conversion table, a
 * currency in {@link CurrencyCode}, a condition segment, a category, a brand or
 * merchant resolved by #70's deterministic lookup — or be reported as
 * UNRESOLVED. There is no third outcome: nothing is silently dropped and
 * nothing is approximated.
 *
 * That rule is held in four independent places, none of them a convention:
 *
 * 1. **The candidate type has no id fields at all.** {@link CandidateIntent}
 *    cannot name a canonical product, a variant, an offer, a merchant id or a
 *    brand id, because no such property exists on it. A model's mention of a
 *    seller arrives as {@link CandidateEntityMention} — free text plus a kind —
 *    which the backend resolves deterministically or reports unresolved.
 * 2. **The candidate carries no facts.** There is no price, no availability and
 *    no specification VALUE a model could assert about a product; a candidate
 *    expresses REQUIREMENTS the catalogue is then asked about.
 *    {@link INTENT_FORBIDDEN_MODEL_OUTPUTS} names all ten prohibitions as
 *    VALUES, disjoint from {@link INTENT_CANDIDATE_ELEMENTS} by a test — the
 *    `RETAIL_FORBIDDEN_COMPONENT_KINDS` device.
 * 3. **Strength is not the model's to choose in a third way.** A candidate
 *    requirement is `hard` or `preference` and becomes one of #94's two
 *    genuinely different types; there is no "soft-hard" and no numeric weight.
 *    A preference's relative importance is an ORDINAL RANK the shopper stated,
 *    never a score — see {@link IntentPreferenceRanking}.
 * 4. **The paraphrase is COMPOSED, never quoted.** {@link ShoppingIntentResult}
 *    has no field a model's prose could occupy: the sentence a shopper reads is
 *    rendered by Mercaria from the validated structure, so "never show model
 *    prose as a substitute for actual results" is the absence of a field rather
 *    than a review comment.
 *
 * ## Deterministic parsing is the FLOOR, not a degraded mode
 *
 * {@link InterpretationMode} has two members and `deterministic` is the one a
 * deployment with no provider configured gets — a complete, working
 * interpretation built from identifiers, locale-aware numbers and currencies,
 * #94's registry and a bounded per-language dictionary. A model, when one is
 * configured, may only ADD to what the deterministic pass already understood.
 * Which is why every result names its mode and, when it is `deterministic`, the
 * REASON the model did not produce it — present exactly then
 * ({@link ShoppingIntentResult.fallbackReason}).
 */

import type { ConditionGroup } from './condition';
import type { ConstraintSet, ConstraintStrength, ConstraintValidationIssue } from './constraint';
import type { CurrencyCode } from './money';
import type { OfferAvailability, OfferKind } from './offer';
import type { SearchFilters } from './search';

/* -------------------------------------------------------------------------- */
/*  Versions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The version of the RESULT SCHEMA (#95 output field 10).
 *
 * A code constant, not a table — the `SEARCH_RELEVANCE_POLICY_VERSION`
 * reasoning: the schema is a procedure, and a table would let somebody publish a
 * version whose shape nobody shipped. It travels on every result and every
 * recorded turn, so an interpretation stored last month can be read back under
 * the rules it was produced by.
 */
export const SHOPPING_INTENT_SCHEMA_VERSION = 'si-1';

/**
 * The version of the DETERMINISTIC interpreter's rules.
 *
 * Separate from the schema version because the two change for different
 * reasons: adding a colloquial term to the Spanish dictionary changes what a
 * query means without changing the shape of the answer, and a benchmark
 * threshold recorded against one is meaningless against the other.
 */
export const SHOPPING_INTENT_PARSER_VERSION = 'sip-1';

/**
 * The version of the PROMPT contract a model provider is handed.
 *
 * Recorded on every result even when the mode is `deterministic`, because "the
 * prompt version in force when this fell back" is what a fallback-rate
 * regression is diagnosed against.
 */
export const SHOPPING_INTENT_PROMPT_VERSION = 'sipr-1';

/* -------------------------------------------------------------------------- */
/*  Mode and fallback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which interpreter produced the result (#95 deterministic-fallback rule 5).
 *
 * Reported to the client on every response, because a shopper editing chips
 * needs to know whether they are correcting a rule or a guess — and because a
 * client that cannot tell the two apart will render a model's confidence over a
 * deterministic answer that was actually stronger.
 */
export const INTERPRETATION_MODES = ['model', 'deterministic'] as const;

/** One of {@link INTERPRETATION_MODES}. */
export type InterpretationMode = (typeof INTERPRETATION_MODES)[number];

/**
 * Why a request was answered deterministically (#95 deterministic-fallback
 * rule 8: "record fallback rate and reason").
 *
 * A CLOSED set, so a fallback rate can be broken down without any free text
 * reaching a counter or a log line. Every member is a fact about Mercaria's own
 * configuration or about the model's OUTPUT — never about what the shopper
 * typed, which is the one thing #77's redaction policy keeps out of storage.
 */
export const INTENT_FALLBACK_REASONS = [
  /** The deployment-wide lever is off. */
  'parser_disabled',
  /** The lever is on and no provider is registered — the fail-closed default. */
  'provider_unconfigured',
  /** This market/language cohort is on the incident block list. */
  'cohort_blocked',
  /** No qualifying benchmark run has enabled this category and language. */
  'not_enabled_for_category_language',
  /** The provider exceeded its deadline. */
  'provider_timeout',
  /** The provider declined to answer. */
  'provider_refused',
  /** The provider threw, or answered something that was not a response. */
  'provider_error',
  /** The output did not satisfy the strict candidate schema. */
  'invalid_model_output',
  /** The output carried a tool call, a URL, code or an instruction. */
  'unsafe_model_output',
  /** Every element the model produced failed to resolve against the registry. */
  'model_output_unresolvable',
  /** The candidate produced a constraint set #94 refused. */
  'constraint_validation_failed',
  /** The caller spent this surface's own parsing budget. */
  'parse_rate_limited',
] as const;

/** One of {@link INTENT_FALLBACK_REASONS}. */
export type IntentFallbackReason = (typeof INTENT_FALLBACK_REASONS)[number];

/**
 * Who owns a clarification session.
 *
 * The same three kinds the backend's `CommerceActor` union has, written out as
 * a tuple because a CHECK constraint needs one and `CommerceActor` deliberately
 * has NO common shape a tuple could be derived from — its whole design is that
 * a consumer must switch on `kind` rather than read a shared `id`. Two spellings
 * of one vocabulary is the risk, and it is bounded here by the vocabulary being
 * three closed values that have not changed since ADR 0003.
 */
export const INTENT_ACTOR_KINDS = ['oxy', 'guest', 'anonymous'] as const;

/** One of {@link INTENT_ACTOR_KINDS}. */
export type IntentActorKind = (typeof INTENT_ACTOR_KINDS)[number];

/* -------------------------------------------------------------------------- */
/*  Provenance of one interpreted element                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where one interpreted element came from (#95 clarification rule 6: "never
 * pretend a model inference was explicitly stated by the user").
 *
 * Carried by EVERY element of an interpretation, which is what makes that rule
 * structural rather than a copy review: the paraphrase renderer reads this field
 * and has three different voices for it, so an inference cannot be written in
 * the voice reserved for something the shopper actually typed.
 */
export const INTENT_ELEMENT_ORIGINS = [
  /** The shopper's own words, or a filter they selected in the UI. */
  'user_explicit',
  /** A deterministic rule read it out of the query — a barcode, `16 GB`, `€900`. */
  'deterministic_rule',
  /** A model inferred it. Never rendered as something the shopper said. */
  'model_inferred',
] as const;

/** One of {@link INTENT_ELEMENT_ORIGINS}. */
export type IntentElementOrigin = (typeof INTENT_ELEMENT_ORIGINS)[number];

/* -------------------------------------------------------------------------- */
/*  What a model may produce, and what it may never                            */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of element a model candidate may contain.
 *
 * Every one of them is a REQUIREMENT or a HINT about what to look for. None of
 * them is a fact about a product, which is the distinction
 * {@link INTENT_FORBIDDEN_MODEL_OUTPUTS} states from the other side.
 */
export const INTENT_CANDIDATE_ELEMENTS = [
  'search_text',
  'category_hint',
  'attribute_requirement',
  'budget',
  'condition_preference',
  'channel_preference',
  'entity_mention',
  'use_tag',
  'unresolved_phrase',
  'clarification_request',
] as const;

/** One of {@link INTENT_CANDIDATE_ELEMENTS}. */
export type IntentCandidateElement = (typeof INTENT_CANDIDATE_ELEMENTS)[number];

/**
 * What a model output may NEVER contain (#95 model-boundary rules 5 and 6, and
 * safety rule 5).
 *
 * Stated as VALUES and DISJOINT from {@link INTENT_CANDIDATE_ELEMENTS} by a
 * test, so a plausible-looking future addition fails the build instead of
 * quietly widening what a model may assert. The vocabulary is one of the four
 * mechanisms; the others are the candidate TYPE having no field for any of
 * them, a strict schema that refuses an undeclared key outright, and a scan of
 * the raw output for tool calls, URLs, code fences and instruction language.
 */
export const INTENT_FORBIDDEN_MODEL_OUTPUTS = [
  /** A canonical product, variant or listing id. */
  'product_identity',
  /** A merchant, storefront or seller id. */
  'merchant_identity',
  /** An offer id, or any claim about one. */
  'offer_identity',
  /** "This costs 899 €" — a price is read from an offer, never from a model. */
  'price_assertion',
  /** "This is in stock" — availability is #57's, derived from live offers. */
  'availability_assertion',
  /** "This laptop has 32 GB" — a specification is #94's, from a source record. */
  'specification_assertion',
  /** A request to call a tool, a function or an external service. */
  'tool_invocation',
  /** A URL, in any form. */
  'url',
  /** Executable code, in any language. */
  'code',
  /** An instruction addressed to Mercaria's own system. */
  'system_instruction',
] as const;

/** One of {@link INTENT_FORBIDDEN_MODEL_OUTPUTS}. */
export type IntentForbiddenModelOutput = (typeof INTENT_FORBIDDEN_MODEL_OUTPUTS)[number];

/* -------------------------------------------------------------------------- */
/*  Product-use intent: bounded tags                                           */
/* -------------------------------------------------------------------------- */

/**
 * Product-use intent, as BOUNDED TAGS (#95 output field 6).
 *
 * The issue offers two shapes — "bounded tags or derived requirements" — and
 * this implements both: a tag from this closed set, and/or ordinary constraints
 * the interpretation derived. What it does NOT permit is a free-text use string,
 * because a use somebody wrote in prose is a phrase a ranking would eventually
 * key on, and nothing would bound it.
 *
 * A tag is a HINT and never a filter: it is reported so a client can explain
 * what Mercaria thought the thing was for, and it reaches no retrieval decision
 * on its own. Any actual narrowing rides on the constraints beside it.
 */
export const SHOPPING_USE_TAGS = [
  'gaming',
  'photography',
  'video_editing',
  'music_production',
  'programming',
  'office_work',
  'study',
  'travel',
  'commuting',
  'fitness',
  'outdoors',
  'cooking',
  'gardening',
  'home_repair',
  'childcare',
  'pets',
  'accessibility',
  'gift',
] as const;

/** One of {@link SHOPPING_USE_TAGS}. */
export type ShoppingUseTag = (typeof SHOPPING_USE_TAGS)[number];

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a budget is measured against (#95 output field 4).
 *
 * The two are genuinely different questions and #94's constraint language
 * already keeps them apart (`offer_price` versus `known_total`). "Under 900 €
 * delivered" is a `known_total`, which is satisfied only when every component
 * of the total is KNOWN — an estimate never satisfies it — and "under 900 €" is
 * an `offer_price`. Reading one as the other is the single most consequential
 * misinterpretation this surface can make, so the basis is always reported and
 * is always one a shopper can correct.
 */
export const INTENT_BUDGET_BASES = ['item_price', 'known_total'] as const;

/** One of {@link INTENT_BUDGET_BASES}. */
export type IntentBudgetBasis = (typeof INTENT_BUDGET_BASES)[number];

/** A budget, in ONE named currency and in its minor units. */
export interface IntentBudget {
  readonly basis: IntentBudgetBasis;
  readonly currency: CurrencyCode;
  /** Inclusive lower bound. */
  readonly minMinor?: number;
  /** Inclusive upper bound. */
  readonly maxMinor?: number;
  readonly origin: IntentElementOrigin;
  /** The shopper's own words this came from — kept, never rewritten. */
  readonly sourcePhrase: string;
}

/* -------------------------------------------------------------------------- */
/*  Unresolved phrases                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why a phrase could not become a constraint (#95 output field 7).
 *
 * A closed set, and every member is a REPORT rather than a silent drop: #95's
 * central rule is that "an unresolvable term is reported as unresolved, never
 * silently dropped and never approximated", and this vocabulary is what makes
 * the report expressible. `unsupported_by_retrieval` is the one worth reading —
 * it is a requirement Mercaria understood completely and cannot ENFORCE, which
 * is a different failure from not having understood it.
 */
export const INTENT_UNRESOLVED_KINDS = [
  /** No attribute definition matches the thing being asked about. */
  'unknown_attribute',
  /** A magnitude with a unit the conversion table does not know. */
  'unknown_unit',
  /** A number with no unit and no attribute to attach it to. */
  'unattached_quantity',
  /** A currency symbol or code outside Mercaria's presentment set. */
  'unknown_currency',
  /** A named brand, merchant or storefront that resolved to nothing. */
  'unresolved_entity',
  /** A category word that matched no category. */
  'unresolved_category',
  /** The phrase has more than one reading and none is clearly stronger. */
  'ambiguous_phrase',
  /** Understood, and #70's retrieval has no way to enforce it. */
  'unsupported_by_retrieval',
  /** Two requirements that cannot both hold. */
  'conflicting_requirements',
  /** An enum value the attribute does not admit. */
  'unknown_enum_value',
] as const;

/** One of {@link INTENT_UNRESOLVED_KINDS}. */
export type IntentUnresolvedKind = (typeof INTENT_UNRESOLVED_KINDS)[number];

/** One phrase the interpretation could not turn into a requirement. */
export interface IntentUnresolvedPhrase {
  readonly kind: IntentUnresolvedKind;
  /** The shopper's own words. Bounded, and never rewritten into ours. */
  readonly phrase: string;
  /** One line a shopper reads, composed by Mercaria. */
  readonly explanation: string;
  /**
   * The constraint this would have become, when the phrase was understood and
   * merely unenforceable. Absent for everything Mercaria did not understand.
   */
  readonly constraintId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Clarification                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a clarification is ABOUT (#95 clarification rule 1: ask only when the
 * ambiguity would materially change hard constraints or category).
 *
 * A closed set, and it is what makes rule 7's "avoid repetitive clarification
 * loops through a bounded state machine" checkable: a session records which
 * kinds it has already asked, and a kind is asked AT MOST ONCE. Without a
 * vocabulary the anti-repetition rule would have to compare question TEXT,
 * which two phrasings of one question defeat.
 */
export const INTENT_CLARIFICATION_KINDS = [
  /** Two categories fit and they return different things. */
  'category',
  /** "Under 900" — before or after delivery. */
  'budget_basis',
  /** A magnitude with no unit, where the plausible units differ by an order. */
  'missing_unit',
  /**
   * A magnitude whose unit fits several attributes in the category.
   *
   * `14 inches` in laptops is a screen size, and it is also a width and a depth
   * — three attributes in the same unit family, and picking one silently is a
   * hard requirement Mercaria invented. The question names the candidates.
   */
  'attribute_disambiguation',
  /** A requirement that could be hard or a leaning, and it changes the results. */
  'requirement_strength',
  /** A named thing that matched several brands or merchants. */
  'entity_disambiguation',
  /** New, used or refurbished, where the shopper said something in between. */
  'condition',
] as const;

/** One of {@link INTENT_CLARIFICATION_KINDS}. */
export type IntentClarificationKind = (typeof INTENT_CLARIFICATION_KINDS)[number];

/** One bounded option a shopper may pick. */
export interface IntentClarificationOption {
  /** Stable within the question — what an answer names. */
  readonly id: string;
  /** One short line, composed by Mercaria from the structure. */
  readonly label: string;
}

/**
 * One question, with its bounded options.
 *
 * There is no free-text answer field: a clarification is answered by naming an
 * OPTION, so a second round of natural language cannot enter through the
 * clarification path and bypass the parse budget. A shopper who wants to say
 * something else edits the query, which is an ordinary new interpretation.
 */
export interface IntentClarification {
  readonly id: string;
  readonly kind: IntentClarificationKind;
  /** The question, composed by Mercaria. Never model prose. */
  readonly question: string;
  readonly options: readonly IntentClarificationOption[];
}

/** The most questions one interpretation may ask at once. */
export const MAX_CLARIFICATIONS_PER_RESULT = 2;

/** The most options one question may offer. */
export const MAX_CLARIFICATION_OPTIONS = 4;

/**
 * The most clarification ROUNDS one session may run (#95 clarification rule 7).
 *
 * Two, and the bound is on the SESSION rather than on the request: a per-request
 * bound is no bound at all, because every answer starts a new request. Past it
 * the session answers with whatever it understood and asks nothing more, which
 * is rule 2 ("do not block a useful result when safe defaults can be shown
 * transparently") arriving by exhaustion rather than by judgement.
 */
export const MAX_CLARIFICATION_ROUNDS = 2;

/* -------------------------------------------------------------------------- */
/*  The interpretation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A preference and how much it matters, RELATIVE to the other preferences
 * (#95 output field 3).
 *
 * An ORDINAL RANK, and deliberately not a weight. A weight would be a ranking
 * input, #74 owns ranking, and its policy versions are the only place a weight
 * may live — so a number here would be a second, unversioned ranking authority
 * arriving through a query parser. A rank is what a shopper actually stated
 * ("mostly I care about battery life") and is ordinal information a UI can
 * render and a person can reorder.
 *
 * `search-intent-isolation.test.ts` fails the build if this domain reaches
 * `services/ranking/` at all.
 */
export interface IntentPreferenceRanking {
  /** The `ConstraintBase.id` of the preference this ranks. */
  readonly constraintId: string;
  /** 1 is the most important. Dense, contiguous, and never a score. */
  readonly rank: number;
  readonly origin: IntentElementOrigin;
}

/** A category the interpretation believes the query is about. */
export interface IntentCategoryCandidate {
  readonly categoryId: string;
  readonly slug: string;
  readonly name: string;
  readonly origin: IntentElementOrigin;
  /** The shopper's own words that led here. */
  readonly sourcePhrase: string;
}

/**
 * The commerce leanings #95 output field 5 names, as a single object.
 *
 * Every member is OPTIONAL and absent means "the shopper said nothing about
 * it" — never a default. A `false` here would be a requirement nobody made:
 * `officialChannelOnly: false` and an absent `officialChannelOnly` mean the same
 * thing to retrieval and completely different things to a paraphrase, and the
 * paraphrase is what a shopper checks.
 */
export interface IntentCommercePreferences {
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly availability?: readonly OfferAvailability[];
  readonly offerKinds?: readonly OfferKind[];
  readonly officialChannelOnly?: boolean;
  /** ISO 3166-1 alpha-2, when the query named a market. */
  readonly market?: string;
  /**
   * Whether the shopper asked for something NEARBY.
   *
   * Reported and never enforced: #70's request contract has no proximity
   * parameter because #93 supplies no collectable-inventory or pickup
   * publication state, so a nearby requirement is reported as
   * `unsupported_by_retrieval` and the shopper is told. Accepting it and
   * changing nothing would read as a working filter.
   */
  readonly nearby?: boolean;
}

/**
 * What Mercaria understood, fully resolved and validated.
 *
 * Every id in here was resolved by a deterministic lookup against Mercaria's
 * own catalogue — never taken from a model — which is #95 model-boundary rule 5
 * expressed as a property of how the object is BUILT rather than of what it
 * contains.
 */
export interface ShoppingInterpretation {
  /** The text #70 searches on. The shopper's words, bounded, never invented. */
  readonly searchText: string;
  /** At most one, and absent when nothing resolved. */
  readonly category?: IntentCategoryCandidate;
  /** The #94 set, already validated. AND across its members. */
  readonly constraints: ConstraintSet;
  readonly preferenceRanking: readonly IntentPreferenceRanking[];
  readonly budget?: IntentBudget;
  readonly commerce: IntentCommercePreferences;
  readonly useTags: readonly ShoppingUseTag[];
  /** Brand and merchant ids that RESOLVED. Unresolved mentions are reported. */
  readonly brandIds: readonly string[];
  readonly merchantIds: readonly string[];
  /** Per-constraint provenance, so a UI can render three different voices. */
  readonly origins: Readonly<Record<string, IntentElementOrigin>>;
}

/* -------------------------------------------------------------------------- */
/*  The request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a client submits (#95 "Input and output contract" 1–6).
 *
 * The six inputs the issue names, and NOTHING else. There is no account id, no
 * address, no coordinate, no payment field and no saved-list reference — safety
 * rule 6 ("do not send account secrets, payment data, private lists or precise
 * location to the model") held by the request type having nowhere to put one,
 * rather than by a redaction step somebody has to keep correct.
 */
export interface ShoppingIntentRequest {
  /** What the shopper typed. Bounded; the server truncates rather than refuses. */
  readonly query: string;
  /** BCP-47. Decides number formats, the dictionary and the paraphrase language. */
  readonly locale: string;
  /** ISO 3166-1 alpha-2 — the market whose offers matter. */
  readonly market?: string;
  /** The currency a budget with no symbol is read in, and the display currency. */
  readonly currency?: CurrencyCode;
  /** The category the shopper is already browsing, when they are. */
  readonly categoryId?: string;
  /** The canonical product the shopper is already looking at, when they are. */
  readonly canonicalProductId?: string;
  /**
   * The session a clarification answer belongs to (#95 clarification rule 4:
   * "a clarification answer updates only the active search session").
   */
  readonly sessionId?: string;
  /** The answer to one previously asked question. */
  readonly clarificationAnswer?: {
    readonly clarificationId: string;
    readonly optionId: string;
  };
  /**
   * Filters the shopper already selected in the UI (#95 input 6).
   *
   * These are `user_explicit` by construction and are NEVER weakened by an
   * interpretation: a model that "understood" the shopper wanted something
   * cheaper cannot widen a price filter they set themselves.
   */
  readonly selectedFilters?: SearchFilters;
  /**
   * Skip the model and answer deterministically (#95 client rule 5: "let the
   * user remove the interpretation and run plain text search").
   */
  readonly deterministicOnly?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  The result                                                                 */
/* -------------------------------------------------------------------------- */

/** Which provider, model, prompt and schema produced a result (#95 output 10). */
export interface IntentProvenance {
  /**
   * The registered provider's id, or `deterministic` when no model ran.
   *
   * Never a credential, never an endpoint and never a request id — this is what
   * an operator reads in a trace and what a benchmark run is recorded against.
   */
  readonly provider: string;
  /** The model identifier the provider used, when one did. */
  readonly model?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  /** The deterministic interpreter's own rules version, always present. */
  readonly parserVersion: string;
}

/**
 * One line of the paraphrase (#95 output field 9).
 *
 * A LIST of typed lines rather than one string, because the three origins have
 * to render differently and a single sentence cannot carry that distinction to a
 * client. `origin` is what a UI keys the voice on — "you asked for", "we read",
 * "we guessed" — and it is the mechanism behind "never pretend a model inference
 * was explicitly stated by the user".
 */
export interface IntentParaphraseLine {
  /** The constraint, budget or preference this line describes. */
  readonly subjectId: string;
  readonly origin: IntentElementOrigin;
  /** The sentence, composed by Mercaria from the validated structure. */
  readonly text: string;
  /** Whether a client may offer a one-tap removal for this element. */
  readonly editable: boolean;
}

/**
 * Where a hard constraint is ENFORCED (#95 acceptance 3: "hard constraints are
 * never silently weakened during retrieval").
 *
 * Every hard constraint in a plan must map to one of the first two. The third
 * exists so the failure is REPORTABLE rather than silent: a hard requirement
 * with no enforcement site refuses the plan and names itself, instead of being
 * quietly demoted to something retrieval happens to be able to do.
 */
export const INTENT_ENFORCEMENT_SITES = [
  /** Applied as a #70 retrieval filter before any scoring. */
  'retrieval_filter',
  /** Applied by #94's evaluator over the retrieved candidates. */
  'constraint_evaluation',
  /** No site can enforce it — the plan is refused and this is why. */
  'unenforceable',
] as const;

/** One of {@link INTENT_ENFORCEMENT_SITES}. */
export type IntentEnforcementSite = (typeof INTENT_ENFORCEMENT_SITES)[number];

/** Where one hard constraint will actually be enforced. */
export interface IntentEnforcement {
  readonly constraintId: string;
  readonly site: IntentEnforcementSite;
  /** One line, so a refusal names the requirement rather than a code. */
  readonly explanation: string;
}

/**
 * A complete, versioned interpretation (#95 "Input and output contract").
 *
 * Ten output fields, and the ones that are ABSENT are the design: no product,
 * no merchant, no price, no availability, no specification and no model prose.
 */
export interface ShoppingIntentResult {
  readonly schemaVersion: string;
  readonly mode: InterpretationMode;
  /** Present EXACTLY when `mode` is `deterministic` — a biconditional. */
  readonly fallbackReason?: IntentFallbackReason;
  readonly provenance: IntentProvenance;
  readonly interpretation: ShoppingInterpretation;
  /** What #70 will actually be asked. Derived, never supplied by a caller. */
  readonly filters: SearchFilters;
  /** Where each hard constraint is enforced. Never contains `unenforceable`. */
  readonly enforcement: readonly IntentEnforcement[];
  readonly unresolved: readonly IntentUnresolvedPhrase[];
  readonly clarifications: readonly IntentClarification[];
  readonly paraphrase: readonly IntentParaphraseLine[];
  /** Non-fatal notes from #94's validation — a deprecated definition, say. */
  readonly warnings: readonly ConstraintValidationIssue[];
  /** The session a clarification answer would belong to, when one is open. */
  readonly sessionId?: string;
  /**
   * How many clarification rounds this session has left.
   *
   * Reported so a client can render "search anyway" as the only remaining path
   * rather than discovering the bound by asking (#95 clarification rule 8).
   */
  readonly clarificationRoundsRemaining: number;
}

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why an intent request was refused outright (#95 acceptance 1 and 3).
 *
 * A refusal is different from a fallback: a fallback still answers, and these
 * do not. Both of them exist because the alternative — answering with a plan
 * whose hard requirements retrieval cannot enforce — would be the silent
 * weakening acceptance 3 forbids.
 */
export const INTENT_REFUSAL_CODES = [
  /** A hard constraint has no enforcement site. Names the constraint. */
  'hard_constraint_unenforceable',
  /** #94 refused the set, and the deterministic reading produced the same set. */
  'constraint_set_invalid',
  /** The query was empty once bounded and folded. */
  'empty_query',
  /** The named session does not exist, expired, or belongs to another actor. */
  'session_not_found',
  /** The answer names a question this session did not ask. */
  'clarification_not_open',
] as const;

/** One of {@link INTENT_REFUSAL_CODES}. */
export type IntentRefusalCode = (typeof INTENT_REFUSAL_CODES)[number];

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The longest query this surface reads (#95 safety rule 4: "bounded string
 * lengths").
 *
 * The same 256 characters #70's normalizer bounds a search term to, and the
 * same treatment — the excess is dropped before anything else runs, so nothing
 * downstream, the model included, can see it. A refusal would be worse: a
 * shopper who pasted a specification sheet still means something by the first
 * part of it.
 */
export const INTENT_QUERY_MAX_LENGTH = 256;

/** The longest phrase an unresolved report may quote back. */
export const INTENT_PHRASE_MAX_LENGTH = 64;

/** The most unresolved phrases one result reports. */
export const MAX_UNRESOLVED_PHRASES = 8;

/** The most use tags one interpretation carries. */
export const MAX_USE_TAGS = 4;

/** The most entity mentions a model candidate may contain. */
export const MAX_ENTITY_MENTIONS = 6;

/* -------------------------------------------------------------------------- */
/*  The model port's own contract                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a model is allowed to KNOW about the shopper (#95 safety rule 6).
 *
 * Six fields, and the absences are the enforcement: no account id, no session
 * id, no email, no address, no coordinate, no payment detail, no saved list, no
 * order history and no cart. A provider implementation cannot send what it is
 * never handed, so the guarantee is a property of this type rather than of a
 * redaction pass.
 *
 * `query` arrives as DATA (#95 safety rule 1). The prompt contract every
 * provider implements puts it inside a delimited user-content block and states
 * that its contents are never instructions; the backend additionally strips
 * control characters and markup before it gets here.
 */
export interface ModelParseInput {
  /** Bounded, control-character-stripped shopper text. Data, never instructions. */
  readonly query: string;
  /** BCP-47. */
  readonly locale: string;
  /** ISO 639-1, derived from the locale — the language the query is read in. */
  readonly language: string;
  /** ISO 3166-1 alpha-2. */
  readonly market?: string;
  /** The currency a bare number is read in. */
  readonly currency?: CurrencyCode;
  /** The category the shopper is browsing, by LABEL — never an id to echo back. */
  readonly categoryLabel?: string;
  /** The exact vocabulary the model may name. Nothing outside it resolves. */
  readonly vocabulary: ModelParseVocabulary;
  /** What the deterministic pass already understood, so a model does not re-guess. */
  readonly deterministicSummary: readonly string[];
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

/**
 * One attribute a model may reference, with everything it needs to reference it
 * correctly (#95 model-boundary rule 4: "may map language to known attributes
 * but cannot create a new attribute definition").
 *
 * The KEY travels because it is the stable machine name; the LABEL travels
 * because that is the word a shopper used (#95 localization rule 4: "translate
 * attribute labels through the registry, not model-generated canonical keys").
 * A key the model invents resolves against nothing and the whole element is
 * reported unresolved.
 */
export interface ModelParseAttribute {
  readonly key: string;
  readonly label: string;
  readonly valueType: string;
  /** The base unit a magnitude is compared in, for a measurement attribute. */
  readonly baseUnit?: string;
  /** The unit family, so a model cannot offer inches for a mass. */
  readonly unitFamily?: string;
  /** The admitted values, for an enum attribute. */
  readonly enumValues?: readonly string[];
  /** Whether it may carry a HARD requirement at all (#94's own flag). */
  readonly hardConstraintCapable: boolean;
}

/** The closed vocabulary a model may draw from. Nothing else resolves. */
export interface ModelParseVocabulary {
  readonly attributes: readonly ModelParseAttribute[];
  readonly conditionGroups: readonly ConditionGroup[];
  readonly currencies: readonly CurrencyCode[];
  readonly useTags: readonly ShoppingUseTag[];
  readonly clarificationKinds: readonly IntentClarificationKind[];
}

/** A named thing the model saw in the query. Free text — never an id. */
export interface CandidateEntityMention {
  readonly kind: 'brand' | 'merchant';
  /** The shopper's own words. Resolved deterministically, or reported. */
  readonly text: string;
}

/** One requirement the model believes the shopper stated. */
export interface CandidateRequirement {
  /** An attribute KEY from the vocabulary. Anything else is unresolvable. */
  readonly attributeKey: string;
  readonly strength: ConstraintStrength;
  readonly operator: 'eq' | 'gte' | 'lte' | 'between' | 'in' | 'is';
  /** A number in the attribute's own unit, a string for enum/string, a boolean. */
  readonly numberValue?: number;
  readonly numberUpperValue?: number;
  /** The unit token the shopper used, resolved against #94's conversion table. */
  readonly unit?: string;
  readonly textValue?: string;
  readonly booleanValue?: boolean;
  readonly textValues?: readonly string[];
  /** The shopper's own words. Kept verbatim for the unresolved report. */
  readonly sourcePhrase: string;
}

/**
 * What a model produces — and it is a CANDIDATE, in the name and in the type.
 *
 * There is no id of any kind on it, no price, no availability and no
 * specification value. Every field is either a REQUIREMENT the catalogue will be
 * asked about or a piece of free text Mercaria will resolve itself.
 */
export interface CandidateIntent {
  /** The words to search on. Must be a substring-preserving reading of the query. */
  readonly searchText: string;
  /** A category by LABEL, resolved deterministically or reported unresolved. */
  readonly categoryLabel?: string;
  readonly requirements: readonly CandidateRequirement[];
  /** Preference constraint source phrases, most important first. */
  readonly preferenceOrder: readonly string[];
  readonly budget?: {
    readonly basis: IntentBudgetBasis;
    readonly currency: CurrencyCode;
    readonly minMinor?: number;
    readonly maxMinor?: number;
    readonly sourcePhrase: string;
  };
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly offerKinds?: readonly OfferKind[];
  readonly officialChannelOnly?: boolean;
  readonly nearby?: boolean;
  readonly entityMentions: readonly CandidateEntityMention[];
  readonly useTags: readonly ShoppingUseTag[];
  /** Phrases the model itself could not read. Reported, never dropped. */
  readonly unreadablePhrases: readonly string[];
  /** At most {@link MAX_CLARIFICATIONS_PER_RESULT}, from the closed kind set. */
  readonly clarificationKinds: readonly IntentClarificationKind[];
}

/**
 * What a provider returns. A discriminated union on a STRING.
 *
 * The backend compiles with `strict: false`, under which TypeScript does not
 * narrow a union on the truthiness of a boolean-literal discriminant — the #68
 * finding. Every result union in this domain therefore uses a string.
 *
 * A provider never throws its way to a fallback: it returns `refused` or
 * `failed`, so the reason a fallback happened is a value from a closed set
 * rather than an exception class. A THROW is still handled — as
 * `provider_error` — because a provider that throws is broken rather than one
 * that declined.
 */
export type ModelParseOutcome =
  | { readonly status: 'parsed'; readonly candidate: CandidateIntent; readonly model?: string }
  | { readonly status: 'refused'; readonly model?: string }
  | { readonly status: 'failed'; readonly model?: string };

/* -------------------------------------------------------------------------- */
/*  Benchmark and enablement                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The case classes the versioned benchmark must cover (#95 "Evaluation" 1–12).
 *
 * A tuple rather than a folder listing, because the dataset's own gate asserts
 * every member is represented — so a class nobody wrote a case for fails the
 * build instead of being absent from a report that still reads complete.
 */
export const INTENT_BENCHMARK_CASE_KINDS = [
  'exact_category_and_budget',
  'several_hard_constraints',
  'preference_versus_requirement',
  'ambiguous_use_case',
  'unsupported_attribute',
  'conflicting_constraints',
  'mixed_units_and_currencies',
  'merchant_or_brand_request',
  'used_nearby_or_official_intent',
  'prompt_injection_or_malformed',
  'multiple_languages',
  'should_fall_back_without_clarification',
] as const;

/** One of {@link INTENT_BENCHMARK_CASE_KINDS}. */
export type IntentBenchmarkCaseKind = (typeof INTENT_BENCHMARK_CASE_KINDS)[number];

/**
 * What a benchmark run MEASURES (#95 "Evaluation", final paragraph).
 *
 * Eight measures, named as values so a recorded run and a threshold cannot
 * describe different numbers. `cost` is deliberately present and deliberately
 * unitless — a run records whatever the provider reported, and the
 * deterministic provider reports zero.
 */
export const INTENT_BENCHMARK_MEASURES = [
  'schema_validity',
  'category_accuracy',
  'hard_constraint_recall',
  'false_hard_constraint_rate',
  'clarification_precision',
  'latency_p95_ms',
  'cost_units',
  'fallback_rate',
] as const;

/** One of {@link INTENT_BENCHMARK_MEASURES}. */
export type IntentBenchmarkMeasure = (typeof INTENT_BENCHMARK_MEASURES)[number];

/**
 * The measures whose threshold is a FLOOR (higher is better).
 *
 * Stated as data because a threshold comparison that guesses the direction is
 * the failure mode a "recorded threshold" is supposed to prevent: reading
 * `false_hard_constraint_rate <= 0.02` as a floor enables the parser precisely
 * when it is inventing requirements.
 */
export const INTENT_BENCHMARK_FLOOR_MEASURES: readonly IntentBenchmarkMeasure[] = [
  'schema_validity',
  'category_accuracy',
  'hard_constraint_recall',
  'clarification_precision',
];

/** One measure of one recorded run. */
export interface IntentBenchmarkMeasurement {
  readonly measure: IntentBenchmarkMeasure;
  readonly value: number;
  /** How many cases the value was computed over. A rate off two cases is noise. */
  readonly sampleSize: number;
}

/**
 * The version of the labelled dataset a run was measured against.
 *
 * Content-addressed: the digest of the case list, so a run recorded against a
 * dataset somebody has since edited cannot be mistaken for one measured against
 * the current cases. The #58 benchmark's device.
 */
export interface IntentBenchmarkDatasetRef {
  readonly version: string;
  readonly digest: string;
  readonly caseCount: number;
}

/**
 * Whether the parser is enabled for one (category, language) pair, and the run
 * that qualified it (#95 acceptance 7).
 *
 * The run is cited by a COMPOSITE foreign key so an enablement citing no
 * measurement is unrepresentable — the `match_category_gates` device, applied
 * to a language rather than to a category alone, because a parser that is
 * accurate in Spanish says nothing about its accuracy in German.
 */
export interface IntentEnablement {
  readonly categoryId: string;
  /** ISO 639-1. */
  readonly language: string;
  readonly enabled: boolean;
  readonly benchmarkRunId: string;
  readonly datasetVersion: string;
  readonly enabledByOxyUserId: string;
  readonly enabledAt: string;
}
