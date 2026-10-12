"""phil's tagger: SigLIP 2 base turning pictures and tags into embeddings, for
phil's auto-tagging (apps/phil/tagging.js starts it, from the environment
scripts/install-tagging.sh makes). One JSON object per line on stdin, one
answer per line on stdout:

  {"id": 1, "op": "info"}                 {"id": 1, "model", "scale", "bias", "device"}
  {"id": 2, "op": "images", "paths": [..]}  {"id": 2, "embeddings": [base64 float32 | null, ...]}
  {"id": 3, "op": "texts", "texts": [..]}   {"id": 3, "embeddings": [base64 float32, ...]}

Embeddings are L2-normalized; a tag fits a picture with probability
sigmoid(dot(picture, tag) * scale + bias). Errors: {"id", "error"}.
"""
import base64
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import torch
from PIL import Image, ImageOps
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


def load(path):
    """The picture, upright, decoded at a reduced size where the format allows
    (the model sees 224 × 224); None if it can't be read."""
    if not path:  # nothing to look at (a video without a thumbnail)
        return None
    try:
        im = Image.open(path)
        im.draft("RGB", (448, 448))
        return ImageOps.exif_transpose(im).convert("RGB")
    except Exception as err:
        print(f"phil tagger: {path}: {err}", file=sys.stderr)
        return None


def images(paths):
    out = [None] * len(paths)
    for start in range(0, len(paths), BATCH):
        loaded = list(pool.map(load, paths[start:start + BATCH]))
        batch = [im for im in loaded if im is not None]
        where = [start + i for i, im in enumerate(loaded) if im is not None]
        if batch:
            pixels = processor(images=batch, return_tensors="pt")["pixel_values"].to(device)
            for i, row in zip(where, features(model.get_image_features(pixel_values=pixels))):
                out[i] = b64(row)
    return out


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
                ans = {"embeddings": images(req["paths"])}
            elif req["op"] == "texts":
                ans = {"embeddings": texts(req["texts"])}
            else:
                ans = {"error": f"no op {req['op']}"}
        except Exception as err:
            ans = {"error": str(err)}
        print(json.dumps({"id": req.get("id"), **ans}), flush=True)
