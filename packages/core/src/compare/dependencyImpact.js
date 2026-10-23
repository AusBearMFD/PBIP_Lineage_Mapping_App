/**
 * Dependency Impact — "what does this change affect?" for Version Compare.
 *
 * Given a snapshot (normally the AFTER side of a commit) and a measure,
 * column, or table that was edited or deleted, finds everything that still
 * depends on it, directly or through other objects:
 *
 *   - downstream measures (and the measures that use those, and so on)
 *   - calculated columns and calculated tables / field parameters
 *   - visuals that show it, or show something that depends on it
 *   - report, page, and visual filters on it
 *   - RLS role filters that use it
 *   - relationships built on a column
 *
 * Only reports bound to the same semantic model are considered, so two
 * models with a same-named measure don't cross-contaminate.
 *
 * The result says whether the change BREAKS things (a deleted object that is
 * still referenced makes those visuals and measures error) or only CHANGES
 * them (an edited formula changes the numbers but nothing errors).
 */

import { extractColumnRefs, extractMeasureRefs, extractTableRefs } from '../parser/daxParser.js';
import { visualLabel } from './snapshot.js';

/** Display order and labels of impact groups. */
export const IMPACT_GROUPS = [
  { key: 'visual', label: 'Visuals' },
  { key: 'filter', label: 'Filters' },
  { key: 'security', label: 'Security (RLS)' },
  { key: 'measure', label: 'Downstream measures' },
  { key: 'column', label: 'Calculated columns' },
  { key: 'table', label: 'Calculated tables and field parameters' },
  { key: 'relationship', label: 'Relationships' },
];

const BREAK_EFFECT = {
  visual: 'Will show an error',
  filter: 'Filter will stop working',
  security: 'Role filter will error, so members of the role can\'t query the model',
  measure: 'Will return an error',
  column: 'Will fail on refresh',
  table: 'Will fail on refresh',
  relationship: 'Will be invalid',
};
const CHANGE_EFFECT = {
  visual: 'Values may change',
  filter: 'Filters on the new values',
  security: 'Rows this role can see may change',
  measure: 'Results may change',
  column: 'Values may change on refresh',
  table: 'Contents may change on refresh',
  relationship: 'Both sides must keep matching data types',
};

/**
 * Index every DAX dependency and report usage in a snapshot, per model.
 * Build once per snapshot and reuse for every record.
 * @param {{ models: Map, reports: Map }} snapshot
 */
export function buildDependencyIndex(snapshot) {
  const perModel = new Map();
  const modelKeys = [...snapshot.models.keys()];
  for (const [key, model] of snapshot.models) perModel.set(key, indexModel(model));

  // Bind each report to its model so usage stays within one model.
  for (const [reportKey, report] of snapshot.reports) {
    const modelKey = resolveModelKey(reportKey, report.modelRef, modelKeys);
    if (modelKey == null || !perModel.has(modelKey)) continue;
    indexReport(perModel.get(modelKey), report, snapshot.reports.size > 1);
  }
  return { perModel };
}

/**
 * What depends on a measure, column, or table.
 * @param {object} index - buildDependencyIndex() result for the AFTER snapshot.
 * @param {string} modelKey - Snapshot key of the model the object belongs to.
 * @param {{ kind: 'measure'|'column'|'table', table?: string, name: string, columns?: string[], measures?: string[] }} target
 * @param {'removed'|'changed'|'renamed'} mode - removed/renamed (old name) -> breaks; changed -> changes.
 * @returns {{ severity: 'breaks'|'changes'|'none', headline: string, groups: Array<{ key, label, items: Array<{ label, via, effect }> }>, note?: string } | null}
 */
