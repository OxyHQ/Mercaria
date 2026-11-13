import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import type {
  MerchantClaim,
  MerchantClaimEligibility,
  MerchantClaimMethod,
  MerchantPage,
} from '../../../packages/shared-types/src';

// The merchant page's Claim button opens the claim flow — a Bloom dialog over
// the page — instead of pushing a settings address nothing read. Every API call
// is a fixture: the Oxy client lookup and session on api.oxy.so, and Mercaria's
// merchant page, claim surface and referral edge on the local API origin.

const MERCHANT_ID = 'merchant-fixture';
const SLUG = 'acme-outfitters';
const USER_ID = 'oxy-claim-browser-fixture';

const OXY_CLIENT = {
  application: {
    id: 'fixture',
    name: 'Mercaria fixture',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    scopes: [],
  },
};

const ALL_METHODS: MerchantClaimEligibility['availableMethods'] = [
  { method: 'dns_txt', assurance: 'high', autoVerifies: true, subjectKind: 'domain' },
  { method: 'well_known_file', assurance: 'standard', autoVerifies: true, subjectKind: 'domain' },
  { method: 'meta_tag', assurance: 'standard', autoVerifies: true, subjectKind: 'domain' },
  { method: 'platform_oauth', assurance: 'high', autoVerifies: true, subjectKind: 'connection' },
  { method: 'channel_key', assurance: 'high', autoVerifies: true, subjectKind: 'connection' },
  { method: 'business_document', assurance: 'standard', autoVerifies: false, subjectKind: null },
];

function merchantPage(claimed: boolean): MerchantPage {
  const claimState = claimed ? 'claimed' : 'unclaimed';
  return {
    merchant: {
      id: MERCHANT_ID,
      name: 'Acme Outfitters',
      slug: SLUG,
      merchantType: null,
      description: null,
      claimState,
      status: 'active',
      mergedIntoId: null,
      rating: 0,
      ratingCount: 0,
      offerCount: 0,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    aliases: [],
    standing: {
      standing: claimed ? 'claimed' : 'unclaimed',
      claimState,
      nativeCheckout: {
        merchantId: MERCHANT_ID,
        eligible: false,
        claimState,
        hasActiveNativeStoreLink: false,
      },
      eligibility: {
        merchantId: MERCHANT_ID,
        claimable: !claimed,
        reason: claimed ? 'already_claimed' : null,
        claimInProgress: false,
        claimState,
        availableMethods: ALL_METHODS,
      },
    },
    operatedChannels: [],
    sellingChannels: [],
    verifiedDomains: [],
    reviews: null,
    brandStandings: [],
    offerMix: {
      activeOfferCount: 0,
      currentOfferCount: 0,
      staleOfferCount: 0,
      byKind: [],
      bySellerRole: [],
      byCondition: [],
      byMarket: [],
    },
    contact: { source: 'none' },
  } as unknown as MerchantPage;
}

function claimRow(
  method: MerchantClaimMethod,
  state: MerchantClaim['state'],
  domain?: string,
): MerchantClaim {
  return {
    id: 'claim-1',
    merchantId: MERCHANT_ID,
    claimantOxyUserId: USER_ID,
    method,
    assurance: method === 'dns_txt' ? 'high' : 'standard',
    state,
    nativeStoreId: null,
    requestedScope: [
      { kind: 'merchant', ref: MERCHANT_ID, state: 'requested', verifiedAt: null },
      ...(domain
        ? [{ kind: 'domain' as const, ref: domain, state: 'requested' as const, verifiedAt: null }]
        : []),
    ],
    verifiedScope: [],
    expiresAt: '2026-10-30T00:00:00Z',
    revalidateAfter: null,
    revalidationDue: false,
    decisionReason: null,
    verifiedAt: state === 'verified' ? '2026-10-16T00:00:00Z' : null,
    revokedAt: null,
    revokeReason: null,
    hasConflictingClaim: state === 'disputed',
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
  };
}

async function locale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
}

