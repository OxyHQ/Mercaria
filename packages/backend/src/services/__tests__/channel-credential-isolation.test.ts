/**
 * The walls around the channel CREDENTIAL surface (#658).
 *
 * `channel-isolation.test.ts` walls the channels SERVICE layer and says, in its
 * own docblock, that the credential surface needs "a different gate about
 * different walls, and it does not exist yet". This is that gate.
 *
 * ## Why this population is DERIVED BY CONTENT rather than by a path pattern
 *
 * #658 suggests an anchored PATH pattern plus
 * `assertNothingOutsideDomainPopulation`. That was measured and rejected: this
 * surface has no coherent path token. Its modules are spelled `channel-key`,
 * `channel-keys`, `channel-ingest-key`, `channelApiKey`, `channels-webhooks`,
 * `channels-schemas`, `connector-crypto`, `connector-sync`, `connectors/types`
 * and `merchant-claim-schemas`. A regex matching exactly those is a hand list in
 * regex clothing — the defect #460 is about, one level up.
 *
 * What the modules genuinely share is not a NAME, it is that their code can
 * reach a channel credential VALUE. So the population is a sweep of every
 * non-test module under `src/` keeping those whose comment-stripped source names
 * something in {@link CREDENTIAL_VOCABULARY}. A module that starts handling a
 * credential joins the population — and every wall below — with no edit here,
 * wherever somebody puts it.
 *
 * ## What that derivation found, which a hand list did not
 *
 * #658 names eight modules. The sweep finds **21**, and the six-module gap that
 * matters is a whole second rail: #83's `channel_key` claim method carries a
 * PLAINTEXT `mck_` from a request body through
 * `middleware/merchant-claim-schemas.ts` (`channelKey: z.string()`),
 * `controllers/merchant-claims.controller.ts` and
 * `services/merchant-claims/merchant-claim.service.ts` into
 * `platform-verification.ts`, which calls `verifyKey`. None of the four is named
 * in the issue. Neither is `lib/connector-crypto.ts` — the module the decryption
 * wall exists to constrain.
 *
 * Two modules the issue names are deliberately NOT here, both measured:
 *
 *  - `routes/channels-oauth.ts` holds an OAuth authorization `code` in a query
 *    string, which is what the protocol requires, and never touches a stored
 *    secret or a plaintext key — it hands the code to `connectAndVerify`, which
 *    IS in the population. It is not excused either: the sweep never reaches it,
 *    and an exemption a sweep cannot produce excuses nothing while reading like a
 *    decision (`docs/isolation-gates.md` §Exemptions, where three of six
 *    exemptions in another guard were structurally unmatchable).
 *  - `controllers/admin/channel-ingest.controller.ts` moves catalogue rows, not
 *    credentials.
 *
 * ## The comment stripping is load-bearing, and it is measured in BOTH directions
 *
 * Raw source puts 22 modules in the population and stripped source puts 21. The
 * one that leaves is `services/merchant-claims/challenge-token.ts`, whose only
 * mention is a docblock sentence citing `channel-key.service.verifyKey` — prose
 * about the credential, not a reach for one.
 *
 * The reverse bit is what made the vocabulary correct:
 * `controllers/channel-ingest-key.controller.ts` DROPPED OUT of a sweep keyed on
 * function symbols alone, because it names `requireChannelKey` only in its
 * docblock and holds the resolved credential in code as `req.channelKey`. A raw
 * sweep would have included it for the wrong reason and hidden the fact that the
 * vocabulary was short of a carrier.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SRC_ROOT,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';

/**
 * A channel credential value, in every spelling one travels under.
 *
 * Three kinds, and each was arrived at by measurement rather than by listing
 * what sounded secret:
 *
 *  - the FUNCTIONS a credential moves through (`encryptSecret`/`decryptSecret`,
 *    `generateKey`/`verifyKey`, `findVerificationCandidates`, the two envelope
 *    readers, and `requireChannelKey`);
 *  - the CARRIERS it rests in (`channelKey` — `req.channelKey`, the zod field and
 *    the service param are all one plaintext key; `VerifiedChannelKey`; and
 *    `ConnectorAuth`, whose own docblock says "already decrypted");
 *  - the FIELDS it arrives and is stored under (`consumerKey`/`consumerSecret`,
 *    the two ciphertext columns).
 *
 * `accessToken` is deliberately NOT here and its absence is the reason
 * `ConnectorAuth` is. Measured: `accessToken` appears in 12 non-test modules and
 * most of them are Oxy user tokens, eBay's OAuth and Awin's — a detector cannot
 * tell a legitimate value from its quarry when the word means two things. The
 * TYPE that carries a decrypted connector credential names exactly four modules,
 * and it is the precise instrument for the same fact.
 */
