/**
 * test_precision_1deg.js — Verificación E2E de ROTACIÓN FINA A 1° (PhoenixBlackNest).
 *
 * Ejecutar:  node_modules\electron\dist\electron.exe test_precision_1deg.js
 *
 * Comprueba:
 *  A) ROTACIÓN FINA 1°  → aparecen ángulos reales no múltiplos de 15 (p.ej. 7°,23°,88°,142°,273°)
 *     y el empaquetado libre (1°) es >= al restringido (15°) [A/B con angleQuantum].
 *  B) CONSOLIDACIÓN      → la "trampa de las 3 piezas" se resuelve en 1 SOLA hoja sin solapes.
 *  C) CONTINUIDAD        → >= 25 generaciones seguidas sin parar; Stop < 5 ms.
 *  D) Reporte: ángulos exactos por pieza, uso de caché VRAM y hojas finales.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const SHEET_W = 1000;
const SHEET_H = 1000;
const SPACING = 3;
const GAP_TOL = 0.9;

/* ------------------------------- Geometría ------------------------------- */
const shoelace = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; s += poly[i].x * poly[j].y - poly[j].x * poly[i].y; } return Math.abs(s) / 2; };
const polyArea = (o, h) => shoelace(o) - (h || []).reduce((a, x) => a + shoelace(x), 0);
const boundsOf = (poly) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of poly) { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; } return { x: a, y: b, width: Math.max(1, c - a), height: Math.max(1, d - b) }; };
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const rectCW = (x, y, w, h) => [{ x, y }, { x, y: y + h }, { x: x + w, y: y + h }, { x: x + w, y }];
const regularPoly = (cx, cy, r, n, ph = 0) => { const o = []; for (let i = 0; i < n; i++) { const a = ph + (i / n) * Math.PI * 2; o.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return o; };
const rot = (poly, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return poly.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })); };
// Parallelogramo oblicuo (sesgado ~23°): empaqueta mejor a ángulos finos
const obliqueParallelogram = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w - h * 0.4245, y: h }, { x: -h * 0.4245, y: h }];
const trapezoid = (w, h, inset) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w - inset, y: h }, { x: inset, y: h }];
const hexagon = () => regularPoly(50, 43.3, 50, 6, 0);
const donut = () => ({ polygon: regularPoly(60, 60, 60, 28), holes: [regularPoly(60, 60, 30, 24, Math.PI / 24)] });
const tileWithHole = () => ({ polygon: rect(0, 0, 300, 300), holes: [rectCW(80, 80, 140, 140)] });

function makePart(name, geom, qty, grain) {
  const holes = geom.holes || [];
  return { filename: name, grain: grain || 'free', quantity: qty || 1, polygon: geom.polygon || geom, holes, bounds: boundsOf(geom.polygon || geom), area: polyArea(geom.polygon || geom, holes) };
}

/* ------------------------------- Auditoría ------------------------------- */
const EPS = 1e-6;
function segInter(p1, p2, p3, p4) { const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4); return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS)); }
function pointInPoly(pt, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside; } return inside; }
function segSegDist(a1, a2, b1, b2) { const pt = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; if (L < EPS) return Math.hypot(p.x - a.x, p.y - a.y); let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)); }; if (segInter(a1, a2, b1, b2)) return 0; return Math.min(pt(a1, b1, b2), pt(a2, b1, b2), pt(b1, a1, a2), pt(b2, a1, a2)); }
function polyEdges(poly) { const e = []; for (let i = 0; i < poly.length; i++) e.push([poly[i], poly[(i + 1) % poly.length]]); return e; }
function auditPlacements(placements) {
  let overlaps = 0, minGap = Infinity;
  for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) {
    const A = placements[i], B = placements[j];
    const legit = (B.inHole && (A.holes || []).some(h => B.outer.every(p => pointInPoly(p, h)))) || (A.inHole && (B.holes || []).some(h => A.outer.every(p => pointInPoly(p, h))));
    if (legit) continue;
    const eA = polyEdges(A.outer), eB = polyEdges(B.outer);
    let inter = false;
    for (const [a1, a2] of eA) { for (const [b1, b2] of eB) if (segInter(a1, a2, b1, b2)) { inter = true; break; } if (inter) break; }
    if (!inter) { if (A.outer.every(p => pointInPoly(p, B.outer)) || B.outer.every(p => pointInPoly(p, A.outer))) inter = true; }
    if (inter) { overlaps++; minGap = -1; continue; }
    for (const [a1, a2] of eA) for (const [b1, b2] of eB) { const d = segSegDist(a1, a2, b1, b2); if (d < minGap) minGap = d; }
  }
  return { overlaps, minGap };
}

