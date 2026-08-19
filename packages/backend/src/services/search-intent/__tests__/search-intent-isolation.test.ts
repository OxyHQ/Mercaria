/**
 * What the intent domain cannot reach, asserted STRUCTURALLY (#95 model
 * boundary, safety rules 2 and 6, and the ranking wall every discovery domain
 * carries).
 *
 * A behavioural fixture can only show that today's code does not do a thing. A
 * module that cannot REACH the data cannot use it, which is the stronger
 * statement, and it is what `fee-ranking-isolation.test.ts` established and
 * `search-relevance-isolation.test.ts` widened. This is that gate pointed at
 * the natural-language path, with five walls:
 *
 * 1. **No catalogue TEXT reaches a parser** (safety rule 2). No module here
 *    reads a listing description, a review body, a merchant profile or a source
 *    record payload — so "catalog descriptions, reviews and merchant text are
 *    never concatenated as trusted parser instructions" is a property of the
 *    import graph rather than of whoever writes the next prompt.
 * 2. **No account secret, payment detail, private list or precise location**
 *    (safety rule 6). The `ModelParseInput` type has no field for one; this is
 *    the second, independent statement of it, covering the modules that COMPOSE
 *    that input.
 * 3. **No ranking.** A preference's importance is an ORDINAL RANK here and a
 *    weight is #74's — a query parser reaching `services/ranking/` would be a
 *    second, unversioned ranking authority arriving through the search box.
 * 4. **No fee, referral or retail-cost reference.** The same seven commercial
 *    signals #70's gate names, because an interpretation feeds retrieval and
 *    anything it could read, retrieval could rank by.
 * 5. **No provider SDK and no credential.** #95 model-boundary rule 1 is a
 *    provider-NEUTRAL interface: a named vendor SDK or an API-key read anywhere
 *    in this domain would mean the port had been closed by importing one rather
 *    than by registering one.
 *
 * The fifth wall additionally scans the STOREFRONT's search path, which is
 * #92's `seller-identity-isolation.test.ts` device: model-boundary rule 8 says
 * provider choice and prompt logic stay outside React components, the
 * storefront has no test runner of its own, and the one file that could break
 * that rule is a storefront file.
 *
 * ## The defences that make a green run mean something
 *
 * A vacuity floor on the file count and on each file's size; a mutation
 * self-test per detector against a seeded positive AND a seeded negative; and
 * comment stripping, because every module here documents what it refuses to do
 * in exactly the vocabulary the detectors look for.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDirectoriesAreFlat,
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  INTENT_CANDIDATE_ELEMENTS,
  INTENT_FORBIDDEN_MODEL_OUTPUTS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Walked whole, so the wall holds for modules nobody has written yet. */
const SCANNED_DIRECTORIES = ['services/search-intent', 'db/searchIntent'];

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * `db/schema` was missing, inherited from the three-name list copied from gate
 * to gate and from `scripts/isolation-gate-census.ts`'s own bag-directory list.
 * The four tables this domain owns — sessions, turns, benchmark runs and the
 * enablement, the one place a raw-query column would be DECLARED, and this
 * domain's central privacy claim is that no such column exists — were behind
 * none of the walls below.
 */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a file BELONGING to this domain is called, wherever it lives.
 *
 * Deliberately the FULL `search-intent`, never a bare `search`: #70's canonical
 * retrieval is a different domain with its own gate, and folding its five files
 * in here would make this wall fire at whoever edits them.
 *
 * The HYPHEN is optional, and that widening is load-bearing rather than tidy:
 * the schema directory names its files in camelCase, so `db/schema/searchIntent.ts`
 * cannot match a hyphenated spelling, and adding `db/schema` to the directory
 * list above without this would have changed NOTHING while looking exactly like
 * a fix. Widening a pattern is the PERMISSIVE direction and owes a measurement:
 * `/search-?intent/i` over the whole of `src/` selects 25 modules, all of them
 * this domain's, and `services/search/` still does not match it.
 */
const DOMAIN_NAME_PATTERN = /search-?intent/i;

/**
 * The STOREFRONT's search path, relative to the repository root.
 *
 * Scanned for the provider/credential wall ONLY — the other four are about a
 * server's import graph. #92's gate scans both packages for the same reason:
 * the storefront has no test runner, so a rule about a client file is a build
 * failure here or it is a copy review.
 */
