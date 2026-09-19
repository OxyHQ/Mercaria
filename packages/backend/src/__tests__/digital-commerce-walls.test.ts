/**
 * The walls that make #1015's boundaries hold, and the ledger that makes its
 * admission of `digital_good` checkable after the fact (ADR 0010).
 *
 * ## Why this file replaced a detector rather than adding one
 *
 * `commerce-type-exclusion.test.ts` carried a `digital_good` detector keyed on
 * `download_url`, `licenseKey`, `is_digital` and six more spellings. Admitting the
 * type removed it — step 4 of that file's own admission procedure — and leaving it
 * would have failed the build on the domain that discharged it.
 *
 * That removal is only safe if something NARROWER takes its place, because the
 * hazard did not go away with the word. *"No digital anything"* stopped being true
 * of this repository; *"no permanent public URL to a paid file"* did not, and
 * neither did the other five boundaries #1015 states. So this file guards the
 * boundaries instead of the vocabulary:
 *
 *  - boundary 3/4: no column in the digital schema could become a public URL, and
 *    the storage key is PROTECTED;
 *  - boundary 5: a licence carries no price;
 *  - boundary 1: no asset table carries stock;
 *  - ADR 0010 D14: no per-asset training-use flag;
 *  - the seven prerequisites `digital_good`'s exclusion named are all discharged,
 *    and every discharge cites something that still exists.
 *
 * ## The discharge ledger is the half nothing else can check
 *
 * The admission procedure deletes the very list step 3 is measured against: once
 * `digital_good` is `classified`, its `prerequisites` field is gone.
 * `DIGITAL_GOOD_PREREQUISITES` preserves it and this file binds it to reality —
 * every citation must resolve to a real exported symbol, a real drizzle table or a
 * real CHECK on one, so an entry cannot survive the thing it cites being deleted.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import {
  ASSET_FILE_ROLES,
  ASSET_FORMAT_KEYS,
  ASSET_FORMAT_REGISTRY,
  COMMERCE_TYPE_DISPOSITIONS,
  COMMERCE_TYPE_PREREQUISITES,
  DIGITAL_GOOD_PREREQUISITES,
  DIGITAL_GOOD_PREREQUISITE_DISCHARGES,
  DOWNLOADABLE_ASSET_VERSION_STATES,
  DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES,
  ITEM_CONDITION_KEYS,
  ORDER_STATUSES,
  PUBLICLY_VIEWABLE_ASSET_FILE_ROLES,
  assetFormatCapability,
} from '@mercaria/shared-types';
import * as digitalAssetSchema from '../db/schema/digitalAssets';
import * as digitalRightSchema from '../db/schema/digitalRights';
// `SHIPPING_METHODS` lives HERE and not in shared-types — the tuple the CHECK is
// rendered from is the schema's, and reading the schema's is what makes this an
// assertion about the database rather than about a DTO.
import { SHIPPING_METHODS, orderItems, orders } from '../db/schema/orders';
import { PROTECTED_COLUMNS } from '../db/protectedColumns';
import { resolveDigitalLines } from '../services/checkout/digital-lines';

/** Every table of the two digital schema modules, by SQL name. */
const DIGITAL_TABLES: readonly PgTable[] = [
  ...Object.values(digitalAssetSchema),
  ...Object.values(digitalRightSchema),
].flatMap((value) => (is(value, PgTable) ? [value] : []));

const digitalColumnNames = (): { table: string; column: string }[] =>
  DIGITAL_TABLES.flatMap((table) =>
    getTableConfig(table).columns.map((column) => ({
      table: getTableName(table),
      column: sqlColumnName(column),
    })),
  );

const checkNames = (table: PgTable): string[] =>
  getTableConfig(table).checks.map((check) => check.name);

describe('the digital schema is the population these walls are measured over', () => {
  it('finds all fifteen tables, so every absence below means something', () => {
    // The anti-vacuity floor. An absence scan over an empty population reports a
    // clean result for a reason that has nothing to do with the wall.
    expect(DIGITAL_TABLES).toHaveLength(15);
    expect(new Set(DIGITAL_TABLES.map(getTableName))).toEqual(
      new Set([
        'digital_assets',
        'asset_versions',
        'asset_files',
        'asset_packages',
        'asset_package_files',
        'asset_file_inspections',
        'asset_provenance_signals',
        'asset_licences',
        'asset_licence_versions',
        'asset_licence_options',
        'asset_rights',
        'asset_right_events',
        'asset_download_grants',
        'asset_download_events',
        'asset_variant_bindings',
      ]),
    );
    expect(digitalColumnNames().length).toBeGreaterThan(100);
  });
});

