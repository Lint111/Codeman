/**
 * @fileoverview Marking subagents that belong to an ultracode/Workflow run.
 *
 * Workflow agents are written to `subagents/workflows/<runId>/agent-<id>.jsonl`
 * and plain Task agents to `subagents/agent-<id>.jsonl`. Both are discovered by
 * the SAME watcher (`watchWorkflowDirs` walks the nested dirs), so both arrive
 * in the subagent list looking identical — an ultracode fleet is
 * indistinguishable from ordinary subagents without this.
 *
 * The run id is recovered from the path the file was already found at, so the
 * subagent side never reads workflow state and `workflow-run-watcher` stays
 * standalone (see the ultracode invariant in CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { workflowRunIdFromPath } from '../src/subagent-watcher.js';

describe('workflowRunIdFromPath', () => {
  it('recovers the run id from a workflow agent path', () => {
    // Shape taken from a real tree.
    const path =
      '/home/liory/.claude/projects/-mnt-c-cpp/af1daf9e/subagents/workflows/wf_cbb5d960-e5d/agent-aec021b48ea1e5195.jsonl';
    expect(workflowRunIdFromPath(path)).toBe('wf_cbb5d960-e5d');
  });

  it('returns undefined for a plain Task subagent', () => {
    const path = '/home/liory/.claude/projects/-x/94e3aff6/subagents/agent-a22d7d73e8bbacf9b.jsonl';
    expect(workflowRunIdFromPath(path)).toBeUndefined();
  });

  it('handles the .meta.json sibling the watcher also registers', () => {
    const path = '/p/s/subagents/workflows/wf_abc123/agent-a1.meta.json';
    expect(workflowRunIdFromPath(path)).toBe('wf_abc123');
  });

  it('accepts Windows separators', () => {
    const path = 'C:\\Users\\x\\.claude\\projects\\p\\s\\subagents\\workflows\\wf_win1\\agent-a1.jsonl';
    expect(workflowRunIdFromPath(path)).toBe('wf_win1');
  });

  it('does not match a directory merely NAMED workflows elsewhere in the path', () => {
    // A project checkout containing `workflows/` must not be read as a run id;
    // only the segment directly under `subagents/` counts.
    const path = '/home/liory/repo/workflows/wf_nope/subagents/agent-a1.jsonl';
    expect(workflowRunIdFromPath(path)).toBeUndefined();
  });

  it('ignores a workflows dir with no run directory under it', () => {
    // A stray file sitting straight in `subagents/workflows/` has no owning run.
    const path = '/p/s/subagents/workflows/agent-a1.jsonl';
    expect(workflowRunIdFromPath(path)).toBeUndefined();
  });
});
