/**
 * The walls that make #1016's boundaries hold (ADR 0011).
 *
 * ## What this file guards, and why each wall is here rather than in review
 *
 * Authorized digital retail stores the first third-party BEARER SECRETS this
 * repository has ever held, and it buys them with real money at the moment a
 * customer pays. Five things would be cheap, plausible additions and each would
 * undo a decision the ADR paid for:
 *
 *  1. a plaintext column beside the sealed one, "just for support";
 *  2. a URL to an artifact, "just for the email";
 *  3. an IP or device column on the reveal audit, "just for fraud";
 *  4. a gift-card product class, "just to try it";
 *  5. a supplier cost on something the storefront reads.
 *
 * None of them would fail a typecheck, a lint or any existing test. Each fails
 * here.
 *
 * ## The population is DERIVED and FLOORED
 *
 * An absence scan over an empty population reports a clean result for a reason
 * that has nothing to do with the wall, so the table count, the column count and
 * the module count are all floored independently before anything is asserted to
 * be missing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import {
  AMBIGUOUS_PROCUREMENT_ERROR_KINDS,
  DIGITAL_FULFILMENT_CAPABILITIES,
  DIGITAL_PROCUREMENT_ERROR_KINDS,
  DIGITAL_PURCHASE_ORDER_LIVE_STATUSES,
  DIGITAL_PURCHASE_ORDER_STATUSES,
  DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES,
  DIGITAL_PURCHASE_ORDER_TRANSITIONS,
  DIGITAL_RETAIL_PRODUCT_CLASSES,
  DIGITAL_SUPPLIER_API_CAPABILITIES,
  DIGITAL_SUPPLY_PROVENANCES,
  DIGITAL_SUPPLY_PROVENANCE_STRENGTH,
  EXCLUDED_COMMERCE_TYPES,
  REQUIRED_PROCUREMENT_CAPABILITIES,
  SECRET_BEARING_FULFILMENT_CAPABILITIES,
  digitalPurchaseOrderTransitionAllowed,
  isAmbiguousProcurementError,
} from '@mercaria/shared-types';
import * as digitalRetailSchema from '../db/schema/digitalRetail';
import { PROTECTED_COLUMNS } from '../db/protectedColumns';
import { PACKAGES_ROOT, SRC_ROOT, walkOwnedDirectory } from './domain-population';

/** Every table of the digital-retail schema module, by SQL name. */
const TABLES: readonly PgTable[] = Object.values(digitalRetailSchema).flatMap((value) =>
  is(value, PgTable) ? [value] : [],
);

const columns = (): { table: string; column: string }[] =>
  TABLES.flatMap((table) =>
    getTableConfig(table).columns.map((column) => ({
      table: getTableName(table),
      column: sqlColumnName(column),
    })),
  );

describe('the population these walls are measured over', () => {
  it('finds all ten tables, so every absence below means something', () => {
    expect(TABLES).toHaveLength(10);
    expect(new Set(TABLES.map(getTableName))).toEqual(
      new Set([
        'digital_supply_terms',
        'digital_supplier_capabilities',
        'digital_procurement_offers',
        'digital_retail_pricing_policies',
        'digital_purchase_orders',
        'digital_purchase_order_attempts',
        'digital_fulfilments',
        'digital_fulfilment_artifacts',
        'digital_fulfilment_reveals',
        'digital_fulfilment_incidents',
      ]),
    );
    expect(columns().length).toBeGreaterThan(120);
  });
});

describe('wall 1 — the plaintext has no column', () => {
  it('carries no column that could hold an unsealed artifact', () => {
    // The cheap repair for "support needs to see the key" is a second column
    // beside the sealed one, and it would look like a convenience. There is one
    // way to reach a secret and it is an audited reveal.
    //
    // `plaintext_sha256` is named EXACTLY, not excused by a pattern: it is the
    // irreversible digest support matches a customer's key against, it is
    // registered PROTECTED, and naming it here means a `plaintext_value` added
    // tomorrow still fails.
    const allowed = new Set(['digital_fulfilment_artifacts.plaintext_sha256']);
    const offenders = columns()
      .filter(({ column }) => /(^|_)(plaintext|plain|clear|unsealed|raw)(_|$)/.test(column))
      .map(({ table, column }) => `${table}.${column}`)
      .filter((name) => !allowed.has(name));
    expect(offenders).toEqual([]);
    // The exemption is asserted to still be NEEDED, so it cannot outlive its column.
    expect(columns().map(({ table, column }) => `${table}.${column}`)).toContain(
      'digital_fulfilment_artifacts.plaintext_sha256',
    );
  });

  it('registers every sealed column as PROTECTED, so a whole-row read cannot ship one', () => {
    expect(PROTECTED_COLUMNS.digital_fulfilment_artifacts).toEqual([
      'sealedSecret',
      'keyReference',
      'plaintextSha256',
    ]);
  });

  it('keeps the hint OUT of the registry, deliberately', () => {
    // Four characters cannot reconstruct a key, support renders it by default,
    // and protecting it would push every "is this the key we sold you" enquiry
    // through a real reveal.
    expect(PROTECTED_COLUMNS.digital_fulfilment_artifacts).not.toContain('maskedHint');
  });
});

