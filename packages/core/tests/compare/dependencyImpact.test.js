import { describe, it, expect } from 'vitest';
import { compareFileMaps } from '../../src/index.js';

// A model where [Total Sales] feeds [Margin], which feeds [Margin %]; visuals,
// a measure filter, an RLS role and a field parameter hang off them.

const M = 'Shop.SemanticModel/definition';
const R = 'Shop.Report/definition';

const salesTmdl = ({ total = 'SUM(Sales[Amount])', format = '$#,##0', noTotal = false, region = true } = {}) => [
  'table Sales',
  '\tcolumn Amount',
  '\t\tdataType: decimal',
  '\t\tsourceColumn: Amount',
  '\tcolumn ProductID',
  '\t\tdataType: int64',
  '\t\tsourceColumn: ProductID',
  ...(region ? ['\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region'] : []),
  "\tcolumn 'Big Sale' = IF(Sales[Amount] > [Total Sales], 1, 0)",
  '\t\tdataType: int64',
  ...(noTotal ? [] : [`\tmeasure 'Total Sales' = ${total}`, `\t\tformatString: ${format}`]),
  "\tmeasure Margin = [Total Sales] * 0.3",
  "\tmeasure 'Margin %' = DIVIDE([Margin], [Total Sales])",
  "\tmeasure Unrelated = COUNTROWS(Sales)",
].join('\n') + '\n';

const productsTmdl = 'table Products\n\tcolumn ProductID\n\t\tdataType: int64\n\t\tsourceColumn: ProductID\n';
const relTmdl = 'relationship r1\n\tfromColumn: Sales.ProductID\n\ttoColumn: Products.ProductID\n';
const roleTmdl = "role Managers\n\tmodelPermission: read\n\n\ttablePermission Sales = [Margin] > 0 && 'Sales'[Region] = \"West\"\n";
const paramTmdl = [
  'table Metric',
  "\tcolumn Metric",
  '\t\tdataType: string',
  '\tpartition Metric = calculated',
  '\t\tmode: import',
  "\t\tsource = {(\"Margin\", NAMEOF('Sales'[Margin]), 0)}",
].join('\n') + '\n';

const field = (kind, table, prop) => ({ [kind]: { Expression: { SourceRef: { Entity: table } }, Property: prop } });
const visual = (name, measure, extra = {}) => JSON.stringify({
  name,
  visual: { visualType: 'card', query: { queryState: { Values: { projections: [{ field: field(...measure) }] } } } },
  ...extra,
});

function files(sales = {}, extra = {}) {
  const f = {
    [`${M}/tables/Sales.tmdl`]: salesTmdl(sales),
    [`${M}/tables/Products.tmdl`]: productsTmdl,
    [`${M}/tables/Metric.tmdl`]: paramTmdl,
    [`${M}/relationships.tmdl`]: relTmdl,
    [`${M}/roles/Managers.tmdl`]: roleTmdl,
    'Shop.Report/definition.pbir': JSON.stringify({ datasetReference: { byPath: { path: '../Shop.SemanticModel' } } }),
    [`${R}/pages/p1/page.json`]: JSON.stringify({ name: 'p1', displayName: 'Overview' }),
    [`${R}/pages/p1/visuals/total/visual.json`]: visual('total', ['Measure', 'Sales', 'Total Sales']),
    [`${R}/pages/p1/visuals/pct/visual.json`]: visual('pct', ['Measure', 'Sales', 'Margin %'], {
      filterConfig: { filters: [{ name: 'f1', type: 'Advanced', field: field('Measure', 'Sales', 'Margin') }] },
    }),
    [`${R}/pages/p1/visuals/param/visual.json`]: visual('param', ['Column', 'Metric', 'Metric']),
    ...extra,
  };
  for (const k of Object.keys(f)) if (f[k] === null) delete f[k];
  return new Map(Object.entries(f));
}

const record = (res, group, change, name) => res.records.find(r => r.group === group && r.change === change && (!name || r.name === name));
const labels = (impact, key) => (impact.groups.find(g => g.key === key)?.items || []).map(i => i.label);

