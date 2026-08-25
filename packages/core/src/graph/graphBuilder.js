/**
 * Graph Builder - Constructs the lineage graph data structure.
 * Takes parsed model and report data and produces a node/edge graph
 * suitable for rendering with D3.js.
 */

import { NODE_TYPES, EDGE_TYPES } from '../utils/constants.js';
import { extractMDataSource, extractRenameColumns, extractNestedJoins } from '../parser/tmdlParser.js';
import { extractUseRelationshipRefs } from '../parser/daxParser.js';

/**
 * Create a graph node.
 * @param {string} id - Unique node identifier.
 * @param {string} name - Display name.
 * @param {string} type - Node type (from NODE_TYPES).
 * @param {object} [metadata={}] - Additional metadata.
 * @returns {GraphNode}
 */
export function createNode(id, name, type, metadata = {}) {
  return { id, name, type, metadata, enrichment: null };
}

/**
 * Create a graph edge.
 * @param {string} sourceId - Source node ID.
 * @param {string} targetId - Source node ID.
 * @param {string} type - Edge type (from EDGE_TYPES).
 * @param {object} [metadata] - Optional extra edge data (e.g. the visual data role
 *   a field is bound to: Values, Y-axis, Category...). Omitted when empty so
 *   existing edge-shape assertions keep passing.
 * @returns {GraphEdge}
 */
export function createEdge(sourceId, targetId, type, metadata) {
  const edge = { source: sourceId, target: targetId, type };
  if (metadata && Object.keys(metadata).length > 0) edge.metadata = metadata;
  return edge;
}

/**
 * Extract column/measure references from a DAX expression.
 * Looks for patterns like [MeasureName] and 'TableName'[ColumnName].
 * @param {string} expression - DAX expression string.
 * @param {string} currentTable - The table containing this measure.
 * @param {Map<string, object>} allNodes - All nodes created so far.
 * @returns {Array<string>} Array of referenced node IDs.
 */
