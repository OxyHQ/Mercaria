import type Redis from 'ioredis';

const PENDING = '__pending__';
/** Reader-first rollout: recognize owned claims before any replica writes them. */
export function isPendingCheckoutClaim(value: string): boolean {
  return value === PENDING || value.startsWith(`${PENDING}:`);
}

const COMPLETE_LEGACY = `
if redis.call('GET', KEYS[1]) == '${PENDING}' then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`;

/**
 * Phase one still writes legacy claims. Its late completion must never replace
 * a future owned claim or a completed group. This cannot distinguish two legacy
 * owners; selective refusal cleanup is deferred until every replica understands
 * owned claims and writes/completes them with its unique token.
 */
export async function completeLegacyCheckoutClaim(
  redis: Pick<Redis, 'eval'>,
  key: string,
  groupId: string,
  ttlMs: number,
): Promise<boolean> {
  return (await redis.eval(COMPLETE_LEGACY, 1, key, groupId, ttlMs)) === 1;
}
