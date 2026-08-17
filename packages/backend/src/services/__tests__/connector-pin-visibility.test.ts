/**
 * A merchant can SEE which fields are pinned against connector re-sync (#420),
 * and RELEASE one (#427).
 *
 * ## #427 changed this gate on purpose, and what it changed is narrower than it looks
 *
 * #420 asserted that the pinned-field notice can write nothing, so that nobody
 * closed it by building the per-field control #416 argued against. #427 is the
 * issue that decided to build one, so this file gained assertions rather than
 * losing them:
 *
 *  - `ConnectorPinNotice` STILL writes nothing, and that assertion is unchanged.
 *    The release arrives as presentational SLOTS the app fills, so the mutation,
 *    the permission it needs and the eleven translations of its copy all live in
 *    the dashboard. A shared component with a `useMutation` in it hands every
 *    future consumer a write it never asked for.
 *  - The product SCREEN must now render the control and reach the mutation —
 *    the same reasoning as the notice's own render assertion, one layer up: the
 *    dashboard has no test runner and no lint in CI, and it typechecks and
 *    bundles perfectly well with a control that is present and wired to nothing.
 *  - And the copy may not promise a RESTORE, which is the failure specific to
 *    this feature. Nothing stores the platform's previous per-field value, so
 *    "revert", "restore" or "undo" would describe an operation the data cannot
 *    perform — and it would fail the way this area keeps failing: silently,
 *    looking exactly like a working feature, with the merchant only finding out
 *    that nothing came back at the next sync, if then.
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
/** The shared pin VOCABULARY: one message id per pinnable field and per policy state. */
const PIN_COPY = 'ui/src/lib/connector-labels.ts';
/**
 * The shared copy itself, since #437 moved the sentences out of `PIN_COPY`.
 *
 * The restore-promise assertion below MUST read this file and not `PIN_COPY`.
 * `PIN_COPY` now holds only key strings, so it satisfies "contains no
 * forbidden word" perfectly and would go on passing while guarding nothing —
 * the exact vacuity the dashboard half of this test already floors against.
 */
const SHARED_EN_BUNDLE = 'ui/src/i18n/locales/en.json';
/** The presentational notice itself. */
const PIN_NOTICE = 'ui/src/components/ui/connector-pin-notice.tsx';
/** The dashboard's English copy — where every sentence the release renders lives. */
const DASHBOARD_EN_BUNDLE = 'dashboard/lib/i18n/locales/en.json';

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

/**
 * Copy that would promise the one thing a release cannot do (#427).
 *
 * Nothing stores the platform's previous per-field value, so a control offering
 * to revert, restore or undo describes an operation with no data behind it. The
 * merchant presses it, the field does not change, and the only way they find out
 * is the next sync — or never, on a webhook-driven connection where the platform
 * may not send that field again for weeks.
 *
 * The scan runs over the DASHBOARD's `en.json` and the shared copy module, which
 * is where these words would actually be written. `released` and `releasing` are
 * fine and are exactly what the copy does say; the pattern is anchored so
 * neither matches.
 */
const FALSE_RESTORE_PROMISE = /\brevert(s|ed|ing)?\b|\brestore[ds]?\b|\brestoring\b|\bundo\b/i;

/**
 * The release control, as the product screen has to spell it.
 *
 * A pair, because either half alone is satisfied by a screen that does not work:
 * the slots without the mutation is a control wired to nothing, and the mutation
 * without the slots is a mutation nothing can reach.
 *
 * Each is anchored on its left, which mutation-testing this file is what
 * established: renaming the prop to `MUTATED_fieldAction` left the unanchored
 * pattern perfectly satisfied by the substring, so the gate reported green on a
 * screen whose control had been renamed out of existence. `tsc` happened to
 * catch that particular spelling; DELETING the prop is the one it cannot, since
 * every slot is optional.
 */
