/**
 * The guest portal's PURE decisions (#108) — scope policy, token scoping,
 * template composition, the trigger table and the throttle's network axis.
 *
 * Everything here is a function of its arguments, which is what makes the
 * privacy rules testable without a fixture that has to be set up right: a
 * template that could name an item title would fail to compile, and a scope
 * resolver that could read a request has no parameter for one.
 */

import { describe, expect, it } from 'vitest';
import {
  GUEST_ORDER_SCOPES,
  GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS,
  GUEST_PORTAL_MESSAGE_KINDS,
  GUEST_PORTAL_PERMANENT_FAILURES,
  UNGRANTABLE_GUEST_ORDER_SCOPES,
  UNVERIFIED_GRANTABLE_SCOPES,
} from '@mercaria/shared-types';
import {
  hashPortalToken,
  mintExchangeToken,
  mintPortalToken,
  portalTokenMatches,
  readExchangeToken,
  readPortalToken,
} from '../grant-token.js';
import { resolveExchangeScopes, resolveGrantScopes, VERIFIED_GRANT_SCOPES } from '../scopes.js';
import {
  buildPortalUrl,
  messageCarriesAccessLink,
  renderGuestMessage,
  resolveMessageLocale,
} from '../templates.js';
import { GUEST_PORTAL_MESSAGE_TRIGGERS } from '../message.service.js';
import { networkPrefix, RECOVERY_MAX_GROUPS } from '../recovery.service.js';

describe('scope policy is decided server-side and has no client input', () => {
  it('a post_checkout credential gets tracking:read and nothing else', () => {
    expect(resolveGrantScopes('post_checkout', false)).toEqual([...UNVERIFIED_GRANTABLE_SCOPES]);
    // Even ASKED for a verified state, the origin decides: proof of a device is
    // not proof of an inbox, whatever a caller claims.
    expect(resolveGrantScopes('post_checkout', true)).toEqual([...UNVERIFIED_GRANTABLE_SCOPES]);
  });

  it('a verified magic-link credential gets everything grantable', () => {
    const scopes = resolveGrantScopes('magic_link', true);
    expect(scopes).toContain('orders:read');
    expect(scopes).toContain('claim:write');
    expect(scopes).toEqual([...VERIFIED_GRANT_SCOPES]);
  });

  it('NOTHING grants contact_change:request — it is defined and unavailable', () => {
    // The `role_email` decision from merchant claiming: a member of a closed
    // set the registry declines to issue is a documented gap, where deleting
    // the member would make the gap invisible and enabling it a schema change.
    expect(GUEST_ORDER_SCOPES).toContain('contact_change:request');
    expect(UNGRANTABLE_GUEST_ORDER_SCOPES).toContain('contact_change:request');
    for (const origin of ['post_checkout', 'magic_link'] as const) {
      for (const verified of [true, false]) {
        expect(resolveGrantScopes(origin, verified)).not.toContain('contact_change:request');
      }
    }
    expect(resolveExchangeScopes()).not.toContain('contact_change:request');
  });

  it('the grantable and ungrantable sets are disjoint and cover the tuple', () => {
    // A scope that was neither grantable nor named ungrantable would be
    // silently unavailable — the failure shape nobody notices.
    for (const scope of GUEST_ORDER_SCOPES) {
      const grantable = VERIFIED_GRANT_SCOPES.includes(scope);
      const forbidden = UNGRANTABLE_GUEST_ORDER_SCOPES.includes(scope);
      expect(grantable !== forbidden, `${scope} is in neither set or in both`).toBe(true);
    }
  });

  it('returns a fresh array each time, so a caller cannot mutate the policy', () => {
    const first = resolveGrantScopes('magic_link', true);
    first.push('contact_change:request');
    expect(resolveGrantScopes('magic_link', true)).not.toContain('contact_change:request');
  });
});

