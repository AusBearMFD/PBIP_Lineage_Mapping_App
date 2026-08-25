import { describe, it, expect } from 'vitest';
import {
  analyzeFromFiles, findOrphansByCategory, classifyMeasureUsage,
  computeStats, ORPHAN_CATEGORIES, parseRoles, identifyProjectStructure,
} from '../src/index.js';

function buildFixture() {
  const modelFiles = new Map();
  modelFiles.set('definition/tables/Sales.tmdl', `
table Sales
	column Amount
		dataType: double
		sourceColumn: amt
	column Rep
		dataType: string
		sourceColumn: rep
	column Region
		dataType: string
		sourceColumn: region
	column NeverUsedCol
		dataType: string
		sourceColumn: never
	column HiddenUnused
		dataType: int64
		sourceColumn: hu
		isHidden
	measure 'On Visual' = SUM('Sales'[Amount])
	measure 'Feeds Visual Measure' = [On Visual] * 2
	measure 'RLS Only' = IF(SELECTEDVALUE('Sales'[Rep])="x",1,0)
	measure 'Filter Only' = SUM('Sales'[Region])
	measure 'Chain Dead End' = [Dead Leaf] + 1
	measure 'Dead Leaf' = 42
	measure 'Totally Alone' = 99
	column 'CalcFromAmount' = 'Sales'[Amount] * 2
`);
  modelFiles.set('definition/roles/Guard.tmdl', `
role Guard
	modelPermission: read
	tablePermission Sales = [RLS Only] > 0
`);

  const reportFiles = new Map();
  // Page-level filter with an applied (non-default) value on [Filter Only].
  reportFiles.set('definition/pages/p1/page.json', JSON.stringify({
    name: 'p1', displayName: 'Page 1', ordinal: 0,
    filterConfig: { filters: [{
      name: 'f1',
      field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Filter Only' } },
      filter: { Where: [{ Condition: { Comparison: {
        ComparisonKind: 2,
        Left: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Filter Only' } },
        Right: { Literal: { Value: '100L' } },
      } } }] },
    }] },
  }));
  reportFiles.set('definition/pages/p1/visuals/v1/visual.json', JSON.stringify({
    name: 'v1',
    visual: {
      visualType: 'card',
      query: { queryState: { Values: { projections: [
        { field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Feeds Visual Measure' } } },
      ] } } },
    },
  }));

  return analyzeFromFiles({ modelFiles, reportFiles }).graph;
}

describe('parseRoles', () => {
  it('parses role name, permission, and multi-line tablePermission DAX', () => {
    const files = new Map();
    files.set('definition/roles/R.tmdl', `
role 'Sales Rep'
	modelPermission: read

	tablePermission Sales = 'Sales'[Rep] = USERPRINCIPALNAME()

	tablePermission Region =
			[Allowed Region Flag] > 0
`);
    const roles = parseRoles(identifyProjectStructure(files).roleFiles);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('Sales Rep');
    expect(roles[0].modelPermission).toBe('read');
    expect(roles[0].tablePermissions).toHaveLength(2);
    expect(roles[0].tablePermissions[1].expression).toContain('Allowed Region Flag');
  });

  it('routes role files separately from table files', () => {
    const files = new Map();
    files.set('definition/roles/R.tmdl', 'role R\n\tmodelPermission: read\n');
    files.set('definition/tables/T.tmdl', 'table T\n\tcolumn C\n\t\tdataType: string\n');
    const s = identifyProjectStructure(files);
    expect(s.roleFiles).toHaveLength(1);
    expect(s.tmdlFiles).toHaveLength(1);
  });
});

describe('measure orphan categories', () => {
  const graph = buildFixture();
  const orphans = findOrphansByCategory(graph);
  const names = key => orphans[key].map(m => m.name).sort();
  const categoryOf = name => classifyMeasureUsage(`measure::Sales.${name}`, graph).category;

  it('does not flag a measure bound to a visual', () => {
    expect(categoryOf('Feeds Visual Measure')).toBe(ORPHAN_CATEGORIES.NONE);
  });

  it('does not flag a measure that reaches a visual transitively', () => {
    expect(categoryOf('On Visual')).toBe(ORPHAN_CATEGORIES.NONE);
  });

  it('classifies an RLS-only measure as filter/security', () => {
    expect(categoryOf('RLS Only')).toBe(ORPHAN_CATEGORIES.FILTER_SECURITY);
  });

  it('classifies a measure used only by an active page filter as filter/security', () => {
    // Page filters reach visuals through page edges, so this only works if
    // classification is edge-type aware rather than node-type aware.
    expect(categoryOf('Filter Only')).toBe(ORPHAN_CATEGORIES.FILTER_SECURITY);
  });

  it('classifies a measure with dependents that lead nowhere as a visual orphan', () => {
    expect(categoryOf('Dead Leaf')).toBe(ORPHAN_CATEGORIES.VISUAL);
  });

  it('classifies wholly disconnected measures as true orphans', () => {
    expect(names('true')).toEqual(['Chain Dead End', 'Totally Alone']);
  });

  it('assigns every measure exactly one category', () => {
    const all = [...names('filterSecurity'), ...names('visual'), ...names('true')];
    expect(new Set(all).size).toBe(all.length);
    const measureCount = [...graph.nodes.values()].filter(n => n.type === 'measure').length;
    const inUse = [...graph.nodes.values()]
      .filter(n => n.type === 'measure' && classifyMeasureUsage(n.id, graph).category === ORPHAN_CATEGORIES.NONE);
    expect(all.length + inUse.length).toBe(measureCount);
  });

  it('keeps computeStats in agreement with the category lists', () => {
    const stats = computeStats(graph);
    expect(stats.orphanedMeasures).toBe(orphans.total);
    expect(stats.orphanBreakdown.true).toBe(orphans.true.length);
    expect(stats.orphanBreakdown.visual).toBe(orphans.visual.length);
    expect(stats.orphanBreakdown.filterSecurity).toBe(orphans.filterSecurity.length);
    expect(stats.orphanedColumns).toBe(orphans.columns.length);
  });
});

describe('column / field orphans', () => {
  const graph = buildFixture();
  const orphans = findOrphansByCategory(graph);
  const colNames = orphans.columns.map(c => c.name);

  it('flags columns nothing references', () => {
    expect(colNames).toContain('NeverUsedCol');
    expect(colNames).toContain('HiddenUnused');
  });

  it('flags an unused calculated column, tagged as calculated', () => {
    const calc = orphans.columns.find(c => c.name === 'CalcFromAmount');
    expect(calc).toBeDefined();
    expect(calc.isCalculated).toBe(true);
  });

  it('does not flag columns consumed by measures or calculated columns', () => {
    expect(colNames).not.toContain('Amount');
  });

  it('does not flag columns reached only through an RLS or filter measure', () => {
    expect(colNames).not.toContain('Rep');
    expect(colNames).not.toContain('Region');
  });

  it('keeps column orphans separate from measure orphans', () => {
    const measureOrphanNames = [
      ...orphans.true, ...orphans.visual, ...orphans.filterSecurity,
    ].map(m => m.name);
    for (const name of colNames) expect(measureOrphanNames).not.toContain(name);
  });

  it('does not flag relationship key columns', () => {
    const modelFiles = new Map();
    modelFiles.set('definition/tables/Sales.tmdl', `
table Sales
	column CustomerKey
		dataType: int64
		sourceColumn: ck
`);
    modelFiles.set('definition/tables/Customers.tmdl', `
table Customers
	column CustomerKey
		dataType: int64
		sourceColumn: ck
`);
    modelFiles.set('definition/relationships.tmdl', `
relationship rel1
	fromColumn: Sales.CustomerKey
	toColumn: Customers.CustomerKey
`);
    const { graph: g } = analyzeFromFiles({ modelFiles });
    const names = findOrphansByCategory(g).columns.map(c => `${c.table}.${c.name}`);
    expect(names).not.toContain('Sales.CustomerKey');
    expect(names).not.toContain('Customers.CustomerKey');
  });
});
