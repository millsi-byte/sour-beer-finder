"""Generate app icons: dark rounded tile, chartreuse tulip glass with foam."""
from PIL import Image, ImageDraw


def make_icon(size):
    img = Image.new("RGBA", (size, size), (16, 16, 20, 255))
    d = ImageDraw.Draw(img)
    s = size / 512.0
    accent = (200, 230, 74, 255)
    foam = (245, 248, 230, 255)

    # tulip glass bowl
    d.polygon(
        [
            (150 * s, 150 * s),
            (362 * s, 150 * s),
            (340 * s, 260 * s),
            (296 * s, 310 * s),
            (216 * s, 310 * s),
            (172 * s, 260 * s),
        ],
        fill=accent,
    )
    # stem + base
    d.rectangle([244 * s, 310 * s, 268 * s, 390 * s], fill=accent)
    d.rounded_rectangle([196 * s, 386 * s, 316 * s, 412 * s], radius=12 * s, fill=accent)
    # foam bubbles
    for cx, cy, r in [(190, 138, 34), (256, 124, 42), (322, 138, 34)]:
        d.ellipse(
            [(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=foam
        )
    return img


for size in (180, 512):
    make_icon(size).save(f"icons/icon-{size}.png")
    print(f"icons/icon-{size}.png")
