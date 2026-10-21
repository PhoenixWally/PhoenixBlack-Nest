#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Motor de Imposición Nativa en Alta Resolución (Fase 2 + Adenda de Producción) - PhoenixBlackNest
Imposición de pliego industrial, normalización cartesiana estricta (Y-inversion sin efecto espejo),
capa Spot Color /CutContour, marcas de registro ópticas y optimización TSP.
"""

import sys
import os
import json
import math
from typing import List, Dict, Any, Tuple

MM_TO_PT = 72.0 / 25.4  # 1 mm = 2.83464567 pt
PT_TO_MM = 25.4 / 72.0

def solve_tsp_2opt(points: List[Tuple[float, float]]) -> List[int]:
    """
    Ordena una lista de puntos de corte utilizando Nearest Neighbor seguido de 2-Opt
    para minimizar los desplazamientos en vacío del cabezal de corte industrial.
    """
    n = len(points)
    if n <= 2:
        return list(range(n))

    unvisited = set(range(n))
    tour = []
    curr_pos = (0.0, 0.0)

    while unvisited:
        next_idx = min(unvisited, key=lambda idx: math.hypot(points[idx][0] - curr_pos[0], points[idx][1] - curr_pos[1]))
        tour.append(next_idx)
        unvisited.remove(next_idx)
        curr_pos = points[next_idx]

    def dist(i, j):
        return math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1])

    improved = True
    iterations = 0
    while improved and iterations < 50:
        improved = False
        iterations += 1
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                if j - i == 1:
                    continue
                d_current = dist(tour[i - 1], tour[i]) + dist(tour[j - 1], tour[j % n])
                d_new = dist(tour[i - 1], tour[j - 1]) + dist(tour[i], tour[j % n])
                if d_new < d_current - 1e-4:
                    tour[i:j] = reversed(tour[i:j])
                    improved = True
                    break
            if improved:
                break
    return tour

def generate_registration_marks(c, sheet_w_pt: float, sheet_h_pt: float, mark_type: str):
    """
    Dibuja marcas ópticas industriales para lectores láser de plotters de corte.
    Graphtec (escuadras), Summa (círculos 5mm con marcas intermedias de avance de bobina),
    y Zünd (círculos 6mm asimétricos).
    """
    if mark_type == 'none':
        return

    c.saveState()
    c.setStrokeColorCMYK(0, 0, 0, 1.0)
    c.setFillColorCMYK(0, 0, 0, 1.0)

    margin_pt = 10.0 * MM_TO_PT

    if mark_type == 'graphtec':
        l_len_pt = 5.0 * MM_TO_PT
        c.setLineWidth(1.0)

        # Esquinas L de 5x5 mm
        c.line(margin_pt, margin_pt, margin_pt + l_len_pt, margin_pt)
        c.line(margin_pt, margin_pt, margin_pt, margin_pt + l_len_pt)

        c.line(sheet_w_pt - margin_pt, margin_pt, sheet_w_pt - margin_pt - l_len_pt, margin_pt)
        c.line(sheet_w_pt - margin_pt, margin_pt, sheet_w_pt - margin_pt, margin_pt + l_len_pt)

        c.line(margin_pt, sheet_h_pt - margin_pt, margin_pt + l_len_pt, sheet_h_pt - margin_pt)
        c.line(margin_pt, sheet_h_pt - margin_pt, margin_pt, sheet_h_pt - margin_pt - l_len_pt)

        c.line(sheet_w_pt - margin_pt, sheet_h_pt - margin_pt, sheet_w_pt - margin_pt - l_len_pt, sheet_h_pt - margin_pt)
        c.line(sheet_w_pt - margin_pt, sheet_h_pt - margin_pt, sheet_w_pt - margin_pt, sheet_h_pt - margin_pt - l_len_pt)

    elif mark_type == 'summa':
        r_pt = 2.5 * MM_TO_PT
        corners = [
            (margin_pt, margin_pt),
            (sheet_w_pt - margin_pt, margin_pt),
            (margin_pt, sheet_h_pt - margin_pt),
            (sheet_w_pt - margin_pt, sheet_h_pt - margin_pt)
        ]
        for cx, cy in corners:
            c.circle(cx, cy, r_pt, stroke=0, fill=1)

        step_pt = 500.0 * MM_TO_PT
        curr_y = margin_pt + step_pt
        while curr_y < (sheet_h_pt - margin_pt - r_pt * 2):
            c.circle(margin_pt, curr_y, r_pt, stroke=0, fill=1)
            c.circle(sheet_w_pt - margin_pt, curr_y, r_pt, stroke=0, fill=1)
            curr_y += step_pt

    elif mark_type == 'zund':
        r_pt = 3.0 * MM_TO_PT
        corners = [
            (margin_pt, margin_pt),
            (sheet_w_pt - margin_pt, margin_pt),
            (margin_pt, sheet_h_pt - margin_pt),
            (sheet_w_pt - margin_pt, sheet_h_pt - margin_pt)
        ]
        for cx, cy in corners:
            c.circle(cx, cy, r_pt, stroke=0, fill=1)
        c.circle(margin_pt + 20.0 * MM_TO_PT, margin_pt, r_pt * 0.7, stroke=0, fill=1)

    c.restoreState()

def export_dxf_toolpath(output_dxf_path: str, sorted_polygons_mm: List[List[Tuple[float, float]]]):
    """
    Exporta el trazado de corte en formato DXF con coordenadas reales en mm (1:1, sin escala).
    Garantías:
      - $INSUNITS = 4 (milímetros): un donut de 200 mm mide 200.00 mm en el DXF, no 5080 mm.
      - Coordenadas en el primer cuadrante positivo (MinX >= 0, MinY >= 0).
      - Contornos cerrados LWPOLYLINE (closed=True) — sin splines rotos ni entidades LINE sueltas.
      - Capa 'CutContour' con color rojo (índice 1) para compatibilidad con Graphtec/Summa/Zünd.
    """
    import ezdxf

    # --- Normalización al primer cuadrante positivo ---
    # Si alguna coordenada es negativa, desplazar todos los polígonos para que MinX >= 3, MinY >= 3.
    global_min_x = min((p[0] for poly in sorted_polygons_mm for p in poly), default=0.0)
    global_min_y = min((p[1] for poly in sorted_polygons_mm for p in poly), default=0.0)
    offset_x = max(0.0, 3.0 - global_min_x) if global_min_x < 3.0 else 0.0
    offset_y = max(0.0, 3.0 - global_min_y) if global_min_y < 3.0 else 0.0

    doc = ezdxf.new('R2010', setup=True)
    # $INSUNITS = 4 → milímetros. Escala 1:1: 1 unidad DXF = 1 mm.
    doc.header['$INSUNITS'] = 4
    # $MEASUREMENT = 1 → sistema métrico (refuerza la interpretación en mm)
    doc.header['$MEASUREMENT'] = 1

    msp = doc.modelspace()
    doc.layers.new(name='CutContour', dxfattribs={'color': 1})  # Rojo = índice 1 (CutContour estándar)

    for poly in sorted_polygons_mm:
        if len(poly) < 3:
            continue  # Polígono degenerado — ignorar para evitar LWPOLYLINE inválida
        # Aplicar offset de normalización y garantizar que las coordenadas sean float
        pts = [(float(p[0]) + offset_x, float(p[1]) + offset_y) for p in poly]
        msp.add_lwpolyline(pts, close=True, dxfattribs={'layer': 'CutContour'})

    doc.saveas(output_dxf_path)

def build_cut_polygons(placements: List[Dict[str, Any]], sheet_h_mm: float) -> Tuple[List[List[Tuple[float, float]]], List[Tuple[float, float]]]:
    """
    Devuelve (poligonos_mm, centros) en el sistema de la plancha (Y invertida PostScript).
    Fuente de verdad: los vértices EXACTOS 'absolute_polygon_mm' / 'absolute_holes_mm'
    emitidos por el motor GPU. Si no existen, cae al modo local+rotación+traslación.
    """
    raw_polygons_mm = []
    centers_for_tsp = []

    for p in placements:
        outer_abs = p.get('absolute_polygon_mm') or []
        holes_abs = p.get('absolute_holes_mm') or []

        piece_polys_mm = []
        if len(outer_abs) >= 3:
            piece_polys_mm.append([(float(pt[0]), sheet_h_mm - float(pt[1])) for pt in outer_abs])
            for hole in holes_abs:
                if len(hole) >= 3:
                    piece_polys_mm.append([(float(pt[0]), sheet_h_mm - float(pt[1])) for pt in hole])
        else:
            cut_poly = p.get('cut_polygon_mm', [])
            if len(cut_poly) >= 3:
                x0_mm = float(p.get('x_mm', 0.0))
                y0_mm = float(p.get('y_mm', 0.0))
                rot_rad = math.radians(float(p.get('rotation_deg', 0.0)))
                cos_r = math.cos(rot_rad)
                sin_r = math.sin(rot_rad)
                poly_sheet = []
                for pt in cut_poly:
                    px, py = float(pt[0]), float(pt[1])
                    rx = px * cos_r - py * sin_r + x0_mm
                    ry = px * sin_r + py * cos_r + y0_mm
                    poly_sheet.append((rx, sheet_h_mm - ry))
                piece_polys_mm.append(poly_sheet)

        for poly_sheet in piece_polys_mm:
            raw_polygons_mm.append(poly_sheet)
            cx = sum(pt[0] for pt in poly_sheet) / len(poly_sheet)
            cy = sum(pt[1] for pt in poly_sheet) / len(poly_sheet)
            centers_for_tsp.append((cx, cy))

    return raw_polygons_mm, centers_for_tsp

def generate_dxf_only(job_config: Dict[str, Any], output_dxf_path: str):
    """Genera SOLO el trazado de corte DXF (CutContour) con la geometría exacta del motor."""
    sheet_w_mm = float(job_config.get('sheet_width_mm', 1200.0))
    sheet_h_mm = float(job_config.get('sheet_height_mm', 2400.0))
    placements = job_config.get('placements', [])

    raw_polygons_mm, centers_for_tsp = build_cut_polygons(placements, sheet_h_mm)
    if centers_for_tsp:
        sorted_indices = solve_tsp_2opt(centers_for_tsp)
        sorted_polygons = [raw_polygons_mm[idx] for idx in sorted_indices]
    else:
        sorted_polygons = raw_polygons_mm

    export_dxf_toolpath(output_dxf_path, sorted_polygons)

    return {
        "dxf_path": os.path.abspath(output_dxf_path),
        "total_polygons": len(sorted_polygons),
        "sheet_dimensions_mm": [sheet_w_mm, sheet_h_mm],
        "tsp_optimized": True
    }

def placement_bbox_mm(p: Dict[str, Any], bleed_mm: float = 0.0):
    """
    Bounding Box EXACTO (mm, sistema SVG Y-abajo) del contorno FINAL colocado en la
    bobina, calculado SIEMPRE a partir de 'absolute_polygon_mm' (vértices exactos que
    emite el motor GPU). NUNCA usa x_mm/y_mm: esas coordenadas incluyen el rotOffset de
    normalización y desplazaban el arte respecto a su CutContour (el relleno se separaba
    del trazado de corte cuando el polígono original no empezaba en (0,0)).
    Devuelve (min_x - bleed, min_y - bleed, max_x + bleed, max_y + bleed) o None.
    """
    outer = p.get('absolute_polygon_mm') or []
    if len(outer) < 3:
        return None
    xs = [float(pt[0]) for pt in outer]
    ys = [float(pt[1]) for pt in outer]
    return (min(xs) - bleed_mm, min(ys) - bleed_mm, max(xs) + bleed_mm, max(ys) + bleed_mm)

def artwork_target_rect_pt(p: Dict[str, Any], sheet_h_mm: float, bleed_mm: float = 0.0):
    """
    Rect destino del arte (imagen ráster o PDF vectorial) en PUNTOS y en coordenadas
    PDF (Y-arriba): (tx0, ty0, width, height). Se deriva EXCLUSIVAMENTE del BBox de
    'absolute_polygon_mm' (± bleed), de modo que la caja del arte coincide al 0.001 mm
    con el CutContour. Devuelve None si la pieza no tiene polígono colocado válido.
    """
    bbox = placement_bbox_mm(p, bleed_mm)
    if bbox is None:
        return None
    bx0, by0, bx1, by1 = bbox
    return (bx0 * MM_TO_PT,
            (sheet_h_mm - by1) * MM_TO_PT,
            (bx1 - bx0) * MM_TO_PT,
            (by1 - by0) * MM_TO_PT)

def generate_pdf_imposition(job_config: Dict[str, Any], output_pdf_path: str):
    """
    Genera el archivo PDF industrial con estampación de alta resolución,
    normalización estricta del eje Y (SVG vs PostScript), capa CutContour en Spot Color
    y marcas de registro.
    """
    from reportlab.pdfgen import canvas
    from reportlab.lib.colors import CMYKColor, CMYKColorSep
    from PIL import Image

    sheet_w_mm = float(job_config.get('sheet_width_mm', 1200.0))
    sheet_h_mm = float(job_config.get('sheet_height_mm', 2400.0))
    mark_type = job_config.get('mark_type', 'summa')
    placements = job_config.get('placements', [])

    sheet_w_pt = sheet_w_mm * MM_TO_PT
    sheet_h_pt = sheet_h_mm * MM_TO_PT

    # Separamos activos vectoriales PDF de activos ráster
    has_pdf_assets = any(os.path.splitext(p.get('source_path') or '')[1].lower() in ('.pdf', '.pdfx') for p in placements if p.get('source_path') and os.path.exists(p.get('source_path')))

    overlay_pdf_path = output_pdf_path + ".tmp_overlay.pdf" if has_pdf_assets else output_pdf_path
    c = canvas.Canvas(overlay_pdf_path, pagesize=(sheet_w_pt, sheet_h_pt))
    c.setTitle("PhoenixBlackNest Industrial Imposition - " + os.path.basename(output_pdf_path))

    CutContourColor = CMYKColorSep(0.0, 1.0, 0.0, 0.0, spotName='CutContour')

    # 1. Capa de Arte Ráster (TIFF, PNG, JPG)
    # El arte se ancla EXACTAMENTE sobre el Bounding Box del contorno colocado
    # (absolute_polygon_mm ± bleed), NUNCA sobre x_mm/y_mm (que incluyen rotOffset).
    bleed_mm = float(job_config.get('bleed_mm', 0.0) or 0.0)
    for p in placements:
        src = p.get('source_path', '')
        if not src or not os.path.exists(src):
            continue

        ext = os.path.splitext(src)[1].lower()
        if ext not in ('.tif', '.tiff', '.png', '.jpg', '.jpeg', '.bmp', '.webp'):
            continue

        rot_deg = float(p.get('rotation_deg', 0.0))
        rot_norm = int(round(rot_deg)) % 360

        rect = artwork_target_rect_pt(p, sheet_h_mm, bleed_mm)
        if rect is None:
            continue
        tx0, ty0, tw_pt, th_pt = rect   # PDF (Y-arriba), en puntos

        # Dibujar la imagen CENTRADA en el rect destino y rotada (mismo sentido visual que
        # el polígono) alrededor de ese centro: su caja delimitadora coincide al 0.001 mm
        # con [bbox ± bleed] con independencia del offset de origen del polígono original.
        cx = tx0 + tw_pt / 2.0
        cy = ty0 + th_pt / 2.0
        if rot_norm in (90, 270):
            draw_w_pt, draw_h_pt = th_pt, tw_pt
        else:
            draw_w_pt, draw_h_pt = tw_pt, th_pt

        c.saveState()
        c.translate(cx, cy)
        if rot_norm != 0:
            c.rotate(-rot_deg)
        c.drawImage(src, -draw_w_pt / 2.0, -draw_h_pt / 2.0,
                    width=draw_w_pt, height=draw_h_pt,
                    preserveAspectRatio=False, mask='auto')
        c.restoreState()

    # 2. Marcas Ópticas de Registro
    generate_registration_marks(c, sheet_w_pt, sheet_h_pt, mark_type)

    # 3. Capa de Corte (CutContour) y Optimización TSP con Inversión Y Normalizada
    raw_polygons_mm, centers_for_tsp = build_cut_polygons(placements, sheet_h_mm)

    if centers_for_tsp:
        sorted_indices = solve_tsp_2opt(centers_for_tsp)
        sorted_polygons = [raw_polygons_mm[idx] for idx in sorted_indices]
    else:
        sorted_polygons = raw_polygons_mm

    c.saveState()
    c.setStrokeColor(CutContourColor)
    c.setFillColor(CMYKColor(0, 0, 0, 0))
    c.setLineWidth(0.25)

    for poly in sorted_polygons:
        if len(poly) >= 2:
            path = c.beginPath()
            path.moveTo(poly[0][0] * MM_TO_PT, poly[0][1] * MM_TO_PT)
            for pt in poly[1:]:
                path.lineTo(pt[0] * MM_TO_PT, pt[1] * MM_TO_PT)
            path.close()
            c.drawPath(path, stroke=1, fill=0)

    c.restoreState()
    c.showPage()
    c.save()

    # Si hay activos vectoriales PDF, los incrustamos de forma nativa sin rasterizar
    if has_pdf_assets:
        from pypdf import PdfReader, PdfWriter, Transformation
        final_writer = PdfWriter()
        master_page = final_writer.add_blank_page(width=sheet_w_pt, height=sheet_h_pt)

        for p in placements:
            src = p.get('source_path', '')
            if not src or not os.path.exists(src):
                continue
            ext = os.path.splitext(src)[1].lower()
            if ext not in ('.pdf', '.pdfx'):
                continue

            rot_deg = float(p.get('rotation_deg', 0.0))
            rot_norm = int(round(rot_deg)) % 360

            rect = artwork_target_rect_pt(p, sheet_h_mm, bleed_mm)
            if rect is None:
                continue
            tx0, ty0, tw_pt, th_pt = rect

            reader = PdfReader(src)
            src_page = reader.pages[0]
            box = src_page.mediabox
            item_w_pt = float(box.width)
            item_h_pt = float(box.height)

            # Escala para que el arte (ya rotado) llene EXACTAMENTE el rect destino.
            if rot_norm in (90, 270):
                sx = tw_pt / item_h_pt if item_h_pt else 0.0
                sy = th_pt / item_w_pt if item_w_pt else 0.0
            else:
                sx = tw_pt / item_w_pt if item_w_pt else 0.0
                sy = th_pt / item_h_pt if item_h_pt else 0.0

            # Pivote = CENTRO del arte: se estira, se rota (sentido visual del polígono) y
            # se traslada el centro al centro del rect destino. Elimina el desplazamiento
            # del relleno respecto al CutContour con offset de origen y rotaciones 90/180/270.
            # (Orden pypdf: la operación más a la derecha se aplica primero al punto.)
            trans = (Transformation()
                     .translate(-item_w_pt / 2.0, -item_h_pt / 2.0)
                     .scale(sx, sy)
                     .rotate(-rot_deg)
                     .translate(tx0 + tw_pt / 2.0, ty0 + th_pt / 2.0))

            src_page.add_transformation(trans)
            master_page.merge_page(src_page)

        # Merge de las marcas y CutContour
        overlay_reader = PdfReader(overlay_pdf_path)
        master_page.merge_page(overlay_reader.pages[0])

        with open(output_pdf_path, 'wb') as f_out:
            final_writer.write(f_out)

        try:
            os.remove(overlay_pdf_path)
        except OSError:
            pass

    # DXF auxiliar
    base_no_ext = os.path.splitext(output_pdf_path)[0]
    output_dxf_path = base_no_ext + "_CutContour.dxf"
    export_dxf_toolpath(output_dxf_path, sorted_polygons)

    return {
        "pdf_path": os.path.abspath(output_pdf_path),
        "dxf_path": os.path.abspath(output_dxf_path),
        "total_parts": len(sorted_polygons),
        "sheet_dimensions_mm": [sheet_w_mm, sheet_h_mm],
        "mark_type": mark_type,
        "tsp_optimized": True
    }

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Uso: python pdf_imposition_exporter.py <job_config.json> <output_file> [pdf|dxf]", file=sys.stderr)
        sys.exit(1)

    config_file = sys.argv[1]
    output_file = sys.argv[2]
    mode = sys.argv[3].lower() if len(sys.argv) > 3 else 'pdf'

    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            job_data = json.load(f)

        if mode == 'dxf':
            output_dxf = output_file if output_file.lower().endswith('.dxf') else os.path.splitext(output_file)[0] + '.dxf'
            result = generate_dxf_only(job_data, output_dxf)
        else:
            result = generate_pdf_imposition(job_data, output_file)

        print("---BEGIN_EXPORT_RESULT---")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("---END_EXPORT_RESULT---")
    except Exception as e:
        print("---BEGIN_ERROR---", file=sys.stderr)
        print(str(e), file=sys.stderr)
        print("---END_ERROR---", file=sys.stderr)
        sys.exit(1)
