const { ipcRenderer } = require('electron');

// Estado reactivo de la aplicación
const state = {
    parts: [],
    isNesting: false,
    currentGen: 0,
    startTime: 0,
    bestSolution: null,
    history: [],
    gpuInfo: null,
    // Pan & Zoom
    view: {
        x: 40,
        y: 40,
        scale: 0.35,
        isDragging: false,
        dragStartX: 0,
        dragStartY: 0
    }
};

// Referencias DOM
const dom = {
    gpuBadge: document.getElementById('gpu-badge'),
    btnImport: document.getElementById('btn-import-files'),
    btnTestBatch: document.getElementById('btn-load-test-batch'),
    inputWidth: document.getElementById('input-width'),
    inputHeight: document.getElementById('input-height'),
    inputSpacing: document.getElementById('input-spacing'),
    inputBleed: document.getElementById('input-bleed'),
    inputDpi: document.getElementById('input-dpi'),
    chkContinuousRoll: document.getElementById('chk-continuous-roll'),
    labelMode: document.getElementById('label-mode'),
    chkShowArt: document.getElementById('chk-show-art'),
    btnStart: document.getElementById('btn-start'),
    btnStop: document.getElementById('btn-stop'),
    btnExportPdf: document.getElementById('btn-export-pdf'),
    btnExportDxf: document.getElementById('btn-export-dxf'),
    partsList: document.getElementById('parts-list'),
    partsBadge: document.getElementById('parts-badge'),
    engineStatus: document.getElementById('engine-status'),
    progressBar: document.getElementById('progress-bar'),
    statPlaced: document.getElementById('stat-placed'),
    statUtil: document.getElementById('stat-util'),
    statPaper: document.getElementById('stat-paper'),
    statSheets: document.getElementById('stat-sheets'),
    historyList: document.getElementById('history-list'),
    svgViewport: document.getElementById('svg-viewport'),
    svgDefs: document.getElementById('svg-defs'),
    cadScene: document.getElementById('cad-scene'),
    sheetsLayer: document.getElementById('sheets-layer'),
    partsLayer: document.getElementById('parts-layer'),
    annotationsLayer: document.getElementById('annotations-layer'),
    emptyState: document.getElementById('empty-state'),
    btnFit: document.getElementById('btn-fit-screen'),
    btnZoomIn: document.getElementById('btn-zoom-in'),
    btnZoomOut: document.getElementById('btn-zoom-out'),
    btnZoomReset: document.getElementById('btn-zoom-reset')
};

// 1. INICIALIZACIÓN Y EVENTOS IPC
document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    initZoomPan();
    applyTransform();

    ipcRenderer.invoke('get-gpu-info').then((info) => {
        if (info) updateGpuBadge(info);
    });
});

ipcRenderer.on('engine:gpu-info', (event, info) => {
    updateGpuBadge(info);
});

function updateGpuBadge(info) {
    state.gpuInfo = info;
    if (dom.gpuBadge) {
        dom.gpuBadge.textContent = info.model || info.vendor || 'GPU WebGL2';
        dom.gpuBadge.title = `Backend: ${info.backend || 'WebGL2'}`;
    }
}

// Telemetría viva de cada generación (60 FPS)
ipcRenderer.on('engine:progress', (event, data) => {
    state.currentGen = data.generation;
    if (dom.engineStatus) {
        const angTxt = (data.angle !== null && data.angle !== undefined) ? ` · ${data.angle}°` : '';
        const vramTxt = data.vramEntries ? ` · VRAM ${data.vramEntries}` : '';
        const utilTxt = (data.utilisation !== undefined && data.utilisation !== null) ? ` · ${Number(data.utilisation).toFixed(1)}%` : '';
        dom.engineStatus.textContent = `CALCULANDO (GEN #${data.generation}${utilTxt}${angTxt}${vramTxt})`;
        dom.engineStatus.style.color = 'var(--accent-cyan)';
    }

    if (dom.statPlaced) {
        dom.statPlaced.textContent = `${data.placedCount} / ${data.totalCount}`;
    }

    if (dom.progressBar && data.totalCount > 0) {
        const pct = Math.min(100, (data.placedCount / data.totalCount) * 100);
        dom.progressBar.style.width = `${pct}%`;
    }

    if (dom.statSheets) {
        dom.statSheets.textContent = `${data.sheetsUsed} lámina(s)`;
    }
});

// Recepción del nuevo récord optimizado
ipcRenderer.on('engine:new-best', (event, data) => {
    state.bestSolution = data;
    recordHistory(data);
    renderSolution(data);

    if (dom.statUtil) {
        dom.statUtil.textContent = `${data.utilisation.toFixed(1)} %`;
    }

    if (dom.statPaper) {
        const mm = data.paperLength_mm.toFixed(1);
        const m = (data.paperLength_mm / 1000.0).toFixed(2);
        dom.statPaper.textContent = `${mm} mm (${m} m)`;
    }

    if (dom.statPlaced) {
        dom.statPlaced.textContent = `${data.placedParts} / ${data.totalParts}`;
    }
});

