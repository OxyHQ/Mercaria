/**
 * A reader disputing a published catalogue fact (#72 identity rules 1 and 2).
 *
 * ## Submitting confers NOTHING, and that is a property of the call graph
 *
 * #72 identity rule 1 — "the brand page is not editable by a merchant merely
 * because the merchant claims a storefront" — is not a permission check here.
 * There is no write path from this domain to a brand, a family or a canonical
 * product AT ALL: this module's only write is one row in #59's REVIEW QUEUE,
 * and `catalog-page-isolation.test.ts` fails the build if any module under
 * `services/catalog-pages/` imports a canonical write service. A merchant with
 * a proven claim and an anonymous reader reach exactly the same code.
 *
 * ## The queue records the DISPUTE, not the disputer
 *
 * `catalog_review_items` has no column for who raised an item and this module
 * adds none. That is deliberate rather than an omission: a submitter recorded
 * beside their dispute is a submitter who can accrue standing, and #72 identity
 * rule 1 is that nobody accrues any. Volume is `detection_count`, which is what
 * a reviewer needs to triage.
 *
 * ## No free text
 *
 * The request names a FIELD from a closed set and carries no sentence. An
 * unmoderated free-text channel into an operator's inbox is a content-moderation
 * problem this domain has no way to solve — CrowdSource owns that for the
 * surfaces that need one — and a reviewer who knows the logo is disputed can
 * look at the logo.
 *
 * ## Convergence, and what it costs
 *
 * #59's `upsertReviewItem` converges on `dedupe_key`, which is grained per
 * SUBJECT. Two readers disputing two different fields of one brand therefore
 * produce ONE item with a count of two, and the FIELD recorded is the first
 * one's (the conflict branch leaves `note` alone). That is stated here rather
 * than hidden because it is a real limitation: per-field fidelity needs a
 * column #59's table does not have, and adding one is #59's decision.
 */

import type {
  CatalogCorrectionField,
  CatalogCorrectionReceipt,
  CatalogCorrectionSubject,
  CurationSubjectType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { upsertReviewItem } from '../../db/curation/curationRepository.js';
import { resolveBrandHandle, resolveFamilyHandle } from './resolve.js';

/**
 * The #59 subject type each correctable subject maps to.
 *
 * A `Record` over the closed set rather than a `switch`, so adding a subject to
 * {@link CatalogCorrectionSubject} fails `tsc` here until somebody says what it
 * is in the review queue's own vocabulary.
 */
const SUBJECT_TYPES: Readonly<Record<CatalogCorrectionSubject, CurationSubjectType>> =
  Object.freeze({
    brand: 'brand',
    product_family: 'canonical_product_family',
  });

export interface CatalogCorrectionRequest {
  readonly subject: CatalogCorrectionSubject;
  /** The id or slug from the page's URL — resolved the same way the page was. */
  readonly handle: string;
  readonly field: CatalogCorrectionField;
}

/**
 * File a correction, or converge on the dispute already open for this subject.
 *
 * `undefined` when the handle resolves to nothing — the same answer the page
 * itself gives, so a correction cannot be used to probe which ids exist.
 */
export async function submitCatalogCorrection(
  request: CatalogCorrectionRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogCorrectionReceipt | undefined> {
  const resolved =
    request.subject === 'brand'
      ? await resolveBrandHandle(db, request.handle)
      : await resolveFamilyHandle(db, request.handle);
  if (resolved === undefined) return undefined;

  const item = await upsertReviewItem(
    {
      // `source_fact_disagreement` because that is what this is: somebody
      // disagrees with the fact a source supplied. It is not a pair-shaped
      // kind, so the item needs no counterpart, and it is not
      // `ambiguous_match` — nothing here is about which product an observation
      // belongs to.
      kind: 'source_fact_disagreement',
      detector: 'public_correction',
      subjectType: SUBJECT_TYPES[request.subject],
      subjectId: resolved.row.id,
      reasonCodes: ['public_correction_submitted'],
      // Server-composed, never a submitter's words. See the module header.
      note: `Reader-reported correction: ${request.field}`,
    },
    db,
  );

  return { reviewItemId: item.id, converged: item.detectionCount > 1 };
}
