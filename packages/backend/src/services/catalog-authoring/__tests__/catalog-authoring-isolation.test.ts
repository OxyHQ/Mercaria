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
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  type ForeignModule,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * The hyphen is optional because `db/catalogAuthoring/` and
 * `db/schema/catalogAuthoring.ts` are camelCase. Measured over the whole of
 * `src/`, this selects sixteen modules and every one is this domain's — the
 * bare word `authoring` adds only `services/navigation/authoring.service.ts`,
 * which is #341's.
 */
const AUTHORING_NAME_PATTERN = /catalog-?authoring/i;

/** The two directories the domain owns, whole. */
const OWNED_DIRECTORIES = ['services/catalog-authoring', 'db/catalogAuthoring'] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the domain, as paths RELATIVE to `src/`.
 *
 * It was the two owned directories and nothing else (#460), which left FOUR
 * modules behind none of the seven walls: the controller, the route, the request
 * schemas and `db/schema/catalogAuthoring.ts`.
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, AUTHORING_NAME_PATTERN, readDir),
  ];
}

interface SourceFile {
  readonly path: string;
  readonly raw: string;
  readonly stripped: string;
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
  return domainRelativePaths().map((path) => {
    const raw = readFileSync(join(SRC_ROOT, path), 'utf8');
    return { path, raw, stripped: stripComments(raw) };
  });
}

const SOURCES = loadSources();

/**
 * The ONE detection function. Every wall assertion and every mutation self-test
 * calls exactly this, over a `files` argument rather than over `SOURCES`.
 *
 * That parameter is the whole point, and it was added because the lever wall
 * below used to be checked one way and self-tested another: the wall applied a
 * PATH predicate and its self-test asserted only that the regex matched a string,
 * so it proved the pattern worked and said nothing about the filter — which meant
 * it could not see that the filter's scope was four files of the domain's ten. A
 * self-test that cannot detect its own gate's narrowing is worse than none,
 * because the passing test is what stops the next reader looking.
 *
 * Returning PATHS rather than a boolean is deliberate too: a self-test can then
 * assert the offender set is EXACTLY the file it mutated, which also fails a
 * filter that has become so broad it flags everything.
 */
function offendingPaths(wall: Wall, files: readonly SourceFile[]): string[] {
  const exempt = new Set((wall.exempt ?? []).map((entry) => entry.path));
  return files
    .filter((file) => !exempt.has(file.path))
    .filter((file) => wall.pattern.test(wall.reads === 'raw' ? file.raw : file.stripped))
    .map((file) => file.path);
}

/** Every distinct directory the population spans. */
function populationDirectories(files: readonly SourceFile[]): string[] {
  return [...new Set(files.map((file) => file.path.split('/').slice(0, -1).join('/')))].sort();
}

/**
 * One file per scanned directory, for the mutation self-tests to seed into.
 *
 * Derived from the POPULATION's own directories rather than hand-listed, so a
 * directory added to the domain gets a victim automatically — and if one somehow
 * contains no seedable `.ts` file, the length assertion in the self-test fails
 * rather than silently covering one directory fewer.
 *
 * #460 moved this from `SCANNED_DIRS` (two entries) to the population's distinct
 * directories (six), which is the same rule applied to the population as it now
 * is rather than as it was. A victim is chosen PER WALL, because a module this
 * wall exempts cannot be a victim for it: the exemption would suppress the red
 * the self-test is measuring, and the test would fail for the wrong reason.
 *
 * One victim per directory rather than one overall, and this was MEASURED: with a
 * single victim, reintroducing the exact path predicate this file was fixed for
 * turned only ONE test red, because the lone victim happened to sit inside the
 * surviving half. With a victim in each, the same mutation turns seventeen red. A
 * gate whose self-test depends on which file the traversal happened to return
 * last is a gate that goes quiet on a rename.
 */