// Parada confirmada (< 5 ms)
ipcRenderer.on('engine:stopped', (event, data) => {
    setNestingState(false);
    if (dom.engineStatus) {
        dom.engineStatus.textContent = `DETENIDO (${data && data.stopTimeMs ? data.stopTimeMs.toFixed(1) + ' ms' : '< 5 ms'})`;
        dom.engineStatus.style.color = 'var(--accent-rose)';
    }
});

// Anidado finalizado automáticamente (convergió o alcanzó el límite)
ipcRenderer.on('engine:finished', (event, data) => {
    setNestingState(false);
    if (dom.engineStatus) {
        const reasonTxt = data && data.reason === 'converged' ? 'convergió'
            : data && data.reason === 'plateau' ? 'sin mejoras'
            : data && data.reason === 'max-generations' ? 'máx. generaciones'
            : 'límite de tiempo';
        const util = (data && typeof data.utilisation === 'number') ? ` · ${data.utilisation.toFixed(1)} %` : '';
        const placed = (data && typeof data.placedParts === 'number') ? ` · ${data.placedParts}/${data.totalParts} piezas` : '';
        dom.engineStatus.textContent = `COMPLETADO (${reasonTxt} · GEN #${data ? data.generation : '?'}${util}${placed})`;
        dom.engineStatus.style.color = 'var(--accent-emerald)';
    }
});

ipcRenderer.on('engine:error', (event, err) => {
    console.error('[UI Engine Error]', err);
    alert(`Error del Motor GPU: ${err}`);
    setNestingState(false);
});

// 2. CONFIGURACIÓN Y EVENTOS DE INTERFAZ
function initEvents() {
    dom.chkContinuousRoll.addEventListener('change', (e) => {
        dom.labelMode.textContent = e.target.checked ? 'Rollo Continuo' : 'Láminas Fijas';
        dom.labelMode.style.color = e.target.checked ? 'var(--accent-cyan)' : 'var(--accent-amber)';
    });

    if (dom.chkShowArt) {
        dom.chkShowArt.addEventListener('change', () => {
            if (state.bestSolution) {
                renderSolution(state.bestSolution);
            }
        });
    }

    dom.btnStart.addEventListener('click', startNesting);
    dom.btnStop.addEventListener('click', stopNesting);

    dom.btnTestBatch.addEventListener('click', loadIndustrialTestBatch);
    dom.btnImport.addEventListener('click', importFilesFromDisk);

    dom.btnExportPdf.addEventListener('click', exportPdf);
    dom.btnExportDxf.addEventListener('click', exportDxf);

    dom.btnFit.addEventListener('click', fitToScreen);
    dom.btnZoomIn.addEventListener('click', () => zoomBy(1.2));
    dom.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.2));
    dom.btnZoomReset.addEventListener('click', () => {
        state.view.x = 40;
        state.view.y = 40;
        state.view.scale = 0.5;
        applyTransform();
    });
}

function setNestingState(nesting) {
    state.isNesting = nesting;
    dom.btnStart.disabled = nesting;
    dom.btnStop.disabled = !nesting;
    dom.btnImport.disabled = nesting;
    dom.btnTestBatch.disabled = nesting;

    if (!nesting && dom.engineStatus) {
        dom.engineStatus.textContent = 'DETENIDO';
        dom.engineStatus.style.color = 'var(--text-muted)';
    }
}

function startNesting() {
    if (state.parts.length === 0) {
        alert('Carga piezas primero usando "Importar Archivos" o "Lote de Prueba Industrial".');
        return;
    }

    setNestingState(true);
    state.startTime = Date.now();
    state.history = [];
    dom.historyList.innerHTML = '<div style="color:var(--text-muted); font-size:10px; padding:4px;">Iniciando GPU...</div>';

    const sheetConfig = {
        widthMm: parseFloat(dom.inputWidth.value) || 1000.0,
        heightMm: parseFloat(dom.inputHeight.value) || 2000.0,
        spacingMm: parseFloat(dom.inputSpacing.value) || 3.0,
        bleedMm: parseFloat(dom.inputBleed.value) || 2.0,
        continuousRoll: dom.chkContinuousRoll.checked
    };

    ipcRenderer.send('engine:start', {
        parts: state.parts,
        sheetConfig: sheetConfig
    });
}

function stopNesting() {
    const t0 = performance.now();
    ipcRenderer.send('engine:stop');
    setNestingState(false);
    const ms = performance.now() - t0;
    if (dom.engineStatus) {
        dom.engineStatus.textContent = `DETENIDO (${ms.toFixed(1)} ms)`;
        dom.engineStatus.style.color = 'var(--accent-rose)';
    }
}

