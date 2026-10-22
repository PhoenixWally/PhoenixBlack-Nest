/**
 * Universal Hardware Abstraction Layer (HAL) & GPU Compute Engine
 * Next-Gen Industrial Nesting Core - PhoenixBlackNest
 * 
 * Implementa:
 * 1. WebGL2 GPU Compute Shaders con ReducciÃ³n JerÃ¡rquica Ping-Pong a 1x1 (RGBA32F + gl.NEAREST + Math.ceil).
 * 2. Conservative Rasterization & 2D Bit-Grid Occupancy Engine.
 * 3. Hole Nesting nativo: Las piezas huecas (donuts/anillos) limpian sus cavidades a 0.
 * 4. Exact Polygon Slide-to-Contact en Float64 con Hard Boundary Clamp durante deslizamiento.
 * 5. NormalizaciÃ³n CanÃ³nica de RotaciÃ³n (PolÃ­gono exterior y agujeros sincronizados al 0.001 mm).
 */

class GpuDetector {
    static detect() {
        let detected = {
            vendor: 'CPU',
            model: 'Procesador Principal (CPU Multihilo)',
            backend: 'cpu',
            supportedBackends: ['cpu'],
            webgpu: typeof navigator !== 'undefined' && !!navigator.gpu
        };

        try {
            let canvas = null;
            if (typeof OffscreenCanvas !== 'undefined') {
                canvas = new OffscreenCanvas(256, 256);
            } else if (typeof document !== 'undefined') {
                canvas = document.createElement('canvas');
            }

            if (canvas) {
                const gl = canvas.getContext('webgl2', { antialias: false, depth: false }) || canvas.getContext('webgl');
                if (gl) {
                    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';
                    const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : '';
                    const fullString = `${vendor} ${renderer}`.toLowerCase();

                    if (fullString.includes('nvidia') || fullString.includes('geforce') || fullString.includes('rtx')) {
                        detected.vendor = 'NVIDIA';
                        detected.model = renderer || 'NVIDIA GeForce / RTX Series';
                        detected.backend = 'cuda';
                        detected.supportedBackends = ['cuda', 'gpgpu_shader', 'cpu'];
                    } else if (fullString.includes('intel') || fullString.includes('arc') || fullString.includes('iris') || fullString.includes('xe')) {
                        detected.vendor = 'Intel';
                        detected.model = renderer || 'Intel Arc Graphics (Direct3D11/Vulkan)';
                        detected.backend = 'gpgpu_shader';
                        detected.supportedBackends = ['gpgpu_shader', 'cpu'];
                    } else if (fullString.includes('amd') || fullString.includes('radeon')) {
                        detected.vendor = 'AMD';
                        detected.model = renderer || 'AMD Radeon Graphics';
                        detected.backend = 'gpgpu_shader';
                        detected.supportedBackends = ['gpgpu_shader', 'cpu'];
                    } else if (renderer) {
                        detected.vendor = 'Universal GPU';
                        detected.model = renderer;
                        detected.backend = 'gpgpu_shader';
                        detected.supportedBackends = ['gpgpu_shader', 'cpu'];
                    }
                }
            }
        } catch (e) {
            console.warn('[GPU Detector] Consulta de hardware grÃ¡fico:', e);
        }

        return detected;
    }
}

class UniversalGpuNestingEngine {
    constructor(options = {}) {
        this.device = GpuDetector.detect();
        this.pixelSizeMm = options.pixelSizeMm || 0.5; // 0.5 mm por celda
        this.bleedMm = options.bleedMm || 0.0;
        this.spacingMm = options.spacingMm || 0.0;

        this.canvas = null;
        this.gl = null;
        if (typeof OffscreenCanvas !== 'undefined') {
            this.canvas = new OffscreenCanvas(1024, 1024);
        } else if (typeof document !== 'undefined') {
            this.canvas = document.createElement('canvas');
            this.canvas.width = 1024;
            this.canvas.height = 1024;
        }

        if (this.canvas) {
            this.gl = this.canvas.getContext('webgl2', {
                antialias: false,
                depth: false,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            });
        }

        this.initialized = !!this.gl;
        if (this.initialized) {
            // AJUSTE 2: ActivaciÃ³n estricta de extensiones flotantes
            this.extFloat = this.gl.getExtension('EXT_color_buffer_float');
            this.extFloatLinear = this.gl.getExtension('OES_texture_float_linear');
            this.initShaders();
            // Capacidad de las texturas de evaluaciÃ³n: X de la bobina a ~0.5 mm/celda.
            // Se necesita 2048 de ancho para que un lote de 8 Ã¡ngulos conserve >=256 px
            // horizontales por franja (antes 16 franjas sobre 1024 = 15.6 mm/px, lo que
            // perdÃ­a huecos y disparaba el fallback de CPU a ~12 s/generaciÃ³n).
            this.EVAL_MAX_W = 2048;
            this.EVAL_MAX_H = 1024;
            // Los buffers de reducción (ping-pong) deben tener el MISMO tamaño que el FBO de
            // evaluación: la pirámide escala sus UVs por (curW/capW, curH/capH), de modo que si
            // el destino es más estrecho que el origen, cada nivel lee solo una fracción de la
            // franja y se pierde el mínimo global (síntoma: cribado ciego, layouts al 45 %).
            this.initPingPongBuffers(this.EVAL_MAX_W, this.EVAL_MAX_H, this.EVAL_MAX_W, this.EVAL_MAX_H);
        }
        // OPT-1 (fail-fast): resolución de la pasada de cribado. Con 2 el shader evalúa la
        // mitad de posiciones candidatas por eje (4× menos trabajo) y el refino analítico
        // posterior (refineSlideToContact) recupera la posición exacta al contacto.
        this.evalScaleX = Math.max(1, parseInt(process.env.PBN_EVAL_SCALE_X || '1', 10));
        this.evalScaleY = Math.max(1, parseInt(process.env.PBN_EVAL_SCALE_Y || '1', 10));
        this.stats = { batchCalls: 0, batchMs: 0, reduceMs: 0, readMs: 0, readBytes: 0 };
        console.log(`[Next-Gen GPU Engine] Inicializado backend: ${this.device.backend} (${this.device.model})`);
    }