describe('wall 2 — a URL is never the artifact', () => {
  it('carries NO url-shaped column anywhere in the domain', () => {
    const offenders = columns().filter(({ column }) =>
      /(^|_)(url|uri|href|link|public_path|cdn_path)(_|$)/.test(column),
    );
    expect(offenders.map(({ table, column }) => `${table}.${column}`)).toEqual([]);
  });
});

describe('wall 3 — the reveal audit is not a tracker', () => {
  it('carries no IP, device, session or user-agent column', () => {
    // `~/AGENTS.md`'s no-IP invariant, with no exception, and the epic's W11
    // requirement 5: record that a reveal happened, never who the browser was.
    const reveals = TABLES.find((table) => getTableName(table) === 'digital_fulfilment_reveals');
    expect(reveals).toBeDefined();
    const names = getTableConfig(reveals!).columns.map((column) => sqlColumnName(column));
    expect(names.length).toBeGreaterThan(5);
    const offenders = names.filter((name) =>
      /(^|_)(ip|ip_address|user_agent|device|fingerprint|session|geo|country)(_|$)/.test(name),
    );
    expect(offenders).toEqual([]);
  });
});

describe('wall 4 — stored value stays unrepresentable', () => {
  it('mints NO product class for a gift card, a voucher or a top-up', () => {
    // ADR 0011 D16 amends only HALF of ADR 0010 D16. A CHECK rendered from this
    // tuple is what makes one a failed write rather than a flag somebody flips.
    const offenders = DIGITAL_RETAIL_PRODUCT_CLASSES.filter((value) =>
      /(gift|voucher|stored|credit|top_?up|balance|prepaid|cash)/i.test(value),
    );
    expect(offenders).toEqual([]);
  });

  it('leaves `stored_value` excluded as a commerce type', () => {
    expect(EXCLUDED_COMMERCE_TYPES).toContain('stored_value');
  });

  it('has a product-class tuple a detector could actually catch a widening in', () => {
    // The anti-vacuity floor for the clause above: an empty tuple would pass it.
    expect(DIGITAL_RETAIL_PRODUCT_CLASSES.length).toBeGreaterThanOrEqual(4);
  });
});

describe('wall 5 — the public projections cannot carry a cost or a supplier', () => {
  const source = readFileSync(
    join(PACKAGES_ROOT, 'shared-types', 'src', 'digital-retail.ts'),
    'utf8',
  );

  /**
   * The PROPERTY NAMES of one exported interface.
   *
   * Names, not the raw body: the docblocks inside these interfaces explain what
   * they deliberately do not carry — "the RETAIL price, never a cost", "it
   * carries NO secret" — so a scan over the text finds every forbidden word in
   * the sentence that forbids it. The first version of this wall did exactly
   * that and failed on its own documentation.
   */
  function propertyNames(name: string): string[] {
    const start = source.indexOf(`export interface ${name} {`);
    expect(start, `${name} is not declared`).toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    return [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gmu)].map((match) => match[1]!);
  }

  it.each(['DigitalRetailOfferView', 'DigitalLibraryEntryView'])(
    '%s declares no supplier, cost, margin or provider property',
    (name) => {
      const names = propertyNames(name);
      // The anti-vacuity floor: a parse that matched nothing passes every
      // clause below for a reason that has nothing to do with the wall.
      expect(names.length).toBeGreaterThan(5);
      const offenders = names.filter((property) =>
        /(supplier|cost|wholesale|margin|provenance|provider|purchaseOrder|procurement)/i.test(
          property,
        ),
      );
      expect(offenders, `${name} must carry no sourcing property`).toEqual([]);
    },
  );

  it('keeps the library entry free of any secret-shaped property', () => {
    const names = propertyNames('DigitalLibraryEntryView');
    expect(names).toContain('maskedHint');
    expect(names.filter((property) => /(secret|sealed|cipher|token)/i.test(property))).toEqual([]);
  });

  it('carries the cost on the PRIVATE pricing result instead, where it belongs', () => {
    // The positive control: the wall above is about what crosses toward a client,
    // not about the domain being unable to talk about money at all.
    expect(source).toContain('marginAmount');
  });
});

