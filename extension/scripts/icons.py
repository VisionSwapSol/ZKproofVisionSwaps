"""Makes the extension's icons (16, 32, 48, 128 px) from the site's 512 px app icon.

Rounded squares, like the site's favicon. The 128 px one is 96 px of art with 16 px of clear
space on each side, as the Chrome Web Store asks for its icons. Run from the repo root:
python extension/scripts/icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, "web", "public", "icon-512.png")
OUT = os.path.join(os.path.dirname(HERE), "icons")


def rounded(img, size, pad):
    inner = size - 2 * pad
    big = 4  # draw large, then shrink, for smooth corners
    art = img.convert("RGBA").resize((inner * big, inner * big), Image.LANCZOS)
    mask = Image.new("L", art.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, art.size[0] - 1, art.size[1] - 1], radius=int(art.size[0] * 0.22), fill=255)
    art.putalpha(mask)
    art = art.resize((inner, inner), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(art, (pad, pad), art)
    return out


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    src = Image.open(SRC)
    for size, pad in ((16, 0), (32, 0), (48, 1), (128, 16)):
        rounded(src, size, pad).save(os.path.join(OUT, f"icon-{size}.png"), optimize=True)
        print(f"icon-{size}.png")
