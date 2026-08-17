/**
 * The walls around the public routing and SEO surface (#75), asserted
 * STRUCTURALLY.
 *
 * This domain reads six others and renders what a crawler is told, which makes
 * it the surface most likely to grow a second copy of somebody else's decision
 * — a local "cheapest", a raw destination URL, a second answer to "is this
 * listing restricted". Each wall below is a scan or a type rather than a
 * fixture, because "cannot" is a stronger statement than "did not in this
 * case":
 *
 *  1. **It WRITES nothing.** A metadata surface issuing an insert is a read
 *    with a side effect, and the first one would be an impression, a click or
 *    a crawl log belonging to a domain that owns it.
 *  2. **It never composes an outbound destination.** #71's outbound seam fails
 *    closed and #37 owns the redirect; a `<link>` or an `offers.url` built from
 *    `offer.destinationUrl` would assert at RENDER time what only a click can
 *    establish, and would put a second authority over where Mercaria sends a
 *    browser into a file nobody reads twice.
 *  3. **It cannot reach commercial standing** — fees, referrals, retail
 *    pricing, the ledger, a plan or a commission. #74's wall, applied to the
 *    surface that publishes its output to search engines.
 *  4. **It does not RANK or order.** A sitemap and a comparison are both
 *    ordered lists, and the one this domain emits is the primary key's.
 *  5. **The two emitters cannot reach the database.** `document.ts`,
 *    `structured-data.ts`, `head.ts`, `indexability.ts`, `sitemap.ts`,
 *    `routes.ts`, `redirects.ts` and `query-params.ts` are pure over
 *    `SeoVisibleFacts` and stated inputs. That is what makes "emit only facts
 *    visible on the page" a property of the call graph rather than a review
 *    comment — and it is the wall the parity test rests on.
 *  6. **`config` is read in ONE module.** A second place interpreting
 *    `SEO_INDEXING_MODE` is a second rollout, and the failure mode is a page
 *    that says `index` while its sitemap entry is withheld.
 *
 * Every scanner carries the metro-gate defences: a vacuity floor so a moved
 * file fails the gate instead of silently shrinking it, and a mutation
 * self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOMAIN_DIR = join(SRC_ROOT, 'services/seo');

/**
 * Every `.ts` under `relative`, RECURSIVELY, excluding the test tree.
 *
 * Recursive although `services/seo/` is flat today: the walk it replaces read
 * one directory level, which is precisely the shape that left
 * `services/ingestion/adapters/` — five modules that talk to somebody else's
 * server — outside every wall in its own file until #472. A subdirectory added
 * here would have been invisible in exactly the same way.
 */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/** Every non-test module in the domain, read from the real directory tree. */
