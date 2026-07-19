/**
 * Customer DTOs for the Mercaria store-admin commerce surface (B5).
 *
 * A `Customer` is a STORE-SCOPED buyer record: the people who have bought from a
 * store, whether through the online storefront or in-store at the POS. A customer
 * may be backed by an Oxy account (`oxyUserId`) or be a WALK-IN (`isWalkIn`,
 * no Oxy account) created at the register. Lifetime aggregates (`stats`) move in
 * lockstep with real paid orders — `orderCount`/`totalSpent` are bumped when a
 * store order is paid. Customers are not global Oxy identities; the same Oxy user
 * has one customer record PER store they buy from.
 */

import type { Timestamps } from './common';
import type { Money } from './money';
import type { AddressSnapshot } from './order';

/** A store-scoped buyer record (Oxy-backed or a walk-in). */
export interface Customer extends Timestamps {
  /** Stable customer id. */
  id: string;
  /** The store that owns this customer record. */
  storeId: string;
  /** Backing Oxy account id, when the customer has one (absent for walk-ins). */
  oxyUserId?: string;
  /** Whether this is a walk-in customer (no Oxy account). */
  isWalkIn: boolean;
  /** Display name shown in the admin (falls back to the Oxy profile when absent). */
  displayName?: string;
  /** Contact email, when known. */
  email?: string;
  /** Contact phone, when known. */
  phone?: string;
  /** A default shipping/contact address snapshot, when one was captured. */
  defaultAddress?: AddressSnapshot;
  /** Free-form tags applied by the store (e.g. `vip`, `wholesale`). */
  tags: string[];
  /** Customer-group tags, used for discount group eligibility. */
  groupTags: string[];
  /** Lifetime aggregates, kept in lockstep with paid orders. */
  stats: {
    /** Number of paid orders this customer has placed at the store. */
    orderCount: number;
    /**
     * Lifetime spend across paid orders, in the store's SHOP currency (its
     * `defaultCurrency`). Always single-currency — a customer's orders all settle
     * in the one store currency, so this aggregate never mixes currencies (it is
     * the shop side of each order's grand total, never the buyer's presentment).
     */
    totalSpent: Money;
    /** ISO-8601 time of the customer's most recent paid order, when any. */
    lastOrderAt?: string;
  };
  /** Internal store note about the customer. */
  notes?: string;
}

/** Payload accepted when creating a customer. */
export interface CreateCustomerInput {
  /** Backing Oxy account id, when relating an existing Oxy user. */
  oxyUserId?: string;
  /** Display name shown in the admin. */
  displayName?: string;
  /** Contact email. */
  email?: string;
  /** Contact phone. */
  phone?: string;
  /** A default address snapshot to capture. */
  defaultAddress?: AddressSnapshot;
  /** Free-form tags to apply. */
  tags?: string[];
  /** Customer-group tags to apply. */
  groupTags?: string[];
  /** Internal store note. */
  notes?: string;
}

/** Partial payload accepted when updating a customer. */
export type UpdateCustomerInput = Partial<CreateCustomerInput>;
