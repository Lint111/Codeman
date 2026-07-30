/**
 * Repository-aware File Viewer browser tests.
 *
 * Port 3211 is reserved in helpers/constants.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';

const PORT = PORTS.FILE_VIEWER;
const BASE_URL = `http://localhost:${PORT}`;

describe('Mobile File Viewer', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let page: Page;
  let context: BrowserContext;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  beforeEach(async () => {
    const result = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    page = result.page;
    context = result.context;
  });

  afterEach(async () => {
    await page
      .evaluate(() => {
        const testWindow = window as typeof window & {
          __fileViewerOriginalFetch?: typeof window.fetch;
        };
        if (testWindow.__fileViewerOriginalFetch) {
          window.fetch = testWindow.__fileViewerOriginalFetch;
          delete testWindow.__fileViewerOriginalFetch;
        }
        if (app.fileBrowserAutoRefreshTimer) {
          clearInterval(app.fileBrowserAutoRefreshTimer);
          app.fileBrowserAutoRefreshTimer = null;
        }
        app.closeFilePreview();
      })
      .catch(() => {});
    await context.close();
  });

  it('keeps a rapid tab switch on the new session and defaults to its worktree root', async () => {
    const state = await page.evaluate(async () => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;

      const repository = (session: string) => ({
        success: true,
        data: {
          available: true,
          repositoryRoot: `/repos/${session}`,
          selectedScopeId: `${session}-current`,
          worktrees: [
            {
              id: `${session}-current`,
              path: `/repos/${session}`,
              name: session,
              branch: 'main',
              head: 'a'.repeat(40),
              current: true,
              main: true,
              locked: false,
            },
            {
              id: `${session}-sibling`,
              path: `/worktrees/${session}-feature`,
              name: `${session}-feature`,
              branch: 'feature/mobile',
              head: 'b'.repeat(40),
              current: false,
              main: false,
              locked: false,
            },
          ],
          changes: [],
          commits: [],
        },
      });
      const files = (session: string) => ({
        success: true,
        data: {
          root: `/repos/${session}`,
          tree: [
            {
              name: `${session}.txt`,
              path: `${session}.txt`,
              type: 'file',
              size: 12,
              extension: 'txt',
            },
          ],
          totalFiles: 1,
          totalDirectories: 0,
          truncated: false,
        },
      });

      window.fetch = async (input) => {
        const url = String(input);
        const session = url.includes('session-a') ? 'session-a' : 'session-b';
        await new Promise((resolve) => setTimeout(resolve, session === 'session-a' ? 100 : 5));
        const payload = url.includes('/repository?') ? repository(session) : files(session);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.fileBrowserData = null;
      app.fileBrowserSessionId = null;
      app.fileBrowserView = 'files';
      app.activeSessionId = 'session-a';
      const firstLoad = app.loadFileBrowser('session-a');
      app.activeSessionId = 'session-b';
      const secondLoad = app.loadFileBrowser('session-b');
      await Promise.allSettled([firstLoad, secondLoad]);

      const scope = document.getElementById('fileBrowserScope') as HTMLSelectElement;
      return {
        sessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        root: app.fileBrowserData?.root,
        treeText: document.getElementById('fileBrowserTree')?.textContent,
        scopeOptions: Array.from(scope.options).map((option) => option.textContent),
        selectedScope: scope.value,
      };
    });

    expect(state).toMatchObject({
      sessionId: 'session-b',
      scopeId: 'session-b-current',
      root: '/repos/session-b',
      selectedScope: 'session-b-current',
    });
    expect(state.treeText).toContain('session-b.txt');
    expect(state.treeText).not.toContain('session-a.txt');
    expect(state.scopeOptions).toHaveLength(2);
    expect(state.scopeOptions[0]).toContain('(root)');
    expect(state.scopeOptions[1]).toContain('(worktree)');
  });

  it('updates repository ownership immediately when switching sessions with the viewer open or closed', async () => {
    const state = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const originalLoadFileBrowser = app.loadFileBrowser;
      const loads: string[] = [];

      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/terminal?')) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const sessionId = url.split('/')[3];
          return new Response(
            JSON.stringify({
              data: {
                terminalBuffer: `${sessionId} ready`,
                truncated: false,
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        return originalFetch(input, init);
      };
      app.loadFileBrowser = async (sessionId: string) => {
        loads.push(sessionId);
      };

      for (const sessionId of ['file-view-a', 'file-view-b']) {
        app.sessions.set(sessionId, {
          id: sessionId,
          name: sessionId,
          mode: 'shell',
          status: 'idle',
          pid: 1,
          workingDir: `/repos/${sessionId}`,
        });
      }
      app.sessionOrder = ['file-view-a', 'file-view-b'];
      app._initialFullBufferLoad = false;
      app.activeSessionId = 'file-view-a';
      app.fileBrowserSessionId = 'file-view-a';
      app.fileBrowserScopeId = 'file-view-a-scope';

      const panel = document.getElementById('fileBrowserPanel')!;
      panel.classList.add('visible');
      const settings = app.loadAppSettingsFromStorage();
      settings.showFileBrowser = true;
      app.saveAppSettingsToStorage(settings);

      const openSwitch = app.selectSession('file-view-b');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const openState = {
        activeSessionId: app.activeSessionId,
        fileBrowserSessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        loads: [...loads],
      };
      await openSwitch;

      panel.classList.remove('visible');
      settings.showFileBrowser = false;
      app.saveAppSettingsToStorage(settings);
      app.fileBrowserSessionId = 'file-view-b';
      app.fileBrowserScopeId = 'file-view-b-scope';

      const closedSwitch = app.selectSession('file-view-a');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const closedState = {
        activeSessionId: app.activeSessionId,
        fileBrowserSessionId: app.fileBrowserSessionId,
        scopeId: app.fileBrowserScopeId,
        loads: [...loads],
      };
      await closedSwitch;

      window.fetch = originalFetch;
      app.loadFileBrowser = originalLoadFileBrowser;

      return { openState, closedState };
    });

    expect(state.openState).toMatchObject({
      activeSessionId: 'file-view-b',
      fileBrowserSessionId: 'file-view-b',
      scopeId: 'current',
      loads: ['file-view-b'],
    });
    expect(state.closedState).toMatchObject({
      activeSessionId: 'file-view-a',
      fileBrowserSessionId: 'file-view-a',
      scopeId: 'current',
      loads: ['file-view-b'],
    });
  });

  it('follows a selected subagent workspace and restores the parent session context', async () => {
    const state = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const requests: string[] = [];
      window.fetch = async (input) => {
        const url = String(input);
        requests.push(url);
        const viewingAgent = url.includes('agentId=agent-feature');
        const root = viewingAgent ? '/worktrees/agent-feature' : '/repos/parent';
        const scopeId = viewingAgent ? 'agent-current' : 'parent-current';
        const payload = url.includes('/repository?')
          ? {
              success: true,
              data: {
                available: true,
                repositoryRoot: root,
                selectedScopeId: scopeId,
                worktrees: [
                  {
                    id: scopeId,
                    path: root,
                    name: viewingAgent ? 'agent-feature' : 'parent',
                    branch: viewingAgent ? 'feature/agent' : 'main',
                    head: 'a'.repeat(40),
                    current: true,
                    main: true,
                    locked: false,
                  },
                ],
                changes: [],
                commits: [],
              },
            }
          : {
              success: true,
              data: {
                root,
                tree: [],
                totalFiles: 0,
                totalDirectories: 0,
                truncated: false,
              },
            };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.sessions.set('restored-7148e9de', {
        id: 'restored-7148e9de',
        claudeSessionId: 'restored-7148e9de',
        name: 'Parent',
        mode: 'claude',
        status: 'idle',
        pid: 1,
        workingDir: '/repos/parent',
      });
      app.subagents.set('agent-feature', {
        agentId: 'agent-feature',
        sessionId: '7148e9de-7673-48b8-bf38-6799e52c346a',
        description: 'Feature worker',
        workingDir: '/worktrees/agent-feature',
        status: 'active',
        toolCallCount: 0,
        entryCount: 1,
        fileSize: 1,
      });
      app.subagentParentMap.delete('agent-feature');
      app.activeSessionId = 'restored-7148e9de';
      app.fileBrowserSessionId = 'restored-7148e9de';
      app.fileBrowserAgentId = null;
      document.getElementById('fileBrowserPanel')?.classList.add('visible');

      await app.selectSubagent('agent-feature');
      const agentState = {
        agentId: app.fileBrowserAgentId,
        root: app.fileBrowserData?.root,
        rootLabel: document.getElementById('fileBrowserRoot')?.textContent,
        editHidden: (document.getElementById('fileBrowserWorkingDirectoryBtn') as HTMLElement)?.hidden,
        requests: [...requests],
      };

      requests.length = 0;
      await app.focusFileBrowserSession('restored-7148e9de');
      const parentState = {
        agentId: app.fileBrowserAgentId,
        root: app.fileBrowserData?.root,
        workingDir: app.sessions.get('restored-7148e9de')?.workingDir,
        requests: [...requests],
      };

      window.fetch = originalFetch;
      return { agentState, parentState };
    });

    expect(state.agentState).toMatchObject({
      agentId: 'agent-feature',
      root: '/worktrees/agent-feature',
      editHidden: true,
    });
    expect(state.agentState.rootLabel).toContain('Feature worker');
    expect(state.agentState.requests).toHaveLength(2);
    expect(state.agentState.requests.every((url) => url.includes('agentId=agent-feature'))).toBe(true);

    expect(state.parentState).toMatchObject({
      agentId: null,
      root: '/repos/parent',
      workingDir: '/repos/parent',
    });
    expect(state.parentState.requests).toHaveLength(2);
    expect(state.parentState.requests.every((url) => !url.includes('agentId='))).toBe(true);
  });

  it('reassigns the active session work path and reloads the repository at current scope', async () => {
    const state = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const requests: Array<{ url: string; method: string; body?: string }> = [];
      window.fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || 'GET';
        requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
        if (url.endsWith('/working-directory')) {
          return new Response(JSON.stringify({ success: true, data: { workingDir: '/repos/reassigned' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const repository = {
          success: true,
          data: {
            available: true,
            repositoryRoot: '/repos/reassigned',
            selectedScopeId: 'reassigned-current',
            worktrees: [
              {
                id: 'reassigned-current',
                path: '/repos/reassigned',
                name: 'reassigned',
                branch: 'main',
                head: 'a'.repeat(40),
                current: true,
                main: true,
                locked: false,
              },
            ],
            changes: [],
            commits: [],
          },
        };
        const files = {
          success: true,
          data: {
            root: '/repos/reassigned',
            tree: [],
            totalFiles: 0,
            totalDirectories: 0,
            truncated: false,
          },
        };
        return new Response(JSON.stringify(url.includes('/repository?') ? repository : files), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.sessions.set('workdir-session', {
        id: 'workdir-session',
        name: 'Workspace',
        mode: 'claude',
        status: 'idle',
        pid: 1,
        workingDir: '/repos/stale',
      });
      app.activeSessionId = 'workdir-session';
      app.fileBrowserSessionId = 'workdir-session';
      document.getElementById('fileBrowserPanel')?.classList.add('visible');

      app.openFileBrowserWorkingDirectoryEditor();
      const modal = document.getElementById('workingDirectoryModal')!;
      const input = document.getElementById('workingDirectoryInput') as HTMLInputElement;
      const initialValue = input.value;
      input.value = '/repos/reassigned';
      await app.saveFileBrowserWorkingDirectory(new Event('submit'));

      const result = {
        initialValue,
        modalOpen: modal.classList.contains('active'),
        workingDir: app.sessions.get('workdir-session')?.workingDir,
        scopeId: app.fileBrowserScopeId,
        requests,
      };
      window.fetch = originalFetch;
      return result;
    });

    expect(state.initialValue).toBe('/repos/stale');
    expect(state.modalOpen).toBe(false);
    expect(state.workingDir).toBe('/repos/reassigned');
    expect(state.scopeId).toBe('reassigned-current');
    expect(state.requests[0]).toMatchObject({
      url: '/api/sessions/workdir-session/working-directory',
      method: 'PUT',
      body: JSON.stringify({ workingDir: '/repos/reassigned' }),
    });
    expect(state.requests.some((request) => request.url.includes('/repository?scope=current'))).toBe(true);
  });

  it('opens a directory workspace menu on hold while preserving scroll gestures', async () => {
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
        __workspaceRequests?: Array<{ url: string; method: string; body?: string }>;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;
      testWindow.__workspaceRequests = [];
      window.fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || 'GET';
        testWindow.__workspaceRequests?.push({
          url,
          method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (url.endsWith('/working-directory')) {
          return new Response(JSON.stringify({ success: true, data: { workingDir: '/repos/project/src' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const repository = {
          success: true,
          data: {
            available: true,
            repositoryRoot: '/repos/project',
            selectedScopeId: 'project-current',
            worktrees: [
              {
                id: 'project-current',
                path: '/repos/project',
                name: 'project',
                branch: 'main',
                head: 'a'.repeat(40),
                current: true,
                main: true,
                locked: false,
              },
            ],
            changes: [],
            commits: [],
          },
        };
        const files = {
          success: true,
          data: {
            root: '/repos/project/src',
            tree: [],
            totalFiles: 0,
            totalDirectories: 0,
            truncated: false,
          },
        };
        return new Response(JSON.stringify(url.includes('/repository?') ? repository : files), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.sessions.set('workspace-session', {
        id: 'workspace-session',
        claudeSessionId: '6eeaf98a-082f-4d8a-9073-87808600c924',
        name: 'Workspace',
        mode: 'claude',
        status: 'idle',
        pid: 1,
        workingDir: '/repos/project',
      });
      app.activeSessionId = 'workspace-session';
      app.fileBrowserSessionId = 'workspace-session';
      app.fileBrowserScopeId = 'project-current';
      app.fileBrowserData = {
        root: '/repos/project',
        tree: [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            children: [],
          },
        ],
        totalFiles: 0,
        totalDirectories: 1,
        truncated: false,
      };
      document.getElementById('fileBrowserPanel')?.classList.add('visible');
      (document.activeElement as HTMLElement | null)?.blur?.();
      app.renderFileBrowserTree();
    });

    const directory = page.locator('.file-tree-item[data-path="src"]');
    const box = await directory.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + Math.min(24, box!.width / 2);
    const y = box!.y + box!.height / 2;

    await directory.dispatchEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    await directory.dispatchEvent('pointermove', {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y + 20,
    });
    await page.waitForTimeout(550);
    expect(await page.locator('.file-browser-directory-menu').count()).toBe(0);

    await directory.dispatchEvent('pointerdown', {
      pointerId: 8,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    await page.waitForTimeout(550);

    const menu = page.locator('.file-browser-directory-menu');
    await expect.poll(() => menu.isVisible()).toBe(true);
    await page.waitForTimeout(1100);
    await directory.dispatchEvent('pointerup', {
      pointerId: 8,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      cancelable: true,
    });
    await directory.dispatchEvent('click');
    const menuState = await page.evaluate(() => {
      const menuEl = document.querySelector('.file-browser-directory-menu') as HTMLElement;
      const modal = document.getElementById('workingDirectoryModal') as HTMLElement;
      const rect = menuEl.getBoundingClientRect();
      return {
        path: menuEl.querySelector('.file-browser-directory-menu-path')?.textContent,
        expanded: app.fileBrowserExpandedDirs.has('src'),
        menuZ: Number(getComputedStyle(menuEl).zIndex),
        modalZ: Number(getComputedStyle(modal).zIndex),
        activeTag: document.activeElement?.tagName,
        insideViewport:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= document.documentElement.clientWidth &&
          rect.bottom <= document.documentElement.clientHeight,
      };
    });
    expect(menuState).toMatchObject({
      path: '/repos/project/src',
      expanded: false,
      insideViewport: true,
    });
    expect(menuState.menuZ).toBeLessThan(menuState.modalZ);
    expect(['INPUT', 'TEXTAREA']).not.toContain(menuState.activeTag);

    await menu.getByRole('menuitem', { name: 'Set as current workspace' }).click();
    await expect
      .poll(() => page.evaluate(() => app.sessions.get('workspace-session')?.workingDir))
      .toBe('/repos/project/src');

    const result = await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __workspaceRequests?: Array<{ url: string; method: string; body?: string }>;
      };
      return {
        cached: app.getSessionWorkspaceAssignment('6eeaf98a-082f-4d8a-9073-87808600c924'),
        requests: testWindow.__workspaceRequests || [],
      };
    });
    expect(result.cached).toBe('/repos/project/src');
    expect(result.requests[0]).toMatchObject({
      url: '/api/sessions/workspace-session/working-directory',
      method: 'PUT',
      body: JSON.stringify({ workingDir: '/repos/project/src' }),
    });
  });

  it('restores an assigned workspace when a conversation is resumed after reload', async () => {
    const conversationId = 'c49fe0aa-a6f9-46a4-b47d-52a67a782f6c';
    await page.evaluate(
      ({ sessionId }) => {
        const runtimeSession = {
          id: 'old-runtime-session',
          claudeSessionId: 'old-runtime-session',
          name: 'Remembered session',
          mode: 'claude',
          status: 'idle',
          pid: 1,
          workingDir: '/repos/remembered',
        };
        app.sessions.set(runtimeSession.id, runtimeSession);
        app.rememberSessionWorkspaceAssignment(runtimeSession, runtimeSession.workingDir);
        app._onSessionUpdated({ ...runtimeSession, claudeSessionId: sessionId });
      },
      { sessionId: conversationId }
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app?.resumeHistorySession === 'function');

    const state = await page.evaluate(
      async ({ sessionId }) => {
        const originalFetch = window.fetch;
        const originalSelectSession = app.selectSession;
        const originalTerminal = app.terminal;
        const requests: Array<{ url: string; method: string; body?: string }> = [];
        window.fetch = async (input, init) => {
          const url = String(input);
          requests.push({
            url,
            method: init?.method || 'GET',
            body: typeof init?.body === 'string' ? init.body : undefined,
          });
          if (url === '/api/sessions') {
            return new Response(
              JSON.stringify({ success: true, data: { session: { id: 'resumed-runtime-session' } } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };
        app.selectSession = async () => {};
        app.terminal = {
          clear() {},
          writeln() {},
          focus() {},
        };

        try {
          const historyRecord = app.applySessionWorkspaceAssignment({
            sessionId,
            workingDir: '/repos/original',
            sources: ['history'],
          });
          await app.resumeHistorySession(sessionId, '/repos/original', 'Remembered session');
          return {
            cached: app.getSessionWorkspaceAssignment(sessionId),
            historyWorkingDir: historyRecord.workingDir,
            requests,
          };
        } finally {
          window.fetch = originalFetch;
          app.selectSession = originalSelectSession;
          app.terminal = originalTerminal;
        }
      },
      { sessionId: conversationId }
    );

    expect(state.cached).toBe('/repos/remembered');
    expect(state.historyWorkingDir).toBe('/repos/remembered');
    const createRequest = state.requests.find((request) => request.url === '/api/sessions');
    expect(createRequest).toMatchObject({ method: 'POST' });
    expect(JSON.parse(createRequest!.body!)).toMatchObject({
      workingDir: '/repos/remembered',
      name: 'Remembered session',
      resumeSessionId: conversationId,
    });
  });

  it('renders current changes and switches between compact and full diff on a phone', async () => {
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;
      window.fetch = async (input) => {
        const url = String(input);
        if (!url.includes('/repository/diff?')) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              path: 'src/app.ts',
              commit: null,
              label: 'Working tree · src/app.ts',
              patch:
                'diff --git a/src/app.ts b/src/app.ts\n' +
                '--- a/src/app.ts\n' +
                '+++ b/src/app.ts\n' +
                '@@ -1,2 +1,3 @@\n' +
                ' alpha\n' +
                '-old\n' +
                '+new\n' +
                '+extra\n',
              beforeContent: 'alpha\nold\n',
              afterContent: 'alpha\nnew\nextra\n',
              beforeExists: true,
              afterExists: true,
              binary: false,
              truncated: false,
              additions: 2,
              deletions: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      app.activeSessionId = 'diff-session';
      app.fileBrowserSessionId = 'diff-session';
      app.fileBrowserScopeId = 'scope-diff';
      app.fileBrowserRepositoryData = {
        available: true,
        repositoryRoot: '/repo',
        selectedScopeId: 'scope-diff',
        worktrees: [
          {
            id: 'scope-diff',
            path: '/repo',
            name: 'repo',
            branch: 'main',
            head: 'a'.repeat(40),
            current: true,
            main: true,
            locked: false,
          },
        ],
        changes: [
          {
            path: 'src/app.ts',
            code: 'M',
            status: 'modified',
            staged: false,
            unstaged: true,
            additions: 2,
            deletions: 1,
            binary: false,
          },
        ],
        commits: [],
      };
      document.getElementById('fileBrowserPanel')?.classList.add('visible');
      app.switchFileBrowserView('changes');
    });

    await expect.poll(() => page.locator('.repo-change-row').count()).toBe(1);
    await expect.poll(() => page.locator('#fileBrowserChangesCount').textContent()).toBe('1');
    await page.locator('.repo-change-row').click();
    await expect.poll(() => page.locator('.repository-diff').isVisible()).toBe(true);
    await expect.poll(() => page.locator('.repository-diff-line.diff-add').count()).toBe(2);
    await expect.poll(() => page.locator('.repository-diff-line.diff-del').count()).toBe(1);

    await page.locator('.file-preview-mode-btn[data-mode="full"]').click();
    await expect.poll(() => page.locator('.repository-diff-full').isVisible()).toBe(true);
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('alpha');
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('old');
    await expect.poll(() => page.locator('#filePreviewBody').textContent()).toContain('new');

    const bounds = await page.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const panel = document.getElementById('fileBrowserPanel')!.getBoundingClientRect();
      const preview = document.querySelector('.file-preview-window')!.getBoundingClientRect();
      return {
        viewport,
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        preview: {
          left: preview.left,
          right: preview.right,
          top: preview.top,
          bottom: preview.bottom,
        },
      };
    });
    expect(bounds.panel.left).toBeGreaterThanOrEqual(0);
    expect(bounds.panel.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.viewport.height);
    expect(bounds.preview.left).toBeGreaterThanOrEqual(0);
    expect(bounds.preview.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.preview.bottom).toBeLessThanOrEqual(bounds.viewport.height);
  });

  it('expands commit history and opens a committed file diff', async () => {
    const commit = 'c'.repeat(40);
    await page.evaluate((commitHash) => {
      const testWindow = window as typeof window & {
        __fileViewerOriginalFetch?: typeof window.fetch;
      };
      testWindow.__fileViewerOriginalFetch = window.fetch;
      window.fetch = async (input) => {
        const url = String(input);
        const payload = url.includes('/repository/commit?')
          ? {
              success: true,
              data: {
                hash: commitHash,
                shortHash: commitHash.slice(0, 8),
                author: 'Agent',
                authoredAt: '2026-07-27T10:00:00Z',
                subject: 'Add mobile history',
                changes: [
                  {
                    path: 'src/history.ts',
                    code: 'A',
                    status: 'added',
                    staged: true,
                    unstaged: false,
                    additions: null,
                    deletions: null,
                    binary: false,
                  },
                ],
              },
            }
          : {
              success: true,
              data: {
                path: 'src/history.ts',
                commit: commitHash,
                label: `${commitHash.slice(0, 8)} · src/history.ts`,
                patch:
                  'diff --git a/src/history.ts b/src/history.ts\n' +
                  '--- /dev/null\n' +
                  '+++ b/src/history.ts\n' +
                  '@@ -0,0 +1 @@\n' +
                  '+export const history = true;\n',
                beforeContent: null,
                afterContent: 'export const history = true;\n',
                beforeExists: false,
                afterExists: true,
                binary: false,
                truncated: false,
                additions: 1,
                deletions: 0,
              },
            };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      app.activeSessionId = 'history-session';
      app.fileBrowserSessionId = 'history-session';
      app.fileBrowserScopeId = 'scope-history';
      app.fileBrowserCommitCache.clear();
      app.fileBrowserExpandedCommit = null;
      app.fileBrowserRepositoryData = {
        available: true,
        repositoryRoot: '/repo',
        selectedScopeId: 'scope-history',
        worktrees: [
          {
            id: 'scope-history',
            path: '/repo',
            name: 'repo',
            branch: 'main',
            head: commitHash,
            current: true,
            main: true,
            locked: false,
          },
        ],
        changes: [],
        commits: [
          {
            hash: commitHash,
            shortHash: commitHash.slice(0, 8),
            author: 'Agent',
            authoredAt: '2026-07-27T10:00:00Z',
            subject: 'Add mobile history',
          },
        ],
      };
      document.getElementById('fileBrowserPanel')?.classList.add('visible');
      app.switchFileBrowserView('history');
    }, commit);

    await expect.poll(() => page.locator('.repo-commit-summary').textContent()).toContain('Add mobile history');
    await page.locator('.repo-commit-summary').click();
    await expect.poll(() => page.locator('.repo-commit-file').textContent()).toContain('src/history.ts');
    await page.locator('.repo-commit-file').click();
    await expect.poll(() => page.locator('#filePreviewFooter').textContent()).toContain(commit.slice(0, 8));
    await expect.poll(() => page.locator('.repository-diff-line.diff-add').count()).toBe(1);
  });
});
