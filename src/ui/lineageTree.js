/**
 * Lineage Tree - D3.js tree/flow diagram for visualizing a traced lineage path.
 * Uses d3.tree() layout (deterministic, left-to-right) to show the full
 * lineage from Visuals down to data sources: Visual → Measure → Table → Column → Source.
 */

import * as d3 from 'd3';
import { LAYER_COLORS, LAYER_LABELS } from '@pbip-lineage/core/utils/constants.js';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 40;
const VERTICAL_SPACING = 64;    // was 52; increased for breathing room between nodes
const HORIZONTAL_SPACING = 260;
const MAX_SVG_HEIGHT = 2400;    // was 1600; give large trees (40+ nodes) more room before viewBox compression

/**
 * Build a tree for a visual-first view: selected visual as root,
 * branching into each measure's upstream lineage.
 */
export function buildVisualTreeData(visual, allMeasures, graph) {
  const measuresWithLineage = allMeasures.filter(m => m.lineage);
  if (measuresWithLineage.length === 0) return null;

  // Shared across every measure on this visual so a table/column used by
  // several of them renders once rather than once per measure. `visited` stays
  // per-measure so each measure still gets its own full chain.
  const emitted = new Map();

  const measureNodes = measuresWithLineage.map(m => {
    const { measureChain, sourceTable } = m.lineage;
    const sourceMap = new Map();
    for (const row of sourceTable) {
      sourceMap.set(`${row.pbiTable}.${row.pbiColumn}`, row);
    }

    const measureNode = {
      name: measureChain.name,
      layer: 2,
      layerLabel: LAYER_LABELS[2],
      type: 'measure',
      detail: truncateExpr(measureChain.expression),
      children: [],
    };
    addChainChildren(measureNode, measureChain, sourceMap, graph, new Set(), emitted);
    return measureNode;
  });

  return {
    name: visual.title || visual.type || 'Visual',
    layer: 1,
    layerLabel: LAYER_LABELS[1],
    type: 'visual',
    detail: `${visual.type} on ${visual.page}`,
    children: measureNodes,
  };
}

/**
 * Build a hierarchical tree data structure from lineage output.
 * Root is the selected measure. Visuals branch left; tables/columns/sources branch right.
 */
export function buildTreeData(lineage, graph) {
  const { visuals, measureChain, sourceTable } = lineage;

  const sourceMap = new Map();
  for (const row of sourceTable) {
    sourceMap.set(`${row.pbiTable}.${row.pbiColumn}`, row);
  }

  // The selected measure is the single root. Its consuming visuals hang off one
  // branch and its upstream dependencies off the others.
  //
  // Earlier versions cloned the entire dependency subtree once per consuming
  // visual, so a measure on 4 visuals rendered its measure/table/column nodes
  // 4 times each — and in a multi-report workspace that multiplied per report
  // even though every report shares the same semantic model node. Because a
  // d3.tree() node can only have one parent, the fix is to render the measure
  // and each dependency exactly once rather than duplicating per consumer.
  const root = {
    name: measureChain.name,
    layer: 2,
    layerLabel: LAYER_LABELS[2],
    type: 'measure',
    detail: truncateExpr(measureChain.expression),
    children: [],
  };

  // Downstream measures / calculated columns — things that REFERENCE this
  // measure. The chain built by traceMeasureLineage is upstream-only, so
  // without this branch the diagram silently omitted dependents that the
  // Dependencies section listed, which read as a bug.
  const dependents = collectDependents(measureChain.id, graph);
  if (dependents.length > 0) {
    const dependentNodes = dependents.map(d => ({
      name: d.name,
      layer: 3,
      layerLabel: d.kind === 'calculatedColumn' ? 'Calc Column (dependent)' : 'Measure (dependent)',
      type: 'dependent',
      detail: [d.table, truncateExpr(d.expression)].filter(Boolean).join(' · '),
      children: [],
    }));

    root.children.push(dependentNodes.length === 1 ? dependentNodes[0] : {
      name: `${dependents.length} dependents`,
      layer: 3,
      layerLabel: 'Referenced by',
      type: 'dependentGroup',
      detail: '',
      children: dependentNodes,
    });
  }

  if (visuals.length > 0) {
    const visualNodes = visuals.map(v => ({
      name: v.title || v.visualType,
      layer: 1,
      layerLabel: LAYER_LABELS[1],
      type: 'visual',
      detail: [v.visualType, v.page, v.report].filter(Boolean).join(' · '),
      children: [],
    }));

    if (visualNodes.length === 1) {
      root.children.push(visualNodes[0]);
    } else {
      // Group so a widely-used measure doesn't fan out into a wall of nodes.
      root.children.push({
        name: `Used by ${visuals.length} visuals`,
        layer: 1,
        layerLabel: 'Consumers',
        type: 'visualGroup',
        detail: '',
        children: visualNodes,
      });
    }
  }

  addChainChildren(root, measureChain, sourceMap, graph, new Set(), new Map());

  return root;
}

