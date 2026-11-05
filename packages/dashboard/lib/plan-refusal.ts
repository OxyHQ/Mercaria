import axios from 'axios';

/**
 * What a paid tool's write was refused for, when the store's PLAN refused it.
 *
 * `capability` — the plan does not include the tool (`PLAN_CAPABILITY_REQUIRED`);
 * `limit` — it does, and the action would pass the plan's limit
 * (`PLAN_LIMIT_REACHED`). Anything else is not a plan refusal and answers
 * `null`, so a screen falls back to its ordinary error.
 */
export type PlanRefusal = 'capability' | 'limit';

export function planRefusalOf(error: unknown): PlanRefusal | null {
  if (!axios.isAxiosError(error)) return null;
  const code = (error.response?.data as { error?: unknown } | undefined)?.error;
  if (code === 'PLAN_CAPABILITY_REQUIRED') return 'capability';
  if (code === 'PLAN_LIMIT_REACHED') return 'limit';
  return null;
}
