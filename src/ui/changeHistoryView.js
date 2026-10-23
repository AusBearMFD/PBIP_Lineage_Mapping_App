/**
 * Change History view — a full-panel page listing what changed in the PBIP
 * files across the last commits of the repo, grouped by topic, with every
 * change shown side by side (older commit | newer commit).
 *
 * Data comes from gitScanner's `pairs`: one entry per consecutive commit pair,
 * newest first, including pairs that touched no PBIP files so the navigator
 * never silently skips a commit. Each pair carries the detected changes and
 * the before/after text of every changed PBIP file for the raw file view.
 */

import { groupChangesByTopic, changeAction, diffLines, collapseUnchanged } from '@pbip-lineage/core';
import { highlightDax } from './lineageView.js';

let _callbacks = {};
let _graph = null;
let _data = { status: 'idle', pairs: [], hasRepo: false }; // status: idle | scanning | ready | error
let _index = 0;            // selected pair (0 = newest)
let _tab = 'changes';      // 'changes' | 'files'
let _topic = 'all';        // topic filter key
const _openFiles = new Set();
const _fullFiles = new Set();
let _container = null;

/**
 * @param {{ onMeasureNavigate?: function(string), onVisualNavigate?: function(string) }} callbacks
 */
export function initChangeHistory(callbacks = {}) {
  _callbacks = callbacks;
}

/**
 * Update the scan data. Re-renders if the view is currently mounted.
 * @param {{ status: string, pairs?: Array, hasRepo?: boolean }} data
 */
export function setChangeHistoryData(data) {
  _data = { pairs: [], hasRepo: false, ...data };
  if (_index >= _data.pairs.length) _index = 0;
  _openFiles.clear();
  _fullFiles.clear();
  if (_container && !_container.classList.contains('hidden')) render();
}

/** Total detected changes across all pairs (for the toolbar badge). */
export function getChangeHistoryCount() {
  return (_data.pairs || []).reduce((n, p) => n + (p.changes?.length || 0), 0);
}

/**
 * Mount/refresh the view into its container.
 * @param {HTMLElement} container
 * @param {object} graph - Current lineage graph (used to make names clickable).
 */
export function renderChangeHistory(container, graph) {
  _container = container;
  _graph = graph;
  render();
}

// --- Rendering ---------------------------------------------------------------

function render() {
  if (!_container) return;
  const pairs = _data.pairs || [];

  let html = '<div class="ch-view">';
  html += '<div class="ch-head"><h2 class="ch-title">Change History</h2>';
  if (_data.status === 'ready' && pairs.length) {
    const total = getChangeHistoryCount();
    html += `<span class="ch-subtitle">Last ${pairs.length + 1} commits · ${pairs.length} comparison${pairs.length !== 1 ? 's' : ''} · ${total} PBIP change${total !== 1 ? 's' : ''}</span>`;
  }
  html += '</div>';

  const empty = renderEmptyState(pairs);
  if (empty) {
    html += empty + '</div>';
    _container.innerHTML = html;
    return;
  }

  const pair = pairs[_index];
  html += renderNavigator(pairs);
  html += renderCommitCompare(pair);
  html += renderTabs(pair);
  html += _tab === 'files' ? renderFiles(pair) : renderChanges(pair);
  html += '</div>';

  _container.innerHTML = html;
  bindEvents();
}

function renderEmptyState(pairs) {
  const msg = (title, hint) =>
    `<div class="ch-empty"><p class="ch-empty-title">${esc(title)}</p><p class="ch-empty-hint">${hint}</p></div>`;

  if (_data.status === 'idle') {
    return msg('No git history loaded', 'Change History appears when you open a PBIP project folder that is a git repository, using <strong>Open Project Folder</strong>. The sample project has no history to read. If you dragged a folder in and see this, open it with <strong>Open Project Folder</strong> instead.');
  }
  if (_data.status === 'scanning') {
    return msg('Scanning git history…', 'Reading the last commits from the local <code>.git</code> folder. This runs entirely in your browser.');
  }
  if (_data.status === 'error') {
    return msg('Could not read git history', 'The <code>.git</code> folder could not be read. Check the browser console for details.');
  }
  if (!_data.hasRepo) {
    return msg('This folder is not a git repository', 'Open the folder that contains the <code>.git</code> folder (usually the repository root) to see commit-by-commit changes.');
  }
  if (pairs.length === 0) {
    return msg('Not enough history yet', 'The repository needs at least two commits to compare.');
  }
  return '';
}

