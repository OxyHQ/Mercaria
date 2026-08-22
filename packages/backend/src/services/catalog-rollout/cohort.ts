/**
 * Catalog rollout cohorts — which slice of a deployment the #367 catalog
 * surfaces are switched on for (ADR 0007 D12, epic Workstream 0).
 *
 * ## What this closes
 *
 * D12 shipped four levers and they are booleans over a whole deployment:
 * `CATALOG_TAXONOMY_V2_ENABLED`, `CATALOG_AUTHORING_ENABLED`,
 * `CATALOG_PROPOSALS_ENABLED`, `FACETS_ENABLED`. It also named a fifth,
 * `CATALOG_AUTHORING_COHORTS`, and nobody built it — so D12 recorded, in its own
 * text, that the rollout order it had decided (internal users → selected stores
 * → selected product types and categories → locales and markets → GA) was **not
 * executable as written**, because nothing narrowed a mount to a cohort.
 *
 * This is that narrowing. It is `CATALOG_ROLLOUT_COHORTS` rather than
 * `CATALOG_AUTHORING_COHORTS` because it narrows all four levers' surfaces and
 * not only authoring, and a variable whose name promises less than it does is
 * the kind a runbook step gets wrong. The rename is recorded in D12 and in
 * `docs/catalog-migration-operations.md`, both of which previously said the
 * capability did not exist.
 *
 * ## Pure, and it has to be
 *
 * No database access and no configuration read inside the predicates — the
 * `services/backfill/cohort.ts` arrangement, and for its reason: the config is
 * read once at the edge, so the whole of "which cohorts are enabled" is testable
 * without a deployment. It also keeps this module out of the way of the four
 * lever isolation walls, which forbid the facet and navigation DOMAINS from
 * reaching configuration at all; the gate that reads this lives in
 * `middleware/catalog-rollout.ts`, which those walls deliberately do not cover.
 *
 * ## The semantics, and why they are OR-across-entries and fail-closed
 *
 * Deliberately the SAME shape as `canonicalReadAllowedFor`, because a second
 * cohort vocabulary in one repository is two ways to say one thing:
 *
 * - **An EMPTY list means every cohort.** That is today's behaviour exactly —
 *   the four levers already decide the whole deployment — so introducing this
 *   variable withdraws nothing from anybody who never sets it. A list that meant
 *   "nothing" when unset would make adding the lever a silent outage.
 * - **`all` short-circuits**, which is how an operator says "every cohort,
 *   explicitly" rather than by deleting a variable.
 * - **Entries are OR-ed.** D12's stages are sequential WIDENINGS of one rollout,
 *   so each stage is the previous stage's entries plus more. Under AND, adding
 *   `market:ES` at the fourth stage would REMOVE the stores admitted at the
 *   second, which is the opposite of what the word "stage" means there.
 * - **A subject that can answer NO enabled dimension is REFUSED.** A canary that
 *   leaks the objects it could not classify is not a canary. The cost is real
 *   and is stated rather than hidden: with `store:S1` configured, `/navigation`
 *   — which knows a market and a locale and never a store — is outside the
 *   rollout and answers as it does with its lever off. That is correct for a
 *   stage whose name is "selected stores", and it is why the stages are
 *   cumulative.
 *
 * ## A malformed entry NARROWS
 *
 * A typo is dropped at parse time and then matches nothing, so it can only ever
 * make the rollout smaller. The opposite — a permissive parse — is how a
 * mistyped variable silently ships a surface to everybody.
 */

import type { CatalogRolloutDimension, CatalogRolloutSubject } from '@mercaria/shared-types';
import { CATALOG_ROLLOUT_DIMENSIONS } from '@mercaria/shared-types';

/**
 * One cohort selector.
 *
 * A STRING discriminant, not a boolean-literal one: this package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean member — a caller writing `if (!c.all)`
 * would still be holding the whole union, and the runtime test would be green.
 */
export type CatalogRolloutCohort =
  | { readonly kind: 'all' }
  | { readonly kind: 'dimension'; readonly dimension: CatalogRolloutDimension; readonly value: string };

/** The whole deployment. Not exported: `all` is spelled in a config entry, never
 * constructed by a caller, and an exported constant nothing imports is a dead
 * export wearing an API's clothes. */
const ALL_CATALOG_ROLLOUT_COHORTS: CatalogRolloutCohort = { kind: 'all' };

/**
 * Read one `<dimension>:<value>` entry, or the literal `all`.
 *
 * Returns `null` for anything else — an unknown dimension, an empty value, a
 * bare word — rather than throwing, because the caller is a configuration read
 * at process start and a deployment must not fail to boot over one stray comma.
 * What a dropped entry costs is coverage, never safety: it is absent from the
 * enabled list and therefore admits nothing.
 *
 * Values are normalised to the spelling the subject carries, which is the only
 * way a comparison can be exact: a market upper-cased (`es` → `ES`) and a locale
 * lower-cased (`es-ES` → `es-es`), matching `middleware/navigation-schemas.ts`,
 * which transforms both on the way in. A store id, a category id and a product
 * type key are case-SENSITIVE identifiers and are left exactly as written.
 */
export function parseCatalogRolloutCohort(entry: string): CatalogRolloutCohort | null {
  const trimmed = entry.trim();
  if (trimmed === '') return null;
  if (trimmed === 'all') return ALL_CATALOG_ROLLOUT_COHORTS;

  const separator = trimmed.indexOf(':');
  if (separator <= 0) return null;
  const rawDimension = trimmed.slice(0, separator);
  const rawValue = trimmed.slice(separator + 1).trim();
  if (rawValue === '') return null;

  const dimension = CATALOG_ROLLOUT_DIMENSIONS.find(
    (candidate): candidate is CatalogRolloutDimension => candidate === rawDimension,
  );
  if (dimension === undefined) return null;

  return { kind: 'dimension', dimension, value: normaliseCohortValue(dimension, rawValue) };
}

