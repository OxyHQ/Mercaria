/**
 * Unit tests for `store.service`: who may put a store under an Oxy account, who
 * may move it to another, the rules on a permission override, and that a
 * settings patch touches only what it names (ADR 0012).
 *
 * The repository and the Oxy account graph are mocked, so nothing here opens a
 * database or a socket: what is under test is the DECISION.
 *
 * ## What moved OUT of this file, and where it went
 *
 * The old `updateStoreSettings` tests asserted that an ABSENT
 * `notificationSettings`/`taxSettings` block was reconstructed from defaults
 * before being patched. That behaviour is gone rather than changed: all six
 * columns are NOT NULL with exactly the defaults the old code substituted, so
 * there is no absent block left to rebuild. What remains testable HERE is that a
 * patch touches only the fields it names — asserted against the column patch the
 * service hands the repository, which is the whole of its contribution now. That
 * the defaults really are what the columns carry is a property of the DDL, and
 * is asserted against a real database in `db/__tests__/stores.realdb.test.ts`.
 *
 * The owner-protection tests (last owner, owner-touches-owner) went with the
 * member list: an Oxy account always has an owner, and that is Oxy's invariant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STORE_ROLE_PERMISSIONS } from '@mercaria/shared-types';
import type { StoreRow } from '../../db/stores/storeRepository.js';
import type { StoreCaller } from '../store-access.service.js';

const insertStore = vi.fn();
const updateStoreColumns = vi.fn();
const upsertStorePermissionOverride = vi.fn();
const deleteStorePermissionOverride = vi.fn();
const readCallerAccountRole = vi.fn();

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: vi.fn(),
  insertStore: (...args: unknown[]) => insertStore(...args),
  storeHandleExists: vi.fn().mockResolvedValue(false),
  updateStoreColumns: (...args: unknown[]) => updateStoreColumns(...args),
  upsertStorePermissionOverride: (...args: unknown[]) => upsertStorePermissionOverride(...args),
  deleteStorePermissionOverride: (...args: unknown[]) => deleteStorePermissionOverride(...args),
  findStorePermissionOverride: vi.fn(),
  findStorePermissionOverridesForUser: vi.fn(),
  findStoresByOwnerAccounts: vi.fn(),
}));
vi.mock('../../db/stores/locationRepository.js', () => ({
  insertLocation: vi.fn(),
}));
vi.mock('../oxy-account-graph.js', () => ({
  readCallerAccountRole: (...args: unknown[]) => readCallerAccountRole(...args),
  listCallerAccountRoles: vi.fn(),
}));

import {
  createStoreForCaller,
  setStorePermissionOverride,
  transferStoreOwnerAccount,
  updateStoreSettings,
} from '../store.service.js';
import { resetStoreAccessCacheForTests } from '../store-access.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE_ID = '000000000000000000000099';
const ALICE = 'person-alice';
const ORG = 'org-acme';
const OTHER_ORG = 'org-other';

/** A store row carrying only what the service reads. Confined to this cast. */
const STORE = { id: STORE_ID, name: 'Test store', oxyAccountId: ALICE } as unknown as StoreRow;

/** Alice in her own, undelegated session. */
const ALICE_SELF: StoreCaller = {
  accountId: ALICE,
  actorAccountId: ALICE,
  delegated: false,
  accessToken: 'bearer-alice',
};

/** Alice operating ORG. */
const ALICE_AS_ORG: StoreCaller = {
  accountId: ORG,
  actorAccountId: ALICE,
  delegated: true,
  accessToken: 'bearer-alice-as-org',
};

function hasCode(code: string) {
  return (err: unknown) => isMercariaError(err) && err.code === code;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoreAccessCacheForTests();
  insertStore.mockImplementation(async (values: Record<string, unknown>) => ({
    id: STORE_ID,
    ...values,
  }));
  updateStoreColumns.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...STORE,
    ...patch,
  }));
  upsertStorePermissionOverride.mockImplementation(async (input: Record<string, unknown>) => input);
  deleteStorePermissionOverride.mockResolvedValue(true);
  readCallerAccountRole.mockResolvedValue(null);
});

