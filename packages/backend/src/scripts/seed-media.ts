import { isOxyFileId } from '@mercaria/shared-types';
import manifest from './seed-media-manifest.json';

/** Public files actually imported into Oxy by the seed operator. Never invent
 * IDs or fall back to a supplier URL when a fixture has not been synchronized. */
export function seedMediaFileId(source: string): string {
  const id = (manifest as Record<string, string>)[source];
  if (!isOxyFileId(id)) throw new Error('Seed media is missing. Synchronize the source into Oxy and update seed-media-manifest.json before seeding.');
  return id;
}