function renderNavigator(pairs) {
  const atNewest = _index === 0;
  const atOldest = _index === pairs.length - 1;
  let html = '<div class="ch-nav" role="group" aria-label="Choose a commit comparison">';
  html += `<button type="button" class="ch-nav-btn" data-nav="older" ${atOldest ? 'disabled' : ''} title="Compare the previous (older) pair of commits">&larr; Older</button>`;
  html += '<div class="ch-timeline" role="tablist">';
  pairs.forEach((p, i) => {
    const count = p.changes?.length || 0;
    const cls = ['ch-pair'];
    if (i === _index) cls.push('active');
    if (count === 0) cls.push('ch-pair-empty');
    const tip = `${short(p.fromCommit.hash)} → ${short(p.toCommit.hash)}\n${p.toCommit.message}\n${formatDate(p.toCommit.date)}` +
      (p.status === 'no-pbip-files' ? '\nNo PBIP files changed' : `\n${count} change${count !== 1 ? 's' : ''}`);
    html += `<button type="button" class="${cls.join(' ')}" role="tab" aria-selected="${i === _index}" data-pair="${i}" title="${esc(tip)}">` +
      `<span class="ch-pair-hash">${esc(short(p.toCommit.hash))}</span>` +
      `<span class="ch-pair-count">${p.status === 'no-pbip-files' ? '–' : count}</span>` +
      '</button>';
  });
  html += '</div>';
  html += `<button type="button" class="ch-nav-btn" data-nav="newer" ${atNewest ? 'disabled' : ''} title="Compare the next (newer) pair of commits">Newer &rarr;</button>`;
  html += '</div>';
  html += '<div class="ch-nav-hint">Newest on the left. Each step compares a commit with the one before it.</div>';
  return html;
}

function renderCommitCompare(pair) {
  const card = (label, c, cls) => `
    <div class="ch-commit ${cls}">
      <div class="ch-commit-label">${label}</div>
      <div class="ch-commit-msg">${esc(c.message || '(no message)')}</div>
      <div class="ch-commit-meta">
        <span class="ch-hash" title="${esc(c.hash)}">${esc(short(c.hash))}</span>
        <span>${esc(formatDateTime(c.date))}</span>
        ${c.author ? `<span>${esc(c.author)}</span>` : ''}
      </div>
    </div>`;
  return `<div class="ch-compare">${card('Before · older commit', pair.fromCommit, 'ch-before')}${card('After · newer commit', pair.toCommit, 'ch-after')}</div>`;
}

function renderTabs(pair) {
  const changeCount = pair.changes?.length || 0;
  const fileCount = pair.files?.length || 0;
  const tab = (key, label, n) =>
    `<button type="button" class="ch-tab${_tab === key ? ' active' : ''}" data-tab="${key}" role="tab" aria-selected="${_tab === key}">${label} <span class="ch-tab-count">${n}</span></button>`;
  return `<div class="ch-tabs" role="tablist">${tab('changes', 'Changes by topic', changeCount)}${tab('files', 'Changed files', fileCount)}</div>`;
}

// --- Changes tab -------------------------------------------------------------

function renderChanges(pair) {
  if (pair.status === 'no-pbip-files') {
    return '<div class="ch-note">This commit changed no PBIP files (TMDL, PBIR, or report JSON). Use <strong>Older</strong> or the timeline to pick another comparison.</div>';
  }
  if (pair.status === 'error') {
    return '<div class="ch-note">These two commits could not be compared. Check the browser console for details.</div>';
  }
  const groups = groupChangesByTopic(pair.changes);
  if (groups.length === 0) {
    return '<div class="ch-note">PBIP files changed, but nothing the change detector tracks (for example formatting, layout, or position). See <strong>Changed files</strong> for the raw differences.</div>';
  }
  if (_topic !== 'all' && !groups.some(g => g.key === _topic)) _topic = 'all';

  let html = '<div class="ch-topic-chips" role="group" aria-label="Filter by topic">';
  const total = pair.changes.length;
  html += `<button type="button" class="ch-chip${_topic === 'all' ? ' active' : ''}" data-topic="all">All <span>${total}</span></button>`;
  for (const g of groups) {
    html += `<button type="button" class="ch-chip ch-topic-${g.key}${_topic === g.key ? ' active' : ''}" data-topic="${g.key}">${esc(g.label)} <span>${g.changes.length}</span></button>`;
  }
  html += '</div>';

  for (const g of groups) {
    if (_topic !== 'all' && _topic !== g.key) continue;
    html += `<section class="ch-topic ch-topic-${g.key}"><h3 class="ch-topic-title">${esc(g.label)} <span class="ch-topic-count">${g.changes.length}</span></h3>`;
    for (const change of g.changes) html += renderChangeCard(change);
    html += '</section>';
  }
  return html;
}

