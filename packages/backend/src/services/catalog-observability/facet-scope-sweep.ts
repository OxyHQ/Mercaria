/**
 * The facet-scope empty-generation sweep (#367 Workstream 17).
 *
 * One question: **which category scopes would render a bare filter rail if a
 * shopper visited them.** It is the numerator of `facet_scope_empty_rate`, and
 * it is a property of the CATALOGUE rather than of traffic — nothing here knows
 * or could know whether anybody visits the categories it reports.
 *
 * W17 asks for three facts about facets and they are not the same fact:
 *
 * - **latency** is the route timer's (`route-observations.ts`), measured per
 *   request in this process;
 * - **usage** — did a shopper APPLY a facet — is a CLIENT fact. #77 defines no
 *   facet event and the storefront has no analytics client, so
 *   `facet_usage_rate` is declared `unmeasured` in the registry with #111 named
 *   as its seam. Nothing here fabricates a substitute: a category that
 *   generates facets says nothing about whether they were worth generating;
 * - **empty generation** is this file, and it is measurable today because it is
 *   a question about published rows rather than about people.
 *
 * ## The real rail is what is measured, not a re-derivation of it
 *
 * `examineFacetScope` calls `resolveFacets` — the facets domain's own composer,
 * on the same scope shape and the same defaults the `/facets` route hands a
 * shopper who has expressed no preference — and reads `response.facets.length`.
 * There is no second copy of facet generation here, and there deliberately is no
 * SQL in this module that touches an attribute, a product type or an offer.
 *
 * The cheaper reading was considered and REJECTED: `planFacets` alone (three
 * metadata statements per scope against the whole rail's ten) is wrong in BOTH
 * directions, so its cost saving buys a number that answers nothing.
 *
 * - It is wrong high: a plan entry that survives planning is still suppressed at
 *   COUNT time (`no_values`, `single_value`, `degenerate_range`), so a scope
 *   whose every facet is withheld for want of data reports a populated rail
 *   while a shopper sees nothing.
 * - It is wrong low: the taxonomy refinement and the five commerce dimensions
 *   (price, availability, condition, market, channel) are composed by
 *   `resolveFacets` and appear in no plan at all, so a scope with no faceted
 *   ATTRIBUTES — which is every scope in a deployment with no published product
 *   type, i.e. today's — reports a bare rail while a shopper sees six facets.
 *
 * ## Sampled, deterministically, and the population is stated beside it
 *
 * The whole rail costs TEN statements per scope — measured, on a scope with no
 * faceted attribute, which is every scope in a deployment with no published
 * product type — and it grows with the attributes a category scopes in, since
 * the labels, the controlled values, the observed spellings and the per-grain
 * aggregates are all reads. So a sweep over every published category is one
 * somebody switches off after the first incident it makes worse. The draw is
 * therefore capped
 * ({@link FACET_SCOPE_SWEEP_DEFAULT_SAMPLE_SIZE}) and `population` — a real
 * `count(*)` over the SAME predicate the draw runs over — says what the sample
 * is a sample OF. `truncated` says whether the cap bit.
 *
 * The draw is `order by md5(<seed> || id)`: deterministic, so two runs over an
 * unchanged catalogue draw the same scopes and a moved number is a moved
 * catalogue rather than a moved sample; and UNIFORM, which `order by id limit n`
 * is not — ids here are uuid v7, so ordering by id is ordering by creation time
 * and the sweep would re-examine the oldest corner of the taxonomy forever and
 * publish it as a fact about all of it (#65's reasoning about its own
 * reconciliation sample). The cost is one sort over the eligible set, which is
 * the price of the uniformity and is paid once per sweep.
 *
 * ## `0 / 0` is not a clean catalogue and it is not 100% either
 *
 * `emptyRatio` is OMITTED when `sampled` is zero rather than reported as `0` or
 * `1` — `catalog-governance/quality.service.ts`'s `cell()` decision, and the
 * same one `CatalogMetricReading` records for the whole registry. A deployment
 * that has published no selectable category yet reaches that branch through
 * `population === 0` forcing `drawn === 0`; a sweep configured to draw nothing
 * reaches it directly. Both are MEASURED readings with an empty denominator, and
 * neither is a percentage.
 *
 * ## Three counters and none of them absorbs another
 *
 * `sampled === empty + populated`, and `drawn === sampled + failed`. A scope
 * whose facet generation RAISED has no verdict: folding it into `populated`
 * dilutes the rate that matters and folding it into `empty` inflates it, so it
 * is counted on its own and excluded from the denominator. That is why the
 * metric's denominator is `sampled` and not `drawn`.
 *
 * ## `invalid` names TWO things, and only one of them is unmeasured
 *
 * W17 names "empty/invalid facet generation", and that word does two jobs. The
 * distinction is the whole of this section, because an earlier version of it
 * argued the unmeasurable half and reported both.
 *
 * **"A facet was generated, returned, and is unusable" is unmeasured, and the
 * reason is a fact about the domain.** `FacetSuppressionReason` is a closed set
 * of NINE members and every one says a facet was WITHHELD.
 * `unsupported_value_type` and `unconvertible_currency` come closest and are
 * still withholdings — the rail declined to render, which is the domain
 * working. Nothing validates facet OUTPUT anywhere: the route mounts
 * `validateBody(facetRequestSchema)`, which is the REQUEST, and there is no
 * response schema and no post-generation check. So this half is reported as
 * {@link FacetScopeInvalidUnmeasured} with no `count` property for anybody to
 * read, and it is not folded into `empty`, because "no facet was offered" and
 * "a facet was offered and is broken" lead an operator to opposite actions.
 *
 * **"Facet generation FAILED" is measured, and this module has always measured
 * it.** A scope whose planning raised is counted in `failed` and its id kept in
 * `failedSample`. That count is now published as
 * `facet_scope_generation_failure_rate` (`failed / drawn`), and the live
 * equivalent is `facet_generation_error_rate` over `POST /facets`' 5xx. Until
 * those two existed, the `warn` below said the count was the aggregate signal
 * and the count reached nobody — the instrument was recording and nothing read
 * it, which is the failure this whole file is otherwise about.
 *
 * What IS reported is `emptyReasons` — the domain's own reasons, as the domain
 * gave them, over the empty scopes only. It is diagnostic and NOT a partition
 * (a scope withholding three facets appears in three buckets), which is why it
 * is not a `CatalogMetricBucket[]` and must not be passed as a metric's `by`.
 */

