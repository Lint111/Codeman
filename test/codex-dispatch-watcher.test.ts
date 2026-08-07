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