describe('createStoreForCaller — which account may be given a store', () => {
  it('defaults to the caller’s own account, with no round trip to Oxy', async () => {
    await createStoreForCaller(ALICE_SELF, { name: 'Shop' });
    expect(insertStore.mock.calls[0]?.[0]).toMatchObject({ oxyAccountId: ALICE });
    expect(readCallerAccountRole).not.toHaveBeenCalled();
  });

  it('places it under an organization the caller administers', async () => {
    readCallerAccountRole.mockResolvedValue('admin');
    await createStoreForCaller(ALICE_SELF, { name: 'Shop', oxyAccountId: ORG });
    expect(readCallerAccountRole).toHaveBeenCalledWith('bearer-alice', ORG);
    expect(insertStore.mock.calls[0]?.[0]).toMatchObject({ oxyAccountId: ORG });
  });

  it('refuses an organization where the caller is only an editor', async () => {
    readCallerAccountRole.mockResolvedValue('editor');
    await expect(
      createStoreForCaller(ALICE_SELF, { name: 'Shop', oxyAccountId: ORG }),
    ).rejects.toSatisfy(hasCode(ErrorCodes.FORBIDDEN));
    expect(insertStore).not.toHaveBeenCalled();
  });

  it('checks the DEFAULT too when the session is an operated organization', async () => {
    // Speaking as ORG is not governing it: an editor can switch in.
    readCallerAccountRole.mockResolvedValue('editor');
    await expect(createStoreForCaller(ALICE_AS_ORG, { name: 'Shop' })).rejects.toSatisfy(
      hasCode(ErrorCodes.FORBIDDEN),
    );
    readCallerAccountRole.mockResolvedValue('owner');
    resetStoreAccessCacheForTests();
    await createStoreForCaller(ALICE_AS_ORG, { name: 'Shop' });
    expect(insertStore.mock.calls[0]?.[0]).toMatchObject({ oxyAccountId: ORG });
  });
});

describe('transferStoreOwnerAccount — convert to organization', () => {
  it('moves the store when the caller administers the target, and drops an override naming it', async () => {
    readCallerAccountRole.mockResolvedValue('owner');
    const moved = await transferStoreOwnerAccount(STORE, ALICE_SELF, ORG);
    expect(updateStoreColumns).toHaveBeenCalledWith(STORE_ID, { oxyAccountId: ORG });
    expect(deleteStorePermissionOverride).toHaveBeenCalledWith(STORE_ID, ORG);
    expect(moved.oxyAccountId).toBe(ORG);
  });

  it('refuses a target the caller does not govern', async () => {
    readCallerAccountRole.mockResolvedValue('viewer');
    await expect(transferStoreOwnerAccount(STORE, ALICE_SELF, OTHER_ORG)).rejects.toSatisfy(
      hasCode(ErrorCodes.FORBIDDEN),
    );
    expect(updateStoreColumns).not.toHaveBeenCalled();
  });

  it('is a no-op onto the account that already owns it', async () => {
    expect(await transferStoreOwnerAccount(STORE, ALICE_SELF, ALICE)).toBe(STORE);
    expect(updateStoreColumns).not.toHaveBeenCalled();
  });
});

