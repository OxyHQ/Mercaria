/**
 * Configuration validation and the registration decision (#156 test 11,
 * "feature/readiness gating", and §"Environment and readiness" items 3, 4 and 7).
 *
 * `config` is frozen at module load, so every case re-imports the whole graph
 * under a fresh environment. That is heavier than passing a config object in,
 * and it is what makes the test measure the real thing: the rules under test
 * are about what a DEPLOYMENT's variables produce, and a hand-built config
 * object would let a case assert a state the env parsing cannot actually reach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV: Record<string, string> = {
  MOOVO_ENABLED: 'true',
  MOOVO_BASE_URL: 'https://api.moovo.now',
  MOOVO_RESOURCE_APPLICATION_ID: 'app_moovo_123',
  MOOVO_ENVIRONMENT: 'production',
};

const TOUCHED = [
  'MOOVO_ENABLED',
  'MOOVO_BASE_URL',
  'MOOVO_RESOURCE_APPLICATION_ID',
  'MOOVO_ENVIRONMENT',
  'MOOVO_SCOPES',
  'NODE_ENV',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  vi.resetModules();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

function setEnv(overrides: Record<string, string | undefined>): void {
  const merged = { ...BASE_ENV, ...overrides };
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Import the domain fresh under whatever env the case just set. */
async function loadDomain() {
  const register = await import('../register.js');
  const transport = await import('../transport.js');
  const port = await import('../../retail-fulfilment/moovo.port.js');
  return { ...register, ...transport, ...port };
}

describe('#156 §"Environment and readiness" — a misconfiguration is a HARD failure', () => {
  it('is silent and installs nothing when disabled — the shipped default', async () => {
    setEnv({ MOOVO_ENABLED: 'false', MOOVO_BASE_URL: undefined });
    const domain = await loadDomain();

    expect(() => domain.registerMoovoClient()).not.toThrow();
    expect(domain.isMoovoBookingAvailable()).toBe(false);
  });

  it('refuses a missing resource application id, naming it', async () => {
    setEnv({ MOOVO_RESOURCE_APPLICATION_ID: undefined });
    const domain = await loadDomain();

    expect(() => domain.registerMoovoClient()).toThrow(/MOOVO_RESOURCE_APPLICATION_ID/);
  });

  it('refuses an unrecognised environment rather than defaulting it', async () => {
    setEnv({ MOOVO_ENVIRONMENT: 'prod' });
    const domain = await loadDomain();

    // The message quotes the value back, so the typo is visible. It is a member
    // of a published closed set, never a secret.
    expect(() => domain.registerMoovoClient()).toThrow(/"prod" is not one of/);
  });

  it('refuses a production deployment pointed at a rehearsal Moovo', async () => {
    setEnv({ MOOVO_ENVIRONMENT: 'staging', NODE_ENV: 'production' });
    const domain = await loadDomain();

    expect(() => domain.registerMoovoClient()).toThrow(/must not address a rehearsal Moovo/);
  });

  it('refuses a plaintext base URL, with no localhost exemption', async () => {
    setEnv({ MOOVO_BASE_URL: 'http://localhost:3001' });
    const domain = await loadDomain();

    expect(() => domain.registerMoovoClient()).toThrow(/must be https/);
  });

  it('reports EVERY problem at once, not the first', async () => {
    setEnv({ MOOVO_BASE_URL: undefined, MOOVO_RESOURCE_APPLICATION_ID: undefined });
    const domain = await loadDomain();

    // One restart per wrong variable is how a deploy window is spent.
    const problems = domain.moovoConfigurationProblems();
    expect(problems.length).toBe(2);
  });

  it('never echoes the resource application id into the refusal', async () => {
    setEnv({ MOOVO_BASE_URL: 'http://insecure.example' });
    const domain = await loadDomain();

    // It is not a credential, but it identifies somebody else's tenant.
    expect(() => domain.registerMoovoClient()).toThrow();
    try {
      domain.registerMoovoClient();
    } catch (error) {
      expect(String(error)).not.toContain('app_moovo_123');
    }
  });
});

describe('#156 — a configured client with no transport is NOT registered', () => {
  it('leaves Moovo booking unavailable, so Mode A stays unreachable', async () => {
    setEnv({});
    const domain = await loadDomain();

    expect(() => domain.registerMoovoClient()).not.toThrow();

    // The load-bearing assertion of this whole issue. `isMoovoBookingAvailable`
    // feeds `chooseFulfilmentMode`'s `moovoBookingAvailable`; a `true` here
    // would make Mode A the CHOSEN mode and strand every paid retail order in
    // a booking path that always fails, instead of falling back to Mode B.
    expect(domain.isMoovoBookingAvailable()).toBe(false);
  });

  it('registers the client once a transport exists, and then Mode A is reachable', async () => {
    setEnv({});
    const domain = await loadDomain();
    domain.registerMoovoTransport({
      registerTrackingOnlyTransport: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      bookTransport: () => Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      readTransportProjection: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      cancelTransport: () => Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      requestReturnTransport: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
    });

    domain.registerMoovoClient();

    expect(domain.isMoovoBookingAvailable()).toBe(true);
    domain.resetMoovoTransport();
    domain.resetMoovoLogisticsPort();
  });

  it('a disabled deployment does not register even with a transport present', async () => {
    setEnv({ MOOVO_ENABLED: 'false' });
    const domain = await loadDomain();
    domain.registerMoovoTransport({
      registerTrackingOnlyTransport: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      bookTransport: () => Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      readTransportProjection: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      cancelTransport: () => Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
      requestReturnTransport: () =>
        Promise.resolve({ kind: 'failed', failure: { afterWrite: 'no' } }),
    });

    domain.registerMoovoClient();

    expect(domain.isMoovoBookingAvailable()).toBe(false);
    domain.resetMoovoTransport();
  });
});
