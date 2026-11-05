import { isLoopbackOrigin } from '@oxy.so/contracts/client';
import type { createCommerceCredential } from '../stores/commerce-credential';
import { referralMetadata } from '../stores/referral-credential-store';

/** Temporary, attribution-only cookie read. Never receives an Oxy, guest or portal credential. */
export async function migrateLegacyReferral(
  baseURL: string,
  credential: ReturnType<typeof createCommerceCredential>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(baseURL);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (!['https://api.mercaria.co', 'https://staging-api.mercaria.co'].includes(url.origin) &&
      !isLoopbackOrigin(url.origin))
  ) {
    throw new Error('Referral migration requires the configured Mercaria API origin');
  }
  // The backend enforces the same finite migration window and the historical issuance cutoff.
  if (Date.now() >= Date.parse('2027-01-23T15:00:46Z')) return;
  await credential.ready;
  await credential.settled();
  if (credential.current().cleared || !credential.current().storageAvailable) return;
  const initial = credential.snapshot();
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Mercaria-Referral-Migration': 'header-v1',
  });
  const init: RequestInit = {
    method: 'POST',
    body: '{}',
    headers,
    credentials: 'include',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  };
  // Retry a lost ACK only for the same already-durable historical carrier.
  if (initial.token) {
    const metadata = referralMetadata(initial.token);
    if (
      metadata &&
      Number(metadata.generation) <= Date.parse('2026-10-25T15:00:46Z') &&
      (await credential.persisted(initial.revision))
    ) {
      const ackHeaders = new Headers(headers);
      ackHeaders.set('X-Mercaria-Referral-State', initial.token);
      const ack = await fetcher(`${url.origin}/referrals/legacy-cookie-ack`, {
        ...init,
        headers: ackHeaders,
      });
      await ack.body?.cancel();
    }
    return;
  }
  const response = await fetcher(`${url.origin}/referrals/legacy-cookie-exchange`, init);
  const token = response.headers.get('X-Mercaria-Referral-State');
  const expiry = response.headers.get('X-Mercaria-Referral-Expires-At');
  await response.body?.cancel();
  if (!response.ok || !token || !expiry) return;
  const metadata = referralMetadata(token);
  if (!metadata || Date.parse(metadata.expiry) !== Date.parse(expiry)) return;
  initial.accept(token, expiry, metadata.generation);
  const revision = credential.store.getState().revision;
  if (credential.current().token !== token || !(await credential.persisted(revision))) return;
  // ACK only after durable storage; failures leave the legacy cookie available for retry.
  const ackHeaders = new Headers(headers);
  ackHeaders.set('X-Mercaria-Referral-State', token);
  const ack = await fetcher(`${url.origin}/referrals/legacy-cookie-ack`, {
    ...init,
    headers: ackHeaders,
  });
  await ack.body?.cancel();
}
