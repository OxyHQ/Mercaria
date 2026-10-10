/**
 * The commerce-platform release, deployed ONCE, against LEGACY rows: `0158`,
 * `0159` and `0160` in its `pre` phase, `0161` and `0162` in its `post` phase.
 *
 * A database of its own, migrated only THROUGH `0157` — the ledger production
 * holds before this release, the schema the previous image served — so rows
 * can be written the way that image wrote them: a store whose owner is a
 * `store_members` row, a publication with its own name, address, pin, hours
 * and closures, a listing with a legacy point. Then the release is deployed
 * through the real migration runner, with the journal prefix that this release
 * shipped (later releases must not enter this historical rollout):
 *
 *  1. `--phase=pre` while the previous image still serves;
 *  2. the ROLLOUT WINDOW — the previous image keeps writing (a store created
 *     through `store_members`, a location published without `published_at`)
 *     and the new one starts (a merchant links a GoWay place);
 *  3. `--phase=post` once the new image is live.
 *
 * The planner refuses a `pre` queued behind an unapplied `post` in one run, so
 * every `pre` of the release sits ahead of every `post` in the journal; one
 * `pre` run and one `post` run apply all five, and this is what proves it.
 *
 * Every other suite runs on a fully migrated database, where none of these
 * rows can be written at all — which is exactly why a post migration's data
 * handling has to be proven here or nowhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  applyMigrationsThrough,
  createMercariaTestDatabaseThrough,
  dropMercariaTestDatabase,
} from '../testDatabase.js';

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

/** The last migration production holds before this release. */
const BEFORE = '0157_bright_scrambler';

let databaseUrl: string;
let client: postgres.Sql;

/** The legacy fixture's ids, chosen so the assertions read as prose. */
const STORE = 'store-legacy';
const ROLLOUT_STORE = 'store-created-during-rollout';
const UNLINKED = 'location-unlinked';
const LINKED = 'location-linked';
const DRAFT = 'location-draft';
const ROLLOUT_PUBLISHED = 'location-published-during-rollout';
const LISTING = 'listing-legacy';

const FIRST_OWNER = 'oxy-owner-first';
const SECOND_OWNER = 'oxy-owner-second';
const ADMIN = 'oxy-admin-with-store-manage';
const STAFF = 'oxy-staff-defaults';
const ROLLOUT_OWNER = 'oxy-owner-rollout';

/** The retired role matrix `0161` measures "non-default" against. */
const OWNER_DEFAULTS = [
  'store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write',
  'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read',
  'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write',
  'refunds:write', 'channels:write', 'analytics:read',
];
const ADMIN_DEFAULTS = OWNER_DEFAULTS.filter((p) => p !== 'store:manage');
const STAFF_DEFAULTS = [
  'products:read', 'products:write', 'inventory:write', 'orders:read', 'orders:fulfill',
  'stats:read', 'customers:read', 'customers:write', 'draft_orders:write',
];

/** When the previous image published `ROLLOUT_PUBLISHED`, during the rollout. */
const ROLLOUT_PUBLISHED_AT = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);

/** `published_at` per location, read right after the `pre` phase. */
let publishedAtAfterPre: Map<string, Date | null>;
/** `stores.oxy_account_id` per store, read right after the `pre` phase. */
let ownerAfterPre: Map<string, string | null>;
/** The ledger's tags after the `pre` phase, and whether `store_members` survived it. */
let ledgerAfterPre: number;
let storeMembersAfterPre: boolean;

