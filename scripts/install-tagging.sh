#!/usr/bin/env bash
# Sets up phil's optional auto-tagging (apps/phil/tagging.js): a Python
# environment with PyTorch and transformers in ~/.local/share/phil/tagging,
# and the SigLIP 2 base model (about 1.5 GB, from Hugging Face, into its
# usual cache). Then turn it on for a folder in its Properties, or for every
# folder in Preferences.
#
# With uv (astral.sh/uv), the environment shares PyTorch and its CUDA
# libraries (6–7 GB for an NVIDIA GPU) with uv's other environments: what's
# in uv's cache already is linked from there, not copied, and what isn't is
# downloaded into it, then linked. Without uv: a venv of its own (pip), with
# its own copy of everything (about 8 GB with PyTorch for an NVIDIA GPU, much
# less for the CPU).
#
#   --documents   also text and Markdown files: sentence-transformers and
#                 EmbeddingGemma 2 (another 1.5 GB or so)
#
# Run it again to update; delete that folder to remove it.
set -euo pipefail

documents=false
for arg in "$@"; do
  case $arg in
    --documents) documents=true ;;
    *) echo "Usage: $0 [--documents]" >&2; exit 2 ;;
  esac
done

data=${XDG_DATA_HOME:-$HOME/.local/share}/phil/tagging
python=${PYTHON:-python3}
model=google/siglip2-base-patch16-224

# PyTorch for this computer. NVIDIA cards before compute capability 7.0
# (Pascal: GTX 10xx) need 2.14's CUDA 12.6 build, the last one made for them;
# newer cards get the current build; without an NVIDIA card, the CPU one
# (slower: about a picture a second, rather than over a hundred).
cap=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n 1 || true)
if [[ -z $cap ]]; then
  torch=(torch torchvision --index-url https://download.pytorch.org/whl/cpu)
  echo "No NVIDIA GPU: PyTorch for the CPU"
elif awk "BEGIN { exit !($cap < 7.0) }"; then
  torch=("torch==2.14.*" "torchvision==0.29.*" --index-url https://download.pytorch.org/whl/cu126)
  echo "NVIDIA GPU, compute capability $cap: PyTorch 2.14 for CUDA 12.6 (the last for it)"
else
  torch=(torch torchvision)
  echo "NVIDIA GPU, compute capability $cap: PyTorch for CUDA"
fi

packages=(transformers pillow)
if $documents; then packages+=("sentence-transformers>=6.1"); fi
mkdir -p "$data"
old=""
if command -v uv >/dev/null; then
  # A venv of its own from before (pip's, with its own copy of PyTorch): set aside,
  # deleted once the new one works (back in its place if it doesn't).
  if [[ -f $data/venv/pyvenv.cfg ]] && ! grep -q '^uv = ' "$data/venv/pyvenv.cfg"; then
    old=$data/venv.old
    rm -rf "$old"
    mv "$data/venv" "$old"
    trap '[[ -d $old ]] && rm -rf "$data/venv" && mv "$old" "$data/venv" && echo "Failed: the old environment is back" >&2' ERR
    echo "Replacing the environment with its own copy of PyTorch by one sharing uv's"
  fi
  # (hardlinks: uv's cache and this environment share the files, when they're on one file system; else copies)
  uvpip=(uv pip install --quiet --python "$data/venv/bin/python" --link-mode hardlink)
  [[ -x $data/venv/bin/python ]] || uv venv --quiet --python "$python" "$data/venv"
  # What uv's cache has is used from there; what it hasn't is downloaded into it first.
  cache=$(uv cache dir)
  before=$(du -sb "$cache" 2>/dev/null | cut -f1 || echo 0)
  "${uvpip[@]}" "${torch[@]}"
  "${uvpip[@]}" "${packages[@]}"
  after=$(du -sb "$cache" 2>/dev/null | cut -f1 || echo 0)
  got=$(( (after - before) / 1000000 ))
  if (( got > 50 )); then echo "Downloaded into uv's cache ($cache): $got MB"; else echo "Everything was in uv's cache already ($cache): nothing downloaded"; fi
  # Shared (the same file as the cache's: more than one link to it), or copied (another file system).
  lib=$(echo "$data"/venv/lib/python3*/site-packages/torch/lib/libtorch_cpu.so)
  if [[ -f $lib && $(stat -c %h "$lib") -gt 1 ]]; then echo "PyTorch: shared with uv's cache (one copy on disk)"
  else echo "PyTorch: copied (uv's cache is on another file system)"; fi
else
  echo "No uv: a venv of its own, with its own copy of PyTorch (uv shares it: astral.sh/uv)"
  "$python" -m venv "$data/venv"
  "$data/venv/bin/pip" install --quiet --upgrade pip
  "$data/venv/bin/pip" install --quiet "${torch[@]}"
  "$data/venv/bin/pip" install --quiet "${packages[@]}"
fi

# The model, now rather than when tagging starts; and a check that it runs.
"$data/venv/bin/python" - "$model" <<'EOF'
import sys
import torch
from transformers import AutoModel, AutoProcessor
model = AutoModel.from_pretrained(sys.argv[1])
AutoProcessor.from_pretrained(sys.argv[1])
gpu = torch.cuda.is_available()
print(f"{sys.argv[1]}: ready, on the {'GPU (' + torch.cuda.get_device_name(0) + ')' if gpu else 'CPU'}")
EOF
if $documents; then
  "$data/venv/bin/python" - <<'EOF'
from sentence_transformers import SentenceTransformer
SentenceTransformer("google/embeddinggemma-2", device="cpu", config_kwargs={"vision_config": None, "audio_config": None})
print("google/embeddinggemma-2: ready (text and Markdown files)")
EOF
fi
if [[ -n $old ]]; then
  trap - ERR
  rm -rf "$old"
  echo "The old environment is deleted"
fi
echo "Auto-tagging is set up in $data. Turn it on for a folder in its Properties (right-click it), or for every folder in Preferences (the gear)."
