/**
 * Dependents view — a flat, spreadsheet-style results grid with one row per
 * measure. Complements the nested Measures/Visuals browsers: instead of
 * drilling in, you see every measure's dependency counts side by side, sortable
 * and exportable.
 *
 * The grid needs the full content width, so it renders into the main panel
 * while its search/sort/export controls live in the sidebar tab.
 */

import { buildMeasureSummaryRows } from '@pbip-lineage/core';
import { esc } from './pageLayoutData.js';

let _rows = [];
let _filtered = [];
let _sortKey = 'name';
let _sortDir = 'asc';
let _query = '';
let _onMeasureSelect = null;
let _container = null;

const COLUMNS = [
  { key: 'name', label: 'Measure', type: 'text', width: '200px' },
  { key: 'table', label: 'Table', type: 'text', width: '140px' },
  { key: 'dependsOnMeasures', label: 'Depends on', type: 'num', title: 'Measures this measure directly references' },
  { key: 'dependentMeasures', label: 'Dependents', type: 'num', title: 'Measures / calculated columns that directly reference this measure' },
  { key: 'columnCount', label: 'Columns', type: 'num', title: 'Columns reached directly or transitively' },
  { key: 'visualCount', label: 'Visuals', type: 'num', title: 'Visuals this measure reaches, including indirectly' },
  { key: 'pageCount', label: 'Pages', type: 'num', title: 'Distinct pages those visuals sit on' },
  { key: 'reportCount', label: 'Reports', type: 'num', title: 'Distinct reports (workspace mode only)' },
  { key: 'filterCount', label: 'Filters', type: 'num', title: 'Filter panes actively filtering on this measure (report / page / visual). Filters sitting at their default value are not counted.' },
  { key: 'orphanCategory', label: 'Status', type: 'text', title: 'in use / filter-RLS only / no visual / orphan' },
  { key: 'expression', label: 'Formula', type: 'text', width: '340px' },
];

const STATUS_LABELS = {
  none: ['in use', 'dep-status-ok'],
  filterSecurity: ['filter/RLS', 'dep-status-filter'],
  visual: ['no visual', 'dep-status-warn'],
  true: ['orphan', 'dep-status-bad'],
};

function statusCell(category) {
  const [label, cls] = STATUS_LABELS[category] || STATUS_LABELS.none;
  return `<span class="dep-status ${cls}">${esc(label)}</span>`;
}

/**
 * @param {{ onMeasureSelect: function }} callbacks
 */
export function initDependentsView(callbacks = {}) {
  _onMeasureSelect = callbacks.onMeasureSelect;

  const search = document.getElementById('dependents-search');
  if (search) {
    let debounce = null;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        _query = search.value.toLowerCase().trim();
        applyFilter();
      }, 200);
    });
  }

  const exportBtn = document.getElementById('dependents-export');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
}

/**
 * Compute rows from the graph. Call once per project load.
 */
export function populateDependents(graph) {
  _rows = graph ? buildMeasureSummaryRows(graph) : [];
  applyFilter();
  const badge = document.getElementById('dependents-count');
  if (badge) badge.textContent = _rows.length;
}

/**
 * Render the grid into the main content container.
 */
export function renderDependentsView(container) {
  if (container) _container = container;
  if (!_container) return;
  applyFilter();
}

function applyFilter() {
  _filtered = !_query
    ? [..._rows]
    : _rows.filter(r =>
        r.name.toLowerCase().includes(_query) ||
        r.table.toLowerCase().includes(_query) ||
        r.expression.toLowerCase().includes(_query));

  const col = COLUMNS.find(c => c.key === _sortKey) || COLUMNS[0];
  _filtered.sort((a, b) => {
    let cmp;
    if (col.type === 'num') cmp = (a[_sortKey] || 0) - (b[_sortKey] || 0);
    else cmp = String(a[_sortKey] || '').localeCompare(String(b[_sortKey] || ''));
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return _sortDir === 'asc' ? cmp : -cmp;
  });

  paint();
}

