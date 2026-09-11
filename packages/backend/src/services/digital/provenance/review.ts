/**
 * How a fingerprint match reaches a HUMAN — through the abuse-report path that
 * already exists, and never on its own (#1015 W8).
 *
 * ## The existing path, reused exactly
 *
 * `services/moderation/` already carries the whole route out of this application:
 * `createAbuseReport` stores a report and, in the SAME transaction, the outbox row
 * that owes its delivery; `report-delivery.worker` hands it to the subject
 * provider for its reported type; `subjects/listing-subject.ts` describes a
 * `commerce.listing` for a jury; CrowdSource opens ONE case per incident;
 * `enforcement.service` applies whatever Mercaria is allowed to apply. A
 * provenance review is a report about a LISTING, so it needs none of that built
 * again — it needs a caller.
 *
 * Building a second path was the alternative and it is worse in a specific way:
 * the dedup key a case is opened under is computed over the subject description
 * the provider produces, so a second producer of "a report about listing X" opens
 * a SECOND case about the same object, with a second jury and a second
 * consequence. `subjects/types.ts` says this in as many words about envelopes, and
 * it is the same failure one level up.
 *
 * ## A machine never files one
 *
 * `fileProvenanceReview` requires an `operatorOxyUserId` and uses it as the
 * REPORTER. There is no platform principal, no `system` sentinel and no default —
 * the parameter has no fallback, so a worker that wanted to file without a human
 * cannot construct the call. That is the structural form of #1015 W8's
 * requirement that a match produce a review a human decides rather than an
 * automatic accusation, and it also makes the dedup the intake already has mean
 * the right thing: `abuse_reports_reporter_reported_key` stops one operator filing
 * twice about one listing.
 *
 * ## The packet carries no bytes, no key and no other creator's identity
 *
 * #1015 W8's last requirement is that private source files are NEVER shared with
 * another claimant. {@link ProvenanceReviewPacket} is how that is held: it has no
 * field for a file, a file name, a storage key, a storage reference, a candidate
 * version id, a candidate asset id or a store id. A response with no field for a
 * thing cannot leak the thing — `MerchantAnalyticsSummary`'s device, and the
 * seller order projection's before it.
 *
 * What a jury gets instead is the SHAPE of the evidence: which fingerprints
 * matched, by which named algorithm at which stated tolerance, how many other
 * versions carry one, and the earliest DATE any of them was published. A date
 * answers "which came first", which is the question, without naming the other
 * creator to a seller who can read the case.
 *
 * ## And nothing here notifies the claimant
 *
 * There is no notification in this directory at all, asserted by
 * `__tests__/provenance-boundaries.test.ts`. `seller-notification.ts` already
 * explains the rule for the one message moderation does send: a seller told who
 * reported them learns something they can retaliate over. A creator told "your
 * work matches an upload by somebody else" learns the same thing about a person no
 * jury has judged — and the moment they are told, the obvious next request is to
 * see the file.
 */

import type { AbuseReportCategory, AssetProvenanceSignalKind } from '@mercaria/shared-types';
import { createAbuseReport } from '../../moderation/report-intake.service.js';
import { findListingById } from '../../../db/catalog/listingRepository.js';
import { forbidden, notFound, validationError } from '../../../lib/errors/error-codes.js';
import {
  GEOMETRY_FINGERPRINT_ALGORITHM,
  GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR,
} from './fingerprint.js';
import { PREVIEW_PHASH_ALGORITHM, PREVIEW_PHASH_MAX_REVIEW_DISTANCE } from './preview-hash.js';
import type { ProvenanceMatchStrength, ProvenanceSweep } from './sweep.js';

/**
 * The Mercaria report category a provenance review is filed under.
 *
 * `stolen_goods`, which `report-taxonomy.ts` maps to `commerce.prohibited_item`,
 * and its reasoning there transfers exactly: *"the objection is that the item may
 * not be sold at all, whoever describes it how"*. A work the seller has no right
 * to distribute is precisely that.
 *
 * **`counterfeit` was the other candidate and is wrong.** A counterfeit is a FAKE
 * of a genuine article; a re-upload is a genuine copy offered by the wrong person,
 * and the thing a jury would be asked is whether the goods are authentic — which
 * they are. Routing it there would put a claim in front of a jury that nobody
 * made, which is the failure `report-taxonomy.ts` describes for `other`.
 *
 * **What neither of them is, is right.** The baseline taxonomy's `commerce` family
 * has four codes and none of them is rights infringement. Mercaria may not mint
 * one — layer one belongs to CrowdSource, and *"a tenant minting its own codes
 * would make findings incomparable across applications"* — so this is an
 * approximation a jury sees, and it is recorded here as a gap to raise upstream
 * rather than papered over with a local code.
 */
