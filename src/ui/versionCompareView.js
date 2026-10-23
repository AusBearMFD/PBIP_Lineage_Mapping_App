/**
 * Version Compare view — a full-panel page that reviews every commit of the
 * repo against its parent using complete PBIP snapshots, in two sections:
 *
 *   Modified / Commit Edits — existing objects that were edited or deleted
 *   Additions               — new objects
 *
 * Records come from core's compareSnapshots() (via snapshotScanner.js).
 * RLS-related changes are highlighted, and deletions that are still referenced
 * elsewhere are flagged. Measures, columns and tables list their "dependency
 * effects": what still uses them and whether the change breaks it or only
 * changes its values.
 */

import { groupCompareRecords, COMPARE_GROUPS } from '@pbip-lineage/core';
import { highlightDax } from './lineageView.js';

const GROUP_LABELS = Object.fromEntries(COMPARE_GROUPS.map(g => [g.key, g.label]));
const SINGULAR = {
  role: 'RLS role', relationship: 'Relationship', measure: 'Measure', calcItem: 'Calculation item', column: 'Column',
  table: 'Table', dataSource: 'Data source', parameter: 'Parameter', expression: 'Expression',
  semanticModel: 'Semantic model', report: 'Report', page: 'Page', visual: 'Visual', filter: 'Filter', bookmark: 'Bookmark',
};
const PAGE_SIZE = 40;
const IMPACT_ITEMS_SHOWN = 8;

let _callbacks = {};
let _container = null;
let _data = { status: 'idle', pairs: [], hasRepo: false, progress: '' };
let _index = 0;
let _group = 'all';
let _query = '';
const _expanded = new Set(); // "section|group" groups showing all records
const _openEffects = new Set(); // bookmark record ids whose effect panel is open

/** @param {{ onRequestScan?: function(), onShowInDiagram?: function({ pairIndex, modelKey, table?, relationship? }) }} callbacks */
export function initVersionCompare(callbacks = {}) {
  _callbacks = callbacks;
}

/** @param {{ status: string, pairs?: Array, hasRepo?: boolean, progress?: string }} data */
export function setVersionCompareData(data) {
  _data = { pairs: [], hasRepo: false, progress: '', ...data };
  if (_index >= _data.pairs.length) _index = 0;
  _expanded.clear();
  if (_container && !_container.classList.contains('hidden')) render();
}

export function getVersionCompareStatus() {
  return _data.status;
}

export function renderVersionCompare(container) {
  _container = container;
  if (_data.status === 'idle') _callbacks.onRequestScan?.();
  render();
}

// --- Rendering ---------------------------------------------------------------

function render() {
  if (!_container) return;
  const pairs = _data.pairs || [];
  let html = '<div class="ch-view vc-view">';
  html += '<div class="ch-head"><h2 class="ch-title">Version Compare</h2>';
  if (_data.status === 'ready' && pairs.length) {
    html += `<span class="ch-subtitle">Last ${pairs.length} commit${pairs.length !== 1 ? 's' : ''}, each compared with its parent using complete snapshots</span>`;
  }
  html += '</div>';

  const empty = renderEmpty(pairs);
  if (empty) {
    _container.innerHTML = html + empty + '</div>';
    return;
  }

  const pair = pairs[_index];
  html += renderNavigator(pairs);
  html += renderCommitCards(pair);
  if (pair.error) {
    html += `<div class="ch-note">This commit could not be compared: ${esc(pair.error)}</div></div>`;
    _container.innerHTML = html;
    bind();
    return;
  }
  html += renderSummary(pair);
  html += renderControls(pair);
  const visible = filterRecords(pair.records);
  html += renderSection('modified', 'Modified / Commit Edits', 'Existing objects that were edited or deleted in this commit.', visible);
  html += renderSection('additions', 'Additions', 'Objects that are new in this commit. Children of a new item are listed inside it.', visible);
  html += '</div>';
  _container.innerHTML = html;
  bind();
}

