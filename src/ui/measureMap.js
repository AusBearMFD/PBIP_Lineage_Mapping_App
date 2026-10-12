/**
 * Measure Map - a measure-centric view of the whole model.
 *
 * Unlike the Lineage Trace view (which roots the tree at a visual or walks
 * down to source columns), the Measure Map puts a single selected measure at
 * the literal center of the diagram and radiates outward to:
 *   - measures it depends on (direct DAX references, upstream)
 *   - other measures that depend on it (direct DAX references, downstream)
 *   - every visual it reaches, anywhere in the report — including
 *     transitively through other measures, field parameters, and
 *     calculation groups — so you can see the full blast radius of changing
 *     this one measure at a glance.
 *
 * A searchable list of every measure in the model sits alongside the map;
 * clicking any measure (in the list, or in the map itself) re-centers it.
 */

import * as d3 from 'd3';
import { getDownstream, isMeasureOrphan } from '@pbip-lineage/core';

const NODE_W = 200;
const NODE_H = 40;
const CENTER_W = 220;
const CENTER_H = 48;
const ROW_GAP = 56;
const COLUMN_GAP = 260;
const CANVAS_PAD = 50;
const MAX_INDIVIDUAL_VISUALS = 24; // beyond this, group the Visuals column by page

const COLORS = {
  measure: '#ff9800',
  visual: '#4caf50',
  column: '#9c27b0',
  table: '#4285f4',
  page: '#00bcd4',
};

let _container = null;
let _listEl = null;
let _canvasEl = null;
let _detailEl = null;
let _graph = null;
let _centerId = null;
let _searchQuery = '';
let _callbacks = {};

/**
 * Register navigation callbacks.
 * @param {{ onVisualNavigate?: Function, onPageNavigate?: Function }} callbacks
 */
export function initMeasureMap(callbacks = {}) {
  _callbacks = callbacks;
}

/**
 * Render the Measure Map into a container. Safe to call repeatedly (e.g. on
 * toolbar toggle) — rebuilds the whole view.
 * @param {HTMLElement} container
 * @param {object} graph - The full lineage graph.
 * @param {{ centerMeasureId?: string }} [options]
 */
export function renderMeasureMap(container, graph, options = {}) {
  _container = container;
  _graph = graph;

  if (options.centerMeasureId) {
    _centerId = options.centerMeasureId;
  } else if (!_centerId || !graph.nodes.has(_centerId)) {
    const firstMeasure = allMeasures()[0];
    _centerId = firstMeasure ? firstMeasure.id : null;
  }

  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'measure-map-wrapper';
  wrapper.innerHTML = `
    <div class="measure-map-sidebar">
      <div class="search-group">
        <input type="text" id="mm-search" placeholder="Search measures..." autocomplete="off" aria-label="Search measures" />
      </div>
      <div id="mm-measure-list" class="measure-list" role="listbox" aria-label="All measures"></div>
    </div>
    <div class="measure-map-main">
      <div id="mm-canvas" class="measure-map-canvas"></div>
      <div id="mm-detail" class="measure-map-detail"></div>
    </div>
  `;
  container.appendChild(wrapper);

  _listEl = wrapper.querySelector('#mm-measure-list');
  _canvasEl = wrapper.querySelector('#mm-canvas');
  _detailEl = wrapper.querySelector('#mm-detail');

  const searchInput = wrapper.querySelector('#mm-search');
  searchInput.value = _searchQuery;
  searchInput.addEventListener('input', () => {
    _searchQuery = searchInput.value;
    renderList();
  });

  renderList();
  renderMap();
}

/**
 * Re-center the map on a different measure without losing search state.
 * @param {string} measureId
 */
export function setCenterMeasure(measureId) {
  if (!_graph || !_graph.nodes.has(measureId)) return;
  _centerId = measureId;
  renderList();
  renderMap();
}

