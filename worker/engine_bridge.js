const { ipcRenderer } = require('electron');
const path = require('path');
const { CoreNestingEngine } = require('../engine/core_nesting_engine.js');

let currentEngine = null;

// Detección directa de WebGL2 en el contexto del Worker
function getGpuDeviceInfo() {
    try {
        const canvas = document.getElementById('gpu-canvas') || document.createElement('canvas');
        const gl = canvas.getContext('webgl2', { antialias: false, depth: false }) || canvas.getContext('webgl');
        if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'WebGL2 Generic';
            const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'GPU';
            return {
                vendor,
                renderer,
                model: renderer,
                webgl2: true,
                backend: 'Intel Arc D3D11 / WebGL2 Compute'
            };
        }
    } catch (e) {
        console.warn('[GPU Worker] Error al consultar WebGL2:', e);
    }
    return {
        vendor: 'CPU',
        renderer: 'CPU Fallback',
        model: 'Procesador Principal',
        webgl2: false,
        backend: 'cpu'
    };
}

const gpuInfo = getGpuDeviceInfo();
const statusEl = document.getElementById('worker-status');
if (statusEl) {
    statusEl.textContent = `GPU Ready: ${gpuInfo.model}`;
}

console.log('[GPU Worker] Inicializado con hardware:', gpuInfo);
ipcRenderer.send('engine:ready', gpuInfo);

ipcRenderer.on('engine:get-info', (event) => {
    event.reply('engine:info', gpuInfo);
});

// Inicio del anidado desde la UI
ipcRenderer.on('engine:start', async (event, payload) => {
    console.log('[GPU Worker] Recibido engine:start', payload ? {
        partCount: (payload.parts || []).length,
        sheetConfig: payload.sheetConfig
    } : null);

    if (currentEngine) {
        currentEngine.stop();
        currentEngine = null;
    }

    currentEngine = new CoreNestingEngine({
        pixelSizeMm: 0.5
    });

    currentEngine.on('progress', (data) => {
        ipcRenderer.send('engine:progress', {
            generation: data.generation,
            generationsCompleted: data.generationsCompleted,
            elapsedMs: data.elapsedMs,
            bestRollLengthMm: data.bestRollLengthMm,
            sheetsUsed: data.sheetsUsed,
            placedCount: data.placedCount,
            totalCount: data.totalCount,
            utilisation: data.utilisation,
            fitness: data.currentFitness,
            bestFitness: data.bestFitness,
            isNewBest: data.isNewBest,
            inProgress: data.inProgress,
            vramEntries: data.vramEntries,
            vramMB: data.vramMB,
            angle: data.angle
        });
    });

    currentEngine.on('best_placement_found', (data) => {
        ipcRenderer.send('engine:new-best', {
            generation: data.generation,
            fitness: data.fitness,
            utilisation: data.utilisation,
            totalParts: data.totalParts,
            placedParts: data.placedParts,
            unplacedParts: data.unplacedParts,
            effectiveSheetWidth_mm: data.effectiveSheetWidth_mm,
            effectiveSheetHeight_mm: data.effectiveSheetHeight_mm,
            sheetsUsed: data.sheetsUsed,
            paperLength_mm: data.paperLength_mm,
            rollLengthMm: data.rollLengthMm,
            continuousRoll: data.continuousRoll,
            elapsedMs: data.elapsedMs,
            sheets: data.sheets
        });
    });

    currentEngine.on('error', (err) => {
        console.error('[GPU Worker] Error en motor:', err);
        ipcRenderer.send('engine:error', String(err && err.message ? err.message : err));
    });

    currentEngine.on('finished', (data) => {
        console.log('[GPU Worker] Anidado finalizado:', data && data.reason);
        ipcRenderer.send('engine:finished', data || {});
    });

    try {
        await currentEngine.start(payload.parts, payload.sheetConfig);
    } catch (e) {
        console.error('[GPU Worker] Error fatal al arrancar:', e);
        ipcRenderer.send('engine:error', String(e && e.message ? e.message : e));
    }
});

// Parada inmediata (< 5 ms)
ipcRenderer.on('engine:stop', () => {
    const t0 = performance.now();
    if (currentEngine) {
        currentEngine.stop();
    }
    const elapsed = performance.now() - t0;
    console.log(`[GPU Worker] Motor detenido en ${elapsed.toFixed(2)} ms.`);
    ipcRenderer.send('engine:stopped', { stopTimeMs: elapsed });
});
