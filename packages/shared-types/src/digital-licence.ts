/**
 * What a buyer is ALLOWED TO DO with a deliverable — the licence half of #1015
 * Workstream 2 (ADR 0010 D2, D3).
 *
 * ## A licence is not a variant, and this module is why
 *
 * #1015 boundary 5: *"a license is not a product variant merely because it
 * changes price"*. The temptation is obvious — Personal €6 and Commercial €25
 * look exactly like two variants of one product — and taking it would make the
 * RIGHTS a string on an option row, unversioned, editable, and snapshotted
 * nowhere. So a licence is its own versioned aggregate and an offer REFERENCES
 * one. Price stays where price lives.
 *
 * ## Three levels, and each one exists because the one above it cannot be frozen
 *
 * - **Definition** — the creator's (or Mercaria's) named licence, e.g.
 *   *"Example Studio Commercial"*. Mutable metadata only: a name and a slug.
 * - **Version** — the TERMS, immutable once published. Every right, bound and
 *   piece of prose a buyer is held to. ADR 0010 D3: editing a licence tomorrow
 *   cannot change yesterday's purchase, and the mechanism is that yesterday's
 *   purchase names a version row nothing may update.
 * - **Option** — the offer-facing choice: *this* licence version, over *this*
 *   package, with *this* update policy. What a product page lists under
 *   "Choose license".
 *
 * ## The rights are a CLOSED vocabulary, and bounded custom terms are the escape
 *
 * An open prose field would make every licence unmachine-readable and every
 * comparison between two of them a human reading. So the rights are a tuple, the
 * numeric bounds are named columns, and a creator's own wording rides alongside
 * as {@link DigitalLicenceVersionTerms.additionalTerms} — bounded, displayed,
 * and never consulted by code. That is `services/analytics/`'s "no property bag"
 * rule applied to a legal surface: what code enforces must be enumerable.
 */

/* -------------------------------------------------------------------------- */
/* The rights vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every right a licence version may grant.
 *
 * A GRANT list rather than a restriction list, and that asymmetry is
 * deliberate: #1015 W2 requirement 6 says redistribution of source files is
 * forbidden BY DEFAULT, and a default-deny vocabulary states that by the right
 * simply being absent. A default-allow list with `redistribution_forbidden`
 * flags would make a forgotten flag a silent grant.
 */
export const DIGITAL_LICENCE_RIGHTS = [
  /** Use the deliverable for the buyer's own non-commercial purposes. */
  'personal_use',
  /** Use it in a commercial project — a game, app, film, client deliverable. */
  'commercial_project_use',
  /** Produce physical copies commercially — the 3D-print rights. */
  'commercial_physical_production',
  /** Modify the deliverable. */
  'modification',
  /** Redistribute a DERIVATIVE (a modified form), subject to the bounds below. */
  'derivative_redistribution',
  /** Redistribute the SOURCE files as supplied. Rarely granted; never default. */
  'source_redistribution',
  /** Sub-license onward to a client, for agency and studio work. */
  'sublicensing',
  /** Use it beyond the seat and revenue bounds a standard licence carries. */
  'extended_enterprise_use',
] as const;

/** One of {@link DIGITAL_LICENCE_RIGHTS}. */
export type DigitalLicenceRight = (typeof DIGITAL_LICENCE_RIGHTS)[number];

/**
 * The rights no licence version may grant without also granting the one it
 * depends on, as PAIRS of `[right, requires]`.
 *
 * Redistributing a derivative you may not create is not a licence, it is a
 * contradiction, and a creator configuring one would ship terms whose two halves
 * disagree. Enforced at write time and pinned by a test; deliberately NOT a
 * database CHECK, because a CHECK over two array elements of one column reads as
 * an accident the next reader will simplify away.
 */
export const DIGITAL_LICENCE_RIGHT_DEPENDENCIES: readonly (readonly [
  DigitalLicenceRight,
  DigitalLicenceRight,
])[] = [
  ['derivative_redistribution', 'modification'],
  ['sublicensing', 'commercial_project_use'],
];