describe('wall 6 — ranking cannot read supplier economics', () => {
  const rankingModules = [
    ...walkOwnedDirectory('services/ranking'),
    ...walkOwnedDirectory('services/discovery'),
    ...walkOwnedDirectory('services/search'),
  ];

  it('found the ranking and discovery modules, so the absence below means something', () => {
    expect(rankingModules.length).toBeGreaterThan(10);
  });

  it('imports nothing from the digital-retail domain', () => {
    // The epic's acceptance criterion 22. The two share no module, no table and
    // no type, and this is what keeps it that way as both grow.
    const offenders = rankingModules.filter((relative) => {
      const text = readFileSync(join(SRC_ROOT, relative), 'utf8');
      return /from '.*(digital-retail|digitalRetail)/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the state machine cannot be walked into a stranded line', () => {
  it('is TOTAL over the statuses', () => {
    expect(Object.keys(DIGITAL_PURCHASE_ORDER_TRANSITIONS).sort()).toEqual(
      [...DIGITAL_PURCHASE_ORDER_STATUSES].sort(),
    );
  });

  it('admits NO edge out of a terminal state except the supplier credit', () => {
    for (const status of DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES) {
      const edges = DIGITAL_PURCHASE_ORDER_TRANSITIONS[status];
      expect(status === 'fulfilled' ? edges : [...edges]).toEqual(
        status === 'fulfilled' ? ['credited'] : [],
      );
    }
  });

  it('refuses `submitting -> failed`, which is what a timeout would take', () => {
    // ADR 0011 D5. A `failed` written on a timeout is a claim that nothing was
    // bought, and nothing on this side of the wire knows that — acting on it is
    // what buys a second key.
    expect(digitalPurchaseOrderTransitionAllowed('submitting', 'ambiguous')).toBe(true);
    expect(digitalPurchaseOrderTransitionAllowed('submitting', 'fulfilled')).toBe(false);
  });

  it('gives every non-terminal state a route OUT, so no line can be stranded', () => {
    // The failure this file's own suite found: a missing `pending -> rejected`
    // edge did not mislabel anything — it left the attempt non-terminal, and the
    // partial unique over the live statuses then blocked that order line forever.
    for (const status of DIGITAL_PURCHASE_ORDER_LIVE_STATUSES) {
      const edges = DIGITAL_PURCHASE_ORDER_TRANSITIONS[status];
      const terminal = edges.filter((edge) =>
        DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES.includes(edge),
      );
      expect(terminal.length, `${status} has no terminal exit`).toBeGreaterThan(0);
    }
  });

  it('derives the live statuses as the complement of the terminal ones', () => {
    expect([...DIGITAL_PURCHASE_ORDER_LIVE_STATUSES].sort()).toEqual(
      DIGITAL_PURCHASE_ORDER_STATUSES.filter(
        (status) => !DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES.includes(status),
      ).sort(),
    );
  });
});

describe('the closed vocabularies agree with each other', () => {
  it('draws every ambiguous error kind from the taxonomy', () => {
    for (const kind of AMBIGUOUS_PROCUREMENT_ERROR_KINDS) {
      expect(DIGITAL_PROCUREMENT_ERROR_KINDS).toContain(kind);
    }
  });

  it('does NOT treat a rate limit or an out-of-stock answer as ambiguous', () => {
    // A throttle is a refusal BEFORE work and an out-of-stock is an answer.
    // Treating either as unknown would stop a fallback that is perfectly safe.
    expect(isAmbiguousProcurementError('rate_limited')).toBe(false);
    expect(isAmbiguousProcurementError('out_of_stock')).toBe(false);
    expect(isAmbiguousProcurementError('other')).toBe(false);
    expect(isAmbiguousProcurementError('timeout')).toBe(true);
  });

  it('requires purchase RECOVERY of every procuring account', () => {
    expect(REQUIRED_PROCUREMENT_CAPABILITIES).toContain('purchase_recovery');
    for (const capability of REQUIRED_PROCUREMENT_CAPABILITIES) {
      expect(DIGITAL_SUPPLIER_API_CAPABILITIES).toContain(capability);
    }
  });

  it('draws every secret-bearing capability from the capability tuple', () => {
    for (const capability of SECRET_BEARING_FULFILMENT_CAPABILITIES) {
      expect(DIGITAL_FULFILMENT_CAPABILITIES).toContain(capability);
    }
    // And the set is a PROPER subset: a domain where everything is a secret has
    // no need for the distinction, and one where nothing is has no secrets.
    expect(SECRET_BEARING_FULFILMENT_CAPABILITIES.length).toBeLessThan(
      DIGITAL_FULFILMENT_CAPABILITIES.length,
    );
    expect(SECRET_BEARING_FULFILMENT_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it('ranks every provenance, with no `unknown` member to fall through to', () => {
    expect(Object.keys(DIGITAL_SUPPLY_PROVENANCE_STRENGTH).sort()).toEqual(
      [...DIGITAL_SUPPLY_PROVENANCES].sort(),
    );
    expect(DIGITAL_SUPPLY_PROVENANCES).not.toContain('unknown');
    expect(DIGITAL_SUPPLY_PROVENANCE_STRENGTH.publisher_direct).toBeGreaterThan(
      DIGITAL_SUPPLY_PROVENANCE_STRENGTH.approved_marketplace_supply,
    );
  });
});