function extractDaxReferences(expression, currentTable, allNodes) {
  if (!expression) return [];

  const refs = [];

  // Match 'Table Name'[Field] (quoted) or TableName[Field] (bare identifier, no word-char/dot before it)
  const qualifiedPattern = /'([^']+)'\[([^\]]+)\]|(?<![\w.])(\w+(?:\s+\w+)*)\[([^\]]+)\]/g;
  let match;
  while ((match = qualifiedPattern.exec(expression)) !== null) {
    const table = (match[1] || match[3]).trim();
    const field = (match[2] || match[4]).trim();
    // Could be a column or measure
    const colId = `column::${table}.${field}`;
    const measureId = `measure::${table}.${field}`;
    if (allNodes.has(measureId)) {
      refs.push(measureId);
    } else if (allNodes.has(colId)) {
      refs.push(colId);
    }
  }

  // Match unqualified [FieldName] (refers to same table first, then any table)
  const unqualifiedPattern = /(?<![\w'])\[([^\]]+)\]/g;
  while ((match = unqualifiedPattern.exec(expression)) !== null) {
    const field = match[1].trim();
    // Skip if already captured by qualified pattern
    const measureId = `measure::${currentTable}.${field}`;
    const colId = `column::${currentTable}.${field}`;
    if (allNodes.has(measureId) && !refs.includes(measureId)) {
      refs.push(measureId);
    } else if (allNodes.has(colId) && !refs.includes(colId)) {
      refs.push(colId);
    } else {
      // Search ALL tables for matching measures (DAX allows cross-table unqualified refs).
      // Link every candidate — if a short name is ambiguous across tables, the user
      // should see the ambiguity in the lineage tree, not have branches silently dropped.
      let found = false;
      for (const [nodeId, node] of allNodes) {
        if (node.type === 'measure' && node.name === field && nodeId !== `measure::${currentTable}.${field}`) {
          if (!refs.includes(nodeId)) {
            refs.push(nodeId);
            found = true;
          }
        }
      }
      // If no measure found, search for column across tables
      if (!found) {
        for (const [nodeId, node] of allNodes) {
          if (node.type === 'column' && node.name === field && nodeId !== `column::${currentTable}.${field}`) {
            if (!refs.includes(nodeId)) {
              refs.push(nodeId);
            }
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Resolve a field reference ({type, table, column, measure}) to its node id,
 * creating a placeholder measure/column (and placeholder table) node if the
 * field doesn't exist yet — e.g. a report was loaded without its full
 * semantic model. Shared by the "visual displays this field" and
 * "report/page/visual actively filters on this field" edge-creation paths so
 * both handle missing-model placeholders identically.
 * @param {Map<string, object>} nodes
 * @param {Array} edges
 * @param {{type: string, table: string, column: string|null, measure: string|null}} field
 * @returns {string|null} The resolved field node id, or null (e.g. field parameters, which have no single field id).
 */
function ensureFieldNode(nodes, edges, field) {
  if (field.type === 'fieldParameter') return null;

  let fieldId;
  if (field.type === 'measure' && field.table && field.measure) {
    fieldId = `measure::${field.table}.${field.measure}`;
  } else if (field.table && field.column) {
    fieldId = `column::${field.table}.${field.column}`;
  }
  if (!fieldId) return null;

  if (!nodes.has(fieldId)) {
    const placeholderName = field.measure || field.column || 'unknown';
    const placeholderType = field.type === 'measure' ? NODE_TYPES.MEASURE : NODE_TYPES.COLUMN;
    nodes.set(fieldId, createNode(fieldId, placeholderName, placeholderType, {
      table: field.table,
      placeholder: true
    }));
    const tableId = `table::${field.table}`;
    if (field.table && !nodes.has(tableId)) {
      nodes.set(tableId, createNode(tableId, field.table, NODE_TYPES.TABLE, {
        table: field.table,
        placeholder: true
      }));
    }
    if (field.table && placeholderType === NODE_TYPES.COLUMN) {
      edges.push(createEdge(fieldId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
    }
  }

  return fieldId;
}

/**
 * Build adjacency lists from edges.
 * @param {Array} edges - Graph edges.
 * @returns {{ upstream: Map<string, string[]>, downstream: Map<string, string[]> }}
 */
export function buildAdjacency(edges) {
  const upstream = new Map();
  const downstream = new Map();

  // Two nodes can be joined by more than one edge — a measure that references
  // 'Date'[Date] normally AND inside USERELATIONSHIP yields two edges for the
  // same pair. Neighbour lists are about *which* nodes are connected, not how
  // many times, so each neighbour is recorded once. Without this, downstream
  // consumers (lineage chains, trees, dependency lists) render the same column
  // several times. Insertion order is preserved.
  const seen = new Set();

  function add(map, key, value) {
    const dedupeKey = `${key}::>${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  for (const edge of edges) {
    // source depends on target for most edge types,
    // but semantically: source -> target means source references target
    // upstream of source includes target; downstream of target includes source
    add(upstream, edge.source, edge.target);
    add(downstream, edge.target, edge.source);
  }

  return { upstream, downstream };
}

/**
 * Build the complete lineage graph from parsed data.
 * @param {{ tables: Array, relationships: Array }} parsedModel - Parsed TMDL model.
 * @param {{ pages: Array, visuals: Array }} parsedReport - Parsed PBIR report.
 * @param {{ fieldParameters: Array, calculationGroups: Array }} [enrichments] - Optional enrichments.
 * @param {Array<{name: string, tablePermissions: Array}>} [roles] - Parsed RLS roles.
 * @returns {{ nodes: Map<string, object>, edges: Array, adjacency: object, stats: object }}
 */
export function buildGraph(parsedModel, parsedReport, enrichments, roles) {
  const nodes = new Map();
  const edges = [];

  // --- Create table, column, and measure nodes ---
  if (parsedModel && parsedModel.tables) {
    for (const table of parsedModel.tables) {
      const tableId = `table::${table.name}`;
      nodes.set(tableId, createNode(tableId, table.name, NODE_TYPES.TABLE, { table: table.name }));

      if (table.columns) {
        for (const col of table.columns) {
          const colId = `column::${table.name}.${col.name}`;
          nodes.set(colId, createNode(colId, col.name, NODE_TYPES.COLUMN, {
            table: table.name,
            dataType: col.dataType,
            sourceColumn: col.sourceColumn,
            expression: col.expression,
            isHidden: col.isHidden || false
          }));
          // Column belongs to table
          edges.push(createEdge(colId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
        }
      }

      // Calculated columns live in their own parsed array (a column with a DAX
      // expression), so they need their own node pass — without this they never
      // enter the graph at all and are invisible to lineage, dependents, and
      // orphan detection.
      if (table.calculatedColumns) {
        for (const col of table.calculatedColumns) {
          const colId = `column::${table.name}.${col.name}`;
          nodes.set(colId, createNode(colId, col.name, NODE_TYPES.COLUMN, {
            table: table.name,
            dataType: col.dataType,
            sourceColumn: col.sourceColumn,
            expression: col.expression,
            isCalculated: true,
            isHidden: col.isHidden || false
          }));
          edges.push(createEdge(colId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
        }
      }

      if (table.measures) {
        for (const measure of table.measures) {
          const measureId = `measure::${table.name}.${measure.name}`;
          nodes.set(measureId, createNode(measureId, measure.name, NODE_TYPES.MEASURE, {
            table: table.name,
            expression: measure.expression,
            description: measure.description || '',
            // formatString/displayFolder come from parseMeasureProperties and are
            // surfaced in the Dependencies strip header.
            formatString: measure.formatString || '',
            displayFolder: measure.displayFolder || '',
            isHidden: measure.isHidden || false
          }));
        }
      }
    }

    // --- Parse DAX references for measures (second pass, after all nodes exist) ---
    for (const table of parsedModel.tables) {
      if (table.measures) {
        for (const measure of table.measures) {
          const measureId = `measure::${table.name}.${measure.name}`;
          const refs = extractDaxReferences(measure.expression, table.name, nodes);
          for (const refId of refs) {
            if (refId === measureId) continue; // skip self-reference
            const refNode = nodes.get(refId);
            if (refNode) {
              const edgeType = refNode.type === NODE_TYPES.MEASURE
                ? EDGE_TYPES.MEASURE_TO_MEASURE
                : EDGE_TYPES.MEASURE_TO_COLUMN;
              edges.push(createEdge(measureId, refId, edgeType));
            }
          }

          // Extract USERELATIONSHIP references — both columns are part of lineage
          const urRefs = extractUseRelationshipRefs(measure.expression || '');
          for (const ur of urRefs) {
            const fromColId = `column::${ur.fromTable}.${ur.fromColumn}`;
            const toColId = `column::${ur.toTable}.${ur.toColumn}`;
            if (nodes.has(fromColId)) {
              edges.push(createEdge(measureId, fromColId, EDGE_TYPES.MEASURE_TO_USERELATIONSHIP));
            }
            if (nodes.has(toColId)) {
              edges.push(createEdge(measureId, toColId, EDGE_TYPES.MEASURE_TO_USERELATIONSHIP));
            }
          }
        }
      }

      // Also parse calculated column expressions. The TMDL parser routes any
      // column that has a DAX expression into `calculatedColumns`, so both
      // arrays are scanned here — checking only `table.columns` would never
      // match anything.
      for (const col of [...(table.calculatedColumns || []), ...(table.columns || [])]) {
        if (!col.expression) continue;
        const colId = `column::${table.name}.${col.name}`;
        const refs = extractDaxReferences(col.expression, table.name, nodes);
        for (const refId of refs) {
          if (refId === colId) continue;
          if (nodes.has(refId)) {
            const refNode = nodes.get(refId);
            const edgeType = refNode.type === NODE_TYPES.MEASURE
              ? EDGE_TYPES.CALC_COLUMN_TO_MEASURE
              : EDGE_TYPES.CALC_COLUMN_TO_COLUMN;
            edges.push(createEdge(colId, refId, edgeType));
          }
        }
      }
    }

    // --- Table relationships ---
    if (parsedModel.relationships) {
      for (const rel of parsedModel.relationships) {
        const fromTable = `table::${rel.fromTable}`;
        const toTable = `table::${rel.toTable}`;
        if (nodes.has(fromTable) && nodes.has(toTable)) {
          edges.push(createEdge(fromTable, toTable, EDGE_TYPES.TABLE_RELATIONSHIP));
        }
      }
    }

    // --- Row-level security roles ---
    // A role's tablePermission filter is DAX, so it can reference measures and
    // columns. Those references are real usage: a measure used only by RLS is
    // in use even though no visual displays it. Runs after the model nodes
    // exist so the DAX references resolve to real ids.
    if (roles && roles.length > 0) {
      for (const role of roles) {
        const roleId = `role::${role.name}`;
        nodes.set(roleId, createNode(roleId, role.name, NODE_TYPES.ROLE, {
          modelPermission: role.modelPermission || '',
          tablePermissions: (role.tablePermissions || []).map(tp => tp.table),
        }));

        for (const tp of (role.tablePermissions || [])) {
          if (!tp.expression) continue;
          const refs = extractDaxReferences(tp.expression, tp.table, nodes);
          for (const refId of refs) {
            if (nodes.has(refId)) {
              edges.push(createEdge(roleId, refId, EDGE_TYPES.RLS_TO_FIELD, { table: tp.table }));
            }
          }
        }
      }
    }

    // --- Build parameter map for PQ expression substitution ---
    const pqParameters = parsedModel.parameters || new Map();

    /**
     * Substitute known PQ parameters in an M expression string.
     * Replaces parameter identifiers (not in quotes) with their resolved values.
     */
    function resolveParameters(mExpr) {
      if (!mExpr || pqParameters.size === 0) return mExpr;
      let resolved = mExpr;
      for (const [paramName, paramValue] of pqParameters) {
        // Replace parameter name as a standalone identifier (not inside quotes)
        const paramRegex = new RegExp(`(?<![\\w"'])\\b${paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?![\\w"'])`, 'g');
        resolved = resolved.replace(paramRegex, `"${paramValue}"`);
      }
      return resolved;
    }

    // --- Create expression nodes from expressions.tmdl ---
    const expressionMap = new Map();
    if (parsedModel.expressions) {
      for (const expr of parsedModel.expressions) {
        if (expr.kind === 'expression') {
          const exprId = `expression::${expr.name}`;
          nodes.set(exprId, createNode(exprId, expr.name, NODE_TYPES.EXPRESSION, {
            mExpression: expr.mExpression,
          }));
          // Only add non-parameter expressions to the map used for partition linking
          expressionMap.set(expr.name, expr);

          // Try to extract data source from the expression
          const resolvedExpr = resolveParameters(expr.mExpression);
          const ds = extractMDataSource(resolvedExpr);
          if (ds) {
            const sourceKey = ds.database
              ? `${(ds.server || '').toLowerCase()}/${ds.database}`
              : (ds.server || '').toLowerCase();
            if (sourceKey) {
              const sourceId = `source::${sourceKey}`;
              if (!nodes.has(sourceId)) {
                const displayName = ds.database || ds.server || sourceKey;
                nodes.set(sourceId, createNode(sourceId, displayName, NODE_TYPES.SOURCE, {
                  server: ds.server,
                  database: ds.database,
                  sourceType: ds.type
                }));
              }
              edges.push(createEdge(exprId, sourceId, EDGE_TYPES.EXPRESSION_TO_SOURCE));
            }
            // Store source info on the expression node
            const exprNode = nodes.get(exprId);
            if (exprNode) {
              exprNode.metadata.dataSource = ds;
            }
          }
        }
      }
    }

    // --- Create source nodes from partition M expressions ---
    const sourceNodeCache = new Map();
    for (const table of parsedModel.tables) {
      // Collect source expressions: from partitions, or from refreshPolicy
      const sourceExpressions = [];
      for (const partition of (table.partitions || [])) {
        if (partition.sourceExpression) {
          sourceExpressions.push(partition);
        }
      }
      // Fallback to refreshPolicy source if no partition source found
      if (sourceExpressions.length === 0 && table.refreshPolicySource) {
        sourceExpressions.push({ sourceExpression: table.refreshPolicySource, mode: 'import' });
      }

      for (const partition of sourceExpressions) {
        if (!partition.sourceExpression) continue;
        const resolvedExpr = resolveParameters(partition.sourceExpression);
        const ds = extractMDataSource(resolvedExpr);

        // Check if partition references a named expression from expressions.tmdl
        // Could be a simple reference like "expr_name" or M code like "let Source = expr_name in ..."
        const trimmedSource = partition.sourceExpression.trim();
        let linkedExprName = null;
        let linkedExpr = null;

        // Pattern 1: Entire source is a single expression name
        const simpleRefMatch = trimmedSource.match(/^(\w+)$/);
        if (simpleRefMatch && expressionMap.has(simpleRefMatch[1])) {
          linkedExprName = simpleRefMatch[1];
          linkedExpr = expressionMap.get(linkedExprName);
        }

        // Pattern 2: M code references a known expression (e.g., let Source = expr_name)
        // Prefer expressions used in Source= assignment; skip parameter expressions
        if (!linkedExpr) {
          let fallbackExprName = null;
          let fallbackExpr = null;
          for (const [exprName, exprObj] of expressionMap) {
            // Skip parameter-kind expressions (RangeStart, RangeEnd, etc.)
            if (exprObj.kind === 'parameter') continue;
            // Match as a standalone identifier (not inside quotes)
            const escaped = exprName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const refRegex = new RegExp('(?<!["\'\'\\w])' + escaped + '(?!["\'\'\\w])');
            if (refRegex.test(trimmedSource)) {
              // Prefer Source= or := assignment pattern
              const assignRegex = new RegExp('(?:Source\\s*=|:=)\\s*' + escaped + '\\b');
              if (assignRegex.test(trimmedSource)) {
                linkedExprName = exprName;
                linkedExpr = exprObj;
                break;
              }
              // Keep as fallback if no assignment match yet
              if (!fallbackExprName) {
                fallbackExprName = exprName;
                fallbackExpr = exprObj;
              }
            }
          }
          if (!linkedExpr && fallbackExprName) {
            linkedExprName = fallbackExprName;
            linkedExpr = fallbackExpr;
          }
        }

        // If no direct data source, try to resolve from the linked expression
        let effectiveDs = ds;
        let effectiveExpr = resolvedExpr;
        if (!effectiveDs && linkedExpr) {
          effectiveExpr = resolveParameters(linkedExpr.mExpression);
          effectiveDs = extractMDataSource(effectiveExpr);
        }

        if (effectiveDs) {
          // Build deduplicated source key
          const sourceKey = effectiveDs.database
            ? `${(effectiveDs.server || '').toLowerCase()}/${effectiveDs.database}`
            : (effectiveDs.server || '').toLowerCase();
          if (sourceKey) {
            const sourceId = `source::${sourceKey}`;
            if (!sourceNodeCache.has(sourceId)) {
              const displayName = effectiveDs.database || effectiveDs.server || sourceKey;
              nodes.set(sourceId, createNode(sourceId, displayName, NODE_TYPES.SOURCE, {
                server: effectiveDs.server,
                database: effectiveDs.database,
                sourceType: effectiveDs.type
              }));
              sourceNodeCache.set(sourceId, true);
            }

            // Edge: table -> source
            const tableId = `table::${table.name}`;
            edges.push(createEdge(tableId, sourceId, EDGE_TYPES.TABLE_TO_SOURCE));

            // Store source metadata on the table node
            const tableNode = nodes.get(tableId);
            if (tableNode) {
              tableNode.metadata.dataSource = {
                server: effectiveDs.server,
                database: effectiveDs.database,
                schema: effectiveDs.schema,
                sourceTable: effectiveDs.sourceTable,
                sourceType: effectiveDs.type,
                mode: partition.mode
              };

              // Extract column rename mappings from the M expression
              // Try from partition source first, then from the linked expression
              let renameMap = extractRenameColumns(resolvedExpr);
              if (renameMap.size === 0 && effectiveExpr !== resolvedExpr) {
                renameMap = extractRenameColumns(effectiveExpr);
              }
              if (renameMap.size > 0) {
                tableNode.metadata.renameMap = Object.fromEntries(renameMap);
              }
            }
          }
        }

        // Create TABLE_TO_EXPRESSION edge for named expression references
        if (linkedExprName && linkedExpr) {
          const exprId = `expression::${linkedExprName}`;
          if (nodes.has(exprId)) {
            edges.push(createEdge(`table::${table.name}`, exprId, EDGE_TYPES.TABLE_TO_EXPRESSION));
          }
        }

        // Create TABLE_TO_TABLE_JOIN edges for M-level joins — these are real lineage:
        // the right-hand table's rows flow into this table's result set.
        // Only emit when the target resolves to a known user-table node (skip step refs).
        const joinSources = [resolvedExpr];
        if (effectiveExpr && effectiveExpr !== resolvedExpr) joinSources.push(effectiveExpr);
        const seenJoins = new Set();
        for (const expr of joinSources) {
          for (const joinedName of extractNestedJoins(expr)) {
            const targetId = `table::${joinedName}`;
            if (!seenJoins.has(targetId) && nodes.has(targetId) && targetId !== `table::${table.name}`) {
              edges.push(createEdge(`table::${table.name}`, targetId, EDGE_TYPES.TABLE_TO_TABLE_JOIN));
              seenJoins.add(targetId);
            }
          }
        }
      }
    }
  }

  // --- Column-level source mapping ---
  // For each column, determine the original source column name using rename maps
  if (parsedModel && parsedModel.tables) {
    for (const table of parsedModel.tables) {
      const tableId = `table::${table.name}`;
      const tableNode = nodes.get(tableId);

      // Get data source from the table directly, or from a linked expression node
      let ds = tableNode?.metadata?.dataSource;
      let renameMap = tableNode?.metadata?.renameMap || {};

      if (!ds || Object.keys(renameMap).length === 0) {
        // Check if table links to an expression node that has data source info or rename maps
        const tableUp = (function buildAdj() {
          const up = [];
          for (const edge of edges) {
            if (edge.source === tableId && (edge.type === EDGE_TYPES.TABLE_TO_EXPRESSION || edge.type === EDGE_TYPES.TABLE_TO_SOURCE)) {
              up.push(edge.target);
            }
          }
          return up;
        })();
        for (const upId of tableUp) {
          const upNode = nodes.get(upId);
          if (!ds && upNode?.metadata?.dataSource) {
            ds = upNode.metadata.dataSource;
          }
          // Also extract rename map from expression M code if not already found
          if (Object.keys(renameMap).length === 0 && upNode?.type === 'expression' && upNode.metadata?.mExpression) {
            const exprRenames = extractRenameColumns(upNode.metadata.mExpression);
            if (exprRenames.size > 0) {
              renameMap = Object.fromEntries(exprRenames);
            }
          }
        }
      }

      if (!ds) continue;

      for (const col of (table.columns || [])) {
        const colId = `column::${table.name}.${col.name}`;
        const colNode = nodes.get(colId);
        if (!colNode) continue;

        // Determine the original source column name
        const sourceCol = col.sourceColumn || col.name;
        // Check if sourceColumn was renamed from an original name
        const originalCol = renameMap[sourceCol] || sourceCol;

        colNode.metadata.sourceColumn = sourceCol;
        colNode.metadata.originalSourceColumn = originalCol;
        colNode.metadata.wasRenamed = originalCol !== sourceCol;
        // Store the full source path if available
        if (ds.sourceTable) {
          const fullTable = ds.schema
            ? `${ds.schema}.${ds.sourceTable}`
            : ds.sourceTable;
          const fullTableWithDb = ds.database
            ? `${ds.database}.${fullTable}`
            : fullTable;
          colNode.metadata.sourceTableFull = `${fullTableWithDb}.${originalCol}`;
          colNode.metadata.sourceTablePath = fullTableWithDb;
        }
      }
    }
  }

  // --- Create page and visual nodes ---
  if (parsedReport) {
    if (parsedReport.pages) {
      for (const page of parsedReport.pages) {
        const pageId = `page::${page.id}`;
        nodes.set(pageId, createNode(pageId, page.name, NODE_TYPES.PAGE, {
          pageId: page.id,
          width: page.width || 1280,
          height: page.height || 720,
          ordinal: page.order ?? 0,
        }));
      }
    }

    if (parsedReport.visuals) {
      for (const visual of parsedReport.visuals) {
        const visualId = `visual::${visual.pageId}/${visual.id}`;
        nodes.set(visualId, createNode(visualId, visual.title || visual.visualType, NODE_TYPES.VISUAL, {
          visualType: visual.visualType,
          pageId: visual.pageId,
          title: visual.title || '',
          position: visual.position || null,
          isHidden: visual.isHidden || false,
          parentGroupName: visual.parentGroupName || null,
        }));

        // Visual belongs to page
        const pageId = `page::${visual.pageId}`;
        if (nodes.has(pageId)) {
          edges.push(createEdge(visualId, pageId, EDGE_TYPES.VISUAL_TO_PAGE));
        }

        // Store page name on visual metadata for display
        const pageNode = nodes.get(pageId);
        if (pageNode) {
          const vNode = nodes.get(visualId);
          if (vNode) vNode.metadata.pageName = pageNode.name;
        }

        // Visual references fields
        if (visual.fields) {
          for (const field of visual.fields) {
            let fieldId;
            if (field.type === 'fieldParameter' && field.table) {
              // Field parameter reference — link visual to the FP table
              const fpTableId = `table::${field.table}`;
              if (nodes.has(fpTableId)) {
                edges.push(createEdge(visualId, fpTableId, EDGE_TYPES.VISUAL_TO_FIELD));
              }
              continue; // Don't create placeholder for FP tables
            } else if (field.type === 'measure' && field.table && field.measure) {
              fieldId = `measure::${field.table}.${field.measure}`;
            } else if (field.table && field.column) {
              fieldId = `column::${field.table}.${field.column}`;
            }
            if (fieldId) {
              // Create placeholder node if the field doesn't exist (no semantic model loaded)
              if (!nodes.has(fieldId)) {
                const placeholderName = field.measure || field.column || 'unknown';
                const placeholderType = field.type === 'measure' ? NODE_TYPES.MEASURE : NODE_TYPES.COLUMN;
                nodes.set(fieldId, createNode(fieldId, placeholderName, placeholderType, {
                  table: field.table,
                  placeholder: true
                }));
                // Also create placeholder table node if needed
                const tableId = `table::${field.table}`;
                if (field.table && !nodes.has(tableId)) {
                  nodes.set(tableId, createNode(tableId, field.table, NODE_TYPES.TABLE, {
                    table: field.table,
                    placeholder: true
                  }));
                }
                if (field.table && placeholderType === NODE_TYPES.COLUMN) {
                  edges.push(createEdge(fieldId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
                }
              }
              edges.push(createEdge(visualId, fieldId, EDGE_TYPES.VISUAL_TO_FIELD,
                field.role ? { role: field.role } : null));
            }
          }
        }

        // A visual's filter-pane reference to a field. EVERY reference is
        // recorded, with `isActive` saying whether the filter currently holds a
        // non-default value. Consumers use that flag differently on purpose:
        //   - orphan classification counts only ACTIVE filters as usage (a
        //     filter parked at its default isn't filtering anything)
        //   - the "Filters" list shows ALL of them, because knowing a measure
        //     sits in a filter pane at all is what users are looking for
        for (const filterRef of (visual.filters || [])) {
          const fieldId = ensureFieldNode(nodes, edges, filterRef);
          if (fieldId) {
            edges.push(createEdge(visualId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
              isActive: filterRef.isActive === true,
              scope: 'visual',
              ownerName: visual.title || visual.visualType || visual.id,
              filterName: filterRef.name || '',
            }));
          }
        }
      }
    }

    // Page-level filters — modeled as the page depending on the field, which
    // (via the existing visual->page edges) transitively makes every visual on
    // that page a consumer, matching how a page filter really behaves.
    for (const page of (parsedReport.pages || [])) {
      const pageId = `page::${page.id}`;
      if (!nodes.has(pageId)) continue;
      for (const filterRef of (page.filters || [])) {
        const fieldId = ensureFieldNode(nodes, edges, filterRef);
        if (fieldId) {
          edges.push(createEdge(pageId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
            isActive: filterRef.isActive === true,
            scope: 'page',
            ownerName: page.displayName || page.name || page.id,
            filterName: filterRef.name || '',
          }));
        }
      }
    }

    // Report-level filters apply to every page (and therefore every visual), so
    // they're wired to each page node. Tagged scope:'report' so the UI can say
    // "report filter" rather than naming each page.
    for (const filterRef of (parsedReport.reportFilters || [])) {
      const fieldId = ensureFieldNode(nodes, edges, filterRef);
      if (!fieldId) continue;
      for (const page of (parsedReport.pages || [])) {
        const pageId = `page::${page.id}`;
        if (nodes.has(pageId)) {
          edges.push(createEdge(pageId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
            isActive: filterRef.isActive === true,
            scope: 'report',
            ownerName: 'Report',
            filterName: filterRef.name || '',
          }));
        }
      }
    }
  }

  // --- Apply enrichments ---
  if (enrichments) {
    if (enrichments.fieldParameters) {
      for (const fp of enrichments.fieldParameters) {
        // Apply enrichment to the field parameter table node
        const tableId = `table::${fp.tableName}`;
        const tableNode = nodes.get(tableId);
        if (tableNode) {
          tableNode.enrichment = { type: 'field_parameter', data: fp };
        }

        // Create edges from field parameter table to each referenced field
        // and store display name mapping on the FP table node
        const refPattern = /'([^']+)'\[([^\]]+)\]/;
        const fpDisplayNames = {};
        for (const field of (fp.fields || [])) {
          const refMatch = field.reference?.match(refPattern);
          if (!refMatch) continue;
          const refTable = refMatch[1];
          const refField = refMatch[2];
          const colId = `column::${refTable}.${refField}`;
          const measureId = `measure::${refTable}.${refField}`;
          const targetId = nodes.has(measureId) ? measureId : (nodes.has(colId) ? colId : null);
          if (targetId) {
            edges.push(createEdge(tableId, targetId, EDGE_TYPES.FIELD_PARAM_TO_FIELD));
            if (field.displayName) {
              fpDisplayNames[targetId] = field.displayName;
            }
          }
        }
        if (tableNode && Object.keys(fpDisplayNames).length > 0) {
          tableNode.metadata.fpDisplayNames = fpDisplayNames;
        }
      }
    }
    if (enrichments.calculationGroups) {
      for (const cg of enrichments.calculationGroups) {
        const nodeId = `table::${cg.tableName}`;
        const node = nodes.get(nodeId);
        if (node) {
          node.enrichment = { type: 'calculation_group', data: cg };
        }
      }
    }
  }

  const adjacency = buildAdjacency(edges);
  const graph = { nodes, edges, adjacency };
  // Relationship key columns are carried through so column-orphan detection can
  // treat them as used — relationships are table-level edges, so the column
  // participation isn't recoverable from the graph alone. Stored as resolved
  // node ids so workspace namespacing can remap them like any other id.
  if (parsedModel?.relationships) {
    const relCols = new Set();
    for (const rel of parsedModel.relationships) {
      if (rel.fromTable && rel.fromColumn) relCols.add(`column::${rel.fromTable}.${rel.fromColumn}`);
      if (rel.toTable && rel.toColumn) relCols.add(`column::${rel.toTable}.${rel.toColumn}`);
    }
    graph.relationshipColumnIds = [...relCols];
  }
  graph.stats = computeStats(graph);

  return graph;
}

/** Orphan categories, ordered least to most severe. */
export const ORPHAN_CATEGORIES = {
  /** Reaches at least one visual — genuinely in use, not an orphan. */
  NONE: 'none',
  /**
   * Reaches no visual, but does reach an active filter or an RLS role. It IS
   * doing work, just nothing a report renders — safe to keep, risky to delete.
   */
  FILTER_SECURITY: 'filterSecurity',
  /**
   * Reaches no visual, filter, or RLS role, but other measures/calculated
   * columns still reference it. Wired into the model, yet nothing surfaces it.
   */
  VISUAL: 'visual',
  /** Reaches nothing and nothing references it — completely disconnected. */
  TRUE: 'true',
};

/**
 * Classify how (or whether) a measure is actually used.
 *
 * Walks the full transitive downstream (consumer) chain and records what kinds
 * of endpoint it reaches, then buckets the measure:
 *
 *   reaches a visual                            -> NONE (in use)
 *   reaches only an active filter / RLS role     -> FILTER_SECURITY
 *   reaches neither, but has dependents          -> VISUAL
 *   reaches nothing, no dependents               -> TRUE
 *
 * "Reaches a filter" means an active (non-default) report/page/visual filter,
 * since a filter parked at its default value isn't filtering anything.
 *
 * This is the single source of truth for orphan status; computeStats(),
 * findOrphans(), the Measures list, and Model Health all defer to it so every
 * count and list in the UI agrees.
 *
 * @param {string} measureId
 * @param {{ nodes: Map, adjacency: { downstream: Map } }} graph
 * @returns {{ category: string, reachesVisual: boolean, reachesFilter: boolean, reachesRls: boolean, dependentCount: number }}
 */
export function classifyMeasureUsage(measureId, graph, typedDownstream) {
  const consumers = typedDownstream || buildTypedDownstream(graph.edges || []);

  let reachesVisual = false;
  let reachesFilter = false;
  let reachesRls = false;
  let dependentCount = 0;

  const visited = new Set([measureId]);
  const queue = [measureId];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const { id: consumerId, type: edgeType, metadata } of (consumers.get(current) || [])) {
      // Filter and RLS references are terminal: they tell us the measure is
      // used for filtering/security, but they must NOT be traversed onward.
      // A page-level filter edge would otherwise let us walk page -> visuals
      // and wrongly conclude the measure is displayed on a visual.
      if (edgeType === EDGE_TYPES.FILTER_TO_FIELD) {
        // Only an APPLIED filter counts as usage. Every filter-pane reference
        // is now recorded as an edge (so the UI can list them), so an
        // unapplied one must be ignored here or nothing would ever be an orphan.
        if (metadata?.isActive) reachesFilter = true;
        continue;
      }
      if (edgeType === EDGE_TYPES.RLS_TO_FIELD) {
        reachesRls = true;
        continue;
      }

      // Dependents are real model references — measures and calculated columns
      // that name this measure. Filter/RLS edges are deliberately excluded, so
      // "has dependents" means "something in the model depends on it".
      if (current === measureId) dependentCount++;

      if (visited.has(consumerId)) continue;
      visited.add(consumerId);

      const consumer = graph.nodes.get(consumerId);
      if (!consumer) continue;

      if (consumer.type === NODE_TYPES.VISUAL) {
        // Displayed on a visual via a real field binding — genuinely in use.
        reachesVisual = true;
        continue; // no need to walk visual -> page
      }
      if (consumer.type === NODE_TYPES.ROLE) {
        reachesRls = true;
        continue;
      }
      queue.push(consumerId);
    }
  }

  let category;
  if (reachesVisual) category = ORPHAN_CATEGORIES.NONE;
  else if (reachesFilter || reachesRls) category = ORPHAN_CATEGORIES.FILTER_SECURITY;
  else if (dependentCount > 0) category = ORPHAN_CATEGORIES.VISUAL;
  else category = ORPHAN_CATEGORIES.TRUE;

  return { category, reachesVisual, reachesFilter, reachesRls, dependentCount };
}

/**
 * Index edges as target -> [{ id: consumerId, type: edgeType }].
 *
 * Orphan classification has to distinguish "displayed on a visual" from
 * "referenced by a filter or RLS role", which the plain adjacency lists can't
 * express since they drop edge types. Built once and passed into
 * classifyMeasureUsage so a whole-model sweep stays O(V + E) rather than
 * re-scanning every edge per measure.
 *
 * @param {Array} edges
 * @returns {Map<string, Array<{id: string, type: string}>>}
 */
export function buildTypedDownstream(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.target)) map.set(edge.target, []);
    // metadata is carried through because classification needs the filter
    // edge's `isActive` flag to tell an applied filter from an idle one.
    map.get(edge.target).push({ id: edge.source, type: edge.type, metadata: edge.metadata });
  }
  return map;
}

/**
 * Back-compat boolean: true when the measure reaches no visual at all (i.e. it
 * falls in any of the three orphan categories).
 * @param {string} measureId
 * @param {{ nodes: Map, adjacency: { downstream: Map } }} graph
 * @returns {boolean}
 */
export function isMeasureOrphan(measureId, graph) {
  return classifyMeasureUsage(measureId, graph).category !== ORPHAN_CATEGORIES.NONE;
}

/**
 * Find unused columns/fields, using the strictest ("true orphan") rule: nothing
 * at all references the column — no measure, calculated column, visual, active
 * filter, RLS role, field parameter, or USERELATIONSHIP.
 *
 * Deliberately kept separate from measure orphans: an unused column is a
 * modelling/refresh-cost concern, whereas an unused measure is a maintenance
 * concern, and conflating the two lists makes both harder to act on.
 *
 * A column's own `column_to_table` and `column_to_source_column` edges point
 * away from it (the column depends on those), so they never appear in its
 * consumer list and can't mask a genuinely unused column.
 *
 * @param {{ nodes: Map, adjacency: { downstream: Map } }} graph
 * @returns {Array<{ id: string, name: string, table: string, dataType: string, isCalculated: boolean, isHidden: boolean }>}
 */
export function findColumnOrphans(graph) {
  const downstream = graph.adjacency ? graph.adjacency.downstream : new Map();
  const orphans = [];

  // Columns on either side of a relationship are in use by definition, but
  // relationships are modelled as table-to-table edges so that usage never
  // shows up in a column's consumer list (see buildGraph).
  const relationshipColumns = new Set(graph.relationshipColumnIds || []);

  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.COLUMN) continue;
    if (node.metadata?.placeholder) continue;
    if (relationshipColumns.has(node.id)) continue;

    const consumers = downstream.get(node.id) || [];
    // Only count consumers that represent real usage.
    const used = consumers.some(id => {
      const c = graph.nodes.get(id);
      if (!c) return false;
      return c.type === NODE_TYPES.MEASURE
        || c.type === NODE_TYPES.VISUAL
        || c.type === NODE_TYPES.PAGE
        || c.type === NODE_TYPES.ROLE
        || c.type === NODE_TYPES.TABLE   // field-parameter table referencing the column
        || (c.type === NODE_TYPES.COLUMN && !!c.metadata?.expression); // calculated column
    });
    if (used) continue;

    orphans.push({
      id: node.id,
      name: node.name,
      table: node.metadata?.table || '',
      dataType: node.metadata?.dataType || '',
      isCalculated: !!node.metadata?.isCalculated,
      isHidden: !!node.metadata?.isHidden,
    });
  }

  orphans.sort((a, b) => (a.table + '.' + a.name).localeCompare(b.table + '.' + b.name));
  return orphans;
}

