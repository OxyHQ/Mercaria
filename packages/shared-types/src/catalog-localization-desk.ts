/**
 * The translation desk (ADR 0007 D4, epic #367 merge-order step 10) — what is
 * translated, what is owed, and which of the gaps a launched market will hit.
 *
 * `catalog-localization.ts` owns what a localization IS. This file owns the
 * questions a translation desk asks ABOUT the set of them, and it is a separate
 * file for one reason: every symbol here is a MEASUREMENT vocabulary, and a
 * measurement's honesty rests on things the localization tables cannot state —
 * how many entities are owed a translation, and how each domain comes to know
 * its text went out of date.
 *
 * ## Nothing here is stored, and that is the schema's own decision
 *
 * `db/schema/catalogLocalization.ts` records a `localization_coverage_runs`
 * table as deliberately ABSENT: "how much of the catalogue is translated into
 * Spanish" is a QUERY over the rows, and storing its answer is a second
 * representation that goes stale the moment a translator saves. This file
 * therefore describes a report that is DERIVED at read time — the
 * `deriveNativeCheckoutEligibility` posture — so a translation saved a second
 * ago is in the next answer with no sweep having run.
 *
 * ## The one figure that can lie, and the shape that stops it
 *
 * A coverage percentage computed over the localization ROWS is vacuous: a locale
 * nobody has started has no rows, so every ratio over them is 0/0 and every
 * "found nothing" reads identically to "there is nothing to find". The
 * denominator here is therefore the ENTITY population — the categories, product
 * types and controlled values that are OWED a translation — which is a count no
 * localization row participates in and which cannot be driven to zero by the
 * work not having been done.
 *
 * {@link LocalizationCompleteness} then makes the residual case unrepresentable
 * rather than merely handled: its `no_population` branch carries no ratio, so a
 * renderer cannot print `100%` for a domain that has nothing in it.
 */

import {
  CATALOG_LOCALIZATION_TEXT_TABLES,
  LOCALIZED_ENTITY_KINDS,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
  type LocalizedEntityKind,
  type SupportedLocale,
} from './catalog-localization';

/* -------------------------------------------------------------------------- */
/* Launch locales                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The locales a shopper can actually be served the apps in, minus the base one.
 *
 * DERIVED from a real fact rather than invented: `packages/ui/src/i18n/locales.ts`
 * is the one locale registry all three Expo apps consume, and its tuple is the
 * set of languages Mercaria ships interface copy in. A catalog translation into
 * a locale no app ships reaches nobody; a locale an app ships and the catalog
 * lacks is a gap a real shopper reads in English. So "launched" is exactly "the
 * app ships it", and this list is that tuple folded to the stored lowercase form
 * and with {@link MERCARIA_BASE_LOCALE} removed — the base locale is not a
 * translation target, it is where the source text lives.
 *
 * It is a CODE CONSTANT and not an environment variable, for the reason the
 * retail pilot's bounds are rows and not variables: which markets Mercaria has
 * launched is a published policy, so widening it is a commit with an author and
 * a date rather than a value somebody changes at 3am. It is not derived by
 * IMPORTING the UI registry either — `@mercaria/ui` is an Expo package consumed
 * from source by Metro and the backend has no business resolving it — so the two
 * halves are committed together and held together by a gate:
 * `catalog-localization-desk.test.ts` reads `packages/ui/src/i18n/locales.ts`
 * off disk and fails the build if the folded sets disagree in either direction.
 *
 * Every member is additionally asserted to be a member of
 * {@link SUPPORTED_LOCALES}: an app shipping a language the catalog has no row
 * shape for is a market that can never have a translated catalogue, and that is
 * a build failure rather than a discovery.
 */
export const LAUNCH_LOCALES: readonly SupportedLocale[] = [
  'ar',
  'bn',
  'ca',
  'de',
  'es',
  'fr',
  'hi',
  'ja',
  'pt-br',
  'ru',
  'zh-hans',
];

/** Whether a supported locale is one a launched app ships copy in. */
export function isLaunchLocale(locale: SupportedLocale): boolean {
  return LAUNCH_LOCALES.includes(locale);
}

