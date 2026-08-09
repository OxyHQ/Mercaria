/**
 * Cohorts — which slice of the catalogue a run addresses, and which slice a
 * canonical READ is allowed to answer for (#60 feature flag 6).
 *
 * A cohort is a pure value plus two pure functions over it: one that renders it
 * as a `listings` predicate, one that decides whether a read may serve it. No
 * database access, no config read inside the predicates themselves — the config
 * is read once, at the edge, so the whole of "which cohorts are enabled" is
 * testable without a deployment.
 *
 * ## Why `all` is a KIND rather than an absent value
 *
 * `{kind:'all'}` and "no cohort" would be two spellings of one fact, and the
 * schema would need a nullable pair to hold both. One kind with a CHECK-enforced
 * NULL value (`catalog_backfill_runs_cohort_shape_check`) means a half-specified
 * cohort — `('store', NULL)`, which would silently mean every store — cannot be
 * stored at all.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import type { CatalogBackfillCohortKind, ConnectorProviderId } from '@mercaria/shared-types';
import { CONNECTOR_PROVIDER_IDS } from '@mercaria/shared-types';
import { LISTING_OWNER_TYPES, listings } from '../../db/schema/catalog.js';
import { validationError } from '../../lib/errors/error-codes.js';

/** One cohort selector. `all` is the only kind carrying no value. */
export type BackfillCohort =
  | { readonly kind: 'all' }
  | { readonly kind: 'store'; readonly value: string }
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'owner_type'; readonly value: string }
  | { readonly kind: 'connector_provider'; readonly value: string };

/** The whole catalogue. */
export const ALL_COHORT: BackfillCohort = { kind: 'all' };

/**
 * Parse a `(kind, value)` pair, refusing every half-specified combination.
 *
 * The refusals are deliberately specific — an owner type that is not
 * `user`/`store` and a provider outside `CONNECTOR_PROVIDER_IDS` are both
 * accepted by the schema's CHECK (which only constrains the KIND) and would
 * silently select nothing. A cohort that matches no listing looks exactly like a
 * cohort whose listings are all already done, which is the measurement trap this
 * whole domain is built to avoid.
 */
export function parseCohort(kind: CatalogBackfillCohortKind, value: string | null): BackfillCohort {
  if (kind === 'all') {
    if (value !== null && value !== '') {
      throw validationError("Cohort kind 'all' carries no value.");
    }
    return ALL_COHORT;
  }
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    throw validationError(`Cohort kind '${kind}' requires a value.`);
  }
  if (kind === 'owner_type' && !LISTING_OWNER_TYPES.some((owner) => owner === trimmed)) {
    throw validationError(
      `Cohort owner_type must be one of ${LISTING_OWNER_TYPES.join(', ')}; got '${trimmed}'.`,
    );
  }
  if (
    kind === 'connector_provider' &&
    !CONNECTOR_PROVIDER_IDS.some((provider) => provider === trimmed)
  ) {
    throw validationError(
      `Cohort connector_provider must be a known provider; got '${trimmed}'.`,
    );
  }
  return { kind, value: trimmed };
}

/** The `(kind, value)` pair a cohort stores as. */
export function cohortColumns(cohort: BackfillCohort): {
  cohortKind: CatalogBackfillCohortKind;
  cohortValue: string | null;
} {
  return cohort.kind === 'all'
    ? { cohortKind: 'all', cohortValue: null }
    : { cohortKind: cohort.kind, cohortValue: cohort.value };
}

/** `<kind>:<value>`, or `all` — the form `CANONICAL_READ_COHORTS` carries. */
export function cohortLabel(cohort: BackfillCohort): string {
  return cohort.kind === 'all' ? 'all' : `${cohort.kind}:${cohort.value}`;
}

/**
 * The `listings` predicate a cohort selects, or `undefined` for the whole
 * catalogue.
 *
 * A `switch` over the union, so adding a cohort kind is a compile error here
 * until somebody decides what it selects — the alternative, a chain of `if`s
 * with a fallthrough, is how a new kind ends up silently meaning "everything".
 */
export function cohortListingPredicate(cohort: BackfillCohort): SQL | undefined {
  switch (cohort.kind) {
    case 'all':
      return undefined;
    case 'store':
      return eq(listings.storeId, cohort.value);
    case 'category':
      return eq(listings.categoryId, cohort.value);
    case 'owner_type':
      // Compared against the column's own narrowed type. The parse above already
      // refused anything outside `LISTING_OWNER_TYPES`, so this cannot widen it.
      return eq(listings.ownerType, cohort.value === 'store' ? 'store' : 'user');
    case 'connector_provider': {
      // Narrowed by `parseCohort`, which refused anything outside the tuple; the
      // find re-narrows it for the compiler rather than asserting it, so a
      // widened tuple cannot slip a bad value into a typed column.
      const provider = CONNECTOR_PROVIDER_IDS.find(
        (candidate): candidate is ConnectorProviderId => candidate === cohort.value,
      );
      if (provider === undefined) {
        throw validationError(`Cohort connector_provider '${cohort.value}' is not a known provider.`);
      }
      return eq(listings.sourceProvider, provider);
    }
  }
}

/** Compose a cohort predicate with a page's own keyset predicate. */
export function withCohort(cohort: BackfillCohort, page: SQL | undefined): SQL | undefined {
  const predicate = cohortListingPredicate(cohort);
  if (predicate === undefined) return page;
  if (page === undefined) return predicate;
  return and(predicate, page);
}

/**
 * What a canonical READ knows about the thing it is about to serve.
 *
 * Every field is optional because a read legitimately knows different things
 * about different objects: a canonical product knows its category and nothing
 * about a store, a native offer knows both. An empty subject is answered by the
 * enabled-cohort list as a whole (see {@link canonicalReadAllowedFor}).
 */
export interface CohortSubject {
  readonly categoryId?: string | null;
  readonly storeId?: string | null;
  readonly ownerType?: string | null;
  readonly connectorProvider?: string | null;
}

/**
 * May a canonical read answer for this subject, given the enabled cohorts?
 *
 * An EMPTY enabled list means every cohort — the `CHECKOUT_DESTINATION_COUNTRIES`
 * rule, and for the same reason: a list that meant "nothing" when unset would
 * make adding the lever a silent outage, and a rollout lever whose default
 * breaks the deployment is not a lever.
 *
 * A subject that knows NOTHING about any enabled cohort's dimension is refused
 * rather than admitted. That direction is the load-bearing one: a canary that
 * leaks the objects it could not classify is not a canary. `all` in the list
 * short-circuits it, which is how an operator says "every cohort, explicitly".
 */
export function canonicalReadAllowedFor(
  enabledCohorts: readonly string[],
  subject: CohortSubject,
): boolean {
  if (enabledCohorts.length === 0) return true;
  if (enabledCohorts.includes('all')) return true;

  for (const label of enabledCohorts) {
    const separator = label.indexOf(':');
    if (separator <= 0) continue;
    const kind = label.slice(0, separator);
    const value = label.slice(separator + 1);
    if (value === '') continue;

    switch (kind) {
      case 'store':
        if (subject.storeId === value) return true;
        break;
      case 'category':
        if (subject.categoryId === value) return true;
        break;
      case 'owner_type':
        if (subject.ownerType === value) return true;
        break;
      case 'connector_provider':
        if (subject.connectorProvider === value) return true;
        break;
      default:
        // An unparseable entry matches nothing rather than everything. A typo in
        // this list must narrow the rollout, never widen it.
        break;
    }
  }
  return false;
}