/**
 * Measures and calculated columns that directly reference the given measure.
 * Filter-pane and RLS references are excluded — those are shown in the
 * Dependencies section's own Filters list, not as model dependents.
 */
function collectDependents(measureId, graph) {
  if (!measureId || !graph?.adjacency?.downstream) return [];

  const filterOrRls = new Set();
  for (const edge of (graph.edges || [])) {
    if (edge.target !== measureId) continue;
    if (edge.type === 'filter_to_field' || edge.type === 'rls_to_field') {
      filterOrRls.add(edge.source);
    }
  }

  const out = [];
  for (const id of (graph.adjacency.downstream.get(measureId) || [])) {
    if (filterOrRls.has(id)) continue;
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (node.type === 'measure') {
      out.push({
        name: node.name,
        table: node.metadata?.table || '',
        expression: node.metadata?.expression || '',
        kind: 'measure',
      });
    } else if (node.type === 'column' && node.metadata?.expression) {
      out.push({
        name: node.name,
        table: node.metadata?.table || '',
        expression: node.metadata.expression,
        kind: 'calculatedColumn',
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Recursively add sub-measures and columns (grouped by table) as children.
 * New structure: Measure → Table → Columns + Source (instead of flat column list).
 */
function addChainChildren(node, chain, sourceMap, graph, visited, emitted = new Map()) {
  if (visited.has(chain.id)) return;
  visited.add(chain.id);

  // Sub-measure children
  for (const child of chain.children) {
    const subNode = {
      name: child.name,
      layer: 3,
      layerLabel: LAYER_LABELS[3],
      type: 'subMeasure',
      detail: truncateExpr(child.expression),
      children: [],
    };
    addChainChildren(subNode, child, sourceMap, graph, visited, emitted);
    node.children.push(subNode);
  }

  // Group columns by their PBI table → one Table node per table
  const tableGroups = new Map();
  for (const col of chain.columns) {
    if (!tableGroups.has(col.table)) tableGroups.set(col.table, []);
    tableGroups.get(col.table).push(col);
  }

  for (const [tableName, cols] of tableGroups) {
    const tableNodeId = `table::${tableName}`;

    // A table/column from the semantic model is one entity, so it appears once
    // per tree. If a sibling branch already emitted it, attach any newly-seen
    // columns to that existing node and record this extra consumer instead of
    // rendering a second copy of the same table.
    const alreadyEmitted = emitted.get(tableNodeId);
    if (alreadyEmitted) {
      noteAlsoUsedBy(alreadyEmitted, node.name);
      addColumnNodes(alreadyEmitted, cols, sourceMap, emitted);
      continue;
    }
    const tableGraphNode = graph?.nodes?.get(tableNodeId);
    const ds = tableGraphNode?.metadata?.dataSource;

    // Build table detail from data source metadata
    const detailParts = [];
    if (ds?.sourceType) detailParts.push(ds.sourceType);
    if (ds?.database) detailParts.push(ds.database);

    const tableNode = {
      name: tableName,
      layer: 4,
      layerLabel: LAYER_LABELS[4],
      type: 'table',
      detail: detailParts.join(' · '),
      children: [],
    };
    emitted.set(tableNodeId, tableNode);

    addColumnNodes(tableNode, cols, sourceMap, emitted);

    // Resolve source chain: PQ expression (L5) → Source connection (L6)
    // Walk graph adjacency: table → expression → source
    let addedSource = false;
    if (graph?.adjacency?.downstream && tableNodeId) {
      const tableDownIds = graph.adjacency.downstream.get(tableNodeId) || new Set();
      for (const dId of tableDownIds) {
        const dNode = graph.nodes.get(dId);
        if (dNode?.type === 'expression') {
          // PQ Expression node (L5)
          const exprChildren = [];
          const exprDownIds = graph.adjacency.downstream.get(dNode.id) || new Set();
          for (const eId of exprDownIds) {
            const srcNode = graph.nodes.get(eId);
            if (srcNode?.type === 'source') {
              const srcMeta = srcNode.metadata || {};
              const srcDetail = [srcMeta.sourceType, srcMeta.server, srcMeta.database, srcMeta.schema]
                .filter(Boolean).join(' · ');
              exprChildren.push({
                name: truncateText(srcMeta.sourceTable || srcNode.name || eId.split('::')[1] || 'Source', 30),
                layer: 6,
                layerLabel: LAYER_LABELS[6],
                type: 'source',
                detail: srcDetail,
                children: [],
              });
            }
          }
          tableNode.children.push({
            name: truncateText(dNode.name || 'Expression', 30),
            layer: 5,
            layerLabel: LAYER_LABELS[5],
            type: 'expression',
            detail: 'Power Query expression',
            children: exprChildren,
          });
          addedSource = true;
          break; // one expression node per table is enough for the tree
        }
      }

      // If no expression, look for direct table → source edges
      if (!addedSource) {
        for (const dId of tableDownIds) {
          const dNode = graph.nodes.get(dId);
          if (dNode?.type === 'source') {
            const srcMeta = dNode.metadata || {};
            const srcDetail = [srcMeta.sourceType, srcMeta.server, srcMeta.database, srcMeta.schema]
              .filter(Boolean).join(' · ');
            tableNode.children.push({
              name: truncateText(srcMeta.sourceTable || dNode.name || 'Source', 30),
              layer: 6,
              layerLabel: LAYER_LABELS[6],
              type: 'source',
              detail: srcDetail,
              children: [],
            });
            addedSource = true;
            break;
          }
        }
      }
    }

    // Fallback: use data source metadata from column sourceMap
    if (!addedSource) {
      const firstCol = cols[0];
      const firstSource = sourceMap.get(`${firstCol.table}.${firstCol.name}`);
      if (firstSource?.sourceTablePath) {
        const srcName = firstSource.sourceTable || firstSource.sourceTablePath.split('.').pop() || firstSource.sourceTablePath;
        const srcDetail = [ds?.sourceType, ds?.server, ds?.database, ds?.schema]
          .filter(Boolean).join(' · ');
        tableNode.children.push({
          name: truncateText(srcName, 30),
          layer: 6,
          layerLabel: LAYER_LABELS[6],
          type: 'source',
          detail: srcDetail,
          children: [],
        });
      }
    }

    node.children.push(tableNode);
  }
}

/**
 * Add column nodes under a table node, skipping any column already present in
 * the tree. A column is one entity in the semantic model, so it renders once.
 */
function addColumnNodes(tableNode, cols, sourceMap, emitted) {
  for (const col of cols) {
    const colKey = `column::${col.table}.${col.name}`;
    if (emitted.has(colKey)) continue;

    const srcColName = col.originalSourceColumn || col.sourceColumn;
    const wasRenamed = col.wasRenamed || (srcColName && srcColName !== col.name);

    let colLayerLabel = 'PBI Column';
    if (wasRenamed && srcColName) {
      colLayerLabel = `← src: ${truncateText(srcColName, 22)}`;
    }

    const sourceRow = sourceMap.get(`${col.table}.${col.name}`);
    const colNode = {
      name: col.name,
      layer: 4,
      layerLabel: colLayerLabel,
      type: 'column',
      detail: sourceRow?.sourceColumnFull || '',
      children: [],
    };
    emitted.set(colKey, colNode);
    tableNode.children.push(colNode);
  }
}

/**
 * Record that another measure in this tree also consumes an already-rendered
 * node, so collapsing the duplicate doesn't lose the relationship.
 */
function noteAlsoUsedBy(node, consumerName) {
  if (!consumerName) return;
  if (!node._alsoUsedBy) node._alsoUsedBy = [];
  if (node._alsoUsedBy.includes(consumerName)) return;
  node._alsoUsedBy.push(consumerName);
  const shared = `also used by ${node._alsoUsedBy.join(', ')}`;
  const base = node._baseDetail !== undefined ? node._baseDetail : (node._baseDetail = node.detail || '');
  node.detail = base ? `${base} · ${shared}` : shared;
}

/**
 * Build a source-first tree for the "Source view" toggle.
 * Root = source connection (L6), flowing down through PQ → Table → Columns → Measure → Visuals.
 * @param {object} lineage - Output from traceMeasureLineage()
 * @param {object} graph   - The full lineage graph
 */
export function buildSourceFirstTreeData(lineage, graph) {
  const { measureChain, visuals } = lineage;

  const visualLeaves = visuals.map(v => ({
    name: truncateText(v.title || v.visualType || 'Visual', 28),
    layer: 1, layerLabel: LAYER_LABELS[1], type: 'visual',
    detail: `${v.visualType} on ${v.page}`, children: [],
  }));

  const measureNode = {
    name: measureChain.name,
    layer: 2, layerLabel: LAYER_LABELS[2], type: 'measure',
    detail: truncateExpr(measureChain.expression),
    children: visualLeaves,
  };

  // Group columns by PBI table
  const tableGroups = new Map();
  for (const col of measureChain.columns) {
    if (!tableGroups.has(col.table)) tableGroups.set(col.table, []);
    tableGroups.get(col.table).push(col);
  }

  if (tableGroups.size === 0) return null;

  const sourceRoots = [];
  let measurePlaced = false;

  for (const [tableName, cols] of tableGroups) {
    const tableNodeId = `table::${tableName}`;
    const tableGraphNode = graph?.nodes?.get(tableNodeId);
    const ds = tableGraphNode?.metadata?.dataSource;

    const colNodes = cols.map(col => {
      const wasRenamed = col.wasRenamed || (col.originalSourceColumn && col.originalSourceColumn !== col.name);
      return {
        name: col.name,
        layer: 4,
        layerLabel: wasRenamed && col.originalSourceColumn
          ? `← src: ${truncateText(col.originalSourceColumn, 22)}`
          : 'PBI Column',
        type: 'column',
        detail: '',
        children: [],
      };
    });

    // Place measure under the first table only to avoid duplication
    const tableChildren = [...colNodes];
    if (!measurePlaced) {
      tableChildren.push(measureNode);
      measurePlaced = true;
    }

    const tableNode = {
      name: tableName,
      layer: 4, layerLabel: LAYER_LABELS[4], type: 'table',
      detail: [ds?.sourceType, ds?.database].filter(Boolean).join(' · '),
      children: tableChildren,
    };

    // Walk graph: table → expression → source
    let treeRoot = tableNode;
    if (graph?.adjacency?.downstream) {
      const tableDownIds = graph.adjacency.downstream.get(tableNodeId) || new Set();
      outer: for (const dId of tableDownIds) {
        const dNode = graph.nodes.get(dId);
        if (dNode?.type === 'expression') {
          for (const eId of (graph.adjacency.downstream.get(dNode.id) || new Set())) {
            const srcNode = graph.nodes.get(eId);
            if (srcNode?.type === 'source') {
              const srcMeta = srcNode.metadata || {};
              const srcDetail = [srcMeta.sourceType, srcMeta.server, srcMeta.database, srcMeta.schema].filter(Boolean).join(' · ');
              const exprNode = {
                name: truncateText(dNode.name || 'Expression', 30),
                layer: 5, layerLabel: LAYER_LABELS[5], type: 'expression',
                detail: 'Power Query expression', children: [tableNode],
              };
              treeRoot = {
                name: truncateText(srcMeta.sourceTable || srcNode.name || 'Source', 30),
                layer: 6, layerLabel: LAYER_LABELS[6], type: 'source',
                detail: srcDetail, children: [exprNode],
              };
              break outer;
            }
          }
        }
      }
      // Fallback: direct table → source edge
      if (treeRoot === tableNode) {
        for (const dId of (graph.adjacency.downstream.get(tableNodeId) || new Set())) {
          const dNode = graph.nodes.get(dId);
          if (dNode?.type === 'source') {
            const srcMeta = dNode.metadata || {};
            const srcDetail = [srcMeta.sourceType, srcMeta.server, srcMeta.database, srcMeta.schema].filter(Boolean).join(' · ');
            treeRoot = {
              name: truncateText(srcMeta.sourceTable || dNode.name || 'Source', 30),
              layer: 6, layerLabel: LAYER_LABELS[6], type: 'source',
              detail: srcDetail, children: [tableNode],
            };
            break;
          }
        }
      }
    }

    sourceRoots.push(treeRoot);
  }

  if (sourceRoots.length === 0) return null;
  if (sourceRoots.length === 1) return sourceRoots[0];

  return {
    name: measureChain.name,
    layer: 0, layerLabel: 'Data Sources', type: 'hub',
    detail: `${tableGroups.size} source tables`,
    children: sourceRoots,
  };
}

/**
 * Render the lineage tree into a container element.
 * @param {HTMLElement} container
 * @param {object} treeData - pre-built tree from buildTreeData()
 * @param {object} [options]
 * @param {boolean} [options.sourceFirst] - use source-first vertical layout
 * @param {object}  [options.lineage]     - raw lineage (required when sourceFirst=true)
 * @param {object}  [options.graph]       - raw graph   (required when sourceFirst=true)
 */
export function renderLineageTree(container, treeData, options = {}) {
  destroyTree(container);

  // When source-first mode is requested, build the inverted tree
  let effectiveTreeData = treeData;
  const isVertical = options.sourceFirst && options.lineage;
  if (isVertical) {
    const sfData = buildSourceFirstTreeData(options.lineage, options.graph);
    if (sfData) effectiveTreeData = sfData;
    else isVertical = false;
  }

  if (!effectiveTreeData || (!effectiveTreeData.children?.length && effectiveTreeData.layer === 0)) {
    if (container) {
      container.innerHTML = '<p class="lineage-muted">No tree visualization available for this measure.</p>';
    }
    return;
  }

  const hierarchy = d3.hierarchy(effectiveTreeData);

  // Calculate an initial layout canvas — this is just a starting extent fed
  // to d3.tree()'s algorithm. The actual SVG size is derived afterwards from
  // real, post-collision-fix node positions (see below), so a dense tree
  // never gets clipped or squeezed into overlapping boxes.
  const treeDepth = Math.max(hierarchy.height + 1, 2);
  const leaves = hierarchy.leaves().length;

  let layoutWidth, layoutHeight;
  if (isVertical) {
    // Vertical (top-down): leaves spread horizontally, depth grows downward
    layoutWidth = Math.max(leaves * (NODE_WIDTH + 20), 400);
    layoutHeight = treeDepth * HORIZONTAL_SPACING + NODE_HEIGHT + 80;
  } else {
    layoutWidth = treeDepth * HORIZONTAL_SPACING + NODE_WIDTH + 80;
    layoutHeight = Math.max(leaves * VERTICAL_SPACING, 200) + 60;
  }

  const treeLayout = isVertical
    ? d3.tree()
        .size([layoutWidth - NODE_WIDTH - 40, layoutHeight - NODE_HEIGHT - 80])
        .separation((a, b) => a.parent === b.parent ? 1.3 : 2.0)
    : d3.tree()
        .size([layoutHeight - 60, layoutWidth - NODE_WIDTH - 80])
        .separation((a, b) => a.parent === b.parent ? 1.2 : 1.6);

  treeLayout(hierarchy);

  // Post-layout collision fix: d3.tree()'s separation() only weighs a node
  // against its immediate siblings, so two unrelated branches (e.g. a wide
  // "Used by N visuals" group sitting alongside a deep dependency chain) can
  // still land close enough for their fixed-size boxes to overlap, especially
  // in wide/dense trees. Enforce a hard minimum pixel gap between any two
  // nodes at the same tree depth, then measure the tree's true bounding box
  // from the FINAL positions rather than trusting the estimate above, so the
  // SVG canvas always grows to fit — nothing overlaps and nothing clips.
  const crossAxisBoxSize = isVertical ? NODE_WIDTH : NODE_HEIGHT;
  resolveNodeOverlap(hierarchy.descendants(), crossAxisBoxSize + 24);

  const allNodes = hierarchy.descendants();
  const halfW = NODE_WIDTH / 2;
  const halfH = NODE_HEIGHT / 2;
  const canvasPad = 40;

  // The cross-axis (collision-resolved) coordinate is always d.x; which
  // screen axis it maps to depends on orientation (see transforms below).
  let minCanvasX, maxCanvasX, minCanvasY, maxCanvasY;
  if (isVertical) {
    minCanvasX = Math.min(...allNodes.map(d => d.x)) - halfW;
    maxCanvasX = Math.max(...allNodes.map(d => d.x)) + halfW;
    minCanvasY = Math.min(...allNodes.map(d => d.y)) - halfH;
    maxCanvasY = Math.max(...allNodes.map(d => d.y)) + halfH;
  } else {
    minCanvasX = Math.min(...allNodes.map(d => d.y)) - halfW;
    maxCanvasX = Math.max(...allNodes.map(d => d.y)) + halfW;
    minCanvasY = Math.min(...allNodes.map(d => d.x)) - halfH;
    maxCanvasY = Math.max(...allNodes.map(d => d.x)) + halfH;
  }

  // Offsets translate the (possibly negative, post-collision-fix) node
  // coordinates into positive SVG space starting at canvasPad.
  const offsetX = canvasPad - minCanvasX;
  const offsetY = canvasPad - minCanvasY;
  const width = (maxCanvasX - minCanvasX) + canvasPad * 2;
  const height = (maxCanvasY - minCanvasY) + canvasPad * 2;

  // SVG height: use full computed height up to MAX_SVG_HEIGHT so tall trees aren't compressed
  const svgHeight = Math.min(height, MAX_SVG_HEIGHT);

  // Wrapper holds the SVG, zoom controls overlay, and pan/zoom hint
  const wrapper = d3.select(container)
    .append('div')
    .attr('class', 'lineage-tree-wrapper');

  const svg = wrapper
    .append('svg')
    .attr('class', 'lineage-tree-svg')
    .attr('width', '100%')
    .attr('height', svgHeight)
    .attr('viewBox', `0 0 ${width} ${height}`);

  const g = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.05, 3])  // floor raised dynamically by fitToView() after first paint
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  svg.call(zoom);

  // Zoom controls overlay (top-right) — discoverable affordance for wheel-zoom/pan
  const controls = wrapper.append('div').attr('class', 'tree-zoom-controls');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'in').attr('title', 'Zoom in').text('+');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'out').attr('title', 'Zoom out').text('\u2212');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'fit').attr('title', 'Fit tree to view').text('Fit');
  controls.append('button').attr('class', 'tree-zoom-btn').attr('data-zoom', 'reset').attr('title', 'Reset to 100%').text('1\u00d7');

  wrapper.append('div').attr('class', 'tree-zoom-hint').text('Scroll to zoom \u00b7 Drag to pan');

  function fitToView() {
    const svgEl = svg.node();
    if (!svgEl) return;
    const availW = svgEl.clientWidth || width;
    const availH = svgEl.clientHeight || svgHeight;
    const scaleX = availW / (width + 80);
    const scaleY = availH / (height + 60);
    const fitScale = Math.min(scaleX, scaleY, 1);
    // Allow zooming ~30% beyond the auto-fit level so large trees can be seen in full
    zoom.scaleExtent([Math.max(0.05, fitScale * 0.7), 3]);
    const tx = Math.max(20, (availW - width * fitScale) / 2);
    const ty = Math.max(10, (availH - height * fitScale) / 2);
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(fitScale));
  }

  controls.selectAll('.tree-zoom-btn').on('click', function() {
    const action = this.getAttribute('data-zoom');
    if (action === 'in') svg.transition().duration(180).call(zoom.scaleBy, 1.4);
    else if (action === 'out') svg.transition().duration(180).call(zoom.scaleBy, 1 / 1.4);
    else if (action === 'fit') fitToView();
    else if (action === 'reset') svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity.translate(20, 10).scale(1));
  });

  // Auto-fit on first paint
  requestAnimationFrame(() => fitToView());

  // Draw links — horizontal for measure view, vertical for source view
  const linkGenerator = isVertical
    ? d3.linkVertical().x(d => d.x + offsetX).y(d => d.y + offsetY)
    : d3.linkHorizontal().x(d => d.y + offsetX).y(d => d.x + offsetY);

  g.selectAll('.tree-link')
    .data(hierarchy.links())
    .join('path')
    .attr('class', 'tree-link')
    .attr('d', linkGenerator)
    .attr('fill', 'none')
    .attr('stroke', d => getLayerColor(d.target.data.type))
    .attr('stroke-width', 2.5)
    .attr('stroke-opacity', 0.65);

  // Draw nodes — position differs by layout direction
  const nodes = g.selectAll('.tree-node')
    .data(hierarchy.descendants())
    .join('g')
    .attr('class', 'tree-node')
    .attr('transform', d => isVertical ? `translate(${d.x + offsetX}, ${d.y + offsetY})` : `translate(${d.y + offsetX}, ${d.x + offsetY})`);

  // Node background rectangles
  nodes.append('rect')
    .attr('x', -NODE_WIDTH / 2)
    .attr('y', -NODE_HEIGHT / 2)
    .attr('width', NODE_WIDTH)
    .attr('height', NODE_HEIGHT)
    .attr('rx', 6)
    .attr('ry', 6)
    .attr('fill', d => getLayerColor(d.data.type))
    .attr('fill-opacity', 0.22)
    .attr('stroke', d => getLayerColor(d.data.type))
    .attr('stroke-width', 1.5)
    // Source nodes get a dashed border to signal external system
    .attr('stroke-dasharray', d => d.data.type === 'source' ? '4,3' : null);

  // Layer indicator dot
  nodes.append('circle')
    .attr('cx', -NODE_WIDTH / 2 + 14)
    .attr('cy', 0)
    .attr('r', 5)
    .attr('fill', d => getLayerColor(d.data.type));

  // Node name text — increased truncation limit from 22 → 28 chars
  nodes.append('text')
    .attr('x', -NODE_WIDTH / 2 + 26)
    .attr('y', -3)
    .attr('class', 'tree-node-name')
    .text(d => truncateText(d.data.name, 28))
    .attr('fill', '#ececec')
    .attr('font-size', '13px')
    .attr('font-weight', 600)
    .attr('dominant-baseline', 'auto');

  // Layer / rename label text (second line)
  nodes.append('text')
    .attr('x', -NODE_WIDTH / 2 + 26)
    .attr('y', 11)
    .attr('class', 'tree-node-layer')
    .text(d => d.data.layerLabel || '')
    .attr('fill', d => {
      // Highlight rename labels in amber to draw attention
      if (d.data.type === 'column' && d.data.layerLabel?.startsWith('← src:')) return '#ffb74d';
      return '#9999bb';
    })
    .attr('font-size', '10px')
    .attr('dominant-baseline', 'auto');

  // Tooltips with full detail
  nodes.append('title')
    .text(d => {
      let tip = `${d.data.layerLabel}: ${d.data.name}`;
      if (d.data.detail) tip += `\n${d.data.detail}`;
      if (d.children && d.children.length > 0) tip += '\n(click to collapse)';
      return tip;
    });

  // Collapse/expand indicator
  nodes.filter(d => d.data.children && d.data.children.length > 0)
    .append('text')
    .attr('x', NODE_WIDTH / 2 - 14)
    .attr('y', 4)
    .attr('text-anchor', 'middle')
    .attr('fill', '#7a7a90')
    .attr('font-size', '12px')
    .attr('class', 'tree-node-toggle')
    .text(d => d.children ? '\u25BC' : '\u25B6')
    .style('cursor', 'pointer');

  // Click to collapse/expand
  nodes.filter(d => d.data.children && d.data.children.length > 0)
    .style('cursor', 'pointer')
    .on('click', function(event, d) {
      event.stopPropagation();
      if (d.children) {
        d._children = d.children;
        d.children = null;
      } else if (d._children) {
        d.children = d._children;
        d._children = null;
      }
      renderLineageTree(container, treeData, options);
    });

  addLegend(svg, width);
}

