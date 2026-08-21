import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalEventRegistry, signatureForExternalEvent } from '../src/external-event-registry.js';
import { ExternalEventStore, type ExternalJobEvent } from '../src/external-event-store.js';

const event: ExternalJobEvent = {
  schemaVersion: 1,
  eventId: 'evt-1',
  type: 'job.updated',
  occurredAt: '2026-08-21T12:00:00.000Z',
  subject: { kind: 'external-job', id: 'boxm://job_abc' },
  sequence: 1,
  state: { status: 'running', provider: 'openai-responses', usageClass: 'openai-api' },
};

describe('external event registry', () => {
  it('returns a one-time secret, verifies HMAC, and persists mode-0600 state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codeman-external-registry-'));
    const filePath = path.join(dir, 'integrations.json');
    const registry = new ExternalEventRegistry(filePath);
    const created = await registry.register({
      id: 'codexless',
      label: 'Codexless',
      owner: 'alice',
      eventTypes: ['job.updated'],
    });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.integration).not.toHaveProperty('secret');
    const body = Buffer.from(JSON.stringify(event));
    const timestamp = '178';
    const verified = await registry.verify({
      id: 'codexless',
      timestamp,
      signature: signatureForExternalEvent({ secret: created.secret, timestamp, rawBody: body }),
      rawBody: body,
      nowSeconds: 178,
    });
    expect(verified).toMatchObject({ id: 'codexless', owner: 'alice' });
    expect(verified.eventTypes.has('job.updated')).toBe(true);
    await expect(stat(filePath)).resolves.toMatchObject({ mode: 0o100600 });
    expect(JSON.parse(await readFile(filePath, 'utf8')).integrations[0].secret).toBe(created.secret);
  });

  it('rejects expired timestamps and signatures from the previous rotation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codeman-external-rotate-'));
    const registry = new ExternalEventRegistry(path.join(dir, 'integrations.json'));
    const created = await registry.register({ id: 'codexless', label: 'Codexless', eventTypes: ['job.updated'] });
    const body = Buffer.from(JSON.stringify(event));
    const oldTimestamp = '100';
    const oldSignature = signatureForExternalEvent({ secret: created.secret, timestamp: oldTimestamp, rawBody: body });
    await registry.rotate('codexless');
    await expect(
      registry.verify({
        id: 'codexless',
        timestamp: oldTimestamp,
        signature: oldSignature,
        rawBody: body,
        nowSeconds: 100,
      })
    ).rejects.toMatchObject({ code: 'INTEGRATION_SIGNATURE_INVALID' });
    await expect(
      registry.verify({ id: 'codexless', timestamp: '1', signature: oldSignature, rawBody: body, nowSeconds: 1_000 })
    ).rejects.toMatchObject({ code: 'INTEGRATION_TIMESTAMP_INVALID' });
  });
});

describe('external event store', () => {
  it('deduplicates event IDs and refuses stale projections', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codeman-external-store-'));
    const store = new ExternalEventStore(path.join(dir, 'events.json'));
    const first = await store.accept(event, 'codexless', 'alice');
    expect(first).toMatchObject({ duplicate: false, stale: false, projection: { state: { status: 'running' } } });
    const duplicate = await store.accept(event, 'codexless', 'alice');
    expect(duplicate.duplicate).toBe(true);
    const stale = await store.accept(
      { ...event, eventId: 'evt-0', sequence: 0, state: { status: 'completed' } },
      'codexless',
      'alice'
    );
    expect(stale.stale).toBe(true);
    expect((await store.listJobs('alice'))[0].state.status).toBe('running');
    const restarted = new ExternalEventStore(path.join(dir, 'events.json'));
    expect((await restarted.listEvents('alice')).length).toBe(2);
  });
});
