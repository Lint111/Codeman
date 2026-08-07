/**
 * @fileoverview Per-instance isolation: data directory + tmux socket.
 *
 * Codeman keeps all runtime state under `~/.codeman` and runs its tmux sessions
 * on a dedicated socket (`tmux -L codeman`). Both are PROCESS-WIDE and SHARED by
 * every Codeman instance on the machine — so a second instance pointed at the
 * same socket will discover and attach to the first instance's live sessions,
 * and two instances sharing `~/.codeman/state.json` will clobber each other.
 *
 * To let a beta build coexist with a production one, this module derives both
 * the data dir and the tmux socket from a single "instance" name:
 *   - default (unset/empty) → `~/.codeman`      + `tmux -L codeman`        (prod layout)
 *   - `CODEMAN_INSTANCE=beta` → `~/.codeman-beta` + `tmux -L codeman-beta`
 *   - `CODEMAN_INSTANCE=foo`  → `~/.codeman-foo`  + `tmux -L codeman-foo`
 *
 * The DEFAULT is the production layout so this is safe to ship to master: an
 * existing install keeps reading `~/.codeman`. To run a beta ALONGSIDE prod,
 * launch it with `CODEMAN_INSTANCE=beta` (and a distinct port, see below) —
 * `scripts/run-beta.sh` does both. The port is unrelated to the instance and is
 * set separately via `--port` / `CODEMAN_PORT` (see `src/cli.ts`).
 *
 * Individual overrides still win: `CODEMAN_DATA_DIR` (absolute data dir) and
 * `CODEMAN_TMUX_SOCKET` (socket name, validated in tmux-manager).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Instance name. Empty string (the default) = production layout (`~/.codeman`,
 * `-L codeman`), so this is safe on master and existing installs are untouched.
 * Set `CODEMAN_INSTANCE=beta` (e.g. via `scripts/run-beta.sh`) to run an
 * isolated beta alongside prod.
 */
export const CODEMAN_INSTANCE = process.env.CODEMAN_INSTANCE ?? '';

const INSTANCE_SUFFIX = CODEMAN_INSTANCE ? `-${CODEMAN_INSTANCE}` : '';

/** Default tmux socket for this instance. `CODEMAN_TMUX_SOCKET` still overrides. */
export const DEFAULT_TMUX_SOCKET = `codeman${INSTANCE_SUFFIX}`;

/**
 * VIEWER MODE (`CODEMAN_VIEWER=1`) — treat the tmux socket as a SHARED
 * development environment this instance observes rather than owns.
 *
 * Codeman normally pins each pane to `window-size manual` (see
 * `setManualWindowSize`, called once from `session.ts`) so its own arbitrated
 * size — the `_desktopSizeClaims` logic in `Session.resize()` — beats raw tmux
 * attach order. That arbitration lives in PER-PROCESS memory, so it works
 * within one instance and is invisible to any other instance on the same
 * socket. Two servers on one pane would then alternate authoritative
 * `resize-window` calls and reflow each other's viewers.
 *
 * In viewer mode we skip the `manual` pin and let tmux's own `window-size
 * latest` arbitrate across every attached client, whichever instance owns it.
 * Measured on a scratch pane (200x50 + 80x24 clients): `smallest` clamps to the
 * smaller, `manual` ignores clients entirely, `latest` lets both coexist at
 * their own client size with the window following the most-recently-ACTIVE one.
 * That is the cross-process behavior `manual` cannot provide — and it is the
 * same choice COD-106 already made for shared remote tmux servers.
 *
 * Off by default: single-instance installs keep the richer in-process
 * arbitration (90s idle claims + explicit takeControl), which tmux has no
 * equivalent for.
 */
export const CODEMAN_VIEWER_MODE = process.env.CODEMAN_VIEWER === '1';

let _ensured = false;

/**
 * Absolute path to this instance's data directory (created on first use). All
 * persisted state (`state.json`, `mux-sessions.json`, settings, push keys,
 * lifecycle log, screenshots, certs, …) lives here.
 */
export function getDataDir(): string {
  const dir = process.env.CODEMAN_DATA_DIR || join(homedir(), `.codeman${INSTANCE_SUFFIX}`);
  if (!_ensured) {
    try {
      mkdirSync(dir, { recursive: true });
      _ensured = true;
    } catch {
      /* best-effort; individual writers also mkdir as needed */
    }
  }
  return dir;
}

/** Join one or more segments onto this instance's data directory. */
export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}
