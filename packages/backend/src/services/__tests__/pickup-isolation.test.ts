/**
 * The five walls #93 asks for, asserted STRUCTURALLY rather than promised.
 *
 * 1. **The collection desk moves no money and no stock** (#93 acceptance 14).
 *    No module in the domain can reach the inventory service, the refund
 *    service, the payment domain or the order writer — which is what makes
 *    "collection cannot commit inventory twice" true of code nobody has written
 *    yet. The units were committed when the order was PAID; a collection that
 *    touched them would be committing them again.
 * 2. **No rollout lever gates a durable record** (#93 operations rule 10). The
 *    collection path, the credential, the trail and the buyer's own read do not
 *    read `config.pickup` — so pausing guest pickup preserves every existing
 *    collection, portal, cancellation and refund flow.
 * 3. **A shopper's precise coordinate never reaches analytics** (#93 privacy
 *    rules 5 and 6). No module in the domain emits an analytics event at all,
 *    and #77's schema has no column one could go in.
 * 4. **The domain makes no outbound call, and GoWay has one door** (ADR 0013).
 *    No module here calls `fetch`, a geocoder or `@goway.to/sdk`: where a
 *    location is comes from the GoWay place it names, read ONLY through
 *    `services/goway` — the one directory in the backend that imports the SDK.
 * 5. **A P2P seller's precise position is unrepresentable** (#93 P2P rule 5).
 *    `listing_local_discovery` has no coordinate column, checked by walking the
 *    REAL drizzle table rather than by reading the file.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails instead of silently shrinking the scan, and a
 * mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  listingLocalDiscovery,
  orderPickups,
  pickupCollectionEvents,
} from '../../db/schema/pickup.js';
import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Anything whose PATH names this domain. */
const DOMAIN_NAMED = /pickup/i;

/** The two directories the domain owns outright. */
const PICKUP_OWNED_DIRECTORIES = ['services/pickup', 'db/pickup'] as const;

/**
 * The shared flat directories a pickup module lives in under a domain NAME.
 *
 * This gate had NONE — it read `services/pickup` and `db/pickup` with a
 * one-level `readdirSync` and nothing else — so the domain's whole HTTP
 * surface, both request-schema modules and its schema module sat behind none of
 * the five walls below. 15 modules of 22.
 */
const PICKUP_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every module of the pickup domain, DERIVED — as a function of its reader, so
 * the positive control in `assertNothingOutsideDomainPopulation` measures this
 * derivation rather than a re-spelling of it.
 */
function pickupPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...PICKUP_OWNED_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory, readDir)),
    ...namedInSharedDirectories(PICKUP_SHARED_DIRECTORIES, DOMAIN_NAMED, readDir),
  ];
}