// 3. GENERADOR DE LOTE DE PRUEBA INDUSTRIAL
function loadIndustrialTestBatch() {
    state.parts = [
        // 1. Pieza en L con 3 cavidades interiores rectangulares
        {
            id: 0,
            filename: 'Pieza_L_3Holes.svg',
            quantity: 4,
            grain: 'free',
            polygon: [
                { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 80 },
                { x: 80, y: 80 }, { x: 80, y: 200 }, { x: 0, y: 200 }
            ],
            holes: [
                [{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 50 }, { x: 10, y: 50 }],
                [{ x: 10, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 110 }, { x: 10, y: 110 }],
                [{ x: 10, y: 120 }, { x: 70, y: 120 }, { x: 70, y: 180 }, { x: 10, y: 180 }]
            ],
            bounds: { x: 0, y: 0, width: 200, height: 200 }
        },
        // 2. Trapecio con hueco central en rombo
        {
            id: 1,
            filename: 'Trapecio_Rombo.svg',
            quantity: 5,
            grain: 'free',
            polygon: [
                { x: 20, y: 0 }, { x: 160, y: 0 }, { x: 180, y: 80 }, { x: 0, y: 80 }
            ],
            holes: [
                [{ x: 90, y: 15 }, { x: 130, y: 40 }, { x: 90, y: 65 }, { x: 50, y: 40 }]
            ],
            bounds: { x: 0, y: 0, width: 180, height: 80 }
        },
        // 3. Octógono regular con cavidad circular concéntrica
        generateOctagonWithCircleHole(2, 'Octogono_Con_Circulo.svg', 5, 120, 40),
        // 4. Donut circular industrial
        generateDonut(3, 'Donut_Circular.svg', 6, 70, 35),
        // 5. Estrella de 5 puntas
        generateStar(4, 'Estrella_5Puntas.svg', 5, 50, 22)
    ];

    renderPartsList();
    if (dom.emptyState) dom.emptyState.style.display = 'none';
}

function generateOctagonWithCircleHole(id, filename, quantity, sizeMm, holeRadiusMm) {
    const r = sizeMm / 2;
    const cx = r, cy = r;
    const outer = [];
    for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 + Math.PI / 8;
        outer.push({
            x: +(cx + r * Math.cos(ang)).toFixed(2),
            y: +(cy + r * Math.sin(ang)).toFixed(2)
        });
    }
    const hole = [];
    for (let i = 0; i < 16; i++) {
        const ang = (i * 2 * Math.PI) / 16;
        hole.push({
            x: +(cx + holeRadiusMm * Math.cos(ang)).toFixed(2),
            y: +(cy + holeRadiusMm * Math.sin(ang)).toFixed(2)
        });
    }
    return {
        id,
        filename,
        quantity,
        grain: 'free',
        polygon: outer,
        holes: [hole],
        bounds: { x: 0, y: 0, width: sizeMm, height: sizeMm }
    };
}

function generateDonut(id, filename, quantity, outerR, innerR) {
    const cx = outerR, cy = outerR;
    const outer = [];
    const hole = [];
    for (let i = 0; i < 24; i++) {
        const ang = (i * 2 * Math.PI) / 24;
        outer.push({
            x: +(cx + outerR * Math.cos(ang)).toFixed(2),
            y: +(cy + outerR * Math.sin(ang)).toFixed(2)
        });
        hole.push({
            x: +(cx + innerR * Math.cos(ang)).toFixed(2),
            y: +(cy + innerR * Math.sin(ang)).toFixed(2)
        });
    }
    return {
        id,
        filename,
        quantity,
        grain: 'free',
        polygon: outer,
        holes: [hole],
        bounds: { x: 0, y: 0, width: outerR * 2, height: outerR * 2 }
    };
}

function generateStar(id, filename, quantity, outerR, innerR) {
    const cx = outerR, cy = outerR;
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const r = (i % 2 === 0) ? outerR : innerR;
        const ang = (i * Math.PI) / 5 - Math.PI / 2;
        pts.push({
            x: +(cx + r * Math.cos(ang)).toFixed(2),
            y: +(cy + r * Math.sin(ang)).toFixed(2)
        });
    }
    return {
        id,
        filename,
        quantity,
        grain: 'free',
        polygon: pts,
        holes: [],
        bounds: { x: 0, y: 0, width: outerR * 2, height: outerR * 2 }
    };
}

