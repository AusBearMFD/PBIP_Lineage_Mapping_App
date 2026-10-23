/**
 * Bookmark Effect — what clicking a bookmark changes compared with its page's
 * default (saved) state.
 *
 * A PBIR bookmark stores the state it captured in `explorationState`:
 *   filters.byExpr                                  report-level filter states
 *   sections[pageId].filters.byExpr                 page filter states
 *   sections[pageId].visualContainers[id]           per visual:
 *       .singleVisual.display.mode === 'hidden'       hidden by the bookmark
 *       .filters.byExpr                               visual filter states
 *       .singleVisual.objects.general[0].properties.filter   slicer selection
 *   sections[pageId].visualContainerGroups[id]      group visibility (+ children)
 *
 * Each entry is compared with the same object's default in the report
 * (visual.json isHidden / filterConfig, page.json and report.json filterConfig).
 * Filter entries match their defaults by filter `name`.
 *
 * Power BI only applies the parts a bookmark is set to capture: with "Data"
 * off (options.suppressData) filter and slicer states are stored but NOT
 * applied, and with "Display" off visibility is not applied. The result says so
 * via `captures`, so a UI can show those parts as inactive.
 */

import { describeFilterCondition, fieldLabel, visualLabel } from './snapshot.js';

const NONE = 'No value applied';

/**
 * @param {object} report - A report from buildSnapshot().
 * @param {object} bookmark - One of report.bookmarks.
 * @returns {{
 *   pageId: string, pageName: string,
 *   captures: { data: boolean, display: boolean, currentPage: boolean },
 *   scope: string,
 *   hidden: string[], shown: string[],
 *   groupsHidden: string[], groupsShown: string[],
 *   reportFilters: Array, pageFilters: Array, visualFilters: Array, slicers: Array,
 *   notCaptured: number
 * }|null}
 */
export function describeBookmarkEffect(report, bookmark) {
  if (!report || !bookmark) return null;
  const state = bookmark.state || {};
  const pageId = state.activeSection || bookmark.pageId || '';
  const page = report.pages.get(pageId);
  const section = state.sections?.[pageId] || {};
  const containers = section.visualContainers || {};
  const targets = bookmark.appliesToSelectedVisuals ? new Set(bookmark.targetVisualIds || []) : null;
  const inScope = (id) => !targets || targets.has(id);

  const pageVisuals = [...report.visuals.values()].filter(v => v.pageId === pageId);
  const byId = new Map(pageVisuals.map(v => [v.id, v]));

  // Visibility of individual visuals
  const hidden = [];
  const shown = [];
  let notCaptured = 0;
  for (const v of pageVisuals) {
    if (v.type === 'group' || !inScope(v.id)) continue;
    const captured = containers[v.id];
    if (!captured) { notCaptured++; continue; }
    const hiddenByBookmark = captured.singleVisual?.display?.mode === 'hidden';
    if (hiddenByBookmark && !v.isHidden) hidden.push(visualLabel(v));
    else if (!hiddenByBookmark && v.isHidden) shown.push(visualLabel(v));
  }

  // Visibility of groups (nested)
  const groupsHidden = [];
  const groupsShown = [];
  (function walkGroups(groups) {
    for (const [id, g] of Object.entries(groups || {})) {
      const v = byId.get(id);
      if (v && inScope(id) && typeof g?.isHidden === 'boolean') {
        if (g.isHidden && !v.isHidden) groupsHidden.push(visualLabel(v));
        else if (!g.isHidden && v.isHidden) groupsShown.push(visualLabel(v));
      }
      walkGroups(g?.children);
    }
  })(section.visualContainerGroups);

  // Filters and slicers
  const reportFilters = compareFilterStates(report.filters, state.filters?.byExpr);
  const pageFilters = page ? compareFilterStates(page.filters, section.filters?.byExpr) : [];
  const visualFilters = [];
  const slicers = [];
  for (const [id, captured] of Object.entries(containers)) {
    const v = byId.get(id);
    if (!v || !inScope(id)) continue;
    for (const change of compareFilterStates(v.filters, captured.filters?.byExpr)) {
      visualFilters.push({ visual: visualLabel(v), ...change });
    }
    const general = captured.singleVisual?.objects?.general;
    const props = Array.isArray(general) ? general[0]?.properties : general?.properties;
    if (props?.filter) {
      const selection = describeFilterCondition(props.filter.filter);
      if (selection !== (v.slicerSelection || '')) {
        slicers.push({ visual: visualLabel(v), default: v.slicerSelection || 'Nothing selected', bookmark: selection || 'Nothing selected' });
      }
    }
  }

  return {
    pageId,
    pageName: page?.name || pageId,
    captures: { data: bookmark.capturesData, display: bookmark.capturesDisplay, currentPage: bookmark.capturesCurrentPage },
    scope: targets ? `${targets.size} selected visual${targets.size !== 1 ? 's' : ''}` : 'All visuals on the page',
    hidden, shown, groupsHidden, groupsShown,
    reportFilters, pageFilters, visualFilters, slicers,
    notCaptured,
  };
}

/**
 * Compare a bookmark's captured filter states with the defaults.
 * @param {Map} defaults - filter key -> summary (from snapshot addFilter).
 * @param {Array} captured - explorationState byExpr entries.
 * @returns {Array<{ field, default, bookmark, notInPane }>} only filters whose value differs.
 */
function compareFilterStates(defaults, captured) {
  const out = [];
  for (const entry of captured || []) {
    const field = fieldLabel(entry.expression || entry.field) || '(unknown field)';
    const key = entry.name || `field:${field}`;
    const def = defaults?.get(key);
    const defCond = def?.condition || '';
    const bmCond = describeFilterCondition(entry.filter);
    if (defCond === bmCond) continue;
    out.push({
      field: def?.field || field,
      default: defCond || NONE,
      bookmark: bmCond || (defCond ? 'Cleared' : NONE),
      notInPane: !def, // captured by the bookmark but not in the object's filter pane
    });
  }
  return out;
}

/**
 * Flatten an effect into short text lines, for diffing two versions of a bookmark.
 * @returns {{ hides: string[], shows: string[], filters: string[], slicers: string[] }}
 */
export function bookmarkEffectLines(effect) {
  if (!effect) return { hides: [], shows: [], filters: [], slicers: [] };
  return {
    hides: [...effect.hidden, ...effect.groupsHidden.map(g => `Group ${g}`)],
    shows: [...effect.shown, ...effect.groupsShown.map(g => `Group ${g}`)],
    filters: [
      ...effect.reportFilters.map(f => `Report: ${f.field} = ${f.bookmark}`),
      ...effect.pageFilters.map(f => `Page: ${f.field} = ${f.bookmark}`),
      ...effect.visualFilters.map(f => `${f.visual}: ${f.field} = ${f.bookmark}`),
    ],
    slicers: effect.slicers.map(s => `${s.visual}: ${s.bookmark}`),
  };
}
