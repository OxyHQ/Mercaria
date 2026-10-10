/**
 * A `Date` interpolated straight into a `sql` template reaches the driver.
 *
 * drizzle replaces postgres.js's date serializers with the identity, because its
 * column mappers hand the driver strings. A raw `${date}` inside `sql` bypasses
 * those mappers, and Node's postgres.js then refuses the statement
 * (`The "string" argument must be of type string … Received an instance of
 * Date`). That is how the ingestion dispatcher's claim failed on every tick in
 * production the first time it ran. `connectPostgres` serializes them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('a raw Date bound in a sql template', () => {
  it('is sent as the instant it names', async () => {
    const at = new Date('2025-03-04T05:06:07.089Z');
    const rows = await db.execute<{ iso: string }>(
      sql`select to_char(${at}::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as iso`,
    );
    expect(rows[0]?.iso).toBe('2025-03-04T05:06:07.089Z');
  });

  it('works where the ingestion claim uses it: coalesce against a timestamptz column', async () => {
    const at = new Date('2025-03-04T05:06:07.000Z');
    const rows = await db.execute<{ same: boolean }>(
      sql`select coalesce(null::timestamptz, ${at}) = ${at.toISOString()}::timestamptz as same`,
    );
    expect(rows[0]?.same).toBe(true);
  });
});
