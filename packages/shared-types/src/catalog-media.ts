/** Catalog gallery kinds. Video bytes never belong to an image projection. */
export const CATALOG_MEDIA_KINDS = ['image', 'video'] as const;
export type CatalogMediaKind = (typeof CATALOG_MEDIA_KINDS)[number];

interface CatalogMediaFields {
  /** Durable public Oxy file ID. Resolve delivery URLs through the Oxy SDK. */
  fileId: string;
  alt?: string;
  /** Position in the complete mixed gallery, not in its image-only projection. */
  position: number;
}
export type ListingMedia =
  | (CatalogMediaFields & { kind: 'image' })
  | (CatalogMediaFields & { kind: 'video' });

/** A supplier reference consumed only by the backend import boundary. */
export interface CatalogMediaSource {
  kind: CatalogMediaKind;
  reference: string;
}
