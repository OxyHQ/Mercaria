/**
 * Reading a challenge back off the merchant's own infrastructure — the DNS and
 * HTTP halves of #83's site proofs, and the file its SSRF defence lives in.
 *
 * ## The token is never taken from the request
 *
 * For all three site methods the server holds the expected token digest and
 * goes LOOKING for it at the challenge's own subject. Nothing a caller sends
 * is compared against anything: the claimant asks "check my domain now", and
 * the answer comes from a DNS zone or an HTTPS response. That is what makes a
 * stolen token useless — publishing merchant A's token on your own host proves
 * nothing, because your claim's challenge carries a different digest and names
 * a different subject.
 *
 * ## SSRF, and why there is no hand-rolled URL check here
 *
 * `safeFetch` from `@oxyhq/core/server` is the whole defence, exactly as the
 * WooCommerce transport uses it: every hop — including each redirect — is
 * validated against the private/link-local/metadata denylist with a real DNS
 * resolution, and the TCP connection is PINNED to the validated address, which
 * closes the DNS-rebind window a check-then-connect would leave open. Two
 * things are added on top, both because a merchant-supplied host is fully
 * attacker-influenced:
 *
 *  - **HTTPS only.** A verification fetched over cleartext can be forged by
 *    anyone on the path, which would make the proof worth nothing rather than
 *    merely insecure.
 *  - **A bounded read.** The response body is read to a hard cap and the
 *    stream destroyed, so a merchant host cannot stream a gigabyte at the
 *    verifier. `safeFetch` hands the caller the stream and says the caller
 *    owns it; this is that ownership.
 *
 * Redirects are followed (`safeFetch` re-validates each hop) because a real
 * site commonly redirects apex → www; they are bounded by the library.
 *
 * ## DNS is resolved, never fetched
 *
 * A TXT lookup makes no HTTP request, reaches no URL, and returns records
 * rather than a body, so it is outside the SSRF surface entirely — there is no
 * address for a rebind to point at. The bounds that matter for it are a
 * timeout and a cap on how many records are inspected.
 */

import { Resolver } from 'node:dns/promises';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import {
  CLAIM_DNS_RECORD_LABEL,
  CLAIM_META_TAG_NAME,
  CLAIM_WELL_KNOWN_PATH,
} from './challenge-token.js';
import { log } from '../../lib/logger.js';

/** Hard cap on the buffered body of a verification fetch. A proof is ~50 bytes. */
const MAX_BODY_BYTES = 256 * 1024;

/** Time-to-first-byte deadline for a verification fetch. */
const HTTP_HEADERS_TIMEOUT_MS = 8_000;

/** How long a TXT lookup may take before it is abandoned. */
const DNS_TIMEOUT_MS = 5_000;

/** Cap on TXT records inspected — a zone with thousands is not a proof, it is a flood. */
const MAX_TXT_RECORDS = 50;

/** Why a site proof was not found. Never echoed verbatim to a client. */
export type SiteVerificationFailure =
  | 'not_found'
  | 'unreachable'
  | 'blocked_address'
  | 'too_large'
  | 'bad_status';

/**
 * The outcome of one site check: `null` when the proof was found, a failure
 * code otherwise.
 *
 * A bare union rather than an `{ok, failure}` wrapper, because a wrapper's
 * discriminant would be a boolean and this package compiles with
 * `strict: false` — under which a boolean discriminant does not narrow, so the
 * wrapper would need a cast to read its own field. Absence-as-success needs no
 * narrowing at all.
 */
export type SiteVerificationOutcome = SiteVerificationFailure | null;

/** The DNS name a `dns_txt` challenge is published at, for a given domain. */
export function claimDnsRecordName(domain: string): string {
  return `${CLAIM_DNS_RECORD_LABEL}.${domain}`;
}

/** The exact TXT value a claimant must publish. */
export function claimDnsRecordValue(token: string): string {
  return `mercaria-merchant-verification=${token}`;
}

/** The URL a `well_known_file` challenge is served from. */
export function claimWellKnownUrl(domain: string): string {
  return `https://${domain}${CLAIM_WELL_KNOWN_PATH}`;
}

/** The site root a `meta_tag` challenge is read from. */
export function claimSiteRootUrl(domain: string): string {
  return `https://${domain}/`;
}

/**
 * Look for the expected TXT value under `_mercaria-challenge.<domain>`.
 *
 * A dedicated `Resolver` with its own timeout rather than the process-wide
 * `dns.resolveTxt`: the default resolver has no deadline a caller can set, and
 * a merchant nameserver that never answers would hold a request open for as
 * long as the OS allows.
 *
 * Multi-string TXT records are JOINED before comparison, because a 255-byte
 * chunk boundary is a transport detail of the DNS wire format and several
 * providers split long values across chunks without telling anybody.
 */
