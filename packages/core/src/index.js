/**
 * @pbip-lineage/core - Core lineage analysis engine for Power BI PBIP projects.
 *
 * Platform-independent: works in Node.js, VS Code, and browsers.
 * Provide a Map<string, string> of file paths to contents, and get back
 * a fully-traced lineage graph.
 */

// Parsers
import { parseTmdlModel, parseExpressions, extractMDataSource, extractRenameColumns, extractNestedJoins } from './parser/tmdlParser.js';
import { parseDaxExpression, extractColumnRefs, extractMeasureRefs, extractTableRefs, extractUseRelationshipRefs } from './parser/daxParser.js';
import { parsePbirReport } from './parser/pbirParser.js';
import { parseRoles } from './parser/roleParser.js';
import { detectEnrichments, applyEnrichments } from './parser/enrichment.js';
import { identifyProjectStructure, findDefinitionPbir, parseSemanticModelReference, isRelevantFile, RELEVANT_EXTENSIONS } from './parser/projectStructure.js';

// Graph
import { buildGraph, computeStats, createNode, createEdge, buildAdjacency, isMeasureOrphan, classifyMeasureUsage, buildTypedDownstream, findColumnOrphans, ORPHAN_CATEGORIES, namespaceGraph, rescopeReportGraph } from './graph/graphBuilder.js';
import { traceMeasureLineage, traceVisualLineage } from './graph/lineageTracer.js';
import { analyzeImpact, findOrphans, findOrphansByCategory, exportImpactReport, getUpstream, getDownstream, getDirectDependencies } from './graph/impactAnalysis.js';
import { buildDependencyStripData, buildMeasureSummaryRows, getFieldFilterUsage } from './graph/dependencyStrip.js';

// Constants
import { NODE_TYPES, EDGE_TYPES, LAYER_COLORS, ENRICHMENT_TYPES } from './utils/constants.js';

// Change Detection
import { detectChanges } from './diff/changeDetector.js';
import { CHANGE_TYPES, CHANGE_SCOPES } from './diff/changeTypes.js';
import { resolveImpact } from './diff/impactResolver.js';
import { CHANGE_TOPICS, topicForChange, changeAction, groupChangesByTopic } from './diff/changeTopics.js';
import { diffLines, collapseUnchanged } from './diff/textDiff.js';

// Version Compare (full-snapshot comparison)
import { buildSnapshot, buildModelFromStructure, describeFilterCondition, visualFields, visualLabel } from './compare/snapshot.js';
import { buildDependencyIndex, describeImpact, IMPACT_GROUPS } from './compare/dependencyImpact.js';
import { modelDiagramData, diffModelDiagram, summarizeDiagramDiff, layoutModelDiagram, cardinalityLabel, crossFilterLabel } from './compare/modelDiagram.js';
import { describeBookmarkEffect } from './compare/bookmarkEffect.js';
import { compareSnapshots, compareFileMaps, groupCompareRecords, COMPARE_GROUPS, prettyVisualType } from './compare/compareSnapshots.js';

// Re-export everything
export {
  // Parsers
  parseTmdlModel, parseExpressions, extractMDataSource, extractRenameColumns, extractNestedJoins,
  parseDaxExpression, extractColumnRefs, extractMeasureRefs, extractTableRefs, extractUseRelationshipRefs,
  parsePbirReport, parseRoles,
  detectEnrichments, applyEnrichments,
  identifyProjectStructure, findDefinitionPbir, parseSemanticModelReference, isRelevantFile, RELEVANT_EXTENSIONS,
  // Graph
  buildGraph, computeStats, createNode, createEdge, buildAdjacency, isMeasureOrphan, namespaceGraph, rescopeReportGraph,
  classifyMeasureUsage, buildTypedDownstream, findColumnOrphans, ORPHAN_CATEGORIES,
  traceMeasureLineage, traceVisualLineage,
  analyzeImpact, findOrphans, findOrphansByCategory, exportImpactReport, getUpstream, getDownstream, getDirectDependencies,
  buildDependencyStripData, buildMeasureSummaryRows, getFieldFilterUsage,
  // Constants
  NODE_TYPES, EDGE_TYPES, LAYER_COLORS, ENRICHMENT_TYPES,
  // Change Detection
  detectChanges, CHANGE_TYPES, CHANGE_SCOPES, resolveImpact,
  CHANGE_TOPICS, topicForChange, changeAction, groupChangesByTopic, diffLines, collapseUnchanged,
  // Version Compare
  buildSnapshot, compareSnapshots, compareFileMaps, groupCompareRecords, COMPARE_GROUPS,
  prettyVisualType, describeFilterCondition, visualFields, visualLabel, describeBookmarkEffect,
  buildModelFromStructure, buildDependencyIndex, describeImpact, IMPACT_GROUPS,
  modelDiagramData, diffModelDiagram, summarizeDiagramDiff, layoutModelDiagram, cardinalityLabel, crossFilterLabel,
};

