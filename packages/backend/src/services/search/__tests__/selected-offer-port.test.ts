/**
 * The #74 seam and the shadow comparison — the two small modules whose whole
 * value is a DEFAULT, which is exactly the kind of thing a suite forgets to
 * pin.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Offer } from '@mercaria/shared-types';
import {
  registerSearchOfferSelector,
  resetSearchOfferSelector,
  selectSearchOffer,
} from '../selected-offer.port.js';
import {
  classifyShadowComparison,
  readShadowComparisons,
  recordShadowComparison,
  resetShadowComparisons,
} from '../shadow.js';

afterEach(() => {
  resetSearchOfferSelector();
  resetShadowComparisons();
});

/** The narrowest thing that type-checks as an `Offer` for a selector's input. */
function fakeOffer(id: string): Offer {
  return { id } as unknown as Offer;
}

describe('the #74 offer-selection seam', () => {
  it('FAILS CLOSED — no selector registered means no lead offer', () => {
    // The property the whole module exists for. A default that picked "the
    // cheapest" would be a ranking decision made under a name that does not say
    // so, and it would look exactly like #74 having shipped.
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('asks a registered selector and returns its answer', () => {
    registerSearchOfferSelector((input) => ({
      offerId: input.offers[0]?.id ?? '',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-test',
    }));
    const selected = selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] });
    expect(selected?.offerId).toBe('o1');
    expect(selected?.rankingPolicyVersion).toBe('rp-test');
  });

  it('lets a selector DECLINE without emptying the result', () => {
    registerSearchOfferSelector(() => undefined);
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('a throwing selector degrades the result instead of failing the page', () => {
    // A ranking fault must cost a lead offer, never a search.
    registerSearchOfferSelector(() => {
      throw new Error('selector exploded');
    });
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('a second registration REPLACES the first rather than stacking', () => {
    // Two selectors would be two rankings. Asserted through the observable
    // effect — the second one answers — rather than through a spy on the log
    // line: a `vi.fn()` that is never wired into the code under test always
    // "passes", which is the check-that-cannot-fail shape (`~/Oxy/AGENTS.md`).
    registerSearchOfferSelector(() => ({
      offerId: 'first',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-first',
    }));
    registerSearchOfferSelector(() => ({
      offerId: 'second',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-second',
    }));
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })?.offerId).toBe(
      'second',
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The seam's DOCUMENTED state matches its real one (#230)                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The port's header states that nothing registers a selector. This is what
 * keeps that sentence true.
 *
 * The defect #230 records is not a missing feature — the seam fails closed and
 * serves a shopper correctly. It is that the header USED to assert a call that
 * never happened, and a comment is the one artefact nothing ever recomputes: no
 * consumer trips over it, no type-check contradicts it, so a false one survives
 * until somebody believes it.
 *
 * So this asserts the ABSENCE, and the absence is only meaningful with a
 * positive control beside it — "no call site" is also what a broken walk
 * reports. Both are below.
 *
 * ## When this goes red, it is doing its job
 *
 * A failure here means somebody wired the seam, which is a legitimate thing to
 * do. The remedy is not to delete the assertion: it is to rewrite the port's
 * "## Registration" section and `docs/search.md` to describe the call that now
 * happens, and then to replace this census with one that pins the registration
 * instead. The `/brands/${id}` assertion in `product-page-isolation.test.ts` is
 * the same device — a check that exists to notice a roadmap step, carrying its
 * own instructions for the person it fires on.
 */
const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A CALL, never the definition.
 *
 * The lookbehind is what separates `registerSearchOfferSelector(next)` from
 * `export function registerSearchOfferSelector(`, which lives in the port
 * itself and must not count as its own consumer.
 */
const REGISTRATION_CALL = /(?<!function\s)\bregisterSearchOfferSelector\s*\(/;

/** Strip comments: the port DOCUMENTS the registration it does not perform. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every production `.ts` under the backend — tests excluded, they register freely. */
function productionSources(): { relative: string; source: string }[] {
  const found: { relative: string; source: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === '__tests__') continue;
        walk(absolute);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      found.push({
        relative: relative(BACKEND_SRC, absolute),
        source: readFileSync(absolute, 'utf8'),
      });
    }
  };
  walk(BACKEND_SRC);
  return found;
}

describe('#230: the seam is UNFILLED, and the port header says so', () => {
  it('no production module registers a selector', () => {
    const files = productionSources();
    // Vacuity floor on the walk itself: a rename or a broken recursion would
    // otherwise report the same clean zero a healthy repository does.
    expect(files.length, 'the backend source walk found too few files').toBeGreaterThanOrEqual(300);

    const callers = files
      .filter((file) => REGISTRATION_CALL.test(withoutComments(file.source)))
      .map((file) => file.relative);

    expect(
      callers,
      `${callers.join(', ')} registers a search offer selector. If the seam has been ` +
        'filled deliberately, rewrite the "## Registration" section of ' +
        'selected-offer.port.ts and the seam entry in docs/search.md to describe the ' +
        'call that now happens, and replace this census with one that pins it.',
    ).toEqual([]);
  });

  it('the walk can SEE the port — the positive control', () => {
    // The measurement's own currency: the file holding the definition must be
    // among the files scanned, or "zero callers" is blindness rather than
    // absence. Asserted on the DEFINITION, which is the one occurrence that is
    // certainly there while the seam is unfilled.
    const port = productionSources().find(
      (file) => file.relative === join('services', 'search', 'selected-offer.port.ts'),
    );
    expect(port, 'the walk never reached selected-offer.port.ts').toBeDefined();
    expect(withoutComments(port?.source ?? '')).toContain(
      'export function registerSearchOfferSelector',
    );
  });

  it('the detector tells a CALL from the DEFINITION — the mutation self-test', () => {
    // A pattern that matched the definition would fire on the port itself and
    // report a caller that does not exist; one that matched neither would pass
    // the census above vacuously forever.
    expect(REGISTRATION_CALL.test('registerSearchOfferSelector(buildRankingSelector());')).toBe(
      true,
    );
    expect(REGISTRATION_CALL.test('  registerSearchOfferSelector((input) => undefined);')).toBe(
      true,
    );
    expect(
      REGISTRATION_CALL.test('export function registerSearchOfferSelector(next: T): void {'),
    ).toBe(false);
    expect(REGISTRATION_CALL.test('import { selectSearchOffer } from "./port.js";')).toBe(false);
  });

  it('the comment stripper does not hide a registration from the census', () => {
    // The stripper is the one component that could make the census vacuous, so
    // it gets its own control in both directions.
    expect(withoutComments('registerSearchOfferSelector(x);')).toContain(
      'registerSearchOfferSelector(',
    );
    expect(withoutComments('/** #74 calls registerSearchOfferSelector(x) */')).not.toContain(
      'registerSearchOfferSelector(',
    );
  });
});

describe('the shadow comparison', () => {
  it('classifies the four ways two answers can differ', () => {
    expect(classifyShadowComparison(3, 2)).toBe('both_returned');
    expect(classifyShadowComparison(3, 0)).toBe('canonical_only');
    // The direction a rollout must not regress in: the old path found
    // something the new one did not.
    expect(classifyShadowComparison(0, 2)).toBe('listing_only');
    expect(classifyShadowComparison(0, 0)).toBe('both_empty');
  });

  it('accumulates counts and result totals', () => {
    recordShadowComparison(3, 2);
    recordShadowComparison(0, 1);
    const counters = readShadowComparisons();
    expect(counters.queries).toBe(2);
    expect(counters.bothReturned).toBe(1);
    expect(counters.listingOnly).toBe(1);
    expect(counters.canonicalResults).toBe(3);
    expect(counters.listingResults).toBe(3);
  });
});
