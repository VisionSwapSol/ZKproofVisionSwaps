"""Packs extension/dist (the published build: `npm run build -w extension`) into the zip the Chrome
Web Store takes, overwriting it in place: VISIONSWAP-CHROME-EXTENSION.zip, beside the repository folder.

The manifest sits at the zip's root. The zip is checked after writing: a CRC pass over every entry,
and a refusal to ship a development build (a pinned key, local addresses) or anything that isn't
part of the extension (source maps, keys, settings).
"""
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(os.path.dirname(HERE), "dist")
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(os.path.dirname(ROOT), "VISIONSWAP-CHROME-EXTENSION.zip")

if __name__ == "__main__":
    man = json.load(open(os.path.join(DIST, "manifest.json"), encoding="utf-8"))
    text = json.dumps(man)
    if "key" in man or "localhost" in text or "127.0.0.1" in text or man.get("name") != "VisionSwap":
        raise SystemExit("extension/dist is not the published build: run npm run build -w extension")
    files = []
    for d, _, fs in os.walk(DIST):
        for f in fs:
            rel = os.path.relpath(os.path.join(d, f), DIST).replace("\\", "/")
            low = rel.lower()
            base = low.rsplit("/", 1)[-1]
            if low.endswith((".map", ".pem")) or low.startswith("keys/") or "dev-key" in low or any(s in base for s in (".env", "settings", "secret")):
                raise SystemExit(f"refusing to ship {rel}")
            files.append(rel)
    files.sort(key=lambda r: (r != "manifest.json", r))
    tmp = OUT + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            z.write(os.path.join(DIST, rel), rel)
    with zipfile.ZipFile(tmp) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f"CRC failure in {bad}")
        names = z.namelist()
        if "manifest.json" not in names:
            raise SystemExit("manifest.json is not at the root")
        extra = [n for n in names if n != "manifest.json" and n.lower().rsplit("/", 1)[-1] == "manifest.json"]
        if extra:
            raise SystemExit(f"the Chrome Web Store allows only one manifest.json, also found: {', '.join(extra)}")
        if json.loads(z.read("manifest.json")) != man:
            raise SystemExit("manifest changed while zipping")
    os.replace(tmp, OUT)
    print(f"{os.path.basename(OUT)}: {len(names)} files, {os.path.getsize(OUT) / 1e6:.1f} MB, version {man['version']}, CRC OK")
