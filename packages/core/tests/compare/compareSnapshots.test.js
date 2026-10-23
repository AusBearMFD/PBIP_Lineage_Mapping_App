import { describe, it, expect } from 'vitest';
import { compareFileMaps, groupCompareRecords, COMPARE_GROUPS, describeFilterCondition } from '../../src/index.js';

// --- Fixture builder -----------------------------------------------------------
// A small but complete PBIP repo: one semantic model and one report.

const M = 'Shop.SemanticModel/definition';
const R = 'Shop.Report/definition';

const salesTmdl = (opts = {}) => [
  'table Sales',
  '\tcolumn Amount',
  `\t\tdataType: ${opts.amountType || 'decimal'}`,
  '\t\tsourceColumn: Amount',
  '\tcolumn Quantity',
  '\t\tdataType: int64',
  '\t\tsourceColumn: Quantity',
  ...(opts.noRegion ? [] : ['\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region']),
  `\tmeasure '${opts.totalName || 'Total Sales'}' = ${opts.totalDax || 'SUM(Sales[Amount])'}`,
  `\t\tformatString: ${opts.totalFormat || '$#,##0'}`,
  ...(opts.noUnused ? [] : ["\tmeasure 'Unused' = COUNTROWS(Sales)"]),
  ...(opts.extraMeasure ? [`\tmeasure 'Margin' = [${opts.totalName || 'Total Sales'}] * 0.3`] : []),
  '\tpartition Sales = m',
  `\t\tmode: ${opts.mode || 'import'}`,
  '\t\tsource =',
  '\t\t\tlet',
  `\t\t\t\tSource = Sql.Database("${opts.server || 'sql01'}", "Shop"),`,
  '\t\t\t\tSales = Source{[Schema="dbo",Item="Sales"]}[Data]',
  '\t\t\tin',
  '\t\t\t\tSales',
].join('\n') + '\n';

const productsTmdl = 'table Products\n\tcolumn ProductID\n\t\tdataType: int64\n\t\tsourceColumn: ProductID\n\tcolumn Category\n\t\tdataType: string\n\t\tsourceColumn: Category\n';
const budgetTmdl = "table Budget\n\tcolumn Target\n\t\tdataType: decimal\n\t\tsourceColumn: Target\n\tmeasure 'Budget Total' = SUM(Budget[Target])\n";

const relTmdl = (opts = {}) => [
  'relationship rel-sales-products',
  '\tfromColumn: Sales.ProductID',
  '\ttoColumn: Products.ProductID',
  ...(opts.inactive ? ['\tisActive: false'] : []),
  ...(opts.both ? ['\tcrossFilteringBehavior: bothDirections'] : []),
  ...(opts.secBoth ? ['\tsecurityFilteringBehavior: bothDirections'] : []),
  ...(opts.extra ? ['', 'relationship rel-sales-budget', '\tfromColumn: Sales.Region', '\ttoColumn: Budget.Region'] : []),
].join('\n') + '\n';

const roleTmdl = (filter) => `role 'Regional Manager'\n\tmodelPermission: read\n\n\ttablePermission Sales = ${filter}\n`;

const pageJson = (name, filters) => JSON.stringify({ name: 'p1', displayName: name, ...(filters ? { filterConfig: { filters } } : {}) });

const field = (kind, table, prop) => ({ [kind]: { Expression: { SourceRef: { Entity: table } }, Property: prop } });
const agg = (table, prop, fn = 0) => ({ Aggregation: { Expression: field('Column', table, prop), Function: fn } });

const visualJson = ({ title, type = 'clusteredColumnChart', values = [field('Measure', 'Sales', 'Total Sales')], category, filters }) => JSON.stringify({
  name: 'v1',
  visual: {
    visualType: type,
    query: { queryState: {
      ...(category ? { Category: { projections: [{ field: category }] } } : {}),
      Y: { projections: values.map(f => ({ field: f })) },
    } },
    ...(title !== undefined ? { visualContainerObjects: { title: [{ properties: {
      show: { expr: { Literal: { Value: 'true' } } },
      text: { expr: { Literal: { Value: `'${title}'` } } },
      fontColor: { solid: { color: '#333333' } },
    } }] } } : {}),
  },
  ...(filters ? { filterConfig: { filters } } : {}),
});