const CREDENTIAL_VOCABULARY =
  /\b(?:encryptSecret|decryptSecret|generateKey|verifyKey|findVerificationCandidates|findConnectionCredentials|findConnectionWebhookSecret|requireChannelKey|channelKey|VerifiedChannelKey|ConnectorAuth|consumerKey|consumerSecret|credentialsCiphertext|webhookSecretCiphertext)\b/;

/**
 * Source with comments removed — what every detector in this file scans.
 *
 * The `[^:]` guard is what keeps `https://` from eating the rest of a line. The
 * `guest-portal-isolation.test.ts` decision, for the same reason: these modules
 * DOCUMENT what they refuse to do in the credential vocabulary, and a raw scan
 * fails on the prose that proves the rule is understood.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A reader of one module's source, RELATIVE to `src/`. */
type SourceReader = (relative: string) => string;

const readSrcSource: SourceReader = (relative) => readFileSync(join(SRC_ROOT, relative), 'utf8');

/**
 * Every module that can reach a channel credential value.
 *
 * BOTH readers are injected, and that is what makes the positive controls below
 * measure this function rather than the disk.
 * `assertNothingOutsideDomainPopulation` is deliberately not used: its control
 * plants a directory ENTRY with no source behind it, so a content-derived
 * population cannot absorb the plant — `readFileSync` would throw on it — and a
 * control that cannot be absorbed proves nothing about a population that
 * contains everything.
 */
function credentialSurface(
  readDir: DirectoryReader = readSrcDirectory,
  readSource: SourceReader = readSrcSource,
): string[] {
  return walkOwnedDirectory('', readDir)
    .filter((relative) => CREDENTIAL_VOCABULARY.test(stripComments(readSource(relative))))
    .sort();
}

/**
 * A symbol only certain modules may reach, and the modules that may.
 *
 * The set is asserted EXACTLY, in both directions. An added reacher is the
 * violation; a REMOVED one is a stale allow-list, which is the half that rots
 * green — an entry naming a module that no longer reaches the symbol excuses
 * nothing while reading like a decision.
 */
interface Chokepoint {
  readonly symbol: string;
  readonly allowed: readonly string[];
  readonly why: string;
}

const CHOKEPOINTS: readonly Chokepoint[] = [
  {
    symbol: 'decryptSecret',
    allowed: [
      'lib/connector-crypto.ts',
      'routes/channels-webhooks.ts',
      'services/connector-sync.service.ts',
    ],
    why:
      'Who can turn a stored connector credential back into plaintext, answered by grepping one ' +
      'function name — the `decryptGuestPii` device. Two callers rather than one, and both are ' +
      'load-bearing: the webhook route decrypts a per-connection WooCommerce secret to verify a ' +
      'signature, and the sync service decrypts to call the provider. What the wall pins is the ' +
      'SET; a third module is the violation.',
  },
  {
    symbol: 'encryptSecret',
    allowed: ['lib/connector-crypto.ts', 'services/connector-sync.service.ts'],
    why:
      'One writer. A second module encrypting a credential is a second place deciding what gets ' +
      'stored under a connection, and the two disagree in the direction that stores a plaintext.',
  },
  {
    symbol: 'findVerificationCandidates',
    allowed: ['db/connectors/channelApiKeyRepository.ts', 'services/channel-key.service.ts'],
    why:
      "The ONE protected read of `channel_api_keys.hash`. The digest is irreversible and is a " +
      'PROTECTED column anyway, because handing it out hands over an offline oracle to test ' +
      'guessed keys against. Every other read in that repository goes through `publicColumns`, ' +
      'so this symbol is the greppable opt-in and its reader set is the wall.',
  },
  {
    symbol: 'generateKey',
    allowed: ['services/channel-key.service.ts', 'controllers/admin/channel-keys.controller.ts'],
    why:
      'The plaintext key exists in exactly one return value and is unrecoverable afterwards, so ' +
      '"returned to a client exactly once" is measurable as "minted from exactly one handler". A ' +
      'second caller is a second response body carrying a live credential.',
  },
] as const;

