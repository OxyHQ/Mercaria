import { isOxyFileId } from '@mercaria/shared-types';
import { oxyClient } from '../../middleware/auth.js';

/**
 * THE media chokepoint. Unimported/invalid references are absent, never supplier
 * hotlinks or URL-shaped file IDs encoded into an Oxy URL. Callers retain their
 * contract's ordinary missing-image shape (omitted field, null, or empty list).
 */
export function resolveMedia(value: string, variant?: string): string | undefined {
  return isOxyFileId(value) ? oxyClient.assets.publicUrl(value, variant) : undefined;
}

/** Legacy URL-valued columns (category art and immutable order snapshots) may
 * already name Oxy media. Resolve only that SDK-configured public namespace;
 * supplier URLs still require a backend import. Never rewrite order history. */
export function resolveStoredMediaUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const source = new URL(value);
    const cloud = new URL(oxyClient.cloudURL);
    const prefix = `${cloud.pathname.replace(/\/+$/, '')}/`;
    if (
      source.origin !== cloud.origin ||
      source.username ||
      source.password ||
      source.hash ||
      !source.pathname.startsWith(prefix)
    )
      return undefined;
    if (
      [...source.searchParams.keys()].some((key) => key !== 'variant') ||
      source.searchParams.getAll('variant').length > 1
    )
      return undefined;
    return resolveMedia(
      source.pathname.slice(prefix.length),
      source.searchParams.get('variant') ?? undefined,
    );
  } catch {
    return undefined;
  }
}
