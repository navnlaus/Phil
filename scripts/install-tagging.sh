#!/usr/bin/env bash
# Sets up phil's optional auto-tagging (apps/phil/tagging.js): a Python
# environment with PyTorch and transformers in ~/.local/share/phil/tagging,
# and the SigLIP 2 base model (about 1.5 GB, from Hugging Face, into its
# usual cache). About 8 GB in all with PyTorch for an NVIDIA GPU (that's
# 6–7 GB of it), much less for the CPU. Then turn it on for a folder in
# its Properties, or for every folder in Preferences.
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

mkdir -p "$data"
"$python" -m venv "$data/venv"
"$data/venv/bin/pip" install --quiet --upgrade pip
"$data/venv/bin/pip" install --quiet "${torch[@]}"
"$data/venv/bin/pip" install --quiet transformers pillow
if $documents; then "$data/venv/bin/pip" install --quiet "sentence-transformers>=6.1"; fi

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
echo "Auto-tagging is set up in $data. Turn it on for a folder in its Properties (right-click it), or for every folder in Preferences (the gear)."