/* --------------------------------- Lotes --------------------------------- */
function buildObliqueSet() {
  return [
    makePart('PAR_23', { polygon: obliqueParallelogram(240, 90) }, 8),   // oblicuo ~23°
    makePart('TRA_inset', { polygon: trapezoid(260, 80, 60) }, 6),
    makePart('HEX', { polygon: hexagon() }, 8),
    makePart('DONUT', donut(), 8),
  ];
}
function buildTrapSet() {
  return [
    makePart('TILE_HUEco', tileWithHole(), 4),
    makePart('TRI', { polygon: rot(rect(0, 0, 200, 200), 23).slice(0, 3) }, 8),
    makePart('DONUT', donut(), 8),
    makePart('HEX', { polygon: hexagon() }, 16),
  ];
}
function buildContinuitySet() {
  return [makePart('HEX', { polygon: hexagon() }, 3), makePart('DONUT', donut(), 2)];
}

/* --------------------------------- Driver -------------------------------- */
let lastProgress = null, progressCount = 0, lastBest = null, neverFinished = true, lastStopped = null;

function flatten(best) {
  if (!best || !best.sheets) return [];
  return best.sheets.flatMap(s => (s.placements || []).map(p => ({ id: p.id, filename: p.filename, inHole: !!p.inHole, rotation: p.rotation | 0, outer: p.placedOuter, holes: p.placedHoles || [] })));
}