function renderEmpty(pairs) {
  const msg = (title, hint) => `<div class="ch-empty"><p class="ch-empty-title">${esc(title)}</p><p class="ch-empty-hint">${hint}</p></div>`;
  if (_data.status === 'idle' || _data.status === 'unavailable') {
    return msg('No git history loaded', 'Version Compare needs a project folder that is a git repository, opened with <strong>Open Project Folder</strong>. The sample project has no history.');
  }
  if (_data.status === 'scanning') {
    return msg('Reading commit snapshots…', `${esc(_data.progress || 'Reading the repository')}<br>Every PBIP file is read once per version, entirely in your browser.`);
  }
  if (_data.status === 'error') return msg('Could not read git history', 'The <code>.git</code> folder could not be read. Check the browser console for details.');
  if (!_data.hasRepo) return msg('This folder is not a git repository', 'Open the folder that contains the <code>.git</code> folder to compare versions.');
  if (!pairs.length) return msg('No commits found', 'The repository has no commits yet.');
  return '';
}

function renderNavigator(pairs) {
  let html = '<div class="ch-nav" role="group" aria-label="Choose a commit">';
  html += `<button type="button" class="ch-nav-btn" data-nav="older" ${_index === pairs.length - 1 ? 'disabled' : ''}>&larr; Older</button>`;
  html += '<div class="ch-timeline" role="tablist">';
  pairs.forEach((p, i) => {
    const s = p.summary || {};
    const empty = !p.records.length;
    const tip = `${short(p.commit.hash)} ${p.commit.message}\n${formatDate(p.commit.date)}\n` +
      (empty ? 'No PBIP changes' : `${s.modified || 0} modified or removed · ${s.added || 0} added${s.security ? ` · ${s.security} security` : ''}`);
    html += `<button type="button" class="ch-pair vc-pair${i === _index ? ' active' : ''}${empty ? ' ch-pair-empty' : ''}" data-pair="${i}" role="tab" aria-selected="${i === _index}" title="${esc(tip)}">` +
      `<span class="ch-pair-hash">${esc(short(p.commit.hash))}${s.security ? '<span class="vc-sec-dot" aria-label="security change"></span>' : ''}</span>` +
      `<span class="vc-pair-counts">${empty ? '–' : `<span class="vc-c-mod">${s.modified || 0}</span> <span class="vc-c-add">+${s.added || 0}</span>`}</span>` +
      '</button>';
  });
  html += '</div>';
  html += `<button type="button" class="ch-nav-btn" data-nav="newer" ${_index === 0 ? 'disabled' : ''}>Newer &rarr;</button>`;
  html += '</div><div class="ch-nav-hint">Newest on the left. Counts show modified or removed / added.</div>';
  return html;
}

function renderCommitCards(pair) {
  const card = (label, c, cls) => c ? `
    <div class="ch-commit ${cls}">
      <div class="ch-commit-label">${label}</div>
      <div class="ch-commit-msg">${esc(c.message || '(no message)')}</div>
      <div class="ch-commit-meta"><span class="ch-hash" title="${esc(c.hash)}">${esc(short(c.hash))}</span><span>${esc(formatDateTime(c.date))}</span>${c.author ? `<span>${esc(c.author)}</span>` : ''}</div>
    </div>` : `
    <div class="ch-commit ${cls}"><div class="ch-commit-label">${label}</div><div class="ch-commit-msg">Nothing (first commit)</div></div>`;
  let html = `<div class="ch-compare">${card('Before · parent commit', pair.parent, 'ch-before')}${card('After · this commit', pair.commit, 'ch-after')}</div>`;
  if (pair.isMerge) html += '<div class="vc-note">This is a merge commit, so it is compared with its first parent. The changes include everything brought in by the merge.</div>';
  if (pair.isRoot) html += '<div class="vc-note">This is the first commit, so everything in it is listed as an addition.</div>';
  return html;
}