export function describeImpact(index, modelKey, target, mode) {
  const dep = index?.perModel.get(modelKey);
  if (!dep) return null;
  const breaks = mode !== 'changed';

  // Starting points: the object itself (and, for a table, its columns and measures).
  const start = [];
  let note = '';
  if (target.kind === 'measure') {
    // Measure names are model-wide in Power BI: if one with the same name
    // still exists (moved to another table), references by name keep working.
    if (breaks && mode === 'removed' && dep.measures.has(lc(target.name))) {
      note = `A measure named [${target.name}] still exists in ${dep.measures.get(lc(target.name)).table}, so references by name keep working (it was most likely moved).`;
      return { severity: 'none', headline: 'Nothing breaks', groups: [], note };
    }
    start.push(measureKey(target.name));
  } else if (target.kind === 'column') {
    start.push(columnKey(target.table, target.name));
  } else if (target.kind === 'table') {
    start.push(tableKey(target.name));
    for (const c of target.columns || []) start.push(columnKey(target.name, c));
    for (const m of target.measures || []) {
      if (!dep.measures.has(lc(m))) start.push(measureKey(m)); // moved measures keep working
    }
  }

  // Walk users breadth-first: users of the target, then users of those users.
  const found = new Map(); // object id -> { obj, via }
  const queue = start.map(k => ({ key: k, via: '' }));
  const seenKeys = new Set(start);
  while (queue.length) {
    const { key, via } = queue.shift();
    for (const id of dep.users.get(key) || []) {
      if (found.has(id)) continue;
      const obj = dep.objects.get(id);
      if (!obj || obj.self === key) continue;
      found.set(id, { obj, via });
      // Anything that depends on this object is affected too.
      for (const next of obj.provides || []) {
        if (!seenKeys.has(next)) {
          seenKeys.add(next);
          queue.push({ key: next, via: obj.short });
        }
      }
    }
  }

  const groups = IMPACT_GROUPS.map(g => ({ ...g, items: [] }));
  const byKey = Object.fromEntries(groups.map(g => [g.key, g]));
  for (const { obj, via } of found.values()) {
    byKey[obj.group].items.push({
      label: obj.label,
      via,
      effect: (breaks ? BREAK_EFFECT : CHANGE_EFFECT)[obj.group],
    });
  }
  for (const g of groups) g.items.sort((a, b) => (a.via ? 1 : 0) - (b.via ? 1 : 0) || a.label.localeCompare(b.label));
  const nonEmpty = groups.filter(g => g.items.length);
  if (!nonEmpty.length) {
    return {
      severity: 'none',
      headline: breaks ? 'Nothing else uses it, so nothing breaks' : 'Nothing else uses it',
      groups: [],
    };
  }
  return { severity: breaks ? 'breaks' : 'changes', headline: headline(nonEmpty, breaks), groups: nonEmpty, ...(note ? { note } : {}) };
}

/** Does any impact group contain security (RLS) items? */
export function impactTouchesSecurity(impact) {
  return !!impact?.groups?.some(g => g.key === 'security' && g.items.length);
}

/**
 * Work out which model a report is bound to. definition.pbir stores a
 * relative path such as "../Sales.SemanticModel"; with a single model in the
 * snapshot, an unresolvable reference falls back to it.
 */
export function resolveModelKey(reportKey, modelRef, modelKeys) {
  if (modelRef && !modelRef.startsWith('Connection:')) {
    const base = (reportKey || '').split('/').slice(0, -1);
    for (const part of modelRef.replace(/\\/g, '/').split('/')) {
      if (part === '..') base.pop();
      else if (part && part !== '.') base.push(part);
    }
    const resolved = base.join('/').toLowerCase();
    const exact = modelKeys.find(k => k.toLowerCase() === resolved);
    if (exact != null) return exact;
    const byName = modelKeys.find(k => k.split('/').pop().toLowerCase() === resolved.split('/').pop());
    if (byName != null) return byName;
  } else if (modelRef) {
    return null; // a live connection to a published model: not in this repo
  }
  return modelKeys.length === 1 ? modelKeys[0] : null;
}

// --- Indexing ----------------------------------------------------------------

function indexModel(model) {
  const dep = {
    measures: new Map(),  // lower-case measure name -> { table, name }
    columns: new Set(),   // columnKey of every column
    users: new Map(),     // dependency key -> Set<object id>
    objects: new Map(),   // object id -> { group, label, short, self, provides }
  };
  for (const t of model.tables.values()) {
    for (const m of t.measures.values()) dep.measures.set(lc(m.name), { table: t.name, name: m.name });
    for (const c of t.columns.values()) dep.columns.add(columnKey(t.name, c.name));
  }

  const addObject = (id, obj, dax) => {
    dep.objects.set(id, obj);
    for (const key of daxDependencies(dep, dax, obj.homeTable)) addUser(dep, key, id);
  };

  for (const t of model.tables.values()) {
    for (const m of t.measures.values()) {
      addObject(`measure:${lc(m.name)}`, {
        group: 'measure', label: `${t.name}[${m.name}]`, short: `[${m.name}]`,
        self: measureKey(m.name), provides: [measureKey(m.name)], homeTable: t.name,
      }, m.expression);
    }
    for (const c of t.columns.values()) {
      if (!c.expression) continue;
      addObject(`column:${columnKey(t.name, c.name)}`, {
        group: 'column', label: `${t.name}[${c.name}]`, short: `${t.name}[${c.name}]`,
        self: columnKey(t.name, c.name), provides: [columnKey(t.name, c.name)], homeTable: t.name,
      }, c.expression);
    }
    for (const p of t.partitions.values()) {
      if (p.type !== 'calculated' || !p.sourceExpression) continue;
      // A calculated table (often a field parameter built with NAMEOF) — anything
      // that uses the table or its columns depends on what its DAX references.
      addObject(`table:${lc(t.name)}`, {
        group: 'table', label: `${t.name}${/NAMEOF\s*\(/i.test(p.sourceExpression) ? ' (field parameter)' : ''}`, short: t.name,
        self: tableKey(t.name),
        provides: [tableKey(t.name), ...[...t.columns.keys()].map(c => columnKey(t.name, c))],
        homeTable: t.name,
      }, p.sourceExpression);
    }
  }

  for (const role of model.roles.values()) {
    for (const [table, expr] of role.tablePermissions) {
      if (!expr) continue;
      addObject(`role:${lc(role.name)}|${lc(table)}`, {
        group: 'security', label: `RLS role "${role.name}" (filter on ${table})`, short: `role ${role.name}`,
        self: '', provides: [], homeTable: table,
      }, expr);
    }
  }

  for (const r of model.relationships.values()) {
    const id = `rel:${lc(r.name)}`;
    dep.objects.set(id, {
      group: 'relationship', label: `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]${r.isActive ? '' : ' (inactive)'}`,
      short: 'relationship', self: '', provides: [],
    });
    addUser(dep, columnKey(r.fromTable, r.fromColumn), id);
    addUser(dep, columnKey(r.toTable, r.toColumn), id);
  }
  return dep;
}

