/**
 * Local zod schemas for the API-key channel connect flow (kept out of the shared
 * `middleware/schemas.ts` on purpose). Used by the channels router
 * (`validateBody`) and the channels controller (the parsed body type).
 */

import { z } from 'zod';
import { isLiveEntityId } from '@oxyhq/db';
import {
  CHANNEL_DISCONNECT_POLICIES,
  CHANNEL_ONBOARDING_STEPS,
  CHANNEL_PAUSE_SCOPES,
  CHANNEL_TYPE_IDS,
} from '@mercaria/shared-types';

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
 * omitted the key is store-scoped. Its SHAPE is checked with `isLiveEntityId` so
 * a malformed id is rejected at the edge rather than in the service — the same
 * predicate `validate.ts` uses, and the only place either id shape is spelled
 * out. A hand-written pattern here would reject one of the two shapes a
 * `connections.id` can hold.
 */
export const generateChannelKeySchema = z.object({
  label: z.string().trim().min(1).max(120),
  connectionId: z
    .string()
    .trim()
    .refine(isLiveEntityId, 'Must be a valid connection id')
    .optional(),
});

/** The validated body of a channel-key generate request. */
export type GenerateChannelKeyBody = z.infer<typeof generateChannelKeySchema>;

/**
 * Body for `POST /admin/stores/:storeId/channels/:connectionId/pause` (#87
 * management 4).
 *
 * `.strict()` for the reason every schema in this codebase that decides
 * something is: a body able to carry an unrecognized key is where somebody
 * eventually puts a value the server would trust. The two fields are the whole
 * of it — WHICH scope, and which way — because a pause has no other parameter
 * and a duration would be a promise nothing schedules.
 */
export const pauseChannelSchema = z
  .object({
    scope: z.enum(CHANNEL_PAUSE_SCOPES),
    paused: z.boolean(),
  })
  .strict();

/** The validated body of a channel pause change. */
export type PauseChannelInput = z.infer<typeof pauseChannelSchema>;

/**
 * Body for `POST /admin/stores/:storeId/channels/:connectionId/disconnect`
 * (#87 management 7).
 *
 * `policy` is REQUIRED and has no default. That is the point of the route: the
 * three answers are all defensible and only the merchant knows which they mean,
 * so a default here would be Mercaria deciding the fate of somebody's catalogue
 * on their behalf. A caller that will not choose has the v1 `DELETE`, whose
 * behaviour has always been `keep_listings`.
 */
export const disconnectChannelSchema = z
  .object({
    policy: z.enum(CHANNEL_DISCONNECT_POLICIES),
  })
  .strict();

/** The validated body of a policy-carrying disconnect. */
export type DisconnectChannelInput = z.infer<typeof disconnectChannelSchema>;

/**
 * Body for `POST /admin/stores/:storeId/channels/onboarding` — start a wizard.
 *
 * A channel TYPE rather than a connector provider id: `product_feed` and
 * `woocommerce_plugin` are both startable and neither is a `connections.provider`
 * value. Whether the type is available on this deployment is the SERVICE's
 * question, not the schema's — a 400 saying "invalid enum value" for a channel
 * Mercaria genuinely supports but has not configured would send a merchant
 * looking for a typo.
 */
export const startChannelOnboardingSchema = z
  .object({
    channelType: z.enum(CHANNEL_TYPE_IDS),
  })
  .strict();

/** The validated body of an onboarding start. */
export type StartChannelOnboardingInput = z.infer<typeof startChannelOnboardingSchema>;

/**
 * Body for `PATCH /admin/stores/:storeId/channels/onboarding/:sessionId`.
 *
 * There is NO credential field, and that absence is wizard step 4 rather than a
 * validation rule: a consumer secret has no key it could arrive under, so the
 * `.strict()` refusal is a second layer rather than the only one.
 *
 * The preview counters are accepted from the client because a preview is run by
 * the channel's OWN surface — a feed preview is `POST /feeds/:id/versions/:v/preview`,
 * a connector sample is a bounded backfill — and this session records what the
 * merchant saw. They are bounded and non-negative, and the session's own
 * `..._preview_total_check` refuses a set that does not partition `scanned`, so
 * a client cannot record a preview that lost records.
 */
export const advanceChannelOnboardingSchema = z
  .object({
    step: z.enum(CHANNEL_ONBOARDING_STEPS).optional(),
    connectionId: z.string().trim().refine(isLiveEntityId, 'Invalid id').optional(),
    feedConfigurationId: z.string().trim().refine(isLiveEntityId, 'Invalid id').optional(),
    preview: z
      .object({
        scanned: z.number().int().min(0).max(10_000_000),
        matched: z.number().int().min(0).max(10_000_000),
        created: z.number().int().min(0).max(10_000_000),
        review: z.number().int().min(0).max(10_000_000),
        invalid: z.number().int().min(0).max(10_000_000),
        duplicate: z.number().int().min(0).max(10_000_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

/** The validated body of an onboarding step. */
export type AdvanceChannelOnboardingInput = z.infer<typeof advanceChannelOnboardingSchema>;
