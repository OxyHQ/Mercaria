import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  constructed: vi.fn(),
  canAttest: vi.fn(() => false),
  dispose: vi.fn(),
}));
vi.mock('@oxy.so/core/server', () => ({
  canAttestWorkloadIdentity: () => mocks.canAttest(),
  OxyServer: class {
    constructor(options: unknown) {
      mocks.constructed(options);
    }
    dispose() {
      mocks.dispose();
    }
  },
}));
import {
  oxyServiceClient,
  requiredOxyServiceClient,
  resetOxyServiceClientForTests,
} from '../oxy-service-client.js';
beforeEach(() => {
  resetOxyServiceClientForTests();
  delete process.env.OXY_APPLICATION_KEY;
  delete process.env.OXY_APPLICATION_SECRET;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.canAttest.mockReturnValue(false);
});
describe('Mercaria workload client', () => {
  it('never promotes a customer key pair into own authority', () => {
    process.env.OXY_APPLICATION_KEY = 'external-key';
    process.env.OXY_APPLICATION_SECRET = 'external-secret';
    expect(oxyServiceClient()).toBeNull();
    expect(() => requiredOxyServiceClient()).toThrow('no attestable Oxy workload identity');
    expect(mocks.constructed).not.toHaveBeenCalled();
  });
  it('uses one workload client even when retired key configuration remains', () => {
    mocks.canAttest.mockReturnValue(true);
    process.env.OXY_APPLICATION_SECRET = 'retired-secret';
    expect(requiredOxyServiceClient()).toBe(oxyServiceClient());
    expect(mocks.constructed).toHaveBeenCalledExactlyOnceWith({ baseURL: 'https://api.oxy.so' });
  });
});
