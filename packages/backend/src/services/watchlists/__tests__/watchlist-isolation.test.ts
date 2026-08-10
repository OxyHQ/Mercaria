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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Every module of the watchlist domain, enumerated from disk. */
function domainSources(): ScannedFile[] {
  const roots = [
    'services/watchlists',
    'db/watchlists',
    'controllers/watchlists.controller.ts',
    'routes/watchlists.ts',
    'middleware/watchlist-schemas.ts',
  ];
  const files: ScannedFile[] = [];
  for (const root of roots) {
    const full = join(SRC_ROOT, root);
    if (root.endsWith('.ts')) {
      files.push({ relative: root, source: readFileSync(full, 'utf8') });
      continue;
    }
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.ts')) continue;
      files.push({ relative: `${root}/${name}`, source: readFileSync(join(full, name), 'utf8') });
    }
  }
  return files;
}

/**
 * The storefront files that RENDER a basket.
 *
 * The storefront has no test runner of its own, so this file scans it — the
 * `seller-identity-isolation.test.ts` precedent, for its reason: the one file
 * that could make the mistake WALL 1 exists for is a screen, and a gate that
 * only looked at the server would pass while the page said the wrong thing.
 */
function storefrontSources(): ScannedFile[] {
  const paths = [
    'app/(app)/watchlists/index.tsx',
    'app/(app)/watchlists/[watchlistId].tsx',
    'components/watchlist/BasketTotalCard.tsx',
    'components/watchlist/WatchlistItemRow.tsx',
    'lib/hooks/use-watchlists.ts',
    'lib/api/watchlists.ts',
  ];
  return paths
    .filter((relative) => existsSync(join(STOREFRONT_ROOT, relative)))
    .map((relative) => ({
      relative: `frontend/${relative}`,
      source: readFileSync(join(STOREFRONT_ROOT, relative), 'utf8'),
    }));
}

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

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // The floor catches a renamed directory, which would otherwise make every
    // scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(11);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('is not vacuous about the STOREFRONT either, which is where the copy lives', () => {
    // `storefrontSources` filters by existence, so a renamed screen would
    // silently shrink WALL 1's scan to the server — where the sentence it
    // forbids was never going to be written. The floor is what makes that
    // failure loud, and it is the same defence the domain floor above provides
    // one package over.
    expect(
      storefront.length,
      'a watchlist screen moved; WALL 1 scans the storefront by PATH and cannot see it now',
    ).toBeGreaterThanOrEqual(6);
    for (const file of storefront) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('WALL 1: nothing claims a multi-store optimum, and the honest label IS present', () => {
    // RAW source, comments included: a forbidden claim written in a comment is
    // a sentence that reaches a screen the next time somebody writes copy.
    const scanned = [...domain, ...storefront];
    expect(scanned.length).toBeGreaterThanOrEqual(domain.length);
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
    expect(WATCHLIST_INDEPENDENT_MINIMA_LABEL).toContain('independent');
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
