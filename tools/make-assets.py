"""Generate the raster brand assets the pages reference.

    python tools/make-assets.py

Writes favicon.png (32px), apple-touch-icon.png (180px) and the two Open
Graph images (1200x630) to the repo root. The wordmark is netenroll-logo.png;
type is rendered with whatever serif and sans Pillow can find on the machine,
falling back to Pillow's built-in face, so the output is deterministic enough
to commit and never depends on a web font.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
INK, GREEN, PAPER, MUTED = (11, 18, 32), (16, 185, 129), (255, 255, 255), (91, 100, 114)


def font(candidates, size):
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


SERIF = ["georgia.ttf", "Georgia.ttf", "times.ttf", "DejaVuSerif.ttf"]
SANS = ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]
MONO = ["consola.ttf", "cour.ttf", "DejaVuSansMono.ttf"]


def icon(size):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = round(size * 0.19)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=INK)
    # The "n" of the wordmark, drawn as strokes so it scales cleanly.
    w = max(2, round(size * 0.1))
    x0, x1 = round(size * 0.27), round(size * 0.66)
    top, bot = round(size * 0.30), round(size * 0.72)
    d.line((x0, top, x0, bot), fill=PAPER, width=w)
    d.line((x1, round(size * 0.48), x1, bot), fill=PAPER, width=w)
    d.arc((x0, top, x1, round(size * 0.66)), start=180, end=360, fill=PAPER, width=w)
    dot = round(size * 0.08)
    cx, cy = round(size * 0.77), round(size * 0.27)
    d.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=GREEN)
    return im


def og(title, lines, eyebrow, out):
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 14, H), fill=GREEN)
    logo = Image.open(ROOT / "netenroll-logo.png").convert("RGBA")
    lh = 44
    logo = logo.resize((round(logo.width * lh / logo.height), lh), Image.LANCZOS)
    im.paste(logo, (80, 64), logo)
    d.text((80, 150), eyebrow, font=font(MONO, 22), fill=(8, 127, 91))
    y = 196
    f = font(SERIF, 72)
    for ln in title:
        d.text((76, y), ln, font=f, fill=INK)
        y += 82
    y += 14
    fs = font(SANS, 28)
    for ln in lines:
        d.text((80, y), ln, font=fs, fill=MUTED)
        y += 40
    d.line((80, H - 80, W - 80, H - 80), fill=(228, 231, 235), width=2)
    d.text((80, H - 62), "netenroll.com  ·  904-512-8487", font=font(MONO, 20), fill=MUTED)
    im.save(out, optimize=True)


icon(32).save(ROOT / "favicon.png")
icon(180).convert("RGB").save(ROOT / "apple-touch-icon.png")
og(["Final expense calls, billed", "per submitted application."],
   ["$199 per submitted application. $0 per call, $0 per month, no minimum.",
    "Live demand routed to producers licensed in the states they choose."],
   "FINAL EXPENSE  ·  BUILT FOR PRODUCERS", ROOT / "og-final-expense.png")
og(["Licensed ACA producers,", "signed to your agency."],
   ["$500 per signed producer, $450 at ten or more. 30-day replacement.",
    "Verified, scheduled onto your calendar. You interview and sign."],
   "ACA AGENT RECRUITING  ·  FOR AGENCY OWNERS", ROOT / "og-recruiting.png")
print("wrote favicon.png apple-touch-icon.png og-final-expense.png og-recruiting.png")
