import { expect, it, vi } from 'vitest';
import type { Listing } from '@mercaria/shared-types';
import { applyProductStatus } from '../bulk-product-status';
import en from '../i18n/locales/en.json';
const first = { id: 'first', title: en.products.title };
const second = { id: 'second', title: en.products.addProduct };
const saved = (id: string, status = 'active') => ({ id, status } as Listing);

it('keeps failures selected and retries only remaining ids, with exact absolute status', async () => {
  const update = vi.fn(async (id: string) => { if (id === second.id) throw new Error('Lost response'); return saved(id); });
  const result = await applyProductStatus([first, second, first], 'active', update, () => true);
  expect(update.mock.calls).toEqual([[first.id, 'active'], [second.id, 'active']]);
  expect(result.updated).toEqual([saved(first.id)]);
  expect(result.remaining).toEqual([{ ...second, outcome: 'failed' }]);
  const retry = vi.fn(async (id: string) => saved(id));
  expect((await applyProductStatus(result.remaining, 'active', retry, () => true)).remaining).toEqual([]);
  expect(retry.mock.calls).toEqual([[second.id, 'active']]);
});
it('stops the remaining queue after identity, store or permission loss', async () => {
  let allowed = true;
  const update = vi.fn(async (id: string) => { allowed = false; return saved(id, 'archived'); });
  const result = await applyProductStatus([first, second], 'archived', update, () => allowed);
  expect(update).toHaveBeenCalledTimes(1);
  expect(result.remaining).toEqual([{ ...second, outcome: 'notAttempted' }]);
});
it('does not claim success when the response identifies a different product or status', async () => {
  const result = await applyProductStatus([first, second], 'draft', async id => id === first.id ? saved('other', 'draft') : saved(id), () => true);
  expect(result.updated).toEqual([]); expect(result.remaining.map(item => item.id)).toEqual([first.id, second.id]);
});

it('stops on a server authorization refusal before sending another product', async () => {
  const update = vi.fn(async () => { throw Object.assign(new Error('Forbidden'), { isAxiosError: true, response: { status: 403 } }); });
  const result = await applyProductStatus([first, second], 'archived', update, () => true);
  expect(update).toHaveBeenCalledTimes(1);
  expect(result.remaining).toEqual([{ ...first, outcome: 'failed' }, { ...second, outcome: 'notAttempted' }]);
});
