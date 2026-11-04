import pino from 'pino';
import { expect, it } from 'vitest';
import { REDACT_PATHS } from '../logger.js';

it('redacts requester proofs from whole request logs', () => {
  let output = '';
  const logger = pino(
    { redact: { paths: REDACT_PATHS } },
    {
      write: (chunk: string) => {
        output += chunk;
      },
    },
  );
  logger.info({
    res: {
      headers: {
        'X-Mercaria-Guest-Token': 'response-guest-canary',
        'X-Mercaria-Portal-Token': 'response-portal-canary',
        'X-Mercaria-Referral-State': 'response-referral-canary',
      },
    },
    req: {
      headers: {
        authorization: 'bearer-canary',
        'x-oxy-requester-token': 'session-canary',
        'x-oxy-requester-context': 'context-canary',
        'x-oxy-capability-ticket': 'ticket-canary',
        'x-oxy-presented-service-token': 'service-canary',
        'x-mercaria-guest-token': 'guest-canary',
        'x-mercaria-portal-token': 'portal-canary',
        'x-mercaria-referral-state': 'referral-canary',
        cookie: 'legacy-canary',
      },
      body: { subjectToken: 'subject-canary', connectionToken: 'connection-canary' },
      serviceActingAs: { requesterContext: 'acting-canary' },
    },
  });
  expect(output).not.toContain('canary');
});
