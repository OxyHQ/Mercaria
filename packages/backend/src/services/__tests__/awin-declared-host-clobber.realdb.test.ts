/**
 * CHARACTERIZATION of a defect (#573): a feed-list poll NULLs `declared_host`.
 *
 * This test pins CURRENT behaviour, which is WRONG, and it is expected to fail
 * the moment somebody fixes it — that failure is the point. It exists because
 * the claim it measures travelled between two people as established fact and
 * was false; a measurement against a real server cannot decay the same way.
 *
 * `discoverAwinAdvertiser`'s `ON CONFLICT DO UPDATE` writes
 * `"declared_host" = $n` unconditionally (`awinAdvertiserRepository.ts:83`),
 * and the PRIMARY discovery path passes no `declaredHost`
 * (`discovery.service.ts:134`) — so every poll erases the column. The
 * seen-only path re-passes `existing.declaredHost` (`:209`) and preserves it,
 * so the two disagree.
 *
 * Whoever fixes this: make the upsert preserve (a `coalesce` on `excluded`,
 * spelled out — `~/Oxy/AGENTS.md` on `excluded.<col>`), then invert the
 * assertion below to `toBe('retailer.example')`.
 *
 * A mock cannot host this: the fact under test is what the SERVER stores after
 * two statements, and a mocked upsert accepts any statement at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { awinAccounts, awinAdvertisers } from '../../db/schema/awin.js';
import { upsertAwinAccount } from '../../db/awin/awinAccountRepository.js';
import { discoverAwinAdvertiser } from '../../db/awin/awinAdvertiserRepository.js';

let db: Database;
const RUN = `${Date.now()}`;
const ADVERTISER_ID = RUN.slice(-8);
let accountId = '';

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // Scoped to the ids this file owns — the test database is shared across
  // parallel files.
  if (accountId !== '') {
    await db.delete(awinAdvertisers).where(eq(awinAdvertisers.accountId, accountId));
    await db.delete(awinAccounts).where(eq(awinAccounts.id, accountId));
  }
  await closePostgres();
});

describe('awin_advertisers.declared_host across a re-poll', () => {
  it('is erased by a poll that passes no declaredHost (#573, current defect)', async () => {
    const account = await upsertAwinAccount({
      publisherId: RUN.slice(-9),
      label: `#573 characterization ${RUN}`,
      feedCredentialRef: 'env:AWIN_TEST_KEY',
    });
    accountId = account.id;

    // A row that HAS a declared host. Today only a test fixture produces this
    // shape; that is the finding, not the setup.
    const first = await discoverAwinAdvertiser({
      accountId: account.id,
      advertiserId: ADVERTISER_ID,
      displayName: 'Characterization advertiser',
      membershipStatus: 'joined',
      declaredHost: 'retailer.example',
    });
    // Positive control: without this the assertion below passes against a
    // column that was never set, which is a different fact entirely.
    expect(first.declaredHost).toBe('retailer.example');

    // The PRIMARY discovery path re-polls. `discovery.service.ts:134` passes
    // no `declaredHost` at all — reproduced by omitting the property.
    const second = await discoverAwinAdvertiser({
      accountId: account.id,
      advertiserId: ADVERTISER_ID,
      displayName: 'Characterization advertiser',
      membershipStatus: 'joined',
    });

    // MEASURED. Invert to `toBe('retailer.example')` when the clobber is fixed.
    expect(second.declaredHost).toBeNull();

    // And it is the stored row, not just the RETURNING projection.
    const [readBack] = await db
      .select({ declaredHost: awinAdvertisers.declaredHost })
      .from(awinAdvertisers)
      .where(eq(awinAdvertisers.id, first.id));
    expect(readBack?.declaredHost).toBeNull();
  });
});
