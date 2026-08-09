/**
 * Moving Mercaria's own decision about one advertiser, and recording the sample
 * that authorises it (#66 quality controls 4 and 5).
 *
 * ## An advertiser cannot reach `active` without a PASSED sample
 *
 * Issue quality control 4 asks that destination URLs and tracking behaviour be
 * sampled before an advertiser is activated. A lifecycle with no sampling state
 * would make that a checklist item somebody remembers, so `sampling` is a real
 * state and `awin_advertisers_activation_sample_check` refuses `active` without
 * a sample id — whether the writer is this service, a service bug or `psql`.
 *
 * There is deliberately no "activate anyway" parameter. An advertiser whose
 * sample failed is re-sampled after its feed or its mapping changes, and a
 * waiver would be a second, quieter way to reach the one state that puts a
 * tracked link in front of a buyer.
 */

import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import type { AwinActivation, AwinSampleFinding, AwinSampleVerdict } from '@mercaria/shared-types';
import { AWIN_ACTIVATING_SAMPLE_VERDICT } from '@mercaria/shared-types';
import {
  changeAwinActivation,
  findAwinAdvertiser,
  type AwinAdvertiserRow,
} from '../../db/awin/awinAdvertiserRepository.js';
import { findAwinFeed } from '../../db/awin/awinFeedRepository.js';
import {
  findAwinLinkSample,
  listAwinLinkSamples,
  recordAwinLinkSample,
  type AwinLinkSampleRow,
} from '../../db/awin/awinLinkSampleRepository.js';

/**
 * The transitions a person may ask for.
 *
 * A TABLE rather than a switch, and the two entries worth reading are the ones
 * that are NOT here: nothing moves INTO `candidate` (an advertiser that has been
 * evaluated cannot become one nobody has looked at), and nothing moves out of
 * `closed` (a programme that ended is re-opened by Awin naming it again, which
 * is discovery's business rather than an operator's).
 */
const PERMITTED_TRANSITIONS: Readonly<Record<AwinActivation, readonly AwinActivation[]>> = {
  candidate: ['sampling'],
  sampling: ['active', 'paused'],
  active: ['paused'],
  // Resuming goes back to `sampling`, never straight to `active`: whatever
  // caused the pause may have been a deep-link regression, and the sample is
  // what tells that apart from an unrelated incident.
  paused: ['sampling'],
  closed: [],
};

export interface ChangeAwinAdvertiserActivationInput {
  advertiserRowId: string;
  activation: AwinActivation;
  actorOxyUserId: string;
  note?: string;
}

/** Move one advertiser's activation, refusing a transition nobody should make. */
export async function changeAwinAdvertiserActivation(
  input: ChangeAwinAdvertiserActivationInput,
): Promise<AwinAdvertiserRow> {
  const advertiser = await findAwinAdvertiser(input.advertiserRowId);
  if (advertiser === null) throw notFound('Awin advertiser not found');

  const permitted = PERMITTED_TRANSITIONS[advertiser.activation];
  if (!permitted.includes(input.activation)) {
    throw conflict(
      `An Awin advertiser cannot move from ${advertiser.activation} to ${input.activation}. ` +
        `Permitted from ${advertiser.activation}: ${permitted.length === 0 ? 'nothing' : permitted.join(', ')}.`,
    );
  }

  let activatingSampleId: string | undefined;
  if (input.activation === 'active') {
    const sample = await latestPassingSample(advertiser.id);
    if (sample === null) {
      throw conflict(
        'This advertiser has no PASSED destination-and-tracking sample. Activation is what puts ' +
          'a tracked link in front of a buyer, so the sample is a precondition rather than a ' +
          'formality — take one and record its verdict first.',
      );
    }
    activatingSampleId = sample.id;
  }

  const updated = await changeAwinActivation({
    advertiserRowId: advertiser.id,
    activation: input.activation,
    actorOxyUserId: input.actorOxyUserId,
    ...(activatingSampleId === undefined ? {} : { activatingSampleId }),
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  if (updated === null) throw notFound('Awin advertiser not found');
  return updated;
}

/**
 * The most recent sample that PASSED, or `null`.
 *
 * Most recent rather than any: a sample taken before the advertiser's last feed
 * change is evidence about a feed that no longer exists, and reading the newest
 * is what makes re-sampling after a regression meaningful. A FAILED sample newer
 * than a passed one therefore blocks activation, which is the point.
 */
async function latestPassingSample(advertiserRowId: string): Promise<AwinLinkSampleRow | null> {
  const samples = await listAwinLinkSamples({ advertiserRowId, limit: 1 });
  const newest = samples[0];
  if (newest === undefined) return null;
  return newest.verdict === AWIN_ACTIVATING_SAMPLE_VERDICT ? newest : null;
}

export interface RecordAwinSampleInput {
  advertiserRowId: string;
  feedRowId: string;
  verdict: AwinSampleVerdict;
  sampled: number;
  passedRows: number;
  findings: readonly AwinSampleFinding[];
  takenByOxyUserId: string;
  note?: string;
}

/**
 * Append one sample.
 *
 * The row is APPEND-ONLY by trigger, so there is no update path and a
 * re-sample is a new row. What this service adds over the repository is the two
 * refusals a CHECK cannot express: the feed must belong to the advertiser being
 * sampled, and a `passed` verdict must have examined something.
 */
export async function recordAwinSample(input: RecordAwinSampleInput): Promise<AwinLinkSampleRow> {
  const advertiser = await findAwinAdvertiser(input.advertiserRowId);
  if (advertiser === null) throw notFound('Awin advertiser not found');

  const feed = await findAwinFeed(input.feedRowId);
  // A 404 rather than a 403 for a feed belonging to another advertiser: a
  // distinguishable response would let a caller enumerate which feed ids exist.
  if (feed === null || feed.advertiserRowId !== advertiser.id) throw notFound('Awin feed not found');

  if (input.passedRows > input.sampled) {
    throw validationError('A sample cannot report more passing rows than it examined.');
  }

  return recordAwinLinkSample({
    advertiserRowId: advertiser.id,
    feedRowId: feed.id,
    verdict: input.verdict,
    sampled: input.sampled,
    passedRows: input.passedRows,
    findings: input.findings,
    takenByOxyUserId: input.takenByOxyUserId,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
}

/** One sample, for the operator trace. */
export async function readAwinSample(sampleId: string): Promise<AwinLinkSampleRow> {
  const sample = await findAwinLinkSample(sampleId);
  if (sample === null) throw notFound('Awin sample not found');
  return sample;
}
