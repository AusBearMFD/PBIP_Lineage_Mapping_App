/**
 * Model Diagram — data and layout for drawing a semantic model's tables and
 * relationships, either as it is now or as a before/after comparison of one
 * commit.
 *
 * Works on semantic-model snapshots (snapshot.js `buildModelFromStructure`,
 * or `snapshot.models` values), so the current project and every commit of
 * the repo use the same code. Platform-independent: the layout returns plain
 * coordinates and the UI draws them.
 */

/**
 * Diagram data for one model.
 * @param {object} model - A model snapshot.
 * @returns {{ tables: Array<object>, relationships: Array<object> }}
 */
export function modelDiagramData(model) {
  if (!model) return { tables: [], relationships: [] };
  const relationships = [...model.relationships.values()].map(r => relRecord(r, 'unchanged'));
  const keyColumns = keyColumnIndex(relationships);
  const tables = [...model.tables.values()].map(t => tableRecord(t, 'unchanged', keyColumns.get(t.name)));
  return { tables, relationships };
}

/**
 * Before/after diagram data for one model: the union of both versions, each
 * table and relationship tagged with what happened to it.
 *   status: 'unchanged' | 'added' | 'removed' | 'changed'
 * Tables carry `columnChanges` and `measureChanges`; changed relationships
 * carry `changes: [{ label, before, after }]`.
 * @param {object|null} before - Model snapshot before the commit (null if the model is new).
 * @param {object|null} after - Model snapshot after the commit (null if the model was deleted).
 */
export function diffModelDiagram(before, after) {
  const bTables = before?.tables || new Map();
  const aTables = after?.tables || new Map();

  // Relationships: match by name, then re-pair a deleted + re-created one by endpoints.
  const bRels = new Map(before?.relationships || []);
  const aRels = new Map(after?.relationships || []);
  for (const [name, ar] of [...aRels]) {
    if (bRels.has(name)) continue;
    const match = [...bRels].find(([bn, br]) => !aRels.has(bn) && endpoints(br) === endpoints(ar));
    if (match) { bRels.delete(match[0]); bRels.set(name, match[1]); }
  }
  const relationships = [];
  for (const name of union(bRels.keys(), aRels.keys())) {
    const br = bRels.get(name);
    const ar = aRels.get(name);
    if (!br) { relationships.push(relRecord(ar, 'added')); continue; }
    if (!ar) { relationships.push(relRecord(br, 'removed')); continue; }
    const changes = relationshipChanges(br, ar);
    relationships.push({ ...relRecord(ar, changes.length ? 'changed' : 'unchanged'), id: ar.name, changes, before: relRecord(br, 'unchanged') });
  }
  const keyColumns = keyColumnIndex(relationships);

  const tables = [];
  for (const name of union(bTables.keys(), aTables.keys())) {
    const bt = bTables.get(name);
    const at = aTables.get(name);
    if (!bt || !at) {
      tables.push(tableRecord(at || bt, at ? 'added' : 'removed', keyColumns.get(name)));
      continue;
    }
    const columnChanges = [];
    for (const c of union(bt.columns.keys(), at.columns.keys())) {
      const bc = bt.columns.get(c);
      const ac = at.columns.get(c);
      if (!bc) columnChanges.push({ name: c, status: 'added', detail: ac.dataType || '' });
      else if (!ac) columnChanges.push({ name: c, status: 'removed', detail: bc.dataType || '' });
      else {
        const details = [];
        if (bc.dataType !== ac.dataType) details.push(`${bc.dataType || '?'} → ${ac.dataType || '?'}`);
        if (norm(bc.expression) !== norm(ac.expression)) details.push('formula edited');
        if (bc.sourceColumn !== ac.sourceColumn) details.push('source column changed');
        if (details.length) columnChanges.push({ name: c, status: 'changed', detail: details.join(', ') });
      }
    }
    const measureChanges = { added: [], removed: [], changed: [] };
    for (const m of union(bt.measures.keys(), at.measures.keys())) {
      const bm = bt.measures.get(m);
      const am = at.measures.get(m);
      if (!bm) measureChanges.added.push(m);
      else if (!am) measureChanges.removed.push(m);
      else if (norm(bm.expression) !== norm(am.expression)) measureChanges.changed.push(m);
    }
    const otherChanges = [];
    const bSrc = [...bt.partitions.values()].map(p => `${p.mode}|${p.source}|${norm(p.sourceExpression)}`).join('\n');
    const aSrc = [...at.partitions.values()].map(p => `${p.mode}|${p.source}|${norm(p.sourceExpression)}`).join('\n');
    if (bSrc !== aSrc) otherChanges.push('Data source or Power Query changed');
    const changed = columnChanges.length || otherChanges.length ||
      measureChanges.added.length || measureChanges.removed.length || measureChanges.changed.length;
    tables.push({
      ...tableRecord(at, changed ? 'changed' : 'unchanged', keyColumns.get(name)),
      columnChanges, measureChanges, otherChanges,
      removedColumns: columnChanges.filter(c => c.status === 'removed').map(c => c.name),
    });
  }
  return { tables, relationships };
}

