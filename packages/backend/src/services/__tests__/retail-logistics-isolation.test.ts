/**
 * #126 acceptance criterion 2, asserted by SCAN and by a walk of the real
 * drizzle tables: **Mercaria contains no carrier adapter, tracking poller or
 * carrier-state mapping for this flow.**
 *
 * A behavioural test can only ever say "it did not this time". The argument,
 * the vacuity floor and the mutation self-test are
 * `retail-checkout-isolation.test.ts`'s and `fee-ranking-isolation.test.ts`'s,
 * reused deliberately rather than reinvented — a second scanner shape would be
 * a second thing to keep correct.
 *
 * Seven walls, and the reason each is a scan rather than a branch:
 *
 *  1. **No carrier client.** A `dhl.ts` or an `easypost.ts` under this domain
 *     is the whole of what acceptance 2 forbids, and it would arrive as a
 *     helpful shortcut while #159 was still open.
 *  2. **No outbound HTTP at all.** Every Moovo call goes through
 *     `moovo.port.ts`; a `fetch` here is either a carrier call or a Moovo call
 *     that skipped the port, and both are the same defect.
 *  3. **No tracking poller.** A scheduled loop asking anybody where a parcel is
 *     is Moovo's job (its ownership item 8). A timer in this domain is how one
 *     starts.
 *  4. **No carrier-state mapping.** Moovo owns *versioned carrier status
 *     normalization*; a second normalization in Mercaria disagrees with the
 *     first in the direction nobody notices.
 *  5. **No carrier, package, label or scan COLUMN**, walked over the real
 *     tables rather than grepped — a column is the durable half of the same
 *     mistake. This one is an ALLOW-LIST
 *     (`retail-fulfilment-column-allowlist.ts`): every column is enumerated
 *     with a reason and anything else fails the build, because the deny-list it
 *     replaced could be fooled by any name it had not anticipated —
 *     `tracking_number` matched none of its eleven tokens — and two of those
 *     tokens could not fire at all, having been matched against TypeScript
 *     property names (#354).
 *  6. **No guest portal credential and no Mercaria service credential** reach
 *     this domain (#126 privacy 3 and 4).
 *  7. **No payment-domain import.** ADR 0004 D1's separation: a supplier's
 *     dispatch is not payment truth, and a transport booking must not be able
 *     to reach a charge.
 *
 * Plus the two disjointness properties the vocabularies rest on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowListedColumnCount,
  auditColumns,
  columnProhibition,
  prohibitionProbeColumn,
  schemaTableColumns,
} from '../../db/__tests__/column-allowlist.js';
import type { TableColumns } from '../../db/__tests__/column-allowlist.js';
import {
  RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
  RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
  RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
} from './retail-fulfilment-column-allowlist.js';
import {
  RETAIL_DELIVERY_PROMISE_KINDS,
  RETAIL_FULFILMENT_FORBIDDEN_FACTS,
  RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES,
  RETAIL_FULFILMENT_INTENT_STATUSES,
  RETAIL_FULFILMENT_MODES,
  MOOVO_TRANSPORT_PROJECTION_STATES,
} from '@mercaria/shared-types';
import * as retailFulfilmentSchema from '../../db/schema/retailFulfilment.js';

import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every module in the domain, DISCOVERED rather than listed.
 *
 * `ingestion-isolation.test.ts` scans the `adapters/` directory for the same
 * reason: a hard-coded list protects the files somebody remembered, and the
 * file that breaks a wall is by definition the one nobody was thinking about.
 * Tests are excluded — this very file names the forbidden vocabulary.
 */
function domainModules(): string[] {
  return walkOwnedDirectory('services/retail-fulfilment').map((relative) =>
    join(SRC_ROOT, relative),
  );
}

/** Anything whose PATH names this domain. */
const DOMAIN_NAMED = /retail-fulfilment|retailFulfilment/i;

/** The owned directories, plus the shared ones a module lives in under a domain NAME. */
const OWNED_DIRECTORIES = ['services/retail-fulfilment', 'db/retailFulfilment'] as const;
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every module of the domain, DERIVED as a function of its reader (#460).
 *
 * This replaces `domainModules()` plus two HAND-NAMED paths — the repository and
 * `db/schema/retailFulfilment.ts`. That pair was complete, which is the point: a
 * hand list of two is complete on the day it is written and silently short the
 * day somebody adds a third, and nothing in this file could tell the
 * difference. The population does not move; what moves is whether it can fall
 * behind.
 */
function fulfilmentPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAMED, readDir),
  ];
}

