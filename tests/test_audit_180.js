/** test_audit_180.js — Auditoría de certificación: 180 piezas heterogéneas, 25 generaciones.
 *  Modo: MODE=fixed (1000x2000, continuousRoll:false) | MODE=roll (1000 mm, continuousRoll:true)
 *  No simula datos: toda la telemetría viene del motor real.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PROJ = path.join(__dirname, '..');
const MODE = (process.env.MODE || 'fixed').toLowerCase();
const GEN_TARGET = Number(process.env.GEN || 25);
const S = 1000, H = MODE === 'roll' ? 1000 : 2000, SP = 3;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261020);

const sho = p => { let s = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; s += p[i].x * p[j].y - p[j].x * p[i].y; } return Math.abs(s) / 2; };
const bnd = p => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of p) { a = Math.min(a, q.x); b = Math.min(b, q.y); c = Math.max(c, q.x); d = Math.max(d, q.y); } return { x: a, y: b, width: c - a, height: d - b }; };
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const rectCW = (x, y, w, h) => [{ x, y }, { x, y: y + h }, { x: x + w, y: y + h }, { x: x + w, y }];
const circle = (cx, cy, r, n, ph = 0) => { const o = []; for (let i = 0; i < n; i++) { const a = ph + i / n * 2 * Math.PI; o.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return o; };
const star = (cx, cy, R, r, pts = 5, ph = -Math.PI / 2) => {
  const o = [];
  for (let i = 0; i < pts * 2; i++) {
    const a = ph + i / (pts * 2) * 2 * Math.PI;
    const rad = i % 2 ? r : R;
    o.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
  }
  return o;
};
const Lshape = (w, h, t, holes) => {
  const outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t }, { x: t, y: t }, { x: t, y: h }, { x: 0, y: h }];
  return { outer, holes: holes || [] };
};
const trap = (bt, bb, h, off) => [{ x: 0, y: 0 }, { x: bb, y: 0 }, { x: off + bt, y: h }, { x: off, y: h }];

function mk(name, poly, holes, qty) {
  return { filename: name, grain: 'free', quantity: qty, polygon: poly, holes: holes || [], bounds: bnd(poly), area: sho(poly) - (holes || []).reduce((a, h) => a + sho(h), 0) };
}

function buildSet() {
  const set = [];
  // ~90 estrellas (90 exactas): 10 geometrías distintas x 9 copias
  const starSizes = [[46, 20], [54, 23], [38, 16], [62, 27], [42, 18], [58, 25], [34, 14], [50, 21], [66, 29], [44, 19]];
  starSizes.forEach(([R, r], i) => {
    set.push(mk(`STAR_${i}`, star(R + 4, R + 4, R, r), [], 9));
  });
  // 24 cajas con hueco (4 geom x 6)
  for (let i = 0; i < 4; i++) {
    const w = 120 + i * 18, h = 90 + i * 14, m = 16 + i * 3;
    set.push(mk(`BOXHOLE_${i}`, rect(0, 0, w, h), [rectCW(m, m, w - 2 * m, h - 2 * m)], 6));
  }
  // 24 L con 2 agujeros (4 x 6)
  for (let i = 0; i < 4; i++) {
    const w = 130 + i * 15, h = 110 + i * 12, t = 34 + i * 4;
    const h1 = circle(t * 0.55, h - t * 0.55, t * 0.28, 20);
    const h2 = circle(w - t * 0.55, t * 0.55, t * 0.28, 20);
    const l = Lshape(w, h, t, [h1, h2]);
    set.push(mk(`LSHAPE_${i}`, l.outer, l.holes, 6));
  }
  // 21 trapecios (3 x 7)
  for (let i = 0; i < 3; i++) {
    const bt = 120 - i * 25, bb = 150 + i * 10, h = 100 + i * 10, off = 15 + i * 5;
    set.push(mk(`TRAP_${i}`, trap(bt, bb, h, off), [], 7));
  }
  // 21 aros (3 x 7)
  for (let i = 0; i < 3; i++) {
    const R = 55 + i * 10, r = 26 + i * 5;
    set.push(mk(`RING_${i}`, circle(R + 4, R + 4, R, 40), [circle(R + 4, R + 4, r, 28, Math.PI / 28)], 7));
  }
  // pequeño ajuste determinista de tamaños para heterogeneidad real (mismo set en ambos modos)
  set.forEach((p, i) => { if (i % 5 === 0) { const k = 0.9 + rnd() * 0.2; p.polygon = p.polygon.map(q => ({ x: q.x * k, y: q.y * k })); p.holes = (p.holes || []).map(h => h.map(q => ({ x: q.x * k, y: q.y * k }))); p.bounds = bnd(p.polygon); p.area = sho(p.polygon) - p.holes.reduce((a, h) => a + sho(h), 0); } });
  return set;
}

const trace = []; let lastBest = null; let stopSent = 0; let stopAck = null; let stopping = false;

app.whenReady().then(async () => {
  const set = buildSet();
  const tot = set.reduce((a, p) => a + p.quantity, 0);
  const totArea = set.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`AUDIT MODE=${MODE} partTypes=${set.length} pieces=${tot} area=${(totArea / 1e6).toFixed(3)}m2 sheet=${S}x${H} sp=${SP} targetGen=${GEN_TARGET}`);

  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  const dump = () => {
    const out = {
      mode: MODE, sheetW: S, sheetH: H, spacing: SP, genTarget: GEN_TARGET,
      trace, stopTimeMs: stopAck ? stopAck.stopTimeMs : null, stopRoundTripMs: stopSent && stopAck ? (Date.now() - stopSent) : null,
      best: lastBest ? {
        generation: lastBest.generation, fitness: lastBest.fitness, utilisation: lastBest.utilisation,
        placedParts: lastBest.placedParts, totalParts: lastBest.totalParts, unplacedParts: lastBest.unplacedParts,
        sheetsUsed: lastBest.sheetsUsed, paperLength_mm: lastBest.paperLength_mm, rollLengthMm: lastBest.rollLengthMm,
        effectiveSheetHeight_mm: lastBest.effectiveSheetHeight_mm,
        sheets: (lastBest.sheets || []).map(sh => ({
          index: sh.index, width: sh.width, height: sh.height, maxY: sh.maxY,
          placements: (sh.placements || []).map(p => ({
            id: p.id, filename: p.filename, source_path: p.source_path, angle: p.rotation, inHole: p.inHole,
            outer: p.placedOuter, holes: p.placedHoles, bounds: p.sheetBounds
          }))
        }))
      } : null
    };
    fs.writeFileSync(path.join(os.tmpdir(), `audit_${MODE}.json`), JSON.stringify(out));
    console.log(`DUMP audit_${MODE}.json`);
  };

  ipcMain.on('engine:progress', (e, d) => {
    if (d.inProgress) return;
    trace.push({ gen: d.generation, best: d.bestFitness, roll: d.bestRollLengthMm, util: d.utilisation, sh: d.sheetsUsed, placed: d.placedCount, tot: d.totalCount, nb: d.isNewBest, ms: d.elapsedMs });
    if (!stopping && trace.length >= GEN_TARGET) {
      stopping = true;
      stopSent = Date.now();
      w.webContents.send('engine:stop');
    }
  });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:stopped', (e, d) => {
    stopAck = d || {};
    setTimeout(async () => { dump(); app.exit(0); }, 150);
  });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 400)));
  ipcMain.handle('get-gpu-info', () => ({ model: 'AUDIT180' }));
  w.webContents.on('console-message', (ev, lvl, msg) => {
    const s = String(msg);
    if (/AUDIT|Audit|AUDIT FATAL|Error de|\[Error/i.test(s)) console.log(s.slice(0, 700));
  });
  w.webContents.on('render-process-gone', (ev, d) => console.log('[worker-gone]', JSON.stringify(d)));
  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1600));
  w.webContents.send('engine:start', { parts: set, sheetConfig: { widthMm: S, heightMm: H, spacingMm: SP, bleedMm: 0, continuousRoll: MODE === 'roll', angleQuantum: 1 } });

  // watchdog
  const t0 = Date.now();
  const wd = setInterval(() => {
    if (Date.now() - t0 > 1000 * (Number(process.env.MAXS) || 600)) {
      console.log('WATCHDOG timeout'); clearInterval(wd); dump(); app.exit(1);
    }
  }, 1000);
});
