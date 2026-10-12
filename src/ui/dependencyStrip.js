/**
 * Measure Dependency Strip — renders one measure alongside its four
 * independent dependency dimensions as side-by-side lists.
 *
 * Hard rules from the component spec, enforced here:
 *  - Four columns, fixed order: Visuals, Downstream measures, Upstream
 *    measures, Upstream columns.
 *  - Columns are INDEPENDENT lists. No shared row index, no cross-column
 *    alignment, no <table>/<tr> anywhere — each column is its own <ul>.
 *  - Visible divider + padding between every pair of columns.
 *  - Container scrolls horizontally and never wraps columns to a new line;
 *    each column scrolls vertically on its own.
 *  - DAX is monospace, whitespace-preserving, never silently truncated.
 *  - Empty columns still render their title, count, and "No references."
 *  - Measure header and column titles stay sticky.
 *  - Identifiers render verbatim from the data. This component never infers
 *    lineage — it only displays what the producer gave it.
 */

import { esc } from './pageLayoutData.js';

const COLUMN_DEFS = [
  { key: 'visuals', id: 'dep-col-visuals', title: 'Visuals', noun: 'visual' },
  { key: 'downstreamMeasures', id: 'dep-col-down', title: 'Downstream measures', noun: 'dependent' },
  { key: 'upstreamMeasures', id: 'dep-col-up', title: 'Upstream measures', noun: 'upstream measure' },
  { key: 'upstreamColumns', id: 'dep-col-cols', title: 'Upstream columns', noun: 'column' },
  // Extends the original four-column spec: which filter panes are actively
  // filtering on this measure (report / page / visual level). Filters sitting
  // in a pane with nothing applied are excluded — they filter nothing.
  { key: 'filters', id: 'dep-col-filters', title: 'Active filters', noun: 'active filter' },
];

/**
 * Render the dependency strip markup for a measure.
 * @param {object} data - DependencyStripData (see core/graph/dependencyStrip.js)
 * @returns {string} HTML string
 */
export function renderDependencyStrip(data) {
  if (!data || !data.measure) return '';
  const { measure } = data;

  let html = '<details class="lineage-section lineage-section-collapsible dep-strip-section" open>';
  html += '<summary class="lineage-section-header"><h3>Dependencies';
  const filterCount = (data.filters || []).length;
  html += `<span class="section-summary-count">${data.visuals.length} visual${data.visuals.length !== 1 ? 's' : ''} · ${data.downstreamMeasures.length} dependent${data.downstreamMeasures.length !== 1 ? 's' : ''} · ${data.upstreamMeasures.length} upstream · ${data.upstreamColumns.length} column${data.upstreamColumns.length !== 1 ? 's' : ''} · ${filterCount} active filter${filterCount !== 1 ? 's' : ''}</span>`;
  html += '</h3></summary>';

  html += '<div class="dep-strip">';

  // Sticky measure header block.
  html += '<header class="dep-strip-header">';
  html += `<span class="dep-strip-measure">[${esc(measure.name)}]</span>`;
  if (measure.table) html += `<span class="dep-strip-meta">${esc(measure.table)}</span>`;
  if (measure.model) html += `<span class="dep-strip-meta">· ${esc(measure.model)}</span>`;
  if (measure.formatString) html += `<span class="dep-strip-meta dep-strip-format">· ${esc(measure.formatString)}</span>`;
  if (measure.expression) {
    html += `<button type="button" class="dep-copy-btn" data-dax="${esc(measure.expression)}" title="Copy this measure's DAX">Copy DAX</button>`;
  }
  html += '</header>';

  html += `<div class="dep-strip-columns" role="group" aria-label="Dependencies for ${esc(measure.name)}">`;
  for (const def of COLUMN_DEFS) {
    html += renderColumn(def, data[def.key] || [], measure.name);
  }
  html += '</div>';

  html += '</div></details>';
  return html;
}

function renderColumn(def, items, measureName) {
  const count = `${items.length} ${def.noun}${items.length !== 1 ? 's' : ''}`;
  let html = `<section class="dep-col" role="region" aria-labelledby="${def.id}">`;
  html += `<h3 class="dep-col-title" id="${def.id}">${esc(def.title)}</h3>`;

  if (items.length === 0) {
    html += '<p class="dep-col-empty">No references.</p>';
  } else {
    html += '<ul class="dep-col-list">';
    for (const item of items) {
      html += renderItem(def.key, item, measureName);
    }
    html += '</ul>';
  }

  html += `<footer class="dep-col-footer">${esc(count)}</footer>`;
  html += '</section>';
  return html;
}