/**
 * A credential value appearing inside a LOG call's arguments.
 *
 * `keyId`, `connectionId`, `shopDomain`, `topic` and `provider` are real log
 * fields in this population and none of them may fire, which is why every
 * alternative is word-bounded: `\bkey\b` does not match `keyId`, because `I` is
 * a word character and the boundary fails.
 */
const CREDENTIAL_IN_LOG =
  /\b(?:raw|plaintext|secret|secrets|consumerKey|consumerSecret|accessToken|channelKey|apiKey|api_key|credential|credentials|ciphertext|hash|digest)\b/;

/**
 * A credential arriving in the URL — a path segment or a query parameter.
 *
 * A request BODY is deliberately not covered: the WooCommerce pair legitimately
 * arrives in one (`middleware/channels-schemas.ts`) and so does a claim's
 * `channelKey`. A URL is different in kind rather than in degree — it lands in
 * access logs, `Referer` headers and browser history, none of which is a place
 * anybody chose to store a credential. The presented ingest key rides a header
 * for exactly that reason (`middleware/channel-key-auth.ts`).
 */
const CREDENTIAL_IN_URL =
  /req\s*\.\s*(?:params|query)\s*\.\s*(?:key|apiKey|channelKey|secret|consumerKey|consumerSecret|accessToken|token|credential)\b|routeParam\(\s*req\s*,\s*['"](?:key|apiKey|channelKey|secret|consumerKey|consumerSecret|accessToken|token|credential)['"]\s*\)/;

/**
 * The argument text of every `log.<channel>.<level>(...)` call in a module.
 *
 * Paren-BALANCED rather than line-based, because most log calls in
 * `connector-sync.service.ts` put their arguments on following lines and a
 * single-line regex would report a clean zero over all of them — the newline
 * trap `docs/isolation-gates.md` records twice, where a smaller number is
 * indistinguishable from a cleaner tree.
 *
 * Quoted string LITERALS are removed from the result: a log message reading
 * `'Failed to generate channel key'` is prose, not a credential. Template
 * literals are KEPT, because `` `key=${raw}` `` is exactly the violation.
 */
function logCallArguments(code: string): string[] {
  const found: string[] = [];
  const opener = /\blog\s*\.\s*[A-Za-z]+\s*\.\s*[a-z]+\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(code)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < code.length && depth > 0) {
      const char = code[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    found.push(code.slice(start, index - 1).replace(/'[^']*'|"[^"]*"/g, ' '));
  }
  return found;
}

/** Read a module's stripped source, refusing one that has gone empty or moved. */
function readModule(relative: string): string {
  const source = readSrcSource(relative);
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  const stripped = stripComments(source);
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

describe('#658 — the channel credential surface: its population', () => {
  it('is derived from the whole tree, and the traversal reached it', () => {
    // The vacuity floor on the SWEEP, not on the population: a walk that reached
    // nothing yields an empty population, and every wall below is then satisfied
    // by having nothing to scan. Set well under today's 1,621 so an ordinary
    // week of new modules never touches it.
    const swept = walkOwnedDirectory('');
    expect(
      swept.length,
      'the whole-tree walk found almost nothing — it cannot report a credential module if it ' +
        'never reached one',
    ).toBeGreaterThanOrEqual(1400);

    // Floors PER SHAPE rather than one total. The six directories break
    // independently, and a single number lets one collapse to zero while the
    // others carry it.
    const surface = credentialSurface();
    const from = (prefix: string): number =>
      surface.filter((relative) => relative.startsWith(prefix)).length;
    expect(from('connectors/'), 'the provider adapters left the surface').toBeGreaterThanOrEqual(3);
    expect(from('controllers/'), 'the controller surface left').toBeGreaterThanOrEqual(4);
    expect(from('db/'), 'the repositories and the schema left').toBeGreaterThanOrEqual(4);
    expect(from('lib/'), 'the crypto chokepoint left the surface').toBeGreaterThanOrEqual(1);
    expect(from('middleware/'), 'the request schemas and the key auth left').toBeGreaterThanOrEqual(
      3,
    );
    expect(from('routes/'), 'the public credential routes left').toBeGreaterThanOrEqual(2);
    expect(from('services/'), 'the services holding a credential left').toBeGreaterThanOrEqual(4);
    expect(surface.length).toBeGreaterThanOrEqual(21);

    // Every member is a real file, so a listing that has started returning stale
    // names goes red rather than handing the walls paths that do not resolve.
    for (const relative of surface) {
      expect(
        statSync(join(SRC_ROOT, relative)).isFile(),
        `${relative} is in the credential surface but is not a file — did it move?`,
      ).toBe(true);
    }
  });

  it('contains the second rail #658 does not mention', () => {
    // #83's `channel_key` claim method carries a plaintext `mck_` through four
    // modules the issue's list omits. Named individually because "the sweep
    // found 21" would still hold if these four dropped out and four strangers
    // arrived.
    const surface = credentialSurface();
    for (const relative of [
      'middleware/merchant-claim-schemas.ts',
      'controllers/merchant-claims.controller.ts',
      'services/merchant-claims/merchant-claim.service.ts',
      'services/merchant-claims/platform-verification.ts',
      'lib/connector-crypto.ts',
      'controllers/channel-ingest-key.controller.ts',
    ]) {
      expect(surface, `${relative} left the credential surface`).toContain(relative);
    }
  });

  it('does not swallow modules of other domains', () => {
    // The clause that catches a population containing everything, and it does
    // not go through either injected reader — so it holds even when a
    // derivation ignores the readers it is handed, which is the case the
    // planted controls below cannot see.
    const surface = credentialSurface();
    const foreign = [
      'controllers/orders.controller.ts',
      'routes/cart.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ];
    expect(foreign.length, 'the foreign-module control is empty, so it cannot fail').toBeGreaterThan(
      2,
    );
    for (const other of foreign) {
      expect(
        statSync(join(SRC_ROOT, other)).isFile(),
        `${other} no longer exists, so excluding it from the population proves nothing`,
      ).toBe(true);
      expect(
        surface,
        `${other} belongs to another domain and is in the credential surface — the derivation ` +
          'has widened to swallow modules nobody reviewed',
      ).not.toContain(other);
    }
  });

  it('positive control: the derivation absorbs a credential module and refuses a clean one', () => {
    // Two plants through ONE derivation, which is what makes them measure the
    // population rather than the disk (#609: two spellings let a control pass
    // while the wall went vacuous).
    //
    // The GUILTY plant proves the content filter is live and that the walk
    // reaches a module nobody listed. The INNOCENT plant, in the same directory
    // on the same run, proves the filter is not simply admitting everything —
    // without it a derivation that returned the whole tree would satisfy the
    // first assertion perfectly.
    const guilty = 'services/planted-credential-reader.ts';
    const innocent = 'services/planted-ordinary-module.ts';
    const honest = credentialSurface();
    expect(honest, 'the guilty plant already exists on disk').not.toContain(guilty);
    expect(honest, 'the innocent plant already exists on disk').not.toContain(innocent);

    const seededDir: DirectoryReader = (relative) =>
      relative === 'services'
        ? [
            ...readSrcDirectory(relative),
            { name: 'planted-credential-reader.ts', isDirectory: () => false, isFile: () => true },
            { name: 'planted-ordinary-module.ts', isDirectory: () => false, isFile: () => true },
          ]
        : readSrcDirectory(relative);
    const seededSource: SourceReader = (relative) => {
      if (relative === guilty) {
        return "import { decryptSecret } from '../lib/connector-crypto.js';\nexport const read = decryptSecret;\n";
      }
      if (relative === innocent) {
        return 'export const total = (a: number, b: number): number => a + b;\n';
      }
      return readSrcSource(relative);
    };

    const seeded = credentialSurface(seededDir, seededSource);
    expect(
      seeded,
      'a planted module that reaches a credential was NOT absorbed by the derivation — either ' +
        'the walk cannot see a new module or the vocabulary matched nothing',
    ).toContain(guilty);
    expect(
      seeded,
      'a planted module that touches no credential WAS absorbed — the derivation is admitting ' +
        'every module, which makes every wall in this file vacuous',
    ).not.toContain(innocent);
  });
});

describe('#658 — the walls', () => {
  it('every chokepoint symbol is reachable from exactly the modules that may reach it', () => {
    const swept = walkOwnedDirectory('');
    expect(CHOKEPOINTS.length, 'the chokepoint table is empty').toBeGreaterThanOrEqual(4);
    for (const chokepoint of CHOKEPOINTS) {
      const pattern = new RegExp(`\\b${chokepoint.symbol}\\b`);
      const reachers = swept
        .filter((relative) => pattern.test(stripComments(readSrcSource(relative))))
        .sort();
      expect(
        reachers,
        `the set of modules reaching \`${chokepoint.symbol}\` has changed. ${chokepoint.why}`,
      ).toEqual([...chokepoint.allowed].sort());
      // An allow-list entry that no longer exists excuses nothing while reading
      // like a decision.
      for (const allowed of chokepoint.allowed) {
        expect(
          statSync(join(SRC_ROOT, allowed)).isFile(),
          `${allowed} is allowed to reach \`${chokepoint.symbol}\` but is not a file`,
        ).toBe(true);
      }
      expect(chokepoint.why.length, `${chokepoint.symbol} is walled with no reason`).toBeGreaterThan(
        60,
      );
    }
  });

  it('never puts a credential value in a log line', () => {
    let scanned = 0;
    for (const relative of credentialSurface()) {
      for (const args of logCallArguments(readModule(relative))) {
        scanned += 1;
        expect(
          CREDENTIAL_IN_LOG.test(args),
          `${relative} logs a credential value — a log line is the one place a secret outlives ` +
            `the request that carried it. Offending call arguments: ${args.trim().slice(0, 120)}`,
        ).toBe(false);
      }
    }
    // The vacuity floor for THIS wall specifically: a `logCallArguments` that
    // matched nothing would report every module clean, which is the same green a
    // correct tree gives.
    expect(
      scanned,
      'no log call was found anywhere in the credential surface — the extractor is broken',
    ).toBeGreaterThanOrEqual(45);
  });

  it('never accepts a credential from a URL path segment or a query string', () => {
    for (const relative of credentialSurface()) {
      expect(
        CREDENTIAL_IN_URL.test(readModule(relative)),
        `${relative} reads a credential out of the URL — it belongs in a header or a body, ` +
          'because a URL lands in access logs, Referer headers and browser history',
      ).toBe(false);
    }
  });

  it('keeps the channels SERVICE layer clear of credentials (the other side of #87)', () => {
    // `channel-isolation.test.ts` asserts this from inside: no module under
    // `services/channels/` may name the credential vocabulary. Here it falls out
    // of the derived surface instead, so the two cannot disagree — and this side
    // also covers a module added to `services/channels/` that reaches a
    // credential by a spelling that gate's own pattern does not carry.
    expect(
      credentialSurface().filter((relative) => relative.startsWith('services/channels/')),
      'a module in the channels service layer now handles a credential — the provider flows own ' +
        'those, not the wizard',
    ).toEqual([]);
  });
});

describe('#658 — mutation self-tests: every detector fires on what it forbids', () => {
  it('CREDENTIAL_VOCABULARY matches each carrier and not an ordinary neighbour', () => {
    for (const probe of [
      "import { decryptSecret } from '../lib/connector-crypto.js';",
      'const { key } = await generateKey(storeId, input, oxyUserId);',
      'const resolved = await verifyKey(raw);',
      'const candidates = await findVerificationCandidates(prefix);',
      'const envelope = await findConnectionWebhookSecret(connectionId, provider);',
      'router.use(makeRateLimiter("channels"), requireChannelKey);',
      'const key = req.channelKey;',
      'channelKey: z.string().trim().min(1).max(200).optional(),',
      'async function call(auth: ConnectorAuth): Promise<void> {}',
      'consumerSecret: z.string().trim().min(1).max(255),',
      'credentialsCiphertext: text(),',
    ]) {
      expect(CREDENTIAL_VOCABULARY.test(probe), `vocabulary missed: ${probe}`).toBe(true);
    }
    // The near misses. A detector that matches everything is as useless as one
    // that matches nothing, and it is the one that gets deleted by whoever hits
    // it next.
    for (const probe of [
      'const conn = await findConnection(storeId, connectionId);',
      'const keyId = routeParam(req, "keyId");',
      'const accessToken = await oxy.getAccessToken();',
      'const summary = await listKeys(storeId);',
    ]) {
      expect(CREDENTIAL_VOCABULARY.test(probe), `vocabulary over-matched: ${probe}`).toBe(false);
    }
  });

  it('stripComments removes prose without eating a URL or the code beside it', () => {
    expect(stripComments('// decryptSecret is forbidden here\nconst x = 1;')).not.toMatch(
      CREDENTIAL_VOCABULARY,
    );
    expect(stripComments('/** never decryptSecret */\nconst x = 1;')).not.toMatch(
      CREDENTIAL_VOCABULARY,
    );
    // The `[^:]` guard: a `https://` inside code must not swallow the rest of
    // the line, or a real reach after one would go unseen.
    expect(stripComments("const url = 'https://x.example'; const a = decryptSecret(b);")).toMatch(
      CREDENTIAL_VOCABULARY,
    );
  });

  it('logCallArguments crosses newlines and drops message literals', () => {
    // The single-line trap: this exact shape is most of `connector-sync.service.ts`.
    const multiline = "log.general.warn(\n  { err, raw },\n  'Something failed',\n);";
    const args = logCallArguments(multiline);
    expect(args.length, 'the extractor found no log call at all').toBe(1);
    expect(
      CREDENTIAL_IN_LOG.test(args[0]),
      'the extractor did not cross a newline, so every multi-line log call reads as clean',
    ).toBe(true);
    // Nested parens must not end the argument region early.
    const nested = 'log.auth.error({ err: toError(e), token: String(raw) }, "x");';
    expect(CREDENTIAL_IN_LOG.test(logCallArguments(nested)[0])).toBe(true);
    // A message literal naming a credential is prose and must NOT fire, or the
    // wall reds on `'Failed to generate channel key'`, which is a real line.
    const proseOnly = "log.general.error({ err, keyId: req.params.keyId }, 'Failed to revoke channel key');";
    expect(
      CREDENTIAL_IN_LOG.test(logCallArguments(proseOnly)[0]),
      'a log MESSAGE naming a credential fired the wall — string literals are not values',
    ).toBe(false);
  });

  it('CREDENTIAL_IN_URL fires on a URL-borne credential and not on an id', () => {
    for (const probe of [
      "const presented = routeParam(req, 'key');",
      'const presented = req.query.apiKey;',
      'const presented = req.params.channelKey;',
      'const presented = req.query.token;',
    ]) {
      expect(CREDENTIAL_IN_URL.test(probe), `URL detector missed: ${probe}`).toBe(true);
    }
    for (const probe of [
      "const connectionId = routeParam(req, 'connectionId');",
      'const keyId = req.params.keyId;',
      'const provider = req.params.provider;',
      'const body = req.body.channelKey;',
    ]) {
      expect(CREDENTIAL_IN_URL.test(probe), `URL detector over-matched: ${probe}`).toBe(false);
    }
  });
});
