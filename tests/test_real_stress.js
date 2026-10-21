/**
 * test_real_stress.js — Benchmark E2E del motor de anidado (PhoenixBlackNest).
 *
 * Ejecutar:  node_modules\electron\dist\electron.exe test_real_stress.js
 *
 * Verifica los 3 arreglos críticos:
 *   1) COMPACTACIÓN DE HOJAS  → un lote al ~62% de una hoja 1000x1000 debe quedar en 1 SOLA hoja.
 *   2) BUCLE CONTINUO         → el motor NO se auto-detiene; >= 25 generaciones seguidas y
 *                               engine:stop en < 5 ms.
 *   3) GPU                    → se reporta la telemetría (ms/gen, gens/seg, caché residente).
 *
 * Asserts:  sheetsUsed === 1 · 0 solapes de material · minGap >= spacing · >= 25 gens · stop < 5 ms.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const SHEET_W = 1000;
const SHEET_H = 1000;
const SPACING = 3;
const GAP_TOL = 0.75; // tolerancia de rejilla en la comprobación de minGap (mm)

/* ------------------------------------------------------------------ *
 *  Geometría sintética (mm reales, outside CCW / holes CW)
 * ------------------------------------------------------------------ */
const shoelace = (poly) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    s += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(s) / 2;
};
const polyArea = (outer, holes) => shoelace(outer) - (holes || []).reduce((a, h) => a + shoelace(h), 0);
const boundsOf = (poly) => {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of poly) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
};

function rect(x, y, w, h) {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
function rectCW(x, y, w, h) {
  return [{ x, y }, { x, y: y + h }, { x: x + w, y: y + h }, { x: x + w, y }];
}
function regularPoly(cx, cy, r, n, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}
function rightTriangle(w, h) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }];
}

// Tiles 300x300 con hueco cuadrado 140x140 (superficie de anidado interior: "la magia")
function tileWithHole() {
  return { polygon: rect(0, 0, 300, 300), holes: [rectCW(80, 80, 140, 140)] };
}
// Anillo (donut): R=60, r=30 → cabe en el hueco 140x140 del tile
function donut() {
  return { polygon: regularPoly(60, 60, 60, 28), holes: [regularPoly(60, 60, 30, 24, Math.PI / 24)] };
}
function hexagon() {
  return { polygon: regularPoly(50, 43.3, 50, 6, 0), holes: [] };
}
function triangle() {
  return { polygon: rightTriangle(200, 200), holes: [] };
}

function makePart(name, geom, qty) {
  const holes = geom.holes || [];
  return {
    filename: name,
    grain: 'free',
    quantity: qty || 1,
    polygon: geom.polygon,
    holes,
    bounds: boundsOf(geom.polygon),
    area: polyArea(geom.polygon, holes)
  };
}

/* ------------------------------------------------------------------ *
 *  Comprobaciones independientes de solape y minGap
 * ------------------------------------------------------------------ */
const EPS = 1e-6;
function segInter(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function segSegDist(a1, a2, b1, b2) {
  const ptSeg = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  if (segInter(a1, a2, b1, b2)) return 0;
  return Math.min(ptSeg(a1, b1, b2), ptSeg(a2, b1, b2), ptSeg(b1, a1, a2), ptSeg(b2, a1, a2));
}
function polyEdges(poly) {
  const e = [];
  for (let i = 0; i < poly.length; i++) e.push([poly[i], poly[(i + 1) % poly.length]]);
  return e;
}
function auditPlacements(placements, spacing) {
  let overlaps = 0, minGap = Infinity, worst = null;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const A = placements[i], B = placements[j];
      // Saltar anidado legítimo (pieza dentro de una cavidad real de la otra)
      const legit =
        (B.inHole && (A.holes || []).some((h) => B.outer.every((p) => pointInPoly(p, h)))) ||
        (A.inHole && (B.holes || []).some((h) => A.outer.every((p) => pointInPoly(p, h))));
      if (legit) continue;

      const eA = polyEdges(A.outer), eB = polyEdges(B.outer);
      let inter = false;
      for (const [a1, a2] of eA) {
        for (const [b1, b2] of eB) { if (segInter(a1, a2, b1, b2)) { inter = true; break; } }
        if (inter) break;
      }
      if (!inter) {
        // Contención total (una pieza dentro de la otra sin ser anidado de cavidad)
        const AinsideB = A.outer.every((p) => pointInPoly(p, B.outer));
        const BinsideA = B.outer.every((p) => pointInPoly(p, A.outer));
        if (AinsideB || BinsideA) inter = true;
      }
      if (inter) {
        overlaps++;
        minGap = -1;
        worst = `${A.filename}#${A.id} ∩ ${B.filename}#${B.id}`;
        continue;
      }
      for (const [a1, a2] of eA) {
        for (const [b1, b2] of eB) {
          const d = segSegDist(a1, a2, b1, b2);
          if (d < minGap) { minGap = d; worst = `${A.filename}#${A.id} ~ ${B.filename}#${B.id}`; }
        }
      }
    }
  }
  return { overlaps, minGap, worst };
}

