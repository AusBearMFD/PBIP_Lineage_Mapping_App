/**
 * Snapshot — a complete, comparison-ready picture of every PBIP project in a
 * file map (one commit of a repo, or a folder on disk).
 *
 * Unlike the change detectors in ../diff (which see only the files a commit
 * touched), a snapshot is built from ALL PBIP files, so comparing two of them
 * can see new/deleted tables, resolve page display names everywhere, and
 * check whether a deleted object is still referenced elsewhere.
 *
 * Files are grouped by their `X.SemanticModel` / `X.Report` folder, so a repo
 * holding several reports and models is handled. Paths without those folder
 * names fall back to a single unnamed model/report.
 */

import { parseTableFile, parseExpressions, extractDaxExpression, unquoteName, extractMDataSource } from '../parser/tmdlParser.js';
import { identifyProjectStructure } from '../parser/projectStructure.js';

/** Aggregation codes used by Power BI semantic queries. */
const AGGREGATIONS = ['Sum', 'Average', 'Count', 'Min', 'Max', 'Count (distinct)', 'Median', 'Standard deviation', 'Variance'];
/** Comparison operators used in filter conditions. */
const COMPARISON_OPS = ['=', '>', '>=', '<', '<='];
/** TMDL properties that are bookkeeping, not meaning — ignored when comparing. */
const IGNORED_TMDL_PROPS = new Set(['lineagetag', 'sourcelineagetag', 'annotation', 'changedproperty', 'isnameinferred', 'extendedproperty']);

/**
 * Build a snapshot from a file map.
 * @param {Map<string, string>} files - path -> text for one version of the repo/folder.
 * @returns {{ models: Map<string, object>, reports: Map<string, object> }}
 */
export function buildSnapshot(files) {
  const modelFiles = new Map();  // modelKey -> { name, files: Map }
  const reportFiles = new Map(); // reportKey -> { name, files: Map }

  for (const [path, content] of files || []) {
    const loc = locateFile(path);
    if (!loc) continue;
    const bucket = loc.kind === 'model' ? modelFiles : reportFiles;
    if (!bucket.has(loc.key)) bucket.set(loc.key, { name: loc.name, files: new Map() });
    bucket.get(loc.key).files.set(path, content);
  }

  const models = new Map();
  for (const [key, { name, files: f }] of modelFiles) {
    const model = buildModel(name, f);
    if (model) models.set(key, model);
  }
  const reports = new Map();
  for (const [key, { name, files: f }] of reportFiles) {
    const report = buildReport(name, f);
    if (report) reports.set(key, report);
  }
  return { models, reports };
}

/**
 * Decide which model/report a file belongs to.
 * @returns {{ kind: 'model'|'report', key: string, name: string }|null}
 */
export function locateFile(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  const lower = path.toLowerCase();
  const mi = parts.findIndex(p => /\.semanticmodel$/i.test(p));
  if (mi !== -1) return { kind: 'model', key: parts.slice(0, mi + 1).join('/'), name: parts[mi].replace(/\.semanticmodel$/i, '') };
  const ri = parts.findIndex(p => /\.report$/i.test(p));
  if (ri !== -1) return { kind: 'report', key: parts.slice(0, ri + 1).join('/'), name: parts[ri].replace(/\.report$/i, '') };
  // Fallback for folders that don't use the PBIP folder naming.
  if (lower.endsWith('.tmdl')) return { kind: 'model', key: '', name: '' };
  if (lower.endsWith('.json') || lower.endsWith('.pbir')) return { kind: 'report', key: '', name: '' };
  return null;
}

// --- Semantic model ----------------------------------------------------------

function buildModel(name, files) {
  return buildModelFromStructure(name, identifyProjectStructure(files));
}

/**
 * Build one semantic model's snapshot from an identifyProjectStructure()
 * result — used for the currently open project, whose files are already
 * sorted into a structure.
 */
