/**
 * `req.ip` is the CLIENT, in both shapes a request reaches the API in.
 *
 * Every IP-keyed control here reads `req.ip`: the SDK's general limiter, the
 * actor limiter's anonymous bucket, guest-session farming (`networkRangeOf`)
 * and guest order recovery. The ALB appends the peer it saw to
 * `X-Forwarded-For`, so the request carries
 *
 *   grey   (DNS only)  X-Forwarded-For: <client>                socket: the ALB
 *   orange (proxied)   X-Forwarded-For: <client>, <cloudflare>  socket: the ALB
 *
 * With no `trust proxy`, `req.ip` was the ALB's private address — one bucket
 * for everybody. `trust proxy = 1` would be right for grey and answer
 * Cloudflare's edge for orange. This drives the REAL `createApp()`'s setting
 * through Express's own `req.ip` getter, so it fails if the setting is dropped,
 * changed to a hop count, or moved behind a different app.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type express from 'express';

let app: express.Express;

beforeAll(async () => {
  app = (await import('../app.js')).createApp();
}, 120_000);

/** Express's own `req.ip`, for a request from `peer` carrying `forwardedFor`. */
function clientIpOf(peer: string, forwardedFor?: string): string | undefined {
  const req = Object.create(app.request) as express.Request;
  const socket = { remoteAddress: peer };
  Object.assign(req, {
    app,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket,
    connection: socket,
  });
  return req.ip;
}

const ALB = '10.0.12.34';
const CLIENT = '203.0.113.7';
const CLOUDFLARE_EDGE = '172.70.1.2';

describe('the client address behind the proxy chain', () => {
  it('is the client for a DNS-only hostname (the ALB appended it)', () => {
    expect(clientIpOf(ALB, CLIENT)).toBe(CLIENT);
  });

  it('is the client, not the edge, behind the Cloudflare proxy', () => {
    expect(clientIpOf(ALB, `${CLIENT}, ${CLOUDFLARE_EDGE}`)).toBe(CLIENT);
  });

  it('never believes an address a caller wrote itself', () => {
    // A forged left-most entry, grey: the ALB's own entry is the answer.
    expect(clientIpOf(ALB, `198.51.100.9, ${CLIENT}`)).toBe(CLIENT);
    // A forged "Cloudflare" entry with no Cloudflare in front: the ALB saw the
    // caller connect from CLIENT, so CLIENT is what it is.
    expect(clientIpOf(ALB, `${CLOUDFLARE_EDGE}, ${CLIENT}`)).toBe(CLIENT);
  });

  it('believes nothing in the header from a public peer (no proxy in front)', () => {
    expect(clientIpOf(CLIENT, '198.51.100.9')).toBe(CLIENT);
  });
});
