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
    req: {
      headers: {
        authorization: 'bearer-canary',
        'x-oxy-requester-token': 'session-canary',
        'x-oxy-requester-context': 'context-canary',
        'x-oxy-capability-ticket': 'ticket-canary',
        'x-oxy-presented-service-token': 'service-canary',
      },
      body: { subjectToken: 'subject-canary', connectionToken: 'connection-canary' },
      serviceActingAs: { requesterContext: 'acting-canary' },
    },
  });
  expect(output).not.toContain('canary');
});