export function buildModelFromStructure(name, structure) {
  if (!structure) return null;
  if (!structure.tmdlFiles.length && !structure.relationshipFiles.length &&
      !structure.roleFiles.length && !structure.expressionFiles.length) return null;

  const tables = new Map();
  for (const { path, content } of structure.tmdlFiles) {
    const parsed = parseTableFile(content, path);
    if (!parsed?.name) continue;
    const childProps = scanChildProperties(content);
    const table = {
      name: parsed.name,
      isCalculationGroup: !!parsed.calculationGroup,
      columns: new Map(),
      measures: new Map(),
      calcItems: new Map(),
      partitions: new Map(),
    };
    for (const col of [...parsed.columns, ...parsed.calculatedColumns]) {
      table.columns.set(col.name, {
        name: col.name,
        dataType: col.dataType || '',
        sourceColumn: col.sourceColumn || '',
        expression: col.expression || '',
        isHidden: !!col.isHidden,
        props: childProps.get(`column|${col.name}`) || {},
      });
    }
    for (const m of parsed.measures) {
      table.measures.set(m.name, {
        name: m.name,
        expression: m.expression || '',
        props: childProps.get(`measure|${m.name}`) || {},
      });
    }
    for (const ci of parsed.calculationItems || []) {
      table.calcItems.set(ci.name, { name: ci.name, expression: ci.expression || '' });
    }
    for (const p of parsed.partitions) {
      const src = extractMDataSource(p.sourceExpression || '');
      table.partitions.set(p.name, {
        name: p.name,
        type: p.type || '',
        mode: p.mode || '',
        sourceExpression: p.sourceExpression || '',
        source: describeDataSource(src),
      });
    }
    tables.set(table.name, table);
  }

  const relationships = new Map();
  for (const { content } of structure.relationshipFiles) {
    for (const rel of parseRelationshipBlocks(content)) relationships.set(rel.name, rel);
  }

  const roles = new Map();
  for (const { content } of structure.roleFiles) {
    for (const role of parseRoleBlocks(content)) roles.set(role.name, role);
  }

  const expressions = new Map();
  for (const { content } of structure.expressionFiles) {
    for (const e of parseExpressions(content).expressions) {
      expressions.set(e.name, { name: e.name, kind: e.kind, value: e.mExpression || '' });
    }
  }

  return { name, tables, relationships, roles, expressions };
}

/**
 * Collect the `key: value` properties (and bare flags such as isHidden) of
 * every column and measure in a table file. The main parser only keeps a few
 * properties; comparisons need all the meaningful ones (formatString,
 * displayFolder, summarizeBy, dataCategory, sortByColumn…).
 * @returns {Map<string, object>} "column|Name" / "measure|Name" -> props
 */
function scanChildProperties(content) {
  const out = new Map();
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = indentOf(line);
    if (indent <= 1) {
      current = null;
      const m = indent === 1 && trimmed.match(/^(column|measure)\s+(.+?)(?:\s*=.*)?$/);
      if (m) {
        current = {};
        out.set(`${m[1]}|${unquoteName(m[2].trim())}`, current);
      }
      continue;
    }
    if (!current || indent !== 2) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv) {
      if (!IGNORED_TMDL_PROPS.has(kv[1].toLowerCase())) current[kv[1]] = kv[2].trim();
    } else if (/^\w+$/.test(trimmed) && !IGNORED_TMDL_PROPS.has(trimmed.toLowerCase())) {
      current[trimmed] = 'true';
    }
  }
  return out;
}

/**
 * Parse relationship blocks keeping every property (the lineage parser keeps
 * only cross-filter direction). Defaults follow the TMDL defaults so that an
 * omitted property and its default value compare equal.
 */
export function parseRelationshipBlocks(content) {
  const rels = [];
  let current = null;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const decl = indentOf(line) === 0 && trimmed.match(/^relationship\s+(.+)$/);
    if (decl) {
      current = { name: unquoteName(decl[1].trim()), props: {} };
      rels.push(current);
      continue;
    }
    if (!current || indentOf(line) === 0) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv && !IGNORED_TMDL_PROPS.has(kv[1].toLowerCase())) current.props[kv[1]] = kv[2].trim();
    else if (/^\w+$/.test(trimmed) && !IGNORED_TMDL_PROPS.has(trimmed.toLowerCase())) current.props[trimmed] = 'true';
  }
  return rels.map(({ name, props }) => {
    const from = parseColumnRef(props.fromColumn);
    const to = parseColumnRef(props.toColumn);
    return {
      name,
      fromTable: from.table, fromColumn: from.column,
      toTable: to.table, toColumn: to.column,
      isActive: props.isActive !== 'false',
      crossFilter: props.crossFilteringBehavior || 'oneDirection',
      fromCardinality: props.fromCardinality || 'many',
      toCardinality: props.toCardinality || 'one',
      securityFilter: props.securityFilteringBehavior || 'oneDirection',
      relyOnReferentialIntegrity: props.relyOnReferentialIntegrity === 'true',
      joinOnDateBehavior: props.joinOnDateBehavior || '',
    };
  });
}

