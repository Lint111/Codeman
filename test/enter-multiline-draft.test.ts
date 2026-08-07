/**
 * @fileoverview Opt-in multi-line Enter drafting (`enterMultilineDraft`).
 *
 * With local echo on and the setting enabled, Enter opens a new line in the
 * client-side draft instead of sending it, and a second Enter on the resulting
 * empty line sends. This is the phone-composition case: Shift+Enter is awkward
 * or absent on a touch keyboard, so a plain-Enter gesture is the only ergonomic
 * way to write a multi-line prompt.
 *
 * The setting is OFF by default, so the shipped behavior is unchanged: Enter
 * sends immediately, which is the contract every CLI expects.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), matching
 * test/input-send-order.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Minimal stand-in for the zerolag overlay's draft surface. */
class FakeOverlay {
  pendingText = '';
  compositionText = '';
  appendText(text: string): void {
    this.pendingText += text;
  }
}

type TerminalUiHost = {
  _localEchoEnabled: boolean;
  _localEchoOverlay: FakeOverlay;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  _enterMultilineDraftEnabled: () => boolean;
  _shouldCommitDraftOnEnter: () => boolean;
  _stripTrailingDraftNewline: (text: string) => string;
  _enterDraftSettingAt?: number;
};

/**
 * Evaluate terminal-ui.js and lift the Enter-drafting helpers onto a bare host
 * object. The module is an `Object.assign(CodemanApp.prototype, {...})` mixin,
 * so a stub prototype target is enough to capture the methods under test
 * without constructing a real terminal.
 */
function loadEnterHelpers(settings: Record<string, unknown>, localEcho: boolean): TerminalUiHost {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const prototypeTarget: Record<string, unknown> = {};
  const context = vm.createContext({
    console,
    CodemanApp: { prototype: prototypeTarget },
    Object,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), querySelector: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    localStorage: { getItem: vi.fn(), setItem: vi.fn() },
    MobileDetection: { isTouchDevice: () => true, isMobile: () => true },
    Terminal: class {},
    fetch: vi.fn(),
  });
  try {
    vm.runInContext(source, context, { filename: 'terminal-ui.js' });
  } catch {
    /* Side effects beyond the mixin (addon wiring) are irrelevant here. */
  }

  const host = Object.create(prototypeTarget) as TerminalUiHost;
  host._localEchoEnabled = localEcho;
  host._localEchoOverlay = new FakeOverlay();
  host.loadAppSettingsFromStorage = () => settings;
  return host;
}

/** Bust the 1s read-through cache so each assertion re-reads the setting. */
function freshRead(host: TerminalUiHost): void {
  host._enterDraftSettingAt = 0;
}

describe('opt-in multi-line Enter drafting', () => {
  it('is disabled by default, so Enter keeps sending immediately', () => {
    const host = loadEnterHelpers({}, true);
    expect(host._enterMultilineDraftEnabled()).toBe(false);
  });

  it('stays disabled without local echo, which is the only mode with a draft', () => {
    // No client-side buffer exists to insert a line break into, so the setting
    // alone must not change Enter's meaning on a desktop/immediate-echo session.
    const host = loadEnterHelpers({ enterMultilineDraft: true }, false);
    expect(host._enterMultilineDraftEnabled()).toBe(false);
  });

  it('activates only with both local echo and the setting on', () => {
    const host = loadEnterHelpers({ enterMultilineDraft: true }, true);
    expect(host._enterMultilineDraftEnabled()).toBe(true);
  });

  it('treats a mid-draft Enter as a new line and the next one as the send', () => {
    const host = loadEnterHelpers({ enterMultilineDraft: true }, true);
    host._localEchoOverlay.pendingText = 'hello';

    // First Enter: text present and no trailing newline -> open a line.
    expect(host._shouldCommitDraftOnEnter()).toBe(false);

    host._localEchoOverlay.appendText('\n');
    freshRead(host);

    // Second Enter: caret now sits on an empty new line -> send.
    expect(host._shouldCommitDraftOnEnter()).toBe(true);
  });

  it('sends on an empty draft rather than opening a stray line', () => {
    const host = loadEnterHelpers({ enterMultilineDraft: true }, true);
    expect(host._shouldCommitDraftOnEnter()).toBe(true);
  });

  it('never sends while an IME composition is in flight', () => {
    const host = loadEnterHelpers({ enterMultilineDraft: true }, true);
    host._localEchoOverlay.pendingText = 'done\n';
    host._localEchoOverlay.compositionText = 'ptr';

    // The trailing newline would otherwise read as "send", but the user is
    // still assembling the current line.
    expect(host._shouldCommitDraftOnEnter()).toBe(false);
  });

  it('drops the drafted newline from the text handed to the PTY', () => {
    const host = loadEnterHelpers({ enterMultilineDraft: true }, true);
    // The newline only ever lived in the unsent overlay draft, so the agent
    // must receive the typed line, not the line plus a blank one.
    expect(host._stripTrailingDraftNewline('hello\n')).toBe('hello');
    expect(host._stripTrailingDraftNewline('a\nb')).toBe('a\nb');
  });

  it('leaves the outgoing text untouched when the feature is off', () => {
    const host = loadEnterHelpers({}, true);
    expect(host._stripTrailingDraftNewline('hello\n')).toBe('hello\n');
  });

  // The helpers above are unit-testable, but the behavior only matters if the
  // Enter branch in `onData` actually consults them. That branch lives inside
  // initTerminal(), which needs a real xterm instance, so assert on the wiring
  // in the source instead of constructing one.
  it('gates the onData Enter branch on the draft helpers', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const enterBranch = source.slice(source.indexOf('if (/^[\\r\\n]+$/.test(data)) {'));

    // The line-break early return must be reached BEFORE the commit path, and
    // the committed text must be stripped of the drafted newline.
    expect(enterBranch).toContain('this._enterMultilineDraftEnabled() && !this._shouldCommitDraftOnEnter()');
    expect(enterBranch.indexOf("appendText('\\n')")).toBeGreaterThan(-1);
    expect(enterBranch).toContain('this._stripTrailingDraftNewline(');
    expect(enterBranch.indexOf("appendText('\\n')")).toBeLessThan(
      enterBranch.indexOf('this._stripTrailingDraftNewline(')
    );
  });
});
