/**
 * PBIP Reader - Browser-specific file reading using the File System Access API.
 * Uses @pbip-lineage/core for project structure identification.
 */

import { identifyProjectStructure, findDefinitionPbir, parseSemanticModelReference, isRelevantFile } from '@pbip-lineage/core';

/**
 * Check if the File System Access API is available and usable.
 * showDirectoryPicker exists in Chrome even on file:// but throws SecurityError.
 */
export function hasFileSystemAccess() {
  return typeof window !== 'undefined' &&
    !!window.showDirectoryPicker &&
    window.isSecureContext;
}

/**
 * Open a PBIP project root folder and auto-discover .Report + .SemanticModel subfolders.
 * Uses File System Access API on supported browsers, falls back to file input on others.
 * @returns {Promise<{reportName: string, reportStructure: object, semanticModelPath: string|null, modelName: string|null, modelStructure: object|null}>}
 */
export async function openProjectFolder() {
  if (!hasFileSystemAccess()) {
    // Fallback: use <input webkitdirectory> for Firefox/Safari
    return openProjectFromFileInput();
  }

  const rootHandle = await window.showDirectoryPicker({ mode: 'read' });
  const rootName = rootHandle.name.toLowerCase();

  // Smart detection: did the user select a .Report or .SemanticModel folder directly?
  if (rootName.endsWith('.report')) {
    return await handleDirectReportFolder(rootHandle);
  }
  if (rootName.endsWith('.semanticmodel')) {
    return await handleDirectSemanticModelFolder(rootHandle);
  }

  // Default: treat as project root — discover .Report and .SemanticModel subfolders
  const result = await handleProjectRoot(rootHandle);
  result.rootHandle = rootHandle;
  return result;
}

/**
 * Handle the case where the user selected the project root folder.
 */
async function handleProjectRoot(rootHandle) {
  const { reportEntries, modelCandidates, truncated } = await scanForReportsAndModels(rootHandle);

  if (reportEntries.length === 0) {
    throw new Error(
      'No .Report folder found in the selected directory (searched subfolders too).\n' +
      'Please select a folder that contains your .Report and .SemanticModel folders.'
    );
  }

  if (reportEntries.length > 1) {
    return { multipleReports: reportEntries, modelCandidates, truncated };
  }

  return await loadSelectedReport(
    reportEntries[0].handle, modelCandidates, reportEntries[0].path || ''
  );
}

/**
 * Recursively scan a folder tree for .Report / .SemanticModel folders.
 *
 * Saving a report as PBIP produces a sibling `X.Report` + `X.SemanticModel`
 * pair. People organise those very differently — all flat in one folder, one
 * subfolder per report, grouped by business area, or inside a wider repo — so
 * the scan walks the whole tree rather than assuming a fixed depth.
 *
 * Safety rules, because the user may well pick a large folder:
 *  - never descend INTO a matched .Report/.SemanticModel folder (its own
 *    subfolders are project internals, not more projects)
 *  - skip dot-folders, node_modules, and other build noise
 *  - stop at MAX_SCAN_DEPTH levels and MAX_MATCHES hits
 *
 * Paths are recorded (relative to the picked root) because folder NAMES are not
 * unique across a tree: two teams can each have a `Sales.Report`, and a report
 * key must be unique. Paths also let a report's definition.pbir reference
 * resolve to the right model when several models share a name.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {Promise<{ reportEntries: Array<{name: string, path: string, handle: FileSystemDirectoryHandle}>, modelCandidates: Array<{name: string, path: string, handle: FileSystemDirectoryHandle}>, truncated: boolean }>}
 */
const MAX_SCAN_DEPTH = 8;
const MAX_MATCHES = 400;
const SKIP_DIRS = new Set(['node_modules', '.git', '.vs', '.vscode', 'bin', 'obj', 'dist', 'build', '__pycache__']);

