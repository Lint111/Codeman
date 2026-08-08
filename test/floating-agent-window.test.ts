/**
 * @fileoverview Shared floating-window primitives.
 *
 * `subagent-windows.js` and `ultracode-windows.js` each carried their own copy
 * of the minimized-window dropdown markup. The copies had already drifted, and
 * both families use the same `.subagent-dropdown*` CSS and the same hover/pin
 * handlers, so the markup now lives in `floating-agent-window.js`.
 *
 * This is a refactor with NO intended behaviour change, so the tests pin the
 * rendered markup rather than the internals — including the escaping, which is
 * the part a markup refactor is most likely to break silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Host = {
  buildMinimizedWindowItem: (entry: Record<string, unknown>) => string;
  buildMinimizedWindowBadge: (options: { badgeClass: string; label: string; items: string[] }) => string;
  animateWindowToTab: (element: unknown, sessionId: string | null, done: () => void) => void;
};

function loadHost(): Host {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/floating-agent-window.js'), 'utf8');
  const prototypeTarget: Record<string, unknown> = {};
  const context = vm.createContext({
    console,
    CodemanApp: { prototype: prototypeTarget },
    Object,
    String,
    escapeHtml: (s: unknown) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: { querySelector: () => null },
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'floating-agent-window.js' });
  return Object.create(prototypeTarget) as Host;
}

describe('floating agent window primitives', () => {
  it('renders a dropdown row with status, name and dismiss control', () => {
    const host = loadHost();
    const html = host.buildMinimizedWindowItem({
      name: 'do a thing',
      statusClass: 'active',
      restoreCall: 'app.restore("a1")',
      dismissCall: 'app.dismiss("a1")',
    });

    expect(html).toContain('class="subagent-dropdown-item"');
    expect(html).toContain('<span class="subagent-dropdown-status active">');
    expect(html).toContain('do a thing');
    expect(html).toContain('app.restore("a1")');
    expect(html).toContain('app.dismiss("a1")');
  });

  it('omits the status modifier rather than emitting a trailing space', () => {
    // The ultracode agent rows pass no status; a stray `class="… "` is harmless
    // but makes this refactor a visible diff against the previous markup.
    const host = loadHost();
    const html = host.buildMinimizedWindowItem({ name: 'x', restoreCall: 'a()', dismissCall: 'b()' });
    expect(html).toContain('<span class="subagent-dropdown-status">');
  });

  it('truncates a long name to 25 characters with an ellipsis', () => {
    const host = loadHost();
    const html = host.buildMinimizedWindowItem({
      name: 'x'.repeat(40),
      restoreCall: 'a()',
      dismissCall: 'b()',
    });
    expect(html).toContain(`${'x'.repeat(25)}…`);
    expect(html).not.toContain('x'.repeat(26));
  });

  it('escapes the display name', () => {
    // Names come from agent descriptions and workflow summaries — model-authored
    // text that reaches innerHTML.
    const host = loadHost();
    const html = host.buildMinimizedWindowItem({
      name: '<img src=x onerror=alert(1)>',
      restoreCall: 'a()',
      dismissCall: 'b()',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders nothing when there is nothing minimized', () => {
    const host = loadHost();
    expect(host.buildMinimizedWindowBadge({ badgeClass: 'tab-subagent-badge', label: 'AGENT', items: [] })).toBe('');
  });

  it('wraps items in the hover/pin badge both families share', () => {
    const host = loadHost();
    const html = host.buildMinimizedWindowBadge({
      badgeClass: 'tab-ultracode-badge',
      label: 'ULTRA (2)',
      items: ['<div>a</div>', '<div>b</div>'],
    });

    expect(html).toContain('class="tab-ultracode-badge"');
    expect(html).toContain('ULTRA (2)');
    // The dropdown behaviour is owned by subagent-windows.js for both families.
    expect(html).toContain('app.showSubagentDropdown(this)');
    expect(html).toContain('app.pinSubagentDropdown(this)');
    expect(html).toContain('<div>a</div><div>b</div>');
  });

  it('completes the minimize animation exactly once', () => {
    const host = loadHost();
    const done = vi.fn();
    // No tab element resolves (document.querySelector returns null), which is
    // the "nothing to fly into" path — `done` must still run so the caller can
    // tear the window down instead of leaking it.
    host.animateWindowToTab({}, 'sess-1', done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