/* -------------------------------------------------------------------------- */
/* What the report covers, and what it does not                               */
/* -------------------------------------------------------------------------- */

/**
 * The catalog domains the completeness report measures.
 *
 * Derived from {@link LOCALIZED_ENTITY_KINDS} rather than restated, so a domain
 * that joins the resolver's registry joins this report in the same commit. A
 * hand-copied fourth entry is where a report starts quietly omitting a domain,
 * and an omission is indistinguishable from a domain with nothing outstanding.
 */
export const LOCALIZATION_COVERAGE_DOMAINS: readonly LocalizedEntityKind[] = LOCALIZED_ENTITY_KINDS;

/**
 * Family tables this report does NOT cover, each with the reason and the owner.
 *
 * The census this list exists for is the point.
 * {@link CATALOG_LOCALIZATION_TEXT_TABLES} is the whole localization family;
 * `catalog-localization-desk.test.ts` asserts that the tables covered by
 * {@link LOCALIZATION_COVERAGE_DOMAINS} plus the tables named here equal that
 * tuple EXACTLY. So a new family member fails the build until somebody decides
 * whether the desk measures it — which is the `merge-plan-census` device, and it
 * is the only thing standing between "this domain has no outstanding work" and
 * "this domain was never looked at". The two render identically in a report that
 * does not carry its own coverage.
 */
export const LOCALIZATION_COVERAGE_UNCOVERED_TABLES = [
  {
    table: 'attribute_labels',
    reason:
      'Now CARRIES the family columns and the machine-write guard, so the original reason ' +
      '(no status to count) is gone. What still keeps it out is that it has no ' +
      'LocalizedEntityKind and no entry in CATALOG_LOCALIZED_FIELDS, exactly like ' +
      'navigation_node_localizations below: there is no registered field to be complete ' +
      'ABOUT and no denominator rule. Adding the kind is the second half of this work and ' +
      'is a separate change, because it cascades into two exhaustive switches, a fifth ' +
      'revision trigger and a review path that could not compile before these columns.',
  },
  {
    table: 'navigation_node_localizations',
    reason:
      'Carries the family columns but has no LocalizedEntityKind and no entry in ' +
      'CATALOG_LOCALIZED_FIELDS, so there is no registered field to be complete ABOUT ' +
      'and no denominator rule stating which navigation nodes are owed copy. ADR 0007 ' +
      'D3 (#367 merge-order step 7) owns both; it joins this report when it registers ' +
      'its fields.',
  },
] as const;

/* -------------------------------------------------------------------------- */
/* How each domain learns its text went out of date                           */
/* -------------------------------------------------------------------------- */

/**
 * How a domain's translations come to be marked `stale`.
 *
 * A STRING discriminant, because the backend compiles with `strict: false` and
 * without `strictNullChecks` TypeScript does not narrow a union on the
 * truthiness of a boolean-literal member.
 */
export const LOCALIZATION_STALENESS_MECHANISMS = ['database_trigger', 'service_copy_forward'] as const;

/** How a domain's translations come to be marked `stale`. */
export type LocalizationStalenessMechanism = (typeof LOCALIZATION_STALENESS_MECHANISMS)[number];

/**
 * What marks one domain's translations stale, what it watches, and — the half
 * that matters — what it therefore cannot see.
 *
 * ## Why a `stale` count is not one measurement
 *
 * The three covered domains detect staleness three different ways, and a report
 * that summed their `stale` counts would be adding three different facts
 * together:
 *
 * - `category` and `attribute_value` are watched by AFTER UPDATE triggers on the
 *   source row, so their `stale` means "the source text changed underneath this
 *   translation". The category trigger watches `name` ALONE, so an edit to
 *   `categories.description` — a registered localized field with its own
 *   translations — marks NOTHING stale. That is a real, nameable blind spot and
 *   it is stated here rather than left for a reader to infer from a zero.
 * - `product_type` has NO trigger. Its translations are staled by
 *   `copyForwardProductTypeLocalizations` when a new version is published with a
 *   semantic change, so its `stale` means "carried onto a version whose meaning
 *   moved". A published version's meaning is frozen, so there is no in-place
 *   edit for a trigger to watch — but a version still in `draft` or `review` can
 *   have its source text edited with nothing marking its translations stale.
 *
 * `unwatched` names each blind spot as a VALUE rather than as prose, so a
 * consumer can render the caveat beside the figure instead of a reader having to
 * know it. `catalog-localization-desk.test.ts` reads the trigger SQL back out of
 * the migration and asserts the trigger name and the watched columns match what
 * is claimed here — the device `catalog-localization.test.ts` already uses on the
 * machine-write guard, and the only thing that keeps a hand-written trigger and
 * a descriptor of it from drifting apart.
 */
