import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configureServiceAuth: vi.fn(),
  getServiceToken: vi.fn(),
  invalidateServiceToken: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock('@oxyhq/core', () => ({
  OxyServices: class {
    constructor(options: unknown) {
      mocks.constructed(options);
    }

    configureServiceAuth(key: string, secret: string): void {
      mocks.configureServiceAuth(key, secret);
    }

    getServiceToken(): Promise<string> {
      return mocks.getServiceToken() as Promise<string>;
    }

    invalidateServiceToken(): void {
      mocks.invalidateServiceToken();
    }
  },
}));

import {
  invalidateOxyServiceToken,
  oxyServiceClient,
  requiredOxyServiceToken,
  resetOxyServiceClientForTests,
} from '../oxy-service-client.js';

beforeEach(() => {
  delete process.env.OXY_APPLICATION_KEY;
  delete process.env.OXY_APPLICATION_SECRET;
  resetOxyServiceClientForTests();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('Mercaria Oxy service client', () => {
  it('fails closed when either application credential is absent', async () => {
    process.env.OXY_APPLICATION_KEY = 'key-only';

    expect(oxyServiceClient()).toBeNull();
    await expect(requiredOxyServiceToken()).rejects.toThrow(
      'Oxy application credentials are not configured',
    );
    expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it('configures one cached application client without handling user tokens', async () => {
    process.env.OXY_APPLICATION_KEY = 'application-key';
    process.env.OXY_APPLICATION_SECRET = 'application-secret';
    mocks.getServiceToken.mockResolvedValueOnce('service-token');

    const first = oxyServiceClient();
    const second = oxyServiceClient();

    expect(first).toBe(second);
    expect(mocks.constructed).toHaveBeenCalledTimes(1);
    expect(mocks.configureServiceAuth).toHaveBeenCalledWith(
      'application-key',
      'application-secret',
    );
    await expect(requiredOxyServiceToken()).resolves.toBe('service-token');
    invalidateOxyServiceToken();
    expect(mocks.invalidateServiceToken).toHaveBeenCalledTimes(1);
  });
});
