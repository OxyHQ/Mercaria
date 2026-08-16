/**
 * The walls around the catalog authoring domain (#367 step 5, ADR 0007 D10).
 *
 * Five prohibitions, each scanned over the WHOLE of `services/catalog-authoring/`
 * and `db/catalogAuthoring/` rather than over a hand-listed set of files — so
 * each holds for modules nobody has written yet, which is the point of scanning a
 * directory instead of an import list.
 *
 * Every detector carries the three defences `~/Oxy/AGENTS.md` prescribes for a
 * scan that answers "is anything still doing X":
 *
 *  - a VACUITY FLOOR on the file count AND on the bytes, so a broken traversal
 *    fails instead of reporting five clean walls over nothing;
 *  - a POSITIVE CONTROL that the scanner finds something it MUST find, run
 *    through the same pipeline the real detectors use;
 *  - a MUTATION SELF-TEST per detector, applied to a copy of a real file, with
 *    the mutation asserted to have LANDED before its effect is measured (a
 *    mutation that never applied is indistinguishable from one that survived).
 *
 * Comments are STRIPPED before the reachability detectors run, because these
 * modules document what they refuse to do in the same vocabulary they would use
 * to do it — the header of `publish.service.ts` names the matcher twice. The
 * FORBIDDEN-SPELLING detector deliberately scans RAW source instead: a
 * prohibition written into a comment is a sentence somebody pastes into code
 * next week.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The two directories the domain owns, whole. */
const SCANNED_DIRS = [
  join(SRC_ROOT, 'services', 'catalog-authoring'),
  join(SRC_ROOT, 'db', 'catalogAuthoring'),
];

interface SourceFile {
  readonly path: string;
  readonly raw: string;
  readonly stripped: string;
}

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      walk(full, into);
      continue;
    }
    if (entry.endsWith('.ts')) into.push(full);
  }
  return into;
}

/**
 * Remove block and line comments.
 *
 * Order matters: block comments first, because a `//` inside a block comment is
 * not a line comment, and stripping lines first would leave the terminator of the
 * enclosing block behind. String literals are NOT protected, and the consequence
 * is a false POSITIVE (a `//` inside a URL string truncating a line) — which is
 * the safe direction and is corrected in one line, where the reverse hides a real
 * call.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function loadSources(): SourceFile[] {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) walk(dir, files);
  return files.map((path) => {
    const raw = readFileSync(path, 'utf8');
    return { path, raw, stripped: stripComments(raw) };
  });
}

const SOURCES = loadSources();

/** One prohibition, as data, so the mutation self-test can drive every one. */
interface Wall {
  readonly name: string;
  readonly pattern: RegExp;
  /** Whether the detector reads the RAW source or the comment-stripped form. */
  readonly reads: 'raw' | 'stripped';
  /**
   * Snippets that MUST trip it, used by the mutation self-test.
   *
   * Every import wall carries BOTH spellings — the path-qualified
   * `services/payments/…` and the RELATIVE `../payments/…` a sibling module
   * actually writes. The first draft of this file matched only the first, and
   * the mutation self-test went red on the second: from
   * `services/catalog-authoring/` the forbidden domain is exactly one `..` away,
   * so the pattern that reads as thorough was blind to the only spelling anybody
   * would ever type. The gate catching its own detector is what it is for.
   */
  readonly mutations: readonly string[];
}

/**
 * An import of a DIRECTORY named `<domain>`, however it is spelled.
 *
 * `(?:[^'"]*\/)?` swallows any prefix — `../`, `../../db/`, `services/` — and
 * then anchors on the directory name plus its trailing slash, so
 * `'../payments/redact.js'`, `'../../services/payments/redact.js'` and
 * `'services/payments/redact.js'` all match while `'../catalog-write.service.js'`
 * does not.
 */
function forbiddenDomainImport(...directories: readonly string[]): RegExp {
  return new RegExp(
    `from\\s+['"](?:[^'"]*\\/)?(?:${directories.join('|')})\\/[^'"]*['"]`,
    'u',
  );
}

