"""Build the gallery cover (pi.image) from a real card frame.

Not part of the extension: a one-shot asset generator, kept so the cover can be
rebuilt when the card design changes. Run: python3 docs/make-cover.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

MONO = "/usr/share/fonts/google-noto-vf/NotoSansMono[wght].ttf"
SERIF = "/usr/share/fonts/google-noto-vf/NotoSerif[wght].ttf"
W, H = 1280, 800
M = 80  # outer margin, shared by every left/right edge
BG_TOP, BG_BOT = (20, 20, 26), (13, 13, 17)
FG = (238, 234, 246)
TAG = (176, 178, 192)
MUTED = (128, 130, 146)
LINE = (44, 45, 56)
ACCENT = (161, 157, 207)  # sampled from the card's running progress bar
CARD_BG = (40, 43, 51)  # the card's own background, so the frame padding is seamless
# card content ends ~x=600 (rest is empty rule lines); x<2 is a dark terminal edge, y<16 empty
CROP = (2, 16, 642, 172)


def font(path: str, size: int, variation: str | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, size)
    if variation:
        f.set_variation_by_name(variation)
    return f


def tracked(d: ImageDraw.ImageDraw, xy, text: str, f, fill, spacing: int) -> None:
    """Draw text with letter spacing (Pillow has no tracking)."""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + spacing


def main() -> None:
    # vertical gradient background
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line((0, y, W, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)))

    # header
    tracked(d, (M, 70), "PI AGENT EXTENSION", font(MONO, 15, "Medium"), MUTED, 4)
    title_f = font(SERIF, 88, "Bold")
    x = M - 3  # optical: serif side-bearing
    for i, part in enumerate("pi-bg-tasks".split("-")):
        if i:
            d.text((x, 92), "-", font=title_f, fill=ACCENT)
            x += d.textlength("-", font=title_f)
        d.text((x, 92), part, font=title_f, fill=FG)
        x += d.textlength(part, font=title_f)
    d.text((M, 230), "Detached bash commands, live progress, wake on completion.", font=font(MONO, 21), fill=TAG)
    d.line((M, 282, W - M, 282), fill=LINE, width=1)

    # the real card: crop the empty right edge, upscale, frame it
    card = Image.open("docs/card-frame.png").convert("RGB").crop(CROP)
    scale = 1.65
    card = card.resize((round(card.width * scale), round(card.height * scale)), Image.LANCZOS)
    pad_x = (W - 2 * M - card.width) // 2  # frame spans exactly the content margins
    pad_y = 40
    fw, fh = card.width + 2 * pad_x, card.height + 2 * pad_y
    fx, fy = M, 310
    frame = (fx, fy, fx + fw - 1, fy + fh - 1)

    # soft accent glow behind the frame
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).rectangle(frame, fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(48))
    img = Image.composite(Image.new("RGB", (W, H), ACCENT), img, glow)
    d = ImageDraw.Draw(img)

    d.rectangle(frame, fill=CARD_BG, outline=(70, 70, 92), width=1)
    img.paste(card, (fx + pad_x, fy + pad_y))
    d.line((fx, fy, fx, frame[3]), fill=ACCENT, width=3)  # vertical accent rule

    # footer
    fy2 = H - 62
    d.line((M, fy2, W - M, fy2), fill=LINE, width=1)
    ff = font(MONO, 17)
    fb = font(MONO, 17, "SemiBold")
    ty = fy2 + 20
    d.rectangle((M, ty + 4, M + 3, ty + 20), fill=ACCENT)
    x = M + 14
    d.text((x, ty), "pi-bg-tasks", font=fb, fill=ACCENT)
    x += d.textlength("pi-bg-tasks", font=fb) + 16
    d.text((x, ty), "│", font=ff, fill=LINE)
    x += d.textlength("│", font=ff) + 16
    d.text((x, ty), "npm:@dis446/pi-bg-tasks", font=ff, fill=MUTED)
    right = "MIT · pi 1.5+"
    d.text((W - M - d.textlength(right, font=ff), ty), right, font=ff, fill=MUTED)

    img.save("docs/cover.png", optimize=True)


if __name__ == "__main__":
    main()
