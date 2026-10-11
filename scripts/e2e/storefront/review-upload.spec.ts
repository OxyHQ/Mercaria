import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  test(`review upload errors preserve the draft and never promote a private file at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const userId = 'review-upload-test-author';
    const token = [
      'e30',
      Buffer.from(
        JSON.stringify({ sub: userId, userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url'),
      'test-only',
    ].join('.');
    await page.addInitScript(
      ({ userId, token }) => {
        localStorage.setItem(
          'i18n-storage',
          JSON.stringify({ state: { locale: 'en' }, version: 0 }),
        );
        localStorage.setItem(
          'oxy.auth.v1',
          JSON.stringify({
            userId,
            sessionId: 'review-test-session',
            accessToken: token,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
      },
      { userId, token },
    );
    let uploads = 0;
    let releaseUpload: (() => void) | undefined;
    const assetWrites: string[] = [];
    // Transport refusal tests only: no real credentials, image bytes returned,
    // successful attachment fixture, or claim that an upload exists in Oxy.
    await page.route('https://api.oxy.so/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/auth/oauth/client/'))
        return route.fulfill({
          json: {
            application: {
              id: 'review-test',
              name: 'Review test',
              type: 'first_party',
              isOfficial: true,
              isInternal: false,
              scopes: [],
            },
          },
        });
      if (path === '/users/me')
        return route.fulfill({
          json: { id: userId, username: 'review-test', name: { displayName: 'Review test' } },
        });
      if (path.startsWith('/assets/') && request.method() !== 'GET') assetWrites.push(path);
      if (path === '/assets/upload') {
        uploads++;
        expect(request.postData()).toContain('name="visibility"');
        expect(request.postData()).toContain('public');
        if (uploads === 1) {
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          return route.fulfill({ status: 503, json: { error: 'Test upload outage' } });
        }
        // An upload response alone must not be trusted: its metadata read below
        // deliberately describes a PRIVATE file, which cannot be attached.
        return route.fulfill({ json: { file: { id: 'unavailable-review-upload-test' } } });
      }
      if (path === '/assets/unavailable-review-upload-test')
        return route.fulfill({
          json: {
            assetId: 'unavailable-review-upload-test',
            file: {
              id: 'unavailable-review-upload-test',
              ownerUserId: userId,
              status: 'active',
              visibility: 'private',
              mime: 'image/jpeg',
              size: 100,
            },
          },
        });
      return route.fulfill({ status: 404, json: { error: 'Unused test endpoint' } });
    });
    const reviews: Record<string, unknown>[] = [];
    await page.route('http://localhost:4160/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/reviews/eligibilities') {
        const grant = {
          id: 'product-review-grant',
          oxyUserId: userId,
          orderId: 'order-test',
          orderItemId: 'line-test',
          scope: 'product',
          targetType: 'canonical_product',
          targetId: 'product-test',
          evidenceType: 'native_order',
          state: 'open',
        };
        return route.fulfill({
          json: {
            success: true,
            data: [
              grant,
              {
                ...grant,
                id: 'private-review-grant',
                scope: 'native_transaction',
                targetType: 'order_item',
                targetId: 'line-test',
              },
              { ...grant, id: 'foreign-review-grant', oxyUserId: 'another-account' },
              { ...grant, id: 'consumed-review-grant', state: 'consumed' },
            ],
          },
        });
      }
      if (path === '/orders')
        return route.fulfill({
          json: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } },
        });
      if (path === '/reviews' && request.method() === 'POST') {
        reviews.push(request.postDataJSON());
        return route.fulfill({
          status: 503,
          json: { success: false, message: 'Test review outage' },
        });
      }
      if (request.method() !== 'GET')
        return route.fulfill({ status: 403, json: { success: false } });
      const headers = request.headers();
      delete headers.authorization;
      return route.continue({ headers });
    });
    await page.goto('/orders');
    const prompt = page.getByTestId('review-prompt-product-review-grant');
    await expect(prompt).toBeVisible();
    await expect(page.getByTestId('review-prompt-foreign-review-grant')).toHaveCount(0);
    await expect(page.getByTestId('review-prompt-consumed-review-grant')).toHaveCount(0);
    await expect(
      page.getByTestId('review-prompt-private-review-grant').getByTestId('review-media-upload'),
    ).toHaveCount(0);
    if (width === 390) await prompt.getByRole('radio').nth(3).click();
    else {
      await prompt.getByRole('radio').first().focus();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
    }
    await expect(prompt.getByRole('radio').nth(3)).toBeChecked();
    await prompt.getByRole('textbox').fill('My review draft survives the upload error.');
    const publish = prompt.getByRole('button', { name: 'Publish review', exact: true });
    await expect(publish).toBeEnabled();
    const input = prompt.locator('input[type=file]');
    await input.setInputFiles({
      name: 'unsupported.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await expect(prompt.getByRole('alert')).toContainText('Up to 10 files');
    expect(uploads).toBe(0);
    await input.setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('rejected upload test'),
    });
    await expect.poll(() => uploads).toBe(1);
    await expect(publish).toBeDisabled();
    await expect.poll(() => prompt.ariaSnapshot()).not.toContain('Upload complete');
    releaseUpload!();
    await expect(prompt.getByRole('alert')).toHaveText(
      'The upload could not be verified. Try again.',
    );
    await expect(publish).toBeEnabled();
    await prompt.getByRole('button', { name: /^try again$/i }).click();
    await expect.poll(() => uploads).toBe(2);
    await expect(prompt.getByRole('alert')).toHaveText(
      'The upload could not be verified. Try again.',
    );
    await expect(publish).toBeEnabled();
    await expect(prompt.getByRole('button', { name: 'Remove photo.jpg', exact: true })).toHaveCount(
      0,
    );
    await publish.click();
    await expect.poll(() => reviews.length).toBe(1);
    expect(reviews[0]).toMatchObject({
      rating: 4,
      eligibilityId: 'product-review-grant',
      body: 'My review draft survives the upload error.',
    });
    expect(reviews[0]).not.toHaveProperty('mediaFileIds');
    await expect(prompt.getByRole('textbox')).toHaveValue(
      'My review draft survives the upload error.',
    );
    expect(assetWrites).toEqual(['/assets/upload', '/assets/upload']);
    await page.screenshot({ path: `/tmp/mercaria-review-upload-failure-${width}.png` });
  });
}
