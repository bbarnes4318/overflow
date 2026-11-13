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


def og_dark(title, price, lines, eyebrow, accent, out):
    """The "Inbound Signal" pages: night background, accent signal strands."""
    W, H = 1200, 630
    NIGHT, TX, TX3 = (4, 16, 11), (236, 245, 240), (130, 153, 142)
    im = Image.new("RGB", (W, H), NIGHT)
    d = ImageDraw.Draw(im, "RGBA")
    # converging strands: broadcast (right edge) -> call node
    import math
    for k in range(7):
        dy = (k - 3) * 46
        pts = []
        for i in range(61):
            t = i / 60
            x = 1180 - t * 330
            y = 470 + dy * math.sin(t * math.pi) ** 1.3
            pts.append((x, y))
        d.line(pts, fill=accent + (90,), width=2)
        d.ellipse((1180 - 165 - 6, 470 + dy - 6, 1180 - 165 + 6, 470 + dy + 6), outline=accent + (200,), width=2)
    d.ellipse((820, 440, 880, 500), fill=accent)
    logo = Image.open(ROOT / "netenroll-logo-dark.png").convert("RGBA")
    lh = 40
    logo = logo.resize((round(logo.width * lh / logo.height), lh), Image.LANCZOS)
    im.paste(logo, (80, 64), logo)
    d.text((80, 146), eyebrow, font=font(SANS, 22), fill=accent)
    y = 190
    for ln in title:
        d.text((76, y), ln, font=font(SANS, 64), fill=TX)
        y += 74
    if price:
        d.text((76, y + 10), price, font=font(SANS, 120), fill=TX)
        y += 150
    for ln in lines:
        d.text((80, y + 6), ln, font=font(SANS, 26), fill=TX3)
        y += 38
    d.text((80, H - 62), "netenroll.com  ·  904-512-8487", font=font(SANS, 20), fill=TX3)
    im.save(out, optimize=True)


MINT, SKY, AMBER = (59, 240, 166), (143, 203, 255), (255, 194, 122)
og_dark(["We bring the opportunities.", "You close the business."], None,
        ["Live TV inbound calls: Medicare $39, Final Expense $44, 120-second buffer.",
         "Or pay per submitted application: $199 · $159 · $100."],
        "CUSTOMER ACQUISITION FOR INSURANCE PROFESSIONALS", MINT, ROOT / "og-home.png")
og_dark(["Medicare TV inbound calls"], "$39 / call", ["120-second billing buffer. Live, consumer-initiated."],
        "LIVE MEDICARE TV INBOUND CALLS", SKY, ROOT / "og-medicare-tv.png")
og_dark(["They saw the ad.", "They made the call."], "$44 / call", ["Final Expense TV inbound. 120-second billing buffer."],
        "LIVE FINAL EXPENSE TV INBOUND CALLS", AMBER, ROOT / "og-final-expense-tv.png")
print("wrote og-home.png og-medicare-tv.png og-final-expense-tv.png")