/**
 * The two client modules NAMED for this domain are derived; the two that are
 * not are listed, and each is asserted to exist.
 *
 * `app/(app)/search.tsx` and `SearchInterpretation.tsx` carry no `search-intent`
 * in their names — the screen is the search screen and the component renders an
 * interpretation — so no name rule reaches them without also reaching a hundred
 * unrelated files. Listing exactly two, with a `statSync` behind each, is honest
 * about that; a rule that "derived" them would be a hand list with an extra step.
 */
const NAMED_CLIENT_FILES = [
  'packages/frontend/app/(app)/search.tsx',
  'packages/ui/src/components/marketplace/SearchInterpretation.tsx',
];

/** Where a client module named for this domain can live. */
const CLIENT_DIRECTORIES = ['packages/frontend/lib/api', 'packages/frontend/lib/hooks'];

/** The repository root, two levels above `packages/backend/src`. */
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');

/**
 * The floors, PER SHAPE and measured off this branch.
 *
 * One TOTAL floor was the previous spelling, and a total lets one shape collapse
 * to zero behind another's number: `db/searchIntent` losing both repositories
 * sits inside a total of 14 as long as the service directory still has
 * seventeen, and every detector then runs over a domain missing its data layer.
 *
 * MEASURED: 19 under `services/search-intent` (including the benchmark) and
 * `db/searchIntent` together, 5 in the shared directories, 4 client files.
 */
const MINIMUM_DIRECTORY_FILES = 19;
const MINIMUM_OUTER_FILES = 5;
const MINIMUM_CLIENT_FILES = 4;

/** What reaching each prohibited thing looks like, from any direction. */
const FORBIDDEN_REFERENCES: readonly { wall: string; pattern: RegExp }[] = [
  {
    wall: 'catalogue_text',
    pattern:
      /listings\.description|listing\.description|reviews\/|reviewRepository|source_records|sourceRecord|catalogSourceObject|merchant\.description|storefront\.description/i,
  },
  {
    wall: 'shopper_private_data',
    pattern:
      /guest_checkouts|guestCheckout|addressRepository|findAddress|paymentIntent|providerAccount|savedItems|favoriteRepository|orderRepository|cartRepository|latitude|longitude|postalCode/i,
  },
  {
    wall: 'ranking',
    pattern: /services\/ranking|\.\.\/ranking\/|rankOffers|rankingPolicy|ranking_policy_versions/i,
  },
  {
    wall: 'commercial_signal',
    pattern:
      /commission|fees\/|feeSchedule|order_fee_snapshots|referrals\/|referral_|retail-pricing\/|retailCost|sponsor|proPlan|acceptsFair|faircoin|oxypay/i,
  },
  {
    wall: 'provider_sdk_or_credential',
    pattern:
      /['"](?:openai|@anthropic-ai\/[a-z-]+|@google\/[a-z-]+|cohere-ai|mistralai|ollama)['"]|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|apiKey\s*[:=]|process\.env\.[A-Z_]*API_KEY/i,
  },
];

/**
 * Strip block and line comments.
 *
 * Simple, and simple in the safe direction: a string literal containing `//`
 * would lose its tail, which can only make the scan see LESS code and therefore
 * only produce a false PASS on that one line — never a false failure somebody
 * would disable the gate to silence. The mutation self-test below is what
 * proves the detectors still fire on real code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // The domain's own tests name the prohibitions in order to test them.
      if (entry === '__tests__') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Assert a path is a real file, then return it. */
function assertFile(absolute: string, label: string): string {
  expect(statSync(absolute).isFile(), `${label} is not a file — did it move?`).toBe(true);
  return absolute;
}

/** The files serving this domain from the SHARED directories, DERIVED by name. */
function outerRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE, and matching the PATH rather than the filename. The sweep this
  // replaces was one level deep beside a recursive `walk()`, so anything under
  // `routes/admin/` or `controllers/admin/` was outside every wall here (#460).
  return namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir);
}

function outerPaths(): string[] {
  return outerRelativePaths().map((relative) => assertFile(join(SRC_ROOT, relative), relative));
}