describe('token scope is STRUCTURAL (ADR 0003 D3, invariant I3)', () => {
  it('each reader accepts only its own prefix', () => {
    const exchange = mintExchangeToken().token;
    const portal = mintPortalToken().token;

    expect(readExchangeToken(exchange)).toBe(exchange);
    expect(readPortalToken(portal)).toBe(portal);

    // The whole of "a cart token cannot become order access": the readers have
    // anchored patterns, so a `mgs_` credential never reaches a hash.
    expect(readPortalToken(exchange)).toBeUndefined();
    expect(readExchangeToken(portal)).toBeUndefined();
    expect(readPortalToken(`mgs_${'A'.repeat(43)}`)).toBeUndefined();
    expect(readExchangeToken(`mgs_${'A'.repeat(43)}`)).toBeUndefined();
  });

  it('refuses the wrong length before any hashing, including a huge value', () => {
    expect(readPortalToken(`mgp_${'A'.repeat(42)}`)).toBeUndefined();
    expect(readPortalToken(`mgp_${'A'.repeat(44)}`)).toBeUndefined();
    expect(readPortalToken(`mgp_${'A'.repeat(100_000)}`)).toBeUndefined();
    expect(readPortalToken(undefined)).toBeUndefined();
    expect(readPortalToken('')).toBeUndefined();
  });

  it('refuses a character outside base64url', () => {
    expect(readPortalToken(`mgp_${'A'.repeat(42)}+`)).toBeUndefined();
    expect(readPortalToken(`mgp_${'A'.repeat(42)}/`)).toBeUndefined();
  });

  it('the digest is a SHA-256 and the ACCEPT decision is a constant-time compare', () => {
    const { token, tokenHash } = mintPortalToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashPortalToken(token));
    expect(portalTokenMatches(token, tokenHash)).toBe(true);
    expect(portalTokenMatches(mintPortalToken().token, tokenHash)).toBe(false);
  });

  it('two mints never collide', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintPortalToken().token));
    expect(seen.size).toBe(200);
  });
});

describe('templates say what they may and nothing else', () => {
  const facts = {
    orderNumber: 'MRC-000123',
    sellerLabel: 'Acme Supplies',
    orderCount: 2,
    portalUrl: 'https://mercaria.co/guest-orders/portal',
  };

  it('renders every kind in both languages with no undefined leaking through', () => {
    for (const kind of GUEST_PORTAL_MESSAGE_KINDS) {
      for (const locale of ['en', 'es-ES', 'fr', null]) {
        const rendered = renderGuestMessage({ ...facts, kind }, locale);
        expect(rendered.subject.length, `${kind}/${String(locale)} subject`).toBeGreaterThan(5);
        expect(rendered.body.length, `${kind}/${String(locale)} body`).toBeGreaterThan(20);
        expect(rendered.subject).not.toContain('undefined');
        expect(rendered.body).not.toContain('undefined');
        expect(rendered.body).toContain(facts.portalUrl);
      }
    }
  });

  it('no SUBJECT names an item, a price or a person (privacy rule 4)', () => {
    // A subject is the one part of a message a lock screen shows a stranger, so
    // it may name Mercaria and a state and nothing else. The facts fed in here
    // deliberately include a seller and an order number so the assertion is not
    // vacuous — the seller may appear in a BODY and must not in a subject.
    for (const kind of GUEST_PORTAL_MESSAGE_KINDS) {
      const rendered = renderGuestMessage({ ...facts, kind }, 'en');
      expect(rendered.subject).not.toContain(facts.orderNumber);
      expect(rendered.subject).not.toContain(facts.sellerLabel);
      expect(rendered.subject.toLowerCase()).toContain('mercaria');
    }
  });

  it('a regional variant renders its language; an unknown tag falls back to English', () => {
    expect(resolveMessageLocale('es-419')).toBe('es');
    expect(resolveMessageLocale('ES')).toBe('es');
    expect(resolveMessageLocale('es')).toBe('es');
    expect(resolveMessageLocale('fr-CA')).toBe('en');
    expect(resolveMessageLocale(null)).toBe('en');
    expect(resolveMessageLocale(undefined)).toBe('en');
    expect(renderGuestMessage({ ...facts, kind: 'order_shipped' }, 'es-MX').locale).toBe('es');
  });

  it('a group-level message names a COUNT and never an order it does not have', () => {
    const rendered = renderGuestMessage(
      { kind: 'access_link_recovery', orderCount: 3, portalUrl: facts.portalUrl },
      'en',
    );
    expect(rendered.body).not.toContain('MRC-');
    expect(rendered.body).toContain(facts.portalUrl);
  });

  it('the token rides in the FRAGMENT, and an unset base is refused not defaulted', () => {
    const token = mintExchangeToken().token;
    const url = buildPortalUrl('https://mercaria.co/guest-orders/portal/', token);
    expect(url).toBe(`https://mercaria.co/guest-orders/portal#${token}`);
    // A fragment is never sent to a server (ADR 0003 T4), so the token cannot
    // reach an access log, a proxy log or a `Referer`. The query form would.
    expect(url).not.toContain('?');
    expect(buildPortalUrl('https://mercaria.co/guest-orders/portal')).not.toContain('#');
    expect(() => buildPortalUrl('  ')).toThrowError(/GUEST_MAGIC_LINK_BASE_URL/);
  });

  it('only the three link-bearing kinds carry a credential', () => {
    for (const kind of GUEST_PORTAL_MESSAGE_KINDS) {
      expect(messageCarriesAccessLink(kind)).toBe(
        GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS.includes(kind),
      );
    }
    expect(GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS).toHaveLength(3);
    // A shipping notice must NOT hand out access: it links to the portal's
    // entry page and the recipient exchanges or recovers from there.
    expect(messageCarriesAccessLink('order_shipped')).toBe(false);
    expect(messageCarriesAccessLink('order_confirmation')).toBe(true);
  });
});

