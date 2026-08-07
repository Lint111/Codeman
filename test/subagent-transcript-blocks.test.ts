import { describe, expect, it } from 'vitest';

import { buildSubagentTranscriptBlocks, type SubagentTranscriptToolBlock } from '../src/subagent-transcript-blocks.js';
import type { SubagentTranscriptEntry } from '../src/subagent-watcher.js';

const base = {
  timestamp: '2026-08-02T10:30:00.000Z',
  agentId: 'agent-test',
  sessionId: 'session-test',
};

describe('buildSubagentTranscriptBlocks', () => {
  it('preserves complete Markdown messages as distinct readable blocks', () => {
    const entries: SubagentTranscriptEntry[] = [
      {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '## Result\n\nFirst paragraph.' },
            { type: 'text', text: '**Second message** with `code`.' },
          ],
        },
      },
    ];

    const blocks = buildSubagentTranscriptBlocks(entries);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'message', role: 'assistant', markdown: '## Result\n\nFirst paragraph.' });
    expect(blocks[1]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      markdown: '**Second message** with `code`.',
    });
  });

  it('pairs an Edit call with its result and emits line-level add/remove rows', () => {
    const entries: SubagentTranscriptEntry[] = [
      {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Edit',
              input: {
                file_path: '/repo/src/example.ts',
                old_string: 'const value = 1;\nconsole.log(value);',
                new_string: 'const value = 2;\nconsole.log(value);',
              },
            },
          ],
        },
      },
      {
        ...base,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Updated successfully' }],
        },
      },
    ];

    const blocks = buildSubagentTranscriptBlocks(entries);
    const tool = blocks[0] as SubagentTranscriptToolBlock;

    expect(tool).toMatchObject({
      kind: 'tool',
      name: 'Edit',
      summary: '/repo/src/example.ts',
      defaultOpen: true,
      status: 'complete',
      result: 'Updated successfully',
    });
    expect(tool.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'remove', text: 'const value = 1;', oldLine: 1 }),
        expect.objectContaining({ kind: 'add', text: 'const value = 2;', newLine: 1 }),
        expect.objectContaining({ kind: 'context', text: 'console.log(value);' }),
      ])
    );
    expect(tool.inputPreview).not.toContain('old_string');
    expect(tool.inputPreview).not.toContain('new_string');
  });

  it('recognizes unified diff output from a shell tool', () => {
    const entries: SubagentTranscriptEntry[] = [
      {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'git diff' } }],
        },
      },
      {
        ...base,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
      },
    ];

    const tool = buildSubagentTranscriptBlocks(entries)[0] as SubagentTranscriptToolBlock;

    expect(tool.summary).toBe('Review working changes');
    expect(tool.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'remove', text: 'old', oldLine: 1 }),
        expect.objectContaining({ kind: 'add', text: 'new', newLine: 1 }),
      ])
    );
    expect(tool.result).toBeUndefined();
  });

  it('uses explicit or deterministic intent for collapsed Bash summaries', () => {
    const entries: SubagentTranscriptEntry[] = [
      {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-described',
              name: 'Bash',
              input: { command: 'npm test', description: 'Verify the transcript renderer' },
            },
            {
              type: 'tool_use',
              id: 'tool-inferred',
              name: 'Bash',
              input: {
                command: '/bin/bash -lc "npx vitest run test/subagent-transcript-blocks.test.ts"',
              },
            },
          ],
        },
      },
    ];

    const tools = buildSubagentTranscriptBlocks(entries) as SubagentTranscriptToolBlock[];

    expect(tools.map((tool) => tool.summary)).toEqual(['Verify the transcript renderer', 'Run focused tests']);
    expect(tools.every((tool) => !tool.defaultOpen)).toBe(true);
  });

  it('coalesces repeated progress noise and marks unmatched results clearly', () => {
    const progress: SubagentTranscriptEntry = {
      ...base,
      type: 'progress',
      data: { type: 'query_update', query: 'Indexing repository' },
    };
    const unmatched: SubagentTranscriptEntry = {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphaned output', is_error: true }],
      },
    };

    const blocks = buildSubagentTranscriptBlocks([progress, progress, unmatched]);

    expect(blocks[0]).toMatchObject({ kind: 'progress', label: 'Searching', detail: 'Indexing repository', count: 2 });
    expect(blocks[1]).toMatchObject({
      kind: 'tool',
      name: 'Tool result',
      status: 'error',
      result: 'orphaned output',
    });
  });
});