function indexReport(dep, report, showReportName) {
  const prefix = showReportName && report.name ? `${report.name} › ` : '';
  const pname = (id) => report.pages.get(id)?.name || id;
  const addRefs = (id, obj, refs) => {
    dep.objects.set(id, obj);
    for (const ref of refs) {
      const [kind, table, name] = ref.split('|');
      if (kind === 'measure') addUser(dep, measureKey(name), id);
      else if (kind === 'column') addUser(dep, columnKey(table, name), id);
      else if (kind === 'table') addUser(dep, tableKey(table), id);
    }
  };
  const rk = report.name || '';
  for (const [vKey, v] of report.visuals) {
    addRefs(`visual:${rk}|${vKey}`, {
      group: 'visual', label: `${visualLabel(v)} on ${prefix}${pname(v.pageId)}`, short: 'visual', self: '', provides: [],
    }, v.refs);
    for (const [fKey, f] of v.filters) {
      addRefs(`filter:${rk}|${vKey}|${fKey}`, {
        group: 'filter', label: `Visual filter on ${visualLabel(v)} (${prefix}${pname(v.pageId)})`, short: 'filter', self: '', provides: [],
      }, f.refs);
    }
  }
  for (const p of report.pages.values()) {
    for (const [fKey, f] of p.filters) {
      addRefs(`filter:${rk}|page:${p.id}|${fKey}`, {
        group: 'filter', label: `Page filter on ${prefix}${p.name}`, short: 'filter', self: '', provides: [],
      }, f.refs);
    }
  }
  for (const [fKey, f] of report.filters) {
    addRefs(`filter:${rk}|report|${fKey}`, {
      group: 'filter', label: `Report filter (all pages${report.name && showReportName ? ` of ${report.name}` : ''})`, short: 'filter', self: '', provides: [],
    }, f.refs);
  }
}

/**
 * Dependency keys a DAX expression references. "T[X]" is a column if T has
 * a column X, otherwise a measure reference written with its table; "[X]" is
 * a measure if one exists by that name, otherwise a column of the home table
 * (row context inside a calculated column).
 */
function daxDependencies(dep, dax, homeTable) {
  if (!dax) return [];
  const keys = new Set();
  for (const { table, column } of extractColumnRefs(dax)) {
    const ck = columnKey(table, column);
    if (dep.columns.has(ck)) keys.add(ck);
    else if (dep.measures.has(lc(column))) keys.add(measureKey(column));
    else keys.add(ck); // a column that no longer exists still counts as a dependency
    keys.add(tableKey(table));
  }
  for (const { measure } of extractMeasureRefs(dax)) {
    if (dep.measures.has(lc(measure))) keys.add(measureKey(measure));
    else if (homeTable && dep.columns.has(columnKey(homeTable, measure))) keys.add(columnKey(homeTable, measure));
    else keys.add(measureKey(measure)); // a missing measure: still a (broken) dependency
  }
  for (const t of extractTableRefs(dax)) keys.add(tableKey(t));
  return [...keys];
}

function addUser(dep, key, id) {
  if (!dep.users.has(key)) dep.users.set(key, new Set());
  dep.users.get(key).add(id);
}

function headline(groups, breaks) {
  const n = (g) => g.items.length;
  const noun = {
    visual: ['visual', 'visuals'], filter: ['filter', 'filters'], security: ['RLS role filter', 'RLS role filters'],
    measure: ['measure', 'measures'], column: ['calculated column', 'calculated columns'],
    table: ['calculated table', 'calculated tables'], relationship: ['relationship', 'relationships'],
  };
  const parts = groups.map(g => `${n(g)} ${noun[g.key][n(g) === 1 ? 0 : 1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return breaks ? `Breaks ${list}` : `May change ${list} (nothing breaks)`;
}

function lc(s) {
  return String(s ?? '').toLowerCase();
}
function measureKey(name) {
  return `m|${lc(name)}`;
}
function columnKey(table, column) {
  return `c|${lc(table)}|${lc(column)}`;
}
function tableKey(table) {
  return `t|${lc(table)}`;
}
