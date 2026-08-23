/**
 * A catalog price is denominated in the STORE's currency, never a literal (#927).
 *
 * ## Why this is a scanned gate and not a unit test
 *
 * `toMinorUnits` is already correct and already tested: it takes the currency and
 * scales by `CURRENCY_PRECISION`. The defect is entirely in the CALLERS, which
 * passed `"FAIR"` regardless of the store. So a unit test on the helper passes
 * today, with the bug live — it would be a test of the half that works.
 *
 * ## Why the bug is invisible without a magnitude assertion
 *
 * The product screens wrote FAIR and read back with `toMajorString(amount,
 * "FAIR")`, so the dashboard round-tripped consistently: type `148.00`, see
 * `148` again. Every OTHER consumer — the pricing engine's shop-side
 * conversion, reports, `PriceDisplay` — read a number the merchant meant as
 * euros and treated it as FairCoin, at eight decimals instead of two. A test
 * that only round-trips through the same pair of helpers inherits exactly that
 * blindness, which is why the magnitude case below asserts `14_800` and names
 * the wrong answer it must not produce.
 *
 * ## Scope, and what deliberately falls outside it
 *
 * The rule is about constructing or reading a `Money` for a CATALOG price, so it
 * is scoped to the product screens. Three nearby FAIR literals are NOT catalog
 * prices and the detectors are shaped so they are out of scope by construction
 * rather than by an exemption list:
 *
 *  - `lib/fx.tsx`'s `FAIR` is the DISPLAY pivot every rate is quoted against
 *    (ADR 0001 D8). Correct, and sweeping it into a currency-correctness change
 *    is how a correct default gets deleted as a bug.
 *  - `PricingRows.tsx`'s `enabled[0]?.currency ?? "FAIR"` is a fallback, not a
 *    write, and it is UNREACHABLE where it is consumed: `firstCurrency` is read
 *    only inside the `enabled.length > 1` branch, so `enabled[0]` exists there.
 *  - `wizard-state.ts`'s `DEFAULT_DRAFT_CURRENCY` seeds a fresh row in a form
 *    that renders a currency SELECTOR over `ALL_CURRENCY_CODES`. A visible,
 *    changeable default is the "preferred default" the money rules permit — a
 *    different shape from a silent unchangeable write.
 *
 * Known gap, named rather than excused: `app/(app)/discounts/index.tsx` scales a
 * fixed-amount discount with `toFairMinor` and sends a BARE number —
 * `CreateDiscountInput.value` carries no currency at all — so no detector here
 * can see it and no fix here can be right without settling what currency that
 * field is in. Reported on #927 rather than guessed at.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENCY_PRECISION } from '@mercaria/shared-types';
import { toMajorString, toMinorUnits } from '../money';

const PRODUCT_SCREENS = new URL('../../app/(app)/products/', import.meta.url).pathname;

function screenFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
        out.push({ path: full.slice(PRODUCT_SCREENS.length), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(PRODUCT_SCREENS);
  return out;
}

/** Comments are stripped: these screens DISCUSS currency as well as passing it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** `currency: "FAIR"` — a Money built with its denomination hardcoded. */
const MONEY_LITERAL = /\bcurrency\s*:\s*["'][A-Z]{3,4}["']/g;
/** `toMinorUnits(x, "FAIR")` / `toMajorString(x, "FAIR")` — a scale hardcoded. */
const HELPER_LITERAL = /\b(?:toMinorUnits|toMajorString)\s*\([^)]*,\s*["'][A-Z]{3,4}["']\s*\)/g;
/** `toFairMinor(...)` — one currency's scale, chosen by the function's name. */
const FAIR_WRAPPER = /\btoFairMinor\s*\(/g;

function offenders(files: readonly { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { path, text } of files) {
    const source = stripComments(text);
    for (const [label, pattern] of [
      ['money literal', MONEY_LITERAL],
      ['helper literal', HELPER_LITERAL],
      ['toFairMinor', FAIR_WRAPPER],
    ] as const) {
      const hits = source.match(pattern);
      if (hits) found.push(`${path}: ${String(hits.length)}× ${label}`);
    }
  }
  return found.sort();
}

describe('a catalog price names the store currency, not a literal', () => {
  const files = screenFiles();

  it('scans the real product screens, not an empty directory', () => {
    // The vacuity floor. Every assertion below passes over zero files, and a
    // path that resolved wrong is exactly how that happens.
    expect(files.length, `${String(files.length)} product screen files`).toBeGreaterThanOrEqual(3);
    expect(files.map((f) => f.path)).toContain('new.tsx');
  });

  it('no product screen hardcodes the currency of a price', () => {
    expect(offenders(files), 'hardcoded catalog currency').toEqual([]);
  });

  it('still names a currency SOURCE, so the absence is not achieved by deletion', () => {
    // The other half of the previous case. An empty offender list is also what
    // deleting every price field would produce, and that reads identically. Each
    // screen that writes a price must still say where its denomination comes
    // from — the store, or the variant that already carries one.
    const sources = /store\?\.defaultCurrency|variant\.price\.currency/;
    for (const name of ['new.tsx', '[id].tsx']) {
      const file = files.find((f) => f.path === name);
      expect(file, `${name} is gone`).toBeDefined();
      expect(sources.test(stripComments(file?.text ?? '')), `${name} names no currency source`).toBe(
        true,
      );
    }
  });

  it('reports a hardcoded currency when it is given one (mutation self-test)', () => {
    // The detector, driven. Without this the case above cannot tell "clean" from
    // "the patterns match nothing".
    expect(
      offenders([
        { path: 'fake.tsx', text: 'price: { amount: n, currency: "FAIR" },' },
      ]),
    ).toHaveLength(1);
    expect(
      offenders([{ path: 'fake.tsx', text: 'toMajorString(v.price.amount, "FAIR")' }]),
    ).toHaveLength(1);
    expect(offenders([{ path: 'fake.tsx', text: 'const m = toFairMinor(price);' }])).toHaveLength(1);

    // …and the other polarity: passing a currency through does not trip it.
    expect(
      offenders([
        { path: 'fake.tsx', text: 'price: { amount: n, currency: store.defaultCurrency },' },
        { path: 'ok2.tsx', text: 'toMinorUnits(row.priceMajor, row.currency)' },
      ]),
    ).toEqual([]);

    // A comment mentioning the literal is not a write.
    expect(
      offenders([{ path: 'fake.tsx', text: '// currency: "FAIR" is what this used to do' }]),
    ).toEqual([]);
  });

  it('prices in the store currency at the store scale, not FAIR', () => {
    // The magnitude assertion the round-trip cannot make. A EUR store's 148.00
    // is 14_800 minor units; the bug produced 14_800_000_000 because FAIR
    // carries eight decimals and EUR carries two.
    expect(CURRENCY_PRECISION.EUR).toBe(2);
    expect(CURRENCY_PRECISION.FAIR).toBe(8);

    const typed = '148.00';
    expect(toMinorUnits(typed, 'EUR')).toBe(14_800);
    expect(toMinorUnits(typed, 'EUR')).not.toBe(toMinorUnits(typed, 'FAIR'));
    // And the read side has to agree, or the field shows a different number
    // from the one that was stored.
    expect(toMajorString(14_800, 'EUR')).toBe('148');
  });
});
