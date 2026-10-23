/**
 * Model Diagram view — a full-panel diagram of a semantic model's tables and
 * relationships, in two modes:
 *
 *   Current model      — the model as it is in the open project
 *   Changes by commit  — one commit compared with its parent: new tables and
 *                        relationships in green, deleted ones in red (struck
 *                        through / dashed), edited ones in amber with what
 *                        changed written on them
 *
 * With several semantic models, each is picked from a chip row by name.
 * Hover or click a relationship for its details; "Annotate" writes the
 * columns each relationship joins on next to its line. Tables can be dragged.
 *
 * Data and layout come from core's modelDiagram.js; commit snapshots come
 * from the Version Compare scan (snapshotScanner.js), shared with that view.
 */

import * as d3 from 'd3';
import {
  buildModelFromStructure, modelDiagramData, diffModelDiagram, summarizeDiagramDiff,
  layoutModelDiagram, cardinalityLabel, crossFilterLabel,
} from '@pbip-lineage/core';

const BOX_W = 220;
const HEADER_H = 28;
const ROW_H = 17;
const MAX_KEY_ROWS = 8;
const MAX_CHANGE_ROWS = 6;
const LABEL_FONT_W = 6.3; // approx. px per character of an 11px label
const LABEL_MAX_CHARS = 30;
const AUTO_DATE_TABLE =/^(LocalDateTable|DateTableTemplate)_[0-9a-f]{8}-/i;

let _callbacks = {};
let _container = null;
let _models = [];   // [{ key, name, structure, reports: [], model? }]
let _history = { status: 'idle', pairs: [] };
let _mode = 'current';
let _modelName = null;
let _pairIndex = 0;
let _annotate = false;
let _changesOnly = false;
let _showAutoDates = false;
let _selected = null;  // { kind: 'table'|'relationship', id }
let _pendingFocus = null;
const _layouts = new Map();    // diagram key -> layout (positions are mutated by dragging)
const _transforms = new Map(); // diagram key -> d3 zoom transform
const _pairCounts = new Map(); // pair index -> total model changes

// Rendering state of the current diagram
let _diagram = null; // { key, data, byTable, layout, svg, zoom, ... }

/** @param {{ onRequestHistory?: function() }} callbacks */
export function initModelDiagram(callbacks = {}) {
  _callbacks = callbacks;
}

/**
 * Models of the open project.
 * @param {Array<{ key: string, name: string, structure: object, reports?: string[] }>} models
 */
export function setModelDiagramModels(models) {
  _models = (models || []).filter(m => m.structure);
  _layouts.clear();
  _transforms.clear();
  _selected = null;
  if (!_models.some(m => m.name === _modelName)) _modelName = _models[0]?.name || null;
  if (isVisible()) render();
}

/** Version history (shared with Version Compare). */
export function setModelDiagramHistory(data) {
  _history = { pairs: [], ...data };
  if (_pairIndex >= (_history.pairs || []).length) _pairIndex = 0;
  _pairCounts.clear();
  for (const key of [..._layouts.keys()]) if (key.startsWith('pair|')) _layouts.delete(key);
  if (_history.status === 'ready' && _pendingFocus) applyPendingFocus();
  if (isVisible()) render();
}

export function renderModelDiagram(container) {
  _container = container;
  render();
}

/**
 * Open the "changes by commit" diagram at one commit, focused on a table or
 * relationship (used by Version Compare's "View in model diagram").
 * @param {{ pairIndex: number, modelKey?: string, table?: string, relationship?: string }} focus
 */
export function showModelDiagramChange(focus) {
  _mode = 'commit';
  _pendingFocus = focus;
  if (_history.status === 'ready') applyPendingFocus();
}

function applyPendingFocus() {
  const f = _pendingFocus;
  _pendingFocus = null;
  if (!f) return;
  _pairIndex = Math.min(Math.max(0, f.pairIndex || 0), Math.max(0, _history.pairs.length - 1));
  const pair = _history.pairs[_pairIndex];
  const m = pair && (pair.models.after.get(f.modelKey) || pair.models.before.get(f.modelKey));
  if (m) _modelName = displayName(m, f.modelKey);
  _selected = f.relationship ? { kind: 'relationship', id: f.relationship } : f.table ? { kind: 'table', id: f.table } : null;
  _changesOnly = false;
}

function isVisible() {
  return _container && !_container.classList.contains('hidden');
}

// --- Page structure ----------------------------------------------------------

function render() {
  if (!_container) return;
  if (_mode === 'commit' && _history.status === 'idle') _callbacks.onRequestHistory?.();

  let html = '<div class="ch-view md-view">';
  html += '<div class="ch-head md-head"><h2 class="ch-title">Model Diagram</h2>';
  html += '<div class="md-modes" role="tablist" aria-label="Diagram mode">' +
    `<button type="button" class="md-mode${_mode === 'current' ? ' active' : ''}" data-mode="current" role="tab" aria-selected="${_mode === 'current'}">Current model</button>` +
    `<button type="button" class="md-mode${_mode === 'commit' ? ' active' : ''}" data-mode="commit" role="tab" aria-selected="${_mode === 'commit'}">Changes by commit</button>` +
    '</div></div>';

  const resolved = _mode === 'current' ? resolveCurrent() : resolveCommit();
  if (resolved.empty) {
    _container.innerHTML = html + resolved.empty + '</div>';
    bindChrome();
    _diagram = null;
    return;
  }
  if (_mode === 'commit') html += renderNavigator();
  html += renderModelChips(resolved.chips);
  html += renderToolbar(resolved);
  if (resolved.note) html += `<div class="vc-note md-note">${resolved.note}</div>`;
  html += '<div class="md-body"><div class="md-canvas" tabindex="-1"><svg class="md-svg" role="img" aria-label="Diagram of tables and relationships"></svg>' +
    '<div class="md-tooltip hidden" role="tooltip"></div>' +
    '<div class="md-zoom"><button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" data-zoom="fit" title="Fit diagram to view">Fit</button></div>' +
    '</div><aside class="md-panel" aria-live="polite"></aside></div>';
  html += '</div>';
  _container.innerHTML = html;
  bindChrome();
  drawDiagram(resolved);
}

function renderEmpty(title, hint) {
  return `<div class="ch-empty"><p class="ch-empty-title">${esc(title)}</p><p class="ch-empty-hint">${hint}</p></div>`;
}

