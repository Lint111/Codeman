/**
 * @fileoverview Cross-provider Codex CLI worker watcher.
 *
 * Durable `codex-dispatch.sh` JSONL remains the preferred event stream. Direct
 * `codex exec` calls launched from Claude Bash tools are discovered from their
 * native Codex rollouts and correlated to the originating Claude lead session.
 *
 * Only correlated workers are admitted. Unrelated personal Codex sessions and
 * commands which merely mention Codex never enter the shared subagent UI.
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join, normalize } from 'node:path';

import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar';

import { MAX_TRACKED_AGENTS } from './config/map-limits.js';
import { STALE_DATA_MAX_AGE_MS } from './config/server-timing.js';
import { parseCodexCliInvocations } from './codex-cli-invocation.js';
import type { SubagentSource, SubagentWatcherStats } from './composite-subagent-watcher.js';
import type {
  SubagentInfo,
  SubagentMessage,
  SubagentToolCall,
  SubagentToolResult,
  SubagentTranscriptEntry,
} from './subagent-watcher.js';

const DEFAULT_DISPATCH_DIR = join(homedir(), 'scripts', 'codex-runs');
const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
// Parent dirs whose children are per-worker CODEX_HOMEs. Dispatch tooling gives
// each worker its own CODEX_HOME, so its rollouts land in
// <CODEX_HOME>/sessions/ rather than ~/.codex/sessions and are otherwise unseen.
const DEFAULT_CODEX_HOME_GLOB_ROOTS = ['/tmp/csd-workers/homes'];
const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const DISPATCH_FILE_PATTERN = /^codex-(.+)\.jsonl$/;
const ROLLOUT_FILE_PATTERN = /^rollout-.+-([0-9a-f]{8}-[0-9a-f-]{20,})\.jsonl$/i;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
const STARTUP_MAX_FILE_AGE_MS = 4 * 60 * 60 * 1000;
const STALE_IDLE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 1000;
// How long an 'idle' worker still counts as live for the panel payload. Matches
// SubagentWatcher.IDLE_LIVENESS_MAX_AGE_MS — see there for the reasoning.
const IDLE_LIVENESS_MAX_AGE_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const NATIVE_PATCH_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_CORRELATION_CELLS = 500_000;
const ROLLOUT_PREFIX_BYTES = 512 * 1024;
const DISPATCH_PREFIX_BYTES = 4096;
const DISPATCH_CORRELATION_WINDOW_MS = 30 * 60 * 1000;
const DIRECT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;
const CLAUDE_TRANSCRIPT_RECENT_GRACE_MS = 5 * 60 * 1000;
const CLAUDE_TRANSCRIPT_DISCOVERY_INTERVAL_MS = 10 * 1000;
const MAX_CLAUDE_TRANSCRIPT_CANDIDATES = 80;
const MAX_PENDING_LINES = 2000;
const MESSAGE_TEXT_LIMIT = 500;

interface ClaudeParentContext {
  projectHash: string;
  sessionId: string;
}

interface CodexRolloutContext {
  threadId: string;
  filePath: string;
  cwd: string;
  model?: string;
  startedAt?: string;
}

interface FileLineCursor {
  filePath: string;
  position: number;
  carry: Buffer;
}

interface DispatchFileCursor extends FileLineCursor {
  label: string;
  pendingLines: string[];
  threadId?: string;
  agentId?: string;
  runStartedAt: number;
  lastMtimeMs: number;
}

interface NativeRolloutCursor extends FileLineCursor {
  threadId: string;
  context: CodexRolloutContext;
  lastMtimeMs: number;
  agentId?: string;
  patchCache?: {
    size: number;
    mtimeMs: number;
    candidates: NativePatchCandidate[];
  };
}

interface CodexLaunchEvidence extends ClaudeParentContext {
  occurredAt: number;
  kind: 'direct' | 'wrapper';
  label?: string;
  workingDir?: string;
  description?: string;
}

interface ClaudeTranscriptCache {
  size: number;
  mtimeMs: number;
  evidence: CodexLaunchEvidence[];
}

interface ClaudeTranscriptCandidate extends ClaudeParentContext {
  path: string;
}

interface NativePatchCandidate {
  patch: string;
  paths: string[];
}

interface CodexDispatchWatcherOptions {
  dispatchDirs?: string[];
  codexSessionsDir?: string;
  /** Additional sessions roots, each shaped like `<root>/<Y>/<M>/<D>/rollout-*.jsonl`. */
  extraCodexSessionsDirs?: string[];
  /** Parent dirs whose immediate children are CODEX_HOMEs (`<child>/sessions`). */
  codexHomeGlobRoots?: string[];
  claudeProjectsDir?: string;
  startupMaxAgeMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function isPatchText(value: string): boolean {
  return /^(?:\*\*\* Begin Patch|diff --git|@@\s+-\d+|---\s+|\+\+\+\s+)/m.test(value);
}

