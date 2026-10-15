import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { Organization } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres.js';
import { organizations } from '../../../db/schema/organizations.js';
import { oxyClient } from '../../../middleware/auth.js';
import { assertSameCanonicalOrganization, getPublicOrganizations } from '../directory.js';

const prefix = uuidv7();
const ids = Array.from({ length: 202 }, (_, i) => `${prefix}-${i}`);
const canonical = (accountId: string, overrides: Partial<Organization> = {}): Organization => ({
  accountId,
  name: 'Live canonical company',
  username: null,
  organizationType: 'business',
  avatar: null,
  legalName: null,
  websiteUrl: null,
  countryCode: null,
  aliases: [],
  verifiedDomains: [],
  claimStatus: 'unclaimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  ...overrides,
});

beforeAll(async () => {
  await connectPostgres();
  await getDb()
    .insert(organizations)
    .values(
      ids.map((id, i) => ({
        id,
        slug: id,
        oxyAccountId: i === 201 ? `${prefix}-oxy-0` : `${prefix}-oxy-${i}`,
      })),
    );
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await getDb().delete(organizations).where(inArray(organizations.id, ids));
  await closePostgres();
});

describe('canonical company reads', () => {
  it('deduplicates all accounts across reference batches and never exceeds the SDK limit', async () => {
    const batch = vi
      .spyOn(oxyClient.organizations, 'batch')
      .mockImplementation(async ({ ids: accounts }) => ({
        items: accounts.map((id) => ({ requestedAccountId: id, organization: canonical(id) })),
        missingIds: [],
      }));
    const result = await getPublicOrganizations([...ids, ids[0]]);
    expect(result.size).toBe(202);
    expect(batch.mock.calls.map(([input]) => input.ids.length)).toEqual([100, 100, 1]);
    expect(new Set(batch.mock.calls.flatMap(([input]) => input.ids)).size).toBe(201);
    expect(result.get(ids[201])?.oxyAccountId).toBe(`${prefix}-oxy-0`);
  });
  it('resolves Oxy merges and withholds missing or suppressed companies', async () => {
    vi.spyOn(oxyClient.organizations, 'batch').mockResolvedValue({
      items: [
        { requestedAccountId: `${prefix}-oxy-0`, organization: canonical('winner') },
        {
          requestedAccountId: `${prefix}-oxy-1`,
          organization: canonical('hidden', { status: 'suppressed' }),
        },
      ],
      missingIds: [`${prefix}-oxy-2`],
    });
    const result = await getPublicOrganizations(ids.slice(0, 3));
    expect([...result.keys()]).toEqual([ids[0]]);
    expect(result.get(ids[0])?.oxyAccountId).toBe('winner');
  });
  it('uses current canonical facts and fails explicitly on an outage', async () => {
    const batch = vi
      .spyOn(oxyClient.organizations, 'batch')
      .mockResolvedValueOnce({
        items: [
          {
            requestedAccountId: `${prefix}-oxy-0`,
            organization: canonical('winner', { name: 'Renamed in Oxy' }),
          },
        ],
        missingIds: [],
      })
      .mockRejectedValueOnce(new Error('unavailable'));
    expect((await getPublicOrganizations([ids[0]])).get(ids[0])?.name).toBe('Renamed in Oxy');
    await expect(getPublicOrganizations([ids[0]])).rejects.toThrow('directory is unavailable');
    expect(batch).toHaveBeenCalledTimes(2);
  });
  it('permits graph consolidation only after the canonical directory resolves both references to one company', async () => {
    const batch = vi
      .spyOn(oxyClient.organizations, 'batch')
      .mockImplementation(async ({ ids: accounts }) => ({
        items: accounts.map((id) => ({ requestedAccountId: id, organization: canonical(id) })),
        missingIds: [],
      }));
    await expect(assertSameCanonicalOrganization(ids[0], ids[1])).rejects.toThrow(
      'Merge company identity in Oxy',
    );
    batch.mockImplementation(async ({ ids: accounts }) => ({
      items: accounts.map((id) => ({ requestedAccountId: id, organization: canonical('winner') })),
      missingIds: [],
    }));
    await expect(assertSameCanonicalOrganization(ids[0], ids[1])).resolves.toBeUndefined();
  });
});
