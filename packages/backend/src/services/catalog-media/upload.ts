import { isOxyFileId } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';

import { matchesProductImage, matchesProductVideo } from './policy.js';
export { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_MIMES, matchesProductImage } from './policy.js';

/** The owning account comes ONLY from loadStore's persisted store, never a header
 * or the operator's identity. Removing a selection never deletes this shared file. */
export async function uploadStoreProductImage(
  ownerAccountId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  return (await uploadStoreProductMedia(ownerAccountId, bytes, mime, 'image')).fileId;
}

export async function uploadStoreProductMedia(
  ownerAccountId: string,
  bytes: Buffer,
  mime: string,
  kind: 'image' | 'video',
): Promise<{ fileId: string; kind: 'image' | 'video' }> {
  if (
    !ownerAccountId ||
    !(kind === 'image' ? matchesProductImage(bytes, mime) : matchesProductVideo(bytes, mime))
  )
    throw new Error('Invalid product media');
  const client = oxyServiceClient();
  if (!client) throw new Error('Product media upload is unavailable');
  const response = await fetch(`${client.baseURL.replace(/\/+$/, '')}/assets/service/user-media`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: `Bearer ${await client.serviceToken()}`,
      'Content-Type': mime,
      'Content-Length': String(bytes.length),
      'x-owner-user-id': ownerAccountId,
      'x-original-name': `product-${kind}`,
      Accept: 'application/json',
    },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Product media upload failed');
  }
  const payload = (await response.json()) as {
    data?: { file?: { id?: unknown; visibility?: unknown; mime?: unknown; size?: unknown } };
  };
  const file = payload.data?.file;
  if (!isOxyFileId(file?.id) || file.visibility !== 'public')
    throw new Error('Product media upload did not return a public file');
  if (kind === 'video' && (file.mime !== mime || file.size !== bytes.length))
    throw new Error('Product video metadata did not match the uploaded bytes');
  return { fileId: file.id, kind };
}