describe('boundary 3 and 4 — a URL is never the ownership record', () => {
  it('carries NO url-shaped column anywhere in the digital schema', () => {
    // The cheap repair for "the client needs the file" is a permanent URL, and it
    // would look like a convenience. There is one way to reach a file and it is a
    // short-lived grant minted after authorization.
    const offenders = digitalColumnNames().filter(({ column }) =>
      /(^|_)(url|uri|href|public_path|cdn_path)(_|$)/.test(column),
    );
    expect(
      offenders.map(({ table, column }) => `${table}.${column}`),
      'a url-shaped column in the digital schema makes the download authorizer optional for ' +
        'anybody who can read a response body (#1015 boundary 3)',
    ).toEqual([]);
  });

  it('PROTECTS the storage key and the grant token digest', () => {
    expect(PROTECTED_COLUMNS.asset_files).toContain('storageKey');
    expect(PROTECTED_COLUMNS.asset_download_grants).toContain('tokenHash');
  });

  it('stores a token DIGEST and has no column that could hold the token', () => {
    const grantColumns = getTableConfig(digitalRightSchema.assetDownloadGrants).columns.map(
      (column) => sqlColumnName(column),
    );
    expect(grantColumns).toContain('token_hash');
    expect(grantColumns).not.toContain('token');
    // And the digest is shape-checked, so a pasted token cannot be stored in it.
    expect(checkNames(digitalRightSchema.assetDownloadGrants)).toContain(
      'asset_download_grants_token_hash_check',
    );
  });

  it('authorizes from exactly ONE right status, and one is the point', () => {
    // A set with two members would need a reader to remember which second one it
    // was. Every other status is a reason a download is refused.
    expect([...DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES]).toEqual(['active']);
  });

  it('keeps `superseded` and `withdrawn` DOWNLOADABLE, and `restricted` not', () => {
    // ADR 0010 D7. A set listing only `published` would revoke every historical
    // purchase the moment a creator shipped an update.
    expect([...DOWNLOADABLE_ASSET_VERSION_STATES]).toEqual(['published', 'superseded', 'withdrawn']);
  });

  it('shows a caller with NO right only previews and web derivatives', () => {
    // #1015 W12 threat 15, and the omissions are the wall: `mesh` is the paid
    // product and `documentation` is the creator's printing notes.
    expect([...PUBLICLY_VIEWABLE_ASSET_FILE_ROLES]).toEqual(['preview', 'web_derivative']);
    for (const role of ['source', 'mesh', 'texture', 'documentation', 'profile', 'archive']) {
      expect(PUBLICLY_VIEWABLE_ASSET_FILE_ROLES as readonly string[]).not.toContain(role);
    }
    // The control: the forbidden names above are real roles, so the assertions are
    // not passing against six strings that were never members of anything.
    for (const role of ['source', 'mesh', 'texture', 'documentation', 'profile', 'archive']) {
      expect(ASSET_FILE_ROLES as readonly string[]).toContain(role);
    }
  });
});

describe('boundary 1 and 5 — no fake stock, and a licence is not a price', () => {
  it('carries NO stock-shaped column on any asset table', () => {
    const offenders = digitalColumnNames().filter(({ column }) =>
      /(^|_)(stock|quantity|available|on_hand|committed|inventory)(_|$)/.test(column),
    );
    expect(
      offenders.map(({ table, column }) => `${table}.${column}`),
      'a digital product is not represented by fake stock (#1015 boundary 1)',
    ).toEqual([]);
  });

  it('carries NO price or currency column on a licence, option or package', () => {
    // A price here would be a second answer to what something costs; offers are
    // the first. The ONE money column in the domain is a licence's revenue CEILING,
    // which is a bound on the buyer's use rather than an amount anybody is charged.
    const priced = digitalColumnNames().filter(
      ({ table, column }) =>
        /(^|_)(price|amount|currency)(_|$)/.test(column) &&
        !(table === 'asset_licence_versions' && column.startsWith('revenue_limit')),
    );
    expect(
      priced.map(({ table, column }) => `${table}.${column}`),
      'a licence is not a product variant merely because it changes price (#1015 boundary 5)',
    ).toEqual([]);
  });

  it('carries NO training-use flag, because the permitting value does not exist', () => {
    // ADR 0010 D14. A nullable boolean is exactly how a default becomes negotiable.
    const offenders = digitalColumnNames().filter(({ column }) => /train|ai_use|model_use/.test(column));
    expect(offenders.map(({ table, column }) => `${table}.${column}`)).toEqual([]);
  });
});

