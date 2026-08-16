/**
 * The pin vocabulary, and the gate that keeps it the READER's vocabulary (#416).
 *
 * `listings.overriddenFields` is a set of bare strings shared between a writer
 * (`updateListing`, through `catalog-field-pins.ts`) and four reader sites that
 * spell their keys as string literals. Nothing in the type system connects the
 * two, and the failure is silent in both directions: a pin naming a key nothing
 * reads is a merchant control with no effect — which is the defect #416 exists
 * to fix, so shipping a second instance of it would be the worst outcome here —
 * and a read key with no writer is a promise nothing keeps, which is the SAME
 * defect wearing the other hat.
 *
 * So the census below reads the two merge sites and asserts they partition
 * EXACTLY into the pinned set and the deliberately-unpinned one. A key in
 * neither fails the build, which is the point: the list of exemptions is
 * asserted by exact equality rather than containment, so it cannot grow one
 * defensible line at a time.
 *
 * The two tuples are declared in `@mercaria/shared-types` since #420 — the
 * dashboard renders the pin set and cannot import a service module — so this
 * gate now also guards what a merchant is TOLD is pinnable, not only what the
 * writer writes.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PINNABLE_CONNECTOR_FIELDS, UNPINNED_CONNECTOR_KEYS } from '@mercaria/shared-types';
import { mergePins, pinnedByEdit, type PinnableListingBefore } from '../catalog-field-pins.js';

/** The two field-merge sites; the two archive paths that read `status` are in the first. */
const READ_SITES = ['../connector-sync.service.ts', '../channel-ingest.service.ts'];

/**
 * Every `overriddenFields` key each production read site consults, PER FILE.
 *
 * Per file rather than unioned, and that is the whole strength of the gate.
 * Mutation-tested during review: swapping `channel-ingest.service.ts` for a file
 * with no reads at all left a unioned census completely unchanged and every
 * assertion green, because `connector-sync.service.ts` alone happens to consult
 * all ten keys. A union floor proves the census read SOMETHING; only a per-file
 * floor proves it read the push-in rail, which is the one that would silently
 * stop being covered if it grew a key of its own.
 *
 * Both spellings are matched — the field merges ask `overridden.has('x')` and
 * the archive paths ask `listing.overriddenFields.includes('x')`. Matching only
 * the first would have reported `status` as unread, which is the reading that
 * makes #390 look already-answered.
 */
function consultedKeysByFile(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const rel of READ_SITES) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const keys = new Set<string>();
    for (const match of source.matchAll(
      /(?:overridden\.has|overriddenFields\.includes)\(\s*'([a-zA-Z]+)'\s*\)/g,
    )) {
      keys.add(match[1]);
    }
    byFile.set(rel, keys);
  }
  return byFile;
}

function consultedKeys(): Set<string> {
  return new Set([...consultedKeysByFile().values()].flatMap((keys) => [...keys]));
}

const before: PinnableListingBefore = {
  title: 'Platform title',
  description: 'Platform description',
  vendor: 'Platform vendor',
  productType: 'Platform type',
  handle: 'platform-handle',
  seoTitle: 'Platform seo title',
  seoDescription: 'Platform seo description',
  imageFileIds: ['file-a', 'file-b'],
};