/**
 * Destroy the tree SVG from the container.
 */
export function destroyTree(container) {
  if (container) container.innerHTML = '';
}

/**
 * Export the current tree as SVG file.
 */
export function exportTreeAsSvg(container, filename = 'lineage-tree') {
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;

  const clone = svgEl.cloneNode(true);
  const viewBox = clone.getAttribute('viewBox');
  if (viewBox) {
    const [, , w, h] = viewBox.split(' ').map(Number);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
  }

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    svg { background: #1a1a2e; }
    .tree-node-name { fill: #ececec; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .tree-node-layer { fill: #9999bb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  `;
  clone.insertBefore(style, clone.firstChild);

  const vb = viewBox ? viewBox.split(' ').map(Number) : [0, 0, 800, 400];
  const watermark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  watermark.setAttribute('x', vb[2] - 10);
  watermark.setAttribute('y', vb[3] - 8);
  watermark.setAttribute('text-anchor', 'end');
  watermark.setAttribute('fill', '#555580');
  watermark.setAttribute('font-size', '10');
  watermark.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
  watermark.textContent = 'PBIP Lineage Explorer — Abearstudios (based on the open-source project by Jihwan Kim)';
  clone.appendChild(watermark);

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clone);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, `${filename}.svg`);
}

/**
 * Export the current tree as PNG file.
 */
