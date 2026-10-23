/**
 * Git Scanner — Scans recent git commits for PBIR/TMDL changes using isomorphic-git.
 * Works entirely in the browser via the File System Access API.
 */

// isomorphic-git assumes Buffer is globally available (Node.js).
// Polyfill it for the browser before importing isomorphic-git.
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

import git from 'isomorphic-git';
import { createGitFs, hasGitDirectory } from './gitFs.js';
import { detectChanges } from '@pbip-lineage/core';

const RELEVANT_EXTENSIONS = ['.json', '.tmdl', '.pbir'];

/**
 * Scan recent commits and detect all changes.
 * @param {FileSystemDirectoryHandle} rootHandle - Handle to the repo root.
 * @param {{ nodes: Map, edges: Array, adjacency: object }} [graph] - Lineage graph for impact resolution.
 * @param {number} [maxCommits=10] - Maximum commits to scan.
 * @returns {Promise<{ scanResults: Array, pairs: Array, flatChanges: Array, measureChangeCounts: Map, hasRepo: boolean }>}
 *   `scanResults` holds only commit pairs with detected changes (used for badges).
 *   `pairs` holds EVERY consecutive pair, newest first, for the Change History
 *   view's navigator — including pairs with no PBIP changes, so no commit is
 *   silently skipped — plus the before/after text of each changed PBIP file.
 */
export async function scanGitHistory(rootHandle, graph = null, maxCommits = 10) {
  if (!await hasGitDirectory(rootHandle)) {
    return { scanResults: [], pairs: [], flatChanges: [], measureChangeCounts: new Map(), hasRepo: false };
  }

  const fs = createGitFs(rootHandle);
  const dir = '/';
  const scanResults = [];
  // Shared isomorphic-git cache: keeps parsed packfiles between calls (much faster).
  const cache = {};
  // Folder listings by git tree id, and file contents by blob id. Consecutive
  // commits share most of their trees and files, so each is read only once.
  const treeCache = new Map();
  const blobCache = new Map();
  const pairs = [];

  try {
    // Get recent commits
    const commits = await git.log({ fs, dir, depth: maxCommits + 1, cache });

    if (commits.length < 2) {
      return { scanResults: [], pairs: [], flatChanges: [], measureChangeCounts: new Map(), hasRepo: true };
    }

    // Compare consecutive commit pairs
    for (let i = 0; i < commits.length - 1; i++) {
      const toCommit = commits[i];
      const fromCommit = commits[i + 1];

      const toHash = toCommit.oid.substring(0, 7);
      const fromHash = fromCommit.oid.substring(0, 7);

      const pair = {
        fromCommit: describeCommit(fromCommit),
        toCommit: describeCommit(toCommit),
        changes: [],
        summary: { totalChanges: 0, byType: {}, byScope: {} },
        files: [],
        status: 'ok', // 'ok' | 'no-pbip-files' | 'error'
      };
      pairs.push(pair);

      try {
        // Changed PBIP files between these two commits, with their blob ids
        const changedFiles = await getChangedFilesBetween(fs, dir, fromCommit.oid, toCommit.oid, cache, treeCache);

        if (changedFiles.length === 0) {
          console.debug(`[git-scan] ${fromHash}..${toHash}: 0 relevant changed files — skipped`);
          pair.status = 'no-pbip-files';
          continue;
        }

        // Build before/after file maps
        const beforeFiles = new Map();
        const afterFiles = new Map();
        for (const { path, before, after } of changedFiles) {
          if (before) beforeFiles.set(path, await readBlobText(fs, dir, before, cache, blobCache));
          if (after) afterFiles.set(path, await readBlobText(fs, dir, after, cache, blobCache));
        }
        const relevantFiles = changedFiles.map(f => f.path);
        // Run change detection
        const { changes, summary } = detectChanges(beforeFiles, afterFiles, graph);

        console.debug(`[git-scan] ${fromHash}..${toHash}: ${relevantFiles.length} relevant files, ${changes.length} changes detected`);

        pair.changes = changes;
        pair.summary = summary;
        pair.files = [...relevantFiles].sort().map(path => {
          const before = beforeFiles.has(path) ? beforeFiles.get(path) : null;
          const after = afterFiles.has(path) ? afterFiles.get(path) : null;
          const status = before == null ? 'added' : after == null ? 'removed' : 'modified';
          return { path, before, after, status };
        });

        if (changes.length > 0) {
          scanResults.push({
            fromCommit: pair.fromCommit,
            toCommit: pair.toCommit,
            changes,
            summary,
          });
        }
      } catch (err) {
        pair.status = 'error';
        console.warn(`[git-scan] Failed to compare ${fromHash}..${toHash}:`, err);
      }
    }
  } catch (err) {
    console.warn('Git history scan failed:', err.message);
  }

  // Build flat change list and measure change counts
  const flatChanges = [];
  const measureChangeCounts = new Map();

  for (const result of scanResults) {
    for (const change of result.changes) {
      flatChanges.push({
        ...change,
        commitHash: result.toCommit.hash.substring(0, 7),
        commitMessage: result.toCommit.message,
        commitDate: result.toCommit.date,
      });

      // Track per-measure change counts
      if (change.target?.measureName) {
        const key = change.target.measureName;
        measureChangeCounts.set(key, (measureChangeCounts.get(key) || 0) + 1);
      }
    }
  }

  return { scanResults, pairs, flatChanges, measureChangeCounts, hasRepo: true };
}