/**
 * Compute graph statistics.
 * @param {{ nodes: Map, edges: Array }} graph
 * @returns {{ tables: number, columns: number, measures: number, visuals: number, pages: number, edges: number, orphanedMeasures: number }}
 */
export function computeStats(graph) {
  const counts = { tables: 0, columns: 0, measures: 0, visuals: 0, pages: 0, sources: 0, expressions: 0 };

  for (const node of graph.nodes.values()) {
    switch (node.type) {
      case NODE_TYPES.TABLE: counts.tables++; break;
      case NODE_TYPES.COLUMN: counts.columns++; break;
      case NODE_TYPES.MEASURE: counts.measures++; break;
      case NODE_TYPES.VISUAL: counts.visuals++; break;
      case NODE_TYPES.PAGE: counts.pages++; break;
      case NODE_TYPES.SOURCE: counts.sources++; break;
      case NODE_TYPES.EXPRESSION: counts.expressions++; break;
    }
  }

  // Orphaned measures, split by how they're (not) used — see
  // classifyMeasureUsage. `orphanedMeasures` stays the total across all three
  // categories so existing callers keep working.
  let orphanedMeasures = 0;
  const orphanBreakdown = { filterSecurity: 0, visual: 0, true: 0 };
  const typedDownstream = buildTypedDownstream(graph.edges || []);
  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.MEASURE) continue;
    const { category } = classifyMeasureUsage(node.id, graph, typedDownstream);
    if (category === ORPHAN_CATEGORIES.NONE) continue;
    orphanedMeasures++;
    orphanBreakdown[category]++;
  }

  const orphanedColumns = findColumnOrphans(graph).length;

  return {
    tables: counts.tables,
    columns: counts.columns,
    measures: counts.measures,
    visuals: counts.visuals,
    pages: counts.pages,
    sources: counts.sources,
    edges: graph.edges.length,
    orphanedMeasures,
    orphanBreakdown,
    orphanedColumns
  };
}

