/**
 * `0161` against LEGACY rows: the place facts leave, and a publication with no
 * GoWay place is withdrawn rather than left looking live (ADR 0013).
 *
 * A database of its own, migrated only THROUGH `0160` — the schema the
 * previous image served — so rows can be written the way that image wrote
 * them: a publication with its own name, address, pin, hours and closures, a
 * listing with a Mongo-era point. Then `0161` is applied in the `post` phase
 * of the release that shipped it, and `0162` in the `pre` phase of the next
 * one, through the real entrypoint — the planner refuses a `pre` queued behind
 * an unapplied `post` in one run, which is what "two releases" means — and what
 * survives is read back off the server.
 *
 * Every other suite runs on a fully migrated database, where none of these
 * rows can be written at all — which is exactly why a post migration's data
 * handling has to be proven here or nowhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  applyMigrations,
  applyMigrationsThrough,
  createMercariaTestDatabaseThrough,
  dropMercariaTestDatabase,
} from '../testDatabase.js';

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

/** The last migration the previous image's schema had. */
const BEFORE = '0160_bitter_sharon_carter';
/** The post migration under test — the last of its own release. */
const AFTER = '0161_shocking_korvac';

let databaseUrl: string;
let client: postgres.Sql;

/** The legacy fixture's ids, chosen so the assertions read as prose. */
const STORE = 'store-legacy';
const UNLINKED = 'location-unlinked';
const LINKED = 'location-linked';
const DRAFT = 'location-draft';
const LISTING = 'listing-legacy';

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabaseThrough(ADMIN_URL, BEFORE);
  client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });

  await client`
    insert into stores (id, oxy_account_id, handle, name, description, brand_color)
    values (${STORE}, 'oxy-owner', 'legacy-store', 'Legacy store', '', '#000000')
  `;
  await client`
    insert into locations (id, store_id, name, type, go_way_place_id)
    values (${UNLINKED}, ${STORE}, 'Shop with only its own pin', 'retail', null),
           (${LINKED}, ${STORE}, 'Shop already linked', 'retail', 'place-linked'),
           (${DRAFT}, ${STORE}, 'Shop never published', 'retail', null)
  `;
  // The previous image's publication: every place fact a column of its own.
  for (const [locationId, state] of [
    [UNLINKED, 'published'],
    [LINKED, 'published'],
    [DRAFT, 'draft'],
  ] as const) {
    await client`
      insert into location_publications (
        id, location_id, store_id, display_name, public_city, public_country, timezone,
        public_phone, accessibility_step_free, latitude, longitude, geocode_provenance,
        geocoded_at, publication_state, pickup_offered, inventory_source,
        stock_confirmation_interval_seconds
      ) values (
        ${`publication-${locationId}`}, ${locationId}, ${STORE}, 'Llibreria', 'Barcelona', 'ES',
        'Europe/Madrid', '+34 931 000 000', true, 41.4036, 2.1744, 'merchant_map_pin',
        now(), ${state}, true, 'pos', 3600
      )
    `;
  }
  await client`
    insert into location_opening_hours (id, publication_id, weekday, opens_minute, closes_minute)
    values ('hours-1', ${`publication-${UNLINKED}`}, 1, 540, 1200)
  `;
  await client`
    insert into location_closures (id, publication_id, from_date, through_date, note)
    values ('closure-1', ${`publication-${UNLINKED}`}, '2026-08-01', '2026-08-02', 'Refit')
  `;
  await client`
    insert into listings (id, owner_type, store_id, title, description, condition, condition_assertion, status, longitude, latitude)
    values (${LISTING}, 'store', ${STORE}, 'Legacy listing', 'x', 'new', 'seller_declared', 'active', 2.17, 41.38)
  `;

  // 0161's release, post phase; then the next release's pre phase (0162).
  await applyMigrationsThrough(databaseUrl, AFTER, 'post');
  await applyMigrations(databaseUrl, 'pre');
}, 300_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  if (databaseUrl) await dropMercariaTestDatabase(databaseUrl);
});