export interface LocalizationStalenessDetection {
  readonly domain: LocalizedEntityKind;
  readonly mechanism: LocalizationStalenessMechanism;
  /** The trigger or the function that performs the marking. */
  readonly performedBy: string;
  /** The `<table>.<column>` sources whose change marks a translation stale. */
  readonly watches: readonly string[];
  /** Source changes that leave a translation reading `approved` when it is not. */
  readonly unwatched: readonly string[];
  /**
   * What happens to this domain's translations when the parent version is
   * SUPERSEDED — a different question from staleness, and the one that decides
   * whether a completeness figure can fall for a reason that is not translator
   * inaction.
   *
   * `not_applicable` for a domain with no versions at all. `yes` names the
   * function that carries them. **`no` means the translations are silently LOST
   * on a version bump**, which makes this domain's completeness collapse to zero
   * for that key with nothing in the data saying why — so the report has to say
   * so beside the figure rather than leave a desk to rediscover it.
   */
  readonly carriesForwardOnVersionBump: 'yes' | 'no' | 'not_applicable';
  /** The issue that owes the gap, when `carriesForwardOnVersionBump` is `no`. */
  readonly knownGapIssue?: string;
}

export const LOCALIZATION_STALENESS_DETECTIONS: readonly LocalizationStalenessDetection[] = [
  {
    domain: 'category',
    mechanism: 'database_trigger',
    performedBy: 'mercaria_categories_localization_stale',
    watches: ['categories.name'],
    unwatched: [
      // A registered localized field (`category.description`) whose source is not
      // watched by the trigger. Widening the trigger's WHEN clause is the fix;
      // until somebody does, a description edit leaves its translations approved.
      'categories.description',
    ],
    carriesForwardOnVersionBump: 'not_applicable',
  },
  {
    domain: 'attribute_value',
    mechanism: 'database_trigger',
    performedBy: 'mercaria_attribute_enum_values_localization_stale',
    watches: ['attribute_enum_values.label', 'attribute_enum_values.value'],
    unwatched: [],
    carriesForwardOnVersionBump: 'not_applicable',
  },
  {
    domain: 'product_type',
    mechanism: 'service_copy_forward',
    performedBy: 'copyForwardProductTypeLocalizations',
    watches: ['product_type_definitions.version'],
    unwatched: [
      // A version in `draft` or `review` may still have its meaning edited
      // (PRODUCT_TYPE_EDITABLE_LIFECYCLES) and nothing marks its translations
      // stale, because the copy forward runs at publish and not at edit.
      'product_type_definitions.name (while draft or review)',
      'product_type_definitions.description (while draft or review)',
    ],
    carriesForwardOnVersionBump: 'yes',
  },
  {
    // #633's per-field authoring copy (ADR 0007 D10). It DOES have a trigger,
    // watching all four base columns, so its in-place staleness detection is the
    // most complete of the four.
    //
    // Its gap is the other question entirely, and it is the reason that question
    // is a field on this descriptor at all: `product_type_field_localizations`
    // hangs off a FIELD, `product_type_fields` rows are frozen and re-minted per
    // version, and `copyForwardProductTypeLocalizations` carries only
    // VERSION-level text. So publishing a new product-type version silently
    // drops every per-field translation, and this domain's completeness for that
    // key collapses to zero with nothing in the data saying why. A desk reading
    // the figure would conclude its translators had stopped working.
    domain: 'product_type_field',
    mechanism: 'database_trigger',
    performedBy: 'mercaria_product_type_fields_localization_stale',
    watches: [
      'product_type_fields.label',
      'product_type_fields.help_text',
      'product_type_fields.placeholder',
      'product_type_fields.example',
    ],
    unwatched: [],
    carriesForwardOnVersionBump: 'no',
    knownGapIssue: '#650',
  },
];