function renderSummary(pair) {
  const s = pair.summary || {};
  const tile = (cls, n, label, sub) => `<div class="vc-tile ${cls}"><div class="vc-tile-n">${n}</div><div class="vc-tile-label">${label}</div>${sub ? `<div class="vc-tile-sub">${sub}</div>` : ''}</div>`;
  const modSub = [s.changed && `${s.changed} edited`, s.renamed && `${s.renamed} renamed`, s.removed && `${s.removed} deleted`].filter(Boolean).join(' · ');
  let html = '<div class="vc-tiles">';
  html += tile('vc-tile-mod', s.modified || 0, 'Modified / Commit Edits', modSub);
  html += tile('vc-tile-add', s.added || 0, 'Additions', '');
  html += tile(`vc-tile-sec${s.security ? ' vc-hot' : ''}`, s.security || 0, 'Security (RLS) related', s.security ? 'Review before merging' : '');
  html += tile(`vc-tile-broken${s.broken ? ' vc-hot' : ''}`, s.broken || 0, 'Breaking changes', s.broken ? 'Deleted or renamed but still used' : '');
  return html + '</div>';
}

function renderControls(pair) {
  const groups = groupCompareRecords(pair.records);
  if (!groups.length) return '';
  if (_group !== 'all' && !groups.some(g => g.key === _group)) _group = 'all';
  let html = '<div class="vc-controls">';
  html += `<input type="search" id="vc-search" class="vc-search" placeholder="Search names, pages, values…" value="${esc(_query)}" aria-label="Search changes">`;
  html += '<div class="ch-topic-chips" role="group" aria-label="Filter by type">';
  html += `<button type="button" class="ch-chip${_group === 'all' ? ' active' : ''}" data-group="all">All <span>${pair.records.length}</span></button>`;
  for (const g of groups) {
    html += `<button type="button" class="ch-chip${_group === g.key ? ' active' : ''}" data-group="${g.key}">${esc(g.label)} <span>${g.records.length}</span></button>`;
  }
  return html + '</div></div>';
}

function filterRecords(records) {
  const q = _query.trim().toLowerCase();
  return records.filter(r => {
    if (_group !== 'all' && r.group !== _group) return false;
    if (!q) return true;
    return searchText(r).includes(q);
  });
}

function searchText(r) {
  const parts = [r.name, r.change, SINGULAR[r.group], r.objectId, r.subtype, ...Object.values(r.location || {})];
  for (const p of r.props) parts.push(p.label, flat(p.before), flat(p.after));
  for (const c of r.context) parts.push(c.label, flat(c.value));
  for (const g of r.impact?.groups || []) for (const i of g.items) parts.push(i.label);
  return parts.join(' ').toLowerCase();
}

function renderSection(section, title, hint, records) {
  const groups = groupCompareRecords(records, section);
  const total = groups.reduce((n, g) => n + g.records.length, 0);
  let html = `<section class="vc-section vc-section-${section}"><h3 class="vc-section-title">${esc(title)} <span class="vc-section-count">${total}</span></h3>`;
  html += `<p class="vc-section-hint">${esc(hint)}</p>`;
  if (!total) {
    html += `<div class="ch-note">${_query || _group !== 'all' ? 'Nothing matches the current search or filter.' : section === 'modified' ? 'Nothing that already existed was edited or deleted.' : 'Nothing new was added.'}</div>`;
    return html + '</section>';
  }
  for (const g of groups) {
    const key = `${section}|${g.key}`;
    const showAll = _expanded.has(key);
    // Security changes first within a group, then still-referenced deletions,
    // sorted before paging so flagged records are never hidden behind "Show more".
    const sorted = [...g.records].sort((a, b) => (b.flags.security - a.flags.security) || (b.flags.broken - a.flags.broken));
    const shown = showAll ? sorted : sorted.slice(0, PAGE_SIZE);
    html += `<details class="vc-group" open><summary class="vc-group-title">${esc(g.label)} <span class="ch-topic-count">${g.records.length}</span></summary>`;
    for (const r of shown) html += renderRecord(r);
    if (!showAll && g.records.length > PAGE_SIZE) {
      html += `<button type="button" class="ch-link vc-more" data-expand="${esc(key)}">Show ${g.records.length - PAGE_SIZE} more</button>`;
    }
    html += '</details>';
  }
  return html + '</section>';
}

