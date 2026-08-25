import { describe, it, expect } from 'vitest';
import { analyzeFromFiles, buildDependencyStripData } from '../src/index.js';

function buildFixture() {
  const modelFiles = new Map();
  modelFiles.set('definition/tables/Sales.tmdl', `
table Sales
	column Quantity
		dataType: int64
		sourceColumn: qty
	column 'Unit Price'
		dataType: double
		sourceColumn: unit_price
	column IsVoided
		dataType: boolean
		sourceColumn: is_voided
	column 'Discount Amount'
		dataType: double
		sourceColumn: disc_amt
	measure 'Net Revenue' = SUMX('Sales', 'Sales'[Quantity] * 'Sales'[Unit Price]) - [Total Discounts]
		formatString: $#,0.00
	measure 'Total Discounts' = SUM('Sales'[Discount Amount])
	measure 'Net Revenue YTD' = CALCULATE([Net Revenue], DATESYTD('Date'[Date]), KEEPFILTERS('Sales'[IsVoided] = FALSE()))
		formatString: $#,0.00;($#,0.00)
	measure 'Net Revenue YTD PY' = CALCULATE([Net Revenue YTD], SAMEPERIODLASTYEAR('Date'[Date]))
`);
  modelFiles.set('definition/tables/Date.tmdl', `
table Date
	column Date
		dataType: dateTime
		sourceColumn: date
`);

  const reportFiles = new Map();
  reportFiles.set('definition/pages/p1/page.json', JSON.stringify({
    name: 'p1', displayName: '01 - Overview', ordinal: 0,
  }));
  // v1 references the measure directly, in the Values data role.
  reportFiles.set('definition/pages/p1/visuals/v1/visual.json', JSON.stringify({
    name: 'v1',
    visual: {
      visualType: 'kpi',
      query: { queryState: { Values: { projections: [
        { field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Net Revenue YTD' } } },
      ] } } },
    },
  }));
  // v2 references it only transitively, via Net Revenue YTD PY.
  reportFiles.set('definition/pages/p1/visuals/v2/visual.json', JSON.stringify({
    name: 'v2',
    visual: {
      visualType: 'lineChart',
      query: { queryState: { Y: { projections: [
        { field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Net Revenue YTD PY' } } },
      ] } } },
    },
  }));

  const { graph } = analyzeFromFiles({ modelFiles, reportFiles });
  return graph;
}

describe('buildDependencyStripData', () => {
  const graph = buildFixture();
  const data = buildDependencyStripData('measure::Sales.Net Revenue YTD', graph);

  it('returns null for an unknown measure', () => {
    expect(buildDependencyStripData('measure::Nope.Missing', graph)).toBeNull();
  });

  it('populates the measure header including formatString', () => {
    expect(data.measure.name).toBe('Net Revenue YTD');
    expect(data.measure.table).toBe('Sales');
    expect(data.measure.formatString).toBe('$#,0.00;($#,0.00)');
    expect(data.measure.expression).toContain('DATESYTD');
  });

  it('always returns arrays, never null', () => {
    for (const key of ['visuals', 'downstreamMeasures', 'upstreamMeasures', 'upstreamColumns']) {
      expect(Array.isArray(data[key])).toBe(true);
    }
  });

  it('includes visuals reached transitively, with page and role', () => {
    expect(data.visuals).toHaveLength(2);
    expect(data.visuals.every(v => v.page === '01 - Overview')).toBe(true);
    // The direct reference carries the PBIR data role.
    expect(data.visuals.some(v => v.role === 'Values')).toBe(true);
  });

  it('lists direct downstream measures with their DAX and kind', () => {
    expect(data.downstreamMeasures).toHaveLength(1);
    expect(data.downstreamMeasures[0].name).toBe('Net Revenue YTD PY');
    expect(data.downstreamMeasures[0].kind).toBe('measure');
    expect(data.downstreamMeasures[0].expression).toContain('SAMEPERIODLASTYEAR');
  });

  it('lists direct upstream measures with their DAX', () => {
    expect(data.upstreamMeasures.map(m => m.name)).toContain('Net Revenue');
    expect(data.upstreamMeasures.every(m => m.expression.length > 0)).toBe(true);
  });

  it('resolves upstream columns transitively across multiple hops', () => {
    const refs = data.upstreamColumns.map(c => `${c.table}[${c.column}]`);
    // Direct references from this measure's own expression.
    expect(refs).toContain('Sales[IsVoided]');
    expect(refs).toContain('Date[Date]');
    // One hop away, via [Net Revenue].
    expect(refs).toContain('Sales[Quantity]');
    expect(refs).toContain('Sales[Unit Price]');
    // Two hops away, via [Net Revenue] -> [Total Discounts].
    expect(refs).toContain('Sales[Discount Amount]');
  });

  it('annotates a "via" function for columns in the measure\'s own expression', () => {
    const dateCol = data.upstreamColumns.find(c => c.column === 'Date');
    expect(dateCol.via).toBe('DATESYTD');
    const voided = data.upstreamColumns.find(c => c.column === 'IsVoided');
    expect(voided.via).toBe('KEEPFILTERS');
  });

  it('leaves "via" empty rather than guessing for transitive columns', () => {
    const qty = data.upstreamColumns.find(c => c.column === 'Quantity');
    expect(qty.via).toBe('');
  });

  it('returns empty dependency lists for a leaf measure', () => {
    const leaf = buildDependencyStripData('measure::Sales.Total Discounts', graph);
    expect(leaf.upstreamMeasures).toHaveLength(0);
    expect(leaf.upstreamColumns.map(c => c.column)).toContain('Discount Amount');
  });

  it('classifies a calculated column dependent as calculatedColumn', () => {
    const modelFiles = new Map();
    modelFiles.set('definition/tables/T.tmdl', `
table T
	column Base
		dataType: int64
		sourceColumn: base
	measure 'M' = SUM('T'[Base])
	column 'Calc' = CALCULATE([M])
		dataType: int64
`);
    const { graph: g } = analyzeFromFiles({ modelFiles });
    const d = buildDependencyStripData('measure::T.M', g);
    const calc = d.downstreamMeasures.find(x => x.name === 'Calc');
    expect(calc).toBeDefined();
    expect(calc.kind).toBe('calculatedColumn');
  });
});