/** The model to draw in "Current model" mode. */
function resolveCurrent() {
  if (!_models.length) {
    return { empty: renderEmpty('No semantic model loaded', 'Open a project that includes its <code>.SemanticModel</code> folder to see its tables and relationships.') };
  }
  const entry = _models.find(m => m.name === _modelName) || _models[0];
  _modelName = entry.name;
  if (!entry.model) entry.model = buildModelFromStructure(entry.name, entry.structure);
  const { data, hiddenAutoDates } = withoutAutoDates(modelDiagramData(entry.model));
  if (!data.tables.length && !hiddenAutoDates) return { empty: renderEmpty('This model has no tables', 'No table definitions were found in its TMDL files.') };
  return {
    key: `cur|${entry.key}|${_showAutoDates}`,
    data,
    hiddenAutoDates,
    chips: _models.map(m => ({ name: m.name, label: `${m.model ? m.model.tables.size : (m.structure.tmdlFiles?.length || 0)} tables` })),
    entry,
  };
}

/** The before/after model to draw in "Changes by commit" mode. */
function resolveCommit() {
  const h = _history;
  if (h.status === 'idle' || h.status === 'unavailable') {
    return { empty: renderEmpty('No git history loaded', 'Changes by commit needs a project folder that is a git repository, opened with <strong>Open Project Folder</strong>.') };
  }
  if (h.status === 'scanning') return { empty: renderEmpty('Reading commit snapshots…', esc(h.progress || 'Reading the repository')) };
  if (h.status === 'error') return { empty: renderEmpty('Could not read git history', 'The <code>.git</code> folder could not be read.') };
  if (!h.hasRepo) return { empty: renderEmpty('This folder is not a git repository', 'Open the folder that contains the <code>.git</code> folder.') };
  if (!h.pairs.length) return { empty: renderEmpty('No commits found', 'The repository has no commits yet.') };

  const pair = h.pairs[_pairIndex];
  if (pair.error || !pair.models) return { empty: renderNavigator() + `<div class="ch-note">This commit could not be compared${pair.error ? `: ${esc(pair.error)}` : ''}.</div>` };
  const keys = [...new Set([...pair.models.before.keys(), ...pair.models.after.keys()])];
  if (!keys.length) return { empty: renderNavigator() + '<div class="ch-note">Neither this commit nor its parent contains a semantic model.</div>' };

  const entries = keys.map(key => {
    const b = pair.models.before.get(key) || null;
    const a = pair.models.after.get(key) || null;
    const { data: diff, hiddenAutoDates } = withoutAutoDates(diffModelDiagram(b, a));
    return { key, name: displayName(a || b, key), before: b, after: a, diff, hiddenAutoDates, summary: summarizeDiagramDiff(diff) };
  });
  const entry = entries.find(e => e.name === _modelName) || entries.find(e => e.summary.total) || entries[0];
  _modelName = entry.name;

  let data = entry.diff;
  if (_changesOnly) data = changedSubset(data);
  const s = entry.summary;
  let note = '';
  if (!entry.before) note = 'This semantic model is new in this commit.';
  else if (!entry.after) note = 'This semantic model was deleted in this commit.';
  else if (!s.total) note = 'No tables or relationships of this model changed in this commit.';
  return {
    key: `pair|${_pairIndex}|${entry.key}|${_changesOnly ? 'changes' : 'all'}|${_showAutoDates}`,
    data,
    hiddenAutoDates: entry.hiddenAutoDates,
    chips: entries.map(e => ({ name: e.name, label: e.summary.total ? `${e.summary.total} change${e.summary.total !== 1 ? 's' : ''}` : 'no changes', hot: e.summary.total > 0 })),
    entry,
    summary: s,
    note,
  };
}

/**
 * Power BI's auto date/time tables (one hidden LocalDateTable per date
 * column) clutter the diagram, and Power BI's own model view hides them, so
 * they are left out unless "Show auto date/time tables" is on.
 */
function withoutAutoDates(data) {
  if (_showAutoDates) return { data, hiddenAutoDates: 0 };
  const hidden = new Set(data.tables.filter(t => AUTO_DATE_TABLE.test(t.name)).map(t => t.id));
  if (!hidden.size) return { data, hiddenAutoDates: 0 };
  const relationships = data.relationships.filter(r => !hidden.has(r.fromTable) && !hidden.has(r.toTable));
  const keys = new Map();
  for (const r of relationships) {
    for (const [t, c] of [[r.fromTable, r.fromColumn], [r.toTable, r.toColumn]]) {
      if (!keys.has(t)) keys.set(t, new Set());
      keys.get(t).add(c);
    }
  }
  const tables = data.tables.filter(t => !hidden.has(t.id)).map(t => {
    const k = keys.get(t.id) || new Set();
    return { ...t, keyColumns: t.keyColumns.filter(c => k.has(c)), columns: t.columns.map(c => ({ ...c, isKey: k.has(c.name) })) };
  });
  return { data: { tables, relationships }, hiddenAutoDates: hidden.size };
}

/** Changed tables and relationships, plus the tables they connect. */
function changedSubset(diff) {
  const keep = new Set(diff.tables.filter(t => t.status !== 'unchanged').map(t => t.id));
  const rels = diff.relationships.filter(r => r.status !== 'unchanged' || keep.has(r.fromTable) || keep.has(r.toTable));
  for (const r of rels) { keep.add(r.fromTable); keep.add(r.toTable); }
  return { tables: diff.tables.filter(t => keep.has(t.id)), relationships: rels };
}

function renderNavigator() {
  const pairs = _history.pairs;
  let html = '<div class="ch-nav" role="group" aria-label="Choose a commit">';
  html += `<button type="button" class="ch-nav-btn" data-nav="older" ${_pairIndex === pairs.length - 1 ? 'disabled' : ''}>&larr; Older</button>`;
  html += '<div class="ch-timeline" role="tablist">';
  pairs.forEach((p, i) => {
    const n = pairChangeCount(i);
    const tip = `${short(p.commit.hash)} ${p.commit.message}\n${n ? `${n} table or relationship change${n !== 1 ? 's' : ''}` : 'No model diagram changes'}`;
    html += `<button type="button" class="ch-pair md-pair${i === _pairIndex ? ' active' : ''}${n ? '' : ' ch-pair-empty'}" data-pair="${i}" role="tab" aria-selected="${i === _pairIndex}" title="${esc(tip)}">` +
      `<span class="ch-pair-hash">${esc(short(p.commit.hash))}</span><span class="ch-pair-count">${n || '–'}</span></button>`;
  });
  html += '</div>';
  html += `<button type="button" class="ch-nav-btn" data-nav="newer" ${_pairIndex === 0 ? 'disabled' : ''}>Newer &rarr;</button></div>`;
  const pair = pairs[_pairIndex];
  html += `<div class="ch-nav-hint">Newest on the left. Showing <strong>${esc(short(pair.commit.hash))}</strong> “${esc(pair.commit.message || '(no message)')}” compared with its parent. Counts are table and relationship changes.</div>`;
  return html;
}

