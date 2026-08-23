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
 * - **The key is opaque**: two entries sharing all four facets must be
 *   ADMITTED, because `no_sourced_mapping` is the only relation a sourced
 *   mapping can express. A key derived from the facets would make that branch
 *   unreachable, so its reachability is driven directly rather than assumed.
 * - **The prototype keys**: an object-literal lookup reports `present` for
 *   `constructor` and `toString`. A `Map` reports `absent`. Same call, opposite
 *   answers, so the test measures the implementation rather than the interface.
 * - **The no-parse gate**: it fires on its own fixture and not on the real
 *   source, and it has a population floor, so a moved file cannot pass it by
 *   having nothing to scan.
 *
 * ## Storability is not asserted here
 *
 * That a key is ACCEPTED by
 * `catalog_external_mappings_size_system_key_shape_check` needs a real
 * PostgreSQL server — re-implementing the pattern in TypeScript would be a test
 * of the re-implementation — and `size-system-registry.realdb.test.ts` drives
 * it over every key in the table, together with the real resolver. Since the
 * keys are now hand-written rather than composed, that case covers the whole
 * population by construction: a key that exists is a key it inserts.
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
import { compareSizeDeclarations, type SizeSystem } from '@mercaria/shared-types';
import {
  SIZE_SYSTEM_DEFINITIONS,
  SIZE_SYSTEM_IDENTITY_FACETS,
  SIZE_SYSTEM_KEY_NAMESPACE,
  resolveSizeSystem,
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

describe('every entry declares its four facets, and the key is opaque', () => {
  it('names all four facets on every entry, and a key in the namespace', () => {
    // Population floor: an emptied table makes every walk below vacuous.
    expect(SIZE_SYSTEM_DEFINITIONS.length).toBeGreaterThanOrEqual(5);

    for (const system of SIZE_SYSTEM_DEFINITIONS) {
      for (const facet of SIZE_SYSTEM_IDENTITY_FACETS) {
        // `strict: false`, so a missing facet is `undefined` at runtime rather
        // than a compile error in every case a JS caller can produce. This is
        // what "required FIELDS" means when the guarantee has to hold at run
        // time: a system that never declared its audience would be comparable
        // with everything.
        expect(system[facet], `${system.key} has no ${facet}`).toBeTruthy();
        expect(typeof system[facet]).toBe('string');
      }
      expect(system.valueShape, `${system.key} has no valueShape`).toBeTruthy();
      expect(system.key.startsWith(`${SIZE_SYSTEM_KEY_NAMESPACE}.`)).toBe(true);
    }

    // Distinct, and the count is asserted BOTH ways so a table that lost an
    // entry and two entries colliding on one key look different. This is also
    // what measures `buildRegistry`'s throw: remove it and a duplicate key
    // silently keeps the last, which lands here as a length mismatch.
    const keys = sizeSystemKeys();
    expect(keys).toHaveLength(SIZE_SYSTEM_DEFINITIONS.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists exactly the facets a real entry carries', () => {
    // Derived from a real definition rather than hand-listed: a fifth facet
    // added to `SizeSystemIdentity` and to the entries but forgotten in the
    // tuple would go unchecked above. `valueShape` is excluded BY NAME because
    // shared-types states it is not a facet of identity — a decision recorded
    // here, so a sixth field arriving with no decision fails the build rather
    // than being absorbed. (`merge-plan-census.test.ts`: silence is not a
    // disposition.)
    const sample = SIZE_SYSTEM_DEFINITIONS[0];
    expect(sample).toBeDefined();
    const carried = Object.keys(sample as object).filter(
      (facet) => facet !== 'key' && facet !== 'valueShape',
    );
    expect(carried.sort()).toEqual([...SIZE_SYSTEM_IDENTITY_FACETS].sort());
  });

  it('ADMITS two systems agreeing on all four facets — the aliasing case', () => {
    // The property the key form exists to preserve, driven over a REAL entry
    // rather than a constructed pair: `compareSizeDeclarations` reaches
    // `no_sourced_mapping` only when all four facets are equal and the KEY
    // differs, and that refusal is the only relation a sourced mapping can ever
    // express.
    //
    // What this measures precisely: nothing about a registry entry's SHAPE
    // forecloses the relation — take one and give it a second key and the
    // branch answers. It does NOT measure the key form, because
    // `compareSizeDeclarations` is shared-types' and behaves identically either
    // way; what a derived key would remove is the registry's ability to HOLD
    // two such systems. The gate below ("composes no key from a facet") is the
    // one that goes red if a derivation returns, and it is mutation-tested.
    // Said plainly because a case that claimed to catch the derivation would be
    // a mechanism its body never tests.
    const real = SIZE_SYSTEM_DEFINITIONS[0] as SizeSystem;
    const alias: SizeSystem = { ...real, key: `${real.key}_brandx` };

    // The twin really differs in the key ALONE, or the assertion below would be
    // measuring a facet mismatch and reporting it as the aliasing case.
    for (const facet of SIZE_SYSTEM_IDENTITY_FACETS) {
      expect(alias[facet]).toBe(real[facet]);
    }
    expect(alias.key).not.toBe(real.key);

    expect(compareSizeDeclarations({ system: real, value: '42' }, { system: alias, value: '42' })).toEqual(
      { outcome: 'refused', reason: 'no_sourced_mapping' },
    );
    // The control: the same system against ITSELF still compares, so the
    // refusal above is about the two keys and not about a comparison that
    // refuses everything.
    expect(compareSizeDeclarations({ system: real, value: '42' }, { system: real, value: '42' })).toEqual(
      { outcome: 'equal', systemKey: real.key },
    );
  });

  it('holds no key EQUAL to the composite of its own facets', () => {
    // The behavioural half of "the key is not derived", and the assertion that
    // goes red if a later change re-derives keys from facets. The scan below is
    // a source-text gate and can be walked around; this one reads the DATA.
    //
    // It names the exact forbidden value rather than a shape: a key that equals
    // `namespace + the four facets joined` is what a derivation produces, and it
    // is the one spelling that makes `no_sourced_mapping` unreachable. Measured
    // — reintroducing the derivation in `buildRegistry` turns this red along
    // with the scan.
    let compared = 0;
    for (const system of SIZE_SYSTEM_DEFINITIONS) {
      const composite = [
        SIZE_SYSTEM_KEY_NAMESPACE,
        ...SIZE_SYSTEM_IDENTITY_FACETS.map((facet) => system[facet]),
      ].join('.');
      // The control: the composite really is the string a derivation would
      // produce, so this is comparing against the right thing rather than
      // against something no implementation could ever emit.
      expect(composite.startsWith(`${SIZE_SYSTEM_KEY_NAMESPACE}.`)).toBe(true);
      expect(composite.split('.')).toHaveLength(SIZE_SYSTEM_IDENTITY_FACETS.length + 1);

      expect(system.key, `${system.key} is the composite of its own facets`).not.toBe(composite);
      compared += 1;
    }
    // Floor: an emptied table compares nothing and reports a clean run.
    expect(compared).toBe(SIZE_SYSTEM_DEFINITIONS.length);
    expect(compared).toBeGreaterThanOrEqual(5);
  });

  it('composes no key from a facet, and parses none back', () => {
    // **Where the reversal is enforced, stated because a reader will look in the
    // wrong place.** It is NOT enforced by `compareSizeDeclarations` behaving
    // differently — that function is shared-types' and is byte-identical under
    // either key form. It is enforced by what the registry can HOLD: a derived
    // key collapses two systems agreeing on all four facets into one, so they
    // could not both exist. Somebody hunting for the guarantee inside the
    // comparison will find nothing and conclude the reversal is undefended.
    //
    // This gate and the composite assertion above are the two that hold it. A
    // composition would make the aliasing relation unrepresentable; a parse
    // would give the facets a second authority that can disagree with the
    // entry. Both directions are scanned.
    const forbidden: readonly { name: string; pattern: RegExp }[] = [
      { name: 'splitting a key', pattern: /\.split\s*\(\s*['"`][.]['"`]/ },
      { name: 'a facet parser', pattern: /\b(?:parseSizeSystemKey|sizeSystemFrom|facetsOfKey)\b/i },
      { name: 'reading a key segment', pattern: /\bkey\s*\.\s*split\b/ },
      // The composition direction: a key built by joining facet fields, in
      // either of the two spellings somebody would reach for.
      {
        name: 'joining facets into a key',
        pattern: /\[[^\]]*\b(?:domain|audience|measurementBasis)\b[^\]]*\]\s*\.join\s*\(/,
      },
      {
        name: 'interpolating facets into a key',
        pattern: /`[^`]*\$\{[^}]*\.(?:domain|audience|measurementBasis)\b[^`]*`/,
      },
    ];
    const scanned = OWNED_MODULES.map((file) => [file, stripComments(ownedSource(file))] as const);
    expect(scanned).toHaveLength(2);

    const violations: string[] = [];
    for (const [file, source] of scanned) {
      for (const { name, pattern } of forbidden) {
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
      'joining facets into a key':
        "return [NAMESPACE, entry.domain, entry.region, entry.audience, entry.measurementBasis].join('.');",
      'interpolating facets into a key': 'const key = `size.${entry.domain}.${entry.audience}`;',
    };
    expect(Object.keys(fixtures).sort()).toEqual(forbidden.map((entry) => entry.name).sort());
    const benign = "const found = SIZE_SYSTEMS_BY_KEY.get(key); return system.domain === other.domain;";
    for (const { name, pattern } of forbidden) {
      expect(pattern.test(fixtures[name] as string), `${name} missed its own fixture`).toBe(true);
      expect(pattern.test(benign), `${name} fires on ordinary code`).toBe(false);
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
      conceptExists('size_system', 'size.shoe_jp'),
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
      real.replace('.', '_'),
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
      'sïze.shoe_eu',
      '.'.repeat(10_000),
      'a'.repeat(100_000),
      'size.shoe_eu; drop table catalog_external_mappings',
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
    expect((await conceptExists('size_system', 'size.nope', 2)).state).toBe(
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