import { sql, type SQL } from 'drizzle-orm';
import type {
  CatalogUnmeasuredReason,
  CurrencyCode,
  FacetSuppressionReason,
} from '@mercaria/shared-types';
import { MERCARIA_BASE_LOCALE } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { resolveFacets } from '../facets/facet.service.js';

/* -------------------------------------------------------------------------- */
/* Bounds and the observation frame                                            */
/* -------------------------------------------------------------------------- */

/**
 * How many scopes one sweep examines unless it is told otherwise.
 *
 * Modest on purpose. The whole rail is ten statements per scope at the measured
 * floor and more where a category scopes in attributes, so this is a couple of
 * thousand statements an hour against a metric whose declared freshness is 3600
 * seconds — and an operator who wants a tighter estimate can raise it for one run
 * rather than for every run forever.
 */
export const FACET_SCOPE_SWEEP_DEFAULT_SAMPLE_SIZE = 200;

/**
 * The ceiling a caller cannot argue past.
 *
 * A parameter with no upper bound is an unbounded sweep with extra steps: the
 * first person who wants an exact number passes the size of the taxonomy and the
 * sweep becomes the incident. Asking for more is clamped, and `drawn` beside
 * `population` is what says the answer is still an estimate.
 */
export const FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE = 2000;

/** How many offending category ids a result carries. */
export const FACET_SCOPE_SWEEP_SAMPLE_LIMIT = 20;

