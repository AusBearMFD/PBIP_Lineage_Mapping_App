/**
 * Model Health Dashboard - High-level overview of the loaded Power BI model.
 * Shows summary cards, orphan list, data source summary, and relationship overview.
 */

import { computeStats, findOrphansByCategory } from '@pbip-lineage/core';

let _onMeasureNavigate = null;
let _visible = false;

/**
 * Initialize the model health dashboard.
 * @param {{ onMeasureNavigate: Function }} callbacks
 */
export function initModelHealth(callbacks = {}) {
  _onMeasureNavigate = callbacks.onMeasureNavigate;
}

/**
 * Toggle the model health dashboard visibility.
 * @param {object} graph - The full lineage graph.
 */
export function toggleModelHealth(graph) {
  _visible = !_visible;
  const btn = document.getElementById('btn-model-health');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const sourceMapContainer = document.getElementById('source-map-container');
  const measureMapContainer = document.getElementById('measure-map-container');
  const measureMapBtn = document.getElementById('btn-measure-map');

  let container = document.getElementById('model-health-container');

  if (_visible) {
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
    if (measureMapContainer) measureMapContainer.classList.add('hidden');
    if (measureMapBtn) measureMapBtn.classList.remove('active');

    if (!container) {
      container = document.createElement('div');
      container.id = 'model-health-container';
      container.className = 'model-health-container';
      const main = document.getElementById('lineage-results');
      if (main) main.appendChild(container);
    }
    container.classList.remove('hidden');
    renderDashboard(container, graph);
  } else {
    if (btn) btn.classList.remove('active');
    if (container) container.classList.add('hidden');
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else if (lineageEmpty) {
      lineageEmpty.classList.remove('hidden');
    }
  }
}

/**
 * Close the dashboard if open (used when navigating away).
 */
export function closeModelHealth() {
  if (!_visible) return;
  _visible = false;
  const btn = document.getElementById('btn-model-health');
  const container = document.getElementById('model-health-container');
  if (btn) btn.classList.remove('active');
  if (container) container.classList.add('hidden');
}

/**
 * Render the full dashboard content.
 */
