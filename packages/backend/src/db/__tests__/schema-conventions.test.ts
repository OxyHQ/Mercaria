/**
 * Schema-Convention Gates — the half that needs no database.
 *
 * `@oxyhq/db/assert` ships four gates and they split cleanly in two:
 *
 *  - STATIC — `findIdColumnViolations` (walks the drizzle table objects) and
 *    `findImplicitWholeRowReads` (reads `.ts` files off disk). Neither opens a
 *    connection, so both run here, under the suite's existing vitest config,
 *    with no Postgres server involved.
 *  - LIVE DATABASE — `findSchemaInvariantViolations` and
 *    `findUnsupportedExpiryColumns`. Both take a `SqlExecutor` and query
 *    `information_schema` / `pg_index`, because they check the DDL that
 *    actually LANDED rather than the TypeScript meant to produce it. They
 *    cannot live in this file: every `src/**` `.test.ts` is collected by the
 *    current config, which has no Postgres, so they would fail every run.
 *    They belong beside the tables they check, in a suite run under
 *    `vitest.pg.globalSetup.ts` (Fase 2, when the harness is wired in).
 *
 * ## The two gates this file adds beyond the package's own
 *
 * `schema/columns.ts` builds money and address columns through helpers with
 * COMPUTED template-literal keys, which TypeScript cannot infer through a
 * generic — so each helper asserts its own return type. That assertion is
 * checked for SHAPE, never for the spelling of the keys inside it, which means a
 * typo there would create a differently-named column with no compile error
 * anywhere. `emits the exact column names …` is the only thing standing between
 * that typo and a schema whose columns do not match its types.
 *
 * `constrains every currency column` closes the matching gap on the CHECK side:
 * `text({ enum })` is a TypeScript narrowing that emits no DDL, so a currency
 * column whose `currencyChecks(...)` entry was forgotten is unconstrained in the
 * database while looking constrained in the editor.
 */

