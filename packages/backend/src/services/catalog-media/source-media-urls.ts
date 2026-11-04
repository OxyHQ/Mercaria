/**
 * Which `source_records.payload.media` references Mercaria can copy into an
 * Oxy file: an HTTPS URL without credentials. One rule for the importer
 * (`source-media-import.ts`) and for the catalogue's gate — Mercaria accepts no
 * product without at least one image, so a reference stage mints none from an
 * observation that names no importable image (`stages/reference-products.ts`).
 */

/** An HTTPS reference without credentials, or nothing. A bare provider id is not a source. */
export function importableMediaUrl(reference: string): string | undefined {
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an observation's payload names at least one image Mercaria can copy. */
export function observationNamesAnImage(payload: Readonly<Record<string, unknown>>): boolean {
  const media = payload.media;
  return (
    Array.isArray(media) &&
    media.some((entry) => typeof entry === 'string' && importableMediaUrl(entry) !== undefined)
  );
}