function nativePatchText(payload: JsonRecord): string | undefined {
  const name = asString(payload.name);
  if (!name) return undefined;
  const rawInput = payload.arguments ?? payload.input;
  const inputRecord = asRecord(rawInput) ?? (typeof rawInput === 'string' ? parseJsonLine(rawInput) : undefined);

  if (name === 'apply_patch') {
    const patch = asString(inputRecord?.patch) ?? asString(inputRecord?.input) ?? asString(rawInput);
    return patch && isPatchText(patch) ? patch : undefined;
  }

  if (name !== 'exec' || typeof rawInput !== 'string') return undefined;
  const source = rawInput;
  const literal =
    source.match(/\b(?:const|let|var)\s+patch\s*=\s*("(?:[^"\\]|\\.)*")\s*;/s)?.[1] ??
    source.match(/tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*")\s*\)/s)?.[1];
  if (!literal) return undefined;
  try {
    const patch = JSON.parse(literal);
    return typeof patch === 'string' && isPatchText(patch) ? patch : undefined;
  } catch {
    return undefined;
  }
}

function normalizedPatchPath(value: string): string {
  let path = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/');
  if (/^[ab]\//.test(path)) path = path.slice(2);
  return path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function patchFilePaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const applyPatchPath = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/)?.[1];
    const movePath = line.match(/^\*\*\* Move to:\s+(.+)$/)?.[1];
    const gitPaths = line.match(/^diff --git\s+(?:"?a\/)?(.+?)"?\s+(?:"?b\/)?(.+?)"?$/);
    for (const path of [applyPatchPath, movePath, gitPaths?.[1], gitPaths?.[2]]) {
      if (path) paths.add(normalizedPatchPath(path));
    }
  }
  return Array.from(paths).filter(Boolean);
}

function pathsEquivalent(left: string, right: string): boolean {
  const a = normalizedPatchPath(left);
  const b = normalizedPatchPath(right);
  return a === b || (a.includes('/') && b.endsWith(`/${a}`)) || (b.includes('/') && a.endsWith(`/${b}`));
}

function sameFileSet(changes: string[], patchPaths: string[]): boolean {
  if (changes.length === 0 || patchPaths.length === 0) return false;
  return (
    changes.every((change) => patchPaths.some((path) => pathsEquivalent(change, path))) &&
    patchPaths.every((path) => changes.some((change) => pathsEquivalent(change, path)))
  );
}

function nativePatchCandidates(content: string): NativePatchCandidate[] {
  const candidates: NativePatchCandidate[] = [];
  for (const line of content.split('\n')) {
    const event = parseJsonLine(line);
    if (event?.type !== 'response_item') continue;
    const payload = asRecord(event.payload);
    if (!payload || !['function_call', 'custom_tool_call'].includes(asString(payload.type) ?? '')) continue;
    const patch = nativePatchText(payload);
    if (!patch) continue;
    const paths = patchFilePaths(patch);
    if (paths.length > 0) candidates.push({ patch, paths });
  }
  return candidates;
}

function correlateNativePatches(events: JsonRecord[], candidates: NativePatchCandidate[]): Map<string, string> {
  const fileChanges = events.flatMap((event) => {
    const item = asRecord(event.item);
    if (event.type !== 'item.started' || item?.type !== 'file_change') return [];
    const itemId = asString(item.id);
    if (!itemId) return [];
    const paths = (Array.isArray(item.changes) ? item.changes : [])
      .map((change) => asString(asRecord(change)?.path))
      .filter((path): path is string => !!path);
    return [{ itemId, paths }];
  });

  const patches = new Map<string, string>();
  if (fileChanges.length === 0 || candidates.length === 0) return patches;

  const cellCount = (fileChanges.length + 1) * (candidates.length + 1);
  if (cellCount > MAX_PATCH_CORRELATION_CELLS) {
    let candidateIndex = 0;
    for (const fileChange of fileChanges) {
      while (candidateIndex < candidates.length && !sameFileSet(fileChange.paths, candidates[candidateIndex].paths)) {
        candidateIndex++;
      }
      if (candidateIndex >= candidates.length) break;
      patches.set(fileChange.itemId, candidates[candidateIndex].patch);
      candidateIndex++;
    }
    return patches;
  }

  const scores = Array.from({ length: fileChanges.length + 1 }, () => new Uint32Array(candidates.length + 1));
  for (let fileIndex = fileChanges.length - 1; fileIndex >= 0; fileIndex--) {
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex--) {
      scores[fileIndex][candidateIndex] = sameFileSet(fileChanges[fileIndex].paths, candidates[candidateIndex].paths)
        ? scores[fileIndex + 1][candidateIndex + 1] + 1
        : Math.max(scores[fileIndex + 1][candidateIndex], scores[fileIndex][candidateIndex + 1]);
    }
  }

  let fileIndex = 0;
  let candidateIndex = 0;
  while (fileIndex < fileChanges.length && candidateIndex < candidates.length) {
    const isMatch = sameFileSet(fileChanges[fileIndex].paths, candidates[candidateIndex].paths);
    if (isMatch && scores[fileIndex][candidateIndex + 1] === scores[fileIndex][candidateIndex]) {
      candidateIndex++;
    } else if (isMatch) {
      patches.set(fileChanges[fileIndex].itemId, candidates[candidateIndex].patch);
      fileIndex++;
      candidateIndex++;
    } else if (scores[fileIndex][candidateIndex + 1] >= scores[fileIndex + 1][candidateIndex]) {
      candidateIndex++;
    } else {
      fileIndex++;
    }
  }
  return patches;
}

function projectHashForDir(workingDir: string): string {
  return workingDir.replace(/\//g, '-');
}

/** Extract Claude's encoded project + parent UUID from a managed scratchpad path. */
export function parseClaudeScratchpadContext(workingDir: string): ClaudeParentContext | undefined {
  const match = workingDir.match(/(?:^|\/)tmp\/claude-\d+\/([^/]+)\/([0-9a-f]{8}-[0-9a-f-]{20,})\/scratchpad(?:\/|$)/i);
  if (!match?.[1] || !match[2] || !CLAUDE_SESSION_ID_PATTERN.test(match[2])) return undefined;
  return { projectHash: match[1], sessionId: match[2] };
}

/**
 * Compatibility helper for callers which only need the established durable
 * wrapper. The shared recognizer also understands direct Codex CLI launches.
 */
export function parseCodexDispatchInvocation(command: string): { brief: string; label: string } | undefined {
  const invocation = parseCodexCliInvocations(command).find((candidate) => candidate.kind === 'wrapper');
  return invocation?.kind === 'wrapper' ? { brief: invocation.brief, label: invocation.label } : undefined;
}

function expandUserPaths(configured: string | undefined): string[] {
  if (!configured) return [];
  return Array.from(
    new Set(
      configured
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value))
    )
  );
}

function configuredDispatchDirs(): string[] {
  const dirs = expandUserPaths(process.env.CODEMAN_CODEX_DISPATCH_DIRS);
  return dirs.length > 0 ? dirs : [DEFAULT_DISPATCH_DIR];
}

/**
 * Roots holding per-worker CODEX_HOME directories.
 *
 * Dispatch tooling launches workers with their own CODEX_HOME
 * (e.g. `CODEX_HOME=/tmp/csd-workers/homes/<worker>`), so their rollouts land in
 * `<CODEX_HOME>/sessions/...` and never appear under the default `~/.codex`.
 * Worker homes are created per dispatch, so they cannot be enumerated up front —
 * a parent directory is scanned for `<child>/sessions` instead.
 *
 * The built-in default applies only when the env var is unset AND the directory
 * actually exists, so a machine that does not use this tooling scans nothing
 * extra. Tests always pass `codexHomeGlobRoots` explicitly rather than inheriting
 * a real path from the host.
 */
function configuredCodexHomeGlobRoots(): string[] {
  const configured = expandUserPaths(process.env.CODEMAN_CODEX_HOME_ROOTS);
  if (configured.length > 0) return configured;
  return DEFAULT_CODEX_HOME_GLOB_ROOTS.filter((dir) => existsSync(dir));
}

export class CodexDispatchWatcher extends EventEmitter implements SubagentSource {
  private readonly dispatchDirs: string[];
  private readonly codexSessionsDir: string;
  private readonly extraCodexSessionsDirs: string[];
  private readonly codexHomeGlobRoots: string[];
  private readonly claudeProjectsDir: string;
  private readonly startupMaxAgeMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly agents = new Map<string, SubagentInfo>();
  private readonly cursors = new Map<string, DispatchFileCursor>();
  private readonly nativeCursors = new Map<string, NativeRolloutCursor>();
  private readonly agentFormats = new Map<string, 'dispatch' | 'rollout'>();
  private readonly claudeTranscriptCandidates = new Map<string, ClaudeTranscriptCandidate>();
  private readonly claudeTranscriptCache = new Map<string, ClaudeTranscriptCache>();
  private launchEvidence: CodexLaunchEvidence[] = [];
  private lastClaudeTranscriptDiscoveryAt = Number.NEGATIVE_INFINITY;
  private readonly pendingToolCalls = new Map<string, Map<string, { tool: string; timestamp: number }>>();
  private readonly dirWatchers = new Map<string, ChokidarWatcher>();
  private readonly fileQueues = new Map<string, Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private _isRunning = false;

  constructor(options: CodexDispatchWatcherOptions = {}) {
    super();
    this.dispatchDirs = options.dispatchDirs ?? configuredDispatchDirs();
    this.codexSessionsDir = options.codexSessionsDir ?? DEFAULT_CODEX_SESSIONS_DIR;
    this.extraCodexSessionsDirs = options.extraCodexSessionsDirs ?? [];
    this.codexHomeGlobRoots = options.codexHomeGlobRoots ?? configuredCodexHomeGlobRoots();
    this.claudeProjectsDir = options.claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
    this.startupMaxAgeMs = options.startupMaxAgeMs ?? STARTUP_MAX_FILE_AGE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setMaxListeners(50);
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    void this.scanNow();
    this.pollTimer = setInterval(() => void this.scanNow(), this.pollIntervalMs);
  }

  stop(): void {
    this._isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const watcher of this.dirWatchers.values()) void watcher.close();
    this.dirWatchers.clear();
    this.fileQueues.clear();
    this.cursors.clear();
    this.nativeCursors.clear();
    this.agentFormats.clear();
    this.claudeTranscriptCandidates.clear();
    this.claudeTranscriptCache.clear();
    this.launchEvidence = [];
    this.lastClaudeTranscriptDiscoveryAt = Number.NEGATIVE_INFINITY;
    this.agents.clear();
    this.pendingToolCalls.clear();
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  /** Public for deterministic integration tests and one-shot diagnostics. */
  /** SubagentSource alias for scanNow(), so the composite can force discovery. */
  async rescan(): Promise<void> {
    await this.scanNow();
  }