function pairChangeCount(i) {
  if (_pairCounts.has(i)) return _pairCounts.get(i);
  const p = _history.pairs[i];
  let n = 0;
  if (p?.models) {
    for (const key of new Set([...p.models.before.keys(), ...p.models.after.keys()])) {
      n += summarizeDiagramDiff(withoutAutoDates(diffModelDiagram(p.models.before.get(key) || null, p.models.after.get(key) || null)).data).total;
    }
  }
  _pairCounts.set(i, n);
  return n;
}

function renderModelChips(chips) {
  if (chips.length < 2) return '';
  let html = '<div class="md-models" role="group" aria-label="Semantic model"><span class="md-models-label">Semantic model</span>';
  for (const c of chips) {
    html += `<button type="button" class="ch-chip${c.name === _modelName ? ' active' : ''}${c.hot ? ' md-chip-hot' : ''}" data-model="${esc(c.name)}">${esc(c.name)} <span>${esc(c.label)}</span></button>`;
  }
  return html + '</div>';
}

function renderToolbar(resolved) {
  const tables = resolved.data.tables;
  let html = '<div class="md-toolbar">';
  html += `<label class="md-toggle"><input type="checkbox" id="md-annotate" ${_annotate ? 'checked' : ''}> Annotate joins <span class="vc-muted">(show the columns each relationship joins on)</span></label>`;
  if (_mode === 'commit') {
    html += `<label class="md-toggle"><input type="checkbox" id="md-changes-only" ${_changesOnly ? 'checked' : ''}> Only changes and the tables they connect</label>`;
  }
  if (resolved.hiddenAutoDates || _showAutoDates) {
    html += `<label class="md-toggle" title="Power BI creates a hidden date table for every date column when Auto date/time is on. Its own model view hides them."><input type="checkbox" id="md-auto-dates" ${_showAutoDates ? 'checked' : ''}> Show auto date/time tables${resolved.hiddenAutoDates ? ` <span class="vc-muted">(${resolved.hiddenAutoDates} hidden)</span>` : ''}</label>`;
  }
  html += `<input type="search" id="md-find" class="vc-search md-find" placeholder="Find a table…" list="md-table-list" aria-label="Find a table"><datalist id="md-table-list">${tables.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>`;
  html += '</div>';

  html += '<div class="md-legend" aria-label="Legend">';
  html += '<span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" class="md-leg-line"/></svg>Active</span>';
  html += '<span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" class="md-leg-line md-leg-dash"/></svg>Inactive</span>';
  html += '<span><svg width="16" height="10"><path d="M2 1 L14 5 L2 9 Z" class="md-leg-arrow"/></svg>Filter direction</span>';
  html += '<span><b>1</b> / <b>*</b> One / many side</span>';
  if (_mode === 'commit') {
    html += '<span class="md-leg-chip md-leg-added">New</span><span class="md-leg-chip md-leg-removed">Deleted</span><span class="md-leg-chip md-leg-changed">Edited</span><span class="vc-muted">Unchanged tables are dimmed</span>';
  }
  html += '<span class="vc-muted">Drag tables to rearrange · scroll to zoom</span>';
  html += '</div>';

  if (_mode === 'commit' && resolved.summary?.total) {
    const s = resolved.summary;
    const parts = [
      s.tablesAdded && `${s.tablesAdded} table${s.tablesAdded !== 1 ? 's' : ''} added`,
      s.tablesRemoved && `${s.tablesRemoved} table${s.tablesRemoved !== 1 ? 's' : ''} deleted`,
      s.tablesChanged && `${s.tablesChanged} table${s.tablesChanged !== 1 ? 's' : ''} edited`,
      s.relsAdded && `${s.relsAdded} relationship${s.relsAdded !== 1 ? 's' : ''} added`,
      s.relsRemoved && `${s.relsRemoved} relationship${s.relsRemoved !== 1 ? 's' : ''} deleted`,
      s.relsDeactivated && `${s.relsDeactivated} made inactive`,
      s.relsActivated && `${s.relsActivated} made active`,
      (s.relsChanged - s.relsDeactivated - s.relsActivated) > 0 && `${s.relsChanged - s.relsDeactivated - s.relsActivated} relationship${s.relsChanged - s.relsDeactivated - s.relsActivated !== 1 ? 's' : ''} edited`,
    ].filter(Boolean);
    html += `<div class="md-summary">${parts.map(esc).join(' · ')}</div>`;
  }
  return html;
}

// --- Diagram -----------------------------------------------------------------

function drawDiagram(resolved) {
  const { key, data } = resolved;
  const commit = _mode === 'commit';
  const byTable = new Map(data.tables.map(t => [t.id, t]));
  const rels = data.relationships.filter(r => byTable.has(r.fromTable) && byTable.has(r.toTable));

  // Lay out with annotated (tallest) box sizes, so toggling Annotate never moves tables.
  let layout = _layouts.get(key);
  if (!layout) {
    layout = layoutModelDiagram(
      data.tables.map(t => ({ id: t.id, w: BOX_W, h: boxHeight(t, true, commit) })),
      rels.map(r => ({ source: r.fromTable, target: r.toTable })),
      { labelRoom: 210 }, // fits a LABEL_MAX_CHARS label between side-by-side tables
    );
    _layouts.set(key, layout);
  }

  const svgEl = _container.querySelector('.md-svg');
  const svg = d3.select(svgEl);
  const defs = svg.append('defs');
  for (const [id, cls] of [['md-arrow', 'md-arrowhead'], ['md-arrow-added', 'md-arrowhead md-added'], ['md-arrow-removed', 'md-arrowhead md-removed'], ['md-arrow-changed', 'md-arrowhead md-changed']]) {
    defs.append('marker').attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 5).attr('refY', 5)
      .attr('markerWidth', 9).attr('markerHeight', 9).attr('orient', 'auto')
      .append('path').attr('d', 'M0 0 L10 5 L0 10 Z').attr('class', cls);
  }
  const viewport = svg.append('g').attr('class', 'md-viewport');
  if (layout.loose) {
    viewport.append('text').attr('class', 'md-loose-label').attr('x', layout.loose.x).attr('y', layout.loose.y - 14)
      .text('Tables with no relationships');
  }
  const edgeLayer = viewport.append('g').attr('class', 'md-edges');
  const tableLayer = viewport.append('g').attr('class', 'md-tables');
  // Labels go on top: they are placed clear of tables where there's room,
  // and a crowded one is better drawn over a table than hidden behind it.
  const labelLayer = viewport.append('g').attr('class', 'md-labels');

  _diagram = { key, data, byTable, rels, layout, svg, viewport, edgeLayer, labelLayer, tableLayer, commit, resolved };

  drawTables();
  drawEdges();
  setupZoom();
  bindDiagramEvents();

  if (_selected && !(_selected.kind === 'table' ? byTable.has(_selected.id) : rels.some(r => r.id === _selected.id))) _selected = null;
  applyHighlight();
  renderPanel();
  if (_selected && !_transforms.has(key)) centerOn(_selected);
}

