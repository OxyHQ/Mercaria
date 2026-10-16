import { Router, raw } from 'express';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { sendError, sendSuccess, ErrorCodes } from '../../utils/api-response.js';
import { uploadStoreProductMedia } from '../../services/catalog-media/upload.js';
import {
  matchesProductImage,
  matchesProductVideo,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_IMAGE_MIMES,
} from '../../services/catalog-media/policy.js';

/** Mounted below authenticated loadStore. Image MIME bypasses express.json;
 * permission and MIME validation precede buffering, with a strict byte cap. */
export const productMediaRouter = Router({ mergeParams: true });
productMediaRouter.post(
  '/',
  requireStorePermission('products:write'),
  (req, res, next) => {
    if (!req.store?.oxyAccountId) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Store access required', 403);
      return;
    }
    const mime = req.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (mime !== 'video/mp4' && !(PRODUCT_IMAGE_MIMES as readonly string[]).includes(mime)) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'Unsupported product media type', 415);
      return;
    }
    raw({
      type: () => true,
      limit: mime === 'video/mp4' ? PRODUCT_VIDEO_MAX_BYTES : PRODUCT_IMAGE_MAX_BYTES,
      inflate: false,
    })(req, res, (error) => {
      if (error) {
        sendError(
          res,
          ErrorCodes.VALIDATION_ERROR,
          'Product media exceeds the size limit or cannot be read',
          error.status === 413 ? 413 : 400,
        );
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const mime = req.get('content-type').split(';')[0].trim().toLowerCase();
    const kind = mime === 'video/mp4' ? 'video' : 'image';
    if (
      !Buffer.isBuffer(req.body) ||
      !(kind === 'video'
        ? matchesProductVideo(req.body, mime)
        : matchesProductImage(req.body, mime))
    ) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'The file is not a supported product media', 400);
      return;
    }
    try {
      const media = await uploadStoreProductMedia(req.store.oxyAccountId, req.body, mime, kind);
      sendSuccess(res, media, 201);
    } catch {
      sendError(
        res,
        ErrorCodes.INTERNAL_ERROR,
        'Product media upload failed. Please try again.',
        502,
      );
    }
  },
);
