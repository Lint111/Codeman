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

  it('re-reads the setting after its short cache window', () => {
    const settings: Record<string, unknown> = { enterMultilineDraft: true };
    const host = loadEnterHelpers(settings, true);
    expect(host._enterMultilineDraftEnabled()).toBe(true);

    // Toggling in App Settings must take effect without a reload; the 1s cache
    // exists only to keep Enter off localStorage during a keystroke burst.
    settings.enterMultilineDraft = false;
    freshRead(host);
    expect(host._enterMultilineDraftEnabled()).toBe(false);
  });

  // On THIS branch the draft buffer is owned by TerminalInputController, so the
  // decision and newline-stripping halves live there (`resolveEnterAction` /
  // `submitDraft`) rather than in the onData block upstream uses. Only the
  // setting reader stays on the terminal surface. Assert the wiring that joins
  // them; the controller's own behavior is covered in
  // test/terminal-input-controller.test.ts.
  it('feeds the setting into the input controller', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    expect(source).toContain('isEnterMultilineDraftEnabled: () => this._enterMultilineDraftEnabled()');

    const controller = readFileSync(
      resolve(import.meta.dirname, '../src/web/public/terminal-input-controller.js'),
      'utf8'
    );
    // Feature off -> Enter submits immediately, even with a draft open.
    expect(controller).toContain('if (!this._isEnterMultilineDraftEnabled()) return');
    // ...and the drafted newline is only stripped while the feature is on.
    expect(controller).toContain('this._isEnterMultilineDraftEnabled() &&');
  });
});
