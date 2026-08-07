import type { SubagentTranscriptEntry } from './subagent-watcher.js';

const MAX_TOOL_TEXT_CHARS = 12_000;
const MAX_DIFF_LINES = 400;
const MAX_LCS_CELLS = 120_000;
const DIFF_CONTEXT_LINES = 3;

export type SubagentTranscriptDiffKind = 'context' | 'add' | 'remove' | 'meta';

export interface SubagentTranscriptDiffLine {
  kind: SubagentTranscriptDiffKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface SubagentTranscriptMessageBlock {
  kind: 'message';
  id: string;
  timestamp: string;
  role: 'assistant' | 'user';
  markdown: string;
}

export interface SubagentTranscriptToolBlock {
  kind: 'tool';
  id: string;
  timestamp: string;
  toolUseId?: string;
  name: string;
  summary: string;
  defaultOpen?: boolean;
  status: 'running' | 'complete' | 'error';
  inputPreview: string;
  inputTruncated?: boolean;
  result?: string;
  resultTruncated?: boolean;
  diff?: SubagentTranscriptDiffLine[];
  diffTruncated?: boolean;
}

export interface SubagentTranscriptProgressBlock {
  kind: 'progress';
  id: string;
  timestamp: string;
  label: string;
  detail?: string;
  count?: number;
}

export type SubagentTranscriptBlock =
  | SubagentTranscriptMessageBlock
  | SubagentTranscriptToolBlock
  | SubagentTranscriptProgressBlock;

interface TextClip {
  text: string;
  truncated: boolean;
}

function clipText(value: string, maxChars: number = MAX_TOOL_TEXT_CHARS): TextClip {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function compactDiff(lines: SubagentTranscriptDiffLine[]): {
  lines: SubagentTranscriptDiffLine[];
  truncated: boolean;
} {
  if (lines.length <= MAX_DIFF_LINES) return { lines, truncated: false };
  const headCount = Math.floor(MAX_DIFF_LINES / 2);
  const tailCount = MAX_DIFF_LINES - headCount - 1;
  const omitted = lines.length - headCount - tailCount;
  return {
    lines: [
      ...lines.slice(0, headCount),
      { kind: 'meta', text: `... ${omitted} diff lines omitted ...` },
      ...lines.slice(-tailCount),
    ],
    truncated: true,
  };
}

function trimUnchangedContext(lines: SubagentTranscriptDiffLine[]): SubagentTranscriptDiffLine[] {
  const changed = lines
    .map((line, index) => (line.kind === 'add' || line.kind === 'remove' ? index : -1))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const keep = new Set<number>();
  for (const index of changed) {
    for (
      let cursor = Math.max(0, index - DIFF_CONTEXT_LINES);
      cursor <= Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES);
      cursor++
    ) {
      keep.add(cursor);
    }
  }

  const result: SubagentTranscriptDiffLine[] = [];
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) result.push({ kind: 'meta', text: '...' });
    result.push(lines[index]);
    previous = index;
  }
  return result;
}

function editDiff(oldText: string, newText: string): SubagentTranscriptDiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const rows: SubagentTranscriptDiffLine[] = [];

  if ((oldLines.length + 1) * (newLines.length + 1) > MAX_LCS_CELLS) {
    oldLines.forEach((text, index) => rows.push({ kind: 'remove', text, oldLine: index + 1 }));
    newLines.forEach((text, index) => rows.push({ kind: 'add', text, newLine: index + 1 }));
    return rows;
  }

  const matrix = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      matrix[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? matrix[oldIndex + 1][newIndex + 1] + 1
          : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
    }
  }

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: 'context', text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex++;
      newIndex++;
    } else if (
      oldIndex < oldLines.length &&
      (newIndex >= newLines.length || matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1])
    ) {
      rows.push({ kind: 'remove', text: oldLines[oldIndex], oldLine: oldIndex + 1 });
      oldIndex++;
    } else {
      rows.push({ kind: 'add', text: newLines[newIndex], newLine: newIndex + 1 });
      newIndex++;
    }
  }

  return trimUnchangedContext(rows);
}

function addedFileDiff(content: string): SubagentTranscriptDiffLine[] {
  return splitLines(content).map((text, index) => ({ kind: 'add', text, newLine: index + 1 }));
}

function looksLikePatch(text: string): boolean {
  return /^(?:diff --git|@@\s+-\d+|\*\*\* (?:Begin Patch|Update File|Add File|Delete File)|---\s+|\+\+\+\s+)/m.test(
    text
  );
}

function patchDiff(text: string): SubagentTranscriptDiffLine[] {
  const rows: SubagentTranscriptDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of splitLines(text)) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (
      /^(?:diff --git|index |--- |\+\+\+ |\*\*\* (?:Begin Patch|End Patch|Update File|Add File|Delete File|Move to))/.test(
        line
      )
    ) {
      rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newLine });
      if (newLine !== undefined) newLine++;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1), oldLine });
      if (oldLine !== undefined) oldLine++;
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
    } else {
      rows.push({ kind: 'meta', text: line });
    }
  }
  return rows;
}

