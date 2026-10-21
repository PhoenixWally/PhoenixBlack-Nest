import os
import cv2
import numpy as np
from PIL import Image, ImageDraw

def test_contours():
    # 1. Crear sticker_estrella.png con fondo transparente (estrella + agujero circular)
    w, h = 600, 600
    img_star = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img_star)
    
    # Estrella de 5 puntas
    cx, cy = 300, 300
    r_out, r_in = 250, 100
    star_pts = []
    for i in range(10):
        ang = i * np.pi / 5 - np.pi / 2
        r = r_out if i % 2 == 0 else r_in
        star_pts.append((cx + r * np.cos(ang), cy + r * np.sin(ang)))
    draw.polygon(star_pts, fill=(255, 60, 100, 255))
    
    # Agujero circular en el centro (transparente)
    r_hole = 45
    draw.ellipse([cx - r_hole, cy - r_hole, cx + r_hole, cy + r_hole], fill=(0, 0, 0, 0))
    
    star_path = os.path.abspath('sticker_estrella.png')
    img_star.save(star_path, 'PNG', dpi=(300, 300))
    print(f"Creado: {star_path}")

    # 2. Crear pieza_fondo_blanco.jpg con fondo blanco (círculo / forma orgánica)
    img_circle = Image.new('RGB', (w, h), (255, 255, 255))
    draw2 = ImageDraw.Draw(img_circle)
    # Dibujar forma elíptica/orgánica
    draw2.ellipse([100, 150, 500, 450], fill=(20, 160, 220))
    circle_path = os.path.abspath('pieza_fondo_blanco.jpg')
    img_circle.save(circle_path, 'JPEG', dpi=(300, 300))
    print(f"Creado: {circle_path}")

    # Probar extracción con OpenCV
    # Test A: Estrella transparente
    rgba = np.array(Image.open(star_path).convert('RGBA'))
    alpha = rgba[:, :, 3]
    mask = (alpha > 20).astype(np.uint8) * 255
    blurred = cv2.GaussianBlur(mask, (5, 5), 1.0)
    _, smask = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)
    contours, hier = cv2.findContours(smask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    print(f"Estrella: {len(contours)} contornos. Jerarquía: {hier}")
    
    # Encontrar contorno externo y agujeros
    for i, c in enumerate(contours):
        if hier[0][i][3] == -1: # Externo
            eps = max(0.5, 0.0025 * cv2.arcLength(c, True))
            approx = cv2.approxPolyDP(c, eps, True)
            print(f"  Outer puntos approx: {len(approx)}, area: {cv2.contourArea(approx)}")
            # Agujeros
            child = hier[0][i][2]
            hole_count = 0
            while child != -1:
                h_c = contours[child]
                if cv2.contourArea(h_c) > 50:
                    h_eps = max(0.5, 0.0025 * cv2.arcLength(h_c, True))
                    h_app = cv2.approxPolyDP(h_c, h_eps, True)
                    hole_count += 1
                    print(f"    Hole puntos approx: {len(h_app)}, area: {cv2.contourArea(h_app)}")
                child = hier[0][child][0]
            print(f"  Total holes detectados: {hole_count}")

    # Test B: JPG fondo blanco
    rgb = np.array(Image.open(circle_path).convert('RGB'))
    h_img, w_img = rgb.shape[:2]
    border = np.concatenate([rgb[0, :], rgb[h_img-1, :], rgb[:, 0], rgb[:, w_img-1]], axis=0)
    bg = np.median(border, axis=0)
    diff = np.linalg.norm(rgb.astype(float) - bg.astype(float), axis=2)
    b_diff = np.linalg.norm(border.astype(float) - bg.astype(float), axis=1)
    tol = max(18.0, float(np.percentile(b_diff, 95) + 8.0))
    mask_b = (diff > tol).astype(np.uint8) * 255
    blurred_b = cv2.GaussianBlur(mask_b, (5, 5), 1.0)
    _, smask_b = cv2.threshold(blurred_b, 127, 255, cv2.THRESH_BINARY)
    contours_b, hier_b = cv2.findContours(smask_b, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    print(f"Círculo JPG: {len(contours_b)} contornos.")
    for i, c in enumerate(contours_b):
        if hier_b[0][i][3] == -1:
            eps = max(0.5, 0.0025 * cv2.arcLength(c, True))
            approx = cv2.approxPolyDP(c, eps, True)
            print(f"  Outer puntos approx: {len(approx)}, area: {cv2.contourArea(approx)}")

if __name__ == '__main__':
    test_contours()
