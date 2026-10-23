/**
 * Snapshot Scanner — reads COMPLETE PBIP snapshots of recent commits for the
 * Version Compare view, and compares each commit with its parent.
 *
 * Differences from gitScanner.js (which feeds "Commit Edits"):
 *  - every PBIP file at each commit is read, not just the files a commit
 *    touched, so new/deleted tables, page names, and leftover references can
 *    be resolved;
 *  - each commit is compared with its actual first parent, not the next entry
 *    in the log, so branches and merges compare correctly;
 *  - file contents are cached by git object id, so a file that didn't change
 *    between commits is read only once.
 */

import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

import git from 'isomorphic-git';
import { createGitFs, hasGitDirectory } from './gitFs.js';
import { buildSnapshot, compareSnapshots } from '@pbip-lineage/core';

const RELEVANT_EXTENSIONS = ['.json', '.tmdl', '.pbir'];

/**
 * @param {FileSystemDirectoryHandle} rootHandle - Folder containing `.git`.
 * @param {{ maxCommits?: number, onProgress?: function(string) }} [options]
 * @returns {Promise<{ hasRepo: boolean, pairs: Array<{ commit, parent, isRoot, isMerge, records, summary, models: { before: Map, after: Map } }> }>}
 */
export async function scanVersionHistory(rootHandle, { maxCommits = 10, onProgress } = {}) {
  if (!await hasGitDirectory(rootHandle)) return { hasRepo: false, pairs: [] };

  const fs = createGitFs(rootHandle);
  const dir = '/';
  const blobCache = new Map();      // blob oid -> text
  const snapshotCache = new Map();  // commit oid -> snapshot
  // isomorphic-git keeps parsed packfiles in this object between calls; without
  // it every object read re-parses the repo's packs, which is very slow.
  const cache = {};
  // Folder listings by git tree id. An unchanged folder keeps the same tree id
  // across commits, so each commit only re-reads the folders that changed.
  const treeCache = new Map();

  const commits = await git.log({ fs, dir, depth: maxCommits, cache });

  async function snapshotOf(commitOid) {
    if (!commitOid) return buildSnapshot(new Map());
    if (snapshotCache.has(commitOid)) return snapshotCache.get(commitOid);
    const files = new Map();
    for (const { path, oid } of await listPbipFiles(fs, dir, commitOid, cache, treeCache)) {
      if (!blobCache.has(oid)) {
        const { blob } = await git.readBlob({ fs, dir, oid, cache });
        blobCache.set(oid, new TextDecoder().decode(blob));
      }
      files.set(path, blobCache.get(oid));
    }
    const snap = buildSnapshot(files);
    snapshotCache.set(commitOid, snap);
    return snap;
  }

  const pairs = [];
  for (let i = 0; i < commits.length; i++) {
    const entry = commits[i];
    const parents = entry.commit.parent || [];
    const parentOid = parents[0] || null;
    onProgress?.(`Comparing commit ${i + 1} of ${commits.length}…`);
    try {
      const [before, after] = [await snapshotOf(parentOid), await snapshotOf(entry.oid)];
      const { records, summary } = compareSnapshots(before, after);
      const parent = parentOid
        ? describeCommit(commits.find(c => c.oid === parentOid) || await git.readCommit({ fs, dir, oid: parentOid, cache }))
        : null;
      pairs.push({
        commit: describeCommit(entry),
        parent,
        isRoot: !parentOid,
        isMerge: parents.length > 1,
        records,
        summary,
        // Semantic-model snapshots of both sides, for the Model Diagram's
        // "changes by commit" view (model snapshots are small; reports aren't kept).
        models: { before: before.models, after: after.models },
      });
    } catch (err) {
      console.warn(`[version-compare] Failed to compare ${entry.oid.substring(0, 7)}:`, err);
      pairs.push({ commit: describeCommit(entry), parent: null, isRoot: !parentOid, isMerge: parents.length > 1, records: [], summary: null, error: err.message });
    }
  }

  return { hasRepo: true, pairs };
}

/**
 * Every PBIP-relevant file in a commit's tree, with its blob id.
 * Reads trees directly (rather than git.walk) so listings can be cached by
 * tree id and reused for unchanged folders in other commits.
 */
async function listPbipFiles(fs, dir, commitOid, cache, treeCache) {
  // readTree peels a commit id to its root tree.
  const { oid: rootTree } = await git.readTree({ fs, dir, oid: commitOid, cache });
  return listTree(rootTree, '');

  // Returns entries with paths relative to the repo root (via prefix); caches
  // them relative to the tree itself so the cache works at any depth.
  async function listTree(treeOid, prefix) {
    let entries = treeCache.get(treeOid);
    if (!entries) {
      const { tree } = await git.readTree({ fs, dir, oid: treeOid, cache });
      entries = [];
      for (const e of tree) {
        const lower = e.path.toLowerCase();
        if (e.type === 'tree') {
          if (lower === 'node_modules' || lower === '.pbi') continue;
          entries.push(...await listTree(e.oid, `${e.path}/`));
        } else if (e.type === 'blob' && RELEVANT_EXTENSIONS.some(ext => lower.endsWith(ext))) {
          entries.push({ path: e.path, oid: e.oid });
        }
      }
      treeCache.set(treeOid, entries);
    }
    return prefix ? entries.map(e => ({ path: prefix + e.path, oid: e.oid })) : entries;
  }
}

function describeCommit(entry) {
  const c = entry.commit || entry;
  const [subject, ...rest] = (c.message || '').split('\n');
  return {
    hash: entry.oid,
    message: subject,
    body: rest.join('\n').trim(),
    author: c.author?.name || '',
    date: new Date((c.committer?.timestamp || c.author?.timestamp || 0) * 1000).toISOString(),
  };
}
