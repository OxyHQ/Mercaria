/**
 * A merchant can SEE which fields are pinned against connector re-sync (#420).
 *
 * #416/#419 made `listings.overriddenFields` real and the admin hydration path
 * serves it. Nothing rendered it, and the direction that fails is the reason
 * this is a gate rather than a review note: a pin is written by an ordinary edit
 * and removed by nothing, so its only symptom is a field that quietly stops
 * following the platform — indistinguishable from a broken sync. A merchant
 * reporting "my Shopify title change isn't arriving" and a merchant who pinned
 * the title six weeks ago look identical from every surface that does not
 * render this set.
 *
 * Two halves:
 *
 *  1. `partitionPinnedFields` — the pure read every surface goes through. The
 *     property that matters is that a key it cannot NAME is still COUNTED: the
 *     column is a bare `text[]` no merchant edit is the only writer of, and
 *     dropping such a key would hide exactly the pin this issue exists to
 *     expose.
 *  2. A SCAN of the dashboard screen and the shared copy, because the dashboard
 *     has no test runner and no lint in CI — a green there proves the types line
 *     up and it bundles, and nothing about what renders. So the assertion that
 *     the screen renders the notice at all lives here, in the only suite CI
 *     runs.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a byte floor
 * on every scanned file, so a moved or emptied file fails HERE instead of
 * satisfying every "does not contain" assertion by having nothing to match;
 * comment stripping, because both scanned modules DOCUMENT what they refuse to
 * do in exactly the vocabulary the detectors match; and a self-test for every
 * detector, so a regex that rotted cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PINNABLE_CONNECTOR_FIELDS,
  UNPINNED_CONNECTOR_KEYS,
  partitionPinnedFields,
} from '@mercaria/shared-types';

/** `packages/`, from this file. */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The merchant screen that serves `Listing.overriddenFields` to a person. */
const PRODUCT_SCREEN = 'dashboard/app/(app)/products/[id].tsx';
/** The shared copy: one sentence per pinnable field and per policy state. */
const PIN_COPY = 'ui/src/lib/connector-labels.ts';
/** The presentational notice itself. */
const PIN_NOTICE = 'ui/src/components/ui/connector-pin-notice.tsx';

function read(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(400);
  return source;
}

/** Strip line and block comments — both scanned files argue in the matched vocabulary. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The keys of one `Record` literal, by NAME, ignoring every other object in the file. */
function recordKeys(source: string, constName: string): string[] {
  const opening = new RegExp(`${constName}[^=]*=\\s*\\{`).exec(source);
  if (!opening) return [];
  const body = source.slice(opening.index + opening[0].length);
  const end = body.indexOf('\n};');
  if (end === -1) return [];
  return [...body.slice(0, end).matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
    (match) => match[1],
  );
}

/**
 * A control that would WRITE a pin — the thing #416 rejected and #420 excludes.
 *
 * `unpin` is matched as a PREFIX rather than a whole word: the self-test below
 * caught the `\b`-terminated first version reporting `unpinField(...)` as clean,
 * which is the exact spelling such a control would arrive under.
 */
