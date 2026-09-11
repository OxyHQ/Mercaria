/**
 * The walls that make ADR 0007 D15's exclusions TRUE, pinned so relaxing one is
 * a visible act (#367 line 144), as amended by #1015 / ADR 0010.
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
 *
 * ## #1015 moved three of these, and the exactness is why you can see that
 *
 * `digitally_delivered` and `digital` are now MEMBERS, and the five required
 * address columns are no longer NOT NULL. Every one of those changes turned this
 * file red and had to be edited here, in the diff that admitted `digital_good` —
 * which is precisely what the paragraph above predicted would happen and asked
 * for. The walls did not weaken: the address wall became a CHECK that says more
 * than the NOT NULLs did, `ITEM_CONDITION_KEYS` is untouched at nine members, and
 * every remaining exclusion (`service`, `stored_value`, `event_admission`,
 * `consumer_subscription`) is still held by the same tuples.
 *
 * What each assertion now guards is stated per test: the members #1015 added are
 * named, and the members it did NOT add — `performed`, `redeemed`, `activated`,
 * `not_applicable` — are still absent by the same `toEqual`.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
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

    it('admits exactly four destination shapes: three places and one absence', () => {
      // Asserted through the shipped request schema rather than through the
      // type, because a union member is invisible at runtime and this is what an
      // HTTP caller actually meets.
      for (const type of [
        'saved_address',
        'inline_shipping_address',
        'pickup',
        // #1015's, and the only one that is not a place. `checkout.service` is
        // what refuses it for a cart holding a physical line — a schema cannot
        // see a cart, which is the same split the actor rules take.
        'digital_delivery',
      ]) {
        const parsed = checkoutSchema.safeParse({ destination: { type } });
        // Each is REACHED — it fails on its own missing fields, never on the
        // discriminant. Without this the loop below would pass against a schema
        // that rejected all four.
        expect(
          JSON.stringify(parsed.error?.issues ?? []),
          `${type} is no longer a destination shape`,
        ).not.toContain('invalid_union_discriminator');
      }
      // Still refused, and `digital` among them: the admitted spelling is
      // `digital_delivery`, and a near-miss must not be quietly accepted.
      for (const type of ['digital', 'download', 'no_delivery', 'email']) {
        const parsed = checkoutSchema.safeParse({ destination: { type } });
        expect(parsed.success, `\`${type}\` is now an accepted destination`).toBe(false);
      }
    });
  });

  describe('order_address_snapshot — a placed order carries a real postal address', () => {
    it('replaces the five NOT NULLs with a CHECK that says MORE than they did', () => {
      // #1015 / ADR 0010 D8. The NOT NULLs are gone and this is not a weakening:
      // a NOT NULL could be satisfied by a fabricated street — which is exactly
      // what a digital order would have had to write — and
      // `orders_shipping_address_digital_check` cannot be. It requires all nine
      // address columns NULL on a `digital` order and the five required ones NOT
      // NULL on every other, so a `service` or an `event_admission` still has no
      // way to reach `orders` without inventing an address.
      const required = notNullColumns(orders);
      for (const column of [
        'shipping_address_recipient_name',
        'shipping_address_line1',
        'shipping_address_city',
        'shipping_address_postal_code',
        'shipping_address_country',
      ]) {
        expect(required, `orders.${column} is unexpectedly NOT NULL again`).not.toContain(column);
      }
      const checks = getTableConfig(orders).checks.map((check) => check.name);
      expect(
        checks,
        'the CHECK that replaced the five NOT NULLs is gone; `orders` now accepts an address-less order of ANY fulfilment kind',
      ).toContain('orders_shipping_address_digital_check');
      // The control: a column that was always nullable still is, so the negative
      // assertions above are reading `notNull` rather than an empty set.
      expect(required).not.toContain('shipping_address_line2');
      // And the positive control: `orders` still has NOT NULL columns at all.
      expect(required).toContain('order_number');
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
    it('admits exactly the physical methods plus `digital`', () => {
      // `digital` is #1015's, and `pickup` has been a non-shipping member since
      // #93 — so this tuple has been a FULFILMENT vocabulary under a legacy name
      // for as long as collection has existed. Still EXACT: a `performed` or a
      // `redeemed` member is how a service or a stored-value redemption would
      // arrive, and containment would welcome either silently.
      expect([...SHIPPING_METHODS]).toEqual(['standard', 'express', 'pickup', 'digital']);
    });

    it('admits the physical statuses plus `digitally_delivered`, and nothing else', () => {
      // Still EXACT, and `digitally_delivered` arrived HERE, in the diff that
      // admitted `digital_good` — which is what this assertion existed to force.
      // `activated`, `redeemed` and `performed` are still absent, and each is the
      // shape one of the REMAINING excluded types would arrive in.
      expect([...ORDER_STATUSES]).toEqual([
        'pending_payment',
        'paid',
        'processing',
        'shipped',
        'delivered',
        'digitally_delivered',
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
