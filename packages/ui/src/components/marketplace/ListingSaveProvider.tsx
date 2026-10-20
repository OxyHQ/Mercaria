import type { ProductSummary } from '@mercaria/shared-types';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Persist a card's save toggle. `product` is the card's summary: a catalogue
 * product (`catalogSlug`) saves the PRODUCT, a listing's card the listing.
 */
export type SaveListing = (
  id: string,
  nextSaved: boolean,
  product?: ProductSummary,
) => boolean | void | Promise<boolean | void>;

const ListingSaveContext = createContext<SaveListing | undefined>(undefined);

/** Apps supply persistence; shared cards never pretend a local toggle saved data. */
export function ListingSaveProvider({
  onSave,
  children,
}: {
  onSave: SaveListing;
  children: ReactNode;
}) {
  return <ListingSaveContext.Provider value={onSave}>{children}</ListingSaveContext.Provider>;
}

export function useListingSaveAction() {
  return useContext(ListingSaveContext);
}
