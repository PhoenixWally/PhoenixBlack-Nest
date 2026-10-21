const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// 1. FLAGS ANTI-THROTTLING ESTRICTOS (GPU + WebGL2 + Timers sin suspensión)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('--enable-precise-memory-info');

let uiWindow = null;
let gpuWorkerWindow = null;
let powerSaveId = null;
let gpuInfoCached = null;

// Resolucion portable del interprete Python: variable de entorno > runtime incluido > PATH
function resolvePython() {
    const candidates = [];
    if (process.env.PHOENIXBLACKNEST_PYTHON) candidates.push(process.env.PHOENIXBLACKNEST_PYTHON);
    candidates.push(path.join(__dirname, 'runtime', 'python', 'python.exe'));
    candidates.push(path.join(__dirname, 'runtime', 'python', 'bin', 'python3'));
    const local = candidates.find((p) => p && fs.existsSync(p));
    if (local) return local;
    return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON_PATH = resolvePython();
// Entorno Python aislado: sin paquetes del usuario, UTF-8 y sin escribir bytecode
const PY_ENV = Object.assign({}, process.env, {
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1'
});
const EXPORTER_SCRIPT = path.join(__dirname, 'engine', 'pdf_imposition_exporter.py');
const CONVERTER_SCRIPT = path.join(__dirname, 'engine', 'local_cad_converter.py');

function createWindows() {
    try {
        if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
            powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        }
    } catch (e) {
        console.warn('powerSaveBlocker:', e);
    }

    // CAPA A: Worker GPU Dedicado Oculto
    gpuWorkerWindow = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    gpuWorkerWindow.loadFile(path.join(__dirname, 'worker', 'gpu_worker.html'));

    gpuWorkerWindow.webContents.on('crashed', (e) => {
        console.error('[GPU Worker Crashed]', e);
    });

    // CAPA B: Frontend Industrial Reactivo
    const isE2E = process.argv.includes('--test-e2e');

    uiWindow = new BrowserWindow({
        title: 'PhoenixBlackNest - Industrial GPU Nesting Core',
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: '#0f172a',
        show: !isE2E, // En modo E2E puede estar visible o ejecutarse directamente
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    if (isE2E) {
        uiWindow.show();
    }

    uiWindow.loadFile(path.join(__dirname, 'ui', 'ui_window.html'));

    uiWindow.on('closed', () => {
        uiWindow = null;
        if (gpuWorkerWindow && !gpuWorkerWindow.isDestroyed()) {
            gpuWorkerWindow.destroy();
        }
        app.quit();
    });

    // Enrutamiento IPC entre UI y Worker GPU
    ipcMain.on('engine:start', (event, payload) => {
        if (gpuWorkerWindow && !gpuWorkerWindow.isDestroyed()) {
            gpuWorkerWindow.webContents.send('engine:start', payload);
        }
    });

    ipcMain.on('engine:stop', () => {
        if (gpuWorkerWindow && !gpuWorkerWindow.isDestroyed()) {
            gpuWorkerWindow.webContents.send('engine:stop');
        }
    });

    ipcMain.on('engine:ready', (event, gpuInfo) => {
        gpuInfoCached = gpuInfo;
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:gpu-info', gpuInfo);
        }
    });

    ipcMain.on('engine:progress', (event, data) => {
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:progress', data);
        }
    });

    ipcMain.on('engine:new-best', (event, data) => {
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:new-best', data);
        }
    });

    ipcMain.on('engine:stopped', (event, data) => {
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:stopped', data);
        }
    });

    ipcMain.on('engine:finished', (event, data) => {
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:finished', data);
        }
    });

    ipcMain.on('engine:error', (event, err) => {
        if (uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('engine:error', err);
        }
    });

    ipcMain.handle('get-gpu-info', () => {
        return gpuInfoCached;
    });

    // Exportación a PDF / DXF conectada al motor Python
    ipcMain.handle('export:pdf', async (event, jobData) => {
        const defaultName = `anidado_${Date.now()}.pdf`;
        const saveRes = await dialog.showSaveDialog(uiWindow, {
            title: 'Exportar PDF Industrial (CutContour + CMYK)',
            defaultPath: defaultName,
            filters: [{ name: 'Documento PDF Industrial', extensions: ['pdf'] }]
        });

        if (saveRes.canceled || !saveRes.filePath) {
            return { canceled: true };
        }

        return executePythonExport(jobData, saveRes.filePath, 'pdf');
    });

    ipcMain.handle('export:dxf', async (event, jobData) => {
        const defaultName = `anidado_${Date.now()}.dxf`;
        const saveRes = await dialog.showSaveDialog(uiWindow, {
            title: 'Exportar DXF Escala 1:1 mm (CutContour)',
            defaultPath: defaultName,
            filters: [{ name: 'Trazado CAD DXF', extensions: ['dxf'] }]
        });

        if (saveRes.canceled || !saveRes.filePath) {
            return { canceled: true };
        }

        return executePythonExport(jobData, saveRes.filePath, 'dxf');
    });

    // Importación de archivos locales
    ipcMain.handle('dialog:import-files', async (event, options = {}) => {
        const dpi = (options && options.dpi) ? options.dpi : 300;
        const res = await dialog.showOpenDialog(uiWindow, {
            title: 'Seleccionar Archivos Vectoriales o CAD',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Formatos Soportados (*.svg, *.dxf, *.dwg, *.pdf, *.png, *.jpg, *.tif)', extensions: ['svg', 'dxf', 'dwg', 'pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'] },
                { name: 'Imágenes Ráster (*.png, *.jpg, *.bmp, *.webp)', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'] },
                { name: 'SVG Vectorial (*.svg)', extensions: ['svg'] },
                { name: 'CAD DXF / DWG (*.dxf, *.dwg)', extensions: ['dxf', 'dwg'] },
                { name: 'PDF Vectorial (*.pdf)', extensions: ['pdf'] }
            ]
        });

        if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
            return [];
        }

        const imported = [];
        for (const filePath of res.filePaths) {
            try {
                const item = await processImportFile(filePath, dpi);
                if (item) imported.push(item);
            } catch (err) {
                console.error(`Error importando ${filePath}:`, err);
            }
        }
        return imported;
    });

    // Si se pasa flag de test e2e, iniciar runner automatizado
    if (isE2E) {
        runAutomatedE2ETest();
    }
}