const between = (lo, hi) => ({ name: 'amt', type: 'Advanced', field: field('Column', 'Sales', 'Amount'),
  filter: { Version: 2, From: [{ Name: 's', Entity: 'Sales', Type: 0 }], Where: [{ Condition: { Between: {
    Expression: { Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Amount' } },
    LowerBound: { Literal: { Value: `${lo}D` } }, UpperBound: { Literal: { Value: `${hi}D` } } } } }] } });

const bookmarkJson = (name, page = 'p1', state = {}) => JSON.stringify({ displayName: name, name: 'b1', explorationState: { activeSection: page, ...state } });

function baseFiles(overrides = {}) {
  const files = {
    [`${M}/tables/Sales.tmdl`]: salesTmdl(),
    [`${M}/tables/Products.tmdl`]: productsTmdl,
    [`${M}/relationships.tmdl`]: relTmdl(),
    [`${M}/roles/Regional Manager.tmdl`]: roleTmdl("'Sales'[Region] = \"West\""),
    [`${R}/../definition.pbir`.replace('/definition/../', '/')]: JSON.stringify({ datasetReference: { byPath: { path: '../Shop.SemanticModel' } } }),
    [`${R}/pages/p1/page.json`]: pageJson('Overview'),
    [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'Sales by Category', category: field('Column', 'Products', 'Category') }),
    [`${R}/bookmarks/b1.bookmark.json`]: bookmarkJson('West view'),
    ...overrides,
  };
  for (const k of Object.keys(files)) if (files[k] === null) delete files[k];
  return new Map(Object.entries(files));
}

function compare(afterOverrides, beforeOverrides = {}) {
  return compareFileMaps(baseFiles(beforeOverrides), baseFiles(afterOverrides));
}
const find = (res, group, change) => res.records.filter(r => r.group === group && (!change || r.change === change));
const prop = (rec, label) => rec?.props.find(p => p.label === label);

// --- Tests --------------------------------------------------------------------

describe('compareSnapshots — no change', () => {
  it('reports nothing for identical snapshots', () => {
    expect(compare({}).records).toEqual([]);
  });
});

