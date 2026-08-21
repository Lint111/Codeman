import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalEventRegistry, signatureForExternalEvent } from '../src/external-event-registry.js';
import { ExternalEventStore } from '../src/external-event-store.js';
import { registerExternalEventRoutes } from '../src/web/routes/external-event-routes.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';

const event = {
  schemaVersion: 1,
  eventId: 'evt-route-1',
  type: 'job.completed',
  occurredAt: '2026-08-21T12:00:00.000Z',
  subject: { kind: 'external-job', id: 'boxm://job_route' },
  sequence: 2,
  state: {
    status: 'completed',
    provider: 'openai-responses',
    usageClass: 'openai-api',
    artifactRefs: ['artifact://job_route/result.json'],
  },
};

describe('external event routes', () => {
  it('accepts, deduplicates, and projects a signed webhook without exposing the secret', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codeman-external-routes-'));
    const registry = new ExternalEventRegistry(path.join(dir, 'integrations.json'));
    const store = new ExternalEventStore(path.join(dir, 'events.json'));
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const app = Fastify();
    registerExternalEventRoutes(app, {
      externalEventRegistry: registry,
      externalEventStore: store,
      invalidateLightState: () => {},
      broadcast: (eventName, data) => broadcasts.push({ event: eventName, data }),
      sendPushNotifications: () => {},
      batchTerminalData: () => {},
      broadcastSessionStateDebounced: () => {},
      batchTaskUpdate: () => {},
      getSseClientCount: () => 0,
    });
    await app.ready();

    const create = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: { id: 'codexless', label: 'Codexless', owner: 'alice', eventTypes: ['job.completed'] },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().data;
    expect(created.integration.secret).toBeUndefined();
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'content-type': 'application/json',
      'x-codeman-timestamp': timestamp,
      'x-codeman-signature': signatureForExternalEvent({ secret: created.secret, timestamp, rawBody: body }),
    };

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/integrations/codexless/events',
      headers,
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().data).toMatchObject({
      accepted: true,
      duplicate: false,
      stale: false,
      eventId: 'evt-route-1',
    });
    expect(broadcasts[0]).toMatchObject({ event: 'integration:jobCompleted' });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/integrations/codexless/events',
      headers,
      payload: body,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.duplicate).toBe(true);

    const jobs = await app.inject({ method: 'GET', url: '/api/integrations/jobs' });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().data[0]).toMatchObject({
      integrationId: 'codexless',
      owner: 'alice',
      state: { status: 'completed' },
    });

    const badSignature = await app.inject({
      method: 'POST',
      url: '/api/integrations/codexless/events',
      headers: { ...headers, 'x-codeman-signature': 'v1=' + '0'.repeat(64) },
      payload: body,
    });
    expect(badSignature.statusCode).toBe(401);
    await app.close();
  });

  it('allows only the signed webhook through the Basic-auth bypass', async () => {
    const previousPassword = process.env.CODEMAN_PASSWORD;
    process.env.CODEMAN_PASSWORD = 'codeman-test-password';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codeman-external-auth-'));
    const registry = new ExternalEventRegistry(path.join(dir, 'integrations.json'));
    const store = new ExternalEventStore(path.join(dir, 'events.json'));
    const app = Fastify();
    await app.register(fastifyCookie);
    registerAuthMiddleware(app, false);
    registerExternalEventRoutes(app, {
      externalEventRegistry: registry,
      externalEventStore: store,
      invalidateLightState: () => {},
      broadcast: () => {},
      sendPushNotifications: () => {},
      batchTerminalData: () => {},
      broadcastSessionStateDebounced: () => {},
      batchTaskUpdate: () => {},
      getSseClientCount: () => 0,
    });
    await app.ready();
    const basic = 'Basic ' + Buffer.from('admin:codeman-test-password').toString('base64');
    const create = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      headers: { authorization: basic },
      payload: { id: 'signed', label: 'Signed', eventTypes: ['job.completed'] },
    });
    const created = create.json().data;
    const body = JSON.stringify({ ...event, eventId: 'evt-auth-1' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signatureForExternalEvent({ secret: created.secret, timestamp, rawBody: body });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/integrations/signed/events',
      headers: {
        'content-type': 'application/json',
        'x-codeman-timestamp': timestamp,
        'x-codeman-signature': signature,
      },
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/api/integrations/signed/events',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    await app.close();
    if (previousPassword === undefined) delete process.env.CODEMAN_PASSWORD;
    else process.env.CODEMAN_PASSWORD = previousPassword;
  });
});