function mutationVictims(wall: Wall): SourceFile[] {
  const exempt = new Set((wall.exempt ?? []).map((entry) => entry.path));
  return populationDirectories(SOURCES).flatMap((directory) => {
    const inDir = SOURCES.filter(
      (file) => file.path.startsWith(`${directory}/`) && !exempt.has(file.path),
    );
    const last = inDir[inDir.length - 1];
    return last === undefined ? [] : [last];
  });
}

/**
 * Directories every one of whose modules this wall exempts, so they legitimately
 * get no victim. NAMED, so "one directory fewer" is a decision rather than a
 * number nobody re-derives.
 */
function whollyExemptDirectories(wall: Wall): string[] {
  const exempt = new Set((wall.exempt ?? []).map((entry) => entry.path));
  return populationDirectories(SOURCES).filter((directory) =>
    SOURCES.filter((file) => file.path.startsWith(`${directory}/`)).every((file) =>
      exempt.has(file.path),
    ),
  );
}

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
  /**
   * Modules of the domain this ONE wall does not apply to.
   *
   * Added by #460 with the population, and the ordering is the decision: widening
   * the population brought `controllers/catalog-authoring.controller.ts` inside
   * SEVEN walls, and it trips exactly TWO of them for a legitimate reason. The
   * alternatives were both worse. Leaving the controller outside the population —
   * what this file used to do, and said so — buys "no exemption to keep true" by
   * giving up the other five walls on the domain's largest HTTP surface. Narrowing
   * the two detectors to `.enabled` is the permissive direction, and it would
   * admit the `process.env` read somebody adds beside the legitimate bound.
   *
   * So each exemption is per WALL, by exact path, and carries its probe in both
   * directions below: it must be IN the population (or it excuses nothing) and it
   * must GENUINELY trip the wall it is excused from (or it is doing nothing).
   */
  readonly exempt?: readonly ForeignModule[];
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
    //
    // `canonicalAttributeValues` was MISSING from this alternation until #367's
    // invariants audit, and it is the one whose absence had a rule behind it:
    // ADR 0007 D7 says a claim becomes a canonical fact only through the
    // selection and provenance machinery, and this wall omitting the SELECTED
    // fact meant a publish path promoting a claim straight into it shipped
    // green. `db/__tests__/canonical-attribute-value-chokepoint.test.ts` is the
    // census over the whole tree; this is the same rule at the domain's own
    // edge, so a violation fails in the diff that writes it.
    //
    // The list is still a hand list, which `docs/isolation-gates.md` records as
    // blind in the ADD direction — `canonicalProductFamilies`, `canonicalImages`
    // and `canonicalFieldProvenance` are named by nothing here. They are left
    // out deliberately rather than forgotten: none of the three has a rule of
    // its own that this domain could break, so adding them would widen the wall
    // without a decision behind it.
    pattern: /\.\s*(insert|update|delete)\s*\(\s*(attributeDefinitions|attributeLabels|attributeEnumValues|categories|productTypeDefinitions|productTypeFields|productTypeFieldGroups|productTypeCategoryScopes|canonicalProducts|canonicalVariants|canonicalAttributeValues|brands|productIdentifiers|listings|productVariants)\s*\)/u,
    reads: 'stripped',
    mutations: [
      '  await db.update(categories).set({ name: 1 });',
      '  await db.insert(listings).values({});',
      '  await tx.insert(canonicalAttributeValues).values({});',
    ],
  },
  {
    name: 'no module here may read the ROLLOUT LEVER — a flag gates the mount, never a stored row',
    // ADR 0007 D12. The lever lives in `app.ts` (the mount); the page bounds and
    // the draft TTL live in `controllers/catalog-authoring.controller.ts`.
    //
    // That controller used to be OUTSIDE the scanned population, and this comment
    // used to say the wall therefore "needs no exemption and has none". #460
    // brought it inside, because keeping it out cost the other five walls on the
    // domain's largest HTTP surface to save one exemption on two. It is exempted
    // here BY NAME and BY WALL, and the assertion that replaces what the
    // exemption gives up is below: the controller may read a BOUND and may not
    // read `.enabled`.
    //
    // What it prevents: a repository or a service that read the lever could
    // refuse to return a draft somebody already saved, which is precisely the
    // rollback nobody would pull. This wall previously covered `db/catalogAuthoring`
    // ONLY — four files of ten — while its own title claimed "repository or read
    // path", so every service in the domain could gate on the flag with a green
    // build. It now covers both directories.
    pattern: /config\s*\.\s*catalogAuthoring/u,
    reads: 'stripped',
    mutations: [
      '  if (config.catalogAuthoring.enabled) return null;',
      '  const ttl = config . catalogAuthoring . draftTtlSeconds;',
    ],
    exempt: [
      {
        path: 'controllers/catalog-authoring.controller.ts',
        why:
          'It reads FOUR page/TTL bounds off `config.catalogAuthoring` and no lever. The ' +
          'prohibition this wall exists for — a read path that could refuse a draft somebody ' +
          'already saved — is asserted on this exact module separately, against `.enabled`.',
      },
    ],
  },
  {
    name: 'no module here may reach configuration at all',
    // The strongest form of the wall above, and it is the shape
    // `services/__tests__/product-type-isolation.test.ts` already uses. It holds
    // today: the domain imports no config module and reads no `process.env`.
    //
    // It is kept BESIDE the specific lever wall rather than replacing it, even
    // though it subsumes it — if a legitimate bound ever moves from the
    // controller into a service, whoever hits this wall will excuse THIS one, and
    // the lever prohibition has to survive that. The two also fail with different
    // messages, and the specific one names the property.
    pattern: /from\s+['"][^'"]*\/config(?:\/[^'"]*)?['"]|process\s*\.\s*env\b/u,
    reads: 'stripped',
    mutations: [
      "import { config } from '../../config/index.js';",
      '  const mode = process.env.CATALOG_AUTHORING_ENABLED;',
    ],
    exempt: [
      {
        path: 'controllers/catalog-authoring.controller.ts',
        why:
          "It imports `../config/index.js` for the four bounds above. This is the wall's own " +
          'stated failure mode — "whoever hits this wall will excuse THIS one" — arriving as ' +
          'predicted, which is why the specific lever wall is kept beside it rather than ' +
          'replaced by it.',
      },
    ],
  },
];

