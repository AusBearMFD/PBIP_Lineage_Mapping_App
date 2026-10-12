/**
 * Dependency Strip data producer.
 *
 * Emits the `DependencyStripData` contract consumed by the "Dependencies"
 * section of the Measure view. The UI is a pure view over this shape — it must
 * never infer lineage itself, so everything the strip renders is computed here
 * from the already-built lineage graph.
 *
 * Contract (arrays are always present, never null):
 * {
 *   measure: { name, table, model, formatString?, expression },
 *   visuals: [{ report, page, visual, visualType?, role? }],
 *   downstreamMeasures: [{ name, table, kind, expression }],
 *   upstreamMeasures: [{ name, table, expression }],
 *   upstreamColumns: [{ table, column, via? }]
 * }
 */

import { NODE_TYPES, EDGE_TYPES } from '../utils/constants.js';
import { classifyMeasureUsage } from './graphBuilder.js';

/** Strip any workspace namespace prefix (`model:KEY§`) off a node id. */
function stripModelPrefix(id) {
  const idx = id.indexOf('§');
  return idx === -1 ? id : id.slice(idx + 1);
}

/** Human label for the semantic model a node belongs to, if discoverable. */
function resolveModelName(measureId, graph, fallback) {
  const ws = graph.workspace;
  if (!ws) return fallback || '';
  // Namespaced ids look like `model:<key>§measure::Table.Name`.
  const match = /^model:(.+?)§/.exec(measureId);
  if (match) return match[1].replace(/\.semanticmodel$/i, '');
  if (ws.primaryModelKey) return String(ws.primaryModelKey).replace(/\.semanticmodel$/i, '');
  return fallback || '';
}

/**
 * Which DAX function/context brought a column into the measure's lineage.
 * Best-effort and purely informational — returns '' when we can't tell, rather
 * than guessing, so the UI simply omits the "via" hint.
 */
