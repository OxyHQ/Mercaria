import { isOxyFileId } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';

export const PRODUCT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PRODUCT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const;

export function matchesProductImage(bytes: Buffer, mime: string): boolean {
  if (!bytes.length || bytes.length > PRODUCT_IMAGE_MAX_BYTES) return false;
  switch (mime) {
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'image/webp': return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/avif': return bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'));
    default: return false;
  }
}

/** The owning account comes ONLY from loadStore's persisted store, never a header
 * or the operator's identity. Removing a selection never deletes this shared file. */
export async function uploadStoreProductImage(ownerAccountId: string, bytes: Buffer, mime: string): Promise<string> {
  if (!ownerAccountId || !matchesProductImage(bytes, mime)) throw new Error('Invalid product image');
  const client = oxyServiceClient();
  if (!client) throw new Error('Product image upload is unavailable');
  const response = await fetch(`${client.baseURL.replace(/\/+$/, '')}/assets/service/user-media`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${await client.serviceToken()}`, 'Content-Type': mime,
      'Content-Length': String(bytes.length), 'x-owner-user-id': ownerAccountId, 'x-original-name': 'product-image', Accept: 'application/json' },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Product image upload failed'); }
  const payload = await response.json() as { data?: { file?: { id?: unknown; visibility?: unknown } } };
  const file = payload.data?.file;
  if (!isOxyFileId(file?.id) || file.visibility !== 'public') throw new Error('Product image upload did not return a public file');
  return file.id;
}
