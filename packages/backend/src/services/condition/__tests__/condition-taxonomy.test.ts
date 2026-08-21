/**
 * The pure halves of #90: the two-spelling input contract, the compatibility
 * projection, the evidence policy table and the source-label normalizer.
 *
 * None of these needs a database, and all four are places where a plausible
 * "simplification" would silently change what a listing claims.
 */

import { describe, expect, it } from 'vitest';
import {
  CONDITION_EVIDENCE_POLICIES,
  CONDITION_GROUPS,
  ITEM_CONDITION_KEYS,
  LEGACY_BINARY_CONDITION_TARGET,
  UNREFINED_CONDITION_KEYS,
  compareConditionQuality,
  conditionEvidencePolicy,
  conditionGroupFor,
  conditionKeysInGroup,
  deriveOrderItemCondition,
  legacyBinaryConditionFor,
  normalizeSourceConditionLabel,
} from '@mercaria/shared-types';
import { resolveConditionInput } from '../condition-input.js';
import { conditionColumnsFor } from '../condition-write.service.js';

describe('the v1 binary contract (#90 propagation rule 8)', () => {
  it('refuses BOTH spellings rather than picking one', () => {
    // The two can disagree — `condition: 'new'` beside
    // `itemCondition: {key: 'for_parts'}` — so a precedence rule would let a
    // client's own bug become a listing that says the opposite of what it meant.
    expect(() =>
      resolveConditionInput({ condition: 'new', itemCondition: { key: 'for_parts' } }),
    ).toThrow(/not both/i);
  });

  it('maps a v1 `used` to the conservative generic key, never `like new`', () => {
    const resolved = resolveConditionInput({ condition: 'used' });
    expect(resolved?.key).toBe('used_good');
    expect(resolved?.assertion).toBe('legacy_client_binary');
    // The property that matters, stated against the tuple the CHECK reads: the
    // key a v1 write produces must be one an unrefined assertion may carry.
    expect(UNREFINED_CONDITION_KEYS).toContain(resolved?.key);
  });

  it('maps a v1 `new` losslessly, which is what makes migration rule 1 deterministic', () => {
    const resolved = resolveConditionInput({ condition: 'new' });
    expect(resolved?.key).toBe('new');
    expect(LEGACY_BINARY_CONDITION_TARGET.new).toBe('new');
  });

  it('gives a v1 write NO acknowledgement, because a v1 client cannot make one', () => {
    const resolved = resolveConditionInput({ condition: 'used' });
    expect(resolved?.defectsAcknowledged).toBe(false);
    // And the columns then carry no acknowledgement timestamp, so nothing in the
    // record reads as consent the seller never gave.
    const columns = conditionColumnsFor(
      resolved ?? { key: 'used_good', assertion: 'legacy_client_binary', details: [], photoAnnotations: [], defectsAcknowledged: false },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(columns.conditionAcknowledgedAt).toBeNull();
  });

  it('returns undefined when neither spelling is present, so a PATCH can omit it', () => {
    expect(resolveConditionInput({})).toBeUndefined();
  });

  it('projects every non-`new` key back out as `used`', () => {
    for (const key of ITEM_CONDITION_KEYS) {
      const expected = conditionGroupFor(key) === 'new' ? 'new' : 'used';
      expect(legacyBinaryConditionFor(key)).toBe(expected);
    }
    // A v1 client has no way to render `for_parts`, and telling it `new` would
    // put a salvage shell in a "brand new" filter.
    expect(legacyBinaryConditionFor('for_parts')).toBe('used');
    expect(legacyBinaryConditionFor('refurbished_manufacturer')).toBe('used');
    expect(legacyBinaryConditionFor('open_box')).toBe('used');
  });

  it('refuses a detail whose shape contradicts its kind', () => {
    expect(() =>
      resolveConditionInput({
        itemCondition: { key: 'used_fair', details: [{ kind: 'warranty', severity: 'heavy' }] },
      }),
    ).toThrow(/cannot carry a severity/i);

    expect(() =>
      resolveConditionInput({
        itemCondition: { key: 'used_fair', details: [{ kind: 'functional_defect' }] },
      }),
    ).toThrow(/must describe/i);
  });

  it('refuses a photo annotation pointing at a defect the request did not send', () => {
    expect(() =>
      resolveConditionInput({
        itemCondition: {
          key: 'used_fair',
          details: [{ kind: 'cosmetic_wear', severity: 'light' }],
          photoAnnotations: [{ fileId: 'f1', detailIndex: 3 }],
        },
      }),
    ).toThrow(/detailIndex/);
  });
});

describe('the taxonomy and its segments', () => {
  it('assigns every key a group, and every group has at least one key', () => {
    for (const key of ITEM_CONDITION_KEYS) {
      expect(CONDITION_GROUPS).toContain(conditionGroupFor(key));
    }
    for (const group of CONDITION_GROUPS) {
      expect(conditionKeysInGroup(group).length).toBeGreaterThan(0);
    }
    // The vacuity floor: nine keys and five segments, so a truncated tuple
    // fails here rather than quietly shrinking every filter in the product.
    expect(ITEM_CONDITION_KEYS).toHaveLength(9);
    expect(CONDITION_GROUPS).toHaveLength(5);
  });

  it('orders keys by sale quality without producing a score', () => {
    expect(compareConditionQuality('new', 'for_parts')).toBeLessThan(0);
    expect(compareConditionQuality('used_like_new', 'used_poor')).toBeLessThan(0);
    expect(compareConditionQuality('used_good', 'used_good')).toBe(0);
  });
});

describe('the evidence policy is a TABLE (#90 evidence rule 1)', () => {
  it('requires item photographs for every key but `new`', () => {
    for (const key of ITEM_CONDITION_KEYS) {
      const policy = conditionEvidencePolicy(key);
      expect(policy.requiresItemPhotos).toBe(key !== 'new');
      // A requirement of "at least zero photographs" is not a requirement.
      expect(policy.minimumItemPhotos > 0).toBe(policy.requiresItemPhotos);
    }
  });

  it('names the refurbisher only for the two refurbished keys (#90 evidence rule 7)', () => {
    const requiring = ITEM_CONDITION_KEYS.filter(
      (key) => CONDITION_EVIDENCE_POLICIES[key].requiresRefurbisherAttribution,
    );
    expect(requiring).toEqual(['refurbished_manufacturer', 'refurbished_seller']);
  });

  it('every policy row names its own key and its own group', () => {
    // The table is indexed by key AND carries the key, which is the kind of
    // duplication that goes wrong silently on a copy-paste.
    for (const key of ITEM_CONDITION_KEYS) {
      const policy = CONDITION_EVIDENCE_POLICIES[key];
      expect(policy.key).toBe(key);
      expect(policy.group).toBe(conditionGroupFor(key));
    }
  });
});

describe('the order snapshot projection (#90 migration rule 3)', () => {
  it('answers `recorded: false` for a pre-#90 line, with no key to misread', () => {
    const snapshot = deriveOrderItemCondition({ conditionKey: null, conditionAssertion: null });
    expect(snapshot).toEqual({ recorded: false });
    // The discriminated union is the guarantee: `snapshot.key` does not
    // type-check on this branch, so a refund screen cannot reach for one.
    expect('key' in snapshot).toBe(false);
  });

  it('re-derives the group rather than reading a stored copy', () => {
    const snapshot = deriveOrderItemCondition({
      conditionKey: 'refurbished_seller',
      conditionAssertion: 'seller_declared',
      conditionNotes: 'repair_or_refurbishment: replaced the battery',
    });
    expect(snapshot).toEqual({
      recorded: true,
      key: 'refurbished_seller',
      group: 'refurbished',
      assertion: 'seller_declared',
      notes: 'repair_or_refurbishment: replaced the battery',
    });
  });

  it('treats a half snapshot as not recorded rather than guessing the other half', () => {
    expect(deriveOrderItemCondition({ conditionKey: 'used_good' })).toEqual({ recorded: false });
  });
});

describe('source-label normalization', () => {
  it('collapses case, punctuation and spacing onto one lookup key', () => {
    expect(normalizeSourceConditionLabel('Ricondizionato — Grado B')).toBe(
      'ricondizionato grado b',
    );
    expect(normalizeSourceConditionLabel('  OPEN   BOX ')).toBe('open box');
    expect(normalizeSourceConditionLabel('Wie neu!')).toBe('wie neu');
  });

  it('keeps non-Latin scripts and digits, which a naive `[a-z0-9]` would destroy', () => {
    // A feed publishing Greek, Cyrillic or CJK condition wording must still get
    // a usable lookup key; stripping to ASCII would collapse every such label to
    // the empty string and make one rule match all of them.
    expect(normalizeSourceConditionLabel('Καινούργιο')).toBe('καινούργιο');
    expect(normalizeSourceConditionLabel('新品 A級')).toBe('新品 a級');
    expect(normalizeSourceConditionLabel('Grade 2')).toBe('grade 2');
  });

  it('keeps a combining mark, so two labels differing only in marks are two keys', () => {
    // #838. `\p{Letter}` excludes `Mn`/`Mc`, so the class this used to carry
    // turned Devanagari and Bengali vowel signs into spaces and gave two
    // different Hindi wordings ONE key — an operator's rule for `नया` silently
    // applying to something else.
    expect(normalizeSourceConditionLabel('नया')).toBe('नया');
    expect(normalizeSourceConditionLabel('साइकिल')).not.toBe(
      normalizeSourceConditionLabel('साइकिलें'),
    );
    // It still does not FOLD accents, which is unchanged and deliberate: NFC
    // unifies two spellings of one label without deciding two labels are one.
    expect(normalizeSourceConditionLabel('Nestlé')).toBe('nestlé');
    expect(normalizeSourceConditionLabel('Nestle\u0301')).toBe('nestlé');
  });

  it('the fix can only SPLIT a lookup key, never merge two — the unique-index property', () => {
    // `condition_source_mappings_ruleset_id_label_key` is UNIQUE over
    // `(ruleset_id, source_label_normalized)`, so the question #838 had to answer
    // was whether a less lossy fold can make an operator's INSERT start failing.
    // It cannot, and this is the reason: adding `\p{M}` to the kept class only
    // ever removes separators, so the new key REFINES the old one — two labels
    // that share a key now shared it before.
    //
    // `previousFold` is a reference implementation of the SUPERSEDED behaviour,
    // deliberately: the code it characterises no longer exists, so there is
    // nothing here that could be re-implementing the function under test.
    const previousFold = (raw: string): string =>
      raw
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');

    const labels = [
      'नया',
      'साइकिल',
      'साइकिलें',
      'बइ',
      'বই',
      'বইগুলি',
      'Nuevo',
      'nuevo',
      'Nuevo!',
      'Nuevo — A',
      'Nuevo A',
      'Nuevo-A',
      'Nestlé',
      'Nestle\u0301',
      'じてんしゃ',
      'してんしゃ',
      'красный',
      'красныи',
      'Grado B',
      'grado  b',
    ];

    let collidingUnderNewFold = 0;
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        if (normalizeSourceConditionLabel(a) !== normalizeSourceConditionLabel(b)) continue;
        collidingUnderNewFold += 1;
        expect(
          previousFold(a),
          `"${a}" and "${b}" share a key now but did not before — a backfill would violate the unique index`,
        ).toBe(previousFold(b));
      }
    }
    // The floor. Without a pair that actually collides under the new fold the
    // loop above asserts nothing at all, and "no merges introduced" would be
    // satisfied by a fixture set in which nothing ever matches.
    // MEASURED over the list above, not predicted: the first draft guessed 6 and
    // the floor refuted it.
    expect(collidingUnderNewFold, 'no fixture pair collides, so nothing was checked').toBe(16);
  });
});
