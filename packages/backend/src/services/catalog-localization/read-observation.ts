/**
 * How this process's localized reads were actually answered (#367 W17 line 771).
 *
 * ADR 0007 D4's fallback chain resolves per field and recorded nothing, so
 * "how much of what people read is being answered in the language they asked
 * for" was unanswerable — and it is a different question from
 * `translation_coverage`, which counts the CATALOGUE. Coverage says how much is
 * translated; this says how much of what is READ is.
 *
 * ## The counter is HERE and never in `resolve.ts`
 *
 * That module's header opens with **PURE** and argues it: *"no database, no
 * configuration, no clock… which is what makes the whole chain testable without
 * a server and what makes it impossible for a fallback to depend on which
 * deployment is asking."* A counter is a side effect on a module-level `let`, so
 * putting one there would cost exactly that property to save one call.
 *
 * `services/variant-axes/projection.ts` made the same split first: a PURE
 * classifier, and a recorder the serving path calls.
 *
 * ## And that is why the wrapper exists rather than nine call sites
 *
 * The denominator is *"field resolutions this process performed"*, so a serving
 * path that resolves without recording does not merely miss a count — it makes
 * the RATE wrong, in a direction nobody can predict from the outside. Nine
 * inline `resolveLocalizedField(...)` calls across two services is nine chances
 * for the next one to be added unwrapped.
 *
 * {@link resolveObservedLocalizedField} is therefore the ONE thing a serving
 * module imports, and `catalog-localization-observation.test.ts` fails the build
 * if a serving module calls the pure resolver directly. The pure one stays
 * exported because `resolve.ts`'s own tests are the reason it is testable
 * without a server.
 *
 * ## Process-local, reset by every deploy, and declared as such
 *
 * The `variant_axis_shadow` decision verbatim — several tasks, no analytics
 * table this domain should own, aggregation belongs to `oxy-infra`. The metric's
 * `attributionLimit` says so; it is not hidden in a comment.
 */

import {
  LOCALIZATION_FALLBACK_STEPS,
  type LocalizationFallbackStep,
  type LocalizedResolution,
} from '@mercaria/shared-types';
import { resolveLocalizedField } from './resolve.js';

/**
 * What one process has accumulated since it started.
 *
 * `byStep` covers every member of `LOCALIZATION_FALLBACK_STEPS`, and
 * `unavailable` is the fourth outcome — a field the chain could not answer at
 * all. It is counted in `resolutions` and in NO fallback bucket, because a
 * field nobody could answer is not a fallback: folding it in would make the
 * rate rise when text is MISSING rather than when it is merely untranslated,
 * which is `translation_missing_count`'s question.
 */
export interface LocalizationReadCounters {
  readonly resolutions: number;
  readonly byStep: Readonly<Record<LocalizationFallbackStep, number>>;
  readonly unavailable: number;
}

function emptyCounters(): LocalizationReadCounters {
  const byStep = {} as Record<LocalizationFallbackStep, number>;
  for (const step of LOCALIZATION_FALLBACK_STEPS) byStep[step] = 0;
  return { resolutions: 0, byStep, unavailable: 0 };
}

let counters: LocalizationReadCounters = emptyCounters();

/**
 * Record one resolution. Never throws — a counter cannot fail a read.
 *
 * Exported separately from the wrapper because a caller that already HAS a
 * resolution (a batch that resolved before this module existed, a test driving
 * one outcome) records it without re-resolving.
 */
export function recordLocalizedResolution(resolution: LocalizedResolution): void {
  const byStep = { ...counters.byStep };
  let unavailable = counters.unavailable;
  if (resolution.outcome === 'resolved') {
    byStep[resolution.step] += 1;
  } else {
    unavailable += 1;
  }
  counters = { resolutions: counters.resolutions + 1, byStep, unavailable };
}

/**
 * Resolve a localized field AND record how it was answered.
 *
 * The signature is the pure resolver's, unchanged, so a call site becomes this
 * one by renaming the function and nothing else. That is deliberate: a wrapper
 * that took different arguments would be a second contract, and the migration
 * of nine call sites would be nine chances to pass the wrong thing.
 */
export function resolveObservedLocalizedField(
  ...args: Parameters<typeof resolveLocalizedField>
): LocalizedResolution {
  const resolution = resolveLocalizedField(...args);
  recordLocalizedResolution(resolution);
  return resolution;
}

/** The counters, for the operator surface. */
export function readLocalizationReadCounters(): LocalizationReadCounters {
  return counters;
}

/** Reset. Test-only seam; production never calls it. */
export function resetLocalizationReadCounters(): void {
  counters = emptyCounters();
}