// --- Multi-report workspace support ---
//
// A "workspace" is a folder holding several PBIP report saves that mostly —
// but not necessarily all — point at the same semantic model (the normal
// result of saving multiple Power BI reports as PBIP into one folder). The
// functions below let analyzeWorkspace() in index.js build ONE combined graph
// out of several independently-parsed single-model / single-report graphs:
//   - namespaceGraph()     prefixes every id in a whole graph — used for any
//                          semantic model that ISN'T the workspace's primary
//                          (most-shared) one, so its tables/measures/columns
//                          can never collide with the primary model's.
//   - rescopeReportGraph() prefixes just a report's own page/visual ids (so
//                          two reports can never collide), and redirects its
//                          field references to the correctly-namespaced model
//                          id when that report uses a non-primary model.

/**
 * Prefix every node id (and every edge/metadata reference to those ids) in a
 * graph with the given string. Used to make a secondary semantic model's
 * tables/columns/measures/sources impossible to confuse with the primary
 * model's, when merging multiple models into one workspace graph.
 * @param {{ nodes: Map, edges: Array }} graph
 * @param {string} prefix
 * @returns {{ nodes: Map, edges: Array, adjacency: object, stats: object }}
 */
export function namespaceGraph(graph, prefix) {
  const remap = new Map();
  for (const id of graph.nodes.keys()) remap.set(id, `${prefix}${id}`);

  const nodes = new Map();
  for (const [id, node] of graph.nodes) {
    const newId = remap.get(id);
    let metadata = node.metadata;
    if (metadata && metadata.fpDisplayNames) {
      const fixed = {};
      for (const [k, v] of Object.entries(metadata.fpDisplayNames)) {
        fixed[remap.get(k) ?? k] = v;
      }
      metadata = { ...metadata, fpDisplayNames: fixed };
    }
    nodes.set(newId, { ...node, id: newId, metadata });
  }

  const edges = graph.edges.map(e => ({
    ...e,
    source: remap.get(e.source) ?? e.source,
    target: remap.get(e.target) ?? e.target,
  }));

  const adjacency = buildAdjacency(edges);
  const namespaced = { nodes, edges, adjacency };
  // Relationship key column ids are plain node ids, so they namespace the same
  // way every other id does.
  if (graph.relationshipColumnIds) {
    namespaced.relationshipColumnIds = graph.relationshipColumnIds.map(id => remap.get(id) ?? id);
  }
  namespaced.stats = computeStats(namespaced);
  return namespaced;
}