const RELEASE_SLOTS = [
  /(?<![A-Za-z0-9_$])fieldAction=\{/,
  /(?<![A-Za-z0-9_$])unnamedAction=\{/,
  /(?<![A-Za-z0-9_$])releaseNote=\{/,
];

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

    // #427's detector, both directions. The negative half is the load-bearing
    // one: the copy this scans SAYS "released" and "releasing" everywhere, so a
    // pattern that fired on those would be disabled by whoever hit it next.
    expect(FALSE_RESTORE_PROMISE.test('Revert to the Shopify version')).toBe(true);
    expect(FALSE_RESTORE_PROMISE.test('Restore the platform value')).toBe(true);
    expect(FALSE_RESTORE_PROMISE.test('Undo this edit')).toBe(true);
    expect(FALSE_RESTORE_PROMISE.test('Released. Nothing changes here until the next sync.')).toBe(
      false,
    );
    expect(FALSE_RESTORE_PROMISE.test('Releasing a field lets the platform manage it')).toBe(false);

    // The slot anchors, from both sides. A renamed prop must not satisfy the
    // pattern by SUBSTRING — measured: `MUTATED_fieldAction={` did, and the gate
    // reported green on a screen whose control had been renamed away.
    expect(RELEASE_SLOTS[0].test('  fieldAction={(field) => null}')).toBe(true);
    expect(RELEASE_SLOTS[0].test('  MUTATED_fieldAction={(field) => null}')).toBe(false);
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
    const labelled = recordKeys(stripComments(read(PIN_COPY)), 'CONNECTOR_PIN_LABEL_KEYS');
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
    const labelled = new Set(recordKeys(stripComments(read(PIN_COPY)), 'CONNECTOR_PIN_LABEL_KEYS'));
    for (const excluded of UNPINNED_CONNECTOR_KEYS) {
      expect(labelled.has(excluded), `${excluded} is not pinnable by an edit — see #416`).toBe(
        false,
      );
    }
  });

  it('is READ-ONLY: the notice can write nothing', () => {
    // Unchanged by #427. The release control reaches this component as
    // presentational slots the app fills, so the shared component still cannot
    // write — which is what keeps the mutation, the permission behind it and the
    // eleven translations of its copy in the app that has all three.
    const notice = stripComments(read(PIN_NOTICE));
    expect(
      PIN_MUTATION.test(notice),
      'the pinned-field notice grew a mutation — the write belongs to the app that renders it',
    ).toBe(false);
  });
});

describe('the merchant can release a pin (#427)', () => {
  it("the product screen renders the release controls AND reaches the mutation", () => {
    // Both halves, because either alone describes a screen that does not work: a
    // control wired to nothing, or a mutation nothing can reach. Neither fails
    // `tsc` and neither fails a bundle, so this is the only thing in CI that
    // notices.
    const screen = stripComments(read(PRODUCT_SCREEN));
    for (const slot of RELEASE_SLOTS) {
      expect(screen, `the product screen must fill the notice's ${slot.source} slot`).toMatch(slot);
    }
    expect(screen, 'and must call the release mutation').toContain('useReleaseProductPins');
    expect(screen, 'and must actually fire it').toMatch(/releaseProductPins\.mutate\(/);
  });

  it('offers the release to the keys the surface cannot NAME', () => {
    // #427's requirement, and the one a release is most likely to miss: those
    // keys are held by the connector merge exactly as the seven are, and a
    // control that could only reach the named ones would leave them stuck
    // forever — worse than not offering a release at all.
    const screen = stripComments(read(PRODUCT_SCREEN));
    expect(screen, 'the unnamed pins must be reachable').toContain('partitionPinnedFields');
    expect(screen).toMatch(/unnamedAction=\{[\s\S]*unnamedPins/);
  });

  it('never promises a RESTORE, in the copy a merchant actually reads', () => {
    // Scoped to the subtree this feature owns rather than to the whole bundle,
    // for a measured reason: the dashboard legitimately says "restore" and
    // "undo" elsewhere — a discarded draft, an error boundary — and a gate that
    // fired on those is one whoever hits it next deletes.
    //
    // ENGLISH only, and that is also deliberate. Several translations state the
    // property as a NEGATION ("no se restaura nada", "es wird also nichts
    // wiederhergestellt"), which is correct copy that a per-language word list
    // would flag. English is where the sentences are authored and where a
    // translator's source comes from, so the rule is: this subtree does not use
    // the word at all, in either direction — say what the release DOES.
    const bundle = JSON.parse(readFileSync(join(PACKAGES_ROOT, DASHBOARD_EN_BUNDLE), 'utf8'));
    const pins = bundle?.products?.detail?.pins;
    // The vacuity floor and the positive control in one: an empty or renamed
    // subtree satisfies "contains no forbidden word" perfectly.
    expect(pins, 'the release copy is missing from the bundle entirely').toBeDefined();
    const copy = JSON.stringify(pins);
    expect(copy.length, 'the release copy is present but empty').toBeGreaterThan(200);
    expect(Object.keys(pins).sort()).toEqual([
      'release',
      'releaseFailed',
      'releaseNote',
      'releaseUnnamed',
      'released',
    ]);

    expect(
      copy,
      'the release copy offers to revert/restore/undo a pinned field — nothing stores the ' +
        "platform's previous value, so that is a promise the data cannot keep (#427)",
    ).not.toMatch(FALSE_RESTORE_PROMISE);
    // The shared bundle's connection-wide sentence describes the same act and
    // must not promise it either. Floored the same way, and for the same
    // reason: an absent or renamed subtree contains no forbidden word.
    const shared = JSON.parse(readFileSync(join(PACKAGES_ROOT, SHARED_EN_BUNDLE), 'utf8'));
    const connector = shared?.ui?.connector;
    expect(connector, 'the shared connector copy is missing from the bundle entirely').toBeDefined();
    const sharedCopy = JSON.stringify(connector);
    expect(sharedCopy.length, 'the shared connector copy is present but empty').toBeGreaterThan(200);
    expect(connector.pinRelease, 'the connection-wide release sentence is gone').toBeTruthy();
    expect(sharedCopy).not.toMatch(FALSE_RESTORE_PROMISE);
  });
});
