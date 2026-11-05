/**
 * Advanced merchandising rules (#89, the paid `advanced_merchandising_rules`
 * tool): `merchandising_rules` and `merchandising_rule_pins`.
 *
 * A rule says how the store's OWN storefront page presents what the free
 * catalogue already holds — a default order with pins (`sort`) or a scheduled
 * shelf (`spotlight`). It never writes `listing_collections`, `collections` or a
 * listing, so every free merchandising fact (a manual collection's positions, an
 * automated collection's NULL positions, a collection's own `sort_order`) stays
 * exactly what the merchant set. `docs/merchandising-rules.md`.
 *
 * ## `collection_id` is SET NULL, and `target` is what keeps NULL unambiguous
 *
 * Each rule holds one unit of a `total` plan allowance, given back only when the
 * merchant deletes the rule (`releaseCapability`, in the delete's transaction).
 * A CASCADE from `collections` would delete the rule without giving the unit
 * back — the counter would drift up forever — and a RESTRICT would make deleting
 * a free collection fail because of a paid rule. So the collection's deletion
 * nulls the reference and the row stays, `detached`, applying to nothing until
 * the merchant removes it.
 *
 * NULL already means something on this column — "the whole store page" — which
 * is the `CONVENTIONS.md` §Foreign keys trap, so the meaning lives in `target`
 * instead: `target = 'store'` REQUIRES a NULL collection, and a `collection`
 * target with a NULL one is detached. A detached rule can never be read as a
 * store-wide one.
 *
 * The foreign key is single-column, not `(collection_id, store_id)`: SET NULL on
 * a composite key nulls `store_id` too, which is NOT NULL, so deleting the
 * collection would fail. The store match is checked when the rule is written,
 * and every read joins the collection on BOTH ids, so a mismatched pair could
 * apply to nothing even if raw SQL wrote one.
 *
 * ## Kind-specific columns are biconditionals
 *
 * `sort_strategy` is present exactly when `kind = 'sort'`, the best-selling
 * window exactly when the strategy is `best_selling`, the spotlight item limit
 * exactly when `kind = 'spotlight'` — each as `(a) = (b)` over two booleans,
 * never one CHECK over their conjunction (`docs/house-invariants.md`).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  MAX_MERCHANDISING_BEST_SELLING_WINDOW_DAYS,
  MAX_MERCHANDISING_PINS,
  MAX_MERCHANDISING_RULE_TITLE_LENGTH,
  MAX_MERCHANDISING_SPOTLIGHT_ITEMS,
  MERCHANDISING_RULE_KINDS,
  MERCHANDISING_RULE_TARGETS,
  MERCHANDISING_SORT_STRATEGIES,
  MIN_MERCHANDISING_BEST_SELLING_WINDOW_DAYS,
  MIN_MERCHANDISING_SPOTLIGHT_ITEMS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { listings } from './catalog';
import { collections } from './merchandising';
import { stores } from './stores';

export const merchandisingRules = pgTable(
  'merchandising_rules',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(MERCHANDISING_RULE_KINDS) }).notNull(),
    title: text().notNull(),
    target: text({ enum: asEnumValues(MERCHANDISING_RULE_TARGETS) }).notNull(),
    /** SET NULL on the collection's deletion — see the module docblock. */
    collectionId: text().references(() => collections.id, { onDelete: 'set null' }),
    enabled: boolean().notNull().default(true),
    /** Inclusive; NULL is "from the beginning". */
    startsAt: timestamptz(),
    /** Exclusive; NULL is "open-ended". */
    endsAt: timestamptz(),
    sortStrategy: text({ enum: asEnumValues(MERCHANDISING_SORT_STRATEGIES) }),
    bestSellingWindowDays: integer(),
    inStockFirst: boolean().notNull().default(false),
    spotlightItemLimit: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchandising_rules_kind_check', t.kind, MERCHANDISING_RULE_KINDS),
    checkOneOf('merchandising_rules_target_check', t.target, MERCHANDISING_RULE_TARGETS),
    checkOneOf(
      'merchandising_rules_sort_strategy_check',
      t.sortStrategy,
      MERCHANDISING_SORT_STRATEGIES,
    ),
    check(
      'merchandising_rules_title_check',
      sql`char_length(btrim(${t.title})) between 1 and ${sql.raw(String(MAX_MERCHANDISING_RULE_TITLE_LENGTH))}`,
    ),
    // A store-wide rule names no collection. (A collection rule MAY have lost its
    // collection — detached — which is why this is one implication, not a
    // biconditional.)
    check(
      'merchandising_rules_store_target_check',
      sql`${t.target} <> 'store' or ${t.collectionId} is null`,
    ),
    // A spotlight is always a collection's shelf.
    check(
      'merchandising_rules_spotlight_target_check',
      sql`${t.kind} <> 'spotlight' or ${t.target} = 'collection'`,
    ),
    check(
      'merchandising_rules_sort_strategy_presence_check',
      sql`(${t.kind} = 'sort') = (${t.sortStrategy} is not null)`,
    ),
    check(
      'merchandising_rules_window_days_presence_check',
      sql`(${t.sortStrategy} is not distinct from 'best_selling') = (${t.bestSellingWindowDays} is not null)`,
    ),
    check(
      'merchandising_rules_window_days_range_check',
      sql`${t.bestSellingWindowDays} is null or ${t.bestSellingWindowDays} between ${sql.raw(
        String(MIN_MERCHANDISING_BEST_SELLING_WINDOW_DAYS),
      )} and ${sql.raw(String(MAX_MERCHANDISING_BEST_SELLING_WINDOW_DAYS))}`,
    ),
    check(
      'merchandising_rules_in_stock_first_check',
      sql`${t.kind} = 'sort' or not ${t.inStockFirst}`,
    ),
    check(
      'merchandising_rules_spotlight_limit_presence_check',
      sql`(${t.kind} = 'spotlight') = (${t.spotlightItemLimit} is not null)`,
    ),
    check(
      'merchandising_rules_spotlight_limit_range_check',
      sql`${t.spotlightItemLimit} is null or ${t.spotlightItemLimit} between ${sql.raw(
        String(MIN_MERCHANDISING_SPOTLIGHT_ITEMS),
      )} and ${sql.raw(String(MAX_MERCHANDISING_SPOTLIGHT_ITEMS))}`,
    ),
    // A window that ends before it starts never applies, and is far more likely
    // a swapped pair of inputs than an intent — refused, as `discounts` does.
    check(
      'merchandising_rules_window_check',
      sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`,
    ),
    // The dashboard list and the storefront read: every rule of one store.
    index('merchandising_rules_store_id_kind_idx').on(t.storeId, t.kind),
    // The SET NULL above scans this column on every collection delete.
    index('merchandising_rules_collection_id_idx').on(t.collectionId),
  ],
);

/**
 * `merchandising_rule_pins` — the listings a `sort` rule puts on top, in order.
 *
 * Both foreign keys CASCADE: a pin exists only to point at its rule and its
 * listing, and holds no allowance of its own. A pin is checked against the
 * store when it is written; at read time it only ever REORDERS the target's own
 * members, so a pin on a listing that has left the collection, been archived or
 * moved store simply has nothing to reorder.
 */
export const merchandisingRulePins = pgTable(
  'merchandising_rule_pins',
  {
    ruleId: text()
      .notNull()
      .references(() => merchandisingRules.id, { onDelete: 'cascade' }),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'merchandising_rule_pins_pkey', columns: [t.ruleId, t.listingId] }),
    unique('merchandising_rule_pins_rule_id_position_key').on(t.ruleId, t.position),
    check(
      'merchandising_rule_pins_position_check',
      sql`${t.position} >= 0 and ${t.position} < ${sql.raw(String(MAX_MERCHANDISING_PINS))}`,
    ),
    // The listing delete's CASCADE scans this column.
    index('merchandising_rule_pins_listing_id_idx').on(t.listingId),
  ],
);
