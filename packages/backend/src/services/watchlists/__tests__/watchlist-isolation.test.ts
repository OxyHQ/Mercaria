/**
 * The six walls #81 asks for, asserted STRUCTURALLY rather than promised.
 *
 * 1. **No surface claims a multi-store optimum** (#81 basket rule 5,
 *    acceptance 6). The displayed sum is independent per-item minima; #42 owns
 *    the optimization. Scanned across the backend domain AND the storefront
 *    screens, in RAW source, because the risk here is COPY rather than code.
 * 2. **A watchlist is private and cannot be shared** (#81 privacy rule 1). The
 *    permitted and forbidden visibility sets are DISJOINT, the only permitted
 *    one is `private`, and no module can reach a share token or a follower.
 * 3. **A basket total can never read a commission** (#74's prohibited inputs,
 *    one domain over). No module here reaches the fee, referral, retail-pricing
 *    or ledger domains — a total that quietly preferred a better-paying offer
 *    would be indistinguishable from one that did not.
 * 4. **The domain is not a second answer to #80** (the coordinator's
 *    constraint). No module here reads, writes or derives a product save, its
 *    aggregate or its counter.
 * 5. **A private note never leaves the owner's own read** (#81 privacy rules 2
 *    and 4). No snapshot column carries one, and no module emits an analytics
 *    event at all.
 * 6. **The domain stores nothing about a person but their account id.** No
 *    column of the four tables carries a contact detail, a display name or a
 *    device identifier.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails instead of silently shrinking the scan, and a
 * mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertDirectoriesAreFlat,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import { getTableColumns } from 'drizzle-orm';
import {
  WATCHLIST_BASKET_OPTIMIZATION_SEAM,
  WATCHLIST_FORBIDDEN_CLAIMS,
  WATCHLIST_FORBIDDEN_VISIBILITIES,
  WATCHLIST_INDEPENDENT_MINIMA_LABEL,
  WATCHLIST_VISIBILITIES,
} from '@mercaria/shared-types';
import {
  watchlistItems,
  watchlistSnapshotItems,
  watchlistSnapshots,
  watchlists,
} from '../../../db/schema/watchlists.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The storefront, from the backend's own source root. */
const STOREFRONT_ROOT = join(SRC_ROOT, '..', '..', 'frontend');

interface ScannedFile {
  readonly relative: string;
  readonly source: string;
}

/** The domain's OWN directories, walked whole. */
const DOMAIN_DIRECTORIES = ['services/watchlists', 'db/watchlists'];

/** The shared directories, where this domain sits beside every other domain's. */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/** What a file BELONGING to this domain is called, wherever it lives. */
const DOMAIN_NAME_PATTERN = /watchlist/i;

/**
 * Read one scanned file, asserting it is a real file first.
 *
 * A DERIVED population is only as honest as the assertion that every member
 * resolves; a `readdirSync` served from a stale cache would hand every scan
 * below names that no longer exist, which reads as a clean run.
 */
function readScanned(absolute: string, relative: string): ScannedFile {
  expect(statSync(absolute).isFile(), `${relative} is not a file — did it move?`).toBe(true);
  return { relative, source: readFileSync(absolute, 'utf8') };
}

/** Every entry of a directory matching `extension`, and optionally a name pattern. */
function filesIn(
  root: string,
  relativePrefix: string,
  extension: string,
  matching?: RegExp,
): ScannedFile[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(extension))
    .filter((name) => matching === undefined || matching.test(name))
    .sort()
    .map((name) => readScanned(join(root, name), `${relativePrefix}/${name}`));
}