/** Parse a whole list, dropping every entry that is not a cohort. */
export function parseCatalogRolloutCohorts(entries: readonly string[]): CatalogRolloutCohort[] {
  const cohorts: CatalogRolloutCohort[] = [];
  for (const entry of entries) {
    const cohort = parseCatalogRolloutCohort(entry);
    if (cohort !== null) cohorts.push(cohort);
  }
  return cohorts;
}

/** `<dimension>:<value>`, or `all` — the form `CATALOG_ROLLOUT_COHORTS` carries. */
export function catalogRolloutCohortLabel(cohort: CatalogRolloutCohort): string {
  return cohort.kind === 'all' ? 'all' : `${cohort.dimension}:${cohort.value}`;
}

/**
 * The ONE place a dimension is tied to the subject field that answers it.
 *
 * A `switch` over the union, so adding a dimension is a compile error here until
 * somebody says which field states it — the alternative, a lookup keyed by
 * string, is how a new dimension ends up silently reading `undefined` and
 * therefore silently refusing every request that mentions it.
 *
 * Returns `null` when the subject cannot state a value, which is a DIFFERENT
 * answer from a value that does not match: the first refuses at the whole-list
 * level, the second lets a sibling entry decide.
 */
export function catalogRolloutSubjectValue(
  dimension: CatalogRolloutDimension,
  subject: CatalogRolloutSubject,
): string | null {
  switch (dimension) {
    case 'market':
      return normaliseSubjectValue(subject.market, 'upper');
    case 'locale':
      return normaliseSubjectValue(subject.locale, 'lower');
    case 'store':
      return normaliseSubjectValue(subject.storeId, 'exact');
    case 'category':
      return normaliseSubjectValue(subject.categoryId, 'exact');
    case 'product_type':
      return normaliseSubjectValue(subject.productTypeKey, 'exact');
    default: {
      // The exhaustiveness check, and it is written as an assignment to `never`
      // rather than left to the compiler's own switch analysis on purpose: this
      // package compiles with `strict: false`, where a `switch` missing a case
      // simply falls through and returns `undefined` — which type-checks, and
      // would make a new dimension silently answer "the subject cannot state
      // this", i.e. refuse every request that mentions it. Measured: adding a
      // sixth member to the tuple produced NO error here until this line
      // existed.
      const unreachable: never = dimension;
      return unreachable;
    }
  }
}

/**
 * Does this subject sit inside this cohort?
 *
 * `locale` is the one dimension that is not an exact comparison, and the rule is
 * the SUBTAG BOUNDARY: `locale:es` covers `es` and `es-ES`, and `locale:es-ES`
 * covers only `es-ES`. That is what "roll out to Spanish" means, and the
 * boundary is what stops it being a prefix match — `locale:e` covers `e-XX` and
 * emphatically not `en`, so a truncated value narrows instead of admitting the
 * catalogue. The same device as `claim-scope.ts`'s label-wise domain
 * containment, which exists because `notapple.com` must not be covered by
 * `apple.com`.
 *
 * Every other dimension is EXACT, `category` included. A category cohort does
 * NOT cover its descendants: resolving a subtree needs a database read and this
 * module is pure, and the alternative — a cohort whose blast radius depends on a
 * tree somebody may re-parent — is not one an operator can reason about during
 * an incident. `SEO_CANARY_CATEGORY_IDS` made the same choice with the same
 * `includes`. List the ids.
 */
export function catalogRolloutCohortCovers(
  cohort: CatalogRolloutCohort,
  subject: CatalogRolloutSubject,
): boolean {
  if (cohort.kind === 'all') return true;
  const value = catalogRolloutSubjectValue(cohort.dimension, subject);
  if (value === null) return false;
  if (cohort.dimension === 'locale') {
    return value === cohort.value || value.startsWith(`${cohort.value}-`);
  }
  return value === cohort.value;
}

/**
 * May a catalog surface answer for this subject, given the enabled cohorts?
 *
 * See the module docblock for why this is OR-across-entries, why empty means
 * everything, and why a subject that can answer no enabled dimension is refused.
 */
export function catalogRolloutAllowedFor(
  cohorts: readonly CatalogRolloutCohort[],
  subject: CatalogRolloutSubject,
): boolean {
  if (cohorts.length === 0) return true;
  for (const cohort of cohorts) {
    if (catalogRolloutCohortCovers(cohort, subject)) return true;
  }
  return false;
}

/** The spelling a dimension's values are compared in. */
function normaliseCohortValue(dimension: CatalogRolloutDimension, value: string): string {
  switch (dimension) {
    case 'market':
      return value.toUpperCase();
    case 'locale':
      return value.toLowerCase();
    case 'store':
    case 'category':
    case 'product_type':
      return value;
    default: {
      // See `catalogRolloutSubjectValue` — same reason, same `strict: false`.
      const unreachable: never = dimension;
      return unreachable;
    }
  }
}

/** A subject field, trimmed and case-folded to match, or `null` when unstated. */
function normaliseSubjectValue(
  raw: string | null | undefined,
  casing: 'upper' | 'lower' | 'exact',
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (casing === 'upper') return trimmed.toUpperCase();
  if (casing === 'lower') return trimmed.toLowerCase();
  return trimmed;
}