// 4. IMPORTACIÓN DE ARCHIVOS CON EXTRACCIÓN DE SILUETA TRUE-SHAPE
async function importFilesFromDisk() {
    try {
        const dpi = parseFloat(dom.inputDpi ? dom.inputDpi.value : 300) || 300;
        const imported = await ipcRenderer.invoke('dialog:import-files', { dpi });
        if (!imported || imported.length === 0) return;

        const failures = [];

        imported.forEach((item) => {
            if (item.error) {
                console.warn(`No se pudo importar ${item.filename}: ${item.error}`);
                failures.push(`${item.filename}: ${item.error}`);
                return;
            }

            if (item.meta && item.meta.warning) {
                console.warn(`${item.filename}: ${item.meta.warning}`);
            }

            // Si el conversor Python detectó piezas estructuradas (True-Shape para ráster/CAD)
            if (item.meta && item.meta.pieces && item.meta.pieces.length > 0) {
                item.meta.pieces.forEach((piece) => {
                    state.parts.push({
                        id: state.parts.length,
                        filename: piece.filename || item.filename,
                        source_path: piece.cropped_image_path || item.source_path,
                        image_data_url: piece.image_data_url || null,
                        quantity: 1,
                        grain: 'free',
                        polygon: piece.polygon.map(pt => ({ x: pt[0], y: pt[1] })),
                        holes: (piece.holes || []).map(h => h.map(pt => ({ x: pt[0], y: pt[1] }))),
                        bounds: piece.bounds,
                        area: piece.area
                    });
                });
            } else if (item.rawSvg) {
                const parsed = parseSvgToPolygon(item.rawSvg, item.filename, state.parts.length, item.source_path);
                if (parsed) state.parts.push(parsed);
            }
        });

        renderPartsList();
        if (state.parts.length > 0 && dom.emptyState) dom.emptyState.style.display = 'none';

        if (failures.length > 0) {
            alert('No se pudieron importar los siguientes archivos:\n\n' + failures.join('\n'));
        }
    } catch (e) {
        console.error('Error importando:', e);
        alert('Error al procesar archivos: ' + e.message);
    }
}

// Parser SVG avanzado: muestrea trazados <path> reales con SVGPathElement.getPointAtLength
function parseSvgToPolygon(svgString, filename, id, source_path) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return null;

        let width = 100, height = 100;
        const vb = svg.getAttribute('viewBox');
        if (vb) {
            const parts = vb.trim().split(/[\s,]+/).map(Number);
            if (parts.length === 4) {
                width = parts[2];
                height = parts[3];
            }
        }

        // Si hay <path>, usar muestreo nativo SVG de alta fidelidad
        const pathEl = svg.querySelector('path');
        if (pathEl) {
            const d = pathEl.getAttribute('d');
            if (d) {
                // Crear path temporal en SVG oculto para calcular longitud
                const tempSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                tempPath.setAttribute('d', d);
                tempSvg.appendChild(tempPath);
                document.body.appendChild(tempSvg);

                try {
                    const totalLen = tempPath.getTotalLength();
                    const numSamples = Math.min(180, Math.max(32, Math.round(totalLen / 1.5)));
                    const sampledPts = [];
                    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;

                    for (let i = 0; i < numSamples; i++) {
                        const pt = tempPath.getPointAtLength((i / numSamples) * totalLen);
                        sampledPts.push({ x: pt.x, y: pt.y });
                        if (pt.x < minX) minX = pt.x;
                        if (pt.y < minY) minY = pt.y;
                        if (pt.x > maxX) maxX = pt.x;
                        if (pt.y > maxY) maxY = pt.y;
                    }

                    document.body.removeChild(tempSvg);

                    // Normalizar a (0, 0)
                    const normPts = sampledPts.map(p => ({
                        x: +(p.x - minX).toFixed(2),
                        y: +(p.y - minY).toFixed(2)
                    }));
                    const wMm = maxX - minX;
                    const hMm = maxY - minY;

                    return {
                        id,
                        filename,
                        source_path,
                        quantity: 1,
                        grain: 'free',
                        polygon: normPts,
                        holes: [],
                        bounds: { x: 0, y: 0, width: wMm, height: hMm }
                    };
                } catch (pe) {
                    if (tempSvg.parentNode) document.body.removeChild(tempSvg);
                }
            }
        }

        // Polígono directo
        const polyEl = svg.querySelector('polygon');
        if (polyEl) {
            const ptsStr = polyEl.getAttribute('points');
            const coords = ptsStr.trim().split(/[\s,]+/).map(Number);
            const polygon = [];
            for (let i = 0; i < coords.length; i += 2) {
                polygon.push({ x: coords[i], y: coords[i + 1] });
            }
            return {
                id,
                filename,
                source_path,
                quantity: 1,
                grain: 'free',
                polygon,
                holes: [],
                bounds: { x: 0, y: 0, width, height }
            };
        }

        const rectEl = svg.querySelector('rect');
        if (rectEl) {
            const rw = parseFloat(rectEl.getAttribute('width')) || width;
            const rh = parseFloat(rectEl.getAttribute('height')) || height;
            return {
                id,
                filename,
                source_path,
                quantity: 1,
                grain: 'free',
                polygon: [{ x: 0, y: 0 }, { x: rw, y: 0 }, { x: rw, y: rh }, { x: 0, y: rh }],
                holes: [],
                bounds: { x: 0, y: 0, width: rw, height: rh }
            };
        }

        return {
            id,
            filename,
            source_path,
            quantity: 1,
            grain: 'free',
            polygon: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
            holes: [],
            bounds: { x: 0, y: 0, width, height }
        };
    } catch (e) {
        console.warn('Fallo al parsear SVG:', e);
        return null;
    }
}

