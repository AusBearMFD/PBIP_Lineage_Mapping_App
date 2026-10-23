/**
 * Main entry point for PBIP Lineage Explorer.
 * Orchestrates parsing, graph building, and UI initialization.
 * Single-view: measure picker + lineage trace output with D3 tree visualization.
 */

// Core analysis engine
import {
  parseTmdlModel, parseExpressions, parseDaxExpression,
  parsePbirReport, detectEnrichments, applyEnrichments,
  buildGraph, computeStats, traceMeasureLineage, traceVisualLineage,
  identifyProjectStructure, analyzeWorkspace,
} from '@pbip-lineage/core';

// Browser-specific file reader
import { openProjectFolder, loadSelectedReport, loadSemanticModelFolder, loadWorkspace } from './parser/pbipReader.js';

// UI
import { initToolbar, updateStats, showLoading, hideLoading } from './ui/toolbar.js';
import { initMeasurePicker, populateMeasures, selectMeasure, updateChangeCounts } from './ui/measurePicker.js';
import { initVisualBrowser, populateVisuals, selectVisual, updatePageChangeCounts } from './ui/visualBrowser.js';
import { initLineageView, renderLineage, renderVisualLineage, clearLineage, setChangeData, renderPageChangeHistory } from './ui/lineageView.js';
import { populateSourceMapping, renderSourceMapping } from './ui/sourceMapping.js';
import { initPageLayout, renderPageLayout } from './ui/pageLayout.js';
import { initImpactPanel, openImpactPanel } from './ui/impactPanel.js';
import { initModelHealth, toggleModelHealth, closeModelHealth } from './ui/modelHealth.js';
import { initMeasureMap, renderMeasureMap, setCenterMeasure as setMeasureMapCenter } from './ui/measureMap.js';
import { initDependentsView, populateDependents, renderDependentsView } from './ui/dependentsView.js';
import { initChangeHistory, setChangeHistoryData, renderChangeHistory, getChangeHistoryCount } from './ui/changeHistoryView.js';
import { initVersionCompare, setVersionCompareData, renderVersionCompare, getVersionCompareStatus } from './ui/versionCompareView.js';
import { initModelDiagram, setModelDiagramModels, setModelDiagramHistory, renderModelDiagram, showModelDiagramChange } from './ui/modelDiagramView.js';
import { scanGitHistory } from './parser/gitScanner.js';
import { scanVersionHistory } from './parser/snapshotScanner.js';

const state = {
  graph: null,
  reportStructure: null,
  reportName: null,
  semanticModelPath: null,
  sourceMapVisible: false,
  measureMapVisible: false,
  changeHistoryVisible: false,
  versionCompareVisible: false,
  modelDiagramVisible: false,
  versionScanToken: 0, // bumps on each project load so a stale scan can't overwrite newer results
  workspace: null, // { reports, primaryModelKey, multiModel } — set when a multi-report workspace is loaded
  measureSelectCount: 0,
  navigationHistory: [], // stack of { type: 'measure'|'visual', id: string }
  currentSelection: null, // { type: 'measure'|'visual', id: string }
  sessionStats: { measuresTraced: 0, columnsmapped: 0, visualsExplored: 0 },
  rootHandle: null, // FileSystemDirectoryHandle for git scanning
  changeData: null, // { flatChanges, measureChangeCounts }
};

// Sample project file manifest (fetched from /sample-pbip/)
const SAMPLE_FILES = [
  'definition/expressions.tmdl',
  'definition/relationships.tmdl',
  'definition/tables/Customers.tmdl',
  'definition/tables/DateTable.tmdl',
  'definition/tables/FieldParameter.tmdl',
  'definition/tables/Products.tmdl',
  'definition/tables/Sales.tmdl',
  'definition/tables/TimeCalc.tmdl',
  'report/definition/pages/page1/page.json',
  'report/definition/pages/page1/visuals/visual1/visual.json',
  'report/definition/pages/page1/visuals/visual2/visual.json',
  'report/definition/pages/page1/visuals/visual3/visual.json',
  'report/definition/pages/page2/page.json',
  'report/definition/pages/page2/visuals/visual4/visual.json',
  'report/definition/pages/page2/visuals/visual5/visual.json',
];

// --- Initialization ---

function init() {
  initToolbar({ onOpenFolder: handleOpenFolder });
  initMeasurePicker({ onSelect: handleMeasureSelect });
  initVisualBrowser({ onVisualSelect: handleVisualSelect, onMeasureNavigate: handleMeasureSelect, onPageLayoutSelect: handlePageLayoutSelect, onPageChangeBadgeClick: handlePageChangeBadgeClick });
  initLineageView({ onMeasureNavigate: handleMeasureSelect, onVisualNavigate: handleVisualSelect });
  initPageLayout({ onVisualSelect: handleVisualSelect });
  initImpactPanel({ onMeasureNavigate: handleMeasureSelect, onVisualNavigate: handleVisualSelect });
  initModelHealth({ onMeasureNavigate: handleMeasureSelect });
  initMeasureMap({ onVisualNavigate: handleVisualSelect, onPageNavigate: handlePageLayoutSelect });
  initDependentsView({ onMeasureSelect: handleMeasureSelect });
  initChangeHistory({ onMeasureNavigate: handleMeasureSelect, onVisualNavigate: handleVisualSelect });
  initVersionCompare({ onRequestScan: startVersionScan, onShowInDiagram: openModelDiagramAt });
  initModelDiagram({ onRequestHistory: startVersionScan });

  const btnLoadModel = document.getElementById('btn-load-model');
  if (btnLoadModel) btnLoadModel.addEventListener('click', handleLoadSemanticModel);

  const btnTrySample = document.getElementById('btn-try-sample');
  if (btnTrySample) btnTrySample.addEventListener('click', handleLoadSampleProject);

  const btnBack = document.getElementById('btn-back');
  if (btnBack) btnBack.addEventListener('click', navigateBack);

  // Source Map toggle
  const btnSourceMap = document.getElementById('btn-source-map');
  if (btnSourceMap) btnSourceMap.addEventListener('click', toggleSourceMap);

  // Measure Map toggle
  const btnMeasureMap = document.getElementById('btn-measure-map');
  if (btnMeasureMap) btnMeasureMap.addEventListener('click', toggleMeasureMap);

  // Change History toggle
  const btnChangeHistory = document.getElementById('btn-change-history');
  if (btnChangeHistory) btnChangeHistory.addEventListener('click', toggleChangeHistory);

  // Version Compare toggle
  const btnVersionCompare = document.getElementById('btn-version-compare');
  if (btnVersionCompare) btnVersionCompare.addEventListener('click', toggleVersionCompare);

  // Model Diagram toggle
  const btnModelDiagram = document.getElementById('btn-model-diagram');
  if (btnModelDiagram) btnModelDiagram.addEventListener('click', toggleModelDiagram);

  // Model Health toggle
  const btnModelHealth = document.getElementById('btn-model-health');
  if (btnModelHealth) btnModelHealth.addEventListener('click', () => {
    if (!state.graph) return;
    exitChangeHistoryIfActive();
    exitVersionCompareIfActive();
    exitModelDiagramIfActive();
    toggleModelHealth(state.graph);
  });

  // Bulk Export
  const btnBulkExport = document.getElementById('btn-bulk-export');
  if (btnBulkExport) btnBulkExport.addEventListener('click', () => {
    if (state.graph) handleBulkExport();
  });

  // Toast close
  const toastClose = document.getElementById('toast-close');
  if (toastClose) toastClose.addEventListener('click', hideToast);

  // Keyboard help
  const btnKeyboardHelp = document.getElementById('btn-keyboard-help');
  if (btnKeyboardHelp) btnKeyboardHelp.addEventListener('click', toggleKeyboardHelp);

  // Sidebar tab switching
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const panelId = `tab-${tab.dataset.tab}`;
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.remove('hidden');

      // The Dependents grid lives in the main panel (it needs the full width),
      // so switching tabs also swaps what the main panel shows.
      if (tab.dataset.tab === 'dependents') showDependentsGrid();
      else hideDependentsGrid();
    });
  });

  document.addEventListener('keydown', handleKeyDown);

  // Drag-and-drop on welcome overlay
  initDragAndDrop();

  // Deep link: restore selection from URL hash after project load
  window.addEventListener('hashchange', handleHashNavigation);
}

