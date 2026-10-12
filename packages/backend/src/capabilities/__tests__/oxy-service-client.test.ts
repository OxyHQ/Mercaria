import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serviceToken: vi.fn(),
  invalidateServiceToken: vi.fn(),
  constructed: vi.fn(),
  canAttest: vi.fn(() => false),
}));

vi.mock('@oxy.so/core/server', () => ({
  canAttestWorkloadIdentity: () => mocks.canAttest(),
  OxyServer: class {
    constructor(options: unknown) {
      mocks.constructed(options);
    }

    serviceToken(): Promise<string> {
      return mocks.serviceToken() as Promise<string>;
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
  mocks.canAttest.mockReturnValue(false);
});

describe('Mercaria Oxy service client', () => {
  it('fails closed when either application credential is absent', async () => {
    process.env.OXY_APPLICATION_KEY = 'key-only';

    expect(oxyServiceClient()).toBeNull();
    await expect(requiredOxyServiceToken()).rejects.toThrow('Mercaria has no Oxy identity');
    expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it('configures one cached application client without handling user tokens', async () => {
    process.env.OXY_APPLICATION_KEY = 'application-key';
    process.env.OXY_APPLICATION_SECRET = 'application-secret';
    mocks.serviceToken.mockResolvedValueOnce('service-token');

    const first = oxyServiceClient();
    const second = oxyServiceClient();

    expect(first).toBe(second);
    expect(mocks.constructed).toHaveBeenCalledTimes(1);
    expect(mocks.constructed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceAuth: { apiKey: 'application-key', apiSecret: 'application-secret' },
      }),
    );
    await expect(requiredOxyServiceToken()).resolves.toBe('service-token');
    invalidateOxyServiceToken();
    expect(mocks.invalidateServiceToken).toHaveBeenCalledTimes(1);
  });

  it('attests its task role when no key pair is configured', async () => {
    mocks.canAttest.mockReturnValue(true);
    mocks.serviceToken.mockResolvedValueOnce('workload-token');

    expect(oxyServiceClient()).not.toBeNull();
    expect(mocks.constructed).toHaveBeenCalledWith(
      expect.not.objectContaining({ serviceAuth: expect.anything() }),
    );
    await expect(requiredOxyServiceToken()).resolves.toBe('workload-token');
  });

  it('never treats half a key pair as an attestation', () => {
    mocks.canAttest.mockReturnValue(true);
    process.env.OXY_APPLICATION_SECRET = 'secret-only';

    expect(oxyServiceClient()).toBeNull();
    expect(mocks.constructed).not.toHaveBeenCalled();
  });
});
