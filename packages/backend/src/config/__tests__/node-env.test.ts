/**
 * `NODE_ENV` decides whether the mock payment rail exists, so an unset value
 * must not boot (the M8-15 finding: an image started without it would read as
 * "not production" and expose mock pay). `config` freezes at import, so each
 * case re-imports it under a stubbed environment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(nodeEnv: string | undefined) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  // Production refuses to load config without the root secret
  // (`lib/derived-secrets.ts`), which is a different boot check from this
  // file's. A fixed test root keeps the production cases about NODE_ENV alone.
  vi.stubEnv('MERCARIA_SECRET_KEY', 'a'.repeat(64));
  return import('../index.js');
}

describe('the boot check', () => {
  it('refuses an unset NODE_ENV, naming the mock rail', async () => {
    const { assertKnownNodeEnv } = await load(undefined);
    expect(() => assertKnownNodeEnv()).toThrow(/NODE_ENV=null .*mock payment rail/);
  });

  it('refuses an unrecognised NODE_ENV rather than reading it as development', async () => {
    const { assertKnownNodeEnv } = await load('prod');
    expect(() => assertKnownNodeEnv()).toThrow(/NODE_ENV="prod" is not one of/);
  });

  it.each(['production', 'development', 'test'])('accepts %s', async (value) => {
    const { assertKnownNodeEnv } = await load(value);
    expect(() => assertKnownNodeEnv()).not.toThrow();
  });
});

describe('the mock payment rail', () => {
  it.each([
    ['development', true],
    ['test', true],
    ['production', false],
    // Fail closed for a process that never ran the boot check.
    [undefined, false],
    ['staging', false],
  ] as const)('NODE_ENV=%s → mockPayEnabled %s', async (value, expected) => {
    const { config } = await load(value);
    expect(config.orders.mockPayEnabled).toBe(expected);
  });
});
