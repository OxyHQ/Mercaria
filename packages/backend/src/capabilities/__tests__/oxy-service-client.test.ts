import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), dispose: vi.fn(), create: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { createServiceClient: (...args: unknown[]) => mocks.create(...args) },
}));
import { oxyClient } from '../../middleware/auth.js';
import {
  oxyServiceClient,
  requiredOxyServiceClient,
  oxyPlatformTransport,
  resetOxyServiceClientForTests,
} from '../oxy-service-client.js';
beforeEach(() => {
  resetOxyServiceClientForTests();
  vi.clearAllMocks();
  mocks.create.mockReturnValue({ fetch: mocks.fetch, dispose: mocks.dispose });
});
describe('Mercaria workload client', () => {
  it('shares the receiver client without customer key fallback or an ECS-only gate', () => {
    vi.stubEnv('OXY_APPLICATION_KEY', 'external-key');
    vi.stubEnv('OXY_APPLICATION_SECRET', 'external-secret');
    expect(oxyServiceClient()).toBe(oxyClient);
    expect(requiredOxyServiceClient()).toBe(oxyClient);
    expect(mocks.create).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('keeps one lazy platform transport and disposes only that transport on reset', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}'));
    await oxyPlatformTransport.fetch('https://api.oxy.so/resource');
    await oxyPlatformTransport.fetch('https://api.oxy.so/other');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      baseURL: 'https://api.oxy.so',
      audience: 'oxy-api',
    });
    resetOxyServiceClientForTests();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
