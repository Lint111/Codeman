import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { closeAllBrowsers, createDevicePage } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';

const PORT = PORTS.SUBAGENT_TRANSCRIPT;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_ID = 'stream-agent-test';
const SECOND_AGENT_ID = 'stream-agent-test-2';
const RUN_ID = 'stream-run-test';

interface BrowserCodemanApp {
  activeSessionId: string | null;
  activeSubagentId: string | null;
  fileBrowserAgentId: string | null;
  fileBrowserSessionId: string | null;
  subagentPanelVisible: boolean;
  sessions: Map<string, Record<string, unknown>>;
  subagents: Map<string, Record<string, unknown>>;
  subagentParentMap: Map<string, string>;
  workflowRuns: Map<string, Record<string, unknown>>;
  workflowRunDetails: Map<string, Record<string, unknown>>;
  ultracodeAgentWindows: Map<string, unknown>;
  _subagentTranscriptViewers: Map<string, unknown>;
  viewSubagentTranscript: (agentId: string) => void;
  openSubagentWindow: (agentId: string, options?: { focusFileBrowser?: boolean }) => void;
  openUltracodeAgentWindow: (agentId: string, runId: string) => void;
  selectSubagent: (agentId: string) => void;
  syncSubagentPanelSession: (sessionId: string) => void;
  _renderSubagentPanelImmediate: () => void;
  _onSubagentMessage: (data: { agentId: string; text: string; timestamp: number }) => void;
}

declare global {
  interface Window {
    app: BrowserCodemanApp;
  }
}

function transcriptBlocks(revision: number, count: number): Record<string, unknown>[] {
  const visibleCount = Math.min(count, 40);
  const firstVisibleEntry = count - visibleCount + 1;
  const timestamp = '2026-08-02T12:00:00.000Z';
  return [
    {
      kind: 'message',
      id: 'message:intro',
      timestamp,
      role: 'assistant',
      markdown: '**Implemented** the transcript renderer with a short explanation.',
    },
    {
      kind: 'tool',
      id: 'tool:edit-example',
      timestamp,
      name: 'Edit',
      summary: 'src/example.ts',
      defaultOpen: true,
      status: 'complete',
      inputPreview: '{\n  "file_path": "src/example.ts"\n}',
      result: 'Updated src/example.ts',
      diff: [
        { kind: 'context', text: 'export function answer() {', oldLine: 1, newLine: 1 },
        { kind: 'remove', text: '  return 41;', oldLine: 2 },
        { kind: 'add', text: '  return 42;', newLine: 2 },
        { kind: 'context', text: '}', oldLine: 3, newLine: 3 },
      ],
    },
    {
      kind: 'progress',
      id: 'progress:search',
      timestamp,
      label: 'Searching',
      detail: 'transcript rendering',
      count: 3,
    },
    ...Array.from({ length: visibleCount }, (_, index) => {
      const entry = firstVisibleEntry + index;
      return {
        kind: 'message',
        id: `message:${entry}`,
        timestamp,
        role: 'assistant',
        markdown: `revision-${revision} entry-${String(entry).padStart(3, '0')} ${'output '.repeat(12)}`,
      };
    }),
  ];
}

async function installTranscriptRoute(context: BrowserContext): Promise<{
  requests: string[];
  setRevision: (revision: number) => void;
}> {
  const requests: string[] = [];
  let revision = 1;
  await context.route('**/api/subagents/**/transcript?**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    const requestedLimit = Number(new URL(url).searchParams.get('limit')) || 320;
    const entryCount = Math.min(requestedLimit, 320);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          blocks: transcriptBlocks(revision, entryCount),
          entryCount,
          totalEntryCount: 320,
        },
      }),
    });
  });
  await context.route(/\/api\/subagents\/[^/?]+$/, async (route) => {
    const agentId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          agentId,
          description: 'Detached transcript worker',
          status: 'active',
          workingDir: '/worktrees/detached-worker',
          entryCount: 320,
        },
      }),
    });
  });
  return {
    requests,
    setRevision: (next) => {
      revision = next;
    },
  };
}