const WALLS: readonly Wall[] = [
  {
    name: 'no module here may reach the payment, ledger or fee domains',
    // ADR 0007's non-goals: authoring is a catalogue act. A schema that could
    // read a commission would be a ranking input arriving through a form.
    pattern: forbiddenDomainImport('payments', 'fees', 'ledger'),
    reads: 'stripped',
    mutations: [
      "import { x } from '../payments/redact.js';",
      "import { y } from '../../services/fees/schedule.js';",
    ],
  },
  {
    name: 'no module here may reach the ranking domain',
    // #74's versioned policy is the ONE place an ordering may be decided. An
    // authoring surface that ranked would be a second, unversioned authority
    // reachable by whoever writes the next form.
    pattern: forbiddenDomainImport('ranking'),
    reads: 'stripped',
    mutations: [
      "import { rankOffers } from '../ranking/rank.js';",
      "import { p } from '../../services/ranking/policy.js';",
    ],
  },
  {
    name: 'no module here may reach the referral domain',
    pattern: forbiddenDomainImport('referrals', 'referral-payouts'),
    reads: 'stripped',
    mutations: [
      "import { attribute } from '../referrals/attribution.js';",
      "import { z } from '../../db/referrals/touchRepository.js';",
    ],
  },
  {
    name: 'no module here may run the MATCHER over what an author resolved',
    // ADR 0007 D10: a directly selected canonical entity is linked and never
    // re-matched. The matcher runs for what the author did NOT resolve, and it
    // is reached through `syncListingFacets` after the commit — never from here.
    pattern: forbiddenDomainImport('matching'),
    reads: 'stripped',
    mutations: [
      "import { runMatch } from '../matching/match.service.js';",
      "import { q } from '../../db/matching/queueRepository.js';",
    ],
  },
  {
    name: 'no module here may write #367 step 4\'s tables with its own spelling',
    // The publish path writes typed axes, assignments, signatures and claims —
    // through `services/variant-axes/`, whose `writeVariantAxisValues` computes
    // the digest `native_variant_signatures` stores. A direct insert here would
    // be a second writer of one fact, and the fact it would get wrong first is
    // the signature: a draft and the variant it publishes into would disagree
    // about which two variants are the same thing.
    pattern:
      /\.\s*(insert|update|delete)\s*\(\s*(nativeListingVariantAxes|nativeVariantAxisAssignments|nativeVariantSignatures|nativeListingAttributeClaims|nativeVariantAttributeClaims)\s*\)/u,
    reads: 'stripped',
    mutations: [
      '  await tx.insert(nativeVariantSignatures).values({});',
      '  await db.update(nativeVariantAxisAssignments).set({});',
    ],
  },
  {
    name: 'no repository here may WRITE a table another domain owns',
    // `db/catalogAuthoring/` reads eleven tables in three domains and writes
    // four. A read across a boundary is a join; a write across one is a second
    // authority — and the one that would arrive first is a "small" update of
    // `listings` that skipped the publication chokepoint.
    pattern: /\.\s*(insert|update|delete)\s*\(\s*(attributeDefinitions|attributeLabels|attributeEnumValues|categories|productTypeDefinitions|productTypeFields|productTypeFieldGroups|productTypeCategoryScopes|canonicalProducts|canonicalVariants|brands|productIdentifiers|listings|productVariants)\s*\)/u,
    reads: 'stripped',
    mutations: [
      '  await db.update(categories).set({ name: 1 });',
      '  await db.insert(listings).values({});',
    ],
  },

];

