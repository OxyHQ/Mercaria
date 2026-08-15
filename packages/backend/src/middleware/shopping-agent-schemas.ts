/**
 * Request schemas for the saved shopping-agent surface (#97).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a request cannot propose a value a CHECK then
 * refuses.
 *
 * ## What `.strict()` is doing here specifically
 *
 * No schema in this file carries an order, a cart, a checkout group, a payment
 * method, a card, a merchant message or a merchant's terms — and #97
 * acceptance 9 ("there is no code path from an agent to autonomous checkout or
 * payment") is that absence rather than a check somebody wrote. `.strict()` is
 * what makes adding one a visible act instead of a field the parser quietly
 * ignores.
 *
 * It is not the whole of the answer, though, because a strict schema refuses an
 * undeclared key with "Unrecognized key", which is true and useless.
 * {@link refuseForbiddenAgentAction} runs BEFORE these schemas and answers with
 * the exact prohibition it found — #121's `forbidden-evidence.ts` device, and
 * the difference between a client author reading "we do not support that field"
 * and reading "this system does not do that".
 *
 * ## The constraint language is #94's, imported rather than restated
 *
 * Two spellings of one grammar is two answers to what a shopper asked for, and
 * the one they are shown is whichever happened to render. `constraintDigest` is
 * REQUIRED on every write that changes the constraints: the client echoes back
 * the digest of what it rendered for confirmation, and a mismatch is refused —
 * which is how #97 privacy 1 becomes a comparison rather than a checkbox.
 *
 * ## What a client may set on an UPDATE is narrower than on a CREATE
 *
 * `state` accepts `enabled` and `paused` and nothing else. `blocked` is a
 * catalogue split's verdict and is answered through `resolve-split`;
 * `completed` is the machine's; `deleted` is the DELETE route. A client able to
 * type `enabled` over a `blocked` agent would walk around the ambiguity it was
 * asked to resolve.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  MAX_CONSTRAINTS_PER_SET,
  MAX_SHOPPING_AGENT_DESCRIPTION_CHARS,
  MAX_SHOPPING_AGENT_LINES,
  MAX_SHOPPING_AGENT_NAME_CHARS,
  MAX_MONEY_MINOR_UNITS,
  SHOPPING_AGENT_CHANNEL_POLICIES,
  SHOPPING_AGENT_JOB_KINDS,
  SHOPPING_AGENT_MINUTES_PER_DAY,
  SHOPPING_AGENT_NOTIFICATION_CHANNELS,
  SHOPPING_AGENT_PRICE_BASES,
  SHOPPING_AGENT_SPLIT_RESOLUTIONS,
  SHOPPING_AGENT_TRIGGER_SOURCES,
  type ConditionGroup,
  type CurrencyCode,
  type ShoppingAgentChannelPolicy,
  type ShoppingAgentJobKind,
  type ShoppingAgentNotificationChannel,
  type ShoppingAgentPriceBasis,
  type ShoppingAgentSplitResolution,
  type ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { productConstraintSchema } from './attribute-schemas.js';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const KIND_VALUES = SHOPPING_AGENT_JOB_KINDS as readonly [
  ShoppingAgentJobKind,
  ...ShoppingAgentJobKind[],
];
const BASIS_VALUES = SHOPPING_AGENT_PRICE_BASES as readonly [
  ShoppingAgentPriceBasis,
  ...ShoppingAgentPriceBasis[],
];
const CHANNEL_POLICY_VALUES = SHOPPING_AGENT_CHANNEL_POLICIES as readonly [
  ShoppingAgentChannelPolicy,
  ...ShoppingAgentChannelPolicy[],
];
const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const TRIGGER_SOURCE_VALUES = SHOPPING_AGENT_TRIGGER_SOURCES as readonly [
  ShoppingAgentTriggerSource,
  ...ShoppingAgentTriggerSource[],
];
const NOTIFICATION_CHANNEL_VALUES = SHOPPING_AGENT_NOTIFICATION_CHANNELS as readonly [
  ShoppingAgentNotificationChannel,
  ...ShoppingAgentNotificationChannel[],
];
const SPLIT_RESOLUTION_VALUES = SHOPPING_AGENT_SPLIT_RESOLUTIONS as readonly [
  ShoppingAgentSplitResolution,
  ...ShoppingAgentSplitResolution[],
];

const entityId = z.string().trim().min(1).max(64);

/**
 * The ceiling is what makes the bound real: `z.number().int()` alone accepts
 * `1e300`, and every money boundary in this repo carries
 * `MAX_MONEY_MINOR_UNITS` for that reason.
 */