// --- Source Map Toggle ---

function toggleSourceMap() {
  state.sourceMapVisible = !state.sourceMapVisible;
  const btn = document.getElementById('btn-source-map');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const sourceMapContainer = document.getElementById('source-map-container');

  if (state.sourceMapVisible) {
    exitMeasureMapIfActive();
    exitChangeHistoryIfActive();
    exitVersionCompareIfActive();
    exitModelDiagramIfActive();
    hideDependentsGrid();
    closeModelHealth();
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (sourceMapContainer) {
      sourceMapContainer.classList.remove('hidden');
      renderSourceMapping(sourceMapContainer);
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
    // Restore previous lineage view
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else {
      if (lineageEmpty) lineageEmpty.classList.remove('hidden');
    }
  }
}

// --- Measure Map Toggle ---

function toggleMeasureMap() {
  if (!state.measureMapVisible && !state.graph) return;
  state.measureMapVisible = !state.measureMapVisible;
  const btn = document.getElementById('btn-measure-map');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const sourceMapContainer = document.getElementById('source-map-container');
  const measureMapContainer = document.getElementById('measure-map-container');

  if (state.measureMapVisible) {
    if (state.sourceMapVisible) {
      state.sourceMapVisible = false;
      const sourceBtn = document.getElementById('btn-source-map');
      if (sourceBtn) sourceBtn.classList.remove('active');
      if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
    }
    exitChangeHistoryIfActive();
    exitVersionCompareIfActive();
    exitModelDiagramIfActive();
    hideDependentsGrid();
    closeModelHealth();
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (measureMapContainer) {
      measureMapContainer.classList.remove('hidden');
      const centerId = state.currentSelection?.type === 'measure' ? state.currentSelection.id : undefined;
      renderMeasureMap(measureMapContainer, state.graph, { centerMeasureId: centerId });
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (measureMapContainer) measureMapContainer.classList.add('hidden');
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else if (lineageEmpty) {
      lineageEmpty.classList.remove('hidden');
    }
  }
}

// --- Dependents grid (main panel, driven by the sidebar tab) ---

function showDependentsGrid() {
  if (!state.graph) return;
  exitMeasureMapIfActive();
  exitChangeHistoryIfActive();
  exitVersionCompareIfActive();
  exitModelDiagramIfActive();
  closeModelHealth();
  if (state.sourceMapVisible) {
    state.sourceMapVisible = false;
    const sourceBtn = document.getElementById('btn-source-map');
    if (sourceBtn) sourceBtn.classList.remove('active');
    const sourceMapContainer = document.getElementById('source-map-container');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
  }
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  if (lineageEmpty) lineageEmpty.classList.add('hidden');
  if (lineageContent) lineageContent.classList.add('hidden');

  const container = document.getElementById('dependents-container');
  if (container) {
    container.classList.remove('hidden');
    renderDependentsView(container);
  }
}

function hideDependentsGrid() {
  const container = document.getElementById('dependents-container');
  if (!container || container.classList.contains('hidden')) return;
  container.classList.add('hidden');

  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  if (lineageContent && lineageContent.innerHTML.trim()) {
    lineageContent.classList.remove('hidden');
  } else if (lineageEmpty) {
    lineageEmpty.classList.remove('hidden');
  }
}

// --- Change History (main panel, toolbar button) ---

function toggleChangeHistory() {
  if (!state.changeHistoryVisible && !state.graph) return;
  state.changeHistoryVisible = !state.changeHistoryVisible;
  const btn = document.getElementById('btn-change-history');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const container = document.getElementById('change-history-container');

  if (state.changeHistoryVisible) {
    if (state.sourceMapVisible) {
      state.sourceMapVisible = false;
      document.getElementById('btn-source-map')?.classList.remove('active');
      document.getElementById('source-map-container')?.classList.add('hidden');
    }
    exitMeasureMapIfActive();
    exitVersionCompareIfActive();
    exitModelDiagramIfActive();
    hideDependentsGrid();
    closeModelHealth();
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (container) {
      container.classList.remove('hidden');
      renderChangeHistory(container, state.graph);
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (container) container.classList.add('hidden');
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else if (lineageEmpty) {
      lineageEmpty.classList.remove('hidden');
    }
  }
}

/** Exit the Change History view (used when another main-panel view takes over). */
function exitChangeHistoryIfActive() {
  if (!state.changeHistoryVisible) return;
  state.changeHistoryVisible = false;
  document.getElementById('btn-change-history')?.classList.remove('active');
  document.getElementById('change-history-container')?.classList.add('hidden');
}

// --- Version Compare (main panel, toolbar button) ---

function toggleVersionCompare() {
  if (!state.versionCompareVisible && !state.graph) return;
  state.versionCompareVisible = !state.versionCompareVisible;
  const btn = document.getElementById('btn-version-compare');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const container = document.getElementById('version-compare-container');

  if (state.versionCompareVisible) {
    if (state.sourceMapVisible) {
      state.sourceMapVisible = false;
      document.getElementById('btn-source-map')?.classList.remove('active');
      document.getElementById('source-map-container')?.classList.add('hidden');
    }
    exitMeasureMapIfActive();
    exitChangeHistoryIfActive();
    exitModelDiagramIfActive();
    hideDependentsGrid();
    closeModelHealth();
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (container) {
      container.classList.remove('hidden');
      renderVersionCompare(container); // starts the snapshot scan on first open
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (container) container.classList.add('hidden');
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else if (lineageEmpty) {
      lineageEmpty.classList.remove('hidden');
    }
  }
}

/** Exit the Version Compare view (used when another main-panel view takes over). */
function exitVersionCompareIfActive() {
  if (!state.versionCompareVisible) return;
  state.versionCompareVisible = false;
  document.getElementById('btn-version-compare')?.classList.remove('active');
  document.getElementById('version-compare-container')?.classList.add('hidden');
}

// --- Model Diagram (main panel, toolbar button) ---

function toggleModelDiagram() {
  if (!state.modelDiagramVisible && !state.graph) return;
  state.modelDiagramVisible = !state.modelDiagramVisible;
  const btn = document.getElementById('btn-model-diagram');
  const lineageEmpty = document.getElementById('lineage-empty');
  const lineageContent = document.getElementById('lineage-content');
  const container = document.getElementById('model-diagram-container');

  if (state.modelDiagramVisible) {
    if (state.sourceMapVisible) {
      state.sourceMapVisible = false;
      document.getElementById('btn-source-map')?.classList.remove('active');
      document.getElementById('source-map-container')?.classList.add('hidden');
    }
    exitMeasureMapIfActive();
    exitChangeHistoryIfActive();
    exitVersionCompareIfActive();
    hideDependentsGrid();
    closeModelHealth();
    if (btn) btn.classList.add('active');
    if (lineageEmpty) lineageEmpty.classList.add('hidden');
    if (lineageContent) lineageContent.classList.add('hidden');
    if (container) {
      container.classList.remove('hidden');
      renderModelDiagram(container);
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (container) container.classList.add('hidden');
    if (lineageContent && lineageContent.innerHTML.trim()) {
      lineageContent.classList.remove('hidden');
    } else if (lineageEmpty) {
      lineageEmpty.classList.remove('hidden');
    }
  }
}

/** Exit the Model Diagram view (used when another main-panel view takes over). */
function exitModelDiagramIfActive() {
  if (!state.modelDiagramVisible) return;
  state.modelDiagramVisible = false;
  document.getElementById('btn-model-diagram')?.classList.remove('active');
  document.getElementById('model-diagram-container')?.classList.add('hidden');
}

/** From Version Compare: open the Model Diagram's commit view focused on a change. */
function openModelDiagramAt(focus) {
  showModelDiagramChange(focus);
  if (state.modelDiagramVisible) renderModelDiagram(document.getElementById('model-diagram-container'));
  else toggleModelDiagram();
}

/** Version history feeds both Version Compare and the Model Diagram's commit view. */
function setVersionData(data) {
  setVersionCompareData(data);
  setModelDiagramHistory(data);
}

/** Display name of a semantic model folder ("Sales.SemanticModel" -> "Sales"). */
function modelDisplayName(nameOrPath) {
  return String(nameOrPath || '').split('/').pop().replace(/\.semanticmodel$/i, '') || 'Semantic model';
}

/** Give the Model Diagram the open project's semantic model(s). */
function publishDiagramModels(entries) {
  // Names pick models in the diagram, so make repeated folder names unique.
  const counts = new Map();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) || 0) + 1);
  setModelDiagramModels(entries.map(e => (counts.get(e.name) > 1 ? { ...e, name: e.key } : e)));
}

/**
 * Read full snapshots of recent commits and compare each with its parent.
 * Runs on first open of Version Compare (reading every PBIP file per version
 * costs more than the Commit Edits scan, so it isn't done on every load).
 */
async function startVersionScan() {
  if (getVersionCompareStatus() === 'scanning') return;
  if (!state.rootHandle) {
    setVersionData({ status: 'unavailable' });
    return;
  }
  const token = ++state.versionScanToken;
  setVersionData({ status: 'scanning', progress: 'Reading the repository…' });
  try {
    const { hasRepo, pairs } = await scanVersionHistory(state.rootHandle, {
      onProgress: (progress) => { if (token === state.versionScanToken) setVersionData({ status: 'scanning', progress }); },
    });
    if (token !== state.versionScanToken) return; // a different project was loaded meanwhile
    setVersionData({ status: 'ready', hasRepo, pairs });
  } catch (err) {
    if (token !== state.versionScanToken) return;
    console.warn('Version Compare scan failed:', err);
    setVersionData({ status: 'error' });
  }
}

/** Show the number of detected changes on the toolbar button. */
function updateChangeHistoryBadge() {
  const badge = document.getElementById('change-history-count');
  if (!badge) return;
  const n = getChangeHistoryCount();
  badge.textContent = n > 0 ? String(n) : '';
  badge.classList.toggle('hidden', n === 0);
}

/** Exit the Measure Map view (used when navigating away via measure/visual/page selection). */
function exitMeasureMapIfActive() {
  if (!state.measureMapVisible) return;
  state.measureMapVisible = false;
  const btn = document.getElementById('btn-measure-map');
  if (btn) btn.classList.remove('active');
  const measureMapContainer = document.getElementById('measure-map-container');
  if (measureMapContainer) measureMapContainer.classList.add('hidden');
}

// --- Toast ---

function showSponsorToast() {
  if (sessionStorage.getItem('pbip-toast-shown')) return;
  const traceCount = state.sessionStats.measuresTraced;
  if (traceCount < 3) return; // Wait until user has traced 3+ items
  const toast = document.getElementById('sponsor-toast');
  const messageEl = document.getElementById('toast-message');
  if (toast && messageEl) {
    const minutesSaved = traceCount * 15;
    messageEl.innerHTML = `You saved ~<strong>${minutesSaved} minutes</strong> this session.`;
    toast.classList.remove('hidden');
    sessionStorage.setItem('pbip-toast-shown', '1');
  }
}

function hideToast() {
  const toast = document.getElementById('sponsor-toast');
  if (toast) toast.classList.add('hidden');
}

// --- Value Counter ---

function updateValueCounter() {
  let counter = document.getElementById('value-counter');
  if (!counter) {
    // Create counter element at the bottom of lineage sections
    counter = document.createElement('div');
    counter.id = 'value-counter';
    counter.className = 'value-counter';
    const sections = document.getElementById('lineage-sections');
    if (sections) sections.after(counter);
  }
  const { measuresTraced, columnsmapped, visualsExplored } = state.sessionStats;
  const parts = [];
  if (measuresTraced > 0) parts.push(`${measuresTraced} measure${measuresTraced !== 1 ? 's' : ''} traced`);
  if (columnsmapped > 0) parts.push(`${columnsmapped} column${columnsmapped !== 1 ? 's' : ''} mapped`);
  if (visualsExplored > 0) parts.push(`${visualsExplored} visual${visualsExplored !== 1 ? 's' : ''} explored`);
  if (parts.length > 0) {
    // Milestone flourish at 5 and 10 traces
    let milestoneText = '';
    if (measuresTraced === 5 || measuresTraced === 10) {
      milestoneText = measuresTraced === 10 ? ' &mdash; power user!' : '';
      counter.classList.add('milestone');
      setTimeout(() => counter.classList.remove('milestone'), 1000);
    }

    counter.innerHTML = `${parts.join(' &middot; ')} in this session${milestoneText}`;
    counter.classList.remove('hidden');
  }
}

// --- Bulk Export ---

function handleBulkExport() {
  if (!state.graph) return;

  const measureNodes = [];
  for (const node of state.graph.nodes.values()) {
    if (node.type === 'measure') measureNodes.push(node);
  }

  const rows = [['Measure', 'Table', 'DAX Expression', 'PBI Table', 'PBI Column', 'Data Type', 'Hidden', 'Source Column', 'Source Table', 'Mode', 'Renamed', 'Used By Visuals']];

  for (const node of measureNodes) {
    try {
      const lineage = traceMeasureLineage(node.id, state.graph);
      if (!lineage) continue;

      const visualNames = (lineage.visuals || []).map(v => v.title || v.name || v.id).join('; ');

      if (lineage.sourceTable && lineage.sourceTable.length > 0) {
        for (const row of lineage.sourceTable) {
          rows.push([
            node.name,
            node.metadata?.table || '',
            (node.metadata?.expression || '').replace(/\n/g, ' ').substring(0, 200),
            row.pbiTable,
            row.pbiColumn,
            row.dataType || '',
            row.isHidden ? 'Yes' : '',
            row.sourceColumn,
            row.sourceTable,
            row.mode,
            row.renamed ? 'Yes' : '',
            visualNames,
          ]);
        }
      } else {
        rows.push([
          node.name,
          node.metadata?.table || '',
          (node.metadata?.expression || '').replace(/\n/g, ' ').substring(0, 200),
          '', '', '', '', '', '', '', '',
          visualNames,
        ]);
      }
    } catch {
      // Skip measures that fail to trace
    }
  }

  // Build CSV
  const csv = rows.map(row =>
    row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const footer = '\n"Traced with PBIP Lineage Explorer (Abearstudios build) — based on the open-source PBIP Lineage Explorer by Jihwan Kim"';
  const blob = new Blob([csv + footer], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `lineage-export-${state.reportName || 'model'}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// --- Keyboard Help ---

function toggleKeyboardHelp() {
  const popover = document.getElementById('keyboard-help-popover');
  if (popover) popover.classList.toggle('hidden');
}

// --- Data Loading ---

async function handleOpenFolder() {
  try {
    clearWelcomeError();
    showLoading('Select the folder that contains your .Report and .SemanticModel folders...');

    const projectResult = await openProjectFolder();
    // Remember the picked folder for the git scan. Kept in state (not just on
    // projectResult) because the multi-report picker path loads later and
    // would otherwise lose it.
    state.rootHandle = projectResult.rootHandle || null;

    // Multiple reports found — show picker overlay
    if (projectResult.multipleReports) {
      hideLoading();
      showReportPicker(projectResult.multipleReports, projectResult.modelCandidates);
      return;
    }

    // Single report (or direct .Report selection) — load immediately
    await loadProjectResult(projectResult);
  } catch (err) {
    hideLoading();
    hideLoadingOverlay();
    if (err.name === 'AbortError') return;
    console.error('Error loading project:', err);
    showWelcomeError(`Failed to load project: ${err.message}`);
  }
}

/**
 * Load the bundled sample project to let first-time users try the tool without a PBIP project.
 */
async function handleLoadSampleProject() {
  try {
    clearWelcomeError();
    state.rootHandle = null; // the bundled sample has no git history
    showLoadingProgress('Loading sample project...', 10);

    // Fetch all sample files in parallel
    const basePath = import.meta.env.BASE_URL || '/';
    const entries = await Promise.all(
      SAMPLE_FILES.map(async (filePath) => {
        const resp = await fetch(`${basePath}sample-pbip/${filePath}`);
        if (!resp.ok) throw new Error(`Failed to fetch ${filePath}`);
        const content = await resp.text();
        return [filePath, content];
      })
    );

    const allFiles = new Map(entries);

    // Separate into model files (definition/) and report files (report/)
    const modelFiles = new Map();
    const reportFiles = new Map();
    for (const [path, content] of allFiles) {
      if (path.startsWith('report/')) {
        // Strip 'report/' prefix to match expected structure
        reportFiles.set(path.slice('report/'.length), content);
      } else {
        modelFiles.set(path, content);
      }
    }

    const modelStructure = identifyProjectStructure(modelFiles);
    const reportStructure = identifyProjectStructure(reportFiles);

    // Build a projectResult matching the shape expected by loadProjectResult
    const projectResult = {
      reportName: 'Sample Report',
      reportStructure,
      semanticModelPath: null,
      modelName: 'Sample SemanticModel',
      modelStructure,
    };

    await loadProjectResult(projectResult);
  } catch (err) {
    hideLoading();
    hideLoadingOverlay();
    console.error('Error loading sample project:', err);
    showWelcomeError(`Failed to load sample project: ${err.message}`);
  }
}

/**
 * Show the report picker overlay when multiple .Report folders are found.
 */
/** Escape text for safe interpolation into innerHTML. */
function escapeHtmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showReportPicker(reportEntries, modelCandidates) {
  const overlay = document.getElementById('report-picker-overlay');
  const list = document.getElementById('report-picker-list');
  if (!overlay || !list) return;

  // Hide welcome overlay
  const welcome = document.getElementById('welcome-overlay');
  if (welcome) welcome.classList.add('hidden');

  list.innerHTML = '';

  if (reportEntries.length > 1) {
    const workspaceItem = document.createElement('div');
    workspaceItem.className = 'report-picker-item report-picker-item-workspace';
    workspaceItem.innerHTML = `<strong>Load all ${reportEntries.length} reports as a workspace</strong><span>See impact and lineage across every report at once — the semantic model most of them share stays fully merged.</span>`;
    workspaceItem.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      try {
        showLoadingProgress('Loading workspace...', 10);
        const { reports, modelStructureByKey, primaryModelKey } = await loadWorkspace(reportEntries, modelCandidates);
        await loadWorkspaceResult({ reports, modelStructureByKey, primaryModelKey });
      } catch (err) {
        hideLoadingOverlay();
        console.error('Error loading workspace:', err);
        showWelcomeError(`Failed to load workspace: ${err.message}`);
      }
    });
    list.appendChild(workspaceItem);

    const divider = document.createElement('div');
    divider.className = 'report-picker-divider';
    divider.textContent = 'Or pick just one report';
    list.appendChild(divider);
  }

  for (const entry of reportEntries) {
    const item = document.createElement('div');
    item.className = 'report-picker-item';
    // Show the containing folder path when the report isn't at the root, since
    // a recursive scan can surface several reports with the same folder name.
    const parentPath = (entry.path || '').includes('/')
      ? entry.path.split('/').slice(0, -1).join('/')
      : '';
    if (parentPath) {
      item.innerHTML = `<strong>${escapeHtmlText(entry.name)}</strong><span class="report-picker-path">${escapeHtmlText(parentPath)}</span>`;
    } else {
      item.textContent = entry.name;
    }
    item.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      try {
        showLoadingProgress('Loading report...', 10);
        const result = await loadSelectedReport(entry.handle, modelCandidates, entry.path || '');
        await loadProjectResult(result);
      } catch (err) {
        hideLoadingOverlay();
        console.error('Error loading report:', err);
        showWelcomeError(`Failed to load report: ${err.message}`);
      }
    });
    list.appendChild(item);
  }

  overlay.classList.remove('hidden');
}

/**
 * Process a loaded multi-report workspace: analyze, build the combined
 * graph, update UI. Mirrors loadProjectResult() but for several reports —
 * see analyzeWorkspace() in @pbip-lineage/core for how the combined graph
 * is actually built.
 */
async function loadWorkspaceResult({ reports, modelStructureByKey, primaryModelKey }) {
  showLoadingProgress(`Step 1/2: Analyzing ${reports.length} reports...`, 30);

  const { graph } = analyzeWorkspace({ reports, modelStructureByKey, primaryModelKey });
  publishDiagramModels([...modelStructureByKey].map(([key, structure]) => ({
    key,
    name: modelDisplayName(key),
    structure,
    reports: reports.filter(r => r.modelKey === key).map(r => r.reportName),
  })));
  state.graph = graph;
  state.workspace = graph.workspace;
  window.__graph = graph; // debug helper

  showLoadingProgress('Step 2/2: Done!', 100);

  state.reportStructure = null;
  state.reportName = `${reports.length} reports`;
  state.semanticModelPath = null;

  const rawStats = computeStats(graph);
  updateStats({
    projectName: `Workspace — ${reports.length} reports`,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    byType: {
      table: rawStats.tables, measure: rawStats.measures,
      visual: rawStats.visuals, column: rawStats.columns,
      page: rawStats.pages, source: rawStats.sources,
    },
    orphanedMeasures: rawStats.orphanedMeasures || 0,
    fieldParameters: 0,
    calculationGroups: 0,
  });

  state.navigationHistory = [];
  state.currentSelection = null;
  updateBackButton();

  populateMeasures(graph);
  populateVisuals(graph);
  populateSourceMapping(graph);
  populateDependents(graph);

  enableProjectToolbarButtons();

  const filterRow = document.getElementById('measure-filter-row');
  if (filterRow) filterRow.classList.remove('hidden');

  const overlay = document.getElementById('welcome-overlay');
  if (overlay) overlay.classList.add('hidden');

  const banner = document.getElementById('model-banner');
  if (banner) banner.classList.add('hidden');

  hideLoading();
  hideLoadingOverlay();

  if (graph.workspace?.multiModel) {
    const secondaryCount = graph.workspace.reports.filter(r => !r.isPrimaryModel).length;
    console.info(`Workspace loaded: ${reports.length} reports, ${modelStructureByKey.size} distinct semantic models (${secondaryCount} report${secondaryCount !== 1 ? 's' : ''} on a non-primary model).`);
  }

  // Async git history scan (non-blocking) — workspaces are usually one repo.
  startGitScan();
}

/**
 * Enable the toolbar buttons that only make sense once a project/workspace
 * graph is loaded (they're always visible, just disabled until then).
 * Shared by the single-report and multi-report-workspace load paths.
 */
function enableProjectToolbarButtons() {
  const btnSourceMap = document.getElementById('btn-source-map');
  if (btnSourceMap) {
    btnSourceMap.disabled = false;
    btnSourceMap.title = 'Source Mapping — flat table showing every PBI column mapped to its original source column and database. Ideal for data engineers.';
  }
  const btnModelHealth = document.getElementById('btn-model-health');
  if (btnModelHealth) {
    btnModelHealth.disabled = false;
    btnModelHealth.title = 'Model Health — overview of tables, columns, measures, relationships, and data sources.';
  }
  const btnBulkExportShow = document.getElementById('btn-bulk-export');
  if (btnBulkExportShow) {
    btnBulkExportShow.disabled = false;
    btnBulkExportShow.title = 'Export All — export the full source column mapping for every measure as a CSV file.';
  }
  const btnMeasureMapShow = document.getElementById('btn-measure-map');
  if (btnMeasureMapShow) {
    btnMeasureMapShow.disabled = false;
  }
  const btnChangeHistoryShow = document.getElementById('btn-change-history');
  if (btnChangeHistoryShow) {
    btnChangeHistoryShow.disabled = false;
  }
  const btnVersionCompareShow = document.getElementById('btn-version-compare');
  if (btnVersionCompareShow) {
    btnVersionCompareShow.disabled = false;
  }
  const btnModelDiagramShow = document.getElementById('btn-model-diagram');
  if (btnModelDiagramShow) {
    btnModelDiagramShow.disabled = false;
  }
}

/**
 * Process a loaded project result (single report): parse, build graph, update UI.
 */
async function loadProjectResult(projectResult) {
  const modelStructure = projectResult.modelStructure;

  state.reportStructure = projectResult.reportStructure;
  state.reportName = projectResult.reportName;
  state.semanticModelPath = projectResult.semanticModelPath;
  publishDiagramModels(modelStructure ? [{
    key: projectResult.semanticModelPath || projectResult.modelName || 'model',
    name: modelDisplayName(projectResult.modelName),
    structure: modelStructure,
    reports: projectResult.reportName ? [projectResult.reportName] : [],
  }] : []);

  showLoadingProgress('Step 1/5: Parsing model...', 10);

  const tmdlFiles = modelStructure?.tmdlFiles || [];
  const relationshipFiles = modelStructure?.relationshipFiles || [];
  const expressionFiles = modelStructure?.expressionFiles || [];
  const model = parseTmdlModel(tmdlFiles, relationshipFiles);

  let parsedExpressions = { expressions: [], parameters: new Map() };
  for (const { content } of expressionFiles) {
    const result = parseExpressions(content);
    parsedExpressions.expressions.push(...result.expressions);
    for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
  }
  model.expressions = parsedExpressions.expressions;
  model.parameters = parsedExpressions.parameters;

  showLoadingProgress('Step 2/5: Parsing DAX...', 30);

  for (const table of model.tables) {
    for (const measure of (table.measures || [])) {
      if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
    }
    for (const col of (table.calculatedColumns || [])) {
      if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
    }
  }

  showLoadingProgress('Step 3/5: Parsing report...', 50);

  const report = parsePbirReport(
    projectResult.reportStructure.visualFiles,
    projectResult.reportStructure.pageFiles
  );

  const enrichments = detectEnrichments(model.tables);

  showLoadingProgress('Step 4/5: Building graph...', 70);

  let graph = buildGraph(model, report, enrichments);
  graph = applyEnrichments(graph, enrichments);
  state.graph = graph;
  window.__graph = graph; // debug helper — inspect adjacency in browser console

  showLoadingProgress('Step 5/5: Done!', 100);

  const rawStats = computeStats(graph);
  const projectName = projectResult.reportName || projectResult.modelName || 'Project';
  updateStats({
    projectName,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    byType: {
      table: rawStats.tables, measure: rawStats.measures,
      visual: rawStats.visuals, column: rawStats.columns,
      page: rawStats.pages, source: rawStats.sources,
    },
    orphanedMeasures: rawStats.orphanedMeasures || 0,
    fieldParameters: enrichments.fieldParameters?.length || 0,
    calculationGroups: enrichments.calculationGroups?.length || 0,
  });

  // Reset navigation history on new project load
  state.navigationHistory = [];
  state.currentSelection = null;
  updateBackButton();

  populateMeasures(graph);
  populateVisuals(graph);
  populateSourceMapping(graph);
  populateDependents(graph);

  enableProjectToolbarButtons();

  // Show orphan filter
  const filterRow = document.getElementById('measure-filter-row');
  if (filterRow) filterRow.classList.remove('hidden');

  // Hide overlays
  const overlay = document.getElementById('welcome-overlay');
  if (overlay) overlay.classList.add('hidden');

  // Show/hide model banner based on whether semantic model was loaded
  const banner = document.getElementById('model-banner');
  if (banner) {
    if (!modelStructure) {
      const modelHint = state.semanticModelPath
        ? state.semanticModelPath.replace(/^\.\.\//, '').replace(/\/$/, '')
        : '.SemanticModel';
      const bannerText = banner.querySelector('.model-banner-text');
      if (bannerText) bannerText.textContent = `Select the ${modelHint} folder to enable full DAX lineage`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  hideLoading();
  hideLoadingOverlay();

  // Restore selection from URL hash (deep link)
  restoreFromHash();

  // Async git history scan (non-blocking)
  if (projectResult.rootHandle) state.rootHandle = projectResult.rootHandle;
  startGitScan();
}

/**
 * Start the git history scan for the current project folder, or reset the
 * Change History view when the project has no readable folder (sample project,
 * legacy drag-and-drop).
 */
function startGitScan() {
  // Version Compare scans lazily (on first open); just discard old results here.
  state.versionScanToken++;
  setVersionData({ status: 'idle' });
  if (state.versionCompareVisible || state.modelDiagramVisible) startVersionScan();

  if (state.rootHandle) {
    scanGitChanges(state.rootHandle);
  } else {
    setChangeHistoryData({ status: 'idle' });
    updateChangeHistoryBadge();
  }
}

// --- Git Change History ---

async function scanGitChanges(rootHandle) {
  try {
    showGitScanStatus('scanning');
    setChangeHistoryData({ status: 'scanning' });
    const { flatChanges, measureChangeCounts, pairs, hasRepo } = await scanGitHistory(rootHandle, state.graph);
    setChangeHistoryData({ status: 'ready', pairs, hasRepo });
    updateChangeHistoryBadge();
    state.changeData = { flatChanges, measureChangeCounts };
    setChangeData(state.changeData);
    updateChangeCounts(measureChangeCounts);

    // Build page-level change counts for visual sidebar badges
    // Include both direct page-scoped changes and changes that impact visuals on the page
    const pageChangeCounts = new Map();
    for (const change of flatChanges) {
      const counted = new Set();
      const pageName = change.target?.pageName;
      if (pageName) {
        pageChangeCounts.set(pageName, (pageChangeCounts.get(pageName) || 0) + 1);
        counted.add(pageName);
      }
      // Also count changes that impact visuals on a page (e.g. measure changes)
      if (change.impact) {
        for (const imp of change.impact) {
          if (imp.pageName && !counted.has(imp.pageName)) {
            pageChangeCounts.set(imp.pageName, (pageChangeCounts.get(imp.pageName) || 0) + 1);
            counted.add(imp.pageName);
          }
        }
      }
    }
    updatePageChangeCounts(pageChangeCounts);

    if (flatChanges.length > 0) {
      const commitCount = new Set(flatChanges.map(c => c.commitHash)).size;
      const pageCount = pageChangeCounts.size;
      const visualCount = new Set(
        flatChanges.filter(c => c.scope === 'visual').map(c => c.target?.visualId).filter(Boolean)
      ).size;
      showGitScanStatus('found', {
        changeCount: flatChanges.length,
        commitCount,
        measureCount: measureChangeCounts.size,
        pageCount,
        visualCount,
      });
      // Re-render current lineage view so change history section appears
      if (state.currentSelection?.type === 'measure') {
        handleMeasureSelect(state.currentSelection.id, { skipHistory: true });
      } else if (state.currentSelection?.type === 'visual') {
        handleVisualSelect(state.currentSelection.id, { skipHistory: true });
      }
    } else {
      showGitScanStatus('none');
    }
  } catch (err) {
    showGitScanStatus('error');
    setChangeHistoryData({ status: 'error' });
    updateChangeHistoryBadge();
    console.warn('Git history scan skipped:', err.message);
  }
}

function showGitScanStatus(status, opts = {}) {
  let el = document.getElementById('git-scan-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'git-scan-status';
    el.className = 'git-scan-status';
    const stats = document.getElementById('stats');
    if (stats) stats.parentNode.insertBefore(el, stats.nextSibling);
    else {
      const toolbar = document.querySelector('.toolbar-left') || document.querySelector('.toolbar');
      if (toolbar) toolbar.appendChild(el);
    }
  }
  if (status === 'scanning') {
    el.innerHTML = '<span class="git-scan-dot scanning"></span> Scanning git history...';
    el.classList.remove('hidden');
  } else if (status === 'found') {
    const { changeCount = 0, commitCount = 0, measureCount = 0, pageCount = 0, visualCount = 0 } = opts;
    const cs = changeCount !== 1 ? 's' : '';
    const cms = commitCount !== 1 ? 's' : '';
    const msg = `${commitCount} commit${cms} · ${changeCount} change${cs}`;
    // Build tooltip with breakdown (only non-zero items)
    const parts = [];
    if (measureCount > 0) parts.push(`${measureCount} measure${measureCount !== 1 ? 's' : ''}`);
    if (pageCount > 0) parts.push(`${pageCount} page${pageCount !== 1 ? 's' : ''}`);
    if (visualCount > 0) parts.push(`${visualCount} visual${visualCount !== 1 ? 's' : ''}`);
    const tooltip = parts.length > 0 ? parts.join(' · ') : '';
    el.innerHTML = `<span class="git-scan-dot found"></span> ${msg}`;
    if (tooltip) el.title = tooltip;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('fade'), 8000);
  } else if (status === 'none') {
    el.innerHTML = '<span class="git-scan-dot"></span> No recent changes detected';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  } else {
    el.classList.add('hidden');
  }
}

// --- Semantic Model Loading ---

async function handleLoadSemanticModel() {
  try {
    showLoadingProgress('Select the .SemanticModel folder...', 0);
    showLoading('Select the .SemanticModel folder...');

    const result = await loadSemanticModelFolder();
    if (!result) {
      hideLoadingOverlay();
      return; // User cancelled
    }

    showLoadingProgress('Parsing semantic model...', 30);

    const modelStructure = result.modelStructure;
    publishDiagramModels(modelStructure ? [{
      key: result.modelName || 'model',
      name: modelDisplayName(result.modelName),
      structure: modelStructure,
      reports: state.reportName ? [state.reportName] : [],
    }] : []);
    const tmdlFiles = modelStructure?.tmdlFiles || [];
    const relationshipFiles = modelStructure?.relationshipFiles || [];
    const expressionFiles = modelStructure?.expressionFiles || [];
    const model = parseTmdlModel(tmdlFiles, relationshipFiles);

    let parsedExpressions = { expressions: [], parameters: new Map() };
    for (const { content } of expressionFiles) {
      const r = parseExpressions(content);
      parsedExpressions.expressions.push(...r.expressions);
      for (const [k, v] of r.parameters) parsedExpressions.parameters.set(k, v);
    }
    model.expressions = parsedExpressions.expressions;
    model.parameters = parsedExpressions.parameters;

    for (const table of model.tables) {
      for (const measure of (table.measures || [])) {
        if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
      }
      for (const col of (table.calculatedColumns || [])) {
        if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
      }
    }

    showLoadingProgress('Rebuilding graph...', 70);

    const report = parsePbirReport(
      state.reportStructure.visualFiles,
      state.reportStructure.pageFiles
    );

    const enrichments = detectEnrichments(model.tables);
    let graph = buildGraph(model, report, enrichments);
    graph = applyEnrichments(graph, enrichments);
    state.graph = graph;
    window.__graph = graph; // debug helper

    showLoadingProgress('Done!', 100);

    const rawStats = computeStats(graph);
    updateStats({
      projectName: state.reportName || result.modelName || 'Project',
      nodeCount: graph.nodes.size,
      edgeCount: graph.edges.length,
      byType: {
        table: rawStats.tables, measure: rawStats.measures,
        visual: rawStats.visuals, column: rawStats.columns,
        page: rawStats.pages, source: rawStats.sources,
      },
      orphanedMeasures: rawStats.orphanedMeasures || 0,
      fieldParameters: enrichments.fieldParameters?.length || 0,
      calculationGroups: enrichments.calculationGroups?.length || 0,
    });

    populateMeasures(graph);
    populateVisuals(graph);
    populateSourceMapping(graph);
    populateDependents(graph);

    // Hide the model banner
    const banner = document.getElementById('model-banner');
    if (banner) banner.classList.add('hidden');

    hideLoadingOverlay();
  } catch (err) {
    hideLoadingOverlay();
    if (err.name === 'AbortError') return;
    console.error('Error loading semantic model:', err);
    showError(`Failed to load semantic model: ${err.message}`);
  }
}

// --- Measure Selection ---

function handleMeasureSelect(measureId, { skipHistory = false } = {}) {
  if (!state.graph) return;

  // Exit source map / model health / measure map views if active
  if (state.sourceMapVisible) {
    state.sourceMapVisible = false;
    const btn = document.getElementById('btn-source-map');
    if (btn) btn.classList.remove('active');
    const sourceMapContainer = document.getElementById('source-map-container');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
  }
  closeModelHealth();
  exitMeasureMapIfActive();
  exitChangeHistoryIfActive();
  exitVersionCompareIfActive();
  exitModelDiagramIfActive();
  hideDependentsGrid();

  const node = state.graph.nodes.get(measureId);
  if (!node || node.type !== 'measure') {
    console.warn(`handleMeasureSelect: node not found or not a measure: ${measureId}`);
    showLineageMessage(`Measure not found in graph: ${measureId}`);
    return;
  }

  // Push current selection to history before navigating
  if (!skipHistory && state.currentSelection) {
    state.navigationHistory.push(state.currentSelection);
  }
  state.currentSelection = { type: 'measure', id: measureId };
  updateBackButton();
  updateHash('measure', measureId);

  try {
    const lineage = traceMeasureLineage(measureId, state.graph);
    if (!lineage) {
      console.warn(`handleMeasureSelect: traceMeasureLineage returned null for ${measureId}`);
      showLineageMessage(`Could not trace lineage for "${node.name}". The measure may not have any dependencies.`);
      selectMeasure(measureId);
      return;
    }
    renderLineage(lineage, node.name, state.graph);
    selectMeasure(measureId);

    // Track session stats
    state.sessionStats.measuresTraced++;
    state.sessionStats.columnsmapped += lineage.sourceTable?.length || 0;
    updateValueCounter();

    // Sponsor toast after 3rd successful lineage trace (value-moment nudge)
    setTimeout(() => showSponsorToast(), 1500);
  } catch (err) {
    console.error(`Error tracing lineage for measure ${measureId}:`, err);
    showLineageMessage(`Failed to trace lineage for "${node.name}": ${err.message}`);
  }
}

// --- Visual Selection ---

function handleVisualSelect(visualId, { skipHistory = false } = {}) {
  if (!state.graph) return;

  // Exit source map / model health / measure map views if active
  if (state.sourceMapVisible) {
    state.sourceMapVisible = false;
    const btn = document.getElementById('btn-source-map');
    if (btn) btn.classList.remove('active');
    const sourceMapContainer = document.getElementById('source-map-container');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
  }
  closeModelHealth();
  exitMeasureMapIfActive();
  exitChangeHistoryIfActive();
  exitVersionCompareIfActive();
  exitModelDiagramIfActive();
  hideDependentsGrid();

  const node = state.graph.nodes.get(visualId);
  if (!node || node.type !== 'visual') {
    console.warn(`handleVisualSelect: node not found or not a visual: ${visualId}`);
    showLineageMessage(`Visual not found in graph: ${visualId}`);
    return;
  }

  // Push current selection to history before navigating
  if (!skipHistory && state.currentSelection) {
    state.navigationHistory.push(state.currentSelection);
  }
  state.currentSelection = { type: 'visual', id: visualId };
  updateBackButton();
  updateHash('visual', visualId);

  try {
    const lineage = traceVisualLineage(visualId, state.graph);
    if (!lineage) {
      showLineageMessage(`Could not trace lineage for this visual.`);
      selectVisual(visualId);
      return;
    }
    renderVisualLineage(lineage, state.graph);
    selectVisual(visualId);
    state.sessionStats.visualsExplored++;
  } catch (err) {
    console.error(`Error tracing lineage for visual ${visualId}:`, err);
    showLineageMessage(`Failed to trace lineage for visual: ${err.message}`);
  }
}

// --- Page Layout Selection ---

function handlePageLayoutSelect(pageName, { skipHistory = false } = {}) {
  if (!state.graph) return;

  // Exit source map / model health / measure map views if active
  if (state.sourceMapVisible) {
    state.sourceMapVisible = false;
    const btn = document.getElementById('btn-source-map');
    if (btn) btn.classList.remove('active');
    const sourceMapContainer = document.getElementById('source-map-container');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
  }
  closeModelHealth();
  exitMeasureMapIfActive();
  exitChangeHistoryIfActive();
  exitVersionCompareIfActive();
  exitModelDiagramIfActive();
  hideDependentsGrid();

  // Resolve the page. An exact node-id match is tried first because page NAMES
  // (and raw pageIds) repeat across reports in a multi-report workspace, so
  // name matching alone can open a different report's identically-named page.
  let pageNode = state.graph.nodes.get(pageName) || null;
  if (pageNode && pageNode.type !== 'page') pageNode = null;

  if (!pageNode) {
    for (const node of state.graph.nodes.values()) {
      if (node.type === 'page' && (node.name === pageName || node.metadata.pageId === pageName)) {
        pageNode = node;
        break;
      }
    }
  }

  if (!pageNode) {
    showLineageMessage(`Page not found: ${pageName}`);
    return;
  }

  // Push current selection to history before navigating
  if (!skipHistory && state.currentSelection) {
    state.navigationHistory.push(state.currentSelection);
  }
  state.currentSelection = { type: 'page', id: pageName };
  updateBackButton();
  updateHash('page', pageName);

  renderPageLayout(pageNode, state.graph);
  updateBackButton();
}

function handlePageChangeBadgeClick(pageName) {
  if (!state.changeData?.flatChanges) return;

  const pageChanges = state.changeData.flatChanges.filter(c =>
    (c.target && c.target.pageName === pageName) ||
    (c.impact && c.impact.some(imp => imp.pageName === pageName))
  );
  if (pageChanges.length === 0) return;

  // Exit source map / model health views if active
  if (state.sourceMapVisible) {
    state.sourceMapVisible = false;
    const btn = document.getElementById('btn-source-map');
    if (btn) btn.classList.remove('active');
    const sourceMapContainer = document.getElementById('source-map-container');
    if (sourceMapContainer) sourceMapContainer.classList.add('hidden');
  }
  closeModelHealth();
  exitMeasureMapIfActive();
  exitChangeHistoryIfActive();
  exitVersionCompareIfActive();
  exitModelDiagramIfActive();

  if (state.currentSelection) {
    state.navigationHistory.push(state.currentSelection);
  }
  state.currentSelection = { type: 'pageChanges', id: pageName };
  updateBackButton();

  renderPageChangeHistory(pageName, pageChanges);
}

function showLineageMessage(message) {
  const empty = document.getElementById('lineage-empty');
  const content = document.getElementById('lineage-content');
  if (content) content.classList.add('hidden');
  if (empty) {
    empty.classList.remove('hidden');
    empty.innerHTML = `<p class="lineage-muted">${message}</p>`;
  }
}

// --- Keyboard Shortcuts ---

function handleKeyDown(event) {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    event.preventDefault();
    const input = document.getElementById('measure-search');
    if (input) input.focus();
  }

  // ? to toggle keyboard help
  if (event.key === '?' && !event.ctrlKey && !event.metaKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    event.preventDefault();
    toggleKeyboardHelp();
  }

  // Escape to close source map view, keyboard help
  if (event.key === 'Escape') {
    const helpPopover = document.getElementById('keyboard-help-popover');
    if (helpPopover && !helpPopover.classList.contains('hidden')) {
      helpPopover.classList.add('hidden');
      return;
    }
    if (state.sourceMapVisible) toggleSourceMap();
    else if (state.changeHistoryVisible) toggleChangeHistory();
    else if (state.versionCompareVisible) toggleVersionCompare();
    else if (state.modelDiagramVisible) toggleModelDiagram();
  }

  // Alt+Left to go back in navigation history
  if (event.key === 'ArrowLeft' && event.altKey) {
    event.preventDefault();
    navigateBack();
  }

  // Arrow keys to navigate sidebar items
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    // Determine which list is active
    const measuresTab = document.querySelector('.sidebar-tab[data-tab="measures"]');
    const isMeasuresActive = measuresTab?.classList.contains('active');
    const listId = isMeasuresActive ? 'measure-list' : 'visual-list';
    const container = document.getElementById(listId);
    if (!container) return;

    const itemClass = isMeasuresActive ? '.measure-item' : '.visual-item';
    const items = Array.from(container.querySelectorAll(itemClass));
    if (items.length === 0) return;

    event.preventDefault();
    const currentActive = container.querySelector(`${itemClass}.active`);
    let idx = currentActive ? items.indexOf(currentActive) : -1;

    if (event.key === 'ArrowDown') {
      idx = idx < items.length - 1 ? idx + 1 : 0;
    } else {
      idx = idx > 0 ? idx - 1 : items.length - 1;
    }

    items[idx].click();
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  // Enter to trace lineage for focused item (when sidebar has focus)
  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    const measuresTab = document.querySelector('.sidebar-tab[data-tab="measures"]');
    const isMeasuresActive = measuresTab?.classList.contains('active');
    const listId = isMeasuresActive ? 'measure-list' : 'visual-list';
    const container = document.getElementById(listId);
    if (!container) return;

    const itemClass = isMeasuresActive ? '.measure-item' : '.visual-item';
    const currentActive = container.querySelector(`${itemClass}.active`);
    if (currentActive) {
      event.preventDefault();
      currentActive.click();
    }
  }
}

// --- Back Navigation ---

function navigateBack() {
  if (state.navigationHistory.length === 0) return;
  const prev = state.navigationHistory.pop();
  if (prev.type === 'measure') {
    handleMeasureSelect(prev.id, { skipHistory: true });
  } else if (prev.type === 'visual') {
    handleVisualSelect(prev.id, { skipHistory: true });
  } else if (prev.type === 'page') {
    handlePageLayoutSelect(prev.id, { skipHistory: true });
  }
  updateBackButton();
}

function updateBackButton() {
  const btn = document.getElementById('btn-back');
  if (!btn) return;
  if (state.navigationHistory.length > 0) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

// --- Utility ---

function showLoadingProgress(message, percent) {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-text');
  const fill = document.getElementById('loading-bar-fill');
  if (overlay) overlay.classList.remove('hidden');
  if (text) text.textContent = message;
  if (fill) fill.style.width = `${percent}%`;
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function showError(message) {
  const el = document.getElementById('stats');
  if (el) {
    const prev = el.textContent;
    el.textContent = message;
    el.style.color = '#ff5252';
    setTimeout(() => { el.textContent = prev; el.style.color = ''; }, 5000);
  }
}

function showWelcomeError(message) {
  const el = document.getElementById('welcome-error');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
  // Also ensure welcome overlay is visible so user sees the error
  const overlay = document.getElementById('welcome-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function clearWelcomeError() {
  const el = document.getElementById('welcome-error');
  if (el) {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

// --- Deep Links (URL Hash) ---

function updateHash(type, id) {
  const encoded = encodeURIComponent(id);
  const hash = `#${type}=${encoded}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
}

function parseHash() {
  const hash = window.location.hash.slice(1); // remove #
  if (!hash) return null;
  const eqIdx = hash.indexOf('=');
  if (eqIdx < 0) return null;
  const type = hash.slice(0, eqIdx);
  const id = decodeURIComponent(hash.slice(eqIdx + 1));
  if (type === 'measure' || type === 'visual' || type === 'page') {
    return { type, id };
  }
  return null;
}

function restoreFromHash() {
  if (!state.graph) return;
  const target = parseHash();
  if (!target) return;
  if (target.type === 'measure') {
    handleMeasureSelect(target.id, { skipHistory: true });
  } else if (target.type === 'visual') {
    handleVisualSelect(target.id, { skipHistory: true });
  } else if (target.type === 'page') {
    handlePageLayoutSelect(target.id, { skipHistory: true });
  }
}

function handleHashNavigation() {
  if (!state.graph) return;
  restoreFromHash();
}

// --- Drag & Drop ---

function initDragAndDrop() {
  const overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;

  overlay.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.add('drag-over');
  });

  overlay.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.remove('drag-over');
  });

  overlay.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.remove('drag-over');

    // Use File System Access API via DataTransferItem.getAsFileSystemHandle()
    const items = [...e.dataTransfer.items];
    for (const item of items) {
      if (item.kind === 'file' && item.getAsFileSystemHandle) {
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle.kind === 'directory') {
            await handleDroppedDirectory(handle);
            return;
          }
        } catch (err) {
          console.warn('getAsFileSystemHandle not supported:', err);
        }
      }
    }

    // Fallback: try webkitGetAsEntry for directory reading
    const entries = [];
    for (const item of items) {
      if (item.kind === 'file' && item.webkitGetAsEntry) {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }

    if (entries.length > 0 && entries[0].isDirectory) {
      await handleDroppedWebkitEntry(entries[0]);
      return;
    }

    showWelcomeError('Please drop a PBIP project folder (not individual files).');
  });
}

