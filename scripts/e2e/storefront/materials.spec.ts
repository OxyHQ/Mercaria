import { test, expect, type Page } from '@playwright/test';

const accountId = 'materials-browser-person';
const offered = {
  id: 'offer-browser',
  ownerAccountId: 'another-account',
  title: 'Reusable boards',
  description: 'Clean reusable wood',
  publicArea: 'West district',
  quantity: 10,
  unit: 'boards',
  status: 'active',
  availableQuantity: 6,
  committedQuantity: 4,
  receivedQuantity: 0,
  createdAt: new Date().toISOString(),
};

async function account(page: Page) {
  const token = [
    'e30',
    Buffer.from(
      JSON.stringify({
        sub: accountId,
        userId: accountId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url'),
    'test-only',
  ].join('.');
  await page.addInitScript(
    ({ accountId, token }) =>
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          userId: accountId,
          sessionId: 'materials-session',
          accessToken: token,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      ),
    { accountId, token },
  );
  await page.route('https://api.oxy.so/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/auth/oauth/client/'))
      return route.fulfill({
        json: {
          application: {
            id: 'fixture',
            name: 'Mercaria fixture',
            type: 'first_party',
            isOfficial: true,
            isInternal: false,
            scopes: [],
          },
        },
      });
    if (path === '/users/me')
      return route.fulfill({
        json: {
          id: accountId,
          username: 'materials-fixture',
          name: { displayName: 'Materials fixture' },
        },
      });
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
  // Never send synthetic credentials to a real service. This browser suite
  // tests the actual SDK, Oxy provider, controls and retry behavior with HTTP fixtures.
  await page.route('http://127.0.0.1:4160/**', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Unused fixture endpoint' } },
    }),
  );
}

test('free offer retries preserve their key after a lost response, on a phone viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await account(page);
  const writes: Record<string, unknown>[] = [];
  let created = false;
  await page.route('**/public/v1/materials/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith('/offers') && req.method() === 'POST') {
      writes.push(req.postDataJSON());
      created = true;
      if (writes.length === 1) return route.abort('failed');
      return route.fulfill({
        status: 201,
        json: {
          ...offered,
          ...req.postDataJSON(),
          id: 'created-offer',
          ownerAccountId: accountId,
          availableQuantity: 3,
          committedQuantity: 0,
          receivedQuantity: 0,
        },
      });
    }
    if (url.pathname.endsWith('/reservations'))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({
      json: {
        items: created
          ? [
              {
                ...offered,
                id: 'created-offer',
                ownerAccountId: accountId,
                title: 'Spare bricks',
                quantity: 3,
                availableQuantity: 3,
                committedQuantity: 0,
              },
            ]
          : [],
        nextCursor: null,
      },
    });
  });
  await page.goto('/materials');
  await expect(page.getByText('Acting as Materials fixture')).toBeVisible();
  await page.getByRole('button', { name: 'Offer materials', exact: true }).click();
  await page.getByLabel('Material name', { exact: true }).fill('Spare bricks');
  await page.getByLabel('Approximate public area', { exact: true }).fill('West district');
  await page.getByLabel('Quantity', { exact: true }).fill('3');
  await page.getByLabel('Unit (pieces, boxes…)', { exact: true }).fill('bricks');
  await page
    .getByLabel('Personal pickup instructions', { exact: true })
    .fill('Ring bell after agreeing a time');
  const publish = page.getByRole('button', { name: 'Publish free offer', exact: true });
  await publish.click();
  await expect(page.getByRole('alert')).toContainText('Could not complete the request');
  await publish.click();
  await expect(page.getByText('Spare bricks', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1].idempotencyKey).toBe(writes[0].idempotencyKey);
  expect(writes[1].ownerAccountId).toBe(accountId);
  expect(writes[1]).not.toHaveProperty('price');
  await expect(page.getByRole('button', { name: 'Close offer to new requests' })).toBeVisible();
});

test('recipient requests, sees accepted pickup and explicitly confirms receipt', async ({
  page,
}) => {
  await account(page);
  let row = {
    id: 'reservation-browser',
    offerId: offered.id,
    donorAccountId: offered.ownerAccountId,
    requesterAccountId: accountId,
    quantity: 2,
    status: 'accepted',
    pickupInstructions: 'Collect from the workshop after 10',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const requests: unknown[] = [];
  const confirmations: unknown[] = [];
  await page.route('**/public/v1/materials/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith('/requests')) {
      requests.push(req.postDataJSON());
      return route.fulfill({
        status: 201,
        json: { ...row, status: 'requested', pickupInstructions: null },
      });
    }
    if (url.pathname.endsWith('/confirm-delivery')) {
      confirmations.push(req.postDataJSON());
      row = { ...row, status: 'delivered' };
      return route.fulfill({ json: row });
    }
    if (url.pathname.endsWith('/reservations'))
      return route.fulfill({ json: { items: [row], nextCursor: null } });
    if (url.pathname.endsWith(`/${offered.id}`)) return route.fulfill({ json: offered });
    return route.fulfill({ json: { items: [offered], nextCursor: null } });
  });
  await page.goto('/materials');
  await expect(page.getByText('Acting as Materials fixture')).toBeVisible();
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Request materials', exact: true }).click();
  await expect(
    page.getByText('Request sent. The donor must accept before units are reserved.'),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ requesterAccountId: accountId, quantity: 2 });
  await page.getByRole('button', { name: 'My requests and reservations', exact: true }).click();
  await expect(page.getByText(row.pickupInstructions)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept and reserve', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'I have received these materials', exact: true }).click();
  await expect(page.getByText('Receipt confirmed', { exact: true })).toBeVisible();
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toMatchObject({ actingAccountId: accountId });
  await expect(page.getByRole('button', { name: 'Cancel request or reservation' })).toHaveCount(0);
});

test('donor accepts, releases a reservation and no longer sees collection details on cancelled rows', async ({
  page,
}) => {
  await account(page);
  const donorOffer = { ...offered, ownerAccountId: accountId };
  let row = {
    id: 'donor-reservation',
    offerId: offered.id,
    donorAccountId: accountId,
    requesterAccountId: 'recipient-fixture',
    quantity: 2,
    status: 'requested',
    pickupInstructions: null as string | null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route('**/public/v1/materials/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/accept')) {
      row = { ...row, status: 'accepted', pickupInstructions: 'Private workshop entrance' };
      return route.fulfill({ json: row });
    }
    if (url.pathname.endsWith('/cancel')) {
      row = { ...row, status: 'cancelled', pickupInstructions: null };
      return route.fulfill({ json: row });
    }
    if (url.pathname.endsWith('/reservations'))
      return route.fulfill({ json: { items: [row], nextCursor: null } });
    if (url.pathname.endsWith(`/${offered.id}`)) return route.fulfill({ json: donorOffer });
    return route.fulfill({ json: { items: [donorOffer], nextCursor: null } });
  });
  await page.goto('/materials');
  await expect(page.getByText('Acting as Materials fixture')).toBeVisible();
  await page.getByRole('button', { name: 'My requests and reservations', exact: true }).click();
  await expect(page.getByText('Awaiting donor acceptance', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept and reserve', exact: true }).click();
  await expect(page.getByText('Private workshop entrance', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'I have received these materials' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Cancel request or reservation', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('Private workshop entrance', { exact: true })).toHaveCount(0);
});