function renderRecord(r) {
  const changeLabel = { changed: 'Edited', removed: 'Deleted', renamed: 'Renamed', added: 'New' }[r.change] || r.change;
  const cls = ['vc-card', `vc-${r.change}`];
  if (r.flags.security) cls.push('vc-security');
  if (r.flags.broken) cls.push('vc-broken');
  const hasEffect = r.group === 'bookmark' && r.effect;
  const effectOpen = hasEffect && _openEffects.has(r.id);
  let html = `<article class="${cls.join(' ')}">`;
  html += `<div class="vc-card-head${hasEffect ? ' vc-clickable' : ''}"${hasEffect ? ` data-effect="${esc(r.id)}" role="button" tabindex="0" aria-expanded="${effectOpen}"` : ''}>`;
  html += `<span class="vc-badge vc-badge-${r.change}">${esc(changeLabel)}</span>`;
  html += `<span class="vc-type">${esc(SINGULAR[r.group] || r.group)}${r.subtype ? ` · ${esc(r.subtype)}` : ''}</span>`;
  html += `<span class="vc-name">${esc(r.name)}</span>`;
  if (r.objectId) html += `<code class="vc-id" title="Object ID: ${esc(r.objectId)} (the folder name in the PBIP files)">${esc(r.objectId.slice(0, 7))}</code>`;
  const loc = locationText(r.location);
  if (loc) html += `<span class="vc-loc">${esc(loc)}</span>`;
  if (r.flags.security) html += '<span class="vc-flag vc-flag-sec" title="Changes row-level security or something an RLS rule uses">Security</span>';
  if (r.flags.broken) html += '<span class="vc-flag vc-flag-broken" title="Deleted or renamed, but the new version still references it">Still referenced</span>';
  if (r.flags.copy) html += '<span class="vc-flag vc-flag-copy" title="Power BI gives a pasted visual a new ID, so this is inferred from matching type, fields and title">Possible copy</span>';
  if (hasEffect) html += `<span class="vc-effect-toggle">${effectOpen ? 'Hide' : 'Show'} what this bookmark changes ${effectOpen ? '▾' : '▸'}</span>`;
  if (r.diagram && _callbacks.onShowInDiagram && (r.group !== 'column' || r.change !== 'added')) {
    html += `<button type="button" class="ch-link vc-diagram-link" data-diagram="${esc(r.id)}" title="Open the Model Diagram at this commit, focused on this change">View in model diagram</button>`;
  }
  html += '</div>';
  html += renderProps(r);
  if (effectOpen) html += renderBookmarkEffect(r.effect);
  if (r.impact) html += renderImpact(r.impact);
  if (r.context.length) {
    html += '<div class="vc-context">';
    for (const c of r.context) {
      html += `<div class="vc-ctx-row"><span class="vc-ctx-label">${esc(c.label)}</span><span class="vc-ctx-value">${Array.isArray(c.value) ? c.value.map(esc).join('<br>') : esc(c.value)}</span></div>`;
    }
    html += '</div>';
  }
  return html + '</article>';
}

function renderProps(r) {
  if (!r.props.length) return '';
  const twoSided = r.change === 'changed' || r.change === 'renamed';
  let html = `<div class="vc-props${twoSided ? ' vc-two' : ''}">`;
  if (twoSided) html += '<div class="vc-ph"></div><div class="vc-ph">Before</div><div class="vc-ph">After</div>';
  for (const p of r.props) {
    html += `<div class="vc-plabel">${esc(p.label)}</div>`;
    if (twoSided) {
      html += `<div class="vc-pval vc-before">${renderValue(p, 'before')}</div><div class="vc-pval vc-after">${renderValue(p, 'after')}</div>`;
    } else {
      html += `<div class="vc-pval ${r.change === 'removed' ? 'vc-before' : 'vc-after'}">${renderValue(p, r.change === 'removed' ? 'before' : 'after')}</div>`;
    }
  }
  return html + '</div>';
}

function renderValue(p, sideKey) {
  const v = p[sideKey];
  if (p.kind === 'list') {
    const items = Array.isArray(v) ? v : (v ? [v] : []);
    if (!items.length) return '<span class="vc-none">(none)</span>';
    const other = new Set(Array.isArray(p[sideKey === 'before' ? 'after' : 'before']) ? p[sideKey === 'before' ? 'after' : 'before'] : []);
    const twoSided = Array.isArray(p.before) && Array.isArray(p.after) && p.before.length && p.after.length;
    return `<ul class="vc-list">${items.map(item => {
      const diff = twoSided && !other.has(item) ? (sideKey === 'before' ? ' vc-item-out' : ' vc-item-in') : '';
      return `<li class="${diff.trim()}">${esc(item)}</li>`;
    }).join('')}</ul>`;
  }
  if (v === '' || v === null || v === undefined) return '<span class="vc-none">(none)</span>';
  if (p.kind === 'dax') return `<div class="ch-code ch-dax">${highlightDax(String(v))}</div>`;
  if (p.kind === 'm') return `<pre class="ch-code">${esc(v)}</pre>`;
  return `<span class="vc-text">${esc(v)}</span>`;
}