describe('Modified / Commit Edits', () => {
  it('measure DAX edited, with format string and where it is shown', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ totalDax: 'SUM(Sales[Amount]) * 2', totalFormat: '#,##0' }) });
    const [m] = find(res, 'measure', 'changed');
    expect(m.section).toBe('modified');
    expect(prop(m, 'DAX')).toMatchObject({ before: 'SUM(Sales[Amount])', after: 'SUM(Sales[Amount]) * 2', kind: 'dax' });
    expect(prop(m, 'Format String')).toMatchObject({ before: '$#,##0', after: '#,##0' });
    expect(m.impact.severity).toBe('changes');
    expect(m.impact.groups.find(g => g.key === 'visual').items[0].label).toContain('Sales by Category');
  });

  it('measure rename is one "renamed" record, not a removal plus an addition', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ totalName: 'Revenue' }) });
    const [m] = find(res, 'measure');
    expect(find(res, 'measure')).toHaveLength(1);
    expect(m.change).toBe('renamed');
    expect(prop(m, 'Name')).toMatchObject({ before: 'Total Sales', after: 'Revenue' });
    // The visual still binds the old name, so it is flagged as broken.
    expect(m.flags.broken).toBe(true);
  });

  it('deleted measure that nothing uses is not flagged', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ noUnused: true }) });
    const [m] = find(res, 'measure', 'removed');
    expect(m.name).toBe('Unused');
    expect(m.flags.broken).toBe(false);
  });

  it('deleted measure still bound to a visual is flagged as still referenced', () => {
    const noTotal = salesTmdl().replace(/\tmeasure 'Total Sales'.*\n\t\tformatString: .*\n/, '');
    const res = compare({ [`${M}/tables/Sales.tmdl`]: noTotal });
    const [m] = find(res, 'measure', 'removed');
    expect(m.name).toBe('Total Sales');
    expect(m.flags.broken).toBe(true);
    expect(m.impact.groups.find(g => g.key === 'visual').items[0].label).toContain('Sales by Category');
  });

  it('deleted table lists its contents and what still references it', () => {
    const res = compare({ [`${M}/tables/Products.tmdl`]: null });
    const [t] = find(res, 'table', 'removed');
    expect(t.section).toBe('modified');
    expect(prop(t, 'Columns').before).toEqual(['ProductID', 'Category']);
    expect(t.flags.broken).toBe(true);
    expect(t.impact.groups.find(g => g.key === 'visual').items[0].label).toContain('Sales by Category');
  });

  it('a commit whose only change is a deleted table file is still detected (full snapshots)', () => {
    const before = baseFiles({ [`${M}/tables/Budget.tmdl`]: budgetTmdl });
    const res = compareFileMaps(before, baseFiles());
    expect(find(res, 'table', 'removed').map(r => r.name)).toEqual(['Budget']);
  });

  it('relationship isActive, cross-filter and security direction changes', () => {
    const res = compare({ [`${M}/relationships.tmdl`]: relTmdl({ inactive: true, both: true, secBoth: true }) });
    const [r] = find(res, 'relationship', 'changed');
    expect(r.name).toBe('Sales[ProductID] → Products[ProductID]');
    expect(prop(r, 'Active')).toMatchObject({ before: 'Yes', after: 'No' });
    expect(prop(r, 'Cross-filter direction')).toMatchObject({ before: 'oneDirection', after: 'bothDirections' });
    expect(r.flags.security).toBe(true);
  });

  it('deleted relationship', () => {
    const res = compare({ [`${M}/relationships.tmdl`]: null });
    expect(find(res, 'relationship', 'removed')).toHaveLength(1);
  });

  it('visual swaps an aggregated column (Sum of Amount -> Sum of Quantity)', () => {
    const before = { [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'T', values: [agg('Sales', 'Amount')] }) };
    const after = { [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'T', values: [agg('Sales', 'Quantity')] }) };
    const res = compare(after, before);
    const [v] = find(res, 'visual', 'changed');
    expect(prop(v, 'Fields')).toMatchObject({ before: ['Y: Sum of Sales[Amount]'], after: ['Y: Sum of Sales[Quantity]'] });
  });

  it('aggregation function change (Sum -> Average) is detected', () => {
    const before = { [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'T', values: [agg('Sales', 'Amount', 0)] }) };
    const after = { [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'T', values: [agg('Sales', 'Amount', 1)] }) };
    expect(prop(find(compare(after, before), 'visual')[0], 'Fields').after).toEqual(['Y: Average of Sales[Amount]']);
  });

  it('visual title text change, with the page display name as location', () => {
    const res = compare({ [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'Revenue by Category', category: field('Column', 'Products', 'Category') }) });
    const [v] = find(res, 'visual', 'changed');
    expect(prop(v, 'Title')).toMatchObject({ before: 'Sales by Category', after: 'Revenue by Category' });
    expect(v.location.page).toBe('Overview');
    expect(v.location.report).toBe('Shop');
  });

  it('visual title formatting alone is ignored', () => {
    const restyled = JSON.parse(visualJson({ title: 'Sales by Category', category: field('Column', 'Products', 'Category') }));
    restyled.visual.visualContainerObjects.title[0].properties.fontColor = { solid: { color: '#ff0000' } };
    restyled.position = { x: 50, y: 50 };
    expect(compare({ [`${R}/pages/p1/visuals/v1/visual.json`]: JSON.stringify(restyled) }).records).toEqual([]);
  });

  it('visual type change', () => {
    const res = compare({ [`${R}/pages/p1/visuals/v1/visual.json`]: visualJson({ title: 'Sales by Category', type: 'lineChart', category: field('Column', 'Products', 'Category') }) });
    expect(prop(find(res, 'visual')[0], 'Type')).toMatchObject({ before: 'Clustered column chart', after: 'Line chart' });
  });

  it('filter BETWEEN bounds change', () => {
    const res = compare(
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 500)]) },
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 100)]) },
    );
    const [f] = find(res, 'filter', 'changed');
    expect(prop(f, 'Condition')).toMatchObject({ before: 'Sales[Amount] between 0 and 100', after: 'Sales[Amount] between 0 and 500' });
    expect(f.location.page).toBe('Overview');
  });

  it('a filter removed and re-added on the same field reads as one edit, not delete + add', () => {
    const renamed = { ...between(0, 500), name: 'brand-new-guid' };
    const res = compare(
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [renamed]) },
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 100)]) },
    );
    const filters = find(res, 'filter');
    expect(filters).toHaveLength(1);
    expect(filters[0].change).toBe('changed');
  });

  it('a filter re-created with the same condition produces no record at all', () => {
    const res = compare(
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [{ ...between(0, 100), name: 'new-guid' }]) },
      { [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 100)]) },
    );
    expect(find(res, 'filter')).toHaveLength(0);
  });

  it('every record id is unique', () => {
    const res = compare({
      [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 5), { ...between(0, 9), name: 'second', field: field('Column', 'Sales', 'Quantity') }]),
      [`${M}/tables/Budget.tmdl`]: budgetTmdl,
    });
    const ids = res.records.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('page rename', () => {
    const res = compare({ [`${R}/pages/p1/page.json`]: pageJson('Sales Overview') });
    const [p] = find(res, 'page');
    expect(p.change).toBe('renamed');
    expect(prop(p, 'Name')).toMatchObject({ before: 'Overview', after: 'Sales Overview' });
  });

  it('RLS filter change is flagged as security', () => {
    const res = compare({ [`${M}/roles/Regional Manager.tmdl`]: roleTmdl("'Sales'[Region] = \"East\"") });
    const [r] = find(res, 'role', 'changed');
    expect(r.flags.security).toBe(true);
    expect(prop(r, 'Filter on Sales').after).toContain('East');
  });

  it('a column used by an RLS rule is flagged as security when it changes', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ noRegion: true }) });
    const [c] = find(res, 'column', 'removed');
    expect(c.name).toBe('Region');
    expect(c.flags.security).toBe(true);
  });

  it('column data type change and column deletion', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ amountType: 'double', noRegion: true }) });
    expect(prop(find(res, 'column', 'changed')[0], 'Data type')).toMatchObject({ before: 'decimal', after: 'double' });
    expect(find(res, 'column', 'removed')[0].name).toBe('Region');
  });

  it('table data source and storage mode change', () => {
    const res = compare({ [`${M}/tables/Sales.tmdl`]: salesTmdl({ server: 'sql02', mode: 'directQuery' }) });
    const [d] = find(res, 'dataSource');
    expect(prop(d, 'Storage mode')).toMatchObject({ before: 'Import', after: 'DirectQuery' });
    expect(prop(d, 'Source').after).toContain('sql02');
    expect(prop(d, 'Power Query').kind).toBe('m');
  });

  it('bookmark change', () => {
    const res = compare({ [`${R}/bookmarks/b1.bookmark.json`]: bookmarkJson('West region', 'p1', { filters: { byName: { x: 1 } } }) });
    const [b] = find(res, 'bookmark');
    expect(b.change).toBe('renamed');
    // byName state isn't something we interpret, so it's reported generically.
    expect(prop(b, 'Other captured state').after).toMatch(/^Updated/);
  });

  it('report re-pointed to a different semantic model', () => {
    const pbir = 'Shop.Report/definition.pbir';
    const res = compare({ [pbir]: JSON.stringify({ datasetReference: { byPath: { path: '../Other.SemanticModel' } } }) });
    expect(prop(find(res, 'report')[0], 'Bound to model')).toMatchObject({ after: '../Other.SemanticModel' });
  });
});

