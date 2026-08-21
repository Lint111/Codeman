import type { ExternalEventRegistry } from '../../external-event-registry.js';
import type { ExternalEventStore } from '../../external-event-store.js';

export interface ExternalEventPort {
  externalEventRegistry: ExternalEventRegistry;
  externalEventStore: ExternalEventStore;
  invalidateLightState(): void;
}