describe('the catalog authoring domain is scanned, not sampled', () => {
  it('finds every module in both directories', () => {
    // The floor is the module count at the time of writing, MINUS nothing: a
    // traversal that returned two files would satisfy every wall below and
    // report five clean prohibitions over almost no source.
    expect(SOURCES.length).toBeGreaterThanOrEqual(13);
  });

  it('reads real source rather than empty files', () => {
    const bytes = SOURCES.reduce((total, file) => total + file.raw.length, 0);
    expect(bytes).toBeGreaterThan(60_000);
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
    expect(offendingPaths(wall, SOURCES)).toEqual([]);
  });

  it.each(wall.mutations)(
    'MUTATION SELF-TEST — the REAL assertion goes red on `%s`, in EVERY scanned directory',
    (mutation) => {
      const victims = mutationVictims(wall);
      const exemptDirs = whollyExemptDirectories(wall);
      expect(
        victims.length,
        `a scanned directory has no file to mutate, so it is self-tested by nothing ` +
          `(wholly exempt here: ${exemptDirs.join(', ') || 'none'})`,
      ).toBe(populationDirectories(SOURCES).length - exemptDirs.length);
      // A floor that is NOT derived from the list it defends: whatever the
      // exemptions do, most of the domain's directories must still be seeded.
      expect(victims.length, 'almost every directory is exempt from this wall').toBeGreaterThanOrEqual(
        4,
      );

      for (const victim of victims) {
        const mutatedRaw = `${victim.raw}\n${mutation}\n`;
        // The mutation LANDED — asserted before its effect is measured, because a
        // mutation that never applied is indistinguishable from one that survived.
        expect(mutatedRaw).not.toBe(victim.raw);
        expect(mutatedRaw).toContain(mutation);

        // Run the REAL detector over a population with the mutated file swapped
        // in, rather than regex-testing a string. `offendingPaths` is the same
        // function the wall assertion above calls, so a narrowing of its filter —
        // a path predicate, a truncated population, a `reads` mix-up — turns this
        // red.
        const mutatedSources = SOURCES.map((file) =>
          file.path === victim.path
            ? { path: file.path, raw: mutatedRaw, stripped: stripComments(mutatedRaw) }
            : file,
        );
        // EXACTLY the mutated file, which also fails a filter grown so broad it
        // flags its innocent neighbours.
        expect(
          offendingPaths(wall, mutatedSources),
          `mutating ${victim.path} did not produce exactly that one offender`,
        ).toEqual([victim.path]);
      }
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

describe('the lever wall covers the whole domain, not one directory of it', () => {
  it('scans BOTH directories — the narrowing this wall used to carry', () => {
    // The wall it replaced filtered on `path.includes('db/catalogAuthoring')`,
    // so it measured 4 files while claiming "repository or read path". This
    // asserts the population it now runs over spans both, by DIRECTORY rather
    // than by count — a count floor would be satisfied by ten files from one
    // directory, which is the exact shape of the bug.
    // Per DIRECTORY rather than by count — a count floor would be satisfied by
    // ten files from one directory, which is the exact shape of the bug. The
    // arithmetic identity that used to close this line (`services + repositories
    // === SOURCES.length`) was a SECOND spelling of the population, and #460
    // deleted it rather than repairing it: it is now false by design, because
    // the population also spans the four shared directories.
    const services = SOURCES.filter((file) => file.path.startsWith('services/catalog-authoring/'));
    const repositories = SOURCES.filter((file) => file.path.startsWith('db/catalogAuthoring/'));
    expect(services.length).toBeGreaterThanOrEqual(4);
    expect(repositories.length).toBeGreaterThanOrEqual(3);
    expect(
      populationDirectories(SOURCES).length,
      'the population no longer spans the six directories this domain occupies',
    ).toBeGreaterThanOrEqual(6);
  });

  it('MUTATION SELF-TEST — a SERVICE reading the lever is caught, which the old wall missed', () => {
    // The regression test for the narrowing itself. Under the old predicate this
    // mutation survived: the file is in `services/`, the filter only looked at
    // `db/`, and the old self-test seeded its mutation into a `db/` file so it
    // never noticed.
    const wall = WALLS.find((candidate) => candidate.name.includes('ROLLOUT LEVER'));
    expect(wall, 'the lever wall is no longer in WALLS').toBeDefined();
    if (wall === undefined) return;

    const victim = SOURCES.find((file) => file.path.startsWith('services/catalog-authoring/'));
    expect(victim, 'the traversal found no service file').toBeDefined();
    if (victim === undefined) return;

    const mutatedRaw = `${victim.raw}\nif (config.catalogAuthoring.enabled) return null;\n`;
    expect(mutatedRaw).not.toBe(victim.raw);
    const mutatedSources = SOURCES.map((file) =>
      file.path === victim.path
        ? { path: file.path, raw: mutatedRaw, stripped: stripComments(mutatedRaw) }
        : file,
    );
    expect(offendingPaths(wall, mutatedSources)).toEqual([victim.path]);
  });
});

describe('the population the seven walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: AUTHORING_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // all sixteen modules the whole-tree sweep finds are this domain's.
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 16 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 12,
      plantIn: 'lib',
      plantName: 'catalog-authoring-cache.ts',
    });
  });

  it('the four modules the two-directory population could not reach are in it', () => {
    // An identity assertion, not a floor. A floor set below 16 is met without
    // any of them.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/catalog-authoring.controller.ts',
      'db/schema/catalogAuthoring.ts',
      'middleware/catalog-authoring-schemas.ts',
      'routes/catalog-authoring.ts',
    ]) {
      expect(population, `${named} is outside all seven walls again`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, AUTHORING_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(9);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      3,
    );
  });

  it('the optional hyphen is load-bearing', () => {
    const camelCase = 'db/schema/catalogAuthoring.ts';
    expect(AUTHORING_NAME_PATTERN.test(camelCase)).toBe(true);
    expect(/catalog-authoring/.test(camelCase), 'the hyphenated spelling already matched').toBe(
      false,
    );
    expect(domainRelativePaths()).toContain(camelCase);
  });
});

