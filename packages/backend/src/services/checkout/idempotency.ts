import type Redis from 'ioredis';

const PENDING = '__pending__';
/** Recognize the prior deployment's marker during rolling upgrades too. */
export function isPendingCheckoutClaim(value: string): boolean {
  return value === PENDING || value.startsWith(`${PENDING}:`);
}
export function checkoutClaimToken(owner: string): string {
  return `${PENDING}:${owner}`;
}

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
const COMPLETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

/** Only this request may release its claim, never an expired claim's successor. */
export async function releaseCheckoutClaim(
  redis: Pick<Redis, 'eval'>,
  key: string,
  token: string,
): Promise<boolean> {
  return (await redis.eval(RELEASE, 1, key, token)) === 1;
}

/** A late completion cannot replace a newer pending claim or its completed group. */
export async function completeCheckoutClaim(
  redis: Pick<Redis, 'eval'>,
  key: string,
  token: string,
  groupId: string,
  ttlMs: number,
): Promise<boolean> {
  return (await redis.eval(COMPLETE, 1, key, token, groupId, ttlMs)) === 1;
}
