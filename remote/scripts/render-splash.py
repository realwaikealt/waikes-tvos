"""iOS launch screens (apple-touch-startup-image) that explain themselves.

A home-screen app that cannot reach the computer never gets past this image, so it carries
the icon and the fix instead of plain black. Needs Pillow:  pip install pillow
Usage: python scripts/render-splash.py   (writes public/splash/WxH.png)
"""
from PIL import Image, ImageDraw, ImageFont

SIZES = [(750, 1334), (1170, 2532), (1179, 2556), (1206, 2622), (1290, 2796), (1320, 2868), (1398, 2034), (1878, 2670), (2670, 1878)]
FONTS = "C:/Windows/Fonts/"
bold = lambda s: ImageFont.truetype(FONTS + "arialbd.ttf", s)
reg = lambda s: ImageFont.truetype(FONTS + "arial.ttf", s)
icon = Image.open("public/icons/icon-512.png").convert("RGBA")


def wrap(d, text, font, width):
    lines, line = [], ""
    for w in text.split():
        t = (line + " " + w).strip()
        if d.textlength(t, font=font) <= width:
            line = t
        else:
            lines.append(line); line = w
    return lines + [line]


for w, h in SIZES:
    u = min(w, h) / 390  # one 'point' at this size
    img = Image.new("RGB", (w, h), (11, 11, 13))
    d = ImageDraw.Draw(img)
    for y in range(h // 2):  # soft top glow, same as the app's boot screen
        k = max(0, 1 - y / (h * 0.4)) * 0.10
        d.line([(0, y), (w, y)], fill=(int(11 + 255 * k * 0.4), int(11 + 255 * k * 0.4), int(13 + 255 * k * 0.5)))
    size = int(96 * u)
    ic = icon.resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), int(size * 0.225), fill=255)
    ic.putalpha(mask)
    cy = int(h * 0.42)
    img.paste(ic, ((w - size) // 2, cy - size), ic)
    f1, f2 = bold(int(20 * u)), reg(int(15 * u))
    y = cy + int(24 * u)
    t = "Opening the remote…"
    d.text(((w - d.textlength(t, font=f1)) / 2, y), t, font=f1, fill=(255, 255, 255))
    y += int(40 * u)
    hint = "Stuck here? Make sure you're on the home Wi-Fi and the computer is on. If it stays on this screen, open Settings, Privacy & Security, Local Network, and turn this app on. Still nothing: delete the icon and add it again from Safari."
    for ln in wrap(d, hint, f2, w - int(96 * u)):
        d.text(((w - d.textlength(ln, font=f2)) / 2, y), ln, font=f2, fill=(160, 160, 168))
        y += int(21 * u)
    img.save(f"public/splash/{w}x{h}.png", optimize=True)
    print(w, h)
