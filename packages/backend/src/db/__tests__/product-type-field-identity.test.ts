/**
 * The identity a product-type FIELD keeps across a version bump, and the
 * version-level change a publish may honestly claim (#650).
 *
 * Two spellings of one identity can disagree, and this is the pair that would:
 * `services/catalog-governance/diff.ts` decides which fields of two versions
 * are THE SAME FIELD, and
 * `db/catalogLocalization/productTypeFieldLocalizationRepository.ts` decides
 * which field a translation is carried onto. If they ever drift, a diff
 * reporting "nothing changed" sits beside a copy forward that matched nothing,
 * and the visible symptom is a v2 that simply has no translations — which is
 * indistinguishable from a v1 that had none.
 *
 * So the pin is against the diff's REAL OUTPUT rather than against a second
 * copy of the format string: `diffProductTypeVersions` puts its own `fieldKey`
 * into every entry's `key`, so reading one is reading the function.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveProductTypeSemanticChange,
} from '../catalogLocalization/productTypeLocalizationRepository.js';
import { productTypeFieldIdentity } from '../catalogLocalization/productTypeFieldLocalizationRepository.js';
import { diffProductTypeVersions } from '../../services/catalog-governance/diff.js';

const FIELD = {
  attributeKey: 'storage_capacity',
  attributeDefinitionVersion: 3,
  scope: 'variant' as const,
  flow: 'merchant' as const,
  requirement: 'required' as const,
  valuePolicy: 'typed_scalar' as const,
  variantCapable: true,
  groupKey: null,
};

describe('productTypeFieldIdentity', () => {
  it('is the SAME identity the governance diff matches two versions on', () => {
    // A field present in v1 and absent from v2. The diff reports it `removed`
    // and stamps its own key on the entry, so this reads the real function
    // rather than restating its format.
    const diff = diffProductTypeVersions(
      { version: 1, fields: [FIELD], categoryIds: [] },
      { version: 2, fields: [], categoryIds: [] },
    );

    const removed = diff.entries.filter((entry) => entry.change === 'removed');
    // The positive control. With an empty `entries` the comparison below would
    // hold against `undefined` on both sides of nothing.
    expect(removed, 'the diff reported no removal, so there is no key to compare').toHaveLength(1);
    expect(removed[0].key).toBe(productTypeFieldIdentity(FIELD));
  });

  it('separates the same attribute asked in two flows and at two scopes', () => {
    const merchant = productTypeFieldIdentity({ ...FIELD, flow: 'merchant' });
    const p2p = productTypeFieldIdentity({ ...FIELD, flow: 'p2p' });
    const asProduct = productTypeFieldIdentity({ ...FIELD, scope: 'product' });

    // A P2P form is a different, shorter form asking a different question, and
    // the same attribute may be a product fact on one field and a variant axis
    // on another. Collapsing either would carry one form's wording onto the
    // other's box.
    expect(new Set([merchant, p2p, asProduct]).size).toBe(3);
  });

  it('does not read the row id, which is minted per version', () => {
    // The failure this whole join exists to avoid: joining on the id matches
    // nothing across a bump and silently carries nothing.
    const identity = productTypeFieldIdentity(FIELD);
    expect(identity).not.toMatch(/id/u);
    expect(identity).toBe('merchant:variant:storage_capacity');
  });
});

describe('deriveProductTypeSemanticChange', () => {
  const v1 = { name: 'Smartphone', description: 'A phone' };

  it('always reports the version help text as changed, because it has no base to compare', () => {
    // `product_type_definitions` carries `name` and `description` and NO
    // `help_text`, so the version-level help text lives only inside
    // `product_type_localizations` and nothing holds a previous value. Claiming
    // it did not move would leave help text describing the old question sitting
    // at `approved`.
    const change = deriveProductTypeSemanticChange(v1, { ...v1 });
    expect(change.kind).toBe('diffed');
    expect(change.kind === 'diffed' ? change.changedFields : []).toEqual([
      'product_type.help_text',
    ]);
  });

  it('is sharper than `unknown`: an unchanged name is not reported as changed', () => {
    // This is the whole reason publish derives rather than declaring
    // `{ kind: 'unknown' }`. `unknown` stales every locale on every bump,
    // including one holding nothing but a name that demonstrably did not move.
    const change = deriveProductTypeSemanticChange(v1, { ...v1 });
    expect(change.kind === 'diffed' ? change.changedFields : []).not.toContain(
      'product_type.name',
    );
  });

  it('reports a renamed version and a rewritten description', () => {
    const change = deriveProductTypeSemanticChange(v1, {
      name: 'Mobile phone',
      description: 'A handheld phone',
    });
    const fields = change.kind === 'diffed' ? change.changedFields : [];
    expect([...fields].sort()).toEqual(
      ['product_type.description', 'product_type.help_text', 'product_type.name'].sort(),
    );
  });

  it('treats a description arriving or disappearing as a change', () => {
    // NULL -> text and text -> NULL both move what a translation describes, and
    // a `!==` on nullable strings is what makes both count.
    const added = deriveProductTypeSemanticChange({ name: 'Phone', description: null }, v1);
    const removed = deriveProductTypeSemanticChange(v1, { name: 'Smartphone', description: null });
    for (const change of [added, removed]) {
      expect(change.kind === 'diffed' ? change.changedFields : []).toContain(
        'product_type.description',
      );
    }
  });
});
