import { describe, it, expect } from 'vitest';
import {
  analyzeWorkspace, analyzeFromFiles, identifyProjectStructure,
  buildAdjacency, createEdge, traceMeasureLineage, EDGE_TYPES,
} from '../src/index.js';

describe('buildAdjacency deduplication', () => {
  it('records each neighbour once even with parallel edges', () => {
    // A measure can reference the same column both normally and inside
    // USERELATIONSHIP, producing two edges for one pair.
    const edges = [
      createEdge('measure::M.A', 'column::Date.Date', EDGE_TYPES.MEASURE_TO_COLUMN),
      createEdge('measure::M.A', 'column::Date.Date', EDGE_TYPES.MEASURE_TO_USERELATIONSHIP),
      createEdge('measure::M.A', 'column::Sales.Amount', EDGE_TYPES.MEASURE_TO_COLUMN),
    ];
    const { upstream, downstream } = buildAdjacency(edges);
    expect(upstream.get('measure::M.A')).toEqual(['column::Date.Date', 'column::Sales.Amount']);
    expect(downstream.get('column::Date.Date')).toEqual(['measure::M.A']);
  });

  it('preserves insertion order', () => {
    const edges = [
      createEdge('a', 'z', 't'),
      createEdge('a', 'm', 't'),
      createEdge('a', 'z', 't'),
    ];
    expect(buildAdjacency(edges).upstream.get('a')).toEqual(['z', 'm']);
  });
});

describe('shared semantic model collapses to single nodes', () => {
  const modelFiles = new Map();
  modelFiles.set('definition/tables/Sales.tmdl', `
table Sales
	column Amount
		dataType: double
		sourceColumn: amt
	measure 'Total Sales' = SUM('Sales'[Amount])
		formatString: $#,##0
`);

  function makeReport(name, pageLabel) {
    const files = new Map();
    files.set('definition/pages/p/page.json', JSON.stringify({
      name: 'p', displayName: pageLabel, ordinal: 0,
    }));
    for (const v of ['a', 'b']) {
      files.set(`definition/pages/p/visuals/${v}/visual.json`, JSON.stringify({
        name: v,
        visual: {
          visualType: 'card',
          query: { queryState: { Values: { projections: [
            { field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total Sales' } } },
          ] } } },
        },
      }));
    }
    return {
      reportKey: name, reportName: name,
      modelKey: 'Shared.SemanticModel',
      reportStructure: identifyProjectStructure(files),
    };
  }

  const reports = [
    makeReport('Sales Report', 'Overview'),
    makeReport('HR Report', 'Overview'),
    makeReport('Finance Report', 'Summary'),
  ];
  const modelStructureByKey = new Map([['Shared.SemanticModel', identifyProjectStructure(modelFiles)]]);
  const { graph } = analyzeWorkspace({ reports, modelStructureByKey });

  it('creates one measure node for three reports sharing a model', () => {
    const measures = [...graph.nodes.values()].filter(n => n.type === 'measure');
    expect(measures).toHaveLength(1);
    expect(measures[0].id).toBe('measure::Sales.Total Sales');
  });

  it('creates one column node for three reports sharing a model', () => {
    const columns = [...graph.nodes.values()].filter(n => n.type === 'column');
    expect(columns).toHaveLength(1);
  });

  it('still keeps every consuming visual distinct', () => {
    const visuals = [...graph.nodes.values()].filter(n => n.type === 'visual');
    expect(visuals).toHaveLength(6);
  });

  it('tags each visual with its owning report so duplicates are tellable apart', () => {
    const lineage = traceMeasureLineage('measure::Sales.Total Sales', graph);
    expect(lineage.visuals).toHaveLength(6);
    const reportNames = new Set(lineage.visuals.map(v => v.report));
    expect(reportNames).toEqual(new Set(['Sales Report', 'HR Report', 'Finance Report']));
  });
});

describe('lineage chain has no duplicate column entries', () => {
  it('lists a column referenced twice by one measure only once', () => {
    const modelFiles = new Map();
    // 'Date'[Date] is referenced both directly and via USERELATIONSHIP.
    modelFiles.set('definition/tables/Sales.tmdl', `
table Sales
	column Amount
		dataType: double
		sourceColumn: amt
	measure 'Rolling' = CALCULATE(SUM('Sales'[Amount]), USERELATIONSHIP('Sales'[Amount], 'Date'[Date]), 'Date'[Date] > 1)
`);
    modelFiles.set('definition/tables/Date.tmdl', `
table Date
	column Date
		dataType: dateTime
		sourceColumn: d
`);
    const { graph } = analyzeFromFiles({ modelFiles });
    const chain = traceMeasureLineage('measure::Sales.Rolling', graph).measureChain;
    const dateCols = chain.columns.filter(c => c.table === 'Date' && c.name === 'Date');
    expect(dateCols).toHaveLength(1);
  });
});