/* -------------------------------------------------------------------------- */
/* The completeness figure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What makes an entity OWED a translation, per domain.
 *
 * Three domains, three different rules, and none of them is derivable from the
 * localization tables — which is exactly why a report built only from those
 * tables cannot have a denominator at all. Stated as data so the report can
 * publish the rule beside the number, since a coverage figure whose population
 * is unstated is a number a reader cannot check.
 */
export const LOCALIZATION_OWED_POPULATION_RULES: Readonly<Record<LocalizedEntityKind, string>> =
  Object.freeze({
    category:
      'categories whose lifecycle is in CATEGORY_ACTIVE_LIFECYCLES (published). A draft is not ' +
      'yet copy anybody reads and a deprecated or merged one is copy nobody should be paying to ' +
      'translate.',
    product_type:
      'product_type_definitions VERSIONS whose lifecycle is published. Per version and not per ' +
      'key, because a translation is of a MEANING and D5 freezes a published version\'s: a v2 ' +
      'that changed what a field asks for must not inherit v1\'s help text. A draft or review ' +
      'version may still change meaning; a deprecated one accepts no new authoring.',
    attribute_value:
      'attribute_enum_values whose parent attribute_definitions.lifecycle_state is active. The ' +
      'enum value carries no lifecycle of its own, so the definition\'s is the only statement ' +
      'available about whether its labels are still worth translating.',
    product_type_field:
      'product_type_fields belonging to a PUBLISHED product-type version, and only those ' +
      'carrying at least one base-locale string. All four base columns are nullable, so a field ' +
      'with no label, help text, placeholder or example has nothing to translate and counting it ' +
      'would make every locale permanently incomplete by exactly the number of bare fields.',
  });

/**
 * How complete one (domain, locale) pair is.
 *
 * A discriminated union with a STRING discriminant, and the `no_population`
 * branch deliberately carries NO ratio and NO `bps`. A domain with nothing in it
 * is not 100% translated and it is not 0% translated — there is no question to
 * answer — and the difference matters precisely on a fresh deployment, where
 * every domain is empty and a percentage-shaped answer would report the
 * catalogue fully translated before anybody had written a word.
 */
export type LocalizationCompleteness =
  | {
      readonly kind: 'measured';
      /** Rows a human settled: `reviewed` or `approved`, in this exact locale. */
      readonly settled: number;
      /** The entity population owed a translation. Never zero in this branch. */
      readonly owed: number;
      /** `settled / owed` in basis points, floored. */
      readonly settledBps: number;
    }
  | {
      readonly kind: 'no_population';
      readonly reason: 'no_translatable_entities';
    };

/**
 * One domain's translation state in one locale.
 *
 * Every status in `LOCALIZATION_STATUSES` gets its own field, plus `absent` —
 * the count with no row at all, which is the one the localization tables
 * structurally cannot report and is usually the largest. `missing` and `absent`
 * are held apart deliberately: the schema's own CHECK makes `missing` a row
 * somebody OPENED to say a translation is owed, and collapsing the two would
 * make a desk that has triaged nothing indistinguishable from one that has
 * triaged everything.
 */
export interface LocaleDomainCompleteness {
  readonly domain: LocalizedEntityKind;
  readonly locale: SupportedLocale;
  readonly launchLocale: boolean;
  /** The denominator — see {@link LOCALIZATION_OWED_POPULATION_RULES}. */
  readonly owed: number;
  /** Owed entities carrying no row for this locale at all. */
  readonly absent: number;
  readonly missing: number;
  readonly machineTranslated: number;
  readonly reviewed: number;
  readonly approved: number;
  readonly stale: number;
  readonly deprecated: number;
  readonly completeness: LocalizationCompleteness;
}

