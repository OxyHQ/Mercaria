/**
 * #110's forbidden-column gate: the eight buyer-request tables can hold no way
 * to identify a buyer.
 *
 * `db/schema/buyerRequests.ts` has cited THIS FILENAME since #110 landed —
 * "`BUYER_REQUEST_FORBIDDEN_IDENTIFIERS` names the prohibition as a value and
 * `buyer-request-forbidden-columns.test.ts` walks these tables against it" —
 * and the file did not exist (#354). Nothing walked those tables. The only
 * assertion on the constant anywhere was `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS
 * .length >= 10` in `buyer-request-isolation.test.ts`, which is a floor on the
 * LIST and says nothing about any column.
 *
 * A gate that does not exist but is described is worse than one that is simply
 * missing: the absent one invites a reviewer to look, and the described one
 * persuades them not to. So this is the walk, and the schema's sentence is now
 * true.
 *
 * Two layers, and the reason for each is in
 * `buyer-request-column-allowlist.ts`. What is worth reading HERE is the
 * liveness self-test: every prohibition is rebuilt into the column name it
 * exists to refuse and pushed through the SAME audit production runs, so a
 * token that cannot fire is a build failure rather than a line that reads as
 * protection. #354's whole subject is a gate whose self-test fed its matcher
 * hand-written literals the scan never receives.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { BUYER_REQUEST_FORBIDDEN_IDENTIFIERS } from '@mercaria/shared-types';
import {
  allowListedColumnCount,
  auditColumns,
  columnProhibition,
  prohibitionProbeColumn,
  schemaTableColumns,
} from '../../db/__tests__/column-allowlist.js';
import type { TableColumns } from '../../db/__tests__/column-allowlist.js';
import * as buyerRequestSchema from '../../db/schema/buyerRequests.js';
import {
  BUYER_REQUEST_COLUMN_ALLOWLIST,
  BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS,
  BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS,
} from './buyer-request-column-allowlist.js';

/** The eight tables, traversed from the MODULE rather than listed. */
function buyerRequestTables(): readonly TableColumns[] {
  return schemaTableColumns(buyerRequestSchema as Record<string, unknown>);
}

function audit(tables: readonly TableColumns[] = buyerRequestTables()) {
  return auditColumns(
    tables,
    BUYER_REQUEST_COLUMN_ALLOWLIST,
    BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS,
    BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS,
  );
}