function renderChangeCard(change) {
  const action = changeAction(change);
  let html = `<article class="ch-card ch-action-${action}">`;
  html += '<div class="ch-card-head">';
  html += `<span class="ch-action">${action === 'added' ? 'Added' : action === 'removed' ? 'Removed' : 'Changed'}</span>`;
  html += `<span class="ch-card-type">${esc(formatType(change.type))}</span>`;
  const target = renderTarget(change);
  if (target) html += `<span class="ch-card-target">${target}</span>`;
  html += '</div>';
  html += `<p class="ch-card-desc">${esc(change.description)}</p>`;
  html += renderSideBySide(change, action);
  html += renderImpact(change.impact);
  html += '</article>';
  return html;
}

/** Name of the changed object; measures and visuals link into the app. */
function renderTarget(change) {
  const t = change.target || {};
  if (t.measureName && t.tableName) {
    const id = `measure::${t.tableName}.${t.measureName}`;
    const label = `${esc(t.tableName)}[${esc(t.measureName)}]`;
    return _graph?.nodes?.has(id)
      ? `<button type="button" class="ch-link" data-measure-id="${esc(id)}" title="Open this measure's lineage">${label}</button>`
      : label;
  }
  if (t.visualName || t.visualId) {
    return `${esc(t.visualName || t.visualId)}${t.pageName ? ` <span class="ch-muted">on ${esc(pageLabel(t.pageName))}</span>` : ''}`;
  }
  if (t.calcGroupName) return `${esc(t.calcGroupName)}${t.calcItemName ? ` › ${esc(t.calcItemName)}` : ''}`;
  if (t.columnName) return `${esc(t.tableName || '')}[${esc(t.columnName)}]`;
  if (t.fromTable) return `${esc(t.fromTable)}[${esc(t.fromColumn || '')}] → ${esc(t.toTable)}[${esc(t.toColumn || '')}]`;
  if (t.partitionName) return `${esc(t.tableName || '')} › ${esc(t.partitionName)}`;
  if (t.expressionName) return esc(t.expressionName);
  if (t.bookmarkName) return esc(t.bookmarkName);
  if (t.filterName) return `${esc(t.filterName)}${t.pageName ? ` <span class="ch-muted">on ${esc(pageLabel(t.pageName))}</span>` : ''}`;
  if (t.pageName) return esc(pageLabel(t.pageName));
  return '';
}

/**
 * Visual- and filter-level changes record the page's folder id ("page1"),
 * not its display name. Resolve it through the graph's page nodes when we can.
 */
function pageLabel(nameOrId) {
  if (!_graph?.nodes || !nameOrId) return nameOrId;
  for (const node of _graph.nodes.values()) {
    if (node.type === 'page' && node.metadata?.pageId === nameOrId) return node.name || nameOrId;
  }
  return nameOrId;
}

/** Before | After columns for one change. */
function renderSideBySide(change, action) {
  const d = change.details || {};
  let before;
  let after;

  if (Array.isArray(d.added) || Array.isArray(d.removed)) {
    // Visual field bindings: removed fields were only in the old version, added only in the new.
    before = fieldList(d.removed, 'removed', 'No fields removed');
    after = fieldList(d.added, 'added', 'No fields added');
  } else {
    const keys = new Set([...Object.keys(d.before || {}), ...Object.keys(d.after || {})]);
    const differs = (k) => JSON.stringify(d.before?.[k]) !== JSON.stringify(d.after?.[k]);
    before = d.before ? renderValueBlock(d.before, keys, differs) : notPresent(action === 'added' ? 'Did not exist' : 'No details recorded');
    after = d.after ? renderValueBlock(d.after, keys, differs) : notPresent(action === 'removed' ? 'Deleted' : 'No details recorded');
  }

  return `<div class="ch-sbs">
    <div class="ch-side ch-side-before"><div class="ch-side-label">Before</div>${before}</div>
    <div class="ch-side ch-side-after"><div class="ch-side-label">After</div>${after}</div>
  </div>`;
}

