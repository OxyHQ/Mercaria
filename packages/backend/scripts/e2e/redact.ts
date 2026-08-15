/**
 * Redaction for the #69 real-store evidence collector.
 *
 * The evidence this harness writes is meant to be pasted into an issue comment,
 * so a credential reaching it is not a tidiness problem — it is a disclosure. The
 * defence is TWO layers that fail differently, the posture
 * `services/payments/redact.ts` and `checkout-payment.service.ts` already take:
 *
 *  1. **An ALLOW-list projection.** Every observation is built field by field by
 *     the collector; there is no "record the response" path and no property bag.
 *     A field nobody named is absent rather than filtered, so a provider adding
 *     one cannot carry it in. That is the layer that catches what nobody thought
 *     about.
 *  2. **A tripwire SCAN of the finished artefact**, here. It catches the other
 *     case: a value that reached an allow-listed field anyway — inside an error
 *     string, a URL's query, a stack frame — which the projection cannot see
 *     because the field itself is legitimate.
 *
 * Both REFUSE rather than filtering. A secret that should not exist in the
 * artefact is a defect in whatever composed it, and quietly stripping it ships
 * that defect: the next field is the one that gets through.
 *
 * ## Why a registry of the run's OWN secrets, and not only patterns
 *
 * A pattern scan knows `mck_`, `shpat_` and `ck_`. It does not know the
 * consumer secret this particular run was handed, which is a bare hex-ish blob
 * with no prefix and is exactly what a WooCommerce site issues. So the run
 * registers every secret VALUE it holds, and the scan reports the LABEL it was
 * registered under — never the value, because a leak report that quotes the
 * secret is a second copy of it.
 *
 * ## The vacuity floor
 *
 * A scanner that read nothing reports the same clean result as one that read a
 * clean artefact, and a redactor handed an empty object produces flawless
 * output. Every scan therefore carries counters ({@link ScanReport}) and
 * {@link assertScanWasNotVacuous} refuses a report that examined no characters
 * or held no registered secrets. `selfTest()` runs the whole thing over a
 * fixture carrying a known secret BESIDE a known-innocent value and asserts both
 * directions — the secret is caught, the innocent value survives — so a scanner
 * that matched everything and one that matched nothing both fail it.
 */

/** Shortest value the registry will accept. */
const MIN_REGISTERABLE_SECRET_LENGTH = 8;

/** Characters of an identifier kept by {@link redactIdentifier}. */
const IDENTIFIER_TAIL_LENGTH = 4;

/**
 * Credential SHAPES that must never appear in evidence, whatever the run
 * happens to hold. Independent of the registry: this half catches a secret the
 * run never knew it had — a channel key minted mid-run, a token echoed by a
 * platform, a `Set-Cookie` in a captured header.
 *
 * Each entry names what it is looking for, because a refusal has to tell an
 * operator which composition to fix.
 */
