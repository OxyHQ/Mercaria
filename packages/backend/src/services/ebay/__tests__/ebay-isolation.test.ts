/**
 * The walls around the eBay source (#65), asserted STRUCTURALLY.
 *
 * Five properties, each a scan or a type read rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case". Every detector
 * carries `~/Oxy/AGENTS.md`'s three defences: a vacuity floor (an empty or moved
 * file fails the gate instead of passing it by having nothing to match), an
 * ENUMERATION floor read off the real directory, and a mutation self-test, so a
 * rotted regex cannot pass by matching nothing.
 *
 *  1. **Mercaria never composes or mutates an EPN link.** #64 §6's eBay rule 3
 *     and the EPN Network Agreement: commission attribution lives entirely in
 *     the parameters eBay put in that URL, and a rebuilt link is
 *     indistinguishable from a working one until a month of revenue is missing.
 *  2. **The adapter reaches nothing.** #62's write boundary, restated for this
 *     directory — the shared `ingestion-isolation.test.ts` already scans it, and
 *     this adds the eBay-specific one: no reach into the commerce graph through
 *     a service either.
 *  3. **No access token is ever written down.** Nothing in the domain persists
 *     one, and there is no column that could hold it.
 *  4. **A minted marketplace seller grants nothing.** No relationship (#55), no
 *     native-store link (#84), no claim (#83), no native checkout.
 *  5. **Nothing here ranks anything** (#74's), performs #37's redirect, or
 *     reaches the retail domain (#116/#121).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EBAY_FORBIDDEN_LINK_OPERATIONS,
  EBAY_OUTBOUND_DESTINATION_KINDS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the eBay domain. Kept explicit so a MOVED file fails the gate. */
const EBAY_DOMAIN_PATHS = [
  'services/ebay/constants.ts',
  'services/ebay/ports.ts',
  'services/ebay/errors.ts',
  'services/ebay/http.ts',
  'services/ebay/token.ts',
  'services/ebay/attribution.ts',
  'services/ebay/normalize.ts',
  'services/ebay/browse.ts',
  'services/ebay/cursor.ts',
  'services/ebay/register.ts',
  'services/ebay/reconciliation.ts',
  'services/ingestion/adapters/ebay.ts',
  'services/ingestion/seller-identity.ts',
  'db/ebay/ebayBudgetRepository.ts',
  'db/ebay/ebayCohortRepository.ts',
  'db/ebay/ebayDiscoveryRepository.ts',
  'db/ebay/ebayReconciliationRepository.ts',
  'db/ingestion/marketplaceSellerRepository.ts',
];

/**
 * COMPOSING a URL against an eBay host.
 *
 * The shape that matters is a template or a concatenation producing an
 * `ebay.` address, or a mutation of an existing one's parameters. Requesting an
 * API endpoint is not that — `browse.ts` legitimately builds
 * `https://api.ebay.com/buy/browse/...` — so the detectors are written against
 * the ITEM-page hosts and against parameter surgery, which is what the
 * prohibition is actually about.
 */