function drawTables() {
  const { data, layout, tableLayer, commit } = _diagram;
  const groups = tableLayer.selectAll('g.md-table').data(data.tables, t => t.id).join('g')
    .attr('class', t => `md-table md-kind-${t.kind}${commit ? ` md-${t.status}` : ''}`)
    .attr('data-table', t => t.id)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', t => `Table ${t.name}${commit && t.status !== 'unchanged' ? ` (${statusWord(t.status)})` : ''}`)
    .attr('transform', t => { const p = layout.positions.get(t.id); return `translate(${p.x},${p.y})`; });

  groups.each(function (t) {
    const g = d3.select(this);
    const rows = boxRows(t, _annotate, commit);
    const h = HEADER_H + 8 + rows.length * ROW_H;
    g.append('rect').attr('class', 'md-box').attr('width', BOX_W).attr('height', h).attr('rx', 6);
    g.append('rect').attr('class', 'md-box-head').attr('width', BOX_W).attr('height', HEADER_H).attr('rx', 6);
    g.append('rect').attr('class', 'md-box-head md-box-head-fill').attr('y', HEADER_H - 6).attr('width', BOX_W).attr('height', 6);
    g.append('text').attr('class', 'md-box-title').attr('x', 10).attr('y', 18).text(truncate(t.name, 25)).append('title').text(t.name);
    if (commit && t.status !== 'unchanged') {
      const tag = { added: 'NEW', removed: 'DELETED', changed: 'EDITED' }[t.status];
      g.append('text').attr('class', `md-box-tag md-tag-${t.status}`).attr('x', BOX_W - 8).attr('y', 18).attr('text-anchor', 'end').text(tag);
    }
    rows.forEach((row, i) => {
      g.append('text').attr('class', `md-row ${row.cls}`).attr('x', 10).attr('y', HEADER_H + 16 + i * ROW_H).text(truncate(row.text, 31))
        .append('title').text(row.title || row.text);
    });
  });
}

function boxHeight(t, annotate, commit) {
  return HEADER_H + 8 + boxRows(t, annotate, commit).length * ROW_H;
}

/** The text rows of a table box. */
function boxRows(t, annotate, commit) {
  const rows = [];
  const kind = { calculationGroup: 'Calculation group', fieldParameter: 'Field parameter', calculated: 'Calculated table' }[t.kind];
  const mode = t.storageMode && t.storageMode !== 'Import' ? ` · ${t.storageMode}` : '';
  rows.push({ text: `${kind ? `${kind} · ` : ''}${t.columns.length} columns · ${t.measureCount} measures${mode}`, cls: 'md-row-sub' });
  if (annotate) {
    const keys = t.keyColumns.slice(0, MAX_KEY_ROWS);
    for (const k of keys) {
      const removed = t.removedColumns.includes(k);
      rows.push({ text: `◆ ${k}`, cls: removed ? 'md-row-key md-row-del' : 'md-row-key', title: `${k} — used by a relationship${removed ? ' (column deleted in this commit)' : ''}` });
    }
    if (t.keyColumns.length > MAX_KEY_ROWS) rows.push({ text: `+${t.keyColumns.length - MAX_KEY_ROWS} more key columns`, cls: 'md-row-sub' });
  }
  if (commit && t.status === 'changed') {
    const changes = t.columnChanges.slice(0, MAX_CHANGE_ROWS);
    for (const c of changes) {
      if (c.status === 'added') rows.push({ text: `+ ${c.name}${c.detail ? `  ${c.detail}` : ''}`, cls: 'md-row-add', title: `Column ${c.name} added${c.detail ? ` (${c.detail})` : ''}` });
      else if (c.status === 'removed') rows.push({ text: `− ${c.name}`, cls: 'md-row-del', title: `Column ${c.name} deleted` });
      else rows.push({ text: `~ ${c.name}: ${c.detail}`, cls: 'md-row-chg', title: `Column ${c.name}: ${c.detail}` });
    }
    if (t.columnChanges.length > MAX_CHANGE_ROWS) rows.push({ text: `+${t.columnChanges.length - MAX_CHANGE_ROWS} more column changes`, cls: 'md-row-sub' });
    const mc = t.measureChanges;
    if (mc.added.length || mc.removed.length || mc.changed.length) {
      const parts = [mc.added.length && `+${mc.added.length} new`, mc.removed.length && `−${mc.removed.length} deleted`, mc.changed.length && `~${mc.changed.length} edited`].filter(Boolean);
      rows.push({ text: `Measures: ${parts.join('  ')}`, cls: 'md-row-chg' });
    }
    for (const o of t.otherChanges) rows.push({ text: o, cls: 'md-row-chg' });
  }
  return rows;
}