describe('every per-wall exemption is real, in BOTH directions (#448)', () => {
  const exemptions = WALLS.flatMap((wall) =>
    (wall.exempt ?? []).map((entry) => ({ wall, entry })),
  );

  it('there are some, and they are the two this conversion had to add', () => {
    // The vacuity floor on the checks below. An empty list would make every one
    // of them pass by iterating nothing.
    expect(exemptions.length).toBe(2);
    expect(new Set(exemptions.map(({ entry }) => entry.path))).toEqual(
      new Set(['controllers/catalog-authoring.controller.ts']),
    );
  });

  it.each(exemptions.map(({ wall, entry }) => [wall.name, entry.path] as const))(
    'COULD it ever fire? `%s` excuses `%s`, which is IN the population',
    (_name, path) => {
      // An exemption pointing at a path the traversal never produces excuses
      // nothing while reading exactly like a decision. Measured elsewhere in
      // this repo: three of six exemptions in another guard were structurally
      // unmatchable.
      expect(SOURCES.map((file) => file.path)).toContain(path);
      expect(statSync(join(SRC_ROOT, path)).isFile()).toBe(true);
    },
  );

  it.each(exemptions.map(({ wall, entry }) => [wall.name, entry.path] as const))(
    'DOES it still fire? `%s` would go red on `%s` without the exemption',
    (name, path) => {
      // The other direction. A module that stopped tripping the wall is one
      // still being excused, and the excuse is then a comment claiming a
      // decision nobody has re-made.
      const wall = WALLS.find((candidate) => candidate.name === name);
      expect(wall, 'the wall named by the exemption is gone').toBeDefined();
      if (wall === undefined) return;
      const withoutExemption: Wall = { ...wall, exempt: [] };
      expect(
        offendingPaths(withoutExemption, SOURCES),
        `${path} no longer trips ${name}, so excusing it is doing nothing`,
      ).toEqual([path]);
    },
  );

  it('and each one states a reason a person can read', () => {
    for (const { entry } of exemptions) expect(entry.why.length).toBeGreaterThan(40);
  });
});

