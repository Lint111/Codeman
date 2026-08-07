/**
 * @fileoverview Semantic renderer for normalized subagent transcript blocks.
 *
 * The server owns provider-specific transcript normalization and call/result pairing.
 * This module owns presentation only and is shared by the ordinary and
 * workflow-agent in-page transcript windows and the standalone transcript page.
 * Agent prose is rendered through CodemanApp._renderMarkdown(), which sanitizes it.
 *
 * @dependency app.js (_renderMarkdown is supplied as a callback)
 * @loadorder after app.js, before panels-ui.js and ultracode-windows.js
 */

(function attachSubagentTranscriptView(root) {
  function escape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderMessage(block, renderMarkdown) {
    let body;
    try {
      body = renderMarkdown(block.markdown || '');
    } catch {
      body = `<pre>${escape(block.markdown || '')}</pre>`;
    }
    const role = block.role === 'user' ? 'Task' : 'Agent';
    return `<article class="sat-message sat-message-${escape(block.role)}" data-transcript-block-id="${escape(block.id)}">
      <header class="sat-message-header"><span>${role}</span><time>${escape(formatTime(block.timestamp))}</time></header>
      <div class="sat-markdown rv-text">${body}</div>
    </article>`;
  }

  function renderDiffLine(line) {
    if (line.kind === 'meta') {
      return `<div class="sat-diff-line sat-diff-meta"><span></span><span></span><span></span><code>${escape(line.text)}</code></div>`;
    }
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    return `<div class="sat-diff-line sat-diff-${escape(line.kind)}">
      <span class="sat-diff-gutter">${line.oldLine == null ? '' : escape(line.oldLine)}</span>
      <span class="sat-diff-gutter">${line.newLine == null ? '' : escape(line.newLine)}</span>
      <span class="sat-diff-prefix">${prefix}</span><code>${escape(line.text)}</code>
    </div>`;
  }

  function renderTool(block) {
    const status = block.status || 'running';
    const summary =
      block.summary && block.summary !== block.name
        ? `<span class="sat-tool-summary" title="${escape(block.summary)}">${escape(block.summary)}</span>`
        : '';
    const input = block.inputPreview
      ? `<section class="sat-tool-section"><h4>Parameters${block.inputTruncated ? ' (truncated)' : ''}</h4><pre>${escape(block.inputPreview)}</pre></section>`
      : '';
    const diff =
      Array.isArray(block.diff) && block.diff.length
        ? `<section class="sat-tool-section sat-tool-change"><h4>Changes${block.diffTruncated ? ' (truncated)' : ''}</h4><div class="sat-diff">${block.diff.map(renderDiffLine).join('')}</div></section>`
        : '';
    const result = block.result
      ? `<section class="sat-tool-section"><h4>Result${block.resultTruncated ? ' (truncated)' : ''}</h4><pre>${escape(block.result)}</pre></section>`
      : '';
    const empty = !input && !diff && !result ? '<div class="sat-tool-empty">Waiting for result...</div>' : '';
    const open = block.defaultOpen ? ' open' : '';
    return `<details class="sat-tool sat-tool-${escape(status)}" data-transcript-block-id="${escape(block.id)}"${open}>
      <summary><span class="sat-tool-name">${escape(block.name || 'Tool')}</span>${summary}<span class="sat-tool-status">${escape(status)}</span><time>${escape(formatTime(block.timestamp))}</time></summary>
      <div class="sat-tool-body">${diff}${input}${result}${empty}</div>
    </details>`;
  }

  function renderProgress(block) {
    const count =
      block.count && block.count > 1 ? `<span class="sat-progress-count">${escape(block.count)}x</span>` : '';
    return `<div class="sat-progress" data-transcript-block-id="${escape(block.id)}">
      <span class="sat-progress-label">${escape(block.label || 'Activity')}</span>
      ${block.detail ? `<span class="sat-progress-detail">${escape(block.detail)}</span>` : ''}${count}
      <time>${escape(formatTime(block.timestamp))}</time>
    </div>`;
  }

  function render(blocks, renderMarkdown) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return '<div class="sat-empty">Waiting for output...</div>';
    }
    return blocks
      .map((block) => {
        if (block.kind === 'message') return renderMessage(block, renderMarkdown);
        if (block.kind === 'tool') return renderTool(block);
        if (block.kind === 'progress') return renderProgress(block);
        return '';
      })
      .join('');
  }

  function replace(container, blocks, renderMarkdown) {
    if (!container) return;
    const previousIds = new Set(
      Array.from(container.querySelectorAll('details[data-transcript-block-id]')).map((element) =>
        element.getAttribute('data-transcript-block-id')
      )
    );
    const openIds = new Set(
      Array.from(container.querySelectorAll('details[open][data-transcript-block-id]')).map((element) =>
        element.getAttribute('data-transcript-block-id')
      )
    );
    container.innerHTML = render(blocks, renderMarkdown);
    for (const details of container.querySelectorAll('details[data-transcript-block-id]')) {
      const blockId = details.getAttribute('data-transcript-block-id');
      if (previousIds.has(blockId)) details.open = openIds.has(blockId);
    }
  }

  /**
   * Own the implicit transcript window used by every transcript surface.
   * The newest bounded tail is the default. Reaching the top expands the tail;
   * returning to the bottom contracts it again and resumes lightweight polling.
   */
  function createTailWindow(options) {
    const scroller = options?.scroller;
    const latestButton = options?.latestButton;
    const onRequest = options?.onRequest;
    if (!scroller || !latestButton || typeof onRequest !== 'function') {
      throw new Error('createTailWindow requires a scroller, latest button, and request callback');
    }

    const initialLimit = Math.max(1, Number(options.initialLimit) || 200);
    const pageSize = Math.max(1, Number(options.pageSize) || initialLimit);
    const followThreshold = Math.max(0, Number(options.followThreshold) || 48);
    const historyThreshold = Math.max(followThreshold, Number(options.historyThreshold) || 80);
    let resetTimer = null;
    let loadingOlder = false;

    const state = {
      limit: initialLimit,
      loadedEntryCount: 0,
      totalEntryCount: 0,
      followLatest: true,
    };

    const request = (requestOptions = {}) => {
      try {
        return Promise.resolve(onRequest({ limit: state.limit, ...requestOptions }));
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const scrollToBottom = () => {
      requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    };

    const resetToLatest = () => {
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = null;
      state.followLatest = true;
      latestButton.hidden = true;
      if (state.limit === initialLimit) {
        scrollToBottom();
        return Promise.resolve();
      }
      state.limit = initialLimit;
      return request({ scrollLatest: true });
    };

    const loadOlder = async () => {
      if (loadingOlder || state.loadedEntryCount >= state.totalEntryCount || state.limit >= state.totalEntryCount) {
        return;
      }
      loadingOlder = true;
      state.limit = Math.min(state.totalEntryCount, state.limit + pageSize);
      try {
        await request({ preserveAnchor: true });
      } finally {
        loadingOlder = false;
      }
    };

    const handleScroll = () => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      state.followLatest = distanceFromBottom <= followThreshold;
      latestButton.hidden = state.followLatest;

      if (!state.followLatest) {
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = null;
        if (scroller.scrollTop <= historyThreshold) void loadOlder();
        return;
      }

      if (state.limit > initialLimit && !resetTimer) {
        resetTimer = setTimeout(() => {
          resetTimer = null;
          void resetToLatest();
        }, 180);
      }
    };

    latestButton.addEventListener('click', resetToLatest);
    scroller.addEventListener('scroll', handleScroll, { passive: true });

    return {
      state,
      get limit() {
        return state.limit;
      },
      get followLatest() {
        return state.followLatest;
      },
      setCounts(loadedEntryCount, totalEntryCount) {
        state.loadedEntryCount = Math.max(0, Number(loadedEntryCount) || 0);
        state.totalEntryCount = Math.max(state.loadedEntryCount, Number(totalEntryCount) || state.loadedEntryCount);
      },
      reset({ request: shouldRequest = false } = {}) {
        state.limit = initialLimit;
        state.loadedEntryCount = 0;
        state.totalEntryCount = 0;
        state.followLatest = true;
        latestButton.hidden = true;
        if (shouldRequest) return request({ scrollLatest: true });
        return Promise.resolve();
      },
      scrollToLatest: resetToLatest,
      captureAnchor() {
        return {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
        };
      },
      restoreAfterRender(anchor, { preserveAnchor = false, scrollLatest = false, firstRender = false } = {}) {
        if (scrollLatest || state.followLatest || firstRender) {
          scrollToBottom();
        } else if (preserveAnchor) {
          scroller.scrollTop = anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
        } else {
          scroller.scrollTop = anchor.scrollTop;
        }
      },
      dispose() {
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = null;
        latestButton.removeEventListener('click', resetToLatest);
        scroller.removeEventListener('scroll', handleScroll);
      },
    };
  }

  root.SubagentTranscriptView = Object.freeze({ render, replace, createTailWindow });
})(typeof globalThis !== 'undefined' ? globalThis : window);