/** "Sales.ProductID", "'Sales Table'.'Product ID'" or "Sales[ProductID]" -> { table, column } */
function parseColumnRef(ref) {
  if (!ref) return { table: '', column: '' };
  const bracket = ref.match(/^(.+?)\[(.+)\]$/);
  if (bracket) return { table: unquoteName(bracket[1].trim()), column: bracket[2].trim() };
  const quoted = ref.match(/^('(?:[^']|'')+'|[^.]+)\.(.+)$/);
  if (quoted) return { table: unquoteName(quoted[1].trim()), column: unquoteName(quoted[2].trim()) };
  return { table: '', column: unquoteName(ref.trim()) };
}

/**
 * Parse RLS/OLS role blocks: model permission, members, table filters, and
 * column permissions.
 */
export function parseRoleBlocks(content) {
  const lines = content.split(/\r?\n/);
  const roles = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const indent = indentOf(line);
    const roleMatch = indent === 0 && trimmed.match(/^role\s+(.+)$/);
    if (roleMatch) {
      current = { name: unquoteName(roleMatch[1].trim()), modelPermission: '', members: [], tablePermissions: new Map(), columnPermissions: [] };
      roles.push(current);
      continue;
    }
    if (!current) continue;
    const perm = trimmed.match(/^modelPermission\s*:\s*(.+)$/);
    if (perm) { current.modelPermission = perm[1].trim(); continue; }
    const member = trimmed.match(/^member\s+(.+)$/);
    if (member) { current.members.push(unquoteName(member[1].trim())); continue; }
    const tp = trimmed.match(/^tablePermission\s+(.+?)(?:\s*=\s*(.*))?$/);
    if (tp) {
      const table = unquoteName(tp[1].trim());
      const expr = tp[2] !== undefined ? (extractDaxExpression(lines, i) || tp[2] || '').trim() : '';
      current.tablePermissions.set(table, expr);
      continue;
    }
    const cp = trimmed.match(/^columnPermission\s+(.+)$/);
    if (cp) {
      const metaLine = lines.slice(i + 1).find(l => l.trim());
      const level = metaLine?.trim().match(/^metadataPermission\s*:\s*(.+)$/)?.[1] || '';
      current.columnPermissions.push(`${unquoteName(cp[1].trim())}${level ? `: ${level}` : ''}`);
    }
  }
  return roles;
}

function describeDataSource(ds) {
  if (!ds) return '';
  const parts = [ds.type, ds.server, ds.database, ds.schema, ds.sourceTable].filter(Boolean);
  return parts.join(' · ');
}

function indentOf(line) {
  const m = line.match(/^(\s*)/)[1];
  let tabs = 0;
  let spaces = 0;
  for (const ch of m) { if (ch === '\t') tabs++; else spaces++; }
  return tabs + Math.floor(spaces / 4);
}

// --- Report ------------------------------------------------------------------

