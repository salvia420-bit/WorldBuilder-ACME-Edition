#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  launch_training.sh — Scene Placer Training on GCP GPU Instance
# ═══════════════════════════════════════════════════════════════════════
#
# Run this script on the GCP instance after SSH-ing in.
# It handles the entire setup: clone, install dependencies, extract
# training data, and launch training.
#
# Usage:
#   bash scripts/launch_training.sh              # Full pipeline
#   bash scripts/launch_training.sh --resume     # Resume from checkpoint
#   bash scripts/launch_training.sh --extract-only  # Only extract tensors
#
# Supports: L4, A100/A100-80GB, H100
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_URL="https://github.com/salvia420-bit/WorldBuilder-ACME-Edition.git"
WORK_DIR="$HOME/WorldBuilder-ACME-Edition"
VENV_DIR="$HOME/scene_placer_venv"
RESUME_FLAG="${1:-}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Scene Placer Training — GCP GPU Instance Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. System Info ──────────────────────────────────────────────────
echo "[1/7] System info..."
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "  GPU: not detected (CPU-only?)"
echo "  Python: $(python3 --version 2>&1 || echo 'not found')"
echo "  Disk: $(df -h --output=avail / | tail -1)"
echo ""

# ─── 2. Clone Repo ──────────────────────────────────────────────────
if [ -d "$WORK_DIR" ]; then
    echo "[2/7] Repo already exists, pulling latest..."
    cd "$WORK_DIR"
    git pull
else
    echo "[2/7] Cloning repository..."
    git lfs install
    git clone "$REPO_URL" "$WORK_DIR"
    cd "$WORK_DIR"
fi

# Pull LFS files (model weights, training tensors, enrichment data)
echo "  Pulling LFS files..."
git lfs pull
echo ""

# ─── 3. Python Environment ──────────────────────────────────────────
echo "[3/7] Setting up Python environment..."
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

pip install --quiet --upgrade pip
pip install --quiet numpy torch safetensors

# Verify CUDA
python3 -c "
import torch
print(f'  PyTorch: {torch.__version__}')
print(f'  CUDA: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'  GPU: {torch.cuda.get_device_name()}')
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
    print(f'  VRAM: {vram:.1f} GB')
    if vram >= 70:
        print(f'  → Recommended batch size: 512')
    elif vram >= 35:
        print(f'  → Recommended batch size: 256')
    else:
        print(f'  → Recommended batch size: 64-128')
else:
    print('  WARNING: No GPU detected!')
"
echo ""

# ─── 4. Verify Data Files ───────────────────────────────────────────
echo "[4/7] Checking data files..."
MISSING=0

check_file() {
    if [ -f "$1" ]; then
        SIZE=$(du -h "$1" | cut -f1)
        echo "  ✓ $1 ($SIZE)"
    else
        echo "  ✗ MISSING: $1"
        MISSING=$((MISSING + 1))
    fi
}

check_file "pipeline_data/enrichment/canonical_enrichment.json"
check_file "pipeline_data/enrichment/difficulty_gradient.json"
check_file "pipeline_data/population_output/vanquish_heights.json"

# Check if tensors already exist
if [ -f "pipeline_data/reference/placement_tensors.npz" ]; then
    SIZE=$(du -h "pipeline_data/reference/placement_tensors.npz" | cut -f1)
    echo "  ✓ placement_tensors.npz already exists ($SIZE)"
    TENSORS_EXIST=1
else
    echo "  ○ placement_tensors.npz not found (will extract)"
    TENSORS_EXIST=0
fi

if [ $MISSING -gt 0 ]; then
    echo ""
    echo "  ERROR: $MISSING required files missing!"
    echo "  Ensure Git LFS files were pulled correctly."
    exit 1
fi
echo ""

# ─── 5. Extract Training Tensors ────────────────────────────────────
if [ "$TENSORS_EXIST" -eq 0 ]; then
    echo "[5/7] Extracting placement tensors from SQL..."
    
    # Check for SQL dump
    SQL_PATH=""
    for path in \
        "D:/ACE/world-db/ACE-World-Database-v0.9.292.sql" \
        "$HOME/ACE-World-Database-v0.9.292.sql" \
        "$WORK_DIR/pipeline_data/ACE-World-Database-v0.9.292.sql"; do
        if [ -f "$path" ]; then
            SQL_PATH="$path"
            break
        fi
    done
    
    if [ -z "$SQL_PATH" ]; then
        echo "  WARNING: SQL dump not found. Extraction will fail unless"
        echo "  you upload ACE-World-Database-v0.9.292.sql to ~/."
        echo "  Continuing anyway (the script will show its own error)..."
    fi
    
    python3 scripts/extract_placement_tensors.py
    echo ""
else
    echo "[5/7] Skipping extraction (tensors already exist)"
    echo ""
fi

if [ "$RESUME_FLAG" = "--extract-only" ]; then
    echo "  Extract-only mode. Done!"
    exit 0
fi

# ─── 6. Launch Training ─────────────────────────────────────────────
echo "[6/7] Starting training..."
echo "  Timestamp: $(date)"
echo ""

TRAIN_ARGS=""

# Resume from checkpoint if requested
if [ "$RESUME_FLAG" = "--resume" ]; then
    RESUME_PT="pipeline_data/models/resume.pt"
    if [ -f "$RESUME_PT" ]; then
        echo "  Resuming from checkpoint: $RESUME_PT"
        TRAIN_ARGS="--resume $RESUME_PT"
    else
        echo "  WARNING: No checkpoint found at $RESUME_PT, starting fresh"
    fi
fi

# Run training (nohup so it survives SSH disconnects)
nohup python3 scripts/train_scene_placer.py $TRAIN_ARGS \
    > training_output.log 2>&1 &

TRAIN_PID=$!
echo "  Training started! PID: $TRAIN_PID"
echo "  Log: tail -f training_output.log"
echo ""

# ─── 7. Monitor ─────────────────────────────────────────────────────
echo "[7/7] Monitoring first 30 seconds of output..."
echo "═══════════════════════════════════════════════════════════════"
sleep 5
tail -n 50 training_output.log 2>/dev/null || echo "  (waiting for output...)"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Training is running in background (PID: $TRAIN_PID)"
echo ""
echo "  Useful commands:"
echo "    tail -f training_output.log        # Watch live progress"
echo "    kill $TRAIN_PID                    # Stop training"
echo "    nvidia-smi                          # Check GPU utilization"
echo ""
echo "  When done:"
echo "    python3 scripts/generate_populated_world.py  # Generate world SQL"
echo "    python3 scripts/score_placement_quality.py    # Score quality"
echo "═══════════════════════════════════════════════════════════════"
