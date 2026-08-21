/**
 * @fileoverview Durable, bounded external event inbox and job projection.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataPath } from './config/instance.js';

const STORE_VERSION = 1;
const MAX_EVENTS = 2_000;
const MAX_JOBS = 1_000;

export type ExternalJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'cancellation_requested'
  | 'unknown';

export interface ExternalJobEvent {
  schemaVersion: 1;
  eventId: string;
  type: 'job.updated' | 'job.completed' | 'job.failed';
  occurredAt: string;
  subject: { kind: 'external-job'; id: string };
  correlation?: { taskRef?: string; workspace?: string };
  sequence?: number;
  state: {
    status: ExternalJobStatus;
    provider?: string;
    usageClass?: string;
    phase?: string;
    artifactRefs?: string[];
    exitCode?: number;
  };
}

export interface ExternalJobProjection extends ExternalJobEvent {
  integrationId: string;
  owner?: string;
  receivedAt: string;
}

interface StoreFile {
  schemaVersion: number;
  events: ExternalJobProjection[];
  jobs: Record<string, ExternalJobProjection>;
}

export class ExternalEventStore {
  private readonly filePath: string;
  private events: ExternalJobProjection[] = [];
  private jobs = new Map<string, ExternalJobProjection>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = dataPath('external-event-store.json')) {
    this.filePath = filePath;
  }

  async accept(
    event: ExternalJobEvent,
    integrationId: string,
    owner?: string
  ): Promise<{ duplicate: boolean; stale: boolean; projection: ExternalJobProjection }> {
    await this.ensureLoaded();
    const duplicate = this.events.some(
      (entry) => entry.integrationId === integrationId && entry.eventId === event.eventId
    );
    if (duplicate) {
      const existing = this.events.find(
        (entry) => entry.integrationId === integrationId && entry.eventId === event.eventId
      )!;
      return { duplicate: true, stale: false, projection: existing };
    }

    const projection: ExternalJobProjection = {
      ...structuredClone(event),
      integrationId,
      ...(owner ? { owner } : {}),
      receivedAt: new Date().toISOString(),
    };
    this.events.push(projection);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);

    const previous = this.jobs.get(event.subject.id);
    const stale = previous ? isStale(event, previous) : false;
    if (!stale) {
      this.jobs.set(event.subject.id, projection);
      while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value!);
    }
    await this.persist();
    return { duplicate: false, stale, projection: this.jobs.get(event.subject.id) ?? projection };
  }

  async listJobs(owner?: string): Promise<ExternalJobProjection[]> {
    await this.ensureLoaded();
    return [...this.jobs.values()].filter((job) => !owner || job.owner === owner);
  }

  async listEvents(owner?: string, limit = 100): Promise<ExternalJobProjection[]> {
    await this.ensureLoaded();
    return this.events.filter((event) => !owner || event.owner === owner).slice(-Math.min(Math.max(limit, 1), 500));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreFile;
      if (parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.events) || !parsed.jobs)
        throw new Error('unsupported external event store schema');
      this.events = parsed.events.slice(-MAX_EVENTS);
      this.jobs = new Map(Object.entries(parsed.jobs).slice(-MAX_JOBS));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persist(): Promise<void> {
    const data =
      JSON.stringify(
        { schemaVersion: STORE_VERSION, events: this.events, jobs: Object.fromEntries(this.jobs) },
        null,
        2
      ) + '\n';
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      await writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    await this.writeChain;
  }
}

function isStale(next: ExternalJobEvent, previous: ExternalJobProjection): boolean {
  if (Number.isSafeInteger(next.sequence) && Number.isSafeInteger(previous.sequence))
    return next.sequence! <= previous.sequence!;
  return next.occurredAt <= previous.occurredAt;
}
