# PhoenixBlackNest

**Anidado true-shape en GPU para corte industrial.** Lee DXF/DWG/SVG/PDF e imágenes, extrae el contorno real de cada pieza (con sus agujeros), coloca todo sin solaparse sobre hojas fijas o bobina continua, y exporta DXF 1:1 mm y PDF de imposición listos para producción.

- Web: [Landing page](docs/index.html)
- Licencia: **AGPL-3.0** (ver [LICENSE](LICENSE))

## El problema

El anidado manual en CAD deja material sobre la mesa: las piezas se colocan por bounding box, se ignoran agujeros e islas, y los huecos entre formas complejas se desperdician. Además, verificar que dos piezas no se tocan exige comprobaciones geométricas caras que un programa secuencial no puede hacer miles de veces por segundo.

## Qué hace

1. **Ingesta true-shape**: DXF (LINE/ARC/SPLINE/LWPOLYLINE con cosido topológico), DWG (vía ODA File Converter si está instalado), SVG (transformaciones, curvas, `use`), PDF vectorial y rasters (PNG/JPG/TIFF/WEBP/BMP) con detección de silueta.
2. **Jerarquía de contornos**: distingue exterior, agujeros e islas, y normaliza cada pieza a milímetros reales.
3. **Evaluación en GPU**: el motor WebGL2 rasteriza la hoja y todas las piezas en un ping-pong 2048×1024, evalúa hasta 8 piezas por pasada con 96 muestras por pieza y min-pooling de profundidad, descartando en el shader los píxeles que no pueden ganar.
4. **Refinado al contacto**: cada candidato se desliza hasta tocar la geometría ya colocada respetando el `spacing` exacto.
5. **Búsqueda genética**: selección, rotaciones en pasos de 1°, y ventana fina alrededor de las mejores soluciones.
6. **Hojas fijas o bobina**: reparto en múltiples hojas o rollo continuo con extensión incremental de la rejilla.
7. **Exportación**: DXF con `LWPOLYLINE` cerrada en capa `CutContour` (`$INSUNITS=4`) y PDF de imposición con marcas de corte, sangrado e incrustación vectorial.

## Rendimiento medido

| Métrica | Valor |
|---|---|
| Utilización bobina (lote real, 144 piezas) | 72.2 % |
| Utilización hojas fijas (set de auditoría, 180 piezas, 24 formas complejas) | 54.1 % |
| Solape de material | 0.000000 mm² |
| Separación mínima | 3.0000 mm (spacing configurado) |
| Coste por lote evaluado | 3.78 ms |
| Ritmo | 4.23 s/gen (fijas) · 4.96 s/gen (bobina) |

Medido en Windows 11 con GPU Intel Arc; el rendimiento depende del equipo.

## Requisitos

- Windows x64
- Node.js 18+ y npm (para Electron)
- Python 3.13 con: `shapely ezdxf reportlab pillow numpy opencv-python-headless pymupdf pypdf`

Instalación de dependencias:

```bat
npm install
python -m pip install shapely ezdxf reportlab pillow numpy opencv-python-headless pymupdf pypdf
```

## Uso

```bat
run.bat
```

o

```bat
npm start
```

1. **Importar**: arrastra o selecciona DXF/DWG/SVG/PDF/imágenes. Cada archivo se convierte a contornos en milímetros; se muestran vértices y agujeros detectados.
2. **Configurar**: tamaño de hoja o modo bobina, `spacing`, sangrado, cantidad de copias por pieza y paso de rotación.
3. **Anidar**: el motor corre en un worker GPU oculto y reporta cada generación. Se puede detener en cualquier momento.
4. **Exportar**: DXF 1:1 mm (`CutContour`) y PDF de imposición.

Variables de entorno útiles:

| Variable | Uso |
|---|---|
| `PHOENIXBLACKNEST_PYTHON` | Ruta al intérprete Python a usar |
| `NEST_SAMPLES` | Carpeta de muestras para las pruebas |
| `MODE`, `GEN` | Modo y generaciones en `tests/test_audit_180.js` |

## Pruebas

```bat
node_modules\electron\dist\electron.exe tests\test_precision_1deg.js
node_modules\electron\dist\electron.exe tests\test_real_stress.js
node_modules\electron\dist\electron.exe tests\test_roll.js
```

## Arquitectura

```
main.js                  proceso principal Electron (ventanas, IPC, Python)
worker/gpu_worker.html   worker GPU oculto (WebGL2)
worker/engine_bridge.js  puente IPC del worker
engine/universal_gpu_engine.js   rasterizado, evaluación y minería de piezas
engine/core_nesting_engine.js    GA, hojas, bobina, compactación, ocupación
engine/local_cad_converter.py    ingesta DXF/DWG/SVG/PDF/raster
engine/pdf_imposition_exporter.py DXF 1:1 + PDF de imposición
ui/                      interfaz desacoplada
```

## Licencia y terceros

Este proyecto se distribuye bajo **GNU Affero General Public License v3.0**. Al distribuir el programa (o un servicio basado en él) debes ofrecer también el código fuente bajo la misma licencia.

Incluye o depende de:

- **PyMuPDF (MuPDF)** — AGPL-3.0 (Artifex). Es la razón de la licencia del proyecto.
- **Electron / Chromium** — MIT / BSD-3-Clause (avisos incluidos en el instalador de Electron).
- **ezdxf, shapely, reportlab, Pillow, numpy, pypdf, pdfplumber** — MIT/BSD.
- **OpenCV** — Apache-2.0.
- **ODA File Converter** — propietario y gratuito; **no se distribuye** con este proyecto. Si está instalado, se usa para convertir DWG.

PyMuPDF es AGPL-3.0. Si necesitas una distribución cerrada, sustituye PyMuPDF por una alternativa permisiva o adquiere una licencia comercial de Artifex.
