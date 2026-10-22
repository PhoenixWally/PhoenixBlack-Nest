/** test_fixed_180.js — Lote real (~180 piezas) en LÁMINAS FIJAS 1000x2000 mm. */
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PROJ = path.join(__dirname, '..');
const PY = (process.env.PHOENIX_PYTHON || 'python');
const CONV = path.join(PROJ, 'engine', 'local_cad_converter.py');
const D = (() => {
  const raw = process.env.NEST_SAMPLES || path.join(PROJ, 'samples');
  return raw.endsWith(path.sep) || raw.endsWith('/') ? raw : raw + path.sep;
})();
const QTY = Number(process.env.QTY || 3), S = 1000, H = 2000, SP = 3;

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
const DUR = Number(process.env.DUR || 240000);

function insideBox(b, hb, m) {
  return b.minX >= hb.minX + m && b.maxX <= hb.maxX - m && b.minY >= hb.minY + m && b.maxY <= hb.maxY - m;
}

app.whenReady().then(async () => {
  const parts = buildParts();
  const totPieces = parts.reduce((a, p) => a + p.quantity, 0);
  const totArea = parts.reduce((a, p) => a + p.area * p.quantity, 0);
  console.log(`PARTES-FILE=${parts.length}  PIEZAS=${totPieces}  AREA=${(totArea / 1e6).toFixed(3)}m²  sheets=${S}x${H} fixed sp=${SP}`);
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  ipcMain.on('engine:progress', (e, d) => { if (d.inProgress) return; trace.push({ gen: d.generation, best: d.bestFitness, roll: d.bestRollLengthMm, placed: d.placedCount, tot: d.totalCount, nb: d.isNewBest, ms: d.elapsedMs }); });
  ipcMain.on('engine:new-best', (e, d) => { lastBest = d; });
  ipcMain.on('engine:finished', () => { sawFinished = true; });
  ipcMain.on('engine:error', (e, err) => console.log('[engine:error]', String(err).slice(0, 300)));
  ipcMain.handle('get-gpu-info', () => ({ model: 'FIXED180' }));
  w.webContents.on('console-message', (ev, lvl, msg) => { const s = String(msg); if (/AUDIT|error|Error/i.test(s)) console.log('[win]', s.slice(0, 600)); });
  w.webContents.on('render-process-gone', (ev, d) => console.log('[worker-gone]', JSON.stringify(d)));
  w.loadFile(path.join(PROJ, 'worker', 'gpu_worker.html'));
  await new Promise(r => setTimeout(r, 1600));
  w.webContents.send('engine:start', { parts, sheetConfig: { widthMm: S, heightMm: H, spacingMm: SP, bleedMm: 0, continuousRoll: false, angleQuantum: 1 } });
  await new Promise(r => setTimeout(r, DUR));
  w.webContents.send('engine:stop');
  await new Promise(r => setTimeout(r, 300));

  console.log(`\nGens=${trace.length}  sawFinished=${sawFinished}`);
  for (const t of trace) console.log(`gen ${String(t.gen).padStart(2)} | fit=${String(Math.round(t.best)).padStart(12)} | placed=${t.placed}/${t.tot} | ${t.nb ? 'NEW' : '   '} | ${t.ms}ms`);

  if (lastBest) {
    const sheets = lastBest.sheets || [];
    console.log(`\nBEST: util=${(lastBest.utilisation || 0).toFixed(1)}% placed=${lastBest.placedCount}/${lastBest.totalCount} sheets=${lastBest.sheetsUsed}`);
    let totalInHole = 0;
    sheets.slice(0, 6).forEach((sh, si) => {
      const pls = sh.placements || [];
      let inHole = 0, maxY = 0, maxYPiece = '';
      for (let i = 0; i < pls.length; i++) {
        const b = pls[i].sheetBounds || pls[i].bounds;
        if (b && b.maxY > maxY) { maxY = b.maxY; maxYPiece = pls[i].filename + '@' + Math.round(pls[i].angle || 0) + '°'; }
        for (let j = 0; j < pls.length; j++) {
          if (i === j) continue;
          const holes = pls[j].placedHoles || pls[j].holes || [];
          for (const h of holes) {
            let hb = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
            for (const pt of h) { if (pt.x < hb.minX) hb.minX = pt.x; if (pt.x > hb.maxX) hb.maxX = pt.x; if (pt.y < hb.minY) hb.minY = pt.y; if (pt.y > hb.maxY) hb.maxY = pt.y; }
            if (b && insideBox(b, hb, SP - 0.01)) { inHole++; break; }
          }
        }
      }
      totalInHole += inHole;
      console.log(`  Hoja #${si + 1}: piezas=${pls.length} enHueco=${inHole} maxY=${maxY.toFixed(1)} (${maxYPiece})`);
    });
    console.log(`  TOTAL en huecos (primeras 6 hojas): ${totalInHole}`);
    const out = { utilisation: lastBest.utilisation, sheetsUsed: lastBest.sheetsUsed, placedCount: lastBest.placedCount, totalCount: lastBest.totalCount, sheets: sheets.map(sh => ({ placements: (sh.placements || []).map(p => ({ filename: p.filename, angle: p.angle, bounds: p.sheetBounds || p.bounds })) })) };
    fs.writeFileSync(path.join(os.tmpdir(), 'fixed180.json'), JSON.stringify(out));
  }
  app.exit(0);
});