/**
 * Every module of the watchlist domain, DERIVED from disk rather than listed.
 *
 * The two domain directories were always walked; the three files in the SHARED
 * directories were named and are now selected by name PATTERN, so an
 * `internal-watchlists.ts` added tomorrow is scanned the moment it exists. The
 * derivation also picks up `db/schema/watchlists.ts`, which the hand list did
 * not name at all (#460).
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // BOTH halves recurse now. `filesIn` read one directory level, so a
    // sub-directory of `services/watchlists/` was outside every wall and the
    // shared-directory sweep could reach neither `routes/admin/` nor
    // `controllers/admin/` (#460). The shared half also matches the PATH rather
    // than the filename, because a module inside a directory named for the
    // domain names it nowhere in its own name.
    ...DOMAIN_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

function domainSources(): ScannedFile[] {
  return domainRelativePaths().map((relative) =>
    readScanned(join(SRC_ROOT, relative), relative),
  );
}

/**
 * The storefront files that RENDER a basket, DERIVED the same way.
 *
 * The storefront has no test runner of its own, so this file scans it — the
 * `seller-identity-isolation.test.ts` precedent, for its reason: the one file
 * that could make the mistake WALL 1 exists for is a screen, and a gate that
 * only looked at the server would pass while the page said the wrong thing.
 *
 * The previous spelling was a fixed list of six paths FILTERED BY `existsSync`,
 * which is the silent-shrink mechanism written as code: a renamed screen simply
 * left the population. Only the `>= 6` floor stood between that and a wall
 * scanning nothing, and a floor catches a rename while remaining blind to the
 * case that matters more — a NEW basket component nobody added to the list. The
 * two screen directories are now walked whole.
 */
function storefrontSources(): ScannedFile[] {
  return [
    ...filesIn(
      join(STOREFRONT_ROOT, 'app/(app)/watchlists'),
      'frontend/app/(app)/watchlists',
      '.tsx',
    ),
    ...filesIn(join(STOREFRONT_ROOT, 'components/watchlist'), 'frontend/components/watchlist', '.tsx'),
    ...['lib/api', 'lib/hooks'].flatMap((relative) =>
      filesIn(join(STOREFRONT_ROOT, relative), `frontend/${relative}`, '.ts', DOMAIN_NAME_PATTERN),
    ),
  ];
}

/**
 * The storefront's twelve TRANSLATION BUNDLES.
 *
 * WALL 1's subject is what a screen SAYS, and #435b moved every one of those
 * sentences out of the `.tsx` files above and into these. Scanning only the
 * source would therefore have gone on passing while
 * "we found you the cheapest basket across every store" sat in a bundle — the
 * floors above would still be met, because the screens still exist and still
 * have bytes; they just no longer contain the copy.
 *
 * ALL TWELVE, not `en.json`: a forbidden claim is just as prohibited in
 * Spanish, and a translator working from a permissive brief can introduce one
 * that never existed in English — which is the case no English-only scan can
 * ever see.
 */
function storefrontBundles(): ScannedFile[] {
  const dir = join(STOREFRONT_ROOT, 'lib', 'i18n', 'locales');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readScanned(join(dir, name), `frontend/lib/i18n/locales/${name}`));
}

/** The namespace the watchlist screens read their copy from. */
const WATCHLIST_COPY_NAMESPACE = 'watchlists';

/**
 * Every leaf string under one bundle's watchlist namespace, with its dotted key.
 *
 * Scanning the bundle's RAW bytes (which WALL 1 does, and should keep doing) is
 * a claim about the file. It is NOT a claim about the copy: a bundle that lost
 * its `watchlists` namespace entirely is still tens of kilobytes of other
 * screens' sentences, so a `length > 200` floor over raw JSON passes with the
 * subject of the wall completely absent. This is what lets the floor be put on
 * the COPY rather than on the file.
 */
function watchlistCopy(bundle: ScannedFile): { key: string; value: string }[] {
  const parsed: unknown = JSON.parse(bundle.source);
  const found: { key: string; value: string }[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      found.push({ key: path, value: node });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, path === '' ? key : `${path}.${key}`);
    }
  };
  walk((parsed as Record<string, unknown> | null)?.[WATCHLIST_COPY_NAMESPACE], '');
  return found;
}

/**
 * MEASURED on this branch: 52 leaf strings under `watchlists` in each of the
 * twelve bundles. The floor is per BUNDLE, because one locale losing the whole
 * namespace is exactly the shape a single total absorbs.
 */
const MINIMUM_COPY_STRINGS_PER_BUNDLE = 40;