// Ejecución segura de pdf_imposition_exporter.py
function executePythonExport(jobData, outputPath, mode = 'pdf') {
    return new Promise((resolve, reject) => {
        const tempJson = path.join(os.tmpdir(), `nest_export_${Date.now()}.json`);
        fs.writeFileSync(tempJson, JSON.stringify(jobData, null, 2), 'utf-8');

        execFile(PYTHON_PATH, [EXPORTER_SCRIPT, tempJson, outputPath, mode], {
            maxBuffer: 100 * 1024 * 1024,
            env: PY_ENV
        }, (error, stdout, stderr) => {
            try { fs.unlinkSync(tempJson); } catch (e) {}

            if (error) {
                console.error(`[Export Error ${mode}]:`, stderr || stdout);
                return resolve({ success: false, error: stderr || stdout || error.message });
            }

            try {
                const match = stdout.match(/---BEGIN_EXPORT_RESULT---([\s\S]*?)---END_EXPORT_RESULT---/);
                const result = match ? JSON.parse(match[1]) : { outputPath };
                resolve({ success: true, mode, result, path: outputPath });
            } catch (parseErr) {
                resolve({ success: true, mode, path: outputPath, raw: stdout });
            }
        });
    });
}

// Procesar importación de archivos mediante el conversor Python (True-Shape)
function processImportFile(filePath, dpi = 300) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);

        execFile(PYTHON_PATH, [CONVERTER_SCRIPT, filePath, String(dpi)], {
            maxBuffer: 50 * 1024 * 1024,
            env: PY_ENV
        }, (error, stdout, stderr) => {
            const errMatch = stdout ? stdout.match(/---BEGIN_ERROR---([\s\S]*?)---END_ERROR---/) : null;

            if (error || errMatch) {
                const detail = errMatch ? errMatch[1].trim() : (stderr || error.message);
                console.error(`[Convert Error ${filename}]:`, detail);
                return resolve({
                    filename,
                    source_path: filePath,
                    ext: ext.replace('.', ''),
                    error: detail
                });
            }

            const svgMatch = stdout.match(/---BEGIN_SVG---([\s\S]*?)---END_SVG---/);
            const metaMatch = stdout.match(/---BEGIN_META---([\s\S]*?)---END_META---/);

            const rawSvg = svgMatch ? svgMatch[1].trim() : '';
            let meta = {};
            try {
                meta = metaMatch ? JSON.parse(metaMatch[1]) : {};
            } catch (parseErr) {
                console.error(`[Convert Meta Error ${filename}]:`, parseErr);
            }

            if (!rawSvg && (!meta.pieces || meta.pieces.length === 0)) {
                return resolve({
                    filename,
                    source_path: filePath,
                    ext: ext.replace('.', ''),
                    error: 'El archivo no contiene geometría importable'
                });
            }

            resolve({
                filename,
                source_path: filePath,
                rawSvg: rawSvg,
                meta: meta,
                ext: ext.replace('.', '')
            });
        });
    });
}

