/**
 * The inspection pipeline's orchestrator — the one module that writes
 * `asset_file_inspections` (#1015 W4, ADR 0010 D12).
 *
 * ## What this does, in the order it does it, and why the order is the design
 *
 * 1. **Resolve the file THROUGH its version.** The job carries both ids and the
 *    file is looked up among the version's files, so a payload naming another
 *    version's file resolves to nothing — the `storeId`-scoped-lookup device the
 *    connector jobs use, for the same reason.
 * 2. **Refuse by recorded size before reading anything.** A file above
 *    {@link MAX_INSPECTED_FILE_BYTES} costs one indexed read, not 400 MB of
 *    transfer.
 * 3. **Read the bytes through the port** (`bytes.ts`), never through a storage key:
 *    `asset_files.storage_key` is protected and `download.service.ts` is documented
 *    as its only reader.
 * 4. **SCAN before any parser sees the bytes.** The parsers in this directory are
 *    the attack surface (#1015 W12 threat 7), so the one component whose job is to
 *    recognize hostile content goes first, and an `infected` verdict stops the
 *    parse entirely. A scanner that cannot decide (`error`) does NOT stop it: a
 *    capability this deployment does not have cannot gate a measurement it does,
 *    nothing the inspection produces reaches a buyer, and publication is blocked by
 *    `everyFileScannedClean` regardless.
 * 5. **Verify the FORMAT from the content** (`sniff.ts`), and compare it with what
 *    the row claims. This is requirement 1 and the decision it protects: a `.stl`
 *    that is really a zip is a different thing, and every parser choice downstream
 *    was made for a file that does not exist.
 * 6. **Dispatch on the REGISTRY's capability row for the VERIFIED format.** Not on
 *    a hard-coded list and not on the declared extension. `blend` reports
 *    `unsupported` because `ASSET_FORMAT_REGISTRY` says `geometryMeasurable: false`,
 *    and a vertical that adds a format changes a registry row rather than this
 *    switch.
 * 7. **Record.** `recordFileInspection` upserts on
 *    `(file_id, processor_name, processor_version)`, so a retried job converges and
 *    a NEW processor version writes a NEW row beside the old measurement.
 *
 * ## Nothing here throws for anything about the file
 *
 * Every refusal is a VERDICT. A corrupt STL, a zip bomb, a 400 MB upload and a
 * format mismatch all produce a row and a successful job, because a thrown handler
 * is retried three times, records nothing, and leaves the creator's screen empty
 * while an operator reads a stack trace. The exceptions that remain are the ones a
 * retry can fix — a storage timeout, a database blip — and `bytes.ts` documents that
 * split as its contract.
 *
 * ## The gap this cannot close, and it is a SCHEMA gap
 *
 * The verified media type has **nowhere to live**. `asset_file_inspections` has no
 * column for it, `asset_files.media_type` is immutable once the version is published
 * and is not this module's to write in any case, and `failure_detail` is a message
 * for a creator rather than a field for a reader. So today the verified format
 * leaves this module only as a RETURN VALUE and as the `corrupt` verdict a mismatch
 * produces — which does block publication through the creator's own screen, but does
 * not give the viewer or the authorizer the verified type #1015 W4 requirement 1
 * asks them to read. Closing it needs a column, which needs a migration, which this
 * workstream does not own. It is reported rather than worked around.
 */

import type { AssetInspectionVerdict, AssetScanVerdict } from '@mercaria/shared-types';
import { assetFormatCapability } from '@mercaria/shared-types';
import {
  findVersionFiles,
  recordAssetFileScan,
  recordFileInspection,
  type PublicAssetFileRow,
} from '../../../db/digital/assetRepository.js';
import { log } from '../../../lib/logger.js';
import { createInspectionBudget, type InspectionBudget } from './budget.js';
import { ASSET_BYTE_READ_CEILING, assetByteSource, isAssetByteSourceConfigured } from './bytes.js';
import { inspectZipContainer, openZipContainer, refineZipContainerFormat } from './container.js';
import { inspectGlb, inspectGltfJson } from './gltf.js';
import { MAX_INSPECTED_FILE_BYTES } from './limits.js';
import { inspectObj } from './obj.js';
import {
  corruptFile,
  inspectionFailed,
  refusedTooLarge,
  unsupportedFormat,
  type GeometryMeasurement,
  type InspectionOutcome,
} from './result.js';
import { resourceIndexOf } from './resources.js';
import { assetMalwareScanner } from './scanner.js';
import { sniffFormat } from './sniff.js';
import { inspectStl } from './stl.js';
import { inspectThreeMf } from './threemf.js';