function renderValueBlock(obj, allKeys, differs) {
  const keys = [...allKeys].filter(k => k in obj);
  if (keys.length === 0) return notPresent('No details recorded');
  let html = '';
  for (const k of keys) {
    const v = obj[k];
    const changed = differs(k) ? ' ch-changed' : '';
    if (k === 'expression' && typeof v === 'string') {
      html += `<div class="ch-code ch-dax${changed}">${highlightDax(v)}</div>`;
    } else if ((k === 'sourceExpression' || k === 'content') && typeof v === 'string') {
      html += `<pre class="ch-code${changed}">${esc(v)}</pre>`;
    } else {
      html += `<div class="ch-kv${changed}"><span class="ch-k">${esc(humanize(k))}</span><span class="ch-v">${formatValue(v)}</span></div>`;
    }
  }
  return html;
}

function fieldList(fields, kind, emptyText) {
  if (!fields || fields.length === 0) return notPresent(emptyText);
  return `<ul class="ch-fields ch-fields-${kind}">${fields.map(f =>
    `<li>${esc(f.table || '')}[${esc(f.field || f.column || f.measure || '')}]${f.type ? ` <span class="ch-muted">${esc(f.type)}</span>` : ''}</li>`
  ).join('')}</ul>`;
}

function renderImpact(impact) {
  if (!impact || impact.length === 0) return '';
  const seen = new Set();
  const byPage = new Map();
  for (const imp of impact) {
    const key = imp.visualId || imp.visualName;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const page = imp.pageName || '(unknown page)';
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(imp);
  }
  let html = `<div class="ch-impact"><span class="ch-impact-label">Affects ${seen.size} visual${seen.size !== 1 ? 's' : ''}:</span>`;
  for (const [page, items] of byPage) {
    html += ` <span class="ch-impact-page">${esc(page)}</span> `;
    html += items.map(imp => {
      const name = esc(imp.visualName || imp.visualId);
      return imp.visualId && _graph?.nodes?.has(imp.visualId)
        ? `<button type="button" class="ch-link ch-impact-item" data-visual-id="${esc(imp.visualId)}" title="${esc(imp.reason || 'Open this visual')}">${name}</button>`
        : `<span class="ch-impact-item" title="${esc(imp.reason || '')}">${name}</span>`;
    }).join(' ');
  }
  return html + '</div>';
}

// --- Files tab ---------------------------------------------------------------

function renderFiles(pair) {
  const files = pair.files || [];
  if (files.length === 0) {
    return `<div class="ch-note">${pair.status === 'no-pbip-files' ? 'This commit changed no PBIP files.' : 'No PBIP files to show.'}</div>`;
  }
  let html = '<div class="ch-files">';
  for (const f of files) {
    const open = _openFiles.has(f.path);
    const { added, removed } = diffStats(f);
    html += `<div class="ch-file${open ? ' open' : ''}">`;
    html += `<button type="button" class="ch-file-head" data-file="${esc(f.path)}" aria-expanded="${open}">` +
      `<span class="ch-file-caret">${open ? '▾' : '▸'}</span>` +
      `<span class="ch-file-status ch-file-${f.status}">${f.status}</span>` +
      `<span class="ch-file-path">${esc(f.path)}</span>` +
      `<span class="ch-file-stats"><span class="ch-plus">+${added}</span> <span class="ch-minus">−${removed}</span></span>` +
      '</button>';
    if (open) html += renderFileDiff(f);
    html += '</div>';
  }
  return html + '</div>';
}

const _diffCache = new WeakMap();
function fileDiff(f) {
  if (!_diffCache.has(f)) _diffCache.set(f, diffLines(f.before, f.after));
  return _diffCache.get(f);
}
function diffStats(f) {
  const { added, removed } = fileDiff(f);
  return { added, removed };
}