    initShaders() {
        const gl = this.gl;
        if (!gl) return;

        const vsSource = `#version 300 es
        in vec2 a_pos;
        out vec2 v_uv;
        void main() {
            v_uv = (a_pos + 1.0) * 0.5;
            gl_Position = vec4(a_pos, 0.0, 1.0);
        }`;

        // Shader de EvaluaciÃ³n de Coste y ColisiÃ³n (True Shape Sample-Points + Spacing Buffer + Roll-Feed Fitness + Cavidades)
        const fsEvaluateSource = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragOutput; // R: Coste, G: X_norm, B: Y_norm, A: InHole flag (1.0 = hueco, 0.0 = lienzo)

        uniform sampler2D u_sheet_grid;
        uniform vec2 u_sheet_dim_mm;
        uniform vec2 u_piece_dim_mm;
        uniform vec2 u_spacing_mm;
        uniform int u_roll_direction; // 0 = Avance en Y, 1 = Avance en X

        uniform int u_num_samples;
        uniform int u_num_perim;   // los primeros u_num_perim puntos son del contorno exterior
        uniform vec2 u_sample_points[96];
        uniform float u_max_eval_y; // cota superior exacta de evaluación (frontera + margen)

        uniform int u_num_holes;
        uniform vec4 u_holes[16]; // vec4(minX, minY, maxX, maxY) en mm

        // BUG 2 FIX: muestra el grid en el punto exacto MÃS las 4 direcciones cardinales
        // a distancia spacing para garantizar el colchÃ³n de separaciÃ³n en VRAM.
        bool sampleOccupied(vec2 pt_mm) {
            vec2 uv = pt_mm / u_sheet_dim_mm;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return true; // fuera de bobina = bloqueado
            if (texture(u_sheet_grid, uv).r > 0.001) return true;
            return false;
        }

        void main() {
            vec2 cand_coord_mm = v_uv * u_sheet_dim_mm;
            
            // LÃ­mite duro de bobina respetando spacing
            if (cand_coord_mm.x < u_spacing_mm.x || 
                cand_coord_mm.y < u_spacing_mm.y ||
                cand_coord_mm.x + u_piece_dim_mm.x > (u_sheet_dim_mm.x - u_spacing_mm.x) ||
                cand_coord_mm.y + u_piece_dim_mm.y > (u_sheet_dim_mm.y - u_spacing_mm.y)) {
                fragOutput = vec4(1.0e9, v_uv.x, v_uv.y, 0.0);
                return;
            }

            // PODA EXACTA: por encima de la frontera + alto de pieza + 3*spacing el coste
            // (x + 10*(y+alto)) siempre es mayor que la posición factible pegada a la frontera,
            // así que ningún píxel de esa banda puede ganar el min-pooling.
            if (cand_coord_mm.y > u_max_eval_y) {
                fragOutput = vec4(1.0e9, v_uv.x, v_uv.y, 0.0);
                return;
            }

            // Test de colisiÃ³n True Shape con buffer de spacing garantizado
            // Para cada punto de muestra del contorno de la pieza se comprueban
            // el punto exacto + desplazamientos en las 4 direcciones Ã— spacing.
            float collides = 0.0;
            for (int i = 0; i < 96; i++) {
                if (i >= u_num_samples) break;
                vec2 sp = cand_coord_mm + u_sample_points[i];

                // Centro del punto
                if (sampleOccupied(sp)) { collides = 1.0; break; }
                // Halo de spacing SOLO en el contorno: los puntos interiores están rodeados por
                // el perímetro, que ya ha aplicado el halo (1 lectura en vez de 5).
                if (i < u_num_perim) {
                    if (sampleOccupied(sp + vec2( u_spacing_mm.x, 0.0))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(-u_spacing_mm.x, 0.0))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(0.0,  u_spacing_mm.y))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(0.0, -u_spacing_mm.y))) { collides = 1.0; break; }
                }
            }

            if (collides > 0.5) {
                fragOutput = vec4(1.0e9, v_uv.x, v_uv.y, 0.0);
                return;
            }

            // DetecciÃ³n de alojamiento en cavidad interior (Hole Nesting)
            float in_hole = 0.0;
            for (int h = 0; h < 16; h++) {
                if (h >= u_num_holes) break;
                vec4 hb = u_holes[h];
                if (cand_coord_mm.x >= hb.x && cand_coord_mm.y >= hb.y &&
                    (cand_coord_mm.x + u_piece_dim_mm.x) <= hb.z &&
                    (cand_coord_mm.y + u_piece_dim_mm.y) <= hb.w) {
                    in_hole = 1.0;
                    break;
                }
            }

            float cost = 0.0;
            {
                // El coste SIEMPRE minimiza el avance de bobina. Las colocaciones en cavidad
                // reciben sÃ³lo un descuento (15%) para preferirlas a igual posiciÃ³n; NUNCA un
                // coste plano (x*0.1+y*0.1) que permitÃ­a saltar a lo alto dejando huecos abajo.
                float trans_cost = (u_roll_direction == 0) ? cand_coord_mm.x : cand_coord_mm.y;
                float roll_advance = (u_roll_direction == 0) ? (cand_coord_mm.y + u_piece_dim_mm.y) : (cand_coord_mm.x + u_piece_dim_mm.x);
                float base = (trans_cost * 1.0) + (roll_advance * 10.0) + (roll_advance * roll_advance * 0.05);
                cost = (in_hole > 0.5) ? (base * 0.85) : base;
            }

            fragOutput = vec4(cost, v_uv.x, v_uv.y, in_hole);
        }`;

        // Shader de EvaluaciÃ³n MULTI-ÃNGULO POR LOTES (True Shape, hasta 4 rotaciones por pase).
        // Cada Ã¡ngulo ocupa una franja vertical (tile) del mismo FBO â†’ 1 render para K Ã¡ngulos.
        const fsEvaluateBatchSource = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragOutput;

        uniform sampler2D u_sheet_grid;
        uniform vec2 u_sheet_dim_mm;
        uniform vec2 u_spacing_mm;
        uniform int u_roll_direction;

        uniform int u_num_samples;
        uniform vec2 u_sample_points[96];   // muestras LOCALES canÃ³nicas (sin rotar)
        uniform int u_num_perim;
        uniform float u_max_eval_y;

        uniform int u_num_holes;
        uniform vec4 u_holes[16];

        uniform int u_num_angles;
        uniform float u_ang_cos[16];
        uniform float u_ang_sin[16];
        uniform vec2 u_ang_off[16];
        uniform vec2 u_ang_dim[16];

        bool sampleOccupied(vec2 pt_mm) {
            vec2 uv = pt_mm / u_sheet_dim_mm;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return true;
            if (texture(u_sheet_grid, uv).r > 0.001) return true;
            return false;
        }

        void main() {
            float fx = v_uv.x * float(u_num_angles);
            int k = int(floor(fx));
            if (k < 0) k = 0;
            if (k >= u_num_angles) k = u_num_angles - 1;
            float lx = clamp(fx - float(k), 0.0, 0.999999);

            // Cada franja k explora SU ventana de X (k/n .. (k+1)/n) con su propio angulo:
            // asi los n angulos cubren todo el ancho sin colapsar al mismo X.
            float gxGlobal = lx;
            vec2 cand_coord_mm = vec2(gxGlobal, v_uv.y) * u_sheet_dim_mm;
            vec2 dim = u_ang_dim[k];
            if (cand_coord_mm.x < u_spacing_mm.x || cand_coord_mm.y < u_spacing_mm.y ||
                cand_coord_mm.x + dim.x > (u_sheet_dim_mm.x - u_spacing_mm.x) ||
                cand_coord_mm.y + dim.y > (u_sheet_dim_mm.y - u_spacing_mm.y)) {
                fragOutput = vec4(1.0e9, gxGlobal, v_uv.y, 0.0);
                return;
            }
            // PODA EXACTA: coste = x + 10*(y+dim.y) + 0.05*(y+dim.y)^2. Como por encima de la
            // frontera la banda está 100% vacía, siempre existe una posición factible pegada a
            // ella (coste <= W + 10*frontera); cualquier y > frontera + dim.y + 3*spacing queda
            // por encima de ese coste. Cortar esa banda no puede cambiar el mínimo.
            if (cand_coord_mm.y > u_max_eval_y) {
                fragOutput = vec4(1.0e9, lx, v_uv.y, 0.0);
                return;
            }

            float cs = u_ang_cos[k];
            float sn = u_ang_sin[k];
            vec2 off = u_ang_off[k];

            float collides = 0.0;
            for (int i = 0; i < 96; i++) {
                if (i >= u_num_samples) break;
                vec2 sp0 = u_sample_points[i];
                vec2 rp = vec2(sp0.x * cs - sp0.y * sn, sp0.x * sn + sp0.y * cs) + off;
                vec2 sp = cand_coord_mm + rp;
                if (sampleOccupied(sp)) { collides = 1.0; break; }
                // Halo cardinal sólo para el contorno exterior (i < u_num_perim): los puntos
                // interiores ya están rodeados por el perímetro y su halo.
                if (i < u_num_perim) {
                    if (sampleOccupied(sp + vec2( u_spacing_mm.x, 0.0))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(-u_spacing_mm.x, 0.0))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(0.0,  u_spacing_mm.y))) { collides = 1.0; break; }
                    if (sampleOccupied(sp + vec2(0.0, -u_spacing_mm.y))) { collides = 1.0; break; }
                }
            }
            if (collides > 0.5) { fragOutput = vec4(1.0e9, lx, v_uv.y, 0.0); return; }

            float in_hole = 0.0;
            for (int h = 0; h < 16; h++) {
                if (h >= u_num_holes) break;
                vec4 hb = u_holes[h];
                if (cand_coord_mm.x >= hb.x && cand_coord_mm.y >= hb.y &&
                    (cand_coord_mm.x + dim.x) <= hb.z &&
                    (cand_coord_mm.y + dim.y) <= hb.w) {
                    in_hole = 1.0;
                    break;
                }
            }

            float cost = 0.0;
            {
                float trans_cost = (u_roll_direction == 0) ? cand_coord_mm.x : cand_coord_mm.y;
                float roll_advance = (u_roll_direction == 0) ? (cand_coord_mm.y + dim.y) : (cand_coord_mm.x + dim.x);
                float base = (trans_cost * 1.0) + (roll_advance * 10.0) + (roll_advance * roll_advance * 0.05);
                cost = (in_hole > 0.5) ? (base * 0.85) : base;
            }
            fragOutput = vec4(cost, gxGlobal, v_uv.y, in_hole);
        }`;

        // Shader de ReducciÃ³n JerÃ¡rquica Min-Pooling Piramidal Exacta
        const fsReduceSource = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 minOutput;
        uniform sampler2D u_prev_level;
        uniform vec2 u_src_scale;
        uniform vec2 u_texel_offset;
        uniform vec2 u_crop_origin;

        void main() {
            vec2 base_uv = u_crop_origin + v_uv * u_src_scale;
            vec4 c0 = texture(u_prev_level, base_uv + vec2(-u_texel_offset.x, -u_texel_offset.y));
            vec4 c1 = texture(u_prev_level, base_uv + vec2( u_texel_offset.x, -u_texel_offset.y));
            vec4 c2 = texture(u_prev_level, base_uv + vec2(-u_texel_offset.x,  u_texel_offset.y));
            vec4 c3 = texture(u_prev_level, base_uv + vec2( u_texel_offset.x,  u_texel_offset.y));

            vec4 best = c0;
            if (c1.r < best.r) best = c1;
            if (c2.r < best.r) best = c2;
            if (c3.r < best.r) best = c3;

            minOutput = best;
        }`;

        this.evalProgram = this.createProgram(vsSource, fsEvaluateSource);
        this.evalBatchProgram = this.createProgram(vsSource, fsEvaluateBatchSource);
        if (!gl.getProgramParameter(this.evalBatchProgram, gl.LINK_STATUS)) {
            console.warn('[GPU] Batch multi-Ã¡ngulo no disponible; usando ruta secuencial.');
            this.evalBatchProgram = null;
        }
        this.reduceProgram = this.createProgram(vsSource, fsReduceSource);

        this.evalUniforms = {
            u_sheet_grid: gl.getUniformLocation(this.evalProgram, 'u_sheet_grid'),
            u_sheet_dim_mm: gl.getUniformLocation(this.evalProgram, 'u_sheet_dim_mm'),
            u_piece_dim_mm: gl.getUniformLocation(this.evalProgram, 'u_piece_dim_mm'),
            u_spacing_mm: gl.getUniformLocation(this.evalProgram, 'u_spacing_mm'),
            u_roll_direction: gl.getUniformLocation(this.evalProgram, 'u_roll_direction'),
            u_num_samples: gl.getUniformLocation(this.evalProgram, 'u_num_samples'),
            u_num_perim: gl.getUniformLocation(this.evalProgram, 'u_num_perim'),
            u_max_eval_y: gl.getUniformLocation(this.evalProgram, 'u_max_eval_y'),
            u_sample_points: gl.getUniformLocation(this.evalProgram, 'u_sample_points'),
            u_num_holes: gl.getUniformLocation(this.evalProgram, 'u_num_holes'),
            u_holes: gl.getUniformLocation(this.evalProgram, 'u_holes')
        };

        this.evalBatchUniforms = {
            u_sheet_grid: gl.getUniformLocation(this.evalBatchProgram, 'u_sheet_grid'),
            u_sheet_dim_mm: gl.getUniformLocation(this.evalBatchProgram, 'u_sheet_dim_mm'),
            u_spacing_mm: gl.getUniformLocation(this.evalBatchProgram, 'u_spacing_mm'),
            u_roll_direction: gl.getUniformLocation(this.evalBatchProgram, 'u_roll_direction'),
            u_num_samples: gl.getUniformLocation(this.evalBatchProgram, 'u_num_samples'),
            u_num_perim: gl.getUniformLocation(this.evalBatchProgram, 'u_num_perim'),
            u_max_eval_y: gl.getUniformLocation(this.evalBatchProgram, 'u_max_eval_y'),
            u_sample_points: gl.getUniformLocation(this.evalBatchProgram, 'u_sample_points'),
            u_num_holes: gl.getUniformLocation(this.evalBatchProgram, 'u_num_holes'),
            u_holes: gl.getUniformLocation(this.evalBatchProgram, 'u_holes'),
            u_num_angles: gl.getUniformLocation(this.evalBatchProgram, 'u_num_angles'),
            u_ang_cos: gl.getUniformLocation(this.evalBatchProgram, 'u_ang_cos'),
            u_ang_sin: gl.getUniformLocation(this.evalBatchProgram, 'u_ang_sin'),
            u_ang_off: gl.getUniformLocation(this.evalBatchProgram, 'u_ang_off'),
            u_ang_dim: gl.getUniformLocation(this.evalBatchProgram, 'u_ang_dim')
        };

        const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
        this.quadVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    }

    createProgram(vsSrc, fsSrc) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);

        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error('[GPU] Error compilando fragment shader:', gl.getShaderInfoLog(fs));
        }

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('[GPU] Error enlazando programa:', gl.getProgramInfoLog(prog));
        }
        return prog;
    }

    /**
     * Inicializa los Framebuffers y texturas flotantes para el ping-pong de reducciÃ³n jerÃ¡rquica
     */
    initPingPongBuffers(width, height, evalWidth = width, evalHeight = height) {
        const gl = this.gl;
        if (!gl) return;

        this.fboA = gl.createFramebuffer();
        this.fboB = gl.createFramebuffer();
        this.fboEval = gl.createFramebuffer();

        this.texA = this.createFloatTexture(width, height);
        this.texB = this.createFloatTexture(width, height);
        this.texEval = this.createFloatTexture(evalWidth, evalHeight);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texA, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texB, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboEval);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texEval, 0);

        // FBO de resultados: acumula el mÃ­nimo 1x1 de cada Ã¡ngulo en una columna,
        // para leer TODOS los Ã¡ngulos con UN SOLO gl.readPixels (evita el stall por Ã¡ngulo).
        this.fboOut = gl.createFramebuffer();
        this.texOut = this.createFloatTexture(16, 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboOut);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texOut, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    createFloatTexture(width, height) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // AJUSTE 2: RGBA32F + gl.FLOAT + gl.NEAREST + gl.CLAMP_TO_EDGE
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    /**
     * AJUSTE 3: NormalizaciÃ³n CanÃ³nica de RotaciÃ³n
     * Rota la pieza y sus agujeros conjuntamente y traslada ambos por el mismo vector (-minX, -minY).
     * Devuelve el offset de normalizaciÃ³n para compensaciÃ³n exacta con el PDF exporter y el visor UI.
     */
    normalizeRotatedGeometry(polygon, holes = [], angleDeg = 0) {
        const rad = (angleDeg * Math.PI) / 180.0;
        const cosR = Math.cos(rad);
        const sinR = Math.sin(rad);

        // 1. Rotar polÃ­gono exterior
        const rotatedOuter = polygon.map(p => ({
            x: p.x * cosR - p.y * sinR,
            y: p.x * sinR + p.y * cosR
        }));

        // 2. LÃ­mites exactos del exterior
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const p of rotatedOuter) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        const rotOffsetX = -minX;
        const rotOffsetY = -minY;
        const widthMm = maxX - minX;
        const heightMm = maxY - minY;

        // 3. Normalizar exterior al origen (0, 0)
        const normalizedOuter = rotatedOuter.map(p => ({
            x: p.x + rotOffsetX,
            y: p.y + rotOffsetY
        }));

        // 4. Rotar y normalizar agujeros exactamente con el mismo vector rotOffsetX, rotOffsetY
        const normalizedHoles = (holes || []).map(hole => {
            return hole.map(p => {
                const rx = p.x * cosR - p.y * sinR;
                const ry = p.x * sinR + p.y * cosR;
                return {
                    x: rx + rotOffsetX,
                    y: ry + rotOffsetY
                };
            });
        });

        return {
            normalizedOuter: normalizedOuter,
            normalizedHoles: normalizedHoles,
            widthMm: widthMm,
            heightMm: heightMm,
            rotOffsetX: rotOffsetX,
            rotOffsetY: rotOffsetY,
            minX: minX,
            minY: minY
        };
    }

    createSheetOccupancyGrid(sheetWidthMm, sheetHeightMm) {
        // ResoluciÃ³n ADAPTATIVA: la rejilla (y la VRAM de la textura de ocupaciÃ³n) se acota
        // a MAX_DIM celdas por eje para que bobinas enormes (tras el auto-ajuste de bobina
        // para piezas con coordenadas crudas gigantes) no agoten la memoria. Para bobinas
        // normales sigue siendo 0.5 mm/celda.
        const MAX_DIM = 4096;
        const effPixel = Math.max(this.pixelSizeMm, sheetWidthMm / MAX_DIM, sheetHeightMm / MAX_DIM);
        const cols = Math.max(10, Math.ceil(sheetWidthMm / effPixel));
        const rows = Math.max(10, Math.ceil(sheetHeightMm / effPixel));
        const grid = new Uint8Array(cols * rows);
        const tex = this.gl ? this.createOccupancyTexture(cols, rows) : null;
        return {
            cols: cols,
            rows: rows,
            pixelSizeMm: effPixel,
            sheetWidthMm: sheetWidthMm,
            sheetHeightMm: sheetHeightMm,
            grid: grid,
            tex: tex,
            placedItems: [],
            maxPlacedY: 0
        };
    }

    createOccupancyTexture(cols, rows) {
        const gl = this.gl;
        if (!gl) return null;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const initialZero = new Uint8Array(cols * rows);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, initialZero);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    // Sube la rejilla completa a VRAM en UNA sola transferencia. Se usa tras estampar muchas
    // piezas con deferUpload=true (reconstrucciÃ³n de ocupaciÃ³n en LNS), evitando un flush por pieza.
    uploadOccupancyGrid(occupancy) {
        const gl = this.gl;
        if (!gl || !occupancy || !occupancy.tex) return;
        gl.bindTexture(gl.TEXTURE_2D, occupancy.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, occupancy.cols, occupancy.rows, gl.RED, gl.UNSIGNED_BYTE, occupancy.grid);
        gl.flush();
    }

    /**
     * Extiende una rejilla de ocupación ya estampada hacia arriba (bobina que necesita más
     * largo). Conserva el pixelSizeMm y todas las marcas existentes; sólo añade filas vacías.
     * Evita reconstruir la rejilla desde cero (y por tanto recolocar las piezas ya puestas).
     */
    extendSheetOccupancyGrid(occupancy, newHeightMm) {
        if (!occupancy) return occupancy;
        const h = Math.max(occupancy.sheetHeightMm, newHeightMm);
        const needRows = Math.max(10, Math.ceil(h / occupancy.pixelSizeMm));
        if (needRows <= occupancy.rows) {
            occupancy.sheetHeightMm = h;
            return occupancy;
        }
        const cols = occupancy.cols;
        const grid = new Uint8Array(cols * needRows);
        grid.set(occupancy.grid.subarray(0, Math.min(occupancy.grid.length, grid.length)));
        occupancy.grid = grid;
        occupancy.rows = needRows;
        occupancy.sheetHeightMm = h;
        if (this.gl) {
            if (occupancy.tex) this.gl.deleteTexture(occupancy.tex);
            occupancy.tex = this.createOccupancyTexture(cols, needRows);
            this.uploadOccupancyGrid(occupancy);
        }
        occupancy.placedItems = occupancy.placedItems || [];
        return occupancy;
    }

    stampPieceIntoSheetGPU(occupancy, rotatedTranslatedOuterPoly, rotatedTranslatedHoles = [], bleedMm = 0, spacingMm = 0, deferUpload = false) {
        // PARCHE 2: Margen de exclusiÃ³n pesimista conservador en VRAM
        const exclusionRadius = bleedMm + spacingMm + (occupancy.pixelSizeMm * 1.5);

        const bounds = this.getPolygonBounds(rotatedTranslatedOuterPoly);
        // Frontera estampada (poda exacta u_max_eval_y): techo real de la geometría marcada.
        if (!(bounds.maxY <= (occupancy.maxPlacedY || 0))) occupancy.maxPlacedY = bounds.maxY;
        const minC = Math.max(0, Math.floor((bounds.minX - exclusionRadius) / occupancy.pixelSizeMm));
        const maxC = Math.min(occupancy.cols - 1, Math.ceil((bounds.maxX + exclusionRadius) / occupancy.pixelSizeMm));
        const minR = Math.max(0, Math.floor((bounds.minY - exclusionRadius) / occupancy.pixelSizeMm));
        const maxR = Math.min(occupancy.rows - 1, Math.ceil((bounds.maxY + exclusionRadius) / occupancy.pixelSizeMm));

        // OPT-2D: rasterizado por SPANLINES. El estampado celda-a-celda con pointInPolygon
        // (O(celdas * aristas)) dominaba el coste de colocacion (~26 ms/pieza, cientos de ms en
        // texturas de muchos vertices). Aqui se calculan las intersecciones de cada fila con las
        // aristas (con bucketing en bandas de 32 filas) y se rellena por spans.
        // El margen de exclusion se aplica expandiendo cada span; sobre-marca esquinas
        // (< sqrt(2)*R), lo cual es conservador y no afecta a la validez geometrica final
        // (el chequeo analitico de refineSlideToContact es el autoritativo).
        const ps = occupancy.pixelSizeMm;
        const grid = occupancy.grid;
        const cols = occupancy.cols;
        const width = maxC - minC + 1;
        const bboxCells = (maxR - minR + 1) * width;

        const bucketInto = (target, poly, nBands, bandH) => {
            const n = poly.length;
            for (let i = 0; i < n; i++) {
                const a = poly[i], bb = poly[(i + 1) % n];
                if (a.y === bb.y) continue;
                const lo = Math.max(minR, Math.floor((Math.min(a.y, bb.y) - exclusionRadius) / ps));
                const hi = Math.min(maxR, Math.ceil((Math.max(a.y, bb.y) + exclusionRadius) / ps));
                if (hi < lo) continue;
                const b0 = Math.max(0, Math.floor((lo - minR) / bandH));
                const b1 = Math.min(nBands - 1, Math.floor((hi - minR) / bandH));
                for (let b = b0; b <= b1; b++) target[b].push(a.x, a.y, bb.x, bb.y);
            }
        };

        if (bboxCells < 20000) {
            const outerEdgeBounds = this._precomputeEdgeBounds(rotatedTranslatedOuterPoly);
            for (let r = minR; r <= maxR; r++) {
                const yMm = (r + 0.5) * ps;
                for (let c = minC; c <= maxC; c++) {
                    if (grid[r * cols + c] > 0) continue;
                    const xMm = (c + 0.5) * ps;
                    const pt = { x: xMm, y: yMm };
                    let insideHole = false;
                    if (rotatedTranslatedHoles && rotatedTranslatedHoles.length > 0) {
                        if (xMm >= bounds.minX && xMm <= bounds.maxX &&
                            yMm >= bounds.minY && yMm <= bounds.maxY) {
                            for (const hole of rotatedTranslatedHoles) {
                                if (this.pointInPolygon(pt, hole)) { insideHole = true; break; }
                            }
                        }
                    }
                    if (insideHole) continue;
                    if (this.pointInPolygon(pt, rotatedTranslatedOuterPoly)) {
                        grid[r * cols + c] = 255;
                        continue;
                    }
                    if (this._pointToPolygonMinDistanceFast(pt, rotatedTranslatedOuterPoly, outerEdgeBounds, exclusionRadius) <= exclusionRadius) {
                        grid[r * cols + c] = 255;
                    }
                }
            }
        } else {
            const bandH = 32;
            const nBands = Math.max(1, Math.ceil((maxR - minR + 1) / bandH));
            const bands = new Array(nBands);
            const holeBands = new Array(nBands);
            for (let b = 0; b < nBands; b++) { bands[b] = []; holeBands[b] = []; }
            bucketInto(bands, rotatedTranslatedOuterPoly, nBands, bandH);
            for (const hole of (rotatedTranslatedHoles || [])) {
                if (hole && hole.length >= 3) bucketInto(holeBands, hole, nBands, bandH);
            }

            // R_eff: medio pixel extra. El test por centro de celda del algoritmo viejo marcaba
            // ~1 celda mas en curvas; sin este margen la rejilla queda algo permisiva y el
            // refinamiento analitico rechaza posiciones, empeorando el empaquetado.
            const R_eff = exclusionRadius + ps * 0.5;
            const rowMask = new Uint8Array(width);
            const xs = [];
            for (let r = minR; r <= maxR; r++) {
                const b = Math.floor((r - minR) / bandH);
                const edges = bands[b];
                if (edges.length === 0) continue;
                let yMm = (r + 0.5) * ps;
                // Filas fuera del poligono (margen vertical de exclusion): usar la fila interior mas cercana.
                if (yMm < bounds.minY) yMm = bounds.minY + ps * 0.51;
                else if (yMm > bounds.maxY) yMm = bounds.maxY - ps * 0.51;
                xs.length = 0;
                for (let e = 0; e < edges.length; e += 4) {
                    const x1 = edges[e], y1 = edges[e + 1], x2 = edges[e + 2], y2 = edges[e + 3];
                    if ((y1 > yMm) !== (y2 > yMm)) xs.push(x1 + (yMm - y1) * (x2 - x1) / (y2 - y1));
                }
                if (xs.length < 2) continue;
                xs.sort((p, q) => p - q);
                rowMask.fill(0);
                let any = false;
                for (let i = 0; i + 1 < xs.length; i += 2) {
                    let c0 = Math.floor((xs[i] - R_eff) / ps) - minC;
                    let c1 = Math.ceil((xs[i + 1] + R_eff) / ps) - minC;
                    if (c1 < 0 || c0 > width - 1) continue;
                    if (c0 < 0) c0 = 0;
                    if (c1 > width - 1) c1 = width - 1;
                    for (let c = c0; c <= c1; c++) rowMask[c] = 1;
                    any = true;
                }
                if (!any) continue;
                const hedges = holeBands[b];
                if (hedges.length > 0) {
                    const hxs = [];
                    for (let e = 0; e < hedges.length; e += 4) {
                        const x1 = hedges[e], y1 = hedges[e + 1], x2 = hedges[e + 2], y2 = hedges[e + 3];
                        if ((y1 > yMm) !== (y2 > yMm)) hxs.push(x1 + (yMm - y1) * (x2 - x1) / (y2 - y1));
                    }
                    if (hxs.length >= 2) {
                        hxs.sort((p, q) => p - q);
                        for (let i = 0; i + 1 < hxs.length; i += 2) {
                            let c0 = Math.ceil((hxs[i] + R_eff) / ps) - minC;
                            let c1 = Math.floor((hxs[i + 1] - R_eff) / ps) - minC;
                            if (c0 < 0) c0 = 0;
                            if (c1 > width - 1) c1 = width - 1;
                            for (let c = c0; c <= c1; c++) rowMask[c] = 0;
                        }
                    }
                }
                const rowOff = r * cols + minC;
                for (let c = 0; c < width; c++) {
                    if (rowMask[c] && grid[rowOff + c] === 0) grid[rowOff + c] = 255;
                }
            }
        }

        // Guardar con bounds pre-calculados para AABB early-reject en refineSlideToContact
        occupancy.placedItems.push({
            outer: rotatedTranslatedOuterPoly,
            holes: rotatedTranslatedHoles || [],
            bounds: bounds  // AABB cacheado â€” evita recomputar en cada isPositionFree()
        });

        // PARCHE 1: Subida sÃ­ncrona obligatoria a VRAM antes de evaluar la siguiente pieza
        if (this.gl && occupancy.tex && !deferUpload) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, occupancy.tex);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            // Subida PARCIAL: sÃ³lo la regiÃ³n modificada (minC..maxC, minR..maxR). Evita subir
            // toda la rejilla (p. ej. 4 MB en 1000Ã—1000 a 0.5 mm) por cada pieza estampada.
            const subW = maxC - minC + 1;
            const subH = maxR - minR + 1;
            if (subW > 0 && subH > 0 && subW < occupancy.cols) {
                const sub = new Uint8Array(subW * subH);
                for (let r = 0; r < subH; r++) {
                    const srcOff = (minR + r) * occupancy.cols + minC;
                    sub.set(occupancy.grid.subarray(srcOff, srcOff + subW), r * subW);
                }
                gl.texSubImage2D(gl.TEXTURE_2D, 0, minC, minR, subW, subH, gl.RED, gl.UNSIGNED_BYTE, sub);
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, occupancy.cols, occupancy.rows, gl.RED, gl.UNSIGNED_BYTE, occupancy.grid);
            }
            gl.flush(); // Garantiza procesamiento sÃ­ncrono en VRAM
        }
    }

    /**
     * OPT-2A HELPER: Pre-calcula bounding boxes de cada arista de un polÃ­gono para
     * descartar aristas lejanas en O(1) antes de llamar a distToSegment.
     */
    _precomputeEdgeBounds(poly) {
        const eb = new Float64Array(poly.length * 4); // [minX, minY, maxX, maxY] Ã— n
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            const ax = poly[i].x, ay = poly[i].y;
            const bx = poly[j].x, by = poly[j].y;
            eb[i * 4 + 0] = Math.min(ax, bx);
            eb[i * 4 + 1] = Math.min(ay, by);
            eb[i * 4 + 2] = Math.max(ax, bx);
            eb[i * 4 + 3] = Math.max(ay, by);
        }
        return eb;
    }

    /**
     * OPT-2C HELPER: Distancia mÃ­nima puntoâ†’polÃ­gono con AABB early-reject por arista.
     * Descarta aristas cuyo AABB no pueda contribuir al mÃ­nimo actual.
     * Termina anticipadamente si la distancia encontrada ya es 0.
     */
    _pointToPolygonMinDistanceFast(pt, poly, edgeBounds, maxDist) {
        let minDist = maxDist + 1.0; // iniciar por encima del umbral
        const px = pt.x, py = pt.y;
        for (let i = 0; i < poly.length; i++) {
            // AABB early-reject: si la arista estÃ¡ a mÃ¡s de minDist en X o Y, ignorarla
            const eMinX = edgeBounds[i * 4 + 0] - minDist;
            const eMinY = edgeBounds[i * 4 + 1] - minDist;
            const eMaxX = edgeBounds[i * 4 + 2] + minDist;
            const eMaxY = edgeBounds[i * 4 + 3] + minDist;
            if (px < eMinX || px > eMaxX || py < eMinY || py > eMaxY) continue;

            const j = (i + 1) % poly.length;
            const d = this.distToSegment(pt, poly[i], poly[j]);
            if (d < minDist) {
                minDist = d;
                if (minDist === 0) return 0; // contacto directo, no puede bajar mÃ¡s
            }
        }
        return minDist;
    }

    getRepresentativeSamplePoints(poly, maxPoints = 64) {
        const allPts = this.generateSamplePoints(poly, Math.max(1.5, this.pixelSizeMm * 2.0), maxPoints * 32);
        if (allPts.length <= maxPoints) return allPts;
        const step = allPts.length / maxPoints;
        const sampled = [];
        for (let i = 0; i < maxPoints; i++) {
            sampled.push(allPts[Math.floor(i * step)]);
        }
        return sampled;
    }

    /**
     * CachÃ© residente (por pieza + rotaciÃ³n) de los puntos de muestreo True Shape.
     * Evita re-normalizar/re-muestrear la geometrÃ­a en las generaciones 2..N.
     */
    _getCachedSamples(cacheKey, normGeo) {
        if (!this._sampleCache) this._sampleCache = new Map();
        const k = (cacheKey || 'anon') + '@' + normGeo.widthMm.toFixed(3) + 'x' + normGeo.heightMm.toFixed(3) + '#' + normGeo.normalizedOuter.length + 'h' + ((normGeo.normalizedHoles || []).length);
        let entry = this._sampleCache.get(k);
        if (!entry) {
            const perimeter = this.getRepresentativeSamplePoints(normGeo.normalizedOuter, 64);
            const interior = this._buildInteriorSamples(normGeo.normalizedOuter, normGeo.normalizedHoles || [], Math.max(0, 96 - perimeter.length));
            const samplePts = perimeter.concat(interior);
            const flatSamples = new Float32Array(Math.max(1, samplePts.length) * 2);
            for (let i = 0; i < samplePts.length; i++) {
                flatSamples[i * 2] = samplePts[i].x;
                flatSamples[i * 2 + 1] = samplePts[i].y;
            }
            entry = { samplePts: samplePts, flatSamples: flatSamples, numPerim: perimeter.length };
            this._sampleCache.set(k, entry);
        }
        return entry;
    }

    clearCaches() {
        if (this._sampleCache) this._sampleCache.clear();
        if (this._geomCache) this._geomCache.clear();
        if (this._stepSampleCache) this._stepSampleCache.clear();
        if (this._sourceCanonCache) this._sourceCanonCache.clear();
        if (this.vramRotationCache) this.vramRotationCache.clear();
        this._vramBytes = 0;
    }

    getCacheStats() {
        return {
            vramRotationEntries: this.vramRotationCache ? this.vramRotationCache.size : 0,
            vramBytes: this._vramBytes || 0,
            vramMB: +(((this._vramBytes || 0) / 1048576).toFixed(2)),
            sampleCacheEntries: this._sampleCache ? this._sampleCache.size : 0,
            geomCacheEntries: this._geomCache ? this._geomCache.size : 0,
            stepSampleCacheEntries: this._stepSampleCache ? this._stepSampleCache.size : 0
        };
    }

    /** Muestras locales canÃ³nicas de una pieza fuente (para el shader multi-Ã¡ngulo). */
    // Puntos INTERIORES de muestreo: una pieza maciza puede tapar una pieza pequeÃ±a ya
    // colocada sin que ninguno de los 64 puntos del perÃ­metro la toque (falso positivo).
    // Se genera una rejilla interior (excluyendo agujeros) y se muestrea uniformemente.
    _buildInteriorSamples(polygon, holes, maxPoints) {
        if (maxPoints <= 0) return [];
        const b = this.getPolygonBounds(polygon);
        const N = 14;
        const cand = [];
        for (let iy = 0; iy < N; iy++) {
            const y = b.minY + ((iy + 0.5) / N) * (b.maxY - b.minY);
            for (let ix = 0; ix < N; ix++) {
                const x = b.minX + ((ix + 0.5) / N) * (b.maxX - b.minX);
                const pt = { x, y };
                if (!this.pointInPolygon(pt, polygon)) continue;
                let inHole = false;
                if (holes && holes.length > 0) {
                    for (const h of holes) {
                        if (this.pointInPolygon(pt, h)) { inHole = true; break; }
                    }
                }
                if (inHole) continue;
                cand.push(pt);
            }
        }
        if (cand.length <= maxPoints) return cand;
        const out = [];
        const step = cand.length / maxPoints;
        for (let i = 0; i < maxPoints; i++) out.push(cand[Math.floor(i * step)]);
        return out;
    }

    _getSourceCanonical(cacheKey, polygon, holes = []) {
        if (!this._sourceCanonCache) this._sourceCanonCache = new Map();
        const key = `${cacheKey}|h${(holes || []).length}`;
        let e = this._sourceCanonCache.get(key);
        if (e) return e;
        const b = this.getPolygonBounds(polygon);
        const cx = (b.minX + b.maxX) * 0.5;
        const cy = (b.minY + b.maxY) * 0.5;
        const local = polygon.map(p => ({ x: p.x - cx, y: p.y - cy }));
        const localHoles = (holes || []).map(h => h.map(p => ({ x: p.x - cx, y: p.y - cy })));
        const all = this.generateSamplePoints(local, Math.max(1.5, this.pixelSizeMm * 2.0), 64 * 32);
        let perimeter = all;
        if (all.length > 64) {
            perimeter = [];
            const step = all.length / 64;
            for (let i = 0; i < 64; i++) perimeter.push(all[Math.floor(i * step)]);
        }
        // 64 perÃ­metro + hasta 32 interiores = 96 puntos mÃ¡ximos
        const interior = this._buildInteriorSamples(local, localHoles, Math.max(0, 96 - perimeter.length));
        const samplePts = perimeter.concat(interior);
        const flat = new Float32Array(Math.max(1, samplePts.length) * 2);
        for (let i = 0; i < samplePts.length; i++) {
            flat[i * 2] = samplePts[i].x;
            flat[i * 2 + 1] = samplePts[i].y;
        }
        e = { cx: cx, cy: cy, sample64: samplePts, flat: flat, num: samplePts.length, numPerim: perimeter.length };
        this._sourceCanonCache.set(key, e);
        return e;
    }

    /**
     * CachÃ© VRAM de rotaciones (0..359Â°) indexada por `${source}_${angleDeg}`.
     * Almacena geometrÃ­a normalizada, cos/sin, offset y muestras True Shape para no
     * recalcular ni re-subir parÃ¡metros entre generaciones. Con presupuesto + evicciÃ³n.
     */
    getRotationEntry(cacheKey, polygon, holes, angleDeg) {
        if (!this.vramRotationCache) this.vramRotationCache = new Map();
        const a = ((Math.round(angleDeg) % 360) + 360) % 360;
        const key = `${cacheKey}_${a}`;
        let e = this.vramRotationCache.get(key);
        if (!e) {
            const src = this._getSourceCanonical(cacheKey, polygon, holes || []);
            const rad = (a * Math.PI) / 180.0;
            const cs = Math.cos(rad), sn = Math.sin(rad);
            const ng = this.normalizeRotatedGeometry(polygon, holes, a);
            const rcx = src.cx * cs - src.cy * sn;
            const rcy = src.cx * sn + src.cy * cs;
            const perimeter = this.getRepresentativeSamplePoints(ng.normalizedOuter, 64);
            const interior = this._buildInteriorSamples(ng.normalizedOuter, ng.normalizedHoles || [], Math.max(0, 96 - perimeter.length));
            const samplePts = perimeter.concat(interior);
            const flatSamples = new Float32Array(Math.max(1, samplePts.length) * 2);
            for (let i = 0; i < samplePts.length; i++) {
                flatSamples[i * 2] = samplePts[i].x;
                flatSamples[i * 2 + 1] = samplePts[i].y;
            }
            e = {
                angle: a, cos: cs, sin: sn,
                offX: ng.rotOffsetX + rcx,
                offY: ng.rotOffsetY + rcy,
                widthMm: ng.widthMm, heightMm: ng.heightMm,
                normGeo: ng, samplePts: samplePts, flatSamples: flatSamples, numPerim: perimeter.length
            };
            this.vramRotationCache.set(key, e);
            this._vramBytes = (this._vramBytes || 0) + ng.normalizedOuter.length * 16 + samplePts.length * 8 + 512;
            const max = this.vramRotationMaxEntries || 20000;
            if (this.vramRotationCache.size > max) {
                const excess = this.vramRotationCache.size - max;
                let i = 0;
                for (const k of this.vramRotationCache.keys()) {
                    this.vramRotationCache.delete(k);
                    if (++i >= excess) break;
                }
            }
        }
        return e;
    }

    /** Puntos de muestreo para barridos de rejilla, cacheados por pieza+paso. */
    _gridSamples(cacheKey, normGeo, stepMm, maxPoints) {
        if (!this._stepSampleCache) this._stepSampleCache = new Map();
        const k = (cacheKey || 'anon') + '@' + normGeo.widthMm.toFixed(3) + 'x' + normGeo.heightMm.toFixed(3) +
            '#' + normGeo.normalizedOuter.length + '#' + stepMm + '#' + maxPoints;
        let s = this._stepSampleCache.get(k);
        if (!s) {
            s = this.generateSamplePoints(normGeo.normalizedOuter, stepMm, maxPoints);
            this._stepSampleCache.set(k, s);
        }
        return s;
    }

    /** Test de colisiÃ³n True Shape en 2 niveles (submuestreo rÃ¡pido + completo). */
    _collidesAt(occupancy, samples, x, y) {
        const ps = occupancy.pixelSizeMm, cols = occupancy.cols, rows = occupancy.rows, grid = occupancy.grid;
        for (let i = 0; i < samples.length; i += 4) {
            const c = Math.floor((x + samples[i].x) / ps);
            const r = Math.floor((y + samples[i].y) / ps);
            if (c < 0 || c >= cols || r < 0 || r >= rows || grid[r * cols + c] > 0) return true;
        }
        for (let i = 0; i < samples.length; i++) {
            const c = Math.floor((x + samples[i].x) / ps);
            const r = Math.floor((y + samples[i].y) / ps);
            if (c < 0 || c >= cols || r < 0 || r >= rows || grid[r * cols + c] > 0) return true;
        }
        return false;
    }

    /** Normaliza (rota+traslada al origen) usando la cachÃ© VRAM por pieza+Ã¡ngulo. */
    normalizeGeometryCached(cacheKey, polygon, holes, angleDeg) {
        return this.getRotationEntry(cacheKey, polygon, holes || [], angleDeg).normGeo;
    }

    /** Cavidades interiores usables (bbox con margen) para el shader. */
    _collectHoles(occupancy, wMm, hMm, spacingMm) {
        const holesList = [];
        if (occupancy.placedItems) {
            for (const placed of occupancy.placedItems) {
                if (placed.holes && placed.holes.length > 0) {
                    for (const hole of placed.holes) {
                        const hb = this.getPolygonBounds(hole);
                        if ((hb.maxX - hb.minX) >= (wMm + spacingMm * 2) &&
                            (hb.maxY - hb.minY) >= (hMm + spacingMm * 2)) {
                            holesList.push(
                                hb.minX + spacingMm,
                                hb.minY + spacingMm,
                                hb.maxX - spacingMm,
                                hb.maxY - spacingMm
                            );
                            if (holesList.length >= 64) break;
                        }
                    }
                }
                if (holesList.length >= 64) break;
            }
        }
        const flatHoles = new Float32Array(64);
        for (let i = 0; i < holesList.length; i++) flatHoles[i] = holesList[i];
        return { numHoles: Math.min(16, Math.floor(holesList.length / 4)), flatHoles: flatHoles };
    }

    /**
     * ResoluciÃ³n de la textura de evaluaciÃ³n para una bobina dada. Mantiene celdas
     * aproximadamente cuadradas: ancho fijo (X â‰ˆ W/1024 mm) y alto proporcional al aspecto
     * (Y â‰ˆ H/evalH mm), acotado a la capacidad asignada. AsÃ­ la densidad de muestreo en Y
     * NO degenera al crecer la bobina (bug original: 1024Â² fijo => H/1024 mm en Y).
     */
    _evalDims(occupancy) {
        const W = Math.max(1e-3, occupancy.sheetWidthMm);
        const H = Math.max(1e-3, occupancy.sheetHeightMm);
        // Resolución fija del cribado: la latencia de sincronización GPU→CPU (~3.7 ms por
        // lote en ANGLE/D3D11) domina el coste, así que reducir píxeles no acelera nada y
        // sí pierde posiciones. Se mantiene el muestreo original.
        const w = this.EVAL_MAX_W;
        let h = Math.round(w * (H / W));
        h = Math.min(this.EVAL_MAX_H, Math.max(1024, h));
        return { w, h };
    }

    /** Estadísticas acumuladas de la ruta GPU (para benchmarks; coste ~0). */
    getStats() {
        return Object.assign({}, this.stats);
    }

    resetStats() {
        this.stats = { batchCalls: 0, batchMs: 0, reduceMs: 0, readMs: 0, readBytes: 0 };
    }

    /**
     * EvaluaciÃ³n MULTI-ÃNGULO POR LOTES en GPU.
     * Hasta 4 rotaciones por pase: cada Ã¡ngulo ocupa una franja vertical del FBO y se
     * reduce por separado (pirÃ¡mide con crop). Devuelve un resultado por Ã¡ngulo.
     */
    findBestPlacementBatch(occupancy, polygon, holes, angles, bleedMm, spacingMm, cacheKey = null) {
        const gl = this.gl;
        if (!gl || !this.evalBatchProgram) return null;

        const uniq = [];
        const seen = new Set();
        for (const a of (angles || [])) {
            const n = ((Math.round(a) % 360) + 360) % 360;
            if (!seen.has(n)) { seen.add(n); uniq.push(n); }
        }
        if (uniq.length === 0) return null;

        const src = this._getSourceCanonical(cacheKey, polygon, holes || []);
        const entries = uniq.map(a => this.getRotationEntry(cacheKey, polygon, holes || [], a));
        const U = this.evalBatchUniforms;
        const MAXB = 8;
        const results = [];
        const cosArr = new Float32Array(MAXB);
        const sinArr = new Float32Array(MAXB);
        const offArr = new Float32Array(MAXB * 2);
        const dimArr = new Float32Array(MAXB * 2);
        const { w: evalW, h: evalH } = this._evalDims(occupancy);

        for (let start = 0; start < entries.length; start += MAXB) {
            const chunk = entries.slice(start, start + MAXB);
            const n = chunk.length;
            const tChunk = (typeof performance !== 'undefined' ? performance.now() : Date.now());

            // Cavidades para el tamaÃ±o (usamos el mÃ¡ximo de dims del lote)
            let maxW = 0, maxH = 0;
            for (const e of chunk) { if (e.widthMm > maxW) maxW = e.widthMm; if (e.heightMm > maxH) maxH = e.heightMm; }
            const holeInfo = this._collectHoles(occupancy, maxW, maxH, spacingMm);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboEval);
            gl.viewport(0, 0, evalW, evalH);
            gl.useProgram(this.evalBatchProgram);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, occupancy.tex);
            gl.uniform1i(U.u_sheet_grid, 0);
            gl.uniform2f(U.u_sheet_dim_mm, occupancy.sheetWidthMm, occupancy.sheetHeightMm);
            gl.uniform2f(U.u_spacing_mm, spacingMm, spacingMm);
            gl.uniform1i(U.u_roll_direction, 0);
            gl.uniform1i(U.u_num_samples, src.num);
            gl.uniform1i(U.u_num_perim, src.numPerim || src.num);
            gl.uniform2fv(U.u_sample_points, src.flat);
            // Poda exacta: nada por encima de la frontera estampada + alto del lote + 3*spacing
            // puede ganar el min-pooling (el coste crece 10/mm en Y). Ahorra la banda vacía.
            const frontierY = occupancy.maxPlacedY || 0;
            gl.uniform1f(U.u_max_eval_y, Math.min(
                occupancy.sheetHeightMm - spacingMm,
                frontierY + maxH + spacingMm * 3.0 + 10.0
            ));
            gl.uniform1i(U.u_num_holes, holeInfo.numHoles);
            gl.uniform4fv(U.u_holes, holeInfo.flatHoles);
            gl.uniform1i(U.u_num_angles, n);

            for (let i = 0; i < n; i++) {
                cosArr[i] = chunk[i].cos;
                sinArr[i] = chunk[i].sin;
                offArr[i * 2] = chunk[i].offX;
                offArr[i * 2 + 1] = chunk[i].offY;
                dimArr[i * 2] = chunk[i].widthMm;
                dimArr[i * 2 + 1] = chunk[i].heightMm;
            }
            gl.uniform1fv(U.u_ang_cos, cosArr);
            gl.uniform1fv(U.u_ang_sin, sinArr);
            gl.uniform2fv(U.u_ang_off, offArr);
            gl.uniform2fv(U.u_ang_dim, dimArr);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
            const aPosLoc = gl.getAttribLocation(this.evalBatchProgram, 'a_pos');
            gl.enableVertexAttribArray(aPosLoc);
            gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const tDraw = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.stats.batchCalls++;

            // Reducción por franja (crop): escribe el mínimo de cada ángulo en su columna
            // del FBO de resultados, sin leer; una única lectura por lote al final.
            for (let i = 0; i < n; i++) {
                const crop = { x0: i / n, w: 1 / n };
                this.executeGpuMinPoolingPass(occupancy, chunk[i].widthMm, chunk[i].heightMm, crop, this.fboEval, this.texEval, i, evalW, evalH);
            }
            const outBuf = new Float32Array(n * 4);
            const tReduce = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboOut);
            gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, outBuf);
            const tRead = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.stats.reduceMs += (tReduce - tDraw);
            this.stats.readMs += (tRead - tReduce);
            this.stats.readBytes += n * 4 * 4;
            this.stats.batchMs += (tRead - tChunk);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            for (let i = 0; i < n; i++) {
                const cost = outBuf[i * 4];
                const gx = outBuf[i * 4 + 1];
                const gy = outBuf[i * 4 + 2];
                const inHoleFlag = outBuf[i * 4 + 3];
                if (!(cost < 1e8)) continue;

                const crop = { x0: i / n, w: 1 / n };
                // Estado original (72.2 %): el shader emite lx como fracción de la franja y el JS
                // reconstruye la X dentro de esa franja.
                const xNorm = crop.x0 + gx * crop.w;
                const yNorm = gy;
                const minX = spacingMm;
                const maxX = Math.max(spacingMm, occupancy.sheetWidthMm - chunk[i].widthMm - spacingMm);
                const minY = spacingMm;
                const maxY = Math.max(spacingMm, occupancy.sheetHeightMm - chunk[i].heightMm - spacingMm);
                results.push({
                    angle: chunk[i].angle,
                    x: Math.max(minX, Math.min(maxX, xNorm * occupancy.sheetWidthMm)),
                    y: Math.max(minY, Math.min(maxY, yNorm * occupancy.sheetHeightMm)),
                    cost: cost,
                    inHole: inHoleFlag > 0.5,
                    normGeo: chunk[i].normGeo
                });
            }
        }

        return { results: results };
    }

    findBestPlacementGPU(occupancy, normGeo, wMm, hMm, spacingMm, cacheKey = null) {
        const gl = this.gl;

        // 1. Recopilar cavidades interiores de piezas ya colocadas
        const holesList = [];
        if (occupancy.placedItems) {
            for (const placed of occupancy.placedItems) {
                if (placed.holes && placed.holes.length > 0) {
                    for (const hole of placed.holes) {
                        const hb = this.getPolygonBounds(hole);
                        if ((hb.maxX - hb.minX) >= (wMm + spacingMm * 2) &&
                            (hb.maxY - hb.minY) >= (hMm + spacingMm * 2)) {
                            holesList.push(
                                hb.minX + spacingMm,
                                hb.minY + spacingMm,
                                hb.maxX - spacingMm,
                                hb.maxY - spacingMm
                            );
                            if (holesList.length >= 64) break;
                        }
                    }
                }
                if (holesList.length >= 64) break;
            }
        }
        const numHoles = Math.min(16, Math.floor(holesList.length / 4));
        const flatHoles = new Float32Array(64);
        for (let i = 0; i < holesList.length; i++) flatHoles[i] = holesList[i];

        // 2. Extraer hasta 64 puntos de muestreo para la evaluaciÃ³n paralela en shader
        //    (con cachÃ© residente por pieza+rotaciÃ³n para no recalcular en cada generaciÃ³n)
        const cached = this._getCachedSamples(cacheKey, normGeo);
        const samplePts = cached.samplePts;
        const flatSamples = cached.flatSamples;

        // 3. Renderizar evaluaciÃ³n en paralelo (evalW x evalH candidatos ajustados al aspecto)
        const { w: evalW, h: evalH } = this._evalDims(occupancy);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
        gl.viewport(0, 0, evalW, evalH);
        gl.useProgram(this.evalProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, occupancy.tex);
        gl.uniform1i(this.evalUniforms.u_sheet_grid, 0);

        gl.uniform2f(this.evalUniforms.u_sheet_dim_mm, occupancy.sheetWidthMm, occupancy.sheetHeightMm);
        gl.uniform2f(this.evalUniforms.u_piece_dim_mm, wMm, hMm);
        gl.uniform2f(this.evalUniforms.u_spacing_mm, spacingMm, spacingMm);
        gl.uniform1i(this.evalUniforms.u_roll_direction, 0);

        gl.uniform1i(this.evalUniforms.u_num_samples, samplePts.length);
        gl.uniform1i(this.evalUniforms.u_num_perim, cached.numPerim || samplePts.length);
        gl.uniform2fv(this.evalUniforms.u_sample_points, flatSamples);
        gl.uniform1f(this.evalUniforms.u_max_eval_y, Math.min(
            occupancy.sheetHeightMm - spacingMm,
            (occupancy.maxPlacedY || 0) + hMm + spacingMm * 3.0 + 10.0
        ));

        gl.uniform1i(this.evalUniforms.u_num_holes, numHoles);
        gl.uniform4fv(this.evalUniforms.u_holes, flatHoles);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
        const aPosLoc = gl.getAttribLocation(this.evalProgram, 'a_pos');
        gl.enableVertexAttribArray(aPosLoc);
        gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // 4. ReducciÃ³n jerÃ¡rquica piramidal en GPU hasta 1x1
        const outputPixel = this.executeGpuMinPoolingPass(occupancy, wMm, hMm, null, null, null, -1, evalW, evalH);

        const minCost = outputPixel ? outputPixel[0] : 1e9;
        let bestX = spacingMm;
        let bestY = spacingMm;
        let foundInsideHole = false;

        if (minCost < 1e8 && outputPixel) {
            bestX = outputPixel[1] * occupancy.sheetWidthMm;
            bestY = outputPixel[2] * occupancy.sheetHeightMm;
            foundInsideHole = outputPixel[3] > 0.5;

            const minPermittedX = spacingMm;
            const maxPermittedX = Math.max(spacingMm, occupancy.sheetWidthMm - wMm - spacingMm);
            const minPermittedY = spacingMm;
            const maxPermittedY = Math.max(spacingMm, occupancy.sheetHeightMm - hMm - spacingMm);
            bestX = Math.max(minPermittedX, Math.min(maxPermittedX, bestX));
            bestY = Math.max(minPermittedY, Math.min(maxPermittedY, bestY));
        }

        return {
            x: bestX,
            y: bestY,
            cost: minCost,
            inHole: foundInsideHole,
            normGeo: normGeo
        };
    }

    findBestPlacement(occupancy, partPolygon, partHoles = [], angleDeg = 0, bleedMm = 0, spacingMm = 0, cacheKey = null) {
        // NormalizaciÃ³n canÃ³nica de geometrÃ­a (con cachÃ© por pieza+Ã¡ngulo)
        const normGeo = this.normalizeGeometryCached(cacheKey, partPolygon, partHoles, angleDeg);
        const wMm = normGeo.widthMm;
        const hMm = normGeo.heightMm;

        // EJECUCIÃ“N DIRECTA 100% EN GPU (Cero bucles JS for y/x)
        if (this.gl && this.evalProgram && this.reduceProgram && this.fboA && this.fboB) {
            const gpuRes = this.findBestPlacementGPU(occupancy, normGeo, wMm, hMm, spacingMm, cacheKey);
            if (gpuRes && gpuRes.cost < 1e8) {
                return gpuRes;
            }
        }

        // --- FALLBACK GRID (entornos sin GPU o posiciÃ³n GPU rechazada) ---
        return this.findBestPlacementGrid(occupancy, normGeo, wMm, hMm, spacingMm);
    }

    /**
     * BÃºsqueda True Shape sobre la rejilla de ocupaciÃ³n (sin GPU). Devuelve la posiciÃ³n
     * libre de menor coste, priorizando cavidades interiores (Hole Nesting), o null si no
     * existe ninguna posiciÃ³n libre a la resoluciÃ³n de la rejilla.
     */
    findBestPlacementGrid(occupancy, normGeo, wMm, hMm, spacingMm, cacheKey = null) {
        const stepMm = Math.max(1.5, occupancy.pixelSizeMm * 3.0);
        const minX = spacingMm;
        const minY = spacingMm;
        const maxX = occupancy.sheetWidthMm - wMm - spacingMm;
        const maxY = occupancy.sheetHeightMm - hMm - spacingMm;

        if (maxX < minX || maxY < minY) return null;

        // ACOTACIÃ“N ANTI-BLOQUEO: como mÃ¡ximo ~128 posiciones por eje (coste O(128Â²Â·samples)).
        const stepX = Math.max(stepMm, (maxX - minX) / 128);
        const stepY = Math.max(stepMm, (maxY - minY) / 128);

        let bestX = null;
        let bestY = null;
        let minCost = 1e18;
        let foundInsideHole = false;

        const samplePoints = this._gridSamples(cacheKey, normGeo, stepMm, 64);

        // 1. EVALUACIÃ“N PRIORITARIA DE CAVIDADES INTERIORES (Hole Nesting)
        for (const placed of occupancy.placedItems) {
            if (placed.holes && placed.holes.length > 0) {
                for (const hole of placed.holes) {
                    const hBounds = this.getPolygonBounds(hole);
                    if ((hBounds.maxX - hBounds.minX) >= (wMm + spacingMm * 2) &&
                        (hBounds.maxY - hBounds.minY) >= (hMm + spacingMm * 2)) {

                        const startY = Math.max(minY, hBounds.minY + spacingMm);
                        const endY = Math.min(maxY, hBounds.maxY - hMm - spacingMm);
                        const startX = Math.max(minX, hBounds.minX + spacingMm);
                        const endX = Math.min(maxX, hBounds.maxX - wMm - spacingMm);

                        for (let y = startY; y <= endY; y += stepY) {
                            for (let x = startX; x <= endX; x += stepX) {
                                if (this._collidesAt(occupancy, samplePoints, x, y)) continue;

                                const holeCost = (x * 0.1) + (y * 0.1);
                                if (holeCost < minCost) {
                                    minCost = holeCost;
                                    bestX = x;
                                    bestY = y;
                                    foundInsideHole = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (foundInsideHole && bestX !== null) {
            return { x: bestX, y: bestY, cost: minCost, inHole: true, normGeo: normGeo };
        }

        // 2. BÃºsqueda True Shape sobre el pliego
        for (let y = minY; y <= maxY; y += stepY) {
            const rollCost = y * 10.0 + y * y * 0.05;
            if (rollCost > minCost) break;

            for (let x = minX; x <= maxX; x += stepX) {
                const totalCost = x * 1.0 + rollCost;
                if (totalCost >= minCost) continue;

                if (!this._collidesAt(occupancy, samplePoints, x, y)) {
                    minCost = totalCost;
                    bestX = x;
                    bestY = y;
                    foundInsideHole = false;
                }
            }
        }

        if (bestX === null) return null;
        return { x: bestX, y: bestY, cost: minCost, inHole: foundInsideHole, normGeo: normGeo };
    }

    /**
     * AJUSTE 2: Bucle real completo de reducciÃ³n jerÃ¡rquica con FBO Ping-Pong a 1x1
     * Utiliza Math.ceil(cur / 2), RGBA32F, gl.NEAREST y lectura final de 1x1 pÃ­xeles
     */
    executeGpuMinPoolingPass(occupancy, pieceWidthMm, pieceHeightMm, crop = null, srcFbo = null, srcTex = null, writeCol = -1, evalW = null, evalH = null) {
        const gl = this.gl;
        if (!gl || !this.reduceProgram || !this.fboA || !this.fboB) return null;

        const capW = evalW || this.EVAL_MAX_W || 1024;
        const capH = evalH || this.EVAL_MAX_H || 1024;

        // crop = { x0, w } en UV (para reducir una sola franja/tile del FBO multi-Ã¡ngulo).
        let curW = crop ? Math.max(1, Math.round(capW * crop.w)) : capW;
        let curH = capH;
        let firstLevel = true;

        let sourceFbo = srcFbo || this.fboA;
        let sourceTex = srcTex || this.texA;
        // El primer nivel escribe siempre en B y luego alterna Aâ†”B, de modo que si la fuente
        // es el FBO de evaluaciÃ³n dedicado (multi-Ã¡ngulo) su textura nunca se sobrescribe.
        let targetFbo = this.fboB;
        let targetTex = this.texB;

        gl.useProgram(this.reduceProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
        const aPosLoc = gl.getAttribLocation(this.reduceProgram, 'a_pos');
        gl.enableVertexAttribArray(aPosLoc);
        gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

        const uPrevLevelLoc = gl.getUniformLocation(this.reduceProgram, 'u_prev_level');
        const uSrcScaleLoc = gl.getUniformLocation(this.reduceProgram, 'u_src_scale');
        const uTexelOffsetLoc = gl.getUniformLocation(this.reduceProgram, 'u_texel_offset');
        const uCropOriginLoc = gl.getUniformLocation(this.reduceProgram, 'u_crop_origin');

        // Bucle exhaustivo reduciendo hasta 1x1
        while (curW > 1 || curH > 1) {
            const nextW = Math.max(1, Math.ceil(curW / 2.0));
            const nextH = Math.max(1, Math.ceil(curH / 2.0));

            gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
            gl.viewport(0, 0, nextW, nextH);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);
            gl.uniform1i(uPrevLevelLoc, 0);
            if (firstLevel && crop) {
                gl.uniform2f(uSrcScaleLoc, crop.w, 1.0);
                gl.uniform2f(uCropOriginLoc, crop.x0, 0.0);
            } else {
                gl.uniform2f(uSrcScaleLoc, curW / capW, curH / capH);
                gl.uniform2f(uCropOriginLoc, 0.0, 0.0);
            }
            gl.uniform2f(uTexelOffsetLoc, 0.5 / capW, 0.5 / capH);
            firstLevel = false;

            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // Intercambio ping-pong
            const tempFbo = sourceFbo; sourceFbo = targetFbo; targetFbo = tempFbo;
            const tempTex = sourceTex; sourceTex = targetTex; targetTex = tempTex;

            curW = nextW;
            curH = nextH;
        }

        // Salida diferida: escribir el mÃ­nimo 1x1 en la columna `writeCol` del FBO de
        // resultados (una lectura Ãºnica por lote) en vez de un readPixels por Ã¡ngulo.
        if (writeCol >= 0) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboOut);
            gl.viewport(writeCol, 0, 1, 1);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);
            gl.uniform1i(uPrevLevelLoc, 0);
            // Copia 1x1â†’1x1: muestrear SOLO el texel central (sin vecinos vacÃ­os que
            // darÃ­an cost 0 falso). scale=0 y offset=0 colapsan los 4 taps al mismo texel.
            gl.uniform2f(uSrcScaleLoc, 0.0, 0.0);
            gl.uniform2f(uCropOriginLoc, 0.5 / capW, 0.5 / capH);
            gl.uniform2f(uTexelOffsetLoc, 0.0, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return null;
        }

        // Lectura garantizada de Ãºnicamente 1x1 pÃ­xel RGBA32F (16 bytes)
        const outputPixel = new Float32Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sourceFbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, outputPixel);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return outputPixel;
    }

    /**
     * AJUSTE 1 & 2: Slide-to-Contact analÃ­tico continuo de 64 bits
     * Con lÃ­mites de bobina como pared dura y verificaciÃ³n estricta de no-colisiÃ³n previa a aceptaciÃ³n.
     * OPT-1: AABB early-reject O(1) con bounds cacheados de stampPieceIntoSheetGPU.
     * OPT-3: Early-exit inmediato si la GPU ya entregÃ³ una posiciÃ³n vÃ¡lida y libre.
     * SPACING-FIX: strictSpacingMm +0.6 garantiza dist euclÃ­dea >= 2.99 mm en Shapely.
     */
    refineSlideToContact(placedItems, normalizedPolygon, initialX, initialY, spacingMm, sheetWidthMm, sheetHeightMm, opts = {}) {
        const fine = !!opts.fine;
        const polyBounds = this.getPolygonBounds(normalizedPolygon);
        const wMm = polyBounds.maxX - polyBounds.minX;
        const hMm = polyBounds.maxY - polyBounds.minY;

        // Rango permitido estricto dentro de la bobina
        const minPermittedX = spacingMm;
        const minPermittedY = spacingMm;
        const maxPermittedX = sheetWidthMm - wMm - spacingMm;
        const maxPermittedY = sheetHeightMm - hMm - spacingMm;

        // SPACING-FIX: margen extra +0.6 mm para compensar resoluciÃ³n de pÃ­xel (0.5 mm/px).
        // Garantiza que la distancia euclÃ­dea mÃ­nima medida por Shapely sea >= 2.99 mm.
        const strictSpacingMm = spacingMm + 0.6;

        let curX = Math.max(minPermittedX, Math.min(maxPermittedX, initialX));
        let curY = Math.max(minPermittedY, Math.min(maxPermittedY, initialY));

        const isPositionFree = (x, y) => {
            // Verificar lÃ­mites de bobina (paredes inamovibles al 0.001 mm)
            if (x < (minPermittedX - 1e-4) || x > (maxPermittedX + 1e-4)) return false;
            if (y < (minPermittedY - 1e-4) || y > (maxPermittedY + 1e-4)) return false;

            // OPT-1: AABB candidata calculada UNA SOLA VEZ fuera del for de placedItems
            const candMinX = x + polyBounds.minX;
            const candMinY = y + polyBounds.minY;
            const candMaxX = x + polyBounds.maxX;
            const candMaxY = y + polyBounds.maxY;

            for (const placed of placedItems) {
                // OPT-1: AABB early-reject O(1) con bounds pre-cacheados del stamp
                const pb = placed.bounds || this.getPolygonBounds(placed.outer);
                if (pb.maxX + strictSpacingMm <= candMinX ||
                    candMaxX + strictSpacingMm <= pb.minX ||
                    pb.maxY + strictSpacingMm <= candMinY ||
                    candMaxY + strictSpacingMm <= pb.minY) {
                    continue; // Separadas con margen estricto â€” sin colisiÃ³n posible
                }

                // Construir polÃ­gono trasladado solo si el AABB no lo descartÃ³ (lazy)
                const shiftedCandidate = normalizedPolygon.map(p => ({ x: p.x + x, y: p.y + y }));

                // Test de intersecciÃ³n de aristas + contenciÃ³n
                const intersects = this.polygonsIntersect(placed.outer, shiftedCandidate);

                // SPACING-FIX: Test de distancia mÃ­nima con margen estricto
                let tooClose = false;
                if (!intersects) {
                    tooClose = this.polygonMinDistance(placed.outer, shiftedCandidate, strictSpacingMm) < strictSpacingMm;
                }

                if (intersects || tooClose) {
                    // ExcepciÃ³n legÃ­tima: la candidata estÃ¡ dentro de un agujero de la colocada
                    let fullyInsideHole = false;
                    if (placed.holes && placed.holes.length > 0) {
                        for (const hole of placed.holes) {
                            // Hole nesting usa spacingMm original (el agujero ya tiene margen de exclusiÃ³n)
                            if (this.isPolygonInsidePolygon(shiftedCandidate, hole, spacingMm)) {
                                fullyInsideHole = true;
                                break;
                            }
                        }
                    }
                    if (!fullyInsideHole) return false;
                }
            }
            return true;
        };

        // Deslizar SIEMPRE hacia -Y y -X hasta contacto (bÃºsqueda por pasos decrecientes).
        // Sin esto la pieza se queda donde la dejÃ³ la GPU (p. ej. el aro suelto en Yâ‰ˆ1997).
        const slideUpAndLeft = (startX, startY) => {
            let x = startX, y = startY;
            for (const step of [256, 128, 64, 32, 16, 8, 4, 2, 1]) {
                while (y - step >= minPermittedY && isPositionFree(x, y - step)) y -= step;
            }
            for (const step of [64, 16, 4, 1]) {
                while (x - step >= minPermittedX && isPositionFree(x - step, y)) x -= step;
            }
            for (const step of [8, 2, 1]) {
                while (y - step >= minPermittedY && isPositionFree(x, y - step)) y -= step;
            }
            return { x, y };
        };

        // OPT-3 (PROBLEMA A): Aceptar la posiciÃ³n de la GPU SOLO si estÃ¡ estrictamente dentro
        // de los mÃ¡rgenes de la lÃ¡mina Y libre. Si la pieza no cabe (maxPermitted < minPermitted,
        // p. ej. mÃ¡s ancha que la bobina) se rechaza aquÃ­ en vez de aceptarla colisionando.
        if (curX >= minPermittedX && curX <= maxPermittedX &&
            curY >= minPermittedY && curY <= maxPermittedY &&
            isPositionFree(curX, curY)) {
            return slideUpAndLeft(curX, curY);
        }

        // === RESCUE DEEP SCAN: barrido fino (1.0 mm) de TODA la lÃ¡mina sobre la rejilla de
        // ocupaciÃ³n, incluyendo huecos interiores y huecos laterales, antes de declarar la
        // pieza como no colocable en esta hoja. Confirma analÃ­ticamente (sin solapes).
        if (fine && opts.occupancy) {
            const stepMm = opts.stepMm || 1.0;
            const maxAnchors = opts.maxAnchors || 12000;
            const occ = opts.occupancy;
            const samples = this._gridSamples(opts.cacheKey || null, { widthMm: wMm, heightMm: hMm, normalizedOuter: normalizedPolygon }, Math.max(0.75, occ.pixelSizeMm), 48);

            // 1) HUECOS INTERIORES PRIMERO: meter la pieza pequeÃ±a en una cavidad libre es
            // siempre mejor que abrir material nuevo en la frontera.
            const holeInfo = this._collectHoles(occ, wMm, hMm, spacingMm);
            for (let h = 0; h < holeInfo.numHoles; h++) {
                const hx1 = holeInfo.flatHoles[h * 4];
                const hy1 = holeInfo.flatHoles[h * 4 + 1];
                const hx2 = holeInfo.flatHoles[h * 4 + 2];
                const hy2 = holeInfo.flatHoles[h * 4 + 3];
                const cands = [
                    [hx1, hy1],
                    [hx2 - wMm, hy1],
                    [hx1, hy2 - hMm],
                    [hx2 - wMm, hy2 - hMm],
                    [(hx1 + hx2 - wMm) * 0.5, (hy1 + hy2 - hMm) * 0.5]
                ];
                for (const c of cands) {
                    const px = Math.max(minPermittedX, Math.min(maxPermittedX, c[0]));
                    const py = Math.max(minPermittedY, Math.min(maxPermittedY, c[1]));
                    if (isPositionFree(px, py)) return slideUpAndLeft(px, py);
                }
            }

            // 2) BARRIDO COMPLETO desde minPermittedY: antes se arrancaba en la frontera
            // (frontier - hMm) y los huecos de la mitad superior no se visitaban nunca.
            // El paso se adapta al presupuesto de anclas para cubrir toda la lÃ¡mina.
            const stepScan = Math.max(stepMm, Math.sqrt((sheetWidthMm * sheetHeightMm) / Math.max(1, maxAnchors)));
            const startY = Math.max(minPermittedY, Math.min(maxPermittedY, opts.minScanY || 0));
            let anchors = 0;
            for (let y = startY; y <= maxPermittedY; y += stepScan) {
                for (let x = minPermittedX; x <= maxPermittedX; x += stepScan) {
                    if (++anchors > maxAnchors) return { x: curX, y: curY, failedToFitSheet: true };
                    if (!this._collidesAt(occ, samples, x, y) && isPositionFree(x, y)) {
                        return slideUpAndLeft(x, y);
                    }
                }
            }
            return { x: curX, y: curY, failedToFitSheet: true };
        }

        // PARCHE 3: El GuardiÃ¡n AnalÃ­tico Inquebrantable en CPU
        // Si la posiciÃ³n devuelta colisiona, se rechaza y se fuerza avance longitudinal en el rollo (Y += spacing).
        let resolved = false;
        let searchY = curY;

        // PRESUPUESTO DE BÃšSQUEDA ADAPTATIVO: acota el barrido O(posiciones Ã— piezas Ã— aristasÂ²)
        // para impedir bloqueos de UI. La bÃºsqueda de completitud (barrido de rejilla barato)
        // la realiza findBestPlacementGrid en el orquestador, asÃ­ que aquÃ­ basta una ventana
        // local alrededor de la posiciÃ³n sugerida.
        let _placedEdgeSum = 0;
        for (const _pl of placedItems) _placedEdgeSum += (_pl.outer ? _pl.outer.length : 0);
        const _avgPlacedEdges = placedItems.length > 0 ? (_placedEdgeSum / placedItems.length) : 1;
        const _perEvalCost = Math.max(1, normalizedPolygon.length) * Math.max(1, _avgPlacedEdges);
        let evalBudget = Math.max(120, Math.min(4000, Math.floor(2.0e5 / _perEvalCost)));

        // Intentar primero avanzar en X en la misma fila
        for (let tx = curX + 0.5; tx <= maxPermittedX && evalBudget > 0; tx += 0.5) {
            evalBudget--;
            if (isPositionFree(tx, searchY)) {
                curX = tx;
                resolved = true;
                break;
            }
        }

        // Si no encuentra hueco a la derecha, forzar avance longitudinal en Y (Y += spacing)
        const stepY = Math.max(0.5, spacingMm);
        while (!resolved && searchY <= maxPermittedY && evalBudget > 0) {
            searchY += stepY;
            for (let tx = minPermittedX; tx <= maxPermittedX && evalBudget > 0; tx += 1.0) {
                evalBudget--;
                if (isPositionFree(tx, searchY)) {
                    curX = tx;
                    curY = searchY;
                    resolved = true;
                    break;
                }
            }
        }

        // GUARDIÃN ANALÃTICO (NO FATAL): PROHIBIDO categÃ³ricamente devolver un placement con
        // colisiÃ³n > 0.0 mmÂ². Si tras barrer X y avanzar en Y no existe ninguna posiciÃ³n libre
        // (lÃ¡mina llena, o pieza cuya huella excede maxPermitted) se seÃ±ala failedToFitSheet=true.
        // El orquestador (evaluatePlacementGPU) usa esta bandera para colocar la pieza en OTRA
        // lÃ¡mina (Multi-LÃ¡mina) - NUNCA se devuelve una coordenada que solape.
        if (!isPositionFree(curX, curY)) {
            return { x: curX, y: curY, failedToFitSheet: true };
        }

        return slideUpAndLeft(
            Math.max(minPermittedX, Math.min(maxPermittedX, curX)),
            Math.max(minPermittedY, Math.min(maxPermittedY, curY))
        );
    }

    // ==========================================
    // UTILIDADES GEOMÃ‰TRICAS PURAS EN FLOAT64
    // ==========================================

    getPolygonBounds(polygon) {
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let i = 0; i < polygon.length; i++) {
            const p = polygon[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }

    pointInPolygon(pt, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    pointToPolygonMinDistance(pt, poly) {
        let minDist = 1e9;
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            const d = this.distToSegment(pt, poly[i], poly[j]);
            if (d < minDist) minDist = d;
        }
        return minDist;
    }

    distToSegment(p, v, w) {
        const l2 = (v.x - w.x) * (v.x - w.x) + (v.y - w.y) * (v.y - w.y);
        if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
    }

    polygonsIntersect(polyA, polyB) {
        for (let i = 0; i < polyA.length; i++) {
            const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length];
            for (let j = 0; j < polyB.length; j++) {
                const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length];
                if (this.segmentsIntersect(a1, a2, b1, b2)) return true;
            }
        }
        if (this.pointInPolygon(polyA[0], polyB)) return true;
        if (this.pointInPolygon(polyB[0], polyA)) return true;
        return false;
    }

    segmentsIntersect(p1, p2, p3, p4) {
        function ccw(a, b, c) {
            return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
        }
        return (ccw(p1, p3, p4) !== ccw(p2, p3, p4)) && (ccw(p1, p2, p3) !== ccw(p1, p2, p4));
    }

    isPolygonInsidePolygon(innerPoly, outerPoly, marginMm = 0) {
        for (const pt of innerPoly) {
            if (!this.pointInPolygon(pt, outerPoly)) return false;
            if (marginMm > 0 && this.pointToPolygonMinDistance(pt, outerPoly) < marginMm) return false;
        }
        return true;
    }

    generateSamplePoints(poly, stepMm, maxPoints = 0) {
        // Muestreo PERIMETRAL (no de Ã¡rea): recorre las aristas del contorno emitiendo un
        // punto cada stepMm. Es O(perÃ­metro/step) en lugar de O(Ã¡rea/stepÂ²), imprescindible
        // para piezas con bounding boxes grandes (p. ej. DXF con coordenadas de metros), que
        // antes provocaban miles de millones de iteraciones y congelaban la interfaz.
        const pts = [];
        const cap = (typeof maxPoints === 'number' && maxPoints > 0) ? maxPoints : Infinity;
        const step = Math.max(0.05, stepMm);
        const n = poly ? poly.length : 0;
        if (n === 0) return pts;
        for (let i = 0; i < n; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % n];
            pts.push({ x: a.x, y: a.y });
            if (pts.length >= cap) return pts;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > step) {
                const segs = Math.floor(len / step);
                for (let s = 1; s <= segs; s++) {
                    const f = (s * step) / len;
                    pts.push({ x: a.x + dx * f, y: a.y + dy * f });
                    if (pts.length >= cap) return pts;
                }
            }
        }
        return pts;
    }

    /**
     * Distancia mÃ­nima en mm entre dos polÃ­gonos convexos o no convexos.
     * Recorre todos los pares de aristas (O(n*m)) y calcula la distancia
     * mÃ­nima entre segmentos. Si los polÃ­gonos se solapan, devuelve 0.
     */
    polygonMinDistance(polyA, polyB, maxDist = Infinity) {
        // DESCARTE RÃPIDO POR AABB (EuclÃ­deo): si los envolventes estÃ¡n mÃ¡s lejos que
        // maxDist no existe ninguna pareja de aristas mÃ¡s cercana, asÃ­ que devolvemos
        // maxDist sin recorrer el costoso doble bucle O(n*m). Imprescindible para que
        // refineSlideToContact() no se convierta en un bloqueo con piezas de muchos lados.
        if (Number.isFinite(maxDist)) {
            const ba = this.getPolygonBounds(polyA);
            const bb = this.getPolygonBounds(polyB);
            const gx = Math.max(ba.minX - bb.maxX, bb.minX - ba.maxX, 0);
            const gy = Math.max(ba.minY - bb.maxY, bb.minY - ba.maxY, 0);
            if (Math.sqrt(gx * gx + gy * gy) >= maxDist) return maxDist;
        }

        // Si se solapan, la distancia es 0
        if (this.polygonsIntersect(polyA, polyB)) return 0;

        // Distancia mÃ­nima EXHAUSTIVA arista-a-arista (segment-to-segment), O(n*m).
        // No basta vÃ©rticeâ†’polÃ­gono: dos aristas oblicuas pueden quedar a < spacing sin
        // que ninguna esquina estÃ© cerca de la otra (caso 8B vs 8D: arista oblicua del
        // trapecio contra la esquina del octÃ³gono). Si dos segmentos NO se cortan, su
        // distancia mÃ­nima ES el mÃ­nimo de las 4 distancias extremoâ†’segmento, asÃ­ que
        // este barrido captura punto-a-segmento Y arista-a-arista exactamente.
        const n = polyA.length;
        const m = polyB.length;
        let minDist = 1e9;
        for (let i = 0; i < n; i++) {
            const a1 = polyA[i];
            const a2 = polyA[(i + 1) % n];
            for (let j = 0; j < m; j++) {
                const b1 = polyB[j];
                const b2 = polyB[(j + 1) % m];
                let d = this.distToSegment(b1, a1, a2);
                if (d < minDist) minDist = d;
                d = this.distToSegment(b2, a1, a2);
                if (d < minDist) minDist = d;
                d = this.distToSegment(a1, b1, b2);
                if (d < minDist) minDist = d;
                d = this.distToSegment(a2, b1, b2);
                if (d < minDist) minDist = d;
                if (minDist === 0) return 0;
                // EARLY-EXIT: si el llamante sÃ³lo necesita el predicado "< maxDist"
                // (p. ej. isPositionFree), en cuanto una pareja baja del umbral la
                // respuesta booleana ya estÃ¡ decidida â†’ no seguir recorriendo.
                if (Number.isFinite(maxDist) && minDist < maxDist) return minDist;
            }
        }

        return minDist;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GpuDetector, UniversalGpuNestingEngine };
} else {
    window.GpuDetector = GpuDetector;
    window.UniversalGpuNestingEngine = UniversalGpuNestingEngine;
}