function renderItem(kind, item, measureName) {
  if (kind === 'visuals') {
    let html = '<li class="dep-item">';
    html += `<div class="dep-item-name">${esc(item.visual)}</div>`;
    const trail = [item.report, item.page].filter(Boolean).map(esc).join(' &#9656; ');
    if (trail) html += `<div class="dep-item-sub">${trail}</div>`;
    const tail = [item.visualType, item.role].filter(Boolean).map(esc).join(' · ');
    if (tail) html += `<div class="dep-item-tail">${tail}</div>`;
    return html + '</li>';
  }

  if (kind === 'filters') {
    const scopeLabel = { report: 'Report filter', page: 'Page filter', visual: 'Visual filter' }[item.scope] || 'Filter';
    // No applied/idle badge: every entry in this column is actively filtering
    // by definition, so a badge saying so on all of them would be noise.
    let html = '<li class="dep-item">';
    html += `<div class="dep-item-name">${esc(scopeLabel)}</div>`;
    // A report filter applies everywhere, so naming a single page would mislead.
    const where = item.scope === 'report'
      ? [item.report].filter(Boolean)
      : [item.report, item.page, item.scope === 'visual' ? item.owner : ''].filter(Boolean);
    if (where.length) html += `<div class="dep-item-sub">${where.map(esc).join(' &#9656; ')}</div>`;
    if (item.filterName) html += `<div class="dep-item-tail">${esc(item.filterName)}</div>`;
    return html + '</li>';
  }

  if (kind === 'upstreamColumns') {
    let html = '<li class="dep-item dep-item-col">';
    html += `<span class="dep-col-ref">${esc(item.table)}[${esc(item.column)}]</span>`;
    if (item.via) html += `<span class="dep-item-via">via ${esc(item.via)}</span>`;
    return html + '</li>';
  }

  // Downstream / upstream measures — name, home table, full DAX.
  const kindSuffix = item.kind === 'calculatedColumn'
    ? ' (calc col)'
    : item.kind === 'calculationItem' ? ' (calc item)' : '';
  let html = '<li class="dep-item">';
  html += `<div class="dep-item-name">[${esc(item.name)}]${kindSuffix}</div>`;
  if (item.table) html += `<div class="dep-item-sub">${esc(item.table)}</div>`;
  if (item.expression) {
    html += `<pre class="dep-dax" aria-label="DAX expression for ${esc(item.name)}"><code>${esc(item.expression)}</code></pre>`;
    html += `<button type="button" class="dep-copy-btn dep-copy-btn-sm" data-dax="${esc(item.expression)}" title="Copy DAX for ${esc(item.name)}">Copy DAX</button>`;
  }
  return html + '</li>';
}

/**
 * Render the measure's own full DAX formula as a standalone section.
 * @param {object} data - DependencyStripData
 * @returns {string} HTML string
 */
export function renderFormulaSection(data) {
  if (!data || !data.measure) return '';
  const { measure } = data;
  if (!measure.expression) {
    return '<div class="lineage-section"><h3>Formula</h3><p class="lineage-muted">No DAX expression found for this measure.</p></div>';
  }
  const lineCount = measure.expression.split('\n').length;
  let html = '<details class="lineage-section lineage-section-collapsible" open>';
  html += '<summary class="lineage-section-header"><h3>Formula';
  html += `<span class="section-summary-count">${lineCount} line${lineCount !== 1 ? 's' : ''}</span>`;
  html += '</h3></summary>';
  html += '<div class="dep-formula-wrap">';
  html += `<pre class="dep-dax dep-dax-full" aria-label="DAX expression for ${esc(measure.name)}"><code>${esc(measure.expression)}</code></pre>`;
  html += `<button type="button" class="dep-copy-btn dep-copy-btn-sm" data-dax="${esc(measure.expression)}" title="Copy full DAX formula">Copy DAX</button>`;
  html += '</div></details>';
  return html;
}

/**
 * Wire up the Copy DAX buttons inside a rendered container.
 * @param {HTMLElement} container
 */
export function bindDependencyStrip(container) {
  if (!container) return;
  container.querySelectorAll('.dep-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dax = btn.dataset.dax || '';
      if (!dax) return;
      navigator.clipboard.writeText(dax).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('dep-copy-btn-done');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('dep-copy-btn-done');
        }, 1500);
      }).catch(() => { /* clipboard unavailable — no-op */ });
    });
  });
}
