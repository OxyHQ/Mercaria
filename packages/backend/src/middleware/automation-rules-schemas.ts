/**
 * Request schemas for automation rules (#89, `automation_rules`).
 *
 * `.strict()` everywhere: a field the schema does not declare is REFUSED, so a
 * caller cannot believe it asked a rule for something (another store, a status
 * nobody listed) that the server then silently dropped. The closed sets are the
 * shared-types tuples the table's CHECKs are rendered from. The cross-field
 * rules (which action follows which trigger, which fields belong to which
 * trigger) are the service's, where the stored rule is known on an edit.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  AUTOMATION_RULE_ACTIONS,
  AUTOMATION_RULE_NAME_MAX_LENGTH,
  AUTOMATION_RULE_STOCK_THRESHOLD_MAX,
  AUTOMATION_RULE_TAG_MAX_LENGTH,
  AUTOMATION_RULE_TRIGGERS,
  assertSafeMoneyAmount,
  type AutomationRuleAction,
  type AutomationRuleTrigger,
  type CurrencyCode,
} from '@mercaria/shared-types';

const TRIGGERS = AUTOMATION_RULE_TRIGGERS as readonly [
  AutomationRuleTrigger,
  ...AutomationRuleTrigger[],
];
const ACTIONS = AUTOMATION_RULE_ACTIONS as readonly [
  AutomationRuleAction,
  ...AutomationRuleAction[],
];
const CURRENCIES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];

const name = z.string().trim().min(1).max(AUTOMATION_RULE_NAME_MAX_LENGTH);
const stockThreshold = z.number().int().min(0).max(AUTOMATION_RULE_STOCK_THRESHOLD_MAX).nullable();
const tag = z.string().trim().max(AUTOMATION_RULE_TAG_MAX_LENGTH).nullable();
const minOrderTotal = z
  .object({
    amount: z
      .number()
      .int()
      .nonnegative()
      .superRefine((value, ctx) => {
        try {
          assertSafeMoneyAmount(value, 'automationRules.minOrderTotal');
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    currency: z.enum(CURRENCIES),
  })
  .strict()
  .nullable();

/** `POST /admin/stores/:storeId/automations`. */
export const createAutomationRuleSchema = z
  .object({
    name,
    enabled: z.boolean().optional(),
    trigger: z.enum(TRIGGERS),
    action: z.enum(ACTIONS),
    stockThreshold: stockThreshold.optional(),
    tag: tag.optional(),
    minOrderTotal: minOrderTotal.optional(),
    republishWhenRestocked: z.boolean().optional(),
  })
  .strict();

/** `PATCH /admin/stores/:storeId/automations/:id`. No trigger, no action: those are fixed. */
export const updateAutomationRuleSchema = z
  .object({
    name: name.optional(),
    enabled: z.boolean().optional(),
    stockThreshold: stockThreshold.optional(),
    tag: tag.optional(),
    minOrderTotal: minOrderTotal.optional(),
    republishWhenRestocked: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

/** `GET /admin/stores/:storeId/automations/runs`. */
export const listAutomationRunsQuerySchema = z
  .object({
    ruleId: z.string().trim().min(1).max(64).optional(),
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