/**
 * Summarise an isomorphic-git log entry for display.
 * `message` is the subject line; `body` is the rest, if any.
 */
function describeCommit(entry) {
  const [subject, ...rest] = (entry.commit.message || '').split('\n');
  return {
    hash: entry.oid,
    message: subject,
    body: rest.join('\n').trim(),
    author: entry.commit.author?.name || '',
    date: new Date(entry.commit.committer.timestamp * 1000).toISOString(),
  };
}

/**
 * Changed PBIP files between two commits, as `{ path, before, after }` where
 * `before`/`after` are blob ids (null when the file was added/removed).
 * Compares trees directly: a folder whose tree id is the same in both commits
 * is unchanged and is skipped without being read, which is much faster than
 * git.walk on large repos. Tree listings are cached by tree id across pairs.
 */
export async function getChangedFilesBetween(fs, dir, fromOid, toOid, cache = {}, treeCache = new Map()) {
  const changed = [];
  try {
    // readTree peels a commit id to its root tree.
    const [{ oid: fromTree }, { oid: toTree }] = await Promise.all([
      git.readTree({ fs, dir, oid: fromOid, cache }),
      git.readTree({ fs, dir, oid: toOid, cache }),
    ]);
    await diffTrees(fromTree, toTree, '');
  } catch (err) {
    console.warn('Failed to compare trees:', err.message);
  }
  return changed;

  async function entriesOf(treeOid) {
    if (!treeOid) return [];
    let entries = treeCache.get(treeOid);
    if (!entries) {
      entries = (await git.readTree({ fs, dir, oid: treeOid, cache })).tree;
      treeCache.set(treeOid, entries);
    }
    return entries;
  }

  async function diffTrees(treeA, treeB, prefix) {
    if (treeA === treeB) return;
    const [a, b] = await Promise.all([entriesOf(treeA), entriesOf(treeB)]);
    const byName = new Map();
    for (const e of a) byName.set(e.path, { a: e, b: null });
    for (const e of b) {
      const slot = byName.get(e.path);
      if (slot) slot.b = e; else byName.set(e.path, { a: null, b: e });
    }
    for (const [name, { a: ea, b: eb }] of byName) {
      if (ea && eb && ea.oid === eb.oid) continue;
      const lower = name.toLowerCase();
      const subA = ea?.type === 'tree' ? ea.oid : null;
      const subB = eb?.type === 'tree' ? eb.oid : null;
      if ((subA || subB) && lower !== '.pbi' && lower !== 'node_modules') {
        await diffTrees(subA, subB, `${prefix}${name}/`);
      }
      const blobA = ea?.type === 'blob' ? ea.oid : null;
      const blobB = eb?.type === 'blob' ? eb.oid : null;
      if ((blobA || blobB) && RELEVANT_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        changed.push({ path: prefix + name, before: blobA, after: blobB });
      }
    }
  }
}

/** Read a blob's text by id, caching by id (unchanged files share ids). */
async function readBlobText(fs, dir, oid, cache, blobCache) {
  if (!blobCache.has(oid)) {
    const { blob } = await git.readBlob({ fs, dir, oid, cache });
    blobCache.set(oid, new TextDecoder().decode(blob));
  }
  return blobCache.get(oid);
}
