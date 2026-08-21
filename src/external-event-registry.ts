/**
 * @fileoverview Authenticated external-event integration registry.
 *
 * Integrations are service credentials, not Codeman users. The registry stores
 * the signing secret in a mode-0600 data file, returns it only at registration
 * or rotation time, and exposes only safe metadata to API callers.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from './config/instance.js';

const REGISTRY_VERSION = 1;
const MAX_INTEGRATIONS = 128;
const INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SIGNATURE = /^v1=([a-f0-9]{64})$/;
const TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ExternalEventIntegration {
  id: string;
  label: string;
  owner?: string;
  eventTypes: string[];
  secret: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface ExternalEventIntegrationPublic {
  id: string;
  label: string;
  owner?: string;
  eventTypes: string[];
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

interface RegistryFile {
  schemaVersion: number;
  integrations: ExternalEventIntegration[];
}

export interface VerifiedExternalEventIntegration {
  id: string;
  owner?: string;
  eventTypes: Set<string>;
}

export class ExternalEventRegistry {
  private readonly filePath: string;
  private integrations = new Map<string, ExternalEventIntegration>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = dataPath('external-event-integrations.json')) {
    this.filePath = filePath;
  }

  async list(): Promise<ExternalEventIntegrationPublic[]> {
    await this.ensureLoaded();
    return [...this.integrations.values()].map(toPublic);
  }

  async register({
    id,
    label,
    owner,
    eventTypes,
  }: {
    id: string;
    label: string;
    owner?: string;
    eventTypes: string[];
  }): Promise<{ integration: ExternalEventIntegrationPublic; secret: string }> {
    await this.ensureLoaded();
    validateId(id);
    if (this.integrations.has(id)) throw error('INTEGRATION_EXISTS', `Integration ${id} already exists`);
    if (this.integrations.size >= MAX_INTEGRATIONS)
      throw error('INTEGRATION_LIMIT', 'External integration registry is full');
    const now = new Date().toISOString();
    const secret = randomBytes(32).toString('base64url');
    const integration: ExternalEventIntegration = {
      id,
      label: validateLabel(label),
      ...(owner ? { owner: validateOwner(owner) } : {}),
      eventTypes: validateEventTypes(eventTypes),
      secret,
      createdAt: now,
      updatedAt: now,
    };
    this.integrations.set(id, integration);
    await this.persist();
    return { integration: toPublic(integration), secret };
  }

  async rotate(id: string): Promise<{ integration: ExternalEventIntegrationPublic; secret: string }> {
    const integration = await this.requireActive(id);
    const secret = randomBytes(32).toString('base64url');
    integration.secret = secret;
    integration.updatedAt = new Date().toISOString();
    await this.persist();
    return { integration: toPublic(integration), secret };
  }

  async revoke(id: string): Promise<ExternalEventIntegrationPublic> {
    const integration = await this.requireActive(id);
    integration.revokedAt = new Date().toISOString();
    integration.updatedAt = integration.revokedAt;
    await this.persist();
    return toPublic(integration);
  }

  async verify({
    id,
    timestamp,
    signature,
    rawBody,
    nowSeconds = Math.floor(Date.now() / 1000),
  }: {
    id: string;
    timestamp: string;
    signature: string;
    rawBody: Buffer;
    nowSeconds?: number;
  }): Promise<VerifiedExternalEventIntegration> {
    const integration = await this.requireActive(id);
    const parsedTimestamp = Number(timestamp);
    if (
      !Number.isSafeInteger(parsedTimestamp) ||
      Math.abs(nowSeconds - parsedTimestamp) > TIMESTAMP_TOLERANCE_SECONDS
    ) {
      throw error('INTEGRATION_TIMESTAMP_INVALID', 'External event timestamp is missing, invalid, or expired');
    }
    const match = SIGNATURE.exec(signature);
    if (!match) throw error('INTEGRATION_SIGNATURE_INVALID', 'External event signature has an invalid format');
    const signed = Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`);
    const expected = createHmac('sha256', integration.secret).update(signed).digest();
    const presented = Buffer.from(match[1], 'hex');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw error(
        'INTEGRATION_SIGNATURE_INVALID',
        'External event signature does not match the registered integration'
      );
    }
    return {
      id: integration.id,
      ...(integration.owner ? { owner: integration.owner } : {}),
      eventTypes: new Set(integration.eventTypes),
    };
  }

  private async requireActive(id: string): Promise<ExternalEventIntegration> {
    await this.ensureLoaded();
    validateId(id);
    const integration = this.integrations.get(id);
    if (!integration || integration.revokedAt)
      throw error('INTEGRATION_NOT_FOUND', `External integration ${id} was not found`);
    return integration;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as RegistryFile;
      if (parsed.schemaVersion !== REGISTRY_VERSION || !Array.isArray(parsed.integrations))
        throw new Error('unsupported registry schema');
      for (const integration of parsed.integrations) {
        if (integration && INTEGRATION_ID.test(integration.id) && typeof integration.secret === 'string')
          this.integrations.set(integration.id, integration);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persist(): Promise<void> {
    const data =
      JSON.stringify({ schemaVersion: REGISTRY_VERSION, integrations: [...this.integrations.values()] }, null, 2) +
      '\n';
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      await writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.filePath);
    });
    await this.writeChain;
  }
}

export function signatureForExternalEvent({
  secret,
  timestamp,
  rawBody,
}: {
  secret: string;
  timestamp: string;
  rawBody: Buffer | string;
}): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function hashExternalEventId(eventId: string): string {
  return createHash('sha256').update(eventId).digest('hex');
}

function toPublic(integration: ExternalEventIntegration): ExternalEventIntegrationPublic {
  const { secret: _secret, ...publicValue } = integration;
  return { ...publicValue, eventTypes: [...integration.eventTypes] };
}

function validateId(id: string): void {
  if (!INTEGRATION_ID.test(id))
    throw error('INTEGRATION_ID_INVALID', 'Integration id must match [a-z0-9][a-z0-9_-]{0,63}');
}

function validateLabel(label: string): string {
  if (typeof label !== 'string' || label.trim().length < 1 || label.length > 120)
    throw error('INTEGRATION_LABEL_INVALID', 'Integration label must be 1-120 characters');
  return label.trim();
}

function validateOwner(owner: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(owner)) throw error('INTEGRATION_OWNER_INVALID', 'Integration owner is invalid');
  return owner;
}

function validateEventTypes(eventTypes: string[]): string[] {
  if (
    !Array.isArray(eventTypes) ||
    eventTypes.length < 1 ||
    eventTypes.length > 32 ||
    eventTypes.some((type) => !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/.test(type))
  ) {
    throw error(
      'INTEGRATION_EVENT_TYPES_INVALID',
      'Integration eventTypes must contain 1-32 dotted lowercase event names'
    );
  }
  return [...new Set(eventTypes)];
}

function error(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