function paint() {
  if (!_container) return;

  let html = '<div class="dependents-view">';
  html += '<div class="dependents-head">';
  html += `<h2 class="dependents-title">Dependents <span class="dependents-subcount">${_filtered.length} of ${_rows.length} measure${_rows.length !== 1 ? 's' : ''}</span></h2>`;
  html += '</div>';

  if (_rows.length === 0) {
    html += '<p class="lineage-muted">No measures found. Load a project with a semantic model to populate this view.</p></div>';
    _container.innerHTML = html;
    return;
  }

  html += '<div class="dependents-scroll"><table class="dependents-table">';
  html += '<thead><tr>';
  for (const col of COLUMNS) {
    const active = _sortKey === col.key;
    const arrow = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const cls = ['dep-th', col.type === 'num' ? 'dep-th-num' : '', active ? 'dep-th-active' : ''].filter(Boolean).join(' ');
    const style = col.width ? ` style="min-width:${col.width}"` : '';
    const title = col.title ? ` title="${esc(col.title)}"` : '';
    html += `<th class="${cls}"${style}${title} data-sort="${col.key}" scope="col">${esc(col.label)}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const r of _filtered) {
    html += `<tr class="dependents-row" data-id="${esc(r.id)}">`;
    html += `<td class="dep-td-name">${esc(r.name)}${r.isHidden ? ' <span class="dep-hidden-tag">hidden</span>' : ''}</td>`;
    html += `<td>${esc(r.table)}</td>`;
    html += `<td class="dep-td-num">${r.dependsOnMeasures}</td>`;
    html += `<td class="dep-td-num">${r.dependentMeasures}</td>`;
    html += `<td class="dep-td-num">${r.columnCount}</td>`;
    html += `<td class="dep-td-num${r.visualCount === 0 ? ' dep-td-zero' : ''}">${r.visualCount}</td>`;
    html += `<td class="dep-td-num">${r.pageCount}</td>`;
    html += `<td class="dep-td-num">${r.reportCount}</td>`;
    html += `<td class="dep-td-num">${r.filterCount}</td>`;
    html += `<td>${statusCell(r.orphanCategory)}</td>`;
    html += `<td class="dep-td-formula"><code>${esc(oneLine(r.expression))}</code></td>`;
    html += '</tr>';
  }
  html += '</tbody></table></div></div>';

  _container.innerHTML = html;

  _container.querySelectorAll('.dep-th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortKey = key;
        // Counts are most useful highest-first; names read better A→Z.
        _sortDir = (COLUMNS.find(c => c.key === key)?.type === 'num') ? 'desc' : 'asc';
      }
      applyFilter();
    });
  });

  _container.querySelectorAll('.dependents-row').forEach(tr => {
    tr.addEventListener('click', () => {
      if (_onMeasureSelect) _onMeasureSelect(tr.dataset.id);
    });
  });
}

function oneLine(expr) {
  if (!expr) return '';
  const flat = expr.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 159) + '…' : flat;
}

function exportCsv() {
  if (_filtered.length === 0) return;
  const header = ['Measure', 'Table', 'Display Folder', 'Format String', 'Hidden',
    'Depends On Measures', 'Dependent Measures', 'Columns', 'Visuals', 'Pages', 'Reports', 'Active Filters', 'Status', 'Formula'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of _filtered) {
    lines.push([
      r.name, r.table, r.displayFolder, r.formatString, r.isHidden ? 'Yes' : '',
      r.dependsOnMeasures, r.dependentMeasures, r.columnCount,
      r.visualCount, r.pageCount, r.reportCount,
      r.filterCount,
      (STATUS_LABELS[r.orphanCategory] || STATUS_LABELS.none)[0],
      (r.expression || '').replace(/\r?\n/g, ' '),
    ].map(csvCell).join(','));
  }
  lines.push('');
  lines.push(csvCell('Generated by PBIP Lineage Explorer (Abearstudios build)'));

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'measure-dependents.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}
