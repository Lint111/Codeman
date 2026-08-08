/**
 * @fileoverview Tests for mux-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerMuxRoutes } from '../../src/web/routes/mux-routes.js';

describe('mux-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    // Add mux methods that mux-routes needs but mock-route-context doesn't provide
    harness = await createRouteTestHarness(registerMuxRoutes);
    harness.ctx.mux.getSessionsWithStats = vi.fn(async () => [{ name: 'codeman-abc', pid: 1234, created: Date.now() }]);
    harness.ctx.mux.isAvailable = vi.fn(() => true);
    harness.ctx.mux.reconcileSessions = vi.fn(async () => ({
      orphaned: [],
      missing: [],
      reconciled: 0,
    }));
    harness.ctx.mux.startStatsCollection = vi.fn();
    harness.ctx.mux.stopStatsCollection = vi.fn();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/mux-sessions ==========

  describe('GET /api/mux-sessions', () => {
    it('returns mux sessions and availability', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/mux-sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.muxAvailable).toBe(true);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].name).toBe('codeman-abc');
    });

    it('returns muxAvailable false when mux is unavailable', async () => {
      harness.ctx.mux.isAvailable = vi.fn(() => false);
      harness.ctx.mux.getSessionsWithStats = vi.fn(async () => []);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/mux-sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.muxAvailable).toBe(false);
      expect(body.sessions).toHaveLength(0);
    });
  });

  // ========== DELETE /api/mux-sessions/:sessionId ==========

  describe('DELETE /api/mux-sessions/:sessionId', () => {
    it('kills a mux session and returns success', async () => {
      harness.ctx.mux.killSession = vi.fn(async () => true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/mux-sessions/codeman-abc',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.killed).toBe(true);
      expect(harness.ctx.mux.killSession).toHaveBeenCalledWith('codeman-abc');
    });

    it('returns success false when kill fails', async () => {
      harness.ctx.mux.killSession = vi.fn(async () => false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/mux-sessions/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.killed).toBe(false);
    });
  });

  // ========== POST /api/mux-sessions/reconcile ==========

  describe('POST /api/mux-sessions/reconcile', () => {
    it('returns reconciliation result', async () => {
      const reconcileResult = { alive: [], dead: [], discovered: ['old-session'], adopted: ['old-session'] };
      harness.ctx.resyncMuxSessions = vi.fn(async () => reconcileResult);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/mux-sessions/reconcile',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.discovered).toEqual(['old-session']);
      expect(body.adopted).toEqual(['old-session']);
    });

    // The endpoint used to call `mux.reconcileSessions()` directly, which only
    // refreshes mux-level tracking: it answered `discovered: [...]` while the
    // session list stayed unchanged, so a pane created after this server booted
    // never became visible. Resync must go through the ADOPTING path.
    it('adopts discovered panes instead of only reporting them', async () => {
      const reconcileOnly = vi.fn(async () => ({ alive: [], dead: [], discovered: ['pane-created-later'] }));
      harness.ctx.mux.reconcileSessions = reconcileOnly;
      harness.ctx.resyncMuxSessions = vi.fn(async () => ({
        alive: [],
        dead: [],
        discovered: ['pane-created-later'],
        adopted: ['pane-created-later'],
      }));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/mux-sessions/reconcile',
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx.resyncMuxSessions).toHaveBeenCalledTimes(1);
      // Bare reconcile must NOT be the route's entry point — it cannot adopt.
      expect(reconcileOnly).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).adopted).toEqual(['pane-created-later']);
    });
  });

  // ========== POST /api/mux-sessions/stats/start ==========

  describe('POST /api/mux-sessions/stats/start', () => {
    it('starts stats collection', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/mux-sessions/stats/start',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
      expect(harness.ctx.mux.startStatsCollection).toHaveBeenCalled();
    });
  });

  // ========== POST /api/mux-sessions/stats/stop ==========

  describe('POST /api/mux-sessions/stats/stop', () => {
    it('stops stats collection', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/mux-sessions/stats/stop',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
      expect(harness.ctx.mux.stopStatsCollection).toHaveBeenCalled();
    });
  });
});
