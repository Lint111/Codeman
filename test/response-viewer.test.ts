/**
 * @fileoverview Response viewer source-selection regressions.
 *
 * The "Last Response" action must never substitute the complete terminal
 * scrollback when a structured transcript lookup is temporarily unavailable.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
  };
}

function loadCodemanAppClass(elements: Record<string, Record<string, unknown>>) {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: {
      addEventListener: vi.fn(),
      getElementById: (id: string) => elements[id] ?? null,
    },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

describe('Last Response viewer', () => {
  // Merge note (origin/master eb8d11f): an empty transcript now FALLS BACK to the
  // cleaned terminal buffer for claude/shell sessions, so tmux repaints can no
  // longer leave the viewer blank when output plainly exists. This test used to
  // assert the opposite (no fallback, one fetch); it now pins the fallback's
  // empty-buffer path — still "No response yet", but only after both sources miss.
  it('falls back to the terminal buffer when the transcript is empty', async () => {
    const elements = {
      responseViewer: { classList: fakeClassList() },
      responseViewerBackdrop: { classList: fakeClassList() },
      responseViewerBody: { textContent: '', innerHTML: '', scrollTop: 0 },
      responseViewerTitle: { textContent: '' },
      responseViewerMore: { style: { display: '' }, textContent: '' },
    };
    const CodemanApp = loadCodemanAppClass(elements);
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as {
      activeSessionId: string;
      sessions: Map<string, { mode: string }>;
      toggleResponseViewer: () => Promise<void>;
    };
    app.activeSessionId = 'claude-session';
    app.sessions = new Map([['claude-session', { mode: 'claude' }]]);

    const fetchMock = vi.fn(async () => ({
      json: async () => ({ success: true, data: { text: '', timestamp: '' } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await app.toggleResponseViewer();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/sessions/claude-session/last-response');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sessions/claude-session/terminal');
    // Both sources empty (the mock returns no terminalBuffer) — placeholder stands.
    expect(elements.responseViewerBody.textContent).toContain('No response yet');
    expect(elements.responseViewerTitle.textContent).toBe('Last Response');
  });

  // A repainting TUI places each row with CUP (`\x1b[<row>;1H`) and emits NO
  // newline between them. Stripping the escapes without honouring what they
  // implied collapsed a whole screen into one run:
  //   "=== BOX ===-- lock resources --build: freetest: free..."
  // which then rendered as a single unreadable paragraph in the viewer. This is
  // the "formatting is lost" case, and it only bites the terminal-buffer
  // fallback — a structured transcript never goes through here.
  describe('_cleanTerminalBuffer positioning escapes', () => {
    const app = Object.create((loadCodemanAppClass({}) as { prototype: object }).prototype) as {
      _cleanTerminalBuffer: (buf: string) => string;
    };

    it('keeps cursor-positioned rows on separate lines', () => {
      const repaint =
        '\x1b[H\x1b[2J\x1b[1;1H=== UNDERTOW BOX 09:58:41 ===' +
        '\x1b[2;1H-- lock resources --' +
        '\x1b[3;1Hbuild: free' +
        '\x1b[4;1Htest: free';

      const lines = app
        ._cleanTerminalBuffer(repaint)
        .split('\n')
        .filter((l) => l.trim());

      expect(lines).toEqual(['=== UNDERTOW BOX 09:58:41 ===', '-- lock resources --', 'build: free', 'test: free']);
    });

    it('restores spaces a repainting CLI encoded as cursor-forward moves', () => {
      // A repainting CLI advances over blank cells instead of writing a space
      // byte: `word\x1b[1X\x1b[Cword`. Stripping those escapes deleted the gap,
      // so the viewer showed "byte-identical;thevalidatorshowedthosecounters".
      // Measured on one live buffer: 8210 CUF escapes vs 16115 literal spaces.
      const cursorSpaced = 'byte-identical;\x1b[1X\x1b[Cthe\x1b[1X\x1b[Cvalidator\x1b[1X\x1b[Cshowed';

      expect(app._cleanTerminalBuffer(cursorSpaced)).toBe('byte-identical; the validator showed');
    });

    it('expands a multi-column cursor-forward move to that many spaces', () => {
      expect(app._cleanTerminalBuffer('a\x1b[4Cb')).toBe('a    b');
    });

    it('does not break a line on mid-row positioning', () => {
      // Column != 1 is positioning WITHIN a row (progress bars, status fields).
      // Treating it as a newline would shred single-line output instead.
      const midRow = 'progress: \x1b[12G50%\x1b[20G done';
      expect(
        app
          ._cleanTerminalBuffer(midRow)
          .split('\n')
          .filter((l) => l.trim())
      ).toHaveLength(1);
    });
  });
});