const FORBIDDEN_SHAPES: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'mercaria channel key (mck_…)', pattern: /\bmck_[A-Za-z0-9_-]{8,}/g },
  { label: 'shopify access token (shpat_/shpca_/shppa_)', pattern: /\bshp(at|ca|pa)_[A-Za-z0-9]{8,}/g },
  { label: 'woocommerce consumer key (ck_…)', pattern: /\bck_[0-9a-f]{16,}/gi },
  { label: 'woocommerce consumer secret (cs_…)', pattern: /\bcs_[0-9a-f]{16,}/gi },
  { label: 'stripe secret/webhook key (sk_/rk_/whsec_)', pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/g },
  // The Shopify OAuth CALLBACK, which is exactly what a connection observation
  // captured right after a connect can carry. `shpat_` covers the token the code
  // is exchanged FOR; the code itself, and the `hmac` that authenticates the
  // callback, have no prefix and would otherwise pass. Reported by the Shopify
  // driver, which captures state at that precise moment.
  { label: 'oauth authorization code / callback hmac query parameter', pattern: /\b(code|hmac)=[A-Za-z0-9._-]{16,}/gi },
  { label: 'guest session token (mgs_/mgx_/mgp_)', pattern: /\bmg[sxp]_[A-Za-z0-9_-]{8,}/g },
  { label: 'HTTP basic-auth userinfo in a URL', pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { label: 'Authorization header value', pattern: /\bauthorization"?\s*[:=]\s*"?\s*(bearer|basic)\s+\S+/gi },
  { label: 'consumer_key/consumer_secret query parameter', pattern: /\bconsumer_(key|secret)=[^&"'\s]+/gi },
  { label: 'email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

/** One thing the scan found. Carries the LABEL and never the matched text. */
export interface SecretLeak {
  /** What was found — a registry label or a forbidden-shape label. */
  readonly label: string;
  /** Which layer found it. */
  readonly source: 'registered_value' | 'forbidden_shape';
  /** How many times it occurred. A count is safe; the text is not. */
  readonly occurrences: number;
}

/** What one scan actually examined — the vacuity floor's evidence. */
export interface ScanReport {
  /** Characters of serialized artefact the scan read. */
  readonly charactersScanned: number;
  /** Registered secret values the scan compared against. */
  readonly registeredSecrets: number;
  /** Forbidden shapes the scan compared against. */
  readonly shapesChecked: number;
  /** What it found. Empty is the expected result. */
  readonly leaks: readonly SecretLeak[];
}

/** Thrown when an artefact would have carried a credential. */
export class EvidenceRedactionError extends Error {
  constructor(readonly leaks: readonly SecretLeak[]) {
    super(
      `Refusing to write evidence: ${leaks.length} credential(s) present — ` +
        leaks.map((l) => `${l.label} x${l.occurrences}`).join('; '),
    );
    this.name = 'EvidenceRedactionError';
  }
}

/**
 * The secret values ONE run holds.
 *
 * Registration is deliberately noisy about what it will not protect: a value
 * shorter than {@link MIN_REGISTERABLE_SECRET_LENGTH} is refused rather than
 * accepted-and-ignored, because a registry that silently declines to watch
 * something is a guarantee nobody can read off the code.
 */
export class SecretRegistry {
  private readonly values = new Map<string, string>();

  /**
   * Watch `value` under `label`. Idempotent per label; re-registering the same
   * label with a different value REPLACES it (a rotated key is still one
   * secret), which is why the label rather than the value is the key.
   */
  register(label: string, value: string): void {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error(`SecretRegistry: refusing to register an empty value for "${label}"`);
    }
    if (trimmed.length < MIN_REGISTERABLE_SECRET_LENGTH) {
      throw new Error(
        `SecretRegistry: "${label}" is ${trimmed.length} characters, below the ` +
          `${MIN_REGISTERABLE_SECRET_LENGTH}-character floor. A value that short matches ` +
          'incidental text, so watching it would make every scan report a leak. Refused ' +
          'rather than skipped: a silently unwatched secret is worse than a loud refusal.',
      );
    }
    this.values.set(label, trimmed);
  }

  /** How many secrets are watched. The vacuity floor reads this. */
  get size(): number {
    return this.values.size;
  }

  /** The labels being watched. Never the values. */
  labels(): string[] {
    return [...this.values.keys()].sort();
  }

  /**
   * Read `text` for every registered value and every forbidden shape.
   *
   * Returns rather than throws so a caller can inspect the report; the write
   * path uses {@link assertNoSecrets}, which throws.
   */
  scan(text: string): ScanReport {
    const leaks: SecretLeak[] = [];

    for (const [label, value] of this.values) {
      const occurrences = countOccurrences(text, value);
      if (occurrences > 0) {
        leaks.push({ label, source: 'registered_value', occurrences });
      }
    }

    for (const { label, pattern } of FORBIDDEN_SHAPES) {
      // Each entry is a module-level RegExp with /g, so lastIndex must not be
      // carried between scans — a stale lastIndex silently skips the head of
      // the next artefact, which reads as clean.
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        leaks.push({ label, source: 'forbidden_shape', occurrences: matches.length });
      }
    }

    return {
      charactersScanned: text.length,
      registeredSecrets: this.values.size,
      shapesChecked: FORBIDDEN_SHAPES.length,
      leaks,
    };
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Refuse a scan that cannot have measured anything.
 *
 * "No leaks" and "read nothing" are the same output, and the second is what a
 * mis-wired collector produces — an empty artefact, a registry nobody
 * populated, a scan handed `undefined`. Every one of those is caught here
 * instead of being written out as a clean bill of health.
 */
export function assertScanWasNotVacuous(report: ScanReport): void {
  if (report.charactersScanned === 0) {
    throw new Error(
      'Redaction scan examined ZERO characters. A clean result over an empty artefact ' +
        'is indistinguishable from a clean artefact; refusing to treat it as evidence.',
    );
  }
  if (report.registeredSecrets === 0) {
    throw new Error(
      'Redaction scan ran with an EMPTY secret registry. The shape patterns alone cannot ' +
        'see this run\'s own consumer secret, which carries no prefix. Register the run\'s ' +
        'credentials before writing evidence.',
    );
  }
  if (report.shapesChecked === 0) {
    throw new Error('Redaction scan ran with no forbidden shapes — the second layer is missing.');
  }
}

/**
 * Scan `text` and throw when anything was found or when the scan was vacuous.
 * This is the function every write path calls.
 */
export function assertNoSecrets(registry: SecretRegistry, text: string): ScanReport {
  const report = registry.scan(text);
  assertScanWasNotVacuous(report);
  if (report.leaks.length > 0) {
    throw new EvidenceRedactionError(report.leaks);
  }
  return report;
}

/**
 * Reduce an identifier to its last four characters, the form §5 of the runbook
 * asks for. `null`/`undefined` stay absent rather than becoming the string
 * "null", so "we did not observe this" and "it was empty" stay distinguishable.
 */
export function redactIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return '';
  if (text.length <= IDENTIFIER_TAIL_LENGTH) {
    // Short enough that the tail IS the value; say so rather than implying a
    // truncation that did not happen.
    return `<${text.length}ch>`;
  }
  return `…${text.slice(-IDENTIFIER_TAIL_LENGTH)}`;
}

/**
 * Reduce a URL to scheme + host, dropping path, query and any userinfo.
 *
 * A WooCommerce feed URL carries its consumer key in the query (the reason
 * `feed_url` is a PROTECTED column in the feed importer), and a site's own host
 * is what an operator needs in order to know which store an observation came
 * from. An unparseable value is reported as such rather than passed through.
 */
export function redactUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Reduce a provider error string to something recordable.
 *
 * The runbook asks for `sync_runs.error` verbatim, and a provider error is
 * exactly where a URL with credentials in its query ends up. Query strings are
 * stripped and userinfo removed BEFORE the value reaches the artefact; whatever
 * survives still goes through {@link assertNoSecrets}, so this is a narrowing
 * rather than the guarantee.
 */
export function redactErrorText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<userinfo-removed>@')
    .replace(/(\?|&)(consumer_key|consumer_secret|access_token|token|key|secret)=[^&\s"']*/gi, '$1$2=<redacted>')
    .slice(0, 600);
}

/**
 * Prove the redactor works, in both directions, before anything is written.
 *
 * A one-directional control is the trap: a scanner that matched EVERYTHING
 * would pass "the secret was caught" and is useless. So the fixture carries a
 * known secret AND a known-innocent value that must SURVIVE, and the assertions
 * are that the first is reported and the second is not. Called from the
 * collector's constructor, so it cannot be forgotten.
 *
 * @returns the two reports, so a caller can print what the control measured
 *          rather than merely that it passed.
 */
export function selfTest(): { readonly caught: ScanReport; readonly clean: ScanReport } {
  const registry = new SecretRegistry();
  const secret = 'cs_selftest_0123456789abcdef0123456789abcdef';
  const innocentIdentifier = 'sync-run-7f3a9c2e';
  registry.register('self-test consumer secret', secret);

  // --- Direction 1: the secret IS caught, wherever it hides -----------------
  const contaminated = JSON.stringify({
    scenario: 'W1',
    syncRunId: innocentIdentifier,
    error: `GET https://shop.example/wp-json/wc/v3/products?consumer_secret=${secret} failed`,
  });
  const caught = registry.scan(contaminated);
  const byRegistry = caught.leaks.filter((l) => l.source === 'registered_value');
  if (byRegistry.length !== 1) {
    throw new Error(
      `Redaction self-test FAILED: the registered secret was not caught ` +
        `(${byRegistry.length} registry leaks reported). The collector must not run.`,
    );
  }
  if (!caught.leaks.some((l) => l.source === 'forbidden_shape')) {
    throw new Error(
      'Redaction self-test FAILED: the forbidden-shape layer did not fire on a ' +
        '`consumer_secret=` query parameter. The second layer is inert.',
    );
  }
  if (caught.charactersScanned !== contaminated.length) {
    throw new Error(
      `Redaction self-test FAILED: scanned ${caught.charactersScanned} of ` +
        `${contaminated.length} characters — the scan did not read the whole artefact.`,
    );
  }

  // --- Direction 2: an innocent artefact SURVIVES ---------------------------
  // Without this, a scanner that reported every input as a leak would pass
  // direction 1 and be indistinguishable from a working one.
  const innocent = JSON.stringify({
    scenario: 'W1',
    syncRunId: redactIdentifier(innocentIdentifier),
    site: redactUrl('https://shop.example/wp-json/wc/v3/products?consumer_secret=' + secret),
    counts: { created: 12, updated: 0, skipped: 0, failed: 0 },
  });
  const clean = registry.scan(innocent);
  if (clean.leaks.length !== 0) {
    throw new Error(
      `Redaction self-test FAILED: a clean artefact was reported as leaking ` +
        `(${clean.leaks.map((l) => l.label).join(', ')}). A scanner that flags everything ` +
        'proves nothing about one that flags a real secret.',
    );
  }
  if (clean.charactersScanned === 0) {
    throw new Error('Redaction self-test FAILED: the clean-direction scan read nothing.');
  }

  // --- The helpers themselves ----------------------------------------------
  if (redactIdentifier('abcdefghij') !== '…ghij') {
    throw new Error('Redaction self-test FAILED: redactIdentifier did not truncate to 4.');
  }
  if (redactUrl('https://u:p@shop.example/a?b=c') !== 'https://shop.example') {
    throw new Error('Redaction self-test FAILED: redactUrl kept path, query or userinfo.');
  }

  return { caught, clean };
}
