/**
 * @fileoverview Shared primitives for the two families of floating agent
 * windows — subagent windows (`subagent-windows.js`) and ultracode/Workflow run
 * windows (`ultracode-windows.js`).
 *
 * The two grew independently and converged on the same idioms: a draggable
 * window connected to its session tab by a line, minimize-to-tab with a hover
 * dropdown listing what was minimized, and restore/dismiss per entry. They
 * ALREADY share `makeWindowDraggable`, the `#connectionLines` SVG and the
 * `.subagent-dropdown*` CSS — ultracode reaches into subagent-windows for them
 * at runtime (see its @dependency header). What stayed duplicated is the markup
 * assembly, which had drifted into two near-identical copies.
 *
 * This module owns that markup. It deliberately does NOT unify the data layers:
 * `workflow-run-watcher` is standalone by design (see the ultracode invariant in
 * CLAUDE.md), the panels render genuinely different shapes (master-detail over
 * runs-and-phases vs a flat agent list), and their minimize semantics differ
 * (subagent windows hide in place; ultracode windows animate into the tab).
 * Callers supply their own entries and callbacks.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency escapeHtml (global)
 * @consumedby subagent-windows.js, ultracode-windows.js
 * @loadorder 14.9 of 16 — after api-client.js(14), before subagent-windows.js(15)
 */
/* global CodemanApp, escapeHtml */

Object.assign(CodemanApp.prototype, {
  /**
   * Render one entry of a minimized-window dropdown.
   *
   * @param {object} entry
   * @param {string} entry.name        display label (truncated here, not by callers)
   * @param {string} [entry.statusClass] status-dot modifier ('active'|'idle'|…)
   * @param {string} [entry.icon]      optional glyph shown before the name
   * @param {string} entry.restoreCall inline handler body that restores the item
   * @param {string} entry.dismissCall inline handler body that dismisses it
   * @param {string} [entry.title]     tooltip for the row
   * @returns {string} HTML
   */
  buildMinimizedWindowItem(entry) {
    const MAX_NAME = 25;
    const name = String(entry.name ?? '');
    const truncated = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}…` : name;
    const icon = entry.icon ? `<span class="ultracode-dd-icon">${escapeHtml(entry.icon)}</span>` : '';
    return (
      `<div class="subagent-dropdown-item" onclick="event.stopPropagation(); ${entry.restoreCall}" title="${escapeHtml(entry.title || 'Click to restore')}">` +
      // Omit the modifier entirely when absent — a trailing space in the class
      // attribute is harmless but shows up as a diff against the old markup.
      `<span class="subagent-dropdown-status${entry.statusClass ? ` ${escapeHtml(entry.statusClass)}` : ''}"></span>` +
      icon +
      `<span class="subagent-dropdown-name">${escapeHtml(truncated)}</span>` +
      `<span class="subagent-dropdown-close" onclick="event.stopPropagation(); ${entry.dismissCall}" title="Dismiss">&times;</span>` +
      `</div>`
    );
  },

  /**
   * Wrap dropdown items in the hover/pin tab badge.
   *
   * Hover, pin and hide are handled by the `showSubagentDropdown` /
   * `scheduleHideSubagentDropdown` / `pinSubagentDropdown` trio in
   * subagent-windows.js, which both families already used — the badge markup
   * was the only copy.
   *
   * @param {object} options
   * @param {string} options.badgeClass outer badge class ('tab-subagent-badge'|'tab-ultracode-badge')
   * @param {string} options.label      badge text, already pluralised by the caller
   * @param {string[]} options.items    rendered rows from buildMinimizedWindowItem
   * @returns {string} HTML, or '' when there is nothing minimized
   */
  buildMinimizedWindowBadge({ badgeClass, label, items }) {
    if (!items || items.length === 0) return '';
    return (
      `<span class="${escapeHtml(badgeClass)}"` +
      ` onmouseenter="app.showSubagentDropdown(this)"` +
      ` onmouseleave="app.scheduleHideSubagentDropdown(this)"` +
      ` onclick="event.stopPropagation(); app.pinSubagentDropdown(this);">` +
      `<span class="subagent-label">${escapeHtml(label)}</span>` +
      `<div class="subagent-dropdown"` +
      ` onmouseenter="app.cancelHideSubagentDropdown()"` +
      ` onmouseleave="app.scheduleHideSubagentDropdown(this.parentElement)">${items.join('')}</div>` +
      `</span>`
    );
  },

  /**
   * Fly `element` into its session tab, then run `done` to tear it down.
   *
   * Extracted from `_animateUltracodeWindowToTab`. Subagent windows currently
   * hide in place rather than animating; keeping this shared means that
   * difference is now a CHOICE at the call site instead of a capability only
   * one family happens to have.
   *
   * `done` runs exactly once — on transitionend, or on a timeout slightly
   * longer than the transition, because transitionend does not fire when the
   * element is display:none or the transition is interrupted.
   */
  animateWindowToTab(element, sessionId, done) {
    const tab = sessionId ? document.querySelector(`.session-tab[data-id="${sessionId}"]`) : null;
    if (!tab || !element) {
      done();
      return;
    }
    const w = element.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const dx = t.left + t.width / 2 - (w.left + w.width / 2);
    const dy = t.top + t.height / 2 - (w.top + w.height / 2);
    element.style.transformOrigin = 'center center';
    element.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.26s ease';
    element.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      element.style.transform = `translate(${dx}px, ${dy}px) scale(0.06)`;
      element.style.opacity = '0';
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    element.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 320);
  },
});