describe('Additions', () => {
  it('new table lists its columns and measures in one record', () => {
    const res = compare({ [`${M}/tables/Budget.tmdl`]: budgetTmdl });
    const [t] = find(res, 'table', 'added');
    expect(t.section).toBe('additions');
    expect(prop(t, 'Measures').after).toEqual(['Budget Total']);
    expect(find(res, 'measure')).toHaveLength(0); // not repeated separately
  });

  it('a commit whose only change is a new table file is detected (full snapshots)', () => {
    const res = compareFileMaps(baseFiles(), baseFiles({ [`${M}/tables/Budget.tmdl`]: budgetTmdl }));
    expect(find(res, 'table', 'added').map(r => r.name)).toEqual(['Budget']);
  });

  it('new measure, column, relationship, role, page, visual, bookmark, report', () => {
    const res = compare({
      [`${M}/tables/Sales.tmdl`]: salesTmdl({ extraMeasure: true }),
      [`${M}/relationships.tmdl`]: relTmdl({ extra: true }),
      [`${M}/roles/Auditor.tmdl`]: "role Auditor\n\tmodelPermission: read\n",
      [`${R}/pages/p2/page.json`]: JSON.stringify({ displayName: 'Returns' }),
      [`${R}/pages/p2/visuals/v9/visual.json`]: visualJson({ title: 'Returns card', type: 'card' }),
      [`${R}/pages/p1/visuals/v2/visual.json`]: visualJson({ title: 'New KPI', type: 'kpi' }),
      [`${R}/bookmarks/b2.bookmark.json`]: bookmarkJson('East view'),
      ['Finance.Report/definition.pbir']: JSON.stringify({ datasetReference: { byPath: { path: '../Shop.SemanticModel' } } }),
      ['Finance.Report/definition/pages/f1/page.json']: JSON.stringify({ displayName: 'Finance' }),
    });
    const added = (g) => find(res, g, 'added').map(r => r.name);
    expect(added('measure')).toEqual(['Margin']);
    expect(added('relationship')).toEqual(['Sales[Region] → Budget[Region]']);
    expect(added('role')).toEqual(['Auditor']);
    expect(find(res, 'role', 'added')[0].flags.security).toBe(true);
    expect(added('page')).toEqual(['Returns']);
    expect(prop(find(res, 'page', 'added')[0], 'Visuals').after).toEqual(['Returns card (Card · v9)']);
    expect(added('visual')).toEqual(['New KPI']); // the new page's visual is listed inside the page instead
    expect(added('bookmark')).toEqual(['East view']);
    expect(added('report')).toEqual(['Finance']);
    expect(res.records.filter(r => r.change === 'added').every(r => r.section === 'additions')).toBe(true);
  });

  it('new page and visual filters', () => {
    const res = compare({ [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 100)]) });
    const [f] = find(res, 'filter', 'added');
    expect(f.section).toBe('additions');
    expect(prop(f, 'Condition').after).toBe('Sales[Amount] between 0 and 100');
  });
});