const LINK_COMPOSITION = [
  {
    name: 'a composed eBay item-page URL',
    pattern: /['"`]https?:\/\/(www\.)?ebay\.[a-z.]+\/itm/i,
  },
  {
    name: 'an EPN campaign parameter written by Mercaria',
    pattern: /(campid|mkcid|mkrid|toolid|customid|mkevt)\s*[=:]/i,
  },
  {
    name: 'surgery on a destination URLs parameters',
    pattern: /searchParams\.(set|append|delete)\s*\(\s*['"`](campid|mkcid|customid|mkevt)/i,
  },
] as const;

/** #55's relationship layer, #83's claiming and #84's native-store linkage. */
const GRANT_REFERENCE =
  /relationship\.service|relationshipRepository|commerce_relationships|nativeStoreLink|native_store_links|merchant-claims|merchantClaims/;

/** #74's ranking. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\//;

/** #37's outbound redirect. This domain models routing metadata and never routes. */
const REDIRECT_REFERENCE = /outboundRedirect|redirect\.service|buildAffiliateUrl|services\/outbound\//;

/** #116/#121's retail domain. An ingested offer must not make Mercaria the seller. */
const RETAIL_REFERENCE = /retail-eligibility|retail-pricing|retailEligibility|retailPricing|mercaria_retail/;

/** Persisting a bearer token. There is no column that could hold one and no code that tries. */
const TOKEN_PERSISTENCE =
  /insert\([a-zA-Z]*[Tt]oken|accessToken:\s*(sql|text\(\))|\.set\(\{[^}]*accessToken/;

function readDomainFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must FAIL here rather than pass
  // the scan by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip comments before a reachability test.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — "never hand-construct an EPN link", "#74 owns ranking" — so a
 * scan over raw source would fail on the prose that exists to explain the
 * boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('Mercaria never composes or mutates an EPN link (#64 §6 rule 3)', () => {
  it('reaches for no eBay item-page URL and no campaign parameter', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      for (const { name, pattern } of LINK_COMPOSITION) {
        expect(pattern.test(source), `${relative} contains ${name}`).toBe(false);
      }
    }
    // The enumeration floor: a domain that shrank to nothing would pass.
    expect(EBAY_DOMAIN_PATHS.length).toBeGreaterThanOrEqual(18);
  });

  it('the link detectors actually detect — the mutation self-test', () => {
    const positives = [
      "const url = `https://www.ebay.es/itm/${itemId}`;",
      "const tracked = `${base}?campid=${campaignId}`;",
      "parsed.searchParams.set('campid', campaignId);",
    ];
    positives.forEach((line, index) => {
      const detector = LINK_COMPOSITION[index];
      expect(detector, `no detector at index ${index}`).toBeDefined();
      expect(detector?.pattern.test(line), `detector ${index} missed its own positive`).toBe(true);
    });
    // And an ordinary line in this domain trips none of them.
    const ordinary = "const url = `https://${EBAY_API_HOST[env]}${EBAY_BROWSE_SEARCH_PATH}?${params}`;";
    for (const { name, pattern } of LINK_COMPOSITION) {
      expect(pattern.test(ordinary), `${name} detector fires on an ordinary API URL`).toBe(false);
    }
  });

  it('keeps the destination kinds and the forbidden operations DISJOINT', () => {
    const destinations = new Set<string>(EBAY_OUTBOUND_DESTINATION_KINDS);
    const overlap = EBAY_FORBIDDEN_LINK_OPERATIONS.filter((entry) => destinations.has(entry));
    expect(overlap).toEqual([]);
    expect(EBAY_OUTBOUND_DESTINATION_KINDS.length).toBeGreaterThanOrEqual(2);
    expect(EBAY_FORBIDDEN_LINK_OPERATIONS.length).toBeGreaterThanOrEqual(6);
  });
});

describe('no access token is ever written down', () => {
  it('persists no token in any module of the domain', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(TOKEN_PERSISTENCE.test(source), `${relative} persists an access token`).toBe(false);
    }
  });

  it('the token-persistence detector actually detects', () => {
    expect(TOKEN_PERSISTENCE.test('await db.insert(ebayTokens).values({ value })')).toBe(true);
    expect(TOKEN_PERSISTENCE.test('accessToken: text()')).toBe(true);
    // The real token cache, which is a `Map`, trips nothing.
    expect(TOKEN_PERSISTENCE.test('cache.set(key, entry);')).toBe(false);
  });
});

describe('an eBay ingestion grants nothing and ranks nothing', () => {
  it('reaches no relationship, claim, native-store link, ranking, redirect or retail module', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(GRANT_REFERENCE.test(source), `${relative} reaches a grant`).toBe(false);
      expect(RANKING_REFERENCE.test(source), `${relative} reaches ranking`).toBe(false);
      expect(REDIRECT_REFERENCE.test(source), `${relative} reaches the redirect`).toBe(false);
      expect(RETAIL_REFERENCE.test(source), `${relative} reaches the retail domain`).toBe(false);
    }
  });

  it('the grant, ranking, redirect and retail detectors actually detect', () => {
    expect(
      GRANT_REFERENCE.test("import { assertRelationship } from '../commerce-graph/relationship.service.js';"),
    ).toBe(true);
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(REDIRECT_REFERENCE.test("import { buildAffiliateUrl } from '../outbound/x.js';")).toBe(
      true,
    );
    expect(RETAIL_REFERENCE.test("import { getRetailEligibility } from '../retail-eligibility/x.js';")).toBe(
      true,
    );
    const ordinary = "const offer = await recordExternalOffer(observation, now);";
    expect(GRANT_REFERENCE.test(ordinary)).toBe(false);
    expect(RANKING_REFERENCE.test(ordinary)).toBe(false);
  });
});

describe('the adapter directory holds only adapters that reach nothing', () => {
  const adaptersDir = join(SRC_ROOT, 'services/ingestion/adapters');

  it('has an eBay adapter and it reaches no repository, database or commerce service', () => {
    const files = readdirSync(adaptersDir)
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => statSync(join(adaptersDir, entry)).isFile());
    // The enumeration floor, read off the real directory.
    expect(files).toContain('ebay.ts');
    expect(files.length).toBeGreaterThanOrEqual(2);

    const source = readFileSync(join(adaptersDir, 'ebay.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(200);
    const stripped = withoutComments(source);
    // #62's own five, restated so a change to this adapter is caught by ITS
    // suite rather than only by the framework's.
    expect(/db\/[a-zA-Z-]+\/[a-zA-Z]+Repository/.test(stripped)).toBe(false);
    expect(/db\/postgres|getDb\(|drizzle-orm/.test(stripped)).toBe(false);
    expect(/offers\/offer\.service|offerRepository|recordExternalOffer/.test(stripped)).toBe(false);
    expect(/matching\/match\.service|runMatch/.test(stripped)).toBe(false);
    // And the eBay-specific one: an adapter must not reach its own composition
    // root, which is where the ports are bound to real repositories.
    expect(/ebay\/register\.js/.test(stripped)).toBe(false);
  });
});
