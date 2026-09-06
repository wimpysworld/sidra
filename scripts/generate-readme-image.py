#!/usr/bin/env python3
"""Compose the README image from the original screenshots at native resolution."""

import base64
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile


root = Path(__file__).resolve().parent.parent
output = root / "assets/sidra-screenshot.png"
screenshots = (
    ("sidra-screenshot-02@2x.png", 80, 56, 2560, 1440),
    ("sidra-settings.png", 1130, 400, 754, 824),
)

for tool in ("rsvg-convert", "optipng"):
    if shutil.which(tool) is None:
        raise SystemExit(f"Required tool not found: {tool}")

layers = []
for name, x, y, width, height in screenshots:
    data = (root / "assets/source" / name).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", data[16:24]) != (width, height):
        raise SystemExit(f"Unexpected screenshot dimensions: {name}")
    encoded = base64.b64encode(data).decode("ascii")
    layers.append(f'''
  <rect x="{x}" y="{y + 12}" width="{width / 2}" height="{height / 2}"
        rx="5" fill="black" opacity="0.5" filter="url(#shadow)"/>
  <image x="{x}" y="{y}" width="{width / 2}" height="{height / 2}"
         href="data:image/png;base64,{encoded}"/>''')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="1800" viewBox="0 0 1600 900">
  <defs>
    <radialGradient id="backdrop" cx="48%" cy="45%" r="72%">
      <stop offset="0" stop-color="#4a0b20"/>
      <stop offset="0.65" stop-color="#380619"/>
      <stop offset="1" stop-color="#270411"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>
  <rect width="1600" height="900" fill="url(#backdrop)"/>
  {''.join(layers)}
</svg>'''

with tempfile.TemporaryDirectory(prefix="readme-image-", dir=output.parent) as temporary:
    png = Path(temporary) / output.name
    subprocess.run(["rsvg-convert", "-o", str(png)], input=svg.encode(), check=True)
    subprocess.run(["optipng", "-strip", "all", "-o2", "-quiet", str(png)], check=True)
    png.replace(output)

print(f"Generated {output.relative_to(root)} (3200 x 1800)")