/** The client files: the two derived by name plus the two that carry none. */
function clientPaths(): { absolute: string; relative: string }[] {
  const derived = CLIENT_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(REPO_ROOT, directory))
      .filter((entry) => entry.endsWith('.ts') && DOMAIN_NAME_PATTERN.test(entry))
      .sort()
      .map((entry) => ({
        absolute: assertFile(join(REPO_ROOT, directory, entry), `${directory}/${entry}`),
        relative: `${directory}/${entry}`,
      })),
  );
  const named = NAMED_CLIENT_FILES.map((relative) => ({
    absolute: assertFile(join(REPO_ROOT, relative), relative),
    relative,
  }));
  return [...derived, ...named];
}

function scannedPaths(): string[] {
  return [
    ...SCANNED_DIRECTORIES.flatMap((relative) => walk(join(SRC_ROOT, relative))),
    ...outerPaths(),
  ];
}

describe('the natural-language intent domain cannot reach what it must not', () => {
  it('no module on the intent path references a prohibited thing', () => {
    // Floored PER SHAPE: a total lets one directory collapse to zero behind
    // another's number, and every detector then runs over a domain missing a
    // layer while reporting exactly what a clean run reports.
    const inDirectories = SCANNED_DIRECTORIES.flatMap((relative) =>
      walk(join(SRC_ROOT, relative)),
    );
    const inOuter = outerPaths();
    expect(
      inDirectories.length,
      'services/search-intent + db/searchIntent shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_DIRECTORY_FILES);
    expect(
      inOuter.length,
      'no controller/route/middleware is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_OUTER_FILES);

    const paths = scannedPaths();
    expect(paths.length).toBe(inDirectories.length + inOuter.length);

    const violations: string[] = [];
    for (const path of paths) {
      const raw = readFileSync(path, 'utf8');
      expect(raw.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
      const source = stripComments(raw);
      for (const reference of FORBIDDEN_REFERENCES) {
        const match = reference.pattern.exec(source);
        if (match !== null) violations.push(`${path} reaches ${reference.wall}: ${match[0]}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every detector actually detects — the mutation self-test', () => {
    const positives: Readonly<Record<string, string>> = {
      catalogue_text: "const hint = listing.description ?? '';",
      shopper_private_data: "const saved = await findAddress(oxyUserId, addressId);",
      ranking: "import { rankOffers } from '../ranking/rank.js';",
      commercial_signal: "const cut = await readAffiliateReport(offer).commission;",
      provider_sdk_or_credential: "import OpenAI from 'openai';",
    };
    // An ordinary line from this domain: it reads the registry and the unit
    // table and nothing else, which is what the whole gate is protecting.
    const negative =
      "import { resolveActiveDefinition } from '../attributes/definition-registry.service.js';";

    for (const reference of FORBIDDEN_REFERENCES) {
      const seeded = positives[reference.wall];
      expect(seeded, `no positive fixture for ${reference.wall}`).toBeDefined();
      expect(
        reference.pattern.test(seeded ?? ''),
        `the ${reference.wall} detector no longer fires on a real reference`,
      ).toBe(true);
      expect(
        reference.pattern.test(negative),
        `the ${reference.wall} detector fires on an ordinary registry read`,
      ).toBe(false);
    }
  });

  it('the STOREFRONT names no provider, credential or prompt', () => {
    // Model-boundary rule 8: provider choice and prompt logic remain outside
    // React components. The client submits a QUERY and reads an
    // interpretation; a vendor SDK, an API key or a prompt string in any of
    // these files would mean the boundary had moved into the browser.
    const detector = FORBIDDEN_REFERENCES.find(
      (reference) => reference.wall === 'provider_sdk_or_credential',
    );
    expect(detector, 'the provider detector went missing').toBeDefined();
    const prompts = /systemPrompt|system_prompt|promptTemplate|messages\s*:\s*\[\s*\{\s*role/i;

    const clients = clientPaths();
    expect(
      clients.length,
      'the client scan found too few files; a renamed hook or api module leaves the browser ' +
        'half of the provider wall measuring nothing',
    ).toBeGreaterThanOrEqual(MINIMUM_CLIENT_FILES);

    const violations: string[] = [];
    for (const { absolute, relative } of clients) {
      const raw = readFileSync(absolute, 'utf8');
      expect(raw.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      const source = stripComments(raw);
      const provider = detector?.pattern.exec(source);
      if (provider !== null && provider !== undefined) {
        violations.push(`${relative} names a provider or a credential: ${provider[0]}`);
      }
      const prompt = prompts.exec(source);
      if (prompt !== null) violations.push(`${relative} composes a prompt: ${prompt[0]}`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the domain-name derivation selects the real files, server and client', () => {
    // A derivation that replaced a hand list owes the proof that it still
    // selects everything the list named.
    const outer = outerPaths().map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    for (const expected of [
      'controllers/search-intent.controller.ts',
      'controllers/internal-search-intent.controller.ts',
      'routes/search-intent.ts',
      'routes/internal-search-intent.ts',
      'middleware/search-intent-schemas.ts',
    ]) {
      expect(outer, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // #70's canonical retrieval is a DIFFERENT domain with its own gate, and
    // must not be dragged in by a pattern of bare `search`.
    for (const foreign of ['controllers/search.controller.ts', 'routes/search.ts']) {
      expect(outer, `${foreign} belongs to #70 and has its own gate`).not.toContain(foreign);
    }
    expect(DOMAIN_NAME_PATTERN.test('search.controller.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('internal-search-intent.ts')).toBe(true);

    const client = clientPaths().map((file) => file.relative);
    for (const expected of [
      'packages/frontend/lib/api/search-intent.ts',
      'packages/frontend/lib/hooks/use-search-intent.ts',
      ...NAMED_CLIENT_FILES,
    ]) {
      expect(client, `the client derivation stopped selecting ${expected}`).toContain(expected);
    }
  });

  it('the comment stripper does not hide code from the scan', () => {
    expect(stripComments('const x = listing.description;')).toContain('listing.description');
    expect(stripComments('// nothing here reads a listing.description\nconst x = 1;')).not.toContain(
      'listing.description',
    );
    expect(stripComments('/** never imports openai */\nconst x = 1;')).not.toContain('openai');
  });

  it('what a model may produce and what it may never are DISJOINT vocabularies', () => {
    // The vocabulary half of the wall — the `RETAIL_FORBIDDEN_COMPONENT_KINDS`
    // device. A plausible-looking future addition that is both producible and
    // forbidden fails the build rather than being quietly admitted.
    const producible = new Set<string>(INTENT_CANDIDATE_ELEMENTS);
    const overlap = INTENT_FORBIDDEN_MODEL_OUTPUTS.filter((output) =>
      producible.has(output as string),
    );
    expect(overlap, `elements in both tuples: ${overlap.join(', ')}`).toEqual([]);
    // …and neither is empty, so the disjointness above is not vacuous.
    expect(INTENT_CANDIDATE_ELEMENTS.length).toBeGreaterThanOrEqual(10);
    expect(INTENT_FORBIDDEN_MODEL_OUTPUTS.length).toBe(10);
  });
});

/**
 * The population's own defence, and the general form of the `db/schema` fix.
 *
 * Adding one directory closes today's gap; this closes the class. The DIRECTORY
 * list above is the last hand list in this gate's server half, and hand lists
 * fail silently — every floor and count stayed green while the four tables this
 * domain owns sat outside every wall.
 *
 * The population is re-derived here in RELATIVE form because the scan above
 * works in absolute paths; it is the same two sources, so the two cannot
 * describe different sets.
 *
 * `search-intent` is unambiguous once the hyphen is optional, so the exclusion
 * set is EMPTY — measured, not guessed.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  const relativePopulation = (readDir: DirectoryReader): string[] => [
    ...SCANNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...outerRelativePaths(readDir),
  ];

  it('every search-intent-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: relativePopulation,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 25 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 18,
      plantIn: 'lib',
      plantName: 'search-intent-cache.ts',
    });
  });

  it('the relative population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together:
    // every absolute path the detectors run over has a relative twin here.
    const absolute = scannedPaths().map((path) => path.slice(SRC_ROOT.length + 1)).sort();
    expect(relativePopulation(readSrcDirectory).sort()).toEqual(absolute);
  });
});

describe('#668 — the client-module read lists FLAT directories', () => {
  it('both CLIENT_DIRECTORIES hold modules and no subdirectory', () => {
    // `clientPaths` reads one level. Both are storefront `lib/` directories and
    // flat today; asserting it means a `lib/api/search/` added tomorrow fails
    // the build rather than quietly leaving its modules outside every wall.
    assertDirectoriesAreFlat(CLIENT_DIRECTORIES, (relative) =>
      readdirSync(join(REPO_ROOT, relative), { withFileTypes: true }),
    );
  });
});