/**
 * The processor this pipeline records itself as.
 *
 * The name the schema's own docblock uses as its example, so the column and the
 * worker agree. It is one name for the whole pipeline rather than one per format:
 * the upsert key is `(file, name, version)`, and a per-format name would make a
 * file re-inspected after a format mismatch accumulate a row per guess.
 */
export const INSPECTION_PROCESSOR_NAME = 'mercaria-mesh-inspect';

/**
 * The processor VERSION, and what obliges a bump.
 *
 * Bump it whenever the MEANING of any recorded value changes, not only when a bug
 * is fixed. Concretely: the millimetre assumption for unitless formats
 * (`UNITLESS_MESH_SCALE_TO_MM`), the vertex welding tolerance
 * (`VERTEX_WELD_EPSILON`), the definition of `watertight`, the triangle convention
 * for polygonal faces, and any ceiling whose crossing changes a verdict.
 *
 * That is what makes #1015 W4 requirement 13 — *"so results can be recomputed
 * later"* — true rather than aspirational: the old measurement stays in its own row,
 * attributable, and the two can be compared. Editing a measurement's meaning
 * WITHOUT a bump overwrites the old number with a differently-defined one and
 * nothing records that it happened.
 */
export const INSPECTION_PROCESSOR_VERSION = '1.0.0';

/** One file's inspection, as the caller sees it. */
export type AssetFileInspectionReport =
  | {
      readonly kind: 'skipped';
      readonly fileId: string;
      /** The only reason: the file is not one of that version's. */
      readonly reason: 'file_not_in_version';
    }
  | {
      readonly kind: 'recorded';
      readonly fileId: string;
      readonly verdict: AssetInspectionVerdict;
      readonly failureDetail?: string;
      /** Absent when no scan was attempted (no bytes were ever read). */
      readonly scanVerdict?: AssetScanVerdict;
      readonly declaredFormat: string;
      /** The format the BYTES are, or `null` when they match nothing known. */
      readonly verifiedFormat: string | null;
      /** Its registry media type. See the module docblock on where this cannot go. */
      readonly verifiedMediaType: string | null;
      readonly measurement: GeometryMeasurement;
    };

/** What one version-wide pass fanned out. */
export interface AssetVersionInspectionReport {
  readonly versionId: string;
  readonly fileCount: number;
  readonly enqueued: number;
}

/** Options every entry point takes, so a test can drive the clock and the ports. */
export interface InspectAssetFileOptions {
  readonly budget?: InspectionBudget;
  readonly now?: () => Date;
}

/**
 * Inspect ONE file and record the result.
 *
 * Idempotent by construction: the read is a read, the scan verdict is a
 * last-writer-wins column, and the inspection row is an upsert on the processor
 * identity. Running this twice produces the same row, which is what makes a
 * crashed-and-retried worker converge instead of raising.
 */
