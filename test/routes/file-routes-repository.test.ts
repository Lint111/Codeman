/**
 * @fileoverview Repository-aware File Viewer route tests.
 *
 * Uses app.inject() with a real temporary Git repository; no HTTP port needed.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { discoverGitRepository } from '../../src/git-repository-browser.js';
import { subagentWatcher } from '../../src/subagent-watcher.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

describe('file-routes repository browsing', () => {
  let fixtureRoot: string;
  let repositoryRoot: string;
  let harness: RouteTestHarness;
  let savedMultiUser: string | undefined;
  let savedUserSpaces: string | undefined;
  let savedEditorBinary: string | undefined;
  let savedEditorCapture: string | undefined;
  let editorCapture: string;

  beforeEach(async () => {
    savedMultiUser = process.env.CODEMAN_MULTIUSER;
    savedUserSpaces = process.env.CODEMAN_USER_SPACES_DIR;
    savedEditorBinary = process.env.CODEMAN_EDITOR_BINARY;
    savedEditorCapture = process.env.CODEMAN_EDITOR_CAPTURE;
    delete process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_USER_SPACES_DIR;
    fixtureRoot = mkdtempSync(join(tmpdir(), 'codeman-file-routes-git-'));
    editorCapture = join(fixtureRoot, 'editor-args.txt');
    const fakeEditor = join(fixtureRoot, 'fake-code.sh');
    writeFileSync(
      fakeEditor,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$CODEMAN_EDITOR_CAPTURE"',
        'has_diff=0',
        'previous=""',
        'last=""',
        'for argument in "$@"; do',
        '  [ "$argument" = "--diff" ] && has_diff=1',
        '  previous="$last"',
        '  last="$argument"',
        'done',
        'if [ "$has_diff" = "1" ]; then',
        '  cp "$previous" "$CODEMAN_EDITOR_CAPTURE.before"',
        '  cp "$last" "$CODEMAN_EDITOR_CAPTURE.after"',
        'fi',
      ].join('\n')
    );
    chmodSync(fakeEditor, 0o755);
    process.env.CODEMAN_EDITOR_BINARY = fakeEditor;
    process.env.CODEMAN_EDITOR_CAPTURE = editorCapture;
    repositoryRoot = join(fixtureRoot, 'repository');
    mkdirSync(repositoryRoot);
    mkdirSync(join(repositoryRoot, 'src'));
    git(repositoryRoot, 'init', '-b', 'main');
    git(repositoryRoot, 'config', 'user.name', 'Codeman Test');
    git(repositoryRoot, 'config', 'user.email', 'codeman@example.invalid');
    writeFileSync(join(repositoryRoot, 'README.md'), 'initial\n');
    writeFileSync(join(repositoryRoot, 'src', 'app.ts'), 'export const initial = true;\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'initial commit');
    writeFileSync(join(repositoryRoot, 'README.md'), 'initial\nchanged\n');

    harness = await createRouteTestHarness(registerFileRoutes);
    harness.ctx._session.workingDir = join(repositoryRoot, 'src');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.app.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
    if (savedMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMultiUser;
    if (savedUserSpaces === undefined) {
      delete process.env.CODEMAN_USER_SPACES_DIR;
    } else {
      process.env.CODEMAN_USER_SPACES_DIR = savedUserSpaces;
    }
    if (savedEditorBinary === undefined) delete process.env.CODEMAN_EDITOR_BINARY;
    else process.env.CODEMAN_EDITOR_BINARY = savedEditorBinary;
    if (savedEditorCapture === undefined) delete process.env.CODEMAN_EDITOR_CAPTURE;
    else process.env.CODEMAN_EDITOR_CAPTURE = savedEditorCapture;
  });

  async function waitForPath(path: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (existsSync(path)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${path}`);
  }

  it('returns repository metadata and roots the scoped file tree at the worktree', async () => {
    const repositoryResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository?scope=current`,
    });
    expect(repositoryResponse.statusCode).toBe(200);
    const repository = repositoryResponse.json();
    expect(repository).toMatchObject({
      success: true,
      data: {
        available: true,
        repositoryRoot,
      },
    });
    expect(repository.data.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'README.md', status: 'modified' })])
    );

    const filesResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=current&depth=2`,
    });
    const files = filesResponse.json();
    expect(files.success).toBe(true);
    expect(files.data.root).toBe(repositoryRoot);
    expect(files.data.tree).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'README.md', type: 'file' })])
    );
  });

  it('uses the same worktree scope for file content and diff detail', async () => {
    const legacyResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=README.md`,
    });
    expect(legacyResponse.json().success).toBe(false);

    const scopedResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=README.md&scope=current`,
    });
    expect(scopedResponse.json()).toMatchObject({
      success: true,
      data: {
        content: 'initial\nchanged\n',
      },
    });

    const diffResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository/diff?scope=current&path=README.md`,
    });
    expect(diffResponse.json()).toMatchObject({
      success: true,
      data: {
        beforeContent: 'initial\n',
        afterContent: 'initial\nchanged\n',
        additions: 1,
      },
    });
  });

  it('opens the selected worktree in VS Code without a shell command', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/repository/open-editor`,
      payload: { scope: 'current' },
    });

    expect(response.json()).toMatchObject({ success: true, data: { kind: 'workspace' } });
    await waitForPath(editorCapture);
    expect(readFileSync(editorCapture, 'utf8').trim().split('\n')).toEqual(['--reuse-window', repositoryRoot]);
  });

  it('opens the current file change as native before and after VS Code snapshots', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/repository/open-editor`,
      payload: { scope: 'current', path: 'README.md' },
    });

    expect(response.json()).toMatchObject({ success: true, data: { kind: 'diff' } });
    await waitForPath(`${editorCapture}.after`);
    expect(readFileSync(editorCapture, 'utf8')).toContain('--diff\n');
    expect(readFileSync(`${editorCapture}.before`, 'utf8')).toBe('initial\n');
    expect(readFileSync(`${editorCapture}.after`, 'utf8')).toBe('initial\nchanged\n');
  });

  it('rejects host-editor launch for a remote session', async () => {
    Object.defineProperty(harness.ctx._session, 'remote', {
      configurable: true,
      value: { host: 'example.invalid' },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/repository/open-editor`,
      payload: { scope: 'current' },
    });

    // The focused route harness does not install production's status-mapping
    // preSerialization hook; the structured error body is the contract here.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      error: 'Host editor launch is available only for local sessions',
    });
    expect(existsSync(editorCapture)).toBe(false);
  });

  it('rejects a forged worktree scope', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=forged&depth=2`,
    });
    expect(response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('scope not found'),
    });
  });

  it('roots repository browsing at an owned subagent workspace', async () => {
    const agentRepositoryRoot = join(fixtureRoot, 'agent-repository');
    mkdirSync(agentRepositoryRoot);
    git(agentRepositoryRoot, 'init', '-b', 'agent-work');
    git(agentRepositoryRoot, 'config', 'user.name', 'Codeman Test');
    git(agentRepositoryRoot, 'config', 'user.email', 'codeman@example.invalid');
    writeFileSync(join(agentRepositoryRoot, 'agent.txt'), 'subagent workspace\n');
    git(agentRepositoryRoot, 'add', 'agent.txt');
    git(agentRepositoryRoot, 'commit', '-m', 'agent workspace');

    vi.spyOn(subagentWatcher, 'getSubagent').mockReturnValue({
      agentId: 'agent-owned',
      sessionId: harness.ctx._sessionId,
      projectHash: subagentWatcher.getProjectHashForDir(harness.ctx._session.workingDir),
      filePath: '/tmp/agent-owned.jsonl',
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 1,
      fileSize: 1,
      workingDir: agentRepositoryRoot,
    });

    const repositoryResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository?scope=current&agentId=agent-owned`,
    });
    expect(repositoryResponse.json()).toMatchObject({
      success: true,
      data: {
        available: true,
        repositoryRoot: agentRepositoryRoot,
      },
    });

    const filesResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=current&agentId=agent-owned&depth=2`,
    });
    expect(filesResponse.json()).toMatchObject({
      success: true,
      data: {
        root: agentRepositoryRoot,
        tree: expect.arrayContaining([expect.objectContaining({ name: 'agent.txt', type: 'file' })]),
      },
    });
  });

  it('accepts the full conversation ID behind a restored session alias', async () => {
    harness.ctx._session.id = 'restored-7148e9de';
    vi.spyOn(subagentWatcher, 'getSubagent').mockReturnValue({
      agentId: 'agent-restored',
      sessionId: '7148e9de-7673-48b8-bf38-6799e52c346a',
      projectHash: subagentWatcher.getProjectHashForDir(harness.ctx._session.workingDir),
      filePath: '/tmp/agent-restored.jsonl',
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 1,
      fileSize: 1,
      workingDir: repositoryRoot,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=current&agentId=agent-restored&depth=2`,
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        root: repositoryRoot,
        tree: expect.arrayContaining([expect.objectContaining({ name: 'README.md', type: 'file' })]),
      },
    });
  });

  it('rejects a subagent workspace from another parent session in the same project', async () => {
    vi.spyOn(subagentWatcher, 'getSubagent').mockReturnValue({
      agentId: 'agent-foreign',
      sessionId: 'other-session',
      projectHash: subagentWatcher.getProjectHashForDir(harness.ctx._session.workingDir),
      filePath: '/tmp/agent-foreign.jsonl',
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 1,
      fileSize: 1,
      workingDir: fixtureRoot,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?scope=current&agentId=agent-foreign&depth=2`,
    });
    expect(response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('does not belong to this session'),
    });
  });

  it('filters and rejects linked worktrees outside a regular user workspace', async () => {
    const userSpaces = join(fixtureRoot, 'user-spaces');
    const allowedRoot = join(userSpaces, 'alice', 'cases', 'allowed-repository');
    const outsideRoot = join(fixtureRoot, 'outside-worktree');
    mkdirSync(allowedRoot, { recursive: true });
    git(allowedRoot, 'init', '-b', 'main');
    git(allowedRoot, 'config', 'user.name', 'Codeman Test');
    git(allowedRoot, 'config', 'user.email', 'codeman@example.invalid');
    writeFileSync(join(allowedRoot, 'README.md'), 'allowed\n');
    git(allowedRoot, 'add', 'README.md');
    git(allowedRoot, 'commit', '-m', 'allowed root');
    git(allowedRoot, 'worktree', 'add', '-b', 'outside', outsideRoot);
    writeFileSync(join(outsideRoot, 'secret.txt'), 'outside secret\n');

    process.env.CODEMAN_MULTIUSER = '1';
    process.env.CODEMAN_USER_SPACES_DIR = userSpaces;
    await harness.app.close();
    harness = await createRouteTestHarness(registerFileRoutes, {
      authUser: { username: 'alice', role: 'user' },
    });
    harness.ctx._session.workingDir = allowedRoot;
    harness.ctx._session.owner = 'alice';

    const discovery = await discoverGitRepository(allowedRoot);
    const outsideScope = discovery?.worktrees.find((worktree) => worktree.path === outsideRoot);
    expect(outsideScope).toBeDefined();

    const overviewResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/repository?scope=current`,
    });
    const overview = overviewResponse.json();
    expect(overview.success).toBe(true);
    expect(overview.data.worktrees).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: outsideRoot })])
    );

    const filesResponse = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?depth=1&scope=` + encodeURIComponent(outsideScope!.id),
    });
    expect(filesResponse.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('outside the allowed workspace'),
    });

    const diffResponse = await harness.app.inject({
      method: 'GET',
      url:
        `/api/sessions/${harness.ctx._sessionId}/repository/diff?path=secret.txt&scope=` +
        encodeURIComponent(outsideScope!.id),
    });
    expect(diffResponse.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('outside the allowed workspace'),
    });
  });
});
