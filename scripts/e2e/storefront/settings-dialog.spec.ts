import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ui from '../../../packages/ui/src/i18n/locales/en.json';

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