export async function inspectAssetFile(
  job: { readonly versionId: string; readonly fileId: string },
  options: InspectAssetFileOptions = {},
): Promise<AssetFileInspectionReport> {
  const now = options.now ?? (() => new Date());
  const budget = options.budget ?? createInspectionBudget();

  const files = await findVersionFiles(job.versionId);
  const file = files.find((candidate) => candidate.id === job.fileId);
  if (!file) {
    // Not an error and not retried: a file deleted between enqueue and execution,
    // or a payload pairing a file with the wrong version, converge on the same
    // honest answer — there is nothing here to measure.
    log.general.warn(
      { versionId: job.versionId, fileId: job.fileId },
      '[DigitalInspection] the file is not one of that version; nothing inspected',
    );
    return { kind: 'skipped', fileId: job.fileId, reason: 'file_not_in_version' };
  }

  const { outcome, scanVerdict, verified } = await examine(file, files, budget, now);

  await recordFileInspection({
    fileId: file.id,
    verdict: outcome.verdict,
    processorName: INSPECTION_PROCESSOR_NAME,
    processorVersion: INSPECTION_PROCESSOR_VERSION,
    triangleCount: outcome.measurement.triangleCount,
    vertexCount: outcome.measurement.vertexCount,
    meshCount: outcome.measurement.meshCount,
    boundingBoxXMm: outcome.measurement.boundingBox?.xMm,
    boundingBoxYMm: outcome.measurement.boundingBox?.yMm,
    boundingBoxZMm: outcome.measurement.boundingBox?.zMm,
    watertight: outcome.measurement.watertight,
    hasUvMapping: outcome.measurement.hasUvMapping,
    hasRig: outcome.measurement.hasRig,
    animationCount: outcome.measurement.animationCount,
    missingResourceCount: outcome.measurement.missingResources?.length,
    failureDetail: outcome.failureDetail,
    measuredAt: now(),
  });

  log.general.info(
    {
      fileId: file.id,
      versionId: job.versionId,
      verdict: outcome.verdict,
      declaredFormat: file.format,
      verifiedFormat: verified?.formatKey ?? null,
      scanVerdict: scanVerdict ?? null,
      processor: `${INSPECTION_PROCESSOR_NAME}@${INSPECTION_PROCESSOR_VERSION}`,
    },
    '[DigitalInspection] file inspected',
  );

  return {
    kind: 'recorded',
    fileId: file.id,
    verdict: outcome.verdict,
    failureDetail: outcome.failureDetail,
    scanVerdict,
    declaredFormat: file.format,
    verifiedFormat: verified?.formatKey ?? null,
    verifiedMediaType: verified?.mediaType ?? null,
    measurement: outcome.measurement,
  };
}

/**
 * Fan one job out to one job per file of a version.
 *
 * Per-FILE granularity rather than one job per version, because the unit of work,
 * of failure and of idempotence is a file: a retry after a crash re-reads one
 * object instead of all of them, and a single corrupt file cannot cost its
 * siblings their measurements.
 *
 * This deliberately does NOT advance the version's state. `processing → review` is
 * the creator-facing lifecycle's transition and `advanceVersionState` is a CAS
 * built for whoever owns that surface; a second author of it here would be a second
 * answer to "is this version ready", decided by a worker with no view of the rest
 * of the submission.
 */
export async function inspectAssetVersion(
  job: { readonly versionId: string },
): Promise<AssetVersionInspectionReport> {
  const files = await findVersionFiles(job.versionId);
  if (files.length === 0) {
    log.general.info(
      { versionId: job.versionId },
      '[DigitalInspection] the version holds no files; nothing to inspect',
    );
    return { versionId: job.versionId, fileCount: 0, enqueued: 0 };
  }

  // Dynamic import: `producers.ts` imports `handlers.ts`, which imports this
  // module. The same cycle-breaking device every other handler in `queue/` uses,
  // and for the same reason — a static edge here would be a module-load cycle.
  const { enqueueAssetFileInspection } = await import('../../../queue/producers.js');

  let enqueued = 0;
  for (const file of files) {
    await enqueueAssetFileInspection({ versionId: job.versionId, fileId: file.id });
    enqueued += 1;
  }
  log.general.info(
    { versionId: job.versionId, files: files.length },
    '[DigitalInspection] per-file inspections enqueued',
  );
  return { versionId: job.versionId, fileCount: files.length, enqueued };
}

/** What one examination concluded, before anything is written. */
interface Examination {
  readonly outcome: InspectionOutcome;
  readonly scanVerdict?: AssetScanVerdict;
  readonly verified?: { readonly formatKey: string; readonly mediaType: string };
}

