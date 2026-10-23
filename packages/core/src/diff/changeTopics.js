/**
 * Change Topics — groups change records into user-facing topics for the
 * Change History view.
 *
 * Scopes describe *where* a change lives (page, visual, report…), which is the
 * wrong axis for browsing: a filter change can be visual-, page-, or
 * report-scoped, but people look for "what filters changed?". Topics are
 * derived from the change *type* instead, so every filter change lands under
 * Filters no matter its scope.
 */

import { CHANGE_TYPES } from './changeTypes.js';

/** Display order of topics in the Change History view. */
export const CHANGE_TOPICS = [
  { key: 'measures', label: 'Measures & calculation items' },
  { key: 'columns', label: 'Columns' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'sources', label: 'Data sources & Power Query' },
  { key: 'pages', label: 'Pages' },
  { key: 'visuals', label: 'Visuals' },
  { key: 'filters', label: 'Filters' },
  { key: 'bookmarks', label: 'Bookmarks' },
  { key: 'other', label: 'Other' },
];

const TOPIC_BY_TYPE = {
  [CHANGE_TYPES.MEASURE_ADDED]: 'measures',
  [CHANGE_TYPES.MEASURE_REMOVED]: 'measures',
  [CHANGE_TYPES.MEASURE_CHANGED]: 'measures',
  [CHANGE_TYPES.CALC_ITEM_ADDED]: 'measures',
  [CHANGE_TYPES.CALC_ITEM_REMOVED]: 'measures',
  [CHANGE_TYPES.CALC_ITEM_CHANGED]: 'measures',

  [CHANGE_TYPES.COLUMN_ADDED]: 'columns',
  [CHANGE_TYPES.COLUMN_REMOVED]: 'columns',
  [CHANGE_TYPES.COLUMN_TYPE_CHANGED]: 'columns',

  [CHANGE_TYPES.RELATIONSHIP_ADDED]: 'relationships',
  [CHANGE_TYPES.RELATIONSHIP_REMOVED]: 'relationships',
  [CHANGE_TYPES.RELATIONSHIP_CHANGED]: 'relationships',

  [CHANGE_TYPES.SOURCE_EXPRESSION_CHANGED]: 'sources',
  [CHANGE_TYPES.EXPRESSION_CHANGED]: 'sources',
  [CHANGE_TYPES.PARAMETER_CHANGED]: 'sources',

  [CHANGE_TYPES.PAGE_ADDED]: 'pages',
  [CHANGE_TYPES.PAGE_REMOVED]: 'pages',
  [CHANGE_TYPES.DEFAULT_PAGE_CHANGED]: 'pages',

  [CHANGE_TYPES.VISUAL_ADDED]: 'visuals',
  [CHANGE_TYPES.VISUAL_REMOVED]: 'visuals',
  [CHANGE_TYPES.VISUAL_FIELD_CHANGED]: 'visuals',
  [CHANGE_TYPES.VISUAL_VISIBILITY_CHANGED]: 'visuals',
  [CHANGE_TYPES.VISUAL_BOOKMARK_CHANGED]: 'visuals',

  [CHANGE_TYPES.FILTER_ADDED]: 'filters',
  [CHANGE_TYPES.FILTER_REMOVED]: 'filters',
  [CHANGE_TYPES.FILTER_CHANGED]: 'filters',
  [CHANGE_TYPES.VISUAL_FILTER_ADDED]: 'filters',
  [CHANGE_TYPES.VISUAL_FILTER_REMOVED]: 'filters',
  [CHANGE_TYPES.VISUAL_FILTER_CHANGED]: 'filters',

  [CHANGE_TYPES.BOOKMARK_CHANGED]: 'bookmarks',
};

/**
 * The topic key a change belongs to.
 * @param {{ type: string }} change
 * @returns {string}
 */
export function topicForChange(change) {
  return TOPIC_BY_TYPE[change?.type] || 'other';
}

/**
 * Whether a change added, removed, or modified something, from its type name.
 * @param {{ type: string }} change
 * @returns {'added'|'removed'|'changed'}
 */
export function changeAction(change) {
  const type = change?.type || '';
  if (type.endsWith('_added')) return 'added';
  if (type.endsWith('_removed')) return 'removed';
  return 'changed';
}

/**
 * Group changes by topic, in CHANGE_TOPICS order, omitting empty topics.
 * Input order is preserved within each topic.
 * @param {Array<object>} changes
 * @returns {Array<{ key: string, label: string, changes: Array<object> }>}
 */
export function groupChangesByTopic(changes) {
  const buckets = new Map(CHANGE_TOPICS.map(t => [t.key, []]));
  for (const change of changes || []) {
    buckets.get(topicForChange(change)).push(change);
  }
  return CHANGE_TOPICS
    .filter(t => buckets.get(t.key).length > 0)
    .map(t => ({ key: t.key, label: t.label, changes: buckets.get(t.key) }));
}