/**
 * Whether attribution is required, optional or may not be demanded.
 *
 * Three values rather than a boolean, because `not_required` and
 * `must_not_be_required` are different statements: the second is what a licence
 * says when a creator has chosen to waive credit entirely, and a boolean cannot
 * hold it (#1015 W2 requirement 5 — *"where allowed"*).
 */
export const DIGITAL_LICENCE_ATTRIBUTION_MODES = [
  'required',
  'optional',
  'not_required',
] as const;

/** One of {@link DIGITAL_LICENCE_ATTRIBUTION_MODES}. */
export type DigitalLicenceAttributionMode = (typeof DIGITAL_LICENCE_ATTRIBUTION_MODES)[number];

/**
 * Whether a later version of the asset is included in what was bought.
 *
 * ADR 0010 D4's answer, and the reason it is a CLOSED tuple on the OPTION rather
 * than a platform-wide rule: #1015 W14 asks the question and every plausible
 * answer is somebody's real commercial model. Pinning one would make the others
 * unrepresentable, and deriving it at read time would mean a buyer's rights
 * changed when Mercaria changed its mind.
 *
 * - `purchased_version_only` — exactly the version bought, forever.
 * - `same_major_version` — later versions sharing the purchased major.
 * - `all_future_versions` — every version the creator ever publishes.
 */
export const DIGITAL_LICENCE_UPDATE_POLICIES = [
  'purchased_version_only',
  'same_major_version',
  'all_future_versions',
] as const;

/** One of {@link DIGITAL_LICENCE_UPDATE_POLICIES}. */
export type DigitalLicenceUpdatePolicy = (typeof DIGITAL_LICENCE_UPDATE_POLICIES)[number];

/**
 * Where a licence version's text came from.
 *
 * A Mercaria-authored reference licence and a creator's own are held identically
 * and rendered differently: a buyer comparing two creators' "Commercial"
 * licences needs to know which of them is the platform's standard text.
 */
export const DIGITAL_LICENCE_AUTHORSHIPS = ['mercaria_reference', 'creator'] as const;

/** One of {@link DIGITAL_LICENCE_AUTHORSHIPS}. */
export type DigitalLicenceAuthorship = (typeof DIGITAL_LICENCE_AUTHORSHIPS)[number];

/** Where a licence version is in its life. Only `published` may be acquired. */
export const DIGITAL_LICENCE_VERSION_STATES = ['draft', 'published', 'retired'] as const;

/** One of {@link DIGITAL_LICENCE_VERSION_STATES}. */
export type DigitalLicenceVersionState = (typeof DIGITAL_LICENCE_VERSION_STATES)[number];

/* -------------------------------------------------------------------------- */
/* The terms a version freezes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The complete, machine-readable terms of ONE licence version.
 *
 * This is the shape a purchase SNAPSHOTS (#1015 acceptance criterion 5). It is
 * an interface rather than a table row type because the same object is what the
 * product page renders, what the order line stores and what a dispute is
 * answered from — three readers of one fact, which is exactly the case a shared
 * DTO exists for.
 */