function buildReport(name, files) {
  const report = {
    name,
    modelRef: '',
    activePageId: '',
    theme: '',
    filters: new Map(),
    pages: new Map(),
    visuals: new Map(),   // "pageId/visualId" -> visual
    bookmarks: new Map(),
    hasDefinition: false,
  };
  let any = false;

  for (const [path, content] of files) {
    const norm = path.replace(/\\/g, '/');
    const parts = norm.split('/');
    const lower = norm.toLowerCase();
    const json = lower.endsWith('.json') || lower.endsWith('.pbir') ? safeJson(content) : null;
    const pagesIdx = parts.findIndex(p => p.toLowerCase() === 'pages');

    if (lower.endsWith('definition.pbir')) {
      any = true;
      report.hasDefinition = true;
      const ref = json?.datasetReference;
      report.modelRef = ref?.byPath?.path
        || (ref?.byConnection ? `Connection: ${ref.byConnection.pbiModelDatabaseName || ref.byConnection.connectionString || 'remote model'}` : '');
    } else if (lower.endsWith('/report.json') || lower === 'report.json' || lower === 'definition/report.json') {
      any = true;
      report.theme = json?.themeCollection?.customTheme?.name || json?.themeCollection?.baseTheme?.name || '';
      for (const f of json?.filterConfig?.filters || []) addFilter(report.filters, f);
    } else if (lower.endsWith('/pages/pages.json')) {
      any = true;
      report.activePageId = json?.activePageName || '';
    } else if (lower.endsWith('/page.json') && pagesIdx !== -1) {
      any = true;
      const pageId = parts[pagesIdx + 1];
      const page = ensurePage(report, pageId);
      page.name = json?.displayName || json?.name || pageId;
      page.hidden = json?.visibility === 'HiddenInViewMode';
      page.hasFile = true;
      for (const f of json?.filterConfig?.filters || []) addFilter(page.filters, f);
    } else if (lower.endsWith('/visual.json') && pagesIdx !== -1) {
      any = true;
      const visualsIdx = parts.findLastIndex(p => p.toLowerCase() === 'visuals');
      const pageId = parts[pagesIdx + 1];
      const visualId = parts[visualsIdx + 1];
      if (!json || !visualId) continue;
      ensurePage(report, pageId);
      report.visuals.set(`${pageId}/${visualId}`, buildVisual(json, pageId, visualId));
    } else if (lower.endsWith('.bookmark.json')) {
      any = true;
      const id = parts[parts.length - 1].replace(/\.bookmark\.json$/i, '');
      if (json) report.bookmarks.set(id, buildBookmark(json, id));
    }
  }
  return any ? report : null;
}

function ensurePage(report, pageId) {
  if (!report.pages.has(pageId)) {
    report.pages.set(pageId, { id: pageId, name: pageId, hidden: false, filters: new Map(), hasFile: false });
  }
  return report.pages.get(pageId);
}

function buildVisual(config, pageId, visualId) {
  const visual = config.visual || {};
  const isGroup = !!config.visualGroup;
  const type = isGroup ? 'group' : (visual.visualType || config.visualType || 'unknown');
  const title = visualTitle(config);
  const { labels, refs } = visualFields(config);
  const filters = new Map();
  for (const f of config.filterConfig?.filters || visual.filterConfig?.filters || []) addFilter(filters, f);
  return {
    id: visualId,
    pageId,
    type,
    title,
    isHidden: config.isHidden === true || visual.isHidden === true,
    fields: labels,
    refs,
    filters,
    slicerSelection: slicerSelectionOf(visual.objects),
  };
}

/** A slicer's saved selection lives in objects.general[0].properties.filter. */
function slicerSelectionOf(objects) {
  const general = objects?.general;
  const props = Array.isArray(general) ? general[0]?.properties : general?.properties;
  return describeFilterCondition(props?.filter?.filter);
}

/** Display name for a visual: its title, or "<Type> (untitled)". */
export function visualDisplayName(v) {
  return v.title || `${prettyVisualType(v.type)} (untitled)`;
}

/** Unambiguous label: name plus type and short ID, e.g. 'Sales (Card · 85f22ff)'. */
export function visualLabel(v) {
  return `${visualDisplayName(v)} (${prettyVisualType(v.type)} · ${String(v.id).slice(0, 7)})`;
}