/** Steps 2 through 6 of the module docblock. Pure apart from the two ports. */
async function examine(
  file: PublicAssetFileRow,
  siblings: readonly PublicAssetFileRow[],
  budget: InspectionBudget,
  now: () => Date,
): Promise<Examination> {
  if (!isAssetByteSourceConfigured()) {
    return {
      outcome: inspectionFailed(
        'no asset byte source is registered on this deployment, so the file was never read',
      ),
    };
  }
  if (file.byteSize > MAX_INSPECTED_FILE_BYTES) {
    return {
      outcome: refusedTooLarge(
        `the file records ${file.byteSize} bytes, above the ${MAX_INSPECTED_FILE_BYTES}-byte ` +
          'inspection ceiling; nothing was read',
      ),
    };
  }

  const read = await assetByteSource().read(file.id, ASSET_BYTE_READ_CEILING);
  if (read.outcome === 'not_found') {
    return { outcome: inspectionFailed('the stored object could not be read') };
  }
  if (read.outcome === 'too_large') {
    return {
      outcome: refusedTooLarge(
        `the stored object is ${read.byteSize} bytes, above the ` +
          `${MAX_INSPECTED_FILE_BYTES}-byte inspection ceiling`,
      ),
    };
  }
  const bytes = read.bytes;

  // The scanner goes first, before any parser in this directory touches the bytes.
  const scan = await assetMalwareScanner().scan({
    fileId: file.id,
    fileName: file.fileName,
    declaredMediaType: file.mediaType,
    bytes,
  });
  // The same injected clock the inspection row uses, so one pass timestamps both
  // facts identically rather than a millisecond apart.
  await recordAssetFileScan(file.id, scan.verdict, now());
  if (scan.verdict === 'infected') {
    return {
      scanVerdict: scan.verdict,
      outcome: inspectionFailed(
        `not inspected: ${scan.scannerName} reported the file infected` +
          (scan.detail ? ` (${scan.detail})` : ''),
      ),
    };
  }

  if (bytes.length !== file.byteSize) {
    // `asset_files.byte_size` is MEASURED server-side at upload (#1015 W1 rule 7),
    // so a disagreement is not a rounding difference — it is the row and the object
    // describing different files, and measuring either of them would attribute the
    // result to the wrong one.
    return {
      scanVerdict: scan.verdict,
      outcome: corruptFile(
        `the stored object holds ${bytes.length} bytes and the file records ${file.byteSize}`,
      ),
    };
  }

  const verification = verifyFormat(file, bytes, budget);
  if (verification.kind === 'refused') {
    return { scanVerdict: scan.verdict, outcome: verification.outcome, verified: verification.verified };
  }

  const verified = verification.verified;
  const capability = assetFormatCapability(verified.formatKey);
  if (!capability) {
    // Unreachable through `sniffFormat`, which resolves every answer through the
    // registry. Kept because the alternative to an explicit verdict is a crash in
    // whichever branch below read `capability.container` off `undefined`.
    return {
      scanVerdict: scan.verdict,
      verified,
      outcome: inspectionFailed(`'${verified.formatKey}' is not in the format registry`),
    };
  }

  const availableResources = resourceIndexOf(siblings.map((sibling) => sibling.fileName));
  return {
    scanVerdict: scan.verdict,
    verified,
    outcome: measureVerifiedFormat(verified.formatKey, capability.geometryMeasurable, bytes, {
      budget,
      availableResources,
    }),
  };
}

/** Either the verified format, or the verdict that refuses the file outright. */
type FormatVerification =
  | { readonly kind: 'verified'; readonly verified: { formatKey: string; mediaType: string } }
  | {
      readonly kind: 'refused';
      readonly outcome: InspectionOutcome;
      readonly verified?: { formatKey: string; mediaType: string };
    };

/**
 * What the bytes are, and whether that is what the row claims.
 *
 * A zip is refined through its central directory, because 3MF is a zip and
 * `sniff.ts` deliberately identifies containers without opening them. The archive is
 * opened here and again inside `inspectThreeMf`; the cost is one central-directory
 * pass, and the alternative — threading an opened archive through the dispatch — ties
 * the orchestrator's shape to one format's internals.
 */