/**
 * The whole report: every covered domain against every requested locale, with
 * the report's own coverage and caveats travelling beside the figures.
 *
 * `uncoveredTables` and `stalenessDetections` are part of the PAYLOAD rather
 * than documentation, for the reason the guest portal's plain-language summary
 * is: a caveat a consumer has to look up is a caveat three consumers will render
 * three different ways, and two of them will omit it.
 */
export interface LocalizationCompletenessReport {
  readonly generatedAt: string;
  readonly baseLocale: SupportedLocale;
  readonly locales: readonly SupportedLocale[];
  readonly domains: readonly LocalizedEntityKind[];
  readonly rows: readonly LocaleDomainCompleteness[];
  readonly uncoveredTables: typeof LOCALIZATION_COVERAGE_UNCOVERED_TABLES;
  readonly stalenessDetections: readonly LocalizationStalenessDetection[];
}

/* -------------------------------------------------------------------------- */
/* Alerts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a launch-locale gap IS.
 *
 * A closed set, and every member names a state a shopper in a launched market
 * can actually reach. There is deliberately no `ok` member: an alert set is the
 * findings, and a "no problem" finding is how a list of problems acquires
 * padding that hides the real ones.
 */
export const LOCALIZATION_ALERT_KINDS = [
  /** Owed entities with no row and no text — a shopper reads the base locale. */
  'untranslated',
  /** Text a source change invalidated. Still served, still wrong. */
  'stale',
  /** Servable text, but no human has settled any of it. */
  'machine_only',
  /** Rows exist for a locale whose owed population is zero — nothing to measure. */
  'unmeasurable',
] as const;

export type LocalizationAlertKind = (typeof LOCALIZATION_ALERT_KINDS)[number];

/**
 * How much a gap matters.
 *
 * `blocking` is reserved for a launched market reading untranslated copy;
 * everything else is a `warning`. The two are separate values rather than a
 * score because a threshold is a number somebody tunes until the dashboard is
 * green, and the question here is categorical.
 */
export const LOCALIZATION_ALERT_SEVERITIES = ['blocking', 'warning'] as const;

export type LocalizationAlertSeverity = (typeof LOCALIZATION_ALERT_SEVERITIES)[number];

/** One finding about one (domain, locale) pair in a launched market. */
export interface LocalizationAlert {
  readonly kind: LocalizationAlertKind;
  readonly severity: LocalizationAlertSeverity;
  readonly domain: LocalizedEntityKind;
  readonly locale: SupportedLocale;
  /** How many entities the finding is about. */
  readonly affected: number;
  /** The owed population the finding sits in. */
  readonly owed: number;
  /**
   * What a reader must know to read `affected` correctly — today, whether this
   * domain's staleness detection has a blind spot. Empty for a domain whose
   * detection watches everything it localizes.
   */
  readonly caveats: readonly string[];
}

/**
 * The alert surface's answer.
 *
 * `evaluatedPairs` is the vacuity floor and it is part of the payload: a run
 * that evaluated nothing produces an empty `alerts` array, which is
 * byte-identical to a run that evaluated everything and found nothing wrong.
 * The count is what tells the two apart, and a consumer rendering "all clear"
 * without reading it is rendering a claim nobody measured.
 */
export interface LocalizationAlertReport {
  readonly generatedAt: string;
  readonly launchLocales: readonly SupportedLocale[];
  /** `domains × launchLocales` — the number of pairs actually examined. */
  readonly evaluatedPairs: number;
  readonly alerts: readonly LocalizationAlert[];
}

/* -------------------------------------------------------------------------- */
/* Side-by-side review                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One field of one entity, source beside target.
 *
 * `target` is a discriminated union on a STRING, and its `absent` branch carries
 * no text, no status and no provenance — so a review UI cannot render an empty
 * string as though somebody had written one. The distinction the branches keep
 * is the same one the completeness report keeps: `absent` (no row) and `missing`
 * (a row saying a translation is owed) are different states of the desk.
 */
export type LocalizedFieldTarget =
  | {
      readonly kind: 'present';
      readonly text: string;
      readonly status: string;
      readonly provenance: string;
      readonly sourceLocale: string | null;
      readonly sourceRevision: string | null;
      readonly reviewedByOxyUserId: string | null;
      readonly reviewedAt: string | null;
    }
  | {
      readonly kind: 'declared_missing';
      readonly status: 'missing';
      readonly provenance: string;
    }
  | { readonly kind: 'absent' };