export interface DigitalLicenceVersionTerms {
  /** Every right granted. Absent from the list means NOT granted. */
  readonly rights: readonly DigitalLicenceRight[];
  readonly attribution: DigitalLicenceAttributionMode;
  /**
   * How many people may use it, or `null` for unbounded.
   *
   * #1015 W2 requirement 7: *"only when meaningful"*. `null` is the ordinary
   * case and a number is the exception, which is why the column is nullable
   * rather than defaulted to 1 — a default of 1 would silently make every
   * unbounded licence a single-seat one.
   */
  readonly seatLimit: number | null;
  /**
   * A revenue ceiling in MINOR UNITS of {@link revenueLimitCurrency}, or `null`.
   *
   * `bigint` in Postgres for the `CURRENCY_PRECISION.FAIR === 8` reason every
   * money column here is (`CONVENTIONS.md` §Money), even though this is a bound
   * rather than a transacted amount: a ceiling that overflows is a ceiling that
   * silently becomes a small number.
   */
  readonly revenueLimitAmount: number | null;
  /** Required exactly when {@link revenueLimitAmount} is present. */
  readonly revenueLimitCurrency: string | null;
  /** How many distinct end products it may appear in, or `null`. */
  readonly projectLimit: number | null;
  /**
   * The creator's own wording, displayed verbatim and consulted by NO code.
   *
   * Bounded at {@link DIGITAL_LICENCE_TEXT_LIMITS}.additionalTerms. It may
   * ADD obligations and may never contradict the rights above — a creator
   * writing "no commercial use" into a version that grants
   * `commercial_project_use` is a configuration error a reviewer catches, not
   * something code can adjudicate, and pretending otherwise is what an open
   * prose field enforced by a parser would be.
   */
  readonly additionalTerms: string | null;
}

/** Length ceilings, shared by the zod schema, the client form and the columns. */
export const DIGITAL_LICENCE_TEXT_LIMITS = {
  name: 160,
  summary: 600,
  additionalTerms: 20_000,
} as const;

/**
 * Whether a set of rights is internally consistent.
 *
 * Exported rather than inlined in the service, because #1015's acceptance is a
 * claim about the RULE and a test that drives the rule directly is the evidence.
 * Returns the offending pairs so a caller can say which dependency is unmet,
 * and `[]` — not `true` — for a valid set, so an empty result cannot be
 * confused with a refusal.
 */
export function unmetLicenceRightDependencies(
  rights: readonly DigitalLicenceRight[],
): readonly (readonly [DigitalLicenceRight, DigitalLicenceRight])[] {
  const granted = new Set<DigitalLicenceRight>(rights);
  return DIGITAL_LICENCE_RIGHT_DEPENDENCIES.filter(
    ([right, requires]) => granted.has(right) && !granted.has(requires),
  );
}

/**
 * The three reference licences Mercaria publishes for the 3D pilot.
 *
 * Data, not code: a creator who wants the platform's standard terms picks one of
 * these, and #1015 acceptance criterion 2 — *"at least personal and one
 * commercial licence"* — is then satisfiable without a creator drafting legal
 * text. `source_redistribution` appears in none of them, which is requirement 6
 * holding by construction rather than by a flag nobody set.
 */
export const MERCARIA_REFERENCE_LICENCES: readonly {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly terms: DigitalLicenceVersionTerms;
}[] = [
  {
    slug: 'mercaria-personal',
    name: 'Personal use',
    summary:
      'Use and modify the files for your own personal projects. No commercial use, and no redistribution of the files themselves.',
    terms: {
      rights: ['personal_use', 'modification'],
      attribution: 'optional',
      seatLimit: 1,
      revenueLimitAmount: null,
      revenueLimitCurrency: null,
      projectLimit: null,
      additionalTerms: null,
    },
  },
  {
    slug: 'mercaria-commercial-project',
    name: 'Commercial project',
    summary:
      'Use and modify the files in commercial projects — games, apps, film, client work — and redistribute them only as part of a finished work.',
    terms: {
      rights: [
        'personal_use',
        'commercial_project_use',
        'modification',
        'derivative_redistribution',
      ],
      attribution: 'optional',
      seatLimit: null,
      revenueLimitAmount: null,
      revenueLimitCurrency: null,
      projectLimit: null,
      additionalTerms: null,
    },
  },
  {
    slug: 'mercaria-commercial-print',
    name: 'Commercial print',
    summary:
      'Produce and sell physical copies of the model. Covers printing and selling printed items; does not permit selling the digital files.',
    terms: {
      rights: [
        'personal_use',
        'commercial_physical_production',
        'modification',
      ],
      attribution: 'optional',
      seatLimit: null,
      revenueLimitAmount: null,
      revenueLimitCurrency: null,
      projectLimit: null,
      additionalTerms: null,
    },
  },
];