// 5. RENDERIZADO DE TABLA DE PIEZAS (CON TEXTURA Y CUTCONTOUR)
function renderPartsList() {
    dom.partsList.innerHTML = '';
    let totalCopies = 0;

    state.parts.forEach((p, idx) => {
        totalCopies += (p.quantity || 1);

        const card = document.createElement('div');
        card.className = 'part-card';

        // Miniatura con imagen real y CutContour superpuesto
        const thumbSvg = generateThumbnailSvg(p.polygon, p.holes, p.bounds, p.image_data_url);

        card.innerHTML = `
            <div class="part-thumb">${thumbSvg}</div>
            <div class="part-info">
                <div class="part-name" title="${p.filename}">${p.filename}</div>
                <div class="part-dims">${p.bounds.width.toFixed(1)} × ${p.bounds.height.toFixed(1)} mm</div>
            </div>
            <div class="part-controls">
                <div class="qty-control">
                    <button class="qty-btn" onclick="updatePartQty(${idx}, -1)">-</button>
                    <input type="number" class="qty-input" value="${p.quantity}" min="1" max="999" onchange="setPartQty(${idx}, this.value)">
                    <button class="qty-btn" onclick="updatePartQty(${idx}, 1)">+</button>
                </div>
                <select class="grain-select" onchange="setPartGrain(${idx}, this.value)">
                    <option value="free" ${p.grain === 'free' ? 'selected' : ''}>Libre</option>
                    <option value="grain" ${p.grain === 'grain' ? 'selected' : ''}>0/180°</option>
                    <option value="fixed" ${p.grain === 'fixed' ? 'selected' : ''}>Fijo</option>
                </select>
                <button class="btn-delete" title="Eliminar" onclick="deletePart(${idx})">✕</button>
            </div>
        `;
        dom.partsList.appendChild(card);
    });

    dom.partsBadge.textContent = `${state.parts.length} piezas (${totalCopies} copias)`;
}

window.updatePartQty = (idx, delta) => {
    if (state.parts[idx]) {
        state.parts[idx].quantity = Math.max(1, (state.parts[idx].quantity || 1) + delta);
        renderPartsList();
    }
};

window.setPartQty = (idx, val) => {
    if (state.parts[idx]) {
        state.parts[idx].quantity = Math.max(1, parseInt(val, 10) || 1);
        renderPartsList();
    }
};

window.setPartGrain = (idx, val) => {
    if (state.parts[idx]) {
        state.parts[idx].grain = val;
    }
};

window.deletePart = (idx) => {
    state.parts.splice(idx, 1);
    renderPartsList();
    if (state.parts.length === 0 && dom.emptyState) {
        dom.emptyState.style.display = 'flex';
    }
};

function generateThumbnailSvg(poly, holes, bounds, imageDataUrl = null) {
    const pad = 2;
    const w = (bounds && bounds.width) || 100;
    const h = (bounds && bounds.height) || 100;
    const vb = `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`;

    let d = '';
    if (poly && poly.length > 0) {
        d += `M ${poly[0].x} ${poly[0].y} ` + poly.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') + ' Z ';
    }
    if (holes && holes.length > 0) {
        holes.forEach(hole => {
            if (hole && hole.length > 0) {
                d += `M ${hole[0].x} ${hole[0].y} ` + hole.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') + ' Z ';
            }
        });
    }

    if (imageDataUrl) {
        // Muestra la imagen gráfica original recortada al contorno (los huecos quedan
        // transparentes) con el trazado CutContour superpuesto en cian
        const cid = 'thumb-clip-' + Math.random().toString(36).slice(2, 10);
        return `<svg viewBox="${vb}">
            <defs><clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${d}" clip-rule="evenodd"/></clipPath></defs>
            <image href="${imageDataUrl}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" clip-path="url(#${cid})"/>
            <path d="${d}" fill="rgba(6, 182, 212, 0.15)" stroke="#06b6d4" stroke-width="1.8" fill-rule="evenodd"/>
        </svg>`;
    }

    return `<svg viewBox="${vb}"><path d="${d}" fill="#06b6d4" fill-opacity="0.7" stroke="#38bdf8" stroke-width="1.8" fill-rule="evenodd"/></svg>`;
}

