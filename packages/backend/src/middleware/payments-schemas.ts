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
import {
  ALL_CURRENCY_CODES,
  LEDGER_ACCOUNTS,
  LEDGER_OWNER_TYPES,
  type CurrencyCode,
  type LedgerAccount,
  type LedgerOwnerType,
} from '@mercaria/shared-types';

/**
 * The shared value sets, as the zod tuples an enum needs.
 *
 * Derived from `@mercaria/shared-types` rather than retyped, exactly as
 * `schemas.ts` derives its own currency tuple: a hand-copied list here could
 * accept a value the database's CHECK then refuses — a 500 on an operator's
 * correcting entry, from two lists that merely LOOKED identical.
 */
const CURRENCY_CODE_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const LEDGER_ACCOUNT_VALUES = LEDGER_ACCOUNTS as readonly [LedgerAccount, ...LedgerAccount[]];
const LEDGER_OWNER_TYPE_VALUES = LEDGER_OWNER_TYPES as readonly [
  LedgerOwnerType,
  ...LedgerOwnerType[],
];

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

// ─────────────────────────────────────────────────────────────────────────────
// The operator surface (#50)
//
// Every schema below is `.strict()`. That is not stylistic here: an operator
// body reaches code that moves money, and a field the schema does not declare
// must be REFUSED rather than stripped — a request naming `amountMinor` on a
// retry, or an extra ledger leg on a correction, is somebody misunderstanding
// the surface, and silently ignoring it would let them believe it worked.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four handles a trace may be opened from — issue #50, operator surface 1.
 *
 * Exactly one must be given, which `superRefine` enforces rather than a union of
 * four object shapes: the error message from a union is a list of four failures
 * and says nothing useful, while this one names the rule.
 *
 * **The absent handles are the point.** There is no `email`, no `phone`, no card
 * fingerprint and no Stripe Customer — none of them can authenticate a Mercaria
 * buyer or claim a Mercaria order (#45 buyer boundaries, #48 identity boundaries
 * 1 and 2), and a resolver able to reach them is the surface where they would
 * eventually be used. `tracePayment`'s own signature has the same property; this
 * schema is what stops an HTTP caller getting around it.
 */
export const paymentTraceQuerySchema = z
  .object({
    orderNumber: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    checkoutGroupId: z.string().trim().min(1).optional(),
    paymentId: z.string().trim().min(1).optional(),
    providerObjectId: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const given = Object.values(value).filter((field) => field !== undefined).length;
    if (given === 1) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Give exactly one of orderNumber, orderId, checkoutGroupId, paymentId or ' +
        'providerObjectId. A trace is opened from one handle.',
    });
  });

/** The validated trace query. */
export type PaymentTraceQueryInput = z.infer<typeof paymentTraceQuerySchema>;

/** How the exception and discrepancy queues are filtered. */
export const paymentExceptionsQuerySchema = z
  .object({
    kind: z.string().trim().min(1).optional(),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** The validated queue filter. */
export type PaymentExceptionsQueryInput = z.infer<typeof paymentExceptionsQuerySchema>;

/**
 * Re-fetching provider state for one payment — issue #50, operator surface 5.
 *
 * A payment id and nothing else. In particular NOT a status: this endpoint reads
 * what the rail says and applies it through the ordinary path, so a caller able
 * to name a desired outcome would be the "mark it paid" surface acceptance 5
 * forbids.
 */
export const paymentRefetchSchema = z.object({ paymentId: z.string().trim().min(1) }).strict();

/** The validated refetch request. */
export type PaymentRefetchInput = z.infer<typeof paymentRefetchSchema>;

/**
 * A named repair — issue #50, operator surface 6.
 *
 * A discriminated union on `action`, so each variant declares exactly the ids it
 * needs and nothing else parses. `reason` is required on every arm (repair
 * invariant 9) with a real minimum length: an operator typing `x` to satisfy a
 * validator produces an audit trail that records that they typed `x`.
 *
 * `book_reconciling_entry` carries the only free-form payload on this surface,
 * and its shape is the ledger's own: a currency and a list of signed legs. The
 * amounts are STRINGS because a ledger entry is `bigint` — `CONVENTIONS.md`'s
 * one money deviation — and JSON numbers lose exactness past 2^53 silently,
 * which is the one thing a correcting entry may not do.
 */
export const paymentRepairSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('retry_withheld_transfer'),
      reason: z.string().trim().min(8).max(2_000),
      discrepancyId: z.string().trim().min(1).optional(),
      paymentId: z.string().trim().min(1),
      orderId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('retry_transfer_reversal'),
      reason: z.string().trim().min(8).max(2_000),
      discrepancyId: z.string().trim().min(1).optional(),
      subjectKind: z.enum(['refund', 'dispute']),
      subjectId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('retry_provider_refund'),
      reason: z.string().trim().min(8).max(2_000),
      discrepancyId: z.string().trim().min(1).optional(),
      refundId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('book_reconciling_entry'),
      reason: z.string().trim().min(8).max(2_000),
      // MANDATORY here, unlike the three retries: a correcting ledger entry with
      // nothing to attach it to is an unexplained movement, which is the one
      // thing the ledger may not contain. The database enforces it too.
      discrepancyId: z.string().trim().min(1),
      // Validated against Mercaria's OWN closed set, not "three letters": a
      // ledger entry in a currency nothing else in the system prices, converts
      // or reports would be a correction no report could ever include, and the
      // column's CHECK would refuse it a layer later with a message about a
      // constraint rather than about the currency.
      currency: z.enum(CURRENCY_CODE_VALUES),
      entries: z
        .array(
          z
            .object({
              account: z.enum(LEDGER_ACCOUNT_VALUES),
              // Signed minor units as a decimal string — see the docblock.
              amountMinor: z.string().regex(/^-?[1-9]\d*$/, 'A signed integer, never zero'),
              ownerType: z.enum(LEDGER_OWNER_TYPE_VALUES).optional(),
              ownerId: z.string().trim().min(1).optional(),
              orderId: z.string().trim().min(1).optional(),
            })
            .strict()
            .refine(
              (entry) => (entry.ownerType === undefined) === (entry.ownerId === undefined),
              'ownerType and ownerId travel together — a type with no id is unusable and an id ' +
                'with no type is ambiguous between a store and an Oxy user.',
            ),
        )
        .min(2, 'A correcting transaction needs at least two entries to balance.')
        .max(20),
    })
    .strict(),
]);

/** The validated repair request. */
export type PaymentRepairInput = z.infer<typeof paymentRepairSchema>;

/**
 * Closing a discrepancy — issue #50, operator surface 8.
 *
 * The actor is NOT a field. It comes from the authenticated caller, exactly as
 * the seller payments surface derives its owner: a body able to name who
 * resolved something is an audit trail anybody can forge.
 */
export const discrepancyResolutionSchema = z
  .object({
    status: z.enum(['acknowledged', 'resolved']).default('resolved'),
    reason: z.string().trim().min(8).max(200),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** The validated resolution. */
export type DiscrepancyResolutionInput = z.infer<typeof discrepancyResolutionSchema>;
