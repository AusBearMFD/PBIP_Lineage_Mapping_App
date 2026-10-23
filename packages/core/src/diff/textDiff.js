/**
 * Text Diff — line-level, side-by-side diff for the Change History file view.
 *
 * Produces aligned rows (left = before, right = after) from a longest-common-
 * subsequence match over lines. Adjacent removed/added runs are paired into
 * "changed" rows so an edited line sits opposite its replacement.
 *
 * Common leading and trailing lines are matched up front, so typical PBIP
 * edits (a few lines inside a large JSON or TMDL file) only run the LCS over
 * the small differing middle. If that middle is still too large, it falls back
 * to showing it as one replaced block rather than freezing the browser.
 */

/** Max LCS table cells (before-lines × after-lines in the differing middle). */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline isn't a line
  return lines;
}

/**
 * Diff two texts line by line.
 * @param {string|null} beforeText - Older content (null/'' when the file was added).
 * @param {string|null} afterText - Newer content (null/'' when the file was removed).
 * @returns {{
 *   rows: Array<{ type: 'same'|'removed'|'added'|'changed', left: string|null, right: string|null, leftNo: number|null, rightNo: number|null }>,
 *   added: number, removed: number, truncated: boolean
 * }}
 */
export function diffLines(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);

  // Match the common prefix and suffix cheaply.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops = []; // { op: '=', '-', '+', i?, j? }
  for (let k = 0; k < start; k++) ops.push({ op: '=', i: k, j: k });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let truncated = false;

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    truncated = true;
    for (let k = 0; k < midA.length; k++) ops.push({ op: '-', i: start + k });
    for (let k = 0; k < midB.length; k++) ops.push({ op: '+', j: start + k });
  } else {
    ops.push(...lcsOps(midA, midB, start));
  }

  for (let k = 0; k < a.length - endA; k++) ops.push({ op: '=', i: endA + k, j: endB + k });

  const rows = pairIntoRows(ops, a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.op === '+') added++;
    else if (op.op === '-') removed++;
  }
  return { rows, added, removed, truncated };
}

/** LCS edit script for the differing middle, offset back to whole-file indices. */
function lcsOps(midA, midB, offset) {
  const n = midA.length;
  const m = midB.length;
  // dp[i][j] = LCS length of midA[i..] and midB[j..], stored flat.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = midA[i] === midB[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { ops.push({ op: '=', i: offset + i, j: offset + j }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ op: '-', i: offset + i }); i++; }
    else { ops.push({ op: '+', j: offset + j }); j++; }
  }
  while (i < n) { ops.push({ op: '-', i: offset + i }); i++; }
  while (j < m) { ops.push({ op: '+', j: offset + j }); j++; }
  return ops;
}

/** Turn an edit script into side-by-side rows, pairing removed/added runs. */
function pairIntoRows(ops, a, b) {
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.op === '=') {
      rows.push({ type: 'same', left: a[op.i], right: b[op.j], leftNo: op.i + 1, rightNo: op.j + 1 });
      k++;
      continue;
    }
    // Collect one contiguous block of removals and additions.
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k].op !== '=') {
      if (ops[k].op === '-') dels.push(ops[k].i); else adds.push(ops[k].j);
      k++;
    }
    const len = Math.max(dels.length, adds.length);
    for (let r = 0; r < len; r++) {
      const di = dels[r];
      const aj = adds[r];
      if (di !== undefined && aj !== undefined) {
        rows.push({ type: 'changed', left: a[di], right: b[aj], leftNo: di + 1, rightNo: aj + 1 });
      } else if (di !== undefined) {
        rows.push({ type: 'removed', left: a[di], right: null, leftNo: di + 1, rightNo: null });
      } else {
        rows.push({ type: 'added', left: null, right: b[aj], leftNo: null, rightNo: aj + 1 });
      }
    }
  }
  return rows;
}

/**
 * Collapse long runs of unchanged rows, keeping `context` rows around each edit.
 * @param {Array} rows - Output rows of diffLines().
 * @param {number} [context=3]
 * @returns {Array} Rows, with collapsed runs replaced by `{ type: 'skip', count }`.
 */
export function collapseUnchanged(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((row, idx) => {
    if (keep[idx]) {
      if (skipped) { out.push({ type: 'skip', count: skipped }); skipped = 0; }
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}
