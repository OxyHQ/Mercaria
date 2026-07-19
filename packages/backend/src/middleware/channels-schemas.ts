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

/**
 * Body for `POST /admin/stores/:storeId/channel-keys` — mint a channel API key.
 *
 * `label` is a short human-readable name the merchant uses to recognize the key.
 * `connectionId` is optional: when present it binds the key to a single push-in
 * connection (validated store-side to belong to the store AND be `push_in`); when
 * omitted the key is store-scoped. It is validated as a Mongo ObjectId shape so a
 * malformed id is rejected at the edge rather than in the service.
 */
export const generateChannelKeySchema = z.object({
  label: z.string().trim().min(1).max(120),
  connectionId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'Must be a valid connection id')
    .optional(),
});

/** The validated body of a channel-key generate request. */
export type GenerateChannelKeyBody = z.infer<typeof generateChannelKeySchema>;
