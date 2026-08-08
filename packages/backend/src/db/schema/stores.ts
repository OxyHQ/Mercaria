/**
 * The seller organization and everything scoped to one: `stores`,
 * `store_members`, `locations`, `tax_rates`, `customers`.
 *
 * A store is the root of most of this schema's foreign keys, so it lands first.
 * Its Mongoose model embedded four things — the member list, the policy set, the
 * tax settings and the notification settings. Only the MEMBER list becomes a
 * table: it is a collection of entities that is queried by element
 * (`{'members.oxyUserId': 1}` is the hot path on every admin request). The other
 * three are single fixed-shape objects and become flat columns.
 *
 * ## ON DELETE, stated against the real Mongo delete paths
 *
 * There is no code path anywhere in `src/` that deletes a `Store` or a
 * `Customer`. `Location` and `TaxRate` both have one
 * (`location.service.deleteLocation`, `tax.service.deleteTaxRate`). So the
 * cascades below describe what SHOULD happen if a store were ever removed, and
 * the RESTRICTs describe an invariant that is real today.
 */

import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import type { LocationType, StorePermission, StoreRole, TextTone } from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  money,
  optionalAddressColumns,
} from './columns';

/** `Store.status`. */
export const STORE_STATUSES = ['active', 'suspended', 'closed'] as const;

/** `StoreMember.role`. */
export const STORE_ROLES: readonly StoreRole[] = ['owner', 'admin', 'staff'];

/**
 * `StoreMember.permissions` element.
 *
 * Seventeen values, and THIS list is the authority — the column's CHECK is built
 * from it. The role matrix in `AGENTS.md` says "16 perms" and predates
 * `channels:write`; that count is the stale one.
 */
export const STORE_PERMISSIONS: readonly StorePermission[] = [
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'locations:write',
  'collections:write',
  'discounts:write',
  'settings:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
  'customers:read',
  'customers:write',
  'draft_orders:write',
  'refunds:write',
  'channels:write',
];

/** `Store.textTone`. */
export const TEXT_TONES: readonly TextTone[] = ['light', 'dark'];

/** `Location.type`. */
export const LOCATION_TYPES: readonly LocationType[] = ['warehouse', 'retail', 'pop_up', 'virtual'];

/**
 * `stores` — a seller organization that lists new products.
 *
 * `handle` is unique on the RAW value, deliberately. Adding `lower(handle)` here
 * would reject pairs of stores that already coexist in production, as a
 * constraint violation on rows nobody touched. If case-insensitive handles are
 * wanted they are a separate, deliberate migration with a data audit in front of
 * it.
 */