function findColumnVia(expression, table, column) {
  if (!expression) return '';
  // Look for the column reference and walk backwards to the nearest function name.
  const escaped = `(?:'${table}'|${table})?\\[${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`;
  const re = new RegExp(escaped);
  const m = re.exec(expression);
  if (!m) return '';
  const before = expression.slice(0, m.index);
  // Nearest preceding FUNCTION( token.
  const fnMatches = [...before.matchAll(/([A-Z][A-Z0-9._]*)\s*\(/gi)];
  if (fnMatches.length === 0) return '';
  return fnMatches[fnMatches.length - 1][1].toUpperCase();
}

/**
 * Build the DependencyStripData payload for one measure.
 *
 * @param {string} measureNodeId - e.g. "measure::Sales._Total Revenue"
 * @param {{ nodes: Map, edges: Array, adjacency: object, workspace?: object }} graph
 * @param {{ modelName?: string }} [options]
 * @returns {object|null} The strip payload, or null if the measure isn't in the graph.
 */
export function buildDependencyStripData(measureNodeId, graph, options = {}) {
  const measureNode = graph.nodes.get(measureNodeId);
  if (!measureNode) return null;

  const upstreamIds = graph.adjacency.upstream.get(measureNodeId) || [];
  const downstreamIds = graph.adjacency.downstream.get(measureNodeId) || [];

  // --- Column 1: Visuals (Report > Page > Visual) ---
  // Transitive: a visual counts if it reaches this measure through any number
  // of intermediate measures, field parameters, or calculation groups.
  const visualIds = collectTransitiveDownstreamByType(measureNodeId, graph, NODE_TYPES.VISUAL);
  // Role is recorded on the direct visual->field edge when PBIR provided one.
  const roleByVisual = new Map();
  for (const edge of graph.edges) {
    if (edge.type !== EDGE_TYPES.VISUAL_TO_FIELD) continue;
    if (edge.target !== measureNodeId) continue;
    if (edge.metadata?.role) roleByVisual.set(edge.source, edge.metadata.role);
  }

  // Some PBIR extraction paths hand back the queryRef ("Sales.Total Sales")
  // instead of a data-role bucket ("Values", "Y"). Those aren't roles, so drop
  // them rather than render a misleading label.
  const qualifiedName = `${measureNode.metadata?.table || ''}.${measureNode.name}`;
  const isRealRole = (role) =>
    role && role !== qualifiedName && role !== measureNode.name && !role.includes('.');

  const visuals = [];
  for (const vId of visualIds) {
    const v = graph.nodes.get(vId);
    if (!v) continue;
    const rawRole = roleByVisual.get(vId) || '';
    visuals.push({
      report: v.metadata?.reportName || '',
      page: v.metadata?.pageName || resolvePageName(vId, graph),
      visual: v.metadata?.title || v.name || vId,
      visualType: v.metadata?.visualType || '',
      role: isRealRole(rawRole) ? rawRole : '',
    });
  }
  visuals.sort((a, b) =>
    (a.report + ' ' + a.page + ' ' + a.visual).localeCompare(b.report + ' ' + b.page + ' ' + b.visual)
  );

  // --- Column 2: Downstream measures / calculated columns (direct referrers) ---
  const downstreamMeasures = [];
  for (const id of dedupe(downstreamIds)) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    if (n.type === NODE_TYPES.MEASURE) {
      downstreamMeasures.push({
        name: n.name,
        table: n.metadata?.table || '',
        kind: n.enrichment?.type === 'calculation_group' ? 'calculationItem' : 'measure',
        expression: n.metadata?.expression || '',
      });
    } else if (n.type === NODE_TYPES.COLUMN && n.metadata?.expression) {
      // A column with a DAX expression is a calculated column.
      downstreamMeasures.push({
        name: n.name,
        table: n.metadata?.table || '',
        kind: 'calculatedColumn',
        expression: n.metadata.expression,
      });
    }
  }
  downstreamMeasures.sort((a, b) => a.name.localeCompare(b.name));

  // --- Column 3: Upstream measures (measures this one references) ---
  const upstreamMeasures = [];
  for (const id of dedupe(upstreamIds)) {
    const n = graph.nodes.get(id);
    if (!n || n.type !== NODE_TYPES.MEASURE) continue;
    upstreamMeasures.push({
      name: n.name,
      table: n.metadata?.table || '',
      expression: n.metadata?.expression || '',
    });
  }
  upstreamMeasures.sort((a, b) => a.name.localeCompare(b.name));

  // --- Column 4: Upstream columns (direct AND transitive) ---
  const columnIds = collectTransitiveUpstreamByType(measureNodeId, graph, NODE_TYPES.COLUMN);
  const ownExpression = measureNode.metadata?.expression || '';
  const upstreamColumns = [];
  for (const id of columnIds) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    const table = n.metadata?.table || '';
    const column = n.name;
    upstreamColumns.push({
      table,
      column,
      via: findColumnVia(ownExpression, table, column),
    });
  }
  upstreamColumns.sort((a, b) => (a.table + '[' + a.column + ']').localeCompare(b.table + '[' + b.column + ']'));

  return {
    measure: {
      name: measureNode.name,
      table: measureNode.metadata?.table || '',
      model: resolveModelName(measureNodeId, graph, options.modelName),
      formatString: measureNode.metadata?.formatString || '',
      expression: ownExpression,
    },
    visuals,
    downstreamMeasures,
    upstreamMeasures,
    upstreamColumns,
    filters: getFieldFilterUsage(measureNodeId, graph),
  };
}

/**
 * Filter panes that are actively filtering on a field — report, page, or
 * visual level.
 *
 * Only filters holding a non-default value are returned. A field merely sitting
 * in a filter pane with nothing applied isn't filtering anything, so counting
 * it would overstate how connected the measure is. Pass
 * `{ activeOnly: false }` to include idle filter-pane references as well.
 *
 * @param {string} fieldId - measure:: or column:: node id
 * @param {{ edges: Array, nodes: Map }} graph
 * @param {{ activeOnly?: boolean }} [options]
 * @returns {Array<{scope: string, owner: string, report: string, page: string, isActive: boolean, filterName: string}>}
 */
