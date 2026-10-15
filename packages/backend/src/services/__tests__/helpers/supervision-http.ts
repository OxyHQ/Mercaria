import express from 'express';
import type { Server } from 'node:http';
import {
  purchaseEffectsSchema,
  purchaseApprovalSchema,
  accountActorChainFromSession,
  type PurchaseApproval,
} from '@oxy.so/contracts';

/** External Oxy transport fixture; the consumer SDK, middleware, SQL and PSP seam stay real. */
export async function startSupervisionHttpFixture() {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, { id: string; supervised: boolean }>();
  const approvals = new Map<string, PurchaseApproval>();
  const calls: { path: string; body: unknown; authorization?: string }[] = [];
  const failNext = new Set<string>();
  const failAlways = new Set<string>();
  const effectsOf = (approval: PurchaseApproval) => {
    const { id, childAccountId, applicationId, status, createdAt, receiptReference, ...effects } =
      approval;
    return purchaseEffectsSchema.parse(effects);
  };
  const token = (id: string, supervised = true) => {
    const value = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ userId: id, sessionId: `session-${id}`, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture-signature`;
    sessions.set(value, { id, supervised });
    return value;
  };
  const sessionResult = (id: string) => ({
    valid: true,
    sessionId: `session-${id}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    lastActivity: new Date().toISOString(),
    user: { id, username: id, name: { first: 'Fixture' }, kind: 'personal' },
    actor: accountActorChainFromSession({ subjectAccountId: id }),
  });
  app.use((req, res, next) => {
    calls.push({ path: req.path, body: req.body, authorization: req.headers.authorization });
    if (failAlways.has(req.path) || failNext.delete(req.path)) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    next();
  });
  app.get('/session/validate-header/:id', (req, res) => {
    const session = sessions.get((req.header('Authorization') ?? '').replace('Bearer ', ''));
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (session.supervised) {
      res.status(403).json({ error: 'supervised_consumer_unsupported' });
      return;
    }
    res.json(sessionResult(session.id));
  });
  app.post('/safety/service/session', (req, res) => {
    const session = sessions.get(req.body.accessToken);
    if (req.header('Authorization') !== 'Bearer fixture-service-token' || !session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!['content', 'purchases'].includes(req.body.action)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.json(sessionResult(session.id));
  });
  app.use('/safety/service', (req, res, next) => {
    if (req.header('Authorization') !== 'Bearer fixture-service-token') {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.post('/safety/service/content-access-batch', (req, res) => {
    if (!sessions.has(req.body.requester.accessToken)) {
      res.sendStatus(401);
      return;
    }
    res.json({
      items: req.body.input.items.map((item: { resourceId: string; classification: string }) => ({
        resourceId: item.resourceId,
        decision: {
          allowed: item.classification === 'general',
          reason: item.classification === 'general' ? 'allowed' : 'unrated_content',
          policyVersion: '2',
        },
      })),
    });
  });
  app.post('/safety/service/purchases', (req, res) => {
    const session = sessions.get(req.body.requester.accessToken);
    if (!session) {
      res.sendStatus(401);
      return;
    }
    const effects = purchaseEffectsSchema.parse(req.body.input);
    let approval = [...approvals.values()].find((row) => row.operationId === effects.operationId);
    if (approval && JSON.stringify(effectsOf(approval)) !== JSON.stringify(effects)) {
      res.status(409).json({ error: 'effects_changed' });
      return;
    }
    if (!approval) {
      approval = purchaseApprovalSchema.parse({
        ...effects,
        id: `approval-${approvals.size + 1}`,
        childAccountId: session.id,
        applicationId: 'mercaria-fixture',
        status: 'pending',
        createdAt: new Date().toISOString(),
        receiptReference: null,
      });
      approvals.set(approval.id, approval);
    }
    res.json(approval);
  });
  app.post('/safety/service/purchases/:action', (req, res) => {
    const approval = approvals.get(req.body.approvalId);
    if (!approval || approval.operationId !== req.body.operationId) {
      res.sendStatus(404);
      return;
    }
    if (req.params.action === 'reserve') {
      const { approvalId: _, ...effects } = req.body;
      if (
        JSON.stringify(effectsOf(approval)) !==
          JSON.stringify(purchaseEffectsSchema.parse(effects)) ||
        !['approved', 'reserved'].includes(approval.status) ||
        (approval.status === 'approved' && Date.parse(approval.expiresAt) <= Date.now())
      ) {
        res.status(409).json({ error: 'approval_required' });
        return;
      }
      approval.status = 'reserved';
    } else if (req.params.action === 'confirm') {
      if (
        !['reserved', 'confirmed'].includes(approval.status) ||
        (approval.receiptReference && approval.receiptReference !== req.body.receiptReference)
      ) {
        res.sendStatus(409);
        return;
      }
      approval.status = 'confirmed';
      approval.receiptReference = req.body.receiptReference;
    } else if (req.params.action === 'cancel') {
      if (approval.status === 'confirmed') {
        res.sendStatus(409);
        return;
      }
      approval.status = 'cancelled';
    } else {
      res.sendStatus(404);
      return;
    }
    res.json(approval);
  });
  app.get('/safety/supervision/purchases/:id', (req, res) => {
    if (req.header('Authorization') !== 'Bearer guardian-fixture') {
      res.sendStatus(403);
      return;
    }
    const approval = approvals.get(req.params.id);
    if (!approval) {
      res.sendStatus(404);
      return;
    }
    res.json(approval);
  });
  app.post('/safety/supervision/purchases/:id/review', (req, res) => {
    if (req.header('Authorization') !== 'Bearer guardian-fixture') {
      res.sendStatus(403);
      return;
    }
    const approval = approvals.get(req.params.id);
    if (approval?.status !== 'pending') {
      res.sendStatus(409);
      return;
    }
    approval.status = req.body.decision === 'approve' ? 'approved' : 'rejected';
    res.json(approval);
  });
  app.get('/users/:id', (req, res) =>
    res.json({
      id: req.params.id,
      username: req.params.id,
      name: { first: 'Seller' },
      kind: 'personal',
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    approvals,
    calls,
    failNext,
    failAlways,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