// TEST E2E AUTOMATIZADO REAL CON IMÁGENES RÁSTER TRUE-SHAPE
async function runAutomatedE2ETest() {
    console.log('\n======================================================');
    console.log('  INICIANDO SUITE DE PRUEBAS E2E (phoenixblacknest)');
    console.log('  VERIFICACIÓN TRUE-SHAPE Y EXTRACCIÓN DE CONTORNOS');
    console.log('======================================================');

    const reportPath = path.join(os.tmpdir(), 'phoenixblacknest_e2e_report.json');
    const results = {
        boot: false,
        gpuDetected: false,
        starVerified: false,
        starVertices: 0,
        starAreaRatio: 0,
        starHolesCount: 0,
        jpgVerified: false,
        jpgVertices: 0,
        loadedBatch: false,
        continuousRollModePassed: false,
        generationsCount: 0,
        fixedSheetsModePassed: false,
        stopSpeedMs: 0,
        stopInstantPassed: false,
        dxfExportPassed: false,
        pdfExportPassed: false,
        passed: false
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        await sleep(1500);
        results.boot = true;
        results.gpuDetected = !!gpuInfoCached;
        console.log(`[E2E] Boot OK. GPU detectada: ${gpuInfoCached ? gpuInfoCached.model : 'N/A'}`);

        // 1. Verificar generación e importación de imágenes reales
        const starPath = path.join(__dirname, 'sticker_estrella.png');
        const jpgPath = path.join(__dirname, 'pieza_fondo_blanco.jpg');

        // Si no existen, generarlas con el script de prueba
        if (!fs.existsSync(starPath) || !fs.existsSync(jpgPath)) {
            const testScript = path.join(__dirname, 'test_contour.py');
            await new Promise((res, rej) => {
                execFile(PYTHON_PATH, [testScript], { cwd: __dirname, env: PY_ENV }, (err) => err ? rej(err) : res());
            });
        }

        console.log('[E2E] Importando sticker_estrella.png y pieza_fondo_blanco.jpg...');
        const starRes = await processImportFile(starPath, 300);
        const jpgRes = await processImportFile(jpgPath, 300);

        if (!starRes.meta || !starRes.meta.pieces || starRes.meta.pieces.length === 0) {
            throw new Error('Fallo al extraer silueta de sticker_estrella.png');
        }
        if (!jpgRes.meta || !jpgRes.meta.pieces || jpgRes.meta.pieces.length === 0) {
            throw new Error('Fallo al extraer silueta de pieza_fondo_blanco.jpg');
        }

        const starPiece = starRes.meta.pieces[0];
        const jpgPiece = jpgRes.meta.pieces[0];

        // Validaciones estrictas requeridas
        results.starVertices = starPiece.polygon.length;
        const starBboxArea = starPiece.bounds.width * starPiece.bounds.height;
        results.starAreaRatio = starPiece.area / starBboxArea;
        results.starHolesCount = (starPiece.holes || []).length;

        results.starVerified = (results.starVertices >= 10) &&
                               (results.starAreaRatio < 0.65) &&
                               (results.starHolesCount === 1);

        console.log(`[E2E] Silueta Estrella: ${results.starVertices} vértices, ratio área: ${(results.starAreaRatio * 100).toFixed(1)}%, huecos: ${results.starHolesCount} -> OK: ${results.starVerified}`);

        results.jpgVertices = jpgPiece.polygon.length;
        results.jpgVerified = (results.jpgVertices > 16);
        console.log(`[E2E] Silueta Círculo JPG: ${results.jpgVertices} vértices (No Cuadrado) -> OK: ${results.jpgVerified}`);

        if (!results.starVerified || !results.jpgVerified) {
            throw new Error(`Validación de silueta fallida: starVerified=${results.starVerified}, jpgVerified=${results.jpgVerified}`);
        }

        // 2. Ejecutar anidado True-Shape con 10 copias de ambas imágenes
        const testParts = [
            {
                id: 0,
                filename: 'sticker_estrella.png',
                source_path: starPiece.cropped_image_path || starPath,
                image_data_url: starPiece.image_data_url,
                quantity: 10,
                grain: 'free',
                polygon: starPiece.polygon.map(pt => ({ x: pt[0], y: pt[1] })),
                holes: (starPiece.holes || []).map(h => h.map(pt => ({ x: pt[0], y: pt[1] }))),
                bounds: starPiece.bounds,
                area: starPiece.area
            },
            {
                id: 1,
                filename: 'pieza_fondo_blanco.jpg',
                source_path: jpgPiece.cropped_image_path || jpgPath,
                image_data_url: jpgPiece.image_data_url,
                quantity: 10,
                grain: 'free',
                polygon: jpgPiece.polygon.map(pt => ({ x: pt[0], y: pt[1] })),
                holes: (jpgPiece.holes || []).map(h => h.map(pt => ({ x: pt[0], y: pt[1] }))),
                bounds: jpgPiece.bounds,
                area: jpgPiece.area
            }
        ];

        console.log('[E2E] Ejecutando anidado True-Shape con 20 piezas (10 copias c/u)...');
        const testRes = await uiWindow.webContents.executeJavaScript(`window.runSelfDiagnosticE2E(${JSON.stringify(testParts)})`);
        Object.assign(results, testRes);

        // 3. Prueba de exportación DXF y PDF con las piezas reales colocadas
        console.log('[E2E] Probando exportación DXF y PDF con geometría real...');
        const dummyJob = {
            sheet_width_mm: 1000.0,
            sheet_height_mm: 2000.0,
            bleed_mm: 2.0,
            mark_type: 'summa',
            placements: [
                {
                    id: 0,
                    source_path: starPiece.cropped_image_path || starPath,
                    rotation_deg: 0,
                    absolute_polygon_mm: starPiece.polygon,
                    absolute_holes_mm: starPiece.holes || []
                },
                {
                    id: 1,
                    source_path: jpgPiece.cropped_image_path || jpgPath,
                    rotation_deg: 90,
                    absolute_polygon_mm: jpgPiece.polygon,
                    absolute_holes_mm: []
                }
            ]
        };

        const testDxfPath = path.join(os.tmpdir(), 'e2e_test_cut.dxf');
        const testPdfPath = path.join(os.tmpdir(), 'e2e_test_imposition.pdf');

        const dxfRes = await executePythonExport(dummyJob, testDxfPath, 'dxf');
        results.dxfExportPassed = dxfRes.success && fs.existsSync(testDxfPath) && fs.statSync(testDxfPath).size > 100;

        const pdfRes = await executePythonExport(dummyJob, testPdfPath, 'pdf');
        results.pdfExportPassed = pdfRes.success && fs.existsSync(testPdfPath) && fs.statSync(testPdfPath).size > 100;

        results.passed = results.boot &&
                         results.gpuDetected &&
                         results.starVerified &&
                         results.jpgVerified &&
                         results.loadedBatch &&
                         results.generationsCount >= 5 &&
                         results.continuousRollModePassed &&
                         results.fixedSheetsModePassed &&
                         results.stopInstantPassed &&
                         results.dxfExportPassed &&
                         results.pdfExportPassed;

        fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf-8');
        console.log('[E2E RESULTADO]', JSON.stringify(results, null, 2));

    } catch (err) {
        console.error('[E2E ERROR]', err);
        results.error = String(err && err.stack || err);
        fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf-8');
    } finally {
        setTimeout(() => app.quit(), 1000);
    }
}

app.whenReady().then(createWindows);

app.on('window-all-closed', () => {
    if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
        powerSaveBlocker.stop(powerSaveId);
    }
    app.quit();
});