async function stateOf(locationId: string): Promise<string> {
  const [row] = await client`
    select publication_state from location_publications where location_id = ${locationId}
  `;
  return String(row.publication_state);
}

describe('0161 on rows the previous image wrote', () => {
  it('WITHDRAWS a published location that names no GoWay place, and says why', async () => {
    expect(await stateOf(UNLINKED)).toBe('withdrawn');
    const events = await client`
      select kind, previous_state, next_state, note, actor_oxy_user_id
      from location_publication_events
      where publication_id = ${`publication-${UNLINKED}`}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'state_withdrawn',
      previous_state: 'published',
      next_state: 'withdrawn',
      actor_oxy_user_id: null,
    });
    expect(String(events[0].note)).toMatch(/names no GoWay place/);
  });

  it('leaves a LINKED location published — whether its place vouches for it is derived, not migrated', async () => {
    expect(await stateOf(LINKED)).toBe('published');
    const events = await client`
      select 1 from location_publication_events where publication_id = ${`publication-${LINKED}`}
    `;
    expect(events).toHaveLength(0);
  });

  it('leaves an unpublished location alone', async () => {
    expect(await stateOf(DRAFT)).toBe('draft');
  });

  it('then 0162 records who WAS published — the withdrawn one included — so the public read answers 410, not 404', async () => {
    const rows = await client`
      select location_id, published_at from location_publications
      where location_id in (${UNLINKED}, ${LINKED}, ${DRAFT})
    `;
    const publishedAt = new Map(rows.map((row) => [String(row.location_id), row.published_at]));
    // Withdrawn by 0161: its trail says it left `published`.
    expect(publishedAt.get(UNLINKED)).toBeInstanceOf(Date);
    // Published now, with no trail entry (written by the previous image's rows).
    expect(publishedAt.get(LINKED)).toBeInstanceOf(Date);
    expect(publishedAt.get(DRAFT)).toBeNull();
  });

  it('keeps every commerce fact of the publication', async () => {
    const [row] = await client`
      select pickup_offered, inventory_source, stock_confirmation_interval_seconds
      from location_publications where location_id = ${UNLINKED}
    `;
    expect(row).toMatchObject({
      pickup_offered: true,
      inventory_source: 'pos',
      stock_confirmation_interval_seconds: 3600,
    });
  });

  it('drops every place fact: the columns, the two child tables and the legacy points', async () => {
    const columns = await client`
      select table_name, column_name from information_schema.columns
      where table_name in ('location_publications', 'location_publication_events', 'listings', 'seller_listing_drafts')
    `;
    const present = new Set(columns.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
    expect(present.size, 'read no columns — a broken read, not a pass').toBeGreaterThan(40);
    for (const dropped of [
      'location_publications.display_name',
      'location_publications.public_country',
      'location_publications.timezone',
      'location_publications.public_phone',
      'location_publications.accessibility_step_free',
      'location_publications.latitude',
      'location_publications.geo_point',
      'location_publications.profile_confirmed_at',
      'location_publication_events.previous_latitude',
      'listings.longitude',
      'listings.latitude',
      'listings.geo',
      'seller_listing_drafts.location_opt_in',
      'seller_listing_drafts.location_latitude',
    ]) {
      expect(present.has(dropped), `${dropped} survived 0161`).toBe(false);
    }
    // Positive controls: what 0160 added, and what was never a place fact.
    expect(present.has('location_publication_events.next_go_way_place_id')).toBe(true);
    expect(present.has('location_publications.publication_state')).toBe(true);

    const tables = await client`
      select table_name from information_schema.tables
      where table_name in ('location_opening_hours', 'location_closures')
    `;
    expect(tables).toHaveLength(0);

    const [listing] = await client`select title from listings where id = ${LISTING}`;
    expect(listing.title).toBe('Legacy listing');
  });
});