describe('the pin vocabulary is the reader’s vocabulary', () => {
  it('finds EVERY read site, not just enough of them to clear a floor', () => {
    // The vacuity floor, applied per file — see `consultedKeysByFile`. Every
    // assertion below is over a set built by a regex against these two files; a
    // moved file or a renamed call empties one, and an empty set satisfies "no
    // unwritten key" perfectly.
    for (const [file, keys] of consultedKeysByFile()) {
      expect(keys.size, `the census read no keys out of ${file}`).toBeGreaterThanOrEqual(7);
    }
    const consulted = consultedKeys();
    expect(consulted, 'a known-present key the field merge consults').toContain('title');
    expect(consulted, 'a known-present key only the archive paths consult').toContain('status');
  });

  it('every key a reader consults is either pinned by an edit or named as unpinned', () => {
    const accounted = new Set<string>([...PINNABLE_CONNECTOR_FIELDS, ...UNPINNED_CONNECTOR_KEYS]);
    const unaccounted = [...consultedKeys()].filter((key) => !accounted.has(key)).sort();
    expect(
      unaccounted,
      'a connector read site consults a key that is neither pinned by a merchant edit ' +
        'nor listed in UNPINNED_CONNECTOR_KEYS — decide which it is',
    ).toEqual([]);
  });

  it('every pinnable field is actually consulted by a reader', () => {
    const consulted = consultedKeys();
    const dead = PINNABLE_CONNECTOR_FIELDS.filter((field) => !consulted.has(field)).sort();
    expect(dead, 'a merchant edit writes a pin no connector reads — it would do nothing').toEqual(
      [],
    );
  });

  it('the two sets are disjoint', () => {
    const overlap = PINNABLE_CONNECTOR_FIELDS.filter((field) =>
      (UNPINNED_CONNECTOR_KEYS as readonly string[]).includes(field),
    );
    expect(overlap).toEqual([]);
  });

  it('the exemption list is exactly these three, by equality', () => {
    // Containment would let a fourth exemption land silently. Each of these has
    // its reason written at the declaration; a change here should be a change
    // there.
    expect([...UNPINNED_CONNECTOR_KEYS].sort()).toEqual(['collections', 'price', 'status']);
  });
});

describe('pinnedByEdit — a pin is a CHANGE, never a mention', () => {
  it('pins nothing when the patch repeats the stored values', () => {
    // The dashboard's product screen sends {title, description, status} on every
    // save whether or not any of them moved. Pinning on presence would pin the
    // title and description of every imported product the first time a merchant
    // touched its status.
    expect(
      pinnedByEdit(before, {
        title: 'Platform title',
        description: 'Platform description',
        status: 'active',
      }),
    ).toEqual([]);
  });

  it('pins only the field that actually moved', () => {
    expect(
      pinnedByEdit(before, { title: 'Merchant title', description: 'Platform description' }),
    ).toEqual(['title']);
  });

  it('treats NULL and empty string as one value', () => {
    const cleared: PinnableListingBefore = { ...before, vendor: null };
    expect(pinnedByEdit(cleared, { vendor: '' })).toEqual([]);
    expect(pinnedByEdit(cleared, { vendor: 'Acme' })).toEqual(['vendor']);
  });

  it('reads a gallery REORDER as an edit', () => {
    // Position is meaningful, so this is not a set comparison.
    expect(pinnedByEdit(before, { imageFileIds: ['file-b', 'file-a'] })).toEqual(['images']);
    expect(pinnedByEdit(before, { imageFileIds: ['file-a', 'file-b'] })).toEqual([]);
  });

  it('pins `seo` when EITHER half moves', () => {
    expect(pinnedByEdit(before, { seo: { title: 'Mine', description: 'Platform seo description' } })).toEqual(
      ['seo'],
    );
    expect(pinnedByEdit(before, { seo: { title: 'Platform seo title', description: 'Mine' } })).toEqual(
      ['seo'],
    );
    expect(
      pinnedByEdit(before, {
        seo: { title: 'Platform seo title', description: 'Platform seo description' },
      }),
    ).toEqual([]);
  });

  it('never pins a key outside the vocabulary, whatever the patch carries', () => {
    const everything = pinnedByEdit(before, {
      title: 'x',
      description: 'x',
      imageFileIds: ['z'],
      vendor: 'x',
      productType: 'x',
      handle: 'x',
      seo: { title: 'x', description: 'x' },
      status: 'draft',
      price: { amount: 1, currency: 'EUR' },
      tags: ['x'],
    });
    expect(everything).toEqual([...PINNABLE_CONNECTOR_FIELDS]);
    for (const excluded of UNPINNED_CONNECTOR_KEYS) {
      expect(everything as readonly string[], `${excluded} must not be pinnable`).not.toContain(
        excluded,
      );
    }
  });
});

describe('mergePins', () => {
  it('returns undefined when the edit adds nothing, so no column is written', () => {
    expect(mergePins(['title'], ['title'])).toBeUndefined();
    expect(mergePins([], [])).toBeUndefined();
  });

  it('appends without dropping or reordering what is already pinned', () => {
    // `status` is here because a pre-#416 fixture or a future explicit control
    // could have written one; a merchant editing a title must not clear it.
    expect(mergePins(['status', 'title'], ['title', 'vendor'])).toEqual([
      'status',
      'title',
      'vendor',
    ]);
  });
});
