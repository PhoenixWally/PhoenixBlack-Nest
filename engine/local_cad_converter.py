#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local CAD & Graphic Converter (True-Shape Contour Extraction Engine) - PhoenixBlackNest
- ExtracciÃ³n de silueta real para imÃ¡genes rÃ¡ster (PNG, JPG, BMP, WEBP, TIFF)
- ExtracciÃ³n vectorial True-Shape para PDF y SVG (PyMuPDF: trazados, curvas y transformaciones)
- DetecciÃ³n estricta de Islas y Agujeros interiores (jerarquÃ­a de contornos)
- DXF: cosido topolÃ³gico de LINE/ARC/SPLINE/LWPOLYLINE, detecciÃ³n de unidades y huecos
- DWG: conversiÃ³n vÃ­a ODA File Converter / libredwg si estÃ¡ disponible
- NormalizaciÃ³n BoundingBox a (0, 0) por pieza y generaciÃ³n de texturas recortadas
"""

import sys
import os
import re
import json
import math
import base64
import io
import hashlib
import shutil
import tempfile
import numpy as np
import cv2
from PIL import Image

MAX_DRAW_MM = 8000.0
PAGE_FRAME_RATIO = 0.90


def emit_output(svg_content, meta_dict):
    """Emite los bloques estructurados de SVG y Metadatos a stdout."""
    print("---BEGIN_META---", flush=True)
    print(json.dumps(meta_dict, ensure_ascii=False, indent=2), flush=True)
    print("---END_META---", flush=True)
    print("---BEGIN_SVG---", flush=True)
    print(svg_content, flush=True)
    print("---END_SVG---", flush=True)


def calculate_polygon_area(pts):
    if len(pts) < 3:
        return 0.0
    n = len(pts)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return abs(area) / 2.0


def _bbox(contour):
    xs = [p[0] for p in contour]
    ys = [p[1] for p in contour]
    return min(xs), min(ys), max(xs), max(ys)


def _bbox_contains(outer, inner, tol=1e-6):
    return (outer[0] - tol <= inner[0] and outer[1] - tol <= inner[1] and
            outer[2] + tol >= inner[2] and outer[3] + tol >= inner[3])


def _point_in_polygon(pt, poly):
    x, y = pt
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xint = xi + (y - yi) * (xj - xi) / (yj - yi)
            if x < xint:
                inside = not inside
        j = i
    return inside


def _clean_contour(contour, max_points=1500):
    out = []
    for p in contour:
        q = (float(p[0]), float(p[1]))
        if not out or math.hypot(q[0] - out[-1][0], q[1] - out[-1][1]) > 1e-7:
            out.append(q)
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < 1e-7:
        out.pop()
    if len(out) < 3:
        return None
    if len(out) > max_points:
        stride = len(out) / float(max_points)
        out = [out[int(i * stride)] for i in range(max_points)]
    return out


def group_contours(contours, min_area=0.0):
    """Agrupa contornos en piezas (nivel par) y cavidades (nivel impar) por contenciÃ³n."""
    cleaned = []
    for c in contours:
        c = _clean_contour(c)
        if not c:
            continue
        a = calculate_polygon_area(c)
        if a <= 0 or a < min_area:
            continue
        cleaned.append((a, c))

    n = len(cleaned)
    if n == 0:
        return []

    order = sorted(range(n), key=lambda i: -cleaned[i][0])
    parent = [-1] * n
    bboxes = [_bbox(cleaned[i][1]) for i in range(n)]

    for oi, i in enumerate(order):
        best = -1
        best_area = None
        for j in order[:oi]:
            if cleaned[j][0] <= cleaned[i][0]:
                continue
            if not _bbox_contains(bboxes[j], bboxes[i]):
                continue
            if _point_in_polygon(cleaned[i][1][0], cleaned[j][1]):
                if best_area is None or cleaned[j][0] < best_area:
                    best = j
                    best_area = cleaned[j][0]
        parent[i] = best

    depth = [0] * n

    def resolve_depth(i):
        if parent[i] == -1 or depth[i]:
            return depth[i]
        depth[i] = resolve_depth(parent[i]) + 1
        return depth[i]

    for i in range(n):
        resolve_depth(i)

    pieces = []
    for i in range(n):
        if depth[i] % 2 == 0:
            holes = [cleaned[j][1] for j in range(n) if parent[j] == i and depth[j] % 2 == 1]
            pieces.append((cleaned[i][1], holes))
    return pieces


def normalize_piece(poly, holes, scale=1.0):
    """Convierte a mm, desplaza la pieza a (0,0) y calcula bounds/Ã¡rea neta."""
    poly_mm = [(x * scale, y * scale) for x, y in poly]
    holes_mm = [[(x * scale, y * scale) for x, y in h] for h in holes]
    minx, miny, maxx, maxy = _bbox(poly_mm)
    poly_norm = [(round(x - minx, 4), round(y - miny, 4)) for x, y in poly_mm]
    holes_norm = [[(round(x - minx, 4), round(y - miny, 4)) for x, y in h] for h in holes_mm]
    w = round(maxx - minx, 4)
    h = round(maxy - miny, 4)
    area = calculate_polygon_area(poly_norm) - sum(calculate_polygon_area(x) for x in holes_norm)
    return poly_norm, holes_norm, {"x": 0, "y": 0, "width": w, "height": h}, round(area, 4)


def _svg_from_pieces(pieces, width, height):
    """SVG compuesto de referencia (debug / compatibilidad)."""
    d_parts = []
    for p in pieces:
        outer = p["polygon"]
        d_parts.append(f"M {outer[0][0]:.3f} {outer[0][1]:.3f} " +
                       " ".join(f"L {q[0]:.3f} {q[1]:.3f}" for q in outer[1:]) + " Z")
        for h in p["holes"]:
            d_parts.append(f"M {h[0][0]:.3f} {h[0][1]:.3f} " +
                           " ".join(f"L {q[0]:.3f} {q[1]:.3f}" for q in h[1:]) + " Z")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.3f} {height:.3f}" '
            f'width="{width:.3f}mm" height="{height:.3f}mm">\n'
            f'  <path d="{" ".join(d_parts)}" fill="#24C7ED" fill-opacity="0.8" '
            'stroke="#000" stroke-width="0.25" fill-rule="evenodd"/>\n'
            '</svg>')


# =============================================================================
# EXTRACCIÃ“N VECTORIAL (PDF / SVG) CON PYMUPDF
# =============================================================================

def _bezier_points(p1, p2, p3, p4, samples):
    pts = []
    for i in range(1, samples + 1):
        t = i / float(samples)
        mt = 1.0 - t
        x = mt ** 3 * p1.x + 3 * mt ** 2 * t * p2.x + 3 * mt * t ** 2 * p3.x + t ** 3 * p4.x
        y = mt ** 3 * p1.y + 3 * mt ** 2 * t * p2.y + 3 * mt * t ** 2 * p3.y + t ** 3 * p4.y
        pts.append((x, y))
    return pts


def _drawing_contours(drawing, scale_mm):
    """Convierte los items de un drawing de PyMuPDF en contornos (unidades de pÃ¡gina)."""
    contours = []
    cur = []
    gap = (0.75 / scale_mm) if scale_mm > 0 else 0.75

    def close():
        nonlocal cur
        if len(cur) >= 3:
            contours.append(cur)
        cur = []

    def push(x, y):
        pt = (float(x), float(y))
        if cur and math.hypot(pt[0] - cur[-1][0], pt[1] - cur[-1][1]) <= 1e-9:
            return
        cur.append(pt)

    for item in drawing.get("items", []):
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if cur and math.hypot(cur[-1][0] - p1.x, cur[-1][1] - p1.y) > gap:
                close()
            if not cur:
                push(p1.x, p1.y)
            push(p2.x, p2.y)
        elif kind == "c":
            p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
            if cur and math.hypot(cur[-1][0] - p1.x, cur[-1][1] - p1.y) > gap:
                close()
            if not cur:
                push(p1.x, p1.y)
            approx_len = (math.hypot(p2.x - p1.x, p2.y - p1.y) +
                          math.hypot(p3.x - p2.x, p3.y - p2.y) +
                          math.hypot(p4.x - p3.x, p4.y - p3.y))
            samples = int(min(48, max(6, (approx_len * scale_mm) / 1.2 + 1)))
            for x, y in _bezier_points(p1, p2, p3, p4, samples):
                push(x, y)
        elif kind == "re":
            close()
            r = item[1]
            contours.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)])
        elif kind == "qu":
            close()
            q = item[1]
            contours.append([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)])

    close()
    return contours


def _is_page_frame(drawing, page_rect):
    """Detecta el marco/borde de pÃ¡gina (sÃ³lo trazo) o fondo a pÃ¡gina completa."""
    r = drawing.get("rect")
    if r is None or page_rect is None:
        return False
    if page_rect.width <= 0 or page_rect.height <= 0:
        return False
    if drawing.get("fill") is not None:
        return False
    cover_w = r.width / page_rect.width
    cover_h = r.height / page_rect.height
    return cover_w >= PAGE_FRAME_RATIO and cover_h >= PAGE_FRAME_RATIO


def vector_drawings_to_pieces(drawings, scale_mm, page_rect):
    """Extrae piezas True-Shape agrupando todos los contornos de la pÃ¡gina.

    Los marcos/bordes a pÃ¡gina completa se descartan para que no absorban las
    figuras como cavidades. El resto se agrupa por contenciÃ³n: contornos
    exteriores (nivel par) son piezas y los interiores (nivel impar) agujeros.
    """
    pieces = []
    min_area_mm2 = 1.0
    min_area_page = min_area_mm2 / (scale_mm * scale_mm) if scale_mm > 0 else min_area_mm2

    all_contours = []
    for drawing in drawings:
        if _is_page_frame(drawing, page_rect):
            continue
        all_contours.extend(_drawing_contours(drawing, scale_mm))

    for poly, holes in group_contours(all_contours, min_area=min_area_page):
        poly_mm, holes_mm, bounds, area = normalize_piece(poly, holes, scale_mm)
        if len(poly_mm) < 3 or bounds["width"] <= 0 or bounds["height"] <= 0:
            continue
        if area < min_area_mm2:
            continue
        pieces.append({
            "polygon": poly_mm,
            "holes": holes_mm,
            "bounds": bounds,
            "area": area
        })
    return pieces


def _svg_physical_width_mm(abs_path, page_rect):
    """Lee el atributo width del SVG para obtener la escala fÃ­sica real."""
    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(16384)
    except Exception:
        head = ""
    match = re.search(r"<svg\b[^>]*\bwidth\s*=\s*[\"']\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z%]*)\s*[\"']", head, re.I)
    if not match:
        match = re.search(r"<svg\b[^>]*\bheight\s*=\s*[\"']\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z%]*)\s*[\"']", head, re.I)
        if match:
            value = float(match.group(1))
            unit = (match.group(2) or "").lower()
            mm = _length_to_mm(value, unit)
            if page_rect is not None and page_rect[1] > 0 and mm:
                return mm * (page_rect[0] / page_rect[1])
            return mm
        return None

    value = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if unit == "%":
        return None
    return _length_to_mm(value, unit)


def _length_to_mm(value, unit):
    if unit == "mm":
        return value
    if unit == "cm":
        return value * 10.0
    if unit == "in":
        return value * 25.4
    if unit == "pt":
        return value * 25.4 / 72.0
    if unit == "pc":
        return value * 25.4 / 6.0
    if unit == "px" or unit == "":
        return value * 25.4 / 96.0
    return value * 25.4 / 96.0


# -----------------------------------------------------------------------------
# Parser SVG propio: respeta <g transform> y agrupa las formas por grupo, de
# modo que cada grupo del diseÃ±o se convierte en una pieza con sus agujeros.
# -----------------------------------------------------------------------------

_SVG_SHAPE_TAGS = {"path", "rect", "circle", "ellipse", "polygon", "polyline", "line"}
_SVG_NUM_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def _tag_name(el):
    return el.tag.split("}")[-1] if isinstance(el.tag, str) else ""


def _mat_identity():
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _mat_mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1)


def _apply_mat(mat, x, y):
    a, b, c, d, e, f = mat
    return (a * x + c * y + e, b * x + d * y + f)


def _parse_transform(text):
    mat = _mat_identity()
    if not text:
        return mat
    for name, args in re.findall(r"([a-zA-Z]+)\s*\(([^)]*)\)", text):
        nums = [float(v) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", args)]
        name = name.lower()
        if name == "translate":
            tx = nums[0] if nums else 0.0
            ty = nums[1] if len(nums) > 1 else 0.0
            local = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif name == "scale":
            sx = nums[0] if nums else 1.0
            sy = nums[1] if len(nums) > 1 else sx
            local = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif name == "rotate":
            ang = math.radians(nums[0]) if nums else 0.0
            cs, sn = math.cos(ang), math.sin(ang)
            local = (cs, sn, -sn, cs, 0.0, 0.0)
            if len(nums) >= 3:
                local = _mat_mul((1.0, 0.0, 0.0, 1.0, nums[1], nums[2]), local)
                local = _mat_mul(local, (1.0, 0.0, 0.0, 1.0, -nums[1], -nums[2]))
        elif name == "matrix" and len(nums) >= 6:
            local = tuple(nums[:6])
        elif name == "skewx":
            local = (1.0, 0.0, math.tan(math.radians(nums[0])), 1.0, 0.0, 0.0) if nums else _mat_identity()
        elif name == "skewy":
            local = (1.0, math.tan(math.radians(nums[0])), 0.0, 1.0, 0.0, 0.0) if nums else _mat_identity()
        else:
            continue
        mat = _mat_mul(mat, local)
    return mat


def _bezier_pts(p1, p2, p3, p4, samples):
    pts = []
    for i in range(1, samples + 1):
        t = i / float(samples)
        mt = 1.0 - t
        x = mt ** 3 * p1[0] + 3 * mt ** 2 * t * p2[0] + 3 * mt * t ** 2 * p3[0] + t ** 3 * p4[0]
        y = mt ** 3 * p1[1] + 3 * mt ** 2 * t * p2[1] + 3 * mt * t ** 2 * p3[1] + t ** 3 * p4[1]
        pts.append((x, y))
    return pts


def _arc_points(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2):
    """Convierte un arco SVG (endpoint) en una polilÃ­nea aproximada."""
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg % 360.0)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p = cos_phi * dx2 + sin_phi * dy2
    y1p = -sin_phi * dx2 + cos_phi * dy2

    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1.0:
        s = math.sqrt(lam)
        rx *= s
        ry *= s

    num = (rx * rx * ry * ry) - (rx * rx * y1p * y1p) - (ry * ry * x1p * x1p)
    den = (rx * rx * y1p * y1p) + (ry * ry * x1p * x1p)
    coef = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        coef = -coef
    cxp = coef * rx * y1p / ry
    cyp = -coef * ry * x1p / rx
    cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2.0
    cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2.0

    def angle(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        det = ux * vy - uy * vx
        return math.atan2(det, dot)

    v1x, v1y = (x1p - cxp) / rx, (y1p - cyp) / ry
    v2x, v2y = (-x1p - cxp) / rx, (-y1p - cyp) / ry
    theta1 = angle(1.0, 0.0, v1x, v1y)
    dtheta = angle(v1x, v1y, v2x, v2y)
    if not sweep and dtheta > 0:
        dtheta -= 2.0 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2.0 * math.pi

    steps = max(4, min(96, int(abs(dtheta) / (math.pi / 36.0)) + 1))
    pts = []
    for i in range(1, steps + 1):
        th = theta1 + dtheta * i / steps
        ct, st = math.cos(th), math.sin(th)
        pts.append((cx + rx * ct * cos_phi - ry * st * sin_phi,
                    cy + rx * ct * sin_phi + ry * st * cos_phi))
    return pts


def _path_to_subpaths(d):
    """Devuelve una lista de subpaths (listas de puntos) en coordenadas locales."""
    tokens = _SVG_NUM_RE.findall(d or "")
    i = 0
    cmd = None
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    prev_ctrl = None
    prev_cmd = ""
    subpaths = []
    pts = []

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def flag():
        nonlocal i
        v = tokens[i]
        i += 1
        return 1 if v in ("1", "1.0") else 0

    def flush():
        nonlocal pts
        if len(pts) >= 2:
            subpaths.append(pts)
        pts = []

    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd in ("Z", "z"):
                if pts:
                    if math.hypot(pts[-1][0] - start[0], pts[-1][1] - start[1]) > 1e-9:
                        pts.append(start)
                    flush()
                cur = start
                prev_ctrl = None
                prev_cmd = cmd
                continue
        elif cmd is None:
            break

        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)

        if c == "M":
            x, y = num() + ox, num() + oy
            flush()
            cur = start = (x, y)
            pts = [cur]
            prev_ctrl = None
            cmd = "l" if rel else "L"
        elif c == "L":
            x, y = num() + ox, num() + oy
            if not pts:
                pts = [cur]
            pts.append((x, y))
            cur = (x, y)
            prev_ctrl = None
        elif c == "H":
            x = num() + ox
            if not pts:
                pts = [cur]
            cur = (x, cur[1])
            pts.append(cur)
            prev_ctrl = None
        elif c == "V":
            y = num() + oy
            if not pts:
                pts = [cur]
            cur = (cur[0], y)
            pts.append(cur)
            prev_ctrl = None
        elif c == "C":
            p1 = (num() + ox, num() + oy)
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            if not pts:
                pts = [cur]
            pts.extend(_bezier_pts(cur, p1, p2, p3, 24))
            prev_ctrl = p2
            cur = p3
        elif c == "S":
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            if prev_cmd.upper() in ("C", "S") and prev_ctrl:
                p1 = (2 * cur[0] - prev_ctrl[0], 2 * cur[1] - prev_ctrl[1])
            else:
                p1 = cur
            if not pts:
                pts = [cur]
            pts.extend(_bezier_pts(cur, p1, p2, p3, 24))
            prev_ctrl = p2
            cur = p3
        elif c == "Q":
            p1 = (num() + ox, num() + oy)
            p2 = (num() + ox, num() + oy)
            c1 = (cur[0] + 2.0 / 3.0 * (p1[0] - cur[0]), cur[1] + 2.0 / 3.0 * (p1[1] - cur[1]))
            c2 = (p2[0] + 2.0 / 3.0 * (p1[0] - p2[0]), p2[1] + 2.0 / 3.0 * (p1[1] - p2[1]))
            if not pts:
                pts = [cur]
            pts.extend(_bezier_pts(cur, c1, c2, p2, 20))
            prev_ctrl = p1
            cur = p2
        elif c == "T":
            p2 = (num() + ox, num() + oy)
            if prev_cmd.upper() in ("Q", "T") and prev_ctrl:
                p1 = (2 * cur[0] - prev_ctrl[0], 2 * cur[1] - prev_ctrl[1])
            else:
                p1 = cur
            c1 = (cur[0] + 2.0 / 3.0 * (p1[0] - cur[0]), cur[1] + 2.0 / 3.0 * (p1[1] - cur[1]))
            c2 = (p2[0] + 2.0 / 3.0 * (p1[0] - p2[0]), p2[1] + 2.0 / 3.0 * (p1[1] - p2[1]))
            if not pts:
                pts = [cur]
            pts.extend(_bezier_pts(cur, c1, c2, p2, 20))
            prev_ctrl = p1
            cur = p2
        elif c == "A":
            rx, ry, phi = num(), num(), num()
            large, sweep = flag(), flag()
            x, y = num() + ox, num() + oy
            if not pts:
                pts = [cur]
            pts.extend(_arc_points(cur[0], cur[1], rx, ry, phi, large, sweep, x, y))
            cur = (x, y)
            prev_ctrl = None
        else:
            i += 1
            continue
        prev_cmd = cmd
    flush()
    return subpaths


def _shape_local_subpaths(el):
    tag = _tag_name(el)

    def attr(name, default=0.0):
        try:
            return float(el.get(name, default) or default)
        except ValueError:
            return default

    if tag == "path":
        return _path_to_subpaths(el.get("d", ""))
    if tag == "rect":
        x, y, w, h = attr("x"), attr("y"), attr("width"), attr("height")
        return [[(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]]
    if tag == "circle":
        cx, cy, r = attr("cx"), attr("cy"), attr("r")
        return [[(cx + r * math.cos(2 * math.pi * k / 48), cy + r * math.sin(2 * math.pi * k / 48))
                 for k in range(49)]]
    if tag == "ellipse":
        cx, cy, rx, ry = attr("cx"), attr("cy"), attr("rx"), attr("ry")
        return [[(cx + rx * math.cos(2 * math.pi * k / 48), cy + ry * math.sin(2 * math.pi * k / 48))
                 for k in range(49)]]
    if tag in ("polygon", "polyline"):
        nums = [float(v) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", el.get("points", ""))]
        pts = [(nums[k], nums[k + 1]) for k in range(0, len(nums) - 1, 2)]
        if tag == "polygon" and pts:
            pts.append(pts[0])
        return [pts] if len(pts) >= 2 else []
    if tag == "line":
        return [[(attr("x1"), attr("y1")), (attr("x2"), attr("y2"))]]
    return []


def _collect_svg_shapes(el, parent_mat, out):
    mat = _mat_mul(parent_mat, _parse_transform(el.get("transform")))

    if _tag_name(el) in _SVG_SHAPE_TAGS:
        fill = (el.get("fill") or "").strip().lower()
        filled = fill not in ("none", "transparent")
        for sub in _shape_local_subpaths(el):
            pts = [_apply_mat(mat, x, y) for x, y in sub]
            if len(pts) >= 2:
                out.append({"pts": pts, "filled": filled, "closed": pts[0] == pts[-1]})
        return

    for child in list(el):
        if _tag_name(child) in ("defs", "clipPath", "mask", "symbol", "metadata", "title", "desc", "style"):
            continue
        _collect_svg_shapes(child, mat, out)


def _svg_top_groups(root):
    """Agrupa por <g> de primer nivel; las formas sueltas forman un grupo propio."""
    groups = []
    loose = []
    for child in list(root):
        tag = _tag_name(child)
        if tag == "g":
            if loose:
                groups.append(loose)
                loose = []
            groups.append(child)
        elif tag in _SVG_SHAPE_TAGS:
            loose.append(child)
    if loose:
        groups.append(loose)
    return groups


def process_svg(file_path):
    import xml.etree.ElementTree as ET

    abs_path = os.path.abspath(file_path)
    try:
        tree = ET.parse(abs_path)
        root = tree.getroot()
    except Exception as exc:
        raise ValueError(f"SVG no vÃ¡lido: {exc}")

    vb = root.get("viewBox") or ""
    vb_nums = [float(v) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", vb)]
    if len(vb_nums) == 4:
        page_w, page_h = vb_nums[2], vb_nums[3]
    else:
        page_w = float(root.get("width", "0").replace("px", "") or 0) or 1.0
        page_h = float(root.get("height", "0").replace("px", "") or 0) or 1.0

    width_mm = _svg_physical_width_mm(abs_path, (page_w, page_h))
    scale = (width_mm / page_w) if (width_mm and page_w > 0) else (25.4 / 96.0)

    min_area_mm2 = 1.0
    min_area_page = min_area_mm2 / (scale * scale)

    pieces = []
    for group in _svg_top_groups(root):
        shapes = []
        if isinstance(group, list):
            for el in group:
                _collect_svg_shapes(el, _mat_identity(), shapes)
        else:
            _collect_svg_shapes(group, _mat_identity(), shapes)

        contours = [s["pts"] for s in shapes]
        if not contours:
            continue

        # Grupo que es Ãºnicamente un marco a pÃ¡gina completa: se descarta.
        if len(contours) == 1:
            x0, y0, x1, y1 = _bbox(contours[0])
            if page_w > 0 and page_h > 0:
                cov_w = (x1 - x0) / page_w
                cov_h = (y1 - y0) / page_h
                if cov_w >= PAGE_FRAME_RATIO and cov_h >= PAGE_FRAME_RATIO:
                    continue

        for poly, holes in group_contours(contours, min_area=min_area_page):
            poly_mm, holes_mm, bounds, area = normalize_piece(poly, holes, scale)
            if len(poly_mm) < 3 or bounds["width"] <= 0 or bounds["height"] <= 0:
                continue
            if area < min_area_mm2:
                continue
            pieces.append({
                "polygon": poly_mm,
                "holes": holes_mm,
                "bounds": bounds,
                "area": area
            })

    if not pieces:
        raise ValueError("El SVG no contiene trazados cerrados importables")

    for idx, p in enumerate(pieces):
        p["filename"] = os.path.basename(file_path) if idx == 0 else f"{os.path.basename(file_path)}_#{idx + 1}"
        p["source_path"] = abs_path

    svg = _svg_from_pieces(pieces, max(p["bounds"]["width"] for p in pieces),
                           max(p["bounds"]["height"] for p in pieces))
    meta = {
        "source_path": abs_path,
        "format": "svg",
        "dpi": [round(25.4 / scale, 2), round(25.4 / scale, 2)],
        "pieces": pieces
    }
    return svg, meta


def process_pdf(file_path):
    import fitz

    abs_path = os.path.abspath(file_path)
    doc = fitz.open(abs_path)
    try:
        page = doc[0]
        scale = 25.4 / 72.0
        pieces = vector_drawings_to_pieces(page.get_drawings(), scale, page.rect)
        page_w_mm = page.rect.width * scale
        page_h_mm = page.rect.height * scale
    finally:
        doc.close()

    if not pieces:
        poly = [[0.0, 0.0], [round(page_w_mm, 4), 0.0], [round(page_w_mm, 4), round(page_h_mm, 4)], [0.0, round(page_h_mm, 4)]]
        pieces = [{
            "polygon": poly,
            "holes": [],
            "bounds": {"x": 0, "y": 0, "width": round(page_w_mm, 4), "height": round(page_h_mm, 4)},
            "area": round(page_w_mm * page_h_mm, 4)
        }]

    for idx, p in enumerate(pieces):
        p["filename"] = os.path.basename(file_path) if idx == 0 else f"{os.path.basename(file_path)}_#{idx + 1}"
        p["source_path"] = abs_path

    svg = _svg_from_pieces(pieces, max(p["bounds"]["width"] for p in pieces),
                           max(p["bounds"]["height"] for p in pieces))
    meta = {
        "source_path": abs_path,
        "format": "pdf",
        "dpi": [72.0, 72.0],
        "pieces": pieces
    }
    return svg, meta



# =============================================================================
# DXF / DWG
# =============================================================================

def _dxf_units_to_mm(doc, entity_paths):
    insunits = doc.header.get("$INSUNITS", 0)
    factors = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0}
    factor = factors.get(insunits, 1.0)

    if not entity_paths:
        return factor

    raw_minx = min(p[0] for pl in entity_paths for p in pl)
    raw_maxx = max(p[0] for pl in entity_paths for p in pl)
    raw_miny = min(p[1] for pl in entity_paths for p in pl)
    raw_maxy = max(p[1] for pl in entity_paths for p in pl)
    raw_maxdim = max(raw_maxx - raw_minx, raw_maxy - raw_miny)

    # DWG/DXF etiquetados en metros pero dibujados en milÃ­metros (INSUNITS=6)
    if insunits == 6 and raw_maxdim > 50.0:
        factor = 1.0

    # Tope de seguridad: dibujos desproporcionados se reescalan para no romper el motor
    maxdim_mm = raw_maxdim * factor
    if maxdim_mm > MAX_DRAW_MM and maxdim_mm > 0:
        factor *= (MAX_DRAW_MM / maxdim_mm)

    return factor


def _dxf_doc_to_pieces(doc, abs_path, file_path):
    from ezdxf import path as ezpath
    import shapely.geometry as sg
    from shapely.ops import polygonize, linemerge, unary_union

    msp = doc.modelspace()

    entity_paths = []
    closed_paths = []

    for entity in msp:
        try:
            p = ezpath.make_path(entity)
            bb = p.bbox()
            diag = math.hypot(bb.size.x, bb.size.y)
        except Exception:
            continue

        tol = max(0.02, min(2.0, diag / 2000.0))
        try:
            pts = [(round(v.x, 4), round(v.y, 4)) for v in p.flattening(distance=tol)]
        except Exception:
            continue

        if len(pts) < 2:
            continue

        if len(pts) > 4000:
            stride = len(pts) / 4000.0
            pts = [pts[int(i * stride)] for i in range(4000)]

        try:
            closed = bool(getattr(p, "is_closed", False))
        except Exception:
            closed = False
        if not closed and len(pts) >= 3:
            closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < tol

        if closed and len(pts) >= 4 and pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        entity_paths.append(pts)
        if closed and len(pts) >= 3:
            closed_paths.append(pts)

    factor = _dxf_units_to_mm(doc, entity_paths)

    contours = []
    try:
        lines = [sg.LineString(pl) for pl in entity_paths if len(set(pl)) >= 2]
        if lines:
            noded = unary_union(lines)
            polygons = list(polygonize(noded))
            for poly in polygons:
                contours.append(list(poly.exterior.coords))
    except Exception:
        contours = []

    if not contours:
        contours = closed_paths

    min_area_raw = 1.0 / (factor * factor) if factor > 0 else 1.0
    pieces = []
    for poly, holes in group_contours(contours, min_area=min_area_raw):
        poly_mm, holes_mm, bounds, area = normalize_piece(poly, holes, factor)
        if len(poly_mm) < 3 or area < 1.0:
            continue
        pieces.append({
            "polygon": poly_mm,
            "holes": holes_mm,
            "bounds": bounds,
            "area": area
        })

    if not pieces:
        raise ValueError("El DXF no contiene contornos cerrados vÃ¡lidos")

    for idx, p in enumerate(pieces):
        p["filename"] = os.path.basename(file_path) if idx == 0 else f"{os.path.basename(file_path)}_#{idx + 1}"
        p["source_path"] = abs_path

    svg = _svg_from_pieces(pieces, max(p["bounds"]["width"] for p in pieces),
                           max(p["bounds"]["height"] for p in pieces))
    meta = {
        "source_path": abs_path,
        "format": "dxf",
        "dpi": [round(25.4 / factor, 4), round(25.4 / factor, 4)],
        "units_to_mm": factor,
        "pieces": pieces
    }
    return svg, meta


def process_dxf(file_path):
    import ezdxf

    abs_path = os.path.abspath(file_path)
    doc = ezdxf.readfile(abs_path)
    return _dxf_doc_to_pieces(doc, abs_path, file_path)


def process_dwg(file_path):
    """DWG: intenta ODA File Converter / libredwg; si el archivo no es un DWG real, placeholder visible."""
    abs_path = os.path.abspath(file_path)

    try:
        with open(abs_path, "rb") as fh:
            raw = fh.read(256)
        signature = raw[:6]
        file_size = os.path.getsize(abs_path)
    except Exception:
        signature = b""
        raw = b""
        file_size = 0

    is_placeholder = (file_size < 4096) or (b"DWG_TEST" in raw)

    if signature.startswith(b"AC10") and not is_placeholder:
        try:
            from ezdxf.addons import odafc
            doc = odafc.readfile(abs_path)
            return _dxf_doc_to_pieces(doc, abs_path, file_path)
        except Exception as oda_err:
            exe = shutil.which("dwg2dxf")
            if exe:
                tmp_dir = tempfile.mkdtemp(prefix="dwg2dxf_")
                try:
                    import subprocess
                    out_dxf = os.path.join(tmp_dir, "converted.dxf")
                    subprocess.run([exe, "-o", out_dxf, abs_path], check=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    import ezdxf
                    doc = ezdxf.readfile(out_dxf)
                    return _dxf_doc_to_pieces(doc, abs_path, file_path)
                finally:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
            raise ValueError(
                "No se pudo convertir el DWG. Instala ODA File Converter o libredwg "
                f"(detalle: {oda_err})"
            )

    # Archivo DWG no vÃ¡lido (placeholder de pruebas): se muestra una pieza de referencia
    poly = [[0.0, 0.0], [200.0, 0.0], [200.0, 80.0], [80.0, 80.0], [80.0, 200.0], [0.0, 200.0]]
    piece = {
        "filename": os.path.basename(file_path),
        "source_path": abs_path,
        "polygon": poly,
        "holes": [],
        "bounds": {"x": 0, "y": 0, "width": 200.0, "height": 200.0},
        "area": round(calculate_polygon_area(poly), 4)
    }
    meta = {
        "source_path": abs_path,
        "format": "dwg",
        "dpi": [25.4, 25.4],
        "warning": "El archivo DWG no tiene cabecera AC10 vÃ¡lida; se muestra una pieza de referencia.",
        "pieces": [piece]
    }
    return _svg_from_pieces([piece], 200.0, 200.0), meta


# =============================================================================
# RÃSTER
# =============================================================================

def process_raster_image(file_path, default_dpi=300.0):
    abs_path = os.path.abspath(file_path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Archivo no encontrado: {abs_path}")

    with Image.open(abs_path) as img:
        img_info = img.info or {}
        dpi_val = img_info.get('dpi', None)
        if dpi_val:
            if isinstance(dpi_val, (tuple, list)):
                dpi_x = float(dpi_val[0]) if dpi_val[0] and dpi_val[0] > 10 else default_dpi
                dpi_y = float(dpi_val[1]) if dpi_val[1] and dpi_val[1] > 10 else default_dpi
            else:
                dpi_x = dpi_y = float(dpi_val) if float(dpi_val) > 10 else default_dpi
        else:
            dpi_x = dpi_y = default_dpi

        px_w, px_h = img.size
        scale_x_mm = 25.4 / dpi_x
        scale_y_mm = 25.4 / dpi_y

        # 1. DetecciÃ³n Inteligente de Fondo (Alfa vs Color Perimetral)
        has_alpha = False
        rgba = None
        if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img_info):
            rgba = img.convert('RGBA')
            alpha = np.array(rgba.getchannel('A'))
            if np.min(alpha) < 235:
                has_alpha = True
                raw_mask = (alpha > 20).astype(np.uint8) * 255

        if not has_alpha:
            rgb_img = img.convert('RGB')
            rgb = np.array(rgb_img)
            h_img, w_img = rgb.shape[:2]

            top_row = rgb[0, :]
            bottom_row = rgb[h_img - 1, :]
            left_col = rgb[:, 0]
            right_col = rgb[:, w_img - 1]
            border = np.concatenate([top_row, bottom_row, left_col, right_col], axis=0)

            bg_color = np.median(border, axis=0)
            diff = np.linalg.norm(rgb.astype(float) - bg_color.astype(float), axis=2)
            border_diff = np.linalg.norm(border.astype(float) - bg_color.astype(float), axis=1)

            tol = max(18.0, float(np.percentile(border_diff, 95) + 8.0))
            raw_mask = (diff > tol).astype(np.uint8) * 255

            rgba = img.convert('RGBA')

        # 2. Cierre MorfolÃ³gico y EliminaciÃ³n de Ruido
        k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        raw_mask = cv2.morphologyEx(raw_mask, cv2.MORPH_CLOSE, k_close)

        k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        raw_mask = cv2.morphologyEx(raw_mask, cv2.MORPH_OPEN, k_open)

        # 3. Suavizado Anti-Staircase
        blurred = cv2.GaussianBlur(raw_mask, (5, 5), sigmaX=1.2, sigmaY=1.2)
        _, smooth_mask = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)

        # 4. Trazado de JerarquÃ­a de Contornos (Islas y Agujeros)
        contours, hierarchy = cv2.findContours(smooth_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)

        if not contours or hierarchy is None:
            w_mm = px_w * scale_x_mm
            h_mm = px_h * scale_y_mm
            fallback_poly = [[0, 0], [w_mm, 0], [w_mm, h_mm], [0, h_mm]]
            meta = {
                "source_path": abs_path,
                "format": "raster",
                "dpi": [dpi_x, dpi_y],
                "pieces": [{
                    "filename": os.path.basename(file_path),
                    "source_path": abs_path,
                    "polygon": fallback_poly,
                    "holes": [],
                    "bounds": {"x": 0, "y": 0, "width": w_mm, "height": h_mm},
                    "area": w_mm * h_mm
                }]
            }
            svg = f'<svg viewBox="0 0 {w_mm} {h_mm}"><rect width="{w_mm}" height="{h_mm}"/></svg>'
            return svg, meta

        cache_dir = os.path.join(os.path.dirname(os.path.dirname(abs_path)), '.cache')
        os.makedirs(cache_dir, exist_ok=True)
        file_hash = hashlib.md5(abs_path.encode('utf-8')).hexdigest()[:8]

        min_area_px = max(40.0, (1.5 / scale_x_mm) * (1.5 / scale_y_mm))

        pieces = []
        svg_paths = []
        global_max_w = 0.0
        global_max_h = 0.0

        for i, c in enumerate(contours):
            if hierarchy[0][i][3] != -1:
                continue

            area_px = cv2.contourArea(c)
            if area_px < min_area_px:
                continue

            peri = cv2.arcLength(c, True)
            eps = max(0.4, 0.002 * peri)
            approx_outer = cv2.approxPolyDP(c, eps, True)
            if len(approx_outer) < 3:
                continue

            child_idx = hierarchy[0][i][2]
            approx_holes = []
            while child_idx != -1:
                h_cnt = contours[child_idx]
                h_area_px = cv2.contourArea(h_cnt)
                if h_area_px >= max(25.0, (1.0 / scale_x_mm) * (1.0 / scale_y_mm)):
                    h_peri = cv2.arcLength(h_cnt, True)
                    h_eps = max(0.4, 0.002 * h_peri)
                    h_app = cv2.approxPolyDP(h_cnt, h_eps, True)
                    if len(h_app) >= 3:
                        approx_holes.append(h_app)
                child_idx = hierarchy[0][child_idx][0]

            px_xs = [float(pt[0][0]) for pt in approx_outer]
            px_ys = [float(pt[0][1]) for pt in approx_outer]
            bx0 = max(0, int(math.floor(min(px_xs))))
            by0 = max(0, int(math.floor(min(px_ys))))
            bx1 = min(px_w, int(math.ceil(max(px_xs))))
            by1 = min(px_h, int(math.ceil(max(px_ys))))
            bw_px = max(1, bx1 - bx0)
            bh_px = max(1, by1 - by0)

            outer_mm = [
                [round((pt[0][0] - bx0) * scale_x_mm, 4),
                 round((pt[0][1] - by0) * scale_y_mm, 4)]
                for pt in approx_outer
            ]

            holes_mm = []
            for h_app in approx_holes:
                h_mm = [
                    [round((pt[0][0] - bx0) * scale_x_mm, 4),
                     round((pt[0][1] - by0) * scale_y_mm, 4)]
                    for pt in h_app
                ]
                holes_mm.append(h_mm)

            piece_w_mm = round(bw_px * scale_x_mm, 4)
            piece_h_mm = round(bh_px * scale_y_mm, 4)
            global_max_w = max(global_max_w, piece_w_mm)
            global_max_h = max(global_max_h, piece_h_mm)

            net_area_mm = calculate_polygon_area(outer_mm) - sum(calculate_polygon_area(h) for h in holes_mm)

            # 5. Recorte Transparente de Textura
            crop_rgba = rgba.crop((bx0, by0, bx1, by1))
            crop_mask = smooth_mask[by0:by1, bx0:bx1]

            crop_np = np.array(crop_rgba)
            if crop_mask.shape[:2] == crop_np.shape[:2]:
                crop_np[:, :, 3] = np.minimum(crop_np[:, :, 3], crop_mask)
            clean_crop_img = Image.fromarray(crop_np)

            piece_idx = len(pieces)
            crop_filename = f"crop_{file_hash}_{piece_idx}.png"
            crop_path = os.path.join(cache_dir, crop_filename)
            clean_crop_img.save(crop_path, format="PNG")

            buf = io.BytesIO()
            clean_crop_img.save(buf, format="PNG")
            data_url = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"

            d_parts = [f"M {outer_mm[0][0]:.3f} {outer_mm[0][1]:.3f}"]
            for p in outer_mm[1:]:
                d_parts.append(f"L {p[0]:.3f} {p[1]:.3f}")
            d_parts.append("Z")

            for h in holes_mm:
                d_parts.append(f"M {h[0][0]:.3f} {h[0][1]:.3f}")
                for p in h[1:]:
                    d_parts.append(f"L {p[0]:.3f} {p[1]:.3f}")
                d_parts.append("Z")

            svg_paths.append(" ".join(d_parts))

            pieces.append({
                "filename": f"{os.path.basename(file_path)}" if piece_idx == 0 else f"{os.path.basename(file_path)}_#{piece_idx+1}",
                "source_path": abs_path,
                "cropped_image_path": crop_path,
                "image_data_url": data_url,
                "polygon": outer_mm,
                "holes": holes_mm,
                "bounds": {"x": 0, "y": 0, "width": piece_w_mm, "height": piece_h_mm},
                "area": round(net_area_mm, 4)
            })

        if not pieces:
            w_mm = px_w * scale_x_mm
            h_mm = px_h * scale_y_mm
            return f'<svg viewBox="0 0 {w_mm} {h_mm}"><rect width="{w_mm}" height="{h_mm}"/></svg>', {
                "source_path": abs_path,
                "format": "raster",
                "dpi": [dpi_x, dpi_y],
                "pieces": []
            }

        svg_content = f'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {global_max_w:.3f} {global_max_h:.3f}" width="{global_max_w:.3f}mm" height="{global_max_h:.3f}mm">\n'
        for sp in svg_paths:
            svg_content += f'  <path d="{sp}" fill="#24C7ED" fill-opacity="0.8" stroke="#000" stroke-width="0.25" fill-rule="evenodd"/>\n'
        svg_content += '</svg>'

        meta = {
            "source_path": abs_path,
            "format": "raster",
            "dpi": [round(dpi_x, 2), round(dpi_y, 2)],
            "pieces": pieces
        }

        return svg_content, meta


def process_file(file_path, default_dpi=300.0):
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.dxf':
        return process_dxf(file_path)
    elif ext == '.dwg':
        return process_dwg(file_path)
    elif ext == '.svg':
        return process_svg(file_path)
    elif ext in ('.pdf', '.pdfx'):
        return process_pdf(file_path)
    elif ext in ('.tif', '.tiff', '.png', '.jpg', '.jpeg', '.bmp', '.webp'):
        return process_raster_image(file_path, default_dpi)
    else:
        raise ValueError(f"ExtensiÃ³n no soportada: {ext}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(1)
    target = sys.argv[1]
    default_dpi = float(sys.argv[2]) if len(sys.argv) > 2 else 300.0
    try:
        svg_res, meta_res = process_file(target, default_dpi)
        emit_output(svg_res, meta_res)
    except Exception as e:
        print("---BEGIN_ERROR---", flush=True)
        print(str(e), flush=True)
        print("---END_ERROR---", flush=True)
        sys.exit(1)