async function signIn(page: Page) {
  const token = [
    'e30',
    Buffer.from(
      JSON.stringify({ sub: USER_ID, userId: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url'),
    'test-only',
  ].join('.');
  await page.addInitScript(
    ({ userId, token }) => {
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          userId,
          sessionId: 'fixture-session',
          accessToken: token,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    },
    { userId: USER_ID, token },
  );
}

async function oxy(page: Page) {
  await page.route('https://api.oxy.so/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/auth/oauth/client/')) return route.fulfill({ json: OXY_CLIENT });
    if (path === '/users/me')
      return route.fulfill({
        json: { id: USER_ID, username: 'claim-fixture', name: { displayName: 'Claim fixture' } },
      });
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
}

interface ClaimApi {
  /** Every request the claim and referral surfaces received: `METHOD path body`. */
  calls: string[];
  claims: MerchantClaim[];
}

/** The local API: a merchant page, an empty catalogue, and a stateful claim surface. */
async function mercaria(
  page: Page,
  options: { claimed?: boolean; verifyFailuresFirst?: number; claims?: MerchantClaim[] } = {},
): Promise<ClaimApi> {
  const api: ClaimApi = { calls: [], claims: options.claims ?? [] };
  let verifyFailures = options.verifyFailuresFirst ?? 0;
  await page.route('http://localhost:4160/**', (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (pathname === `/merchants/${SLUG}/page`)
      return route.fulfill({
        json: { success: true, data: merchantPage(options.claimed ?? false) },
      });
    if (pathname === `/merchants/${SLUG}/catalog`)
      return route.fulfill({
        json: {
          success: true,
          data: {
            merchantId: MERCHANT_ID,
            scope: { sellers: 'this_merchant' },
            entries: [],
            emptyReason: 'no_offers',
          },
        },
      });
    if (pathname.startsWith('/merchant-claims') || pathname.startsWith('/referrals/')) {
      api.calls.push(`${request.method()} ${pathname}${body ? ` ${JSON.stringify(body)}` : ''}`);
    }
    if (pathname === '/merchant-claims' && request.method() === 'GET')
      return route.fulfill({ json: { success: true, data: api.claims } });
    if (pathname === '/merchant-claims' && request.method() === 'POST') {
      const claim = claimRow(body.method, 'draft', body.domain);
      api.claims = [claim];
      return route.fulfill({ status: 201, json: { success: true, data: claim } });
    }
    if (pathname === '/merchant-claims/claim-1/challenge') {
      const current = api.claims[0];
      api.claims = [{ ...current, state: 'challenge_pending' }];
      const domain = current.requestedScope.find((scope) => scope.kind === 'domain')?.ref ?? '';
      return route.fulfill({
        status: 201,
        json: {
          success: true,
          data: {
            challengeId: 'challenge-1',
            method: current.method,
            subjectKind: 'domain',
            subject: domain,
            expiresAt: '2026-10-30T12:00:00Z',
            token: 'fixture-token-123',
            dnsRecordName: `_mercaria-challenge.${domain}`,
            dnsRecordValue: 'mercaria-merchant-verification=fixture-token-123',
          },
        },
      });
    }
    if (pathname === '/merchant-claims/claim-1/verify') {
      if (verifyFailures > 0) {
        verifyFailures -= 1;
        return route.fulfill({
          status: 400,
          json: { success: false, error: 'VALIDATION_ERROR', message: 'not found' },
        });
      }
      api.claims = [{ ...api.claims[0], state: 'verified' }];
      return route.fulfill({ json: { success: true, data: api.claims[0] } });
    }
    if (pathname === '/merchant-claims/claim-1/submit') {
      api.claims = [{ ...api.claims[0], state: 'review_pending' }];
      return route.fulfill({ json: { success: true, data: api.claims[0] } });
    }
    if (pathname === '/merchant-claims/contest') {
      const claim = claimRow('business_document', 'disputed');
      api.claims = [claim];
      return route.fulfill({ status: 201, json: { success: true, data: claim } });
    }
    // `REFERRALS_ENABLED=false`: the edge is unmounted, and the claim must not care.
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
  return api;
}

test('signed out, Claim asks for a session and opens no claim', async ({ page }) => {
  await locale(page);
  await oxy(page);
  const api = await mercaria(page);
  await page.goto(`/merchants/${SLUG}`);
  await page.getByRole('button', { name: en.merchants.standing.claim, exact: true }).click();
  const account = page.getByRole('dialog', { name: 'AccountDialog', exact: true });
  await expect(account).toBeVisible();
  await expect(page.getByTestId('merchant-claim-dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/merchants/${SLUG}$`));
  expect(api.calls).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`a DNS claim opens, binds a carried referral, and verifies at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await locale(page);
    await signIn(page);
    await oxy(page);
    const api = await mercaria(page, { verifyFailuresFirst: 1 });
    await page.goto(`/merchants/${SLUG}`);
    await page.getByRole('button', { name: en.merchants.standing.claim, exact: true }).click();

    const dialog = page.getByTestId('merchant-claim-dialog');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/merchants/${SLUG}$`));
    await expect(dialog.getByText(en.merchantClaim.intro, { exact: true })).toBeVisible();
    // The platform proofs need a connection only a dashboard knows; not offered here.
    await expect(dialog.getByRole('radio')).toHaveCount(4);
    await expect(
      dialog.getByText(en.merchantClaim.method.dnsTxt.description, { exact: true }),
    ).toBeVisible();

    await dialog.getByRole('textbox', { name: en.merchantClaim.domain.label }).fill('acme.example');
    await dialog.getByRole('button', { name: en.merchantClaim.start, exact: true }).click();

    await expect(
      dialog.getByText('_mercaria-challenge.acme.example', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('mercaria-merchant-verification=fixture-token-123', { exact: true }),
    ).toBeVisible();

    await dialog
      .getByRole('button', { name: en.merchantClaim.challenge.verify, exact: true })
      .click();
    await expect(
      dialog.getByText(en.merchantClaim.errors.notFoundYet, { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: en.merchantClaim.challenge.verify, exact: true })
      .click();
    await expect(
      dialog.getByText(en.merchantClaim.status.verified.title, { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

    const writes = api.calls.filter((call) => call.startsWith('POST'));
    expect(writes).toEqual([
      `POST /merchant-claims {"merchantId":"${MERCHANT_ID}","method":"dns_txt","domain":"acme.example"}`,
      `POST /referrals/merchant-binding {"merchantId":"${MERCHANT_ID}","surface":"web"}`,
      'POST /merchant-claims/claim-1/challenge',
      'POST /merchant-claims/claim-1/verify {"token":"fixture-token-123"}',
      'POST /merchant-claims/claim-1/verify {"token":"fixture-token-123"}',
    ]);
  });
}

test('a document claim goes to a person for review', async ({ page }) => {
  await locale(page);
  await signIn(page);
  await oxy(page);
  const api = await mercaria(page);
  await page.goto(`/merchants/${SLUG}`);
  await page.getByRole('button', { name: en.merchants.standing.claim, exact: true }).click();
  const dialog = page.getByTestId('merchant-claim-dialog');
  await dialog
    .getByRole('radio', { name: new RegExp(en.merchantClaim.method.businessDocument.label) })
    .click();
  await expect(dialog.getByRole('textbox', { name: en.merchantClaim.domain.label })).toHaveCount(0);
  await dialog.getByRole('button', { name: en.merchantClaim.start, exact: true }).click();

  const link = dialog.getByRole('textbox', { name: en.merchantClaim.evidence.urlLabel });
  await expect(link).toBeVisible();
  await link.fill('https://files.example/registration.pdf');
  await dialog.getByRole('button', { name: en.merchantClaim.evidence.submit, exact: true }).click();
  await expect(
    dialog.getByText(en.merchantClaim.status.reviewPending.title, { exact: true }),
  ).toBeVisible();
  expect(api.calls.filter((call) => call.startsWith('POST'))).toEqual([
    `POST /merchant-claims {"merchantId":"${MERCHANT_ID}","method":"business_document"}`,
    `POST /referrals/merchant-binding {"merchantId":"${MERCHANT_ID}","surface":"web"}`,
    'POST /merchant-claims/claim-1/submit {"evidence":[{"url":"https://files.example/registration.pdf"}]}',
  ]);
});

test('a claim whose code was issued elsewhere resumes at a new code', async ({ page }) => {
  await locale(page);
  await signIn(page);
  await oxy(page);
  await mercaria(page, { claims: [claimRow('dns_txt', 'challenge_pending', 'acme.example')] });
  await page.goto(`/merchants/${SLUG}`);
  await page.getByRole('button', { name: en.merchants.standing.claim, exact: true }).click();
  const dialog = page.getByTestId('merchant-claim-dialog');
  await expect(dialog.getByText(en.merchantClaim.challenge.lost, { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { name: en.merchantClaim.challenge.getCode, exact: true })
    .click();
  await expect(dialog.getByText('_mercaria-challenge.acme.example', { exact: true })).toBeVisible();
});

test('a claimed merchant offers a contest, decided by a person', async ({ page }) => {
  await locale(page);
  await signIn(page);
  await oxy(page);
  const api = await mercaria(page, { claimed: true });
  await page.goto(`/merchants/${SLUG}`);
  await expect(
    page.getByRole('button', { name: en.merchants.standing.claim, exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: en.merchants.standing.contest, exact: true }).click();
  const dialog = page.getByTestId('merchant-claim-dialog');
  await expect(dialog.getByText(en.merchantClaim.contest.intro, { exact: true })).toBeVisible();
  const send = dialog.getByRole('button', { name: en.merchantClaim.contest.submit, exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByRole('textbox').first().fill('I run this business and nobody else does.');
  await send.click();
  await expect(
    dialog.getByText(en.merchantClaim.status.disputed.title, { exact: true }),
  ).toBeVisible();
  expect(api.calls.filter((call) => call.startsWith('POST'))).toEqual([
    `POST /merchant-claims/contest {"merchantId":"${MERCHANT_ID}","reason":"I run this business and nobody else does."}`,
  ]);
});
