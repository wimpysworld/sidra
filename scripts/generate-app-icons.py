#!/usr/bin/env python3
"""Render the shared logo and package app icons for macOS and Windows."""

from pathlib import Path
import shutil
import struct
import subprocess
import tempfile


root = Path(__file__).resolve().parent.parent
source = root / "assets/source/sidra-icon-squircle.svg"
output = root / "build"
sizes = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ico_sizes = sizes[:7]
icns_slots = {
    b"icp4": 16,
    b"icp5": 32,
    b"icp6": 64,
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic10": 1024,
    b"ic11": 32,
    b"ic12": 64,
    b"ic13": 256,
    b"ic14": 512,
}

for tool in ("rsvg-convert", "optipng"):
    if shutil.which(tool) is None:
        raise SystemExit(f"Required tool not found: {tool}")

with tempfile.TemporaryDirectory(prefix="app-icons-", dir=output) as temporary:
    staging = Path(temporary)
    images = {}
    for size in sizes:
        png = staging / f"{size}.png"
        subprocess.run([
            "rsvg-convert", "-w", str(size), "-h", str(size),
            "-o", str(png), str(source),
        ], check=True)
        subprocess.run(["optipng", "-strip", "all", "-o7", "-quiet", str(png)], check=True)
        images[size] = png.read_bytes()

    chunks = b"".join(
        struct.pack(">4sI", slot, 8 + len(images[size])) + images[size]
        for slot, size in icns_slots.items()
    )
    (staging / "icon.icns").write_bytes(struct.pack(">4sI", b"icns", 8 + len(chunks)) + chunks)

    # ICO offsets are absolute, and a zero dimension denotes 256 pixels.
    directory = bytearray(struct.pack("<HHH", 0, 1, len(ico_sizes)))
    offset = 6 + 16 * len(ico_sizes)
    for size in ico_sizes:
        length = len(images[size])
        directory.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, length, offset))
        offset += length
    (staging / "icon.ico").write_bytes(directory + b"".join(images[size] for size in ico_sizes))
    (staging / "icon.png").write_bytes(images[1024])
    (staging / "sidra-logo.png").write_bytes(images[256])

    for name in ("icon.png", "icon.icns", "icon.ico"):
        (staging / name).replace(output / name)
    (staging / "sidra-logo.png").replace(root / "assets/sidra-logo.png")