/**
 * Strip comments before a REACHABILITY scan.
 *
 * These modules document what they refuse to do in the same vocabulary the
 * detectors look for, so scanning raw source would make a gate fire on its own
 * explanation — and the fix somebody reaches for is to delete the explanation.
 * WALL 1 is the deliberate exception: a forbidden CLAIM in a comment is a
 * sentence somebody will paste into a screen next week.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching the fee, referral, retail-pricing or ledger domains.
 *
 * The path fragments are written WITHOUT their `services/` or `db/` prefix —
 * `/fees/`, not `services/fees` — because a module inside
 * `services/watchlists/` imports its sibling domain as `'../fees/…'`, and a
 * detector anchored on the absolute-looking form would miss exactly the import
 * a real violation takes. The mutation self-test below is what caught that.
 */
const COMMERCIAL_REFERENCE =
  /from\s+'[^']*(\/fees\/|\/referrals\/|retail-pricing|ledgerRepository)[^']*'|marketplace_fees?\b|commission_revenue\b|affiliate_commission|referral_program|ledger_entries\b/;

/** Reaching the product-save domain (#80), from any direction. */
const SAVE_DOMAIN_REFERENCE =
  /from\s+'[^']*(product-saves|productSaves)[^']*'|product_save_aggregates\b|product_saves\b|rebuildProductSaveAggregate|discloseProductSaveCount/;

/** Reaching a sharing mechanism — a token, a link grant, a follower. */
const SHARING_REFERENCE =
  /share_?token|shareToken|sharedWith|share_?link|shareLink|public_?url|publicUrl|followers?_?count|follow_?targets|collaborators?\b/;

/** Emitting an analytics event, from any direction. See {@link COMMERCIAL_REFERENCE}. */
const ANALYTICS_REFERENCE =
  /from\s+'[^']*\/analytics\/[^']*'|recordAnalyticsEvent\(|emitAnalyticsEvent\(|analytics_events\b/;

describe('a watchlist basket is honest, private, and reaches nothing commercial', () => {
  const domain = domainSources();
  const storefront = storefrontSources();
  const bundles = storefrontBundles();

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // Floored PER SHAPE rather than on one total, so a directory that collapsed
    // to nothing cannot hide behind another's count. MEASURED: 9 under
    // `services/watchlists`, 3 under `db/watchlists`, 4 in the shared ones.
    // Both halves come from the SAME traversal the population uses (#668). They
    // were a one-level `filesIn` beside a recursive population — a second
    // spelling, holding only because `routes/admin/` and `controllers/admin/`
    // happen to hold no watchlist module today.
    const inDomain = DOMAIN_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const inOuter = namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN);
    expect(
      inDomain.length,
      'services/watchlists + db/watchlists shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(12);
    expect(
      inOuter.length,
      'no controller/route/middleware/schema is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(4);
    expect(domain.length).toBe(inDomain.length + inOuter.length);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('is not vacuous about the STOREFRONT either', () => {
    // Two shapes, two floors. MEASURED: 4 screens/components, 2 lib modules.
    const screens = storefront.filter((file) => file.relative.endsWith('.tsx'));
    const modules = storefront.filter((file) => file.relative.endsWith('.ts'));
    expect(
      screens.length,
      'a watchlist screen or basket component moved; WALL 1 cannot see it now',
    ).toBeGreaterThanOrEqual(4);
    expect(modules.length, 'the watchlist api/hook modules moved').toBeGreaterThanOrEqual(2);
    for (const file of storefront) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('is not vacuous about the BUNDLES, which is where the copy lives since #435b', () => {
    // Twelve locales (#396: the storefront is the app that ships `ar`). A
    // directory that moved would read as zero forbidden claims, which is the
    // same answer a clean tree gives.
    expect(
      bundles.length,
      'the storefront locale bundles moved; WALL 1 can no longer see the copy it forbids',
    ).toBeGreaterThanOrEqual(12);
    for (const file of bundles) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
      // …and the floor that a byte count cannot give: the watchlist COPY is
      // still in there. A bundle stripped of this namespace is still a large
      // file of other screens' sentences, so `length > 200` would go on passing
      // with WALL 1's entire subject absent.
      expect(
        watchlistCopy(file).length,
        `${file.relative} carries no \`${WATCHLIST_COPY_NAMESPACE}\` copy — the namespace moved ` +
          'and WALL 1 is now scanning other screens',
      ).toBeGreaterThanOrEqual(MINIMUM_COPY_STRINGS_PER_BUNDLE);
    }
  });

  it('WALL 1: nothing claims a multi-store optimum, and the honest label IS present', () => {
    // RAW source, comments included: a forbidden claim written in a comment is
    // a sentence that reaches a screen the next time somebody writes copy.
    const scanned = [...domain, ...storefront, ...bundles];
    expect(scanned.length).toBeGreaterThanOrEqual(domain.length + bundles.length);
    for (const file of scanned) {
      for (const claim of WATCHLIST_FORBIDDEN_CLAIMS) {
        expect(
          file.source.toLowerCase().includes(claim),
          `${file.relative} contains "${claim}"; the displayed sum is independent per-item ` +
            'minima and #42 owns the optimization that would justify that sentence',
        ).toBe(false);
      }
    }

    // The POSITIVE CONTROL. Proving no file says the wrong thing is only half
    // the claim — a scan over files that say nothing at all would pass it — so
    // the seam has to actually be carried where a basket is composed.
    const evaluation = domain.find((file) => file.relative.endsWith('evaluation.service.ts'));
    expect(evaluation?.source).toContain('WATCHLIST_BASKET_OPTIMIZATION_SEAM');
    expect(WATCHLIST_BASKET_OPTIMIZATION_SEAM.performed).toBe(false);
    expect(WATCHLIST_BASKET_OPTIMIZATION_SEAM.ownedBy).toBe('#42');
  });

  it('WALL 1 positive control: the honest label is REALLY rendered, and a screen reads it', () => {
    // This replaces `expect(WATCHLIST_INDEPENDENT_MINIMA_LABEL).toContain('independent')`
    // — a constant asserted to contain a substring of ITSELF. That is true of the
    // constant alone, stays true however the basket is worded, and says nothing
    // about any surface: it is the shape of a control that cannot fail. Half of
    // WALL 1's claim ("and the honest label IS present") rested on it.
    //
    // The relation instead: the shared-types constant must appear in the English
    // copy the screens actually render, and the component must reference the KEYS
    // those strings sit under. Rename either side and this goes red as STALE,
    // which is the whole job of a control. Keyed rather than phrase-matched,
    // because a phrase assertion over a `.tsx` is precisely the check that went
    // vacuous when #435b moved the copy out.
    const english = bundles.find((file) => file.relative.endsWith('/en.json'));
    expect(english, 'en.json is missing').toBeDefined();
    const carrying = watchlistCopy(english as ScannedFile).filter(({ value }) =>
      value.toLowerCase().includes(WATCHLIST_INDEPENDENT_MINIMA_LABEL.toLowerCase()),
    );
    expect(
      carrying.length,
      `no en.json \`${WATCHLIST_COPY_NAMESPACE}\` string contains ` +
        `"${WATCHLIST_INDEPENDENT_MINIMA_LABEL}" — either the basket stopped saying what its ` +
        'total actually is, or the constant and the copy have drifted apart',
    ).toBeGreaterThanOrEqual(2);

    // …and the component genuinely goes through those keys, so the copy scanned
    // above is the copy rendered rather than a string nothing reaches.
    const basket = storefront.find((file) => file.relative.endsWith('BasketTotalCard.tsx'));
    expect(basket, 'BasketTotalCard.tsx is missing').toBeDefined();
    for (const { key } of carrying) {
      expect(
        (basket as ScannedFile).source.includes(key),
        `BasketTotalCard.tsx no longer references \`${key}\`; the honest label is in the bundle ` +
          'but nothing renders it',
      ).toBe(true);
    }
  });

  it('WALL 2: a watchlist cannot be public or shared', () => {
    expect([...WATCHLIST_VISIBILITIES]).toEqual(['private']);
    const overlap = WATCHLIST_VISIBILITIES.filter((value) =>
      WATCHLIST_FORBIDDEN_VISIBILITIES.includes(value),
    );
    expect(
      overlap,
      'a forbidden visibility joined the permitted tuple; #81 privacy rule 1 keeps lists private ' +
        'until an explicit sharing feature is built, with its own issue and its own review',
    ).toEqual([]);
    expect(WATCHLIST_FORBIDDEN_VISIBILITIES).toContain('public');
    expect(WATCHLIST_FORBIDDEN_VISIBILITIES).toContain('shared_link');

    for (const file of [...domain, ...storefront]) {
      expect(
        SHARING_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches a sharing mechanism; a list reachable by URL is public to ` +
          'everyone the URL reaches, however unguessable it is',
      ).toBe(false);
    }
  });

  it('WALL 3: no module can reach a fee, a commission, a referral or the ledger', () => {
    for (const file of domain) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches a commercial domain; a basket total that could read what an ` +
          'offer pays Mercaria is a total nobody can trust',
      ).toBe(false);
    }
  });

  it('WALL 4: no module reads, writes or derives a product save (#80)', () => {
    for (const file of domain) {
      expect(
        SAVE_DOMAIN_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches the product-save domain; a watchlist is a GROUPING with a ` +
          'purpose, never a second answer to "did this buyer save this product"',
      ).toBe(false);
    }
  });

  it('WALL 5: no module emits an analytics event, and no snapshot column holds a note', () => {
    for (const file of domain) {
      expect(
        ANALYTICS_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} emits an analytics event; #81 privacy rule 4 keeps private notes out ` +
          'of analytics, and the way this domain guarantees it is by emitting nothing at all',
      ).toBe(false);
    }
    const snapshotColumns = [
      ...Object.keys(getTableColumns(watchlistSnapshots)),
      ...Object.keys(getTableColumns(watchlistSnapshotItems)),
    ];
    expect(snapshotColumns.length).toBeGreaterThanOrEqual(40);
    expect(snapshotColumns.filter((name) => /note|comment|memo|remark/i.test(name))).toEqual([]);
  });

  it('WALL 6: no column carries anything about a person but their account id', () => {
    const forbidden =
      /email|phone|address|postal|full_?name|display_?name|handle|username|avatar|ip_?address|user_?agent|device|fingerprint|token|session/i;
    const tables = [
      { name: 'watchlists', columns: Object.keys(getTableColumns(watchlists)) },
      { name: 'watchlist_items', columns: Object.keys(getTableColumns(watchlistItems)) },
      { name: 'watchlist_snapshots', columns: Object.keys(getTableColumns(watchlistSnapshots)) },
      {
        name: 'watchlist_snapshot_items',
        columns: Object.keys(getTableColumns(watchlistSnapshotItems)),
      },
    ];
    // The vacuity floor: a broken reflection would return no columns and pass.
    const total = tables.reduce((sum, table) => sum + table.columns.length, 0);
    expect(total).toBeGreaterThanOrEqual(60);

    for (const table of tables) {
      for (const column of table.columns) {
        expect(
          forbidden.test(column),
          `${table.name}.${column} looks like a personal detail; this domain stores an Oxy ` +
            'account id and nothing else about a person',
        ).toBe(false);
      }
    }
    // …and only the LIST carries the account id at all. An item, a snapshot and
    // a snapshot line all reach their owner through the list, so an erasure is
    // one scoped DELETE rather than four.
    expect(Object.keys(getTableColumns(watchlists))).toContain('oxyUserId');
    for (const table of tables.slice(1)) {
      expect(table.columns.filter((name) => /oxy|actor|buyer/i.test(name))).toEqual([]);
    }
  });

  it('MUTATION SELF-TEST: every detector actually detects', () => {
    // A scanner whose regex rotted would pass every assertion above vacuously.
    expect(COMMERCIAL_REFERENCE.test("import { feeFor } from '../fees/schedule.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { x } from '../../db/fees/feeRepository.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test('select * from ledger_entries')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { listOffers } from '../offers/offer.service.js';")).toBe(
      false,
    );

    expect(
      SAVE_DOMAIN_REFERENCE.test("import { readBestOfferForProduct } from '../product-saves/best-offer.js';"),
    ).toBe(true);
    expect(SAVE_DOMAIN_REFERENCE.test('select count(*) from product_saves')).toBe(true);
    expect(
      SAVE_DOMAIN_REFERENCE.test("import { rankOfferComparison } from '../ranking/comparison.service.js';"),
    ).toBe(false);

    expect(SHARING_REFERENCE.test('const shareToken = mintToken();')).toBe(true);
    expect(SHARING_REFERENCE.test('share_link text not null')).toBe(true);
    expect(SHARING_REFERENCE.test('const displayCurrency = list.displayCurrency;')).toBe(false);

    expect(ANALYTICS_REFERENCE.test("import { recordAnalyticsEvent } from '../analytics/emit.js';")).toBe(
      true,
    );
    expect(ANALYTICS_REFERENCE.test('recordAnalyticsEvent({ type: "x" });')).toBe(true);
    expect(ANALYTICS_REFERENCE.test('const evaluatedAt = new Date();')).toBe(false);

    // WALL 1's detector is a plain substring over the forbidden CLAIMS, so the
    // self-test is that the list is real and that a sentence containing one is
    // caught in the case a screen would actually write it.
    expect(WATCHLIST_FORBIDDEN_CLAIMS.length).toBeGreaterThanOrEqual(6);
    const offending = 'We found you the Cheapest Basket across every store.';
    expect(
      WATCHLIST_FORBIDDEN_CLAIMS.some((claim) => offending.toLowerCase().includes(claim)),
    ).toBe(true);
    const honest = `Total of ${WATCHLIST_INDEPENDENT_MINIMA_LABEL}, in EUR.`;
    expect(WATCHLIST_FORBIDDEN_CLAIMS.some((claim) => honest.toLowerCase().includes(claim))).toBe(
      false,
    );

    // And the comment stripper must not eat real code, or the reachability
    // walls would pass by scanning nothing.
    expect(withoutComments('// a comment\nimport { x } from "../fees/a.js";')).toContain(
      '../fees/a.js',
    );
    expect(withoutComments('/* never imports ../fees/a.js */\nconst x = 1;')).not.toContain(
      '../fees/a.js',
    );
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY lists above are the last hand lists in this gate's server
 * derivation, and hand lists fail silently. So: sweep the whole of `src/` for
 * paths NAMING this domain and require each to be in the population or in a
 * counted exclusion. A bag directory nobody has invented yet brings its modules
 * under these walls with no edit here.
 *
 * The exclusion set is EMPTY because it was MEASURED — `watchlist` is an
 * unambiguous token in this tree and the sweep selects 16 modules, every one of
 * them this domain's.
 *
 * The STOREFRONT half is out of scope for this sweep, which walks `src/` only;
 * it has its own derivation and its own floor above.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every watchlist-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 16 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 12,
      plantIn: 'lib',
      plantName: 'watchlists-cache.ts',
    });
  });

  it('the relative population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together.
    expect(domainSources().map((file) => file.relative).sort()).toEqual(
      domainRelativePaths().sort(),
    );
  });
});

describe('#668 — the shared-directory sweep can tell a directory from a file', () => {
  it('sees a module inside a SEEDED subdirectory of `routes`', () => {
    // The acceptance #668 asks for, and the only thing that separates a fixed
    // traversal from a tree that happens to be flat. `routes/admin/` holds 23
    // modules and `controllers/admin/` 19 today; neither holds one named for
    // this domain, which is exactly why a test over the real tree cannot tell.
    const seeded: DirectoryReader = (relative) =>
      relative === 'routes'
        ? [
            ...readSrcDirectory(relative),
            { name: 'admin', isDirectory: () => true, isFile: () => false },
          ]
        : relative === 'routes/admin'
          ? [{ name: 'watchlists-admin.ts', isDirectory: () => false, isFile: () => true }]
          : readSrcDirectory(relative);
    const planted = `routes/admin/${'watchlists-admin.ts'}`;
    expect(domainRelativePaths(seeded), 'the shared sweep does not recurse').toContain(planted);
    // …and the half that makes it non-circular: the seeded module is absent from
    // the real tree, so this measures the traversal rather than the tree.
    expect(
      domainRelativePaths(),
      'the seeded control exists on disk, so this proves nothing',
    ).not.toContain(planted);
  });

  it('and the remaining one-level `filesIn` lists only directories that are FLAT', () => {
    // The latent half, stated rather than left implicit (#668). `filesIn` still
    // reads one level, and every directory it is now called with has no
    // subdirectory — asserted here, so the day one appears this goes red instead
    // of quietly listing less.
    // ONE implementation, shared (#668). It was this loop inline over an inline
    // array with NO floor on the array — emptying it left all 26 tests in this
    // file green, which is the exact shape #460 exists to remove.
    assertDirectoriesAreFlat(['services/watchlists', 'db/watchlists']);
  });
});
