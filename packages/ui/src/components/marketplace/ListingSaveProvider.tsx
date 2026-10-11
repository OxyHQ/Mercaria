import { createContext, useContext, type ReactNode } from 'react';

export type SaveListing = (
  id: string,
  nextSaved: boolean,
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
