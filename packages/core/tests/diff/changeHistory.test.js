import { describe, it, expect } from 'vitest';
import {
  CHANGE_TYPES, CHANGE_TOPICS, topicForChange, changeAction, groupChangesByTopic,
  diffLines, collapseUnchanged,
} from '../../src/index.js';

describe('change topics', () => {
  it('maps every known change type to a real topic, never "other"', () => {
    for (const type of Object.values(CHANGE_TYPES)) {
      expect(topicForChange({ type }), type).not.toBe('other');
    }
  });

  it('puts filter changes under Filters regardless of scope', () => {
    expect(topicForChange({ type: CHANGE_TYPES.FILTER_CHANGED, scope: 'report' })).toBe('filters');
    expect(topicForChange({ type: CHANGE_TYPES.FILTER_ADDED, scope: 'page' })).toBe('filters');
    expect(topicForChange({ type: CHANGE_TYPES.VISUAL_FILTER_REMOVED, scope: 'visual' })).toBe('filters');
  });

  it('falls back to "other" for unknown types', () => {
    expect(topicForChange({ type: 'something_new' })).toBe('other');
    expect(topicForChange(null)).toBe('other');
  });

  it('derives the action from the type suffix', () => {
    expect(changeAction({ type: CHANGE_TYPES.MEASURE_ADDED })).toBe('added');
    expect(changeAction({ type: CHANGE_TYPES.VISUAL_REMOVED })).toBe('removed');
    expect(changeAction({ type: CHANGE_TYPES.MEASURE_CHANGED })).toBe('changed');
    expect(changeAction({ type: CHANGE_TYPES.DEFAULT_PAGE_CHANGED })).toBe('changed');
  });

  it('groups in display order, omits empty topics, keeps input order within a topic', () => {
    const changes = [
      { type: CHANGE_TYPES.VISUAL_ADDED, description: 'v1' },
      { type: CHANGE_TYPES.MEASURE_CHANGED, description: 'm1' },
      { type: CHANGE_TYPES.FILTER_CHANGED, description: 'f1' },
      { type: CHANGE_TYPES.MEASURE_ADDED, description: 'm2' },
    ];
    const groups = groupChangesByTopic(changes);
    expect(groups.map(g => g.key)).toEqual(['measures', 'visuals', 'filters']);
    expect(groups[0].changes.map(c => c.description)).toEqual(['m1', 'm2']);
    const order = CHANGE_TOPICS.map(t => t.key);
    const idx = groups.map(g => order.indexOf(g.key));
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
  });

  it('returns no groups for no changes', () => {
    expect(groupChangesByTopic([])).toEqual([]);
    expect(groupChangesByTopic(undefined)).toEqual([]);
  });
});

describe('diffLines', () => {
  it('reports identical text as all-same rows', () => {
    const { rows, added, removed } = diffLines('a\nb\nc', 'a\nb\nc');
    expect(rows.every(r => r.type === 'same')).toBe(true);
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });

  it('pairs an edited line opposite its replacement', () => {
    const { rows } = diffLines('a\nold\nc', 'a\nnew\nc');
    expect(rows.map(r => r.type)).toEqual(['same', 'changed', 'same']);
    expect(rows[1]).toMatchObject({ left: 'old', right: 'new', leftNo: 2, rightNo: 2 });
  });

  it('handles pure additions and removals with correct line numbers', () => {
    const add = diffLines('a\nc', 'a\nb\nc');
    expect(add.rows.map(r => r.type)).toEqual(['same', 'added', 'same']);
    expect(add.rows[1]).toMatchObject({ left: null, right: 'b', rightNo: 2 });
    expect(add.rows[2]).toMatchObject({ leftNo: 2, rightNo: 3 });

    const del = diffLines('a\nb\nc', 'a\nc');
    expect(del.rows.map(r => r.type)).toEqual(['same', 'removed', 'same']);
    expect(del.removed).toBe(1);
  });

  it('treats a missing side as a whole-file add or remove', () => {
    expect(diffLines(null, 'x\ny').rows.map(r => r.type)).toEqual(['added', 'added']);
    expect(diffLines('x\ny', '').rows.map(r => r.type)).toEqual(['removed', 'removed']);
  });

  it('ignores CRLF vs LF and a trailing newline', () => {
    const { added, removed } = diffLines('a\r\nb\r\n', 'a\nb');
    expect(added + removed).toBe(0);
  });

  it('finds a small edit inside a large file without truncating', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = [...lines];
    after[2500] = 'edited';
    const { rows, truncated, added, removed } = diffLines(lines.join('\n'), after.join('\n'));
    expect(truncated).toBe(false);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(rows.filter(r => r.type === 'changed')).toHaveLength(1);
  });
});

describe('collapseUnchanged', () => {
  it('keeps context around edits and replaces long unchanged runs with a skip marker', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const after = [...before];
    after[10] = 'x';
    const { rows } = diffLines(before.join('\n'), after.join('\n'));
    const out = collapseUnchanged(rows, 2);
    expect(out[0]).toEqual({ type: 'skip', count: 8 });
    expect(out.filter(r => r.type !== 'skip')).toHaveLength(5); // 2 + edit + 2
    expect(out[out.length - 1]).toEqual({ type: 'skip', count: 7 });
  });
});
