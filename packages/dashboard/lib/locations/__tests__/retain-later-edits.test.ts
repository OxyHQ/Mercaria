import { expect, it } from 'vitest';
import { retainLaterEdits } from '../retain-later-edits';

it('acknowledges only the saved snapshot, preserving new fields and edits during the request', () => {
  const submitted = { email: 'first@example.test', phone: '' };
  const current = { email: 'later@example.test', phone: '', website: 'https://example.test' };
  expect(retainLaterEdits(current, submitted)).toEqual({
    email: 'later@example.test',
    website: 'https://example.test',
  });
  expect(current).toEqual({
    email: 'later@example.test',
    phone: '',
    website: 'https://example.test',
  });
});
it('releases saved fields so future remote values can be displayed, including false and zero', () => {
  expect(
    retainLaterEdits({ offered: false, threshold: 0 }, { offered: false, threshold: 0 }),
  ).toEqual({});
});