/**
 * Which entity column holds a registered field's BASE-locale text, or the fact
 * that no column holds it.
 *
 * Three of the six registered fields have no base-locale counterpart in the
 * schema at all: `categories` has no `description`, and
 * `product_type_definitions` has no help text. `read.service.ts` already knows
 * one of them — it resolves `category.description` with `baseValue: null` — and
 * this states all three in one place so a reviewer's screen can say "there is no
 * source for this field" rather than rendering an empty box that reads as "the
 * source was blank".
 *
 * `catalog-localization-desk.test.ts` walks the real drizzle tables and asserts
 * every `column` named here EXISTS and every `none` genuinely has no
 * same-named column — so a base column ADDED later fails the build here rather
 * than silently continuing to report "no source".
 */
export type LocalizedFieldBaseSource =
  | { readonly kind: 'column'; readonly table: string; readonly column: string }
  | { readonly kind: 'none'; readonly reason: string };

export const LOCALIZED_FIELD_BASE_SOURCES: Readonly<Record<string, LocalizedFieldBaseSource>> =
  Object.freeze({
    'category.name': { kind: 'column', table: 'categories', column: 'name' },
    'category.description': {
      kind: 'none',
      reason:
        '`categories` carries no description column. A category with no description in any ' +
        'locale has none, and inventing one from the name is how a catalogue starts asserting ' +
        'things nobody wrote.',
    },
    'product_type.name': { kind: 'column', table: 'product_type_definitions', column: 'name' },
    'product_type.description': {
      kind: 'column',
      table: 'product_type_definitions',
      column: 'description',
    },
    'product_type.help_text': {
      kind: 'none',
      reason:
        '`product_type_definitions` carries no help-text column — authoring guidance exists ' +
        'only as localized text, so every locale including the base one is a row.',
    },
    'attribute_value.label': {
      kind: 'column',
      table: 'attribute_enum_values',
      column: 'label',
    },
    // #633's four. Unlike every other entity here, `product_type_fields` carries
    // a base-locale counterpart for ALL of its localized fields — which is why
    // this domain is the only one whose review screen never shows an empty
    // source box for a structural reason.
    'product_type_field.label': {
      kind: 'column',
      table: 'product_type_fields',
      column: 'label',
    },
    'product_type_field.help_text': {
      kind: 'column',
      table: 'product_type_fields',
      column: 'help_text',
    },
    'product_type_field.placeholder': {
      kind: 'column',
      table: 'product_type_fields',
      column: 'placeholder',
    },
    'product_type_field.example': {
      kind: 'column',
      table: 'product_type_fields',
      column: 'example',
    },
  });

/** One field's source text beside its target, for a reviewer. */
export interface LocalizedFieldComparison {
  readonly field: string;
  /**
   * Where this field's base-locale text lives, or that nowhere does.
   *
   * Carried on every comparison rather than looked up by the client, so a screen
   * showing one field in isolation still shows why its source box is empty.
   */
  readonly baseSource: LocalizedFieldBaseSource;
  /**
   * The base-locale text itself. `null` both when `baseSource.kind === 'none'`
   * and when the column exists and holds nothing — `baseSource` is what tells
   * those two apart, which is the whole reason it travels beside this.
   */
  readonly source: string | null;
  readonly target: LocalizedFieldTarget;
}

/** One entity in one locale, every registered field, source beside target. */
export interface LocalizedEntityComparison {
  readonly domain: LocalizedEntityKind;
  readonly entityId: string;
  readonly locale: SupportedLocale;
  readonly baseLocale: SupportedLocale;
  readonly fields: readonly LocalizedFieldComparison[];
  /** How this domain would learn the source moved. See the staleness note. */
  readonly stalenessDetection: LocalizationStalenessDetection;
}

/** Every supported locale, for a caller that wants the whole picture. */
export const ALL_REPORTABLE_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES.filter(
  (locale) => locale !== MERCARIA_BASE_LOCALE,
);