describe('Dependency effects — deleted measure', () => {
  const res = compareFileMaps(files(), files({ noTotal: true }));
  const m = record(res, 'measure', 'removed', 'Total Sales');

  it('breaks, and is flagged as still referenced', () => {
    expect(m.impact.severity).toBe('breaks');
    expect(m.flags.broken).toBe(true);
    expect(m.impact.headline).toMatch(/^Breaks /);
  });

  it('lists downstream measures, including indirect ones', () => {
    expect(labels(m.impact, 'measure').sort()).toEqual(['Sales[Margin %]', 'Sales[Margin]']);
  });

  it('lists visuals that use it directly and through other measures', () => {
    const visuals = m.impact.groups.find(g => g.key === 'visual').items;
    expect(visuals.map(v => v.label).join(' ')).toContain('total');
    expect(visuals.map(v => v.label).join(' ')).toContain('pct');
    expect(visuals.find(v => v.label.includes('pct')).via).toMatch(/\[Margin/);
    expect(visuals.every(v => v.effect === 'Will show an error')).toBe(true);
  });

  it('includes measure filters, RLS roles, calculated columns and field parameters', () => {
    expect(labels(m.impact, 'filter')[0]).toContain('Visual filter');
    expect(labels(m.impact, 'security')[0]).toContain('Managers');
    expect(m.flags.security).toBe(true);
    expect(labels(m.impact, 'column')).toEqual(['Sales[Big Sale]']);
    expect(labels(m.impact, 'table')[0]).toContain('Metric (field parameter)');
    // The field-parameter visual breaks through the parameter table.
    expect(labels(m.impact, 'visual').join(' ')).toContain('param');
  });
});

describe('Dependency effects — edited measure', () => {
  it('changes values downstream but breaks nothing', () => {
    const res = compareFileMaps(files(), files({ total: 'SUM(Sales[Amount]) * 1.1' }));
    const m = record(res, 'measure', 'changed', 'Total Sales');
    expect(m.impact.severity).toBe('changes');
    expect(m.flags.broken).toBe(false);
    expect(m.impact.headline).toContain('nothing breaks');
    expect(m.impact.groups.find(g => g.key === 'visual').items[0].effect).toBe('Values may change');
  });

  it('a format-only edit has no dependency effects', () => {
    const res = compareFileMaps(files(), files({ format: '0.0' }));
    expect(record(res, 'measure', 'changed', 'Total Sales').impact).toBeUndefined();
  });
});

describe('Dependency effects — columns and tables', () => {
  it('a deleted column breaks the RLS filter that uses it', () => {
    const res = compareFileMaps(files(), files({ region: false }));
    const c = record(res, 'column', 'removed', 'Region');
    expect(c.impact.severity).toBe('breaks');
    expect(labels(c.impact, 'security')[0]).toContain('Managers');
  });

  it('a deleted table breaks the relationship to it', () => {
    const res = compareFileMaps(files(), files({}, { [`${M}/tables/Products.tmdl`]: null }));
    const t = record(res, 'table', 'removed', 'Products');
    expect(labels(t.impact, 'relationship')[0]).toContain('Sales[ProductID] → Products[ProductID]');
  });
});

describe('Dependency effects — model boundaries and moves', () => {
  it('a measure moved to another table breaks nothing', () => {
    const otherTmdl = "table Other\n\tcolumn X\n\t\tdataType: int64\n\tmeasure 'Total Sales' = SUM(Sales[Amount])\n";
    const res = compareFileMaps(files(), files({ noTotal: true }, { [`${M}/tables/Other.tmdl`]: otherTmdl }));
    const m = record(res, 'measure', 'removed', 'Total Sales');
    expect(m.impact.severity).toBe('none');
    expect(m.impact.note).toContain('Other');
    expect(m.flags.broken).toBe(false);
  });

  it('only counts reports bound to the same model', () => {
    // A second report on a second model shows its own [Total Sales].
    const second = {
      'Other.SemanticModel/definition/tables/Sales.tmdl': "table Sales\n\tcolumn Amount\n\t\tdataType: decimal\n\tmeasure 'Total Sales' = SUM(Sales[Amount])\n",
      'Other.Report/definition.pbir': JSON.stringify({ datasetReference: { byPath: { path: '../Other.SemanticModel' } } }),
      'Other.Report/definition/pages/p9/page.json': JSON.stringify({ name: 'p9', displayName: 'Elsewhere' }),
      'Other.Report/definition/pages/p9/visuals/v9/visual.json': visual('v9', ['Measure', 'Sales', 'Total Sales']),
    };
    const res = compareFileMaps(files({}, second), files({ noTotal: true }, second));
    const m = record(res, 'measure', 'removed', 'Total Sales');
    expect(labels(m.impact, 'visual').join(' ')).not.toContain('Elsewhere');
  });
});
