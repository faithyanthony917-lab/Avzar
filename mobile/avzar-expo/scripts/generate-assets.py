#!/usr/bin/env python3
"""Generate Avzar's app icon, adaptive icon, splash image and favicon using Python stdlib only."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]

def png(path: Path, width: int, height: int, painter):
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(painter(x, y, width, height))
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))

def mark(x, y, size):
    # White geometric A mark, with a clear counter and a broad crossbar.
    scale = size / 1000
    px, py = x / scale, y / scale
    inside = 260 <= px <= 740 and 220 <= py <= 780 and abs(px - 500) <= (py - 180) * 0.46
    counter = 410 <= px <= 590 and 430 <= py <= 560 and abs(px - 500) <= (py - 350) * 0.55
    crossbar = 365 <= px <= 635 and 570 <= py <= 625
    return inside and (not counter or crossbar)

def icon(x, y, w, h):
    size = min(w, h)
    # Rounded-looking orange field; the mark is inset from the edges for adaptive icon masks.
    edge = min(x, y, w - 1 - x, h - 1 - y)
    orange = (194, 65, 12)
    if edge < size * .035:
        return (255, 255, 255)
    if mark(x - (w-size)//2, y - (h-size)//2, size):
        return (255, 255, 255)
    return orange

def splash(x, y, w, h):
    # Warm off-white background and centered orange square with white A.
    side = min(w, h) * .38
    cx, cy = w / 2, h / 2
    if abs(x-cx) < side/2 and abs(y-cy) < side/2:
        ix, iy = x - (cx-side/2), y - (cy-side/2)
        return icon(int(ix / side * 1000), int(iy / side * 1000), 1000, 1000)
    return (255, 248, 243)

if __name__ == '__main__':
    png(ROOT / 'assets/icon.png', 1024, 1024, icon)
    png(ROOT / 'assets/adaptive-icon.png', 1024, 1024, icon)
    png(ROOT / 'assets/splash.png', 1242, 2436, splash)
    png(ROOT / 'assets/favicon.png', 64, 64, icon)
    print('Generated Avzar icon, adaptive icon, splash and favicon assets.')
