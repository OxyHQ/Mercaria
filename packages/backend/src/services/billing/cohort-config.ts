import { isLiveEntityId } from '@oxy.so/db';
import { z } from 'zod';

const id = z.string().min(1).max(200);
export const billingCohortSchema = z.object({
  merchantId: id, applicationId: id,
  environment: z.enum(['development', 'staging', 'production']),
  platformAccountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  livemode: z.boolean(), storeIds: z.array(z.string().refine(isLiveEntityId, 'Must be a valid store id')).min(1).max(1000),
}).strict().refine((v) => v.livemode === (v.environment === 'production'));
export type BillingCohort = z.infer<typeof billingCohortSchema>;

/** Pure configuration boundary; never imports config, SDK clients or repositories. */
export function parseBillingCohort(raw: string): BillingCohort | undefined {
  if (!raw) return undefined;
  try { return billingCohortSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Invalid merchant billing cohort configuration.'); }
}