/** Counts of what changed in a diffModelDiagram() result. */
export function summarizeDiagramDiff(diff) {
  const s = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, relsAdded: 0, relsRemoved: 0, relsChanged: 0, relsDeactivated: 0, relsActivated: 0 };
  for (const t of diff.tables) {
    if (t.status === 'added') s.tablesAdded++;
    else if (t.status === 'removed') s.tablesRemoved++;
    else if (t.status === 'changed') s.tablesChanged++;
  }
  for (const r of diff.relationships) {
    if (r.status === 'added') s.relsAdded++;
    else if (r.status === 'removed') s.relsRemoved++;
    else if (r.status === 'changed') {
      s.relsChanged++;
      if (r.before?.isActive && !r.isActive) s.relsDeactivated++;
      if (!r.before?.isActive && r.isActive) s.relsActivated++;
    }
  }
  s.total = s.tablesAdded + s.tablesRemoved + s.tablesChanged + s.relsAdded + s.relsRemoved + s.relsChanged;
  return s;
}

// --- Layout ------------------------------------------------------------------

/**
 * Lay out tables so related tables sit near each other and no boxes overlap.
 * Deterministic (same input, same picture). Connected groups of tables are
 * laid out with a small force simulation, then packed in rows; tables with no
 * relationships are gathered in a grid at the end.
 *
 * @param {Array<{ id: string, w: number, h: number }>} nodes - Table boxes (sizes from the UI).
 * @param {Array<{ source: string, target: string }>} links - Relationships.
 * @param {{ gap?: number, labelRoom?: number, maxRowWidth?: number }} [options] - labelRoom: extra space
 *   between related tables for text written on the relationship lines.
 * @returns {{ positions: Map<string, { x, y, w, h }>, width: number, height: number, loose: { x, y, w, h } | null }}
 *   x/y are box top-left corners. `loose` bounds the grid of unrelated tables.
 */
export function layoutModelDiagram(nodes, links, options = {}) {
  const gap = options.gap ?? 48;
  const labelRoom = options.labelRoom ?? gap;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) {
    if (l.source === l.target || !adj.has(l.source) || !adj.has(l.target)) continue;
    adj.get(l.source).add(l.target);
    adj.get(l.target).add(l.source);
  }

  // Connected components, largest first (ties by name for stable output).
  const seen = new Set();
  const components = [];
  const loose = [];
  for (const n of [...nodes].sort((a, b) => adj.get(b.id).size - adj.get(a.id).size || a.id.localeCompare(b.id))) {
    if (seen.has(n.id)) continue;
    if (!adj.get(n.id).size) { seen.add(n.id); loose.push(n); continue; }
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(byId.get(id));
      for (const nb of adj.get(id)) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    components.push(comp);
  }

  const blocks = components.map(comp => layoutComponent(comp, adj, gap, labelRoom));
  if (loose.length) blocks.push(layoutGrid(loose.sort((a, b) => a.id.localeCompare(b.id)), gap, true));

  // Shelf-pack the blocks into rows.
  const totalArea = blocks.reduce((s, b) => s + (b.width + gap) * (b.height + gap), 0);
  const maxRowWidth = options.maxRowWidth ?? Math.max(900, Math.sqrt(totalArea) * 1.6, ...blocks.map(b => b.width));
  const positions = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  let looseBounds = null;
  for (const b of blocks) {
    if (x > 0 && x + b.width > maxRowWidth) { x = 0; y += rowH + gap * 2; rowH = 0; }
    for (const [id, p] of b.positions) positions.set(id, { ...p, x: p.x + x, y: p.y + y });
    if (b.isLoose) looseBounds = { x, y, w: b.width, h: b.height };
    x += b.width + gap * 2;
    rowH = Math.max(rowH, b.height);
    width = Math.max(width, x - gap * 2);
  }
  return { positions, width, height: y + rowH, loose: looseBounds };
}

/**
 * Lay out one connected group, normalised to start at (0, 0).
 *
 * Power BI models are mostly star schemas: a fact table with many dimension
 * tables that relate to nothing else. Each "hub" table is laid out with its
 * single-link tables in a tight ellipse around it (a star block), and the
 * blocks are then arranged with a force simulation. A plain force layout
 * spreads stars into large hollow rings.
 */
