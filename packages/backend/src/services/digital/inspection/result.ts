/**
 * What one inspection concluded — the shape every parser in this directory
 * returns and the only thing `inspect.service.ts` writes a row from.
 *
 * ## NULL is not zero, and the type system says so
 *
 * Every measurement is OPTIONAL, and an absent property means NOT MEASURED.
 * `0` means measured zero. ADR 0010 D12 keeps the two apart in the schema — every
 * geometry column is nullable precisely so that an unmeasured triangle count and
 * an empty mesh are different rows — and a result type with `triangleCount:
 * number` defaulting to 0 would collapse them again one layer above the column
 * that was built to hold them apart.
 *
 * So the constructors below never fill a field in. {@link measured} takes exactly
 * what the parser established; {@link corruptFile} and {@link refusedTooLarge}
 * take a reason and, where the parser got far enough to know something true, the
 * partial measurement it did make.
 *
 * ## `watertight: undefined` is the one that matters most
 *
 * #1015 W4's closing rule: *a geometric analyzer may report measured properties;
 * it must NEVER present an unsafe or uncertain model as guaranteed printable.*
 * The failure mode is not a wrong `true` — it is a `false` that was really "we
 * did not check", rendered by a product page as "not watertight", and a `null`
 * rendered the same way. Which is why `watertight` is absent whenever the check
 * did not RUN, and why no constructor here can produce it by default.
 *
 * ## A verdict is a RESULT, never an exception
 *
 * Nothing in this directory throws for anything about the file. A corrupt STL, a
 * zip bomb and a 400 MB upload are all values, because a thrown parser becomes a
 * failed BullMQ job that is retried three times and recorded nowhere — the
 * creator's screen stays empty and the operator sees a stack trace instead of
 * "this file is not an STL". Infrastructure failures (storage, database) are the
 * only things that throw, and they are the only things worth retrying.
 */

import type { AssetInspectionVerdict } from '@mercaria/shared-types';
import { MAX_REPORTED_MISSING_RESOURCES } from './limits.js';

/** A bounding box in whole millimetres. Three numbers or none — the schema's CHECK. */
export interface BoundingBoxMm {
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
}

/**
 * What a parser established about one file. EVERY field optional: absent means
 * not measured.
 */
export interface GeometryMeasurement {
  readonly triangleCount?: number;
  readonly vertexCount?: number;
  readonly meshCount?: number;
  /** All three axes or none, because two of three renders as `42 × 17 × —`. */
  readonly boundingBox?: BoundingBoxMm;
  /** `true` proven closed, `false` proven open, ABSENT not determined. */
  readonly watertight?: boolean;
  readonly hasUvMapping?: boolean;
  readonly hasRig?: boolean;
  readonly animationCount?: number;
  /**
   * Resources the file names and the version does not contain.
   *
   * Names rather than a count, because the count is what the column stores and
   * the NAMES are what a creator needs in order to fix it. Bounded by
   * {@link MAX_REPORTED_MISSING_RESOURCES} before it reaches `failure_detail`.
   */
  readonly missingResources?: readonly string[];
}

/** One parser's conclusion about one file. */
export interface InspectionOutcome {
  readonly verdict: AssetInspectionVerdict;
  /** Why, for the creator's own screen. Absent on a clean measurement. */
  readonly failureDetail?: string;
  readonly measurement: GeometryMeasurement;
}

/** The measurement that establishes nothing. Frozen so no caller mutates a shared default. */
export const NOTHING_MEASURED: GeometryMeasurement = Object.freeze({});

/**
 * A clean measurement.
 *
 * Promotes itself to `missing_resources` when the parser found references it
 * could not resolve — one place, so no parser can measure a broken file and
 * report `measured` by forgetting to check. The geometry SURVIVES the promotion:
 * a glTF naming an absent texture still has a real triangle count, and dropping
 * it would punish the creator twice for one mistake.
 */
export function measured(measurement: GeometryMeasurement): InspectionOutcome {
  const missing = measurement.missingResources ?? [];
  if (missing.length === 0) {
    return { verdict: 'measured', measurement };
  }
  return {
    verdict: 'missing_resources',
    failureDetail: describeMissingResources(missing),
    measurement,
  };
}

/**
 * The file is not what it claims to be, or cannot be read as what it claims.
 *
 * Includes a declared/actual format mismatch — a `.stl` whose bytes are a zip —
 * because the alternative reading, `unsupported`, would say the FORMAT cannot be
 * measured when the truth is that this file is not that format.
 */
export function corruptFile(
  failureDetail: string,
  measurement: GeometryMeasurement = NOTHING_MEASURED,
): InspectionOutcome {
  return { verdict: 'corrupt', failureDetail, measurement };
}

/**
 * Mercaria declined to open it: a ceiling in `limits.ts`, or the time budget.
 *
 * Distinct from `corrupt` on purpose. The file may be perfectly valid; what the
 * row records is that THIS processor version refused, which is a fact a later one
 * with a bigger ceiling can revisit — and it writes a new row rather than
 * overwriting this one, because the upsert key carries the processor version.
 */
export function refusedTooLarge(
  failureDetail: string,
  measurement: GeometryMeasurement = NOTHING_MEASURED,
): InspectionOutcome {
  return { verdict: 'refused_too_large', failureDetail, measurement };
}

/**
 * Nothing here measures this format — and that is an honest answer, not a failure.
 *
 * Two distinguishable causes, both `unsupported`, told apart by the detail:
 * the registry declares the format unmeasurable (`blend`), or the registry
 * declares it measurable and this processor version has no parser for it (`fbx`).
 * `docs/digital-commerce.md` states the second explicitly — *"what a NEW format
 * may need is a processor … and its absence reads as `unsupported`, not as a
 * measurement of zero"*.
 */
export function unsupportedFormat(failureDetail: string): InspectionOutcome {
  return { verdict: 'unsupported', failureDetail, measurement: NOTHING_MEASURED };
}

/**
 * The processor itself could not run — no byte source, an unreadable object, a
 * scanner that called the file infected.
 *
 * NEVER used for anything the file did. `failed` means Mercaria's side broke or
 * refused to proceed, and keeping it disjoint from `corrupt` is what lets an
 * operator read a verdict census as "how many uploads are bad" versus "how much
 * of the pipeline is down".
 */
export function inspectionFailed(failureDetail: string): InspectionOutcome {
  return { verdict: 'failed', failureDetail, measurement: NOTHING_MEASURED };
}

/** The `failure_detail` a missing-resource verdict carries: a bounded, named list. */
export function describeMissingResources(names: readonly string[]): string {
  const shown = names.slice(0, MAX_REPORTED_MISSING_RESOURCES);
  const suffix = names.length > shown.length ? ` (+${names.length - shown.length} more)` : '';
  return `references ${names.length} resource(s) the version does not contain: ${shown.join(', ')}${suffix}`;
}

/**
 * `value` if it is a count a column can hold, otherwise `undefined`.
 *
 * The guard that stands between a DECLARED number in a hostile file and a
 * `bigint` column. `z.number().int()`'s hole, one domain over — AGENTS.md records
 * it for money and it is the same hole here: `1e300` is an integer to
 * `Number.isInteger` and is not a triangle count. A value that fails this is NOT
 * clamped to the ceiling, because a clamped count is a measurement nobody made.
 */
export function safeCount(value: unknown, ceiling: number): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (value < 0 || value > ceiling) return undefined;
  return value;
}
