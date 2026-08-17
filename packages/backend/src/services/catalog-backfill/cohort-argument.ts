/**
 * `--cohort=<kind>[:<value>]` → a {@link BackfillCohort} (#367 workstream 13).
 *
 * The inverse of #60's `cohortLabel`, which renders the same `<kind>:<value>`
 * string, and it lives here rather than in three copies inside the three
 * `backfill-catalog-*` scripts: one parse means an operator who types
 * `--cohort=store:abc` gets the same slice from the classification, the
 * reconciliation and the repair, and three copies is how the repair ends up
 * addressing rows the classification never looked at.
 *
 * The vocabulary and every refusal are #60's — `parseCohort` already rejects a
 * half-specified pair, an owner type outside `LISTING_OWNER_TYPES` and a
 * provider outside `CONNECTOR_PROVIDER_IDS`, each because a cohort that matches
 * no listing looks exactly like a cohort whose listings are all already done.
 * Nothing here re-decides any of that; it only splits the string.
 */

import type { CatalogBackfillCohortKind } from '@mercaria/shared-types';
import { CATALOG_BACKFILL_COHORT_KINDS } from '@mercaria/shared-types';
import { parseCohort, type BackfillCohort } from '../backfill/cohort.js';

/** Parse one `--cohort=` argument, refusing an unknown kind by name. */
export function parseCohortArgument(raw: string): BackfillCohort {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(':');
  const kind = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const value = separator < 0 ? null : trimmed.slice(separator + 1);

  // A `find` rather than an `includes` plus a cast: the tuple re-narrows the
  // string for the compiler instead of the caller asserting it, so a widened
  // tuple cannot slip an unhandled kind into `parseCohort`.
  const known = CATALOG_BACKFILL_COHORT_KINDS.find(
    (candidate): candidate is CatalogBackfillCohortKind => candidate === kind,
  );
  if (known === undefined) {
    throw new Error(
      `--cohort kind must be one of ${CATALOG_BACKFILL_COHORT_KINDS.join(', ')}; got "${kind}".`,
    );
  }
  return parseCohort(known, value);
}
