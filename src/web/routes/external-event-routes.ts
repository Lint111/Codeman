/**
 * @fileoverview Authenticated external-event registry and webhook routes.
 *
 * The ingress is HMAC-authenticated independently of Codeman user sessions.
 * Accepted events are durably recorded before their typed SSE projection is
 * broadcast. Delivery is at-least-once and event IDs are idempotent.
 */

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { ExternalJobEvent } from '../../external-event-store.js';
import { ExternalEventIntegrationCreateSchema, ExternalJobEventSchema } from '../schemas.js';
import { parseBody, getAuthUser, isAdmin, requireAdmin } from '../route-helpers.js';
import { IntegrationJobCompleted, IntegrationJobFailed, IntegrationJobUpdated } from '../sse-events.js';
import type { EventPort } from '../ports/event-port.js';
import type { ExternalEventPort } from '../ports/external-event-port.js';

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };
const MAX_SIGNATURE_FAILURES = 10;
const SIGNATURE_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function registerExternalEventRoutes(app: FastifyInstance, ctx: EventPort & ExternalEventPort): void {
  const signatureFailures = new Map<string, { count: number; expiresAt: number }>();

  app.post('/api/integrations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const input = parseBody(ExternalEventIntegrationCreateSchema, req.body);
    try {
      const created = await ctx.externalEventRegistry.register(input);
      return reply.code(201).send({ data: created });
    } catch (error) {
      return registryError(reply, error);
    }
  });

  app.get('/api/integrations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { data: await ctx.externalEventRegistry.list() };
  });

  app.post('/api/integrations/:id/rotate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = integrationId(req);
      return { data: await ctx.externalEventRegistry.rotate(id) };
    } catch (error) {
      return registryError(reply, error);
    }
  });

  app.delete('/api/integrations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = integrationId(req);
      return { data: await ctx.externalEventRegistry.revoke(id) };
    } catch (error) {
      return registryError(reply, error);
    }
  });

  app.get('/api/integrations/jobs', async (req) => {
    const owner = isAdmin(req) ? undefined : getAuthUser(req).username;
    return { data: await ctx.externalEventStore.listJobs(owner) };
  });

  app.get('/api/integrations/events', async (req) => {
    const owner = isAdmin(req) ? undefined : getAuthUser(req).username;
    const rawLimit = (req.query as { limit?: string }).limit;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    return { data: await ctx.externalEventStore.listEvents(owner, Number.isSafeInteger(limit) ? limit : 100) };
  });

  app.register(async (scope) => {
    scope.addHook('preParsing', async (request, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks);
      (request as RawBodyRequest).rawBody = rawBody;
      return Readable.from([rawBody]);
    });

    scope.post('/api/integrations/:id/events', { bodyLimit: 128 * 1024 }, async (req, reply) => {
      let id: string;
      try {
        id = integrationId(req);
      } catch (error) {
        return registryError(reply, error);
      }
      const rawBody = (req as RawBodyRequest).rawBody;
      const timestamp = header(req, 'x-codeman-timestamp');
      const signature = header(req, 'x-codeman-signature');
      if (!rawBody || !timestamp || !signature)
        return rejectIngress(req, reply, signatureFailures, 'Integration signature headers are required');

      let integration;
      try {
        integration = await ctx.externalEventRegistry.verify({ id, timestamp, signature, rawBody });
      } catch (error) {
        return rejectIngress(
          req,
          reply,
          signatureFailures,
          error instanceof Error ? error.message : 'Integration authentication failed'
        );
      }

      signatureFailures.delete(req.ip);
      const event = parseBody(ExternalJobEventSchema, req.body) as ExternalJobEvent;
      if (!integration.eventTypes.has(event.type))
        return reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, `Integration is not registered for ${event.type}`));

      const accepted = await ctx.externalEventStore.accept(event, integration.id, integration.owner);
      if (!accepted.duplicate && !accepted.stale) {
        ctx.invalidateLightState();
        ctx.broadcast(sseEventFor(event.type), { ...accepted.projection, duplicate: false, stale: false });
      }
      return reply.code(accepted.duplicate ? 200 : 202).send({
        data: {
          accepted: true,
          duplicate: accepted.duplicate,
          stale: accepted.stale,
          eventId: event.eventId,
          projection: accepted.projection,
        },
      });
    });
  });
}

function sseEventFor(type: ExternalJobEvent['type']): string {
  if (type === 'job.completed') return IntegrationJobCompleted;
  if (type === 'job.failed') return IntegrationJobFailed;
  return IntegrationJobUpdated;
}

function integrationId(req: FastifyRequest): string {
  const id = (req.params as { id?: string }).id;
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    throw Object.assign(new Error('Invalid integration id'), { code: 'INTEGRATION_ID_INVALID' });
  return id;
}

function header(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && value ? value : null;
}

function rejectIngress(
  req: FastifyRequest,
  reply: FastifyReply,
  failures: Map<string, { count: number; expiresAt: number }>,
  message: string
): unknown {
  const now = Date.now();
  const current = failures.get(req.ip);
  const next =
    !current || current.expiresAt <= now
      ? { count: 1, expiresAt: now + SIGNATURE_FAILURE_WINDOW_MS }
      : { count: current.count + 1, expiresAt: current.expiresAt };
  failures.set(req.ip, next);
  if (next.count > MAX_SIGNATURE_FAILURES) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(1, Math.ceil((next.expiresAt - now) / 1000))))
      .send(createErrorResponse(ApiErrorCode.RATE_LIMITED));
  }
  return reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED, message));
}

function registryError(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown
): unknown {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'INTEGRATION_EXISTS')
    return reply.code(409).send(createErrorResponse(ApiErrorCode.ALREADY_EXISTS, String((error as Error).message)));
  if (code === 'INTEGRATION_NOT_FOUND')
    return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, String((error as Error).message)));
  return reply
    .code(400)
    .send(
      createErrorResponse(ApiErrorCode.INVALID_INPUT, error instanceof Error ? error.message : 'Invalid integration')
    );
}
