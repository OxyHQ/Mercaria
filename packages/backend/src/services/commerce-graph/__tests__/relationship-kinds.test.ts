/**
 * The relationship TYPE registry: that it answers all nine of the issue's
 * relationship types, that it constrains subject and object entity kinds, and
 * that "Official store" and "Authorized reseller" stay different words for
 * different facts.
 *
 * The nine-question check is the one worth reading. Six are relationship kinds
 * and three are foreign keys (ADR 0002 D17: containment is an FK, assertable and
 * temporal facts are rows) — so the gate is that every question is answered by
 * exactly ONE mechanism, never both, which is what stops a second representation
 * of a fact appearing later and disagreeing with the first.
 */

import { describe, expect, it } from 'vitest';
import {
  BADGE_RELATIONSHIP_KINDS,
  PUBLIC_RELATIONSHIP_BADGES,
  RELATIONSHIP_ENTITY_KINDS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_KIND_DEFINITIONS,
  RELATIONSHIP_VERIFICATION_METHODS,
  STRUCTURAL_GRAPH_FACTS,
} from '@mercaria/shared-types';

describe('the nine relationship types the issue requires', () => {
  it('answers all nine, six as kinds and three as foreign keys', () => {
    const answeredByKind = new Set<string>(RELATIONSHIP_KINDS);
    const answeredStructurally = new Set(STRUCTURAL_GRAPH_FACTS.map((fact) => fact.question));

    expect([...answeredByKind].sort()).toEqual([
      'brand_succeeds_brand',
      'merchant_authorized_reseller_for_brand',
      'merchant_official_channel_for_brand',
      'organization_manufactures',
      'organization_operates_merchant',
      'organization_owns_brand',
    ]);
    expect([...answeredStructurally].sort()).toEqual([
      'brand contains product family',
      'brand markets product',
      'merchant operates storefront',
    ]);
    expect(answeredByKind.size + answeredStructurally.size).toBe(9);
  });

  it('never answers one question BOTH ways', () => {
    // A relationship kind duplicating a structural fact would be a second
    // representation that can disagree with the foreign key — the exact failure
    // ADR 0002 D17 forbids. Matching on the noun pair rather than the exact
    // string, so a kind named `merchant_operates_storefront` is caught however
    // it is spelled.
    for (const fact of STRUCTURAL_GRAPH_FACTS) {
      const nouns = fact.question.split(' ').filter((word) => word.length > 4);
      for (const kind of RELATIONSHIP_KINDS) {
        const matched = nouns.every((noun) => kind.includes(noun.replace(/s$/, '')));
        expect(matched, `${kind} duplicates the structural fact "${fact.question}"`).toBe(false);
      }
    }
  });

  it('states WHERE each structural fact is stored, so the answer is findable', () => {
    for (const fact of STRUCTURAL_GRAPH_FACTS) {
      expect(fact.storedAs).toMatch(/\w+\.\w+/);
      expect(fact.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('every kind constrains its subject and object entity kinds', () => {
  it('declares both endpoints, from the closed entity-kind set', () => {
    for (const kind of RELATIONSHIP_KINDS) {
      const definition = RELATIONSHIP_KIND_DEFINITIONS[kind];
      expect(RELATIONSHIP_ENTITY_KINDS).toContain(definition.subject);
      expect(RELATIONSHIP_ENTITY_KINDS).toContain(definition.object);
      expect(definition.description.length).toBeGreaterThan(20);
    }
  });

  it('reads its endpoints the way its name does', () => {
    expect(RELATIONSHIP_KIND_DEFINITIONS.organization_owns_brand).toMatchObject({
      subject: 'organization',
      object: 'brand',
    });
    expect(RELATIONSHIP_KIND_DEFINITIONS.merchant_official_channel_for_brand).toMatchObject({
      subject: 'merchant',
      object: 'brand',
    });
    expect(RELATIONSHIP_KIND_DEFINITIONS.organization_manufactures).toMatchObject({
      subject: 'organization',
      object: 'product_family',
    });
    // The one kind with the same entity kind on both ends, and the reason
    // `related_brand_id` exists as a fifth endpoint column.
    expect(RELATIONSHIP_KIND_DEFINITIONS.brand_succeeds_brand).toMatchObject({
      subject: 'brand',
      object: 'brand',
    });
  });

  it('keeps manufacturing and brand ownership as different kinds (ADR 0002 D11)', () => {
    // Foxconn manufactures iPhones and owns no Apple brand. Neither kind may be
    // derivable from the other, which starts with them not sharing endpoints.
    expect(RELATIONSHIP_KIND_DEFINITIONS.organization_manufactures.object).toBe('product_family');
    expect(RELATIONSHIP_KIND_DEFINITIONS.organization_owns_brand.object).toBe('brand');
  });
});

describe('“Official store” and “Authorized reseller” are different public language', () => {
  it('are two distinct badges from two distinct kinds', () => {
    expect(RELATIONSHIP_KIND_DEFINITIONS.merchant_official_channel_for_brand.publicBadge).toBe(
      'official_store',
    );
    expect(RELATIONSHIP_KIND_DEFINITIONS.merchant_authorized_reseller_for_brand.publicBadge).toBe(
      'authorized_reseller',
    );
    expect(new Set(PUBLIC_RELATIONSHIP_BADGES).size).toBe(2);
  });

  it('produces a badge from no other kind', () => {
    const withBadges = RELATIONSHIP_KINDS.filter(
      (kind) => RELATIONSHIP_KIND_DEFINITIONS[kind].publicBadge !== null,
    );
    expect(withBadges).toEqual([...BADGE_RELATIONSHIP_KINDS]);
    expect(RELATIONSHIP_KIND_DEFINITIONS.organization_owns_brand.publicBadge).toBeNull();
    expect(RELATIONSHIP_KIND_DEFINITIONS.brand_succeeds_brand.publicBadge).toBeNull();
  });
});

describe('no badge can be produced from a name, a logo or a domain (acceptance 1)', () => {
  it('offers no name-match or logo-match verification method', () => {
    // The closed set is what makes "verified because the name matched"
    // unrepresentable rather than merely forbidden — the same device
    // `NATIVE_STORE_LINK_METHODS` uses for #54's linkage.
    for (const method of RELATIONSHIP_VERIFICATION_METHODS) {
      expect(method).not.toMatch(/name|logo|similar|fuzzy|match/);
    }
    expect([...RELATIONSHIP_VERIFICATION_METHODS].sort()).toEqual([
      'brand_statement',
      'domain_control',
      'legal_register',
      'operator_review',
      'platform_verification',
    ]);
  });
});
