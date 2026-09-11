/**
 * The 3D profile package's PURE controls (#1015 Workstream 3).
 *
 * Nothing here touches a database, and that is the division of labour rather
 * than a convenience: every rule in this file is a property of the package VALUE
 * or of a pure judgement over it, and each one is driven with a mutation that
 * shows it can fail. `three-d-profiles.realdb.test.ts` drives the half that only
 * a real server can answer — the triggers, the publication refusals and the
 * census — and this file drives the half a real server cannot, which includes
 * every vacuity floor and the licence states the database refuses to let a test
 * manufacture.
 *
 * ## The floors come first
 *
 * Every `for` loop below is vacuously green over an empty package, which is
 * exactly what a broken import produces. So the first block asserts the
 * populations before anything iterates one, and the numbers are the package's
 * real sizes rather than `> 0`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIGITAL_LICENCE_UPDATE_POLICIES,
  DIGITAL_VERTICALS,
  MERCARIA_REFERENCE_LICENCES,
  PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  PRODUCT_TYPE_KEY_PATTERN,
  THREE_D_CLAIM_ATTRIBUTE_KEYS,
  THREE_D_CLAIM_KIND_BY_KEY,
  THREE_D_DELIVERABLE_CONFIGURATIONS,
  THREE_D_FORBIDDEN_PROFILE_SHAPES,
  THREE_D_MEASURED_FACTS,
  THREE_D_PROFILE_KEYS,
  THREE_D_PROFILE_VERTICAL,
  THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS,
  unmetLicenceRightDependencies,
} from '@mercaria/shared-types';
import type {
  ProductTypeAuthoringFlow,
  ProductTypeVisibilityRule,
  ThreeDClaimAttributeKey,
} from '@mercaria/shared-types';

import { assessVariantAxis } from '../../../product-types/variant-axis.js';
import { assessValuePolicy } from '../../../product-types/value-policy.js';
import {
  disagreementsWithPublishedVocabulary,
  namespaceFor,
  namespaceRule,
  nsKey,
  profileVocabularyFingerprint,
} from '../apply.js';
import {
  deriveExpectation,
  judgeProfileCensus,
  PROFILE_CENSUS_POSITIVE_CONTROL_ENTITIES,
} from '../census.js';
import { decideLicenceVersionStep, licenceTermsDisagreements } from '../licences.js';
import { THREE_D_PROFILE_PACKAGE } from '../package.js';
import type { ThreeDExpectation, ThreeDProfilePackage } from '../types.js';

const PKG = THREE_D_PROFILE_PACKAGE;
const ALL_FIELDS = PKG.profiles.flatMap((profile) =>
  profile.fields.map((field) => ({ profile: profile.key, ...field })),
);
const VALUE_TYPE_BY_KEY = new Map(
  PKG.attributes.map((attribute) => [attribute.key, attribute.valueType] as const),
);

/** A deep copy a case may edit without affecting any other case. */
function mutableCopy(): ThreeDProfilePackage {
  return structuredClone(PKG) as ThreeDProfilePackage;
}

/* -------------------------------------------------------------------------- */
/*  The floors                                                                 */
/* -------------------------------------------------------------------------- */