/** Draw (or redraw after a drag) every relationship line, marker and label. */
function drawEdges() {
  const { rels, layout, edgeLayer, labelLayer, commit } = _diagram;
  edgeLayer.selectAll('*').remove();
  labelLayer.selectAll('*').remove();

  // Several relationships between the same two tables are fanned out as curves.
  const pairCount = new Map();
  const pairIndex = new Map();
  for (const r of rels) {
    const k = [r.fromTable, r.toTable].sort().join('\u0000');
    pairIndex.set(r.id, pairCount.get(k) || 0);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }

  const labels = [];
  for (const r of rels) {
    const k = [r.fromTable, r.toTable].sort().join('\u0000');
    const n = pairCount.get(k);
    const offset = (pairIndex.get(r.id) - (n - 1) / 2) * 46;
    const geo = edgeGeometry(r, layout.positions, offset);
    if (!geo) continue;
    const status = commit ? r.status : 'unchanged';
    const g = edgeLayer.append('g')
      .attr('class', `md-edge md-${status}${r.isActive ? '' : ' md-inactive'}${r.crossFilter === 'bothDirections' ? ' md-both' : ''}`)
      .attr('data-rel', r.id);
    g.append('path').attr('class', 'md-edge-line').attr('d', geo.d);
    g.append('path').attr('class', 'md-edge-hit').attr('d', geo.d)
      .attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', `Relationship ${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}]`);

    // Cardinality next to each table: "*" many, "1" one.
    const nearFrom = pointAt(geo, 0.1, 11);
    const nearTo = pointAt(geo, 0.9, 11);
    g.append('text').attr('class', 'md-card').attr('x', nearFrom.x).attr('y', nearFrom.y + 4).text(r.fromCardinality === 'one' ? '1' : '*');
    g.append('text').attr('class', 'md-card').attr('x', nearTo.x).attr('y', nearTo.y + 4).text(r.toCardinality === 'one' ? '1' : '*');

    // Filter direction: from the "to" (one) side towards the "from" (many) side; both ways if bidirectional.
    const marker = `url(#md-arrow${status !== 'unchanged' ? `-${status}` : ''})`;
    const arrow = (t, towardFrom) => {
      const p = pointAt(geo, t, 0);
      const tan = tangentAt(geo, t);
      const dir = towardFrom ? -1 : 1;
      g.append('path').attr('class', 'md-dir')
        .attr('d', `M${p.x - tan.x * 7 * dir},${p.y - tan.y * 7 * dir} L${p.x},${p.y}`)
        .attr('marker-end', marker);
    };
    if (r.crossFilter === 'bothDirections') { arrow(0.42, true); arrow(0.58, false); } else arrow(0.5, true);
    if (commit && status === 'removed') {
      const p = pointAt(geo, 0.5, 0);
      g.append('path').attr('class', 'md-x').attr('d', `M${p.x - 6},${p.y - 6} L${p.x + 6},${p.y + 6} M${p.x + 6},${p.y - 6} L${p.x - 6},${p.y + 6}`);
    }

    const lines = labelLines(r, commit);
    if (lines.length) {
      const w = Math.max(...lines.map(l => l.text.length)) * LABEL_FONT_W + 14;
      const h = lines.length * 14 + 6;
      labels.push({ r, status, lines, geo, side: offset >= 0 ? 1 : -1, w, h });
    }
  }

  placeLabels(labels);
  for (const l of labels) {
    const g = labelLayer.append('g').attr('class', `md-label md-${l.status}`).attr('data-rel', l.r.id)
      .attr('transform', `translate(${l.x},${l.y})`);
    g.append('rect').attr('width', l.w).attr('height', l.h).attr('rx', 4);
    l.lines.forEach((line, i) => g.append('text').attr('class', line.cls).attr('x', 7).attr('y', 14 + i * 14).text(line.text));
  }
}

/** Text written next to a relationship: its join columns and, in commit mode, what changed. */
function labelLines(r, commit) {
  const lines = [];
  const showJoin = _annotate || (commit && r.status !== 'unchanged');
  if (showJoin) {
    // Column names only: the table names are on the boxes at each end (hover
    // shows the full form). Long names wrap onto two lines.
    const join = `${r.fromColumn} → ${r.toColumn}`;
    if (join.length <= LABEL_MAX_CHARS) lines.push({ text: join, cls: 'md-label-join' });
    else {
      lines.push({ text: `${truncate(r.fromColumn, LABEL_MAX_CHARS - 2)} →`, cls: 'md-label-join' });
      lines.push({ text: truncate(r.toColumn, LABEL_MAX_CHARS), cls: 'md-label-join' });
    }
    if (_annotate) {
      lines.push({ text: `${cardinalityLabel(r)} · ${crossFilterLabel(r.crossFilter)} filter${r.isActive ? '' : ' · Inactive'}`, cls: 'md-label-sub' });
    }
  }
  if (commit && r.status === 'added') lines.push({ text: 'New relationship', cls: 'md-label-status' });
  if (commit && r.status === 'removed') lines.push({ text: 'Deleted relationship', cls: 'md-label-status' });
  if (commit && r.status === 'changed') {
    for (const c of r.changes.slice(0, 3)) lines.push({ text: truncate(`${c.label}: ${c.before} → ${c.after}`, LABEL_MAX_CHARS + 4), cls: 'md-label-status' });
  }
  return lines;
}

/**
 * Put each relationship label beside its line, at the first spot along the
 * line (middle first, then further out, either side) that covers no table
 * and no other label. If none is free, the middle is used.
 */
function placeLabels(labels) {
  const boxes = [..._diagram.layout.positions].map(([id, p]) => ({ x: p.x, y: p.y, w: p.w, h: currentHeight(id) }));
  const placed = [];
  const clear = (rect) => !boxes.some(b => overlaps(rect, b, 4)) && !placed.some(p => overlaps(rect, p, 3));
  for (const l of labels) {
    let chosen = null;
    let fallback = null;
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) {
      for (const side of [l.side, -l.side]) {
        const tan = tangentAt(l.geo, t);
        // Far enough from the line that the label's box doesn't cross it.
        const dist = (Math.abs(tan.y) * l.w + Math.abs(tan.x) * l.h) / 2 + 5;
        const c = pointAt(l.geo, t, dist * side);
        const rect = { x: c.x - l.w / 2, y: c.y - l.h / 2, w: l.w, h: l.h };
        if (!fallback) fallback = rect;
        if (clear(rect)) { chosen = rect; break; }
      }
      if (chosen) break;
    }
    Object.assign(l, chosen || fallback, { crowded: !chosen });
    placed.push(l);
  }
}

function overlaps(a, b, pad) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Curve from one table box edge to the other, bent by `offset` px. */
function edgeGeometry(r, positions, offset) {
  const a = positions.get(r.fromTable);
  const b = positions.get(r.toTable);
  if (!a || !b) return null;
  const ah = currentHeight(r.fromTable, a);
  const bh = currentHeight(r.toTable, b);
  const ca = { x: a.x + a.w / 2, y: a.y + ah / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + bh / 2 };
  if (r.fromTable === r.toTable) {
    // Self-relationship: a loop on the right of the box.
    const p0 = { x: a.x + a.w, y: a.y + ah * 0.35 };
    const p1 = { x: a.x + a.w, y: a.y + ah * 0.7 };
    const c = { x: a.x + a.w + 70, y: a.y + ah / 2 };
    return { p0, c, p1, d: `M${p0.x},${p0.y} Q${c.x},${c.y} ${p1.x},${p1.y}` };
  }
  const mx = (ca.x + cb.x) / 2;
  const my = (ca.y + cb.y) / 2;
  const len = Math.max(Math.hypot(cb.x - ca.x, cb.y - ca.y), 1);
  const nx = -(cb.y - ca.y) / len;
  const ny = (cb.x - ca.x) / len;
  const c = { x: mx + nx * offset * 2, y: my + ny * offset * 2 };
  const p0 = clipToBox({ ...a, h: ah }, ca, c);
  const p1 = clipToBox({ ...b, h: bh }, cb, c);
  return { p0, c, p1, d: `M${p0.x},${p0.y} Q${c.x},${c.y} ${p1.x},${p1.y}` };
}