/**
 * "Dependency effects": everything that still uses the changed object, and
 * whether the change breaks it (deleted/renamed) or only changes its values.
 */
function renderImpact(impact) {
  const cls = `vc-impact vc-impact-${impact.severity}`;
  let html = `<div class="${cls}"><div class="vc-impact-head"><span class="vc-impact-title">Dependency effects</span>` +
    `<span class="vc-impact-headline">${esc(impact.headline)}</span></div>`;
  if (impact.note) html += `<div class="vc-impact-note">${esc(impact.note)}</div>`;
  for (const g of impact.groups) {
    html += `<div class="vc-impact-group"><div class="vc-impact-glabel">${esc(g.label)} <span class="ch-topic-count">${g.items.length}</span></div><ul class="vc-impact-list">`;
    const item = (i) => `<li><span class="vc-impact-item">${esc(i.label)}</span>` +
      `${i.via ? ` <span class="vc-muted">through ${esc(i.via)}</span>` : ''}` +
      ` <span class="vc-impact-effect">${esc(i.effect)}</span></li>`;
    html += g.items.slice(0, IMPACT_ITEMS_SHOWN).map(item).join('');
    html += '</ul>';
    if (g.items.length > IMPACT_ITEMS_SHOWN) {
      html += `<details class="vc-impact-more"><summary>Show ${g.items.length - IMPACT_ITEMS_SHOWN} more</summary><ul class="vc-impact-list">${g.items.slice(IMPACT_ITEMS_SHOWN).map(item).join('')}</ul></details>`;
    }
    html += '</div>';
  }
  return html + '</div>';
}

/**
 * What clicking the bookmark changes compared with its page's default state.
 * Parts the bookmark doesn't capture are shown, but marked as not applied.
 */
