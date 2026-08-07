import { EventEmitter } from 'node:events';

import type { SubagentInfo, SubagentTranscriptEntry } from './subagent-watcher.js';

export interface SubagentWatcherStats {
  agentCount: number;
  fileDebouncerCount: number;
  dirWatcherCount: number;
  idleTimerCount: number;
  pendingToolCallsCount: number;
  knownDirsCount: number;
  filePositionsCount: number;
}

export interface SubagentSource extends EventEmitter {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getSubagents(): SubagentInfo[];
  getSubagentsForSession(workingDir: string): SubagentInfo[];
  getSubagent(agentId: string): SubagentInfo | undefined;
  getRecentSubagents(minutes?: number): SubagentInfo[];
  getTranscript(agentId: string, limit?: number): Promise<SubagentTranscriptEntry[]>;
  formatTranscript(entries: SubagentTranscriptEntry[]): string[];
  killSubagent(agentId: string): Promise<boolean>;
  killSubagentsForSession(workingDir: string, sessionId?: string): Promise<void>;
  cleanupNow(): number;
  clearAll(): number;
  getStats(): SubagentWatcherStats;
  getProjectHashForDir?(workingDir: string): string;
  updateDescription?(agentId: string, description: string): boolean;
}

const FORWARDED_EVENTS = [
  'subagent:discovered',
  'subagent:updated',
  'subagent:tool_call',
  'subagent:tool_result',
  'subagent:progress',
  'subagent:message',
  'subagent:completed',
  'subagent:error',
] as const;

/**
 * Provider-neutral facade over independently-owned agent activity sources.
 *
 * Consumers keep using the established `subagent:*` contract while each source
 * remains responsible for discovery, parsing, liveness, and transcript reads in
 * its own native format.
 */
export class CompositeSubagentWatcher extends EventEmitter {
  constructor(private readonly sources: SubagentSource[]) {
    super();
    this.setMaxListeners(50);

    for (const source of sources) {
      for (const event of FORWARDED_EVENTS) {
        source.on(event, (...args: unknown[]) => this.emit(event, ...args));
      }
    }
  }

  start(): void {
    for (const source of this.sources) source.start();
  }

  stop(): void {
    for (const source of this.sources) source.stop();
  }

  isRunning(): boolean {
    return this.sources.some((source) => source.isRunning());
  }

  getSubagents(): SubagentInfo[] {
    return this.mergeAgents((source) => source.getSubagents());
  }

  getSubagentsForSession(workingDir: string): SubagentInfo[] {
    return this.mergeAgents((source) => source.getSubagentsForSession(workingDir));
  }

  getSubagent(agentId: string): SubagentInfo | undefined {
    return this.findSource(agentId)?.getSubagent(agentId);
  }

  getRecentSubagents(minutes: number = 60): SubagentInfo[] {
    return this.mergeAgents((source) => source.getRecentSubagents(minutes)).sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt
    );
  }

  async getTranscript(agentId: string, limit?: number): Promise<SubagentTranscriptEntry[]> {
    const source = this.findSource(agentId);
    return source ? source.getTranscript(agentId, limit) : [];
  }

  formatTranscript(entries: SubagentTranscriptEntry[]): string[] {
    const agentId = entries.find((entry) => entry.agentId)?.agentId;
    const source = agentId ? this.findSource(agentId) : undefined;
    return (source ?? this.sources[0])?.formatTranscript(entries) ?? [];
  }

  async killSubagent(agentId: string): Promise<boolean> {
    const source = this.findSource(agentId);
    return source ? source.killSubagent(agentId) : false;
  }

  async killSubagentsForSession(workingDir: string, sessionId?: string): Promise<void> {
    await Promise.all(this.sources.map((source) => source.killSubagentsForSession(workingDir, sessionId)));
  }

  cleanupNow(): number {
    return this.sources.reduce((count, source) => count + source.cleanupNow(), 0);
  }

  clearAll(): number {
    return this.sources.reduce((count, source) => count + source.clearAll(), 0);
  }

  updateDescription(agentId: string, description: string): boolean {
    const source = this.findSource(agentId);
    return source?.updateDescription?.(agentId, description) ?? false;
  }

  getProjectHashForDir(workingDir: string): string {
    for (const source of this.sources) {
      if (source.getProjectHashForDir) return source.getProjectHashForDir(workingDir);
    }
    return workingDir.replace(/\//g, '-');
  }

  getStats(): SubagentWatcherStats {
    const total: SubagentWatcherStats = {
      agentCount: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
      pendingToolCallsCount: 0,
      knownDirsCount: 0,
      filePositionsCount: 0,
    };
    for (const source of this.sources) {
      const stats = source.getStats();
      for (const key of Object.keys(total) as Array<keyof SubagentWatcherStats>) {
        total[key] += stats[key];
      }
    }
    return total;
  }

  private findSource(agentId: string): SubagentSource | undefined {
    return this.sources.find((source) => source.getSubagent(agentId) !== undefined);
  }

  private mergeAgents(read: (source: SubagentSource) => SubagentInfo[]): SubagentInfo[] {
    const merged = new Map<string, SubagentInfo>();
    for (const source of this.sources) {
      for (const agent of read(source)) merged.set(agent.agentId, agent);
    }
    return Array.from(merged.values());
  }
}
