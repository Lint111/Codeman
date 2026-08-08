/** Standalone transcript page for a named, reusable subagent browser tab. */

(function initializeSubagentViewer() {
  'use strict';

  const INITIAL_LIMIT = 200;
  const POLL_MS = 2000;
  const agentId = decodeURIComponent(location.pathname.match(/^\/subagent\/([^/]+)$/)?.[1] || '');
  const elements = {
    returnButton: document.getElementById('subagentViewerReturn'),
    close: document.getElementById('subagentViewerClose'),
    title: document.getElementById('subagentViewerTitle'),
    workspace: document.getElementById('subagentViewerWorkspace'),
    status: document.getElementById('subagentViewerStatus'),
    scroller: document.getElementById('subagentViewerScroller'),
    content: document.getElementById('subagentViewerContent'),
    meta: document.getElementById('subagentViewerMeta'),
    latest: document.getElementById('subagentViewerLatest'),
  };
  let requestId = 0;
  let abortController = null;
  let lastContent = null;
  let agentStatus = 'active';

  try {
    const skin = localStorage.getItem('codeman:skin');
    if (skin) document.documentElement.dataset.skin = skin;
  } catch {}

  function renderMarkdown(markdown) {
    return sanitizeMarkdownHtml(marked.parse(markdown || ''));
  }

  function returnToCodeman() {
    if (window.opener && !window.opener.closed) {
      window.opener.focus();
      return;
    }
    location.assign('/');
  }

  async function loadMetadata() {
    if (!agentId) throw new Error('Invalid subagent address');
    const response = await fetch(`/api/subagents/${encodeURIComponent(agentId)}`, { cache: 'no-store' });
    const envelope = await response.json();
    if (!response.ok || !envelope.success || !envelope.data) {
      throw new Error(envelope.error || 'Subagent unavailable');
    }
    const agent = envelope.data;
    agentStatus = agent.status || 'active';
    const label = agent.description || agent.agentId || agentId;
    elements.title.textContent = label;
    elements.title.title = label;
    elements.workspace.textContent = agent.workingDir || '';
    elements.workspace.title = agent.workingDir || '';
    elements.status.textContent = agentStatus;
    elements.status.dataset.status = agentStatus;
    document.title = `${label} · Codeman`;
  }

  const tailWindow = SubagentTranscriptView.createTailWindow({
    scroller: elements.scroller,
    latestButton: elements.latest,
    initialLimit: INITIAL_LIMIT,
    pageSize: INITIAL_LIMIT,
    onRequest: (options) => refreshTranscript(options),
  });

  async function refreshTranscript(options = {}) {
    if (!agentId) return;
    const currentRequestId = ++requestId;
    const anchor = tailWindow.captureAnchor();
    abortController?.abort();
    abortController = new AbortController();
    try {
      const query = new URLSearchParams({ format: 'blocks', limit: String(tailWindow.limit) });
      const response = await fetch(`/api/subagents/${encodeURIComponent(agentId)}/transcript?${query}`, {
        cache: 'no-store',
        signal: abortController.signal,
      });
      const envelope = await response.json();
      if (!response.ok || !envelope.success || !envelope.data) {
        throw new Error(envelope.error || 'Transcript unavailable');
      }
      if (currentRequestId !== requestId) return;

      const data = envelope.data;
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      const content = JSON.stringify(blocks);
      const firstRender = lastContent === null;
      if (content !== lastContent) {
        lastContent = content;
        SubagentTranscriptView.replace(elements.content, blocks, renderMarkdown);
      }
      const loaded = Number(data.entryCount) || 0;
      const total = Math.max(loaded, Number(data.totalEntryCount) || loaded);
      tailWindow.setCounts(loaded, total);
      tailWindow.restoreAfterRender(anchor, {
        preserveAnchor: options.preserveAnchor === true,
        scrollLatest: options.scrollLatest === true,
        firstRender,
      });
      elements.meta.textContent = `${loaded} of ${total} entries · ${new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`;
    } catch (error) {
      if (error?.name === 'AbortError' || currentRequestId !== requestId) return;
      elements.meta.textContent = error.message || 'Transcript unavailable';
    }
  }

  elements.returnButton.addEventListener('click', returnToCodeman);

  /**
   * Close this transcript window and let the opener re-tile the survivors.
   *
   * `window.close()` is only permitted on a script-opened window, which this
   * always is (it is reached via `window.open` from Codeman). If a browser
   * refuses anyway, fall back to returning rather than leaving a dead-end
   * button.
   */
  function closeTranscriptWindow() {
    try {
      if (window.opener && !window.opener.closed) {
        // Ask the opener to reflow the remaining popups once this one is gone.
        // Guarded: the opener may be an older build without the handler.
        window.opener.postMessage({ type: 'codeman:subagent-transcript-closed', agentId }, location.origin);
      }
    } catch {
      /* opener navigated away or is cross-origin — closing still works */
    }
    window.close();
    // Reached only if close() was refused.
    setTimeout(() => {
      if (!window.closed) returnToCodeman();
    }, 150);
  }

  elements.close?.addEventListener('click', closeTranscriptWindow);
  document.addEventListener('keydown', (event) => {
    // Esc is the expected close gesture for a single-purpose popup.
    if (event.key === 'Escape' && !event.defaultPrevented) closeTranscriptWindow();
  });
  window.addEventListener('beforeunload', () => {
    abortController?.abort();
    tailWindow.dispose();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshTranscript();
  });

  Promise.all([loadMetadata(), refreshTranscript({ scrollLatest: true })]).catch((error) => {
    elements.status.textContent = 'Unavailable';
    elements.content.replaceChildren();
    const message = document.createElement('div');
    message.className = 'sat-empty';
    message.textContent = String(error.message || error);
    elements.content.appendChild(message);
  });
  setInterval(() => {
    if (!document.hidden && agentStatus !== 'completed') void refreshTranscript();
  }, POLL_MS);
  setInterval(() => {
    if (!document.hidden) void loadMetadata().catch(() => {});
  }, 10_000);
})();