function changeListDiff(changes: unknown[]): SubagentTranscriptDiffLine[] {
  const rows: SubagentTranscriptDiffLine[] = [];
  for (const change of changes) {
    const record = recordValue(change);
    if (!record) continue;
    const patch = stringValue(record.diff) ?? stringValue(record.patch);
    if (patch && looksLikePatch(patch)) {
      rows.push(...patchDiff(patch));
      continue;
    }
    const kind = stringValue(record.kind) ?? 'changed';
    const path = stringValue(record.path) ?? stringValue(record.file_path) ?? '';
    rows.push({ kind: 'meta', text: `${kind} ${path}`.trim() });
  }
  return rows;
}

function diffFromInput(name: string, input: Record<string, unknown>): SubagentTranscriptDiffLine[] {
  const oldText = stringValue(input.old_string) ?? stringValue(input.oldString);
  const newText = stringValue(input.new_string) ?? stringValue(input.newString);
  if (oldText !== undefined && newText !== undefined) return editDiff(oldText, newText);

  const patch = stringValue(input.patch) ?? stringValue(input.diff);
  if (patch && looksLikePatch(patch)) return patchDiff(patch);

  if (Array.isArray(input.changes)) return changeListDiff(input.changes);

  const content = stringValue(input.content);
  if (/write|create/i.test(name) && content !== undefined) return addedFileDiff(content);
  return [];
}

function compactSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const shell = trimmed.match(
    /^(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:bash|dash|fish|sh|zsh)\s+-[a-z]*c\s+([\s\S]+)$/i
  );
  if (!shell) return trimmed;

  const body = shell[1].trim();
  if (body.startsWith('"') && body.endsWith('"')) {
    try {
      const decoded = JSON.parse(body);
      if (typeof decoded === 'string') return decoded.trim();
    } catch {
      return body.slice(1, -1).trim();
    }
  }
  if (body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'\\''/g, "'").trim();
  return body;
}

function bashIntent(command: string): string {
  const body = unwrapShellCommand(command);
  const normalized = body.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (/\buntil\b.*\bkill\s+-0\b|\bwhile\b.*\bkill\s+-0\b/.test(lower)) return 'Wait for background task';
  if (/\bgit\s+diff\b/.test(lower) && /--check\b/.test(lower)) return 'Validate working changes';
  if (/\bgit\s+diff\b/.test(lower)) return 'Review working changes';
  if (/\bgit\s+status\b/.test(lower)) return 'Inspect repository status';
  if (/\bgit\s+(?:log|show)\b/.test(lower)) return 'Inspect commit history';
  if (
    /\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/.test(
      lower
    )
  ) {
    const focused = /(?:^|\s)(?:test\/|tests\/|src\/).*\.(?:test|spec)\.|\s(?:-t|--testnamepattern)\b/.test(lower);
    return focused ? 'Run focused tests' : 'Run tests';
  }
  if (
    /\b(?:dotnet\s+build|cargo\s+build|go\s+build|cmake\s+--build|npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build)\b/.test(
      lower
    )
  ) {
    return 'Build project';
  }
  if (/\b(?:rg|grep)\b/.test(lower)) return 'Search source files';
  if (/\b(?:sed\s+-n|cat|head|tail)\b/.test(lower)) return 'Inspect source files';
  if (/\b(?:find|ls|pwd)\b/.test(lower)) return 'Inspect files and workspace';
  if (/\b(?:npm|pnpm|yarn)\s+(?:ci|install)\b/.test(lower)) return 'Install dependencies';
  if (/\bcurl\b|\bwget\b/.test(lower)) return 'Request remote resource';

  const script = normalized.match(/\b(?:node|tsx|bash|sh)\s+([^\s;&|]+)/i)?.[1];
  if (script) return `Run ${script.split('/').at(-1)}`.slice(0, 180);
  return compactSummary(normalized.split('\n')[0]);
}

function isShellTool(name: string): boolean {
  return /^(?:bash|shell|exec_command)$/i.test(name.trim());
}

function isChangeTool(name: string): boolean {
  return /^(?:edit|write|create|apply_patch|patch)$/i.test(name.trim());
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (isShellTool(name)) {
    const description = stringValue(input.description) ?? stringValue(input.prompt);
    if (description) return compactSummary(description);
    const command = stringValue(input.command) ?? stringValue(input.cmd);
    if (command) return bashIntent(command);
  }
  const path =
    stringValue(input.file_path) ??
    stringValue(input.path) ??
    stringValue(input.target_file) ??
    stringValue(input.notebook_path);
  if (path) return path;
  const command = stringValue(input.command) ?? stringValue(input.cmd);
  if (command) return command.split('\n')[0].slice(0, 180);
  const query = stringValue(input.query) ?? stringValue(input.pattern);
  if (query) return query.slice(0, 180);
  const description = stringValue(input.description) ?? stringValue(input.prompt);
  if (description) return compactSummary(description);
  if (Array.isArray(input.changes))
    return `${input.changes.length} file change${input.changes.length === 1 ? '' : 's'}`;
  return name;
}

