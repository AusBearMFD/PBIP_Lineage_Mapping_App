import { describe, it, expect } from 'vitest';
import {
  analyzeFromFiles, findOrphansByCategory, classifyMeasureUsage,
  getFieldFilterUsage, buildDependencyStripData, buildMeasureSummaryRows,
  computeStats, ORPHAN_CATEGORIES,
} from '../src/index.js';

/**
 * Filter-pane membership vs filter-pane USAGE.
 *
 * Every filter reference is recorded as an edge so the UI can list it, but only
 * a filter holding a non-default value counts as usage for orphan detection.
 * Getting these two apart is what makes the Filter/Security category appear at
 * all — previously an unapplied filter produced no edge, so such measures were
 * silently mislabelled as true orphans.
 */
function buildFixture() {
  const modelFiles = new Map();
  modelFiles.set('definition/tables/S.tmdl', `
table S
	column A
		dataType: double
		sourceColumn: a
	measure 'Shown' = SUM('S'[A])
	measure 'PageFilterApplied' = SUM('S'[A])
	measure 'PageFilterIdle' = SUM('S'[A])
	measure 'VisualFilter' = SUM('S'[A])
	measure 'ReportFilter' = SUM('S'[A])
	measure 'Nothing' = 1
`);

  const mref = p => ({ Measure: { Expression: { SourceRef: { Entity: 'S' } }, Property: p } });
  const applied = p => ({
    name: `f_${p}`, field: mref(p),
    filter: { Where: [{ Condition: { Comparison: {
      ComparisonKind: 2, Left: mref(p), Right: { Literal: { Value: '1L' } },
    } } }] },
  });
  const idle = p => ({ name: `f_${p}`, field: mref(p), filter: {} });

  const reportFiles = new Map();
  reportFiles.set('definition/report.json', JSON.stringify({
    filterConfig: { filters: [applied('ReportFilter')] },
  }));
  reportFiles.set('definition/pages/p1/page.json', JSON.stringify({
    name: 'p1', displayName: 'Overview', ordinal: 0,
    filterConfig: { filters: [applied('PageFilterApplied'), idle('PageFilterIdle')] },
  }));
  reportFiles.set('definition/pages/p1/visuals/v1/visual.json', JSON.stringify({
    name: 'v1',
    visual: {
      visualType: 'card',
      query: { queryState: { Values: { projections: [{ field: mref('Shown') }] } } },
      visualContainerObjects: { title: [{ properties: { text: { expr: { Literal: { Value: "'The Card'" } } } } }] },
      filterConfig: { filters: [applied('VisualFilter')] },
    },
  }));

  return analyzeFromFiles({ modelFiles, reportFiles }).graph;
}

describe('filter usage and the Filter/Security orphan category', () => {
  const graph = buildFixture();
  const categoryOf = name => classifyMeasureUsage(`measure::S.${name}`, graph).category;

  it('treats a measure bound to a visual as in use', () => {
    expect(categoryOf('Shown')).toBe(ORPHAN_CATEGORIES.NONE);
  });

  it('classifies applied page, visual and report filters as filter/security', () => {
    expect(categoryOf('PageFilterApplied')).toBe(ORPHAN_CATEGORIES.FILTER_SECURITY);
    expect(categoryOf('VisualFilter')).toBe(ORPHAN_CATEGORIES.FILTER_SECURITY);
    expect(categoryOf('ReportFilter')).toBe(ORPHAN_CATEGORIES.FILTER_SECURITY);
  });

  it('does not treat an unapplied filter as usage', () => {
    expect(categoryOf('PageFilterIdle')).toBe(ORPHAN_CATEGORIES.TRUE);
  });

  it('populates the filter/security list and agrees with computeStats', () => {
    const orphans = findOrphansByCategory(graph);
    expect(orphans.filterSecurity).toHaveLength(3);
    const stats = computeStats(graph);
    expect(stats.orphanBreakdown.filterSecurity).toBe(3);
    expect(stats.orphanBreakdown.true).toBe(2);
  });
});

describe('getFieldFilterUsage', () => {
  const graph = buildFixture();
  const usageOf = name => getFieldFilterUsage(`measure::S.${name}`, graph);

  it('reports scope, owner and applied state for a page filter', () => {
    const [entry] = usageOf('PageFilterApplied');
    expect(entry.scope).toBe('page');
    expect(entry.page).toBe('Overview');
    expect(entry.isActive).toBe(true);
  });

  it('excludes a filter left at its default value', () => {
    // It sits in the pane but filters nothing, so it is not "in a filter".
    expect(usageOf('PageFilterIdle')).toHaveLength(0);
  });

  it('can still surface idle filter-pane entries on request', () => {
    const all = getFieldFilterUsage('measure::S.PageFilterIdle', graph, { activeOnly: false });
    expect(all).toHaveLength(1);
    expect(all[0].isActive).toBe(false);
  });

  it('only returns actively filtering entries by default', () => {
    for (const name of ['PageFilterApplied', 'VisualFilter', 'ReportFilter']) {
      expect(usageOf(name).every(e => e.isActive)).toBe(true);
    }
  });

  it('names the owning visual for a visual-level filter', () => {
    const [entry] = usageOf('VisualFilter');
    expect(entry.scope).toBe('visual');
    expect(entry.owner).toBe('The Card');
  });

  it('collapses a report filter to one entry rather than one per page', () => {
    const entries = usageOf('ReportFilter');
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('report');
  });

  it('returns an empty list for a measure in no filter', () => {
    expect(usageOf('Nothing')).toHaveLength(0);
  });
});

describe('filter counts surfaced to the UI', () => {
  const graph = buildFixture();

  it('includes filters[] in the dependency strip payload', () => {
    const strip = buildDependencyStripData('measure::S.PageFilterApplied', graph);
    expect(Array.isArray(strip.filters)).toBe(true);
    expect(strip.filters).toHaveLength(1);
  });

  it('counts only actively filtering panes per row', () => {
    const rows = buildMeasureSummaryRows(graph);
    const row = name => rows.find(r => r.name === name);
    // Idle filter -> 0, because it is not filtering anything.
    expect(row('PageFilterIdle').filterCount).toBe(0);
    expect(row('VisualFilter').filterCount).toBe(1);
    expect(row('PageFilterApplied').filterCount).toBe(1);
    expect(row('ReportFilter').filterCount).toBe(1);
    expect(row('Nothing').filterCount).toBe(0);
    expect(rows.every(r => typeof r.filterCount === 'number')).toBe(true);
  });
});
