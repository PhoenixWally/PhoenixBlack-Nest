/**
 * bench_engine.js — Benchmark reproducible del motor (A/B de optimizaciones).
 *
 * Uso:
 *   electron tests/bench_engine.js
 * Entorno:
 *   NEST_SAMPLES  carpeta del lote real (por defecto ../samples)
 *   QTY           copias por pieza (3)
 *   W,H,SP        hoja (1000x2000, spacing 3)
 *   ROLL          1 = bobina continua, 0 = láminas fijas (0)
 *   GENS          generaciones a medir (6)
 *   TAG           etiqueta para el JSON de salida
 *   ANGQ          cuantía angular (1)
 * Salida: por generación (ms, util, roll, colocadas) + estadísticas GPU + JSON.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.join(__dirname, '..');
const PY = (process.env.PHOENIX_PYTHON || 'python');
const CONV = path.join(PROJ, 'engine', 'local_cad_converter.py');
const D = (process.env.NEST_SAMPLES || path.join(PROJ, 'samples') + path.sep);
const QTY = Number(process.env.QTY || 3);
const W = Number(process.env.W || 1000);
const H = Number(process.env.H || 2000);
const SP = Number(process.env.SP || 3);
const ROLL = String(process.env.ROLL || '0') === '1';
const GENS = Number(process.env.GENS || 6);
const TAG = process.env.TAG || 'bench';
const ANGQ = Number(process.env.ANGQ || 1);

function piecesOf(file) {
  const out = execFileSync(PY, [CONV, D + file, '300'], { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  const m = out.match(/---BEGIN_META---([\s\S]*?)---END_META---/);
  if (!m) throw new Error('no meta ' + file);
  return JSON.parse(m[1]).pieces || [];
}

function buildParts() {
  const files = fs.readdirSync(D).filter(f => /^(0[1-9]|1[0-4])_/.test(f)).sort();
  const parts = [];
  let id = 0;
  for (const f of files) {
    const ps = piecesOf(f);
    ps.forEach((p, k) => {
      const poly = (p.polygon || []).map(pt => ({ x: pt[0], y: pt[1] }));
      const holes = (p.holes || []).map(h => (h || []).map(pt => ({ x: pt[0], y: pt[1] })));
      parts.push({ id: id++, filename: `${f}#${k}`, source_path: D + f, grain: 'free', quantity: QTY, polygon: poly, holes, bounds: p.bounds, area: p.area });
    });
  }
  return parts;
}

const trace = [];
const genMs = new Map();
let micro = null;
let lastBest = null;
let stats = null;

app.whenReady().then(async () => {
  const parts = buildParts();
  const totPieces = parts.reduce((a, p) => a + p.quantity, 0);
  const totArea = parts.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`[${TAG}] piezas=${totPieces} area=${(totArea / 1e6).toFixed(3)}m2 sheet=${W}x${H} sp=${SP} roll=${ROLL} gens=${GENS}`);

  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  ipcMain.on('engine:progress', (e, d) => {
    if (genMs.has(d.generation)) return;
    genMs.set(d.generation, { gen: d.generation, best: d.bestFitness, roll: d.bestRollLengthMm, util: d.utilisation, placed: d.placedCount, tot: d.totalCount, nb: d.isNewBest, ms: d.elapsedMs });
  });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:debug-stats:result', (e, d) => { stats = d; });
  ipcMain.on('engine:micro:result', (e, d) => { micro = d; });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 300)));
  ipcMain.handle('get-gpu-info', () => ({ model: 'BENCH' }));
  w.webContents.on('console-message', (ev, lvl, msg) => {
    const t = String(msg);
    if (/error|Error|descartada|GPU Worker/.test(t)) console.log('[win]', t.slice(0, 300));
  });
  w.webContents.on('render-process-gone', (e, d) => console.log('[worker-gone]', JSON.stringify(d)));

  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1600));

  const t0 = Date.now();
  w.webContents.send('engine:start', { parts, seed: process.env.PBN_SEED ? parseInt(process.env.PBN_SEED, 10) : undefined, sheetConfig: { widthMm: W, heightMm: H, spacingMm: SP, bleedMm: 0, continuousRoll: ROLL, angleQuantum: ANGQ } });

  const DUR = Number(process.env.DUR || 20000);
  await new Promise(r => setTimeout(r, DUR));
  const tStop = Date.now();
  w.webContents.send('engine:stop');
  await new Promise(r => setTimeout(r, 400));
  w.webContents.send('engine:debug-stats');
  w.webContents.send('engine:micro');
  await new Promise(r => setTimeout(r, 900));
  if (micro) console.log(`[${TAG}] MICRO readPixels perCall=${micro.perCall ? micro.perCall.toFixed(2) : '?'}ms n=${micro.n || 0}`);

  const used = Array.from(genMs.values()).sort((a, b) => a.gen - b.gen).slice(0, GENS + 1);
  const wall = (tStop - t0) / 1000;
  const gensDone = (stats && stats.engine && stats.engine.generations) ? stats.engine.generations : (used.length ? used[used.length - 1].gen : 0);
  const avg = gensDone > 0 ? (wall * 1000) / gensDone : 0;
  console.log(`\n[${TAG}] gens_done=${gensDone} wall=${wall.toFixed(2)}s avg_gen=${avg.toFixed(0)}ms`);
  for (const t of used) console.log(`  gen ${String(t.gen).padStart(2)} | util=${(t.util || 0).toFixed(1)}% | roll=${Math.round(t.roll)} | placed=${t.placed}/${t.tot} | ${t.ms}ms ${t.nb ? 'NEW' : ''}`);
  if (lastBest) console.log(`[${TAG}] BEST util=${(lastBest.utilisation || 0).toFixed(1)}% sheets=${lastBest.sheetsUsed} roll=${Math.round(lastBest.rollLengthMm)}mm placed=${lastBest.placedParts}/${lastBest.totalParts}`);
  if (stats && stats.gpu) {
    const g = stats.gpu;
    console.log(`[${TAG}] GPU batchCalls=${g.batchCalls} batchMs=${g.batchMs.toFixed(0)} reduceMs=${g.reduceMs.toFixed(0)} readMs=${g.readMs.toFixed(0)} (${(g.readMs / Math.max(1, g.batchCalls)).toFixed(2)} ms/llamada) syncMs=${(g.syncMs || 0).toFixed(0)} readKB=${(g.readBytes / 1024).toFixed(1)}`);
    console.log(`[${TAG}] evalScale=${stats.engine ? stats.engine.evalScaleX + 'x' + stats.engine.evalScaleY : '?'}`);
    if (stats.engine && stats.engine.prof) {
      const q = stats.engine.prof;
      console.log(`[${TAG}] PROF calls=${q.calls} total=${q.total.toFixed(0)}ms batch=${q.batch.toFixed(0)}ms refine=${q.refine.toFixed(0)}ms grid=${q.grid.toFixed(0)}ms`);
    }
  }

  const out = {
    tag: TAG, gens: used.length, avgGenMs: avg, wallS: wall,
    best: lastBest ? { util: lastBest.utilisation, sheets: lastBest.sheetsUsed, roll: lastBest.rollLengthMm, placed: lastBest.placedCount, total: lastBest.totalCount } : null,
    gpu: stats ? stats.gpu : null,
    placements: lastBest ? (lastBest.sheets || []).map(sh => (sh.placements || []).map(p => ({ id: p.id, filename: p.filename, angle: p.angle || p.rotation || 0, bounds: p.sheetBounds || p.bounds }))) : null
  };
  const file = path.join(os.tmpdir(), `bench_${TAG}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`[${TAG}] json=${file}`);
  app.exit(0);
});
