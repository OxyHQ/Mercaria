/**
 * The size-system registry answers honestly, and registering it is what makes
 * it answer at all (#367 Workstream 11).
 *
 * ## The claim that needs a control, not an assertion
 *
 * "A known key resolves" is satisfied by a registry that returns `present` for
 * everything — which is strictly worse than the unregistered seam it replaces,
 * because the seam blocked visibly. So every `present` case below is paired
 * with an `absent` one over the SAME call, and the sharpest pairs are the ones
 * a plausible implementation gets wrong: a key that differs from a real one
 * only in case, only in a trailing space, or only by being `toString`.
 *
 * ## What each check would report if the thing it measures were absent
 *
 * - **Registration**: `unavailable` before, `present` after, asserted in that
 *   order in one test. Remove the registration and the second half reports
 *   `unavailable`; remove the TABLE and it reports `absent`. Three states,
 *   three distinguishable failures.
 * - **The derivation**: every key equals the derivation of its own facets.
 *   Hand-write a key that disagrees and this fails; hand-write one that agrees
 *   and it passes — which is the point, because agreeing IS the property.
 * - **The prototype keys**: an object-literal lookup reports `present` for
 *   `constructor` and `toString`. A `Map` reports `absent`. Same call, opposite
 *   answers, so the test measures the implementation rather than the interface.
 * - **The no-parse gate**: it fires on its own fixture and not on the real
 *   source, and it has a population floor, so a moved file cannot pass it by
 *   having nothing to scan.
 *
 * The one property NOT asserted here is that the keys are STORABLE — that is
 * `catalog_external_mappings_size_system_key_shape_check`'s, it needs a real
 * PostgreSQL server, and re-implementing the pattern in TypeScript would be a
 * test of the re-implementation. `size-system-registry.realdb.test.ts` drives
 * it, together with the real resolver.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCatalogConceptRegistries,
  conceptExists,
  registeredConceptDimensions,
} from '../../catalog-external-mappings/concept-registry.port.js';
import {
  registerSizeSystemConceptRegistry,
  sizeSystemConceptRegistry,
} from '../size-system-registry.js';
import {
  SIZE_SYSTEM_DEFINITIONS,
  SIZE_SYSTEM_IDENTITY_FACETS,
  SIZE_SYSTEM_KEY_NAMESPACE,
  resolveSizeSystem,
  sizeSystemKey,
  sizeSystemKeys,
} from '../size-systems.js';

const CANONICAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = join(CANONICAL_DIR, '..', '..');

/** The two modules this issue adds, comment-stripped where a scan needs it. */
const OWNED_MODULES = ['size-systems.ts', 'size-system-registry.ts'] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function ownedSource(file: string): string {
  const source = readFileSync(join(CANONICAL_DIR, file), 'utf8');
  // The vacuity floor. A moved or emptied module has nothing to match and would
  // pass every scan below by measuring nothing.
  expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(1000);
  return source;
}

beforeEach(() => {
  clearCatalogConceptRegistries();
});

afterEach(() => {
  clearCatalogConceptRegistries();
});