function verifyFormat(
  file: PublicAssetFileRow,
  bytes: Uint8Array,
  budget: InspectionBudget,
): FormatVerification {
  const sniffed = sniffFormat(bytes);

  if (sniffed.kind === 'unidentified') {
    const declared = assetFormatCapability(file.format);
    if (declared && !declared.geometryMeasurable) {
      // A format this pipeline does not measure and cannot positively identify —
      // a compressed `.blend` is the live example. There is nothing to contradict,
      // so `unsupported` is the honest verdict rather than an accusation of
      // mislabelling.
      return {
        kind: 'refused',
        outcome: unsupportedFormat(
          `the registry declares '${file.format}' not geometry-measurable, and its content ` +
            `matches no format this processor recognizes (${sniffed.evidence})`,
        ),
      };
    }
    return {
      kind: 'refused',
      outcome: corruptFile(
        `the file is recorded as '${file.format}' and its content matches no format Mercaria ` +
          `recognizes (${sniffed.evidence})`,
      ),
    };
  }

  let formatKey = sniffed.formatKey;
  let mediaType = sniffed.mediaType;

  if (formatKey === 'zip') {
    const opened = openZipContainer(bytes, budget);
    if (opened.ok === false) {
      // An archive that fails its own safety checks is refused as an archive,
      // whatever the row claims it is: there is no reading of a zip bomb under which
      // the declared format matters.
      return { kind: 'refused', outcome: opened.outcome, verified: { formatKey, mediaType } };
    }
    const refined = refineZipContainerFormat(opened.entries);
    const refinedCapability = assetFormatCapability(refined);
    if (refinedCapability) {
      formatKey = refined;
      mediaType = refinedCapability.mediaType;
    }
  }

  if (formatKey !== file.format) {
    // Requirement 1, and the verdict is `corrupt` rather than `unsupported`: the
    // FORMAT is measurable, this FILE is not the format it says it is. Naming both
    // sides is what makes the creator's screen actionable.
    return {
      kind: 'refused',
      verified: { formatKey, mediaType },
      outcome: corruptFile(
        `the file is recorded as '${file.format}' and its content is '${formatKey}' ` +
          `(${sniffed.evidence})`,
      ),
    };
  }

  return { kind: 'verified', verified: { formatKey, mediaType } };
}

/**
 * Dispatch on the VERIFIED format key.
 *
 * `geometryMeasurable` comes from the registry and is read rather than re-decided,
 * which is what #1015 W4's *"`verdict: 'unsupported'` is the honest result for
 * `.blend`"* asks for: the list of measurable formats is registry DATA, and this
 * switch only says which processor implements which row.
 *
 * A format the registry calls measurable and this version has no parser for also
 * answers `unsupported`, with a detail that says which of the two it is.
 * `docs/digital-commerce.md` states that outcome explicitly — *"what a NEW format
 * may need is a processor … and its absence reads as `unsupported`, not as a
 * measurement of zero"*.
 */
function measureVerifiedFormat(
  formatKey: string,
  geometryMeasurable: boolean,
  bytes: Uint8Array,
  options: { readonly budget: InspectionBudget; readonly availableResources: ReadonlySet<string> },
): InspectionOutcome {
  if (!geometryMeasurable) {
    if (formatKey === 'zip') {
      // Not measurable, but very much inspectable: the path, entry-count and
      // expansion checks are the whole value of looking at an archive.
      return inspectZipContainer(bytes, options.budget);
    }
    return unsupportedFormat(
      `the format registry declares '${formatKey}' not geometry-measurable, so nothing was ` +
        'measured rather than measured as zero',
    );
  }

  switch (formatKey) {
    case 'stl':
      return inspectStl(bytes, { budget: options.budget });
    case 'obj':
      return inspectObj(bytes, {
        budget: options.budget,
        availableResources: options.availableResources,
      });
    case 'gltf':
      return inspectGltfJson(bytes, {
        budget: options.budget,
        availableResources: options.availableResources,
      });
    case 'glb':
      return inspectGlb(bytes, {
        budget: options.budget,
        availableResources: options.availableResources,
      });
    case '3mf':
      return inspectThreeMf(bytes, { budget: options.budget });
    default:
      return unsupportedFormat(
        `the registry declares '${formatKey}' geometry-measurable and ` +
          `${INSPECTION_PROCESSOR_NAME}@${INSPECTION_PROCESSOR_VERSION} has no processor for it`,
      );
  }
}
