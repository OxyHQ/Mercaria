import { expect, test } from '@playwright/test';
import type * as ReactModule from 'react';
import type * as ReactDOM from 'react-dom/client';
import type * as BloomTheme from '@oxy.so/bloom/theme';
import type * as Boundary from '../components/error-boundary';

// No route/debug switch is shipped. The development module registry exposes the
// actual Metro-built components, so this verifies RN web + real Bloom without
// aliasing/mocking their theme hooks or adding another provider to the app.
for (const context of ['provider-independent', 'inside-bloom'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`${context} recovery uses orange ${mode} and retries the failed child`, async ({
      page,
    }) => {
      // The active Bloom mode deliberately differs from the OS in the themed case.
      await page.emulateMedia({
        colorScheme: context === 'inside-bloom' ? (mode === 'dark' ? 'light' : 'dark') : mode,
        reducedMotion: 'reduce',
      });
      await page.route(/https?:\/\/(?:api\.oxy\.so|localhost:4160)\//, (route) => route.abort());
      await page.goto('/');
      const expected = await page.evaluate(
        async ({ context, mode }) => {
          interface MetroRegistry {
            (id: number): unknown;
            getModules(): Map<number, { verboseName?: string }>;
          }
          const registry = (window as unknown as { __r: MetroRegistry }).__r;
          const load = <T>(suffix: string): T => {
            const entry = [...registry.getModules()].find(([, value]) =>
              value.verboseName?.endsWith(suffix),
            );
            if (!entry) throw new Error(`Metro module not found: ${suffix}`);
            return registry(entry[0]) as T;
          };
          const React = load<typeof ReactModule>('/react/index.js');
          const ReactDOM = load<typeof import('react-dom/client')>('/react-dom/client.js');
          const { AppErrorBoundary, ThemedErrorFallback } = load<typeof Boundary>(
            'components/error-boundary.tsx',
          );
          const { buildTheme } = load<typeof BloomTheme>('/theme/index.web.js');
          const { BloomProvider } =
            load<typeof import('@oxy.so/bloom/provider')>('/provider/index.js');
          // Hide the independent application root; the test root has no ancestor
          // theme, i18n, Oxy or navigation provider. No authentication is simulated.
          document.querySelector<HTMLElement>('#root')!.hidden = true;
          const host = document.createElement('div');
          host.id = 'recovery-component-test';
          document.body.append(host);
          let failed = true;
          function Child() {
            if (failed) throw new Error('Isolated recovery acceptance error');
            return React.createElement('div', { 'data-testid': 'recovered-child' }, 'Recovered');
          }
          const tree = React.createElement(AppErrorBoundary, {
            fallback: context === 'inside-bloom' ? ThemedErrorFallback : undefined,
            children: React.createElement(Child),
          });
          const root: ReactDOM.Root = ReactDOM.createRoot(host);
          root.render(
            context === 'inside-bloom'
              ? React.createElement(BloomProvider, {
                  colorPreset: 'orange',
                  mode,
                  fonts: false,
                  children: tree,
                })
              : tree,
          );
          // A real failed descendant is repaired before pressing the real retry.
          (window as unknown as { repairChild: () => void }).repairChild = () => {
            failed = false;
          };
          const normalize = (color: string) => {
            const node = document.createElement('span');
            node.style.color = color;
            host.append(node);
            const value = getComputedStyle(node).color;
            node.remove();
            return value;
          };
          const colors = buildTheme('orange', mode).colors;
          return { background: normalize(colors.background), primary: normalize(colors.primary) };
        },
        { context, mode },
      );
      const fallback = page.getByTestId('app-error-fallback');
      await expect(fallback).toBeVisible();
      await expect(fallback).toHaveCSS('background-color', expected.background);
      const retry = page.locator('#recovery-component-test').getByRole('button');
      await expect(retry).toHaveCount(1);
      await expect(retry).toHaveAccessibleName(/.+/);
      // Bloom paints its surface in ::after; RN's independent button paints
      // the host. Compare the visible RGB channels and require a visible fill.
      await expect
        .poll(() =>
          retry.evaluate((node, context) => {
            const paint = getComputedStyle(
              node,
              context === 'inside-bloom' ? '::after' : null,
            ).backgroundColor;
            const channels = paint.match(/[\d.]+/g)?.map(Number) ?? [];
            return { rgb: channels.slice(0, 3), visible: (channels[3] ?? 1) > 0 };
          }, context),
        )
        .toEqual({ rgb: expected.primary.match(/[\d.]+/g)!.map(Number), visible: true });
      await page.screenshot({ path: `/tmp/wholesale-recovery-${context}-${mode}.png` });
      await page.evaluate(() => (window as unknown as { repairChild: () => void }).repairChild());
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('recovered-child')).toBeVisible();
      await expect(fallback).toHaveCount(0);
    });
  }
}