describe('setStorePermissionOverride — exceptions to the role map', () => {
  const ADMIN_ACCESS = { role: 'admin' as const, permissions: [...STORE_ROLE_PERMISSIONS.admin] };

  function write(overrides: { oxyUserId?: string; granted?: string[]; revoked?: string[] }) {
    return setStorePermissionOverride({
      store: STORE,
      caller: ALICE_SELF,
      callerAccess: ADMIN_ACCESS,
      oxyUserId: overrides.oxyUserId ?? 'person-bob',
      granted: (overrides.granted ?? []) as never,
      revoked: (overrides.revoked ?? []) as never,
    });
  }

  it('writes the exception, naming the human who wrote it', async () => {
    await write({ granted: ['refunds:write'], revoked: ['discounts:write'] });
    expect(upsertStorePermissionOverride).toHaveBeenCalledWith({
      storeId: STORE_ID,
      oxyUserId: 'person-bob',
      granted: ['refunds:write'],
      revoked: ['discounts:write'],
      updatedByOxyUserId: ALICE,
    });
  });

  it('removes it when both sets are empty — "no exception" is the absence of a row', async () => {
    expect(await write({})).toBeNull();
    expect(deleteStorePermissionOverride).toHaveBeenCalledWith(STORE_ID, 'person-bob');
    expect(upsertStorePermissionOverride).not.toHaveBeenCalled();
  });

  it('refuses a permission the caller does not hold — no escalation by override', async () => {
    await expect(write({ granted: ['store:manage'] })).rejects.toSatisfy(
      hasCode(ErrorCodes.FORBIDDEN),
    );
  });

  it('refuses one permission both granted and revoked', async () => {
    await expect(
      write({ granted: ['refunds:write'], revoked: ['refunds:write'] }),
    ).rejects.toSatisfy(hasCode(ErrorCodes.VALIDATION_ERROR));
  });

  it('refuses an override on the owning account itself', async () => {
    await expect(write({ oxyUserId: ALICE, revoked: ['refunds:write'] })).rejects.toSatisfy(
      hasCode(ErrorCodes.VALIDATION_ERROR),
    );
  });
});

describe('store.service.updateStoreSettings', () => {
  /** The column patch the service handed the repository on its only call. */
  function patchSent(): Record<string, unknown> {
    expect(updateStoreColumns).toHaveBeenCalledTimes(1);
    return updateStoreColumns.mock.calls[0][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    updateStoreColumns.mockResolvedValue(STORE);
  });

  it('flattens long-form policies and notification settings into their columns', async () => {
    await updateStoreSettings(STORE_ID, {
      policies: {
        refundPolicy: 'Returns within 30 days.',
        privacyPolicy: 'We respect your privacy.',
        termsOfService: 'Be excellent to each other.',
      },
      notificationSettings: { lowStockAlerts: false, lowStockThreshold: 3 },
    });

    expect(patchSent()).toEqual({
      policiesRefundPolicy: 'Returns within 30 days.',
      policiesPrivacyPolicy: 'We respect your privacy.',
      policiesTermsOfService: 'Be excellent to each other.',
      notificationSettingsLowStockAlerts: false,
      notificationSettingsLowStockThreshold: 3,
    });
  });

  it('names ONLY the fields the patch supplied', async () => {
    // The assertion that matters, and the reason it is `toEqual` on the whole
    // object rather than a handful of `toHaveProperty`s: an UPDATE that also
    // named `orderEmails` would overwrite a merchant's setting with the default,
    // and a subset assertion cannot see an EXTRA key.
    await updateStoreSettings(STORE_ID, {
      notificationSettings: { orderEmails: false },
    });

    expect(patchSent()).toEqual({ notificationSettingsOrderEmails: false });
  });

  it('folds a tax-settings patch through the same path', async () => {
    await updateStoreSettings(STORE_ID, {
      taxSettings: { pricesIncludeTax: true, taxRegistrationId: 'ES-B12345678' },
    });

    expect(patchSent()).toEqual({
      taxSettingsPricesIncludeTax: true,
      taxSettingsTaxRegistrationId: 'ES-B12345678',
    });
  });

  it('throws NOT_FOUND when the store does not exist', async () => {
    updateStoreColumns.mockResolvedValueOnce(null);

    await expect(
      updateStoreSettings(STORE_ID, { policies: { refundPolicy: 'x' } }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });
});
