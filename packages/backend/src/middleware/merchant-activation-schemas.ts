/**
 * Request schemas for the merchant activation surface (#85).
 *
 * Every schema is `.strict()`, and here that is a security property rather than
 * tidiness: #85 capability rule 2 is "client UI cannot override them" and
 * acceptance 2 is "skipping a client step cannot enable checkout when an
 * authoritative requirement is missing". A body able to carry a capability name,
 * a requirement key, a readiness verdict or a hold flag is where one would
 * eventually be trusted — so an undeclared field is REFUSED rather than
 * stripped, and the declared set below is deliberately three fields long.
 *
 * There is no `capabilities`, no `nativeCheckoutState`, no `activated` and no
 * `platformHold` anywhere in this file. A merchant states an INTENT and a
 * contact; everything else is derived.
 */

import { z } from 'zod';
import {
  MERCHANT_ACTIVATION_POLICY_KEYS,
  MERCHANT_CHECKOUT_INTENTS,
  type MerchantActivationPolicyKey,
  type MerchantCheckoutIntent,
} from '@mercaria/shared-types';
import {
  MERCHANT_ACTIVATION_MAX_HOLD_REASON_LENGTH,
  MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH,
} from '../db/schema/merchantActivation.js';

const INTENT_VALUES = MERCHANT_CHECKOUT_INTENTS as readonly [
  MerchantCheckoutIntent,
  ...MerchantCheckoutIntent[],
];
const POLICY_KEY_VALUES = MERCHANT_ACTIVATION_POLICY_KEYS as readonly [
  MerchantActivationPolicyKey,
  ...MerchantActivationPolicyKey[],
];

/**
 * A public support email, or `null` to clear it.
 *
 * `null` is representable on purpose: a merchant who published a support address
 * and closed that inbox must be able to remove it, and the requirement then goes
 * unsatisfied — which is correct and visible, where leaving a dead address
 * satisfied is neither.
 */
const supportEmail = z
  .string()
  .trim()
  .email()
  .max(MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH)
  .nullable();

/**
 * A public support URL, HTTPS only.
 *
 * Same rule the SSRF-facing surfaces use, for a different reason: this URL is
 * rendered to buyers, and an `http://` support page is a form somebody fills in
 * over the wire. The CHECK on the column states it again, so a write that
 * bypassed this schema still cannot store one.
 */
const supportUrl = z
  .string()
  .trim()
  .url()
  .startsWith('https://')
  .max(MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH)
  .nullable();

/** What a merchant may change about its own activation. Three fields, no more. */
export const updateActivationSettingsSchema = z
  .object({
    nativeCheckoutIntent: z.enum(INTENT_VALUES).optional(),
    guestCheckoutIntent: z.enum(INTENT_VALUES).optional(),
    supportEmail: supportEmail.optional(),
    supportUrl: supportUrl.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateActivationSettingsBody = z.infer<typeof updateActivationSettingsSchema>;

/**
 * Accepting a policy. The body ECHOES the version the seller's screen showed, so
 * an acceptance recorded against a stale dialog is refused with the current one
 * rather than silently recorded against the wrong version — #88's fee-acceptance
 * rule, and the reason it exists is the same: consent has to name what was seen.
 *
 * There is no `ownerType` and no `ownerId`: the policy declares who may accept
 * it and the route establishes who is asking. A body carrying either would be a
 * way to accept a policy on somebody else's behalf.
 */
export const acceptActivationPolicySchema = z
  .object({
    policyKey: z.enum(POLICY_KEY_VALUES),
    policyVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export type AcceptActivationPolicyBody = z.infer<typeof acceptActivationPolicySchema>;

/**
 * An operator holds a store's checkout.
 *
 * The reason is MANDATORY and bounded. Mandatory because a hold with no stated
 * reason is one nobody can review or lift with confidence; bounded because this
 * is an audit field and not a case file — the moderation record lives where
 * moderation records live.
 */
export const holdStoreActivationSchema = z
  .object({
    reason: z.string().trim().min(1).max(MERCHANT_ACTIVATION_MAX_HOLD_REASON_LENGTH),
  })
  .strict();

export type HoldStoreActivationBody = z.infer<typeof holdStoreActivationSchema>;
