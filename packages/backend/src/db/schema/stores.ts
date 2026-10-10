/**
 * The seller organization and everything scoped to one: `stores`,
 * `store_permission_overrides`, `locations`, `tax_rates`, `customers`.
 *
 * A store is the root of most of this schema's foreign keys, so it lands first.
 * A store carries a policy set, tax settings and notification settings; each is
 * a single fixed-shape object and is flat columns here. The member
 * list is GONE (ADR 0012): a store is owned by an Oxy account
 * (`stores.oxy_account_id`), Oxy decides who belongs to that account and in
 * which role, and Mercaria keeps only per-person EXCEPTIONS to the role map.
 *
 * ## ON DELETE, stated against the real delete paths
 *
 * There is no code path anywhere in `src/` that deletes a `Store` or a
 * `Customer`. `Location` and `TaxRate` both have one
 * (`location.service.deleteLocation`, `tax.service.deleteTaxRate`). So the
 * cascades below describe what SHOULD happen if a store were ever removed, and
 * the RESTRICTs describe an invariant that is real today.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { STORE_PERMISSIONS } from '@mercaria/shared-types';
import type { LocationType, StorePermission, TextTone } from '@mercaria/shared-types';
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
    /**
     * The Oxy account that owns the store, usually `kind=organization` (ADR
     * 0012). An Oxy account id — no foreign key; Oxy owns identity, and its
     * membership decides who may act for the store.
     *
     * Every store that predates the column took its earliest owner's personal
     * account (`drizzle/0158`, `0161`): a personal account id and an
     * organization id share one id space, so the backfill is a copy.
     */
    oxyAccountId: text().notNull(),
    handle: text().notNull(),
    name: text().notNull(),
    /**
     * NOT NULL with NO default — a store without a description stores `''`,
     * written by whoever creates it (`store.service` already does exactly this).
     *
     * There is deliberately no `default: ''`.
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
    // "Which stores does this caller reach" is `oxy_account_id = any(<the
    // accounts Oxy lists for them>)` on every dashboard load.
    index('stores_oxy_account_id_idx').on(t.oxyAccountId),
    index('stores_status_created_at_idx').on(t.status, t.createdAt.desc()),
  ],
);

/**
 * `store_permission_overrides` — per-person EXCEPTIONS to the role map.
 *
 * Access to a store is decided by Oxy: the caller is the owning account, or a
 * member of it whose role maps to a default permission set
 * (`STORE_ROLE_PERMISSIONS`). A row here adjusts that set for ONE person on ONE
 * store — `(role defaults ∪ granted) − revoked` — and never admits anybody: a
 * row naming somebody who is not a member of the owning account grants nothing,
 * because there is no role to adjust.
 *
 * `granted`/`revoked` stay `text[]` rather than a row per permission: a scalar
 * set, never queried by element. The CHECKs hold the vocabulary at the row, keep
 * the two sets disjoint (a permission both added and removed is a mistake with
 * no safe reading to store), and refuse an empty override — "no exception" is
 * the ABSENCE of a row, so the service deletes instead of writing one.
 */
export const storePermissionOverrides = pgTable(
  'store_permission_overrides',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** The person the exception applies to. An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /**
     * `$type` rather than a bare `text[]`: drizzle infers `string[]`, which
     * would make every consumer widen a `StorePermission` to `string` and then
     * narrow it back with a cast. The CHECK is what enforces the set.
     */
    granted: text().array().$type<StorePermission[]>().notNull().default(sql`'{}'::text[]`),
    revoked: text().array().$type<StorePermission[]>().notNull().default(sql`'{}'::text[]`),
    /**
     * The human who last wrote the row (`getOxyActor().actorAccountId`), which
     * differs from the session's account when a person acts as an organization.
     * NULL when Oxy did not report the actor — recorded as unknown rather than
     * guessed — and on the rows `drizzle/0161` carried over from `store_members`.
     * An Oxy account id — no foreign key.
     */
    updatedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkEveryElementOf('store_permission_overrides_granted_check', t.granted, STORE_PERMISSIONS),
    checkEveryElementOf('store_permission_overrides_revoked_check', t.revoked, STORE_PERMISSIONS),
    check('store_permission_overrides_disjoint_check', sql`not (${t.granted} && ${t.revoked})`),
    check(
      'store_permission_overrides_nonempty_check',
      sql`cardinality(${t.granted}) + cardinality(${t.revoked}) > 0`,
    ),
    // One exception per person per store, and the read `loadStore` makes.
    uniqueIndex('store_permission_overrides_store_id_oxy_user_id_key').on(t.storeId, t.oxyUserId),
  ],
);

/**
 * `locations` — a physical or virtual place a store stocks inventory.
 *
 * `deleteLocation` refuses to remove the last or the default location, so a
 * store always retains a routable default.
 *
 * ## `go_way_place_id` is the whole of what Mercaria knows about where it IS
 *
 * ADR 0013: a location's place facts — name, address, position, timezone,
 * hours, contact, accessibility — live on a GoWay place, and this opaque id is
 * the reference. No foreign key (another service's key space) and no copy of a
 * single fact: everything is read through `services/goway`.
 *
 * Unique per STORE rather than globally. The place names back exactly one
 * location (`commerce.mercaria.store` holds one value at its strongest tier),
 * so two of one store's locations on one place would leave one that can never
 * be verified; across stores, a global unique would let any store that typed a
 * place id first lock its real owner out. The index leads with the place id,
 * so "which locations point at this place" is one probe.
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
    /** A GoWay place id — opaque, no foreign key (ADR 0013). */
    goWayPlaceId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('locations_type_check', t.type, LOCATION_TYPES),
    uniqueIndex('locations_go_way_place_id_store_id_key')
      .on(t.goWayPlaceId, t.storeId)
      .where(sql`${t.goWayPlaceId} is not null`),
    index('locations_store_id_is_default_idx').on(t.storeId, t.isDefault.desc()),
    index('locations_store_id_is_active_idx').on(t.storeId, t.isActive),
    // `deleteLocation`'s guard depends on this being true: at most ONE default
    // location per store.
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
     * An ABSENT value is a nullable column with NO default — never `'{}'`,
     * which is the different value "scoped to no product type at all".
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
    // One customer per (store, Oxy user). Partial rather than plain:
    // it keeps the index the size of the Oxy-backed set and states the intent.
    // Postgres treats NULLs as distinct anyway, so walk-ins never collide — but
    // the writer must store NULL and never `''`, which IS a value and collides.
    uniqueIndex('customers_store_id_oxy_user_id_key')
      .on(t.storeId, t.oxyUserId)
      .where(sql`${t.oxyUserId} is not null`),
    index('customers_store_id_email_idx')
      .on(t.storeId, t.email)
      .where(sql`${t.email} is not null`),
    // Tag filtering within a store. A btree cannot serve `&&`/`<@`, so the
    // element side is GIN; the `storeId` narrowing happens on the heap.
    index('customers_tags_idx').using('gin', t.tags),
    index('customers_store_id_created_at_idx').on(t.storeId, t.createdAt.desc()),
  ],
);
