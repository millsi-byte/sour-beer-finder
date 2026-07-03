"""Generate app icons: the S4S lockup (Search 4 Sour Beer) — sage-green
serif "S4S" over a rule and wordmark on white, matching @search4sourbeer.
Requires Pillow and Liberation Serif (Times-like, close to the logo face)."""
from PIL import Image, ImageDraw, ImageFont

GREEN = (86, 122, 94, 255)  # #567a5e
SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"


def make_icon(size):
    # Draw at 512 and downscale for crisp small sizes.
    S = 512
    img = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)

    f_big = ImageFont.truetype(SERIF, 220)
    f_mid = ImageFont.truetype(SERIF, 140)
    f_sub = ImageFont.truetype(SERIF, 46)

    # "S4S" — the 4 smaller, dipping slightly below the S baseline
    baseline = 270
    parts = [("S", f_big, 0), ("4", f_mid, 14), ("S", f_big, 0)]
    widths = [d.textbbox((0, 0), t, font=f)[2] for t, f, _ in parts]
    gap = 6
    total = sum(widths) + gap * 2
    x = (S - total) / 2
    for (t, f, dip), w in zip(parts, widths):
        asc, _ = f.getmetrics()
        d.text((x, baseline + dip - asc), t, font=f, fill=GREEN)
        x += w + gap

    # rule + wordmark
    rule_w = total + 24
    rx = (S - rule_w) / 2
    d.rectangle([rx, 316, rx + rule_w, 330], fill=GREEN)
    sub = "Search 4 Sour Beer"
    sw = d.textbbox((0, 0), sub, font=f_sub)[2]
    d.text(((S - sw) / 2, 356), sub, font=f_sub, fill=GREEN)

    return img.resize((size, size), Image.LANCZOS) if size != S else img


for size in (180, 512):
    make_icon(size).save(f"icons/icon-{size}.png")
    print(f"icons/icon-{size}.png")
