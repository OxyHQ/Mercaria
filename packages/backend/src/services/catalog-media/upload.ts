import { uploadOxyFile } from './oxy-files.js';

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
  let file: Awaited<ReturnType<typeof uploadOxyFile>>;
  try {
    file = await uploadOxyFile(
      { kind: 'account', oxyUserId: ownerAccountId },
      bytes,
      mime,
      `product-${kind}`,
    );
  } catch {
    throw new Error('Product media upload failed');
  }
  if (file.visibility !== 'public')
    throw new Error('Product media upload did not return a public file');
  if (kind === 'video' && (file.mime !== mime || file.size !== bytes.length))
    throw new Error('Product video metadata did not match the uploaded bytes');
  return { fileId: file.fileId, kind };
}