describe('#110 — the buyer-request schema can hold no way to identify a buyer', () => {
  it('every column of every table is ALLOW-LISTED, and nothing else may exist', () => {
    const tables = buyerRequestTables();
    // Three vacuity floors, because a traversal that found nothing, an
    // allow-list that listed nothing and a table that lost its columns all
    // produce a clean audit.
    expect(tables.length).toBe(8);
    expect(BUYER_REQUEST_COLUMN_ALLOWLIST.length).toBe(8);
    expect(allowListedColumnCount(BUYER_REQUEST_COLUMN_ALLOWLIST)).toBeGreaterThanOrEqual(85);
    for (const { table, columns } of tables) {
      expect(columns.length, `${table} has no columns — did the traversal break?`).toBeGreaterThan(
        3,
      );
    }

    const result = audit(tables);
    // The deny layer first: it names the PROHIBITION a column falls under,
    // where `unlisted` says only that nobody has decided about it.
    expect(result.forbidden).toEqual([]);
    // A NEW COLUMN FAILS THE BUILD UNTIL SOMEBODY DECIDES IT IS ALLOWED. The
    // fix is a group whose REASON covers it, never a widened sentence.
    expect(result.unlistedTables).toEqual([]);
    expect(result.unlisted).toEqual([]);
    // And the reverse, so the list cannot rot into a standing permission for a
    // column that moved or was dropped.
    expect(result.missingTables).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('the traversal yields SQL identifiers, which is the defect this gate was born from', () => {
    // `column.name` is the TypeScript PROPERTY name; `@oxyhq/db` owns the
    // casing authority and drizzle converts at query time. A gate reading
    // `column.name` compares `buyer_email` to `buyerEmail` and cannot fire.
    for (const { table, columns } of buyerRequestTables()) {
      for (const column of columns) {
        expect(column, `${table}.${column} is not a SQL identifier`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }

    // And the two spellings really do differ here, so the assertion above is
    // not passing on a schema whose properties happen to be snake_case already
    // — which would make it a check that cannot fail.
    const differing: string[] = [];
    for (const value of Object.values(buyerRequestSchema as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      if (!(Symbol.for('drizzle:Name') in value)) continue;
      const table = value as Parameters<typeof getTableColumns>[0];
      for (const column of Object.values(getTableColumns(table))) {
        if (sqlColumnName(column) !== column.name) {
          differing.push(`${getTableName(table)}.${sqlColumnName(column)}`);
        }
      }
    }
    expect(differing.length).toBeGreaterThan(50);
    expect(differing).toContain('cancellation_requests.idempotency_key');
  });

  it('walks the tables against BUYER_REQUEST_FORBIDDEN_IDENTIFIERS itself', () => {
    // The schema docblock's actual claim. The constant names ten exact handles;
    // this asserts each is genuinely refused, so the constant is load-bearing
    // rather than decorative — while the deny-list stays broader than it, since
    // a leak arrives under a neighbouring name.
    expect(BUYER_REQUEST_FORBIDDEN_IDENTIFIERS.length).toBeGreaterThanOrEqual(10);
    for (const identifier of BUYER_REQUEST_FORBIDDEN_IDENTIFIERS) {
      expect(
        columnProhibition(
          `cancellation_requests.${identifier}`,
          BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS,
          BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS,
        ),
        `${identifier} is named as forbidden and nothing refuses it`,
      ).not.toBeNull();
    }

    // And each one goes red through the REAL audit, on a REAL table, which is
    // the walk the docblock describes.
    for (const identifier of BUYER_REQUEST_FORBIDDEN_IDENTIFIERS) {
      const mutated = buyerRequestTables().map((table) =>
        table.table === 'support_messages'
          ? { ...table, columns: [...table.columns, identifier] }
          : table,
      );
      expect(
        audit(mutated).forbidden.map((offence) => offence.column),
        `${identifier} passes the walk`,
      ).toContain(`support_messages.${identifier}`);
    }
  });

  it('EVERY prohibition can fire, through the real audit — the liveness self-test', () => {
    // Exhaustive by construction: each prohibition is rebuilt into the name it
    // exists to refuse and injected into a real table, and the assertion reads
    // the audit production runs. A token added later is proven the moment it is
    // added, rather than when somebody remembers to write it a probe.
    expect(BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS.length).toBeGreaterThanOrEqual(25);
    for (const entry of BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS) {
      const probe = prohibitionProbeColumn(entry);
      const mutated = buyerRequestTables().map((table) =>
        table.table === 'return_requests' ? { ...table, columns: [...table.columns, probe] } : table,
      );
      expect(
        audit(mutated).forbidden.map((offence) => offence.column),
        `the prohibition on ${entry.prohibition} cannot fire`,
      ).toContain(`return_requests.${probe}`);
    }
  });

  it('no prohibition is REDUNDANT — an entry another already covers is not protection', () => {
    // The other half of "what would this report if the thing it measures were
    // absent". A live-looking entry that some earlier one already catches can
    // never be the reason anything is refused, so removing it changes nothing —
    // and it reads to the next person as a decision somebody made.
    for (const entry of BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS) {
      const others = BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS.filter((candidate) => candidate !== entry);
      expect(
        columnProhibition(`t.${prohibitionProbeColumn(entry)}`, others),
        `the prohibition on ${entry.prohibition} is already covered by another`,
      ).toBeNull();
    }
  });

  it('fires on the names a buyer would actually be identified by', () => {
    // Written as the real violation would arrive: a column somebody adds while
    // wiring a notification, a support search or a "it is my card" reply.
    for (const probe of [
      'buyer_email',
      'contact_email',
      'reply_to_email',
      'buyer_email_hash',
      'buyer_phone',
      'recipient_name',
      'shipping_address_line1',
      'delivery_postcode',
      'client_ip_address',
      'card_last_four',
      'payment_method_fingerprint',
      'stripe_customer_id',
      'guest_session_id',
      'cart_session_token',
      'order_number',
    ]) {
      const mutated = buyerRequestTables().map((table) =>
        table.table === 'support_threads' ? { ...table, columns: [...table.columns, probe] } : table,
      );
      expect(
        audit(mutated).forbidden.map((offence) => offence.column),
        `${probe} should be refused by name`,
      ).toContain(`support_threads.${probe}`);
    }
  });

  it('fires on an INNOCUOUS unlisted column too — which is the whole inversion', () => {
    // A name no prohibition carries and no group lists. The deny-list says
    // nothing about it; the allow-list is what stops it. This is the half a
    // deny-list can never have.
    const mutated = buyerRequestTables().map((table) =>
      table.table === 'return_request_lines'
        ? { ...table, columns: [...table.columns, 'restock_location'] }
        : table,
    );
    const result = audit(mutated);
    expect(result.forbidden).toEqual([]);
    expect(result.unlisted).toContain('return_request_lines.restock_location');

    // A whole new table is refused the same way.
    const withNewTable = audit([
      ...buyerRequestTables(),
      { table: 'buyer_request_contacts', columns: ['id'] },
    ]);
    expect(withNewTable.unlistedTables).toContain('buyer_request_contacts');
  });

  it('fires on an allow-list entry with no column behind it', () => {
    const result = auditColumns(
      buyerRequestTables(),
      [
        ...BUYER_REQUEST_COLUMN_ALLOWLIST,
        {
          table: 'support_messages',
          groups: [{ reason: 'x'.repeat(40), columns: ['author_email'] }],
        },
      ],
      BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS,
      BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS,
    );
    // Named on the allow-list, absent from the schema — and the deny layer sees
    // it anyway, which is what stops a forbidden name being admitted by being
    // written down.
    expect(result.missing).toContain('support_messages.author_email');
    expect(result.forbidden.map((offence) => offence.column)).toContain(
      'support_messages.author_email',
    );
  });

  it('permits the columns the domain is built on', () => {
    // The mirror of the liveness test. A prohibition refusing these would ban
    // the actor triples, the order pointer and the refund pointer #110 needs —
    // and `ship_back_deadline_at` is the one to read: `ship` is not `shipping`,
    // which is why matching is by SEGMENT and not by substring.
    for (const probe of [
      'order_id',
      'refund_id',
      'requested_by_actor_kind',
      'requested_by_oxy_user_id',
      'requested_by_grant_id',
      'ship_back_deadline_at',
      'return_instructions',
      'idempotency_key',
      'completion_failure',
      'redactions',
    ]) {
      expect(
        columnProhibition(
          `return_requests.${probe}`,
          BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS,
          BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS,
        ),
        `${probe} must be permitted`,
      ).toBeNull();
    }
  });

  it('every allow-listed group states a reason, and no column is listed twice', () => {
    const seen = new Set<string>();
    for (const allowance of BUYER_REQUEST_COLUMN_ALLOWLIST) {
      expect(allowance.groups.length, `${allowance.table} has no groups`).toBeGreaterThan(0);
      for (const group of allowance.groups) {
        expect(group.reason.length, `${allowance.table} has a group with no reason`).toBeGreaterThan(
          30,
        );
        expect(group.columns.length, `${allowance.table} has an empty group`).toBeGreaterThan(0);
        for (const column of group.columns) {
          const qualified = `${allowance.table}.${column}`;
          expect(seen.has(qualified), `${qualified} is listed twice`).toBe(false);
          seen.add(qualified);
        }
      }
    }
  });

  it('the exemption list is EXACTLY empty', () => {
    // A ceiling rather than an exact count is the gate switching itself off one
    // defensible line at a time.
    expect(BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS.length).toBe(0);
  });
});