function allMeasures() {
  if (!_graph) return [];
  const list = [];
  for (const node of _graph.nodes.values()) {
    if (node.type === 'measure') list.push(node);
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// --- Sidebar measure list ---

function renderList() {
  if (!_listEl || !_graph) return;

  const q = _searchQuery.trim().toLowerCase();
  const measures = allMeasures().filter(m => !q || m.name.toLowerCase().includes(q));

  if (measures.length === 0) {
    _listEl.innerHTML = '<div class="measure-empty">No measures match your search.</div>';
    return;
  }

  let html = '';
  for (const node of measures) {
    const isCenter = node.id === _centerId;
    const orphan = isMeasureOrphan(node.id, _graph);
    const orphanBadge = orphan
      ? ' <span class="measure-badge measure-badge-orphan" title="Not used by any visual, and not actively filtering a page or report">orphan</span>'
      : '';
    html += `<div class="measure-item${isCenter ? ' active' : ''}" data-id="${escapeHtml(node.id)}" title="${escapeHtml(node.metadata?.table || '')}[${escapeHtml(node.name)}]">${escapeHtml(node.name)}${orphanBadge}</div>`;
  }
  _listEl.innerHTML = html;

  _listEl.querySelectorAll('.measure-item[data-id]').forEach(el => {
    el.addEventListener('click', () => setCenterMeasure(el.dataset.id));
  });
}

// --- Detail / "also uses" info card ---

function renderDetail(centerNode, fieldNodes) {
  if (!_detailEl) return;

  if (!centerNode) {
    _detailEl.innerHTML = '<p class="lineage-muted">No measure selected.</p>';
    return;
  }

  const table = centerNode.metadata?.table || '';
  const expr = truncate(centerNode.metadata?.expression || '', 220);

  let fieldsHtml = '';
  if (fieldNodes.length > 0) {
    const items = fieldNodes
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(n => `<span class="mm-field-chip" style="border-color:${COLORS[n.type] || '#888'}">${escapeHtml(n.metadata?.table ? `${n.metadata.table}[${n.name}]` : n.name)}</span>`)
      .join(' ');
    fieldsHtml = `<div class="mm-detail-row"><span class="mm-detail-label">Also uses (columns/tables)</span><div class="mm-field-chips">${items}</div></div>`;
  }

  _detailEl.innerHTML = `
    <div class="mm-detail-row"><span class="mm-detail-label">Selected</span><strong>${escapeHtml(table)}[${escapeHtml(centerNode.name)}]</strong></div>
    ${expr ? `<div class="mm-detail-row"><span class="mm-detail-label">DAX</span><code class="mm-detail-dax">${escapeHtml(expr)}</code></div>` : ''}
    ${fieldsHtml}
  `;
}

// --- Canvas / hub graph ---

function renderMap() {
  if (!_canvasEl) return;
  _canvasEl.innerHTML = '';

  const centerNode = _centerId ? _graph.nodes.get(_centerId) : null;
  if (!centerNode) {
    _canvasEl.innerHTML = '<p class="lineage-muted">No measures found in this model.</p>';
    renderDetail(null, []);
    return;
  }

  const upstreamIds = _graph.adjacency.upstream.get(_centerId) || [];
  const downstreamIds = _graph.adjacency.downstream.get(_centerId) || [];

  const dependsOnMeasures = dedupeNodes(upstreamIds.filter(id => _graph.nodes.get(id)?.type === 'measure'));
  const usedByMeasures = dedupeNodes(downstreamIds.filter(id => _graph.nodes.get(id)?.type === 'measure'));
  const dependsOnFields = dedupeNodes(upstreamIds.filter(id => {
    const n = _graph.nodes.get(id);
    return n && (n.type === 'column' || n.type === 'table');
  }));

  const allDownstream = getDownstream(_centerId, _graph.adjacency);
  const visualNodes = dedupeNodes([...allDownstream].filter(id => _graph.nodes.get(id)?.type === 'visual'));

  renderDetail(centerNode, dependsOnFields);

  // Build the four columns. "Visuals" collapses to one node per page when
  // there are too many individual visuals to stay legible.
  let visualColumnNodes;
  let visualColumnIsGrouped = false;
  if (visualNodes.length > MAX_INDIVIDUAL_VISUALS) {
    visualColumnIsGrouped = true;
    const byPage = new Map();
    for (const v of visualNodes) {
      const pageName = v.metadata?.pageName || v.metadata?.pageId || 'Page';
      const reportName = v.metadata?.reportName || '';
      // Group by the page's unique NODE id so two reports' identically-named
      // pages stay separate, and so clicking through navigates to the right
      // page — a synthetic key would match nothing on navigation.
      const pageNodeId = resolvePageNodeId(v.id) || `${reportName}::${v.metadata?.pageId || pageName}`;
      if (!byPage.has(pageNodeId)) byPage.set(pageNodeId, { pageNodeId, pageName, reportName, count: 0 });
      byPage.get(pageNodeId).count++;
    }
    visualColumnNodes = [...byPage.values()].map(p => ({
      id: `page-group::${p.pageNodeId}`,
      name: p.pageName,
      type: 'page',
      isPageGroup: true,
      pageId: p.pageNodeId,
      subtitle: p.reportName ? `${p.count} visual${p.count !== 1 ? 's' : ''} · ${p.reportName}` : `${p.count} visual${p.count !== 1 ? 's' : ''}`,
    }));
  } else {
    visualColumnNodes = visualNodes.map(v => ({
      id: v.id,
      name: v.metadata?.title || v.name,
      type: 'visual',
      subtitle: v.metadata?.reportName ? `${v.metadata?.pageName || ''} · ${v.metadata.reportName}` : (v.metadata?.pageName || ''),
    }));
  }

  const dependsOnCol = dependsOnMeasures.map(n => ({ id: n.id, name: n.name, type: 'measure', subtitle: n.metadata?.table || '' }));
  const usedByCol = usedByMeasures.map(n => ({ id: n.id, name: n.name, type: 'measure', subtitle: n.metadata?.table || '' }));

  const columns = [
    { x: -COLUMN_GAP, label: 'Depends on', nodes: dependsOnCol },
    { x: COLUMN_GAP, label: 'Used by', nodes: usedByCol },
    { x: COLUMN_GAP * 2, label: visualColumnIsGrouped ? `Appears on ${visualNodes.length} visuals` : `Appears on ${visualColumnNodes.length} visual${visualColumnNodes.length !== 1 ? 's' : ''}`, nodes: visualColumnNodes },
  ];

  drawHubGraph(centerNode, columns);
}

/** De-duplicate a list of node ids into their graph node objects. */
/**
 * The unique page node id a visual sits on. Page names and raw pageIds repeat
 * across reports in a workspace, so navigation needs the node id.
 */
function resolvePageNodeId(visualId) {
  for (const id of (_graph.adjacency.upstream.get(visualId) || [])) {
    if (_graph.nodes.get(id)?.type === 'page') return id;
  }
  return '';
}

function dedupeNodes(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = _graph.nodes.get(id);
    if (node) out.push(node);
  }
  return out;
}

function layoutColumn(nodes, x) {
  const totalH = nodes.length * ROW_GAP;
  return nodes.map((node, i) => ({
    ...node,
    x,
    y: -totalH / 2 + ROW_GAP * (i + 0.5),
  }));
}

function drawHubGraph(centerNode, columns) {
  const placed = columns.map(col => ({ ...col, nodes: layoutColumn(col.nodes, col.x) }));
  const centerPoint = { x: 0, y: 0, id: centerNode.id, name: centerNode.name, type: 'measure', isCenter: true };

  const allPlacedNodes = [centerPoint, ...placed.flatMap(c => c.nodes)];

  const halfW = NODE_W / 2, halfH = NODE_H / 2;
  const minX = Math.min(...allPlacedNodes.map(d => d.x)) - halfW;
  const maxX = Math.max(...allPlacedNodes.map(d => d.x)) + halfW;
  const minY = Math.min(...allPlacedNodes.map(d => d.y)) - halfH;
  const maxY = Math.max(...allPlacedNodes.map(d => d.y)) + halfH;

  const offsetX = CANVAS_PAD - minX;
  const offsetY = CANVAS_PAD - minY;
  const width = Math.max((maxX - minX) + CANVAS_PAD * 2, 500);
  const height = Math.max((maxY - minY) + CANVAS_PAD * 2, 300);

  const wrapper = d3.select(_canvasEl).append('div').attr('class', 'lineage-tree-wrapper');
  const svg = wrapper.append('svg')
    .attr('class', 'lineage-tree-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${width} ${height}`);

  const g = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.05, 3])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  const controls = wrapper.append('div').attr('class', 'tree-zoom-controls');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'in').attr('title', 'Zoom in').text('+');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'out').attr('title', 'Zoom out').text('−');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'fit').attr('title', 'Fit to view').text('Fit');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'reset').attr('title', 'Reset to 100%').text('1×');
  wrapper.append('div').attr('class', 'tree-zoom-hint').text('Scroll to zoom · Drag to pan');

  function fitToView() {
    const svgEl = svg.node();
    if (!svgEl) return;
    const availW = svgEl.clientWidth || width;
    const availH = svgEl.clientHeight || height;
    const fitScale = Math.min(availW / (width + 40), availH / (height + 40), 1);
    zoom.scaleExtent([Math.max(0.05, fitScale * 0.7), 3]);
    const tx = Math.max(10, (availW - width * fitScale) / 2);
    const ty = Math.max(10, (availH - height * fitScale) / 2);
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(fitScale));
  }

  controls.selectAll('.tree-zoom-btn').on('click', function () {
    const action = this.getAttribute('data-zoom');
    if (action === 'in') svg.transition().duration(180).call(zoom.scaleBy, 1.4);
    else if (action === 'out') svg.transition().duration(180).call(zoom.scaleBy, 1 / 1.4);
    else if (action === 'fit') fitToView();
    else if (action === 'reset') svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity.translate(20, 10).scale(1));
  });

  requestAnimationFrame(() => fitToView());

  // Column section labels
  for (const col of placed) {
    if (col.nodes.length === 0) continue;
    const topY = Math.min(...col.nodes.map(n => n.y)) - halfH - 14;
    g.append('text')
      .attr('x', col.x + offsetX)
      .attr('y', topY + offsetY)
      .attr('text-anchor', 'middle')
      .attr('fill', '#9999bb')
      .attr('font-size', '12px')
      .attr('font-weight', 600)
      .text(col.label);
  }

  // Links: center <-> depends-on / used-by (solid); center -> visuals (dashed,
  // since a visual may be reached transitively through several measures).
  const linkGen = d3.linkHorizontal().x(d => d.x + offsetX).y(d => d.y + offsetY);
  for (const col of placed) {
    const isVisualCol = col.nodes.some(n => n.type === 'visual' || n.isPageGroup);
    g.selectAll(null)
      .data(col.nodes)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke', d => COLORS[d.type] || '#888')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', isVisualCol ? 0.45 : 0.65)
      .attr('stroke-dasharray', isVisualCol ? '5,4' : null)
      .attr('d', d => {
        const source = col.x < 0 ? d : centerPoint;
        const target = col.x < 0 ? centerPoint : d;
        return linkGen({ source, target });
      });
  }

  // Nodes
  const nodeSel = g.selectAll('.mm-node')
    .data(allPlacedNodes)
    .join('g')
    .attr('class', 'mm-node')
    .attr('transform', d => `translate(${d.x + offsetX}, ${d.y + offsetY})`)
    .style('cursor', d => d.isCenter ? 'default' : 'pointer');

  nodeSel.append('rect')
    .attr('x', d => d.isCenter ? -CENTER_W / 2 : -NODE_W / 2)
    .attr('y', d => d.isCenter ? -CENTER_H / 2 : -NODE_H / 2)
    .attr('width', d => d.isCenter ? CENTER_W : NODE_W)
    .attr('height', d => d.isCenter ? CENTER_H : NODE_H)
    .attr('rx', 7)
    .attr('fill', d => COLORS[d.type] || '#888')
    .attr('fill-opacity', d => d.isCenter ? 0.32 : 0.2)
    .attr('stroke', d => COLORS[d.type] || '#888')
    .attr('stroke-width', d => d.isCenter ? 2.5 : 1.5);

  nodeSel.append('text')
    .attr('x', d => (d.isCenter ? -CENTER_W / 2 : -NODE_W / 2) + 14)
    .attr('y', d => d.subtitle ? -3 : 4)
    .attr('fill', '#ececec')
    .attr('font-size', d => d.isCenter ? '14px' : '13px')
    .attr('font-weight', d => d.isCenter ? 700 : 600)
    .text(d => truncate(d.name, d.isCenter ? 24 : 22));

  nodeSel.filter(d => !!d.subtitle).append('text')
    .attr('x', d => (d.isCenter ? -CENTER_W / 2 : -NODE_W / 2) + 14)
    .attr('y', 12)
    .attr('fill', '#9999bb')
    .attr('font-size', '10px')
    .text(d => truncate(d.subtitle, 26));

  nodeSel.append('title').text(d => {
    if (d.isCenter) return `${d.name} (selected measure)`;
    if (d.isPageGroup) return `${d.name} — ${d.subtitle} — click to view page`;
    return d.subtitle ? `${d.name}\n${d.subtitle}` : d.name;
  });

  nodeSel.filter(d => !d.isCenter).on('click', (event, d) => {
    if (d.type === 'measure') {
      setCenterMeasure(d.id);
    } else if (d.isPageGroup) {
      if (_callbacks.onPageNavigate) _callbacks.onPageNavigate(d.pageId);
    } else if (d.type === 'visual') {
      if (_callbacks.onVisualNavigate) _callbacks.onVisualNavigate(d.id);
    }
  });
}

function truncate(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
