/**
 * @fileoverview Conservative recognition of Codex workers launched from shell commands.
 *
 * This is intentionally not a shell evaluator. It identifies Codex only when it
 * occupies an executable position, including common launch wrappers and nested
 * shells, while masking heredoc bodies and command text passed to unrelated
 * inspection tools.
 */

import { basename } from 'node:path';

export type CodexCliInvocation =
  | { kind: 'direct'; workingDir: string | undefined }
  | { kind: 'wrapper'; brief: string; label: string };

interface HereDoc {
  delimiter: string;
  stripTabs: boolean;
}

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHELL_KEYWORDS = new Set(['!', 'do', 'elif', 'if', 'then', 'time', 'until', 'while']);
const SIMPLE_WRAPPERS = new Set(['command', 'exec', 'nohup', 'setsid']);
const SHELLS = new Set(['bash', 'dash', 'sh', 'zsh']);
const CODEX_VALUE_OPTIONS = new Set([
  '-a',
  '--ask-for-approval',
  '-c',
  '--config',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
]);

function executableName(word: string): string {
  return basename(word).replace(/\.exe$/i, '');
}

function findHereDocs(line: string): HereDoc[] {
  const found: HereDoc[] = [];
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') continue;

    let cursor = i + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor++;
    while (/\s/.test(line[cursor] ?? '')) cursor++;

    let delimiter = '';
    const delimiterQuote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor++] : undefined;
    while (cursor < line.length) {
      const current = line[cursor];
      if (delimiterQuote ? current === delimiterQuote : /[\s;&|()<>]/.test(current)) break;
      if (current === '\\' && cursor + 1 < line.length) cursor++;
      delimiter += line[cursor++];
    }
    if (delimiter) found.push({ delimiter, stripTabs });
    i = cursor;
  }
  return found;
}

function stripHereDocBodies(command: string): string {
  const pending: HereDoc[] = [];
  return command
    .split('\n')
    .map((line) => {
      const active = pending[0];
      if (active) {
        const candidate = active.stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === active.delimiter) pending.shift();
        return '';
      }
      pending.push(...findHereDocs(line));
      return line;
    })
    .join('\n');
}