function layoutComponent(comp, adj, gap, labelRoom) {
  const byId = new Map(comp.map(n => [n.id, n]));
  if (comp.length === 1) return normalise([{ ...comp[0], x: 0, y: 0 }]);

  const degree = (id) => adj.get(id).size;
  let core = comp.map(n => n.id).filter(id => degree(id) > 1);
  if (!core.length) core = [comp[0].id]; // two tables related only to each other
  const coreSet = new Set(core);
  const leavesOf = new Map(core.map(id => [id, []]));
  for (const n of comp) {
    if (coreSet.has(n.id)) continue;
    const hub = [...adj.get(n.id)].find(nb => coreSet.has(nb));
    leavesOf.get(hub).push(n);
  }

  const blocks = new Map(core.map(id => [id, starBlock(byId.get(id), leavesOf.get(id).sort((a, b) => a.id.localeCompare(b.id)), gap, labelRoom)]));
  const coreEdges = [];
  for (const id of core) for (const nb of adj.get(id)) if (coreSet.has(nb) && id < nb) coreEdges.push([id, nb]);
  const centres = forceLayout(core.map(id => ({ id, w: blocks.get(id).w, h: blocks.get(id).h })), coreEdges, adj, gap + labelRoom / 2);

  const blockBoxes = core.map(id => {
    const b = blocks.get(id);
    const c = centres.get(id);
    return { id, w: b.w, h: b.h, x: c.x - b.w / 2, y: c.y - b.h / 2 };
  });
  removeOverlaps(blockBoxes, gap);
  const boxes = [];
  for (const bb of blockBoxes) {
    for (const m of blocks.get(bb.id).members) boxes.push({ id: m.id, w: m.w, h: m.h, x: bb.x + m.dx, y: bb.y + m.dy });
  }
  removeOverlaps(boxes, gap * 0.6); // safety net; star blocks are already overlap-free
  return normalise(boxes);
}

/**
 * A hub table with its leaf tables on an ellipse around it, grown until no
 * two boxes overlap. Many leaves go on two rings so the block stays compact.
 * @returns {{ w, h, members: Array<{ id, w, h, dx, dy }> }} member offsets are top-left, relative to the block's top-left.
 */
function starBlock(hub, leaves, gap, labelRoom) {
  const placed = [{ id: hub.id, w: hub.w, h: hub.h, cx: 0, cy: 0 }];
  if (leaves.length) {
    const maxW = Math.max(...leaves.map(l => l.w));
    const maxH = Math.max(...leaves.map(l => l.h));
    const rings = leaves.length > 12 ? [leaves.filter((_, i) => i % 3 === 0), leaves.filter((_, i) => i % 3 !== 0)] : [leaves];
    // Side-by-side tables need room for a label between them; stacked ones only its height.
    let rx = hub.w / 2 + maxW / 2 + Math.max(gap, labelRoom);
    let ry = hub.h / 2 + maxH / 2 + gap + Math.min(labelRoom, 40);
    rings.forEach((ring, ri) => {
      const n = ring.length;
      const start = n <= 2 ? 0 : -Math.PI / 2 + ri * (Math.PI / n);
      let tries = [];
      for (let attempt = 0; attempt < 80; attempt++) {
        tries = ring.map((leaf, i) => {
          const angle = start + (2 * Math.PI * i) / n;
          return { id: leaf.id, w: leaf.w, h: leaf.h, cx: Math.cos(angle) * rx, cy: Math.sin(angle) * ry };
        });
        const clash = tries.some((a, i) => [...placed, ...tries.slice(i + 1)].some(b => boxesOverlap(a, b, gap * 0.5)));
        if (!clash) break;
        rx *= 1.06;
        ry *= 1.06;
      }
      placed.push(...tries);
      // The next ring starts outside this one.
      rx += maxW + gap;
      ry += maxH + gap;
    });
  }
  const minX = Math.min(...placed.map(p => p.cx - p.w / 2));
  const minY = Math.min(...placed.map(p => p.cy - p.h / 2));
  const maxX = Math.max(...placed.map(p => p.cx + p.w / 2));
  const maxY = Math.max(...placed.map(p => p.cy + p.h / 2));
  return {
    w: maxX - minX,
    h: maxY - minY,
    members: placed.map(p => ({ id: p.id, w: p.w, h: p.h, dx: p.cx - p.w / 2 - minX, dy: p.cy - p.h / 2 - minY })),
  };
}

