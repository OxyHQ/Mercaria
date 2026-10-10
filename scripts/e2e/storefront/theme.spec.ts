import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compile } from '@tailwindcss/node';
import { compile as compileNative } from 'react-native-css/compiler';
import { expect, test } from '@playwright/test';

// Compile each real app entry so a missing shared import cannot pass. The
// browser checks the cascade; the native compiler checks platform separation.
for (const app of ['frontend', 'dashboard', 'pos']) {
  test(`${app} dark utilities follow the app selection across OS themes`, async ({ page }) => {
    const base = resolve(__dirname, `../../../packages/${app}`);
    const compiler = await compile(await readFile(`${base}/global.css`, 'utf8'), {
      base,
      onDependency() {},
    });
    const css = compiler.build(['bg-white', 'dark:bg-black']);
    await page.setContent('<div id="swatch" class="bg-white dark:bg-black">Theme</div>');
    await page.addStyleTag({ content: css });
    for (const system of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: system });
      for (const dark of [false, true]) {
        await page.evaluate(
          (enabled) => document.documentElement.classList.toggle('dark', enabled),
          dark,
        );
        await expect(page.locator('#swatch')).toHaveCSS(
          'background-color',
          dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
        );
      }
    }
    const native = compileNative(css).stylesheet();
    const darkRules = native.s?.find(([name]) => name === 'dark:bg-black')?.[1];
    expect(darkRules?.length).toBeGreaterThan(0);
    for (const rule of darkRules!) {
      // No web selector/ancestor rule leaks into the native style registry.
      expect(rule.m).toEqual([
        [
          '&',
          [
            ['=', 'platform', 'native'],
            ['=', 'prefers-color-scheme', 'dark'],
          ],
        ],
      ]);
      expect(rule.d).toContainEqual({ backgroundColor: '#000' });
    }
  });
}