function extractCommandSubstitutions(command: string): { outer: string; nested: string[] } {
  const chars = [...command];
  const nested: string[] = [];
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = char;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (char !== '$' || chars[i + 1] !== '(') continue;

    let depth = 1;
    let innerQuote: "'" | '"' | undefined;
    let cursor = i + 2;
    for (; cursor < chars.length; cursor++) {
      const current = chars[cursor];
      if (current === '\\') {
        cursor++;
        continue;
      }
      if (innerQuote) {
        if (current === innerQuote) innerQuote = undefined;
        continue;
      }
      if (current === "'" || current === '"') {
        innerQuote = current;
        continue;
      }
      if (current === '(') depth++;
      if (current === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    nested.push(chars.slice(i + 2, cursor).join(''));
    for (let mask = i; mask <= cursor; mask++) chars[mask] = ' ';
    i = cursor;
  }
  return { outer: chars.join(''), nested };
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;

  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\') {
      current += char;
      if (i + 1 < command.length) current += command[++i];
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (';\n|&(){}'.includes(char) || char === '`') {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

function tokenizeShellSegment(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | undefined;

  const flush = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === '\\') {
      started = true;
      if (i + 1 < segment.length) current += segment[++i];
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === '#' && !started) break;
    current += char;
    started = true;
  }
  flush();
  return words;
}

function skipDecorators(words: string[], start: number): number {
  let cursor = start;
  while (cursor < words.length) {
    const word = words[cursor];
    if (ASSIGNMENT_PATTERN.test(word) || SHELL_KEYWORDS.has(word) || /^\d*(?:<|>)/.test(word)) {
      cursor++;
      continue;
    }
    break;
  }
  return cursor;
}

function skipOptions(words: string[], start: number): number {
  let cursor = start;
  while (cursor < words.length && words[cursor].startsWith('-')) {
    if (words[cursor] === '--') return cursor + 1;
    cursor++;
  }
  return cursor;
}

function parseCodexWords(words: string[], codexIndex: number): CodexCliInvocation[] {
  let cursor = codexIndex + 1;
  while (cursor < words.length) {
    const word = words[cursor];
    if (word === 'exec') break;
    if (word === '--') return [];
    if (!word.startsWith('-')) return [];
    if (CODEX_VALUE_OPTIONS.has(word) && cursor + 1 < words.length) cursor++;
    cursor++;
  }
  if (words[cursor] !== 'exec') return [];

  let workingDir: string | undefined;
  for (let i = codexIndex + 1; i < words.length; i++) {
    const word = words[i];
    if ((word === '-C' || word === '--cd') && words[i + 1]) workingDir = words[++i];
    else if (word.startsWith('--cd=')) workingDir = word.slice('--cd='.length);
  }
  return [{ kind: 'direct', workingDir }];
}

function parseWrapperWords(words: string[], scriptIndex: number): CodexCliInvocation[] {
  const brief = words[scriptIndex + 1];
  const label = words[scriptIndex + 2];
  if (!brief || !label || !LABEL_PATTERN.test(label)) return [];
  return [{ kind: 'wrapper', brief, label }];
}

function parseExecutable(words: string[], start: number, depth: number): CodexCliInvocation[] {
  if (depth > 8) return [];
  const executableIndex = skipDecorators(words, start);
  if (executableIndex >= words.length) return [];
  const executable = executableName(words[executableIndex]);

  if (executable === 'codex') return parseCodexWords(words, executableIndex);
  if (executable === 'codex-dispatch.sh' || executable === 'codex-run.sh') {
    return parseWrapperWords(words, executableIndex);
  }

  if (SHELLS.has(executable)) {
    for (let i = executableIndex + 1; i < words.length; i++) {
      if (/^-[^-]*c[^-]*$/.test(words[i])) {
        return words[i + 1] ? parseCommand(words[i + 1], depth + 1) : [];
      }
      if (!words[i].startsWith('-')) {
        const script = executableName(words[i]);
        return script === 'codex-dispatch.sh' || script === 'codex-run.sh' ? parseWrapperWords(words, i) : [];
      }
    }
    return [];
  }

  if (SIMPLE_WRAPPERS.has(executable)) {
    return parseExecutable(words, skipOptions(words, executableIndex + 1), depth + 1);
  }

  if (executable === 'env') {
    let cursor = executableIndex + 1;
    while (cursor < words.length) {
      if (words[cursor] === '-u' || words[cursor] === '--unset') cursor += 2;
      else if (words[cursor].startsWith('-') || ASSIGNMENT_PATTERN.test(words[cursor])) cursor++;
      else break;
    }
    return parseExecutable(words, cursor, depth + 1);
  }

  if (executable === 'timeout') {
    let cursor = executableIndex + 1;
    while (cursor < words.length && words[cursor].startsWith('-')) {
      if (['-k', '--kill-after', '-s', '--signal'].includes(words[cursor])) cursor += 2;
      else cursor++;
    }
    if (cursor < words.length) cursor++; // duration
    return parseExecutable(words, cursor, depth + 1);
  }

  if (executable === 'nice' || executable === 'stdbuf' || executable === 'sudo') {
    let cursor = executableIndex + 1;
    while (cursor < words.length && words[cursor].startsWith('-')) {
      const option = words[cursor++];
      if (['-n', '--adjustment', '-u', '--user', '-g', '--group'].includes(option) && cursor < words.length) cursor++;
    }
    return parseExecutable(words, cursor, depth + 1);
  }

  return [];
}

function parseCommand(command: string, depth: number): CodexCliInvocation[] {
  if (depth > 8) return [];
  const withoutHereDocs = stripHereDocBodies(command);
  const { outer, nested } = extractCommandSubstitutions(withoutHereDocs);
  const invocations = splitShellSegments(outer).flatMap((segment) =>
    parseExecutable(tokenizeShellSegment(segment), 0, depth)
  );
  for (const commandSubstitution of nested) invocations.push(...parseCommand(commandSubstitution, depth + 1));
  return invocations;
}

export function parseCodexCliInvocations(command: string): CodexCliInvocation[] {
  return typeof command === 'string' && command.trim() ? parseCommand(command, 0) : [];
}