function domainSources(): { relative: string; source: string }[] {
  return walk('services/seo').map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/** The flat directories every domain's HTTP surface shares. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware'] as const;

/**
 * The pieces that live outside the domain directory. WALKED and DERIVED, never
 * listed.
 *
 * This was six hand-written paths (#460). `db/seo/` is walked whole; the shared
 * flat directories have no directory of their own, so every SEO-named module in
 * them is taken — which today is exactly the five that were listed, and
 * tomorrow is whatever somebody adds without having to remember this file.
 *
 * No exclusions: unlike `offer` and `comparison`, `seo` names one domain in this
 * tree and no other issue has shipped an SEO-named surface. That is asserted
 * rather than assumed — the floors below would go red on a shrink, and a new
 * SEO-named module belonging to somebody else would show up here as a scanned
 * file rather than as silence.
 */
const OUTER_PATHS = [
  ...walk('db/seo'),
  ...SHARED_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /seo/i.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`),
  ),
];

function outerSources(): { relative: string; source: string }[] {
  return OUTER_PATHS.map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * The modules that must stay PURE — no repository, no `getDb`, no config.
 *
 * `seo.service.ts` and `sitemap.service.ts` are deliberately absent: they are
 * the composition layer and reading is their job. `rollout.ts` is absent for
 * the same reason with respect to config.
 */
const PURE_MODULES = [
  'document.ts',
  'structured-data.ts',
  'head.ts',
  'indexability.ts',
  'sitemap.ts',
  'routes.ts',
  'redirects.ts',
  'query-params.ts',
  'visible-facts.ts',
];

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Source with TYPE-ONLY imports removed.
 *
 * A `import type { Row } from '../../db/...'` is ERASED at compile time and
 * reaches nothing at runtime — naming the shape a repository returns is how a
 * pure module states its input contract. WALL 5 is about runtime reach, so it
 * scans the source with those removed; the mutation self-test below proves a
 * VALUE import from the same path is still caught.
 */
function withoutTypeImports(source: string): string {
  return source.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
}

/** Writing. A read surface that writes is a read surface with a side effect. */
const WRITE_REFERENCE = /\.insert\(|\.update\(|\.delete\(|INSERT INTO|UPDATE \w+ SET|DELETE FROM/;

/** Composing an outbound destination, or performing one. */
const OUTBOUND_COMPOSITION_REFERENCE =
  /destinationUrl|trackingTemplate|awin1\.com|campaignId|res\.redirect|affiliate/;

/** #74's own commercial detector, verbatim — the same prohibition, one layer up. */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\breferrals\/|\bretail-pricing\/|\bledger|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs|retailCostQuote|retail_cost_quotes|subscription|merchantPlan|commissionRate|affiliate_commission/;

/** Ordering something. A sitemap's order is the primary key's, and nothing else's. */
const ORDERING_REFERENCE = /\.sort\(|localeCompare\(/;

/** Reaching persistence from a module that must be pure. */
const PERSISTENCE_REFERENCE = /getDb\(|db\/|drizzle-orm|DatabaseOrTransaction/;

/** Reading a deployment flag. */
const CONFIG_REFERENCE = /\bconfig\.|from '\.\.\/\.\.\/config\/|process\.env/;

describe('the SEO surface exists — the vacuity floor', () => {
  it('scans a domain that exists and is not empty', () => {
    const domain = domainSources();
    // A renamed directory or a moved module must fail HERE rather than make
    // every scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(10);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
    for (const file of outerSources()) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('derives the outer surface rather than listing it, and every shape found something', () => {
    // Floors PER SHAPE rather than one on the total: the repository walk and the
    // three shared-directory derivations break independently, and one total
    // would let a walk collapse to zero while the others carried the number.
    //
    // Each is today's count, because these directories only grow and a SHRINK is
    // the event that should stop the build rather than quietly narrowing every
    // assertion in this file.
    const from = (prefix: string) => OUTER_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('db/seo/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(1);
    expect(from('controllers/'), 'no SEO controller was derived').toBeGreaterThanOrEqual(2);
    expect(from('routes/'), 'no SEO route was derived').toBeGreaterThanOrEqual(2);
    expect(from('middleware/'), 'no SEO request schema was derived').toBeGreaterThanOrEqual(1);

    // No test file may enter the scanned set: a gate that scans its own probes
    // reports violations it wrote itself.
    expect(OUTER_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

    // And the walk really reads the disk rather than returning a cached or empty
    // result: every path it produced resolves to a real file.
    for (const path of OUTER_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
  });

  it('the pure list names modules that exist', () => {
    const present = new Set(domainSources().map((file) => file.relative.split('/').pop()));
    for (const module of PURE_MODULES) {
      expect(present.has(module), `${module} is listed pure but does not exist`).toBe(true);
    }
  });
});

describe('WALL 1: the surface writes nothing', () => {
  it('no module in the domain or its repository issues a write', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        WRITE_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} writes; publishing metadata is a read, and every fact it emits ` +
          'belongs to a domain that owns it',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the write detector actually detects — the mutation self-test', () => {
    expect(WRITE_REFERENCE.test('await db.insert(crawlLogs).values({})')).toBe(true);
    expect(WRITE_REFERENCE.test('await db.update(canonicalProducts).set({})')).toBe(true);
    expect(WRITE_REFERENCE.test('const rows = await db.select().from(brands)')).toBe(false);
  });
});

