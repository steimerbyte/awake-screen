#!/usr/bin/env python3
"""Render the Awake Screen icons (16/32/48/128 px) into ../icons/.

Every size is drawn once at 4x and downscaled with LANCZOS, so the shapes stay
vector-like. Deterministic by construction: no timestamps, no text chunks, no
randomness -- the same Pillow/zlib build always yields byte-identical files.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SS = 4  # supersample factor

GROUND = (11, 18, 32, 255)  # #0B1220
MOON = (34, 211, 238, 255)  # #22D3EE
SUN = (245, 158, 11, 255)  # #F59E0B


def render(size):
    """Draw the motif on a size*SS canvas and return the downscaled icon."""
    n = size * SS

    # Transparent, but pre-filled with the ground colour so LANCZOS does not
    # pull black into the antialiased corners.
    canvas = Image.new("RGBA", (n, n), GROUND[:3] + (0,))

    # Rounded square ground.
    pad = round(n * 0.035)
    ground_mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(ground_mask).rounded_rectangle(
        (pad, pad, n - 1 - pad, n - 1 - pad), radius=round(n * 0.22), fill=255
    )
    canvas.paste(Image.new("RGBA", (n, n), GROUND), (0, 0), ground_mask)

    # Crescent: outer disc minus an offset disc, kept as its own alpha mask so
    # the subtraction cannot eat the ground beside the moon.
    cx, cy = n * 0.44, n * 0.50
    r_out = n * 0.275
    ox, oy = n * 0.085, -n * 0.085
    r_in = n * 0.265
    moon_mask = Image.new("L", (n, n), 0)
    pen = ImageDraw.Draw(moon_mask)
    pen.ellipse((cx - r_out, cy - r_out, cx + r_out, cy + r_out), fill=255)
    pen.ellipse((cx + ox - r_in, cy + oy - r_in, cx + ox + r_in, cy + oy + r_in), fill=0)
    canvas.paste(Image.new("RGBA", (n, n), MOON), (0, 0), moon_mask)

    # Sun dot inside the crescent's hollow.
    sx, sy = cx + ox + n * 0.02, cy + oy + n * 0.095
    r_sun = n * 0.075
    ImageDraw.Draw(canvas).ellipse((sx - r_sun, sy - r_sun, sx + r_sun, sy + r_sun), fill=SUN)

    return canvas.resize((size, size), Image.LANCZOS)


def main():
    icons = Path(__file__).resolve().parent.parent / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        render(size).save(icons / f"{size}.png", format="PNG", optimize=True)


if __name__ == "__main__":
    main()
