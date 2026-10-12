"""phil's tagger: SigLIP 2 base turning pictures and tags into embeddings, for
phil's auto-tagging (apps/phil/tagging.js starts it, from the environment
scripts/install-tagging.sh makes). One JSON object per line on stdin, one
answer per line on stdout:

  {"id": 1, "op": "info"}                 {"id": 1, "model", "scale", "bias", "device"}
  {"id": 2, "op": "images", "paths": [..]}  {"id": 2, "embeddings": [base64 float32 | null, ...],
                                           "meta": [{"description", "keywords"} | null, ...]}
  {"id": 3, "op": "texts", "texts": [..]}   {"id": 3, "embeddings": [base64 float32, ...]}

Embeddings are L2-normalized; a tag fits a picture with probability
sigmoid(dot(picture, tag) * scale + bias). "meta" is what the file says about
itself: a description and keywords from its EXIF, XMP or IPTC data, when it
has them. Errors: {"id", "error"}.
"""
import base64
import html
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

import torch
from PIL import Image, ImageOps, IptcImagePlugin
from transformers import AutoModel, AutoProcessor

MODEL = "google/siglip2-base-patch16-224"
BATCH = 32

device = "cuda" if torch.cuda.is_available() else "cpu"
pool = ThreadPoolExecutor(os.cpu_count() or 4)  # decoding, which is most of the work
model = AutoModel.from_pretrained(MODEL, dtype=torch.float32).to(device).eval()
processor = AutoProcessor.from_pretrained(MODEL)


def features(out):  # a tensor, or an output object (newer transformers)
    return torch.nn.functional.normalize(out if torch.is_tensor(out) else out.pooler_output, dim=-1)


def b64(row):
    return base64.b64encode(row.float().cpu().numpy().astype("<f4").tobytes()).decode()


# What cameras put in the description field when nobody wrote one.
FILLER = re.compile(r"^(olympus digital camera|sony dsc|samsung camera pictures|dcim.*|default|untitled|image|picture|photo|description)?$", re.I)


def text(value):
    """EXIF/IPTC text: bytes (UTF-8, or UTF-16 for Windows' XP* fields), tuples of byte values, or str."""
    if isinstance(value, tuple):
        value = bytes(value)
    if isinstance(value, bytes):
        value = value.decode("utf-16-le" if value.count(b"\0") > len(value) // 4 else "utf-8", errors="ignore")
    return str(value or "").replace("\0", "").strip()


def described(im):
    """A description and keywords the file carries, or None."""
    description, keywords = "", []
    try:
        exif = im.getexif()
        description = text(exif.get(270)) or text(exif.get(0x9C9C))  # ImageDescription, XPComment
        keywords += [k for k in re.split(r"[;,]", text(exif.get(0x9C9E))) if k.strip()]  # XPKeywords
    except Exception:
        pass
    xmp = im.info.get("xmp") or im.info.get("XML:com.adobe.xmp") or b""
    xmp = xmp.decode("utf-8", errors="ignore") if isinstance(xmp, bytes) else str(xmp)
    if xmp:
        m = re.search(r"<dc:description>.*?<rdf:li[^>]*>(.*?)</rdf:li>", xmp, re.S)
        description = description or (html.unescape(m.group(1)).strip() if m else "")
        m = re.search(r"<dc:subject>(.*?)</dc:subject>", xmp, re.S)
        keywords += [html.unescape(k).strip() for k in re.findall(r"<rdf:li[^>]*>(.*?)</rdf:li>", m.group(1), re.S)] if m else []
    try:
        iptc = IptcImagePlugin.getiptcinfo(im) or {}
        description = description or text(iptc.get((2, 120)))  # caption
        kw = iptc.get((2, 25), [])
        keywords += [text(k) for k in (kw if isinstance(kw, list) else [kw])]
    except Exception:
        pass
    description = "" if FILLER.match(description) else description
    keywords = list(dict.fromkeys(k.strip() for k in keywords if k.strip()))
    return {"description": description[:500], "keywords": keywords[:50]} if description or keywords else None


def load(path):
    """(the picture, upright, decoded at a reduced size where the format
    allows: the model sees 224 × 224; what it says about itself), or
    (None, None) if it can't be read."""
    if not path:  # nothing to look at (a video without a thumbnail)
        return None, None
    try:
        im = Image.open(path)
        meta = described(im)
        im.draft("RGB", (448, 448))
        return ImageOps.exif_transpose(im).convert("RGB"), meta
    except Exception as err:
        print(f"phil tagger: {path}: {err}", file=sys.stderr)
        return None, None


def images(paths):
    out, meta = [None] * len(paths), [None] * len(paths)
    for start in range(0, len(paths), BATCH):
        loaded = list(pool.map(load, paths[start:start + BATCH]))
        for i, (_, m) in enumerate(loaded):
            meta[start + i] = m
        batch = [im for im, _ in loaded if im is not None]
        where = [start + i for i, (im, _) in enumerate(loaded) if im is not None]
        if batch:
            pixels = processor(images=batch, return_tensors="pt")["pixel_values"].to(device)
            for i, row in zip(where, features(model.get_image_features(pixel_values=pixels))):
                out[i] = b64(row)
    return out, meta


def texts(items):
    out = []
    for start in range(0, len(items), 256):
        tokens = processor(text=[f"This is a photo of {t}." for t in items[start:start + 256]],
                           padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(device)
        out += [b64(row) for row in features(model.get_text_features(**tokens))]
    return out


print(json.dumps({"ready": True, "device": device}), flush=True)
with torch.no_grad():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            if req["op"] == "info":
                ans = {"model": MODEL, "scale": model.logit_scale.exp().item(), "bias": model.logit_bias.item(), "device": device}
            elif req["op"] == "images":
                embeddings, meta = images(req["paths"])
                ans = {"embeddings": embeddings, "meta": meta}
            elif req["op"] == "texts":
                ans = {"embeddings": texts(req["texts"])}
            else:
                ans = {"error": f"no op {req['op']}"}
        except Exception as err:
            ans = {"error": str(err)}
        print(json.dumps({"id": req.get("id"), **ans}), flush=True)