const money = z
  .object({
    amount: z.number().int().positive().max(MAX_MONEY_MINOR_UNITS),
    currency: z.enum(CURRENCY_VALUES),
  })
  .strict();

const market = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'market must be an ISO 3166-1 alpha-2 code');

const line = z
  .object({
    canonicalProductId: entityId,
    canonicalVariantId: entityId.optional(),
    quantity: z.number().int().min(1).max(999).optional(),
    conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).max(CONDITION_GROUPS.length).optional(),
    merchantId: entityId.optional(),
  })
  .strict();

const quietHours = z
  .object({
    startMinute: z.number().int().min(0).max(SHOPPING_AGENT_MINUTES_PER_DAY - 1),
    endMinute: z.number().int().min(0).max(SHOPPING_AGENT_MINUTES_PER_DAY - 1),
    timeZone: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * The policy half, shared by create and update.
 *
 * `cooldownSeconds` has a floor of one minute rather than none: a cooldown of
 * zero is not a policy, it is the absence of one, and #97 notification 2 asks
 * for cooldowns and reset conditions rather than for a way to opt out of them.
 */
const policyFields = {
  priceBasis: z.enum(BASIS_VALUES).optional(),
  channelPolicy: z.enum(CHANNEL_POLICY_VALUES).optional(),
  market: market.optional(),
  conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).max(CONDITION_GROUPS.length).optional(),
  excludedMerchantIds: z.array(entityId).max(50).optional(),
  triggerSources: z.array(z.enum(TRIGGER_SOURCE_VALUES)).min(1).max(3).optional(),
  scheduleIntervalSeconds: z.number().int().min(900).max(90 * 24 * 60 * 60).optional(),
  notificationChannels: z.array(z.enum(NOTIFICATION_CHANNEL_VALUES)).min(1).max(2).optional(),
  cooldownSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  quietHours: quietHours.optional(),
  locale: z.string().trim().min(2).max(35).optional(),
} as const;

export const createShoppingAgentSchema = z
  .object({
    kind: z.enum(KIND_VALUES),
    name: z.string().trim().min(1).max(MAX_SHOPPING_AGENT_NAME_CHARS),
    description: z.string().trim().max(MAX_SHOPPING_AGENT_DESCRIPTION_CHARS).optional(),
    displayCurrency: z.enum(CURRENCY_VALUES),
    target: money.optional(),
    lines: z.array(line).min(1).max(MAX_SHOPPING_AGENT_LINES),
    /** #94's grammar, imported. May be empty — an agent need not constrain. */
    constraints: z.array(productConstraintSchema).max(MAX_CONSTRAINTS_PER_SET),
    /** #97 privacy 1: the digest of exactly what the shopper confirmed. */
    constraintDigest: z.string().trim().min(8).max(128),
    ...policyFields,
  })
  .strict();

export const updateShoppingAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_SHOPPING_AGENT_NAME_CHARS).optional(),
    description: z.string().trim().max(MAX_SHOPPING_AGENT_DESCRIPTION_CHARS).optional(),
    /** A NARROWER subset than the column's — see the module header. */
    state: z.enum(['enabled', 'paused']).optional(),
    target: money.optional(),
    lines: z.array(line).min(1).max(MAX_SHOPPING_AGENT_LINES).optional(),
    constraints: z.array(productConstraintSchema).max(MAX_CONSTRAINTS_PER_SET).optional(),
    /** REQUIRED whenever `constraints` or `lines` moves. Checked in the service. */
    constraintDigest: z.string().trim().min(8).max(128).optional(),
    ...policyFields,
  })
  .strict();

export const resolveShoppingAgentSplitSchema = z
  .object({ resolution: z.enum(SPLIT_RESOLUTION_VALUES) })
  .strict();

export const listShoppingAgentsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();

export const listShoppingAgentFindingsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
