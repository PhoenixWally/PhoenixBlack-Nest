/**
 * Next-Gen Core Nesting Engine - PhoenixBlackNest (Pure Millimeter Dedicated Architecture)
 * Orquestador MetaheurÃ­stico AsÃ­ncrono no-bloqueante para Worker GPU.
 * 
 * 100% en milÃ­metros reales puros (mm) de principio a fin (sin conversiones a puntos PostScript).
 * True Shape Nesting con Hole Nesting (anidado en cavidades interiores),
 * rotaciÃ³n estricta, Shoelace Formula para utilizaciÃ³n neta, auditorÃ­a de Cero Solapamientos (0.0000 mmÂ²),
 * modo Bobina Continua (rollo infinito con corte dinÃ¡mico) y modo LÃ¡minas Fijas (multi-pliego).
 */

const { EventEmitter } = require('events');
const { UniversalGpuNestingEngine } = require('./universal_gpu_engine.js');

class CoreNestingEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.working = false;
        this.aborted = false;
        this.gpuEngine = new UniversalGpuNestingEngine(options);
        this.generationCount = 0;
        this.generationsCompleted = 0;
        this.bestFitness = 1e15;
        this.bestOrder = null;
        this.bestAngles = null;
        this.bestAngleById = new Map();
        this.bestResult = null;
        this.currentPlacements = [];
        this.timer = null;
        this.startTime = 0;
        this.maxRollGrowths = 8;
        this.seed = (options.seed !== undefined && options.seed !== null)
            ? (parseInt(options.seed, 10) | 0)
            : ((Date.now() ^ 0x9E3779B9) | 0);
        this._rngState = this.seed >>> 0;
        this._prof = { calls: 0, total: 0, batch: 0, refine: 0, grid: 0 };

        // El motor es de BUCLE CONTINUO: no se auto-detiene. SÃ³lo para por engine:stop().
        // (valores conservados por compatibilidad de API; no disparan parada automÃ¡tica)
        this.maxGenerations = options.maxGenerations || 200;
        this.maxDurationMs = options.maxDurationMs || 60000;
        this.plateauGenerations = options.plateauGenerations || 15;
        this.noImproveGenerations = 0;
        this.completed = false;
        this.finishReason = null;
    }

    /** PRNG determinista (mulberry32): la misma semilla reproduce la misma ejecucion. */
    _rand() {
        let t = (this._rngState = (this._rngState + 0x6D2B79F5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * Inicia el proceso de anidado industrial asÃ­ncrono
     * @param {Array} rawParts - Lista de partes [{ id, filename, quantity, grain, polygon, holes, bounds, source_path }]
     * @param {Object} sheetConfig - ConfiguraciÃ³n de material en mm { widthMm, heightMm, spacingMm, bleedMm, continuousRoll }
     */
    async start(rawParts, sheetConfig = {}) {
        if (this.working) return;
        this.working = true;
        this.aborted = false;
        this.generationCount = 0;
        this.generationsCompleted = 0;
        this.bestFitness = 1e15;
        this.bestOrder = null;
        this.bestAngles = null;
        this.bestAngleById = new Map();
        this.bestResult = null;
        this.currentPlacements = [];
        this.startTime = Date.now();
        this.noImproveGenerations = 0;
        this.completed = false;
        this.finishReason = null;

        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.gpuEngine && this.gpuEngine.clearCaches) this.gpuEngine.clearCaches();

        const continuousRoll = (typeof sheetConfig.continuousRoll === 'boolean') ? sheetConfig.continuousRoll : true;
        this.continuousRoll = continuousRoll;
        // CuantÃ­a angular: 1 = grados reales (360), 15 = restringido a mÃºltiplos de 15 (para A/B).
        this.angleQuantum = Math.max(1, parseInt(sheetConfig.angleQuantum || 1, 10));

        const sheetWidthMm = parseFloat(sheetConfig.widthMm || sheetConfig.sheetWidthMm || 1000.0);
        const sheetHeightMm = parseFloat(sheetConfig.heightMm || sheetConfig.sheetHeightMm || 2000.0);
        const spacingMm = parseFloat(sheetConfig.spacingMm !== undefined ? sheetConfig.spacingMm : (sheetConfig.spacing || 3.0));
        const bleedMm = parseFloat(sheetConfig.bleedMm !== undefined ? sheetConfig.bleedMm : (sheetConfig.bleed || 0.0));

        // Filtrar piezas (excluir si alguna viene marcada como sheet)
        const partsToPlace = [];
        let idCounter = 0;

        (rawParts || []).forEach((p, srcIndex) => {
            if (p.sheet) return;

            const qty = Math.max(1, parseInt(p.quantity || 1, 10));
            const grain = p.grain || 'free'; // 'free', 'grain' (0/180), 'fixed' (0)

            // PolÃ­gono exterior en milÃ­metros reales
            const cleanPolygon = (p.polygon || p.polygontree || []).map(pt => ({
                x: parseFloat(pt.x || 0),
                y: parseFloat(pt.y || 0)
            }));

            // Cavidades interiores (Holes) en milÃ­metros reales
            const cleanHoles = [];
            const rawHoles = p.holes || (p.polygontree && p.polygontree.children) || [];
            if (rawHoles && rawHoles.length > 0) {
                rawHoles.forEach(h => {
                    const holePts = (h || []).map(pt => ({
                        x: parseFloat(pt.x || 0),
                        y: parseFloat(pt.y || 0)
                    }));
                    if (holePts.length >= 3) {
                        cleanHoles.push(holePts);
                    }
                });
            }

            // ValidaciÃ³n de huecos dentro del polÃ­gono exterior
            if (cleanHoles.length > 0 && this.gpuEngine && typeof this.gpuEngine.isPolygonInsidePolygon === 'function') {
                const validHoles = [];
                cleanHoles.forEach(h => {
                    if (this.gpuEngine.isPolygonInsidePolygon(h, cleanPolygon, 0)) {
                        validHoles.push(h);
                    } else {
                        console.warn('[CoreNestingEngine] Hueco descartado por no estar contenido en el contorno exterior.');
                    }
                });
                cleanHoles.length = 0;
                Array.prototype.push.apply(cleanHoles, validHoles);
            }

            // CÃ¡lculo exacto del Ã¡rea neta (FÃ³rmula de Gauss descontando cavidades)
            const netArea = this.calculateNetPolygonArea(cleanPolygon, cleanHoles);

            // Bounding box en mm
            let boundsMm = p.bounds;
            if (!boundsMm || boundsMm.width === undefined) {
                const b = this.gpuEngine.getPolygonBounds(cleanPolygon);
                boundsMm = {
                    x: b.minX,
                    y: b.minY,
                    width: Math.max(1, b.maxX - b.minX),
                    height: Math.max(1, b.maxY - b.minY)
                };
            }

            for (let q = 0; q < qty; q++) {
                partsToPlace.push({
                    id: idCounter++,
                    source: srcIndex,
                    filename: p.filename || `Pieza_${srcIndex + 1}`,
                    source_path: p.source_path || '',
                    image_data_url: p.image_data_url || '',
                    grain: grain,
                    polygon: cleanPolygon,
                    holes: cleanHoles,
                    bounds: boundsMm,
                    area: netArea
                });
            }
        });

        if (partsToPlace.length === 0) {
            this.emit('error', 'No hay piezas vÃ¡lidas para anidar.');
            this.stop();
            return;
        }

        // Orden inicial First-Fit Decreasing por Ã¡rea real
        partsToPlace.sort((a, b) => b.area - a.area);

        console.log(`[CoreNestingEngine GPU] Arrancando anidado de ${partsToPlace.length} piezas en bobina ${sheetWidthMm}x${sheetHeightMm} mm (spacing: ${spacingMm}mm, bleed: ${bleedMm}mm, continuousRoll: ${continuousRoll})`);

        await new Promise(resolve => setTimeout(resolve, 10));
        if (!this.working || this.aborted) return;

        this.runOptimizationLoop(partsToPlace, sheetWidthMm, sheetHeightMm, spacingMm, bleedMm, sheetConfig);
    }

    runOptimizationLoop(partsToPlace, sheetW, sheetH, spacing, bleed, config) {
        if (!this.working || this.aborted) return;

        const scheduleNext = () => {
            if (!this.working || this.aborted) return;
            this.timerId = setTimeout(executeGeneration, 4);
        };

        const _legacyBuildCandidate = (gen) => {
            const forcedAngles = {};
            let order;

            if (gen === 0) {
                order = [...partsToPlace]; // FFD Ã¡rea desc
            } else if (gen === 1) {
                order = [...partsToPlace].sort((a, b) => ((b.bounds && b.bounds.height) || 0) - ((a.bounds && a.bounds.height) || 0));
                // Acostar piezas anchas si grain es 'free'
                partsToPlace.forEach(part => {
                    if (part.grain !== 'free') return;
                    const bb = part.bounds;
                    if (bb && bb.width > bb.height) {
                        forcedAngles[part.id] = 90;
                    }
                });
            } else if (gen === 2) {
                order = [...partsToPlace].sort((a, b) => ((b.bounds && b.bounds.width) || 0) - ((a.bounds && a.bounds.width) || 0));
            } else if (gen === 3) {
                order = [...partsToPlace].sort((a, b) => {
                    const pa = (a.bounds && (a.bounds.width + a.bounds.height)) || 0;
                    const pb = (b.bounds && (b.bounds.width + b.bounds.height)) || 0;
                    return pb - pa;
                });
            } else {
                const base = this.bestOrder ? [...this.bestOrder] : [...partsToPlace];
                const n = base.length;

                // === TAIL-FIRST PROMOTION ===
                // Si el mejor layout usa 2+ hojas, las piezas de la ÃšLTIMA lÃ¡mina son las que
                // provocaron abrir una hoja extra: se promocionan al frente del genoma para que
                // intenten encajar en las hojas previas y se consolide todo en una sola tirada.
                if (this.bestResult && this.bestResult.sheets && this.bestResult.sheets.length > 1 && n >= 2) {
                    const lastSheet = this.bestResult.sheets[this.bestResult.sheets.length - 1];
                    const tailIds = new Set((lastSheet.placements || []).map(p => p.id));
                    if (tailIds.size >= 1 && tailIds.size <= 8) {
                        const tailParts = base.filter(p => tailIds.has(p.id));
                        const rest = base.filter(p => !tailIds.has(p.id));
                        base.length = 0;
                        base.push(...tailParts, ...rest);
                    }
                }

                // Mover pieza mÃ¡s profunda (maxY) al inicio para que busque huecos superiores
                if (this.bestResult && this.bestResult.sheets && this.bestResult.sheets.length > 0 && n >= 2) {
                    let deepestId = null, deepestY = -Infinity;
                    this.bestResult.sheets.forEach(sh => {
                        (sh.placements || []).forEach(p => {
                            const my = p.sheetBounds ? p.sheetBounds.maxY : 0;
                            if (my > deepestY) { deepestY = my; deepestId = p.id; }
                        });
                    });
                    if (deepestId !== null) {
                        const idx = base.findIndex(p => p.id === deepestId);
                        if (idx > 0) {
                            const moved = base.splice(idx, 1)[0];
                            base.unshift(moved);
                        }
                    }
                }

                // MutaciÃ³n de permutaciÃ³n: 1-3 swaps/inserciones (normal) o HYPER-MUTATION (estancado)
                const stagnant = this.noImproveGenerations >= 4;
                if (n >= 2) {
                    if (stagnant) {
                        // Sacudida fuerte: mezcla 35% del orden + inversiones de pares adyacentes
                        const kick = Math.max(2, Math.ceil(n * 0.35));
                        for (let m = 0; m < kick; m++) {
                            const i = Math.floor(this._rand() * n);
                            const j = Math.floor(this._rand() * n);
                            if (i === j) continue;
                            const t = base[i]; base[i] = base[j]; base[j] = t;
                        }
                        const invCount = 1 + Math.floor(this._rand() * 3);
                        for (let m = 0; m < invCount; m++) {
                            const i = Math.floor(this._rand() * (n - 1));
                            const t = base[i]; base[i] = base[i + 1]; base[i + 1] = t;
                        }
                    } else {
                        const mutations = 1 + Math.floor(this._rand() * 3);
                        for (let m = 0; m < mutations; m++) {
                            const i = Math.floor(this._rand() * n);
                            const j = Math.floor(this._rand() * n);
                            if (i === j) continue;
                            if (this._rand() < 0.5) {
                                const t = base[i]; base[i] = base[j]; base[j] = t;
                            } else {
                                const moved = base.splice(i, 1)[0];
                                base.splice(j, 0, moved);
                            }
                        }
                    }
                }
                order = base;

                // Rotaciones genÃ©ticas a 1Â°: micro-giro Â±1..5Â° sobre el Ã¡ngulo previo o giro libre 0..359
                const prevAngleById = new Map();
                if (this.bestResult) {
                    for (const sh of this.bestResult.sheets) {
                        for (const pl of (sh.placements || [])) prevAngleById.set(pl.id, pl.rotation | 0);
                    }
                }
                const rotCount = stagnant ? (4 + Math.floor(this._rand() * 8)) : (2 + Math.floor(this._rand() * 4));
                const candidates = partsToPlace.filter(p => p.grain !== 'fixed');
                for (let r = 0; r < rotCount && candidates.length > 0; r++) {
                    const part = candidates[Math.floor(this._rand() * candidates.length)];
                    if (part.grain === 'grain') {
                        forcedAngles[part.id] = (this._rand() < 0.5) ? 0 : 180;
                    } else if (this._rand() < 0.35) {
                        const prev = prevAngleById.has(part.id) ? prevAngleById.get(part.id) : 0;
                        const d = (1 + Math.floor(this._rand() * 5)) * (this._rand() < 0.5 ? -1 : 1);
                        forcedAngles[part.id] = ((prev + d) % 360 + 360) % 360;
                    } else {
                        forcedAngles[part.id] = Math.floor(this._rand() * 360);
                    }
                }
            }
            const _angleVals = Object.values(forcedAngles);
            return { order, forcedAngles, lastAngle: (_angleVals.length > 0 ? _angleVals[0] : 0) };
        };

        // ================== GA POBLACIONAL (steady-state) ==================
        // Cada generaciÃ³n evalÃºa UN descendiente (coste = 1 decode), pero la bÃºsqueda
        // mantiene una poblaciÃ³n con torneo, cruce OX y bÃºsqueda local (memÃ©tica) en
        // lugar del antiguo 1+1 hill-climbing que se estancaba tras la 2Âª pasada.
        const POP_SIZE = Math.max(8, Math.min(48, parseInt((config && config.populationSize) || 24, 10)));
        const population = [];
        const randInt = (n) => Math.floor(this._rand() * n);
        const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
        const validOrder = (order, n) => {
            if (!Array.isArray(order) || order.length !== n) return false;
            const seen = new Set();
            for (const p of order) { if (!p || seen.has(p.id)) return false; seen.add(p.id); }
            return true;
        };

        const lieWide = (order) => { const a = {}; order.forEach(p => { if (p.grain === 'free' && p.bounds && p.bounds.width > p.bounds.height) a[p.id] = 90; }); return a; };
        const seeds = [];
        {
            const byArea = partsToPlace.slice().sort((a, b) => b.area - a.area);
            const byH = partsToPlace.slice().sort((a, b) => ((b.bounds && b.bounds.height) || 0) - ((a.bounds && a.bounds.height) || 0));
            const byW = partsToPlace.slice().sort((a, b) => ((b.bounds && b.bounds.width) || 0) - ((a.bounds && a.bounds.width) || 0));
            const perim = (p) => p.bounds ? (p.bounds.width + p.bounds.height) : 0;
            const byPerim = partsToPlace.slice().sort((a, b) => perim(b) - perim(a));
            const byFill = partsToPlace.slice().sort((a, b) => (b.area / Math.max(1, (b.bounds ? b.bounds.width * b.bounds.height : 1))) - (a.area / Math.max(1, (a.bounds ? a.bounds.width * a.bounds.height : 1))));
            seeds.push({ order: byArea, angles: {} });
            // BIG-SMALL GAP FILLER: intercala 3 grandes : 2 pequeÃ±as (corte 70/30 por Ã¡rea)
            // para que las pequeÃ±as se cuelen en los huecos que dejan las grandes al colocarse.
            {
                const cut = Math.max(1, Math.round(byArea.length * 0.7));
                const big = byArea.slice(0, cut);
                const small = byArea.slice(cut);
                const inter = [];
                let bi = 0, si = 0;
                while (bi < big.length || si < small.length) {
                    for (let k = 0; k < 3 && bi < big.length; k++) inter.push(big[bi++]);
                    for (let k = 0; k < 2 && si < small.length; k++) inter.push(small[si++]);
                }
                seeds.push({ order: inter, angles: {} });
            }
            seeds.push({ order: byH, angles: lieWide(byH) });
            seeds.push({ order: byW, angles: {} });
            seeds.push({ order: byPerim, angles: {} });
            seeds.push({ order: byFill, angles: {} });
            for (let i = 0; i < 3; i++) seeds.push({ order: shuffle(partsToPlace.slice()), angles: {} });
        }
        let seedIdx = 0;

        const mutateOrder = (order, heavy) => {
            const n = order.length; if (n < 2) return;
            // La sacudida destructiva del 35% sÃ³lo se aplica de forma OCASIONAL: si se aplica en
            // cada generaciÃ³n estancada el GA nunca explota el entorno local del mejor layout.
            const shake = !!heavy && this._rand() < 0.12;
            const count = shake ? Math.max(2, Math.ceil(n * 0.35)) : (1 + randInt(3));
            for (let m = 0; m < count; m++) {
                const i = randInt(n), j = randInt(n); if (i === j) continue;
                if (this._rand() < 0.5) { const t = order[i]; order[i] = order[j]; order[j] = t; }
                else { const mv = order.splice(i, 1)[0]; order.splice(j, 0, mv); }
            }
            if (shake) {
                const inv = 1 + randInt(3);
                for (let m = 0; m < inv; m++) { const i = randInt(n - 1); const t = order[i]; order[i] = order[i + 1]; order[i + 1] = t; }
            }
        };

        const mutateAngles = (order, angles, heavy) => {
            const cands = order.filter(p => p.grain !== 'fixed');
            if (cands.length === 0) return;
            const rotCount = heavy ? (4 + randInt(8)) : (2 + randInt(4));
            for (let r = 0; r < rotCount; r++) {
                const part = cands[randInt(cands.length)];
                if (!part) continue;
                if (part.grain === 'grain') angles[part.id] = (this._rand() < 0.5) ? 0 : 180;
                else if (this._rand() < 0.4) {
                    const prev = (angles[part.id] !== undefined) ? angles[part.id] : 0;
                    const d = (1 + randInt(5)) * (this._rand() < 0.5 ? -1 : 1);
                    angles[part.id] = ((prev + d) % 360 + 360) % 360;
                } else angles[part.id] = randInt(360);
            }
        };

        const oxCrossover = (a, b) => {
            const n = a.length; if (n < 3) return a.slice();
            let i = randInt(n), j = randInt(n); if (i > j) { const t = i; i = j; j = t; }
            const child = new Array(n).fill(null);
            const taken = new Set();
            for (let k = i; k <= j; k++) { child[k] = a[k]; taken.add(a[k].id); }
            let p = 0;
            for (let k = 0; k < n; k++) {
                const gene = b[(j + 1 + k) % n];
                if (taken.has(gene.id)) continue;
                while (p < n && child[p] !== null) p++;
                if (p >= n) break;
                child[p] = gene; taken.add(gene.id);
            }
            for (let k = 0; k < n; k++) { if (child[k] === null) { for (const g of a) { if (!taken.has(g.id)) { child[k] = g; taken.add(g.id); break; } } } }
            return child;
        };

        const tournament = () => {
            let best = null;
            for (let k = 0; k < 5 && population.length > 0; k++) {
                const c = population[randInt(population.length)];
                if (!best || c.fitness < best.fitness) best = c;
            }
            return best;
        };

        const tailFirstPromote = (order) => {
            if (!this.bestResult || !this.bestResult.sheets || this.bestResult.sheets.length <= 1) return;
            const last = this.bestResult.sheets[this.bestResult.sheets.length - 1];
            const ids = new Set((last.placements || []).map(p => p.id));
            if (ids.size < 1 || ids.size > 8) return;
            const tail = order.filter(p => ids.has(p.id));
            const rest = order.filter(p => !ids.has(p.id));
            const at = Math.min(rest.length, randInt(4));
            order.length = 0; order.push(...rest.slice(0, at), ...tail, ...rest.slice(at));
        };

        // Mueve la pieza mÃ¡s profunda (maxY) a una posiciÃ³n temprana aleatoria:
        // ataca directamente la longitud de bobina, que es el gradiente principal.
        const deepestMove = (order) => {
            if (!this.bestResult || !this.bestResult.sheets) return;
            let id = null, my = -Infinity;
            for (const sh of this.bestResult.sheets) {
                for (const p of (sh.placements || [])) {
                    const y = p.sheetBounds ? p.sheetBounds.maxY : 0;
                    if (y > my) { my = y; id = p.id; }
                }
            }
            if (id === null) return;
            const idx = order.findIndex(p => p.id === id);
            if (idx <= 0) return;
            const moved = order.splice(idx, 1)[0];
            const at = (this._rand() < 0.6) ? 0 : randInt(Math.min(6, order.length + 1));
            order.splice(at, 0, moved);
        };

        let deepestSweep = 0;
        const deepestChild = () => {
            const best = population[0];
            if (!best || !this.bestResult) return localSearchChild();
            const order = best.order.slice();
            const angles = Object.assign({}, best.angles);
            let id = null, my = -Infinity;
            for (const sh of this.bestResult.sheets) {
                for (const p of (sh.placements || [])) {
                    const y = p.sheetBounds ? p.sheetBounds.maxY : 0;
                    if (y > my) { my = y; id = p.id; }
                }
            }
            if (id !== null) {
                const idx = order.findIndex(p => p.id === id);
                if (idx > 0) {
                    const moved = order.splice(idx, 1)[0];
                    const span = Math.min(8, order.length + 1);
                    const at = deepestSweep % span;
                    deepestSweep++;
                    order.splice(at, 0, moved);
                }
            }
            mutateAngles(order, angles, false);
            return { order, angles };
        };

        const breedChild = () => {
            if (population.length < 2) return { order: shuffle(partsToPlace.slice()), angles: {} };
            const elite = population[0];
            const p1 = (this._rand() < 0.65) ? elite : (tournament() || elite);
            let p2 = tournament() || elite;
            if (p2 === p1 && population.length > 1) p2 = population[1 + randInt(population.length - 1)];
            const order = oxCrossover(p1.order, p2.order);
            const angles = Object.assign({}, p1.angles);
            if (this._rand() < 0.5) Object.assign(angles, p2.angles);
            const heavy = this.noImproveGenerations >= 4;
            if (this._rand() < 0.4) deepestMove(order);
            if (this._rand() < 0.25) tailFirstPromote(order);
            mutateOrder(order, heavy);
            mutateAngles(order, angles, heavy);
            return { order, angles };
        };

        const localSearchChild = () => {
            const best = population[0];
            if (!best) return breedChild();
            const order = best.order.slice();
            const angles = Object.assign({}, best.angles);
            const n = order.length;
            const r = this._rand();
            if (r < 0.3) {
                deepestMove(order);
            } else if (r < 0.45) {
                tailFirstPromote(order);
            } else if (r < 0.65 && n >= 4) {
                let i = randInt(n), j = randInt(n); if (i > j) { const t = i; i = j; j = t; }
                if (i !== j) { const seg = order.slice(i, j + 1).reverse(); for (let k = 0; k < seg.length; k++) order[i + k] = seg[k]; }
            } else if (r < 0.82 && n >= 3) {
                const len = 1 + randInt(Math.min(3, n - 1));
                const i = randInt(n - len + 1);
                const block = order.splice(i, len);
                const j = randInt(order.length + 1);
                order.splice(j, 0, ...block);
            } else {
                mutateAngles(order, angles, false);
            }
            return { order, angles };
        };

        // ATAQUE A LA COLA: la longitud de bobina la define el grupo de piezas con mayor maxY.
        // Este operador las adelanta en el genoma (para que compitan antes por el espacio bajo) y
        // rompe la segregaciÃ³n por tamaÃ±o intercambiando una pieza temprana por una tardÃ­a.
        const topSweepChild = () => {
            const best = population[0];
            if (!best) return breedChild();
            const order = best.order.slice();
            const angles = Object.assign({}, best.angles);
            if (!this.bestResult || !this.bestResult.sheets) { mutateOrder(order, false); return { order, angles }; }
            const tops = [];
            for (const sh of this.bestResult.sheets) {
                for (const p of (sh.placements || [])) {
                    tops.push({ id: p.id, y: p.sheetBounds ? p.sheetBounds.maxY : 0 });
                }
            }
            tops.sort((a, b) => b.y - a.y);
            const pool = tops.slice(0, Math.min(tops.length, 8));
            const k = Math.min(pool.length, 2 + randInt(3));
            for (let c = 0; c < k; c++) {
                const t = pool.splice(randInt(pool.length), 1)[0];
                if (!t) break;
                const idx = order.findIndex(p => p.id === t.id);
                if (idx <= 0) continue;
                const moved = order.splice(idx, 1)[0];
                const at = randInt(Math.min(12, order.length + 1));
                order.splice(at, 0, moved);
            }
            if (this._rand() < 0.35 && order.length > 10) {
                const i = randInt(Math.min(10, order.length));
                const j = order.length - 1 - randInt(Math.min(10, order.length));
                if (i !== j) { const t = order[i]; order[i] = order[j]; order[j] = t; }
            }
            mutateAngles(order, angles, false);
            return { order, angles };
        };

        // CRITICAL-BAND RUIN & RECREATE: cuando el GA ya se estancÃ³, mutar todo el cromosoma
        // desordena las piezas grandes que ya empaquetaron bien la base. AquÃ­ se CONGELA el 60%
        // inicial (base compacta de la Hoja #1) y se reordena sÃ³lo el 40% final: se promueven
        // las 3 piezas con mayor maxY al inicio del bloque, se intercalan grandes/pequeÃ±as y se
        // aplican rotaciones finas. Todas las generaciones 6..N se dedican a comprimir la cola.
        const criticalBandChild = () => {
            const baseOrder = (this.bestOrder && this.bestOrder.length > 0)
                ? this.bestOrder
                : ((population[0] && population[0].order) || partsToPlace);
            const order = baseOrder.slice();
            const angles = Object.assign({}, this.bestAngles || (population[0] && population[0].angles) || {});
            if (order.length < 12) return topSweepChild();

            const cut = Math.max(1, Math.floor(order.length * 0.6));
            const frozen = order.slice(0, cut);
            let band = order.slice(cut);

            const topY = new Map();
            if (this.bestResult && this.bestResult.sheets) {
                for (const sh of this.bestResult.sheets) {
                    for (const p of (sh.placements || [])) {
                        const y = p.sheetBounds ? p.sheetBounds.maxY : 0;
                        const prev = topY.get(p.id);
                        if (prev === undefined || y > prev) topY.set(p.id, y);
                    }
                }
            }
            const promote = band.slice()
                .sort((a, b) => (topY.get(b.id) || 0) - (topY.get(a.id) || 0))
                .slice(0, 3)
                .map(p => p.id);
            const rank = (p) => { const i = promote.indexOf(p.id); return i < 0 ? 99 : i; };
            band.sort((a, b) => rank(a) - rank(b));

            const byArea = band.slice().sort((a, b) => (b.area || 0) - (a.area || 0));
            const bcut = Math.max(1, Math.round(byArea.length * 0.65));
            const big = byArea.slice(0, bcut);
            const small = byArea.slice(bcut);
            const inter = [];
            let bi = 0, si = 0;
            while (bi < big.length || si < small.length) {
                for (let k = 0; k < 2 && bi < big.length; k++) inter.push(big[bi++]);
                for (let k = 0; k < 1 && si < small.length; k++) inter.push(small[si++]);
            }
            // Las 3 crÃ­ticas al inicio del bloque intercalado (orden de maxY).
            inter.sort((a, b) => rank(a) - rank(b));

            for (const p of inter) {
                if (p.grain && p.grain !== 'free') continue;
                if (this._rand() >= 0.45) continue;
                const cur = angles[p.id] !== undefined ? angles[p.id] : 0;
                const deltas = [1, 2, 3, 5, 8, 15, 45, 90];
                const d = deltas[randInt(deltas.length)];
                angles[p.id] = ((cur + (this._rand() < 0.5 ? d : -d)) % 360 + 360) % 360;
            }
            return { order: frozen.concat(inter), angles };
        };

        const buildCandidate = (gen) => {
            let cand;
            if (seedIdx < seeds.length) {
                const s = seeds[seedIdx++];
                cand = { order: s.order.slice(), angles: Object.assign({}, s.angles) };
            } else if (this.noImproveGenerations >= 2 && this._rand() < 0.5) {
                // Estancado: 50% de las generaciones van dirigidas a la franja crÃ­tica.
                cand = criticalBandChild();
            } else if (this._rand() < 0.34) {
                cand = topSweepChild();
            } else if (this._rand() < 0.45) {
                cand = localSearchChild();
            } else {
                cand = breedChild();
            }
            if (!validOrder(cand.order, partsToPlace.length)) {
                cand = { order: partsToPlace.slice(), angles: cand.angles || {} };
            }
            const vals = Object.values(cand.angles || {});
            return { order: cand.order, forcedAngles: cand.angles || {}, lastAngle: (vals.length > 0 ? vals[0] : 0) };
        };

        const executeGeneration = async () => {
            if (!this.working || this.aborted) return;
            this.generationCount++;

            try {
                const cand = buildCandidate(this.generationCount - 1);
                const result = await this.evaluatePlacementGPU(cand.order, sheetW, sheetH, spacing, bleed, config, cand.forcedAngles);

                if (this.aborted || result === null) return;

                this.generationsCompleted++;
                const elapsedMs = Date.now() - this.startTime;

                const isNewBest = (result.fitness < this.bestFitness || this.currentPlacements.length === 0);

                if (isNewBest) {
                    this.bestFitness = result.fitness;
                    this.bestOrder = cand.order;
                    this.bestAngles = cand.forcedAngles;
                    this.bestResult = result;
                    this.currentPlacements = result.placements;
                    for (const p of result.placements) {
                        if (p.rotation !== undefined && p.rotation !== null) this.bestAngleById.set(p.id, p.rotation | 0);
                    }

                    this.emit('best_placement_found', {
                        generation: this.generationCount,
                        fitness: result.fitness,
                        utilisation: result.utilisation,
                        totalParts: partsToPlace.length,
                        placedParts: result.placements.length,
                        unplacedParts: result.unplacedCount,
                        effectiveSheetWidth_mm: result.effectiveSheetW,
                        effectiveSheetHeight_mm: result.effectiveSheetH,
                        sheetsUsed: result.sheets.length,
                        paperLength_mm: result.totalPaperLengthMm,
                        rollLengthMm: result.rollLengthMm,
                        continuousRoll: result.continuousRoll,
                        elapsedMs: elapsedMs,
                        sheets: result.sheets
                    });
                }

                population.push({ order: cand.order, angles: cand.forcedAngles, fitness: result.fitness });
                population.sort((a, b) => a.fitness - b.fitness);
                if (population.length > POP_SIZE) population.length = POP_SIZE;

                // Progreso emitido en CADA generaciÃ³n para garantizar telemetrÃ­a viva a 60 FPS
                const vramStats = (this.gpuEngine && this.gpuEngine.getCacheStats) ? this.gpuEngine.getCacheStats() : null;
                this.emit('progress', {
                    generation: this.generationCount,
                    generationsCompleted: this.generationsCompleted,
                    elapsedMs: elapsedMs,
                    bestFitness: this.bestFitness,
                    currentFitness: result.fitness,
                    utilisation: result.utilisation,
                    bestRollLengthMm: this.bestResult ? this.bestResult.totalPaperLengthMm : result.totalPaperLengthMm,
                    sheetsUsed: result.sheets.length,
                    placedCount: result.placements.length,
                    totalCount: partsToPlace.length,
                    isNewBest: isNewBest,
                    vramEntries: vramStats ? vramStats.vramRotationEntries : 0,
                    vramMB: vramStats ? vramStats.vramMB : 0,
                    angle: cand.lastAngle !== undefined ? cand.lastAngle : null
                });

                if (isNewBest) {
                    this.noImproveGenerations = 0;
                } else {
                    this.noImproveGenerations++;
                }

                // BUCLE CONTINUO: NO hay parada automÃ¡tica por convergencia/estancamiento.
                // El motor itera indefinidamente (Gen #1..#N) hasta que el usuario pulse Detener
                // (engine:stop â†’ this.stop()). Al estancarse se aplica HYPER-MUTATION en la
                // siguiente generaciÃ³n (ver buildCandidate) para escapar del mÃ­nimo local.
                if (this.noImproveGenerations === 5) {
                    this.emit('progress', {
                        generation: this.generationCount,
                        generationsCompleted: this.generationsCompleted,
                        elapsedMs: elapsedMs,
                        bestFitness: this.bestFitness,
                        currentFitness: result.fitness,
                        utilisation: this.bestResult ? this.bestResult.utilisation : result.utilisation,
                        bestRollLengthMm: this.bestResult ? this.bestResult.totalPaperLengthMm : result.totalPaperLengthMm,
                        sheetsUsed: this.bestResult ? this.bestResult.sheets.length : result.sheets.length,
                        placedCount: this.bestResult ? this.bestResult.placements.length : result.placements.length,
                        totalCount: partsToPlace.length,
                        isNewBest: false,
                        hyperMutation: true
                    });
                }

            } catch (err) {
                console.warn(`[CoreNestingEngine GPU] Gen ${this.generationCount} descartada:`, err.message || err);
            } finally {
                scheduleNext();
            }
        };

        executeGeneration();
    }

    async evaluatePlacementGPU(parts, sheetW, sheetH, spacing, bleed, config, forcedAngles = {}) {
        this._currentBatchCount = (parts && parts.length) || 0;
        const continuousRoll = (typeof config.continuousRoll === 'boolean')
            ? config.continuousRoll
            : ((typeof this.continuousRoll === 'boolean') ? this.continuousRoll : true);

        const createSheetState = (idx, h) => ({
            index: idx,
            height: h,
            occupancy: this.gpuEngine.createSheetOccupancyGrid(sheetW, h),
            placements: [],
            maxY: 0.0,
            netArea: 0.0,
            usedArea: 0.0,
            // CachÃ© de rechazo por origen: todas las copias del mismo source tienen la misma
            // geometrÃ­a, asÃ­ que si una no cupo (Ã¡ngulo libre) las demÃ¡s tampoco (la hoja sÃ³lo
            // puede llenarse mÃ¡s). Evita 90 evaluaciones GPU idÃ©nticas.
            rejectedSources: new Set(),
            minSearchYBySource: new Map()
        });

        // Pre-filtro: descartar piezas que no caben de ninguna forma en la bobina
        const pending = [];
        const tooWide = [];
        for (const part of parts) {
            const gb = part.bounds;
            if (gb && gb.width > 0 && gb.height > 0) {
                const fitsNormal = (gb.width <= sheetW && gb.height <= sheetH);
                const fitsRotated = (gb.width <= sheetH && gb.height <= sheetW);
                if (!fitsNormal && !fitsRotated && !continuousRoll) {
                    part.tooWide = true;
                    tooWide.push(part);
                    continue;
                }
                if (gb.width > sheetW && gb.height > sheetW) {
                    part.tooWide = true;
                    tooWide.push(part);
                    continue;
                }
            }
            pending.push(part);
        }

        const sheets = [];
        let effectiveH = sheetH;
        let remaining = pending;
        let bestRes = null;

        if (continuousRoll) {
            // Modo Bobina Continua: expandir dinÃ¡micamente si se requiere mÃ¡s largo
            const MAX_ROLL_H = 100000.0;
            // PRE-DIMENSIONADO: estimar el largo por Ã¡rea antes del primer intento. Sin esto la
            // bobina arranca en sheetH (p. ej. 1000 mm) y recoloca TODAS las piezas 5-6 veces,
            // multiplicando el coste por generaciÃ³n sin mejorar el resultado.
            let workH = sheetH;
            {
                let pendingArea = 0.0;
                for (const p of pending) pendingArea += (p.area || 0);
                const estH = pendingArea / (sheetW * 0.55) + 2.0 * spacing;
                if (estH > workH) workH = Math.min(MAX_ROLL_H, estH);
            }
            let bestSheet = null;

            // Un solo _placeAll sobre las 180 piezas (máxima resolución vertical mm/px) con la
            // estimación de altura del estado que daba la mejor calidad. Si faltan piezas, NO se
            // reconstruye la hoja: se extiende la rejilla existente y se colocan SÓLO las que
            // quedaron fuera. Así se conserva el layout bueno y se evita el doble _placeAll.
            {
                const sheet = createSheetState(0, workH);
                let res = await this._placeAll(sheet, pending, sheetW, workH, spacing, bleed, forcedAngles);
                if (res === null || this.aborted) return null;
                bestSheet = sheet;
                bestRes = res;

                for (let attempt = 0; attempt < 200; attempt++) {
                    if (res.unplaced.length === 0) break;
                    if (sheet.placements.length === 0) break;

                    let tallestUnplaced = 0.0;
                    res.unplaced.forEach(p => {
                        const h = (p.bounds && p.bounds.height) || 0;
                        if (h > tallestUnplaced) tallestUnplaced = h;
                    });
                    const newH = Math.min(MAX_ROLL_H, workH + Math.max(tallestUnplaced * 2.0, 1000.0));
                    if (newH <= workH + 0.5) break;
                    workH = newH;
                    // Extiende la rejilla conservando las marcas y las piezas ya colocadas.
                    this.gpuEngine.extendSheetOccupancyGrid(sheet.occupancy, workH);
                    sheet.height = workH;
                    // Con la hoja más alta, los vetos por origen y la cota de búsqueda dejan de ser
                    // válidos (esas piezas pueden volver a caber más arriba).
                    if (sheet.rejectedSources) sheet.rejectedSources.clear();
                    if (sheet.minSearchYBySource) sheet.minSearchYBySource.clear();
                    res = await this._placeAll(sheet, res.unplaced, sheetW, workH, spacing, bleed, forcedAngles);
                    if (res === null || this.aborted) return null;
                    bestRes = res;
                }
            }
            if (bestSheet && bestSheet.placements.length > 1) {
                // ORDEN CRÃTICO: el LNS trabaja con la rejilla y el layout en el MISMO estado
                // (reciÃ©n estampados). Compactar antes desplazarÃ­a las piezas y la rejilla
                // dejarÃ­a de reflejar la realidad.
                const preLns = this._clonePlacements(bestSheet.placements);
                const preLnsMaxY = bestSheet.maxY;
                // Presupuesto ACOTADO: un LNS de cola que se alarga 10-20 s por generaciÃ³n es
                // lo que hacÃ­a "pensar" al motor durante minutos sin mejorar el rÃ©cord.
                await this._lnsPolish(bestSheet, pending, sheetW, workH, spacing, bleed, forcedAngles, { maxMs: 250 });
                this._compactSheetExact(bestSheet, spacing);
                // VerificaciÃ³n de seguridad: si el pulido introdujese cualquier solape de material
                // se descarta por completo y se conserva el layout del decodificador.
                try {
                    this.auditZeroOverlaps(bestSheet.placements, null, spacing);
                } catch (_auditErr) {
                    bestSheet.placements = preLns;
                    bestSheet.maxY = preLnsMaxY;
                    this._compactSheetExact(bestSheet, spacing);
                }
                bestSheet._tail = null;
            }
            sheets.push(bestSheet || createSheetState(0, sheetH));
            effectiveH = workH;
            remaining = (bestRes && bestRes.unplaced) ? bestRes.unplaced : [];
        } else {
            // === MODO LÃMINAS FIJAS: FIRST-FIT DECREASING SOBRE HOJAS EXISTENTES ===
            // Para CADA pieza se intenta SIEMPRE la Hoja 0, 1, 2... en orden estricto antes
            // de abrir una hoja nueva. SÃ³lo si no cabe en NINGUNA hoja existente (ni siquiera
            // tras el Barrido de Rescate de Alta Densidad) se abre la hoja K+1.
            const sheetsList = [createSheetState(0, sheetH)];
            let unplacedFixed = [];

            for (let pi = 0; pi < pending.length; pi++) {
                if (this.aborted) return null;
                const part = pending[pi];
                let done = false;
                const freeAngle = (forcedAngles[part.id] === undefined);
                // Claves separadas: fallar el intento normal NO impide un rescate posterior.
                const nKey = part.source + '_N';
                const rKey = part.source + '_R';

                // 1) Best-Fit / First-Fit en hojas existentes, en orden de Ã­ndice
                for (let si = 0; si < sheetsList.length && !done; si++) {
                    const sh = sheetsList[si];
                    if (freeAngle && sh.rejectedSources.has(nKey)) continue;
                    done = await this._tryPlaceOnSheet(sh, part, sheetW, sheetH, spacing, bleed, forcedAngles, false);
                    if (!done && freeAngle) sh.rejectedSources.add(nKey);
                }

                // 2) RESCUE DEEP SCAN: sÃ³lo si la pieza va a provocar abrir hoja nueva y esa hoja
                //    aÃºn no rechazÃ³ este source en rescate (evita 80 barridos idÃ©nticos).
                if (!done && sheetsList.length <= 2) {
                    for (let si = 0; si < sheetsList.length && !done; si++) {
                        const sh = sheetsList[si];
                        if (freeAngle && sh.rejectedSources.has(rKey)) continue;
                        done = await this._tryPlaceOnSheet(sh, part, sheetW, sheetH, spacing, bleed, forcedAngles, true);
                        if (!done && freeAngle) sh.rejectedSources.add(rKey);
                    }
                }

                // 3) SÃ³lo entonces abrir una hoja nueva (y colocar ahÃ­, con rescate si hace falta)
                if (!done) {
                    const newSheet = createSheetState(sheetsList.length, sheetH);
                    const okNew = await this._tryPlaceOnSheet(newSheet, part, sheetW, sheetH, spacing, bleed, forcedAngles, false)
                        || await this._tryPlaceOnSheet(newSheet, part, sheetW, sheetH, spacing, bleed, forcedAngles, true);
                    if (okNew) {
                        sheetsList.push(newSheet);
                        done = true;
                    }
                }

                if (!done) unplacedFixed.push(part);
            }

            // LNS DIRIGIDO A LA FRANJA maxY (modo lÃ¡minas fijas): el totalPaperLengthMm es
            // (K-1)*sheetH + maxY de la ÃšLTIMA hoja, asÃ­ que ahÃ­ estÃ¡ toda la ganancia.
            // Antes esto sÃ³lo existÃ­a en el modo bobina â†’ estancamiento tras la Gen 5.
            const lastSh = sheetsList[sheetsList.length - 1];
            if (lastSh && lastSh.placements.length > 0) {
                this._compactSheetExact(lastSh, spacing);
                await this._lnsPolish(lastSh, pending, sheetW, sheetH, spacing, bleed, forcedAngles, {
                    mode: 'random', fraction: 0.35, maxCount: 24, maxMs: 200
                });
                // Si la Ãºltima hoja quedÃ³ casi vacÃ­a (<=12 piezas) se intenta REABSORBER en las
                // hojas anteriores; si todas caben, desaparece una hoja entera.
                if (lastSh.placements.length <= 12 && sheetsList.length > 1) {
                    const byId = new Map();
                    for (const p of pending) byId.set(p.id, p);
                    const kept = [];
                    let moved = 0;
                    for (const pl of lastSh.placements.slice()) {
                        const part = byId.get(pl.id);
                        if (!part) { kept.push(pl); continue; }
                        let okMove = false;
                        for (let si = 0; si < sheetsList.length - 1 && !okMove; si++) {
                            okMove = await this._tryPlaceOnSheet(sheetsList[si], part, sheetW, sheetH, spacing, bleed, forcedAngles, false);
                        }
                        if (okMove) moved++; else kept.push(pl);
                    }
                    if (moved > 0) {
                        this._rebuildOccupancy(lastSh, kept, bleed, spacing);
                        lastSh.placements = kept;
                        let my = 0, used = 0;
                        for (const pl of kept) {
                            const b = pl.sheetBounds || this.gpuEngine.getPolygonBounds(pl.placedOuter);
                            if (b.maxY > my) my = b.maxY;
                            const pp = byId.get(pl.id);
                            if (pp) used += (pp.area || 0);
                        }
                        lastSh.maxY = my;
                        lastSh.usedArea = used;
                        lastSh.netArea = used;
                        if (kept.length === 0 && sheetsList.length > 1) {
                            sheetsList.pop();
                            sheetsList.forEach((s, i) => { s.index = i; });
                        }
                    }
                }
            }

            for (const sh of sheetsList) sheets.push(sh);
            remaining = unplacedFixed;
        }

        if (sheets.length === 0) sheets.push(createSheetState(0, continuousRoll ? effectiveH : sheetH));

        const unplaced = tooWide.concat(remaining);
        const unplacedCount = unplaced.length;

        // AuditorÃ­a forense obligatoria: CERO SOLAPAMIENTOS Y LÃMITES POR LÃMINA
        const eps = 1e-3;
        for (const sh of sheets) {
            this.auditZeroOverlaps(sh.placements, null, spacing);
            const shH = sh.height || sheetH;
            for (const p of sh.placements) {
                const b = this.gpuEngine.getPolygonBounds(p.placedOuter);
                if (b.minX < -eps || b.maxX > sheetW + eps || b.minY < -eps || b.maxY > shH + eps) {
                    throw new Error(`[AUDIT FATAL] Pieza ID=${p.id} fuera de la lÃ¡mina ${sh.index} (${b.minX.toFixed(2)}, ${b.minY.toFixed(2)}, ${b.maxX.toFixed(2)}, ${b.maxY.toFixed(2)})`);
                }
            }
        }

        const K = sheets.length;
        const lastSheet = sheets[K - 1];
        const lastSheetH = lastSheet.height || sheetH;
        const totalNetPlacedArea = sheets.reduce((a, s) => a + s.netArea, 0);
        const rollLengthMm = lastSheet.maxY;
        const totalPaperLengthMm = (K - 1) * lastSheetH + ((lastSheet.placements.length > 0) ? (lastSheet.maxY + spacing) : 0);

        let sumTopY = 0.0;
        let neighbourPairs = 0;
        for (const sh of sheets) {
            const pls = sh.placements;
            for (const p of pls) {
                const b = p.sheetBounds || this.gpuEngine.getPolygonBounds(p.placedOuter);
                sumTopY += b.maxY;
            }
            for (let i = 0; i < pls.length; i++) {
                const bi = pls[i].sheetBounds || this.gpuEngine.getPolygonBounds(pls[i].placedOuter);
                for (let j = i + 1; j < pls.length; j++) {
                    const bj = pls[j].sheetBounds || this.gpuEngine.getPolygonBounds(pls[j].placedOuter);
                    if (bi.minX <= bj.maxX + spacing + 1 && bj.minX <= bi.maxX + spacing + 1 &&
                        bi.minY <= bj.maxY + spacing + 1 && bj.minY <= bi.maxY + spacing + 1) {
                        neighbourPairs++;
                    }
                }
            }
        }

        // Fitness con gradiente continuo:
        //  - piezas sin colocar   -> prioridad absoluta
        //  - nÂº de hojas           -> prioridad alta
        //  - longitud de bobina    -> prioridad media
        //  - Î£ topY (tie-break)    -> empuja cada pieza hacia arriba/compacto
        //  - pares vecinos         -> premia el encaje/interlocking
        const fitness = (unplacedCount * 1e12)
            + (K * 1e9)
            + (rollLengthMm * 1e5)
            + (sumTopY * 1.0)
            - (neighbourPairs * 100.0);

        const sheetAreaUsed = sheetW * Math.max(10.0, (K - 1) * lastSheetH + lastSheet.maxY);
        const utilisation = Math.min(100.0, (totalNetPlacedArea / sheetAreaUsed) * 100.0);

        return {
            fitness,
            utilisation,
            placements: [].concat.apply([], sheets.map(s => s.placements)),
            sheets: sheets.map(s => ({
                index: s.index,
                placements: s.placements,
                maxY: s.maxY,
                heightMm: s.height || sheetH,
                usedLengthMm: (s.placements.length > 0) ? (s.maxY + spacing) : 0.0,
                netArea: s.netArea
            })),
            rollLengthMm,
            totalPaperLengthMm,
            unplacedCount,
            unplaced,
            effectiveSheetW: sheetW,
            effectiveSheetH: effectiveH,
            sheetsUsed: K,
            continuousRoll
        };
    }

    /**
     * Plan angular jerÃ¡rquico Coarse-to-Fine:
     *  - Normal: malla de 15Â° (24) + preferredAngle del cromosoma â†’ ventana Â±7Â° a 1Â°.
     *  - Rescue: malla de 10Â° (36) + preferredAngle â†’ micro-ajuste Â±5Â° a 1Â°.
     *  - Sin GPU batch (CPU): cardinales + preferredAngle (para no bloquear).
     */
    _anglePlanFor(part, forcedAngles, rescue) {
        if (part.grain === 'fixed') return { coarse: [0], fine: 0 };
        if (part.grain === 'grain') return { coarse: [0, 180], fine: 0 };

        let pref = (forcedAngles && Object.prototype.hasOwnProperty.call(forcedAngles, part.id))
            ? (((forcedAngles[part.id] | 0) % 360) + 360) % 360
            : null;
        if (pref === null && this.bestAngleById && this.bestAngleById.has(part.id)) {
            pref = (((this.bestAngleById.get(part.id) | 0) % 360) + 360) % 360;
        }

        // Modo restringido (A/B con angleQuantum>1): sÃ³lo mÃºltiplos de la cuantÃ­a, sin refino fino.
        const q = this.angleQuantum || 1;
        if (q > 1) {
            const coarseQ = [];
            for (let a = 0; a < 360; a += q) coarseQ.push(a);
            if (pref !== null) coarseQ.push((Math.round(pref / q) * q) % 360);
            return { coarse: Array.from(new Set(coarseQ)), fine: 0 };
        }

        const batch = !!(this.gpuEngine && this.gpuEngine.evalBatchProgram);
        // Lotes grandes (>400 piezas): el coste por pieza domina el tiempo de generaciÃ³n.
        // Se recorta la ventana fina y el nÂº de candidatas refinadas (calidad ~igual).
        const bigBatch = (this._currentBatchCount || 0) > 400;

        // PLAN ADAPTATIVO: si ya conocemos un Ã¡ngulo bueno para esta pieza (del mejor layout
        // anterior), usar malla dispersa (45Â°) + ancla previa y ventana fina local. Esto reduce
        // ~2x el trabajo angular por pieza conservando la calidad (el refino fino sigue a 1Â°).
        if (pref !== null && batch && !rescue) {
            // Ángulo conocido del mejor layout: una sola pasada de batch con 4 orientaciones
            // base (pref y sus perpendiculares) + ventana fina de ±3° alrededor del mejor.
            return { coarse: Array.from(new Set([pref, (pref + 90) % 360, (pref + 180) % 360, (pref + 270) % 360])), fine: 4 };
        }

        const step = rescue ? 10 : 15;
        const coarse = [];
        if (batch || rescue) {
            for (let a = 0; a < 360; a += step) coarse.push(a);
        } else {
            coarse.push(0, 90, 180, 270);
        }
        if (pref !== null) coarse.push(pref);

        return { coarse: Array.from(new Set(coarse)), fine: rescue ? 5 : (bigBatch ? 4 : 7) };
    }

    async _tryPlaceOnSheet(sheet, part, sheetW, sheetH, spacing, bleed, forcedAngles, rescue) {
        const _tStart = performance.now();

        // Gate barato: si el espacio libre teÃ³rico de la hoja no da ni para el Ã¡rea de la pieza
        // mÃ¡s su margen perimetral, no se pierde tiempo evaluando esa hoja.
        const freeEnc = (sheetW * sheetH) - sheet.usedArea;
        const need = part.area + 2.0 * (((part.bounds && part.bounds.width) || 0) + ((part.bounds && part.bounds.height) || 0)) * spacing;
        if (freeEnc < need) return false;

        const occupancy = sheet.occupancy;
        const cacheKey = 'src' + part.source;
        const plan = this._anglePlanFor(part, forcedAngles, rescue);
        const gpu = this.gpuEngine;
        // FRONTERA MONÃ“TONA por source: si ya colocamos una copia idÃ©ntica (sin Ã¡ngulo forzado)
        // a Y=yPlaced, las siguientes copias no pueden caber por encima de yPlaced-5 mm; si
        // hubiera cabido mÃ¡s arriba, la copia anterior lo habrÃ­a elegido. Acota el barrido.
        const hintY = (sheet.minSearchYBySource && sheet.minSearchYBySource.get(part.source)) || 0;
        const minScanY = Math.max(0, hintY - 5);

        // ---- Paso A: exploraciÃ³n angular (batch GPU si estÃ¡ disponible) ----
        let results = null;
        const _tBatch0 = performance.now();
        if (gpu.evalBatchProgram) {
            const r = gpu.findBestPlacementBatch(occupancy, part.polygon, part.holes, plan.coarse, bleed, spacing, cacheKey);
            if (r) results = r.results;
        }
        if (!results) {
            results = [];
            for (const a of plan.coarse) {
                const e = gpu.findBestPlacement(occupancy, part.polygon, part.holes, a, bleed, spacing, cacheKey);
                if (e && e.cost < 1e8) results.push({ x: e.x, y: e.y, cost: e.cost, inHole: !!e.inHole, normGeo: e.normGeo, angle: a });
            }
        }

        // ---- Paso B: refinamiento fino a Â±1Â° alrededor del MEJOR Ã¡ngulo ----
        // Se limita a 8 Ã¡ngulos exactos: entran en UN solo pase de batch (MAXB=8) en vez de
        // 3-4 pases. Antes: 2 tops x Â±7Â° = hasta 30 Ã¡ngulos por pieza.
        if (plan.fine > 0 && results.length > 0) {
            results.sort((a, b) => a.cost - b.cost);
            // Un solo top fuera de rescue: ±3° alrededor del mejor ángulo = 7 ángulos, que caben
            // en UN chunk de MAXB (antes 3 tops → hasta 21 ángulos → 3 chunks por pieza).
            const nTops = Math.min(3, results.length);
            const tops = results.slice(0, nTops);
            const window = Math.min(3, plan.fine);
            const coarseSet = new Set(plan.coarse);
            const fineSet = new Set();
            for (const t of tops) {
                for (let d = -window; d <= window; d++) {
                    const a = ((t.angle + d) % 360 + 360) % 360;
                    if (!coarseSet.has(a)) fineSet.add(a);
                }
            }
            const fineAngles = Array.from(fineSet).slice(0, 16);
            if (fineAngles.length > 0) {
                let fineResults = null;
                if (gpu.evalBatchProgram) {
                    const r = gpu.findBestPlacementBatch(occupancy, part.polygon, part.holes, fineAngles, bleed, spacing, cacheKey);
                    if (r) fineResults = r.results.map(x => Object.assign({ fine: true }, x));
                }
                if (!fineResults) {
                    fineResults = [];
                    for (const a of fineAngles) {
                        const e = gpu.findBestPlacement(occupancy, part.polygon, part.holes, a, bleed, spacing, cacheKey);
                        if (e && e.cost < 1e8) fineResults.push({ x: e.x, y: e.y, cost: e.cost, inHole: !!e.inHole, normGeo: e.normGeo, angle: a, fine: true });
                    }
                }
                // Desempate: con la Y cuantizada a la rejilla, muchos ángulos finos empatan en
                // coste con el ancla gruesa y el sort estable dejaba ganar siempre al múltiplo de
                // 15°. Ante empate técnico se prefiere el ángulo fino (es el que explora).
                results = results.concat(fineResults).sort((a, b) => {
                    const d = a.cost - b.cost;
                    if (Math.abs(d) > 0.5) return d;
                    return (a.fine ? 0 : 1) - (b.fine ? 0 : 1);
                });
            }
        }

        this._prof.batch += performance.now() - _tBatch0;
        const _tRef = performance.now();
        let bestEval = (results && results.length > 0) ? results[0] : null;
        let bestAngle = bestEval ? bestEval.angle : null;
        let normGeo = bestEval ? bestEval.normGeo : null;
        let refined = null;
        let inHole = bestEval ? !!bestEval.inHole : false;

        if (bestEval) {
            refined = gpu.refineSlideToContact(
                occupancy.placedItems,
                normGeo.normalizedOuter,
                bestEval.x,
                bestEval.y,
                spacing,
                sheetW,
                sheetH,
                rescue ? { fine: true, occupancy: occupancy, stepMm: 1.0, cacheKey: cacheKey, minScanY: minScanY } : {}
            );
        }

        this._prof.refine += performance.now() - _tRef;
        const _tGrid = performance.now();

        // FALLBACK DE COMPLETITUD / RESCATE: barrido de rejilla True Shape sobre los mejores
        // Ã¡ngulos, con confirmaciÃ³n analÃ­tica y refino fino si es rescate.
        if (!refined || refined.failedToFitSheet) {
            // El barrido de rejilla en CPU es el coste dominante (~20 ms por intento). En modo
            // normal sólo se ejecuta si la GPU SÍ vio candidatos (refino analítico fallido) y con
            // 2 ángulos; si la GPU no vio NADA, el barrido profundo se reserva al rescate.
            if (!rescue && (!results || results.length === 0)) return false;
            const nAng = rescue ? 4 : 2;
            const gridAngles = (results && results.length > 0)
                ? results.slice(0, nAng).map(r => r.angle)
                : plan.coarse.slice(0, nAng);
            let gridBest = null;
            let gridAngle = bestAngle !== null ? bestAngle : 0;
            for (const angle of gridAngles) {
                const ng = gpu.normalizeGeometryCached(cacheKey, part.polygon, part.holes, angle);
                const g = gpu.findBestPlacementGrid(occupancy, ng, ng.widthMm, ng.heightMm, spacing, cacheKey);
                if (g && (!gridBest || g.cost < gridBest.cost)) {
                    gridBest = g;
                    gridAngle = angle;
                }
            }
            if (gridBest) {
                const r2 = gpu.refineSlideToContact(
                    occupancy.placedItems,
                    gridBest.normGeo.normalizedOuter,
                    gridBest.x,
                    gridBest.y,
                    spacing,
                    sheetW,
                    sheetH,
                    { fine: true, occupancy: occupancy, stepMm: 1.0, cacheKey: cacheKey, minScanY: minScanY }
                );
                if (r2 && !r2.failedToFitSheet) {
                    refined = r2;
                    bestAngle = gridAngle;
                    normGeo = gridBest.normGeo;
                    inHole = !!gridBest.inHole;
                }
            }
        }

        this._prof.grid += performance.now() - _tGrid;
        if (!refined || refined.failedToFitSheet || !normGeo) return false;
        if (bestAngle === null) bestAngle = 0;
        this._prof.total += performance.now() - _tStart;
        this._prof.calls++;
        this._commitPlacement(sheet, part, normGeo, refined, bestAngle, inHole, bleed, spacing);
        if (!forcedAngles || forcedAngles[part.id] === undefined) {
            if (!sheet.minSearchYBySource) sheet.minSearchYBySource = new Map();
            sheet.minSearchYBySource.set(part.source, refined.y);
        }
        return true;
    }

    _commitPlacement(sheet, part, normGeo, refined, bestAngle, inHole, bleed, spacing) {
        const placedOuter = normGeo.normalizedOuter.map(p => ({
            x: +(p.x + refined.x).toFixed(4),
            y: +(p.y + refined.y).toFixed(4)
        }));

        const placedHoles = (normGeo.normalizedHoles || []).map(h => {
            return (h || []).map(p => ({
                x: +(p.x + refined.x).toFixed(4),
                y: +(p.y + refined.y).toFixed(4)
            }));
        });

        this.gpuEngine.stampPieceIntoSheetGPU(sheet.occupancy, placedOuter, placedHoles, bleed, spacing);

        // Flag inHole EXACTO por geometrÃ­a (el shader sÃ³lo rastrea 16 agujeros y con rejilla
        // gruesa deja de detectarlo). Se evalÃºa contra las piezas ya colocadas en la hoja.
        if (!inHole && placedHoles !== undefined) {
            const pb = this.gpuEngine.getPolygonBounds(placedOuter);
            for (const it of sheet.occupancy.placedItems) {
                if (!it.holes || it.holes.length === 0) continue;
                const ib = it.bounds || this.gpuEngine.getPolygonBounds(it.outer);
                if (pb.minX < ib.minX || pb.maxX > ib.maxX || pb.minY < ib.minY || pb.maxY > ib.maxY) continue;
                for (const h of it.holes) {
                    if (this.gpuEngine.isPolygonInsidePolygon(placedOuter, h, spacing)) { inHole = true; break; }
                }
                if (inHole) break;
            }
        }

        const xComp = refined.x + normGeo.rotOffsetX;
        const yComp = refined.y + normGeo.rotOffsetY;

        sheet.placements.push({
            id: part.id,
            source: part.source,
            filename: part.filename,
            source_path: part.source_path,
            image_data_url: part.image_data_url,
            orig_bounds: part.bounds,
            x: +xComp.toFixed(4),
            y: +yComp.toFixed(4),
            rotation: bestAngle,
            inHole: inHole,
            placedOuter: placedOuter,
            placedHoles: placedHoles,
            sheetIndex: sheet.index,
            sheetBounds: {
                minX: +refined.x.toFixed(4),
                minY: +refined.y.toFixed(4),
                maxX: +(refined.x + normGeo.widthMm).toFixed(4),
                maxY: +(refined.y + normGeo.heightMm).toFixed(4)
            }
        });

        sheet.netArea += part.area;
        sheet.usedArea += part.area;

        const bounds = this.gpuEngine.getPolygonBounds(placedOuter);
        if (bounds.maxY > sheet.maxY) {
            sheet.maxY = bounds.maxY;
        }
    }

    /**
     * CompactaciÃ³n por gravedad con geometrÃ­a EXACTA (no muestreo de contorno).
     * Baja cada grupo (pieza + piezas anidadas en sus huecos, que se mueven rÃ­gidamente)
     * hasta tocar lo ya asentado, usando polygonsIntersect + polygonMinDistance para
     * garantizar separaciÃ³n >= spacing y CERO solapes de material. Reduce la longitud de
     * bobina cerrando los huecos verticales que deja el empaquetado greedy.
     */
    _compactSheetExact(sheet, spacing) {
        const gpu = this.gpuEngine;
        const P = sheet.placements;
        const n = P.length;
        if (!P || n < 2) return 0;
        const W = sheet.occupancy.sheetWidthMm;

        const curB = new Map();
        for (const p of P) curB.set(p, gpu.getPolygonBounds(p.placedOuter));

        // 1) Agrupar anidamiento en huecos: una pieza dentro de un agujero baja con su contenedora.
        const parent = new Map();
        for (const p of P) {
            const b = curB.get(p);
            for (const a of P) {
                if (a === p || !a.placedHoles || a.placedHoles.length === 0) continue;
                let found = false;
                for (const h of a.placedHoles) {
                    const hb = gpu.getPolygonBounds(h);
                    if (b.minX >= hb.minX - 0.01 && b.maxX <= hb.maxX + 0.01 &&
                        b.minY >= hb.minY - 0.01 && b.maxY <= hb.maxY + 0.01 &&
                        gpu.isPolygonInsidePolygon(p.placedOuter, h, 0)) { parent.set(p, a); found = true; break; }
                }
                if (found) break;
            }
        }
        const rootOf = (p) => { let r = p, g = 0; while (parent.has(r) && g++ < 64) r = parent.get(r); return r; };
        const gmap = new Map();
        for (const p of P) { const r = rootOf(p); if (!gmap.has(r)) gmap.set(r, []); gmap.get(r).push(p); }
        const groups = [];
        for (const members of gmap.values()) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const m of members) {
                const b = curB.get(m);
                if (b.minX < minX) minX = b.minX; if (b.minY < minY) minY = b.minY;
                if (b.maxX > maxX) maxX = b.maxX; if (b.maxY > maxY) maxY = b.maxY;
            }
            groups.push({ members, set: new Set(members), minX, minY, maxX, maxY });
        }
        groups.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));

        // Comprueba un desplazamiento dy del grupo contra TODAS las demÃ¡s piezas (asentadas y
        // pendientes, en su posiciÃ³n actual). GeometrÃ­a EXACTA => cero solapes.
        const collides = (grp, dy) => {
            for (const m of grp.members) {
                const b = curB.get(m);
                const cminY = b.minY + dy, cmaxY = b.maxY + dy;
                if (cminY < spacing - 1e-6) return true;
                if (b.minX < spacing - 1e-6 || b.maxX > W - spacing + 1e-6) return true;
                const cand = m.placedOuter.map(q => ({ x: q.x, y: q.y + dy }));
                for (const o of P) {
                    if (grp.set.has(o)) continue;
                    const ob = curB.get(o);
                    if (b.maxX <= ob.minX - spacing || b.minX >= ob.maxX + spacing ||
                        cmaxY <= ob.minY - spacing || cminY >= ob.maxY + spacing) continue;
                    if (gpu.polygonsIntersect(cand, o.placedOuter)) return true;
                    if (gpu.polygonMinDistance(cand, o.placedOuter, spacing) < spacing - 1e-6) return true;
                }
            }
            return false;
        };

        let moved = 0;
        for (const g of groups) {
            const maxDown = g.minY - spacing;
            let dy = 0;
            if (maxDown > 0.05) {
                const step = 2.0;
                let d = 0, lastGood = 0, hit = false;
                while (d < maxDown - 1e-9) {
                    const nd = Math.min(maxDown, d + step);
                    if (collides(g, -nd)) { hit = true; d = nd; break; }
                    d = nd; lastGood = nd;
                }
                if (hit) {
                    let lo = lastGood, hi = d;
                    for (let it = 0; it < 5; it++) {
                        const mid = (lo + hi) * 0.5;
                        if (collides(g, -mid)) hi = mid; else lo = mid;
                    }
                    dy = -lo;
                } else {
                    dy = -lastGood;
                }
            }
            if (dy < -1e-3) {
                for (const m of g.members) {
                    for (const q of m.placedOuter) q.y += dy;
                    if (m.placedHoles) for (const h of m.placedHoles) for (const q of h) q.y += dy;
                    if (m.sheetBounds) { m.sheetBounds.minY += dy; m.sheetBounds.maxY += dy; }
                    if (typeof m.y === 'number') m.y = +(m.y + dy).toFixed(4);
                    curB.set(m, gpu.getPolygonBounds(m.placedOuter));
                }
                g.minY += dy; g.maxY += dy;
                moved++;
            }
        }

        let my = 0;
        for (const p of P) { const b = gpu.getPolygonBounds(p.placedOuter); if (b.maxY > my) my = b.maxY; }
        sheet.maxY = my;
        return moved;
    }

    /**
     * LNS (Large Neighborhood Search) sobre el layout YA construido.
     * La longitud de bobina la determinan las piezas de la cola. En cada ronda se retiran las
     * piezas con mayor maxY (mÃ¡s una muestra de la banda superior), se reconstruye la rejilla de
     * ocupaciÃ³n y se recolocan con la bÃºsqueda angular completa: el decodificador greedy las
     * llevarÃ¡ al hueco mÃ¡s bajo disponible, cerrando la bolsa vacÃ­a que dejaron. Se acepta sÃ³lo
     * si la longitud de bobina baja. Esto aporta seÃ±al real donde el GA de orden es plano.
     */
    _clonePlacements(pls) {
        return (pls || []).map(pl => ({
            ...pl,
            placedOuter: pl.placedOuter.map(q => ({ x: q.x, y: q.y })),
            placedHoles: (pl.placedHoles || []).map(h => h.map(q => ({ x: q.x, y: q.y }))),
            sheetBounds: pl.sheetBounds ? { ...pl.sheetBounds } : pl.sheetBounds
        }));
    }

    async _lnsPolish(sheet, parts, sheetW, sheetH, spacing, bleed, forcedAngles, opts = {}) {
        if (!sheet || !sheet.placements || sheet.placements.length < 8) return 0;
        const occ = sheet.occupancy;
        const mode = opts.mode || 'tail';
        const partById = new Map();
        const partByFile = new Map();
        for (const p of parts) {
            partById.set(p.id, p);
            partByFile.set(`${p.filename}|${p.source}`, p);
        }
        const resolvePart = (pl) => {
            const byId = partById.get(pl.id);
            if (byId && byId.filename === pl.filename) return byId;
            return partByFile.get(`${pl.filename}|${pl.source}`) || byId || null;
        };

        const refreshStats = () => {
            let used = 0, my = 0;
            for (const pl of sheet.placements) {
                const part = resolvePart(pl);
                if (part) used += (part.area || 0);
                const b = pl.sheetBounds || this.gpuEngine.getPolygonBounds(pl.placedOuter);
                if (b.maxY > my) my = b.maxY;
            }
            sheet.usedArea = used;
            sheet.netArea = used;
            sheet.maxY = my;
        };

        const before = this._scoreLayout(sheet);
        const fullPlacements = sheet.placements.slice();
        const deadline = (opts.maxMs && opts.maxMs > 0) ? Date.now() + opts.maxMs : Infinity;

        let keep = null;
        let victims = null;
        if (mode === 'tail') {
            const tail = sheet._tail;
            if (!tail) return 0;
            sheet._tail = null;
            keep = fullPlacements.slice(0, tail.placementCount);
            victims = fullPlacements.slice(tail.placementCount);
        } else {
            // RUIN & RECREATE ALEATORIO: cualquier pieza del layout puede ser vÃ­ctima.
            const k = Math.max(4, Math.min(opts.maxCount || 45, Math.round(fullPlacements.length * (opts.fraction || 0.30))));
            const chosen = new Set();
            if (opts.biasTop) {
                // Sesgo a la franja superior: son las piezas que fijan maxY. Si no se tocan,
                // ninguna reordenaciÃ³n puede reducir la longitud de bobina.
                const byTop = fullPlacements.map((pl, i) => ({
                    i,
                    y: (pl.sheetBounds || this.gpuEngine.getPolygonBounds(pl.placedOuter)).maxY
                })).sort((a, b) => b.y - a.y);
                const kTop = Math.min(byTop.length, Math.max(1, Math.round(k * 0.65)));
                for (let t = 0; t < kTop; t++) chosen.add(byTop[t].i);
            }
            while (chosen.size < Math.min(k, fullPlacements.length)) {
                chosen.add(Math.floor(this._rand() * fullPlacements.length));
            }
            keep = [];
            victims = [];
            for (let i = 0; i < fullPlacements.length; i++) {
                if (chosen.has(i)) victims.push(fullPlacements[i]);
                else keep.push(fullPlacements[i]);
            }
        }
        if (!victims || victims.length === 0) return 0;

        const victimParts = [];
        for (const v of victims) { const part = resolvePart(v); if (part) victimParts.push(part); }
        if (victimParts.length === 0) return 0;
        victimParts.sort((a, b) => (a.area || 0) - (b.area || 0));

        const restoreFull = () => {
            sheet.placements = fullPlacements;
            this._rebuildOccupancy(sheet, fullPlacements, bleed, spacing);
            refreshStats();
        };

        // Deja la rejilla y la rejilla analÃ­tica EXACTAMENTE con las piezas que se conservan.
        this._rebuildOccupancy(sheet, keep, bleed, spacing);
        sheet.placements = keep.slice();
        refreshStats();

        for (const part of victimParts) {
            if (this.aborted) { restoreFull(); return 0; }
            if (Date.now() > deadline) { restoreFull(); return 0; }
            let ok = await this._tryPlaceOnSheet(sheet, part, sheetW, sheet.height, spacing, bleed, forcedAngles, false);
            if (!ok) ok = await this._tryPlaceOnSheet(sheet, part, sheetW, sheet.height, spacing, bleed, forcedAngles, true);
            if (!ok) { restoreFull(); return 0; }
        }
        this._compactSheetExact(sheet, spacing);
        const after = this._scoreLayout(sheet);
        if (after < before - 0.01) return 1;
        restoreFull();
        return 0;
    }

    // PuntuaciÃ³n fina del layout: longitud de bobina + desempate por Î£ topY.
    // Permite aceptar mejoras reales de compactaciÃ³n que no cambian maxY.
    _scoreLayout(sheet) {
        let sumTop = 0;
        let my = 0;
        for (const pl of sheet.placements) {
            const b = pl.sheetBounds || this.gpuEngine.getPolygonBounds(pl.placedOuter);
            sumTop += b.maxY;
            if (b.maxY > my) my = b.maxY;
        }
        return my + 1e-4 * sumTop;
    }

    // Reconstruye la rejilla de ocupaciÃ³n desde cero con un conjunto de colocaciones.
    _rebuildOccupancy(sheet, placements, bleed, spacing) {
        const occ = sheet.occupancy;
        occ.grid.fill(0);
        occ.placedItems.length = 0;
        occ.maxPlacedY = 0;
        for (const pl of placements) {
            this.gpuEngine.stampPieceIntoSheetGPU(occ, pl.placedOuter, pl.placedHoles || [], bleed, spacing, true);
        }
        this.gpuEngine.uploadOccupancyGrid(occ);
    }

    // Pulido profundo: varias rondas de ruin & recreate aleatorio. Se usa sÃ³lo cuando
    // el GA lleva generaciones estancado (ver evaluatePlacementGPU).
    async _deepLns(sheet, parts, sheetW, sheetH, spacing, bleed, forcedAngles, rounds, fraction) {
        let gained = 0;
        const nPieces = sheet.placements.length;
        const maxCount = Math.max(16, Math.min(60, Math.round(nPieces * 0.5)));
        const deadline = Date.now() + (rounds || 1) * 400;
        for (let r = 0; r < rounds; r++) {
            if (this.aborted) break;
            if (Date.now() > deadline) break;
            const ok = await this._lnsPolish(sheet, parts, sheetW, sheetH, spacing, bleed, forcedAngles, {
                mode: 'random',
                fraction: Math.min(0.6, fraction + 0.10 * r),
                maxCount,
                maxMs: 400
            });
            if (!ok) break;
            gained++;
        }
        return gained;
    }

    // Coloca un lote de piezas en una Ãºnica hoja (usado por el modo Bobina Continua).
    async _placeAll(sheet, parts, sheetW, sheetH, spacing, bleed, forcedAngles) {
        const unplaced = [];
        const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let lastYieldTime = nowMs();
        // CHECKPOINT DE COLA: copia de la rejilla de ocupaciÃ³n justo antes de estampar el Ãºltimo
        // 15% de las piezas. Permite al LNS "deshacer" la cola sin reconstruir la rejilla pieza a
        // pieza (coste ~2 ms frente a ~3 s).
        const kTail = Math.max(6, Math.min(45, Math.round(parts.length * 0.30)));
        const tailAt = Math.max(0, parts.length - kTail);
        sheet._tail = null;
        let lastProgMs = nowMs();
        // CachÃ© de rechazo por origen (ver createSheetState): evita reevaluar 90 veces la
        // misma geometrÃ­a cuando ya no cabe. SÃ³lo aplica con Ã¡ngulo LIBRE.
        const rejected = sheet.rejectedSources || (sheet.rejectedSources = new Set());

        for (let i = 0; i < parts.length; i++) {
            if (i === tailAt) {
                sheet._tail = {
                    placedCount: sheet.occupancy.placedItems.length,
                    placementCount: sheet.placements.length
                };
            }
            // TelemetrÃ­a intra-generaciÃ³n: con lotes grandes una generaciÃ³n puede tardar
            // decenas de segundos y la UI parece congelada si sÃ³lo se emite al terminar.
            if (nowMs() - lastProgMs > 500.0) {
                lastProgMs = nowMs();
                const br = this.bestResult;
                this.emit('progress', {
                    generation: this.generationCount,
                    generationsCompleted: this.generationsCompleted,
                    bestFitness: this.bestFitness,
                    currentFitness: null,
                    utilisation: br ? br.utilisation : null,
                    bestRollLengthMm: br ? br.totalPaperLengthMm : null,
                    sheetsUsed: br ? br.sheets.length : 1,
                    placedCount: i + 1,
                    totalCount: parts.length,
                    isNewBest: false,
                    inProgress: true
                });
            }
            if (nowMs() - lastYieldTime > 12.0) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (this.aborted) return null;
                lastYieldTime = nowMs();
            }
            const freeAngle = (forcedAngles[parts[i].id] === undefined);
            const nKey = parts[i].source + '_N';
            if (freeAngle && rejected.has(nKey)) {
                unplaced.push(parts[i]);
                continue;
            }
            const ok = await this._tryPlaceOnSheet(sheet, parts[i], sheetW, sheetH, spacing, bleed, forcedAngles, false);
            if (!ok) {
                unplaced.push(parts[i]);
                if (freeAngle) rejected.add(nKey);
            }
        }


        return {
            placed: sheet.placements,
            unplaced: unplaced
        };
    }

    calculatePolygonArea(poly) {
        if (!poly || poly.length < 3) return 0;
        let sum = 0.0;
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            sum += (poly[i].x * poly[j].y - poly[j].x * poly[i].y);
        }
        return Math.abs(sum) / 2.0;
    }

    calculateNetPolygonArea(outerPoly, holes = []) {
        let net = Math.abs(this.calculatePolygonArea(outerPoly));
        if (holes && holes.length > 0) {
            for (const h of holes) {
                net -= Math.abs(this.calculatePolygonArea(h));
            }
        }
        return Math.max(0, net);
    }

    auditZeroOverlaps(placements, allPolygons = null, spacingMm = 0) {
        const n = placements.length;
        for (let i = 0; i < n; i++) {
            const pA = placements[i];
            const polyA = pA.placedOuter;
            const holesA = pA.placedHoles || [];

            for (let j = i + 1; j < n; j++) {
                const pB = placements[j];
                const polyB = pB.placedOuter;
                const holesB = pB.placedHoles || [];

                if (pA.sheetBounds && pB.sheetBounds) {
                    if (pA.sheetBounds.maxX < pB.sheetBounds.minX ||
                        pA.sheetBounds.minX > pB.sheetBounds.maxX ||
                        pA.sheetBounds.maxY < pB.sheetBounds.minY ||
                        pA.sheetBounds.minY > pB.sheetBounds.maxY) {
                        continue;
                    }
                }

                if (polyA && polyB && this.gpuEngine.polygonsIntersect(polyA, polyB)) {
                    // El anidamiento legÃ­timo se juzga por GEOMETRÃA: que una pieza estÃ©
                    // completamente dentro de un agujero de la otra. No se depende del flag
                    // inHole (el shader sÃ³lo rastrea 16 agujeros y con rejilla gruesa falla).
                    let legitimateHole = false;
                    if (holesA && holesA.length > 0) {
                        for (const hole of holesA) {
                            if (this.gpuEngine.isPolygonInsidePolygon(polyB, hole, 0)) {
                                legitimateHole = true;
                                break;
                            }
                        }
                    }
                    if (!legitimateHole && holesB && holesB.length > 0) {
                        for (const hole of holesB) {
                            if (this.gpuEngine.isPolygonInsidePolygon(polyA, hole, 0)) {
                                legitimateHole = true;
                                break;
                            }
                        }
                    }

                    if (!legitimateHole) {
                        throw new Error(`[AUDIT FATAL] SOLAPAMIENTO: Pieza ID=${pA.id} (${pA.filename}) y Pieza ID=${pB.id} (${pB.filename}) colisionan.`);
                    }
                }
            }
        }
        return true;
    }

    stop() {
        this.working = false;
        this.aborted = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.timerId) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    reset() {
        this.stop();
        this.bestFitness = 1e15;
        this.bestOrder = null;
        this.bestAngles = null;
        this.bestAngleById = new Map();
        this.bestResult = null;
        this.currentPlacements = [];
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CoreNestingEngine };
} else {
    window.CoreNestingEngine = CoreNestingEngine;
}



