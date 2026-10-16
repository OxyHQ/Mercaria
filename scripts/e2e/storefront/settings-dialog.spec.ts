import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ui from '../../../packages/ui/src/i18n/locales/en.json';
import {
  REFERRAL_METRIC_DEFINITIONS,
  type ReferralLinkPartnerView,
  type ReferralPartnerDashboard,
} from '../../../packages/shared-types/src';

// Settings is Bloom's SettingsModal (the Oxy-wide dialog), never a stack of
// screens: /profile opens it, a /settings/* address opens it over the page
// underneath, and a choice inside it applies at once. Signed out, so no API
// writes happen; the Oxy client lookup is the only network fixture.
async function signedOut(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem(
      'mercaria.bloom.theme',
      JSON.stringify({ mode: 'light', colorPreset: 'blue' }),
    );
  });
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
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
}

for (const width of [390, 1440]) {
  test(`profile opens the settings dialog and theme applies live at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await signedOut(page);
    await page.goto('/profile');
    await page.getByRole('button', { name: en.settings.sections.general, exact: true }).click();

    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-label', ui.ui.settings.dialog);
    await expect(page).toHaveURL(/\/profile$/);
    await expect(
      dialog.getByText(ui.ui.settings.language.title, { exact: true }).first(),
    ).toBeVisible();
    await expect(dialog.getByText(en.settings.currency.signedOut, { exact: true })).toBeVisible();

    // The section list: compact screens go back to it, wide ones show it beside the page.
    if (width < 640)
      await dialog.getByRole('button', { name: ui.ui.settings.back, exact: true }).click();
    await dialog.getByText(ui.ui.settings.pages.appearance, { exact: true }).first().click();
    await dialog.getByRole('radio', { name: ui.ui.settings.appearance.dark, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('mercaria.bloom.theme') ?? ''))
      .toContain('"dark"');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

test('a /settings/* address opens the dialog on its page over the storefront', async ({ page }) => {
  await signedOut(page);
  await page.goto('/settings/feedback');
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(en.feedback.subtitle, { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/settings/);
});

test('signed in, the dialog carries the account pages and a row that leaves it closes it first', async ({
  page,
}) => {
  const userId = 'oxy-settings-browser-fixture';
  const token = [
    'e30',
    Buffer.from(
      JSON.stringify({ sub: userId, userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url'),
    'test-only',
  ].join('.');
  await page.addInitScript(
    ({ userId, token }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
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
    { userId, token },
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
          id: userId,
          username: 'settings-fixture',
          name: { displayName: 'Settings fixture' },
          email: 'settings@example.invalid',
        },
      });
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
  await page.route('http://localhost:4160/**', (route) =>
    route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } }),
  );

  await page.goto('/profile');
  await page.getByRole('button', { name: en.settings.account.title, exact: true }).click();
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog.getByText('Settings fixture', { exact: true })).toBeVisible();
  await expect(dialog.getByText(ui.ui.settings.account.oxyAccount, { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(en.settings.sections.addresses, { exact: true }).first(),
  ).toBeVisible();

  await dialog.getByText(en.settings.sections.watchlists, { exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/watchlists$/);
});

test('the sidebar Settings row opens the dialog', async ({ page }) => {
  await signedOut(page);
  await page.goto('/');
  await page
    .getByRole('link', { name: en.nav.settings, exact: true })
    .or(page.getByRole('button', { name: en.nav.settings, exact: true }))
    .first()
    .click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
});

test('Referrals: a link is created, copied and listed, and every figure keeps its definition', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const userId = 'oxy-referrals-browser-fixture';
  const token = [
    'e30',
    Buffer.from(
      JSON.stringify({ sub: userId, userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url'),
    'test-only',
  ].join('.');
  await page.addInitScript(
    ({ userId, token }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
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
    { userId, token },
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
          id: userId,
          username: 'referrals-fixture',
          name: { displayName: 'Referrals fixture' },
        },
      });
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });

  const metric = REFERRAL_METRIC_DEFINITIONS.referral_human_clicks;
  const links: ReferralLinkPartnerView[] = [];
  const dashboard = (): ReferralPartnerDashboard =>
    ({
      partner: {
        id: 'p1',
        displayName: 'Fixture',
        ownerType: 'user',
        state: 'active',
        appealState: 'none',
      },
      enrollment: {
        earningStarted: true,
        outstanding: [],
        agreementStanding: 'accepted',
        requiredAgreementVersion: '1',
      },
      programs: [
        {
          program: {
            programId: 'prog-1',
            version: 1,
            name: 'Fixture programme',
            publicTermsSummary: 'Fixture terms.',
            family: 'connected_marketplace',
            status: 'active',
            attributionWindowDays: 30,
            termsVersion: '1',
            disclosureVersion: '1',
          },
          eligible: true,
          ineligibleReasons: [],
          termsAccepted: true,
          rewardBasis: { kind: 'not_published' },
        } as ReferralPartnerDashboard['programs'][number],
      ],
      limits: [],
      instruments: {
        codes: links.length
          ? [
              {
                id: 'code-1',
                code: 'FIXTURE',
                status: 'active',
                programId: 'prog-1',
                disclosureRequired: true,
                createdAt: '2026-10-16T00:00:00Z',
              },
            ]
          : [],
        links: [...links],
        disclosureText: 'I may earn a reward when you buy through this link.',
        disclosureVersion: '1',
      },
      performance: {
        dimension: 'date',
        from: '2026-09-16',
        through: '2026-10-16',
        rows: [],
        totals: { humanClicks: 0, qualifiedConversions: 0 },
        withheldRowCount: 0,
        metrics: [metric],
      },
      earnings: { pendingConversions: 0, byCurrency: [], recentRewards: [], metrics: [] },
      payouts: {
        earningEnabled: true,
        payoutEnabled: false,
        identity: 'pending',
        tax: 'pending',
        payout: 'pending',
        outstanding: [],
        supportedCurrencies: ['EUR'],
        cadence: 'monthly',
        recentPayouts: [],
      },
      support: { appealAvailable: false, unavailable: [] },
    }) as ReferralPartnerDashboard;
  const writes: string[] = [];
  await page.route('http://localhost:4160/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/referral-partner/dashboard')
      return route.fulfill({ json: { success: true, data: dashboard() } });
    if (pathname === '/referral-partner/codes') {
      writes.push(`code ${route.request().postDataJSON().programId}`);
      return route.fulfill({
        status: 201,
        json: {
          success: true,
          data: {
            code: {
              id: 'code-1',
              code: 'FIXTURE',
              status: 'active',
              programId: 'prog-1',
              disclosureRequired: true,
              createdAt: '2026-10-16T00:00:00Z',
            },
          },
        },
      });
    }
    if (pathname === '/referral-partner/links') {
      writes.push(`link ${route.request().postDataJSON().codeId}`);
      const link: ReferralLinkPartnerView = {
        id: 'link-1',
        codeId: 'code-1',
        token: 'fixturetoken',
        status: 'active',
        createdAt: '2026-10-16T00:00:00Z',
      };
      links.push(link);
      return route.fulfill({ status: 201, json: { success: true, data: { link } } });
    }
    if (pathname === '/referrals/code-entry') {
      const body = route.request().postDataJSON();
      writes.push(`entry ${body.code} ${body.moment}`);
      return route.fulfill({
        json: {
          success: true,
          data: {
            state: 'attributed',
            disclosureRequired: true,
            publicTermsSummary: 'Typed terms.',
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });

  await page.goto('/referral-partner');
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/referral-partner/);
  await expect(dialog.getByText(en.referral.links.empty, { exact: true })).toBeVisible();
  // The disclosure is verbatim, and a figure still carries its definition.
  await expect(
    dialog.getByText('“I may earn a reward when you buy through this link.”', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(metric.label, { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: en.referral.links.create, exact: true }).click();
  await expect(page.getByText(en.referral.links.copied, { exact: true })).toBeVisible();
  expect(writes).toEqual(['code prog-1', 'link code-1']);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/r\/fixturetoken$/);
  await expect(dialog.getByText(/\/r\/fixturetoken$/)).toBeVisible();
  await expect(dialog.getByText('FIXTURE', { exact: true })).toBeVisible();

  // A code somebody was given is typed here — the `in_app` moment, never checkout.
  await dialog.getByLabel(en.referral.code.label, { exact: true }).fill('FRIEND10');
  await dialog.getByRole('button', { name: en.referral.code.apply, exact: true }).click();
  await expect(page.getByText(en.referral.code.applied, { exact: true })).toBeVisible();
  expect(writes.at(-1)).toBe('entry FRIEND10 in_app');
  await expect(dialog.getByText('Typed terms.', { exact: true })).toBeVisible();
});