/**
 * Analyze a PBIP project from pre-parsed file structures.
 * This is the main high-level API that runs the full pipeline:
 * parse model -> parse DAX -> parse report -> detect enrichments -> build graph.
 *
 * @param {object} options
 * @param {object} options.modelStructure - Output of identifyProjectStructure() for the semantic model folder.
 * @param {object} [options.reportStructure] - Output of identifyProjectStructure() for the report folder.
 * @returns {{ graph: object, stats: object, enrichments: object, model: object, report: object }}
 */
export function analyze({ modelStructure, reportStructure }) {
  // Step 1: Parse TMDL model
  const tmdlFiles = modelStructure?.tmdlFiles || [];
  const relationshipFiles = modelStructure?.relationshipFiles || [];
  const expressionFiles = modelStructure?.expressionFiles || [];
  const model = parseTmdlModel(tmdlFiles, relationshipFiles);

  // Step 2: Parse expressions
  const parsedExpressions = { expressions: [], parameters: new Map() };
  for (const { content } of expressionFiles) {
    const result = parseExpressions(content);
    parsedExpressions.expressions.push(...result.expressions);
    for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
  }
  model.expressions = parsedExpressions.expressions;
  model.parameters = parsedExpressions.parameters;

  // Step 3: Parse DAX for measures and calculated columns
  for (const table of model.tables) {
    for (const measure of (table.measures || [])) {
      if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
    }
    for (const col of (table.calculatedColumns || [])) {
      if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
    }
  }

  // Step 4: Parse report (if provided)
  const report = reportStructure
    ? parsePbirReport(reportStructure.visualFiles || [], reportStructure.pageFiles || [])
    : { visuals: [], pages: [] };

  // Step 5: Parse row-level security roles (their DAX filters count as usage)
  const roles = parseRoles(modelStructure?.roleFiles || []);
  model.roles = roles;

  // Step 6: Detect and apply enrichments
  const enrichments = detectEnrichments(model.tables);
  let graph = buildGraph(model, report, enrichments, roles);
  graph = applyEnrichments(graph, enrichments);

  // Step 7: Compute stats
  const stats = computeStats(graph);

  return { graph, stats, enrichments, model, report, roles };
}

/**
 * Analyze a PBIP project from raw file maps.
 * Convenience wrapper that handles identifyProjectStructure internally.
 *
 * @param {object} options
 * @param {Map<string, string>} options.modelFiles - Map of relative path -> content for the semantic model folder.
 * @param {Map<string, string>} [options.reportFiles] - Map of relative path -> content for the report folder.
 * @returns {{ graph: object, stats: object, enrichments: object, model: object, report: object }}
 */
export function analyzeFromFiles({ modelFiles, reportFiles }) {
  const modelStructure = identifyProjectStructure(modelFiles);
  const reportStructure = reportFiles ? identifyProjectStructure(reportFiles) : null;
  return analyze({ modelStructure, reportStructure });
}

/**
 * Analyze a multi-report "workspace" folder — several PBIP report saves that
 * mostly (but not necessarily all) point at the same semantic model, e.g.
 * saving several Power BI reports as PBIP into one folder. Produces ONE
 * combined graph so a measure change shows every report, page, and visual it
 * touches, and orphan detection considers the whole workspace at once.
 *
 * The semantic model referenced by the most reports is treated as the
 * workspace's "primary" model and keeps today's plain id scheme
 * (`measure::Table.Name`, etc.) exactly as a single-project analyze() call
 * would — so the common case (every report shares one model) behaves
 * identically to loading that one model, just with reports layered on top.
 * Any OTHER model present is namespaced so its tables/measures/columns can
 * never collide with the primary model's (or each other's).
 *
 * @param {object} options
 * @param {Array<{ reportKey: string, reportName: string, modelKey: string, reportStructure: object }>} options.reports
 *   One entry per report. `modelKey` identifies which semantic model this
 *   report resolves to — reports sharing a model MUST use the same key.
 * @param {Map<string, object>} options.modelStructureByKey - One identifyProjectStructure() output per distinct modelKey.
 * @param {string} [options.primaryModelKey] - Which modelKey to treat as primary (unprefixed). Defaults to whichever key the most reports use.
 * @returns {{ graph: object, stats: object }}
 */
