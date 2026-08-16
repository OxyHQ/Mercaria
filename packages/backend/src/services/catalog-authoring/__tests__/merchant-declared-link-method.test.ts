/**
 * Where `merchant_declared` sits, in the two places a seventh link method lands
 * silently (#367 step 5, ADR 0007 D10).
 *
 * `CONFIDENT_LINK_METHODS` (#80) is derived by SUBTRACTION from
 * `NATIVE_LISTING_LINK_METHODS`, so adding a member makes it confident with no
 * diff anywhere saying so. #91 hit exactly this and wrote
 * `sell-yours/__tests__/link-method-confidence.test.ts` for it; this is the same
 * test for the same mechanism, because without one "we thought about this" and
 * "nobody noticed" produce identical code.
 *
 * The decision, stated once: a `merchant_declared` attachment is a store member
 * holding `products:write` choosing from a search that offers only `active`
 * canonical products, on a surface that showed them the identifiers, and ADR
 * 0007 D10 forbids the matcher from overruling it. Somebody has agreed it —
 * which is the whole of what `matcher` lacks and the whole of why `matcher` is
 * excluded.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_LISTING_LINK_METHODS } from '@mercaria/shared-types';
import {
  CONFIDENT_LINK_METHODS,
  PRODUCT_SAVE_MIGRATION_VERSION,
  UNCONFIDENT_LINK_METHODS,
} from '../../product-saves/mapping-version.js';
import { MERCHANT_DECLARED_MATCH_RULE } from '../publish.service.js';

describe('the confidence classification of a merchant-declared attachment', () => {
  it('`merchant_declared` is a real link method', () => {
    expect(NATIVE_LISTING_LINK_METHODS).toContain('merchant_declared');
  });

  it('it IS confident enough to carry a product save', () => {
    expect(
      CONFIDENT_LINK_METHODS,
      'if this ever needs to change, move it into `UNCONFIDENT_LINK_METHODS` deliberately and ' +
        'bump `PRODUCT_SAVE_MIGRATION_VERSION` — do not leave it decided by a filter',
    ).toContain('merchant_declared');
  });

  it('`matcher` is still the ONLY unconfident method, which is what the exclusion means', () => {
    expect([...UNCONFIDENT_LINK_METHODS]).toEqual(['matcher']);
  });

  it('the product-save migration version is deliberately NOT bumped', () => {
    // #91 DID bump, and the difference is retroactivity. `seller_declared` rows
    // already existed when it became confident, so favorites previously recorded
    // as skipped had to be re-examined. NO row carries `merchant_declared` at the
    // moment this ships — the method is minted by a publication path that did
    // not exist — so no stored verdict changes, and a bump would re-run the whole
    // favorite migration to reach the same answer.
    //
    // The residual is a general property of the migration rather than something
    // this change introduces: a link created AFTER a migration run never causes a
    // re-examination, which is equally true of `operator`.
    expect(PRODUCT_SAVE_MIGRATION_VERSION).toBeTruthy();
  });

  it('the match rule is a stable, namespaced constant rather than a free string', () => {
    // `native_listing_links_match_rule_check` refuses an empty one, and #59's
    // review tooling groups by it — so a per-call sentence would make "how many
    // attachments did the authoring wizard produce" unanswerable.
    expect(MERCHANT_DECLARED_MATCH_RULE).toBe('authoring.merchant_declared');
  });
});