export const stores = pgTable(
  'stores',
  {
    id: generatedId(),
    handle: text().notNull(),
    name: text().notNull(),
    /**
     * NOT NULL with NO default — a store without a description stores `''`,
     * written by whoever creates it (`store.service` already does exactly this).
     *
     * The Mongoose `default: ''` is deliberately not carried across.
     * `findSchemaInvariantViolations` rejects an empty-string DEFAULT across
     * every Oxy schema, and the reason generalizes past this column: a default
     * that manufactures a sentinel value makes "absent" and "empty" the same
     * row, which is harmless for prose and destructive the first time the same
     * habit reaches a sparse-unique column, where `''` is a VALUE and collides
     * for real.
     */
    description: text().notNull(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    logoFileId: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    coverFileId: text(),
    brandColor: text().notNull(),
    textTone: text({ enum: asEnumValues(TEXT_TONES) }).notNull().default('light'),
    status: text({ enum: asEnumValues(STORE_STATUSES) }).notNull().default('active'),

    // `policies` — a fixed five-field object, flattened.
    policiesReturnWindowDays: integer().notNull().default(30),
    policiesShippingNote: text(),
    policiesRefundPolicy: text(),
    policiesPrivacyPolicy: text(),
    policiesTermsOfService: text(),

    /** The store's SETTLEMENT currency — the basis every report `$match`es on. */
    defaultCurrency: text().notNull().default('FAIR'),

    // `taxSettings` — a fixed three-field object, flattened.
    taxSettingsPricesIncludeTax: boolean().notNull().default(false),
    taxSettingsTaxRegistrationId: text(),
    taxSettingsChargeTaxOnProducts: boolean().notNull().default(true),

    // `notificationSettings` — a fixed three-field object, flattened.
    notificationSettingsLowStockAlerts: boolean().notNull().default(true),
    notificationSettingsOrderEmails: boolean().notNull().default(true),
    notificationSettingsLowStockThreshold: integer(),

    /** Average review score, 0 when unrated — a computed mean, hence a float. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    productCount: integer().notNull().default(0),
    salesCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `text({ enum })` is a TYPESCRIPT narrowing only — drizzle emits no DDL for
    // it. Every closed value set needs its CHECK stated explicitly, rendered from
    // the same tuple that types the column so the two cannot drift.
    checkOneOf('stores_text_tone_check', t.textTone, TEXT_TONES),
    checkOneOf('stores_status_check', t.status, STORE_STATUSES),
    ...currencyChecks('stores', [t.defaultCurrency]),
    uniqueIndex('stores_handle_key').on(t.handle),
    index('stores_status_created_at_idx').on(t.status, t.createdAt.desc()),
  ],
);

/**
 * `store_members` — who may act for a store, and with which permissions.
 *
 * Embedded in Mongo, a table here: the `{'members.oxyUserId': 1}` multikey index
 * is read on every admin request to answer "may this Oxy user act for this
 * store", and that is a query BY ELEMENT.
 *
 * `permissions` stays a `text[]` rather than becoming a third table — it is a
 * scalar set, never queried by element (the permission check loads the member
 * row and tests the array in the service), so a row per permission would be
 * over-normalization. The CHECK is on the ELEMENTS via containment.
 */
export const storeMembers = pgTable(
  'store_members',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    oxyUserId: text().notNull(),
    role: text({ enum: asEnumValues(STORE_ROLES) }).notNull(),
    /**
     * `$type` rather than a bare `text[]`: drizzle infers `string[]`, which
     * would make every consumer widen a `StorePermission` to `string` and then
     * narrow it back with a cast. The CHECK below is what actually enforces the
     * set — the type only stops the compiler from forgetting it exists.
     */
    permissions: text()
      .array()
      .$type<StorePermission[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** An Oxy account id — no foreign key. */
    invitedBy: text(),
    joinedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('store_members_role_check', t.role, STORE_ROLES),
    checkEveryElementOf('store_members_permissions_check', t.permissions, STORE_PERMISSIONS),
    // Mongo could not state this: an embedded array happily held the same user
    // twice. One membership per user per store.
    uniqueIndex('store_members_store_id_oxy_user_id_key').on(t.storeId, t.oxyUserId),
    // The hot path — "which stores may this user act for", on every admin request.
    index('store_members_oxy_user_id_idx').on(t.oxyUserId),
  ],
);

/**
 * `locations` — a physical or virtual place a store stocks inventory.
 *
 * `deleteLocation` refuses to remove the last or the default location, so a
 * store always retains a routable default.
 */
export const locations = pgTable(
  'locations',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    type: text({ enum: asEnumValues(LOCATION_TYPES) }).notNull().default('warehouse'),
    ...optionalAddressColumns('address'),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    fulfillsOnlineOrders: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('locations_type_check', t.type, LOCATION_TYPES),
    index('locations_store_id_is_default_idx').on(t.storeId, t.isDefault.desc()),
    index('locations_store_id_is_active_idx').on(t.storeId, t.isActive),
    // Mongo could not state this either, and `deleteLocation`'s guard depends on
    // it being true: at most ONE default location per store.
    uniqueIndex('locations_store_id_default_key')
      .on(t.storeId)
      .where(sql`${t.isDefault}`),
  ],
);

/** `tax_rates` — a store-scoped tax rule, matched by region and priority. */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Basis points — 800 = 8%. An integer, never a float. */
    rateBps: integer().notNull(),
    // `region` — a fixed three-field object, flattened.
    regionCountry: text(),
    regionRegion: text(),
    regionPostalCodePattern: text(),
    appliesToShipping: boolean().notNull().default(false),
    /**
     * `default: undefined` in Mongoose means ABSENT, which is a nullable column
     * with NO default — never `'{}'`, which is the different value "scoped to no
     * product type at all".
     */
    productTypeScope: text().array(),
    priority: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tax_rates_store_id_is_active_idx').on(t.storeId, t.isActive),
    index('tax_rates_store_id_region_idx').on(t.storeId, t.regionCountry, t.regionRegion),
  ],
);

/**
 * `customers` — a store-scoped buyer record, Oxy-backed or a POS walk-in.
 *
 * `stats` is a fixed three-field rollup kept in lockstep with paid orders, so it
 * flattens. `totalSpent` is a single-currency `Money` in the store's own
 * settlement currency — `customer.stats.totalSpent` is summed `$match`ed to
 * `defaultCurrency`, so it is never a `DualMoney`.
 *
 * `email` and `phone` are PROTECTED — see `db/protectedColumns.ts`. A POS
 * walk-in's contact details are exactly the shape that leaks through the first
 * naive `db.select().from(customers)`.
 */
export const customers = pgTable(
  'customers',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. NULL for a walk-in. */
    oxyUserId: text(),
    isWalkIn: boolean().notNull().default(false),
    displayName: text(),
    email: text(),
    phone: text(),
    ...optionalAddressColumns('defaultAddress'),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    groupTags: text().array().notNull().default(sql`'{}'::text[]`),
    statsOrderCount: integer().notNull().default(0),
    ...money('statsTotalSpent'),
    statsLastOrderAt: timestamptz(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('customers', [t.statsTotalSpentCurrency]),
    // Mongo's `{storeId, oxyUserId}` sparse unique. Partial rather than plain:
    // it keeps the index the size of the Oxy-backed set and states the intent.
    // Postgres treats NULLs as distinct anyway, so walk-ins never collide — but
    // the writer must store NULL and never `''`, which IS a value and collides.
    uniqueIndex('customers_store_id_oxy_user_id_key')
      .on(t.storeId, t.oxyUserId)
      .where(sql`${t.oxyUserId} is not null`),
    index('customers_store_id_email_idx')
      .on(t.storeId, t.email)
      .where(sql`${t.email} is not null`),
    // Mongo's `{storeId, tags}` multikey. A btree cannot serve `&&`/`<@`, so the
    // element side is GIN; the `storeId` narrowing happens on the heap, which is
    // the same shape Mongo's compound multikey degraded to anyway.
    index('customers_tags_idx').using('gin', t.tags),
    index('customers_store_id_created_at_idx').on(t.storeId, t.createdAt.desc()),
  ],
);
