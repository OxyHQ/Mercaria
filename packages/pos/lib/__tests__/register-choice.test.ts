import { describe, expect, it } from 'vitest';
import type { PosRegister, PosRegisterList } from '@mercaria/shared-types';
import { activeRegisterFor, registerChoices } from '../register-choice';

function register(id: string, locationId: string, archived = false): PosRegister {
  return {
    id,
    storeId: 'store',
    locationId,
    name: id,
    ...(archived ? { archivedAt: '2026-11-01T00:00:00.000Z' } : {}),
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const list = (attributionActive: boolean): PosRegisterList => ({
  attributionActive,
  registers: [register('a', 'here'), register('b', 'here', true), register('c', 'there')],
});

describe('registerChoices', () => {
  it('offers only live registers at this location while the plan honours them', () => {
    expect(registerChoices(list(true), 'here').map((r) => r.id)).toEqual(['a']);
  });

  it('offers nothing when the plan does not honour named registers (the free baseline)', () => {
    expect(registerChoices(list(false), 'here')).toEqual([]);
    expect(registerChoices(undefined, 'here')).toEqual([]);
  });
});

describe('activeRegisterFor', () => {
  it('keeps a remembered register that is still offered', () => {
    expect(activeRegisterFor(list(true), 'here', 'a')?.id).toBe('a');
  });

  it('falls back to the default register (null) for anything no longer offered', () => {
    expect(activeRegisterFor(list(true), 'here', null)).toBeNull();
    expect(activeRegisterFor(list(true), 'here', 'b')).toBeNull(); // archived
    expect(activeRegisterFor(list(true), 'here', 'c')).toBeNull(); // other location
    expect(activeRegisterFor(list(false), 'here', 'a')).toBeNull(); // plan ended
  });
});