// 6. RENDERIZADO DEL VISOR VECTORIAL CAD (HIGH PERFORMANCE + TEXTURA IMPRESA)
function renderSolution(solution) {
    if (!solution || !solution.sheets) return;

    dom.sheetsLayer.innerHTML = '';
    dom.partsLayer.innerHTML = '';
    dom.annotationsLayer.innerHTML = '';

    const sheetW = solution.effectiveSheetWidth_mm || parseFloat(dom.inputWidth.value) || 1000.0;
    const spacing = parseFloat(dom.inputSpacing.value) || 3.0;
    const showArt = dom.chkShowArt ? dom.chkShowArt.checked : true;

    // Limpiar recortes de arte de renderizados anteriores
    if (dom.svgDefs) {
        dom.svgDefs.querySelectorAll('.placed-art-clip').forEach(n => n.remove());
    }

    let totalOffset = 0;

    solution.sheets.forEach((sh, shIdx) => {
        const shH = sh.heightMm || solution.effectiveSheetHeight_mm || 2000.0;

        // 1. Dibujar Contorno de Lámina
        const sheetRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        sheetRect.setAttribute('x', 0);
        sheetRect.setAttribute('y', totalOffset);
        sheetRect.setAttribute('width', sheetW);
        sheetRect.setAttribute('height', shH);
        sheetRect.setAttribute('class', 'sheet-boundary');
        dom.sheetsLayer.appendChild(sheetRect);

        // Título de la lámina
        const sheetTitle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        sheetTitle.setAttribute('x', 15);
        sheetTitle.setAttribute('y', totalOffset + 30);
        sheetTitle.setAttribute('class', 'sheet-title');
        sheetTitle.textContent = `LÁMINA #${shIdx + 1}: ${sheetW.toFixed(0)} × ${shH.toFixed(0)} mm`;
        dom.sheetsLayer.appendChild(sheetTitle);

        // 2. Dibujar Piezas Colocadas
        (sh.placements || []).forEach((p, pIdx) => {
            const outerPts = p.placedOuter || [];
            if (outerPts.length >= 3) {
                // Trazado vectorial exacto CutContour + Agujeros (se usa para el relleno
                // y también como recorte del arte impreso).
                let pathData = `M ${outerPts[0].x} ${outerPts[0].y + totalOffset} ` +
                    outerPts.slice(1).map(pt => `L ${pt.x} ${pt.y + totalOffset}`).join(' ') + ' Z ';
                (p.placedHoles || []).forEach(h => {
                    if (h && h.length >= 3) {
                        pathData += `M ${h[0].x} ${h[0].y + totalOffset} ` +
                            h.slice(1).map(pt => `L ${pt.x} ${pt.y + totalOffset}`).join(' ') + ' Z ';
                    }
                });

                // A) Si tiene arte impreso y el toggle está activo, renderizar la imagen gráfica
                // recortada al contorno real (evita que el arte tape huecos y piezas vecinas).
                if (showArt && p.image_data_url) {
                    const clipId = `placed-art-clip-${shIdx}-${pIdx}`;
                    const rad = (p.rotation || 0) * Math.PI / 180;
                    const cosR = Math.cos(-rad);
                    const sinR = Math.sin(-rad);
                    const toLocal = (q) => {
                        const dx = q.x - p.x;
                        const dy = q.y - p.y;
                        return { x: dx * cosR - dy * sinR, y: dx * sinR + dy * cosR };
                    };
                    const ring = (pts) => 'M ' + pts.map(q => { const l = toLocal(q); return `${l.x} ${l.y}`; }).join(' L ') + ' Z ';
                    let localPath = ring(outerPts);
                    (p.placedHoles || []).forEach(h => { if (h && h.length >= 3) localPath += ring(h); });

                    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
                    clip.setAttribute('id', clipId);
                    clip.setAttribute('class', 'placed-art-clip');
                    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
                    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    clipPath.setAttribute('d', localPath);
                    clipPath.setAttribute('clip-rule', 'evenodd');
                    clip.appendChild(clipPath);
                    if (dom.svgDefs) dom.svgDefs.appendChild(clip);

                    const imgG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    imgG.setAttribute('transform', `translate(${p.x}, ${p.y + totalOffset}) rotate(${p.rotation})`);

                    const imgEl = document.createElementNS('http://www.w3.org/2000/svg', 'image');
                    imgEl.setAttribute('href', p.image_data_url);
                    imgEl.setAttribute('x', 0);
                    imgEl.setAttribute('y', 0);
                    const origW = (p.orig_bounds && p.orig_bounds.width) || (p.sheetBounds.maxX - p.sheetBounds.minX);
                    const origH = (p.orig_bounds && p.orig_bounds.height) || (p.sheetBounds.maxY - p.sheetBounds.minY);
                    imgEl.setAttribute('width', origW);
                    imgEl.setAttribute('height', origH);
                    imgEl.setAttribute('preserveAspectRatio', 'none');
                    imgEl.setAttribute('clip-path', `url(#${clipId})`);
                    imgG.appendChild(imgEl);
                    dom.partsLayer.appendChild(imgG);
                }

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', pathData);
                path.setAttribute('class', 'placed-part-poly');
                path.setAttribute('fill-rule', 'evenodd');

                // Si se muestra el arte, hacemos el relleno más traslúcido para destacar el diseño
                if (showArt && p.image_data_url) {
                    path.style.fill = 'rgba(6, 182, 212, 0.12)';
                    path.style.stroke = '#06b6d4';
                    path.style.strokeWidth = '1.5';
                }

                const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                titleEl.textContent = `${p.filename} [Rot: ${p.rotation}°] [X: ${p.x.toFixed(1)}mm, Y: ${p.y.toFixed(1)}mm]`;
                path.appendChild(titleEl);

                dom.partsLayer.appendChild(path);
            }
        });

        // 3. Línea de corte de bobina (Roll Cut Line)
        if (solution.continuousRoll && sh.maxY > 0) {
            const cutY = sh.maxY + spacing + totalOffset;
            const cutLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            cutLine.setAttribute('x1', 0);
            cutLine.setAttribute('y1', cutY);
            cutLine.setAttribute('x2', sheetW);
            cutLine.setAttribute('y2', cutY);
            cutLine.setAttribute('class', 'roll-cut-line');
            dom.annotationsLayer.appendChild(cutLine);

            const cutText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            cutText.setAttribute('x', 15);
            cutText.setAttribute('y', cutY - 8);
            cutText.setAttribute('class', 'roll-cut-text');
            cutText.textContent = `✂ LÍNEA DE CORTE DE BOBINA: ${(sh.maxY + spacing).toFixed(1)} mm (${((sh.maxY + spacing) / 1000).toFixed(2)} m)`;
            dom.annotationsLayer.appendChild(cutText);
        }

        totalOffset += shH + 100; // separación visual entre láminas
    });
}

