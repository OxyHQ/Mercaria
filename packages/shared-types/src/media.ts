/** Oxy file references are opaque IDs. URLs are import inputs or resolved
 * rendition addresses, never values for a fileId field. */
export function isOxyFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}
