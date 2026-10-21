/** test_export_real.js — Layout con activos REALES (TIFF/PDF de la carpeta de muestras) para auditar DXF+PDF. */
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PROJ = path.join(__dirname, '..');
const PY = (process.env.PHOENIX_PYTHON || 'python');
const CONV = path.join(PROJ, 'engine', 'local_cad_converter.py');
const D = (process.env.NEST_SAMPLES || path.join(PROJ, 'samples') + path.sep);
const S = 1000, H = 2000, SP = 3;
const FILES = process.env.FILES ? process.env.FILES.split(',') : ['09_trama_corte_300dpi.tif', '10_mascara_binaria_linework.tif', '11_preprensa_tiff_it_ct.tif', '12_preprensa_tiff_it_lw.tif'];

function piecesOf(file) {
  const out = execFileSync(PY, [CONV, D + file, '300'], { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  const m = out.match(/---BEGIN_META---([\s\S]*?)---END_META---/);
  if (!m) throw new Error('no meta ' + file);
  return JSON.parse(m[1]).pieces || [];
}
const parts = [];
let id = 0;
for (const f of FILES) {
  for (const p of piecesOf(f)) {
    parts.push({
      id: id++, filename: f, source_path: D + f, grain: 'free', quantity: 2,
      polygon: (p.polygon || []).map(pt => ({ x: pt[0], y: pt[1] })),
      holes: (p.holes || []).map(h => (h || []).map(pt => ({ x: pt[0], y: pt[1] }))),
      bounds: p.bounds, area: p.area
    });
  }
}
let lastBest = null, stopSent = 0, stopAck = null, stopped = false;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:progress', (e, d) => {
    if (d.inProgress || stopped) return;
    if (d.generation >= 3) { stopped = true; stopSent = Date.now(); w.webContents.send('engine:stop'); }
  });
  ipcMain.on('engine:stopped', (e, d) => {
    stopAck = d || {};
    setTimeout(() => {
      const out = { sheetW: S, sheetH: H, spacing: SP, stopTimeMs: stopAck.stopTimeMs, stopRoundTripMs: Date.now() - stopSent, best: lastBest };
      fs.writeFileSync(path.join(os.tmpdir(), 'real_export.json'), JSON.stringify(out));
      console.log('DUMP real_export.json pieces=' + (lastBest ? lastBest.placedParts : 0));
      app.exit(0);
    }, 200);
  });
  ipcMain.handle('get-gpu-info', () => ({ model: 'EXPORT' }));
  w.webContents.on('console-message', (ev, lvl, msg) => { if (/Error|AUDIT/i.test(String(msg))) console.log('[win]', String(msg).slice(0, 300)); });
  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1500));
  w.webContents.send('engine:start', { parts, sheetConfig: { widthMm: S, heightMm: H, spacingMm: SP, bleedMm: 0, continuousRoll: false, angleQuantum: 1 } });
  setTimeout(() => { if (!stopped) { stopped = true; stopSent = Date.now(); w.webContents.send('engine:stop'); } }, 60000);
});
