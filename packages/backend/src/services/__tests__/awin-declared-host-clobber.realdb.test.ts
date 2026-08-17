/**
 * `awin_advertisers.declared_host` survives a feed-list poll (#573).
 *
 * The defect: `discoverAwinAdvertiser`'s `ON CONFLICT DO UPDATE` wrote
 * `declared_host = input ?? null`, and the PRIMARY discovery path
 * (`discovery.service.ts`) passes no `declaredHost` because the feed list
 * publishes no host column — so every poll ERASED the column. Measured, not
 * inferred: the value was set, one ordinary re-poll returned it as `null`.
 *
 * It had no practical effect only because nothing in production writes the
 * column at all. That is #573's actual finding and it is why this file exists
 * BEFORE the writer does: whoever adds one must not have to rediscover that
 * their value evaporates on the next hourly poll.
 *
 * Three cases, and the third is the one that stops the fix from overshooting —
 * `coalesce` preserves on absence, and a preservation that also froze the
 * column against a real write would pass the first two on its own.
 *
 * A mock cannot host any of this: the fact under test is what the SERVER stores
 * after two statements, and a mocked upsert accepts any statement at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { awinAccounts, awinAdvertisers } from '../../db/schema/awin.js';
import { upsertAwinAccount } from '../../db/awin/awinAccountRepository.js';
import { discoverAwinAdvertiser } from '../../db/awin/awinAdvertiserRepository.js';

let db: Database;
const RUN = `${Date.now()}`;
let accountId = '';

beforeAll(async () => {
  db = await connectPostgres();
  const account = await upsertAwinAccount({
    publisherId: RUN.slice(-9),
    label: `#573 declared_host ${RUN}`,
    feedCredentialRef: 'env:AWIN_TEST_KEY',
  });
  accountId = account.id;
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

/** A distinct advertiser id per case, so the three cannot interfere. */
function advertiserIdFor(caseName: string): string {
  let hash = 0;
  for (const ch of `${RUN}${caseName}`) hash = (hash * 31 + ch.charCodeAt(0)) % 99_999_999;
  return `${hash}`;
}

async function storedHostOf(rowId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ declaredHost: awinAdvertisers.declaredHost })
    .from(awinAdvertisers)
    .where(eq(awinAdvertisers.id, rowId));
  return row?.declaredHost;
}

describe('awin_advertisers.declared_host across a re-poll', () => {
  it('survives a poll that passes no declaredHost', async () => {
    const advertiserId = advertiserIdFor('survives');
    const first = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Preserved advertiser',
      membershipStatus: 'joined',
      declaredHost: 'retailer.example',
    });
    // Positive control: without this the assertion below would pass against a
    // column that was never set, which is a different fact entirely.
    expect(first.declaredHost).toBe('retailer.example');

    // The PRIMARY discovery path re-polls: `discovery.service.ts` passes no
    // `declaredHost`, reproduced by omitting the property.
    const second = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Preserved advertiser',
      membershipStatus: 'joined',
    });

    expect(second.declaredHost).toBe('retailer.example');
    // The stored row, not just the RETURNING projection.
    expect(await storedHostOf(first.id)).toBe('retailer.example');
  });

  it('is still absent when it was never set', async () => {
    const advertiserId = advertiserIdFor('absent');
    const first = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Hostless advertiser',
      membershipStatus: 'joined',
    });
    expect(first.declaredHost).toBeNull();

    const second = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Hostless advertiser',
      membershipStatus: 'not_joined',
    });
    // Preservation must not invent a value, and this is today's whole
    // production population: every real row is NULL.
    expect(second.declaredHost).toBeNull();
    expect(await storedHostOf(first.id)).toBeNull();
  });

  it('is still UPDATED by a caller that supplies one', async () => {
    const advertiserId = advertiserIdFor('updates');
    const first = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Rehosted advertiser',
      membershipStatus: 'joined',
      declaredHost: 'old.example',
    });
    expect(first.declaredHost).toBe('old.example');

    const second = await discoverAwinAdvertiser({
      accountId,
      advertiserId,
      displayName: 'Rehosted advertiser',
      membershipStatus: 'joined',
      declaredHost: 'new.example',
    });

    // Preserve-on-absence must not become immutable-forever: a fix that froze
    // the column would satisfy both cases above and make the eventual writer
    // silently inert.
    expect(second.declaredHost).toBe('new.example');
    expect(await storedHostOf(first.id)).toBe('new.example');
  });
});
