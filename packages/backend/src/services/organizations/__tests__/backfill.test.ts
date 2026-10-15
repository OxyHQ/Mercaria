import { describe, expect, it, vi } from 'vitest';
import {
  applyOrganizationBackfill,
  planOrganizationBackfill,
  type OrganizationMigrationRow,
} from '../backfill.js';

function row(
  id: string,
  overrides: Partial<OrganizationMigrationRow> = {},
): OrganizationMigrationRow {
  const date = new Date('2026-10-15T00:00:00.000Z');
  return {
    id,
    oxyAccountId: null,
    slug: id,
    status: 'active',
    mergedIntoId: null,
    firstSeenAt: date,
    lastSeenAt: null,
    lastReviewedAt: null,
    pinnedFields: [],
    createdAt: date,
    updatedAt: date,
    archive: {
      id,
      organizationId: id,
      name: 'Shared display name',
      legalName: null,
      websiteUrl: null,
      verifiedDomains: [],
      countryCode: null,
      logoFileId: null,
      logoSourceRecordId: null,
      archivedAt: date,
    },
    aliases: [],
    ...overrides,
  };
}

function directory() {
  const identities = new Map<string, string>();
  const importExternal = vi.fn(async (input: { externalId: string; accountId?: string }) => {
    const accountId =
      identities.get(input.externalId) ?? input.accountId ?? `oxy-${input.externalId}`;
    identities.set(input.externalId, accountId);
    return { accountId, created: !input.accountId };
  });
  return { importExternal };
}

describe('canonical organization migration', () => {
  it('never merges companies just because their names are equal', () => {
    const plan = planOrganizationBackfill([row('a'), row('b')]);
    expect(plan.groups).toHaveLength(2);
    expect(planOrganizationBackfill([row('b'), row('a')]).sha256).toBe(plan.sha256);
  });
  it('follows evidence-backed historical redirects and rejects cycles or missing targets', () => {
    expect(
      planOrganizationBackfill([row('a', { mergedIntoId: 'b', status: 'merged' }), row('b')])
        .groups,
    ).toHaveLength(1);
    expect(() => planOrganizationBackfill([row('a', { mergedIntoId: 'b' })])).toThrow('Missing');
    expect(() =>
      planOrganizationBackfill([row('a', { mergedIntoId: 'b' }), row('b', { mergedIntoId: 'a' })]),
    ).toThrow('cycle');
  });
  it('binds every old reference to the winner and remains resumable after remote success', async () => {
    const rows = [row('old', { mergedIntoId: 'winner', status: 'merged' }), row('winner')];
    const sdk = directory();
    const saveMappings = vi
      .fn()
      .mockRejectedValueOnce(new Error('local transaction failed'))
      .mockResolvedValue(undefined);
    const options = {
      rows,
      expectedPlanSha256: planOrganizationBackfill(rows).sha256,
      reviewedMappings: [],
      directory: sdk,
      saveMappings,
    };
    await expect(applyOrganizationBackfill(options)).rejects.toThrow('local transaction failed');
    await expect(applyOrganizationBackfill(options)).resolves.toEqual([
      { organizationId: 'winner', accountId: 'oxy-winner' },
      { organizationId: 'old', accountId: 'oxy-winner' },
    ]);
    expect(sdk.importExternal.mock.calls[1][0]).toMatchObject({
      externalId: 'old',
      accountId: 'oxy-winner',
    });
  });
  it('refuses changed plans and conflicting reviewed evidence before any writes', async () => {
    const rows = [row('a')];
    const sdk = directory();
    const saveMappings = vi.fn();
    await expect(
      applyOrganizationBackfill({
        rows,
        expectedPlanSha256: 'stale',
        reviewedMappings: [],
        directory: sdk,
        saveMappings,
      }),
    ).rejects.toThrow('plan changed');
    expect(sdk.importExternal).not.toHaveBeenCalled();
    expect(saveMappings).not.toHaveBeenCalled();
  });
  it('requires explicit acknowledgment of domain reverification and never republishes a suppressed source', async () => {
    const source = row('a');
    if (!source.archive) throw new Error('Missing test archive');
    source.archive.verifiedDomains = ['example.com'];
    const sdk = directory();
    const options = {
      rows: [source],
      expectedPlanSha256: planOrganizationBackfill([source]).sha256,
      reviewedMappings: [],
      directory: sdk,
      saveMappings: vi.fn(),
    };
    await expect(applyOrganizationBackfill(options)).rejects.toThrow(
      'verify domain ownership again',
    );
    expect(sdk.importExternal).not.toHaveBeenCalled();
    await expect(
      applyOrganizationBackfill({ ...options, acknowledgeDomainReverification: true }),
    ).resolves.toHaveLength(1);
    const suppressed = row('hidden', { status: 'suppressed' });
    await expect(
      applyOrganizationBackfill({
        ...options,
        rows: [suppressed],
        expectedPlanSha256: planOrganizationBackfill([suppressed]).sha256,
      }),
    ).rejects.toThrow('cannot publish');
  });
});
