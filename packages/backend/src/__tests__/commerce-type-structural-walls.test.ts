/**
 * The walls that make ADR 0007 D15's exclusions TRUE, pinned so relaxing one is
 * a visible act (#367 line 144).
 *
 * ## Why this file exists at all
 *
 * Every refusal below was already true of this repository before #367 line 144
 * was written, and none of it was written down. That is the difference the
 * issue's own wording turns on: *"or are intentionally excluded"*. A service and
 * a digital good are unsellable here today by ACCIDENT — because a commerce path
 * built for physical goods happens to demand a street, a whole-unit quantity and
 * a condition — and an accident is not a decision. It also erodes quietly: any
 * one of these could be relaxed by somebody solving an unrelated problem, and
 * nothing would say that a commerce type had been admitted along with it.
 *
 * So each wall is asserted here, with the excluded type it holds and the
 * prerequisite it corresponds to in `COMMERCE_TYPE_PREREQUISITES`. Relaxing one
 * now fails a test whose message names the ADR.
 *
 * ## These are pins, not new constraints
 *
 * Nothing here changes behaviour and nothing here is a second implementation of
 * a rule. Every assertion reads the real exported symbol or the real drizzle
 * table, and the two behavioural ones call the shipped function. A wall that
 * this file re-implemented would measure the re-implementation.
 *
 * ## Each exact-membership assertion is its own control
 *
 * Where the wall is a tuple, it is asserted EXACTLY rather than by containment.
 * A containment assertion goes green when a member is ADDED, which is precisely
 * the direction that admits a commerce type — an `ORDER_STATUSES` grown a
 * `digitally_delivered` member, an `ITEM_CONDITION_KEYS` grown a `not_applicable`.
 * Where the wall is a throw, the control is the accepting case beside it, so
 * "it throws" cannot be satisfied by a function that throws on everything.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  COMMERCE_TYPE_PREREQUISITES,
  ITEM_CONDITION_KEYS,
  type CheckoutInput,
} from '@mercaria/shared-types';
import { destinationFromInput } from '../services/checkout/destination';
import { checkoutSchema } from '../middleware/schemas';
import { ORDER_STATUSES, SHIPPING_METHODS, orderItems, orders } from '../db/schema/orders';

/** Every prerequisite this file pins, so an unpinned one is visible. */
const PINNED_PREREQUISITES = [
  'delivery_destination',
  'order_address_snapshot',
  'fulfilment_completion_signal',
  'condition_semantics',
  'pricing_basis',
] as const;

/**
 * The SQL names of a table's NOT NULL columns.
 *
 * `sqlColumnName`, never `column.name`: `DATABASE_CASING` means drizzle's `.name`
 * is the TypeScript property (`shippingAddressRecipientName`), so a set built
 * from it contains no snake_case name at all — every assertion below would then
 * report the column as nullable whether it was or not. Caught on the first run,
 * which is the only reason this docblock exists.
 */
const notNullColumns = (table: Parameters<typeof getTableConfig>[0]): Set<string> =>
  new Set(
    getTableConfig(table)
      .columns.filter((column) => column.notNull)
      .map((column) => sqlColumnName(column)),
  );

describe('the walls that exclude a service and a digital good', () => {
  it('pins prerequisites that are all in the closed vocabulary', () => {
    // The map between this file and the decision. A prerequisite renamed in
    // `commerce-type.ts` and not here would leave a wall pinned under a name
    // nothing refers to.
    for (const prerequisite of PINNED_PREREQUISITES) {
      expect(COMMERCE_TYPE_PREREQUISITES, `${prerequisite} is not a declared prerequisite`)
        .toContain(prerequisite);
    }
  });

  describe('delivery_destination — a checkout cannot happen without a place', () => {
    it('REFUSES a body carrying neither a destination nor the v1 addressId', () => {
      // The wall itself. A digital good and a service have no place to be sent,
      // so there is no code path by which either could be bought.
      expect(() => destinationFromInput({} as CheckoutInput)).toThrow();
    });

    it('accepts one that does, so the refusal above is not a function that always throws', () => {
      expect(
        destinationFromInput({ addressId: 'addr_1' } as CheckoutInput),
      ).toEqual({ type: 'saved_address', addressId: 'addr_1' });
    });

    it('admits exactly three destination shapes, all of them places', () => {
      // Asserted through the shipped request schema rather than through the
      // type, because a union member is invisible at runtime and this is what an
      // HTTP caller actually meets.
      for (const type of ['saved_address', 'inline_shipping_address', 'pickup']) {
        const parsed = checkoutSchema.safeParse({ destination: { type } });
        // Each is REACHED — it fails on its own missing fields, never on the
        // discriminant. Without this the loop below would pass against a schema
        // that rejected all four.
        expect(
          JSON.stringify(parsed.error?.issues ?? []),
          `${type} is no longer a destination shape`,
        ).not.toContain('invalid_union_discriminator');
      }
      for (const type of ['digital', 'download', 'no_delivery', 'email']) {
        const parsed = checkoutSchema.safeParse({ destination: { type } });
        expect(parsed.success, `\`${type}\` is now an accepted destination`).toBe(false);
      }
    });
  });

  describe('order_address_snapshot — a placed order carries a real postal address', () => {
    it('keeps every required address column NOT NULL on `orders`', () => {
      const required = notNullColumns(orders);
      // `optionalAddressColumns` exists and `draft_orders` uses it, so this is a
      // choice `orders` makes rather than the only shape available.
      for (const column of [
        'shipping_address_recipient_name',
        'shipping_address_line1',
        'shipping_address_city',
        'shipping_address_postal_code',
        'shipping_address_country',
      ]) {
        expect(required, `orders.${column} is no longer NOT NULL`).toContain(column);
      }
      // The control: the OPTIONAL half of the same address is still nullable, so
      // the assertion above is reading `notNull` rather than every column.
      expect(required).not.toContain('shipping_address_line2');
      expect(required).not.toContain('shipping_address_phone');
    });
  });

  describe('pricing_basis — every order line is a catalog variant, in whole units', () => {
    it('keeps `order_items.variant_id` NOT NULL, so there is no ad-hoc or labour line', () => {
      const required = notNullColumns(orderItems);
      expect(required).toContain('variant_id');
      expect(required).toContain('quantity');
      // The control, same shape as above.
      expect(required).not.toContain('condition_key');
    });
  });

  describe('fulfilment_completion_signal — an order completes by being carried', () => {
    it('admits exactly the physical shipping methods', () => {
      expect([...SHIPPING_METHODS]).toEqual(['standard', 'express', 'pickup']);
    });

    it('admits exactly the statuses of a physical order', () => {
      // EXACT. A `digitally_delivered`, `activated`, `redeemed` or `performed`
      // member is the shape in which a non-physical completion arrives, and
      // containment would welcome it silently.
      expect([...ORDER_STATUSES]).toEqual([
        'pending_payment',
        'paid',
        'processing',
        'shipped',
        'delivered',
        'cancelled',
        'refunded',
        'partially_refunded',
      ]);
    });
  });

  describe('condition_semantics — every condition describes the state of an object', () => {
    it('admits exactly the nine physical conditions', () => {
      expect([...ITEM_CONDITION_KEYS]).toEqual([
        'new',
        'open_box',
        'refurbished_manufacturer',
        'refurbished_seller',
        'used_like_new',
        'used_good',
        'used_fair',
        'used_poor',
        'for_parts',
      ]);
    });
  });
});
