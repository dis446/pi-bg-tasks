"""Render the task card at native resolution for the gallery cover.

The card is drawn by the extension itself (`renderCard` in ../core.ts), so this
rasterizes *its* output instead of upscaling a screenshot. Same rows, same theme
colours, same glyphs as the real TUI — just at 32 px instead of 11 pt, which is
why the result is sharp when the cover scales it down.

Run from the repo root: python3 docs/make-card.py
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "/usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf"  # matches the terminal
SIZE = 32
LINE = 1.55  # line height as a multiple of the font size
PAD_X = 3  # cells of breathing room left and right

# Sampled from the real card recording: this is the pi theme the user runs.
BG = (40, 43, 52)
FG = {
    "accent": (135, 131, 183),
    "success": (109, 180, 149),
    "error": (217, 123, 123),
    "muted": (141, 146, 156),
    "dim": (109, 114, 124),
    "text": (200, 203, 210),
    "warning": (214, 178, 122),
}

# A real moment from the demo clip (t≈32 s): two bars mid-flight, one finished.
ROWS = [
    {"id": "8lvvkabw", "label": "# release build · cargo build", "state": "running",
     "percent": 41, "message": "compiling 41/100", "startedAt": 0, "updatedAt": 4000},
    {"id": "8lvw1xri", "label": "# e2e · playwright test", "state": "running",
     "percent": 35, "message": "spec 21/60", "startedAt": 0, "updatedAt": 3000},
    {"id": "8lvvuxno", "label": "# test suite · node --test", "state": "completed",
     "percent": 100, "startedAt": 0, "finishedAt": 30_000, "updatedAt": 2000},
    {"id": "8lvw9y1c", "label": "# dev server · next dev", "state": "running",
     "startedAt": 0, "updatedAt": 1000},
]
NOW = 40_000  # elapsed clock for the dev server row


def render_lines() -> list[str]:
    """Card lines with ANSI colour, straight from the extension's renderer."""
    script = """
import { renderCard } from "./core.ts";
const { rows, now, palette } = JSON.parse(NA);
const fg = (c, s) => `\\x1b[38;2;${palette[c].join(";")}m${s}\\x1b[0m`;
process.stdout.write(renderCard(rows, fg, now, 6).join("\\n"));
""".replace("NA", "process.argv[1]")
    payload = json.dumps({"rows": ROWS, "now": NOW, "palette": FG})
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script, payload],
        cwd=ROOT, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f"card render failed: {out.stderr.strip()}")
    return out.stdout.split("\n")


SGR = re.compile(r"\x1b\[([0-9;]*)m")


def spans(line: str) -> list[tuple[tuple[int, int, int], str]]:
    """Split a line into (colour, text) runs, defaulting to the text colour."""
    out: list[tuple[tuple[int, int, int], str]] = []
    colour, pos = FG["text"], 0
    for m in SGR.finditer(line):
        if m.start() > pos:
            out.append((colour, line[pos:m.start()]))
        args = [int(a) for a in m.group(1).split(";") if a]
        if args[:2] == [38, 2] and len(args) >= 5:
            colour = (args[2], args[3], args[4])
        elif args and args[0] == 0:
            colour = FG["text"]
        pos = m.end()
    if pos < len(line):
        out.append((colour, line[pos:]))
    return out


def main() -> None:
    lines = render_lines()
    font = ImageFont.truetype(FONT, SIZE)
    advance = font.getlength("M")
    cell_w, cell_h = round(advance), round(SIZE * LINE)
    cols = max(sum(len(t) for _, t in spans(l)) for l in lines)

    pad = round(cell_h * 0.6)
    width = round(cols * cell_w) + PAD_X * cell_w * 2
    height = len(lines) * cell_h + pad * 2
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    y = pad - round(cell_h * 0.15)  # optical: cap height sits below the line top
    for line in lines:
        x = PAD_X * cell_w
        for colour, text in spans(line):
            for ch in text:
                if ch != " ":
                    draw.text((x, y), ch, font=font, fill=colour)
                x += cell_w
        y += cell_h

    img.save(ROOT / "docs/card-frame.png", optimize=True)
    print(f"docs/card-frame.png {img.width}x{img.height}  ({cols} cols, {len(lines)} lines)")


if __name__ == "__main__":
    main()