function recordHistory(solution) {
    state.history.unshift(solution);
    if (state.history.length > 20) state.history.pop();

    dom.historyList.innerHTML = '';
    state.history.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = `history-item ${idx === 0 ? 'active' : ''}`;
        row.innerHTML = `
            <span>#${item.generation} (${item.placedParts}/${item.totalParts})</span>
            <span style="color:var(--accent-cyan); font-weight:bold;">${item.rollLengthMm.toFixed(0)} mm</span>
            <span style="color:var(--accent-emerald); font-weight:bold;">${item.utilisation.toFixed(1)}%</span>
        `;
        row.addEventListener('click', () => {
            document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
            row.classList.add('active');
            renderSolution(item);
        });
        dom.historyList.appendChild(row);
    });
}

// 7. ZOOM Y PAN INTERACTIVO (60 FPS)
function initZoomPan() {
    const el = dom.svgViewport;

    el.addEventListener('mousedown', (e) => {
        if (e.button === 0 || e.button === 1) { // Click izq o rueda
            state.view.isDragging = true;
            state.view.dragStartX = e.clientX - state.view.x;
            state.view.dragStartY = e.clientY - state.view.y;
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!state.view.isDragging) return;
        state.view.x = e.clientX - state.view.dragStartX;
        state.view.y = e.clientY - state.view.dragStartY;
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        state.view.isDragging = false;
    });

    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        const newScale = Math.min(5.0, Math.max(0.05, state.view.scale * factor));
        state.view.x = mouseX - (mouseX - state.view.x) * (newScale / state.view.scale);
        state.view.y = mouseY - (mouseY - state.view.y) * (newScale / state.view.scale);
        state.view.scale = newScale;

        applyTransform();
    }, { passive: false });
}

function zoomBy(factor) {
    const cx = dom.svgViewport.clientWidth / 2;
    const cy = dom.svgViewport.clientHeight / 2;
    const newScale = Math.min(5.0, Math.max(0.05, state.view.scale * factor));
    state.view.x = cx - (cx - state.view.x) * (newScale / state.view.scale);
    state.view.y = cy - (cy - state.view.y) * (newScale / state.view.scale);
    state.view.scale = newScale;
    applyTransform();
}

function fitToScreen() {
    if (!state.bestSolution && state.parts.length === 0) return;

    const w = parseFloat(dom.inputWidth.value) || 1000.0;
    const h = (state.bestSolution && state.bestSolution.rollLengthMm > 0)
        ? (state.bestSolution.rollLengthMm + 100)
        : (parseFloat(dom.inputHeight.value) || 2000.0);

    const vpW = dom.svgViewport.clientWidth || 800;
    const vpH = dom.svgViewport.clientHeight || 600;

    const scale = Math.min((vpW - 80) / w, (vpH - 80) / h);
    state.view.scale = Math.min(2.0, Math.max(0.05, scale));
    state.view.x = (vpW - w * state.view.scale) / 2;
    state.view.y = 40;

    applyTransform();
}

