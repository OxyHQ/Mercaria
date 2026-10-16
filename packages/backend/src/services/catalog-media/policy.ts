export const PRODUCT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PRODUCT_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export function matchesProductImage(bytes: Buffer, mime: string): boolean {
  if (!bytes.length || bytes.length > PRODUCT_IMAGE_MAX_BYTES) return false;
  switch (mime) {
    case 'image/jpeg':
      return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'image/avif':
      return (
        bytes.subarray(4, 8).toString('ascii') === 'ftyp' &&
        ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))
      );
    default:
      return false;
  }
}

export const PRODUCT_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

export function matchesProductVideo(bytes: Buffer, mime: string): boolean {
  if (mime !== 'video/mp4' || bytes.length < 16 || bytes.length > PRODUCT_VIDEO_MAX_BYTES)
    return false;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length || bytes.subarray(4, 8).toString('ascii') !== 'ftyp')
    return false;
  // ISO base-media containers include images (AVIF/HEIF): require an MP4 brand.
  const brands = [bytes.subarray(8, 12).toString('ascii')];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4)
    brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
  return brands.some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand));
}

export function catalogMediaKind(mime: string, size: number): 'image' | 'video' | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined;
  if ((PRODUCT_IMAGE_MIMES as readonly string[]).includes(mime) && size <= PRODUCT_IMAGE_MAX_BYTES)
    return 'image';
  return mime === 'video/mp4' && size <= PRODUCT_VIDEO_MAX_BYTES ? 'video' : undefined;
}
