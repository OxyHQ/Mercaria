import { describe, expect, it } from 'vitest';
import { MERCARIA_REF_ID_FIELDS, parsePortableMercariaRef } from '../src/ref-core';
import { MercariaRefSchema } from '../src/refs';

describe('portable reference validation without response schemas', () => {
  it('matches strict canonical schemas for every kind, opaque ID edge and extra/missing field', () => {
    const ids: unknown[] = [
      '',
      ' ',
      '\n\t',
      ' id ',
      'id:with/slash',
      '漢字',
      'a\u0000b',
      0,
      null,
      undefined,
      {},
      [],
    ];
    for (const [kind, fields] of Object.entries(MERCARIA_REF_ID_FIELDS)) {
      for (const id of ids) {
        const validShape = { kind, ...Object.fromEntries(fields.map((field) => [field, id])) };
        const missing = { ...validShape };
        Reflect.deleteProperty(missing, fields[0]);
        for (const input of [validShape, missing, { ...validShape, title: 'stale snapshot' }]) {
          const schema = MercariaRefSchema.safeParse(input);
          const portable = parsePortableMercariaRef(input);
          expect(portable !== null).toBe(schema.success);
          if (schema.success) {
            expect(portable).toEqual(schema.data);
            expect(Object.isFrozen(portable)).toBe(true);
            expect(portable).not.toBe(input);
          }
        }
      }
    }
  });
  it('accepts null-prototype data and rejects classes, arrays and unknown kinds', () => {
    expect(
      parsePortableMercariaRef(Object.assign(Object.create(null), { kind: 'product', id: 'p' })),
    ).toEqual({ kind: 'product', id: 'p' });
    class LooksLikeRef {
      kind = 'product';
      id = 'p';
    }
    for (const value of [
      new LooksLikeRef(),
      [],
      null,
      0,
      { kind: '__proto__', id: 'p' },
      { kind: 'variant', id: 'p' },
    ])
      expect(parsePortableMercariaRef(value)).toBeNull();
  });
});