app.whenReady().then(async () => {
  const worker = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  worker.webContents.on('console-message', (e, l, m) => { const s = String(m); if (/Error|ERROR|fail|no disponible|Warning: .*shader/i.test(s)) console.log('[worker]', s.slice(0, 260)); });
  ipcMain.on('engine:progress', (e, d) => { progressCount++; lastProgress = d; });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:finished', () => { neverFinished = false; });
  ipcMain.on('engine:stopped', (e, d) => { lastStopped = d || {}; });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 400)));
  ipcMain.handle('get-gpu-info', () => ({ model: 'PRECISION-HARNESS' }));

  worker.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1500));

  const start = (parts, cfg) => worker.webContents.send('engine:start', { parts, sheetConfig: cfg });
  const stop = () => worker.webContents.send('engine:stop');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let failures = 0;
  const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

  async function run(parts, cfg, budgetMs, wantConsolidated) {
    lastProgress = null; lastBest = null; progressCount = 0; neverFinished = true;
    const t0 = Date.now();
    start(parts, cfg);
    while (Date.now() - t0 < budgetMs) {
      await sleep(300);
      const b = lastBest;
      if (wantConsolidated && b && b.sheetsUsed === 1 && (b.unplacedParts || 0) === 0) break;
    }
    stop();
    await sleep(150);
    return { best: lastBest, progress: lastProgress, gens: lastProgress ? lastProgress.generationsCompleted : 0, elapsed: Date.now() - t0 };
  }

  /* ================================ TEST A/B ================================ */
  console.log('\n=== TEST A · ROTACIÓN FINA A 1° (libre vs restringido 15°) ===');
  const parts = buildTrapSet();
  const totalCount = parts.reduce((a, p) => a + p.quantity, 0);
  const netArea = parts.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`Piezas: ${totalCount} · área neta: ${(netArea / 1000).toFixed(1)}k mm² = ${(100 * netArea / (SHEET_W * SHEET_H)).toFixed(1)}%`);

  const CFG_RESTRICTED = { widthMm: SHEET_W, heightMm: SHEET_H, spacingMm: SPACING, bleedMm: 0, continuousRoll: false, angleQuantum: 15 };
  const CFG_FREE = { widthMm: SHEET_W, heightMm: SHEET_H, spacingMm: SPACING, bleedMm: 0, continuousRoll: false, angleQuantum: 1 };

  const rRestricted = await run(parts, CFG_RESTRICTED, 90000, true);
  const uR = rRestricted.best ? rRestricted.best.utilisation : 0;
  const platesR = flatten(rRestricted.best);
  console.log(`→ restringido 15°: hojas=${rRestricted.best ? rRestricted.best.sheetsUsed : '?'} util=${uR.toFixed(1)}% colocadas=${rRestricted.best ? rRestricted.best.placedParts : 0}/${totalCount}`);

  const rFree = await run(parts, CFG_FREE, 90000, true);
  const uF = rFree.best ? rFree.best.utilisation : 0;
  const platesF = flatten(rFree.best);
  const anglesF = platesF.map(p => p.rotation);
  const fineAngles = anglesF.filter(a => a % 15 !== 0);
  const uniqFine = Array.from(new Set(fineAngles)).sort((a, b) => a - b);
  console.log(`→ libre 1°       : hojas=${rFree.best ? rFree.best.sheetsUsed : '?'} util=${uF.toFixed(1)}% colocadas=${rFree.best ? rFree.best.placedParts : 0}/${totalCount}`);
  console.log(`→ ángulos finos no múltiplos de 15° usados (${uniqFine.length}): ${uniqFine.join('°, ')}°`);

  assert(uniqFine.length > 0, `Aparecen ángulos finos de 1° no múltiplos de 15° (obtenidos: ${uniqFine.length})`);
  assert(uF >= uR - 0.5, `Empaquetado a 1° >= restringido 15° (${uF.toFixed(1)}% vs ${uR.toFixed(1)}%)`);

  /* ================================ TEST B ================================ */
  console.log('\n=== TEST B · CONSOLIDACIÓN (trampa de 3 piezas) ===');
  const audit = auditPlacements(platesF);
  const sheetsUsed = rFree.best ? rFree.best.sheetsUsed : -1;
  const unplaced = rFree.best ? rFree.best.unplacedParts : totalCount;
  const inHole = platesF.filter(p => p.inHole).length;
  console.log(`→ hojas=${sheetsUsed} · colocadas=${rFree.best ? rFree.best.placedParts : 0}/${totalCount} · sin colocar=${unplaced} · solapes=${audit.overlaps} · minGap=${audit.minGap === Infinity ? 'n/a' : audit.minGap.toFixed(2)}mm · enCavidad=${inHole}`);
  assert(sheetsUsed === 1, `Consolidado en 1 sola hoja (obtenido: ${sheetsUsed})`);
  assert(unplaced === 0, `Todas las piezas colocadas (sin colocar: ${unplaced})`);
  assert(audit.overlaps === 0, `Cero solapes de material (obtenido: ${audit.overlaps})`);
  assert(audit.minGap === Infinity || audit.minGap >= SPACING - GAP_TOL, `minGap >= spacing (minGap=${audit.minGap === Infinity ? 'n/a' : audit.minGap.toFixed(2)}mm)`);

  /* ================================ TEST C ================================ */
  console.log('\n=== TEST C · CONTINUIDAD (>= 25 generaciones, sin auto-stop) ===');
  const contParts = buildContinuitySet();
  neverFinished = true; lastProgress = null; progressCount = 0; lastBest = null; lastStopped = null;
  start(contParts, CFG_FREE);
  await sleep(20000);
  const gens = lastProgress ? lastProgress.generationsCompleted : 0;
  const msPerGen = lastProgress && gens ? lastProgress.elapsedMs / gens : null;
  stop();
  await sleep(150);
  const stopMs = lastStopped ? lastStopped.stopTimeMs : Infinity;
  console.log(`→ ${gens} generaciones en ~20s (${msPerGen ? msPerGen.toFixed(0) : '?'} ms/gen) · stop ${Number(stopMs).toFixed(2)} ms`);
  assert(gens >= 25, `Generaciones continuas >= 25 (obtenido: ${gens})`);
  assert(neverFinished, 'El motor NO se auto-detuvo (sin engine:finished)');
  assert(stopMs < 5, `engine:stop < 5 ms (obtenido: ${Number(stopMs).toFixed(2)} ms)`);

  /* ================================ REPORTE ================================ */
  const vramEntries = rFree.progress ? (rFree.progress.vramEntries || 0) : 0;
  const vramMB = rFree.progress ? (rFree.progress.vramMB || 0) : 0;
  console.log('\n================ REPORTE ================');
  console.log(`Caché VRAM rotaciones (source_angle): ${vramEntries} entradas · ~${vramMB} MB`);
  console.log(`Hojas finales usadas: ${sheetsUsed}  (restringido 15°: ${rRestricted.best ? rRestricted.best.sheetsUsed : '?'})`);
  console.log(`Ángulos exactos por pieza (libre 1°):`);
  const byAngle = {};
  for (const p of platesF) byAngle[p.rotation] = (byAngle[p.rotation] || 0) + 1;
  console.log('  ' + Object.keys(byAngle).sort((a, b) => a - b).map(a => `${a}°×${byAngle[a]}`).join('  '));
  const fineList = platesF.filter(p => p.rotation % 15 !== 0).slice(0, 12).map(p => `${p.filename}#${p.id}→${p.rotation}°`);
  console.log('  ejemplos finos: ' + (fineList.join('  ') || '(ninguno)'));
  console.log(`ASSERTS: ${failures === 0 ? 'TODOS OK ✅' : failures + ' FALLIDO(S) ❌'}`);
  console.log('=========================================');

  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 200);
});
