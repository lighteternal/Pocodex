"""Draw Professor Tibo, the intro's host, as original FireRed-style pixel art (64 x 96, transparent).

A friendly nod to Tibo Sottiaux of OpenAI's Codex team: short dark hair with a side fringe, a big
smile, a black tee under a lab coat. Not an endorsement. Writes companion/ui/professor-tibo.png.
"""

import struct
import zlib
from pathlib import Path

W, H = 64, 96
OUT = Path(__file__).resolve().parents[1] / "companion" / "ui" / "professor-tibo.png"
C = {  # material: (base, shade)
    "hair": ((58, 42, 34), (38, 27, 22)), "skin": ((240, 200, 164), (214, 166, 128)), "tee": ((44, 44, 52), (30, 30, 36)),
    "coat": ((246, 246, 240), (200, 206, 216)), "sleeve": ((246, 246, 240), (200, 206, 216)), "jeans": ((64, 84, 120), (44, 58, 88)), "shoe": ((236, 236, 232), (180, 184, 190)),
    "sole": ((70, 60, 56), (70, 60, 56)), "mouth": ((120, 40, 44), (120, 40, 44)), "teeth": ((255, 255, 255), (255, 255, 255)),
    "eye": ((34, 30, 36), (34, 30, 36)), "blush": ((236, 168, 150), (236, 168, 150)),
}
OUTLINE = (32, 30, 40)
grid = [[None] * W for _ in range(H)]  # (material, shaded)


def put(x, y, material, shade=False):
    if 0 <= x < W and 0 <= y < H:
        grid[y][x] = (material, shade)


def ellipse(cx, cy, rx, ry, material, shade_from=None, rows=None):
    for y in range(H):
        for x in range(W):
            if ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1 and (rows is None or rows[0] <= y <= rows[1]):
                put(x, y, material, shade_from is not None and x >= shade_from)


def rect(x0, y0, x1, y1, material, shade_from=None):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(x, y, material, shade_from is not None and x >= shade_from)


def thick_line(x0, y0, x1, y1, width, material, shade_side=None):
    steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 3) + 1
    for i in range(steps + 1):
        t = i / steps
        cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        for y in range(int(cy - width), int(cy + width) + 1):
            for x in range(int(cx - width), int(cx + width) + 1):
                if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= (width / 2) ** 2:
                    put(x, y, material, shade_side is not None and x >= cx + shade_side)


# Legs and sneakers
rect(21, 70, 30, 88, "jeans", shade_from=28); rect(33, 70, 42, 88, "jeans", shade_from=40)
rect(19, 89, 30, 92, "shoe", shade_from=28); rect(33, 89, 44, 92, "shoe", shade_from=42)
rect(19, 93, 30, 93, "sole"); rect(33, 93, 44, 93, "sole")
# The arm at his side (image left): sleeve, then the hand
thick_line(17, 37, 14, 61, 6, "sleeve", shade_side=1); ellipse(14, 64.5, 3.4, 3.8, "skin", shade_from=15)
# Lab coat over a black tee, open at the front
for y in range(33, 73):
    spread = min(4, (y - 33) // 5)
    rect(20 - spread // 2, y, 44 + spread // 2, y, "coat", shade_from=37 + spread // 2)
    if 48 <= y: put(24, y, "coat", True)  # a fold
for y in range(32, 60):  # the tee between the lapels, narrowing to the first button
    half = 4 if y < 44 else max(1, 4 - (y - 44) // 4)
    rect(32 - half, y, 31 + half, y, "tee", shade_from=33)
rect(38, 51, 43, 51, "coat", shade_from=0); rect(38, 52, 38, 55, "coat", shade_from=0)  # pocket
for y in range(60, 73):
    put(31, y, "coat", True)  # the coat's front edge
# The waving arm (image right): sleeve up and out, an open hand beside his head
thick_line(45, 38, 50, 28, 7, "sleeve", shade_side=1); thick_line(50, 28, 53, 20, 6, "sleeve", shade_side=1)
ellipse(54, 14.5, 3.9, 4.7, "skin", shade_from=56)
for fx in (51, 53, 55, 57):
    put(fx, 9, "skin", fx >= 56); put(fx, 10, "skin", fx >= 56)
put(49, 15, "skin"); put(49, 16, "skin")  # thumb
# Neck and head
rect(29, 28, 34, 32, "skin", shade_from=33)
ellipse(31.5, 18.5, 8.2, 10.8, "skin", shade_from=36)
put(22, 18, "skin"); put(22, 19, "skin"); put(22, 20, "skin"); put(41, 18, "skin", True); put(41, 19, "skin", True); put(41, 20, "skin", True)
# Hair: volume on top, a fringe swept to one side, short sides
ellipse(31.5, 14.5, 10.2, 8.6, "hair", shade_from=37, rows=(4, 13))
for x in range(23, 36):
    for y in range(13, 13 + max(0, (35 - x) // 4)):
        put(x, y, "hair", x >= 33)
rect(23, 14, 23, 19, "hair"); rect(40, 14, 40, 18, "hair", shade_from=0)
for x, y in ((28, 8), (29, 8), (30, 9), (34, 8), (35, 9)):
    put(x, y, "hair", True)  # strands
# Face: brows, smiling eyes, a big grin, a hint of blush
rect(26, 15, 29, 15, "hair"); rect(34, 15, 37, 15, "hair")
for ex in (27, 35):
    put(ex, 18, "eye"); put(ex + 1, 17, "eye"); put(ex + 2, 18, "eye")  # happy crescents
put(32, 21, "skin", True); put(32, 22, "skin", True)
rect(28, 24, 35, 24, "mouth"); rect(28, 25, 28, 25, "mouth"); rect(35, 25, 35, 25, "mouth")
rect(29, 25, 34, 25, "teeth"); rect(29, 26, 34, 26, "mouth"); rect(30, 27, 33, 27, "mouth")
put(25, 22, "blush"); put(26, 22, "blush"); put(37, 22, "blush"); put(38, 22, "blush")


PAIRS = {frozenset(("sleeve", "coat")), frozenset(("sleeve", "skin")), frozenset(("coat", "jeans"))}


def pixels():
    rows = []
    for y in range(H):
        row = []
        for x in range(W):
            cell = grid[y][x]
            if cell is None:
                edge = any(0 <= x + dx < W and 0 <= y + dy < H and grid[y + dy][x + dx] is not None for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                row.append((*OUTLINE, 255) if edge else (0, 0, 0, 0))
            else:
                material, shaded = cell
                # An inner outline where two parts meet, drawn on the left/upper side only (1 px).
                seam = any(0 <= x + dx < W and 0 <= y + dy < H and grid[y + dy][x + dx] is not None
                           and frozenset((material, grid[y + dy][x + dx][0])) in PAIRS for dx, dy in ((1, 0), (0, 1)))
                row.append((*OUTLINE, 255) if seam else (*C[material][1 if shaded else 0], 255))
        rows.append(row)
    return rows


def png(rows):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.write_bytes(png(pixels()))
    print(f"Wrote {OUT}")
