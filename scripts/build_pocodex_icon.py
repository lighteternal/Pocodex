"""Generate the project's original small egg icon using the standard library."""

import struct
import zlib
from pathlib import Path


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def main() -> None:
    size = 256
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = x / 2, y / 2
            color = (184, 64, 55, 255)
            width = 28 + (py - 27) * 0.12
            if ((px - 64) / width) ** 2 + ((py - 68) / 44) ** 2 < 1:
                color = (251, 248, 227, 255)
                if any((px - cx) ** 2 + (py - cy) ** 2 < radius ** 2 for cx, cy, radius in [(56, 41, 11), (78, 75, 13), (43, 86, 10)]):
                    color = (110, 148, 88, 255)
            row.extend(color)
        rows.append(bytes(row))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")
    dest = Path(__file__).resolve().parents[1] / "companion" / "assets"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "icon.png").write_bytes(png)
    header = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    (dest / "icon.ico").write_bytes(header + png)


if __name__ == "__main__":
    main()