import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findIdColumnViolations, findImplicitWholeRowReads } from '@oxyhq/db/assert';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import { DEFERRED_FOREIGN_KEYS, ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../deferredForeignKeys.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { addressColumns, dualMoney, money, optionalAddressColumns } from '../schema/columns.js';
import * as schema from '../schema/index.js';

/** `src/` — the tree `findImplicitWholeRowReads` scans for whole-row reads. */
const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every drizzle table the barrel exports, which is exactly the set drizzle-kit
 * generates DDL for and `createDatabase({ schema })` gives types to. Filtered
 * with drizzle's own `is()` rather than a duck-type check so a non-table export
 * (an enum tuple, a helper) cannot be mistaken for one.
 *
 * `flatMap` rather than `filter` with a hand-written predicate: the barrel
 * exports enum TUPLES beside its tables, so the union `Object.values` produces
 * is not a supertype of `PgTable` and a `value is PgTable` predicate on it is a
 * TS2677 error. Narrowing inside the callback avoids declaring one at all.
 */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/**
 * The number of tables the barrel is expected to export. RAISE THIS with every
 * table added — that is the point, not an annoyance.
 *
 * This is the anti-vacuity floor for every gate below. `findIdColumnViolations`
 * takes a `minimumTables` of its own and would happily accept 0, which means a
 * broken import, a renamed barrel or a table module nobody re-exported would
 * make it traverse nothing and report a clean schema. Pinning the count
 * EXACTLY, rather than as a minimum, is what makes that impossible in both
 * directions.
 */
const SCHEMA_TABLE_COUNT = 260;

describe('schema conventions (static)', () => {
  it('exports exactly the tables the gates below are calibrated for', () => {
    expect(tables).toHaveLength(SCHEMA_TABLE_COUNT);
  });

  it('classifies every id-shaped column', () => {
    expect(
      findIdColumnViolations({
        tables,
        deferred: DEFERRED_FOREIGN_KEYS,
        withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY,
        minimumTables: SCHEMA_TABLE_COUNT,
      }),
    ).toEqual([]);
  });

  it('reads no protected column implicitly', async () => {
    expect(
      await findImplicitWholeRowReads({ sourceDir: SOURCE_DIR, registry: PROTECTED_COLUMNS }),
    ).toEqual([]);
  });

  it('names a real table and a real column in every protected-column entry', () => {
    // The registry is keyed by SQL table name and valued by TypeScript property
    // name. Get either convention wrong and `publicColumns` silently protects
    // NOTHING — an unmatched key is not an error, it is a table with no entry.
    const byName = new Map<string, PgTable>(tables.map((table) => [getTableName(table), table]));

    for (const [tableName, columns] of Object.entries(PROTECTED_COLUMNS)) {
      const table = byName.get(tableName);
      expect(table, `${tableName} is not a table in the schema barrel`).toBeDefined();
      if (!table) continue;

      const properties = new Set(Object.keys(getTableColumns(table)));
      for (const column of columns) {
        expect(properties.has(column), `${tableName}.${column} is not a column`).toBe(true);
      }
    }
  });

  it('emits the exact column names the money and address helpers claim', () => {
    // Pinned against a literal list rather than derived from the helpers, which
    // would only restate whatever they happen to produce. These are the SQL
    // names the migration creates and every query references.
    expect(Object.keys(money('price')).sort()).toEqual(['priceAmount', 'priceCurrency']);

    expect(Object.keys(dualMoney('unitPrice')).sort()).toEqual([
      'unitPricePresentmentAmount',
      'unitPricePresentmentCurrency',
      'unitPriceShopAmount',
      'unitPriceShopCurrency',
    ]);

    const addressFields = [
      'City',
      'Country',
      'Label',
      'Line1',
      'Line2',
      'Phone',
      'PostalCode',
      'RecipientName',
      'Region',
    ];
    const expectedAddress = addressFields.map((field) => `shippingAddress${field}`).sort();
    expect(Object.keys(addressColumns('shippingAddress')).sort()).toEqual(expectedAddress);
    expect(Object.keys(optionalAddressColumns('shippingAddress')).sort()).toEqual(expectedAddress);

    // The SQL side, which is what actually has to be right — the property names
    // above are only half the contract, and drizzle derives the rest. Read off a
    // REAL table, so this asserts what the migration created rather than what a
    // freshly-built helper would have produced.
    expect(sqlColumnName(schema.orderItems.unitPriceShopAmount)).toBe('unit_price_shop_amount');
    expect(sqlColumnName(schema.orders.shippingAddressPostalCode)).toBe(
      'shipping_address_postal_code',
    );
    expect(sqlColumnName(schema.customers.statsTotalSpentAmount)).toBe('stats_total_spent_amount');
  });

  it('constrains every currency column with a CHECK', () => {
    // `text({ enum })` narrows TypeScript and emits no DDL, so the CHECK is the
    // only thing that actually rejects a bad currency code. A column whose
    // `currencyChecks(...)` entry was forgotten looks constrained in the editor
    // and is not constrained in the database.
    //
    // Three deliberate exceptions, all the same shape: a currency chosen by a
    // system that is not Mercaria, which may legitimately be a code Mercaria does
    // not list. `connections.shop_currency` is the external commerce platform's;
    // `provider_accounts.default_currency` is the payment rail's, and several EEA
    // settlement currencies (RON, CZK, HUF, BGN) are outside Mercaria's
    // presentment set — so a CHECK there would fail the SYNC of a real seller's
    // account rather than reject a price. `awin_feeds.currency` (#66) is the
    // network's declaration of what an advertiser trades in, and it is
    // `offers.price_currency`'s own documented exception (ADR 0002 D18) one
    // layer up: refusing a feed because its currency is outside the presentment
    // set would decline a whole retailer's inventory over a display concern,
    // where a row whose currency Mercaria cannot READ is already refused per
    // record by #63's money reader with the code named. Named here so removing
    // any exemption is a visible decision.
    const EXEMPT = new Set([
      'connections.shop_currency',
      'provider_accounts.default_currency',
      'awin_feeds.currency',
    ]);

    const unconstrained: string[] = [];
    let scanned = 0;

    for (const table of tables) {
      const config = getTableConfig(table);
      // The CHECK's rendered SQL, which is where the column reference lives.
      const checkedSql = config.checks.map((entry) => entry.value.queryChunks).flat();
      const checkedColumns = new Set(
        checkedSql
          .filter((chunk): chunk is { name: string } => typeof chunk === 'object' && chunk !== null && 'name' in chunk)
          .map((chunk) => chunk.name),
      );

      for (const column of config.columns) {
        const sqlName = sqlColumnName(column);
        const isCurrency = sqlName === 'currency' || sqlName.endsWith('_currency');
        if (!isCurrency) continue;

        scanned += 1;
        const id = `${config.name}.${sqlName}`;
        if (EXEMPT.has(id)) continue;
        if (!checkedColumns.has(column.name)) unconstrained.push(id);
      }
    }

    // Vacuity floor: a broken traversal returning zero currency columns would
    // otherwise report a perfectly constrained schema by examining nothing.
    expect(scanned).toBeGreaterThanOrEqual(40);
    expect(unconstrained).toEqual([]);
  });
});
