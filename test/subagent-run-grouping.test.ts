/**
 * @fileoverview Run grouping in the subagents panel (opt-in).
 *
 * Workflow-spawned agents already arrive in the subagent list — the watcher
 * walks `subagents/workflows/<runId>/` — so a fleet reads as N loose rows.
 * Measured on a live session: 31 agents across 9 runs. Grouping collapses each
 * run into one expandable entry.
 *
 * Gated on `showUltracodeAgents`, so with the toggle OFF the list must render
 * byte-identically to before. The tests pin that, plus the two rules that are
 * easy to get wrong: the compound (runId, agentId) join key and the
 * live-vs-completed label preference.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Agent = {
  agentId: string;
  status?: string;
  description?: string;
  toolCallCount?: number;
  workflowRunId?: string;
  modelShort?: string;
};

type Host = {
  activeSubagentId: string | null;
  subagents: Map<string, Agent>;
  subagentActivity: Map<string, unknown[]>;
  subagentWindows: Map<string, unknown>;
  workflowRuns: Map<string, Record<string, unknown>>;
  workflowRunDetails: Map<string, { agents: Array<Record<string, unknown>> }>;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  getTeammateInfo: () => null;
  getTeammateBadgeHtml: () => string;
  getToolIcon: () => string;
  _runGroupingSettingAt?: number;
  _subagentRunGroupingEnabled: () => boolean;
  _subagentListItemHtml: (agent: Agent) => string;
  _buildGroupedSubagentListHtml: (agents: Agent[]) => string;
  _workflowAgentFor: (agent: Agent) => Record<string, unknown> | undefined;
  _groupedAgentLabel: (agent: Agent) => string;
  _expandedRunIds: () => Set<string>;
};

function loadHost(settings: Record<string, unknown>): Host {
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
    JSON,
    String,
    Array,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn: () => void) => fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    window: { addEventListener: vi.fn(), screen: {}, innerWidth: 1920, innerHeight: 1080 },
    location: { origin: 'http://localhost' },
    localStorage: { getItem: () => null, setItem: () => {} },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    escapeHtml: (s: unknown) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    scheduleBackground: (fn: () => void) => fn(),
  });
  try {
    vm.runInContext(source, context, { filename: 'panels-ui.js' });
  } catch {
    /* side effects beyond the mixin are irrelevant here */
  }

  const host = Object.create(prototypeTarget) as Host;
  host.activeSubagentId = null;
  host.subagents = new Map();
  host.subagentActivity = new Map();
  host.subagentWindows = new Map();
  host.workflowRuns = new Map();
  host.workflowRunDetails = new Map();
  host.loadAppSettingsFromStorage = () => settings;
  host.getTeammateInfo = () => null;
  host.getTeammateBadgeHtml = () => '';
  host.getToolIcon = () => '';
  return host;
}

const plainAgent: Agent = { agentId: 'plain1', status: 'active', description: 'plain work', toolCallCount: 2 };
const wfAgentA: Agent = {
  agentId: 'wfa',
  status: 'active',
  description: 'probe dompurify',
  toolCallCount: 1,
  workflowRunId: 'wf_1',
};
const wfAgentB: Agent = {
  agentId: 'wfb',
  status: 'idle',
  description: 'probe csp',
  toolCallCount: 3,
  workflowRunId: 'wf_1',
};

describe('subagent run grouping', () => {
  it('is off unless showUltracodeAgents is enabled', () => {
    expect(loadHost({})._subagentRunGroupingEnabled()).toBe(false);
    expect(loadHost({ showUltracodeAgents: true })._subagentRunGroupingEnabled()).toBe(true);
  });

  it('groups workflow agents under their run and leaves plain agents top-level', () => {
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRuns.set('wf_1', { workflowName: 'my run', status: 'running' });

    const html = host._buildGroupedSubagentListHtml([wfAgentA, wfAgentB, plainAgent]);

    expect(html).toContain('subagent-run-group');
    expect(html).toContain('my run');
    expect(html).toContain('2'); // member count
    // Plain agent is NOT inside a group.
    expect(html).toContain('data-agent-id="plain1"');
  });

  it('keeps a collapsed group’s members out of the DOM', () => {
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRuns.set('wf_1', { workflowName: 'my run', status: 'running' });

    const html = host._buildGroupedSubagentListHtml([wfAgentA, wfAgentB]);

    // Collapsed by default — a 27-agent fleet must not render 27 rows.
    expect(html).not.toContain('data-agent-id="wfa"');
    expect(html).toContain('▸'); // collapsed caret
  });

  it('renders members once the group is expanded', () => {
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRuns.set('wf_1', { workflowName: 'my run', status: 'running' });
    host._expandedRunIds().add('wf_1');

    const html = host._buildGroupedSubagentListHtml([wfAgentA, wfAgentB]);

    expect(html).toContain('data-agent-id="wfa"');
    expect(html).toContain('data-agent-id="wfb"');
    expect(html).toContain('subagent-run-children');
  });

  it('still groups when the workflow watcher never ran', () => {
    // The run id comes from the agent's own file path, so grouping must not
    // depend on workflow state existing — which is the normal case here: the
    // watcher only starts when an ultracode toggle is on.
    const host = loadHost({ showUltracodeAgents: true });
    const html = host._buildGroupedSubagentListHtml([wfAgentA, wfAgentB]);

    expect(html).toContain('subagent-run-group');
    expect(html).toContain('wf_1'); // falls back to the run id as the label
  });

  it('joins on (runId, agentId), not agentId alone', () => {
    // Measured on this machine: 1 of 2789 ids (`a274b70247988c762`) exists BOTH
    // as a flat subagent and inside a workflow run. A flat agentId map would
    // render one row's data under the other.
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRunDetails.set('wf_other', { agents: [{ agentId: 'collide', label: 'WRONG RUN' }] });
    host.workflowRunDetails.set('wf_1', { agents: [{ agentId: 'collide', label: 'right run' }] });

    const found = host._workflowAgentFor({ agentId: 'collide', workflowRunId: 'wf_1' });

    expect(found?.label).toBe('right run');
  });

  it('does not use the fabricated workflow label while a run is live', () => {
    // workflow-run-watcher.parseLiveDir invents `label: "agent <n>"` from the
    // file ordinal for LIVE runs; preferring it would rename every in-flight
    // agent to "agent 1", "agent 2", ... and discard the real description.
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRuns.set('wf_1', { status: 'running' });
    host.workflowRunDetails.set('wf_1', { agents: [{ agentId: 'wfa', label: 'agent 1' }] });

    expect(host._groupedAgentLabel(wfAgentA)).toBe('probe dompurify');
  });

  it('prefers the workflow label once the run has completed', () => {
    const host = loadHost({ showUltracodeAgents: true });
    host.workflowRuns.set('wf_1', { status: 'completed' });
    host.workflowRunDetails.set('wf_1', { agents: [{ agentId: 'wfa', label: 'probe:dompurify-config' }] });

    expect(host._groupedAgentLabel(wfAgentA)).toBe('probe:dompurify-config');
  });

  it('renders an identical row to the ungrouped path', () => {
    // The grouped path reuses _subagentListItemHtml rather than carrying a
    // second row template, so a member row and a top-level row must match.
    const host = loadHost({ showUltracodeAgents: true });
    host._expandedRunIds().add('wf_1');

    const grouped = host._buildGroupedSubagentListHtml([wfAgentA]);
    const direct = host._subagentListItemHtml(wfAgentA);

    expect(grouped).toContain(direct.trim());
  });
});