/** The population, as absolute paths, for the readers below. */
function scannedPaths(): string[] {
  return fulfilmentPopulation().map((relative) => join(SRC_ROOT, relative));
}

/** Source with comments removed — what every REACHABILITY detector scans. */
function readCode(path: string): string {
  const source = readFileSync(path, 'utf8');
  expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${path} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

/**
 * A carrier's own client, by import or by identifier.
 *
 * Named carriers plus the label aggregators, because the realistic shortcut is
 * not writing a DHL client from scratch — it is adding `easypost` to
 * `package.json` and a twenty-line wrapper.
 */
const CARRIER_CLIENT_REFERENCE =
  /from\s+['"][^'"]*(dhl|fedex|\bups\b|usps|correos|seur|\bgls\b|\bdpd\b|royalmail|shippo|easypost|aftership|shipengine)[^'"]*['"]|\b(dhlClient|fedexClient|upsClient|easyPostClient|shippoClient|aftershipClient)\b/i;

/** Any outbound HTTP. Everything Moovo goes through the port. */
const OUTBOUND_HTTP_REFERENCE =
  /\bfetch\s*\(|\bsafeFetch\b|from\s+['"](axios|undici|node-fetch|got|node:http|node:https)['"]/;

/** A scheduled loop. A poller in this domain is how a tracking poller starts. */
const SCHEDULER_REFERENCE = /\bsetInterval\s*\(|\bsetTimeout\s*\(|\bstart[A-Za-z]*Dispatcher\b/;

/** A second normalization of a carrier's own status strings. */
const CARRIER_STATE_MAPPING_REFERENCE =
  /CARRIER_STATUS|CARRIER_STATE|carrierStatusMap|mapCarrierStatus|normali[sz]eCarrierStatus|toCarrierState/;

/** #126 privacy 3 and 4. */
const CREDENTIAL_REFERENCE =
  /guestPortalGrant|guest_portal_grants|resolveGuestPortalSubject|\bmgp_|\bmgx_|configureServiceAuth|OXY_SERVICE_KEY|serviceCredential/;

/**
 * ADR 0004 D1: this domain never reaches the money.
 *
 * `\.\./payments/` is the alternative that matters and it was missing. A sibling
 * domain is one `../` away, so the import somebody here would actually write is
 * `from '../payments/payment.service.js'` — which the absolute-looking
 * `services/payments/` form never sees. One alternative covers every depth,
 * because however many `../` segments precede it the LAST one always abuts the
 * directory name: `../payments/`, `../../payments/` and `../../../payments/` all
 * contain the literal `../payments/`.
 *
 * This is live rather than hypothetical — 22 modules under `services/` already
 * import a sibling this way.
 */
const PAYMENT_DOMAIN_REFERENCE = /services\/payments\/|\.\.\/payments\/|db\/payments\/|\bstripe\b/i;

describe('#460 — the population is closed against the tree', () => {
  it('no fulfilment-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion, through the shared derivation so the
    // positive control re-derives THIS population against the seeded reader —
    // an over-broad derivation then absorbs the plant and fires, which a
    // control built on a finished array cannot do.
    //
    // The population does NOT move: the repository and `db/schema/retailFulfilment.ts`
    // were already covered, by being NAMED. A hand list of two is complete on the
    // day it is written and silently short the day somebody adds a third, so the
    // proof here is the planted control rather than a number that grew.
    assertNothingOutsideDomainPopulation({
      population: fulfilmentPopulation,
      pattern: DOMAIN_NAMED,
      // Measured empty: every module in the tree naming this domain is a module
      // of it. One owned by somebody else goes here WITH its reason.
      notThisDomain: [],
      sweepFloor: 7,
      plantIn: 'lib',
      plantName: 'retail-fulfilment-cache.ts',
    });
  });
});

describe('#126 acceptance 2 — no carrier system inside Mercaria', () => {
  it('scans every module in the domain, and there are some', () => {
    // The vacuity floor. `expect([]).toEqual([])` on a broken traversal is
    // exactly what a passing scan looks like, so the count is asserted first
    // and a new module raises it deliberately.
    const paths = scannedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(9);
    expect(domainModules().some((path) => path.endsWith('moovo.port.ts'))).toBe(true);
  });

  it('contains no carrier client', () => {
    for (const path of scannedPaths()) {
      expect(CARRIER_CLIENT_REFERENCE.test(readCode(path)), `${path} reaches a carrier`).toBe(
        false,
      );
    }
  });

  it('makes no outbound HTTP call of its own', () => {
    for (const path of scannedPaths()) {
      expect(OUTBOUND_HTTP_REFERENCE.test(readCode(path)), `${path} calls out directly`).toBe(
        false,
      );
    }
  });

  it('schedules nothing', () => {
    for (const path of scannedPaths()) {
      expect(SCHEDULER_REFERENCE.test(readCode(path)), `${path} runs a loop`).toBe(false);
    }
  });

  it('maps no carrier status', () => {
    for (const path of scannedPaths()) {
      expect(
        CARRIER_STATE_MAPPING_REFERENCE.test(readCode(path)),
        `${path} normalizes a carrier status`,
      ).toBe(false);
    }
  });

  it('reaches no guest portal or service credential', () => {
    for (const path of scannedPaths()) {
      expect(CREDENTIAL_REFERENCE.test(readCode(path)), `${path} reaches a credential`).toBe(
        false,
      );
    }
  });

  it('reaches no payment module', () => {
    for (const path of scannedPaths()) {
      expect(PAYMENT_DOMAIN_REFERENCE.test(readCode(path)), `${path} reaches the money`).toBe(
        false,
      );
    }
  });

  it('mutation self-test: every detector fires on source that breaks its wall', () => {
    // Without this the six assertions above would pass identically against a
    // regex that matches nothing — the "check that cannot distinguish success
    // from failure" this repository refuses. Each probe is written in the shape
    // the real violation would take.
    expect(CARRIER_CLIENT_REFERENCE.test("import DHL from '@dhl/express-sdk';")).toBe(true);
    expect(CARRIER_CLIENT_REFERENCE.test('const client = new EasyPostClient(key);')).toBe(true);
    expect(OUTBOUND_HTTP_REFERENCE.test('const r = await fetch(url);')).toBe(true);
    expect(OUTBOUND_HTTP_REFERENCE.test("import axios from 'axios';")).toBe(true);
    expect(SCHEDULER_REFERENCE.test('const t = setInterval(pollTracking, 60_000);')).toBe(true);
    expect(
      CARRIER_STATE_MAPPING_REFERENCE.test("const CARRIER_STATUS = { NT: 'in_transit' };"),
    ).toBe(true);
    expect(CREDENTIAL_REFERENCE.test('const token = grant.mgp_token;')).toBe(true);
    // The relative specifier. This assertion read `.toBe(false)` until #454 —
    // the gate's own self-test recording the hole as intended behaviour, which
    // is what kept it green. It is the spelling a module in THIS directory
    // would actually write, since `services/payments` is one `../` away.
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../payments/payment.service.js';"),
    ).toBe(true);
    // And at depth, from a nested module.
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../../payments/stripe/client.js';"),
    ).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../../services/payments/payment.service.js';"),
    ).toBe(true);
    // The negative half: a sibling that merely SHARES a prefix is not the
    // payment domain, so the widening must not swallow it.
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../payments-ui/format.js';"),
    ).toBe(false);
  });
});

describe('#126 acceptance 2 — no carrier COLUMN in the schema', () => {
  /**
   * The four tables, traversed from the MODULE rather than listed, so a fifth
   * one is walked automatically. Names are SQL identifiers (`sqlColumnName`),
   * which is not cosmetic: this gate used to read `column.name`, the TypeScript
   * PROPERTY name, and was comparing `proof_of_delivery` and `service_code`
   * against `proofOfDelivery` and `serviceCode` — two of its eleven tokens
   * could never fire (#354).
   */
  function retailTables(): readonly TableColumns[] {
    return schemaTableColumns(retailFulfilmentSchema as Record<string, unknown>);
  }

  it('every column of every table is ALLOW-LISTED, and nothing else may exist', () => {
    const tables = retailTables();
    // Three vacuity floors, because a traversal that found nothing, an
    // allow-list that listed nothing and a table that lost its columns all
    // produce a clean audit.
    expect(tables.length).toBe(4);
    expect(RETAIL_FULFILMENT_COLUMN_ALLOWLIST.length).toBe(4);
    expect(allowListedColumnCount(RETAIL_FULFILMENT_COLUMN_ALLOWLIST)).toBeGreaterThanOrEqual(40);
    for (const { table, columns } of tables) {
      expect(columns.length, `${table} has no columns — did the traversal break?`).toBeGreaterThan(
        3,
      );
      for (const column of columns) {
        // The traversal yields SQL identifiers or the gate is measuring the
        // wrong string. A camelCase name here IS the #354 defect returning.
        expect(column, `${table}.${column} is not a SQL identifier`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }

    const audit = auditColumns(
      tables,
      RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
      RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
      RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
    );
    // The deny layer is asserted FIRST, because vitest stops at the first
    // failing assertion and this is the message worth reading: it names the
    // PROHIBITION a column falls under, where `unlisted` says only that nobody
    // has decided about it.
    expect(audit.forbidden).toEqual([]);
    // A NEW COLUMN FAILS THE BUILD UNTIL SOMEBODY DECIDES IT IS ALLOWED. That
    // is the inversion: the previous gate refused eleven tokens somebody had
    // thought of and admitted everything else, so `tracking_number`,
    // `shipment_id`, `courier_reference` and `checkpoint_at` would every one
    // have passed. The fix is to add it to the allow-list under a group whose
    // REASON covers it — never to widen a sentence that does not describe it.
    expect(audit.unlistedTables).toEqual([]);
    expect(audit.unlisted).toEqual([]);
    // And the reverse, so the list cannot rot into a standing permission for a
    // column that moved or was dropped.
    expect(audit.missingTables).toEqual([]);
    expect(audit.missing).toEqual([]);
  });

  it('every allow-listed group states a reason, and no column is listed twice', () => {
    const seen = new Set<string>();
    for (const allowance of RETAIL_FULFILMENT_COLUMN_ALLOWLIST) {
      expect(allowance.groups.length, `${allowance.table} has no groups`).toBeGreaterThan(0);
      for (const group of allowance.groups) {
        // A reason long enough to be a reason. A blank one is what a hurried
        // addition produces.
        expect(group.reason.length, `${allowance.table} has a group with no reason`).toBeGreaterThan(
          30,
        );
        expect(group.columns.length, `${allowance.table} has an empty group`).toBeGreaterThan(0);
        for (const column of group.columns) {
          const qualified = `${allowance.table}.${column}`;
          expect(seen.has(qualified), `${qualified} is listed twice`).toBe(false);
          seen.add(qualified);
        }
      }
    }
  });

  it('EVERY prohibition can fire, through the real audit — the liveness self-test', () => {
    // The question #354 exists for: what would this check report if the thing
    // it measures were absent? A self-test that calls a matcher with a
    // hand-written literal proves the matcher works on data the scan never
    // receives, which is exactly how two dead tokens survived here.
    //
    // So each prohibition is rebuilt into the column name it exists to refuse
    // and injected into a REAL table, and the assertion is made on the audit
    // production runs. Exhaustive by construction: a token added later is
    // proven the moment it is added, rather than when somebody remembers to
    // write it a probe.
    expect(RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS.length).toBeGreaterThanOrEqual(15);
    for (const entry of RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS) {
      const probe = prohibitionProbeColumn(entry);
      const mutated = retailTables().map((table) =>
        table.table === 'retail_fulfilment_intents'
          ? { ...table, columns: [...table.columns, probe] }
          : table,
      );
      const audit = auditColumns(
        mutated,
        RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
        RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
        RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
      );
      expect(
        audit.forbidden.map((offence) => offence.column),
        `the prohibition on ${entry.prohibition} cannot fire`,
      ).toContain(`retail_fulfilment_intents.${probe}`);
    }
  });

  it('no prohibition is REDUNDANT — an entry another already covers is not protection', () => {
    // The other half of "what would this report if the thing it measures were
    // absent". A live-looking entry some earlier one already catches can never
    // be the reason anything is refused, so removing it changes nothing — and
    // it reads to the next person as a decision somebody made.
    for (const entry of RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS) {
      const others = RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS.filter(
        (candidate) => candidate !== entry,
      );
      expect(
        columnProhibition(`t.${prohibitionProbeColumn(entry)}`, others),
        `the prohibition on ${entry.prohibition} is already covered by another`,
      ).toBeNull();
    }
  });

  it('fires on the realistic names, INCLUDING the two the old gate could not see', () => {
    assertEachOf([
      // The two that were inert: matched against `proofOfDelivery` and
      // `serviceCode`, they could not fire however the schema grew.
      'proof_of_delivery_at',
      'carrier_service_code',
      // The ones the old regex did catch, kept so the rewrite is not a
      // silent narrowing.
      'carrier_account_id',
      'package_weight_grams',
      'shipping_label_url',
      'last_scan_status',
      'tracking_poll_cursor',
      // And the ones it admitted outright, which is the deny-list's own
      // incompleteness rather than the casing bug.
      'tracking_number',
      'shipment_id',
      'courier_reference',
      'waybill_id',
      'checkpoint_at',
    ], 12, (probe) => {
      const mutated = retailTables().map((table) =>
        table.table === 'retail_delivery_promises'
          ? { ...table, columns: [...table.columns, probe] }
          : table,
      );
      const audit = auditColumns(
        mutated,
        RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
        RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
        RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
      );
      expect(
        audit.forbidden.map((offence) => offence.column),
        `${probe} should be refused by name`,
      ).toContain(`retail_delivery_promises.${probe}`);
    });
  });

  it('fires on an INNOCUOUS unlisted column too — which is the whole inversion', () => {
    // A name no prohibition carries and no group lists. The deny-list says
    // nothing about it; the allow-list is what stops it.
    const mutated = retailTables().map((table) =>
      table.table === 'retail_fulfilment_line_allocations'
        ? { ...table, columns: [...table.columns, 'internal_note'] }
        : table,
    );
    const audit = auditColumns(
      mutated,
      RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
      RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
      RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
    );
    expect(audit.forbidden).toEqual([]);
    expect(audit.unlisted).toContain('retail_fulfilment_line_allocations.internal_note');

    // A whole new table is refused the same way.
    const withNewTable = auditColumns(
      [...retailTables(), { table: 'retail_carrier_bookings', columns: ['id'] }],
      RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
      RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
      RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
    );
    expect(withNewTable.unlistedTables).toContain('retail_carrier_bookings');
  });

  it('fires on an allow-list entry with no column behind it', () => {
    const audit = auditColumns(
      retailTables(),
      [
        ...RETAIL_FULFILMENT_COLUMN_ALLOWLIST,
        {
          table: 'retail_delivery_promises',
          groups: [{ reason: 'x'.repeat(40), columns: ['carrier_scan_at'] }],
        },
      ],
      RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
      RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
    );
    // Named on the allow-list, absent from the schema — and the deny layer sees
    // it anyway, which is what stops a forbidden name being admitted by being
    // written down.
    expect(audit.missing).toContain('retail_delivery_promises.carrier_scan_at');
    expect(audit.forbidden.map((offence) => offence.column)).toContain(
      'retail_delivery_promises.carrier_scan_at',
    );
  });

  it('permits the seam columns that must survive', () => {
    // The mirror of the liveness test: a prohibition that refused these would
    // ban the Moovo seam this domain is built around.
    assertEachOf([
      'moovo_transport_request_id',
      'moovo_source_reference',
      'moovo_transport_registered_at',
      'fulfilment_mode',
      'permitted_fulfilment_mode',
    ], 5, (probe) => {
      expect(
        columnProhibition(
          `retail_fulfilment_intents.${probe}`,
          RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS,
          RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS,
        ),
        `${probe} must be permitted`,
      ).toBeNull();
    });
  });

  it('the exemption list is EXACTLY empty', () => {
    // A ceiling rather than an exact count is the gate switching itself off one
    // defensible line at a time. Nothing in these four tables needs one.
    expect(RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS.length).toBe(0);
  });
});

describe('the vocabularies are disjoint from their prohibitions', () => {
  it('no fulfilment-intent status asserts a physical fact', () => {
    const overlap = RETAIL_FULFILMENT_INTENT_STATUSES.filter((status) =>
      (RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES as readonly string[]).includes(status),
    );
    expect(overlap).toEqual([]);
    expect(RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES.length).toBeGreaterThanOrEqual(8);
  });

  it('no recorded vocabulary names a forbidden carrier fact', () => {
    // The union of everything this domain can record, against the ten things it
    // may never record. Moovo's own projection states are included on the
    // recorded side deliberately: they are the words a BUYER uses, handed over
    // already normalized, and the test is what keeps that claim honest.
    const recorded: readonly string[] = [
      ...RETAIL_FULFILMENT_INTENT_STATUSES,
      ...RETAIL_FULFILMENT_MODES,
      ...RETAIL_DELIVERY_PROMISE_KINDS,
      ...MOOVO_TRANSPORT_PROJECTION_STATES,
    ];
    const overlap = RETAIL_FULFILMENT_FORBIDDEN_FACTS.filter((fact) => recorded.includes(fact));
    expect(overlap).toEqual([]);
    expect(RETAIL_FULFILMENT_FORBIDDEN_FACTS.length).toBeGreaterThanOrEqual(10);
    expect(recorded.length).toBeGreaterThanOrEqual(20);
  });
});