/** Where a ray from the box centre towards `toward` leaves the box. */
function clipToBox(box, centre, toward) {
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (!dx && !dy) return centre;
  const tx = dx ? (box.w / 2 + 3) / Math.abs(dx) : Infinity;
  const ty = dy ? (box.h / 2 + 3) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: centre.x + dx * t, y: centre.y + dy * t };
}

function pointAt(geo, t, perp) {
  const { p0, c, p1 } = geo;
  const x = (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t ** 2 * p1.x;
  const y = (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t ** 2 * p1.y;
  if (!perp) return { x, y };
  const tan = tangentAt(geo, t);
  return { x: x - tan.y * perp, y: y + tan.x * perp };
}

function tangentAt(geo, t) {
  const { p0, c, p1 } = geo;
  const x = 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x);
  const y = 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y);
  const len = Math.max(Math.hypot(x, y), 0.001);
  return { x: x / len, y: y / len };
}

/** Drawn height of a table box (shorter than its layout slot when not annotated). */
function currentHeight(id) {
  const t = _diagram.byTable.get(id);
  return boxHeight(t, _annotate, _diagram.commit);
}

// --- Zoom, drag, hover, selection -------------------------------------------

function setupZoom() {
  const { svg, viewport, key } = _diagram;
  const zoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', (event) => {
    viewport.attr('transform', event.transform);
    _transforms.set(key, event.transform);
    hideTooltip();
  });
  svg.call(zoom).on('dblclick.zoom', null);
  _diagram.zoom = zoom;
  const saved = _transforms.get(key);
  if (saved) svg.call(zoom.transform, saved);
  else fit(false);
}

function fit(animate = true) {
  const { svg, zoom, layout } = _diagram;
  const el = svg.node();
  const w = el.clientWidth || 800;
  const h = el.clientHeight || 500;
  const pad = 40;
  const scale = Math.min((w - pad * 2) / Math.max(layout.width, 1), (h - pad * 2) / Math.max(layout.height + 20, 1), 1.1);
  const s = Math.max(scale, 0.1);
  const t = d3.zoomIdentity.translate((w - layout.width * s) / 2, Math.max(pad, (h - layout.height * s) / 2) + 10).scale(s);
  (animate ? svg.transition().duration(300) : svg).call(zoom.transform, t);
}

function centerOn(sel) {
  const { svg, zoom, layout, rels } = _diagram;
  let x;
  let y;
  if (sel.kind === 'table') {
    const p = layout.positions.get(sel.id);
    if (!p) return;
    x = p.x + p.w / 2; y = p.y + currentHeight(sel.id) / 2;
  } else {
    const r = rels.find(rel => rel.id === sel.id);
    const a = r && layout.positions.get(r.fromTable);
    const b = r && layout.positions.get(r.toTable);
    if (!a || !b) return;
    x = (a.x + b.x + BOX_W) / 2; y = (a.y + b.y) / 2 + 40;
  }
  const el = svg.node();
  const k = Math.max(d3.zoomTransform(el).k, 0.8);
  svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity.translate(el.clientWidth / 2 - x * k, el.clientHeight / 2 - y * k).scale(k));
}

function bindDiagramEvents() {
  const { svg, tableLayer, layout } = _diagram;
  const canvas = _container.querySelector('.md-canvas');

  const drag = d3.drag()
    .on('start', function () { d3.select(this).raise().classed('md-dragging', true); hideTooltip(); })
    .on('drag', function (event, t) {
      const p = layout.positions.get(t.id);
      p.x += event.dx; p.y += event.dy;
      d3.select(this).attr('transform', `translate(${p.x},${p.y})`);
      drawEdges();
      applyHighlight();
    })
    .on('end', function () { d3.select(this).classed('md-dragging', false); });
  tableLayer.selectAll('g.md-table').call(drag)
    .on('click', (event, t) => { event.stopPropagation(); select({ kind: 'table', id: t.id }); })
    .on('keydown', (event, t) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select({ kind: 'table', id: t.id }); } })
    .on('mouseenter', (event, t) => { if (!_selected) applyHighlight({ kind: 'table', id: t.id }); })
    .on('mouseleave', () => { if (!_selected) applyHighlight(); });

  // Relationship lines and labels are redrawn on drag, so delegate their events.
  const relOf = (target) => target.closest?.('[data-rel]')?.getAttribute('data-rel');
  svg.on('mousemove', (event) => {
    const id = relOf(event.target);
    if (!id) { hideTooltip(); return; }
    showTooltip(event, id, canvas);
  });
  svg.on('mouseleave', hideTooltip);
  svg.on('click', (event) => {
    const id = relOf(event.target);
    if (id) select({ kind: 'relationship', id });
    else if (!event.target.closest('g.md-table')) select(null);
  });
  svg.on('keydown', (event) => {
    const id = relOf(event.target);
    if (id && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select({ kind: 'relationship', id }); }
  });
}

function select(sel) {
  _selected = sel;
  applyHighlight();
  renderPanel();
}

/** Emphasise a table (and its relationships) or a relationship (and its two tables). */
function applyHighlight(sel = _selected) {
  if (!_diagram) return;
  const { tableLayer, edgeLayer, labelLayer, rels } = _diagram;
  let tables = null;
  let edges = null;
  if (sel?.kind === 'table') {
    tables = new Set([sel.id]);
    edges = new Set();
    for (const r of rels) if (r.fromTable === sel.id || r.toTable === sel.id) { edges.add(r.id); tables.add(r.fromTable); tables.add(r.toTable); }
  } else if (sel?.kind === 'relationship') {
    const r = rels.find(x => x.id === sel.id);
    if (r) { edges = new Set([r.id]); tables = new Set([r.fromTable, r.toTable]); }
  }
  tableLayer.selectAll('g.md-table')
    .classed('md-faded', t => !!tables && !tables.has(t.id))
    .classed('md-selected', t => sel?.kind === 'table' && sel.id === t.id);
  edgeLayer.selectAll('g.md-edge')
    .classed('md-faded', function () { return !!edges && !edges.has(this.getAttribute('data-rel')); })
    .classed('md-selected', function () { return !!edges && edges.has(this.getAttribute('data-rel')); });
  labelLayer.selectAll('g.md-label')
    .classed('md-faded', function () { return !!edges && !edges.has(this.getAttribute('data-rel')); });
}

