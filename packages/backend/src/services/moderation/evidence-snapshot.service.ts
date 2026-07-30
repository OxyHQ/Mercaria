/**
 * Building the report CrowdSource receives, out of what Mercaria already has.
 *
 * This composes the SDK's `ReportInput` — NOT a Case Envelope. The envelope,
 * resource ids, relations, digests, principal refs, the binding proof, the policy
 * version, privacy terms and the idempotency key are all derived by
 * `@oxyhq/crowdsource` from what this returns, and deliberately so: two shoppers
 * reporting one counterfeit listing must produce byte-identical resource lists, or
 * the dedup key differs and one incident opens two cases.
 *
 * ## The rule that makes retries safe
 *
 * **Nothing composed here may vary between two deliveries of the same report.**
 *
 * Ingress fingerprints the whole `{externalReportId, envelope}` to detect an
 * external id reused with different content, and answers 409 when it changes. That
 * 409 is NOT retryable — no number of attempts turns two payloads into one report
 * — so anything non-deterministic in here converts a perfectly legitimate outbox
 * retry into a permanent dead letter. It would surface days later, as a report
 * stuck in a queue, with nothing in any test having failed.
 *
 * Concretely, and each of these is a real trap rather than a style preference:
 *
 *   * `submittedAt` is the REPORT's `createdAt`, never `new Date()`.
 *   * Allegation codes are sorted and deduped (see `report-taxonomy.ts`).
 *   * Resource order is positional and stable — the provider sorts images by the
 *     position the buyer sees, not by whatever order Mongo returned.
 *   * The reporter's free text travels verbatim; it is never trimmed differently
 *     on a second pass.
 *
 * A subject SNAPSHOT is allowed to differ between deliveries — a seller editing
 * their listing is exactly the case §5.6 exists for — but that is a different
 * report of a different version, and the local row records which one was sent.
 */

import { createHash } from 'node:crypto';
import type { ReportInput } from '@oxyhq/crowdsource';
import type { IAbuseReport } from '../../models/abuse-report.js';
import { toTaxonomyCodes } from './report-taxonomy.js';
import { subjectProviderFor } from './subjects/registry.js';
import type { ModerationSubjectSnapshot } from './subjects/types.js';

/**
 * Raised when a report's type has no subject provider at delivery time.
 *
 * `retryable: false` — trying again cannot conjure a provider. This should be
 * unreachable, because intake only enqueues a delivery for a type that HAD one;
 * it exists for the case where a provider is removed while rows are still in
 * flight, and it dead-letters loudly rather than retrying for days.
 */
export class ModerationSubjectUnsupportedError extends Error {
  readonly retryable = false;

  constructor(reportedType: string) {
    super(`No moderation subject provider for reported type '${reportedType}'.`);
    this.name = 'ModerationSubjectUnsupportedError';
  }
}

/** Raised when the reported object no longer exists. Not retryable. */
export class ModerationSubjectMissingError extends Error {
  readonly retryable = false;

  constructor(reportedType: string, reportedId: string) {
    super(`The reported ${reportedType} '${reportedId}' no longer exists.`);
    this.name = 'ModerationSubjectMissingError';
  }
}

/**
 * SHA-256 of the exact representation being reviewed.
 *
 * Stored on the local report so a decision about an older version of a listing
 * stays identifiable as such after the seller has edited it. Computed HERE rather
 * than in each provider, so there is one definition of "the hash of this snapshot"
 * for every subject type.
 *
 * `JSON.stringify` over a deliberately ordered object: the field order below is
 * the hash's definition, and it must not be reordered casually.
 */
export function snapshotHash(snapshot: ModerationSubjectSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        subject: snapshot.subject,
        content: snapshot.content,
        attachments: snapshot.attachments ?? [],
        context: snapshot.context ?? [],
      }),
    )
    .digest('hex');
}

export interface BuiltReport {
  input: ReportInput;
  snapshotHash: string;
}

/**
 * Compose the report to deliver, and the hash of what it pins.
 *
 * Throws rather than returning null on both failure modes, because both are
 * terminal for THIS report and the outbox needs to dead-letter rather than spin.
 */
export async function buildReportInput(report: IAbuseReport): Promise<BuiltReport> {
  const provider = subjectProviderFor(report.reportedType);
  if (provider === undefined) {
    throw new ModerationSubjectUnsupportedError(report.reportedType);
  }

  const snapshot = await provider.snapshot(report.reportedId);
  if (snapshot === null) {
    throw new ModerationSubjectMissingError(report.reportedType, report.reportedId);
  }

  const input: ReportInput = {
    externalReportId: report._id.toHexString(),
    subject: snapshot.subject,
    content: snapshot.content,
    ...(snapshot.attachments === undefined ? {} : { attachments: snapshot.attachments }),
    ...(snapshot.context === undefined ? {} : { context: snapshot.context }),
    allegations:
      report.details === undefined || report.details.trim() === ''
        ? toTaxonomyCodes(report.categories)
        : toTaxonomyCodes(report.categories).map((code, index) => ({
            code,
            // The reporter's own words ride on the FIRST allegation only —
            // repeating them under every code would present one complaint as
            // several corroborating ones.
            ...(index === 0 ? { details: report.details } : {}),
          })),
    reportedBy: { oxyUserId: report.reporterOxyUserId },
    // The moment the USER reported it — never the moment of delivery. See the
    // module comment: an invented timestamp makes a retry a permanent 409.
    submittedAt: report.createdAt,
  };

  return { input, snapshotHash: snapshotHash(snapshot) };
}