  async scanNow(): Promise<void> {
    await this.refreshClaudeLaunchEvidence();
    const paths: string[] = [];
    for (const dir of this.dispatchDirs) {
      if (this._isRunning) await this.ensureDirectoryWatcher(dir);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && DISPATCH_FILE_PATTERN.test(entry.name)) paths.push(join(dir, entry.name));
      }
    }
    await Promise.all(paths.map((filePath) => this.queueFile(filePath)));
    await this.scanNativeRollouts();
    this.refreshIdleStatuses();
    this.cleanupNow();
  }

  getSubagents(): SubagentInfo[] {
    return Array.from(this.agents.values());
  }

  getSubagentsForSession(workingDir: string): SubagentInfo[] {
    const projectHash = projectHashForDir(workingDir);
    return this.getSubagents().filter((agent) => agent.projectHash === projectHash);
  }

  getSubagent(agentId: string): SubagentInfo | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Recent workers, plus any worker that is plausibly still running.
   *
   * refreshIdleStatuses() demotes a worker to 'idle' after only IDLE_TIMEOUT_MS
   * of quiet, so 'idle' covers both a worker between tool calls and one whose
   * process is long gone — an idle worker therefore stays only while it is
   * plausibly alive (IDLE_LIVENESS_MAX_AGE_MS), not indefinitely.
   *
   * Mirrors SubagentWatcher.getRecentSubagents; bounding the map stays
   * cleanupNow()/MAX_TRACKED_AGENTS' job.
   */
  getRecentSubagents(minutes: number = 60): SubagentInfo[] {
    const now = this.now();
    const cutoff = now - minutes * 60 * 1000;
    const idleCutoff = now - IDLE_LIVENESS_MAX_AGE_MS;
    return this.getSubagents()
      .filter((agent) => {
        if (agent.status === 'active') return true;
        if (agent.status === 'idle') return agent.lastActivityAt >= Math.min(cutoff, idleCutoff);
        return agent.lastActivityAt >= cutoff;
      })
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async getTranscript(agentId: string, limit?: number): Promise<SubagentTranscriptEntry[]> {
    const info = this.agents.get(agentId);
    if (!info) return [];
    let content: string;
    try {
      content =
        limit && limit > 0 && this.agentFormats.get(agentId) === 'rollout'
          ? await this.readTail(info.filePath, TRANSCRIPT_TAIL_BYTES)
          : await readFile(info.filePath, 'utf8');
    } catch {
      return [];
    }

    const format = this.agentFormats.get(agentId);
    const events = content
      .split('\n')
      .map(parseJsonLine)
      .filter((event): event is JsonRecord => !!event);
    const patches = format === 'dispatch' ? await this.nativePatchesForDispatch(agentId, events) : new Map();
    const entries: SubagentTranscriptEntry[] = [];
    for (const rawEvent of events) {
      const item = asRecord(rawEvent.item);
      const patch = item?.type === 'file_change' ? patches.get(asString(item.id) ?? '') : undefined;
      const event = patch ? { ...rawEvent, item: { ...item, patch } } : rawEvent;
      const entry =
        format === 'rollout' ? this.toNativeTranscriptEntry(event, info) : this.toTranscriptEntry(event, info);
      if (entry) entries.push(entry);
    }
    return limit && limit > 0 ? entries.slice(-limit) : entries;
  }

  formatTranscript(entries: SubagentTranscriptEntry[]): string[] {
    const lines: string[] = [];
    for (const entry of entries) {
      const content = entry.message?.content;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${entry.timestamp} ${entry.message?.role === 'assistant' ? 'agent' : 'tool'}: ${content.trim()}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') lines.push(`${entry.timestamp} tool: ${block.name ?? 'unknown'}`);
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            lines.push(`${entry.timestamp} result: ${block.content}`);
          }
        }
      }
    }
    return lines;
  }

  async killSubagent(_agentId: string): Promise<boolean> {
    // The script is normally launched through nohup and owns a process pipeline.
    // Without a dispatcher-provided PID/process-group token, killing by label can
    // target a reused label. Observation remains safe; destructive control waits
    // for an explicit manifest protocol.
    return false;
  }

  async killSubagentsForSession(_workingDir: string, _sessionId?: string): Promise<void> {
    // Script-dispatched workers intentionally outlive the parent shell command.
  }

  cleanupNow(): number {
    const now = this.now();
    const before = this.agents.size;
    for (const [agentId, info] of this.agents) {
      const age = now - info.lastActivityAt;
      if (
        (info.status === 'completed' && age > STALE_DATA_MAX_AGE_MS) ||
        (info.status === 'idle' && age > STALE_IDLE_MAX_AGE_MS)
      ) {
        this.removeAgent(agentId);
      }
    }

    if (this.agents.size > MAX_TRACKED_AGENTS) {
      const evictable = Array.from(this.agents.values())
        .filter((agent) => agent.status !== 'active')
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      for (const agent of evictable.slice(0, this.agents.size - MAX_TRACKED_AGENTS)) {
        this.removeAgent(agent.agentId);
      }
    }
    return before - this.agents.size;
  }

  clearAll(): number {
    const count = this.agents.size;
    this.agents.clear();
    this.agentFormats.clear();
    this.pendingToolCalls.clear();
    for (const cursor of this.cursors.values()) {
      cursor.position = 0;
      cursor.carry = Buffer.alloc(0);
      cursor.threadId = undefined;
      cursor.agentId = undefined;
      cursor.pendingLines = [];
    }
    for (const cursor of this.nativeCursors.values()) {
      cursor.position = 0;
      cursor.carry = Buffer.alloc(0);
      cursor.agentId = undefined;
    }
    return count;
  }

  updateDescription(agentId: string, description: string): boolean {
    const info = this.agents.get(agentId);
    if (!info) return false;
    info.description = description;
    this.emit('subagent:updated', info);
    return true;
  }

  getProjectHashForDir(workingDir: string): string {
    return projectHashForDir(workingDir);
  }

  getStats(): SubagentWatcherStats {
    let pendingToolCallsCount = 0;
    for (const calls of this.pendingToolCalls.values()) pendingToolCallsCount += calls.size;
    return {
      agentCount: this.agents.size,
      fileDebouncerCount: this.fileQueues.size,
      dirWatcherCount: this.dirWatchers.size,
      idleTimerCount: 0,
      pendingToolCallsCount,
      knownDirsCount: this.dispatchDirs.length + this.dirWatchers.size,
      filePositionsCount: this.cursors.size + this.nativeCursors.size,
    };
  }

  private async refreshClaudeLaunchEvidence(): Promise<void> {
    const cutoff = this.now() - this.startupMaxAgeMs - CLAUDE_TRANSCRIPT_RECENT_GRACE_MS;
    if (
      this.claudeTranscriptCandidates.size === 0 ||
      this.now() - this.lastClaudeTranscriptDiscoveryAt >= CLAUDE_TRANSCRIPT_DISCOVERY_INTERVAL_MS
    ) {
      await this.discoverClaudeTranscriptCandidates(cutoff);
    }

    const candidates: Array<ClaudeTranscriptCandidate & { mtimeMs: number; size: number }> = [];
    await Promise.all(
      Array.from(this.claudeTranscriptCandidates.values()).map(async (candidate) => {
        try {
          const fileStat = await stat(candidate.path);
          if (!fileStat.isFile() || fileStat.mtimeMs < cutoff) {
            this.claudeTranscriptCandidates.delete(candidate.path);
            this.claudeTranscriptCache.delete(candidate.path);
            return;
          }
          candidates.push({ ...candidate, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
        } catch {
          this.claudeTranscriptCandidates.delete(candidate.path);
          this.claudeTranscriptCache.delete(candidate.path);
        }
      })
    );

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = candidates.slice(0, MAX_CLAUDE_TRANSCRIPT_CANDIDATES);
    const activePaths = new Set(selected.map((candidate) => candidate.path));
    const evidence: CodexLaunchEvidence[] = [];

    for (const candidate of selected) {
      let cached = this.claudeTranscriptCache.get(candidate.path);
      if (!cached || cached.size !== candidate.size || cached.mtimeMs !== candidate.mtimeMs) {
        const tail = await this.readTail(candidate.path, TRANSCRIPT_TAIL_BYTES);
        cached = {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          evidence: this.extractLaunchEvidence(tail, candidate.projectHash, candidate.sessionId),
        };
        this.claudeTranscriptCache.set(candidate.path, cached);
      }
      evidence.push(...cached.evidence);
    }

    for (const path of this.claudeTranscriptCache.keys()) {
      if (!activePaths.has(path)) this.claudeTranscriptCache.delete(path);
    }
    this.launchEvidence = evidence.sort((a, b) => b.occurredAt - a.occurredAt);
  }

  private async discoverClaudeTranscriptCandidates(cutoff: number): Promise<void> {
    let projects;
    try {
      projects = await readdir(this.claudeProjectsDir, { withFileTypes: true });
    } catch {
      this.claudeTranscriptCandidates.clear();
      this.launchEvidence = [];
      return;
    }

    const discovered = new Map<string, ClaudeTranscriptCandidate>();

    const addCandidate = async (path: string, projectHash: string, sessionId: string): Promise<void> => {
      try {
        const fileStat = await stat(path);
        if (fileStat.isFile() && fileStat.mtimeMs >= cutoff) {
          discovered.set(path, { path, projectHash, sessionId });
        }
      } catch {
        // Transcript disappeared between directory discovery and stat.
      }
    };

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = join(this.claudeProjectsDir, project.name);
      let sessions;
      try {
        sessions = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const leadFiles = sessions.filter((session) => {
        if (!session.isFile() || !session.name.endsWith('.jsonl')) return false;
        return CLAUDE_SESSION_ID_PATTERN.test(session.name.slice(0, -'.jsonl'.length));
      });
      await Promise.all(
        leadFiles.map((session) => {
          const sessionId = session.name.slice(0, -'.jsonl'.length);
          return addCandidate(join(projectDir, session.name), project.name, sessionId);
        })
      );

      const recentSessionIds = new Set(
        leadFiles
          .map((session) => session.name.slice(0, -'.jsonl'.length))
          .filter((sessionId) => discovered.has(join(projectDir, `${sessionId}.jsonl`)))
      );
      const sessionDirectories = sessions.filter(
        (session) => session.isDirectory() && CLAUDE_SESSION_ID_PATTERN.test(session.name)
      );
      await Promise.all(
        sessionDirectories
          .filter((session) => !recentSessionIds.has(session.name))
          .map(async (session) => {
            try {
              const directoryStat = await stat(join(projectDir, session.name));
              if (directoryStat.mtimeMs >= cutoff) recentSessionIds.add(session.name);
            } catch {
              // Session directory disappeared during discovery.
            }
          })
      );
      for (const session of sessionDirectories) {
        if (!recentSessionIds.has(session.name)) continue;
        const subagentsDir = join(projectDir, session.name, 'subagents');
        let subagents;
        try {
          subagents = await readdir(subagentsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        await Promise.all(
          subagents
            .filter((subagent) => subagent.isFile() && subagent.name.endsWith('.jsonl'))
            .map((subagent) => addCandidate(join(subagentsDir, subagent.name), project.name, session.name))
        );
      }
    }
    this.claudeTranscriptCandidates.clear();
    for (const [path, candidate] of discovered) this.claudeTranscriptCandidates.set(path, candidate);
    this.lastClaudeTranscriptDiscoveryAt = this.now();
  }

  private extractLaunchEvidence(content: string, projectHash: string, sessionId: string): CodexLaunchEvidence[] {
    const evidence: CodexLaunchEvidence[] = [];
    for (const line of content.split('\n')) {
      const entry = parseJsonLine(line);
      const occurredAt = Date.parse(asString(entry?.timestamp) ?? '');
      if (!Number.isFinite(occurredAt)) continue;
      const blocks = asRecord(entry?.message)?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const tool = asRecord(block);
        if (tool?.type !== 'tool_use' || tool.name !== 'Bash') continue;
        const input = asRecord(tool.input);
        const command = asString(input?.command);
        if (!command) continue;
        const description = asString(input?.description)?.slice(0, 160);
        for (const invocation of parseCodexCliInvocations(command)) {
          evidence.push({
            projectHash,
            sessionId,
            occurredAt,
            kind: invocation.kind === 'direct' ? 'direct' : 'wrapper',
            ...(invocation.kind === 'direct'
              ? { workingDir: this.normalizeDeclaredWorkingDir(invocation.workingDir), description }
              : { label: invocation.label, description }),
          });
        }
      }
    }
    return evidence;
  }

  private normalizeDeclaredWorkingDir(workingDir: string | undefined): string | undefined {
    if (!workingDir) return undefined;
    if (workingDir === '~') return homedir();
    if (workingDir.startsWith('~/')) return normalize(join(homedir(), workingDir.slice(2)));
    return workingDir.startsWith('/') ? normalize(workingDir) : undefined;
  }

  private findDirectLaunchEvidence(rollout: CodexRolloutContext): CodexLaunchEvidence | undefined {
    const startedAt = Date.parse(rollout.startedAt ?? '');
    if (!Number.isFinite(startedAt)) return undefined;
    const rolloutCwd = normalize(rollout.cwd);
    const candidates = this.launchEvidence.filter((evidence) => {
      if (evidence.kind !== 'direct') return false;
      if (Math.abs(evidence.occurredAt - startedAt) > DIRECT_CORRELATION_WINDOW_MS) return false;
      return !evidence.workingDir || evidence.workingDir === rolloutCwd;
    });
    candidates.sort((left, right) => {
      const leftCwdPenalty = left.workingDir === rolloutCwd ? 0 : 1;
      const rightCwdPenalty = right.workingDir === rolloutCwd ? 0 : 1;
      if (leftCwdPenalty !== rightCwdPenalty) return leftCwdPenalty - rightCwdPenalty;
      return Math.abs(left.occurredAt - startedAt) - Math.abs(right.occurredAt - startedAt);
    });
    return candidates[0];
  }

  private async ensureDirectoryWatcher(dir: string): Promise<void> {
    if (this.dirWatchers.has(dir)) return;
    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) return;
    } catch {
      return;
    }

    const watcher = chokidarWatch(dir, { depth: 0, ignoreInitial: false });
    const queueIfDispatch = (filePath: string) => {
      if (DISPATCH_FILE_PATTERN.test(basename(filePath))) void this.queueFile(filePath);
    };
    watcher.on('add', queueIfDispatch);
    watcher.on('change', queueIfDispatch);
    watcher.on('error', (error) =>
      this.emit('subagent:error', error instanceof Error ? error : new Error(String(error)))
    );
    this.dirWatchers.set(dir, watcher);
  }

  private queueFile(filePath: string): Promise<void> {
    const prior = this.fileQueues.get(filePath) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this.processFile(filePath))
      .catch((error: unknown) => {
        this.emit('subagent:error', error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (this.fileQueues.get(filePath) === next) this.fileQueues.delete(filePath);
      });
    this.fileQueues.set(filePath, next);
    return next;
  }

  private async processFile(filePath: string): Promise<void> {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }
    if (!fileStat.isFile()) return;

    let cursor = this.cursors.get(filePath);
    if (!cursor) {
      if (this.now() - fileStat.mtimeMs > this.startupMaxAgeMs) return;
      const match = basename(filePath).match(DISPATCH_FILE_PATTERN);
      if (!match?.[1]) return;
      cursor = {
        filePath,
        label: match[1],
        position: 0,
        carry: Buffer.alloc(0),
        pendingLines: [],
        runStartedAt: fileStat.mtimeMs,
        lastMtimeMs: fileStat.mtimeMs,
      };
      this.cursors.set(filePath, cursor);
    } else if (fileStat.size !== cursor.position || fileStat.mtimeMs !== cursor.lastMtimeMs) {
      const prefixThreadId = await this.readDispatchThreadId(filePath);
      if (fileStat.size < cursor.position || (prefixThreadId && prefixThreadId !== cursor.threadId)) {
        this.resetCursor(cursor, fileStat.mtimeMs, true);
      }
      cursor.lastMtimeMs = fileStat.mtimeMs;
    }

    const isInitialReplay = cursor.position === 0 && cursor.agentId === undefined;
    const newLines = await this.readNewLines(cursor, fileStat.size);
    for (const line of newLines) {
      const event = parseJsonLine(line);
      const threadId = event?.type === 'thread.started' ? asString(event.thread_id) : undefined;
      if (threadId && THREAD_ID_PATTERN.test(threadId)) {
        if (cursor.threadId && cursor.threadId !== threadId) {
          this.resetCursor(cursor, fileStat.mtimeMs, false);
        }
        cursor.threadId = threadId;
      }
      if (cursor.agentId) {
        if (event) this.processEvent(event, cursor.agentId, fileStat.size, fileStat.mtimeMs);
      } else if (cursor.pendingLines.length < MAX_PENDING_LINES) {
        cursor.pendingLines.push(line);
      }
    }

    if (!cursor.agentId && cursor.threadId) {
      const info = await this.createAgent(cursor, fileStat.mtimeMs, fileStat.size);
      if (info) {
        cursor.agentId = info.agentId;
        for (const line of cursor.pendingLines) {
          const event = parseJsonLine(line);
          if (event) this.processEvent(event, info.agentId, fileStat.size, fileStat.mtimeMs, !isInitialReplay);
        }
        cursor.pendingLines = [];
      }
    }
  }

  private async scanNativeRollouts(): Promise<void> {
    const paths: string[] = [];
    for (const dir of await this.rolloutDirectories()) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)) paths.push(join(dir, entry.name));
      }
    }
    await Promise.all(paths.map((filePath) => this.processNativeRollout(filePath)));
  }

  /**
   * Every sessions root to search: the default `~/.codex/sessions`, any roots
   * given outright, plus `<child>/sessions` for each child of a CODEX_HOME glob
   * root.
   *
   * A Codex CLI launched from a script or tool call typically gets its own
   * CODEX_HOME, so its rollouts never appear under the default root. Worker
   * homes are created per dispatch and cannot be enumerated ahead of time, hence
   * scanning the parent rather than requiring each one to be configured.
   */
  private async sessionsRoots(): Promise<string[]> {
    const roots = new Set<string>([this.codexSessionsDir, ...this.extraCodexSessionsDirs]);
    for (const globRoot of this.codexHomeGlobRoots) {
      let children: string[];
      try {
        children = await readdir(globRoot);
      } catch {
        continue; // Root absent on this machine — not an error.
      }
      for (const child of children) roots.add(join(globRoot, child, 'sessions'));
    }
    return Array.from(roots);
  }

  /** Date-partitioned subdirectories (`<root>/<Y>/<M>/<D>`) for one sessions root. */
  private datePartitions(root: string, at: number): string[] {
    const directories = new Set<string>();
    for (let offset = -2; offset <= 1; offset++) {
      const date = new Date(at + offset * 24 * 60 * 60 * 1000);
      const local = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
      const utc = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
      for (const [year, month, day] of [local, utc]) {
        directories.add(join(root, String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')));
      }
    }
    return Array.from(directories);
  }

  private async rolloutDirectories(): Promise<string[]> {
    const roots = await this.sessionsRoots();
    const now = this.now();
    return roots.flatMap((root) => this.datePartitions(root, now));
  }

  private async processNativeRollout(filePath: string): Promise<void> {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }
    if (!fileStat.isFile()) return;

    let cursor = this.nativeCursors.get(filePath);
    if (!cursor) {
      if (this.now() - fileStat.mtimeMs > this.startupMaxAgeMs) return;
      const context = await this.readRolloutContext(filePath);
      if (!context) return;
      cursor = {
        filePath,
        position: 0,
        carry: Buffer.alloc(0),
        threadId: context.threadId,
        context,
        lastMtimeMs: fileStat.mtimeMs,
      };
      this.nativeCursors.set(filePath, cursor);
    }

    const agentId = `codex-${cursor.threadId}`;
    if (this.agentFormats.get(agentId) === 'dispatch') return;
    if (fileStat.size < cursor.position) {
      cursor.position = 0;
      cursor.carry = Buffer.alloc(0);
    }
    cursor.lastMtimeMs = fileStat.mtimeMs;

    if (!cursor.agentId) {
      const existing = this.agents.get(agentId);
      if (existing && this.agentFormats.get(agentId) === 'rollout') {
        cursor.agentId = agentId;
      } else {
        const directEvidence = this.findDirectLaunchEvidence(cursor.context);
        const scratchpadParent = parseClaudeScratchpadContext(cursor.context.cwd);
        // A worker running under its own CODEX_HOME was started by tooling, and
        // that is enough on its own. Requiring a Claude parent excluded the
        // common pipeline shape: a worker launched from a script with the REPO
        // as its cwd (not a /tmp/claude-*/…/scratchpad path) and no launch
        // invocation in any Claude transcript. Such a worker has no parent
        // conversation to attribute to, so it is keyed by its working directory
        // and the panel attributes it to the session rooted there.
        const parent = scratchpadParent ?? directEvidence ?? this.workerHomeParent(filePath, cursor.context.cwd);
        if (!parent) return;
        const info: SubagentInfo = {
          agentId,
          sessionId: parent.sessionId,
          projectHash: parent.projectHash,
          filePath,
          startedAt: cursor.context.startedAt ?? new Date(fileStat.birthtimeMs || fileStat.mtimeMs).toISOString(),
          lastActivityAt: fileStat.mtimeMs,
          status: 'active',
          toolCallCount: 0,
          entryCount: 0,
          fileSize: fileStat.size,
          description:
            directEvidence?.description ??
            this.workerHomeLabel(filePath) ??
            `codex exec (${basename(cursor.context.cwd) || 'worker'})`,
          model: cursor.context.model ?? 'codex',
          modelShort: 'codex',
          workingDir: cursor.context.cwd,
          provider: 'codex',
          source: 'script',
          providerSessionId: cursor.threadId,
          canKill: false,
        };
        cursor.agentId = agentId;
        this.agents.set(agentId, info);
        this.agentFormats.set(agentId, 'rollout');
        this.emit('subagent:discovered', info);
      }
    }

    const isInitialReplay = cursor.position === 0;
    const newLines = await this.readNewLines(cursor, fileStat.size);
    for (const line of newLines) {
      const event = parseJsonLine(line);
      if (event && cursor.agentId) {
        this.processNativeEvent(event, cursor.agentId, fileStat.size, fileStat.mtimeMs, !isInitialReplay);
      }
    }
  }

  private async readNewLines(cursor: FileLineCursor, fileSize: number): Promise<string[]> {
    if (fileSize <= cursor.position) return [];
    const length = fileSize - cursor.position;
    const buffer = Buffer.alloc(length);
    const handle = await open(cursor.filePath, 'r');
    try {
      await handle.read(buffer, 0, length, cursor.position);
    } finally {
      await handle.close();
    }
    cursor.position = fileSize;

    const combined = cursor.carry.length > 0 ? Buffer.concat([cursor.carry, buffer]) : buffer;
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== 0x0a) continue;
      const end = i > start && combined[i - 1] === 0x0d ? i - 1 : i;
      lines.push(combined.subarray(start, end).toString('utf8'));
      start = i + 1;
    }
    cursor.carry = combined.subarray(start);
    return lines;
  }

  private async createAgent(
    cursor: DispatchFileCursor,
    lastActivityAt: number,
    fileSize: number
  ): Promise<SubagentInfo | undefined> {
    const threadId = cursor.threadId;
    if (!threadId) return undefined;
    const rollout = await this.resolveRollout(threadId, cursor.runStartedAt);
    if (!rollout) return undefined;

    const rolloutStartedAt = rollout.startedAt ? Date.parse(rollout.startedAt) : Number.NaN;
    const correlationAt = Number.isFinite(rolloutStartedAt) ? rolloutStartedAt : cursor.runStartedAt;
    const parent =
      parseClaudeScratchpadContext(rollout.cwd) ??
      (await this.findParentFromDispatchTranscript(cursor.label, correlationAt));
    if (!parent) return undefined;

    const agentId = `codex-${threadId}`;
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.lastActivityAt = lastActivityAt;
      existing.fileSize = fileSize;
      if (this.agentFormats.get(agentId) === 'rollout') {
        existing.filePath = cursor.filePath;
        existing.description = cursor.label;
        existing.entryCount = 0;
        existing.toolCallCount = 0;
        this.pendingToolCalls.delete(agentId);
        this.agentFormats.set(agentId, 'dispatch');
      }
      return existing;
    }

    const info: SubagentInfo = {
      agentId,
      sessionId: parent.sessionId,
      projectHash: parent.projectHash,
      filePath: cursor.filePath,
      startedAt: rollout.startedAt ?? new Date(cursor.runStartedAt).toISOString(),
      lastActivityAt,
      status: 'active',
      toolCallCount: 0,
      entryCount: 0,
      fileSize,
      description: cursor.label,
      model: rollout.model ?? 'codex',
      modelShort: 'codex',
      workingDir: rollout.cwd,
      provider: 'codex',
      source: 'script',
      providerSessionId: threadId,
      canKill: false,
    };
    this.agents.set(agentId, info);
    this.agentFormats.set(agentId, 'dispatch');
    this.emit('subagent:discovered', info);
    return info;
  }

  private processEvent(
    event: JsonRecord,
    agentId: string,
    fileSize: number,
    activityAt: number,
    emitDetails: boolean = true
  ): void {
    const info = this.agents.get(agentId);
    if (!info) return;
    const timestamp = new Date(activityAt).toISOString();
    info.lastActivityAt = Math.max(info.lastActivityAt, activityAt);
    info.fileSize = fileSize;
    info.entryCount++;
    if (info.status === 'idle') {
      info.status = 'active';
      this.emit('subagent:updated', info);
    }

    const type = asString(event.type);
    if (type === 'turn.started') {
      info.status = 'active';
      this.emit('subagent:updated', info);
      return;
    }

    const item = asRecord(event.item);
    if ((type === 'item.started' || type === 'item.completed') && item) {
      this.processItem(type, item, info, timestamp, emitDetails);
      return;
    }

    if (type === 'turn.completed') {
      const usage = asRecord(event.usage);
      if (usage) {
        info.totalInputTokens = asNumber(usage.input_tokens) ?? info.totalInputTokens;
        info.totalOutputTokens = asNumber(usage.output_tokens) ?? info.totalOutputTokens;
      }
      this.completeAgent(agentId);
      return;
    }

    if (type === 'turn.failed' || type === 'error') {
      if (emitDetails) {
        this.emitMessage(info, timestamp, asString(event.message) ?? asString(event.error) ?? 'Codex worker failed');
      }
      this.completeAgent(agentId);
    }
  }

  private processNativeEvent(
    event: JsonRecord,
    agentId: string,
    fileSize: number,
    fallbackActivityAt: number,
    emitDetails: boolean
  ): void {
    const info = this.agents.get(agentId);
    if (!info || this.agentFormats.get(agentId) !== 'rollout') return;
    const parsedActivityAt = Date.parse(asString(event.timestamp) ?? '');
    const activityAt = Number.isFinite(parsedActivityAt) ? parsedActivityAt : fallbackActivityAt;
    const timestamp = new Date(activityAt).toISOString();
    info.lastActivityAt = Math.max(info.lastActivityAt, activityAt);
    info.fileSize = fileSize;
    info.entryCount++;

    const payload = asRecord(event.payload);
    if (!payload) return;
    if (event.type === 'event_msg') {
      const eventType = asString(payload.type);
      if (eventType === 'task_started') {
        if (info.status !== 'active') {
          info.status = 'active';
          this.emit('subagent:updated', info);
        }
        return;
      }
      if (eventType === 'token_count') {
        const total = asRecord(asRecord(payload.info)?.total_token_usage);
        if (total) {
          info.totalInputTokens = asNumber(total.input_tokens) ?? info.totalInputTokens;
          info.totalOutputTokens = asNumber(total.output_tokens) ?? info.totalOutputTokens;
        }
        return;
      }
      if (eventType === 'task_complete') {
        this.completeAgent(agentId);
        return;
      }
      if (eventType === 'task_failed' || eventType === 'turn_aborted' || eventType === 'stream_error') {
        if (emitDetails) this.emitMessage(info, timestamp, asString(payload.message) ?? 'Codex worker failed');
        this.completeAgent(agentId);
      }
      return;
    }

    if (event.type !== 'response_item') return;
    const payloadType = asString(payload.type);
    const callId = asString(payload.call_id) ?? asString(payload.id) ?? `${payloadType}-${info.entryCount}`;
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const toolCall = this.nativeToolCallFromPayload(payload, info, timestamp, callId);
      if (!toolCall) return;
      info.toolCallCount++;
      let pending = this.pendingToolCalls.get(agentId);
      if (!pending) {
        pending = new Map();
        this.pendingToolCalls.set(agentId, pending);
      }
      pending.set(callId, { tool: toolCall.tool, timestamp: activityAt });
      if (emitDetails) this.emit('subagent:tool_call', toolCall);
      return;
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const pending = this.pendingToolCalls.get(agentId)?.get(callId);
      if (!pending) return;
      this.pendingToolCalls.get(agentId)?.delete(callId);
      const output = this.nativeOutputText(payload);
      const toolResult: SubagentToolResult = {
        agentId,
        sessionId: info.sessionId,
        timestamp,
        toolUseId: callId,
        tool: pending.tool,
        preview: output.slice(0, MESSAGE_TEXT_LIMIT),
        contentLength: output.length,
        isError: this.nativeOutputIsError(payload),
      };
      if (emitDetails) this.emit('subagent:tool_result', toolResult);
      return;
    }

    if (payloadType === 'message' && payload.role === 'assistant') {
      const text = this.nativeMessageText(payload);
      if (text && emitDetails) this.emitMessage(info, timestamp, text);
    }
  }

  private nativeToolCallFromPayload(
    payload: JsonRecord,
    info: SubagentInfo,
    timestamp: string,
    callId: string
  ): SubagentToolCall | undefined {
    const name = asString(payload.name);
    if (!name) return undefined;
    const rawInput = payload.arguments ?? payload.input;
    let input = asRecord(rawInput);
    if (!input && typeof rawInput === 'string') {
      input = parseJsonLine(rawInput) ?? { input: rawInput };
    }
    input ??= {};
    const patch = nativePatchText(payload);
    const normalizedInput = patch ? { patch } : input;
    const tool = patch ? 'Edit' : name === 'exec_command' ? 'Bash' : name === 'apply_patch' ? 'Edit' : name;
    return {
      agentId: info.agentId,
      sessionId: info.sessionId,
      timestamp,
      tool,
      input: normalizedInput,
      fullInput: normalizedInput,
      toolUseId: callId,
    };
  }

  private nativeMessageText(payload: JsonRecord): string {
    const content = payload.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => asString(asRecord(block)?.text) ?? '')
      .filter(Boolean)
      .join('\n');
  }

  private nativeOutputText(payload: JsonRecord): string {
    const output = payload.output;
    if (typeof output === 'string') return output;
    if (output === undefined) return '';
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private nativeOutputIsError(payload: JsonRecord): boolean {
    if (payload.status === 'failed') return true;
    const output = asRecord(payload.output);
    const exitCode = asNumber(output?.exit_code);
    return exitCode !== undefined && exitCode !== 0;
  }

  private processItem(
    eventType: string,
    item: JsonRecord,
    info: SubagentInfo,
    timestamp: string,
    emitDetails: boolean
  ): void {
    const itemType = asString(item.type) ?? '';
    const itemId = asString(item.id) ?? `${itemType}-${info.entryCount}`;

    if (eventType === 'item.started') {
      const toolCall = this.toolCallFromItem(itemType, item, info, timestamp, itemId);
      if (toolCall) {
        info.toolCallCount++;
        let pending = this.pendingToolCalls.get(info.agentId);
        if (!pending) {
          pending = new Map();
          this.pendingToolCalls.set(info.agentId, pending);
        }
        pending.set(itemId, { tool: toolCall.tool, timestamp: this.now() });
        if (emitDetails) this.emit('subagent:tool_call', toolCall);
      }
      return;
    }

    if (itemType === 'agent_message') {
      const text = asString(item.text);
      if (text && emitDetails) this.emitMessage(info, timestamp, text);
      return;
    }

    if (itemType === 'error') {
      const message = asString(item.message);
      if (message && emitDetails) this.emitMessage(info, timestamp, message);
      return;
    }

    const pending = this.pendingToolCalls.get(info.agentId)?.get(itemId);
    if (!pending) return;
    this.pendingToolCalls.get(info.agentId)?.delete(itemId);
    const result = this.resultText(itemType, item);
    const status = asString(item.status);
    const exitCode = asNumber(item.exit_code);
    const toolResult: SubagentToolResult = {
      agentId: info.agentId,
      sessionId: info.sessionId,
      timestamp,
      toolUseId: itemId,
      tool: pending.tool,
      preview: result.slice(0, MESSAGE_TEXT_LIMIT),
      contentLength: result.length,
      isError: status === 'failed' || (exitCode !== undefined && exitCode !== 0),
    };
    if (emitDetails) this.emit('subagent:tool_result', toolResult);
  }

  private toolCallFromItem(
    itemType: string,
    item: JsonRecord,
    info: SubagentInfo,
    timestamp: string,
    itemId: string
  ): SubagentToolCall | undefined {
    let tool: string;
    let input: Record<string, unknown>;
    if (itemType === 'command_execution') {
      tool = 'Bash';
      input = { command: asString(item.command) ?? '' };
    } else if (itemType === 'file_change') {
      tool = 'Edit';
      const patch = asString(item.patch);
      input = {
        changes: Array.isArray(item.changes) ? item.changes : [],
        ...(patch ? { patch } : {}),
      };
    } else if (itemType === 'mcp_tool_call') {
      tool = asString(item.tool) ?? asString(item.name) ?? 'MCP';
      input = asRecord(item.arguments) ?? {};
    } else if (itemType === 'web_search') {
      tool = 'WebSearch';
      input = { query: asString(item.query) ?? '' };
    } else {
      return undefined;
    }
    return {
      agentId: info.agentId,
      sessionId: info.sessionId,
      timestamp,
      tool,
      input,
      fullInput: input,
      toolUseId: itemId,
    };
  }

  private resultText(itemType: string, item: JsonRecord): string {
    if (itemType === 'command_execution') return asString(item.aggregated_output) ?? '';
    if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes
        .map((change) => {
          const record = asRecord(change);
          return record ? `${asString(record.kind) ?? 'changed'} ${asString(record.path) ?? ''}`.trim() : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return asString(item.result) ?? asString(item.output) ?? asString(item.error) ?? '';
  }

  private emitMessage(info: SubagentInfo, timestamp: string, text: string): void {
    const message: SubagentMessage = {
      agentId: info.agentId,
      sessionId: info.sessionId,
      timestamp,
      role: 'assistant',
      text: text.slice(0, MESSAGE_TEXT_LIMIT),
    };
    this.emit('subagent:message', message);
  }

  private completeAgent(agentId: string): void {
    const info = this.agents.get(agentId);
    if (!info || info.status === 'completed') return;
    info.status = 'completed';
    info.pid = undefined;
    this.pendingToolCalls.delete(agentId);
    this.emit('subagent:completed', info);
  }

  private refreshIdleStatuses(): void {
    const now = this.now();
    for (const info of this.agents.values()) {
      if (info.status === 'active' && now - info.lastActivityAt >= IDLE_TIMEOUT_MS) {
        info.status = 'idle';
        this.emit('subagent:updated', info);
      }
    }
  }

  private removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.agentFormats.delete(agentId);
    this.pendingToolCalls.delete(agentId);
  }

  private resetCursor(cursor: DispatchFileCursor, runStartedAt: number, rewind: boolean): void {
    if (cursor.agentId) this.completeAgent(cursor.agentId);
    if (rewind) cursor.position = 0;
    cursor.carry = Buffer.alloc(0);
    cursor.pendingLines = [];
    cursor.threadId = undefined;
    cursor.agentId = undefined;
    cursor.runStartedAt = runStartedAt;
  }

  private async readDispatchThreadId(filePath: string): Promise<string | undefined> {
    const prefix = await this.readPrefix(filePath, DISPATCH_PREFIX_BYTES);
    for (const line of prefix.split('\n')) {
      const event = parseJsonLine(line);
      const threadId = event?.type === 'thread.started' ? asString(event.thread_id) : undefined;
      if (threadId && THREAD_ID_PATTERN.test(threadId)) return threadId;
    }
    return undefined;
  }

  private async readRolloutContext(filePath: string): Promise<CodexRolloutContext | undefined> {
    const fileThreadId = basename(filePath).match(ROLLOUT_FILE_PATTERN)?.[1];
    const prefix = await this.readPrefix(filePath, ROLLOUT_PREFIX_BYTES);
    let threadId = fileThreadId;
    let cwd: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let isExec = false;

    for (const line of prefix.split('\n')) {
      const entry = parseJsonLine(line);
      if (!entry) continue;
      const payload = asRecord(entry.payload);
      if (entry.type === 'session_meta' && payload) {
        threadId = asString(payload.id) ?? asString(payload.session_id) ?? threadId;
        cwd = asString(payload.cwd);
        startedAt = asString(entry.timestamp) ?? asString(payload.timestamp);
        const originator = asString(payload.originator);
        const source = asRecord(payload.source);
        isExec = originator === 'codex_exec' || asString(source?.type) === 'exec' || payload.source === 'exec';
      } else if (entry.type === 'turn_context' && payload) {
        model = asString(payload.model) ?? model;
      }
    }

    // `isExec` distinguishes a scripted `codex exec` run from the user's own
    // interactive Codex session, which must NOT be surfaced as a subagent.
    //
    // But dispatch tooling also drives interactive TUI workers from a script
    // (`tmux new-session -e CODEX_HOME=<worker-home> codex ... -C <repo>`), and
    // those report originator "codex-tui" / source "cli" — indistinguishable
    // from a hand-run session by originator alone. What does distinguish them is
    // the dedicated CODEX_HOME: a rollout living under a worker home was created
    // by tooling, never by the user's own `codex` in a terminal.
    const isManagedWorker = !isExec && this.isWorkerHomeRollout(filePath);
    if (!threadId || !THREAD_ID_PATTERN.test(threadId) || !cwd || !(isExec || isManagedWorker)) {
      return undefined;
    }
    return { threadId, filePath, cwd, model, startedAt };
  }

  /**
   * The worker's own name, taken from its CODEX_HOME directory.
   *
   * Dispatch tooling names each home after the job (`luna1-envfix`), which is far
   * more useful in the panel than a generic "codex exec (<repo>)" — and for a
   * TUI worker that label would be wrong anyway, since it is not an exec run.
   */
  private workerHomeLabel(filePath: string): string | undefined {
    for (const root of this.codexHomeGlobRoots) {
      if (!filePath.startsWith(`${root}/`)) continue;
      const name = filePath.slice(root.length + 1).split('/')[0];
      if (name) return name;
    }
    return undefined;
  }

  /**
   * Synthetic parent for a tooling-launched worker with no Claude conversation.
   *
   * `sessionId` normally carries the parent conversation id; here there is none,
   * so the worker's own thread identity is used. Attribution to a Codeman
   * session then happens on `workingDir`, which the panel already prefers when a
   * conversation id matches nothing (the restored-session case).
   */
  private workerHomeParent(filePath: string, cwd: string): ClaudeParentContext | undefined {
    if (!this.isWorkerHomeRollout(filePath)) return undefined;
    return { projectHash: projectHashForDir(cwd), sessionId: `codex-worker:${basename(cwd) || 'worker'}` };
  }

  /**
   * True when a rollout lives under a per-worker CODEX_HOME rather than the
   * user's own Codex home.
   *
   * Deliberately keyed on the CODEX_HOME glob roots and explicitly-named extra
   * roots only — never on "not the default root". A plain extra sessions
   * directory is just another place rollouts live and carries no evidence that
   * tooling created them, so treating it as tooling-owned would admit the user's
   * own interactive sessions.
   */
  private isWorkerHomeRollout(filePath: string): boolean {
    if (filePath.startsWith(`${this.codexSessionsDir}/`)) return false;
    return [...this.codexHomeGlobRoots, ...this.extraCodexSessionsDirs].some((root) => filePath.startsWith(`${root}/`));
  }

  private async resolveRollout(threadId: string, startedAt: number): Promise<CodexRolloutContext | undefined> {
    const candidates = new Set<string>();
    for (const root of await this.sessionsRoots()) {
      for (const dir of this.datePartitions(root, startedAt)) candidates.add(dir);
    }

    for (const dir of candidates) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      const name = files.find((file) => file.endsWith(`-${threadId}.jsonl`));
      if (!name) continue;
      const filePath = join(dir, name);
      const context = await this.readRolloutContext(filePath);
      if (context?.threadId === threadId) return context;
    }
    return undefined;
  }

  private async readPrefix(filePath: string, maxBytes: number): Promise<string> {
    const fileStat = await stat(filePath);
    const length = Math.min(fileStat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, 'r');
    try {
      await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }
    return buffer.toString('utf8');
  }

  private async findParentFromDispatchTranscript(
    label: string,
    runStartedAt: number
  ): Promise<ClaudeParentContext | undefined> {
    return this.launchEvidence
      .filter(
        (evidence) =>
          evidence.kind === 'wrapper' &&
          evidence.label === label &&
          Math.abs(evidence.occurredAt - runStartedAt) <= DISPATCH_CORRELATION_WINDOW_MS
      )
      .sort((left, right) => Math.abs(left.occurredAt - runStartedAt) - Math.abs(right.occurredAt - runStartedAt))[0];
  }

  private async readTail(filePath: string, maxBytes: number): Promise<string> {
    const fileStat = await stat(filePath);
    const length = Math.min(fileStat.size, maxBytes);
    const start = Math.max(0, fileStat.size - length);
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, 'r');
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }

  private async nativePatchesForDispatch(agentId: string, events: JsonRecord[]): Promise<Map<string, string>> {
    const info = this.agents.get(agentId);
    const threadId = info?.providerSessionId;
    if (!info || !threadId) return new Map();

    const cursor = Array.from(this.nativeCursors.values()).find((candidate) => candidate.threadId === threadId);
    const rollout = cursor?.context ?? (await this.resolveRollout(threadId, Date.parse(info.startedAt)));
    if (!rollout) return new Map();

    try {
      const fileStat = await stat(rollout.filePath);
      let candidates =
        cursor?.patchCache?.size === fileStat.size && cursor.patchCache.mtimeMs === fileStat.mtimeMs
          ? cursor.patchCache.candidates
          : undefined;
      if (!candidates) {
        const content = await this.readTail(rollout.filePath, NATIVE_PATCH_INDEX_BYTES);
        candidates = nativePatchCandidates(content);
        if (cursor) cursor.patchCache = { size: fileStat.size, mtimeMs: fileStat.mtimeMs, candidates };
      }
      return correlateNativePatches(events, candidates);
    } catch {
      return new Map();
    }
  }

  private toNativeTranscriptEntry(event: JsonRecord, info: SubagentInfo): SubagentTranscriptEntry | undefined {
    if (event.type !== 'response_item') return undefined;
    const payload = asRecord(event.payload);
    if (!payload) return undefined;
    const timestamp = asString(event.timestamp) ?? new Date(info.lastActivityAt).toISOString();
    const payloadType = asString(payload.type);

    if (payloadType === 'message' && payload.role === 'assistant') {
      const text = this.nativeMessageText(payload);
      if (!text) return undefined;
      return {
        type: 'assistant',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: { role: 'assistant', content: text },
      };
    }

    const callId = asString(payload.call_id) ?? asString(payload.id) ?? payloadType ?? 'tool';
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const toolCall = this.nativeToolCallFromPayload(payload, info, timestamp, callId);
      if (!toolCall) return undefined;
      return {
        type: 'assistant',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: toolCall.tool, id: callId, input: toolCall.fullInput }],
        },
      };
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      return {
        type: 'user',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: callId,
              content: this.nativeOutputText(payload),
              is_error: this.nativeOutputIsError(payload),
            },
          ],
        },
      };
    }
    return undefined;
  }

  private toTranscriptEntry(event: JsonRecord, info: SubagentInfo): SubagentTranscriptEntry | undefined {
    const item = asRecord(event.item);
    if (!item) return undefined;
    const timestamp = new Date(info.lastActivityAt).toISOString();
    const itemType = asString(item.type) ?? '';
    const itemId = asString(item.id) ?? itemType;
    if (itemType === 'agent_message' || itemType === 'error') {
      const text = asString(item.text) ?? asString(item.message);
      if (!text) return undefined;
      return {
        type: 'assistant',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: { role: 'assistant', content: text },
      };
    }
    if (event.type === 'item.started') {
      const toolCall = this.toolCallFromItem(itemType, item, info, timestamp, itemId);
      if (!toolCall) return undefined;
      return {
        type: 'assistant',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: toolCall.tool, id: itemId, input: toolCall.fullInput }],
        },
      };
    }
    if (event.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(itemType)) {
      return {
        type: 'user',
        timestamp,
        agentId: info.agentId,
        sessionId: info.sessionId,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: itemId,
              content: this.resultText(itemType, item),
              is_error: asString(item.status) === 'failed',
            },
          ],
        },
      };
    }
    return undefined;
  }
}

export const codexDispatchWatcher = new CodexDispatchWatcher();