function inputPreview(input: Record<string, unknown>): TextClip {
  const displayInput = { ...input };
  for (const key of ['old_string', 'oldString', 'new_string', 'newString', 'content', 'patch', 'diff', 'changes']) {
    delete displayInput[key];
  }
  if (Object.keys(displayInput).length === 0) return { text: '', truncated: false };
  return clipText(JSON.stringify(displayInput, null, 2));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = recordValue(item);
      return record ? (stringValue(record.text) ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

function progressLabel(entry: SubagentTranscriptEntry): { label: string; detail?: string } {
  const data = entry.data;
  if (!data) return { label: 'Activity' };
  if (data.hookName || data.hookEvent) {
    return { label: 'Hook', detail: data.hookName ?? data.hookEvent };
  }
  if (data.type === 'query_update') return { label: 'Searching', detail: data.query };
  if (data.type === 'search_results_received') {
    return { label: 'Search results', detail: `${data.resultCount ?? 0} results` };
  }
  return { label: data.type.replace(/[_-]+/g, ' ') || 'Activity', detail: data.query };
}

function addProgressBlock(blocks: SubagentTranscriptBlock[], entry: SubagentTranscriptEntry, entryIndex: number): void {
  const { label, detail } = progressLabel(entry);
  const previous = blocks.at(-1);
  if (previous?.kind === 'progress' && previous.label === label && previous.detail === detail) {
    previous.count = (previous.count ?? 1) + 1;
    return;
  }
  blocks.push({
    kind: 'progress',
    id: `progress:${entryIndex}`,
    timestamp: entry.timestamp,
    label,
    detail,
  });
}

/** Convert normalized provider transcripts into semantic blocks for every live/full viewer. */
export function buildSubagentTranscriptBlocks(entries: SubagentTranscriptEntry[]): SubagentTranscriptBlock[] {
  const blocks: SubagentTranscriptBlock[] = [];
  const tools = new Map<string, SubagentTranscriptToolBlock>();

  entries.forEach((entry, entryIndex) => {
    if (entry.type === 'progress') {
      addProgressBlock(blocks, entry, entryIndex);
      return;
    }

    const message = entry.message;
    if (!message?.content) return;
    const role: 'assistant' | 'user' = message.role === 'assistant' ? 'assistant' : 'user';

    if (typeof message.content === 'string') {
      if (message.content.trim()) {
        blocks.push({
          kind: 'message',
          id: `message:${entryIndex}:0`,
          timestamp: entry.timestamp,
          role,
          markdown: message.content.trim(),
        });
      }
      return;
    }

    message.content.forEach((content, contentIndex) => {
      if (content.type === 'text' && content.text?.trim()) {
        blocks.push({
          kind: 'message',
          id: `message:${entryIndex}:${contentIndex}`,
          timestamp: entry.timestamp,
          role,
          markdown: content.text.trim(),
        });
        return;
      }

      if (content.type === 'tool_use') {
        const input = content.input ?? {};
        const preview = inputPreview(input);
        const rawDiff = diffFromInput(content.name ?? 'Tool', input);
        const compacted = compactDiff(rawDiff);
        const toolUseId = content.id || `entry-${entryIndex}-${contentIndex}`;
        const tool: SubagentTranscriptToolBlock = {
          kind: 'tool',
          id: `tool:${toolUseId}`,
          timestamp: entry.timestamp,
          toolUseId: content.id,
          name: content.name ?? 'Tool',
          summary: toolSummary(content.name ?? 'Tool', input),
          defaultOpen: isChangeTool(content.name ?? 'Tool') || undefined,
          status: 'running',
          inputPreview: preview.text,
          inputTruncated: preview.truncated || undefined,
          diff: compacted.lines.length ? compacted.lines : undefined,
          diffTruncated: compacted.truncated || undefined,
        };
        blocks.push(tool);
        if (content.id) tools.set(content.id, tool);
        return;
      }

      if (content.type !== 'tool_result') return;
      const text = resultText(content.content);
      const tool = content.tool_use_id ? tools.get(content.tool_use_id) : undefined;
      if (tool) {
        tool.status = content.is_error ? 'error' : 'complete';
        if (!tool.diff && looksLikePatch(text)) {
          const compacted = compactDiff(patchDiff(text));
          tool.diff = compacted.lines;
          tool.diffTruncated = compacted.truncated || undefined;
        } else if (text) {
          const clipped = clipText(text);
          tool.result = clipped.text;
          tool.resultTruncated = clipped.truncated || undefined;
        }
        return;
      }

      const clipped = clipText(text);
      blocks.push({
        kind: 'tool',
        id: `result:${content.tool_use_id || `${entryIndex}-${contentIndex}`}`,
        timestamp: entry.timestamp,
        toolUseId: content.tool_use_id,
        name: 'Tool result',
        summary: content.is_error ? 'Unmatched error result' : 'Unmatched tool result',
        status: content.is_error ? 'error' : 'complete',
        inputPreview: '',
        result: clipped.text,
        resultTruncated: clipped.truncated || undefined,
      });
    });
  });

  return blocks;
}
