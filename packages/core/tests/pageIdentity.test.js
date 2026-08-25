import { describe, it, expect } from 'vitest';
import { analyzeWorkspace, identifyProjectStructure } from '../src/index.js';

/**
 * Page identity in a multi-report workspace.
 *
 * Every report saved from Power BI tends to name its first page folder "p1",
 * and human page names like "Overview" repeat freely across reports. So neither
 * the display name nor the raw pageId identifies a page — only the graph node
 * id does. These tests pin that down, because navigating by name silently
 * opened the wrong report's page.
 */
function buildCollidingWorkspace() {
  const modelFiles = new Map();
  modelFiles.set('definition/tables/S.tmdl', `
table S
	column A
		dataType: double
		sourceColumn: a
	measure 'M' = SUM('S'[A])
`);

  const makeReport = (name, visualTitles) => {
    const files = new Map();
    // Same raw page id AND same display name in every report — the collision.
    files.set('definition/pages/p1/page.json', JSON.stringify({
      name: 'p1', displayName: 'Overview', ordinal: 0, width: 1280, height: 720,
    }));
    visualTitles.forEach((title, i) => {
      files.set(`definition/pages/p1/visuals/v${i}/visual.json`, JSON.stringify({
        name: `v${i}`,
        visual: {
          visualType: 'card',
          position: { x: i * 100, y: 0, width: 90, height: 80 },
          query: { queryState: { Values: { projections: [
            { field: { Measure: { Expression: { SourceRef: { Entity: 'S' } }, Property: 'M' } } },
          ] } } },
          visualContainerObjects: { title: [{ properties: { text: { expr: { Literal: { Value: `'${title}'` } } } } }] },
        },
      }));
    });
    return {
      reportKey: name, reportName: name, modelKey: 'K',
      reportStructure: identifyProjectStructure(files),
    };
  };

  const reports = [
    makeReport('Sales Report', ['Sales A', 'Sales B']),
    makeReport('HR Report', ['HR A']),
    makeReport('Finance Report', ['Fin A', 'Fin B', 'Fin C']),
  ];
  const { graph } = analyzeWorkspace({
    reports,
    modelStructureByKey: new Map([['K', identifyProjectStructure(modelFiles)]]),
  });
  return graph;
}

describe('page identity across reports', () => {
  const graph = buildCollidingWorkspace();
  const pages = [...graph.nodes.values()].filter(n => n.type === 'page');

  it('keeps one page node per report even when name and raw pageId collide', () => {
    expect(pages).toHaveLength(3);
    expect(new Set(pages.map(p => p.name)).size).toBe(1);
    expect(new Set(pages.map(p => p.metadata.pageId)).size).toBe(1);
    expect(new Set(pages.map(p => p.id)).size).toBe(3);
  });

  it('tags every page node with its owning report', () => {
    expect(pages.every(p => !!p.metadata.reportName)).toBe(true);
    expect(new Set(pages.map(p => p.metadata.reportName)))
      .toEqual(new Set(['Sales Report', 'HR Report', 'Finance Report']));
  });

  it('links each visual only to its own report page', () => {
    const expected = { 'Sales Report': 2, 'HR Report': 1, 'Finance Report': 3 };
    for (const page of pages) {
      const visualIds = graph.adjacency.downstream.get(page.id) || [];
      const visuals = visualIds
        .map(id => graph.nodes.get(id))
        .filter(n => n && n.type === 'visual');
      expect(visuals).toHaveLength(expected[page.metadata.reportName]);

      const prefix = { 'Sales Report': 'Sales', 'HR Report': 'HR', 'Finance Report': 'Fin' }[page.metadata.reportName];
      for (const v of visuals) {
        expect(v.metadata.title.startsWith(prefix)).toBe(true);
      }
    }
  });

  it('resolves a page unambiguously by node id', () => {
    for (const page of pages) {
      const found = graph.nodes.get(page.id);
      expect(found.id).toBe(page.id);
      expect(found.metadata.reportName).toBe(page.metadata.reportName);
    }
  });

  it('demonstrates why name lookup is unsafe: it collapses to one page', () => {
    const byName = [];
    for (const node of graph.nodes.values()) {
      if (node.type === 'page' && node.name === 'Overview') { byName.push(node); break; }
    }
    // A first-match-by-name lookup can only ever return one of the three.
    expect(byName).toHaveLength(1);
    expect(pages.length).toBeGreaterThan(byName.length);
  });
});