export function getFieldFilterUsage(fieldId, graph, options = {}) {
  const { activeOnly = true } = options;
  const out = [];
  const seen = new Set();

  for (const edge of (graph.edges || [])) {
    if (edge.type !== EDGE_TYPES.FILTER_TO_FIELD) continue;
    if (edge.target !== fieldId) continue;

    const ownerNode = graph.nodes.get(edge.source);
    const meta = edge.metadata || {};
    if (activeOnly && meta.isActive !== true) continue;
    const scope = meta.scope || (ownerNode?.type === NODE_TYPES.VISUAL ? 'visual' : 'page');

    // Resolve which report/page this filter lives on for display.
    let report = ownerNode?.metadata?.reportName || '';
    let page = '';
    if (ownerNode?.type === NODE_TYPES.VISUAL) {
      page = ownerNode.metadata?.pageName || resolvePageName(edge.source, graph);
    } else if (ownerNode?.type === NODE_TYPES.PAGE) {
      page = ownerNode.name || '';
    }

    const owner = meta.ownerName
      || (scope === 'report' ? 'Report' : (ownerNode?.metadata?.title || ownerNode?.name || ''));

    // A report-level filter is wired to every page, so collapse those into one
    // entry per report rather than repeating it for each page.
    const key = scope === 'report'
      ? `report§${report}§${meta.filterName || ''}`
      : `${scope}§${report}§${page}§${owner}§${meta.filterName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      scope,
      owner,
      report,
      page: scope === 'report' ? '' : page,
      isActive: meta.isActive === true,
      filterName: meta.filterName || '',
    });
  }

  // Report-level first (broadest blast radius), then page, then visual.
  const order = { report: 0, page: 1, visual: 2 };
  out.sort((a, b) =>
    (order[a.scope] ?? 9) - (order[b.scope] ?? 9)
    || (a.report + a.page + a.owner).localeCompare(b.report + b.page + b.owner)
  );
  return out;
}

/**
 * Build one flat summary row per measure — the data behind the "Dependents"
 * results grid. Counts are computed the same way the Dependencies strip
 * computes its columns, so the two views can never disagree.
 *
 * @param {{ nodes: Map, adjacency: object, workspace?: object }} graph
 * @returns {Array<object>} One row per measure in the model.
 */
export function buildMeasureSummaryRows(graph) {
  const rows = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.MEASURE) continue;
    if (node.metadata?.placeholder) continue;

    const upstreamIds = graph.adjacency.upstream.get(node.id) || [];
    const downstreamIds = graph.adjacency.downstream.get(node.id) || [];

    let dependsOnMeasures = 0;
    for (const id of dedupe(upstreamIds)) {
      if (graph.nodes.get(id)?.type === NODE_TYPES.MEASURE) dependsOnMeasures++;
    }
    let dependentMeasures = 0;
    for (const id of dedupe(downstreamIds)) {
      const n = graph.nodes.get(id);
      if (!n) continue;
      if (n.type === NODE_TYPES.MEASURE) dependentMeasures++;
      else if (n.type === NODE_TYPES.COLUMN && n.metadata?.expression) dependentMeasures++;
    }

    const visualIds = collectTransitiveDownstreamByType(node.id, graph, NODE_TYPES.VISUAL);
    const pages = new Set();
    const reports = new Set();
    for (const vId of visualIds) {
      const v = graph.nodes.get(vId);
      if (!v) continue;
      const page = v.metadata?.pageName || resolvePageName(vId, graph);
      if (page) pages.add(`${v.metadata?.reportName || ''}§${page}`);
      if (v.metadata?.reportName) reports.add(v.metadata.reportName);
    }

    const columnCount = collectTransitiveUpstreamByType(node.id, graph, NODE_TYPES.COLUMN).length;
    const usage = classifyMeasureUsage(node.id, graph);
    // Active filters only — an idle filter-pane entry isn't filtering anything.
    const filters = getFieldFilterUsage(node.id, graph);

    rows.push({
      id: node.id,
      name: node.name,
      table: node.metadata?.table || '',
      displayFolder: node.metadata?.displayFolder || '',
      formatString: node.metadata?.formatString || '',
      expression: node.metadata?.expression || '',
      isHidden: !!node.metadata?.isHidden,
      dependsOnMeasures,
      dependentMeasures,
      columnCount,
      visualCount: visualIds.length,
      pageCount: pages.size,
      reportCount: reports.size,
      orphanCategory: usage.category,
      filterCount: filters.length,
    });
  }

  rows.sort((a, b) => (a.table + '.' + a.name).localeCompare(b.table + '.' + b.name));
  return rows;
}

function dedupe(ids) {
  return [...new Set(ids)];
}

function resolvePageName(visualId, graph) {
  const ups = graph.adjacency.upstream.get(visualId) || [];
  for (const id of ups) {
    const n = graph.nodes.get(id);
    if (n && n.type === NODE_TYPES.PAGE) return n.name;
  }
  return '';
}

/** BFS over "things that reference X", collecting nodes of a given type. */
function collectTransitiveDownstreamByType(startId, graph, type) {
  const found = new Set();
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of (graph.adjacency.downstream.get(cur) || [])) {
      if (seen.has(next)) continue;
      seen.add(next);
      const n = graph.nodes.get(next);
      if (n && n.type === type) found.add(next);
      queue.push(next);
    }
  }
  return [...found];
}

/** BFS over "things X depends on", collecting nodes of a given type. */
function collectTransitiveUpstreamByType(startId, graph, type) {
  const found = new Set();
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of (graph.adjacency.upstream.get(cur) || [])) {
      if (seen.has(next)) continue;
      seen.add(next);
      const n = graph.nodes.get(next);
      if (n && n.type === type) found.add(next);
      queue.push(next);
    }
  }
  return [...found];
}

export { stripModelPrefix };
