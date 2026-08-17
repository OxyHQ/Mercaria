/**
 * The two key-shape CHECKs #477 repaired, against a REAL Postgres server.
 *
 * Both reached production with a bare `.` where a literal dot was meant, so both
 * admitted exactly what they exist to refuse. A mocked `insert` accepts any
 * statement, including one the server rejects outright — and more to the point
 * here, it accepts one the server ACCEPTS when it should not, which is the
 * direction this defect failed in. Only a server settles it.
 *
 * ## What makes each case non-vacuous
 *
 * Every refusal asserts the SPECIFIC constraint name off the driver error. A
 * bare "the insert threw" would be satisfied by a NOT NULL, a unique index or a
 * typo in the fixture, so it would pass while measuring nothing about the shape
 * check at all.
 *
 * Every block also carries POSITIVE controls — the legitimate values that must
 * still be accepted. Without them a constraint of `false` passes every refusal
 * case in the file, and so does a table that does not exist.
 *
 * ## Scoping, because the test database is SHARED across parallel files
 *
 * Every accepted fixture is suffixed with a per-run token and teardown deletes
 * only the ids this file created. The refused ones need no scoping: they never
 * become rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { productTypeDefinitions } from '../schema/productTypes.js';
import { awinAccounts, awinAdvertisers } from '../schema/awin.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();

const definitionIds: string[] = [];
const advertiserIds: string[] = [];
const accountIds: string[] = [];

/**
 * The write was refused, and refused by the constraint this case NAMES.
 *
 * drizzle wraps the driver failure in a `Failed query: …` message of its own, so
 * both the SQLSTATE and the constraint name live on the CAUSE. Matching the
 * top-level message would pass against ANY refusal — which is the assertion that
 * cannot tell one failure from another.
 */
async function expectRefusedBy(constraint: string, run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught, `the write SUCCEEDED; ${constraint} did not fire`).toBeDefined();
  const cause = (caught as { cause?: { code?: string; constraint_name?: string } }).cause;
  expect(cause?.code, `expected a CHECK violation (23514), got: ${String(caught)}`).toBe('23514');
  expect(cause?.constraint_name, `refused, but by the wrong constraint: ${String(caught)}`).toBe(
    constraint,
  );
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  if (advertiserIds.length > 0) {
    await db.delete(awinAdvertisers).where(inArray(awinAdvertisers.id, advertiserIds));
  }
  if (accountIds.length > 0) {
    await db.delete(awinAccounts).where(inArray(awinAccounts.id, accountIds));
  }
  if (definitionIds.length > 0) {
    await db.delete(productTypeDefinitions).where(inArray(productTypeDefinitions.id, definitionIds));
  }
  await closePostgres();
});

describe('product_type_definitions_key_shape_check', () => {
  /**
   * The separators the bare `.` admitted.
   *
   * `foo bar` and `foo/bar` are the two the issue names. The rest are here
   * because the defect was never about those two characters — a wildcard admits
   * every character, so a fix that special-cased a space and a slash would look
   * identical to a correct one on the issue's own examples.
   */
  it.each([
    ['a space', 'foo bar'],
    ['a slash', 'foo/bar'],
    ['an at sign', 'foo@bar'],
    ['a newline', 'foo\nbar'],
    ['a tab', 'foo\tbar'],
    ['an uppercase letter as the separator', 'fooXbar'],
  ])('refuses %s in a key', async (_label, key) => {
    await expectRefusedBy('product_type_definitions_key_shape_check', () =>
      db.insert(productTypeDefinitions).values({ key, version: 1, name: 'refused' }),
    );
  });

  it.each([
    ['a trailing dot', 'foo.'],
    ['a leading dot', '.foo'],
    ['a leading digit', '1foo'],
    ['a segment starting with a digit', 'foo.1bar'],
    ['an empty segment', 'foo..bar'],
    ['an empty key', ''],
  ])('still refuses %s, which the broken pattern also refused', async (_label, key) => {
    // These were refused before #477 too. They are here so a regression that
    // loosened the pattern in some OTHER direction while fixing the dot is
    // visible — the anchors and the leading-letter rule are part of the shape.
    await expectRefusedBy('product_type_definitions_key_shape_check', () =>
      db.insert(productTypeDefinitions).values({ key, version: 1, name: 'refused' }),
    );
  });

  // POSITIVE CONTROLS. Without these the refusals above are satisfied by a
  // constraint that rejects everything, and by a broken fixture.
  it.each([
    ['a plain key', 'smartphone'],
    ['a snake_case key', 'athletic_footwear'],
    ['a dotted namespace', 'electronics.phones.smartphone'],
    ['digits after the first character', 'a1_b2.c3'],
  ])('accepts %s', async (_label, key) => {
    // Scoped by extending the FIRST segment, so the case's own shape survives:
    // a plain key stays plain and a dotted one keeps its dots. Appending a
    // `.<RUN>` segment instead would make every case dotted, and the "plain
    // key" row would silently stop testing a plain key.
    //
    // The `r` before the token is load-bearing: `RUN` is hex and may begin with
    // a digit, and every segment must start with a letter. The first spelling
    // of this file did not, and the constraint refused it — which is the
    // positive control doing its job on its first run.
    const scoped = key.replace(/^[a-z][a-z0-9_]*/u, (segment) => `${segment}_r${RUN}`);
    expect(scoped.includes('.'), 'scoping changed the shape under test').toBe(key.includes('.'));

    const [row] = await db
      .insert(productTypeDefinitions)
      .values({ key: scoped, version: 1, name: 'accepted' })
      .returning();
    definitionIds.push(row.id);
    expect(row.key).toBe(scoped);
  });
});

describe('awin_advertisers_declared_host_shape_check', () => {
  let accountId: string;

  beforeAll(async () => {
    const [account] = await db
      .insert(awinAccounts)
      .values({ publisherId: `477${RUN.replace(/\D/gu, '') || '1'}`, label: `#477 ${RUN}` })
      .returning();
    accountIds.push(account.id);
    accountId = account.id;
  });

  /** A counter, because `(account_id, advertiser_id)` is unique. */
  let seq = 0;
  const advertiserId = (): string => String(477_000 + (seq += 1));

  it.each([
    ['a separator-less host', 'axcom'],
    ['a space as the separator', 'example com'],
    ['a slash as the separator', 'example/com'],
    ['a scheme', 'https://example.com'],
    ['a port', 'example.com:8080'],
    ['a path', 'example.com/a'],
  ])('refuses %s', async (_label, declaredHost) => {
    await expectRefusedBy('awin_advertisers_declared_host_shape_check', () =>
      db.insert(awinAdvertisers).values({
        accountId,
        advertiserId: advertiserId(),
        displayName: 'refused',
        declaredHost,
      }),
    );
  });

  // POSITIVE CONTROLS.
  it.each([
    ['an apex domain', 'apple.com'],
    ['a subdomain', 'shop.apple.com'],
    ['a hyphenated label', 'my-shop.example.co.uk'],
  ])('accepts %s', async (_label, declaredHost) => {
    const [row] = await db
      .insert(awinAdvertisers)
      .values({
        accountId,
        advertiserId: advertiserId(),
        displayName: 'accepted',
        declaredHost,
      })
      .returning();
    advertiserIds.push(row.id);
    expect(row.declaredHost).toBe(declaredHost);
  });

  it('accepts a NULL host, which is the ordinary state', async () => {
    const [row] = await db
      .insert(awinAdvertisers)
      .values({ accountId, advertiserId: advertiserId(), displayName: 'accepted' })
      .returning();
    advertiserIds.push(row.id);
    expect(row.declaredHost).toBeNull();
  });
});
