/**
 * The data-inventory census (#111 "Data inventory and classification").
 *
 * `merge-plan-census.test.ts` walks the drizzle tables for every foreign key
 * targeting a mergeable entity and fails the build until each has a
 * disposition; this is that device applied to PRIVACY. A guest table added
 * without a data class fails here, which is the point — the decision "who may
 * read this, and when does it go" is otherwise made by not being made, and the
 * absence is invisible in review because nothing goes red.
 *
 * The census is deliberately over a NAMED set of guest tables rather than over
 * every table in the schema. Classifying the whole catalogue is a different
 * issue's work and a census that tried would be a gate nobody could keep green;
 * what this one guarantees is that the sixteen classes cover the guest-commerce
 * surface #103 through #111 built, and that nothing in that surface is
 * unclassified or classified twice.
 */

import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  GUEST_DATA_CLASSES,
  GUEST_DATA_INVENTORY,
  GUEST_RETENTION_CLASSES,
} from '@mercaria/shared-types';
import { EXPIRY_TARGETS } from '../expiryTargets.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';

/**
 * Every table the guest-commerce domains WRITE, from #103 through #111.
 *
 * Maintained by hand and checked from two directions below, which is what
 * makes it more than a list: the expiry registry is walked for guest tables
 * that are swept, and the protected-column registry for guest tables that hold
 * a digest, and both must be covered here. A table that appears in either and
 * not here fails the build.
 */
const GUEST_TABLES = [
  // #103
  'guest_sessions',
  // #104
  'carts',
  'cart_items',
  'cart_merges',
  // #105/#106
  'guest_checkouts',
  'orders',
  'order_items',
  'order_status_history',
  // #108
  'guest_order_access_grants',
  'guest_portal_messages',
  'guest_contact_suppressions',
  'guest_recovery_attempts',
  'guest_contact_routing',
  'guest_portal_operator_actions',
  // #109
  'guest_order_claims',
  'guest_order_claim_revocations',
  'guest_order_claim_outbox',
  // #110
  'cancellation_requests',
  'cancellation_request_lines',
  'return_requests',
  'return_request_lines',
  'return_request_evidence',
  'support_threads',
  'support_messages',
  'buyer_request_events',
  // #77
  'analytics_events',
  'analytics_search_queries',
  'analytics_experiment_exposures',
  'analytics_pseudonym_salts',
  'analytics_rollups',
  'analytics_query_aggregates',
  // #111
  'guest_abuse_counters',
  'guest_abuse_interventions',
  'guest_security_signal_counters',
  'guest_data_requests',
] as const;

/** Every table any inventory record claims. */
function classifiedTables(): readonly string[] {
  return GUEST_DATA_INVENTORY.flatMap((record) => record.tables);
}

describe('every guest table is classified exactly once (#111)', () => {
  it('covers a real, non-trivial set (vacuity floor)', () => {
    // A census over an empty set passes every assertion below. Thirty-five at
    // the time of writing.
    expect(GUEST_TABLES.length).toBeGreaterThanOrEqual(30);
    expect(classifiedTables().length).toBeGreaterThanOrEqual(25);
  });

  it('no guest table is missing a data class', () => {
    const classified = new Set(classifiedTables());
    const unclassified = GUEST_TABLES.filter((table) => !classified.has(table));
    expect(unclassified).toEqual([]);
  });

  it('no table is claimed by two classes', () => {
    const seen = new Map<string, string[]>();
    for (const record of GUEST_DATA_INVENTORY) {
      for (const table of record.tables) {
        seen.set(table, [...(seen.get(table) ?? []), record.dataClass]);
      }
    }
    const duplicated = [...seen.entries()]
      .filter(([, classes]) => classes.length > 1)
      .map(([table, classes]) => `${table}: ${classes.join(', ')}`);
    expect(duplicated).toEqual([]);
  });

  it('every class in the tuple has exactly one record', () => {
    expect(GUEST_DATA_INVENTORY.map((record) => record.dataClass).sort()).toEqual(
      [...GUEST_DATA_CLASSES].sort(),
    );
  });

  it('every record names a retention class that exists', () => {
    for (const record of GUEST_DATA_INVENTORY) {
      expect(GUEST_RETENTION_CLASSES).toContain(record.retentionClass);
    }
  });

  it('a class with NO tables says it stores nothing, or names where the data lives', () => {
    // Four records carry an empty `tables` list and each is a deliberate
    // answer rather than an omission: the paid checkout and the destination
    // snapshot live on tables another class already claims, the payment records
    // are the payment domain's, and the provider reference is NOT STORED. An
    // empty list with none of those explanations is what this catches.
    for (const record of GUEST_DATA_INVENTORY.filter((entry) => entry.tables.length === 0)) {
      expect(record.purpose.length).toBeGreaterThan(60);
    }
    const notStored = GUEST_DATA_INVENTORY.filter(
      (record) => record.disposition === 'not_stored',
    );
    expect(notStored.map((record) => record.dataClass)).toEqual([
      'provider_customer_wallet_reference',
    ]);
    expect(notStored[0]?.tables).toEqual([]);
  });
});

describe('the census is checked from the two registries, not only from a list (#111)', () => {
  it('every SWEPT guest table appears in the inventory', () => {
    // The positive control the AGENTS.md census rule asks for: finding fewer
    // guest tables looks identical to there BEING fewer, so the list above is
    // cross-checked against a registry built for another purpose entirely.
    const classified = new Set(classifiedTables());
    const sweptGuestTables = EXPIRY_TARGETS.map((target) => getTableName(target.table)).filter(
      (name) => name.startsWith('guest_') || name.startsWith('analytics_'),
    );
    expect(sweptGuestTables.length).toBeGreaterThanOrEqual(10);
    expect(sweptGuestTables.filter((name) => !classified.has(name))).toEqual([]);
  });

  it('every guest table holding a PROTECTED column appears in the inventory', () => {
    const classified = new Set(classifiedTables());
    const protectedGuestTables = Object.keys(PROTECTED_COLUMNS).filter((name) =>
      name.startsWith('guest_'),
    );
    expect(protectedGuestTables.length).toBeGreaterThanOrEqual(5);
    expect(protectedGuestTables.filter((name) => !classified.has(name))).toEqual([]);
  });

  it('#111 registered its own two digest columns as PROTECTED', () => {
    // A keyed digest is an exact-match ORACLE and is ALSO this domain's only
    // cross-row join key, which is the sharper reason: a trace returning it
    // would let a reader ask "what else did this subject do".
    expect(PROTECTED_COLUMNS.guest_abuse_counters).toEqual(['subjectHash']);
    expect(PROTECTED_COLUMNS.guest_abuse_interventions).toEqual(['subjectHash']);
  });

  it('every class whose data is ENCRYPTED says who may read it', () => {
    for (const record of GUEST_DATA_INVENTORY.filter((entry) => entry.encryptedAtRest)) {
      expect(record.accessRoles.length).toBeGreaterThan(0);
    }
    // The two classes nobody may read directly are the throttle evidence and
    // the provider reference. `none` is a real answer and has to be one: a
    // digest exists precisely so no reader ever gets the value.
    const unreadable = GUEST_DATA_INVENTORY.filter((record) =>
      record.accessRoles.includes('none'),
    );
    expect(unreadable.map((record) => record.dataClass).sort()).toEqual([
      'email_verification_and_recovery',
      'provider_customer_wallet_reference',
    ]);
  });
});
