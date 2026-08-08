/**
 * @fileoverview Subagent → session attribution and visibility.
 *
 * The subagents panel is scoped to the session being viewed, but attribution
 * used to fall back to "blame the active tab" and the visibility filter used to
 * FAIL OPEN on an unattributed agent. Together that showed every agent under
 * every session: measured on a live instance, 28 of 28 agents had no resolvable
 * owner because restored sessions carry a placeholder `claudeSessionId` until
 * something adopts the real conversation id.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), matching
 * test/input-send-order.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Agent = { agentId: string; sessionId?: string; workingDir?: string };
type Session = { workingDir?: string; claudeSessionId?: string; id?: string };

type Host = {
  subagents: Map<string, Agent>;
  sessions: Map<string, Session>;
  subagentParentMap: Map<string, string>;
  activeSessionId: string | null;
  setAgentParentSessionId: (agentId: string, sessionId: string) => void;
  updateSubagentWindowParent: () => void;
  updateSubagentWindowVisibility: () => void;
  updateConnectionLines: () => void;
  isSubagentSessionMatch: (sessionId: string, session: Session, agentSessionId?: string) => boolean;
  findParentSessionForSubagent: (agentId: string) => void;
};

function loadHost(): Host {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const prototypeTarget: Record<string, unknown> = {};
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
    window: { addEventListener: vi.fn(), screen: {}, innerWidth: 1920, innerHeight: 1080 },
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

  const host = Object.create(prototypeTarget) as Host;
  host.subagents = new Map();
  host.sessions = new Map();
  host.subagentParentMap = new Map();
  host.activeSessionId = null;
  host.setAgentParentSessionId = (agentId, sessionId) => host.subagentParentMap.set(agentId, sessionId);
  host.updateSubagentWindowParent = vi.fn();
  host.updateSubagentWindowVisibility = vi.fn();
  host.updateConnectionLines = vi.fn();
  return host;
}

/** The live topology that exposed the bug. */
function seedLiveTopology(host: Host): void {
  host.sessions.set('restored-1b670f56', { workingDir: '/home/liory/codeman-cases/testcase' });
  host.sessions.set('restored-ed1c0e74', { workingDir: '/home/liory' });
  host.sessions.set('restored-494ee26e', { workingDir: '/home/liory/Github/undertow' });
}

describe('subagent ownership attribution', () => {
  it('attributes an agent by its working directory when the conversation id cannot match', () => {
    // Restored sessions carry a placeholder claudeSessionId, so the agent's own
    // `sessionId` matches nothing — workingDir is the signal that survives.
    const host = loadHost();
    seedLiveTopology(host);
    host.activeSessionId = 'restored-1b670f56'; // viewing a DIFFERENT session
    host.subagents.set('a1', {
      agentId: 'a1',
      sessionId: 'bc149d56-08ed-4f3d-88f0-685887dff10c',
      workingDir: '/home/liory/Github/undertow',
    });

    host.findParentSessionForSubagent('a1');

    expect(host.subagentParentMap.get('a1')).toBe('restored-494ee26e');
  });

  it('prefers the most specific session when paths nest', () => {
    // Both `/home/liory` and `/home/liory/Github/undertow` contain the agent;
    // the deeper session is the one that actually spawned it.
    const host = loadHost();
    seedLiveTopology(host);
    host.subagents.set('a2', {
      agentId: 'a2',
      workingDir: '/home/liory/Github/undertow/vixen/engine/VIXEN',
    });

    host.findParentSessionForSubagent('a2');

    expect(host.subagentParentMap.get('a2')).toBe('restored-494ee26e');
  });

  it('never blames the active session for an agent it cannot place', () => {
    // The old fallback wrote a PERMANENT association from a guess, so an agent
    // from another pane was mislabelled whenever that pane happened to be
    // focused — and the mistake persisted across restarts.
    const host = loadHost();
    host.sessions.set('sess-a', { workingDir: '/home/liory/project-a' });
    host.activeSessionId = 'sess-a';
    host.subagents.set('orphan', { agentId: 'orphan', workingDir: '/somewhere/else' });

    host.findParentSessionForSubagent('orphan');

    expect(host.subagentParentMap.has('orphan')).toBe(false);
  });

  it('does not require a path separator match to be a real containment', () => {
    // `/home/liory/undertow-extract` must NOT be claimed by a session rooted at
    // `/home/liory/undertow` — a naive startsWith would swallow it.
    const host = loadHost();
    host.sessions.set('sess-u', { workingDir: '/home/liory/undertow' });
    host.subagents.set('sibling', { agentId: 'sibling', workingDir: '/home/liory/undertow-extract' });

    host.findParentSessionForSubagent('sibling');

    expect(host.subagentParentMap.has('sibling')).toBe(false);
  });
});