async function scanForReportsAndModels(rootHandle) {
  const reportEntries = [];
  const modelCandidates = [];
  let truncated = false;

  // Breadth-first so shallower (more likely intended) projects are found first.
  const queue = [{ handle: rootHandle, path: '', depth: 0 }];

  while (queue.length > 0) {
    const { handle: dirHandle, path: dirPath, depth } = queue.shift();
    if (depth > MAX_SCAN_DEPTH) { truncated = true; continue; }

    let entries;
    try {
      entries = [];
      for await (const entry of dirHandle.entries()) entries.push(entry);
    } catch (err) {
      // Permission or transient IO problem on one folder shouldn't abort the scan.
      console.warn(`Skipping unreadable folder: ${dirPath || '(root)'}`, err);
      continue;
    }

    for (const [name, handle] of entries) {
      if (handle.kind !== 'directory') continue;

      const lowerName = name.toLowerCase();
      const path = dirPath ? `${dirPath}/${name}` : name;

      if (lowerName.endsWith('.report')) {
        reportEntries.push({ name, path, handle });
        continue; // don't walk into a report's internals
      }
      if (lowerName.endsWith('.semanticmodel')) {
        modelCandidates.push({ name, path, handle });
        continue; // don't walk into a model's internals
      }

      if (name.startsWith('.') || SKIP_DIRS.has(lowerName)) continue;

      if (reportEntries.length + modelCandidates.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      queue.push({ handle, path, depth: depth + 1 });
    }

    if (reportEntries.length + modelCandidates.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
  }

  return { reportEntries, modelCandidates, truncated };
}

/**
 * Handle the case where the user selected a .Report folder directly.
 */
async function handleDirectReportFolder(reportHandle) {
  const { reportStructure, semanticModelPath } = await readReportFolder(reportHandle);
  return {
    reportName: reportHandle.name,
    reportStructure,
    semanticModelPath,
    modelName: null,
    modelStructure: null,
  };
}

/**
 * Handle the case where the user selected a .SemanticModel folder directly.
 */
async function handleDirectSemanticModelFolder(modelHandle) {
  throw new Error(
    'Please select the folder that contains your .Report and .SemanticModel folders, not the .SemanticModel folder directly.'
  );
}

/**
 * Load a specific report + resolve its linked semantic model.
 * @param {FileSystemDirectoryHandle} reportHandle
 * @param {Array<{name: string, path?: string, handle: FileSystemDirectoryHandle}>} modelCandidates
 * @param {string} [reportPath] - Report folder path relative to the picked root.
 *   Lets the pbir model reference resolve correctly when a recursive scan found
 *   several models sharing a base name.
 */
export async function loadSelectedReport(reportHandle, modelCandidates = [], reportPath = '') {
  const { reportStructure, semanticModelPath } = await readReportFolder(reportHandle);

  const { modelStructure, modelName } = await resolveSemanticModel(
    modelCandidates, semanticModelPath, reportPath
  );

  return {
    reportName: reportHandle.name,
    reportStructure,
    semanticModelPath,
    modelName,
    modelStructure,
  };
}

/**
 * Open a directory picker to load a semantic model folder.
 */
export async function loadSemanticModelFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    const files = await walkDirectory(dirHandle, '');
    const modelStructure = identifyProjectStructure(files);
    return { modelName: dirHandle.name, modelStructure };
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

/**
 * Read and parse a report folder's contents.
 */
async function readReportFolder(reportHandle) {
  const reportFiles = await walkDirectory(reportHandle, '');
  const reportStructure = identifyProjectStructure(reportFiles);

  const pbirPath = findDefinitionPbir(reportFiles);
  let semanticModelPath = null;
  if (pbirPath) {
    semanticModelPath = parseSemanticModelReference(reportFiles.get(pbirPath));
  }

  return { reportStructure, semanticModelPath };
}

/**
 * Pick which .SemanticModel candidate a report's definition.pbir reference
 * points to (falls back to the first candidate if there's no hint, or only
 * one candidate to begin with). Pure/no I/O so it can be reused for both a
 * single-report load and multi-report workspace grouping.
 * @param {Array<{name: string, handle: FileSystemDirectoryHandle}>} modelCandidates
 * @param {string|null} semanticModelPath
 * @returns {{name: string, handle: FileSystemDirectoryHandle}|null}
 */
function matchModelCandidate(modelCandidates, semanticModelPath, reportPath = '') {
  if (modelCandidates.length === 0) return null;
  if (modelCandidates.length === 1) return modelCandidates[0];

  const hintRaw = (semanticModelPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!hintRaw) {
    // No hint at all — prefer a model sitting beside the report over a random one.
    return findNearest(modelCandidates, reportPath) || modelCandidates[0];
  }

  // 1. Resolve the pbir reference (usually "../Name.SemanticModel") against the
  //    report's own folder, and match on the resulting full path. This is the
  //    only reliable option once several models share a base name.
  const resolved = resolveRelativePath(reportPath, hintRaw);
  if (resolved) {
    const exact = modelCandidates.find(c => c.path.toLowerCase() === resolved.toLowerCase());
    if (exact) return exact;
  }

  // 2. Fall back to base-name matching, preferring the candidate closest to the
  //    report in the tree so same-named models in other subtrees don't win.
  const hintName = hintRaw.split('/').pop().toLowerCase();
  const byName = modelCandidates.filter(c => c.name.toLowerCase() === hintName);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return findNearest(byName, reportPath) || byName[0];

  return findNearest(modelCandidates, reportPath) || modelCandidates[0];
}

/**
 * Resolve a relative reference (e.g. "../Sales.SemanticModel") against the
 * folder containing `fromPath`. Returns null if it escapes above the root.
 */
function resolveRelativePath(fromPath, relative) {
  const baseParts = (fromPath || '').split('/').filter(Boolean);
  baseParts.pop(); // drop the report folder itself -> its parent directory

  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (baseParts.length === 0) return null; // above the picked root
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

/**
 * Of several candidates, the one sharing the longest folder prefix with the
 * report — i.e. the nearest in the tree.
 */
function findNearest(candidates, reportPath) {
  if (!reportPath) return null;
  const reportParts = reportPath.split('/').filter(Boolean);
  reportParts.pop();

  let best = null;
  let bestShared = -1;
  for (const candidate of candidates) {
    const parts = candidate.path.split('/').filter(Boolean);
    parts.pop();
    let shared = 0;
    while (shared < parts.length && shared < reportParts.length
           && parts[shared].toLowerCase() === reportParts[shared].toLowerCase()) {
      shared++;
    }
    if (shared > bestShared) { bestShared = shared; best = candidate; }
  }
  return best;
}

/**
 * Resolve which .SemanticModel folder to use from candidates.
 */
async function resolveSemanticModel(modelCandidates, semanticModelPath, reportPath = '') {
  let modelStructure = null;
  let modelName = null;

  const matched = matchModelCandidate(modelCandidates, semanticModelPath, reportPath);
  if (matched) {
    const modelFiles = await walkDirectory(matched.handle, '');
    modelStructure = identifyProjectStructure(modelFiles);
    modelName = matched.name;
  }

  return { modelStructure, modelName };
}

/**
 * Load every report in a workspace folder, grouping them by which
 * .SemanticModel each one resolves to (reports that resolve to the same
 * model folder are treated as sharing it — the model is only read once).
 * The model resolved by the MOST reports is reported as the primary one;
 * callers (analyzeWorkspace) keep that model's ids unprefixed and namespace
 * everything else.
 * @param {Array<{name: string, handle: FileSystemDirectoryHandle}>} reportEntries
 * @param {Array<{name: string, handle: FileSystemDirectoryHandle}>} modelCandidates
 * @returns {Promise<{ reports: Array<{reportKey: string, reportName: string, modelKey: string, reportStructure: object}>, modelStructureByKey: Map<string, object>, primaryModelKey: string|null }>}
 */
export async function loadWorkspace(reportEntries, modelCandidates) {
  const reports = [];
  const modelStructureByKey = new Map();
  const modelKeyCounts = new Map();

  // Display names come from the folder name, but a recursive scan can turn up
  // several reports with the SAME folder name in different subtrees. Work out
  // up front which base names repeat so those can be shown with enough of
  // their path to tell apart.
  const nameCounts = new Map();
  for (const entry of reportEntries) {
    const base = entry.name.replace(/\.report$/i, '');
    nameCounts.set(base, (nameCounts.get(base) || 0) + 1);
  }

  for (const entry of reportEntries) {
    const entryPath = entry.path || entry.name;
    const { reportStructure, semanticModelPath } = await readReportFolder(entry.handle);
    const matched = matchModelCandidate(modelCandidates, semanticModelPath, entryPath);
    // Key models by PATH, not name: a recursive scan can find several models
    // sharing a base name, and keying by name would merge unrelated models.
    const modelKey = matched ? (matched.path || matched.name) : `__unresolved__:${entryPath}`;
    modelKeyCounts.set(modelKey, (modelKeyCounts.get(modelKey) || 0) + 1);

    if (matched && !modelStructureByKey.has(modelKey)) {
      const modelFiles = await walkDirectory(matched.handle, '');
      modelStructureByKey.set(modelKey, identifyProjectStructure(modelFiles));
    }

    const base = entry.name.replace(/\.report$/i, '');
    const parentFolder = entryPath.includes('/')
      ? entryPath.split('/').slice(-2, -1)[0]
      : '';
    const reportName = (nameCounts.get(base) > 1 && parentFolder)
      ? `${base} (${parentFolder})`
      : base;

    reports.push({
      // reportKey must be unique — it scopes page/visual ids in the combined
      // graph — so it uses the full relative path.
      reportKey: entryPath,
      reportName,
      modelKey,
      reportStructure,
    });
  }

  let primaryModelKey = null;
  let bestCount = -1;
  for (const [key, count] of modelKeyCounts) {
    // An unresolved (no matching .SemanticModel found) report can never be primary.
    if (key.startsWith('__unresolved__:')) continue;
    if (count > bestCount) { primaryModelKey = key; bestCount = count; }
  }

  return { reports, modelStructureByKey, primaryModelKey };
}

/**
 * Recursively walk a directory handle and collect file contents.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} [basePath='']
 * @returns {Promise<Map<string, string>>}
 */
export async function walkDirectory(dirHandle, basePath = '') {
  const files = new Map();

  for await (const [name, handle] of dirHandle.entries()) {
    const relativePath = basePath ? `${basePath}/${name}` : name;

    if (handle.kind === 'directory') {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const subFiles = await walkDirectory(handle, relativePath);
      for (const [path, content] of subFiles) {
        files.set(path, content);
      }
    } else if (handle.kind === 'file') {
      if (isRelevantFile(name)) {
        try {
          const file = await handle.getFile();
          const content = await file.text();
          files.set(relativePath, content);
        } catch (err) {
          console.warn(`Failed to read file: ${relativePath}`, err);
        }
      }
    }
  }

  return files;
}

// --- Cross-browser fallback using <input webkitdirectory> ---

/**
 * Open project using a hidden <input webkitdirectory> file input.
 * Works in Firefox, Safari, and all Chromium browsers.
 * @returns {Promise<object>}
 */
function openProjectFromFileInput() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      try {
        if (!input.files || input.files.length === 0) {
          reject(new DOMException('No folder selected', 'AbortError'));
          return;
        }
        const result = await processFileList(input.files);
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        input.remove();
      }
    });

    input.addEventListener('cancel', () => {
      input.remove();
      reject(new DOMException('User cancelled', 'AbortError'));
    });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Process a FileList from webkitdirectory input into project structure.
 * Files have webkitRelativePath like "MyProject/MyProject.Report/definition/pages/..."
 * @param {FileList} fileList
 * @returns {Promise<object>}
 */
async function processFileList(fileList) {
  // Read all relevant files into a map keyed by relative path
  const allFiles = new Map();
  const rootParts = new Set();

  for (const file of fileList) {
    const relPath = file.webkitRelativePath;
    if (!relPath) continue;

    // Track the root folder name
    const parts = relPath.split('/');
    if (parts.length > 0) rootParts.add(parts[0]);

    // Only read relevant extensions
    const fileName = parts[parts.length - 1];
    if (isRelevantFile(fileName)) {
      try {
        const content = await file.text();
        allFiles.set(relPath, content);
      } catch (err) {
        console.warn(`Failed to read file: ${relPath}`, err);
      }
    }
  }

  // Find .Report and .SemanticModel folders
  const reportFolders = [];
  const modelFolders = [];

  // Get all unique second-level folder names
  const secondLevel = new Set();
  for (const [path] of allFiles) {
    const parts = path.split('/');
    if (parts.length >= 2) secondLevel.add(parts[1]);
  }

  // Also check the root folder itself
  const rootName = [...rootParts][0] || '';

  for (const folderName of secondLevel) {
    const lower = folderName.toLowerCase();
    if (lower.endsWith('.report')) reportFolders.push(folderName);
    else if (lower.endsWith('.semanticmodel')) modelFolders.push(folderName);
  }

  // Also check if root is itself a .Report or .SemanticModel
  if (rootName.toLowerCase().endsWith('.report')) {
    return processAsReport(rootName, allFiles, rootName);
  }
  if (rootName.toLowerCase().endsWith('.semanticmodel')) {
    throw new Error('Please select the folder that contains your .Report and .SemanticModel folders.');
  }

  if (reportFolders.length === 0) {
    throw new Error(
      'No .Report folder found in the selected directory.\n' +
      'Please select the folder that contains your .Report and .SemanticModel subfolders.'
    );
  }

  // For now, use the first report and first model (multi-report picker could be added later)
  const reportFolder = reportFolders[0];
  const modelFolder = modelFolders[0] || null;

  // Extract report files (strip the root/reportFolder prefix)
  const reportPrefix = `${rootName}/${reportFolder}/`;
  const reportFiles = new Map();
  for (const [path, content] of allFiles) {
    if (path.startsWith(reportPrefix)) {
      reportFiles.set(path.slice(reportPrefix.length), content);
    }
  }
  const reportStructure = identifyProjectStructure(reportFiles);

  // Find semantic model reference
  const pbirPath = findDefinitionPbir(reportFiles);
  let semanticModelPath = null;
  if (pbirPath) {
    semanticModelPath = parseSemanticModelReference(reportFiles.get(pbirPath));
  }

  // Extract model files
  let modelStructure = null;
  let modelName = null;
  if (modelFolder) {
    const modelPrefix = `${rootName}/${modelFolder}/`;
    const modelFiles = new Map();
    for (const [path, content] of allFiles) {
      if (path.startsWith(modelPrefix)) {
        modelFiles.set(path.slice(modelPrefix.length), content);
      }
    }
    modelStructure = identifyProjectStructure(modelFiles);
    modelName = modelFolder;
  }

  return {
    reportName: reportFolder,
    reportStructure,
    semanticModelPath,
    modelName,
    modelStructure,
  };
}

/**
 * Process files when the root folder is itself a .Report folder.
 */
function processAsReport(reportName, allFiles, rootName) {
  const prefix = `${rootName}/`;
  const reportFiles = new Map();
  for (const [path, content] of allFiles) {
    if (path.startsWith(prefix)) {
      reportFiles.set(path.slice(prefix.length), content);
    }
  }
  const reportStructure = identifyProjectStructure(reportFiles);
  const pbirPath = findDefinitionPbir(reportFiles);
  let semanticModelPath = null;
  if (pbirPath) {
    semanticModelPath = parseSemanticModelReference(reportFiles.get(pbirPath));
  }
  return {
    reportName,
    reportStructure,
    semanticModelPath,
    modelName: null,
    modelStructure: null,
  };
}