describe('WALL 2: the surface never sends anybody anywhere', () => {
  it('composes no destination and performs no redirect of its own', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        OUTBOUND_COMPOSITION_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches an offer's destination; #37 owns the redirect and #71's ` +
          'outbound union is where a row states where checkout happens',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the outbound detector actually detects — the mutation self-test', () => {
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('node.url = offer.destinationUrl;')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('const url = `${trackingTemplate}`;')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('res.redirect(301, location)')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('const host = outbound.destinationHost;')).toBe(false);
  });
});

describe('WALL 3: the surface cannot read commercial standing', () => {
  it('no module references a fee, a referral, a plan or a margin', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches commercial standing; what a merchant pays must not decide ` +
          'what a crawler is told',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });
});

describe('WALL 4: the surface orders nothing', () => {
  it('no module sorts a result set', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      const source = withoutComments(file.source);
      // `visible-facts.ts` sorts IMAGES by their own `position` column, which is
      // the order the page renders them in and is a fact rather than a ranking.
      if (file.relative.endsWith('visible-facts.ts')) continue;
      expect(
        ORDERING_REFERENCE.test(source),
        `${file.relative} orders something; a sitemap's order is the primary key's and a ` +
          "comparison's is #74's",
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(17);
  });

  it('the ordering detector actually detects — the mutation self-test', () => {
    expect(ORDERING_REFERENCE.test('rows.sort((a, b) => a.score - b.score)')).toBe(true);
    expect(ORDERING_REFERENCE.test('names.localeCompare(other)')).toBe(true);
    expect(ORDERING_REFERENCE.test('const rows = page.offers;')).toBe(false);
  });
});

describe('WALL 5: the emitters cannot reach the database', () => {
  it('every module that composes metadata is pure over stated inputs', () => {
    let scanned = 0;
    for (const file of domainSources()) {
      const name = file.relative.split('/').pop() ?? '';
      if (!PURE_MODULES.includes(name)) continue;
      expect(
        PERSISTENCE_REFERENCE.test(withoutTypeImports(withoutComments(file.source))),
        `${file.relative} reaches persistence; the emitters take SeoVisibleFacts and nothing ` +
          'else, which is what makes visible-fact parity a property of the call graph',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(PURE_MODULES.length);
  });

  it('the persistence detector actually detects — the mutation self-test', () => {
    const scan = (source: string): boolean =>
      PERSISTENCE_REFERENCE.test(withoutTypeImports(withoutComments(source)));
    expect(scan("import { getDb } from '../../db/postgres.js';")).toBe(true);
    expect(scan("import { eq } from 'drizzle-orm';")).toBe(true);
    expect(scan("import { listBrandSitemapPage } from '../../db/seo/seoRepository.js';")).toBe(true);
    // The erased form, which is what a pure module legitimately uses.
    expect(scan("import type { SeoSitemapCandidateRow } from '../../db/seo/seoRepository.js';")).toBe(
      false,
    );
    expect(scan('const facts = productPageFacts(page, brand);')).toBe(false);
  });
});

describe('WALL 6: the rollout levers are interpreted in ONE module', () => {
  it('only `rollout.ts` and the composition layer read config', () => {
    const permitted = new Set(['rollout.ts', 'seo.service.ts', 'sitemap.service.ts']);
    let scanned = 0;
    for (const file of domainSources()) {
      const name = file.relative.split('/').pop() ?? '';
      if (permitted.has(name)) continue;
      expect(
        CONFIG_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reads a deployment flag; a second interpretation of ` +
          'SEO_INDEXING_MODE is a second rollout',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(8);
  });

  it('the config detector actually detects — the mutation self-test', () => {
    expect(CONFIG_REFERENCE.test('if (config.seo.indexingMode === "on") return true;')).toBe(true);
    expect(CONFIG_REFERENCE.test("import { config } from '../../config/index.js';")).toBe(true);
    expect(CONFIG_REFERENCE.test('if (process.env.SEO_INDEXING_MODE) return true;')).toBe(true);
    expect(CONFIG_REFERENCE.test('const mode = request.mode;')).toBe(false);
  });
});