export function exportTreeAsPng(container, filename = 'lineage-tree') {
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;

  const clone = svgEl.cloneNode(true);
  const viewBox = clone.getAttribute('viewBox');
  const [, , w, h] = viewBox ? viewBox.split(' ').map(Number) : [0, 0, 800, 400];

  const scale = 2;
  clone.setAttribute('width', w * scale);
  clone.setAttribute('height', h * scale);

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    svg { background: #1a1a2e; }
    .tree-node-name { fill: #ececec; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .tree-node-layer { fill: #9999bb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  `;
  clone.insertBefore(style, clone.firstChild);

  const watermark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  watermark.setAttribute('x', w - 10);
  watermark.setAttribute('y', h - 8);
  watermark.setAttribute('text-anchor', 'end');
  watermark.setAttribute('fill', '#555580');
  watermark.setAttribute('font-size', '10');
  watermark.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
  watermark.textContent = 'PBIP Lineage Explorer — Abearstudios (based on the open-source project by Jihwan Kim)';
  clone.appendChild(watermark);

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clone);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${filename}.png`);
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- Helpers ---

/**
 * Guarantee no two nodes at the same tree depth render closer together than
 * minGap pixels, regardless of what d3.tree()'s separation() produced.
 * Groups nodes by depth, sorts each row by cross-axis position (d.x — the
 * axis d3.tree() spreads siblings/cousins along, in BOTH horizontal and
 * vertical layouts), and greedily pushes any node that's too close to its
 * left/upper neighbor further away. The whole row is then re-centered on its
 * original midpoint so fixing overlap doesn't visibly drag the tree to one
 * side.
 * @param {Array} nodes - d3 hierarchy descendants (mutated in place).
 * @param {number} minGap - Minimum allowed pixel distance between adjacent node centers.
 */
function resolveNodeOverlap(nodes, minGap) {
  const byDepth = new Map();
  for (const d of nodes) {
    if (!byDepth.has(d.depth)) byDepth.set(d.depth, []);
    byDepth.get(d.depth).push(d);
  }

  for (const row of byDepth.values()) {
    if (row.length < 2) continue;
    row.sort((a, b) => a.x - b.x);

    const originalCenter = (row[0].x + row[row.length - 1].x) / 2;
    for (let i = 1; i < row.length; i++) {
      const minAllowed = row[i - 1].x + minGap;
      if (row[i].x < minAllowed) row[i].x = minAllowed;
    }

    // Re-center so the fix doesn't systematically drift the row in one direction.
    const newCenter = (row[0].x + row[row.length - 1].x) / 2;
    const drift = newCenter - originalCenter;
    if (drift !== 0) {
      for (const d of row) d.x -= drift;
    }
  }
}

function getLayerColor(type) {
  return LAYER_COLORS[type] || '#607d8b';
}

function truncateExpr(expr) {
  if (!expr) return '';
  const first = expr.split('\n')[0];
  return first.length > 80 ? first.substring(0, 80) + '...' : first;
}

function truncateText(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen - 1) + '\u2026' : text;
}

function addLegend(svg, width) {
  const legendData = [
    { type: 'visual',      label: LAYER_LABELS[1], prefix: 'L1' },
    { type: 'measure',     label: LAYER_LABELS[2], prefix: 'L2' },
    { type: 'subMeasure',  label: LAYER_LABELS[3], prefix: 'L3' },
    { type: 'table',       label: 'PBI Table',      prefix: 'L4' },
    { type: 'column',      label: 'PBI Column',     prefix: 'L4' },
    { type: 'expression',  label: LAYER_LABELS[5], prefix: 'L5' },
    { type: 'source',      label: LAYER_LABELS[6], prefix: 'L6' },
  ];

  const rowH = 24;
  const legendW = 210;
  const legend = svg.append('g')
    .attr('class', 'tree-legend')
    .attr('transform', `translate(${width - legendW - 10}, 10)`);

  legend.append('rect')
    .attr('x', -10)
    .attr('y', -10)
    .attr('width', legendW)
    .attr('height', legendData.length * rowH + 20)
    .attr('rx', 6)
    .attr('fill', 'rgba(22, 33, 62, 0.92)')
    .attr('stroke', '#2a2a4a');

  const entries = legend.selectAll('.legend-entry')
    .data(legendData)
    .join('g')
    .attr('class', 'legend-entry')
    .attr('transform', (d, i) => `translate(0, ${i * rowH})`);

  entries.append('circle')
    .attr('cx', 8)
    .attr('cy', 8)
    .attr('r', 5)
    .attr('fill', d => LAYER_COLORS[d.type] || '#607d8b');

  entries.append('text')
    .attr('x', 20)
    .attr('y', 12)
    .text(d => `${d.prefix}: ${d.label}`)
    .attr('fill', '#d4d4e0')
    .attr('font-size', '13px');
}
