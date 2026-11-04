import { expect, test } from 'bun:test';

const entries = [
  '../packages/frontend/public/_worker.js',
  '../packages/dashboard/public/_worker.js',
  '../packages/pos/public/_worker.js',
];
for (const entry of entries) {
  test(`${entry}: preserves the asset response`, async () => {
    const worker = (await import(entry)).default;
    const response = new Response('asset', {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public,max-age=31536000,immutable',
      },
    });
    const result = await worker.fetch(
      new Request('https://example.com/private-image.png?user=secret'),
      { ASSETS: { fetch: async () => response } },
      { waitUntil: () => {} },
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('immutable');
    expect(await result.text()).toBe('asset');
  });
  test(`${entry}: asset failures preserve the original error`, async () => {
    const worker = (await import(entry)).default;
    const error = new Error('asset failure');
    await expect(
      worker.fetch(
        new Request('https://example.com/file.png'),
        {
          ASSETS: {
            fetch: async () => {
              throw error;
            },
          },
        },
        { waitUntil: () => {} },
      ),
    ).rejects.toBe(error);
  });
}

test('storefront: a referral link is redirected to the API, which sets the carrier on its own host', async () => {
  const worker = (await import('../packages/frontend/public/_worker.js')).default;
  const env = {
    SEO_API_ORIGIN: 'https://api.example.com',
    ASSETS: {
      fetch: async () => new Response('app shell', { headers: { 'Content-Type': 'text/html' } }),
    },
  };
  const result = await worker.fetch(
    new Request('https://example.com/r/eyJsaW5rSWQiOiJ4In0.c2lnbmF0dXJl?utm_source=ignored'),
    env,
    { waitUntil: () => {} },
  );
  expect(result.status).toBe(302);
  expect(result.headers.get('location')).toBe(
    'https://api.example.com/r/eyJsaW5rSWQiOiJ4In0.c2lnbmF0dXJl',
  );
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(result.headers.get('referrer-policy')).toBe('no-referrer');

  // Anything that is not a link token's shape is the app's to answer.
  const other = await worker.fetch(new Request('https://example.com/r/not-a-token'), env, {
    waitUntil: () => {},
  });
  expect(other.status).toBe(200);
});