describe('what the controller exemption gives up is asserted separately', () => {
  const CONTROLLER = 'controllers/catalog-authoring.controller.ts';

  it('the controller reads BOUNDS and never the rollout lever', () => {
    // The prohibition the two config walls exist for, applied to the one module
    // exempted from them. Without this the exemption would be a hole rather than
    // a scope judgement: `.enabled` in a read path could refuse a draft somebody
    // already saved, which is the rollback nobody would pull (ADR 0007 D12).
    const controller = SOURCES.find((file) => file.path === CONTROLLER);
    expect(controller, 'the controller is not in the population').toBeDefined();
    if (controller === undefined) return;
    expect(
      /config\s*\.\s*catalogAuthoring\s*\.\s*enabled/u.test(controller.stripped),
      'the controller reads the rollout lever',
    ).toBe(false);
    // POSITIVE CONTROL: it genuinely reads the bounds, so this is a scan over
    // real config reads rather than over a module that touches none.
    expect(/config\s*\.\s*catalogAuthoring\s*\./u.test(controller.stripped)).toBe(true);
  });

  it('MUTATION SELF-TEST: a lever read in the controller is caught by that assertion', () => {
    const controller = SOURCES.find((file) => file.path === CONTROLLER);
    expect(controller).toBeDefined();
    if (controller === undefined) return;
    const mutated = stripComments(
      `${controller.raw}\nif (config.catalogAuthoring.enabled) return null;\n`,
    );
    expect(mutated).not.toBe(controller.stripped);
    expect(/config\s*\.\s*catalogAuthoring\s*\.\s*enabled/u.test(mutated)).toBe(true);
  });
});
