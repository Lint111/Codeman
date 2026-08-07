import { describe, expect, it } from 'vitest';

import { parseCodexCliInvocations } from '../src/codex-cli-invocation.js';

describe('parseCodexCliInvocations', () => {
  it.each([
    ['codex exec "inspect the repository"', undefined],
    ['nohup /usr/bin/codex exec --json -C /tmp/work "do work" >worker.log 2>&1 &', '/tmp/work'],
    ['timeout 30 env CODEX_HOME=/tmp/codex codex -c model_reasoning_effort=high exec -C /tmp/probe -', '/tmp/probe'],
    ["bash -lc 'cat brief.md | codex exec --json -C /tmp/nested -' &", '/tmp/nested'],
    ['result=$(codex exec --json -C /tmp/substitution "answer")', '/tmp/substitution'],
    ['cat brief.md | codex exec --json -', undefined],
  ])('recognizes a direct Codex exec launch in %s', (command, workingDir) => {
    expect(parseCodexCliInvocations(command)).toEqual([expect.objectContaining({ kind: 'direct', workingDir })]);
  });

  it('recognizes multiple background workers in one Bash tool call', () => {
    expect(
      parseCodexCliInvocations(
        'codex exec -C /tmp/one "one" >one.log 2>&1 & codex exec -C /tmp/two "two" >two.log 2>&1 & wait'
      )
    ).toEqual([
      expect.objectContaining({ kind: 'direct', workingDir: '/tmp/one' }),
      expect.objectContaining({ kind: 'direct', workingDir: '/tmp/two' }),
    ]);
  });

  it('recognizes the durable wrapper through assignments, nohup, and bash', () => {
    expect(
      parseCodexCliInvocations(
        'CODEX_REPO="$S/board-wt" nohup bash ~/scripts/codex-dispatch.sh "$S/brief.md" board >launch.log 2>&1 &'
      )
    ).toEqual([
      {
        kind: 'wrapper',
        brief: '$S/brief.md',
        label: 'board',
      },
    ]);
  });

  it.each([
    'rg -n "codex exec" src test',
    'grep -n "codex exec --json" ~/scripts/codex-dispatch.sh',
    'printf "%s\\n" "codex exec do-work"',
    'ps -ef | rg "codex exec"',
    "cat > /tmp/launcher.sh <<'SH'\ncodex exec --json 'not running yet'\nSH",
  ])('does not confuse inspection or heredoc content with a launch: %s', (command) => {
    expect(parseCodexCliInvocations(command)).toEqual([]);
  });
});