async function insertMember(storeId: string, oxyUserId: string, role: string, permissions: string[], joinedAt: string) {
  await client`
    insert into store_members (id, store_id, oxy_user_id, role, permissions, joined_at)
    values (${`member-${storeId}-${oxyUserId}`}, ${storeId}, ${oxyUserId}, ${role}, ${permissions}, ${joinedAt})
  `;
}

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabaseThrough(ADMIN_URL, BEFORE);
  client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });

  // ── The previous image's rows ───────────────────────────────────────────────
  await client`
    insert into stores (id, handle, name, description, brand_color)
    values (${STORE}, 'legacy-store', 'Legacy store', '', '#000000')
  `;
  // A second `owner` who joined LATER, so the earliest one must win.
  await insertMember(STORE, SECOND_OWNER, 'owner', OWNER_DEFAULTS, '2025-02-01T00:00:00Z');
  await insertMember(STORE, FIRST_OWNER, 'owner', OWNER_DEFAULTS, '2025-01-01T00:00:00Z');
  await insertMember(STORE, ADMIN, 'admin', [...ADMIN_DEFAULTS, 'store:manage'], '2025-03-01T00:00:00Z');
  await insertMember(STORE, STAFF, 'staff', STAFF_DEFAULTS, '2025-04-01T00:00:00Z');

  await client`
    insert into locations (id, store_id, name, type)
    values (${UNLINKED}, ${STORE}, 'Shop with only its own pin', 'retail'),
           (${LINKED}, ${STORE}, 'Shop the merchant links during the rollout', 'retail'),
           (${DRAFT}, ${STORE}, 'Shop never published', 'retail'),
           (${ROLLOUT_PUBLISHED}, ${STORE}, 'Shop published during the rollout', 'retail')
  `;
  // The previous image's publication: every place fact a column of its own.
  for (const [locationId, state] of [
    [UNLINKED, 'published'],
    [LINKED, 'published'],
    [DRAFT, 'draft'],
    [ROLLOUT_PUBLISHED, 'draft'],
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

  // ── Migrate (pre), while the previous image still serves ────────────────────
  await applyMigrationsThrough(databaseUrl, '0162_naive_gauntlet', 'pre');

  const publications = await client`select location_id, published_at from location_publications`;
  publishedAtAfterPre = new Map(publications.map((row) => [String(row.location_id), row.published_at as Date | null]));
  const stores = await client`select id, oxy_account_id from stores`;
  ownerAfterPre = new Map(stores.map((row) => [String(row.id), row.oxy_account_id as string | null]));
  const [ledger] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
  ledgerAfterPre = Number(ledger.n);
  storeMembersAfterPre =
    (await client`select 1 from information_schema.tables where table_name = 'store_members'`).length === 1;

  // ── The rollout window ──────────────────────────────────────────────────────
  // The previous image creates a store the only way it knows: no owning
  // account, an `owner` member row.
  await client`
    insert into stores (id, handle, name, description, brand_color)
    values (${ROLLOUT_STORE}, 'rollout-store', 'Rollout store', '', '#000000')
  `;
  await insertMember(ROLLOUT_STORE, ROLLOUT_OWNER, 'owner', OWNER_DEFAULTS, '2025-06-01T00:00:00Z');
  // ...and publishes a location the way it always did: state and trail, no
  // `published_at`, which it has never heard of.
  await client`
    update location_publications set publication_state = 'published', updated_at = ${ROLLOUT_PUBLISHED_AT}
    where location_id = ${ROLLOUT_PUBLISHED}
  `;
  await client`
    insert into location_publication_events (id, publication_id, kind, previous_state, next_state, occurred_at)
    values ('event-rollout-published', ${`publication-${ROLLOUT_PUBLISHED}`}, 'published', 'draft', 'published',
            ${ROLLOUT_PUBLISHED_AT})
  `;
  // The new image is live: a merchant links one location to its GoWay place.
  await client`update locations set go_way_place_id = 'place-linked' where id = ${LINKED}`;

  // ── Migrate (post), once the new image is live ──────────────────────────────
  await applyMigrationsThrough(databaseUrl, '0162_naive_gauntlet', 'post');
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

async function publishedAtOf(locationId: string): Promise<Date | null> {
  const [row] = await client`select published_at from location_publications where location_id = ${locationId}`;
  return row.published_at as Date | null;
}

describe('the pre phase, against the previous image\'s rows', () => {
  it('applies all three pre migrations and neither post; the post run applies both', async () => {
    // 0000-0157 plus 0158, 0159 and 0160.
    expect(ledgerAfterPre).toBe(161);
    expect(storeMembersAfterPre).toBe(true);
    const [ledger] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(Number(ledger.n)).toBe(163);
  });

  it('gives a legacy store its owning account in the pre phase already', () => {
    expect(ownerAfterPre.get(STORE)).toBe(FIRST_OWNER);
  });

  it('records every first publication BEFORE anything is withdrawn', () => {
    // Published now, with no trail entry: its `updated_at`.
    expect(publishedAtAfterPre.get(UNLINKED)).toBeInstanceOf(Date);
    expect(publishedAtAfterPre.get(LINKED)).toBeInstanceOf(Date);
    expect(publishedAtAfterPre.get(DRAFT)).toBeNull();
    expect(publishedAtAfterPre.get(ROLLOUT_PUBLISHED)).toBeNull();
  });
});

describe('0161 on stores the previous image wrote', () => {
  it('owns a legacy store by its EARLIEST owner member', async () => {
    const [row] = await client`select oxy_account_id from stores where id = ${STORE}`;
    expect(row.oxy_account_id).toBe(FIRST_OWNER);
  });

  it('re-runs the backfill for a store the previous image created during the rollout', async () => {
    expect(ownerAfterPre.has(ROLLOUT_STORE)).toBe(false);
    const [row] = await client`select oxy_account_id from stores where id = ${ROLLOUT_STORE}`;
    expect(row.oxy_account_id).toBe(ROLLOUT_OWNER);
  });

  it('carries only NON-default grants of non-owning members into overrides', async () => {
    const rows = await client`
      select oxy_user_id, granted, revoked, updated_by_oxy_user_id
      from store_permission_overrides where store_id in (${STORE}, ${ROLLOUT_STORE})
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      oxy_user_id: ADMIN,
      granted: ['store:manage'],
      revoked: [],
      updated_by_oxy_user_id: null,
    });
  });

  it('drops the member list and makes the owning account NOT NULL', async () => {
    const tables = await client`select 1 from information_schema.tables where table_name = 'store_members'`;
    expect(tables).toHaveLength(0);
    const [column] = await client`
      select is_nullable from information_schema.columns
      where table_name = 'stores' and column_name = 'oxy_account_id'
    `;
    expect(column.is_nullable).toBe('NO');
    const impact = await client`
      select 1 from information_schema.columns
      where table_name = 'store_linkage_requests' and column_name = 'impact_store_members'
    `;
    expect(impact).toHaveLength(0);
  });
});

describe('0162 on publications the previous image wrote', () => {
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

  it('keeps the withdrawn location\'s first publication, so the public read answers 410, not 404', async () => {
    const publishedAt = await publishedAtOf(UNLINKED);
    expect(publishedAt).toBeInstanceOf(Date);
    // `0160` wrote it in the pre phase; the withdrawal moved nothing.
    expect(publishedAt?.getTime()).toBe(publishedAtAfterPre.get(UNLINKED)?.getTime());
  });

  it('dates a location the previous image published during the rollout by its trail, then withdraws it', async () => {
    expect(await stateOf(ROLLOUT_PUBLISHED)).toBe('withdrawn');
    // Its trail entry, not the withdrawal's: the backfill re-ran BEFORE block 2.
    expect((await publishedAtOf(ROLLOUT_PUBLISHED))?.getTime()).toBe(ROLLOUT_PUBLISHED_AT.getTime());
    const events = await client`
      select kind, occurred_at from location_publication_events
      where publication_id = ${`publication-${ROLLOUT_PUBLISHED}`}
      order by occurred_at
    `;
    expect(events.map((row) => String(row.kind))).toEqual(['published', 'state_withdrawn']);
  });

  it('leaves a location LINKED during the rollout published — whether its place vouches for it is derived, not migrated', async () => {
    expect(await stateOf(LINKED)).toBe('published');
    expect(await publishedAtOf(LINKED)).toBeInstanceOf(Date);
    const events = await client`
      select 1 from location_publication_events where publication_id = ${`publication-${LINKED}`}
    `;
    expect(events).toHaveLength(0);
  });

  it('leaves an unpublished location alone', async () => {
    expect(await stateOf(DRAFT)).toBe('draft');
    expect(await publishedAtOf(DRAFT)).toBeNull();
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
      expect(present.has(dropped), `${dropped} survived 0162`).toBe(false);
    }
    // Positive controls: what 0159 and 0160 added, and what was never a place fact.
    expect(present.has('location_publication_events.next_go_way_place_id')).toBe(true);
    expect(present.has('location_publications.published_at')).toBe(true);
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
