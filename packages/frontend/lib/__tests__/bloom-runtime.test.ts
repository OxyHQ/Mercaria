import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// SurfaceProvider, Dialog and OverlayInertBoundary must read the same context.
// A nested Bloom can typecheck and bundle while leaving Oxy dialogs invisible.
describe('installed Bloom runtime', () => {
  for (const app of ['frontend', 'dashboard', 'pos']) {
    it(`${app} and Oxy Services resolve one surface and theme implementation`, () => {
      const consumer = createRequire(new URL(`../../../${app}/package.json`, import.meta.url).href);
      const services = createRequire(consumer.resolve('@oxy.so/services'));
      for (const entry of ['@oxy.so/bloom/surfaces', '@oxy.so/bloom/theme']) {
        expect(realpathSync(services.resolve(entry)), `${app}: ${entry} must be shared with Services`)
          .toBe(realpathSync(consumer.resolve(entry)));
      }
    });
  }
});