/**
 * The seed the deterministic draw uses unless a caller names another.
 *
 * A constant rather than a clock, which is the whole property: the same
 * catalogue draws the same scopes on every run, so a change in the number is a
 * change in the catalogue. Rotating it re-draws the sample deliberately, which
 * is what somebody wants after fixing what a sweep found and wanting a second
 * opinion from different rows.
 */
export const FACET_SCOPE_SWEEP_DEFAULT_SEED = 'facet-scope-sweep/v1';

/**
 * The display currency the sweep measures in.
 *
 * `FAIR`, because that is what `facets.controller.ts` gives a shopper who has
 * chosen no currency, and the sweep's whole subject is what such a shopper would
 * see. It is restated here rather than imported because the controller's constant
 * is a SERVING default and this one is part of a metric's definition: the two
 * agreeing today is the point, and a serving change must not silently redefine a
 * published number.
 *
 * It is load-bearing and it is disclosed in `frame`: a scope priced entirely in
 * a currency Mercaria cannot convert to this one has no price facet, so the
 * currency the sweep ran in is part of what the number means.
 */
export const FACET_SCOPE_SWEEP_CURRENCY: CurrencyCode = 'FAIR';

/**
 * Whether the swept scope includes the subtree beneath each category.
 *
 * TRUE, and it is not a preference: `includeDescendants` defaults true on the
 * `/facets` route, so a shopper standing on a grouping category sees the
 * subtree's facets. Sweeping with it false would report every grouping root in
 * the taxonomy as a bare rail — a large, confident, entirely wrong number.
 */
export const FACET_SCOPE_SWEEP_INCLUDE_DESCENDANTS = true;

/**
 * The presentation frame one sweep ran in, echoed on its result.
 *
 * A facet count is not frame-independent — the locale decides labels and the
 * currency decides whether the price facet can be composed at all — so a number
 * that does not name its frame cannot be compared with another one.
 */
export interface FacetScopeSweepFrame {
  readonly locale: string;
  readonly displayCurrency: CurrencyCode;
  readonly includeDescendants: boolean;
}

