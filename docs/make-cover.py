"""Build the gallery cover (pi.image) from a real card frame.

Not part of the extension: a one-shot asset generator, kept so the cover can be
rebuilt when the card design changes. Run: python3 docs/make-cover.py
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

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
CARD_PAD_X = 44  # breathing room inside the frame; vertical padding is solved below
TITLE_PX = 112
TOP = 80  # kicker ink top, same as the side margin
GAP = 62  # tagline to frame, and caption to footer rule
CAP_GAP = 22  # frame to caption


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
    # the real card, rendered at 32 px by make-card.py, cropped to its content
    # columns. It is only ever scaled *down*, which is what keeps the glyphs crisp.
    card = Image.open("docs/card-frame.png").convert("RGB")
    card_bg = card.getpixel((2, 2))  # frame padding uses the card's own background: seamless
    ink = ImageChops.difference(card, Image.new("RGB", card.size, card_bg)).point(lambda v: 255 if v > 12 else 0)
    card = card.crop(ink.getbbox())
    fit = W - 2 * M - 2 * CARD_PAD_X
    assert card.width >= fit, "card would be upscaled; render make-card.py larger"
    card = card.resize((fit, round(card.height * fit / card.width)), Image.LANCZOS)

    # vertical stack, centred between the top edge and the footer rule
    kick_f = font(MONO, 16, "Medium")
    title_f = font(SERIF, TITLE_PX, "Bold")
    tag_f = font(MONO, 22)
    cap_f = font(MONO, 18)
    rule_y = H - 62
    # place by ink, not by Pillow's line box: (draw y) = (wanted ink top) - (bbox top offset)
    def at(f, text, ink_top):
        return ink_top - f.getbbox(text)[1], f.getbbox(text)[3] - f.getbbox(text)[1]

    y_kick, kick_h = at(kick_f, "PI", TOP)
    y_title, title_h = at(title_f, "pi-bg-tasks", TOP + kick_h + 30)  # ink incl. p/g descenders
    tag_text = "Detached bash commands, live progress, wake on completion."
    y_tag, tag_h = at(tag_f, tag_text, TOP + kick_h + 30 + title_h + 36)
    fy = TOP + kick_h + 30 + title_h + 36 + tag_h + GAP
    y_cap, cap_h = at(cap_f, "/bg toggles", 0)
    # frame absorbs the remaining height, so no band outside it outgrows its own padding
    fh = rule_y - GAP - cap_h - CAP_GAP - fy
    pad_y = (fh - card.height) // 2
    fw = card.width + 2 * CARD_PAD_X
    fx = M
    frame = (fx, fy, fx + fw - 1, fy + fh - 1)

    # vertical gradient background
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line((0, y, W, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)))

    # soft accent glow, offset low so it lifts the frame off the page instead of haloing it
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).rectangle((fx + 60, fy + 30, frame[2] - 60, frame[3] + 20), fill=56)
    glow = glow.filter(ImageFilter.GaussianBlur(56))
    img = Image.composite(Image.new("RGB", (W, H), ACCENT), img, glow)
    d = ImageDraw.Draw(img)

    # header
    tracked(d, (M, y_kick), "PI AGENT EXTENSION", kick_f, MUTED, 4)
    x = M - 4  # optical: serif side-bearing
    for i, part in enumerate("pi-bg-tasks".split("-")):
        if i:
            d.text((x, y_title), "-", font=title_f, fill=ACCENT)
            x += d.textlength("-", font=title_f)
        d.text((x, y_title), part, font=title_f, fill=FG)
        x += d.textlength(part, font=title_f)
    d.text((M, y_tag), tag_text, font=tag_f, fill=TAG)

    # frame: card-coloured panel, hairline border, accent rule on the left edge
    d.rectangle(frame, fill=card_bg, outline=(66, 68, 88), width=1)
    img.paste(card, (fx + CARD_PAD_X, fy + pad_y))
    d.rectangle((fx, fy, fx + 2, frame[3]), fill=ACCENT)

    # caption: literally true (README: "/bg toggles the card")
    cy = frame[3] + 1 + CAP_GAP + y_cap
    cx = M
    d.text((cx, cy), "/bg", font=font(MONO, 18, "SemiBold"), fill=ACCENT)
    cx += d.textlength("/bg ", font=cap_f)
    d.text((cx, cy), "toggles this card, live inside pi", font=cap_f, fill=MUTED)

    # footer
    d.line((M, rule_y, W - M, rule_y), fill=LINE, width=1)
    ff = font(MONO, 17)
    fb = font(MONO, 17, "SemiBold")
    ty = rule_y + 20
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
    print(f"frame {fw}x{fh} at y={fy}..{frame[3]}, card scale {fit / (ink.getbbox()[2] - ink.getbbox()[0]):.3f}, pad_y {pad_y}")


if __name__ == "__main__":
    main()