function renderDashboard(container, graph) {
  const stats = computeStats(graph);
  const orphans = findOrphansByCategory(graph);

  // Collect data sources
  const dataSources = collectDataSources(graph);
  // Collect relationships
  const relationships = collectRelationships(graph);

  let html = '<div class="model-health-dashboard">';
  html += '<h2 class="model-health-title">Model Health Dashboard</h2>';

  // Summary cards
  html += '<div class="health-cards">';
  html += renderCard('Measures', stats.measures, 'measure');
  // Each orphan category gets its own card — the totals-only card hid the one
  // number people actually act on (how many are safe to delete).
  html += renderCard('True Orphans', orphans.true.length, 'orphan', orphans.true.length > 0 ? 'warning' : '');
  html += renderCard('Visual Orphans', orphans.visual.length, 'orphan', orphans.visual.length > 0 ? 'warning' : '');
  html += renderCard('Filter / RLS Orphans', orphans.filterSecurity.length, 'measure');
  html += renderCard('Field Orphans', orphans.columns.length, 'column', orphans.columns.length > 0 ? 'warning' : '');
  html += renderCard('Tables', stats.tables, 'table');
  html += renderCard('Columns', stats.columns, 'column');
  html += renderCard('Visuals', stats.visuals, 'visual');
  html += renderCard('Pages', stats.pages, 'page');
  html += renderCard('Relationships', relationships.length, 'relationship');
  html += renderCard('Data Sources', dataSources.length, 'source');
  html += '</div>';

  // Measure orphans, split by severity. Kept as three separate lists because
  // the right action differs: category 3 is safe to delete, category 1 needs
  // investigation, category 2 is usually working as intended.
  html += renderOrphanGroup(
    'True Orphans', orphans.true, '#e05d5d',
    'Referenced by nothing at all — no visual, no other measure, no filter, no RLS role. These are the safest to delete.'
  );
  html += renderOrphanGroup(
    'Visual Orphans', orphans.visual, '#ff9800',
    'Not shown on any visual or slicer, and nothing that references them reaches a visual, filter pane, or RLS role either. Wired into the model but nothing surfaces them.'
  );
  html += renderOrphanGroup(
    'Filter / Security Orphans', orphans.filterSecurity, '#4285f4',
    'Not on any visual, but actively filtering via a filter pane, or referenced by row-level security. A filter left at its default value does not count, since it filters nothing. These are doing real work — usually keep them.'
  );

  // Column/field orphans — deliberately a separate list from measure orphans.
  html += '<div class="health-section">';
  html += `<h3>Field / Column Orphans <span class="health-count">${orphans.columns.length}</span></h3>`;
  html += '<p class="health-desc">Columns nothing references — no measure, calculated column, visual, active filter, RLS role, field parameter, or relationship key. Removing these can cut model size and refresh time.</p>';
  if (orphans.columns.length === 0) {
    html += '<p class="health-none">None found.</p>';
  } else {
    html += '<div class="health-orphan-list">';
    for (const col of orphans.columns) {
      html += '<div class="health-orphan-item">';
      html += '<span class="health-dot" style="background:#9c27b0"></span>';
      html += `<span class="health-orphan-name">${esc(col.name)}</span>`;
      html += `<span class="health-orphan-table">${esc(col.table)}${col.isCalculated ? ' · calc' : ''}${col.isHidden ? ' · hidden' : ''}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Data sources summary
  if (dataSources.length > 0) {
    html += '<div class="health-section">';
    html += `<h3>Data Sources <span class="health-count">${dataSources.length}</span></h3>`;
    html += '<div class="trace-table-wrapper"><table class="trace-table">';
    html += '<thead><tr><th>Source Type</th><th>Server / Path</th><th>Database</th><th>Tables</th></tr></thead>';
    html += '<tbody>';
    for (const ds of dataSources) {
      html += '<tr>';
      html += `<td><span class="mode-badge mode-badge-${ds.type === 'directQuery' ? 'dq' : 'import'}">${esc(ds.sourceType || 'unknown')}</span></td>`;
      html += `<td>${esc(ds.server || '')}</td>`;
      html += `<td>${esc(ds.database || '')}</td>`;
      html += `<td>${ds.tableCount}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  }

  // Relationships summary
  if (relationships.length > 0) {
    html += '<div class="health-section">';
    html += `<h3>Relationships <span class="health-count">${relationships.length}</span></h3>`;
    html += '<div class="trace-table-wrapper"><table class="trace-table">';
    html += '<thead><tr><th>From</th><th>To</th><th>Cross-Filter</th></tr></thead>';
    html += '<tbody>';
    for (const rel of relationships) {
      html += '<tr>';
      html += `<td>${esc(rel.from)}</td>`;
      html += `<td>${esc(rel.to)}</td>`;
      html += `<td>${esc(rel.crossFilter || 'single')}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  }

  html += '</div>';
  container.innerHTML = html;

  // Bind orphan click handlers
  container.querySelectorAll('.health-orphan-item[data-measure-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.measureId;
      _visible = false;
      const btn = document.getElementById('btn-model-health');
      if (btn) btn.classList.remove('active');
      container.classList.add('hidden');
      if (_onMeasureNavigate) _onMeasureNavigate(id);
    });
  });
}

/**
 * Render one orphan category list.
 *
 * Always rendered, even when the count is zero — a missing section is
 * ambiguous ("none found" vs "this check didn't run"), and an explicit 0 is
 * itself a useful answer.
 */
function renderOrphanGroup(title, items, dotColor, description) {
  const list = items || [];
  let html = '<div class="health-section">';
  html += `<h3>${esc(title)} <span class="health-count">${list.length}</span></h3>`;
  html += `<p class="health-desc">${esc(description)}</p>`;

  if (list.length === 0) {
    html += '<p class="health-none">None found.</p>';
    return html + '</div>';
  }

  html += '<div class="health-orphan-list">';
  for (const m of items) {
    html += `<div class="health-orphan-item" data-measure-id="${esc(m.id)}">`;
    html += `<span class="health-dot" style="background:${dotColor}"></span>`;
    html += `<span class="health-orphan-name">${esc(m.name)}</span>`;
    const tags = [m.table];
    if (m.reachesRls) tags.push('RLS');
    if (m.reachesFilter) tags.push('filter');
    if (m.dependentCount > 0) tags.push(`${m.dependentCount} dependent${m.dependentCount !== 1 ? 's' : ''}`);
    if (m.isHidden) tags.push('hidden');
    html += `<span class="health-orphan-table">${esc(tags.filter(Boolean).join(' · '))}</span>`;
    html += '</div>';
  }
  html += '</div></div>';
  return html;
}

function renderCard(label, value, type, variant = '') {
  const colorClass = variant === 'warning' && value > 0 ? ' health-card-warning' : '';
  return `<div class="health-card${colorClass}">
    <div class="health-card-value">${value}</div>
    <div class="health-card-label">${label}</div>
  </div>`;
}

/**
 * Collect unique data sources from graph.
 */
function collectDataSources(graph) {
  const sourceMap = new Map(); // key: server+database
  for (const node of graph.nodes.values()) {
    if (node.type === 'table' && node.metadata?.dataSource) {
      const ds = node.metadata.dataSource;
      const key = `${ds.server || ''}|${ds.database || ''}|${ds.sourceType || ''}`;
      if (!sourceMap.has(key)) {
        sourceMap.set(key, {
          server: ds.server || '',
          database: ds.database || '',
          sourceType: ds.sourceType || '',
          type: ds.mode || 'import',
          tableCount: 0,
        });
      }
      sourceMap.get(key).tableCount++;
    }
  }
  return Array.from(sourceMap.values());
}

/**
 * Collect relationships from graph edges.
 */
function collectRelationships(graph) {
  const rels = [];
  for (const edge of graph.edges) {
    if (edge.type === 'table_relationship') {
      const fromNode = graph.nodes.get(edge.source);
      const toNode = graph.nodes.get(edge.target);
      rels.push({
        from: fromNode?.name || edge.source,
        to: toNode?.name || edge.target,
        crossFilter: edge.metadata?.crossFilter || 'single',
      });
    }
  }
  return rels;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
