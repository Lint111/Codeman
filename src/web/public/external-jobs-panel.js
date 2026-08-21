/**
 * @fileoverview External job projection panel.
 *
 * Hydrates from the durable integration projection endpoint and then applies
 * typed integration SSE events. It deliberately renders status metadata only;
 * provider-local prompts, logs, and filesystem paths stay out of the UI.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 */
/* global CodemanApp, escapeHtml */

Object.assign(CodemanApp.prototype, {
  _ensureExternalJobState() {
    if (!this.externalJobs) this.externalJobs = new Map();
  },

  async loadExternalJobs() {
    this._ensureExternalJobState();
    try {
      const response = await fetch('/api/integrations/jobs');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const jobs = payload?.data?.data ?? payload?.data ?? [];
      if (!Array.isArray(jobs)) return;
      this.externalJobs.clear();
      for (const job of jobs) this._upsertExternalJob(job);
      this.renderExternalJobsPanel();
    } catch (error) {
      console.debug('[external-jobs] projection unavailable', error);
    }
  },

  _onExternalJobUpdated(data) {
    this._upsertExternalJob(data);
  },

  _onExternalJobCompleted(data) {
    this._upsertExternalJob(data);
    this.showToast?.(`External job completed: ${this._externalJobLabel(data)}`, 'success');
  },

  _onExternalJobFailed(data) {
    this._upsertExternalJob(data);
    this.showToast?.(`External job failed: ${this._externalJobLabel(data)}`, 'error');
  },

  _upsertExternalJob(data) {
    this._ensureExternalJobState();
    const id = data?.subject?.id;
    if (typeof id !== 'string' || !id) return;
    this.externalJobs.set(id, data);
    this.renderExternalJobsPanel();
  },

  _externalJobLabel(job) {
    return job?.correlation?.taskRef || job?.subject?.id || 'job';
  },

  toggleExternalJobsPanel() {
    const panel = document.getElementById('externalJobsPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) this.renderExternalJobsPanel();
  },

  closeExternalJobsPanel() {
    const panel = document.getElementById('externalJobsPanel');
    if (panel) {
      panel.classList.remove('open');
      panel.classList.add('hidden');
    }
  },

  renderExternalJobsPanel() {
    this._ensureExternalJobState();
    const list = document.getElementById('externalJobsList');
    const badge = document.getElementById('externalJobsBadge');
    if (!list) return;
    const jobs = [...this.externalJobs.values()].sort((a, b) =>
      String(b.receivedAt || '').localeCompare(String(a.receivedAt || ''))
    );
    const activeCount = jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job?.state?.status)).length;
    if (badge) {
      badge.textContent = activeCount ? String(activeCount) : '';
      badge.classList.toggle('hidden', activeCount === 0);
    }
    if (!jobs.length) {
      list.innerHTML = '<div class="external-job-empty">No external jobs received</div>';
      return;
    }
    list.innerHTML = jobs
      .slice(0, 100)
      .map((job) => {
        const status = String(job?.state?.status || 'unknown');
        const provider = job?.state?.provider || 'external';
        const usage = job?.state?.usageClass || '';
        const task = this._externalJobLabel(job);
        const artifacts = Array.isArray(job?.state?.artifactRefs) ? job.state.artifactRefs.length : 0;
        return `<article class="external-job-card">
        <div class="external-job-card-top">
          <strong>${escapeHtml(task)}</strong>
          <span class="external-job-status external-job-status-${escapeHtml(status)}">${escapeHtml(status)}</span>
        </div>
        <div class="external-job-meta">
          <span>${escapeHtml(provider)}</span>
          ${usage ? `<span>${escapeHtml(usage)}</span>` : ''}
          ${artifacts ? `<span>${artifacts} artifact${artifacts === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="external-job-meta external-job-muted">${escapeHtml(job?.subject?.id || '')}</div>
      </article>`;
      })
      .join('');
  },
});