function boxesOverlap(a, b, pad) {
  return Math.abs(a.cx - b.cx) * 2 < a.w + b.w + pad * 2 && Math.abs(a.cy - b.cy) * 2 < a.h + b.h + pad * 2;
}

/**
 * Fruchterman–Reingold layout of star blocks: springs on relationships,
 * repulsion between every pair, and a gentle pull to the centre. Starts from
 * rings around the most-connected block, ordered breadth-first, so the
 * result is deterministic. Returns block centres.
 */
function forceLayout(items, edges, adj, gap) {
  const ids = items.map(n => n.id);
  const size = new Map(items.map(n => [n.id, n]));
  const pos = new Map();
  if (items.length === 1) { pos.set(ids[0], { x: 0, y: 0 }); return pos; }
  const neighbours = new Map(ids.map(id => [id, []]));
  for (const [a, b] of edges) { neighbours.get(a).push(b); neighbours.get(b).push(a); }
  const root = [...ids].sort((a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b))[0];
  const depth = new Map([[root, 0]]);
  const order = [root];
  for (let i = 0; i < order.length; i++) {
    for (const nb of [...neighbours.get(order[i])].sort()) {
      if (!depth.has(nb)) { depth.set(nb, depth.get(order[i]) + 1); order.push(nb); }
    }
  }
  for (const id of ids) if (!depth.has(id)) { depth.set(id, 1); order.push(id); }
  const unit = Math.sqrt(items.reduce((s, n) => s + n.w * n.h, 0) / items.length) + gap;
  const rings = new Map();
  for (const id of order) {
    const d = depth.get(id);
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d).push(id);
  }
  for (const [d, ring] of rings) {
    ring.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / ring.length + d * 0.6;
      pos.set(id, { x: Math.cos(angle) * d * unit, y: Math.sin(angle) * d * unit });
    });
  }
  // Ideal distance between two blocks: about enough for them not to touch.
  const ideal = (a, b) => (Math.hypot(size.get(a).w, size.get(a).h) + Math.hypot(size.get(b).w, size.get(b).h)) / 2 * 0.75 + gap;
  let temp = unit;
  for (let iter = 0; iter < 300; iter++) {
    const disp = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]); const b = pos.get(ids[j]);
        let dx = a.x - b.x; let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = 0.01 * (i + 1); dy = 0.01 * (j + 1); dist = Math.hypot(dx, dy); }
        const k = ideal(ids[i], ids[j]);
        const f = (k * k) / dist;
        disp.get(ids[i]).x += (dx / dist) * f; disp.get(ids[i]).y += (dy / dist) * f;
        disp.get(ids[j]).x -= (dx / dist) * f; disp.get(ids[j]).y -= (dy / dist) * f;
      }
    }
    for (const [s, t] of edges) {
      const a = pos.get(s); const b = pos.get(t);
      const dx = a.x - b.x; const dy = a.y - b.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const f = (dist * dist) / ideal(s, t);
      disp.get(s).x -= (dx / dist) * f; disp.get(s).y -= (dy / dist) * f;
      disp.get(t).x += (dx / dist) * f; disp.get(t).y += (dy / dist) * f;
    }
    for (const id of ids) {
      const p = pos.get(id); const d = disp.get(id);
      d.x -= p.x * 0.05; d.y -= p.y * 0.05;
      const len = Math.max(Math.hypot(d.x, d.y), 0.01);
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
    }
    temp = Math.max(temp * 0.985, 2);
  }
  return pos;
}

/** Simple grid for tables that have no relationships. */
function layoutGrid(nodes, gap, isLoose) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.5)));
  const colW = Math.max(...nodes.map(n => n.w));
  const boxes = [];
  let y = 0;
  for (let i = 0; i < nodes.length; i += cols) {
    const row = nodes.slice(i, i + cols);
    const rowH = Math.max(...row.map(n => n.h));
    row.forEach((n, j) => boxes.push({ id: n.id, w: n.w, h: n.h, x: j * (colW + gap / 2), y }));
    y += rowH + gap / 2;
  }
  return { ...normalise(boxes), isLoose };
}

function removeOverlaps(boxes, pad) {
  for (let pass = 0; pass < 400; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]; const b = boxes[j];
        const ox = Math.min(a.x + a.w + pad, b.x + b.w + pad) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Push apart along the axis that needs the smaller move.
        if (ox < oy) {
          const shift = ox / 2 + 0.5;
          if (a.x + a.w / 2 <= b.x + b.w / 2) { a.x -= shift; b.x += shift; } else { a.x += shift; b.x -= shift; }
        } else {
          const shift = oy / 2 + 0.5;
          if (a.y + a.h / 2 <= b.y + b.h / 2) { a.y -= shift; b.y += shift; } else { a.y += shift; b.y -= shift; }
        }
      }
    }
    if (!moved) break;
  }
}