export async function verifyDnsTxtChallenge(params: {
  domain: string;
  expectedValue: string;
}): Promise<SiteVerificationOutcome> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  let records: string[][];
  try {
    records = await resolver.resolveTxt(claimDnsRecordName(params.domain));
  } catch (err) {
    // NXDOMAIN and "no records" are the ordinary answer for a challenge that
    // has not been published yet, and are not distinguishable from a broken
    // zone without reading a driver-specific code — both mean "not proven".
    log.general.debug(
      { err, domain: params.domain },
      '[MerchantClaim] DNS TXT lookup did not answer',
    );
    return 'not_found';
  }

  for (const chunks of records.slice(0, MAX_TXT_RECORDS)) {
    if (chunks.join('').trim() === params.expectedValue) {
      return null;
    }
  }
  return 'not_found';
}

/**
 * Fetch a merchant URL through the SSRF-safe transport and return a bounded
 * prefix of its body.
 *
 * The caller owns `safeFetch`'s stream; this destroys it in every branch,
 * including the one where the cap is hit, so a hostile host cannot keep the
 * socket alive by continuing to write.
 */
async function fetchBoundedBody(
  url: string,
): Promise<{ body: string | null; failure: SiteVerificationOutcome }> {
  let result;
  try {
    result = await safeFetch(url, {
      method: 'GET',
      headersTimeoutMs: HTTP_HEADERS_TIMEOUT_MS,
      headers: { accept: 'text/plain, text/html;q=0.9, */*;q=0.1' },
    });
  } catch (err) {
    if (err instanceof SsrfRejection) {
      // A merchant "domain" resolving into a private range is not a transport
      // failure to retry — it is the check working.
      log.general.warn({ url }, '[MerchantClaim] verification target refused by the SSRF guard');
      return { body: null, failure: 'blocked_address' };
    }
    if (err instanceof UpstreamError) {
      return { body: null, failure: 'unreachable' };
    }
    log.general.debug({ err, url }, '[MerchantClaim] verification fetch failed');
    return { body: null, failure: 'unreachable' };
  }

  const { response, status } = result;
  if (status !== 200) {
    response.destroy();
    return { body: null, failure: 'bad_status' };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        response.destroy();
        return { body: null, failure: 'too_large' };
      }
      chunks.push(buf);
    }
  } catch (err) {
    response.destroy();
    log.general.debug({ err, url }, '[MerchantClaim] verification body read failed');
    return { body: null, failure: 'unreachable' };
  }

  return { body: Buffer.concat(chunks).toString('utf8'), failure: null };
}

/**
 * Look for the token in `/.well-known/mercaria-merchant-verification.txt`.
 *
 * The file must contain the token and nothing else that matters — the body is
 * trimmed and compared whole, so a page that merely MENTIONS the token (a
 * forum post, a support article, an error page echoing the URL) is not a
 * proof. An equality is the difference between "this host serves my file" and
 * "this host contains my string somewhere".
 */
export async function verifyWellKnownFileChallenge(params: {
  domain: string;
  expectedToken: string;
}): Promise<SiteVerificationOutcome> {
  const fetched = await fetchBoundedBody(claimWellKnownUrl(params.domain));
  if (fetched.body === null) return fetched.failure;
  return fetched.body.trim() === params.expectedToken ? null : 'not_found';
}

/**
 * Look for `<meta name="mercaria-merchant-verification" content="…">` on the
 * site root.
 *
 * Parsed with a bounded regular expression rather than an HTML parser: the tag
 * has a fixed name, the content is a token with a known alphabet, and adding
 * an HTML parser to the dependency tree to read one attribute would be a
 * larger attack surface than the thing it reads. Both attribute orders are
 * accepted because real templating engines emit both, and quotes may be single
 * or double for the same reason.
 */
export async function verifyMetaTagChallenge(params: {
  domain: string;
  expectedToken: string;
}): Promise<SiteVerificationOutcome> {
  const fetched = await fetchBoundedBody(claimSiteRootUrl(params.domain));
  if (fetched.body === null) return fetched.failure;
  return metaTagCarriesToken(fetched.body, params.expectedToken) ? null : 'not_found';
}

/**
 * Whether an HTML document carries the verification meta tag with this exact
 * token. Exported so it can be tested without a network — the parsing is the
 * part with edge cases, and the fetch is `safeFetch`'s job, already tested
 * where it lives.
 */
export function metaTagCarriesToken(html: string, expectedToken: string): boolean {
  // The token alphabet is base64url plus the `mcc_` prefix, so a literal
  // comparison against the captured group is exact; the pattern only has to
  // find the attribute pair, in either order.
  const pattern = new RegExp(
    `<meta\\s+[^>]*?(?:name=["']${CLAIM_META_TAG_NAME}["']\\s+[^>]*?content=["']([^"']*)["']` +
      `|content=["']([^"']*)["']\\s+[^>]*?name=["']${CLAIM_META_TAG_NAME}["'])`,
    'gi',
  );
  for (const match of html.matchAll(pattern)) {
    const content = match[1] ?? match[2];
    if (content !== undefined && content.trim() === expectedToken) {
      return true;
    }
  }
  return false;
}