function renderBookmarkEffect(e) {
  const yes = (on, label) => `<span class="vc-cap ${on ? 'vc-cap-on' : 'vc-cap-off'}">${on ? '✓' : '✕'} ${label}</span>`;
  let html = '<div class="vc-effect">';
  html += `<div class="vc-effect-head">Compared with the default state of page <strong>${esc(e.pageName)}</strong> · ${esc(e.scope)}</div>`;
  html += `<div class="vc-caps">Captures: ${yes(e.captures.data, 'Data')} ${yes(e.captures.display, 'Display')} ${yes(e.captures.currentPage, 'Current page')}</div>`;

  const visibility = [
    ['Hidden by this bookmark', e.hidden, 'Visible by default'],
    ['Shown by this bookmark', e.shown, 'Hidden by default'],
    ['Groups hidden', e.groupsHidden, ''],
    ['Groups shown', e.groupsShown, ''],
  ].filter(([, list]) => list.length);
  const filterRows = [
    ...e.reportFilters.map(f => ({ scope: 'Report (all pages)', ...f })),
    ...e.pageFilters.map(f => ({ scope: `Page: ${e.pageName}`, ...f })),
    ...e.visualFilters.map(f => ({ scope: f.visual, ...f })),
  ];

  if (!visibility.length && !filterRows.length && !e.slicers.length) {
    html += '<div class="vc-effect-empty">This bookmark matches the page\'s default state. It shows no hidden or unhidden objects and no filter or slicer changes.</div>';
  }

  if (visibility.length) {
    html += `<div class="vc-effect-block${e.captures.display ? '' : ' vc-inactive'}">`;
    html += '<div class="vc-effect-title">Visibility</div>';
    if (!e.captures.display) html += '<div class="vc-effect-warn">Display isn\'t captured, so Power BI does not apply these visibility states when the bookmark is clicked.</div>';
    html += '<div class="vc-effect-cols">';
    for (const [title, list, hint] of visibility) {
      html += `<div><div class="vc-effect-sub">${esc(title)} <span class="ch-topic-count">${list.length}</span>${hint ? ` <span class="vc-muted">${esc(hint)}</span>` : ''}</div><ul class="vc-list">${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    }
    html += '</div></div>';
  }

  if (filterRows.length || e.slicers.length) {
    html += `<div class="vc-effect-block${e.captures.data ? '' : ' vc-inactive'}">`;
    html += '<div class="vc-effect-title">Filters and slicers</div>';
    if (!e.captures.data) html += '<div class="vc-effect-warn">Data isn\'t captured, so these filter and slicer states are stored in the bookmark but Power BI does not apply them when it\'s clicked.</div>';
    html += '<div class="table-wrap-vc"><table class="vc-effect-table"><thead><tr><th>Applies to</th><th>Field</th><th>Page default</th><th>With bookmark</th></tr></thead><tbody>';
    for (const f of filterRows) {
      html += `<tr><td>${esc(f.scope)}${f.notInPane ? ' <span class="vc-muted">(not in its filter pane)</span>' : ''}</td><td>${esc(f.field)}</td><td class="vc-before">${esc(f.default)}</td><td class="vc-after">${esc(f.bookmark)}</td></tr>`;
    }
    for (const s of e.slicers) {
      html += `<tr><td>${esc(s.visual)} <span class="vc-muted">(slicer)</span></td><td>Selection</td><td class="vc-before">${esc(s.default)}</td><td class="vc-after">${esc(s.bookmark)}</td></tr>`;
    }
    html += '</tbody></table></div></div>';
  }

  if (e.notCaptured) {
    html += `<div class="vc-effect-foot">${e.notCaptured} visual${e.notCaptured !== 1 ? 's' : ''} on this page ${e.notCaptured !== 1 ? 'aren\'t' : 'isn\'t'} recorded in the bookmark, so ${e.notCaptured !== 1 ? 'they keep' : 'it keeps'} whatever state ${e.notCaptured !== 1 ? 'they\'re' : 'it\'s'} in when the bookmark is clicked.</div>`;
  }
  return html + '</div>';
}

// --- Events ------------------------------------------------------------------

function bind() {
  const root = _container;
  root.querySelectorAll('[data-pair]').forEach(b => b.addEventListener('click', () => selectPair(Number(b.dataset.pair))));
  root.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => selectPair(_index + (b.dataset.nav === 'older' ? 1 : -1))));
  root.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { _group = b.dataset.group; render(); }));
  root.querySelectorAll('[data-expand]').forEach(b => b.addEventListener('click', () => { _expanded.add(b.dataset.expand); render(); }));
  root.querySelectorAll('[data-diagram]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = (_data.pairs[_index]?.records || []).find(x => x.id === b.dataset.diagram);
    if (r?.diagram) _callbacks.onShowInDiagram?.({ pairIndex: _index, ...r.diagram });
  }));
  root.querySelectorAll('[data-effect]').forEach(head => {
    const toggle = () => {
      const id = head.dataset.effect;
      if (_openEffects.has(id)) _openEffects.delete(id); else _openEffects.add(id);
      const scrollTop = _container.scrollTop;
      render();
      _container.scrollTop = scrollTop; // keep the card where it was
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  const search = root.querySelector('#vc-search');
  if (search) {
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        _query = search.value;
        render();
        const s = _container.querySelector('#vc-search');
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
      }, 200);
    });
  }
  root.querySelector('.ch-pair.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function selectPair(i) {
  if (i < 0 || i >= (_data.pairs || []).length || i === _index) return;
  _index = i;
  _expanded.clear();
  _openEffects.clear();
  render();
}

// --- Helpers -----------------------------------------------------------------

function locationText(loc = {}) {
  return [loc.model, loc.report, loc.page, loc.visual, loc.table && `${loc.table} table`].filter(Boolean).join(' › ');
}
function flat(v) {
  return Array.isArray(v) ? v.join(' ') : String(v ?? '');
}
function short(hash) {
  return (hash || '').substring(0, 7);
}
function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso || ''; }
}
function formatDateTime(iso) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso || ''; }
}
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
