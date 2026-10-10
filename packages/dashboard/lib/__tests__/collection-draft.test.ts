import { expect, it } from 'vitest';
import type { Collection } from '@mercaria/shared-types';
import en from '../i18n/locales/en.json';
import { collectionChanges } from '../collection-draft';

const original = { title: en.collections.create.titlePlaceholder, handle: 'summer', description: en.collections.subtitle,
  isPublished: true, sortOrder: 'manual', productIds: ['one'] } as Collection;

it('sends only edited fields, preserving remote membership and other fresh metadata', () => {
  const updatedTitle = en.nav.collections;
  expect(collectionChanges({ ...original, handle: 'remote', productIds: ['two'] }, { title: `  ${updatedTitle}  ` })).toEqual({ title: updatedTitle });
});
it('preserves explicit false and empty description, rather than treating them as absent', () => {
  expect(collectionChanges(original, { isPublished: false, description: '', sortOrder: 'price_asc' })).toEqual({ isPublished: false, description: '', sortOrder: 'price_asc' });
});
it('does not produce a PATCH for unchanged values or normalized whitespace', () => {
  expect(collectionChanges(original, {})).toEqual({});
  expect(collectionChanges(original, { title: ` ${original.title} `, handle: ' summer ', isPublished: true })).toEqual({});
});