describe('the format registry is a capability model, not a hard-coded list', () => {
  it('has unique keys, lowercase extensions and a media type each', () => {
    expect(new Set(ASSET_FORMAT_KEYS).size).toBe(ASSET_FORMAT_KEYS.length);
    for (const format of ASSET_FORMAT_REGISTRY) {
      expect(format.mediaType, format.key).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(format.extensions.length, format.key).toBeGreaterThan(0);
      for (const extension of format.extensions) {
        expect(extension, format.key).toBe(extension.toLowerCase());
        expect(extension, format.key).not.toContain('.');
      }
      expect(assetFormatCapability(format.key)).toBe(format);
    }
  });

  it('declares `blend` unmeasurable rather than claiming zero triangles', () => {
    // #1015 W4's closing rule. Measuring it needs Blender itself in the worker,
    // which is a whole-application parser on hostile input; a registry claiming
    // otherwise would have the pipeline reporting an absence as a measurement.
    expect(assetFormatCapability('blend')?.geometryMeasurable).toBe(false);
    // The control: something IS measurable, so the assertion is not passing
    // against a registry that claims nothing about anything.
    expect(assetFormatCapability('stl')?.geometryMeasurable).toBe(true);
  });

  it('marks every container format as one, because containers are the attack surface', () => {
    // #1015 W12 threats 5 and 6. A container is always inspected in the sandbox
    // with a file-count and expansion ceiling, never trusted.
    for (const key of ['zip', '3mf', 'blend']) {
      expect(assetFormatCapability(key)?.container, key).toBe(true);
    }
    expect(assetFormatCapability('stl')?.container).toBe(false);
  });
});

describe('the `digital_good` admission is still discharged in full (ADR 0010)', () => {
  it('is CLASSIFIED, and its detector is therefore gone', () => {
    const disposition = COMMERCE_TYPE_DISPOSITIONS.digital_good;
    expect(disposition.verdict).toBe('classified');
  });

  it('preserves the SEVEN prerequisites its exclusion named, verbatim', () => {
    // The ledger entry. `inventory_semantics` and `pricing_basis` are absent
    // because that disposition did not name them: a digital line IS a catalog
    // variant bought in whole units.
    expect([...DIGITAL_GOOD_PREREQUISITES]).toEqual([
      'delivery_destination',
      'order_address_snapshot',
      'fulfilment_completion_signal',
      'entitlement_delivery',
      'tax_place_of_supply',
      'condition_semantics',
      'withdrawal_and_guarantee_terms',
    ]);
    // Every one of them is still in the CLOSED vocabulary, so a prerequisite
    // renamed there cannot leave this ledger pointing at nothing.
    for (const prerequisite of DIGITAL_GOOD_PREREQUISITES) {
      expect(COMMERCE_TYPE_PREREQUISITES, prerequisite).toContain(prerequisite);
    }
  });

  it('discharges EXACTLY those seven, with no orphan and no gap', () => {
    // `tsc` holds the missing-key direction; nothing holds a key left behind.
    expect(Object.keys(DIGITAL_GOOD_PREREQUISITE_DISCHARGES).sort()).toEqual(
      [...DIGITAL_GOOD_PREREQUISITES].sort(),
    );
  });

  it('cites an ADR decision and a real mechanism for each', () => {
    for (const [prerequisite, discharge] of Object.entries(DIGITAL_GOOD_PREREQUISITE_DISCHARGES)) {
      expect(discharge.decision, prerequisite).toMatch(/^ADR 0010 D\d+(\.\d+)?$/);
      expect(discharge.mechanism.length, prerequisite).toBeGreaterThan(80);
      expect(discharge.citation.length, prerequisite).toBeGreaterThan(10);
    }
  });

  it('cites CHECK constraints that actually exist on the tables named', () => {
    // The half that can go stale silently: a citation naming a constraint somebody
    // renamed reads exactly like a correct one.
    const orderChecks = checkNames(orders);
    const itemChecks = checkNames(orderItems);
    expect(orderChecks).toContain('orders_shipping_address_digital_check');
    expect(orderChecks).toContain('orders_digital_withdrawal_consent_check');
    expect(itemChecks).toContain('order_items_digital_no_condition_check');
    expect(itemChecks).toContain('order_items_digital_snapshot_complete_check');
    for (const name of [
      'orders_shipping_address_digital_check',
      'orders_digital_withdrawal_consent_check',
      'order_items_digital_no_condition_check',
    ]) {
      const cited = Object.values(DIGITAL_GOOD_PREREQUISITE_DISCHARGES).some((discharge) =>
        discharge.citation.includes(name),
      );
      expect(cited, `${name} exists but no discharge cites it`).toBe(true);
    }
  });

  it('cites tuple members that are actually members', () => {
    expect(ORDER_STATUSES as readonly string[]).toContain('digitally_delivered');
    expect(SHIPPING_METHODS as readonly string[]).toContain('digital');
    // And `condition_semantics` was discharged WITHOUT widening the condition
    // vocabulary, which is the half the discharge claims and this is the check.
    expect(ITEM_CONDITION_KEYS).toHaveLength(9);
    expect(ITEM_CONDITION_KEYS as readonly string[]).not.toContain('not_applicable');
  });
});

describe('the binding resolver reads nothing it was not asked about', () => {
  it('returns an empty map for an empty variant set, with no database read', async () => {
    // Not connected to Postgres in this file. A resolver that queried anyway would
    // throw here rather than returning `{}` — which is what makes this an assertion
    // about the short-circuit and not about an empty result.
    await expect(resolveDigitalLines([])).resolves.toEqual(new Map());
  });
});
