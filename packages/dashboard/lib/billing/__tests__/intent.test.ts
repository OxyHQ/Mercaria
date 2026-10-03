import { describe, expect, it } from 'vitest';
import { createBillingIntentRunner } from '../intent';
function fixture() {
  const saved = new Map<string, string>(); let counter = 0;
  const storage = { getItem: async (k: string) => saved.get(k) ?? null, setItem: async (k: string, v: string) => { saved.set(k, v); }, removeItem: async (k: string) => { saved.delete(k); } };
  const create = () => createBillingIntentRunner(storage, () => `intent-${++counter}`);
  return { saved, create };
}
describe('billing intent persistence', () => {
  it('retains the key across lost response and recreated runner, then clears success', async () => {
    const f = fixture(); let first = '';
    await expect(f.create()(['store', 'checkout', 'plan'], async key => { first = key; throw new Error('connection lost'); })).rejects.toThrow('connection lost');
    expect([...f.saved.values()]).toEqual([first]);
    expect(await f.create()(['store', 'checkout', 'plan'], async key => key)).toBe(first);
    expect(f.saved.size).toBe(0);
  });
  it('coalesces concurrent clicks and separates store/action/parameters', async () => {
    const f = fixture(); const run = f.create(); let effects = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const action = async (key: string) => { effects++; await barrier; return key; };
    const a = run(['a', 'checkout', 'p1'], action); const b = run(['a', 'checkout', 'p1'], action);
    release(); expect(await a).toBe(await b); expect(effects).toBe(1);
    const keys = await Promise.all([run(['a', 'portal'], async k => k), run(['b', 'portal'], async k => k)]);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('keeps unknown/conflict outcomes but clears terminal validation for a new intent', async () => {
    const f = fixture(); const run = f.create();
    for (const status of [409, 429, 500, 401]) {
      await expect(run(['a', 'cancel'], async () => { throw { response: { status } }; })).rejects.toBeDefined();
      expect(f.saved.size).toBe(1);
    }
    await expect(run(['a', 'cancel'], async () => { throw { response: { status: 400 } }; })).rejects.toBeDefined();
    expect(f.saved.size).toBe(0);
  });
  it('does not send an action if durable storage or randomness fails', async () => {
    let calls = 0;
    const run = createBillingIntentRunner({ getItem: async () => null, setItem: async () => { throw new Error('storage'); }, removeItem: async () => {} }, () => 'intent-fixed');
    await expect(run(['a', 'checkout'], async () => { calls++; })).rejects.toThrow('storage');
    expect(calls).toBe(0);
  });
});
