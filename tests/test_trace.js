/** test_trace.js — Traza gen a gen de fitness/roll para diagnosticar el estancamiento. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const PROJ = path.join(__dirname, '..');
const S = 1000, SP = 3;
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const rectCW = (x, y, w, h) => [{ x, y }, { x, y: y + h }, { x: x + w, y: y + h }, { x: x + w, y }];
const reg = (cx, cy, r, n, ph = 0) => { const o = []; for (let i = 0; i < n; i++) { const a = ph + i / n * 2 * Math.PI; o.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return o; };
const sho = p => { let s = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; s += p[i].x * p[j].y - p[j].x * p[i].y; } return Math.abs(s) / 2; };
const bnd = p => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of p) { a = Math.min(a, q.x); b = Math.min(b, q.y); c = Math.max(c, q.x); d = Math.max(d, q.y); } return { x: a, y: b, width: c - a, height: d - b }; };
const mk = (n, poly, holes, qty) => ({ filename: n, grain: 'free', quantity: qty, polygon: poly, holes: holes || [], bounds: bnd(poly), area: sho(poly) - (holes || []).reduce((a, h) => a + sho(h), 0) });
const set = () => [mk('TILE', rect(0, 0, 300, 300), [rectCW(80, 80, 140, 140)], 4), mk('HEX', reg(50, 43, 50, 6, 0), [], 16), mk('DONUT', reg(60, 60, 60, 28), [reg(60, 60, 30, 24, Math.PI / 24)], 8), mk('TRI', [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }], [], 8)];
const trace = [];
let lastBest = null;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  ipcMain.on('engine:progress', (e, d) => trace.push({ gen: d.generation, fit: d.fitness, best: d.bestFitness, roll: d.bestRollLengthMm, sh: d.sheetsUsed, placed: d.placedCount, tot: d.totalCount, nb: d.isNewBest, ms: d.elapsedMs }));
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.handle('get-gpu-info', () => ({ model: 'TRACE' }));
  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1400));
  w.webContents.send('engine:start', { parts: set(), sheetConfig: { widthMm: S, heightMm: S, spacingMm: SP, bleedMm: 0, continuousRoll: false, angleQuantum: 1 } });
  await new Promise(r => setTimeout(r, 120000));
  w.webContents.send('engine:stop');
  await new Promise(r => setTimeout(r, 200));
  console.log('gen | fitness        | bestFit        | roll | sheets | placed | NEW | ms');
  let lastRoll = null, sameRoll = 0;
  for (const t of trace) { if (t.roll === lastRoll) sameRoll++; else { sameRoll = 1; lastRoll = t.roll; } console.log(`${String(t.gen).padStart(3)} | ${String(t.fit).padStart(14)} | ${String(t.best).padStart(14)} | ${String(t.roll).padStart(4)} | ${t.sh} | ${t.placed}/${t.tot} | ${t.nb ? ' * ' : '   '} | ${t.ms}`); }
  const nb = trace.filter(t => t.nb).length;
  const uniqRoll = new Set(trace.map(t => t.roll)).size;
  console.log(`\nGens=${trace.length} · newBest=${nb} · distinctRollLengths=${uniqRoll} · finalBest=${lastBest ? lastBest.utilisation.toFixed(1) + '% util, ' + lastBest.sheetsUsed + ' hojas' : 'n/a'}`);
  app.exit(0);
});
