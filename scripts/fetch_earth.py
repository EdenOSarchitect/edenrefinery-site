"""fetch_earth.py - download Earth imagery for the photoreal globe, once, into tex/.

Sources (tried in order for each layer; the first that works is used):
  4k layers: Solar System Scope textures (CC BY 4.0, based on NASA imagery),
             downscaled from 8k to 4096 x 2048 so phones and laptops can hold them.
  2k layers: three.js example textures r149 (MIT repository; NASA-derived imagery).
Writes tex/CREDITS.txt naming exactly which source each file came from.
Usage: pip install pillow; python scripts/fetch_earth.py    (skips layers already present)
"""
import io, os, sys, urllib.request
from PIL import Image

Image.MAX_IMAGE_PIXELS = 200_000_000
OUT = "tex"
SSS = "https://www.solarsystemscope.com/textures/download/"
THREE = "https://raw.githubusercontent.com/mrdoob/three.js/r149/examples/textures/planets/"
CREDIT = {SSS: "Solar System Scope (CC BY 4.0), https://www.solarsystemscope.com/textures/ , based on NASA imagery",
          THREE: "three.js r149 example textures (github.com/mrdoob/three.js), NASA-derived imagery"}
# name: (size, mode, [(base, file, how)])   how: rgb | lum | alpha
LAYERS = {
    "day_4k.jpg":    (4096, [(SSS, "8k_earth_daymap.jpg", "rgb")]),
    "night_4k.jpg":  (4096, [(SSS, "8k_earth_nightmap.jpg", "rgb")]),
    "clouds_4k.jpg": (4096, [(SSS, "8k_earth_clouds.jpg", "lum")]),
    "day_2k.jpg":    (2048, [(THREE, "earth_atmos_2048.jpg", "rgb"), (SSS, "2k_earth_daymap.jpg", "rgb")]),
    "night_2k.jpg":  (2048, [(THREE, "earth_lights_2048.png", "rgb"), (SSS, "2k_earth_nightmap.jpg", "rgb")]),
    "clouds_2k.jpg": (2048, [(THREE, "earth_clouds_1024.png", "alpha"), (SSS, "2k_earth_clouds.jpg", "lum")]),
    "spec_2k.jpg":   (2048, [(THREE, "earth_specular_2048.jpg", "lum")]),
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "EDEN-Refinery-site/1 (+https://edenrefinery.com)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def convert(raw, how, width):
    im = Image.open(io.BytesIO(raw))
    if how == "alpha" and im.mode in ("RGBA", "LA"):
        im = im.getchannel("A")
    elif how in ("lum", "alpha"):
        im = im.convert("L")
    else:
        im = im.convert("RGB")
    if im.width != width:
        im = im.resize((width, width // 2), Image.LANCZOS)
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    credits = []
    for name, (width, sources) in LAYERS.items():
        path = os.path.join(OUT, name)
        if os.path.exists(path) and os.path.getsize(path) > 10_000:
            continue
        for base, f, how in sources:
            try:
                im = convert(get(base + f), how, width)
                im.save(path, "JPEG", quality=86 if width > 2048 else 88, optimize=True, progressive=True)
                credits.append("%s <- %s%s : %s" % (name, base, f, CREDIT[base]))
                print("ok  ", name, "from", base + f, os.path.getsize(path), "bytes")
                break
            except Exception as e:
                print("miss", name, "from", base + f, "-", e)
    if credits:
        with open(os.path.join(OUT, "CREDITS.txt"), "a") as fh:
            fh.write("\n".join(credits) + "\n")
    if not os.path.exists(os.path.join(OUT, "day_2k.jpg")):
        print("No day imagery; the site will keep its dot-matrix globe.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