export const PROVENANCE_REVIEW_CATEGORY: AbuseReportCategory = 'stolen_goods';

/**
 * What leaves Mercaria about a provenance match.
 *
 * Every field is either a property of the SUBJECT listing, a description of the
 * method, or a count. Nothing identifies another creator, another store, another
 * asset, another version or any file.
 */
export interface ProvenanceReviewPacket {
  /** The version under review — the subject's own, which the subject's seller owns. */
  readonly subjectVersionId: string;
  /** The strongest kind of evidence found, from `sweep.ts`' named mechanisms. */
  readonly strength: ProvenanceMatchStrength;
  /** Every signal kind that matched, in tuple order. */
  readonly matchedKinds: readonly AssetProvenanceSignalKind[];
  /**
   * How the matched fingerprints were computed, algorithm and tolerance, so a
   * decision is reproducible and a future reviewer can tell which generation of
   * the algorithm produced it.
   */
  readonly methods: readonly string[];
  /** How many other versions carry at least one of these fingerprints. */
  readonly otherVersionCount: number;
  /**
   * The earliest DATE — not instant — on which any matching version was
   * published, or `null` when none of them ever was.
   *
   * A date rather than a timestamp, and a date rather than an id: it answers
   * "which of these came first" and nothing else. A full timestamp would let a
   * determined reader correlate against a public product page and identify the
   * other creator, which is the disclosure this packet exists to avoid.
   */
  readonly earliestOtherPublishedOn: string | null;
  /** When the subject was published, same granularity, or `null`. */
  readonly subjectPublishedOn: string | null;
}

/**
 * Build the packet from a sweep.
 *
 * Pure, and over the WHOLE sweep rather than over one candidate. One filing is one
 * question about one listing — *is this listing the seller's to sell* — so
 * selecting a candidate to file "against" would be the accusation this module
 * refuses to make, with the selection standing in for a judgement about which of
 * two creators is the original.
 */
export function buildProvenanceReviewPacket(sweep: ProvenanceSweep): ProvenanceReviewPacket {
  const matchedKinds = [
    ...new Set(sweep.candidates.flatMap((candidate) => candidate.matchedKinds)),
  ];
  const publishedDates = sweep.candidates
    .map((candidate) => candidate.candidatePublishedAt)
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime());

  return {
    subjectVersionId: sweep.subjectVersionId,
    strength: strongestStrength(sweep),
    matchedKinds,
    methods: matchedKinds.map(methodOf),
    otherVersionCount: sweep.candidates.length,
    earliestOtherPublishedOn:
      publishedDates.length === 0 ? null : toDateOnly(new Date(Math.min(...publishedDates))),
    subjectPublishedOn:
      sweep.subjectPublishedAt === null ? null : toDateOnly(sweep.subjectPublishedAt),
  };
}

/**
 * The packet as the free text a report carries.
 *
 * It opens by saying what the evidence is NOT, because the reader is a juror who
 * has never read this directory and the first thing they need is that a
 * fingerprint match is not a finding of infringement. The closing line says no
 * files are attached, so a reviewer who expected one knows it was withheld by
 * design rather than lost.
 *
 * Bounded at `abuse_reports_details_length_check`'s 2000 characters, which every
 * value this composes is far inside — the string is a fixed template over a
 * handful of counts and dates.
 */
export function renderProvenanceReviewDetails(packet: ProvenanceReviewPacket): string {
  const lines = [
    'Automated provenance signal, referred by a Mercaria operator for human review.',
    '',
    'This is EVIDENCE, not a finding. A fingerprint match means two uploads describe',
    'the same thing; it does not establish who owns it, and Mercaria has taken no',
    'action on the strength of it.',
    '',
    `Subject asset version: ${packet.subjectVersionId}`,
    `Evidence: ${packet.strength} (${packet.matchedKinds.join(', ')})`,
    `Method: ${packet.methods.join('; ')}`,
    `Other versions carrying a matching fingerprint: ${String(packet.otherVersionCount)}`,
    `Earliest matching version published on: ${packet.earliestOtherPublishedOn ?? 'never published'}`,
    `This version published on: ${packet.subjectPublishedOn ?? 'not yet published'}`,
    '',
    'No files, file names or storage references are attached, and the other uploads',
    'are deliberately not identified: a provenance review must not hand one creator',
    "another creator's source files or identity.",
  ];
  return lines.join('\n');
}

