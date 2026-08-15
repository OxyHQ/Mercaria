/**
 * Traffic classification (#143 link rule 4): bots, link previews and scanners
 * are told apart from shoppers, and none of them grants attribution.
 *
 * The tests that matter most here are the NEGATIVE ones: a classifier is only
 * as good as the things it declines to call automated, and a false positive is
 * a real buyer silently losing the attribution they clicked for.
 */

import { describe, expect, it } from 'vitest';
import { classifyReferralTraffic, trafficMayAttribute } from '../traffic.js';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like ' +
  'Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

describe('classifyReferralTraffic', () => {
  it('calls an ordinary browser organic', () => {
    for (const userAgent of [CHROME, SAFARI_IOS]) {
      const verdict = classifyReferralTraffic({ userAgent }, undefined);
      expect(verdict.trafficClass).toBe('organic');
      expect(verdict.signal).toBe('no_automation_signal');
      expect(trafficMayAttribute(verdict.trafficClass)).toBe(true);
    }
  });

  it('calls a declared crawler a bot', () => {
    for (const userAgent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'GPTBot/1.0',
    ]) {
      const verdict = classifyReferralTraffic({ userAgent }, undefined);
      expect(verdict.trafficClass, userAgent).toBe('bot');
      expect(trafficMayAttribute(verdict.trafficClass)).toBe(false);
    }
  });

  it('calls a link unfurler a preview, not a bot', () => {
    // A different fact, and it routes differently in an operator trace:
    // somebody pasted the link into a chat, which is a person about to click.
    for (const userAgent of [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'WhatsApp/2.23.20.0',
      'Twitterbot/1.0',
    ]) {
      const verdict = classifyReferralTraffic({ userAgent }, undefined);
      expect(verdict.trafficClass, userAgent).toBe('preview');
      expect(trafficMayAttribute(verdict.trafficClass)).toBe(false);
    }
  });

  it('reads a declared prefetch as a preview even from a real browser', () => {
    // The case a User-Agent list can never catch: Chrome speculatively fetching
    // a link nobody chose. Recording that as a click would let a browser's
    // optimiser spend a partner's ceiling.
    const verdict = classifyReferralTraffic(
      { userAgent: CHROME, purposeHeaders: { 'sec-purpose': 'prefetch;prerender' } },
      undefined,
    );
    expect(verdict.trafficClass).toBe('preview');
    expect(verdict.signal).toBe('purpose_header');
  });

  it('accepts the older purpose spellings too', () => {
    for (const header of ['purpose', 'x-purpose', 'x-moz'] as const) {
      const verdict = classifyReferralTraffic(
        { userAgent: CHROME, purposeHeaders: { [header]: 'prefetch' } },
        undefined,
      );
      expect(verdict.trafficClass, header).toBe('preview');
    }
  });

  it('reads a MISSING User-Agent as automated', () => {
    // Every real browser sends one, so the absence is itself a declaration.
    const verdict = classifyReferralTraffic({}, undefined);
    expect(verdict.trafficClass).toBe('bot');
  });

  it('classifies staff traffic INTERNAL, ahead of every other rule', () => {
    // Mercaria's own monitors carry automated user agents. Reading them as
    // `bot` would hide staff traffic in the same bucket as strangers'
    // crawlers, and #143 web rule 9 asks for an EXPLICIT exclusion.
    const verdict = classifyReferralTraffic(
      { userAgent: 'curl/8.4.0', internalTrafficToken: 'shhh' },
      'shhh',
    );
    expect(verdict.trafficClass).toBe('internal');
    expect(verdict.signal).toBe('internal_token');
    expect(trafficMayAttribute(verdict.trafficClass)).toBe(false);
  });

  it('does NOT treat an unconfigured deployment as all-internal', () => {
    // The bug this pins: `'' === ''`. Without the length guard an empty
    // presented token would match an empty expected one and every request in
    // an unconfigured deployment would classify `internal` — attribution off
    // marketplace-wide, silently, with nothing in any log saying so.
    const verdict = classifyReferralTraffic({ userAgent: CHROME, internalTrafficToken: '' }, '');
    expect(verdict.trafficClass).toBe('organic');
  });

  it('ignores a WRONG internal token', () => {
    const verdict = classifyReferralTraffic(
      { userAgent: CHROME, internalTrafficToken: 'guess' },
      'shhh',
    );
    expect(verdict.trafficClass).toBe('organic');
  });

  it('never reads anything but the three declared headers', () => {
    // A structural assertion, not a behavioural one: the signature has three
    // members and none of them is an address, a language, an accept header or
    // a stored counter. If this stops compiling because a fourth arrived,
    // that is the review this test exists to force (ADR 0005 A2).
    const signals: Parameters<typeof classifyReferralTraffic>[0] = {
      userAgent: CHROME,
      purposeHeaders: {},
      internalTrafficToken: undefined,
    };
    expect(Object.keys(signals).sort()).toEqual([
      'internalTrafficToken',
      'purposeHeaders',
      'userAgent',
    ]);
  });

  it('is pure — the same input answers the same way every time', () => {
    // No per-client state, so nothing here can become a fingerprint by
    // accumulating. Ten identical calls, one answer.
    const answers = new Set(
      Array.from({ length: 10 }, () =>
        JSON.stringify(classifyReferralTraffic({ userAgent: CHROME }, 'shhh')),
      ),
    );
    expect(answers.size).toBe(1);
  });
});

describe('trafficMayAttribute', () => {
  it('admits organic and nothing else', () => {
    expect(trafficMayAttribute('organic')).toBe(true);
    expect(trafficMayAttribute('bot')).toBe(false);
    expect(trafficMayAttribute('preview')).toBe(false);
    expect(trafficMayAttribute('internal')).toBe(false);
  });
});
