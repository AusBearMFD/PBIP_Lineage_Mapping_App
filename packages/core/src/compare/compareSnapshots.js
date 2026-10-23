/**
 * Compare Snapshots — the "Version Compare" engine.
 *
 * Compares two complete snapshots (see snapshot.js) and returns one record per
 * meaningful difference, split into two sections:
 *
 *   modified  — things that existed before and were edited or deleted
 *   additions — things that are new
 *
 * Every record has the same shape, so a reviewer script can consume it
 * directly:
 *
 *   {
 *     id, section: 'modified'|'additions', change: 'changed'|'removed'|'renamed'|'added',
 *     group: 'measure'|'relationship'|…  (see COMPARE_GROUPS),
 *     name, location: { model?, table?, report?, page?, visual? },
 *     props:   [{ label, before, after, kind }]   // what differs (or the new/old values)
 *     context: [{ label, value, kind }]           // extra facts, e.g. which visuals use it
 *     flags:   { security, broken, copy }         // RLS-related / still referenced after deletion / looks like a copy
 *     objectId?, subtype?                          // PBIR object ID and visual type, for visuals/pages/bookmarks
 *     effect?                                      // bookmarks: what the bookmark changes vs the page default (bookmarkEffect.js)
 *     impact?                                      // measures/columns/tables: what depends on it (dependencyImpact.js)
 *     diagram?                                     // model objects: { modelKey, table?, relationship? } for the model diagram
 *   }
 *
 * `kind` is 'text' | 'dax' | 'm' | 'list' and tells a UI how to render a value.
 *
 * Children of a newly added or deleted parent (a new table's measures, a
 * deleted page's visuals) are listed inside the parent's record rather than
 * repeated as separate records.
 */

import { buildSnapshot, visualDisplayName, visualLabel, prettyVisualType } from './snapshot.js';
import { describeBookmarkEffect, bookmarkEffectLines } from './bookmarkEffect.js';
import { buildDependencyIndex, describeImpact, impactTouchesSecurity } from './dependencyImpact.js';

export { prettyVisualType };

/** Display order and labels of record groups. */
export const COMPARE_GROUPS = [
  { key: 'role', label: 'Security (RLS roles)' },
  { key: 'relationship', label: 'Relationships' },
  { key: 'measure', label: 'Measures' },
  { key: 'calcItem', label: 'Calculation items' },
  { key: 'column', label: 'Columns' },
  { key: 'table', label: 'Tables' },
  { key: 'dataSource', label: 'Data sources' },
  { key: 'parameter', label: 'Parameters' },
  { key: 'expression', label: 'Shared Power Query expressions' },
  { key: 'semanticModel', label: 'Semantic models' },
  { key: 'report', label: 'Reports' },
  { key: 'page', label: 'Pages' },
  { key: 'visual', label: 'Visuals' },
  { key: 'filter', label: 'Filters' },
  { key: 'bookmark', label: 'Bookmarks' },
];

/**
 * Compare two file maps (convenience wrapper).
 * @param {Map<string,string>} beforeFiles
 * @param {Map<string,string>} afterFiles
 */
export function compareFileMaps(beforeFiles, afterFiles) {
  return compareSnapshots(buildSnapshot(beforeFiles), buildSnapshot(afterFiles));
}

/**
 * Compare two snapshots.
 * @param {object} before - buildSnapshot() result (or null/undefined for "nothing").
 * @param {object} after - buildSnapshot() result.
 * @returns {{ records: Array<object>, summary: object }}
 */
export function compareSnapshots(before, after) {
  const b = before || { models: new Map(), reports: new Map() };
  const a = after || { models: new Map(), reports: new Map() };
  const ctx = {
    records: [],
    showModelName: new Set([...b.models.keys(), ...a.models.keys()]).size > 1,
    deps: buildDependencyIndex(a),
    afterModels: [...a.models.values()],
  };

  for (const key of union(b.models.keys(), a.models.keys())) {
    compareModel(ctx, key, b.models.get(key), a.models.get(key));
  }
  for (const key of union(b.reports.keys(), a.reports.keys())) {
    compareReport(ctx, b.reports.get(key), a.reports.get(key));
  }

  const records = ctx.records;
  return { records, summary: summarize(records) };
}

/**
 * Group records of one section in COMPARE_GROUPS order, omitting empty groups.
 * @returns {Array<{ key, label, records }>}
 */
export function groupCompareRecords(records, section) {
  const inSection = records.filter(r => !section || r.section === section);
  return COMPARE_GROUPS
    .map(g => ({ ...g, records: inSection.filter(r => r.group === g.key) }))
    .filter(g => g.records.length > 0);
}