/** Who filed, and about which catalogue object. */
export interface FileProvenanceReviewInput {
  /**
   * The operator referring the match. Becomes the report's REPORTER.
   *
   * No default and no sentinel: see the module docblock. A background sweep cannot
   * supply one, which is the point.
   */
  readonly operatorOxyUserId: string;
  /** The listing that sells the subject version. */
  readonly listingId: string;
  readonly sweep: ProvenanceSweep;
}

export interface FiledProvenanceReview {
  readonly reportId: string;
  /** Absent only if `listing` ever loses its subject provider, which it has. */
  readonly outboxEventId?: string;
  readonly packet: ProvenanceReviewPacket;
}

/**
 * Refer a sweep to community review, as an operator.
 *
 * Three refusals before anything is written, and each closes a way this could
 * become a worse tool than no tool:
 *
 * 1. **A sweep with no candidates is refused.** Filing "we looked and found
 *    nothing" as a report would put a seller in front of a jury over the absence
 *    of evidence.
 * 2. **The listing must belong to the subject version's own store.** Without it,
 *    the operator surface is an arbitrary "report any listing as stolen" button
 *    with a machine-generated justification attached. A digital asset always has a
 *    store (`digital_assets.store_id` is NOT NULL), so a `user`-owned P2P listing
 *    can never be the right target and is refused rather than matched loosely.
 * 3. **The subject is the listing, never the match.** There is no parameter for
 *    "the listing that was copied", so this cannot be used to report somebody
 *    else's product.
 */
export async function fileProvenanceReview(
  input: FileProvenanceReviewInput,
): Promise<FiledProvenanceReview> {
  if (typeof input.operatorOxyUserId !== 'string' || input.operatorOxyUserId.length === 0) {
    throw validationError('fileProvenanceReview: an operator id is required to file a review.');
  }
  if (input.sweep.candidates.length === 0) {
    throw validationError(
      'fileProvenanceReview: this sweep found no matching fingerprint, so there is nothing to review.',
    );
  }

  const listing = await findListingById(input.listingId);
  if (listing === null) {
    throw notFound(`fileProvenanceReview: listing ${input.listingId} does not exist.`);
  }
  if (listing.ownerType !== 'store' || listing.storeId !== input.sweep.subjectStoreId) {
    throw forbidden(
      'fileProvenanceReview: the listing named does not belong to the store that published this asset version.',
    );
  }

  const packet = buildProvenanceReviewPacket(input.sweep);
  const result = await createAbuseReport({
    reporterOxyUserId: input.operatorOxyUserId,
    reportedType: 'listing',
    reportedId: input.listingId,
    categories: [PROVENANCE_REVIEW_CATEGORY],
    details: renderProvenanceReviewDetails(packet),
  });

  return {
    reportId: result.report.id,
    ...(result.outboxEventId === undefined ? {} : { outboxEventId: result.outboxEventId }),
    packet,
  };
}

/** The strongest evidence anywhere in the sweep. */
function strongestStrength(sweep: ProvenanceSweep): ProvenanceMatchStrength {
  if (sweep.candidates.some((candidate) => candidate.strength === 'exact_bytes')) {
    return 'exact_bytes';
  }
  if (sweep.candidates.some((candidate) => candidate.strength === 'normalized_geometry')) {
    return 'normalized_geometry';
  }
  return 'preview_similarity';
}

/** How one kind was computed, with its tolerance, in one line a juror can read. */
function methodOf(kind: AssetProvenanceSignalKind): string {
  if (kind === 'content_hash') return 'content_hash=sha256 of stored bytes, exact match';
  if (kind === 'geometry_fingerprint') {
    return (
      `geometry_fingerprint=${GEOMETRY_FINGERPRINT_ALGORITHM} ` +
      `(centroid and RMS-radius normalised vertex set, quantised to 1/` +
      `${String(GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR)} of the radius; ` +
      'not rotation invariant)'
    );
  }
  if (kind === 'preview_phash') {
    return (
      `preview_phash=${PREVIEW_PHASH_ALGORITHM} (DCT perceptual hash of a Mercaria-generated ` +
      `preview, reviewed within Hamming distance ${String(PREVIEW_PHASH_MAX_REVIEW_DISTANCE)})`
    );
  }
  return `${kind}=creator-supplied assertion, not machine compared`;
}

/** `YYYY-MM-DD`, UTC. */
function toDateOnly(at: Date): string {
  return at.toISOString().slice(0, 10);
}