describe('visual identity and copies', () => {
  const V2 = `${R}/pages/p1/visuals/v2/visual.json`;
  const V1 = `${R}/pages/p1/visuals/v1/visual.json`;

  it('matches visuals by ID, so a retitled visual with new fields is one edit', () => {
    const res = compare({ [V1]: visualJson({ title: 'Totally different', values: [field('Measure', 'Sales', 'Unused')] }) });
    const visuals = find(res, 'visual');
    expect(visuals).toHaveLength(1);
    expect(visuals[0].change).toBe('changed');
    expect(visuals[0].objectId).toBe('v1');
    expect(visuals[0].subtype).toBe('Clustered column chart');
  });

  it('two visuals with the same title stay separate records with different IDs', () => {
    const res = compare({ [V2]: visualJson({ title: 'Sales by Category', values: [field('Measure', 'Sales', 'Unused')] }) });
    const [added] = find(res, 'visual', 'added');
    expect(added.objectId).toBe('v2');
    expect(added.id).not.toBe(find(compare({ [V1]: visualJson({ title: 'x' }) }), 'visual')[0].id);
  });

  it('flags an added visual identical to an existing one as a likely copy', () => {
    const res = compare({ [V2]: visualJson({ title: 'Sales by Category', category: field('Column', 'Products', 'Category') }) });
    const [added] = find(res, 'visual', 'added');
    expect(added.flags.copy).toBe(true);
    expect(added.context[0]).toMatchObject({ label: 'Looks like a copy of' });
    expect(added.context[0].value[0]).toContain('v1');
  });

  it('flags a same-titled visual with different fields as an edited copy', () => {
    const res = compare({ [V2]: visualJson({ title: 'Sales by Category', values: [field('Measure', 'Sales', 'Unused')] }) });
    expect(find(res, 'visual', 'added')[0].context[0].label).toBe('Looks like an edited copy of');
  });

  it('flags a re-created visual whose original was deleted in the same commit', () => {
    const res = compare({ [V1]: null, [V2]: visualJson({ title: 'Sales by Category', category: field('Column', 'Products', 'Category') }) });
    const [added] = find(res, 'visual', 'added');
    expect(added.context[0].value[0]).toContain('deleted in this commit');
  });

  it('does not flag unrelated new visuals', () => {
    const res = compare({ [V2]: visualJson({ title: 'Brand new', values: [field('Measure', 'Sales', 'Unused')] }) });
    expect(find(res, 'visual', 'added')[0].flags.copy).toBe(false);
  });
});

