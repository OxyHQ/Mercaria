/**
 * Preview and validation — the two ways a mapping is looked at before it goes
 * live (#63 processing 9 and 10, Mapping UX 1–4 and 6).
 *
 * ## They are different runs, and the difference is what may activate
 *
 * A PREVIEW reads a bounded SAMPLE and renders it: the merchant's own values
 * beside what the mapping made of them, plus the issues each row raised and the
 * suggestions for the columns nothing is mapped to. It is the mapping form's
 * feedback loop and it is deliberately cheap.
 *
 * A VALIDATION reads the WHOLE feed and writes a report. Only a validation may
 * justify an activation (`FEED_ACTIVATING_REPORT_MODES`), because a preview's
 * fifty rows say nothing about the fifty-thousandth — which is exactly where a
 * mapping breaks, since that is where the merchant's unusual products are.
 *
 * ## Neither writes a source observation
 *
 * Both stop at the report. Nothing here calls #62's pipeline, mints a
 * `source_records` row, resolves a canonical entity or touches an offer — the
 * dry-run tallies are reads (`report.service.ts` states what each can honestly
 * claim). "Provide dry-run counts" is a report, not a rehearsal that leaves
 * rows behind.
 */

import type {
  FeedMappingSuggestion,
  FeedPreviewRecord,
  FeedRecordIssue,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import type { FeedImportReportRow } from '../../db/feedImport/feedImportReportRepository.js';
import { boundedBytes, decodeText, decompressBytes, type FeedByteMeter } from './bytes.js';
import { FeedImportRefusal } from './errors.js';
import { mapFeedRecord } from './mapping.js';
import { openFeedOrigin } from './open.js';
import { streamFeedRecords } from './parse/index.js';
import { composeFeedImportReport } from './report.service.js';
import { resolveFeedImportVersion } from './resolve.js';
import { buildFeedStage } from './staging.js';
import { suggestFeedFieldMappings } from './suggest.js';

/** What a preview renders (issue Mapping UX 1, 3 and 4). */
export interface FeedPreview {
  readonly configurationId: string;
  readonly versionId: string;
  readonly sampleSize: number;
  readonly records: readonly FeedPreviewRecord[];
  /** Every column the sample carried, in first-seen order. */
  readonly detectedFields: readonly string[];
  /** Columns nothing is mapped to, with a suggestion where one is confident. */
  readonly suggestions: readonly FeedMappingSuggestion[];
  /** Every issue the sample raised, in feed order. */
  readonly issues: readonly FeedRecordIssue[];
}

/**
 * Read a bounded sample and render it.
 *
 * The sample is streamed and NOT staged: a preview needs the merchant's own
 * values beside the mapped ones, and the stage deliberately keeps only mapped
 * candidates (a stage carrying raw rows would be a second copy of the feed on
 * disk with a different retention rule). Bounding by record count rather than by
 * bytes is what makes the read cheap on a gigabyte file — the stream is
 * abandoned after the last sampled row and the socket destroyed.
 */
export async function previewFeed(input: {
  configurationId: string;
  versionId: string;
  signal?: AbortSignal;
}): Promise<FeedPreview> {
  const feed = await resolveFeedImportVersion(input.configurationId, input.versionId);
  if (feed === null) {
    throw new FeedImportRefusal(
      'configuration_missing',
      'The mapping version does not belong to this feed configuration.',
    );
  }

  const sampleSize = config.feedImport.previewSampleSize;
  const opened = await openFeedOrigin(feed.origin, input.signal);
  if (opened.kind === 'not_modified') {
    // A conditional 304 on a PREVIEW is a nuisance rather than a hazard: the
    // merchant asked to see rows and the host said "unchanged". Reporting an
    // empty sample would look like a broken mapping, so it is a refusal that
    // names what happened. (The `not_modified` branch carries no bytes, which
    // is what makes this impossible to get wrong.)
    throw new FeedImportRefusal(
      'upstream_status',
      'The feed host answered 304 Not Modified. A preview needs the file itself; the stored ' +
        'validators will be replaced by the next successful pass.',
    );
  }

  const records: FeedPreviewRecord[] = [];
  const issues: FeedRecordIssue[] = [];
  const detected: string[] = [];
  const seenFields = new Set<string>();

  try {
    const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };
    const bounded = boundedBytes(opened.bytes, config.feedImport.maxDownloadBytes, meter);
    const inflated = decompressBytes(
      bounded,
      feed.compression,
      {
        maxDownloadBytes: config.feedImport.maxDownloadBytes,
        maxDecompressedBytes: config.feedImport.maxDecompressedBytes,
        maxCompressionRatio: config.feedImport.maxCompressionRatio,
      },
      meter,
    );
    const text = decodeText(inflated, feed.encoding);

    for await (const raw of streamFeedRecords(text, feed.parseOptions)) {
      for (const name of raw.fields.keys()) {
        if (!seenFields.has(name)) {
          seenFields.add(name);
          detected.push(name);
        }
      }
      const mapped = mapFeedRecord(raw, feed.mapping);
      issues.push(...mapped.issues);
      records.push({
        recordIndex: mapped.index,
        ...(mapped.externalId === null ? {} : { externalId: mapped.externalId }),
        sourceValues: Object.fromEntries(mapped.sourceValues),
        ...(mapped.normalized === null ? {} : { normalizedTitle: mapped.normalized.title }),
        ...(mapped.normalized?.brandHint === undefined
          ? {}
          : { normalizedBrand: mapped.normalized.brandHint }),
        ...(mapped.normalized?.price === undefined
          ? {}
          : {
              normalizedPriceMinor: mapped.normalized.price.amount,
              normalizedCurrency: mapped.normalized.price.currency,
            }),
        ...(mapped.normalized?.availability === undefined
          ? {}
          : { normalizedAvailability: mapped.normalized.availability }),
        issues: mapped.issues,
      });
      if (records.length >= sampleSize) break;
    }
  } finally {
    opened.close();
  }

  const mappedFields = new Set(
    [...feed.mapping.fieldMappings.values()].flatMap((mapping) =>
      mapping.sourceField === undefined ? [] : [mapping.sourceField],
    ),
  );

  return {
    configurationId: input.configurationId,
    versionId: input.versionId,
    sampleSize,
    records,
    detectedFields: detected,
    // Suggestions cover the columns nothing is mapped to yet, which is what
    // makes them useful in a form and what stops them reading as a proposal to
    // change a decision the merchant already made.
    suggestions: suggestFeedFieldMappings(detected.filter((name) => !mappedFields.has(name))),
    issues,
  };
}