// --- Semantic model ----------------------------------------------------------

function compareModel(ctx, modelKey, bm, am) {
  const modelName = (am || bm).name || 'Semantic model';
  const loc = (extra = {}) => ({ ...(ctx.showModelName ? { model: modelName } : {}), ...extra });
  ctx.modelKey = modelKey;

  if (!bm || !am) {
    const m = am || bm;
    push(ctx, {
      change: am ? 'added' : 'removed', group: 'semanticModel', name: modelName, location: {},
      props: [
        side(am, 'Tables', [...m.tables.keys()], 'list'),
        side(am, 'Measures', count([...m.tables.values()].reduce((n, t) => n + t.measures.size, 0)), 'text'),
        side(am, 'Relationships', count(m.relationships.size), 'text'),
        side(am, 'RLS roles', [...m.roles.keys()], 'list'),
      ].filter(p => !isEmpty(p.before) || !isEmpty(p.after)),
      flags: { security: m.roles.size > 0 },
      diagram: { modelKey },
    });
    return;
  }

  // Tables, columns, measures, calculation items, data sources
  for (const tName of union(bm.tables.keys(), am.tables.keys())) {
    const bt = bm.tables.get(tName);
    const at = am.tables.get(tName);
    if (!bt || !at) {
      const t = at || bt;
      const impact = at ? null : describeImpact(ctx.deps, modelKey, {
        kind: 'table', name: tName, columns: [...t.columns.keys()], measures: [...t.measures.keys()],
      }, 'removed');
      push(ctx, {
        change: at ? 'added' : 'removed', group: 'table', name: tName, location: loc(), impact, diagram: { modelKey, table: tName },
        props: [
          side(at, 'Columns', [...t.columns.keys()], 'list'),
          side(at, 'Measures', [...t.measures.keys()], 'list'),
          side(at, 'Data source', [...t.partitions.values()].map(p => p.source || p.mode || p.type).filter(Boolean), 'list'),
          ...(t.isCalculationGroup ? [side(at, 'Calculation items', [...t.calcItems.keys()], 'list')] : []),
        ].filter(p => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { broken: isBreaking(impact), security: rolesMentioning(ctx, tableMentionRegex(tName)).length > 0 || impactTouchesSecurity(impact) },
      });
      continue;
    }
    compareColumns(ctx, bt, at, loc);
    compareMeasures(ctx, bt, at, loc);
    compareCalcItems(ctx, bt, at, loc);
    compareDataSource(ctx, bt, at, loc);
  }

  compareRelationships(ctx, bm, am, loc);
  compareRoles(ctx, bm, am, loc);
  compareExpressions(ctx, bm, am, loc);
}

function compareColumns(ctx, bt, at, loc) {
  for (const name of union(bt.columns.keys(), at.columns.keys())) {
    const bc = bt.columns.get(name);
    const ac = at.columns.get(name);
    const location = loc({ table: at.name });
    const colRegex = columnMentionRegex(at.name, name);
    const diagram = { modelKey: ctx.modelKey, table: at.name };
    if (!bc || !ac) {
      const c = ac || bc;
      const impact = ac ? null : describeImpact(ctx.deps, ctx.modelKey, { kind: 'column', table: at.name, name }, 'removed');
      push(ctx, {
        change: ac ? 'added' : 'removed', group: 'column', name, location, impact, diagram,
        props: [
          side(ac, 'Data type', c.dataType, 'text'),
          c.expression ? side(ac, 'Formula', c.expression, 'dax') : side(ac, 'Source column', c.sourceColumn, 'text'),
        ].filter(p => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { broken: isBreaking(impact), security: rolesMentioning(ctx, colRegex).length > 0 || impactTouchesSecurity(impact) },
      });
      continue;
    }
    const props = [];
    diffProp(props, 'Data type', bc.dataType, ac.dataType);
    diffProp(props, 'Formula', bc.expression, ac.expression, 'dax', normWs);
    diffProp(props, 'Source column', bc.sourceColumn, ac.sourceColumn);
    diffProp(props, 'Hidden', yesNo(bc.isHidden), yesNo(ac.isHidden));
    diffGenericProps(props, bc.props, ac.props, ['dataType', 'sourceColumn', 'isHidden', 'expression']);
    if (!props.length) continue;
    // Only changes to what the column contains ripple downstream; hiding it or
    // changing its format does not.
    const meaningful = bc.dataType !== ac.dataType || normWs(bc.expression) !== normWs(ac.expression) || bc.sourceColumn !== ac.sourceColumn;
    const impact = meaningful ? describeImpact(ctx.deps, ctx.modelKey, { kind: 'column', table: at.name, name }, 'changed') : null;
    const roles = rolesMentioning(ctx, colRegex);
    push(ctx, {
      change: 'changed', group: 'column', name, location, props, impact, diagram,
      flags: { security: roles.length > 0 || impactTouchesSecurity(impact) },
    });
  }
}

function compareMeasures(ctx, bt, at, loc) {
  const removed = [...bt.measures.keys()].filter(n => !at.measures.has(n));
  const added = [...at.measures.keys()].filter(n => !bt.measures.has(n));

  // Rename detection: a removed and an added measure with the same DAX.
  const renames = new Map();
  for (const r of removed) {
    const expr = normWs(bt.measures.get(r).expression);
    if (!expr) continue;
    const match = added.find(n => !renames.has(n) && normWs(at.measures.get(n).expression) === expr);
    if (match) renames.set(match, r);
  }
  const renamedFrom = new Set(renames.values());
  const location = loc({ table: at.name });

  for (const [newName, oldName] of renames) {
    const regex = measureMentionRegex(newName);
    // Anything still using the OLD name is broken by the rename.
    const impact = describeImpact(ctx.deps, ctx.modelKey, { kind: 'measure', name: oldName }, 'renamed');
    const roles = rolesMentioning(ctx, regex);
    const props = [{ label: 'Name', before: oldName, after: newName, kind: 'text' }];
    diffGenericProps(props, bt.measures.get(oldName).props, at.measures.get(newName).props);
    push(ctx, {
      change: 'renamed', group: 'measure', name: newName, location, props, impact,
      flags: { broken: isBreaking(impact), security: roles.length > 0 || impactTouchesSecurity(impact) },
    });
  }

  for (const name of added) {
    if (renames.has(name)) continue;
    const m = at.measures.get(name);
    push(ctx, {
      change: 'added', group: 'measure', name, location,
      props: [
        { label: 'DAX', before: '', after: m.expression, kind: 'dax' },
        ...propsAsList(m.props, false),
      ],
    });
  }
  for (const name of removed) {
    if (renamedFrom.has(name)) continue;
    const m = bt.measures.get(name);
    const regex = measureMentionRegex(name);
    const impact = describeImpact(ctx.deps, ctx.modelKey, { kind: 'measure', name }, 'removed');
    push(ctx, {
      change: 'removed', group: 'measure', name, location, impact,
      props: [{ label: 'DAX', before: m.expression, after: '', kind: 'dax' }],
      flags: { broken: isBreaking(impact), security: rolesMentioning(ctx, regex).length > 0 || impactTouchesSecurity(impact) },
    });
  }

  for (const [name, am] of at.measures) {
    const bmeas = bt.measures.get(name);
    if (!bmeas) continue;
    const props = [];
    diffProp(props, 'DAX', bmeas.expression, am.expression, 'dax', normWs);
    diffGenericProps(props, bmeas.props, am.props);
    if (!props.length) continue;
    const regex = measureMentionRegex(name);
    const roles = rolesMentioning(ctx, regex);
    // A new formula changes every number built on it; a format-only edit
    // changes how values look, not what depends on them.
    const daxChanged = normWs(bmeas.expression) !== normWs(am.expression);
    const impact = daxChanged ? describeImpact(ctx.deps, ctx.modelKey, { kind: 'measure', name }, 'changed') : null;
    push(ctx, {
      change: 'changed', group: 'measure', name, location, props, impact,
      flags: { security: roles.length > 0 || impactTouchesSecurity(impact) },
    });
  }
}

function compareCalcItems(ctx, bt, at, loc) {
  for (const name of union(bt.calcItems.keys(), at.calcItems.keys())) {
    const bi = bt.calcItems.get(name);
    const ai = at.calcItems.get(name);
    const location = loc({ table: at.name });
    if (!bi || !ai) {
      push(ctx, {
        change: ai ? 'added' : 'removed', group: 'calcItem', name, location,
        props: [side(ai, 'DAX', (ai || bi).expression, 'dax')],
      });
      continue;
    }
    const props = [];
    diffProp(props, 'DAX', bi.expression, ai.expression, 'dax', normWs);
    if (props.length) push(ctx, { change: 'changed', group: 'calcItem', name, location, props });
  }
}

function compareDataSource(ctx, bt, at, loc) {
  const props = [];
  const bParts = [...bt.partitions.values()];
  const aParts = [...at.partitions.values()];
  const bNames = bParts.map(p => p.name).sort();
  const aNames = aParts.map(p => p.name).sort();
  if (bNames.join('|') !== aNames.join('|') && (bParts.length > 1 || aParts.length > 1)) {
    props.push({ label: 'Partitions', before: bNames, after: aNames, kind: 'list' });
  }
  // Compare partitions by name; with a single partition on each side, compare
  // them directly even if the partition was renamed.
  const pairs = bParts.length === 1 && aParts.length === 1
    ? [[bParts[0], aParts[0]]]
    : aParts.map(p => [bt.partitions.get(p.name), p]).filter(([x]) => x);
  for (const [bp, ap] of pairs) {
    const suffix = pairs.length > 1 ? ` (${ap.name})` : '';
    diffProp(props, `Storage mode${suffix}`, storageMode(bp.mode), storageMode(ap.mode));
    diffProp(props, `Source${suffix}`, bp.source, ap.source);
    const kind = ap.type === 'calculated' ? 'dax' : 'm';
    diffProp(props, `${kind === 'dax' ? 'Table expression' : 'Power Query'}${suffix}`, bp.sourceExpression, ap.sourceExpression, kind, normWs);
  }
  if (props.length) push(ctx, { change: 'changed', group: 'dataSource', name: at.name, location: loc(), props, diagram: { modelKey: ctx.modelKey, table: at.name } });
}

/** Partition modes are parsed lower-case ("directquery"); show Power BI's spelling. */
function storageMode(mode) {
  const m = (mode || 'import').toLowerCase();
  return { import: 'Import', directquery: 'DirectQuery', dual: 'Dual', directlake: 'Direct Lake' }[m] || mode;
}

function compareRelationships(ctx, bm, am, loc) {
  const label = (r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`;
  const endpoints = (r) => `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`;
  const bRels = new Map(bm.relationships);
  const aRels = new Map(am.relationships);

  // A relationship deleted and re-created gets a new name; match those by endpoints.
  for (const [name, ar] of [...aRels]) {
    if (bRels.has(name)) continue;
    const match = [...bRels].find(([bn, br]) => !aRels.has(bn) && endpoints(br) === endpoints(ar));
    if (match) { bRels.delete(match[0]); bRels.set(name, match[1]); }
  }

  const describe = (r) => [
    { label: 'Active', value: yesNo(r.isActive) },
    { label: 'Cross-filter direction', value: r.crossFilter },
    { label: 'Cardinality', value: `${r.fromCardinality} to ${r.toCardinality}` },
    { label: 'Security filter direction', value: r.securityFilter },
  ];

  for (const name of union(bRels.keys(), aRels.keys())) {
    const br = bRels.get(name);
    const ar = aRels.get(name);
    if (!br || !ar) {
      const r = ar || br;
      push(ctx, {
        change: ar ? 'added' : 'removed', group: 'relationship', name: label(r), location: loc(),
        props: describe(r).map(d => side(ar, d.label, d.value, 'text')),
        diagram: { modelKey: ctx.modelKey, relationship: name },
      });
      continue;
    }
    const props = [];
    diffProp(props, 'From', `${br.fromTable}[${br.fromColumn}]`, `${ar.fromTable}[${ar.fromColumn}]`);
    diffProp(props, 'To', `${br.toTable}[${br.toColumn}]`, `${ar.toTable}[${ar.toColumn}]`);
    diffProp(props, 'Active', yesNo(br.isActive), yesNo(ar.isActive));
    diffProp(props, 'Cross-filter direction', br.crossFilter, ar.crossFilter);
    diffProp(props, 'Cardinality', `${br.fromCardinality} to ${br.toCardinality}`, `${ar.fromCardinality} to ${ar.toCardinality}`);
    diffProp(props, 'Security filter direction', br.securityFilter, ar.securityFilter);
    diffProp(props, 'Assume referential integrity', yesNo(br.relyOnReferentialIntegrity), yesNo(ar.relyOnReferentialIntegrity));
    diffProp(props, 'Join on date', br.joinOnDateBehavior, ar.joinOnDateBehavior);
    if (!props.length) continue;
    push(ctx, {
      change: 'changed', group: 'relationship', name: label(ar), location: loc(), props,
      diagram: { modelKey: ctx.modelKey, relationship: name },
      // Security filter direction controls how RLS propagates across the relationship.
      flags: { security: br.securityFilter !== ar.securityFilter },
    });
  }
}

function compareRoles(ctx, bm, am, loc) {
  for (const name of union(bm.roles.keys(), am.roles.keys())) {
    const br = bm.roles.get(name);
    const ar = am.roles.get(name);
    if (!br || !ar) {
      const r = ar || br;
      push(ctx, {
        change: ar ? 'added' : 'removed', group: 'role', name, location: loc(),
        props: [
          side(ar, 'Model permission', r.modelPermission, 'text'),
          side(ar, 'Members', r.members, 'list'),
          ...[...r.tablePermissions].map(([t, e]) => side(ar, `Filter on ${t}`, e || '(no filter)', 'dax')),
          side(ar, 'Column permissions', r.columnPermissions, 'list'),
        ].filter(p => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { security: true },
      });
      continue;
    }
    const props = [];
    diffProp(props, 'Model permission', br.modelPermission, ar.modelPermission);
    diffList(props, 'Members', br.members, ar.members);
    for (const t of union(br.tablePermissions.keys(), ar.tablePermissions.keys())) {
      const be = br.tablePermissions.has(t) ? (br.tablePermissions.get(t) || '(no filter)') : '';
      const ae = ar.tablePermissions.has(t) ? (ar.tablePermissions.get(t) || '(no filter)') : '';
      diffProp(props, `Filter on ${t}`, be, ae, 'dax', normWs);
    }
    diffList(props, 'Column permissions', br.columnPermissions, ar.columnPermissions);
    if (props.length) push(ctx, { change: 'changed', group: 'role', name, location: loc(), props, flags: { security: true } });
  }
}

function compareExpressions(ctx, bm, am, loc) {
  for (const name of union(bm.expressions.keys(), am.expressions.keys())) {
    const be = bm.expressions.get(name);
    const ae = am.expressions.get(name);
    const e = ae || be;
    const group = e.kind === 'parameter' ? 'parameter' : 'expression';
    const kind = e.kind === 'parameter' && !String(e.value).includes('\n') ? 'text' : 'm';
    if (!be || !ae) {
      push(ctx, { change: ae ? 'added' : 'removed', group, name, location: loc(), props: [side(ae, 'Value', e.value, kind)] });
      continue;
    }
    const props = [];
    diffProp(props, 'Value', be.value, ae.value, kind, normWs);
    if (props.length) push(ctx, { change: 'changed', group, name, location: loc(), props });
  }
}

// --- Reports -----------------------------------------------------------------

function compareReport(ctx, br, ar) {
  const reportName = (ar || br).name || 'Report';
  const pageName = (rep, id) => rep?.pages.get(id)?.name || id;

  if (!br || !ar) {
    const r = ar || br;
    push(ctx, {
      change: ar ? 'added' : 'removed', group: 'report', name: reportName, location: {},
      props: [
        side(ar, 'Pages', [...r.pages.values()].map(p => p.name), 'list'),
        side(ar, 'Visuals', count(r.visuals.size), 'text'),
        side(ar, 'Bookmarks', count(r.bookmarks.size), 'text'),
        side(ar, 'Bound to model', r.modelRef, 'text'),
      ].filter(p => !isEmpty(p.before) || !isEmpty(p.after)),
    });
    return;
  }

  // Report-level settings
  const props = [];
  diffProp(props, 'Bound to model', br.modelRef, ar.modelRef);
  diffProp(props, 'Default page', br.activePageId ? pageName(br, br.activePageId) : '', ar.activePageId ? pageName(ar, ar.activePageId) : '');
  diffProp(props, 'Theme', br.theme, ar.theme);
  if (props.length) push(ctx, { change: 'changed', group: 'report', name: reportName, location: { report: reportName }, props });

  compareFilterMaps(ctx, br.filters, ar.filters, { report: reportName, scopeLabel: 'All pages' });

  // Pages
  for (const id of union(br.pages.keys(), ar.pages.keys())) {
    const bp = br.pages.get(id);
    const ap = ar.pages.get(id);
    if (!bp || !ap) {
      const p = ap || bp;
      const rep = ap ? ar : br;
      const visuals = [...rep.visuals.values()].filter(v => v.pageId === id).map(visualLabel);
      push(ctx, {
        change: ap ? 'added' : 'removed', group: 'page', name: p.name, location: { report: reportName }, objectId: id,
        props: [
          side(ap, 'Visuals', visuals, 'list'),
          side(ap, 'Page filters', [...p.filters.values()].map(filterSummary), 'list'),
          ...(p.hidden ? [side(ap, 'Hidden', 'Yes', 'text')] : []),
        ].filter(x => !isEmpty(x.before) || !isEmpty(x.after)),
      });
      continue;
    }
    const pprops = [];
    diffProp(pprops, 'Name', bp.name, ap.name);
    diffProp(pprops, 'Hidden', yesNo(bp.hidden), yesNo(ap.hidden));
    if (pprops.length) {
      push(ctx, {
        change: bp.name !== ap.name ? 'renamed' : 'changed', group: 'page', name: ap.name,
        location: { report: reportName }, props: pprops, objectId: id,
      });
    }
    compareFilterMaps(ctx, bp.filters, ap.filters, { report: reportName, page: ap.name, scopeLabel: 'Page' });
  }

  // Visuals (only on pages that exist on both sides; new/deleted pages list theirs).
  // Visuals are matched by page ID + visual ID, never by title.
  const findCopySource = copyFinder(br, ar);
  for (const key of union(br.visuals.keys(), ar.visuals.keys())) {
    const bv = br.visuals.get(key);
    const av = ar.visuals.get(key);
    const pageId = (av || bv).pageId;
    if (!br.pages.has(pageId) || !ar.pages.has(pageId)) continue;
    const location = { report: reportName, page: pageName(ar, pageId) };
    if (!bv || !av) {
      const v = av || bv;
      const source = av ? findCopySource(av) : null;
      push(ctx, {
        change: av ? 'added' : 'removed', group: 'visual', name: visualDisplayName(v), location,
        objectId: v.id, subtype: prettyVisualType(v.type),
        props: [
          side(av, 'Type', prettyVisualType(v.type), 'text'),
          side(av, 'Fields', v.fields, 'list'),
          ...(v.filters.size ? [side(av, 'Visual filters', [...v.filters.values()].map(filterSummary), 'list')] : []),
        ].filter(x => !isEmpty(x.before) || !isEmpty(x.after)),
        context: source ? [{ label: source.label, value: [source.description], kind: 'list' }] : [],
        flags: { copy: !!source },
      });
      continue;
    }
    const vprops = [];
    diffProp(vprops, 'Title', bv.title, av.title);
    diffProp(vprops, 'Type', prettyVisualType(bv.type), prettyVisualType(av.type));
    diffList(vprops, 'Fields', bv.fields, av.fields);
    diffProp(vprops, 'Hidden', yesNo(bv.isHidden), yesNo(av.isHidden));
    if (vprops.length) {
      push(ctx, { change: 'changed', group: 'visual', name: visualDisplayName(av), location, props: vprops, objectId: av.id, subtype: prettyVisualType(av.type) });
    }
    compareFilterMaps(ctx, bv.filters, av.filters, { ...location, visual: visualLabel(av), scopeLabel: 'Visual' });
  }

  // Bookmarks
  for (const id of union(br.bookmarks.keys(), ar.bookmarks.keys())) {
    const bb = br.bookmarks.get(id);
    const ab = ar.bookmarks.get(id);
    const bookmarkProps = (bk, rep) => [
      { label: 'Target page', value: bk.pageId ? pageName(rep, bk.pageId) : '' },
      { label: 'Applies to', value: bk.appliesToSelectedVisuals ? `${bk.targetVisuals} selected visual(s)` : 'All visuals' },
      { label: 'Captures', value: ['data', 'display', 'current page'].filter((_, i) => [bk.capturesData, bk.capturesDisplay, bk.capturesCurrentPage][i]).join(', ') || 'nothing' },
    ];
    if (!bb || !ab) {
      const bk = ab || bb;
      push(ctx, {
        change: ab ? 'added' : 'removed', group: 'bookmark', name: bk.name, location: { report: reportName }, objectId: id,
        props: bookmarkProps(bk, ab ? ar : br).filter(p => p.value).map(p => side(ab, p.label, p.value, 'text')),
        effect: describeBookmarkEffect(ab ? ar : br, bk),
      });
      continue;
    }
    const bprops = [];
    diffProp(bprops, 'Name', bb.name, ab.name);
    const before = bookmarkProps(bb, br);
    const after = bookmarkProps(ab, ar);
    before.forEach((p, i) => diffProp(bprops, p.label, p.value, after[i].value));
    // What the bookmark does, before vs after. The defaults it's compared with
    // can change too (e.g. a visual became hidden by default), so compare each
    // version against its own snapshot.
    const beforeEffect = describeBookmarkEffect(br, bb);
    const afterEffect = describeBookmarkEffect(ar, ab);
    const bl = bookmarkEffectLines(beforeEffect);
    const al = bookmarkEffectLines(afterEffect);
    const effectPropsBefore = bprops.length;
    diffList(bprops, 'Hides', bl.hides, al.hides);
    diffList(bprops, 'Shows', bl.shows, al.shows);
    diffList(bprops, 'Filter changes', bl.filters, al.filters);
    diffList(bprops, 'Slicer selections', bl.slicers, al.slicers);
    if (bb.capturedState !== ab.capturedState && bprops.length === effectPropsBefore) {
      // Something else in the captured state changed (sort order, drill level…).
      bprops.push({ label: 'Other captured state', before: 'Previous state', after: 'Updated (sort, drill or formatting)', kind: 'text' });
    }
    if (bprops.length) {
      push(ctx, {
        change: bb.name !== ab.name ? 'renamed' : 'changed', group: 'bookmark', name: ab.name,
        location: { report: reportName }, props: bprops, objectId: id, effect: afterEffect,
      });
    }
  }
}

function compareFilterMaps(ctx, bMap, aMap, where) {
  const { scopeLabel, ...location } = where;
  // Removing a filter and adding one back on the same field gives it a new
  // internal name; pair those up by field so they read as one edit, not a
  // delete plus an add.
  bMap = new Map(bMap);
  for (const [aKey, af] of aMap) {
    if (bMap.has(aKey)) continue;
    const match = [...bMap].find(([bKey, bf]) => !aMap.has(bKey) && bf.field === af.field);
    if (match) { bMap.delete(match[0]); bMap.set(aKey, match[1]); }
  }
  for (const key of union(bMap.keys(), aMap.keys())) {
    const bf = bMap.get(key);
    const af = aMap.get(key);
    const f = af || bf;
    const name = `${f.field} (${scopeLabel.toLowerCase()} filter)`;
    if (!bf || !af) {
      push(ctx, {
        change: af ? 'added' : 'removed', group: 'filter', name, location, idKey: key,
        props: [
          side(af, 'Condition', f.condition || 'No value applied', 'text'),
          ...(f.hidden ? [side(af, 'Hidden from readers', 'Yes', 'text')] : []),
          ...(f.locked ? [side(af, 'Locked', 'Yes', 'text')] : []),
        ],
      });
      continue;
    }
    const props = [];
    diffProp(props, 'Field', bf.field, af.field);
    diffProp(props, 'Condition', bf.condition || 'No value applied', af.condition || 'No value applied');
    diffProp(props, 'Filter type', bf.type, af.type);
    diffProp(props, 'Hidden from readers', yesNo(bf.hidden), yesNo(af.hidden));
    diffProp(props, 'Locked', yesNo(bf.locked), yesNo(af.locked));
    if (props.length) push(ctx, { change: 'changed', group: 'filter', name, location, props, idKey: key });
  }
}

/**
 * Build a lookup that guesses whether a newly added visual was copied from
 * another one. Power BI gives a pasted visual a new ID, so a copy can't be
 * proven from the files, only inferred:
 *   - same type and identical fields as an existing or deleted visual  -> copy
 *   - same type and same title, but different fields                   -> copy, then edited
 * Visuals with no fields and no title (shapes, blank buttons) are never matched.
 */
function copyFinder(br, ar) {
  const fieldSig = (v) => `${v.type}|${[...v.fields].sort().join('\n')}`;
  const titleSig = (v) => `${v.type}|${v.title.trim().toLowerCase()}`;
  const byFields = new Map();
  const byTitle = new Map();
  const index = (v, rep, status) => {
    if (v.type === 'group') return;
    const entry = { v, rep, status };
    if (v.fields.length) {
      if (!byFields.has(fieldSig(v))) byFields.set(fieldSig(v), []);
      byFields.get(fieldSig(v)).push(entry);
    }
    if (v.title.trim()) {
      if (!byTitle.has(titleSig(v))) byTitle.set(titleSig(v), []);
      byTitle.get(titleSig(v)).push(entry);
    }
  };
  // Candidates: every visual that existed before this commit (still present or deleted).
  for (const [key, v] of br.visuals) index(v, br, ar.visuals.has(key) ? 'existing' : 'deleted');

  const describe = ({ v, rep, status }) =>
    `${visualLabel(v)} on ${rep.pages.get(v.pageId)?.name || v.pageId}${status === 'deleted' ? ' (deleted in this commit, so this may be a move or re-creation)' : ''}`;

  return (added) => {
    if (added.type === 'group' || (!added.fields.length && !added.title.trim())) return null;
    const exact = added.fields.length ? byFields.get(fieldSig(added)) : null;
    if (exact?.length) return { label: 'Looks like a copy of', description: describe(exact[0]) };
    const titled = added.title.trim() ? byTitle.get(titleSig(added)) : null;
    if (titled?.length) return { label: 'Looks like an edited copy of', description: describe(titled[0]) };
    return null;
  };
}

// --- Reference helpers -------------------------------------------------------

function rolesMentioning(ctx, regex) {
  const out = [];
  for (const m of ctx.afterModels) {
    for (const role of m.roles.values()) {
      for (const [table, expr] of role.tablePermissions) {
        if (expr && regex.test(expr)) out.push(`RLS role "${role.name}" (filter on ${table})`);
      }
    }
  }
  return out;
}

function measureMentionRegex(name) {
  return new RegExp(`\\[${escapeRegex(name)}\\]`, 'i');
}
function columnMentionRegex(table, column) {
  return new RegExp(`(?:'${escapeRegex(table)}'|\\b${escapeRegex(table)})\\s*\\[${escapeRegex(column)}\\]`, 'i');
}
function tableMentionRegex(table) {
  return new RegExp(`(?:'${escapeRegex(table)}'|\\b${escapeRegex(table)}\\b)`, 'i');
}

// --- Record helpers ----------------------------------------------------------

function push(ctx, r) {
  const section = r.change === 'added' ? 'additions' : 'modified';
  const loc = r.location || {};
  const id = [r.group, loc.model, loc.report, loc.page, loc.visual, loc.table, r.name].filter(Boolean).join('|');
  const unique = r.objectId || r.idKey;
  const record = {
    id: unique ? `${id}|${unique}` : id,
    section,
    change: r.change,
    group: r.group,
    name: r.name,
    location: loc,
    props: r.props || [],
    context: r.context || [],
    flags: { security: !!r.flags?.security, broken: !!r.flags?.broken, copy: !!r.flags?.copy },
  };
  if (r.objectId) record.objectId = r.objectId;
  if (r.subtype) record.subtype = r.subtype;
  if (r.effect) record.effect = r.effect;
  if (r.impact) record.impact = r.impact;
  if (r.diagram) record.diagram = r.diagram;
  ctx.records.push(record);
}

function isBreaking(impact) {
  return impact?.severity === 'breaks';
}

/** A property for an added (value on the after side) or removed (before side) record. */
function side(isAfter, label, value, kind) {
  return isAfter
    ? { label, before: kind === 'list' ? [] : '', after: value, kind }
    : { label, before: value, after: kind === 'list' ? [] : '', kind };
}

function diffProp(props, label, before, after, kind = 'text', normalize = (x) => x) {
  const b = before ?? '';
  const a = after ?? '';
  if (normalize(String(b)) === normalize(String(a))) return;
  props.push({ label, before: b, after: a, kind });
}

function diffList(props, label, before = [], after = []) {
  const b = [...before];
  const a = [...after];
  if (b.join('\u0000') === a.join('\u0000')) return;
  props.push({ label, before: b, after: a, kind: 'list' });
}

/** Compare remaining TMDL properties (formatString, displayFolder, summarizeBy…). */
function diffGenericProps(props, before = {}, after = {}, skip = []) {
  for (const key of union(Object.keys(before), Object.keys(after))) {
    if (skip.includes(key)) continue;
    const label = humanize(key);
    const b = key === 'isHidden' ? yesNo(before[key] === 'true') : (before[key] ?? '');
    const a = key === 'isHidden' ? yesNo(after[key] === 'true') : (after[key] ?? '');
    diffProp(props, label, b, a);
  }
}

function propsAsList(obj = {}, isBefore) {
  return Object.entries(obj).map(([k, v]) => side(!isBefore, humanize(k), k === 'isHidden' ? 'Yes' : v, 'text'));
}

function filterSummary(f) {
  return `${f.field}: ${f.condition || 'no value applied'}`;
}


function summarize(records) {
  const s = { modified: 0, changed: 0, removed: 0, renamed: 0, added: 0, security: 0, broken: 0, byGroup: {} };
  for (const r of records) {
    if (r.section === 'modified') s.modified++;
    s[r.change]++;
    if (r.flags.security) s.security++;
    if (r.flags.broken) s.broken++;
    s.byGroup[r.group] = (s.byGroup[r.group] || 0) + 1;
  }
  return s;
}

function union(a, b) {
  return [...new Set([...a, ...b])];
}
function count(n) {
  return String(n);
}
function yesNo(v) {
  return v ? 'Yes' : 'No';
}
function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
function normWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
function humanize(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