function showTooltip(event, relId, canvas) {
  const r = _diagram.rels.find(x => x.id === relId);
  const tip = _container.querySelector('.md-tooltip');
  if (!r || !tip) return;
  tip.innerHTML = relationshipDetails(r, true);
  tip.classList.remove('hidden');
  const box = canvas.getBoundingClientRect();
  const x = Math.min(event.clientX - box.left + 14, box.width - tip.offsetWidth - 8);
  const y = Math.min(event.clientY - box.top + 14, box.height - tip.offsetHeight - 8);
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function hideTooltip() {
  _container?.querySelector('.md-tooltip')?.classList.add('hidden');
}

// --- Details panel -----------------------------------------------------------

function renderPanel() {
  const panel = _container?.querySelector('.md-panel');
  if (!panel || !_diagram) return;
  const { byTable, rels, commit, resolved } = _diagram;
  let html = '';
  if (_selected?.kind === 'table' && byTable.has(_selected.id)) {
    html = tableDetails(byTable.get(_selected.id), rels, commit);
  } else if (_selected?.kind === 'relationship' && rels.some(r => r.id === _selected.id)) {
    html = relationshipDetails(rels.find(r => r.id === _selected.id), false);
  } else {
    html = overview(resolved, commit);
  }
  panel.innerHTML = html;
  panel.querySelectorAll('[data-select-rel]').forEach(el => el.addEventListener('click', () => { select({ kind: 'relationship', id: el.dataset.selectRel }); centerOn(_selected); }));
  panel.querySelectorAll('[data-select-table]').forEach(el => el.addEventListener('click', () => { select({ kind: 'table', id: el.dataset.selectTable }); centerOn(_selected); }));
  panel.querySelector('[data-clear]')?.addEventListener('click', () => select(null));
}

function overview(resolved, commit) {
  const { data } = resolved;
  const rels = data.relationships;
  const inactive = rels.filter(r => !r.isActive).length;
  const both = rels.filter(r => r.crossFilter === 'bothDirections').length;
  let html = `<div class="md-panel-title">${esc(_modelName || 'Semantic model')}</div>`;
  html += `<div class="md-facts"><div><b>${data.tables.length}</b> tables</div><div><b>${rels.length}</b> relationships</div>` +
    `<div><b>${inactive}</b> inactive</div><div><b>${both}</b> both-direction</div></div>`;
  if (!commit && resolved.entry?.reports?.length) {
    html += `<div class="md-panel-sub">Used by report${resolved.entry.reports.length !== 1 ? 's' : ''}</div><ul class="vc-list">${resolved.entry.reports.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
  }
  if (commit) {
    const changedTables = data.tables.filter(t => t.status !== 'unchanged');
    const changedRels = rels.filter(r => r.status !== 'unchanged');
    if (changedTables.length || changedRels.length) {
      html += '<div class="md-panel-sub">What changed</div><ul class="md-changes">';
      for (const t of changedTables) {
        html += `<li><button type="button" class="ch-link" data-select-table="${esc(t.id)}"><span class="md-dot md-${t.status}"></span>Table ${esc(t.name)}</button> <span class="vc-muted">${esc(statusWord(t.status))}</span></li>`;
      }
      for (const r of changedRels) {
        const what = r.status === 'changed' ? r.changes.map(c => c.label).join(', ') : statusWord(r.status);
        html += `<li><button type="button" class="ch-link" data-select-rel="${esc(r.id)}"><span class="md-dot md-${r.status}"></span>${esc(`${r.fromTable} → ${r.toTable}`)}</button> <span class="vc-muted">${esc(what)}</span></li>`;
      }
      html += '</ul>';
    }
  }
  html += '<p class="md-hint">Click a table or relationship for details. Hover a relationship to see how it joins.</p>';
  return html;
}

function tableDetails(t, rels, commit) {
  const kind = { calculationGroup: 'Calculation group', fieldParameter: 'Field parameter', calculated: 'Calculated table', table: 'Table' }[t.kind];
  let html = `<div class="md-panel-top"><span class="md-panel-kind">${esc(kind)}</span><button type="button" class="ch-link" data-clear>Close</button></div>`;
  html += `<div class="md-panel-title">${esc(t.name)}${commit && t.status !== 'unchanged' ? ` <span class="md-status md-${t.status}">${esc(statusWord(t.status))}</span>` : ''}</div>`;
  const facts = [t.storageMode && `Storage: ${t.storageMode}`, t.source && `Source: ${t.source}`].filter(Boolean);
  if (facts.length) html += `<div class="md-panel-facts">${facts.map(esc).join('<br>')}</div>`;

  if (commit && t.status === 'changed') {
    if (t.columnChanges.length) {
      html += '<div class="md-panel-sub">Column changes</div><ul class="md-changes">';
      for (const c of t.columnChanges) {
        html += `<li class="md-chg-${c.status}"><span class="md-dot md-${c.status === 'changed' ? 'changed' : c.status}"></span>${esc(c.name)} <span class="vc-muted">${esc(c.status === 'changed' ? c.detail : `${statusWord(c.status)}${c.detail ? ` (${c.detail})` : ''}`)}</span></li>`;
      }
      html += '</ul>';
    }
    const mc = t.measureChanges;
    for (const [list, word, status] of [[mc.added, 'New measures', 'added'], [mc.removed, 'Deleted measures', 'removed'], [mc.changed, 'Edited measures', 'changed']]) {
      if (list.length) html += `<div class="md-panel-sub">${word}</div><ul class="md-changes">${list.map(m => `<li class="md-chg-${status}"><span class="md-dot md-${status}"></span>${esc(m)}</li>`).join('')}</ul>`;
    }
    for (const o of t.otherChanges) html += `<div class="md-panel-facts md-chg-changed">${esc(o)}</div>`;
    if (mc.removed.length || mc.changed.length) html += '<p class="md-hint">See the Compare tab for each measure\'s DAX and its dependency effects.</p>';
  }

  const mine = rels.filter(r => r.fromTable === t.id || r.toTable === t.id);
  html += `<div class="md-panel-sub">Relationships <span class="ch-topic-count">${mine.length}</span></div>`;
  if (!mine.length) html += '<div class="vc-muted">Not related to any other table.</div>';
  else {
    html += '<ul class="md-changes">';
    for (const r of mine) {
      const other = r.fromTable === t.id ? r.toTable : r.fromTable;
      const mineCol = r.fromTable === t.id ? r.fromColumn : r.toColumn;
      const otherCol = r.fromTable === t.id ? r.toColumn : r.fromColumn;
      html += `<li><button type="button" class="ch-link" data-select-rel="${esc(r.id)}">${commit && r.status !== 'unchanged' ? `<span class="md-dot md-${r.status}"></span>` : ''}${esc(`${mineCol} → ${other}[${otherCol}]`)}</button>` +
        ` <span class="vc-muted">${esc(cardinalityLabel(r))}${r.isActive ? '' : ' · inactive'}${r.crossFilter === 'bothDirections' ? ' · both' : ''}</span></li>`;
    }
    html += '</ul>';
  }

  html += `<div class="md-panel-sub">Columns <span class="ch-topic-count">${t.columns.length}</span></div><ul class="md-cols">`;
  for (const c of t.columns) {
    const removed = t.removedColumns.includes(c.name);
    html += `<li class="${removed ? 'md-chg-removed' : ''}">${c.isKey ? '<span class="md-key" title="Used by a relationship">◆</span>' : ''}${esc(c.name)}` +
      ` <span class="vc-muted">${esc(c.dataType || '')}${c.isCalculated ? ' · calculated' : ''}${c.isHidden ? ' · hidden' : ''}</span></li>`;
  }
  html += '</ul>';
  if (t.measures.length) {
    html += `<details class="md-measures"><summary class="md-panel-sub">Measures <span class="ch-topic-count">${t.measures.length}</span></summary><ul class="md-cols">${t.measures.map(m => `<li>${esc(m)}</li>`).join('')}</ul></details>`;
  }
  return html;
}

/** Relationship details, for the hover tooltip (compact) and the panel. */
function relationshipDetails(r, compact) {
  const commit = _diagram?.commit;
  let html = '';
  if (!compact) html += '<div class="md-panel-top"><span class="md-panel-kind">Relationship</span><button type="button" class="ch-link" data-clear>Close</button></div>';
  html += `<div class="${compact ? 'md-tip-title' : 'md-panel-title'}">${esc(`${r.fromTable}[${r.fromColumn}]`)} <span class="vc-muted">→</span> ${esc(`${r.toTable}[${r.toColumn}]`)}`;
  if (commit && r.status !== 'unchanged') html += ` <span class="md-status md-${r.status}">${esc(statusWord(r.status))}</span>`;
  html += '</div>';
  const rows = [
    ['From (', r.fromCardinality === 'one' ? 'one side' : 'many side', `)`, `${r.fromTable}[${r.fromColumn}]`],
    ['To (', r.toCardinality === 'one' ? 'one side' : 'many side', `)`, `${r.toTable}[${r.toColumn}]`],
  ];
  html += '<table class="md-facts-table"><tbody>';
  for (const [a, b, c, v] of rows) html += `<tr><th>${esc(a + b + c)}</th><td>${esc(v)}</td></tr>`;
  html += `<tr><th>Cardinality</th><td>${esc(cardinalityLabel(r))}</td></tr>`;
  html += `<tr><th>Cross-filter</th><td>${esc(crossFilterLabel(r.crossFilter))}</td></tr>`;
  html += `<tr><th>Active</th><td>${r.isActive ? 'Yes' : 'No — only used through USERELATIONSHIP()'}</td></tr>`;
  if (!compact) {
    html += `<tr><th>Security filter</th><td>${esc(crossFilterLabel(r.securityFilter))}</td></tr>`;
    html += `<tr><th>Referential integrity</th><td>${r.relyOnReferentialIntegrity ? 'Assumed' : 'Not assumed'}</td></tr>`;
  }
  html += '</tbody></table>';
  const flow = r.crossFilter === 'bothDirections'
    ? `Filters flow both ways between ${r.fromTable} and ${r.toTable}.`
    : `Filters on ${r.toTable} flow to ${r.fromTable}.`;
  html += `<div class="md-flow">${esc(flow)}</div>`;
  if (commit && r.status === 'changed' && r.changes.length) {
    html += '<table class="md-facts-table md-change-table"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>';
    for (const c of r.changes) html += `<tr><th>${esc(c.label)}</th><td class="vc-before">${esc(c.before)}</td><td class="vc-after">${esc(c.after)}</td></tr>`;
    html += '</tbody></table>';
  }
  if (commit && r.status === 'removed') html += '<div class="md-flow md-chg-removed">This relationship was deleted in this commit.</div>';
  if (commit && r.status === 'added') html += '<div class="md-flow md-chg-added">This relationship is new in this commit.</div>';
  if (compact) html += '<div class="vc-muted md-tip-hint">Click for more</div>';
  return html;
}

// --- Chrome events -----------------------------------------------------------

function bindChrome() {
  const root = _container;
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    if (_mode === b.dataset.mode) return;
    _mode = b.dataset.mode;
    _selected = null;
    render();
  }));
  root.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', () => {
    _modelName = b.dataset.model;
    _selected = null;
    render();
  }));
  root.querySelectorAll('[data-pair]').forEach(b => b.addEventListener('click', () => selectPair(Number(b.dataset.pair))));
  root.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => selectPair(_pairIndex + (b.dataset.nav === 'older' ? 1 : -1))));
  root.querySelector('#md-annotate')?.addEventListener('change', (e) => {
    _annotate = e.target.checked;
    render(); // positions and zoom are kept, so tables stay where they are
  });
  root.querySelector('#md-changes-only')?.addEventListener('change', (e) => {
    _changesOnly = e.target.checked;
    render();
  });
  root.querySelector('#md-auto-dates')?.addEventListener('change', (e) => {
    _showAutoDates = e.target.checked;
    _pairCounts.clear();
    render();
  });
  const find = root.querySelector('#md-find');
  find?.addEventListener('change', () => {
    const q = find.value.trim().toLowerCase();
    const t = _diagram?.data.tables.find(x => x.name.toLowerCase() === q) || _diagram?.data.tables.find(x => x.name.toLowerCase().includes(q));
    if (t) { select({ kind: 'table', id: t.id }); centerOn(_selected); }
  });
  root.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
    if (!_diagram) return;
    if (b.dataset.zoom === 'fit') fit();
    else _diagram.svg.transition().duration(200).call(_diagram.zoom.scaleBy, b.dataset.zoom === 'in' ? 1.3 : 1 / 1.3);
  }));
  root.querySelector('.ch-pair.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function selectPair(i) {
  if (i < 0 || i >= _history.pairs.length || i === _pairIndex) return;
  _pairIndex = i;
  _selected = null;
  render();
}

// --- Helpers -----------------------------------------------------------------

function displayName(model, key) {
  return model?.name || (key || '').split('/').pop().replace(/\.semanticmodel$/i, '') || 'Semantic model';
}
function statusWord(status) {
  return { added: 'New', removed: 'Deleted', changed: 'Edited', unchanged: 'Unchanged' }[status] || status;
}
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}
function short(hash) {
  return (hash || '').substring(0, 7);
}
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
