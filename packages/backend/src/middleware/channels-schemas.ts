/**
 * Local zod schemas for the API-key channel connect flow (kept out of the shared
 * `middleware/schemas.ts` on purpose). Used by the channels router
 * (`validateBody`) and the channels controller (the parsed body type).
 */

import { z } from 'zod';

/**
 * Body for `POST /admin/stores/:storeId/channels/:provider/connect-key`.
 *
 * `shopDomain` is the merchant's WooCommerce SITE URL and MUST be `https://` — the
 * transport rejects non-https and consumer credentials must never travel in the
 * clear. A full URL (not a bare host) is required so a WooCommerce install in a
 * subdirectory (`https://example.com/store`) resolves its REST base correctly. The
 * `consumerKey`/`consumerSecret` are the merchant's WooCommerce REST API key pair.
 */
export const connectKeyChannelSchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Must be an https:// site URL'),
  consumerKey: z.string().trim().min(1).max(255),
  consumerSecret: z.string().trim().min(1).max(255),
});

/** The validated body of an API-key channel connect. */
export type ConnectKeyChannelInput = z.infer<typeof connectKeyChannelSchema>;