/* ------------------------------------------------------------------ *
 *  ESQUEMA 1: lote de compactación (~62% de la hoja)
 * ------------------------------------------------------------------ */
function buildCompactionParts() {
  return [
    makePart('A_tile_hueco', tileWithHole(), 4),   // 4 x 70.4k  = 281.6k
    makePart('B_triangulo', triangle(), 8),        // 8 x 20.0k  = 160.0k
    makePart('C_donut', donut(), 8),               // 8 x  8.48k =  67.9k
    makePart('D_hexagono', hexagon(), 16),         // 16 x 6.50k = 103.9k
  ];                                               // TOTAL       ≈ 613.4k  (61.3%)
}

/* ------------------------------------------------------------------ *
 *  ESQUEMA 2: lote pequeño para el test de continuidad
 * ------------------------------------------------------------------ */
function buildContinuityParts() {
  return [
    makePart('S_hexagono', hexagon(), 3),
    makePart('S_triangulo', triangle(), 2),
    makePart('S_donut', donut(), 2),
  ];
}

/* ------------------------------------------------------------------ *
 *  Arranque Electron + driver del worker GPU
 * ------------------------------------------------------------------ */
let progressCount = 0;
let lastProgress = null;
let lastBest = null;
let newBestCount = 0;
let neverFinished = true;
let lastStopped = null;

function genMs() {
  if (!lastProgress || !lastProgress.generationsCompleted) return null;
  return lastProgress.elapsedMs / lastProgress.generationsCompleted;
}

