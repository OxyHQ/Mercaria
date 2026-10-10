import { isOxyFileId, type ApiResponse } from '@mercaria/shared-types';
import apiClient from './api/client';
import { unwrap } from './api/unwrap';

export const PRODUCT_PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PRODUCT_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
export function validProductPhoto(mime: string | undefined, size: number) {
  return PRODUCT_PHOTO_MIMES.includes(mime ?? '') && Number.isSafeInteger(size) && size > 0 && size <= PRODUCT_PHOTO_MAX_BYTES;
}
export async function uploadProductPhoto(storeId: string, bytes: Blob, onProgress: (value: number) => void, signal: AbortSignal): Promise<string> {
  if (!validProductPhoto(bytes.type, bytes.size)) throw new Error('Invalid product image');
  const result = await apiClient.post<ApiResponse<{ fileId: string }>>(`/admin/stores/${storeId}/products/media`, bytes, {
    headers: { 'Content-Type': bytes.type }, timeout: 60_000, signal,
    onUploadProgress: event => { if (event.total) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); },
  });
  const { fileId } = unwrap(result.data);
  if (!isOxyFileId(fileId)) throw new Error('Invalid uploaded product file ID');
  return fileId;
}
