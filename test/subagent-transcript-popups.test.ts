/**
 * @fileoverview Tiling policy for subagent transcript popups.
 *
 * Opening a transcript while others are open must SHARE the screen rather than
 * stack windows on top of each other, and closing one must give its space back
 * to the survivors. The geometry calls themselves are best-effort (a browser
 * may honour `window.open` as a tab, which has no geometry), so what is pinned
 * here is the arithmetic and the bookkeeping — the parts that are ours.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), matching
 * test/input-send-order.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Rect = { left: number; top: number; width: number; height: number };
type PopupHost = {
  subagents: Map<string, unknown>;
  showToast: (message: string, level?: string) => void;
  _subagentTranscriptPopups?: Map<string, FakePopup>;
  _liveSubagentTranscriptPopups: () => Map<string, FakePopup>;
  _subagentPopupGridRect: (index: number, count: number) => Rect;
  _retileSubagentTranscriptPopups: () => void;
  _onSubagentTranscriptClosed: (agentId: string) => void;
  closeSubagentTranscriptPopups: () => number;
};

/** Stand-in for a popup window: records the geometry the app asks for. */
class FakePopup {
  closed = false;
  moved: Array<[number, number]> = [];
  resized: Array<[number, number]> = [];
  focus(): void {}
  close(): void {
    this.closed = true;
  }
  moveTo(x: number, y: number): void {
    this.moved.push([x, y]);
  }
  resizeTo(w: number, h: number): void {
    this.resized.push([w, h]);
  }
}

/**
 * Evaluate panels-ui.js and lift the popup helpers onto a bare host. The module
 * is an `Object.assign(CodemanApp.prototype, {...})` mixin, so a stub prototype
 * target captures the methods without constructing the whole app.
 */
function loadPopupHost(screen: Record<string, number>): PopupHost {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const prototypeTarget: Record<string, unknown> = {};
  const listeners: Array<(event: unknown) => void> = [];
  const context = vm.createContext({
    console,
    CodemanApp: { prototype: prototypeTarget },
    Object,
    Math,
    Map,
    Set,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn: () => void) => fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    window: {
      screen,
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener: (_type: string, fn: (event: unknown) => void) => listeners.push(fn),
      open: vi.fn(),
    },
    location: { origin: 'http://localhost' },
    localStorage: { getItem: () => null, setItem: () => {} },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    escapeHtml: (s: string) => s,
  });
  try {
    vm.runInContext(source, context, { filename: 'panels-ui.js' });
  } catch {
    /* Side effects beyond the mixin are irrelevant here. */
  }

  const host = Object.create(prototypeTarget) as PopupHost;
  host.subagents = new Map();
  host.showToast = vi.fn();
  return host;
}

const SCREEN = { availLeft: 0, availTop: 0, availWidth: 1600, availHeight: 900 };

describe('subagent transcript popup tiling', () => {
  it('gives a lone transcript the whole available screen', () => {
    const host = loadPopupHost(SCREEN);
    expect(host._subagentPopupGridRect(0, 1)).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });

  it('splits two transcripts SIDE BY SIDE rather than stacking them', () => {
    const host = loadPopupHost(SCREEN);
    const first = host._subagentPopupGridRect(0, 2);
    const second = host._subagentPopupGridRect(1, 2);

    // Same row, adjacent columns — the compare-two case this policy exists for.
    expect(first.top).toBe(second.top);
    expect(second.left).toBe(first.left + first.width);
    expect(first.width).toBe(800);
  });

  it('tiles four transcripts into a 2x2 grid', () => {
    const host = loadPopupHost(SCREEN);
    const rects = [0, 1, 2, 3].map((i) => host._subagentPopupGridRect(i, 4));

    expect(rects.map((r) => [r.left, r.top])).toEqual([
      [0, 0],
      [800, 0],
      [0, 450],
      [800, 450],
    ]);
  });

  it('offsets the grid onto the monitor Codeman is on', () => {
    // availLeft/availTop are non-zero on a secondary display; ignoring them
    // drops every popup onto the primary screen.
    const host = loadPopupHost({ availLeft: 1920, availTop: 40, availWidth: 1600, availHeight: 900 });
    expect(host._subagentPopupGridRect(0, 1)).toMatchObject({ left: 1920, top: 40 });
  });

  it('keeps a window usable when the grid would make it tiny', () => {
    const host = loadPopupHost({ availLeft: 0, availTop: 0, availWidth: 800, availHeight: 600 });
    const rect = host._subagentPopupGridRect(8, 9); // 3x3 on a small screen
    expect(rect.width).toBeGreaterThanOrEqual(360);
    expect(rect.height).toBeGreaterThanOrEqual(320);
  });

  it('prunes closed popups so they do not consume a grid slot', () => {
    const host = loadPopupHost(SCREEN);
    const live = host._liveSubagentTranscriptPopups();
    const gone = new FakePopup();
    gone.closed = true;
    live.set('dead-agent', gone);
    live.set('live-agent', new FakePopup());

    expect(host._liveSubagentTranscriptPopups().size).toBe(1);
    expect([...host._liveSubagentTranscriptPopups().keys()]).toEqual(['live-agent']);
  });

  it('re-tiles the survivors when one transcript closes', () => {
    const host = loadPopupHost(SCREEN);
    const live = host._liveSubagentTranscriptPopups();
    const a = new FakePopup();
    const b = new FakePopup();
    live.set('a', a);
    live.set('b', b);

    // _onSubagentTranscriptClosed defers its re-tile so the closing window is
    // not still counted as live; drive the reflow directly here.
    host._onSubagentTranscriptClosed('a');
    host._retileSubagentTranscriptPopups();

    // 'b' is alone now and should reclaim the full width, not stay at half.
    expect(b.resized.at(-1)).toEqual([1600, 900]);
  });

  it('closes every live popup and empties the registry', () => {
    const host = loadPopupHost(SCREEN);
    const live = host._liveSubagentTranscriptPopups();
    const a = new FakePopup();
    const b = new FakePopup();
    live.set('a', a);
    live.set('b', b);

    expect(host.closeSubagentTranscriptPopups()).toBe(2);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(host._liveSubagentTranscriptPopups().size).toBe(0);
  });
});