app.whenReady().then(async () => {
  const worker = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  worker.webContents.on('console-message', (e, l, m) => {
    const s = String(m);
    if (!/Security Warning|Content-Security|Autofill/.test(s)) console.log('[worker]', s.slice(0, 240));
  });

  ipcMain.on('engine:progress', (e, d) => { progressCount++; lastProgress = d; });
  ipcMain.on('engine:new-best', (e, d) => { newBestCount++; lastBest = d; });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 400)));
  ipcMain.on('engine:finished', () => { neverFinished = false; });
  ipcMain.on('engine:stopped', (e, d) => { lastStopped = d || {}; });
  ipcMain.handle('get-gpu-info', () => ({ model: 'TEST-HARNESS' }));

  worker.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const startEngine = (parts, cfg) => worker.webContents.send('engine:start', { parts, sheetConfig: cfg });
  const stopEngine = () => worker.webContents.send('engine:stop');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const SHEET_CFG = { widthMm: SHEET_W, heightMm: SHEET_H, spacingMm: SPACING, bleedMm: 0, continuousRoll: false };

  let failures = 0;
  const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

  /* ============================ TEST 1: COMPACTACIÓN ============================ */
  console.log('\n=== TEST 1 · COMPACTACIÓN DE HOJAS (1 hoja) ===');
  const parts1 = buildCompactionParts();
  const totalCount1 = parts1.reduce((a, p) => a + p.quantity, 0);
  const netArea1 = parts1.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`Piezas: ${totalCount1} · área neta: ${(netArea1 / 1000).toFixed(1)}k mm² = ${(100 * netArea1 / (SHEET_W * SHEET_H)).toFixed(1)}% de la hoja ${SHEET_W}x${SHEET_H}`);

  progressCount = 0; newBestCount = 0; lastBest = null; lastProgress = null;
  const t1 = Date.now();
  startEngine(parts1, SHEET_CFG);

  // Esperar a un resultado que use 1 sola hoja con todo colocado, o agotar el presupuesto.
  const BUDGET_MS = 150000;
  let best1 = null;
  while (Date.now() - t1 < BUDGET_MS) {
    await sleep(400);
    const b = lastBest;
    if (b && b.sheetsUsed === 1 && (b.unplacedParts || 0) === 0) { best1 = b; break; }
    if (b && (!best1 || (b.unplacedParts || 0) < (best1.unplacedParts || 0))) best1 = b;
  }
  const t1elapsed = Date.now() - t1;

  const stopT0 = Date.now();
  stopEngine();
  await sleep(120);
  const stopLatency = Date.now() - stopT0;

  const sheetsUsed1 = best1 ? best1.sheetsUsed : -1;
  const placed1 = best1 ? best1.placedParts : 0;
  const unplaced1 = best1 ? best1.unplacedParts : totalCount1;

  console.log(`→ resultado: hojas=${sheetsUsed1} · colocadas=${placed1}/${totalCount1} · sin colocar=${unplaced1} · util=${best1 ? best1.utilisation.toFixed(1) : '?'}% · gens=${newBestCount} · t=${(t1elapsed / 1000).toFixed(1)}s`);

  const placements1 = (best1 && best1.sheets) ? best1.sheets.flatMap((s) => (s.placements || []).map((p) => ({
    id: p.id, filename: p.filename, inHole: !!p.inHole, outer: p.placedOuter, holes: p.placedHoles || []
  }))) : [];
  const inHole1 = placements1.filter((p) => p.inHole).length;
  const audit1 = auditPlacements(placements1, SPACING);
  console.log(`→ auditoría: solapes=${audit1.overlaps} · minGap=${audit1.minGap === Infinity ? 'n/a' : audit1.minGap.toFixed(2) + ' mm'} · enHueco=${inHole1} · peor=${audit1.worst || '-'}`);

  assert(sheetsUsed1 === 1, `Consolidado en 1 SOLA hoja (obtenido: ${sheetsUsed1})`);
  assert(unplaced1 === 0, `Todas las piezas colocadas (sin colocar: ${unplaced1})`);
  assert(audit1.overlaps === 0, `Cero solapes de material (obtenido: ${audit1.overlaps})`);
  assert(audit1.minGap === Infinity || audit1.minGap >= SPACING - GAP_TOL, `minGap >= spacing (minGap=${audit1.minGap === Infinity ? 'n/a' : audit1.minGap.toFixed(2)}mm, spacing=${SPACING}mm)`);

  /* ============================ TEST 2: BUCLE CONTINUO ============================ */
  console.log('\n=== TEST 2 · BUCLE CONTINUO (no auto-stop, >= 25 generaciones) ===');
  const parts2 = buildContinuityParts();
  progressCount = 0; newBestCount = 0; lastBest = null; lastProgress = null; lastStopped = null; neverFinished = true;

  const t2 = Date.now();
  startEngine(parts2, SHEET_CFG);
  const RUN_MS = 20000;
  await sleep(RUN_MS);

  const gens2 = lastProgress ? lastProgress.generationsCompleted : 0;
  const elapsed2 = lastProgress ? lastProgress.elapsedMs : RUN_MS;
  const msPerGen = gens2 > 0 ? elapsed2 / gens2 : null;
  const gensPerSec = msPerGen ? 1000 / msPerGen : null;
  console.log(`→ ${gens2} generaciones en ${(elapsed2 / 1000).toFixed(1)}s · ${msPerGen ? msPerGen.toFixed(0) : '?'} ms/gen · ${gensPerSec ? gensPerSec.toFixed(2) : '?'} gens/s`);

  stopEngine();
  await sleep(150);
  const stop2 = lastStopped ? lastStopped.stopTimeMs : Infinity;

  assert(gens2 >= 25, `Generaciones continuas >= 25 (obtenido: ${gens2})`);
  assert(neverFinished, 'El motor NO se auto-detuvo (sin evento engine:finished)');
  assert(stop2 < 5, `engine:stop respondió en < 5 ms (obtenido: ${Number(stop2).toFixed(2)} ms)`);

  /* ============================ RESUMEN ============================ */
  console.log('\n================ RESUMEN ================');
  console.log(`1) Compactación : ${sheetsUsed1} hoja(s), ${placed1}/${totalCount1} colocadas, ${audit1.overlaps} solapes, minGap ${audit1.minGap === Infinity ? '-' : audit1.minGap.toFixed(2)}mm, ${inHole1} piezas en cavidad`);
  console.log(`2) Continuidad  : ${gens2} generaciones en ${(elapsed2 / 1000).toFixed(0)}s (${msPerGen ? msPerGen.toFixed(0) : '?'} ms/gen), stop ${Number(stop2).toFixed(2)} ms`);
  console.log(`3) GPU/telemetría: progreso=${progressCount}, newBest=${newBestCount}`);
  console.log(`ASSERTS: ${failures === 0 ? 'TODOS OK ✅' : failures + ' FALLIDO(S) ❌'}`);
  console.log('==========================================');

  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 200);
});