/** How the sample was drawn, echoed so a reading can be reproduced. */
export interface FacetScopeSweepDraw {
  readonly seed: string;
  readonly sampleSize: number;
  /** Present when the sweep was narrowed to one subtree. */
  readonly rootCategoryId?: string;
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What one scope turned out to be.
 *
 * A string discriminant, never a boolean-literal one: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean member.
 *
 * `facetCount` exists on the `facets_generated` branch ONLY. There is no facet
 * count on a bare rail for a caller to sum, and no suppression list on a failure
 * — a scope whose generation raised produced no rail to have reasons about.
 */
export type FacetScopeVerdict =
  | {
      readonly outcome: 'facets_generated';
      readonly categoryId: string;
      /** At least one, by construction. */
      readonly facetCount: number;
      readonly suppressed: readonly FacetSuppressionReason[];
    }
  | {
      readonly outcome: 'no_facets';
      readonly categoryId: string;
      /** The domain's own reasons for the rail being bare. May be empty. */
      readonly suppressed: readonly FacetSuppressionReason[];
    }
  | {
      readonly outcome: 'generation_failed';
      readonly categoryId: string;
    };

/**
 * Why a bare rail was bare, in the facets domain's own vocabulary.
 *
 * A COUNT and no denominator, deliberately. These buckets overlap — one scope
 * withholding three facets appears three times — so a ratio over them would be
 * a percentage of nothing, and `CatalogMetricBucket`, which requires a
 * denominator and reads as a partition, is the wrong shape to hand a consumer.
 */
export interface FacetScopeEmptyReason {
  readonly reason: FacetSuppressionReason;
  /** How many of the EMPTY scopes reported this reason at least once. */
  readonly scopes: number;
}

/**
 * `invalid` has one state and it is `unmeasured`.
 *
 * There is no `count` property, in any branch, because there is no branch: the
 * facets domain publishes no unusable-facet verdict, so a number here could only
 * be one this file made up. The `GuestSellerActivation` device — the value that
 * would mean "yes" is unrepresentable rather than refused.
 *
 * Closing it is a change in the FACETS domain, not here: a suppression reason
 * (or a distinct verdict) meaning "this facet was generated and cannot be used",
 * at which point this type grows a `measured` branch and `sweepFacetScopes`
 * fills it from the same verdicts it already collects.
 */
export interface FacetScopeInvalidUnmeasured {
  readonly state: 'unmeasured';
  readonly reason: CatalogUnmeasuredReason;
  /** What would close it. Required — an unmeasured figure with no owner is an apology. */
  readonly seam: string;
}

/** The one value {@link FacetScopeSweepResult.invalid} can take today. */
export const FACET_SCOPE_INVALID_UNMEASURED: FacetScopeInvalidUnmeasured = Object.freeze({
  state: 'unmeasured',
  reason: 'dimension_absent_from_source' as CatalogUnmeasuredReason,
  seam:
    'The facets domain has no invalid-facet verdict: every FacetSuppressionReason says a facet '
    + 'was WITHHELD, which is the rail declining to render rather than a broken facet. Closing it '
    + 'is a verdict in services/facets, not a derivation here.',
});

/* -------------------------------------------------------------------------- */
/* The result                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One sweep, completely stated.
 *
 * `numerator` is `empty`, `denominator` is `sampled`, and `emptyRatio` is
 * present exactly when `sampled > 0`. `population` is NOT the denominator: it is
 * the population the sample was drawn from, and a consumer that used it as one
 * would divide the empties among rows nothing examined.
 */
export interface FacetScopeSweepResult {
  /** Eligible scopes: published, selectable categories. A real `count(*)`. */
  readonly population: number;
  /** How many the deterministic draw selected. `min(population, sampleSize)`. */
  readonly drawn: number;
  /** How many produced a verdict. `empty + populated`, and the DENOMINATOR. */
  readonly sampled: number;
  /** Verdict: the rail is bare. The NUMERATOR. */
  readonly empty: number;
  /** Verdict: at least one facet. */
  readonly populated: number;
  /** Generation raised. No verdict, in neither bucket, excluded from `sampled`. */
  readonly failed: number;
  /** `empty / sampled`. Omitted when `sampled` is zero — never `0`, never `1`. */
  readonly emptyRatio?: number;
  /** Whether the cap bit, i.e. `population > drawn`. */
  readonly truncated: boolean;
  /** Always unmeasured. See {@link FACET_SCOPE_INVALID_UNMEASURED}. */
  readonly invalid: FacetScopeInvalidUnmeasured;
  /** Diagnostic, overlapping, not a partition. Descending by `scopes`. */
  readonly emptyReasons: readonly FacetScopeEmptyReason[];
  /** Bounded sample of category IDS whose rail is bare. Never a localized name. */
  readonly emptySample: readonly string[];
  /** Bounded sample of category IDS whose generation raised. */
  readonly failedSample: readonly string[];
  readonly frame: FacetScopeSweepFrame;
  readonly draw: FacetScopeSweepDraw;
  readonly sweptAt: string;
}

/** What one sweep may be told. */
export interface FacetScopeSweepOptions {
  readonly db?: DatabaseOrTransaction;
  /** Clamped to `[0, FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE]`. Zero draws nothing. */
  readonly sampleSize?: number;
  readonly seed?: string;
  /**
   * Narrow the population to one category and its subtree.
   *
   * The operator affordance after publishing a subtree — "did what I just
   * published come out with filters" — served by the GIN index on
   * `categories.ancestor_ids`. A narrowed sweep is EXACT rather than an estimate
   * whenever `truncated` is false, and `population` says which population was
   * measured either way.
   */
  readonly rootCategoryId?: string;
  readonly locale?: string;
  readonly displayCurrency?: CurrencyCode;
  readonly now?: Date;
}

/* -------------------------------------------------------------------------- */
/* One scope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generate one scope's rail and report what came out.
 *
 * Exported because it is the unit of ISOLATION, not for convenience: an operator
 * examining one category and the sweep examining two hundred must run the same
 * code, or the number the sweep publishes is about a path nobody can reproduce.
 *
 * It THROWS. Catching lives in {@link sweepFacetScopes}, one level up, so that a
 * caller asking about one category gets the real failure rather than a verdict
 * that quietly means "we could not tell".
 */
export async function examineFacetScope(input: {
  readonly db: DatabaseOrTransaction;
  readonly categoryId: string;
  readonly frame: FacetScopeSweepFrame;
  readonly now: Date;
}): Promise<FacetScopeVerdict> {
  const { response } = await resolveFacets(
    {
      scope: {
        kind: 'category',
        categoryId: input.categoryId,
        includeDescendants: input.frame.includeDescendants,
      },
      // No selection, deliberately: the subject is the rail a shopper is handed
      // on arrival. A selection would measure a narrowed rail, and every
      // narrowing makes a facet likelier to be suppressed for want of data — so
      // a sweep that applied one would report a higher empty rate than the
      // surface ever shows, and the difference would be its own doing.
      selection: [],
      locale: input.frame.locale,
      displayCurrency: input.frame.displayCurrency,
      now: input.now,
    },
    input.db,
  );

  const suppressed = response.suppressed.map((entry) => entry.reason);
  if (response.facets.length === 0) {
    return { outcome: 'no_facets', categoryId: input.categoryId, suppressed };
  }
  return {
    outcome: 'facets_generated',
    categoryId: input.categoryId,
    facetCount: response.facets.length,
    suppressed,
  };
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The eligible population, as ONE fragment.
 *
 * `lifecycle = 'published' and selectable` is #367 W17's "published, selectable
 * categories", and it is two independent facts rather than one: a suppressed
 * category can still be selectable and a grouping root can be published and not
 * selectable (`catalog.ts` records the distinction). Neither may be swept — the
 * first is not on sale and the second is not a scope a shopper filters in.
 *
 * `merged` is excluded by `published` alone, since `lifecycle` is one column.
 *
 * The fragment is built once and used by BOTH the count and the draw, which is
 * what makes `population` a fact about this sweep rather than a number from
 * somewhere near it (`integrity.service.ts`'s `countExamined` device).
 */
function eligibleCategories(rootCategoryId: string | undefined): SQL {
  if (rootCategoryId === undefined) {
    return sql`from categories c where c.lifecycle = 'published' and c.selectable`;
  }
  return sql`from categories c
    where c.lifecycle = 'published'
      and c.selectable
      and (c.id = ${rootCategoryId} or ${rootCategoryId} = any(c.ancestor_ids))`;
}

/** Clamp a requested sample size into the bound this module will actually run. */
function boundedSampleSize(requested: number | undefined): number {
  if (requested === undefined) return FACET_SCOPE_SWEEP_DEFAULT_SAMPLE_SIZE;
  if (!Number.isFinite(requested)) return FACET_SCOPE_SWEEP_DEFAULT_SAMPLE_SIZE;
  const floored = Math.floor(requested);
  if (floored <= 0) return 0;
  return Math.min(floored, FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE);
}

/**
 * Sweep the catalogue's facet scopes.
 *
 * Sequential, deliberately: this is a background health read on the same
 * connection pool that serves shoppers, and a fan-out here would make an hourly
 * observation the thing that made a slow minute slower. The cap is what bounds
 * the wall clock, and it is reported.
 */
export async function sweepFacetScopes(
  options: FacetScopeSweepOptions = {},
): Promise<FacetScopeSweepResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const seed = options.seed ?? FACET_SCOPE_SWEEP_DEFAULT_SEED;
  const sampleSize = boundedSampleSize(options.sampleSize);
  const frame: FacetScopeSweepFrame = {
    locale: options.locale ?? MERCARIA_BASE_LOCALE,
    displayCurrency: options.displayCurrency ?? FACET_SCOPE_SWEEP_CURRENCY,
    includeDescendants: FACET_SCOPE_SWEEP_INCLUDE_DESCENDANTS,
  };
  const eligible = eligibleCategories(options.rootCategoryId);

  const populationRows = await db.execute<{ total: number }>(
    sql`select count(*)::int as total ${eligible}`,
  );
  const population = Number(populationRows[0]?.total ?? 0);

  // A draw of nothing is not a query worth issuing, and it is a real
  // configuration: the branch it produces is the same one an empty catalogue
  // takes, because `drawn <= population`.
  const drawnIds =
    sampleSize === 0
      ? []
      : (
          await db.execute<{ id: string }>(
            sql`select c.id ${eligible} order by md5(${seed}::text || c.id) limit ${sampleSize}`,
          )
        ).map((row) => row.id);

  let empty = 0;
  let populated = 0;
  let failed = 0;
  const emptySample: string[] = [];
  const failedSample: string[] = [];
  const reasonScopes = new Map<FacetSuppressionReason, number>();

  for (const categoryId of drawnIds) {
    let verdict: FacetScopeVerdict;
    try {
      verdict = await examineFacetScope({ db, categoryId, frame, now });
    } catch (error) {
      // Per-scope isolation, `services/backfill`'s `examineSubject` reasoning: a
      // sweep that aborted on its worst category would report nothing at all
      // about the ones after it, forever, and the failure would present as a
      // metric that stopped moving. Recorded and logged, never swallowed —
      // `failed` is in the result and is excluded from the denominator.
      //
      // `warn` rather than `error`: one malformed category is a finding for an
      // operator to open, and a sweep that logged an error per scope would page
      // somebody once per hour for as long as that row exists. The count is the
      // aggregate signal.
      log.general.warn(
        { categoryId, err: error },
        'facet scope sweep: facet generation failed for one category',
      );
      failed += 1;
      if (failedSample.length < FACET_SCOPE_SWEEP_SAMPLE_LIMIT) failedSample.push(categoryId);
      continue;
    }

    if (verdict.outcome === 'no_facets') {
      empty += 1;
      if (emptySample.length < FACET_SCOPE_SWEEP_SAMPLE_LIMIT) emptySample.push(categoryId);
      // Counted per SCOPE, not per suppressed facet: "in how many bare rails did
      // this reason appear" is the question an operator can act on, where a
      // total over facets is dominated by whichever category has the most
      // attributes.
      for (const reason of new Set(verdict.suppressed)) {
        reasonScopes.set(reason, (reasonScopes.get(reason) ?? 0) + 1);
      }
      continue;
    }
    populated += 1;
  }

  // Derived rather than counted, so the identity cannot come apart: the
  // denominator IS the two verdict buckets, and a scope with no verdict is in
  // neither.
  const sampled = empty + populated;

  const emptyReasons: FacetScopeEmptyReason[] = [...reasonScopes.entries()]
    .map(([reason, scopes]) => ({ reason, scopes }))
    .sort((left, right) => right.scopes - left.scopes || left.reason.localeCompare(right.reason));

  const result: FacetScopeSweepResult = {
    population,
    drawn: drawnIds.length,
    sampled,
    empty,
    populated,
    failed,
    // The `cell()` decision: no `ratio` property at all when there is no
    // denominator, so a consumer wanting to render a percentage has to notice
    // there is nothing to render.
    ...(sampled === 0 ? {} : { emptyRatio: empty / sampled }),
    truncated: population > drawnIds.length,
    invalid: FACET_SCOPE_INVALID_UNMEASURED,
    emptyReasons,
    emptySample,
    failedSample,
    frame,
    draw: {
      seed,
      sampleSize,
      ...(options.rootCategoryId === undefined ? {} : { rootCategoryId: options.rootCategoryId }),
    },
    sweptAt: now.toISOString(),
  };

  // Printed on SUCCESS, not only on failure: a sweep that examined nothing and a
  // sweep that found a clean catalogue both report `empty: 0`, and the only
  // thing in the logs that tells them apart is the population beside it.
  log.general.info(
    {
      population: result.population,
      drawn: result.drawn,
      sampled: result.sampled,
      empty: result.empty,
      failed: result.failed,
      truncated: result.truncated,
      locale: frame.locale,
      displayCurrency: frame.displayCurrency,
    },
    'facet scope sweep completed',
  );

  return result;
}