function normalise(boxes) {
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const positions = new Map();
  let width = 0;
  let height = 0;
  for (const b of boxes) {
    const p = { x: Math.round(b.x - minX), y: Math.round(b.y - minY), w: b.w, h: b.h };
    positions.set(b.id, p);
    width = Math.max(width, p.x + p.w);
    height = Math.max(height, p.y + p.h);
  }
  return { positions, width, height };
}

// --- Records -----------------------------------------------------------------

function tableRecord(t, status, keyColumns = new Set()) {
  const parts = [...t.partitions.values()];
  const calculated = parts.some(p => p.type === 'calculated');
  const fieldParameter = parts.some(p => p.type === 'calculated' && /NAMEOF\s*\(/i.test(p.sourceExpression || ''));
  const modes = [...new Set(parts.map(p => storageMode(p.mode)))];
  return {
    id: t.name,
    name: t.name,
    status,
    kind: t.isCalculationGroup ? 'calculationGroup' : fieldParameter ? 'fieldParameter' : calculated ? 'calculated' : 'table',
    storageMode: calculated ? '' : modes.join(', '),
    source: parts.map(p => p.source).filter(Boolean)[0] || '',
    columns: [...t.columns.values()].map(c => ({
      name: c.name, dataType: c.dataType, isHidden: c.isHidden, isCalculated: !!c.expression, isKey: keyColumns.has(c.name),
    })),
    measureCount: t.measures.size,
    measures: [...t.measures.keys()],
    keyColumns: [...keyColumns],
    columnChanges: [],
    measureChanges: { added: [], removed: [], changed: [] },
    otherChanges: [],
    removedColumns: [],
  };
}

function relRecord(r, status) {
  return {
    id: r.name,
    name: r.name,
    status,
    fromTable: r.fromTable, fromColumn: r.fromColumn,
    toTable: r.toTable, toColumn: r.toColumn,
    isActive: r.isActive,
    crossFilter: r.crossFilter,
    fromCardinality: r.fromCardinality,
    toCardinality: r.toCardinality,
    securityFilter: r.securityFilter,
    relyOnReferentialIntegrity: r.relyOnReferentialIntegrity,
    changes: [],
  };
}

function relationshipChanges(br, ar) {
  const out = [];
  const add = (label, b, a) => { if (b !== a) out.push({ label, before: b, after: a }); };
  add('From', `${br.fromTable}[${br.fromColumn}]`, `${ar.fromTable}[${ar.fromColumn}]`);
  add('To', `${br.toTable}[${br.toColumn}]`, `${ar.toTable}[${ar.toColumn}]`);
  add('Active', br.isActive ? 'Yes' : 'No', ar.isActive ? 'Yes' : 'No');
  add('Cross-filter direction', crossFilterLabel(br.crossFilter), crossFilterLabel(ar.crossFilter));
  add('Cardinality', cardinalityLabel(br), cardinalityLabel(ar));
  add('Security filter direction', crossFilterLabel(br.securityFilter), crossFilterLabel(ar.securityFilter));
  add('Assume referential integrity', br.relyOnReferentialIntegrity ? 'Yes' : 'No', ar.relyOnReferentialIntegrity ? 'Yes' : 'No');
  return out;
}

/** "Many to one" style label for a relationship's cardinality. */
export function cardinalityLabel(r) {
  const c = (x) => (x === 'one' ? 'one' : 'many');
  const text = `${c(r.fromCardinality)} to ${c(r.toCardinality)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Single" / "Both" label for a cross-filter or security-filter direction. */
export function crossFilterLabel(v) {
  if (v === 'bothDirections') return 'Both';
  if (v === 'automatic') return 'Automatic';
  return 'Single';
}

function keyColumnIndex(relationships) {
  const index = new Map();
  const add = (t, c) => { if (!index.has(t)) index.set(t, new Set()); index.get(t).add(c); };
  for (const r of relationships) { add(r.fromTable, r.fromColumn); add(r.toTable, r.toColumn); }
  return index;
}

function storageMode(mode) {
  const m = (mode || 'import').toLowerCase();
  return { import: 'Import', directquery: 'DirectQuery', dual: 'Dual', directlake: 'Direct Lake' }[m] || mode;
}

function endpoints(r) {
  return `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`;
}
function union(a, b) {
  return [...new Set([...a, ...b])];
}
function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
