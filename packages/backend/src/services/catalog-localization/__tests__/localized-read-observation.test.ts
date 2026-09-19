/**
 * The localized-read counter, and the wall that makes its DENOMINATOR true
 * (#367 W17 line 771).
 *
 * ## Why a scanned gate and not just a unit test
 *
 * The metric's denominator is *"field resolutions this process performed"*. A
 * serving path that resolves without recording does not merely miss a count —
 * it makes the RATE wrong, in a direction nobody can predict from outside,
 * because the missing resolutions are whichever ones that caller happened to
 * do. A page whose names are observed and whose descriptions are not reports a
 * fallback rate about names only, and nothing in the reading says so.
 *
 * There were nine inline `resolveLocalizedField(...)` calls across two serving
 * modules when this landed, which is nine chances for the tenth to be added
 * unwrapped. So the wall is scanned rather than remembered.
 *
 * `resolve.ts` keeps exporting the pure resolver, deliberately: its own tests
 * are the reason the chain is testable without a server, and the counter is
 * outside it because that module's header opens with **PURE** and argues it.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALIZATION_FALLBACK_STEPS,
  type LocalizedResolution,
} from '@mercaria/shared-types';
import {
  readLocalizationReadCounters,
  recordLocalizedResolution,
  resetLocalizationReadCounters,
} from '../read-observation.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The modules that SERVE localized text and must go through the wrapper.
 *
 * Scanned as whole DIRECTORIES rather than as a file list, so the wall holds for
 * modules nobody has written yet — the `adapters/` device, one domain over.
 */
const SERVING_DIRS: readonly string[] = [
  join(SRC_ROOT, 'services', 'catalog-localization'),
  join(SRC_ROOT, 'services', 'catalog-authoring'),
];

/** The two files that may name the pure resolver, and why. */
const ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
  { file: 'services/catalog-localization/resolve.ts', why: 'it IS the pure resolver' },
  {
    file: 'services/catalog-localization/read-observation.ts',
    why: 'it is the wrapper, and calling the pure one is what it exists to do',
  },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') && statSync(full).size > 0) found.push(full);
  }
  return found;
}

/** Strip comments: these modules discuss the pure resolver at length. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Files naming the PURE resolver in code, as repo-relative paths. */
function pureResolverCallers(): string[] {
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of SERVING_DIRS) {
    for (const file of sourceFiles(dir)) {
      scanned += 1;
      const code = stripComments(readFileSync(file, 'utf8'));
      // Word-boundary on the left so `resolveObservedLocalizedField` — which
      // CONTAINS neither the name nor a prefix of it at a boundary — cannot
      // match, and a bare `resolveLocalizedField` anywhere in code does.
      if (!/(?<![A-Za-z0-9_])resolveLocalizedField(?![A-Za-z0-9_])/u.test(code)) continue;
      offenders.push(relative(SRC_ROOT, file).split('\\').join('/'));
    }
  }
  // The scan's own floor, returned rather than asserted here so the caller can
  // state it: a walk that read nothing reports no offenders.
  expect(scanned, 'the directory walk read almost nothing').toBeGreaterThanOrEqual(15);
  return offenders.sort();
}

describe('#367 W17 line 771 — a serving path cannot resolve without being counted', () => {
  it('only the resolver itself and its wrapper name the pure function', () => {
    expect(
      pureResolverCallers(),
      'this module calls the PURE resolver, so its resolutions are missing from the '
        + 'translation_fallback_use_rate denominator — which makes the RATE wrong rather than '
        + 'merely incomplete. Import `resolveObservedLocalizedField` from `read-observation.js`.',
    ).toEqual(ALLOWED.map((entry) => entry.file).sort());
  });

  it('every allowance names a file that exists and a reason', () => {
    // An exemption that can never fire is the shape this domain has paid for
    // once already: if a permitted file is renamed away, the list above stops
    // permitting anything and silently stops being an exemption at all.
    assertEachOf(ALLOWED, 2, (entry) => {
      expect(statSync(join(SRC_ROOT, entry.file)).size, `${entry.file} is empty`).toBeGreaterThan(0);
      expect(entry.why.length, `${entry.file} has no reason`).toBeGreaterThan(20);
    });
  });

  it('the detector really fires — the mutation self-test', () => {
    // `toEqual(ALLOWED)` above is what a detector matching NOTHING reports, so
    // the pattern is driven against both spellings directly.
    const detects = (code: string): boolean =>
      /(?<![A-Za-z0-9_])resolveLocalizedField(?![A-Za-z0-9_])/u.test(stripComments(code));
    expect(detects('const x = resolveLocalizedField({ field: "category.name" });')).toBe(true);
    expect(detects("import { resolveLocalizedField } from './resolve.js';")).toBe(true);
    // …and is NOT fooled by the wrapper, which is the whole point: a gate that
    // flagged the observed call would be one somebody deletes on day one.
    expect(detects('const x = resolveObservedLocalizedField({ field: "category.name" });')).toBe(
      false,
    );
    // …nor by prose, which both modules are full of.
    expect(detects('// never calls resolveLocalizedField directly')).toBe(false);
  });
});

/** One resolution with a given step. Only the fields the counter reads. */
function resolved(step: (typeof LOCALIZATION_FALLBACK_STEPS)[number]): LocalizedResolution {
  return {
    outcome: 'resolved',
    basis: 'localization_row',
    value: 'x',
    requestedLocale: 'es-mx',
    effectiveLocale: 'es',
    step,
    status: 'approved',
    provenance: 'mercaria',
  } as LocalizedResolution;
}

describe('#367 W17 line 771 — the counter partitions its own population', () => {
  beforeEach(() => {
    resetLocalizationReadCounters();
  });

  it('counts every outcome once, and the steps plus unavailable sum to the total', () => {
    recordLocalizedResolution(resolved('exact'));
    recordLocalizedResolution(resolved('exact'));
    recordLocalizedResolution(resolved('language'));
    recordLocalizedResolution(resolved('base'));
    recordLocalizedResolution({
      outcome: 'unavailable',
      reason: 'no_text_in_locale',
      requestedLocale: 'es-mx',
    } as LocalizedResolution);

    const counters = readLocalizationReadCounters();
    expect(counters.resolutions).toBe(5);
    expect(counters.byStep.exact).toBe(2);
    expect(counters.byStep.language).toBe(1);
    expect(counters.byStep.base).toBe(1);
    expect(counters.unavailable).toBe(1);
    // THE IDENTITY the metric's buckets rest on. Without it a step could be
    // dropped or double-counted and the reading would still look sane.
    const summed =
      LOCALIZATION_FALLBACK_STEPS.reduce((total, step) => total + counters.byStep[step], 0)
      + counters.unavailable;
    expect(summed, 'the outcomes do not partition the resolutions').toBe(counters.resolutions);
  });

  it('starts at zero for every step, so an absent step is a zero and not a hole', () => {
    const counters = readLocalizationReadCounters();
    expect(counters.resolutions).toBe(0);
    for (const step of LOCALIZATION_FALLBACK_STEPS) {
      expect(counters.byStep[step], `${step} is missing from a fresh counter`).toBe(0);
    }
    // A fresh process reports `0 / 0`, which the registry's own rule keeps in
    // the MEASURED branch with no ratio — "nothing has been read yet" rather
    // than a confident zero or a fake seam.
    expect(Object.keys(counters.byStep).sort()).toEqual([...LOCALIZATION_FALLBACK_STEPS].sort());
  });
});