describe('the package has something to measure', () => {
  it('declares the seven profiles the published vocabulary names', () => {
    expect(PKG.profiles.map((profile) => profile.key).sort()).toEqual([...THREE_D_PROFILE_KEYS].sort());
    expect(THREE_D_PROFILE_KEYS.length).toBe(7);
  });

  it('declares every claim attribute the published vocabulary names, and no other', () => {
    expect(PKG.attributes.map((attribute) => attribute.key).sort()).toEqual(
      [...THREE_D_CLAIM_ATTRIBUTE_KEYS].sort(),
    );
    expect(THREE_D_CLAIM_ATTRIBUTE_KEYS.length).toBe(17);
  });

  it('belongs to the vertical the feature lever names', () => {
    // `DIGITAL_ENABLED_VERTICALS` is an ALLOW-list defaulting EMPTY (ADR 0010
    // D13), so the key this package's assets carry and the key an operator types
    // into that variable must be the same string — and it is stated once rather
    // than written into seven rows.
    expect(THREE_D_PROFILE_VERTICAL).toBe('three_d');
    expect(DIGITAL_VERTICALS).toContain(THREE_D_PROFILE_VERTICAL);
  });

  it('has fields, groups, categories and licences to iterate', () => {
    expect(ALL_FIELDS.length).toBe(96);
    expect(PKG.categories.length).toBe(9);
    expect(PKG.licences.length).toBe(MERCARIA_REFERENCE_LICENCES.length);
    expect(MERCARIA_REFERENCE_LICENCES.length).toBeGreaterThanOrEqual(3);
    for (const profile of PKG.profiles) expect(profile.groups.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The declared expectation, and the drift check that guards the census       */
/* -------------------------------------------------------------------------- */

describe('the declared expectation agrees with the package data', () => {
  it('matches entity for entity', () => {
    expect(deriveExpectation(PKG)).toEqual(PKG.expect);
  });

  it('is a real check — a field added without updating `expect` is caught', () => {
    // The mutation self-test. Without it this block passes against a derivation
    // that returns `pkg.expect` verbatim, which is precisely the shortcut that
    // makes a census validate the run that broke it.
    const mutated = mutableCopy();
    const [first] = mutated.profiles;
    expect(first).toBeDefined();
    if (!first) return;
    (first.fields as unknown[]).push({ ...first.fields[0], position: 99 });
    expect(deriveExpectation(mutated)).not.toEqual(mutated.expect);
  });

  it('declares a positive count for every entity kind the census controls', () => {
    for (const entity of PROFILE_CENSUS_POSITIVE_CONTROL_ENTITIES) {
      expect(PKG.expect[entity], String(entity)).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  ADR 0010 D12 — the provenance split                                       */
/* -------------------------------------------------------------------------- */

describe('no seller claim is also a measured fact', () => {
  it('keeps the two populations disjoint', () => {
    const measured = new Set<string>(THREE_D_MEASURED_FACTS);
    const overlap = THREE_D_CLAIM_ATTRIBUTE_KEYS.filter((key) => measured.has(key));
    expect(overlap).toEqual([]);
  });

  it('declares no attribute for a fact the pipeline measures, under any obvious spelling', () => {
    // The disjointness above is over the registry's OWN fact names. A claim
    // spelled `triangles` rather than `triangle_count` would slip past it, so
    // this is the same rule keyed on what somebody would actually type — and it
    // is the spelling list rather than the registry that makes it a gate.
    const forbidden = [
      'triangle_count',
      'triangles',
      'polygon_count',
      'polycount',
      'vertex_count',
      'vertices',
      'mesh_count',
      'part_count',
      'watertight',
      'manifold',
      'uv_mapped',
      'has_uv',
      'rigged',
      'animated',
      'animation_count',
      'file_size',
      'download_size',
      'formats_included',
      'included_formats',
      'file_formats',
      'textures_included',
      'presliced_profile_included',
      'bounding_box',
      'dimensions',
      'model_units',
    ];
    const declared = new Set<string>(PKG.attributes.map((attribute) => attribute.key));
    expect(forbidden.filter((key) => declared.has(key))).toEqual([]);
    // And the control: the detector notices when one IS declared.
    declared.add('triangle_count');
    expect(forbidden.filter((key) => declared.has(key))).toEqual(['triangle_count']);
  });

  it('classifies every claim as general or printable', () => {
    for (const key of THREE_D_CLAIM_ATTRIBUTE_KEYS) {
      expect(THREE_D_CLAIM_KIND_BY_KEY[key], key).toBeDefined();
    }
    const printable = THREE_D_CLAIM_ATTRIBUTE_KEYS.filter(
      (key) => THREE_D_CLAIM_KIND_BY_KEY[key] === 'printable',
    );
    // Both halves are non-empty, which is what makes the split a split. Nine
    // printable and eight general, counted off the vocabulary.
    expect(printable.length).toBe(9);
    expect(THREE_D_CLAIM_ATTRIBUTE_KEYS.length - printable.length).toBe(8);
  });

  it('names only real, not-yet-measured claims as retirable', () => {
    const claims = new Set<string>(THREE_D_CLAIM_ATTRIBUTE_KEYS);
    const measured = new Set<string>(THREE_D_MEASURED_FACTS);
    expect(THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS.length).toBeGreaterThan(0);
    for (const key of THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS) {
      expect(claims.has(key), `${key} is not a claim`).toBe(true);
      expect(measured.has(key), `${key} is already measured`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Key shapes — what the CHECKs will accept                                   */
/* -------------------------------------------------------------------------- */

describe('every key this package can produce is one the CHECKs accept', () => {
  it('ships attribute keys of the registry shape', () => {
    for (const attribute of PKG.attributes) {
      expect(PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN.test(attribute.key), attribute.key).toBe(true);
    }
  });

  it('ships profile keys of the product-type shape, digits and all', () => {
    for (const profile of PKG.profiles) {
      expect(PRODUCT_TYPE_KEY_PATTERN.test(profile.key), profile.key).toBe(true);
    }
  });

  it('keeps them legal under any namespace `namespaceFor` will mint', () => {
    for (const token of ['three_d', 'run-4a2b', 'A Weird  Token!!', 'x']) {
      const ns = namespaceFor(token);
      for (const attribute of PKG.attributes) {
        expect(PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN.test(nsKey(ns, attribute.key))).toBe(true);
      }
      for (const profile of PKG.profiles) {
        expect(PRODUCT_TYPE_KEY_PATTERN.test(nsKey(ns, profile.key))).toBe(true);
      }
    }
  });

  it('is a real test — the epic’s own `3d_` spelling is refused by the pattern', () => {
    // The reason the keys say `three_d`. Both CHECKs anchor on `^[a-z]`, so
    // `3d_print_model` is not a legal key and never was; this asserts the
    // refusal rather than leaving a reader to conclude the profiles were renamed
    // for taste.
    expect(PRODUCT_TYPE_KEY_PATTERN.test('3d_print_model')).toBe(false);
    expect(PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN.test('3d_formats')).toBe(false);
    expect(PRODUCT_TYPE_KEY_PATTERN.test('three_d_print_model')).toBe(true);
  });

  it('refuses a namespace token that could not produce a legal key', () => {
    expect(() => namespaceFor('9lives')).toThrow(/start with a letter/u);
    expect(() => namespaceFor('   ')).toThrow(/start with a letter/u);
  });
});

/* -------------------------------------------------------------------------- */
/*  ADR 0010 D2 — exactly one variant axis                                    */
/* -------------------------------------------------------------------------- */

describe('the one axis, and the walls under everything else', () => {
  it('declares exactly one variant-defining attribute, and it is the deliverable', () => {
    const axes = PKG.attributes.filter((attribute) => attribute.variantDefining === true);
    expect(axes.map((attribute) => attribute.key)).toEqual(['deliverable_configuration']);
    expect(axes[0]?.enumValues?.map((value) => value.value)).toEqual([
      ...THREE_D_DELIVERABLE_CONFIGURATIONS,
    ]);
  });

  it('marks a field variant-capable only for that attribute, and only at variant scope', () => {
    const capable = ALL_FIELDS.filter((field) => field.variantCapable === true);
    expect(capable.length).toBeGreaterThan(0);
    for (const field of capable) {
      expect(field.attributeKey).toBe('deliverable_configuration');
      expect(field.scope).toBe('variant');
    }
  });

  it('passes `assessVariantAxis` for every field it declares', () => {
    for (const field of ALL_FIELDS) {
      const verdict = assessVariantAxis({
        scope: field.scope,
        attributeKey: field.attributeKey,
        variantCapable: field.variantCapable ?? false,
      });
      expect(verdict.outcome, `${field.profile}/${field.flow}/${field.attributeKey}`).toBe(
        'permitted',
      );
    }
  });

  it('is a real test — a compatibility-scope field turned into an axis is REFUSED', () => {
    // The wall that actually protects this vertical. The CHECK's exact-match
    // half cannot fire on a seeded key (a namespaced key matches none of the
    // forbidden spellings), so what stops "works in Unreal" becoming an option
    // row is the scope conjunct — and this drives it against the real analyser,
    // on a real field of this package.
    const engine = ALL_FIELDS.find((field) => field.attributeKey === 'engine_compatibility');
    expect(engine).toBeDefined();
    if (!engine) return;
    expect(engine.scope).toBe('compatibility');
    const verdict = assessVariantAxis({
      scope: engine.scope,
      attributeKey: engine.attributeKey,
      variantCapable: true,
    });
    expect(verdict.outcome).toBe('refused');
    // And the control: the same call at `variant` scope is permitted, so the
    // refusal is about the scope rather than about the key.
    expect(
      assessVariantAxis({ scope: 'variant', attributeKey: engine.attributeKey, variantCapable: true })
        .outcome,
    ).toBe('permitted');
  });

  it('declares no attribute the forbidden-key list names, and records why that is not the wall', () => {
    // None of the 3D claims is a reserved offer fact, a compatibility target
    // spelling or a composition spelling — asserted. But the reason this is NOT
    // the wall that protects the vertical is the namespace: under a namespaced
    // run the stored key is `run4a2b_tested_printers`, which matches no entry in
    // the list however the list grows. Both halves are asserted so the next
    // reader does not mistake one for the other.
    const forbidden = new Set<string>(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS);
    expect(forbidden.size).toBeGreaterThan(20);
    for (const attribute of PKG.attributes) {
      expect(forbidden.has(attribute.key), attribute.key).toBe(false);
    }
    const ns = namespaceFor('run4a2b');
    for (const key of PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS) {
      expect(forbidden.has(nsKey(ns, key)), `${key} namespaced`).toBe(false);
    }
  });

  it('declares no licence or format attribute at all (#1015 boundaries 5 and 6)', () => {
    // The two axes this vertical is most likely to grow, stated as an absence
    // because an absence is what keeps them unrepresentable. A licence tier
    // would be a second, unversioned record of the terms; a format would make a
    // buyer choose bytes.
    const suspicious = PKG.attributes
      .map((attribute) => attribute.key)
      .filter((key) => /licen|format|file_type|extension/u.test(key));
    expect(suspicious).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The value policy, against the attribute each field cites                   */
/* -------------------------------------------------------------------------- */

describe('every field’s value policy agrees with the attribute it cites', () => {
  it('agrees for all 96 fields', () => {
    for (const field of ALL_FIELDS) {
      const valueType = VALUE_TYPE_BY_KEY.get(field.attributeKey);
      expect(valueType, `${field.attributeKey} is not declared`).toBeDefined();
      if (valueType === undefined) continue;
      const agreement = assessValuePolicy({
        attributeKey: field.attributeKey,
        valuePolicy: field.valuePolicy,
        valueType,
      });
      expect(agreement.outcome, `${field.profile}/${field.flow}/${field.attributeKey}`).toBe(
        'agrees',
      );
    }
  });

  it('is a real test — `controlled_value` over a boolean contradicts', () => {
    // What publication would refuse, driven directly. `print_in_place` is a real
    // boolean claim of this package, so the mutation is the plausible mistake
    // rather than an invented one.
    expect(VALUE_TYPE_BY_KEY.get('print_in_place')).toBe('boolean');
    const agreement = assessValuePolicy({
      attributeKey: 'print_in_place',
      valuePolicy: 'controlled_value',
      valueType: 'boolean',
    });
    expect(agreement.outcome).toBe('contradicts');
  });
});

/* -------------------------------------------------------------------------- */
/*  The printable guard                                                        */
/* -------------------------------------------------------------------------- */

/** Every attribute key a rule reads — the publication check's own walk. */
function ruleFields(rule: ProductTypeVisibilityRule, into: string[] = []): string[] {
  switch (rule.node) {
    case 'all':
    case 'any':
      for (const branch of rule.rules) ruleFields(branch, into);
      return into;
    case 'not':
      return ruleFields(rule.rule, into);
    default:
      if (!into.includes(rule.field)) into.push(rule.field);
      return into;
  }
}

/** The dangling-rule-field check, per (profile, flow) — what publication refuses. */
function danglingRuleFields(pkg: ThreeDProfilePackage): string[] {
  const dangling: string[] = [];
  for (const profile of pkg.profiles) {
    const flows = new Set<ProductTypeAuthoringFlow>(profile.fields.map((field) => field.flow));
    for (const flow of flows) {
      const inFlow = profile.fields.filter((field) => field.flow === flow);
      const declared = new Set(inFlow.map((field) => field.attributeKey as string));
      for (const field of inFlow) {
        if (field.visibilityRule === undefined) continue;
        for (const key of ruleFields(field.visibilityRule)) {
          if (!declared.has(key)) dangling.push(`${profile.key}/${flow}/${field.attributeKey} -> ${key}`);
        }
      }
    }
  }
  return dangling;
}

describe('the printable block is guarded, and the guard resolves in its own flow', () => {
  it('guards every printable field and nothing else', () => {
    const guarded = ALL_FIELDS.filter((field) => field.visibilityRule !== undefined);
    expect(guarded.length).toBeGreaterThan(0);
    for (const field of guarded) {
      expect(
        THREE_D_CLAIM_KIND_BY_KEY[field.attributeKey as ThreeDClaimAttributeKey],
        field.attributeKey,
      ).toBe('printable');
    }
    // And the inverse: no printable field is ever unguarded, in any flow. A
    // single unguarded one would ask a material-pack seller about supports.
    const printableFields = ALL_FIELDS.filter(
      (field) => THREE_D_CLAIM_KIND_BY_KEY[field.attributeKey as ThreeDClaimAttributeKey] === 'printable',
    );
    expect(printableFields.length).toBeGreaterThan(0);
    for (const field of printableFields) expect(field.visibilityRule, field.attributeKey).toBeDefined();
  });

  it('never makes a guarded field `required`', () => {
    // A `required` field behind a rule is required only while the rule stands.
    // Recommended survives the edit that removes the guard; required turns it
    // into a wall for every seller who did not tick "for printing".
    for (const field of ALL_FIELDS) {
      if (field.visibilityRule === undefined) continue;
      expect(field.requirement, field.attributeKey).not.toBe('required');
    }
  });

  it('declares the guard’s own field in every flow that reads it', () => {
    expect(danglingRuleFields(PKG)).toEqual([]);
  });

  it('is a real test — dropping `intended_use` from one flow makes the rule dangle', () => {
    // `publishProductTypeVersion` refuses exactly this
    // (`visibility_rule_names_unknown_field`), and it is the mistake a P2P flow
    // invites: a merchant-only guard over a P2P field leaves that field hidden
    // forever with every surface reporting success.
    const mutated = mutableCopy();
    const profile = mutated.profiles.find((candidate) => candidate.key === 'three_d_print_model');
    expect(profile).toBeDefined();
    if (!profile) return;
    (profile as unknown as { fields: unknown[] }).fields = profile.fields.filter(
      (field) => !(field.flow === 'p2p' && field.attributeKey === 'intended_use'),
    );
    expect(danglingRuleFields(mutated).length).toBeGreaterThan(0);
  });

  it('namespaces a rule’s field and leaves its values alone', () => {
    const guarded = ALL_FIELDS.find((field) => field.visibilityRule !== undefined);
    expect(guarded?.visibilityRule).toBeDefined();
    const rule = guarded?.visibilityRule;
    if (rule === undefined) return;
    const ns = namespaceFor('run4a2b');
    const namespaced = namespaceRule(ns, rule);
    expect(ruleFields(namespaced)).toEqual(['run4a2b_intended_use']);
    // The VALUES are a controlled vocabulary and are not namespaced: a value is
    // not a key, and prefixing one would make the rule compare against a
    // spelling no enum row carries.
    expect(JSON.stringify(namespaced)).toContain('physical_printing');
    // Null namespace is the identity, which is what a production apply uses.
    expect(namespaceRule(null, rule)).toBe(rule);
    // And the shared rule object is not mutated by being namespaced — nine
    // fields and seven profiles share one, so an in-place prefix would double up.
    expect(ruleFields(rule)).toEqual(['intended_use']);
  });
});

/* -------------------------------------------------------------------------- */
/*  The flows                                                                  */
/* -------------------------------------------------------------------------- */

describe('every profile is authorable by a merchant and by a person', () => {
  it('declares both flows, with the P2P one strictly shorter', () => {
    for (const profile of PKG.profiles) {
      const merchant = profile.fields.filter((field) => field.flow === 'merchant');
      const p2p = profile.fields.filter((field) => field.flow === 'p2p');
      expect(merchant.length, profile.key).toBeGreaterThan(0);
      expect(p2p.length, profile.key).toBeGreaterThan(0);
      expect(p2p.length, profile.key).toBeLessThan(merchant.length);
    }
  });

  it('keeps scope, variant capability and value policy identical across flows', () => {
    // `mercaria_product_type_field_citation` refuses two flows disagreeing about
    // any of the three — WHO is asked varies per flow, what the attribute IS does
    // not — and it raises at insert time, halfway through a seed.
    for (const profile of PKG.profiles) {
      const byKey = new Map<string, { scope: string; variant: boolean; policy: string }>();
      for (const field of profile.fields) {
        const seen = byKey.get(field.attributeKey);
        const mine = {
          scope: field.scope,
          variant: field.variantCapable ?? false,
          policy: field.valuePolicy,
        };
        if (seen === undefined) byKey.set(field.attributeKey, mine);
        else expect(mine, `${profile.key}/${field.attributeKey}`).toEqual(seen);
      }
    }
  });

  it('lays every field out in a group the profile declares, at a unique position per flow', () => {
    for (const profile of PKG.profiles) {
      const groups = new Set(profile.groups.map((group) => group.key));
      const positions = new Map<string, Set<number>>();
      for (const field of profile.fields) {
        expect(groups.has(field.groupKey), `${profile.key}/${field.groupKey}`).toBe(true);
        const seen = positions.get(field.flow) ?? new Set<number>();
        expect(seen.has(field.position), `${profile.key}/${field.flow}@${field.position}`).toBe(false);
        seen.add(field.position);
        positions.set(field.flow, seen);
      }
    }
  });

  it('puts one attribute in the same group in every profile that asks it', () => {
    // `PublicProductTypeSpecificationLayout` is derived across every flow and
    // names none, so two profiles grouping one attribute differently put it in
    // `conflictingAttributeKeys` and place it NOWHERE. A shopper comparing a prop
    // against a character would then read one of them with a row missing.
    const group = new Map<string, string>();
    for (const field of ALL_FIELDS) {
      const seen = group.get(field.attributeKey);
      if (seen === undefined) group.set(field.attributeKey, field.groupKey);
      else expect(field.groupKey, field.attributeKey).toBe(seen);
    }
    expect(group.size).toBe(THREE_D_CLAIM_ATTRIBUTE_KEYS.length);
  });

  it('asks every declared attribute somewhere, and asks the print-model profile the most', () => {
    // An attribute no profile cites is a definition nobody can answer — a form
    // field that exists in the registry and on no form.
    const asked = new Set(ALL_FIELDS.map((field) => field.attributeKey));
    expect([...THREE_D_CLAIM_ATTRIBUTE_KEYS].filter((key) => !asked.has(key))).toEqual([]);
    const sizes = PKG.profiles.map((profile) => ({
      key: profile.key,
      size: profile.fields.filter((field) => field.flow === 'merchant').length,
    }));
    const widest = sizes.reduce((best, candidate) => (candidate.size > best.size ? candidate : best));
    expect(['three_d_print_model', 'three_d_character', 'three_d_prop']).toContain(widest.key);
    const narrowest = sizes.reduce((best, candidate) => (candidate.size < best.size ? candidate : best));
    expect(narrowest.key).toBe('three_d_material_texture_pack');
  });
});

/* -------------------------------------------------------------------------- */
/*  The published vocabulary, and the fingerprint                              */
/* -------------------------------------------------------------------------- */

describe('the package agrees with both published vocabularies', () => {
  it('finds no disagreement today', () => {
    expect(disagreementsWithPublishedVocabulary(PKG)).toEqual([]);
  });

  it('is a real test — a missing profile and an unknown licence are both named', () => {
    const withoutProfile = mutableCopy();
    (withoutProfile as unknown as { profiles: unknown[] }).profiles = withoutProfile.profiles.filter(
      (profile) => profile.key !== 'three_d_prop',
    );
    expect(disagreementsWithPublishedVocabulary(withoutProfile).join(' ')).toContain('three_d_prop');

    const withStrangeLicence = mutableCopy();
    (withStrangeLicence as unknown as { licences: unknown[] }).licences = [
      ...withStrangeLicence.licences,
      { slug: 'mercaria-invented', version: 1, suggestedUpdatePolicy: 'purchased_version_only' },
    ];
    expect(disagreementsWithPublishedVocabulary(withStrangeLicence).join(' ')).toContain(
      'mercaria-invented',
    );
  });

  it('fingerprints the vocabulary and not the prose', () => {
    const before = profileVocabularyFingerprint(PKG);
    const reworded = mutableCopy();
    const [profile] = reworded.profiles;
    if (profile) (profile as { description: string }).description = 'Entirely different wording.';
    expect(profileVocabularyFingerprint(reworded)).toBe(before);

    const rekeyed = mutableCopy();
    const [attribute] = rekeyed.attributes;
    if (attribute) (attribute as { valueType: string }).valueType = 'string';
    expect(profileVocabularyFingerprint(rekeyed)).not.toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/*  The reference licences                                                     */
/* -------------------------------------------------------------------------- */

describe('the reference licence seeds', () => {
  it('covers every published reference licence at version 1', () => {
    for (const reference of MERCARIA_REFERENCE_LICENCES) {
      const seed = PKG.licences.find((licence) => licence.slug === reference.slug);
      expect(seed, reference.slug).toBeDefined();
      expect(seed?.version).toBe(1);
      expect(DIGITAL_LICENCE_UPDATE_POLICIES).toContain(seed?.suggestedUpdatePolicy);
    }
  });

  it('seeds no licence whose rights contradict themselves', () => {
    // The write-time rule, driven over the data the seed will actually write.
    // `unmetLicenceRightDependencies` is deliberately not a CHECK, so a seed is
    // exactly the caller that could ship a contradiction to every deployment.
    for (const reference of MERCARIA_REFERENCE_LICENCES) {
      expect(unmetLicenceRightDependencies(reference.terms.rights), reference.slug).toEqual([]);
    }
    // The control: the rule notices one.
    expect(unmetLicenceRightDependencies(['derivative_redistribution']).length).toBe(1);
  });

  it('grants `source_redistribution` in none of them (#1015 W2 requirement 6)', () => {
    for (const reference of MERCARIA_REFERENCE_LICENCES) {
      expect(reference.terms.rights, reference.slug).not.toContain('source_redistribution');
    }
  });

  it('decides all four stored states, including the one no database can produce', () => {
    const reference = MERCARIA_REFERENCE_LICENCES[0];
    expect(reference).toBeDefined();
    if (!reference) return;
    const published = {
      id: 'v1',
      licenceId: 'l1',
      version: 1,
      state: 'published',
      summary: reference.summary,
      rights: [...reference.terms.rights],
      attribution: reference.terms.attribution,
      seatLimit: reference.terms.seatLimit,
      revenueLimitAmount: reference.terms.revenueLimitAmount,
      revenueLimitCurrency: reference.terms.revenueLimitCurrency,
      projectLimit: reference.terms.projectLimit,
      additionalTerms: reference.terms.additionalTerms,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof decideLicenceVersionStep>[0];

    expect(decideLicenceVersionStep(null, reference.terms, reference.summary).action).toBe(
      'insert_and_publish',
    );
    expect(decideLicenceVersionStep(published, reference.terms, reference.summary).action).toBe(
      'present',
    );
    // The draft a run interrupted between the insert and the publish leaves.
    // `asset_licence_versions_immutable_once_published` freezes `published_at`
    // itself, so a test cannot manufacture this from a published row at all —
    // driving the decision is the only control there is.
    const draft = { ...(published as object), state: 'draft', publishedAt: null } as typeof published;
    expect(decideLicenceVersionStep(draft, reference.terms, reference.summary).action).toBe(
      'publish_existing_draft',
    );
    // And a stored row that disagrees is reported, never corrected.
    const edited = {
      ...(published as object),
      rights: ['personal_use'],
    } as typeof published;
    const verdict = decideLicenceVersionStep(edited, reference.terms, reference.summary);
    expect(verdict.action).toBe('divergent');
    expect(verdict.action === 'divergent' ? verdict.detail : '').toContain('rights stored');
  });

  it('compares rights as a SET, because a text[] comes back in no guaranteed order', () => {
    const reference = MERCARIA_REFERENCE_LICENCES[1];
    expect(reference).toBeDefined();
    if (!reference) return;
    const reordered = {
      summary: reference.summary,
      rights: [...reference.terms.rights].reverse(),
      attribution: reference.terms.attribution,
      seatLimit: reference.terms.seatLimit,
      revenueLimitAmount: reference.terms.revenueLimitAmount,
      revenueLimitCurrency: reference.terms.revenueLimitCurrency,
      projectLimit: reference.terms.projectLimit,
      additionalTerms: reference.terms.additionalTerms,
    } as unknown as Parameters<typeof licenceTermsDisagreements>[0];
    expect(licenceTermsDisagreements(reordered, reference.terms, reference.summary)).toEqual([]);
    // The control: a MISSING right is not an ordering difference.
    const short = {
      ...(reordered as object),
      rights: reference.terms.rights.slice(1),
    } as typeof reordered;
    expect(licenceTermsDisagreements(short, reference.terms, reference.summary).length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The census judgement                                                       */
/* -------------------------------------------------------------------------- */

const ZERO: Record<keyof ThreeDExpectation, number> = {
  categories: 0,
  attributes: 0,
  enumValues: 0,
  profiles: 0,
  profileFields: 0,
  licences: 0,
  licenceVersions: 0,
};

describe('the census judgement', () => {
  it('answers `vacuous` for all zeros rather than matching them against zeros', () => {
    // The whole class of bug: seven zeros compared against seven zeros is
    // `0 === 0` seven times, which every per-entity equality accepts.
    const vacuousPackage = mutableCopy();
    (vacuousPackage as { expect: ThreeDExpectation }).expect = { ...ZERO };
    // A package declaring zero is `unmeasurable` BEFORE the floor is reached,
    // which is the stricter of the two answers and the order that matters.
    expect(judgeProfileCensus(vacuousPackage, ZERO).outcome).toBe('unmeasurable');
    // With the real expectation and nothing found, the verdict is the floor.
    expect(judgeProfileCensus(PKG, ZERO).outcome).toBe('vacuous');
  });

  it('matches only an exact set of counts', () => {
    expect(judgeProfileCensus(PKG, { ...PKG.expect }).outcome).toBe('matched');
    const short = { ...PKG.expect, profileFields: PKG.expect.profileFields - 1 };
    const verdictShort = judgeProfileCensus(PKG, short);
    expect(verdictShort.outcome).toBe('mismatched');
    // The HIGH direction too: a floor would pass this, which is how a floor ends
    // at `>= 0`.
    const over = { ...PKG.expect, categories: PKG.expect.categories + 1 };
    expect(judgeProfileCensus(PKG, over).outcome).toBe('mismatched');
  });
});

/* -------------------------------------------------------------------------- */
/*  #1015 acceptance criterion 18 — the published module declares no form       */
/* -------------------------------------------------------------------------- */

/** The detector: a property declaration whose name is a form property. */
function formShapesIn(source: string): string[] {
  return THREE_D_FORBIDDEN_PROFILE_SHAPES.filter((name) =>
    new RegExp(`^\\s*(readonly\\s+)?${name}\\s*\\??\\s*:`, 'mu').test(source),
  );
}

describe('the published profile module declares no authoring form', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  /** Found by walking UP, because this runs from the package or the repo root. */
  function locate(relative: string): string {
    let dir = here;
    for (let hops = 0; hops < 12; hops += 1) {
      const candidate = join(dir, relative);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`Could not locate ${relative} by walking up from ${here}.`);
  }

  it('has a subject to measure', () => {
    const source = readFileSync(
      locate(join('packages', 'shared-types', 'src', 'digital-3d-profile.ts')),
      'utf8',
    );
    // The floor: a path that resolved to an empty file would report a clean scan.
    expect(source.length).toBeGreaterThan(5_000);
    expect(source).toContain('THREE_D_CLAIM_ATTRIBUTE_KEYS');
  });

  it('declares none of the seven form properties', () => {
    const source = readFileSync(
      locate(join('packages', 'shared-types', 'src', 'digital-3d-profile.ts')),
      'utf8',
    );
    expect(formShapesIn(source)).toEqual([]);
  });

  it('is a real test — the detector finds one when it is there', () => {
    expect(formShapesIn('export interface X {\n  readonly requirement: string;\n}')).toEqual([
      'requirement',
    ]);
    expect(formShapesIn('export interface X {\n  visibilityRule?: unknown;\n}')).toEqual([
      'visibilityRule',
    ]);
    // And it does not fire on prose mentioning the word, which is what a naive
    // substring scan would do — this module's own header names all seven.
    expect(formShapesIn(' * no requirement, no flow, no groupKey, no position.')).toEqual([]);
  });
});
