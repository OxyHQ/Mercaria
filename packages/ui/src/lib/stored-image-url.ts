import { isOxyFileId } from '@mercaria/shared-types';

type ImageResolver = (fileId: string, variant?: string) => string | undefined;

/** New catalog DTOs carry IDs. Only old persisted DTOs need the URL compatibility
 * check below; a malformed present ID must never fall back to an external URL. */
export function resolveCatalogImage(
  fileId: string | undefined,
  legacyUrl: string | undefined,
  resolveImage: ImageResolver | null,
  variant?: string,
): string | undefined {
  if (fileId !== undefined) return isOxyFileId(fileId) ? resolveImage?.(fileId, variant) : undefined;
  return resolveStoredImageUrl(legacyUrl, resolveImage);
}

/** Old device history contains URL-valued DTOs. Only display a URL that the
 * app's current Bloom/Oxy resolver actually produces for that file/rendition.
 * This neither imports external media nor treats a URL as a file ID. */
export function resolveStoredImageUrl(
  value: string | undefined,
  resolveImage: ImageResolver | null,
): string | undefined {
  if (!value || !resolveImage) return undefined;
  try {
    const url = new URL(value);
    const fileId = url.pathname.split('/').at(-1);
    if (!isOxyFileId(fileId)) return undefined;
    const resolved = resolveImage(fileId, url.searchParams.get('variant') ?? undefined);
    return resolved && new URL(resolved).href === url.href ? resolved : undefined;
  } catch {
    return undefined;
  }
}