describe('the key is derived from the four facets and never parsed', () => {
  it('mints one key per system, each equal to the derivation of its own facets', () => {
    // Population floor: an emptied table makes every walk below vacuous.
    expect(SIZE_SYSTEM_DEFINITIONS.length).toBeGreaterThanOrEqual(5);

    for (const system of SIZE_SYSTEM_DEFINITIONS) {
      expect(system.key).toBe(
        sizeSystemKey({
          domain: system.domain,
          region: system.region,
          audience: system.audience,
          measurementBasis: system.measurementBasis,
        }),
      );
      expect(system.key.startsWith(`${SIZE_SYSTEM_KEY_NAMESPACE}.`)).toBe(true);
    }

    // Distinct, and the count is asserted BOTH ways so a table that lost an
    // entry and a derivation that collapsed two onto one look different.
    const keys = sizeSystemKeys();
    expect(keys).toHaveLength(SIZE_SYSTEM_DEFINITIONS.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('builds the key from EVERY identity facet the entries carry', () => {
    // Derived from a real definition rather than hand-listed: a fifth facet
    // added to `SizeSystemIdentity` and to the entries, but forgotten in the
    // key, would leave two systems sharing one key and nothing else would
    // notice. `valueShape` is excluded BY NAME because shared-types states it
    // is not a facet of identity — a decision recorded here, so a sixth field
    // arriving with no decision fails the build rather than being absorbed.
    // (`merge-plan-census.test.ts`'s posture: silence is not a disposition.)
    const sample = SIZE_SYSTEM_DEFINITIONS[0];
    expect(sample).toBeDefined();
    const carried = Object.keys(sample as object).filter(
      (facet) => facet !== 'key' && facet !== 'valueShape',
    );
    expect(carried.sort()).toEqual([...SIZE_SYSTEM_IDENTITY_FACETS].sort());
  });

  it('names its facets in the key, which a short opaque key could not', () => {
    // The reason the derived form was chosen over `size.eu`. Two systems that
    // differ ONLY in audience — the facet worth a full shoe size — must produce
    // two keys, and every facet must be recoverable by a READER of the key even
    // though no code parses it.
    const base = {
      domain: 'footwear',
      region: 'us',
      audience: 'mens',
      measurementBasis: 'manufacturer_label',
    } as const;
    const mens = sizeSystemKey(base);
    const womens = sizeSystemKey({ ...base, audience: 'womens' });
    expect(mens).not.toBe(womens);
    expect(mens).toBe('size.footwear.us.mens.manufacturer_label');
    expect(womens).toBe('size.footwear.us.womens.manufacturer_label');
    // …and a domain change moves it too, so the key is not region-plus-noise.
    expect(sizeSystemKey({ ...base, domain: 'apparel' })).toBe(
      'size.apparel.us.mens.manufacturer_label',
    );
  });

  it('has no inverse — nothing splits a key back into facets', () => {
    // The derivation must stay the ONE authority. A reader that split on dots
    // would produce facets that can disagree with the row, silently, in the
    // direction that reads as a working feature.
    const parsePatterns: readonly { name: string; pattern: RegExp }[] = [
      { name: 'splitting a key', pattern: /\.split\s*\(\s*['"`][.]['"`]/ },
      { name: 'a facet parser', pattern: /\b(?:parseSizeSystemKey|sizeSystemFrom|facetsOfKey)\b/i },
      { name: 'reading a key segment', pattern: /\bkey\s*\.\s*split\b/ },
    ];
    const scanned = OWNED_MODULES.map((file) => [file, stripComments(ownedSource(file))] as const);
    expect(scanned).toHaveLength(2);

    const violations: string[] = [];
    for (const [file, source] of scanned) {
      for (const { name, pattern } of parsePatterns) {
        if (pattern.test(source)) violations.push(`${file} carries ${name}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);

    // The mutation self-test, one fixture per detector: a rotted pattern passes
    // by matching nothing, which looks exactly like a clean run.
    const fixtures: Readonly<Record<string, string>> = {
      'splitting a key': "const parts = other.split('.');",
      'a facet parser': 'export function parseSizeSystemKey(k: string) { return k; }',
      'reading a key segment': 'const [, domain] = key.split(SEPARATOR);',
    };
    expect(Object.keys(fixtures).sort()).toEqual(parsePatterns.map((p) => p.name).sort());
    for (const { name, pattern } of parsePatterns) {
      expect(pattern.test(fixtures[name] as string), `${name} missed its own fixture`).toBe(true);
      expect(pattern.test('return sizeSystemKey(identity);'), `${name} fires on the real code`).toBe(
        false,
      );
    }
  });
});

describe('the registry relates nothing to an attribute key', () => {
  it('carries no attribute key from the footwear seed in either module', () => {
    // The population is DERIVED from the seed rather than hand-listed, so a
    // sixth size attribute added there is covered with no edit here. Relating
    // the two namespaces is the value-level mapping this epic re-scoped to an
    // ADR amendment; it would arrive disguised as a convenience.
    const seed = readFileSync(join(BACKEND_SRC, 'scripts', 'seed-verticals', 'footwear.ts'), 'utf8');
    const seeded = [...new Set([...seed.matchAll(/\bshoe_size_[a-z_]+\b/g)].map((m) => m[0]))];
    // Floor: a seed that stopped matching would make the scan vacuous.
    expect(seeded.length, `found ${seeded.length} seeded size keys`).toBeGreaterThanOrEqual(4);

    const violations: string[] = [];
    for (const file of OWNED_MODULES) {
      const source = stripComments(ownedSource(file));
      for (const key of seeded) {
        if (source.includes(key)) violations.push(`${file} names the attribute key ${key}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);

    // The detector fires on a planted relation — otherwise "no violations" is
    // also what an `includes` over an empty key list reports.
    const planted = `const ATTRIBUTE_FOR = { 'size.x': '${seeded[0] as string}' };`;
    expect(seeded.some((key) => planted.includes(key))).toBe(true);
  });
});

describe('a key this registry does not hold is ABSENT, not present', () => {
  beforeEach(() => {
    registerSizeSystemConceptRegistry();
  });

  it('answers present for every minted key and absent for an unknown one', async () => {
    for (const key of sizeSystemKeys()) {
      await expect(conceptExists('size_system', key)).resolves.toEqual({ state: 'present' });
    }
    // The paired negative, over the same call. Without it a registry returning
    // `present` unconditionally satisfies every line above.
    await expect(
      conceptExists('size_system', 'size.footwear.jp.mens.manufacturer_label'),
    ).resolves.toEqual({ state: 'absent' });
  });

  it('does not answer for a key that differs only in case or whitespace', async () => {
    // A key is a Mercaria machine name with ONE spelling — the column's CHECK
    // admits lowercase only — so a lookup that trimmed and folded would give one
    // concept several names that index differently.
    const real = sizeSystemKeys()[0] as string;
    expect(resolveSizeSystem(real)).not.toBeNull();
    for (const near of [
      real.toUpperCase(),
      ` ${real}`,
      `${real} `,
      `${real}.`,
      `.${real}`,
      real.replace(/[.]/g, '_'),
      real.slice(0, -1),
    ]) {
      expect(resolveSizeSystem(near), `resolved a near-miss: ${near}`).toBeNull();
      await expect(conceptExists('size_system', near)).resolves.toEqual({ state: 'absent' });
    }
  });

  it('reports absent for a key that lives on Object.prototype', async () => {
    // The case that separates a `Map` from an object literal. An object lookup
    // answers `constructor` and `toString` from the prototype chain, so a
    // registry built on one reports `present` for three keys nobody declared —
    // and one of them comes back as a function.
    for (const inherited of [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'prototype',
    ]) {
      expect(resolveSizeSystem(inherited), `resolved ${inherited}`).toBeNull();
      await expect(conceptExists('size_system', inherited)).resolves.toEqual({ state: 'absent' });
    }
  });

  it('never throws, whatever it is handed', async () => {
    const adversarial: readonly unknown[] = [
      '',
      ' ',
      String.fromCharCode(9, 10),
      'Size Systems',
      'size.',
      '.',
      '..',
      'sïze.footwear.eu.unisex.manufacturer_label',
      '.'.repeat(10_000),
      'a'.repeat(100_000),
      'size.footwear.eu.unisex.manufacturer_label; drop table catalog_external_mappings',
      // Not a string at all. `strict: false` and an untyped HTTP boundary make
      // this reachable in practice, and a registry that threw would take a whole
      // ingestion pass down over one bad row.
      null,
      undefined,
      42,
      {},
      [],
    ];
    for (const input of adversarial) {
      await expect(
        conceptExists('size_system', input as string),
        `threw on ${String(input).slice(0, 24)}`,
      ).resolves.toEqual({ state: 'absent' });
    }
  });

  it('answers UNAVAILABLE for a pinned version, which is neither of the other two', async () => {
    // A code table ships exactly one revision. `present` would claim a version
    // check nobody performed and `absent` would deny a system Mercaria has, so
    // the honest answer is the third state — and it BLOCKS. No caller passes a
    // version today, which is precisely why this branch is driven: a defensive
    // branch nobody drives is a claim rather than a behaviour.
    const real = sizeSystemKeys()[0] as string;
    const pinned = await conceptExists('size_system', real, 1);
    expect(pinned.state).toBe('unavailable');
    expect(pinned.state === 'unavailable' ? pinned.reason.length : 0).toBeGreaterThan(20);
    // The control: the SAME key with no version is `present`, so the refusal is
    // about the version and not about the key.
    await expect(conceptExists('size_system', real)).resolves.toEqual({ state: 'present' });
    // …and an unknown key with a version is still refused for the version,
    // because the version cannot be checked at all.
    expect((await conceptExists('size_system', 'size.nope.eu.mens.foot_length', 2)).state).toBe(
      'unavailable',
    );
  });
});

describe('registering the reader is what changes the answer', () => {
  it('answers unavailable before registration and present after', async () => {
    const real = sizeSystemKeys()[0] as string;

    // The control, and the reason this test exists rather than a bare `present`
    // assertion: with no reader the port answers `unavailable`, which the
    // resolver turns into `registry_unavailable`. If registration were a no-op,
    // the second half below would still report `unavailable` — a distinguishable
    // failure from a table that lost the key, which reports `absent`.
    expect(registeredConceptDimensions()).not.toContain('size_system');
    const before = await conceptExists('size_system', real);
    expect(before.state).toBe('unavailable');

    registerSizeSystemConceptRegistry();

    expect(registeredConceptDimensions()).toContain('size_system');
    await expect(conceptExists('size_system', real)).resolves.toEqual({ state: 'present' });
    // `product_type` is the OTHER seam and this issue does not close it —
    // asserted, so a registration that claimed both dimensions fails here.
    expect(registeredConceptDimensions()).not.toContain('product_type');
    expect((await conceptExists('product_type', 'smartphone')).state).toBe('unavailable');
  });

  it('registers under `size_system` and refuses a second reader', () => {
    expect(sizeSystemConceptRegistry.dimension).toBe('size_system');
    registerSizeSystemConceptRegistry();
    // Two readers for one dimension are two answers to one question, and which
    // one answered would depend on import order.
    expect(() => registerSizeSystemConceptRegistry()).toThrow(/already registered/);
  });
});