export function analyzeWorkspace({ reports, modelStructureByKey, primaryModelKey }) {
  if (!primaryModelKey) {
    const counts = new Map();
    for (const r of reports) counts.set(r.modelKey, (counts.get(r.modelKey) || 0) + 1);
    let best = null, bestCount = -1;
    for (const [key, count] of counts) {
      if (count > bestCount) { best = key; bestCount = count; }
    }
    primaryModelKey = best;
  }

  // Step 1: parse + build each distinct semantic model exactly once, applying
  // the SAME pipeline as analyze() (TMDL -> expressions -> DAX -> enrichments
  // -> graph). Namespace every model except the primary.
  const modelGraphByKey = new Map();
  for (const [modelKey, modelStructure] of modelStructureByKey) {
    const tmdlFiles = modelStructure?.tmdlFiles || [];
    const relationshipFiles = modelStructure?.relationshipFiles || [];
    const expressionFiles = modelStructure?.expressionFiles || [];
    const model = parseTmdlModel(tmdlFiles, relationshipFiles);

    const parsedExpressions = { expressions: [], parameters: new Map() };
    for (const { content } of expressionFiles) {
      const result = parseExpressions(content);
      parsedExpressions.expressions.push(...result.expressions);
      for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
    }
    model.expressions = parsedExpressions.expressions;
    model.parameters = parsedExpressions.parameters;

    for (const table of model.tables) {
      for (const measure of (table.measures || [])) {
        if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
      }
      for (const col of (table.calculatedColumns || [])) {
        if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
      }
    }

    const roles = parseRoles(modelStructure?.roleFiles || []);
    model.roles = roles;

    const enrichments = detectEnrichments(model.tables);
    let modelGraph = buildGraph(model, null, enrichments, roles);
    modelGraph = applyEnrichments(modelGraph, enrichments);
    if (modelKey !== primaryModelKey) {
      modelGraph = namespaceGraph(modelGraph, `model:${modelKey}§`);
    }
    modelGraphByKey.set(modelKey, modelGraph);
  }

  // Step 2: merge every model's nodes/edges into one combined base.
  const combinedNodes = new Map();
  const combinedEdges = [];
  const combinedRelColumnIds = new Set();
  for (const modelGraph of modelGraphByKey.values()) {
    for (const [id, node] of modelGraph.nodes) combinedNodes.set(id, node);
    combinedEdges.push(...modelGraph.edges);
    for (const id of (modelGraph.relationshipColumnIds || [])) combinedRelColumnIds.add(id);
  }

  // Step 3: parse + build each report's pages/visuals (with no model
  // attached, so every field reference comes out as a placeholder id),
  // rescope it (report-scoped page/visual ids; field ids namespaced to match
  // step 1 when this report isn't on the primary model), then merge — real
  // model nodes always win over a same-id placeholder.
  const reportMeta = [];
  for (const r of reports) {
    const parsedReport = parsePbirReport(r.reportStructure?.visualFiles || [], r.reportStructure?.pageFiles || []);
    let reportGraph = buildGraph(null, parsedReport, null);

    const isPrimary = r.modelKey === primaryModelKey;
    reportGraph = rescopeReportGraph(reportGraph, {
      reportKey: r.reportKey,
      reportName: r.reportName,
      fieldPrefix: isPrimary ? '' : `model:${r.modelKey}§`,
    });

    for (const [id, node] of reportGraph.nodes) {
      const existing = combinedNodes.get(id);
      if (existing && node.metadata?.placeholder) continue; // never let a placeholder clobber a real node
      combinedNodes.set(id, node);
    }
    combinedEdges.push(...reportGraph.edges);

    reportMeta.push({ reportKey: r.reportKey, reportName: r.reportName, modelKey: r.modelKey, isPrimaryModel: isPrimary });
  }

  const adjacency = buildAdjacency(combinedEdges);
  const graph = { nodes: combinedNodes, edges: combinedEdges, adjacency };
  graph.relationshipColumnIds = [...combinedRelColumnIds];
  const stats = computeStats(graph);
  graph.stats = stats;
  graph.workspace = {
    reports: reportMeta,
    primaryModelKey,
    multiModel: modelStructureByKey.size > 1,
  };

  return { graph, stats };
}