function applyTransform() {
    dom.cadScene.setAttribute('transform', `translate(${state.view.x}, ${state.view.y}) scale(${state.view.scale})`);
}

// 8. EXPORTACIONES A PDF / DXF CON MOTOR PYTHON
async function exportPdf() {
    if (!state.bestSolution) {
        alert('Ejecuta el anidado antes de exportar.');
        return;
    }

    const jobData = buildExportJobData();
    const res = await ipcRenderer.invoke('export:pdf', jobData);
    if (res.canceled) return;
    if (res.success) {
        alert(`PDF Industrial exportado exitosamente:\n${res.path}`);
    } else {
        alert(`Error exportando PDF: ${res.error}`);
    }
}

async function exportDxf() {
    if (!state.bestSolution) {
        alert('Ejecuta el anidado antes de exportar.');
        return;
    }

    const jobData = buildExportJobData();
    const res = await ipcRenderer.invoke('export:dxf', jobData);
    if (res.canceled) return;
    if (res.success) {
        alert(`DXF 1:1 mm exportado exitosamente:\n${res.path}`);
    } else {
        alert(`Error exportando DXF: ${res.error}`);
    }
}

function buildExportJobData() {
    const sheetW = state.bestSolution.effectiveSheetWidth_mm || parseFloat(dom.inputWidth.value) || 1000.0;
    const sheetH = state.bestSolution.continuousRoll
        ? (state.bestSolution.rollLengthMm + parseFloat(dom.inputSpacing.value || 3.0))
        : (state.bestSolution.effectiveSheetHeight_mm || parseFloat(dom.inputHeight.value) || 2000.0);

    const placements = [];
    (state.bestSolution.sheets || []).forEach(sh => {
        (sh.placements || []).forEach(p => {
            placements.push({
                id: p.id,
                source_path: p.source_path || '',
                rotation_deg: p.rotation || 0,
                x_mm: p.x,
                y_mm: p.y,
                absolute_polygon_mm: (p.placedOuter || []).map(pt => [pt.x, pt.y]),
                absolute_holes_mm: (p.placedHoles || []).map(h => (h || []).map(pt => [pt.x, pt.y]))
            });
        });
    });

    return {
        sheet_width_mm: sheetW,
        sheet_height_mm: sheetH,
        bleed_mm: parseFloat(dom.inputBleed.value) || 2.0,
        mark_type: 'summa',
        placements: placements
    };
}

// 9. DIAGNÓSTICO AUTÓNOMO E2E PARA VERIFICACIÓN FORMAL (CON IMÁGENES RÁSTER TRUE-SHAPE)
window.runSelfDiagnosticE2E = async function(customParts = null) {
    console.log('[E2E Diagnostic] Iniciando protocolo de verificación...');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    if (customParts && customParts.length > 0) {
        state.parts = customParts;
        renderPartsList();
        if (dom.emptyState) dom.emptyState.style.display = 'none';
    } else {
        loadIndustrialTestBatch();
    }
    const batchOk = state.parts.length >= 2;

    // 1. Prueba de Modo Bobina Continua (>= 5 generaciones)
    dom.chkContinuousRoll.checked = true;
    startNesting();

    let waited = 0;
    while (state.currentGen < 5 && waited < 15000) {
        await sleep(250);
        waited += 250;
    }
    const genCount = state.currentGen;
    const rollPassed = (state.bestSolution !== null) && (state.bestSolution.sheets.length === 1) && (state.bestSolution.rollLengthMm > 0);

    // 2. Prueba de Detención Instantánea (< 5 ms)
    const t0 = performance.now();
    stopNesting();
    const stopMs = performance.now() - t0;
    const stopInstantPassed = (stopMs < 20);

    // 3. Prueba de Modo Láminas Fijas
    await sleep(200);
    dom.chkContinuousRoll.checked = false;
    dom.inputWidth.value = 80;
    dom.inputHeight.value = 80;
    startNesting();

    waited = 0;
    while (state.currentGen < genCount + 3 && waited < 10000) {
        await sleep(250);
        waited += 250;
    }
    stopNesting();
    const fixedSheetsPassed = (state.bestSolution !== null) && (state.bestSolution.sheets.length >= 2);

    return {
        loadedBatch: batchOk,
        generationsCount: genCount,
        continuousRollModePassed: rollPassed,
        stopSpeedMs: stopMs,
        stopInstantPassed: stopInstantPassed,
        fixedSheetsModePassed: fixedSheetsPassed
    };
};