async function handleDroppedDirectory(dirHandle) {
  try {
    clearWelcomeError();
    state.rootHandle = dirHandle; // a dropped folder handle can be scanned for git history too
    showLoadingProgress('Reading dropped folder...', 10);

    const allFiles = new Map();
    await readDirectoryRecursive(dirHandle, '', allFiles);

    if (allFiles.size === 0) {
      hideLoadingOverlay();
      showWelcomeError('No files found in the dropped folder.');
      return;
    }

    const modelFiles = new Map();
    const reportFiles = new Map();

    for (const [path, content] of allFiles) {
      if (path.includes('.SemanticModel/') || path.includes('definition/')) {
        // Strip to relative path within model
        const relPath = path.replace(/^.*?\.SemanticModel\//, '').replace(/^.*?definition\//, 'definition/');
        modelFiles.set(relPath, content);
      }
      if (path.includes('.Report/') || path.includes('report/')) {
        const relPath = path.replace(/^.*?\.Report\//, '').replace(/^.*?report\/definition\//, 'definition/');
        reportFiles.set(relPath, content);
      }
    }

    // If no clear structure found, try flat structure
    if (modelFiles.size === 0 && reportFiles.size === 0) {
      for (const [path, content] of allFiles) {
        if (path.endsWith('.tmdl')) {
          modelFiles.set(path, content);
        } else if (path.endsWith('.json') && path.includes('visual')) {
          reportFiles.set(path, content);
        }
      }
    }

    const modelStructure = modelFiles.size > 0 ? identifyProjectStructure(modelFiles) : null;
    const reportStructure = reportFiles.size > 0 ? identifyProjectStructure(reportFiles) : null;

    const projectResult = {
      reportName: dirHandle.name || 'Dropped Project',
      reportStructure,
      semanticModelPath: null,
      modelName: dirHandle.name || 'Dropped Model',
      modelStructure,
    };

    await loadProjectResult(projectResult);
  } catch (err) {
    hideLoadingOverlay();
    console.error('Error processing dropped folder:', err);
    showWelcomeError(`Failed to load dropped folder: ${err.message}`);
  }
}

async function readDirectoryRecursive(dirHandle, basePath, result) {
  for await (const entry of dirHandle.values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      try {
        const file = await entry.getFile();
        // Only read text files (.tmdl, .json, .xml)
        if (/\.(tmdl|json|xml)$/i.test(entry.name)) {
          const content = await file.text();
          result.set(entryPath, content);
        }
      } catch { /* skip unreadable files */ }
    } else if (entry.kind === 'directory') {
      // Skip common non-relevant directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      await readDirectoryRecursive(entry, entryPath, result);
    }
  }
}

async function handleDroppedWebkitEntry(dirEntry) {
  try {
    clearWelcomeError();
    state.rootHandle = null; // legacy drag-and-drop entries can't be read by the git scanner
    showLoadingProgress('Reading dropped folder...', 10);

    const allFiles = new Map();
    await readWebkitDirectoryRecursive(dirEntry, '', allFiles);

    if (allFiles.size === 0) {
      hideLoadingOverlay();
      showWelcomeError('No supported files found in the dropped folder.');
      return;
    }

    const modelFiles = new Map();
    const reportFiles = new Map();
    for (const [path, content] of allFiles) {
      if (path.endsWith('.tmdl')) modelFiles.set(path, content);
      else if (path.endsWith('.json')) reportFiles.set(path, content);
    }

    const modelStructure = modelFiles.size > 0 ? identifyProjectStructure(modelFiles) : null;
    const reportStructure = reportFiles.size > 0 ? identifyProjectStructure(reportFiles) : null;

    const projectResult = {
      reportName: dirEntry.name || 'Dropped Project',
      reportStructure,
      semanticModelPath: null,
      modelName: dirEntry.name || 'Dropped Model',
      modelStructure,
    };

    await loadProjectResult(projectResult);
  } catch (err) {
    hideLoadingOverlay();
    console.error('Error processing dropped folder:', err);
    showWelcomeError(`Failed to load dropped folder: ${err.message}`);
  }
}

function readWebkitDirectoryRecursive(dirEntry, basePath, result) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const readEntries = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) { resolve(); return; }
        for (const entry of entries) {
          const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
          if (entry.isFile && /\.(tmdl|json|xml)$/i.test(entry.name)) {
            const content = await new Promise((res) => {
              entry.file((file) => {
                const reader = new FileReader();
                reader.onload = () => res(reader.result);
                reader.onerror = () => res('');
                reader.readAsText(file);
              });
            });
            if (content) result.set(entryPath, content);
          } else if (entry.isDirectory && !['node_modules', '.git', 'dist'].includes(entry.name)) {
            await readWebkitDirectoryRecursive(entry, entryPath, result);
          }
        }
        readEntries(); // Continue reading (batched by browser)
      });
    };
    readEntries();
  });
}

// --- Start ---

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