describe('bookmark effect', () => {
  const B1 = `${R}/bookmarks/b1.bookmark.json`;
  const V2 = `${R}/pages/p1/visuals/v2/visual.json`;
  const hiddenCard = JSON.stringify({ ...JSON.parse(visualJson({ title: 'Detail card', type: 'card' })), name: 'v2', isHidden: true });
  const slicer = (value) => JSON.stringify({ name: 'v3', visual: { visualType: 'slicer', title: 'Region',
    query: { queryState: { Values: { projections: [{ field: field('Column', 'Sales', 'Region') }] } } },
    ...(value ? { objects: { general: [{ properties: { filter: { filter: { Version: 2, From: [{ Name: 's', Entity: 'Sales', Type: 0 }],
      Where: [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Region' } }], Values: [[{ Literal: { Value: `'${value}'` } }]] } } }] } } } }] } } : {}) } });
  const regionIn = (value) => ({ Version: 2, From: [{ Name: 's', Entity: 'Sales', Type: 0 }],
    Where: [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Region' } }], Values: [[{ Literal: { Value: `'${value}'` } }]] } } }] });

  const bookmark = (options = {}) => JSON.stringify({
    displayName: 'Focus view', name: 'b1',
    options,
    explorationState: {
      activeSection: 'p1',
      sections: { p1: {
        filters: { byExpr: [{ name: 'amt', expression: field('Column', 'Sales', 'Amount'), filter: between(0, 50).filter }] },
        visualContainers: {
          v1: { singleVisual: { visualType: 'clusteredColumnChart', display: { mode: 'hidden' } },
            filters: { byExpr: [{ name: 'vf', expression: field('Column', 'Sales', 'Region'), filter: regionIn('West') }] } },
          v2: { singleVisual: { visualType: 'card' } },
          v3: { singleVisual: { visualType: 'slicer', objects: { general: [{ properties: { filter: { filter: regionIn('East') } } }] } } },
        },
      } },
    },
  });

  const files = (bm) => ({
    [`${R}/pages/p1/page.json`]: pageJson('Overview', [between(0, 100)]),
    [V2]: hiddenCard,
    [`${R}/pages/p1/visuals/v3/visual.json`]: slicer(null),
    [B1]: bm,
  });

  it('lists hidden/shown visuals and filter/slicer changes versus the page default', () => {
    const res = compare(files(bookmark()), files(bookmarkJson('West view')));
    const [b] = find(res, 'bookmark');
    const e = b.effect;
    expect(e.pageName).toBe('Overview');
    expect(e.hidden).toEqual(['Sales by Category (Clustered column chart · v1)']);
    expect(e.shown).toEqual(['Detail card (Card · v2)']);
    expect(e.pageFilters).toEqual([expect.objectContaining({ field: 'Sales[Amount]', default: 'Sales[Amount] between 0 and 100', bookmark: 'Sales[Amount] between 0 and 50' })]);
    expect(e.visualFilters).toEqual([expect.objectContaining({ field: 'Sales[Region]', bookmark: 'Sales[Region] is West', notInPane: true })]);
    expect(e.slicers).toEqual([expect.objectContaining({ default: 'Nothing selected', bookmark: 'Sales[Region] is East' })]);
    expect(e.captures).toEqual({ data: true, display: true, currentPage: true });
    // The change list shows what the bookmark now does differently.
    expect(prop(b, 'Hides').after).toEqual(['Sales by Category (Clustered column chart · v1)']);
  });

  it('reports what is captured, so filters can be shown as not applied when Data is off', () => {
    const res = compare(files(bookmark({ suppressData: true })), files(bookmarkJson('West view')));
    expect(find(res, 'bookmark')[0].effect.captures.data).toBe(false);
  });

  it('limits the effect to the selected visuals when the bookmark targets them', () => {
    const res = compare(files(bookmark({ applyOnlyToTargetVisuals: true, targetVisualNames: ['v2'] })), files(bookmarkJson('West view')));
    const e = find(res, 'bookmark')[0].effect;
    expect(e.scope).toBe('1 selected visual');
    expect(e.hidden).toEqual([]);
    expect(e.shown).toEqual(['Detail card (Card · v2)']);
  });

  it('new bookmarks carry their effect too', () => {
    const res = compare({ ...files(bookmark()), [`${R}/bookmarks/b9.bookmark.json`]: bookmark() }, files(bookmark()));
    const [added] = find(res, 'bookmark', 'added');
    expect(added.objectId).toBe('b9');
    expect(added.effect.hidden).toHaveLength(1);
  });

  it('group visibility', () => {
    const group = JSON.stringify({ name: 'g1', visualGroup: { displayName: 'Details group' } });
    const bm = JSON.stringify({ displayName: 'Hide group', explorationState: { activeSection: 'p1', sections: { p1: { visualContainerGroups: { g1: { isHidden: true } } } } } });
    const res = compare({ [`${R}/pages/p1/visuals/g1/visual.json`]: group, [B1]: bm }, { [`${R}/pages/p1/visuals/g1/visual.json`]: group });
    expect(find(res, 'bookmark')[0].effect.groupsHidden).toEqual(['Details group (Group · g1)']);
  });
});

describe('helpers', () => {
  it('groups records in display order', () => {
    const res = compare({ [`${M}/tables/Budget.tmdl`]: budgetTmdl, [`${M}/relationships.tmdl`]: relTmdl({ inactive: true }) });
    const order = COMPARE_GROUPS.map(g => g.key);
    const keys = groupCompareRecords(res.records).map(g => g.key);
    expect(keys).toEqual([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(groupCompareRecords(res.records, 'additions').map(g => g.key)).toEqual(['table']);
  });

  it('describes common filter conditions readably', () => {
    const where = (Condition) => ({ Where: [{ Condition }] });
    const col = { Column: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Region' } };
    expect(describeFilterCondition(where({ In: { Expressions: [col], Values: [[{ Literal: { Value: "'West'" } }]] } }))).toBe('Sales[Region] is West');
    expect(describeFilterCondition(where({ Not: { Expression: { In: { Expressions: [col], Values: [[{ Literal: { Value: "'West'" } }]] } } } }))).toBe('not (Sales[Region] is West)');
    expect(describeFilterCondition(where({ Comparison: { ComparisonKind: 2, Left: col, Right: { Literal: { Value: '10L' } } } }))).toBe('Sales[Region] >= 10');
    expect(describeFilterCondition({})).toBe('');
  });
});
