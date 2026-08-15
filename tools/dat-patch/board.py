"""Concept-board compositor: consistent layout/typography for the 10 boards."""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

FDIR = "/usr/share/fonts/truetype/dejavu/"
def F(sz, bold=False, mono=False):
    n = "DejaVuSansMono%s.ttf" % ("-Bold" if bold else "")
    if not mono:
        n = "DejaVuSans%s.ttf" % ("-Bold" if bold else "")
    return ImageFont.truetype(FDIR + n, sz)

BG = (18, 20, 26)
PANEL = (26, 29, 37)
INK = (232, 234, 240)
DIM = (150, 156, 170)
ACC = (255, 176, 60)      # planned / added geometry
ACC2 = (90, 200, 255)     # measurement / data
GOOD = (110, 215, 140)
BAD = (255, 110, 110)

W, H = 1500, 1060


def new_board(title, subtitle, tag=None, tagcolor=ACC2):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 112], fill=(12, 13, 18))
    d.text((34, 16), title, font=F(32, True), fill=INK)
    f = F(13, mono=True)
    for i, ln in enumerate(_wrap(d, subtitle, f, W - 80)[:3]):
        d.text((36, 58 + i * 17), ln, font=f, fill=DIM)
    if tag:
        tw = d.textlength(tag, font=F(15, True))
        d.rectangle([W - tw - 60, 18, W - 28, 50], fill=tagcolor)
        d.text((W - tw - 44, 24), tag, font=F(15, True), fill=(12, 13, 18))
    d.line([0, 112, W, 112], fill=(60, 66, 80))
    return im, d


def _fit(d, txt, font, maxw):
    if d.textlength(txt, font=font) <= maxw:
        return txt
    while txt and d.textlength(txt + "…", font=font) > maxw:
        txt = txt[:-1]
    return txt + "…"


def panel(d, box, label, sub=None, color=DIM):
    x0, y0, x1, y1 = box
    d.rectangle(box, fill=PANEL, outline=(58, 64, 80))
    d.text((x0 + 12, y0 + 8), _fit(d, label, F(15, True), x1 - x0 - 24), font=F(15, True), fill=INK)
    if sub:
        f = F(12, mono=True)
        for i, ln in enumerate(_wrap(d, sub, f, x1 - x0 - 24)[:2]):
            d.text((x0 + 12, y0 + 28 + i * 15), ln, font=f, fill=color)
    return (x0 + 8, y0 + 60, x1 - 8, y1 - 8)


def paste_render(im, img, inner, caption=None, d=None):
    x0, y0, x1, y1 = inner
    bw, bh = x1 - x0, y1 - y0
    img = img.copy()
    img.thumbnail((bw, bh), Image.LANCZOS)
    ox = x0 + (bw - img.size[0]) // 2
    oy = y0 + (bh - img.size[1]) // 2
    im.paste(img, (ox, oy))
    if caption and d:
        d.text((x0 + 4, y1 - 18), caption, font=F(12, mono=True), fill=DIM)
    return (ox, oy, img.size)


def callout(d, xy, txt, target=None, color=ACC, w=330, font=None):
    """Numbered/annotated callout box with an optional leader line."""
    font = font or F(13)
    x, y = xy
    lines = _wrap(d, txt, font, w - 18)
    hgt = 10 + len(lines) * (font.size + 4)
    d.rectangle([x, y, x + w, y + hgt], fill=(14, 15, 20), outline=color)
    for i, ln in enumerate(lines):
        d.text((x + 9, y + 5 + i * (font.size + 4)), ln, font=font, fill=INK)
    if target:
        d.line([x + w / 2, y + hgt / 2, target[0], target[1]], fill=color, width=1)
        d.ellipse([target[0] - 4, target[1] - 4, target[0] + 4, target[1] + 4],
                  outline=color, width=2)
    return hgt


def _wrap(d, txt, font, maxw):
    out = []
    for para in txt.split("\n"):
        cur = ""
        for word in para.split():
            t = (cur + " " + word).strip()
            if d.textlength(t, font=font) <= maxw:
                cur = t
            else:
                out.append(cur)
                cur = word
        out.append(cur)
    return out


def bullets(d, x, y, items, w=440, title=None, font=None, color=INK):
    font = font or F(14)
    if title:
        d.text((x, y), title, font=F(15, True), fill=ACC2)
        y += 24
    for it in items:
        for i, ln in enumerate(_wrap(d, it, font, w - 20)):
            d.text((x + (14 if i else 0), y), ("• " if i == 0 else "") + ln,
                   font=font, fill=color)
            y += font.size + 5
        y += 3
    return y


def footer(d, y, text, color=DIM):
    d.line([28, y, W - 28, y], fill=(58, 64, 80))
    for i, ln in enumerate(_wrap(d, text, F(13, mono=True), W - 70)):
        d.text((32, y + 10 + i * 18), ln, font=F(13, mono=True), fill=color)


def note(d, y, text, color=ACC, size=14, x=32, maxw=W - 64):
    f = F(size)
    for i, ln in enumerate(_wrap(d, text, f, maxw)):
        d.text((x, y + i * (size + 4)), ln, font=f, fill=color)
    return y + len(_wrap(d, text, f, maxw)) * (size + 4)