/** Every module of the pickup domain, with its source. */
function domainSources(): { relative: string; source: string }[] {
  return pickupPopulation().map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Strip comments before a reachability scan.
 *
 * These modules DOCUMENT what they refuse to do, in the same vocabulary the
 * detectors look for — `collection.service.ts` says "moves NO money and NO
 * stock" and names the refund service in as many words. Scanning raw source
 * would make the gate fire on its own explanation, and the fix somebody would
 * reach for is to delete the explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Reaching stock, money or the order writer, from any direction. */
const COMMERCE_WRITE_REFERENCE =
  /from\s+'[^']*(inventory\.service|refund\.service|order\.service|services\/payments)[^']*'|\b(reserve|commit|release|restock|setAvailable)\s*\(|processRefund\s*\(|insertOrder\s*\(|applyPaymentStatus\s*\(|transition\s*\(/;

/** Reading a rollout lever. */
const PICKUP_LEVER_REFERENCE = /config\.pickup\b|config\.guest\.checkoutRollout\b/;

/** Emitting an analytics event, from any direction. */
const ANALYTICS_REFERENCE =
  /from\s+'[^']*analytics[^']*'|emitAnalyticsEvent\s*\(|recordAnalyticsEvent\s*\(/;

/**
 * An outbound call, of any shape a geocoding client would take.
 *
 * The geocoding half looks for an IMPORT of such a module or a CALL to one, and
 * deliberately NOT for the word `geocode` — this domain legitimately READS a
 * `geocoded` boolean and a `geocodeProvenance` off a row on nearly every path,
 * and a detector that fired on those would be one whoever hit it next disabled.
 * That false positive was measured while writing this gate, which is why it is
 * narrowed here rather than after somebody else met it.
 */
const OUTBOUND_CALL_REFERENCE =
  /\bfetch\s*\(|safeFetch\s*\(|from\s+'[^']*(axios|undici|node:https|node-fetch|geocod|nominatim|mapbox|google-maps|@goway\.to\/sdk)[^']*'|\bgeocod\w*\s*\(/i;

/** Importing the GoWay SDK, in any spelling an import or a re-export takes. */
const GOWAY_SDK_IMPORT = /from\s+'@goway\.to\/sdk'|import\s*\(\s*'@goway\.to\/sdk'\s*\)/;

/** The one directory allowed to import the SDK. */
const GOWAY_ADAPTER_DIRECTORY = 'services/goway/';

/** Every non-test backend module, relative to `src/`. */
function backendModules(directory = ''): string[] {
  return readdirSync(join(SRC_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : backendModules(relative);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [relative] : [];
  });
}

/**
 * The modules that MAY read a lever — the entry points, and only them.
 *
 * `checkout-gate.ts` refuses a checkout the deployment has switched off,
 * `nearby.service.ts` annotates a browse with an actor verdict, and
 * `local-discovery.service.ts` answers an empty list for a surface that is off.
 * All three are ENTRY. Nothing that reads or writes a PLACED collection is on
 * this list, which is wall 2.
 */
const LEVER_ENTRY_POINTS = new Set([
  'services/pickup/checkout-gate.ts',
  'services/pickup/nearby.service.ts',
  'services/pickup/local-discovery.service.ts',
  'services/pickup/collection-code.ts',
  // The HTTP entry itself, brought into the population by #460 — it 404s
  // `nearbyP2pHandler` when `config.pickup.p2pLocalDiscoveryEnabled` is off,
  // which is the same job `local-discovery.service.ts` does one layer down and
  // is ENTRY by any reading. It is named here rather than the detector being
  // narrowed, because narrowing is the permissive direction: a detector
  // loosened for one legitimate reader admits the violation added beside it.
  'controllers/pickup.controller.ts',
]);

describe('the pickup domain has no reach it should not have', () => {
  const domain = domainSources();

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // Floors PER SHAPE rather than one on the total: the sources break
    // independently, and a single number lets one collapse to zero while the
    // others carry it.
    const from = (prefix: string) =>
      domain.filter((file) => file.relative.startsWith(prefix)).length;
    expect(from('services/pickup/'), 'the service walk found nothing').toBeGreaterThanOrEqual(10);
    expect(from('db/pickup/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(5);
    expect(from('controllers/'), 'no pickup controller was derived').toBeGreaterThanOrEqual(3);
    expect(from('middleware/'), 'no pickup middleware module was derived').toBeGreaterThanOrEqual(
      2,
    );
    expect(from('routes/'), 'no pickup route was derived').toBeGreaterThanOrEqual(1);
    expect(from('db/schema/'), 'the schema module left the population').toBeGreaterThanOrEqual(1);
    expect(domain.length).toBeGreaterThanOrEqual(22);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(
        200,
      );
    }
    // EXACT: an unbounded exemption set lets any number of readers ride in
    // behind the ones somebody justified (#448). This set had no count at all.
    expect(LEVER_ENTRY_POINTS.size, 'a sixth lever reader was exempted').toBe(5);
    for (const entry of LEVER_ENTRY_POINTS) {
      expect(
        domain.map((file) => file.relative),
        `${entry} may read a lever but is not in the domain`,
      ).toContain(entry);
    }
  });

  it('no pickup-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion, through the shared derivation so the
    // positive control measures THIS population rather than a re-spelling of
    // it: handed the seeded reader, an over-broad derivation absorbs the plant
    // and the control fires.
    //
    // This gate is the sharpest case in the flat directory. It read
    // `services/pickup` and `db/pickup` with a one-level `readdirSync` and no
    // shared directories at all, so the whole HTTP surface — including
    // `controllers/admin/pickup-admin.controller.ts`, which a recursion fix
    // alone would have been credited with catching — plus both schema-request
    // modules and `db/schema/pickup.ts` were behind none of the five walls.
    // 15 modules of 22.
    assertNothingOutsideDomainPopulation({
      population: pickupPopulation,
      pattern: DOMAIN_NAMED,
      // Measured empty: every pickup-named module in the tree is a module of
      // this domain. One owned by somebody else goes here WITH its reason.
      notThisDomain: [],
      expectedExclusions: 0,
      sweepFloor: 18,
      plantIn: 'lib',
      plantName: 'pickup-cache.ts',
    });
  });

  it('WALL 1: no module can reach inventory, refunds, payments or the order writer', () => {
    for (const file of domain) {
      expect(
        COMMERCE_WRITE_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches a stock or money writer; a collection is a handover, and the ` +
          'units were committed when the order was paid (#93 acceptance 14)',
      ).toBe(false);
    }
  });

  it('WALL 2: only the ENTRY points read a rollout lever', () => {
    for (const file of domain) {
      if (LEVER_ENTRY_POINTS.has(file.relative)) continue;
      expect(
        PICKUP_LEVER_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reads a rollout lever; pausing guest pickup must preserve every ` +
          'placed collection, its code, its trail and its refund path (#93 operations rule 10)',
      ).toBe(false);
    }
  });

  it('WALL 3: no module emits an analytics event', () => {
    for (const file of domain) {
      expect(
        ANALYTICS_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches analytics; a nearby request's coordinate must not leave it ` +
          '(#93 privacy rules 5 and 6)',
      ).toBe(false);
    }
  });

  it('WALL 4: no module makes an outbound call, so no provider is reachable but through GoWay', () => {
    for (const file of domain) {
      expect(
        OUTBOUND_CALL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} makes an outbound call; where a location is comes from its GoWay ` +
          'place, read through services/goway (ADR 0013)',
      ).toBe(false);
    }
  });

  it('WALL 4: services/goway is the ONE door to GoWay in the whole backend', () => {
    const importers = backendModules().filter((relative) =>
      GOWAY_SDK_IMPORT.test(withoutComments(readFileSync(join(SRC_ROOT, relative), 'utf8'))),
    );
    for (const relative of importers) {
      expect(
        relative.startsWith(GOWAY_ADAPTER_DIRECTORY),
        `${relative} imports @goway.to/sdk; feature code reads places through ${GOWAY_ADAPTER_DIRECTORY}`,
      ).toBe(true);
    }
    // Vacuity floor: the adapter's own client, reads and projection DO import
    // it, so a walk that found nothing is a broken walk rather than a pass.
    expect(importers.length).toBeGreaterThanOrEqual(3);
  });

  it('WALL 5: `listing_local_discovery` has no coordinate column at all', () => {
    // Walked from the REAL drizzle table rather than read out of the file, so
    // a column added in a migration and mirrored into the schema fails here.
    const columns = Object.keys(getTableColumns(listingLocalDiscovery));
    assertEachOf(
      ['latitude', 'longitude', 'lat', 'lon', 'geoPoint', 'point', 'address'],
      7,
      (forbidden) => {
        expect(columns, `listing_local_discovery must not carry ${forbidden}`).not.toContain(
          forbidden,
        );
      },
    );
    // …and the positive control: the cell it DOES carry is present, so a
    // renamed table cannot pass this by having no columns to check.
    expect(columns).toContain('cellLatIndex');
    expect(columns).toContain('cellLonIndex');
    expect(columns.length).toBeGreaterThanOrEqual(10);
  });

  it('the collection trail carries no buyer, and the order snapshot no person', () => {
    // #93 merchant rules 2 and 3: the desk sees what it needs to hand a parcel
    // over. The whole of what the trail says about a person is which member of
    // STAFF acted.
    const trail = Object.keys(getTableColumns(pickupCollectionEvents));
    assertEachOf(
      ['buyerOxyUserId', 'email', 'phone', 'guestSessionId', 'codeHash', 'code'],
      6,
      (forbidden) => {
        expect(trail, `pickup_collection_events must not carry ${forbidden}`).not.toContain(
          forbidden,
        );
      },
    );
    expect(trail).toContain('actorOxyUserId');

    const snapshot = Object.keys(getTableColumns(orderPickups));
    assertEachOf(
      ['buyerEmail', 'buyerPhone', 'recipientName', 'guestSessionId'],
      4,
      (forbidden) => {
        expect(snapshot, `order_pickups must not carry ${forbidden}`).not.toContain(forbidden);
      },
    );
    expect(snapshot.length).toBeGreaterThanOrEqual(20);
  });
});

/**
 * The mutation self-test.
 *
 * Every detector above is only worth having if it FIRES. A regex that has
 * rotted — a renamed module, a changed call shape — passes silently against
 * every file, which is exactly the shape `~/Oxy/AGENTS.md` calls "a check that
 * cannot distinguish success from failure". So each is run against a source
 * that genuinely contains what it forbids.
 */
describe('the detectors themselves', () => {
  it('WALL 1 fires on a stock write', () => {
    expect(
      COMMERCE_WRITE_REFERENCE.test("import { reserve } from '../inventory.service.js';"),
    ).toBe(true);
    expect(COMMERCE_WRITE_REFERENCE.test('await restock(variantId, 1, locationId);')).toBe(true);
    expect(COMMERCE_WRITE_REFERENCE.test("import { x } from '../payments/provider.js';")).toBe(
      false,
    );
    expect(
      COMMERCE_WRITE_REFERENCE.test("import { x } from '../services/payments/redact.js';"),
    ).toBe(true);
  });

  it('WALL 2 fires on a lever read', () => {
    expect(PICKUP_LEVER_REFERENCE.test('if (config.pickup.guestPickupEnabled) {')).toBe(true);
    expect(PICKUP_LEVER_REFERENCE.test('config.guest.checkoutRollout.blockedMarkets')).toBe(true);
    expect(PICKUP_LEVER_REFERENCE.test('config.orders.lowStockThreshold')).toBe(false);
  });

  it('WALL 3 fires on an analytics emission', () => {
    expect(ANALYTICS_REFERENCE.test('emitAnalyticsEvent(req, { eventType: "x" });')).toBe(true);
    expect(ANALYTICS_REFERENCE.test("import { x } from '../analytics/emit.js';")).toBe(true);
    expect(ANALYTICS_REFERENCE.test('const analytics = 1;')).toBe(false);
  });

  it('WALL 4 fires on an outbound call and on a geocoder by name', () => {
    expect(OUTBOUND_CALL_REFERENCE.test('const res = await fetch(url);')).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test('await safeFetch(url);')).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test('const point = await geocodeAddress(address);')).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test("import { x } from '@some/geocoder-sdk';")).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test("import { x } from '@mapbox/search';")).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test("import { createGoWayClient } from '@goway.to/sdk';")).toBe(
      true,
    );
    expect(OUTBOUND_CALL_REFERENCE.test("import { x } from '../geo.js';")).toBe(false);
    expect(OUTBOUND_CALL_REFERENCE.test("import { readPlace } from '../goway/places.js';")).toBe(
      false,
    );
    expect(OUTBOUND_CALL_REFERENCE.test('const distance = haversineMetres(a, b);')).toBe(false);
    expect(GOWAY_SDK_IMPORT.test("import type { Place } from '@goway.to/sdk';")).toBe(true);
    expect(GOWAY_SDK_IMPORT.test("import { x } from '@goway.to/sdk-extra';")).toBe(false);
  });

  it('the comment stripper removes a line comment and a block comment', () => {
    // Without it, every wall above would fire on the docblock that explains it.
    expect(withoutComments('// await fetch(x)\nconst a = 1;')).not.toContain('fetch');
    expect(withoutComments('/* reserve( */\nconst a = 1;')).not.toContain('reserve(');
    // …and does NOT eat a URL in a string, which would be a stripper that
    // silently blanks half the file it is meant to hand to a detector.
    expect(withoutComments("const u = 'https://example.test/x';")).toContain('example.test');
  });
});
