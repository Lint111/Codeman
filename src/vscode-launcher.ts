/** Host-side VS Code launcher for File Viewer workspace and diff actions. */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { GitDiffDetail } from './git-repository-browser.js';

function editorBinary(): string {
  return process.env.CODEMAN_EDITOR_BINARY || 'code';
}

function launch(args: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(editorBinary(), args, {
      stdio: 'ignore',
      env: process.env,
    });
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.on('error', () => {});
      child.unref();
      resolve(child);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

export async function openWorkspaceInVsCode(workingDir: string): Promise<void> {
  const stat = await fs.stat(workingDir);
  if (!stat.isDirectory()) throw new Error('Workspace path is not a directory');
  await launch(['--reuse-window', workingDir]);
}

function safeSnapshotName(filePath: string): string {
  const cleaned = basename(filePath)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-160);
  return cleaned || 'file.txt';
}

export async function openDiffInVsCode(detail: GitDiffDetail): Promise<void> {
  if (detail.binary) throw new Error('Binary files cannot be opened as a text diff');
  if (detail.truncated) throw new Error('The diff is too large to open safely');

  const snapshotDir = await fs.mkdtemp(join(tmpdir(), 'codeman-vscode-diff-'));
  const fileName = safeSnapshotName(detail.path);
  const beforePath = join(snapshotDir, `before-${fileName}`);
  const afterPath = join(snapshotDir, `after-${fileName}`);
  try {
    await Promise.all([
      fs.writeFile(beforePath, detail.beforeContent ?? '', 'utf8'),
      fs.writeFile(afterPath, detail.afterContent ?? '', 'utf8'),
    ]);
    const child = await launch(['--reuse-window', '--wait', '--diff', beforePath, afterPath]);
    const cleanup = () => {
      void fs.rm(snapshotDir, { recursive: true, force: true });
    };
    child.once('exit', cleanup);
    child.once('error', cleanup);
    if (child.exitCode !== null) cleanup();
  } catch (error) {
    await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