/**
 * Read the WHOLE feed under a version and write a `validation` report.
 *
 * The report is what an activation cites, so it is written even when the pass
 * found problems: a merchant needs to see 4,812 invalid rows and decide, and a
 * validation that refused to record a bad result would leave them with nothing
 * to look at. What the ACTIVATION then refuses is a report with no valid records
 * at all (`configuration.service.ts`).
 */
export async function validateFeedVersion(input: {
  configurationId: string;
  versionId: string;
  sourceId: string;
  requestedByOxyUserId: string;
  signal?: AbortSignal;
}): Promise<FeedImportReportRow> {
  const feed = await resolveFeedImportVersion(input.configurationId, input.versionId);
  if (feed === null) {
    throw new FeedImportRefusal(
      'configuration_missing',
      'The mapping version does not belong to this feed configuration.',
    );
  }

  const opened = await openFeedOrigin(feed.origin, input.signal);
  if (opened.kind === 'not_modified') {
    throw new FeedImportRefusal(
      'upstream_status',
      'The feed host answered 304 Not Modified. A validation must read the whole file.',
    );
  }

  try {
    const stage = await buildFeedStage({
      openBytes: async () => opened.bytes,
      compression: feed.compression,
      encoding: feed.encoding,
      parseOptions: feed.parseOptions,
      mapping: feed.mapping,
    });
    return await getDb().transaction(async (tx) =>
      composeFeedImportReport(
        {
          configurationId: input.configurationId,
          versionId: input.versionId,
          sourceId: input.sourceId,
          mode: 'validation',
          stage,
          requestedByOxyUserId: input.requestedByOxyUserId,
        },
        tx,
      ),
    );
  } finally {
    opened.close();
  }
}