describe('every message kind is triggered or explicitly deferred', () => {
  it('the trigger table is TOTAL over the vocabulary', () => {
    // The `deferred: #NN` device from the Stripe event ingress: a kind with no
    // decision is a template nobody has proved works, and silence about it
    // reads identically to real handling.
    for (const kind of GUEST_PORTAL_MESSAGE_KINDS) {
      const entry = GUEST_PORTAL_MESSAGE_TRIGGERS[kind];
      expect(entry, `${kind} has no trigger decision`).toBeDefined();
      expect(entry.note.length, `${kind} has no note`).toBeGreaterThan(30);
      if (entry.trigger === null) {
        // A deferred kind must name the issue that owes it.
        expect(entry.note, `${kind} is deferred without an issue number`).toMatch(/#\d+/);
      } else {
        expect(entry.trigger).toMatch(/\.ts/);
      }
    }
  });

  it('the kinds #108 actually sends are triggered', () => {
    for (const kind of [
      'order_confirmation',
      'access_link_recovery',
      'access_link_step_up',
      'access_security_notice',
      'order_shipped',
      'order_cancelled',
    ] as const) {
      expect(GUEST_PORTAL_MESSAGE_TRIGGERS[kind].trigger, `${kind} should be triggered`).not.toBe(
        null,
      );
    }
  });
});

describe('failure permanence is declared, not inferred', () => {
  it('an unconfigured transport is PERMANENT and an unavailable one is not', () => {
    // The asymmetry is the decision: treating a permanent failure as retryable
    // burns a sender reputation slowly and invisibly; treating a transient one
    // as permanent loses one message loudly.
    expect(GUEST_PORTAL_PERMANENT_FAILURES).toContain('transport_unconfigured');
    expect(GUEST_PORTAL_PERMANENT_FAILURES).toContain('contact_suppressed');
    expect(GUEST_PORTAL_PERMANENT_FAILURES).toContain('contact_anonymized');
    expect(GUEST_PORTAL_PERMANENT_FAILURES).not.toContain('transport_unavailable');
  });
});

describe('the recovery throttle bounds without identifying', () => {
  it('an IPv4 address collapses to its /24 and an IPv6 one to its /64', () => {
    expect(networkPrefix('203.0.113.42')).toBe('203.0.113');
    expect(networkPrefix('203.0.113.99')).toBe('203.0.113');
    expect(networkPrefix('203.0.114.42')).not.toBe('203.0.113');
    // A v6 client must not be able to walk its own allocation around the limit
    // one address at a time.
    expect(networkPrefix('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2');
    expect(networkPrefix('2001:DB8:1:2:9:9:9:9')).toBe('2001:db8:1:2');
    expect(networkPrefix('2001:db8:1:3::1')).not.toBe('2001:db8:1:2');
  });

  it('the fan-out per request is bounded', () => {
    expect(RECOVERY_MAX_GROUPS).toBeGreaterThan(0);
    expect(RECOVERY_MAX_GROUPS).toBeLessThanOrEqual(10);
  });
});
