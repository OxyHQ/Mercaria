/**
 * Every noun Mercaria can send for community review.
 *
 * Adding a subject type is one entry here plus one provider file. Nothing else in
 * the integration knows what a listing is — not the outbox, not the delivery
 * worker, not the webhook receiver, not the enforcement service.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A type WITHOUT one
 * is still accepted by `POST /reports` and still stored — it simply never leaves,
 * and the row says so in `localStatusReason`.
 *
 * The registry is NOT an admission gate on the API, and making it one would be a
 * mistake with a specific cost: it turns adopting CrowdSource into a breaking
 * change for every report surface an application has not yet wired up. Incremental
 * adoption, one subject type at a time, is the property that makes this
 * integration reusable across the other Oxy apps at all. It is also why a type
 * with no provider must never get an outbox row — a worker that later found one
 * would dead-letter a report that is not defective.
 *
 * ## Why `seller` has no provider, and would not gain one by trying harder
 *
 * Two independent reasons, and each is sufficient on its own.
 *
 * **There is nothing to pin.** A decision must attach to the exact version
 * reviewed. `SellerProfile` deliberately stores no user-authored identity at all —
 * its own doc comment says display name, username and avatar are "NEVER stored
 * here", they are read live from the Oxy profile at hydration time. What remains
 * is aggregates Mercaria computes (`rating`, `salesCount`, `isVerified`). A jury
 * cannot judge a person from numbers this application calculated about them, and
 * the prose they might judge belongs to a different system.
 *
 * **Tenancy.** `applicationId` comes off the service credential, so a report
 * Mercaria submits opens a case in MERCARIA's tenant. A case about an Oxy identity
 * names an object only Oxy can act on; Mercaria cannot suspend an Oxy account and
 * must not try, and if another Oxy app reported the same person under its own
 * credential the dedup key would differ by tenant — one person, two cases, two
 * juries, two consequences, breaking "one decision per incident" at a layer
 * nothing inside Mercaria can repair.
 *
 * Both point at a MISSING PROVIDER rather than a refused report. A seller report is
 * still stored, and it is still the right thing for a buyer to be able to file:
 * the pattern it records is real evidence for a human looking at repeat offenders,
 * even while no jury sees it. Cross-application hand-off is an open design
 * question, not something to fake here.
 *
 * ## Why `store` has no provider
 *
 * The same shape, one step further out. A store is an organisation whose material
 * IS its listings and its reviews — both of which are reportable in their own
 * right, with providers, and can be judged on their own terms. Reporting the
 * organisation adds no material a jury could read; it asks for a verdict on a
 * business, which is a suspension decision rather than a content one.
 */

import type { AbuseReportedType } from '@mercaria/shared-types';
import { createListingSubjectProvider } from './listing-subject.js';
import { createReviewSubjectProvider } from './review-subject.js';
import type { ModerationSubjectProvider } from './types.js';

const PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  createListingSubjectProvider(),
  createReviewSubjectProvider(),
]);

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  PROVIDERS.map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment. Intake asks
 * before queueing a delivery, and the evidence builder asks again when it builds
 * one; a type this returns `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can PIN the set. That is not ceremony: the difference between a
 * delivered type and a local-only one is completely invisible in the 201 a
 * reporter gets, so registering a provider — or forgetting to — is a change no
 * response body would reveal. The assertion makes widening the delivered surface a
 * deliberate act with an argument attached.
 */
export function deliverableTypes(): AbuseReportedType[] {
  return Array.from(BY_REPORTED_TYPE.keys()) as AbuseReportedType[];
}