const PIN_MUTATION =
  /\bunpin[A-Za-z]*|\buseMutation\b|\.mutate\(|\bonValueChange\b|\bonCheckedChange\b|\bsetOverriddenFields\b/;

describe('partitionPinnedFields', () => {
  it('returns two empty lists for a listing with no pins', () => {
    // Absent and empty are one value: a P2P listing and a freshly imported one
    // both render nothing, so the notice never appears on the common case.
    expect(partitionPinnedFields(undefined)).toEqual({ pinned: [], unnamed: [] });
    expect(partitionPinnedFields([])).toEqual({ pinned: [], unnamed: [] });
  });

  it('names every pinnable field, in vocabulary order rather than edit order', () => {
    // Stored order is the sequence a merchant happened to edit in; two products
    // with the same pins must not render two different lists.
    expect(partitionPinnedFields(['seo', 'title', 'images']).pinned).toEqual([
      'title',
      'images',
      'seo',
    ]);
    expect(partitionPinnedFields([...PINNABLE_CONNECTOR_FIELDS].reverse()).pinned).toEqual([
      ...PINNABLE_CONNECTOR_FIELDS,
    ]);
  });

  it('deduplicates, because the column is an append-only array', () => {
    expect(partitionPinnedFields(['title', 'title', 'title']).pinned).toEqual(['title']);
  });

  it('COUNTS a held key it cannot name instead of dropping it', () => {
    // The load-bearing property of this function. `mergePins` never removes an
    // entry and a fixture, a repair or a later issue can leave a key in the
    // column that no merchant EDIT writes — and the connector's merge holds it
    // all the same. Dropping it here would hide a live pin, which is the exact
    // defect #420 exists to close.
    const partition = partitionPinnedFields(['title', 'price', 'status', 'something_new']);
    expect(partition.pinned).toEqual(['title']);
    expect(partition.unnamed).toEqual(['price', 'something_new', 'status']);
  });

  it('never reports a deliberately-unpinned key as pinned', () => {
    // The #416 exclusions, from the other side: a UI implying that publishing an
    // imported product pinned its status would be a new false promise.
    const partition = partitionPinnedFields([...UNPINNED_CONNECTOR_KEYS]);
    expect(partition.pinned).toEqual([]);
    expect(partition.unnamed).toEqual([...UNPINNED_CONNECTOR_KEYS].sort());
  });
});

describe('the merchant surface renders the pin set', () => {
  it('reads its own scanned files, and the key extractor actually extracts', () => {
    // The vacuity floor and the detector self-tests. Every assertion below is
    // over a set built by a regex against these three files; a moved file or a
    // renamed const empties one, and an empty set satisfies "names no forbidden
    // key" perfectly.
    expect(
      recordKeys('const X: Record<K, string> = {\n  alpha: "a",\n  beta: "b",\n};\n', 'X'),
    ).toEqual(['alpha', 'beta']);
    expect(recordKeys('const X = {\n  alpha: "a",\n};\n', 'MISSING')).toEqual([]);
    expect(PIN_MUTATION.test('const m = useMutation({});')).toBe(true);
    expect(PIN_MUTATION.test('unpinField(id)')).toBe(true);
    expect(PIN_MUTATION.test('<Text>Fields you edited in Mercaria</Text>')).toBe(false);
    expect(stripComments('// unpin\nconst a = 1;\n')).not.toContain('unpin');
  });

  it("the dashboard's product screen renders the notice with the DTO's own field", () => {
    // The whole of #420: `Listing.overriddenFields` was served and nothing put
    // it in front of a person. Without the render this assertion is the only
    // thing in CI that fails — the dashboard has no test runner, and it
    // typechecks and bundles perfectly well with the notice absent.
    const screen = stripComments(read(PRODUCT_SCREEN));
    expect(screen, 'the product screen must render the pinned-field notice').toContain(
      '<ConnectorPinNotice',
    );
    expect(screen, 'and must feed it the listing’s own pin set').toMatch(
      /overriddenFields=\{product\.overriddenFields\}/,
    );
    // A pin is only in force while the channel honours it, so a surface that
    // asserted "later syncs will not overwrite these" under `connector_wins`
    // would generate the same false bug report in the opposite direction.
    expect(screen, 'and must pass the channel policy, not assume one').toContain('conflictPolicy=');
  });

  it('names exactly the fields a merchant edit can pin', () => {
    const labelled = recordKeys(stripComments(read(PIN_COPY)), 'CONNECTOR_PIN_LABELS');
    expect(
      labelled.sort(),
      'the pin copy and the pin vocabulary disagree — a key with no label renders blank, ' +
        'a label with no key promises a pin nothing writes',
    ).toEqual([...PINNABLE_CONNECTOR_FIELDS].sort());
  });

  it('offers none of the deliberately-unpinned keys as pinnable', () => {
    // Equality above already forbids this; asserted separately because it is the
    // consequence that matters, and because the two would be reported as
    // completely different failures.
    const labelled = new Set(recordKeys(stripComments(read(PIN_COPY)), 'CONNECTOR_PIN_LABELS'));
    for (const excluded of UNPINNED_CONNECTOR_KEYS) {
      expect(labelled.has(excluded), `${excluded} is not pinnable by an edit — see #416`).toBe(
        false,
      );
    }
  });

  it('is READ-ONLY: the notice can write nothing', () => {
    // #420 excludes a per-field pin/unpin control by name, so that nobody closes
    // it by building the thing #416 argued against. Per-field release is a
    // different piece of work: nothing stores the platform's previous value, so
    // "unpin" can only mean "resume tracking from the next sync".
    const notice = stripComments(read(PIN_NOTICE));
    expect(
      PIN_MUTATION.test(notice),
      'the pinned-field notice grew a mutation — #420 is a read-only surface',
    ).toBe(false);
  });
});