function renderFileDiff(f) {
  const diff = fileDiff(f);
  const full = _fullFiles.has(f.path);
  const rows = full ? diff.rows : collapseUnchanged(diff.rows, 3);
  let html = '<div class="ch-diff-wrap">';
  if (diff.truncated) {
    html += '<div class="ch-note ch-note-small">This file changed too much to line up line by line, so the changed section is shown as one block.</div>';
  }
  // Explicit column widths: with table-layout:fixed the header's colspans would
  // otherwise split the width evenly and make the line-number columns huge.
  html += '<table class="ch-diff"><colgroup><col class="ch-col-ln"><col><col class="ch-col-ln"><col></colgroup>' +
    '<thead><tr><th colspan="2">Before</th><th colspan="2">After</th></tr></thead><tbody>';
  for (const r of rows) {
    if (r.type === 'skip') {
      html += `<tr class="ch-diff-skip"><td colspan="4"><button type="button" class="ch-link" data-full-file="${esc(f.path)}">Show ${r.count} unchanged line${r.count !== 1 ? 's' : ''}</button></td></tr>`;
      continue;
    }
    const lCls = r.type === 'removed' || r.type === 'changed' ? 'ch-del' : r.left == null ? 'ch-blank' : '';
    const rCls = r.type === 'added' || r.type === 'changed' ? 'ch-add' : r.right == null ? 'ch-blank' : '';
    html += `<tr class="ch-diff-${r.type}">` +
      `<td class="ch-ln">${r.leftNo ?? ''}</td><td class="ch-code-cell ${lCls}">${r.left == null ? '' : esc(r.left)}</td>` +
      `<td class="ch-ln">${r.rightNo ?? ''}</td><td class="ch-code-cell ${rCls}">${r.right == null ? '' : esc(r.right)}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  if (full && diff.rows.some(r => r.type === 'same')) {
    html += `<button type="button" class="ch-link ch-collapse" data-collapse-file="${esc(f.path)}">Hide unchanged lines</button>`;
  }
  return html + '</div>';
}

// --- Events ------------------------------------------------------------------

function bindEvents() {
  const root = _container;
  root.querySelectorAll('[data-pair]').forEach(btn => btn.addEventListener('click', () => selectPair(Number(btn.dataset.pair))));
  root.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => {
    selectPair(btn.dataset.nav === 'older' ? _index + 1 : _index - 1);
  }));
  root.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { _tab = btn.dataset.tab; render(); }));
  root.querySelectorAll('[data-topic]').forEach(btn => btn.addEventListener('click', () => { _topic = btn.dataset.topic; render(); }));
  root.querySelectorAll('[data-file]').forEach(btn => btn.addEventListener('click', () => {
    const p = btn.dataset.file;
    if (_openFiles.has(p)) _openFiles.delete(p); else _openFiles.add(p);
    render();
  }));
  root.querySelectorAll('[data-full-file]').forEach(btn => btn.addEventListener('click', () => { _fullFiles.add(btn.dataset.fullFile); render(); }));
  root.querySelectorAll('[data-collapse-file]').forEach(btn => btn.addEventListener('click', () => { _fullFiles.delete(btn.dataset.collapseFile); render(); }));
  root.querySelectorAll('[data-measure-id]').forEach(btn => btn.addEventListener('click', () => _callbacks.onMeasureNavigate?.(btn.dataset.measureId)));
  root.querySelectorAll('[data-visual-id]').forEach(btn => btn.addEventListener('click', () => _callbacks.onVisualNavigate?.(btn.dataset.visualId)));

  // Keep the selected commit chip in view.
  root.querySelector('.ch-pair.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function selectPair(i) {
  const n = (_data.pairs || []).length;
  if (i < 0 || i >= n || i === _index) return;
  _index = i;
  _openFiles.clear();
  _fullFiles.clear();
  render();
}

// --- Helpers -----------------------------------------------------------------

function notPresent(text) {
  return `<div class="ch-absent">${esc(text)}</div>`;
}

function formatValue(v) {
  if (v === null || v === undefined || v === '') return '<span class="ch-muted">(none)</span>';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    if (v.length === 0) return '<span class="ch-muted">(none)</span>';
    if (v.every(x => typeof x !== 'object')) return esc(v.join(', '));
    return `<code class="ch-json">${esc(JSON.stringify(v))}</code>`;
  }
  if (typeof v === 'object') return `<code class="ch-json">${esc(JSON.stringify(v))}</code>`;
  return esc(String(v));
}

function humanize(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function formatType(type) {
  return (type || 'change').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function short(hash) {
  return (hash || '').substring(0, 7);
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso || ''; }
}

function formatDateTime(iso) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return iso || ''; }
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
