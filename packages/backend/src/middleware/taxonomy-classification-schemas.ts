/**
 * Request schemas for `/internal/taxonomy/classifications/*` (#367 Workstream 1).
 *
 * `.strict()`, and here it is load-bearing rather than habitual. The forbidden
 * reasons in `SECONDARY_CLASSIFICATION_FORBIDDEN_REASONS` are the ways this
 * surface would be misused — filing a product somewhere to make it appear in a
 * carousel, to lift it in search, to stand in for a redirect — and a permissive
 * body is how one of them arrives under a key nobody declared, such as
 * `{ reason: 'multi_function_product', boost: true }`.
 *
 * ## `isPrimary` is refused BY NAME, and that is the point
 *
 * The primary category is `listings.category_id` / `canonical_products.category_id`,
 * written by their own owners. A client that sends `isPrimary` has the wrong
 * model of this surface, and `.strict()` alone would answer "Unrecognized
 * key(s)" — true, unhelpful, and identical to the answer for a typo. Naming it
 * says which door to use instead. The `forbidden-evidence.ts` device from #121,
 * for the same reason: an answer beats a rejection.
 */

import { z } from 'zod';
import {
  SECONDARY_CLASSIFICATION_FORBIDDEN_REASONS,
  SECONDARY_CLASSIFICATION_REASONS,
} from '@mercaria/shared-types';
import type { SecondaryClassificationReason } from '@mercaria/shared-types';

/**
 * A shared tuple, narrowed to the non-empty form `z.enum` requires.
 *
 * Reading the SAME tuple the Postgres CHECK is rendered from is what stops a
 * reason being storable and unreachable, or reachable and unstorable.
 */
function enumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('A z.enum of no values rejects every request');
  }
  return [first, ...rest];
}

const REASON_VALUES = enumValues<SecondaryClassificationReason>(SECONDARY_CLASSIFICATION_REASONS);

/**
 * Keys that name a decision this surface does not make, answered by NAME.
 *
 * Mounted BEFORE the `.strict()` shape check, so the specific answer wins over
 * the generic one. A test pins each MESSAGE — the whole value here is the
 * wording, so a gate on the status code alone would pass against
 * "Unrecognized key(s)".
 */
const MISDIRECTED_KEYS: Readonly<Record<string, string>> = {
  isPrimary:
    'A secondary classification is never primary. The primary category is the subject’s own ' +
    'category_id and is set through the listing or canonical-product write path.',
  primary: 'The primary category is not set here. Use the listing or canonical-product write path.',
  categorySlug:
    'Classifications name a category by id, not by slug: a slug is presentation and is never ' +
    'identity (ADR 0007 D1).',
  categoryKey:
    'Classifications name a category by id. A key is stable but is still a handle, and the id is ' +
    'what the foreign key targets.',
  position:
    'Secondary classifications carry no order. An ordering column would make “the first one” a ' +
    'second way to say “primary”.',
  sortOrder: 'Secondary classifications carry no order.',
};

/**
 * `POST /internal/taxonomy/classifications/:subjectKind/:subjectId` — file one
 * secondary classification.
 *
 * `justifiedBy` is deliberately absent from the body. It is the AUTHENTICATED
 * operator, taken from the credential, and a body field would let one operator
 * file a decision in another's name — the `applicationId` reasoning from the
 * CrowdSource integration, one domain over.
 */
const DECLARED_KEYS = ['categoryId', 'reason', 'justification', 'schemeRef'] as const;

export const secondaryClassificationSchema = z
  .object({
    categoryId: z.string().trim().min(1),
    /**
     * `z.string()` and not `z.enum(REASON_VALUES)`, for the ordering reason
     * again: a failed enum fails the SHAPE parse, so `superRefine` never runs
     * and a forbidden reason would be answered "Invalid enum value" — the
     * generic rejection, in the one place the specific answer matters most.
     * Membership is checked below, against the same tuple, forbidden first.
     */
    reason: z.string().trim().min(1),
    /**
     * Bounded at both ends. The floor is what makes "justified" real — the
     * database CHECK refuses a blank, and this refuses it before a round trip
     * — and the ceiling exists because this text is rendered in an operator
     * surface and a justification is a sentence, not a document.
     */
    justification: z.string().trim().min(1).max(2000),
    schemeRef: z.string().trim().min(1).max(200).optional(),
  })
  /**
   * `passthrough` plus an explicit unknown-key sweep, NOT `.strict()`.
   *
   * `.strict()` rejects during the shape parse, which runs BEFORE any
   * refinement — so an `isPrimary` key would be answered "Unrecognized key(s)"
   * and the named answer below would never run. Sweeping the keys here is what
   * puts the specific answer in front of the generic one, and the generic one
   * is still produced for everything unnamed, so nothing is passed through in
   * practice.
   */
  .passthrough()
  .superRefine((value, ctx) => {
    const body = value as Record<string, unknown>;

    for (const key of Object.keys(body)) {
      if ((DECLARED_KEYS as readonly string[]).includes(key)) continue;

      const named = MISDIRECTED_KEYS[key];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: named ?? `Unrecognized key: ${key}`,
        path: [key],
      });
    }

    // Forbidden FIRST, so a reason another domain owns gets the answer that
    // says which domain, rather than the membership refusal it would also fail.
    const reason = String(body.reason);
    if (SECONDARY_CLASSIFICATION_FORBIDDEN_REASONS.includes(reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `“${reason}” may never justify a secondary classification: another domain owns it. ` +
          'Filing a product under a category to achieve it would be exactly the fake category ' +
          'ADR 0007 D3 refuses.',
        path: ['reason'],
      });
    } else if (!(REASON_VALUES as readonly string[]).includes(reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Not a reason a secondary classification may cite. Expected one of: ${REASON_VALUES.join(', ')}.`,
        path: ['reason'],
      });
    }
  });