async function waitForContent(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ target, expected }) => document.querySelector(target)?.textContent?.includes(expected),
    { target: selector, expected: text }
  );
}

async function distanceFromBottom(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
}

describe('Subagent transcript streaming', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('keeps multiple active subagent transcripts inside their floating windows', async () => {
    const { context, page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    try {
      const routeState = await installTranscriptRoute(context);
      await page.evaluate(
        ({ firstAgentId, secondAgentId }) => {
          const { app } = window;
          for (const [agentId, description] of [
            [firstAgentId, 'First stream worker'],
            [secondAgentId, 'Second stream worker'],
          ]) {
            app.subagents.set(agentId, {
              agentId,
              description,
              status: 'active',
              startedAt: Date.now(),
            });
            app.openSubagentWindow(agentId, { focusFileBrowser: false });
            app.viewSubagentTranscript(agentId);
          }
        },
        { firstAgentId: AGENT_ID, secondAgentId: SECOND_AGENT_ID }
      );

      const firstWindow = `#subagent-window-${AGENT_ID}`;
      const secondWindow = `#subagent-window-${SECOND_AGENT_ID}`;
      await waitForContent(page, `${firstWindow} [data-role="content"]`, 'revision-1 entry-200');
      await waitForContent(page, `${secondWindow} [data-role="content"]`, 'revision-1 entry-200');
      expect(context.pages()).toHaveLength(1);
      expect(await page.locator('.subagent-window.subagent-window-transcript-open').count()).toBe(2);
      expect(routeState.requests.every((url) => new URL(url).searchParams.get('format') === 'blocks')).toBe(true);
      expect(await page.locator(`${firstWindow} [data-mode="transcript"]`).getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator(`${firstWindow} [data-mode="full"]`).count()).toBe(0);
      expect(routeState.requests.some((url) => new URL(url).searchParams.get('limit') === '200')).toBe(true);
      expect(await distanceFromBottom(page, `${firstWindow} [data-role="scroller"]`)).toBeLessThanOrEqual(2);
      expect(
        await page
          .locator(`${firstWindow} .subagent-transcript-content`)
          .evaluate((element) => getComputedStyle(element).display)
      ).toBe('flex');
      expect(
        await page
          .locator(`${firstWindow} .sat-tool`)
          .first()
          .evaluate((element) => getComputedStyle(element).borderTopWidth)
      ).toBe('1px');
      expect(await page.locator(`${firstWindow} .sat-message strong`).first().textContent()).toBe('Implemented');
      const tool = page.locator(`${firstWindow} .sat-tool`).first();
      expect(await tool.getAttribute('open')).not.toBeNull();
      expect(await tool.locator('.sat-diff-remove').textContent()).toContain('return 41');
      expect(await tool.locator('.sat-diff-add').textContent()).toContain('return 42');
      await tool.locator('summary').click();
      expect(await tool.getAttribute('open')).toBeNull();

      routeState.setRevision(2);
      await page.evaluate((agentId) => {
        window.app._onSubagentMessage({ agentId, text: 'new output', timestamp: Date.now() });
      }, AGENT_ID);
      await waitForContent(page, `${firstWindow} [data-role="content"]`, 'revision-2 entry-200');
      expect(await tool.getAttribute('open')).toBeNull();
      await tool.locator('summary').click();
      expect(await tool.getAttribute('open')).not.toBeNull();

      const stacking = await page.locator(firstWindow).evaluate((windowElement) => {
        const controls = windowElement.querySelector('.subagent-window-transcript-controls');
        const scroller = windowElement.querySelector('[data-role="scroller"]');
        if (!(controls instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return null;
        const controlsRect = controls.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const topElement = document.elementFromPoint(controlsRect.left + controlsRect.width / 2, controlsRect.top + 2);
        return {
          controlsBottom: controlsRect.bottom,
          scrollerTop: scrollerRect.top,
          controlsZIndex: getComputedStyle(controls).zIndex,
          topIsControl: !!topElement?.closest('.subagent-window-transcript-controls'),
        };
      });
      expect(stacking).not.toBeNull();
      expect(stacking!.controlsBottom).toBeLessThanOrEqual(stacking!.scrollerTop + 1);
      expect(Number(stacking!.controlsZIndex)).toBeGreaterThan(0);
      expect(stacking!.topIsControl).toBe(true);

      const requestCount = routeState.requests.length;
      await page.locator(`${firstWindow} [data-role="scroller"]`).evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await waitForContent(page, `${firstWindow} [data-role="meta"]`, '320 of 320 entries');
      expect(
        routeState.requests.slice(requestCount).some((url) => new URL(url).searchParams.get('limit') === '320')
      ).toBe(true);
      expect(await page.locator(`${firstWindow} [data-role="latest"]`).isVisible()).toBe(true);
      expect(await page.locator(`${firstWindow} .sat-tool`).first().getAttribute('open')).not.toBeNull();

      const popupPromise = page.waitForEvent('popup');
      await page.locator(`${firstWindow} [data-action="open-browser-tab"]`).click();
      const detached = await popupPromise;
      await detached.waitForLoadState('domcontentloaded');
      await waitForContent(detached, '[data-role="content"]', 'revision-2 entry-200');
      expect(new URL(detached.url()).pathname).toBe(`/subagent/${AGENT_ID}`);
      expect(await detached.locator('[data-action="return-to-codeman"]').isVisible()).toBe(true);
      expect(context.pages()).toHaveLength(2);

      await page.bringToFront();
      await page.locator(`${firstWindow} [data-action="open-browser-tab"]`).click();
      await page.waitForTimeout(100);
      expect(context.pages()).toHaveLength(2);

      await page.locator(`${firstWindow} [data-mode="activity"]`).click();
      expect(await page.locator(`${firstWindow} .subagent-window-activity-pane`).isVisible()).toBe(true);
      expect(await page.locator(`${firstWindow} .subagent-window-transcript-pane`).isHidden()).toBe(true);
      expect(await page.locator(`${secondWindow} .subagent-window-transcript-pane`).isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  }, 20_000);

  it('keeps the tracked in-page popup live without stealing a scrolled reading position', async () => {
    const { context, page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    try {
      const routeState = await installTranscriptRoute(context);
      await page.evaluate(
        ({ agentId, runId }) => {
          const { app } = window;
          app.workflowRuns.set(runId, {
            runId,
            workflowName: 'Tracked stream run',
            status: 'running',
            lastActivityAt: Date.now(),
          });
          app.workflowRunDetails.set(runId, {
            runId,
            agents: [{ agentId, label: 'Tracked worker', state: 'progress' }],
          });
          app.subagents.set(agentId, {
            agentId,
            description: 'Tracked worker',
            status: 'active',
            startedAt: Date.now(),
          });
          app.openUltracodeAgentWindow(agentId, runId);
        },
        { agentId: AGENT_ID, runId: RUN_ID }
      );

      const windowSelector = `#ultracode-agent-window-${AGENT_ID}`;
      const bodySelector = `${windowSelector} .ultracode-window-body`;
      await waitForContent(page, `${windowSelector} [data-role="content"]`, 'revision-1 entry-200');
      expect(await page.locator(`${windowSelector} [data-mode="transcript"]`).getAttribute('aria-pressed')).toBe(
        'true'
      );
      expect(await page.locator(`${windowSelector} [data-mode="full"]`).count()).toBe(0);
      expect(routeState.requests.some((url) => new URL(url).searchParams.get('limit') === '200')).toBe(true);
      expect(await distanceFromBottom(page, bodySelector)).toBeLessThanOrEqual(2);
      expect(await page.locator(`${windowSelector} .sat-tool`).count()).toBe(1);
      expect(await page.locator(`${windowSelector} .sat-progress-count`).textContent()).toBe('3x');

      const box = await page.locator(windowSelector).boundingBox();
      const viewport = page.viewportSize();
      expect(box).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);

      await page.locator(bodySelector).evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await waitForContent(page, `${windowSelector} [data-role="meta"]`, '320 of 320 entries');
      expect(await page.locator(`${windowSelector} [data-role="latest"]`).isVisible()).toBe(true);

      const readingTop = await page.locator(bodySelector).evaluate((element) => element.scrollTop);

      routeState.setRevision(2);
      await page.evaluate((agentId) => {
        window.app._onSubagentMessage({ agentId, text: 'new output', timestamp: Date.now() });
      }, AGENT_ID);
      await waitForContent(page, `${windowSelector} [data-role="content"]`, 'revision-2 entry-320');
      expect(
        Math.abs((await page.locator(bodySelector).evaluate((element) => element.scrollTop)) - readingTop)
      ).toBeLessThanOrEqual(2);
      expect(await page.locator(`${windowSelector} [data-role="latest"]`).isVisible()).toBe(true);

      const requestCount = routeState.requests.length;
      await page.locator(`${windowSelector} [data-role="latest"]`).click();
      await waitForContent(page, `${windowSelector} [data-role="meta"]`, '200 of 320 entries');
      expect(await distanceFromBottom(page, bodySelector)).toBeLessThanOrEqual(2);
      expect(
        routeState.requests.slice(requestCount).some((url) => new URL(url).searchParams.get('limit') === '200')
      ).toBe(true);

      await page.locator(`${windowSelector} .uw-close`).click();
      expect(await page.locator(windowSelector).count()).toBe(0);
      expect(await page.evaluate((agentId) => window.app.ultracodeAgentWindows.has(agentId), AGENT_ID)).toBe(false);
    } finally {
      await context.close();
    }
  }, 20_000);

  it('shows only subagents owned by the active session', async () => {
    const { context, page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium');
    try {
      await page.evaluate(() => {
        const { app } = window;
        app.sessions.set('session-one', {
          id: 'session-one',
          claudeSessionId: 'conversation-one',
          workingDir: '/repos/one',
          name: 'One',
        });
        app.sessions.set('session-two', {
          id: 'session-two',
          claudeSessionId: 'conversation-two',
          workingDir: '/repos/two',
          name: 'Two',
        });
        app.subagents.set('agent-one', {
          agentId: 'agent-one',
          sessionId: 'conversation-one',
          workingDir: '/worktrees/one',
          description: 'Worker one',
          status: 'active',
          toolCallCount: 1,
          entryCount: 1,
          fileSize: 1,
        });
        app.subagents.set('agent-two', {
          agentId: 'agent-two',
          sessionId: 'conversation-two',
          workingDir: '/worktrees/two',
          description: 'Worker two',
          status: 'active',
          toolCallCount: 2,
          entryCount: 2,
          fileSize: 2,
        });
        app.subagentParentMap.set('agent-one', 'session-one');
        app.subagentParentMap.set('agent-two', 'session-two');
        app.activeSessionId = 'session-one';
        app.subagentPanelVisible = true;
        app._renderSubagentPanelImmediate();
      });

      expect(await page.locator('#subagentList [data-agent-id="agent-one"]').count()).toBe(1);
      expect(await page.locator('#subagentList [data-agent-id="agent-two"]').count()).toBe(0);
      expect(await page.locator('#subagentCountBadge').textContent()).toBe('1');

      await page.evaluate(() => window.app.selectSubagent('agent-one'));
      expect(await page.evaluate(() => window.app.fileBrowserAgentId)).toBe('agent-one');

      await page.evaluate(() => {
        window.app.activeSessionId = 'session-two';
        window.app.syncSubagentPanelSession('session-two');
      });
      expect(await page.locator('#subagentList [data-agent-id="agent-one"]').count()).toBe(0);
      expect(await page.locator('#subagentList [data-agent-id="agent-two"]').count()).toBe(1);
      expect(await page.evaluate(() => window.app.activeSubagentId)).toBeNull();
    } finally {
      await context.close();
    }
  });
});