describe('the catalog authoring domain is scanned, not sampled', () => {
  it('finds every module in both directories', () => {
    // The floor is the module count at the time of writing, MINUS nothing: a
    // traversal that returned two files would satisfy every wall below and
    // report five clean prohibitions over almost no source.
    expect(SOURCES.length).toBeGreaterThanOrEqual(9);
  });

  it('reads real source rather than empty files', () => {
    const bytes = SOURCES.reduce((total, file) => total + file.raw.length, 0);
    expect(bytes).toBeGreaterThan(40_000);
  });

  it('POSITIVE CONTROL — the publish path DOES reach step 4\'s service', () => {
    // The wall above says "not with its own spelling"; this says the writes
    // happen at all. Without it, deleting the typed-axis write entirely would
    // turn every wall green — the strongest version of the failure a
    // prohibition-only gate cannot see.
    const source = SOURCES.map((file) => file.stripped).join('\n');
    for (const symbol of [
      'declareListingVariantAxes',
      'writeVariantAxisValues',
      'recordVariantAttributeClaim',
      'recordListingAttributeClaim',
      'typedVariantSignature',
      'normalizeAxisValue',
    ]) {
      expect(source, `${symbol} is not called anywhere in the domain`).toContain(symbol);
    }
  });

  it('POSITIVE CONTROL — the scanner finds an import the domain genuinely makes', () => {
    // The one seam this domain legitimately holds: the store-product create it
    // reuses rather than forking. If the scanner cannot find THIS, it cannot
    // find anything, and every wall below is measuring nothing.
    const found = SOURCES.some((file) =>
      /from\s+['"][^'"]*catalog-write\.service[^'"]*['"]/u.test(file.stripped),
    );
    expect(found).toBe(true);
  });

  it('POSITIVE CONTROL — comment stripping removes a comment and keeps code', () => {
    const sample = "const a = 1; // import { x } from 'services/ranking/y.js';\n/* services/fees */\nconst b = 2;";
    const stripped = stripComments(sample);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
    expect(stripped).not.toContain('services/ranking');
    expect(stripped).not.toContain('services/fees');
  });
});

describe.each(WALLS)('$name', (wall) => {
  it('holds across the whole domain', () => {
    const offenders = SOURCES.filter((file) =>
      wall.pattern.test(wall.reads === 'raw' ? file.raw : file.stripped),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it.each(wall.mutations)(
    'MUTATION SELF-TEST — the detector goes red on `%s`',
    (mutation) => {
      const victim = SOURCES[0];
      expect(victim, 'the traversal found no file to mutate').toBeDefined();
      if (victim === undefined) return;

      const mutated = `${victim.raw}\n${mutation}\n`;
      // The mutation LANDED — asserted before its effect is measured, because a
      // mutation that never applied is indistinguishable from one that survived.
      expect(mutated).not.toBe(victim.raw);
      expect(mutated).toContain(mutation);

      const subject = wall.reads === 'raw' ? mutated : stripComments(mutated);
      expect(wall.pattern.test(subject)).toBe(true);
    },
  );
});

describe('the forbidden field keys are named as VALUES, and disjoint from what a schema composes', () => {
  it('no forbidden key can be a product-type field key in this repository', async () => {
    const { AUTHORING_FORBIDDEN_FIELD_KEYS, RESERVED_OFFER_FACT_KEYS } = await import(
      '@mercaria/shared-types'
    );
    // Every one of the authoring prohibitions that names an OFFER fact is
    // already refused at definition time by
    // `attribute_definitions_reserved_key_check`. The overlap is the point: this
    // list restates the registry's rule at the layer where a client would learn
    // to write `fields.price`, and the ones NOT in the registry's list
    // (`fulfilment`, `merchant`) are the ones only this layer can refuse.
    const reserved = new Set(RESERVED_OFFER_FACT_KEYS);
    const overlap = AUTHORING_FORBIDDEN_FIELD_KEYS.filter((key) => reserved.has(key));
    expect(overlap.length).toBeGreaterThan(0);
    expect(AUTHORING_FORBIDDEN_FIELD_KEYS.length).toBeGreaterThan(overlap.length);
  });

  it('the two lists are non-empty, which is the vacuity floor on the assertion above', () => {
    // Without this, an empty `AUTHORING_FORBIDDEN_FIELD_KEYS` would make the
    // overlap assertion fail loudly — but an empty RESERVED list would make it
    // pass with `overlap.length === 0`... which it does not, because the
    // assertion demands a positive overlap. Both floors are stated anyway, so a
    // later edit to either assertion cannot make this file vacuous silently.
    return import('@mercaria/shared-types').then((types) => {
      expect(types.AUTHORING_FORBIDDEN_FIELD_KEYS.length).toBeGreaterThanOrEqual(10);
      expect(types.RESERVED_OFFER_FACT_KEYS.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe('a flag gates the MOUNT and never a stored row', () => {
  it('no repository or read path in this domain reads `config.catalogAuthoring`', () => {
    // ADR 0007 D12's house rule. The lever lives in `app.ts` (the mount) and in
    // the controller (the TTL and the page bounds, which are numbers rather than
    // gates). A repository that read it could refuse to return a draft somebody
    // already saved, which is precisely the rollback nobody would pull.
    const offenders = SOURCES.filter(
      (file) =>
        file.path.includes(`${'db'}/catalogAuthoring`) &&
        /config\s*\.\s*catalogAuthoring/u.test(file.stripped),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('MUTATION SELF-TEST — the detector goes red on a repository reading the lever', () => {
    const victim = SOURCES.find((file) => file.path.includes(`${'db'}/catalogAuthoring`));
    expect(victim, 'the traversal found no repository file').toBeDefined();
    if (victim === undefined) return;
    const mutated = `${victim.raw}\nif (config.catalogAuthoring.enabled) { /* nothing */ }\n`;
    expect(mutated).not.toBe(victim.raw);
    expect(/config\s*\.\s*catalogAuthoring/u.test(stripComments(mutated))).toBe(true);
  });
});