/**
 * Rescope a single report's graph (as produced by buildGraph(null, report,
 * null) — a report parsed with no semantic model attached, so every
 * measure/column/table it touches is a placeholder) for merging into a
 * multi-report workspace graph:
 *   - every page:: / visual:: id gets a report-scoped suffix, so the same
 *     page/visual id in two different reports never collides.
 *   - every measure:: / column:: / table:: id (i.e. every *field* reference —
 *     from displayed fields, filter panes, or field-parameter tables) gets
 *     fieldPrefix prepended, so it lines up with the real node id already
 *     produced for that model by namespaceGraph() when this report doesn't
 *     use the workspace's primary model. fieldPrefix is '' for reports on the
 *     primary model, which keeps ids byte-identical to today's single-report
 *     scheme — zero behavior change for the common "one shared model" case.
 * @param {{ nodes: Map, edges: Array }} reportGraph
 * @param {{ reportKey: string, reportName: string, fieldPrefix: string }} opts
 * @returns {{ nodes: Map, edges: Array }}
 */
export function rescopeReportGraph(reportGraph, { reportKey, reportName, fieldPrefix = '' }) {
  const reportSuffix = `§report:${reportKey}`;

  function remapId(id) {
    if (id.startsWith('page::') || id.startsWith('visual::')) {
      return `${id}${reportSuffix}`;
    }
    if (fieldPrefix && (id.startsWith('measure::') || id.startsWith('column::') || id.startsWith('table::'))) {
      return `${fieldPrefix}${id}`;
    }
    return id;
  }

  const nodes = new Map();
  for (const [id, node] of reportGraph.nodes) {
    const newId = remapId(id);
    const isReportScoped = newId !== id && (id.startsWith('page::') || id.startsWith('visual::'));
    const metadata = isReportScoped ? { ...node.metadata, reportKey, reportName } : node.metadata;
    nodes.set(newId, newId === id ? node : { ...node, id: newId, metadata });
  }

  const edges = reportGraph.edges.map(e => ({
    ...e,
    source: remapId(e.source),
    target: remapId(e.target),
  }));

  return { nodes, edges };
}
