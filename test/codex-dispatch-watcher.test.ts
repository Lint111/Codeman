/**
 * Integration tests for script-dispatched Codex worker discovery.
 *
 * Uses synthetic dispatch artifacts, Codex rollouts, and Claude transcripts in
 * isolated temp directories. No real user sessions or global worker files are
 * read or modified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodexDispatchWatcher,
  parseClaudeScratchpadContext,
  parseCodexDispatchInvocation,
} from '../src/codex-dispatch-watcher.js';
import { CompositeSubagentWatcher } from '../src/composite-subagent-watcher.js';
import type { SubagentInfo } from '../src/subagent-watcher.js';

const PROJECT_HASH = '-home-liory-Github-undertow';
const PARENT_SESSION_ID = '7148e9de-7673-48b8-bf38-6799e52c346a';
const THREAD_ID = '019fbeae-5a9f-73b3-95c4-3a178a376f6e';

describe('CodexDispatchWatcher', () => {
  let root: string;
  let dispatchDir: string;
  let sessionsDir: string;
  let projectsDir: string;
  let now: number;
  let watcher: CodexDispatchWatcher;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeman-codex-dispatch-'));
    dispatchDir = join(root, 'dispatch');
    sessionsDir = join(root, 'codex-sessions');
    projectsDir = join(root, 'claude-projects');
    now = Date.now();
    await mkdir(dispatchDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    watcher = new CodexDispatchWatcher({
      dispatchDirs: [dispatchDir],
      codexSessionsDir: sessionsDir,
      // Pin to none: the built-in default is a real host path
      // (/tmp/csd-workers/homes), so leaving it unset makes these tests discover
      // whatever Codex workers happen to be running on the developer's machine.
      codexHomeGlobRoots: [],
      claudeProjectsDir: projectsDir,
      now: () => now,
    });
  });

  afterEach(async () => {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function writeRollout(
    threadId: string,
    cwd: string,
    originator = 'codex_exec',
    events: object[] = []
  ): Promise<string> {
    const date = new Date(now);
    const dir = join(
      sessionsDir,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    );
    await mkdir(dir, { recursive: true });
    const lines = [
      {
        timestamp: new Date(now).toISOString(),
        type: 'session_meta',
        payload: { id: threadId, cwd, originator, source: 'exec' },
      },
      { timestamp: new Date(now).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    ];
    const filePath = join(dir, `rollout-2026-08-01T00-00-00-${threadId}.jsonl`);
    await writeFile(filePath, `${[...lines, ...events].map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    return filePath;
  }

  it('parses the established dispatch command and Claude scratchpad path', () => {
    const command =
      'CODEX_REPO="$S/board-wt" nohup bash ~/scripts/codex-dispatch.sh "$S/codex-board-brief.md" board > launch.log 2>&1 &';
    expect(parseCodexDispatchInvocation(command)).toEqual({
      brief: '$S/codex-board-brief.md',
      label: 'board',
    });
    expect(
      parseClaudeScratchpadContext(`/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/board-wt`)
    ).toEqual({ projectHash: PROJECT_HASH, sessionId: PARENT_SESSION_ID });
  });

  it('discovers a script worker and streams only newly appended activity', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/board-wt`;
    await writeRollout(THREAD_ID, cwd);
    const rawPath = join(dispatchDir, 'codex-board.jsonl');
    await writeFile(
      rawPath,
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n${JSON.stringify({
        type: 'turn.started',
      })}\n`,
      'utf8'
    );

    const discovered = vi.fn<(info: SubagentInfo) => void>();
    const toolCall = vi.fn();
    const toolResult = vi.fn();
    const message = vi.fn();
    const completed = vi.fn();
    watcher.on('subagent:discovered', discovered);
    watcher.on('subagent:tool_call', toolCall);
    watcher.on('subagent:tool_result', toolResult);
    watcher.on('subagent:message', message);
    watcher.on('subagent:completed', completed);

    await watcher.scanNow();

    expect(discovered).toHaveBeenCalledTimes(1);
    expect(toolCall).not.toHaveBeenCalled();
    const info = discovered.mock.calls[0][0];
    expect(info).toMatchObject({
      agentId: `codex-${THREAD_ID}`,
      sessionId: PARENT_SESSION_ID,
      projectHash: PROJECT_HASH,
      description: 'board',
      model: 'gpt-5.6-sol',
      modelShort: 'codex',
      provider: 'codex',
      source: 'script',
      providerSessionId: THREAD_ID,
      canKill: false,
      workingDir: cwd,
      status: 'active',
    });

    const appended = [
      {
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'git status', status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'git status',
          aggregated_output: 'clean',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Work complete.' } },
      { type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } },
    ];
    await appendFile(rawPath, `${appended.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    now += 1000;
    await watcher.scanNow();

    expect(toolCall).toHaveBeenCalledTimes(1);
    expect(toolCall.mock.calls[0][0]).toMatchObject({
      agentId: `codex-${THREAD_ID}`,
      sessionId: PARENT_SESSION_ID,
      tool: 'Bash',
      toolUseId: 'item_1',
      input: { command: 'git status' },
    });
    expect(toolResult).toHaveBeenCalledTimes(1);
    expect(toolResult.mock.calls[0][0]).toMatchObject({ toolUseId: 'item_1', preview: 'clean', isError: false });
    expect(message.mock.calls[0][0]).toMatchObject({ role: 'assistant', text: 'Work complete.' });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(watcher.getSubagent(`codex-${THREAD_ID}`)).toMatchObject({
      status: 'completed',
      toolCallCount: 1,
      totalInputTokens: 1200,
      totalOutputTokens: 80,
    });

    const transcript = await watcher.getTranscript(`codex-${THREAD_ID}`);
    expect(transcript).toHaveLength(3);
    expect(transcript.map((entry) => entry.type)).toEqual(['assistant', 'user', 'assistant']);
    const composite = new CompositeSubagentWatcher([watcher]);
    expect(composite.formatTranscript(transcript)).toContainEqual(expect.stringContaining('result: clean'));
  });

  // The SSE initial-state payload that populates the subagents panel is built
  // from subagentWatcher.getRecentSubagents(15), and subagentWatcher is a
  // CompositeSubagentWatcher over [claudeSubagentWatcher, codexDispatchWatcher]
  // (subagent-watcher.ts:1906) — so this filter decides whether a Codex CLI
  // dispatch is visible in the panel at all. The frontend never back-fills from
  // /api/subagents.
  //
  // `idle` here does NOT mean finished: refreshIdleStatuses() demotes a live
  // agent from 'active' to 'idle' purely on an activity timeout, and
  // completeAgent() is the only path to 'completed'. A quiet-but-running Codex
  // worker must therefore survive the window, exactly as on the Claude side.
  // Measured on this machine: three Codex workers running in
  // /home/liory/Github/undertow, launched by the codex-dispatch tooling as
  //   tmux new-session -e CODEX_HOME=/tmp/csd-workers/homes/<worker> codex ... -C <repo>
  // Their rollouts land under $CODEX_HOME/sessions/<Y>/<M>/<D>/, NOT ~/.codex,
  // and their session_meta reads originator "codex-tui" / source "cli" because
  // they are interactive TUI sessions rather than `codex exec` runs.
  //
  // Both facts independently hid them from the panel.
  describe('workers under a custom CODEX_HOME', () => {
    /** Rollout written to an ALTERNATE sessions root, as a worker home does. */
    async function writeRolloutIn(
      root: string,
      threadId: string,
      cwd: string,
      originator: string,
      source: string
    ): Promise<string> {
      const date = new Date(now);
      const dir = join(
        root,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      );
      await mkdir(dir, { recursive: true });
      const lines = [
        {
          timestamp: new Date(now).toISOString(),
          type: 'session_meta',
          payload: { id: threadId, cwd, originator, source },
        },
        { timestamp: new Date(now).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      ];
      const filePath = join(dir, `rollout-2026-08-08T21-27-54-${threadId}.jsonl`);
      await writeFile(filePath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
      return filePath;
    }

    it('discovers an interactive TUI worker in an extra sessions root', async () => {
      const workerHome = join(root, 'csd-workers', 'homes', 'luna1-envfix', 'sessions');
      const repo = '/home/liory/Github/undertow';
      const threadId = '019fe2a1-aeab-7b91-a29e-84e2f489f267';
      await writeRolloutIn(workerHome, threadId, repo, 'codex-tui', 'cli');

      const scoped = new CodexDispatchWatcher({
        dispatchDirs: [dispatchDir],
        codexSessionsDir: sessionsDir,
        extraCodexSessionsDirs: [workerHome],
        codexHomeGlobRoots: [], // do not inherit the real host default
        claudeProjectsDir: projectsDir,
        now: () => now,
      });
      try {
        await scoped.scanNow();

        const found = scoped.getSubagents();
        expect(found).toHaveLength(1);
        // cwd is the repo, which is how it attributes to the undertow session.
        expect(found[0]).toMatchObject({ workingDir: repo, provider: 'codex' });
      } finally {
        scoped.stop();
      }
    });

    it('discovers worker homes from a glob root without naming each worker', async () => {
      // Worker homes are created per dispatch, so the roots cannot be enumerated
      // ahead of time — a directory pattern is the only workable configuration.
      const homes = join(root, 'csd-workers', 'homes');
      const repo = '/home/liory/Github/undertow';
      await writeRolloutIn(
        join(homes, 'luna1', 'sessions'),
        '019fe2a1-aeab-7b91-a29e-84e2f489f267',
        repo,
        'codex-tui',
        'cli'
      );
      await writeRolloutIn(
        join(homes, 'luna2', 'sessions'),
        '019fe2a1-cf25-7c33-bdb6-36a35f91d9dc',
        repo,
        'codex-tui',
        'cli'
      );

      const scoped = new CodexDispatchWatcher({
        dispatchDirs: [dispatchDir],
        codexSessionsDir: sessionsDir,
        codexHomeGlobRoots: [homes],
        claudeProjectsDir: projectsDir,
        now: () => now,
      });
      try {
        await scoped.scanNow();

        expect(scoped.getSubagents()).toHaveLength(2);
      } finally {
        scoped.stop();
      }
    });

    it('labels a worker with its CODEX_HOME name, not "codex exec"', async () => {
      // Tooling names each home after the job (luna1-envfix), which beats a
      // generic "codex exec (undertow)" — and for a TUI worker that label is
      // wrong anyway, since it is not an exec run. All workers in one repo would
      // otherwise be indistinguishable in the panel.
      const homes = join(root, 'csd-workers', 'homes');
      await writeRolloutIn(
        join(homes, 'luna1-envfix', 'sessions'),
        '019fe2a1-aeab-7b91-a29e-84e2f489f267',
        '/home/liory/Github/undertow',
        'codex-tui',
        'cli'
      );

      const scoped = new CodexDispatchWatcher({
        dispatchDirs: [dispatchDir],
        codexSessionsDir: sessionsDir,
        codexHomeGlobRoots: [homes],
        claudeProjectsDir: projectsDir,
        now: () => now,
      });
      try {
        await scoped.scanNow();

        expect(scoped.getSubagents()[0].description).toBe('luna1-envfix');
      } finally {
        scoped.stop();
      }
    });
  });

  it('keeps running and recently-quiet workers but ages out long-dead idle ones', () => {
    const agents = (watcher as unknown as { agents: Map<string, Partial<SubagentInfo>> }).agents;
    agents.set('codex-running', {
      agentId: 'codex-running',
      status: 'active',
      lastActivityAt: now - 6 * 60 * 60 * 1000, // active but quiet 6h — still running
    });
    agents.set('codex-thinking', {
      agentId: 'codex-thinking',
      status: 'idle',
      lastActivityAt: now - 5 * 60 * 1000, // 5m — a plausible gap between tool calls
    });
    agents.set('codex-long-dead', {
      agentId: 'codex-long-dead',
      status: 'idle',
      lastActivityAt: now - 3 * 60 * 60 * 1000, // 3h — not coming back
    });
    agents.set('codex-done-new', { agentId: 'codex-done-new', status: 'completed', lastActivityAt: now });

    const ids = watcher.getRecentSubagents(15).map((agent) => agent.agentId);

    expect(ids).toContain('codex-running');
    expect(ids).toContain('codex-thinking');
    // Without this bound the panel fills with hours-old runs: cleanupNow only
    // reaps idle workers after STALE_IDLE_MAX_AGE_MS (4h).
    expect(ids).not.toContain('codex-long-dead');
    expect(ids).toContain('codex-done-new');
  });

  it('surfaces a live Codex worker through the composite watcher', () => {
    // server.ts calls getRecentSubagents on the COMPOSITE, so the liveness rule
    // has to survive the merge — applying it only to the Claude watcher would
    // leave Codex dispatches ageing out of the panel after 15 minutes.
    const agents = (watcher as unknown as { agents: Map<string, Partial<SubagentInfo>> }).agents;
    agents.set('codex-running', {
      agentId: 'codex-running',
      status: 'active',
      lastActivityAt: now - 6 * 60 * 60 * 1000,
    });

    const composite = new CompositeSubagentWatcher([watcher]);

    expect(composite.getRecentSubagents(15).map((a) => a.agentId)).toContain('codex-running');
  });

  it('enriches wrapper file-change rows with the full native Codex patch', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/patch-wt`;
    const filePath = `${cwd}/src/example.ts`;
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      '-export const value = 1;',
      '+export const value = 2;',
      '*** End Patch',
    ].join('\n');
    await writeRollout(THREAD_ID, cwd, 'codex_exec', [
      {
        timestamp: new Date(now + 10).toISOString(),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'native-patch',
          input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`,
        },
      },
    ]);
    await writeFile(
      join(dispatchDir, 'codex-patch.jsonl'),
      `${[
        { type: 'thread.started', thread_id: THREAD_ID },
        {
          type: 'item.started',
          item: { id: 'item_patch', type: 'file_change', changes: [{ path: filePath, kind: 'update' }] },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_patch',
            type: 'file_change',
            changes: [{ path: filePath, kind: 'update' }],
            status: 'completed',
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
      'utf8'
    );

    await watcher.scanNow();

    const transcript = await watcher.getTranscript(`codex-${THREAD_ID}`);
    expect(transcript[0].message?.content).toEqual([
      {
        type: 'tool_use',
        name: 'Edit',
        id: 'item_patch',
        input: { changes: [{ path: filePath, kind: 'update' }], patch },
      },
    ]);
  });

  it('aligns repeated-file patches without letting a failed native attempt skip wrapper edits', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/retry-wt`;
    const firstPath = `${cwd}/src/first.ts`;
    const secondPath = `${cwd}/src/second.ts`;
    const makePatch = (path: string, before: string, after: string) =>
      ['*** Begin Patch', `*** Update File: ${path}`, '@@', `-${before}`, `+${after}`, '*** End Patch'].join('\n');
    const firstPatch = makePatch(firstPath, 'first-0', 'first-1');
    const secondPatch = makePatch(secondPath, 'second-0', 'second-1');
    const failedRetry = makePatch(firstPath, 'missing-context', 'never-applied');
    const finalPatch = makePatch(firstPath, 'first-1', 'first-2');
    const nativeCall = (callId: string, patch: string, offset: number) => ({
      timestamp: new Date(now + offset).toISOString(),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: callId,
        input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`,
      },
    });
    await writeRollout(THREAD_ID, cwd, 'codex_exec', [
      nativeCall('first', firstPatch, 10),
      nativeCall('second', secondPatch, 20),
      nativeCall('failed-retry', failedRetry, 30),
      nativeCall('final', finalPatch, 40),
    ]);

    const wrapperEvents: object[] = [{ type: 'thread.started', thread_id: THREAD_ID }];
    for (const [id, path] of [
      ['item_first', firstPath],
      ['item_second', secondPath],
      ['item_final', firstPath],
    ]) {
      const item = { id, type: 'file_change', changes: [{ path, kind: 'update' }] };
      wrapperEvents.push(
        { type: 'item.started', item },
        { type: 'item.completed', item: { ...item, status: 'completed' } }
      );
    }
    await writeFile(
      join(dispatchDir, 'codex-retry.jsonl'),
      `${wrapperEvents.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8'
    );

    await watcher.scanNow();

    const transcript = await watcher.getTranscript(`codex-${THREAD_ID}`);
    const patches = transcript
      .filter((entry) => entry.type === 'assistant')
      .map((entry) => {
        const content = Array.isArray(entry.message?.content) ? entry.message.content[0] : undefined;
        return content?.type === 'tool_use' ? content.input?.patch : undefined;
      });
    expect(patches).toEqual([firstPatch, secondPatch, finalPatch]);
  });

  it('replaces a reused label with the new Codex thread even when the file regrows', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/board-wt`;
    await writeRollout(THREAD_ID, cwd);
    const rawPath = join(dispatchDir, 'codex-board.jsonl');
    await writeFile(
      rawPath,
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n${JSON.stringify({ type: 'turn.completed' })}\n`,
      'utf8'
    );
    await watcher.scanNow();

    const nextThreadId = '019fbeae-5a9f-73b3-95c4-3a178a376f70';
    now += 1000;
    await writeRollout(nextThreadId, cwd);
    await writeFile(
      rawPath,
      `${JSON.stringify({ type: 'thread.started', thread_id: nextThreadId })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'new run' } })}\n`,
      'utf8'
    );
    await watcher.scanNow();

    expect(watcher.getSubagent(`codex-${THREAD_ID}`)?.status).toBe('completed');
    expect(watcher.getSubagent(`codex-${nextThreadId}`)).toMatchObject({ status: 'active', description: 'board' });
  });

  it('rewinds dispatch cursors when watcher state is cleared', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/board-wt`;
    await writeRollout(THREAD_ID, cwd);
    await writeFile(
      join(dispatchDir, 'codex-board.jsonl'),
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`,
      'utf8'
    );
    await watcher.scanNow();

    expect(watcher.clearAll()).toBe(1);
    expect(watcher.getSubagents()).toEqual([]);
    await watcher.scanNow();

    expect(watcher.getSubagent(`codex-${THREAD_ID}`)).toBeDefined();
  });

  it('falls back to a parent transcript dispatch invocation outside a scratchpad cwd', async () => {
    await writeRollout(THREAD_ID, '/home/liory/Github/undertow-worktree');
    const projectDir = join(projectsDir, PROJECT_HASH);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${PARENT_SESSION_ID}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command:
                  'nohup bash /home/liory/scripts/codex-dispatch.sh /tmp/worker-brief.md worker-a > /tmp/launch.log 2>&1 &',
              },
            },
          ],
        },
      })}\n`,
      'utf8'
    );
    await writeFile(
      join(dispatchDir, 'codex-worker-a.jsonl'),
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`,
      'utf8'
    );

    await watcher.scanNow();

    expect(watcher.getSubagent(`codex-${THREAD_ID}`)).toMatchObject({
      sessionId: PARENT_SESSION_ID,
      projectHash: PROJECT_HASH,
      workingDir: '/home/liory/Github/undertow-worktree',
    });
  });

  it('ignores exec rollouts that cannot be tied to a Claude dispatch', async () => {
    await writeRollout(THREAD_ID, '/home/liory/personal-codex-session');
    await writeFile(
      join(dispatchDir, 'codex-unowned.jsonl'),
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`,
      'utf8'
    );

    await watcher.scanNow();

    expect(watcher.getSubagents()).toEqual([]);
  });

  it('discovers a direct background Codex CLI call from its native rollout', async () => {
    const cwd = '/home/liory/Github/undertow-direct-worker';
    const rolloutPath = await writeRollout(THREAD_ID, cwd, 'codex_exec', [
      {
        timestamp: new Date(now + 10).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started' },
      },
      {
        timestamp: new Date(now + 20).toISOString(),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'git status' }),
        },
      },
      {
        timestamp: new Date(now + 30).toISOString(),
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'clean' },
      },
      {
        timestamp: new Date(now + 40).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Direct worker complete.' }],
        },
      },
      {
        timestamp: new Date(now + 50).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 900, output_tokens: 75 } },
        },
      },
      {
        timestamp: new Date(now + 60).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ]);
    const projectDir = join(projectsDir, PROJECT_HASH);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${PARENT_SESSION_ID}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-direct',
              name: 'Bash',
              input: {
                command: `nohup codex exec --json -C ${cwd} "audit this" >worker.log 2>&1 &`,
                description: 'Audit direct worker',
                run_in_background: true,
              },
            },
          ],
        },
      })}\n`,
      'utf8'
    );

    const discovered = vi.fn<(info: SubagentInfo) => void>();
    watcher.on('subagent:discovered', discovered);
    await watcher.scanNow();

    expect(discovered).toHaveBeenCalledTimes(1);
    expect(watcher.getSubagent(`codex-${THREAD_ID}`)).toMatchObject({
      sessionId: PARENT_SESSION_ID,
      projectHash: PROJECT_HASH,
      filePath: rolloutPath,
      workingDir: cwd,
      description: 'Audit direct worker',
      status: 'completed',
      toolCallCount: 1,
      totalInputTokens: 900,
      totalOutputTokens: 75,
      provider: 'codex',
      source: 'script',
    });
    const transcript = await watcher.getTranscript(`codex-${THREAD_ID}`);
    expect(transcript.map((entry) => entry.message?.content)).toEqual([
      [{ type: 'tool_use', name: 'Bash', id: 'call-1', input: { cmd: 'git status' } }],
      [{ type: 'tool_result', tool_use_id: 'call-1', content: 'clean', is_error: false }],
      'Direct worker complete.',
    ]);
  });

  it('attributes a Codex CLI call launched from a Claude subagent to its lead session', async () => {
    const cwd = '/home/liory/Github/subagent-worker';
    await writeRollout(THREAD_ID, cwd);
    const subagentsDir = join(projectsDir, PROJECT_HASH, PARENT_SESSION_ID, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      join(subagentsDir, 'agent-worker.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-subagent-direct',
              name: 'Bash',
              input: { command: `codex exec -C ${cwd} "review this"` },
            },
          ],
        },
      })}\n`,
      'utf8'
    );

    await watcher.scanNow();

    expect(watcher.getSubagent(`codex-${THREAD_ID}`)).toMatchObject({
      sessionId: PARENT_SESSION_ID,
      projectHash: PROJECT_HASH,
      workingDir: cwd,
    });
  });

  it('streams activity appended to a direct worker native rollout', async () => {
    const cwd = '/home/liory/Github/live-direct-worker';
    const rolloutPath = await writeRollout(THREAD_ID, cwd, 'codex_exec', [
      {
        timestamp: new Date(now).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started' },
      },
    ]);
    const projectDir = join(projectsDir, PROJECT_HASH);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${PARENT_SESSION_ID}.jsonl`),
      `${JSON.stringify({
        timestamp: new Date(now).toISOString(),
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: `codex exec -C ${cwd} "live task"` },
            },
          ],
        },
      })}\n`,
      'utf8'
    );
    const toolCall = vi.fn();
    const toolResult = vi.fn();
    const message = vi.fn();
    const completed = vi.fn();
    watcher.on('subagent:tool_call', toolCall);
    watcher.on('subagent:tool_result', toolResult);
    watcher.on('subagent:message', message);
    watcher.on('subagent:completed', completed);
    await watcher.scanNow();

    expect(toolCall).not.toHaveBeenCalled();
    now += 1000;
    await appendFile(
      rolloutPath,
      `${[
        {
          timestamp: new Date(now).toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'live-call',
            arguments: JSON.stringify({ cmd: 'npm test' }),
          },
        },
        {
          timestamp: new Date(now + 10).toISOString(),
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'live-call', output: 'passed' },
        },
        {
          timestamp: new Date(now + 20).toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Finished live work.' }],
          },
        },
        {
          timestamp: new Date(now + 30).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_complete' },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
      'utf8'
    );

    await watcher.scanNow();

    expect(toolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'Bash', toolUseId: 'live-call' }));
    expect(toolResult).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Bash', toolUseId: 'live-call', preview: 'passed', isError: false })
    );
    expect(message).toHaveBeenCalledWith(expect.objectContaining({ text: 'Finished live work.' }));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('does not duplicate a wrapper worker through its native rollout', async () => {
    const cwd = `/tmp/claude-1000/${PROJECT_HASH}/${PARENT_SESSION_ID}/scratchpad/board-wt`;
    await writeRollout(THREAD_ID, cwd);
    await writeFile(
      join(dispatchDir, 'codex-board.jsonl'),
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`,
      'utf8'
    );
    const discovered = vi.fn<(info: SubagentInfo) => void>();
    watcher.on('subagent:discovered', discovered);

    await watcher.scanNow();

    expect(discovered).toHaveBeenCalledTimes(1);
    expect(watcher.getSubagents()).toHaveLength(1);
    expect(watcher.getSubagent(`codex-${THREAD_ID}`)?.filePath).toBe(join(dispatchDir, 'codex-board.jsonl'));
  });
});
