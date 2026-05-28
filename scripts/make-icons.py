#!/usr/bin/env python3
"""Generate TotoroTrader PWA icons with Pillow.

The Totoro mascot is simple geometry (matching src/Totoro.jsx), so we draw it
directly at 4x supersample and downscale with LANCZOS for clean anti-aliased
edges — no SVG rasterizer required. Run: python3 scripts/make-icons.py
"""

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "public")
MASTER = 2048  # supersample canvas; all drawing happens here then downscales

# Forest theme palette (default theme in the app).
BG_TOP = (27, 38, 42)      # #1b262a
BG_BOTTOM = (13, 20, 22)   # #0d1416
ACCENT = (92, 184, 92)     # #5cb85c
BODY = (107, 114, 128)     # #6b7280
BODY_DARK = (75, 85, 99)   # #4b5563
BELLY = (238, 240, 242)    # near-white
EYE_WHITE = (245, 245, 247)
EYE_DARK = (26, 26, 34)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg():
    img = Image.new("RGB", (MASTER, MASTER))
    px = img.load()
    for y in range(MASTER):
        c = lerp(BG_TOP, BG_BOTTOM, y / (MASTER - 1))
        for x in range(MASTER):
            px[x, y] = c
    return img


# Cache the gradient — it's the expensive part.
_GRAD = None


def base_canvas(rounded):
    global _GRAD
    if _GRAD is None:
        _GRAD = gradient_bg()
    img = _GRAD.copy().convert("RGBA")
    if rounded:
        mask = Image.new("L", (MASTER, MASTER), 0)
        d = ImageDraw.Draw(mask)
        r = int(MASTER * 0.22)
        d.rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=r, fill=255)
        img.putalpha(mask)
    return img


def draw_totoro(img, pad):
    """Draw the mascot centered. `pad` is the fraction of the canvas reserved
    as empty margin on each side (controls how large the Totoro renders)."""
    d = ImageDraw.Draw(img)
    # Content is centered on SVG point (32, 33) with half-extent 26 (spans 6..59).
    cx_svg, cy_svg, half = 32.0, 33.0, 26.0
    content = (1 - 2 * pad) * MASTER
    scale = content / (2 * half)
    cxp, cyp = MASTER / 2, MASTER / 2

    def P(x, y):
        return (cxp + (x - cx_svg) * scale, cyp + (y - cy_svg) * scale)

    def ellipse(cx, cy, rx, ry, fill):
        a = P(cx - rx, cy - ry)
        b = P(cx + rx, cy + ry)
        d.ellipse([a[0], a[1], b[0], b[1]], fill=fill)

    def poly(points, fill):
        d.polygon([P(x, y) for x, y in points], fill=fill)

    def line(points, fill, w):
        d.line([P(x, y) for x, y in points], fill=fill, width=max(1, int(w * scale)),
               joint="curve")

    # ears
    poly([(22, 18), (19, 8), (27, 16)], BODY_DARK)
    poly([(42, 18), (45, 8), (37, 16)], BODY_DARK)
    # body + belly
    ellipse(32, 36, 22, 22, BODY)
    ellipse(32, 40, 14, 15, BELLY)
    # eyes
    ellipse(26, 38, 2.6, 2.8, EYE_WHITE)
    ellipse(38, 38, 2.6, 2.8, EYE_WHITE)
    ellipse(26.3, 38.2, 1.1, 1.1, EYE_DARK)
    ellipse(38.3, 38.2, 1.1, 1.1, EYE_DARK)
    ellipse(26.6, 37.7, 0.4, 0.4, (255, 255, 255))
    ellipse(38.6, 37.7, 0.4, 0.4, (255, 255, 255))
    # nose
    poly([(31, 45), (33, 45), (32, 46.5)], EYE_DARK)
    # calm mouth
    line([(29, 50), (32, 51), (35, 50)], EYE_DARK, 0.9)
    # whiskers
    for wy in (46, 47.6):
        line([(21, wy), (16, wy - 0.5 + (wy - 46))], BODY_DARK, 0.45)
        line([(43, wy), (48, wy - 0.5 + (wy - 46))], BODY_DARK, 0.45)
    # accent dot
    ellipse(32, 20, 1.4, 1.4, ACCENT)
    return img


def render(rounded, pad):
    img = base_canvas(rounded)
    draw_totoro(img, pad)
    return img


def save(img, name, size, mode="RGBA"):
    out = img.resize((size, size), Image.LANCZOS)
    if mode == "RGB":
        bg = Image.new("RGB", out.size, BG_BOTTOM)
        bg.paste(out, mask=out.split()[3])
        out = bg
    path = os.path.join(OUT, name)
    out.save(path)
    print(f"  wrote {name} ({size}x{size})")


def main():
    os.makedirs(OUT, exist_ok=True)
    print("rendering masters...")
    m_any = render(rounded=True, pad=0.14)
    m_mask = render(rounded=False, pad=0.22)   # content within Android safe zone
    m_apple = render(rounded=False, pad=0.12)

    print("exporting...")
    save(m_any, "icon-192.png", 192)
    save(m_any, "icon-512.png", 512)
    save(m_mask, "icon-maskable-512.png", 512)
    save(m_apple, "apple-touch-icon.png", 180, mode="RGB")
    save(m_any, "favicon-32.png", 32)

    # multi-size favicon.ico
    ico = m_any.resize((64, 64), Image.LANCZOS)
    ico.save(os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("  wrote favicon.ico")
    print("done.")


if __name__ == "__main__":
    main()
