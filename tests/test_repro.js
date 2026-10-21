/** test_repro.js — Reproduce el lote real: muestras 01..14 x20, bobina 1000mm, spacing 3mm. */
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PROJ = path.join(__dirname, '..');
const PY = (process.env.PHOENIX_PYTHON || 'python');
const CONV = path.join(PROJ, 'engine', 'local_cad_converter.py');
const D = (process.env.NEST_SAMPLES || path.join(PROJ, 'samples') + path.sep);
const QTY = Number(process.env.QTY || 10), S = 1000, SP = 3;

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

const trace = []; let lastBest = null; let sawFinished = false;
const DUR = Number(process.env.DUR || 150000);
app.whenReady().then(async () => {
  const parts = buildParts();
  const totPieces = parts.reduce((a, p) => a + p.quantity, 0);
  const totArea = parts.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`PARTES-FILE=${parts.length}  PIEZAS=${totPieces}  AREA=${(totArea / 1e6).toFixed(3)}m²  rollW=${S} sp=${SP}`);
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  ipcMain.on('engine:progress', (e, d) => { if (d.inProgress) return; trace.push({ gen: d.generation, best: d.bestFitness, roll: d.bestRollLengthMm, placed: d.placedCount, tot: d.totalCount, nb: d.isNewBest, ms: d.elapsedMs }); });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:finished', () => { sawFinished = true; });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 300)));
  ipcMain.handle('get-gpu-info', () => ({ model: 'REPRO' }));
  w.webContents.on('console-message', (ev, lvl, msg) => { console.log('[win]', String(msg).slice(0, 1200)); });
  w.webContents.on('render-process-gone', (ev, d) => console.log('[worker-gone]', JSON.stringify(d)));
  w.webContents.on('did-fail-load', (ev, ec, desc) => console.log('[fail-load]', ec, desc));
  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1600));
  w.webContents.send('engine:start', { parts, sheetConfig: { widthMm: S, heightMm: S, spacingMm: SP, bleedMm: 0, continuousRoll: true, angleQuantum: 1 } });
  await new Promise(r => setTimeout(r, DUR));
  w.webContents.send('engine:stop');
  await new Promise(r => setTimeout(r, 300));

  console.log(`\nGens=${trace.length}  sawFinished=${sawFinished}`);
  for (const t of trace) console.log(`gen ${String(t.gen).padStart(2)} | fit=${String(Math.round(t.best)).padStart(12)} | roll=${String(t.roll).padStart(4)} | placed=${t.placed}/${t.tot} | ${t.nb ? '*' : ' '} | ${t.ms}ms`);
  if (lastBest) {
    const out = { rollLengthMm: lastBest.rollLengthMm, utilisation: lastBest.utilisation, sheetsUsed: lastBest.sheetsUsed, placedCount: lastBest.placedCount, totalCount: lastBest.totalCount, sheets: lastBest.sheets };
    fs.writeFileSync(path.join(os.tmpdir(), 'repro_placements.json'), JSON.stringify(out));
    console.log(`\nBEST: util=${(lastBest.utilisation || 0).toFixed(1)}% roll=${lastBest.rollLengthMm}mm placed=${lastBest.placedCount}/${lastBest.totalCount} sheets=${lastBest.sheetsUsed}`);
  }
  app.exit(0);
});
