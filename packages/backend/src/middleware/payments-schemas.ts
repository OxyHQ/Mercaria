/**
 * Request schemas for the seller payments surface.
 *
 * Its own file rather than a section of `schemas.ts`, following
 * `channels-schemas.ts`: the payments routes are a self-contained surface and
 * their validation reads better beside the ADR that decides it.
 *
 * The whole surface takes ONE optional field, and that is the point. Everything
 * else about a connected account — its id, its capabilities, its requirements,
 * its state — is read from the provider or derived by Mercaria, and a request
 * body able to carry any of it would be the mass-assignment surface that turns
 * "create my account" into "attach that account to my store" (#46, security 3).
 */

import { z } from 'zod';

/**
 * Starting or resuming hosted onboarding.
 *
 * `country` is the ONLY thing a client may say, and only the first time: it is
 * immutable at the provider once an account exists, so a later value is ignored
 * rather than rejected — refusing it would break the ordinary case of a
 * dashboard that still has the picker on screen when it re-mints a link.
 *
 * Validated for SHAPE here and for MEMBERSHIP in `account.service`, against
 * `STRIPE_SELLER_COUNTRIES`. Splitting it that way keeps the allow-list where
 * the ADR's reasoning about it lives, instead of freezing a Stripe region into a
 * zod schema.
 */
export const onboardingLinkSchema = z.object({
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Country must be a two-letter ISO-3166-1 code')
    .optional(),
});

/** The validated body of a hosted-onboarding request. */
export type OnboardingLinkBody = z.infer<typeof onboardingLinkSchema>;

/**
 * The signed round-trip state Stripe echoes back on `refresh_url`/`return_url`.
 *
 * Present and non-empty is all a schema can say about it — its integrity is the
 * HMAC's job, in `onboarding-state.ts`. Validated here so a request with no
 * `state` at all is a 400 naming the parameter rather than a signature failure
 * on an empty string.
 */
export const onboardingReturnQuerySchema = z.object({
  state: z.string().min(1),
});
