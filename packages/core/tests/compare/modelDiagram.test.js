import { describe, it, expect } from 'vitest';
import { buildSnapshot, modelDiagramData, diffModelDiagram, summarizeDiagramDiff, layoutModelDiagram } from '../../src/index.js';

const M = 'Shop.SemanticModel/definition';
const table = (name, cols, measures = []) => `table ${name}\n` +
  cols.map(([c, t]) => `\tcolumn ${c}\n\t\tdataType: ${t}\n\t\tsourceColumn: ${c}\n`).join('') +
  measures.map(m => `\tmeasure ${m} = 1\n`).join('');
const rel = (name, from, to, extra = []) => [`relationship ${name}`, `\tfromColumn: ${from}`, `\ttoColumn: ${to}`, ...extra].join('\n');

function model(files) {
  return [...buildSnapshot(new Map(Object.entries(files))).models.values()][0];
}

const before = model({
  [`${M}/tables/Sales.tmdl`]: table('Sales', [['ProductID', 'int64'], ['DateKey', 'int64'], ['Amount', 'decimal']], ['Total']),
  [`${M}/tables/Products.tmdl`]: table('Products', [['ProductID', 'int64'], ['Category', 'string']]),
  [`${M}/tables/Date.tmdl`]: table('Date', [['DateKey', 'int64']]),
  [`${M}/tables/Legacy.tmdl`]: table('Legacy', [['X', 'string']]),
  [`${M}/relationships.tmdl`]: [
    rel('r-prod', 'Sales.ProductID', 'Products.ProductID'),
    rel('r-date', 'Sales.DateKey', 'Date.DateKey'),
  ].join('\n\n') + '\n',
});
const after = model({
  [`${M}/tables/Sales.tmdl`]: table('Sales', [['ProductID', 'int64'], ['DateKey', 'string'], ['Region', 'string']], ['Total', 'Margin']),
  [`${M}/tables/Products.tmdl`]: table('Products', [['ProductID', 'int64'], ['Category', 'string']]),
  [`${M}/tables/Date.tmdl`]: table('Date', [['DateKey', 'int64']]),
  [`${M}/tables/Region.tmdl`]: table('Region', [['Region', 'string']]),
  [`${M}/relationships.tmdl`]: [
    rel('r-prod', 'Sales.ProductID', 'Products.ProductID', ['\tcrossFilteringBehavior: bothDirections']),
    rel('r-date', 'Sales.DateKey', 'Date.DateKey', ['\tisActive: false']),
    rel('r-region', 'Sales.Region', 'Region.Region'),
  ].join('\n\n') + '\n',
});

describe('modelDiagramData', () => {
  it('lists tables with their relationship key columns', () => {
    const d = modelDiagramData(before);
    expect(d.tables.map(t => t.name).sort()).toEqual(['Date', 'Legacy', 'Products', 'Sales']);
    expect(d.tables.find(t => t.name === 'Sales').keyColumns.sort()).toEqual(['DateKey', 'ProductID']);
    expect(d.relationships).toHaveLength(2);
  });
});

describe('diffModelDiagram', () => {
  const diff = diffModelDiagram(before, after);
  const t = (name) => diff.tables.find(x => x.name === name);
  const r = (name) => diff.relationships.find(x => x.name === name);

  it('tags added, removed, changed, and unchanged tables', () => {
    expect(t('Region').status).toBe('added');
    expect(t('Legacy').status).toBe('removed');
    expect(t('Sales').status).toBe('changed');
    expect(t('Products').status).toBe('unchanged');
  });

  it('lists column and measure changes inside a changed table', () => {
    const sales = t('Sales');
    expect(sales.columnChanges).toEqual(expect.arrayContaining([
      { name: 'Amount', status: 'removed', detail: 'decimal' },
      { name: 'Region', status: 'added', detail: 'string' },
      { name: 'DateKey', status: 'changed', detail: 'int64 → string' },
    ]));
    expect(sales.measureChanges.added).toEqual(['Margin']);
  });

  it('describes how each relationship changed', () => {
    expect(r('r-region').status).toBe('added');
    expect(r('r-date').changes).toEqual([{ label: 'Active', before: 'Yes', after: 'No' }]);
    expect(r('r-prod').changes).toEqual([{ label: 'Cross-filter direction', before: 'Single', after: 'Both' }]);
    const s = summarizeDiagramDiff(diff);
    expect(s).toMatchObject({ tablesAdded: 1, tablesRemoved: 1, relsAdded: 1, relsChanged: 2, relsDeactivated: 1 });
  });

  it('a relationship deleted and re-created with a new name is one relationship', () => {
    const recreated = model({
      [`${M}/tables/Sales.tmdl`]: table('Sales', [['ProductID', 'int64']]),
      [`${M}/tables/Products.tmdl`]: table('Products', [['ProductID', 'int64']]),
      [`${M}/relationships.tmdl`]: rel('new-guid', 'Sales.ProductID', 'Products.ProductID') + '\n',
    });
    const original = model({
      [`${M}/tables/Sales.tmdl`]: table('Sales', [['ProductID', 'int64']]),
      [`${M}/tables/Products.tmdl`]: table('Products', [['ProductID', 'int64']]),
      [`${M}/relationships.tmdl`]: rel('old-guid', 'Sales.ProductID', 'Products.ProductID') + '\n',
    });
    const d = diffModelDiagram(original, recreated);
    expect(d.relationships.map(x => x.status)).toEqual(['unchanged']);
  });
});

describe('layoutModelDiagram', () => {
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('places every table without overlaps, and is deterministic', () => {
    // A star of 12 dimensions around a fact table, plus a few unrelated tables.
    const nodes = [{ id: 'Fact', w: 200, h: 120 }];
    const links = [];
    for (let i = 0; i < 12; i++) {
      nodes.push({ id: `Dim${i}`, w: 200, h: 60 + (i % 3) * 20 });
      links.push({ source: 'Fact', target: `Dim${i}` });
    }
    links.push({ source: 'Dim0', target: 'Dim1' });
    for (let i = 0; i < 4; i++) nodes.push({ id: `Loose${i}`, w: 200, h: 60 });

    const a = layoutModelDiagram(nodes, links);
    const b = layoutModelDiagram(nodes, links);
    expect([...a.positions]).toEqual([...b.positions]);
    expect(a.positions.size).toBe(nodes.length);
    const boxes = [...a.positions.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    }
    expect(a.loose).not.toBeNull();
  });
});