const VISUAL_TYPE_NAMES = {
  tableEx: 'Table', pivotTable: 'Matrix', card: 'Card', multiRowCard: 'Multi-row card', cardVisual: 'Card',
  slicer: 'Slicer', advancedSlicerVisual: 'Button slicer', textbox: 'Text box', image: 'Image', shape: 'Shape',
  actionButton: 'Button', kpi: 'KPI', gauge: 'Gauge', map: 'Map', filledMap: 'Filled map', azureMap: 'Azure map',
  lineChart: 'Line chart', areaChart: 'Area chart', barChart: 'Bar chart', columnChart: 'Column chart',
  clusteredBarChart: 'Clustered bar chart', clusteredColumnChart: 'Clustered column chart',
  lineClusteredColumnComboChart: 'Line and clustered column chart', pieChart: 'Pie chart', donutChart: 'Donut chart',
  scatterChart: 'Scatter chart', waterfallChart: 'Waterfall chart', funnel: 'Funnel', treemap: 'Treemap', group: 'Group',
};
export function prettyVisualType(type) {
  if (!type) return 'Visual';
  return VISUAL_TYPE_NAMES[type] || type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

/** Title text only (formatting such as font, colour, alignment is ignored). */
export function visualTitle(config) {
  const visual = config.visual || config;
  if (config.visualGroup?.displayName) return config.visualGroup.displayName;
  if (typeof visual.title === 'string') return visual.title;
  if (visual.title?.text) return visual.title.text;
  for (const holder of [visual.visualContainerObjects, visual.vcObjects, visual.objects]) {
    const t = holder?.title;
    const props = Array.isArray(t) ? t[0]?.properties : t?.properties;
    const text = props?.text;
    if (typeof text === 'string') return text;
    const lit = text?.expr?.Literal?.Value;
    if (lit !== undefined) return decodeLiteral(lit);
  }
  return '';
}

/**
 * Every field bound to a visual, labelled with its role and aggregation
 * ("Values: Sum of Sales[Amount]"), plus a set of plain references
 * ("measure|Sales|Total Sales") for "is this still used?" checks.
 */
export function visualFields(config) {
  const visual = config.visual || config;
  const labels = [];
  const refs = new Set();
  const queryState = visual.query?.queryState || visual.queryState;

  if (queryState && typeof queryState === 'object') {
    for (const [role, state] of Object.entries(queryState)) {
      for (const proj of state?.projections || []) {
        const label = fieldLabel(proj?.field, {}, refs);
        if (label) labels.push(`${role}: ${label}${proj.displayName ? ` as "${proj.displayName}"` : ''}`);
      }
      for (const fp of state?.fieldParameters || []) {
        const entity = fp?.parameterExpr?.Column?.Expression?.SourceRef?.Entity;
        if (entity) { labels.push(`${role}: field parameter ${entity}`); refs.add(`table|${entity}|`); }
      }
    }
  }
  const pq = visual.prototypeQuery;
  if (!labels.length && pq?.Select) {
    const alias = {};
    for (const f of pq.From || []) if (f.Name && f.Entity) alias[f.Name] = f.Entity;
    for (const item of pq.Select) {
      const label = fieldLabel(item, alias, refs);
      if (label) labels.push(`Fields: ${label}`);
    }
  }
  return { labels: [...new Set(labels)], refs };
}

/** Human label for a field expression, recording plain refs along the way. */
export function fieldLabel(f, alias = {}, refs = null) {
  if (!f || typeof f !== 'object') return '';
  const entityOf = (x) => x?.Expression?.SourceRef?.Entity || alias[x?.Expression?.SourceRef?.Source] || x?.Expression?.SourceRef?.Source || '';
  if (f.Measure) {
    const t = entityOf(f.Measure);
    refs?.add(`measure|${t}|${f.Measure.Property}`);
    return `${t}[${f.Measure.Property}]`;
  }
  if (f.Column) {
    const t = entityOf(f.Column);
    refs?.add(`column|${t}|${f.Column.Property}`);
    return `${t}[${f.Column.Property}]`;
  }
  if (f.Aggregation) {
    const inner = fieldLabel(f.Aggregation.Expression, alias, refs);
    const fn = AGGREGATIONS[f.Aggregation.Function] || `Aggregate ${f.Aggregation.Function}`;
    return inner ? `${fn} of ${inner}` : '';
  }
  if (f.HierarchyLevel) {
    const h = f.HierarchyLevel.Expression?.Hierarchy;
    const t = entityOf(h);
    if (t) refs?.add(`table|${t}|`);
    return `${t}[${h?.Hierarchy || ''}].${f.HierarchyLevel.Level || ''}`;
  }
  if (f.Literal) return decodeLiteral(f.Literal.Value);
  return '';
}

// --- Filters -----------------------------------------------------------------

function addFilter(map, filter) {
  if (!filter || typeof filter !== 'object') return;
  const field = fieldLabel(filter.field) || '(unknown field)';
  const key = filter.name || `field:${field}`;
  const condition = describeFilterCondition(filter.filter);
  const refs = new Set();
  fieldLabel(filter.field, {}, refs);
  map.set(key, {
    key,
    field,
    type: filter.type || '',
    condition,
    applied: condition !== '',
    hidden: filter.isHiddenInViewMode === true,
    locked: filter.isLockedInViewMode === true,
    refs,
  });
}

/**
 * Readable text for a filter's Where clause, covering In / Not / Comparison /
 * Between / Contains / StartsWith / EndsWith / And / Or. Anything else falls
 * back to a stable JSON form, so a change is never silently missed.
 * Returns '' when the filter has no condition (sitting unapplied in the pane).
 */
export function describeFilterCondition(filterDef) {
  const where = filterDef?.Where;
  if (!Array.isArray(where) || where.length === 0) return '';
  const alias = {};
  for (const f of filterDef.From || []) if (f.Name && f.Entity) alias[f.Name] = f.Entity;
  return where.map(w => describeCondition(w?.Condition, alias)).filter(Boolean).join(' and ');
}

function describeCondition(c, alias) {
  if (!c) return '';
  const expr = (e) => fieldLabel(e, alias) || stableJson(e);
  if (c.In) {
    const lhs = (c.In.Expressions || []).map(expr).join(', ');
    if (c.In.Values) {
      const vals = c.In.Values.map(row => row.map(v => (v?.Literal ? decodeLiteral(v.Literal.Value) : expr(v))).join(' / '));
      return `${lhs} is ${vals.length === 1 ? vals[0] : `one of ${vals.join(', ')}`}`;
    }
    return `${lhs} in ${stableJson(c.In.Table || c.In)}`;
  }
  if (c.Not) return `not (${describeCondition(c.Not.Expression, alias)})`;
  if (c.And) return `${describeCondition(c.And.Left, alias)} and ${describeCondition(c.And.Right, alias)}`;
  if (c.Or) return `(${describeCondition(c.Or.Left, alias)} or ${describeCondition(c.Or.Right, alias)})`;
  if (c.Comparison) {
    const op = COMPARISON_OPS[c.Comparison.ComparisonKind] ?? `op${c.Comparison.ComparisonKind}`;
    return `${expr(c.Comparison.Left)} ${op} ${expr(c.Comparison.Right)}`;
  }
  if (c.Between) return `${expr(c.Between.Expression)} between ${expr(c.Between.LowerBound)} and ${expr(c.Between.UpperBound)}`;
  for (const k of ['Contains', 'StartsWith', 'EndsWith']) {
    if (c[k]) return `${expr(c[k].Left)} ${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${expr(c[k].Right)}`;
  }
  return stableJson(c);
}

/** Decode a Power BI query literal: "'Bikes'" -> Bikes, "100D" -> 100, datetime'…' -> the date. */
export function decodeLiteral(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  let m = s.match(/^'((?:[^']|'')*)'$/);
  if (m) return m[1].replace(/''/g, "'");
  m = s.match(/^(-?\d+(?:\.\d+)?)[DLM]$/);
  if (m) return m[1];
  m = s.match(/^datetime'(.+)'$/i);
  if (m) return m[1].replace(/T00:00:00(\.0+)?$/, '');
  return s;
}

// --- Bookmarks ---------------------------------------------------------------

function buildBookmark(json, id) {
  const state = json.explorationState || {};
  const { activeSection, ...rest } = state;
  const opts = json.options || {};
  return {
    id,
    name: json.displayName || id,
    pageId: activeSection || '',
    targetVisuals: (opts.targetVisualNames || []).length,
    targetVisualIds: opts.targetVisualNames || [],
    appliesToSelectedVisuals: opts.applyOnlyToTargetVisuals === true,
    capturesData: opts.suppressData !== true,
    capturesDisplay: opts.suppressDisplay !== true,
    capturesCurrentPage: opts.suppressActiveSection !== true,
    capturedState: stableJson(rest),
    state, // raw explorationState, used to work out what the bookmark changes
  };
}

// --- helpers -----------------------------------------------------------------

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** JSON with sorted keys, so equal objects always stringify equally. */
export function stableJson(value) {
  if (value === undefined) return '';
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
    : v));
}
